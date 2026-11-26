"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { BACKEND, addAudit, getDb, mutate, newId, nowIso } from "@/lib/db/store";
import { missingTables, recheckMissingTables } from "@/lib/db/supabase";
import { attachmentsOf, detectType, discardStored, relinkDocumentAttachments, storeFile } from "@/lib/attachments";
import { readObject } from "@/lib/storage";
import type { Attachment, CapturedDocument, Database, DocumentKind, User } from "@/lib/db/types";
import { aiEnabled, extractDocument, FIELD_KEYS, normalizeExtracted, type LineItem, type OcrMode, type OcrResult } from "@/lib/ai/ocr";
import { calcSheet, compareTranscription } from "@/lib/quote-sheet-calc";
import { REGISTER_TARGETS } from "@/lib/capture-fields";
import { DOCUMENT_KIND_LABEL } from "@/lib/constants";
import { findOrderByPostcard, storeFromPostcard, surveyFromExtracted } from "@/lib/survey-link";
import { assertCaseStore, assertStore, choice, fail, requireActionUser, resolveStoreId, safeReturn, str, withErr, withMsg } from "./guards";
import { canEditCaseStore } from "@/lib/auth/permissions";
import { customerHasPhone } from "@/lib/customer-contacts";
import { buildCaseMap, quoteLinkForCase } from "@/lib/case-group";

// 写真は画面側で縮小してから送る (image-prep.ts)。PDF などは 4 MB まで (Server Action の 1 回の送信の上限 4.5 MB = next.config.ts)
const MAX_BYTES = 4 * 1024 * 1024;

/** 案件のどの記録の ID でも、案件に見積を足すときのつながり (src/lib/case-group.ts の quoteLinkForCase) */
function caseQuoteLink(db: Database, id: string) {
  const map = buildCaseMap(db);
  const root = map.caseOf(id);
  return root ? quoteLinkForCase(db, root, map) : undefined;
}

/**
 * 読み取った見積書のお客様を、見積の作成の画面の検索に入れる (案件から撮影したときは使わない):
 * 電話番号が 1 人のお客様と一致すればそのお客様を選び、なければ氏名で検索する
 */
function setQuoteCustomer(qs: URLSearchParams, user: User, extracted: Record<string, unknown>) {
  const cq = customerQuery(extracted.customerName ?? extracted.siteName);
  const digits = typeof extracted.phone === "string" ? extracted.phone.replace(/\D/g, "") : "";
  const byPhone = digits.length >= 9 ? getDb().customers.filter((c) => customerHasPhone(c, digits) && canEditCaseStore(user, c.storeId)) : [];
  if (byPhone.length === 1) qs.set("customerId", byPhone[0].id);
  else if (cq) qs.set("cq", cq);
}

const PROVIDER_LABEL: Record<OcrResult["provider"], string> = { claude: "Claude", openai: "OpenAI", mock: "サンプル", error: "読取失敗" };

/** 読取結果を書類に保存する形 (_ で始まる項目は読取の記録)。mode = calc は「金額を書く前に撮影」した見積書 */
function toExtracted(result: OcrResult, sample: boolean, mode?: OcrMode): Record<string, unknown> {
  return {
    ...result.extracted,
    ...(mode ? { _mode: mode } : {}),
    _provider: result.provider,
    _model: result.model,
    _warnings: result.warnings,
    _aiWarnings: result.warnings,
    _error: result.error,
    _ms: result.ms,
    _readAt: nowIso(),
    // AI が読み取ったままの値 (担当者の修正と比べて、読取の正確さを集計する)
    ...(result.provider === "claude" || result.provider === "openai" ? { _ai: result.extracted } : {}),
    ...(sample ? { _sample: true } : {}),
  };
}

function readMessage(result: OcrResult, mode?: OcrMode): string {
  if (mode === "calc") return `読み取って計算しました (${PROVIDER_LABEL[result.provider]})。数量・単価が用紙と同じか確かめてから、金額を書き写してください。`;
  return `読み取りが完了しました (${PROVIDER_LABEL[result.provider]} / 確度 ${Math.round(result.confidence * 100)}%)。内容を確認・修正してから登録してください。`;
}

/** 書類の画面 (金額の計算の書類は計算の画面) */
const docPath = (id: string, mode?: unknown) => (mode === "calc" ? `/capture/calc?doc=${id}` : `/capture?doc=${id}`);

/** 送られた写真・PDF を読む (写真は画面側で縮小済み) */
async function readUpload(formData: FormData, back: string): Promise<{ fileName: string; mimeType: string; base64: string } | null> {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return null;
  if (file.size > MAX_BYTES) fail(back, "ファイルサイズは 4MB 以下にしてください (写真は自動で縮小されます)。");
  const fileName = file.name.slice(0, 200) || "document";
  const t = detectType(fileName, file.type);
  if (!t || (!t.photo && t.contentType !== "application/pdf")) fail(back, "写真 (JPEG・PNG など) か PDF を取り込んでください。");
  return { fileName, mimeType: t.contentType, base64: Buffer.from(await file.arrayBuffer()).toString("base64") };
}

/** 元の画像・PDF を書類の添付ファイルとして保存する。保存できなくても読取結果は登録する (undefined) */
async function storeOriginal(user: User, formData: FormData, doc: { id: string; storeId: CapturedDocument["storeId"]; fileName: string }, up: { fileName: string; mimeType: string; base64: string }): Promise<Attachment | undefined> {
  const noTable = BACKEND === "supabase" && missingTables().includes("attachments") && (await recheckMissingTables()).includes("attachments");
  if (noTable) return undefined;
  try {
    const thumb = formData.get("thumb");
    return await storeFile({
      user,
      parent: { type: "document", id: doc.id, storeId: doc.storeId, label: `取込書類 ${doc.fileName}`, href: `/capture?doc=${doc.id}`, entity: "document" },
      file: { name: up.fileName, type: up.mimeType, bytes: Buffer.from(up.base64, "base64") },
      thumb: thumb instanceof File && thumb.size > 0 ? { name: "thumb.jpg", type: "image/jpeg", bytes: Buffer.from(await thumb.arrayBuffer()) } : undefined,
      takenAt: str(formData, "takenAt") || undefined,
    });
  } catch (err) {
    console.warn("[capture] original not stored:", (err as Error).message);
    return undefined;
  }
}

function failMessage(result: OcrResult): string {
  return `AI で読み取れませんでした: ${result.error ?? "原因不明のエラー"} 内容を手入力して登録するか、「もう一度読み取る」を押してください。`;
}

export async function uploadDocument(formData: FormData) {
  const user = await requireActionUser();
  // mode = calc: 金額を書く前に撮影した手書き見積書 (数量・単価を読み、金額はシステムが計算する)
  const mode: OcrMode | undefined = str(formData, "mode") === "calc" ? "calc" : undefined;
  const back = mode === "calc" ? "/capture/calc" : "/capture";
  const kind = mode === "calc" ? "handwritten_quote" : choice(formData, "kind", DOCUMENT_KIND_LABEL, "other");
  if (kind === "reception") fail(back, "受付メモは 問い合わせ →「問合せ登録」から取り込んでください。");
  const storeId = resolveStoreId(user, str(formData, "storeId"));
  assertStore(user, storeId, back);
  const up = await readUpload(formData, back);
  if (!up && aiEnabled()) fail(back, "書類を撮影するか、画像・PDF のファイルを選んでください。");
  const fileName = up?.fileName ?? (str(formData, "sampleName").slice(0, 120) || "sample.jpg");
  const db = getDb();
  const result = await extractDocument({ kind, fileName, mimeType: up?.mimeType ?? "image/jpeg", base64: up?.base64, products: db.products, storeId, mode });
  const id = newId("doc");
  // 元の画像・PDF を保存する (確認画面・登録した見積・経費・仕入請求書・受注の画面で表示する)。保存できなくても読取結果は登録する
  const original = up ? await storeOriginal(user, formData, { id, storeId, fileName }, up) : undefined;
  const failed = result.provider === "error";
  await mutate((d) => {
    if (original) d.attachments.push(original!);
    d.documents.push({ id, kind, fileName, uploadedBy: user.id, storeId, uploadedAt: nowIso(), status: failed ? "failed" : "extracted", extracted: toExtracted(result, !up, mode), confidence: result.confidence });
    addAudit(d, { userId: user.id, action: "create", entity: "document", entityId: id, entityLabel: fileName, summary: `書類を取込・AI読取 (${DOCUMENT_KIND_LABEL[kind]}${mode === "calc" ? "・金額の計算" : ""} / ${PROVIDER_LABEL[result.provider]}${failed ? `: ${result.error}` : ""})`, storeId });
  }).catch(async (err) => {
    if (original) await discardStored(original);
    throw err;
  });
  revalidatePath("/capture");
  if (mode === "calc") revalidatePath(back);
  if (failed) redirect(withErr(docPath(id, mode), failMessage(result)));
  redirect(withMsg(docPath(id, mode), readMessage(result, mode)));
}

/**
 * 手書きの見積書を撮影 → AI で読み取り → 見積の作成の画面 (読み取った明細・手書きの日時が入った状態) へ。
 * - 予定表の小さな画面 (お客様のご要望 2026-11-25「② 予定表からの見積書登録」: 案件を探し直さない) と、
 *   見積の作成の画面の「手書きの見積書を撮影して AI で読み取る」(お客様のご要望 2026-11-26「■1」: どこから見積作成に入っても 2 通り) で共通
 * - 案件 (inquiryId・customerId・caseId) があればその案件の見積に、なければ読み取ったお客様 (電話番号・氏名) で探す
 * - returnTo があれば、見積を保存したあとその画面に戻る。back は読み取りの前に断るときの戻り先 (見積の作成の画面)
 * - 1 つの案件に見積を複数作れる (お客様のご要望 2026-11-26「■6」。すでに見積がある案件でも撮影できる)
 * 読み取りに失敗したときは書類取込の確認の画面 (手入力・読み直し。「見積を作成」で同じ案件の見積の画面へ)
 */
export async function captureCaseQuote(formData: FormData) {
  const user = await requireActionUser();
  const ret = safeReturn(str(formData, "returnTo"), "");
  const back = safeReturn(str(formData, "back"), "") || ret || "/schedule";
  const db0 = getDb();
  const caseIdIn = str(formData, "caseId");
  const caseLink = caseIdIn ? caseQuoteLink(db0, caseIdIn) : undefined;
  if (caseIdIn && !caseLink) fail(back, "見積を作る案件が見つかりません。");
  const inq = db0.inquiries.find((i) => i.id === (str(formData, "inquiryId") || caseLink?.inquiryId) && !i.deleted);
  const customer = db0.customers.find((c) => c.id === (str(formData, "customerId") || inq?.customerId || caseLink?.customerId));
  const contextual = Boolean(inq || customer || caseLink);
  const storeId = inq?.storeId ?? (caseLink?.storeId || undefined) ?? customer?.storeId ?? resolveStoreId(user, str(formData, "storeId"));
  if (!canEditCaseStore(user, storeId)) fail(back, contextual ? "この案件の見積を作る権限がありません (担当店舗の社員・店長が作れます)。" : "この店舗の見積を作る権限がありません。");
  const up = await readUpload(formData, back);
  if (!up && aiEnabled()) fail(back, "見積書を撮影してください。");
  const fileName = up?.fileName ?? "sample.jpg";
  const result = await extractDocument({ kind: "handwritten_quote", fileName, mimeType: up?.mimeType ?? "image/jpeg", base64: up?.base64, products: db0.products, storeId });
  const id = newId("doc");
  const original = up ? await storeOriginal(user, formData, { id, storeId, fileName }, up) : undefined;
  const failed = result.provider === "error";
  // 問い合わせのない案件 (見積・受注から始まった案件) は案件の ID でつなぐ
  const caseId = !inq && caseLink?.caseId ? caseLink.caseId : undefined;
  const ctx = { inquiryId: inq?.id, customerId: customer?.id, caseId, eventId: str(formData, "eventId") || undefined, returnTo: ret || undefined };
  const extracted = { ...toExtracted(result, !up), ...(contextual || ret ? { _case: ctx } : {}) };
  const where = str(formData, "eventId") ? "予定表の案件から" : "見積の作成の画面から";
  await mutate((d) => {
    if (original) d.attachments.push(original!);
    d.documents.push({ id, kind: "handwritten_quote", fileName, uploadedBy: user.id, storeId, uploadedAt: nowIso(), status: failed ? "failed" : "extracted", extracted, confidence: result.confidence });
    addAudit(d, { userId: user.id, action: "create", entity: "document", entityId: id, entityLabel: fileName, summary: `${where}手書きの見積書を撮影・AI読取 (${inq ? `問い合わせ ${inq.number}` : customer ? `${customer.name} 様` : "お客様は読み取りから"} / ${PROVIDER_LABEL[result.provider]}${failed ? `: ${result.error}` : ""})`, storeId });
  }).catch(async (err) => {
    if (original) await discardStored(original);
    throw err;
  });
  revalidatePath("/capture");
  if (failed) redirect(withErr(docPath(id), failMessage(result)));
  const qs = new URLSearchParams({ documentId: id });
  if (ret) qs.set("returnTo", ret);
  if (customer) qs.set("customerId", customer.id);
  else setQuoteCustomer(qs, user, result.extracted);
  if (inq) qs.set("inquiryId", inq.id);
  if (caseId) qs.set("caseId", caseId);
  redirect(withMsg(`/quotes/new?${qs.toString()}`, readMessage(result)));
}

function findDoc(db: Database, user: User, id: string): CapturedDocument {
  const doc = db.documents.find((d) => d.id === id);
  if (!doc) fail("/capture", "書類が見つかりません。");
  assertStore(user, doc.storeId, "/capture");
  return doc;
}

/** 金額を書く前に撮影した手書き見積書 (金額・合計はシステムの計算) */
const calcMode = (doc: CapturedDocument): OcrMode | undefined => (doc.kind === "handwritten_quote" && doc.extracted?._mode === "calc" ? "calc" : undefined);

function assertEditable(doc: CapturedDocument, back: string) {
  if (doc.status === "confirmed") fail(back, "登録済みの書類は変更できません (登録先の画面で修正してください)。");
  if (doc.status === "discarded") fail(back, "破棄した書類は変更できません。もう一度取り込んでください。");
}

/** もう一度読み取る (種類を変えて読み直すこともできる)。保存してある元の画像・PDF を使う */
export async function retryExtraction(formData: FormData) {
  const user = await requireActionUser();
  const id = str(formData, "id");
  const db = getDb();
  const doc = findDoc(db, user, id);
  // 金額の計算の書類は、計算の読み方のまま読み直す
  const mode: OcrMode | undefined = doc.extracted?._mode === "calc" && doc.kind === "handwritten_quote" ? "calc" : undefined;
  const back = docPath(id, mode);
  assertEditable(doc, back);
  const kind = mode === "calc" ? "handwritten_quote" : choice(formData, "kind", DOCUMENT_KIND_LABEL, doc.kind);
  if (kind === "reception" || doc.kind === "reception") fail(back, "受付メモは 問い合わせ →「問合せ登録」の画面で読み直してください。");
  const sample = Boolean(doc.extracted?._sample);
  let base64: string | undefined;
  let mimeType = "image/jpeg";
  if (!sample) {
    const original = attachmentsOf(db, "document", id)[0];
    const bytes = original ? await readObject(original.storageKey) : null;
    if (!original || !bytes) fail(back, "元の画像が保存されていないため読み直せません。お手数ですが、もう一度撮影・取込してください。");
    base64 = bytes.toString("base64");
    mimeType = original.contentType;
  }
  const result = await extractDocument({ kind, fileName: doc.fileName, mimeType, base64, products: db.products, storeId: doc.storeId, mode });
  const failed = result.provider === "error";
  await mutate((d) => {
    const x = findDoc(d, user, id);
    assertEditable(x, back);
    const before = x.kind;
    x.kind = kind;
    x.extracted = toExtracted(result, sample, mode);
    x.confidence = result.confidence;
    x.status = failed ? "failed" : "extracted";
    addAudit(d, { userId: user.id, action: "update", entity: "document", entityId: id, entityLabel: x.fileName, summary: `書類を読み直し (${before !== kind ? `${DOCUMENT_KIND_LABEL[before]} → ` : ""}${DOCUMENT_KIND_LABEL[kind]} / ${PROVIDER_LABEL[result.provider]}${failed ? `: ${result.error}` : ""})`, storeId: x.storeId });
  });
  revalidatePath("/capture");
  if (mode) revalidatePath("/capture/calc");
  if (failed) redirect(withErr(back, failMessage(result)));
  redirect(withMsg(back, readMessage(result, mode)));
}

/** 画面で確認・修正した内容を受け取る (書類の種類ごとに決めた項目だけ。長さも制限する) */
function parseEdited(formData: FormData, kind: DocumentKind, back: string): Record<string, unknown> {
  const raw = String(formData.get("data") ?? "");
  let data: unknown;
  try {
    if (raw.length > 300_000) throw new Error("too large");
    data = JSON.parse(raw || "{}");
  } catch {
    fail(back, "入力内容を読み取れませんでした。もう一度お試しください。");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) fail(back, "入力内容を読み取れませんでした。");
  const allowed = new Set(FIELD_KEYS[kind]);
  const clip = (v: unknown, depth = 0): unknown => {
    if (typeof v === "string") return v.slice(0, 4000);
    if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
    if (Array.isArray(v)) return depth > 2 ? [] : v.slice(0, 200).map((x) => clip(x, depth + 1));
    if (v && typeof v === "object") return depth > 2 ? undefined : Object.fromEntries(Object.entries(v).slice(0, 40).map(([k, x]) => [k.slice(0, 40), clip(x, depth + 1)]));
    return v === null || typeof v === "boolean" ? v : undefined;
  };
  return Object.fromEntries(Object.entries(data as Record<string, unknown>).filter(([k]) => allowed.has(k)).map(([k, v]) => [k, clip(v)]));
}

const META_KEYS = ["_case", "_provider", "_model", "_aiWarnings", "_error", "_ms", "_readAt", "_sample", "_ai", "_accountCandidates", "_mode", "_calc", "_calcCheck"];

/** 読取の確認が必要か (AI が自信がないとした項目・行が残っている) */
function needsConfirmation(prev: Record<string, unknown> | undefined, edited: Record<string, unknown>): boolean {
  const fields = (edited.uncertainFields ?? prev?.uncertainFields) as unknown;
  const rows = Array.isArray(edited.items) && (edited.items as { uncertain?: boolean }[]).some((i) => i?.uncertain);
  return (Array.isArray(fields) && fields.length > 0) || rows;
}

function applyEdits(doc: CapturedDocument, edited: Record<string, unknown>, warnings: string[], user: User, confirmed = false) {
  const prev = doc.extracted ?? {};
  const meta = Object.fromEntries(META_KEYS.filter((k) => prev[k] !== undefined).map((k) => [k, prev[k]]));
  // AI が「自信がない」とした項目・「消して書き直した」とした箇所は、担当者が確認するまで残す
  const unsure = edited.uncertainFields ?? prev.uncertainFields;
  const corrections = edited.corrections ?? prev.corrections;
  doc.extracted = { ...edited, ...(unsure ? { uncertainFields: unsure } : {}), ...(corrections ? { corrections } : {}), ...meta, _warnings: warnings, _edited: { by: user.id, at: nowIso() }, ...(confirmed ? { _confirmed: { by: user.id, at: nowIso() } } : prev._confirmed ? { _confirmed: prev._confirmed } : {}) };
  if (doc.status === "failed" || doc.status === "uploaded") doc.status = "extracted";
}

function customerQuery(name: unknown): string {
  return typeof name === "string" ? name.normalize("NFKC").replace(/(様|御中|殿)\s*$/, "").replace(/\s+/g, " ").trim().slice(0, 40) : "";
}

/**
 * 確認・修正した内容を保存し、選んだ登録先へ進む
 * intent: save (保存のみ) / confirm (データとして確定) / quote・expense・purchase (各画面へ。読取内容を初期値にする)
 */
export async function saveExtraction(formData: FormData) {
  const user = await requireActionUser();
  const id = str(formData, "id");
  const back = `/capture?doc=${id}`;
  const intent = choice(formData, "intent", ["save", "confirm", "quote", "expense", "purchase", "survey"] as const, "save");
  const db = getDb();
  const doc0 = findDoc(db, user, id);
  assertEditable(doc0, back);
  if (intent !== "save" && intent !== "confirm" && !REGISTER_TARGETS[doc0.kind].includes(intent)) fail(back, "この種類の書類は、その登録先には登録できません。");
  const { extracted, warnings } = normalizeExtracted(doc0.kind, parseEdited(formData, doc0.kind, back), db.products, { mode: calcMode(doc0) });
  const confirmed = formData.get("confirmedUncertain") === "on";
  if (intent !== "save" && intent !== "confirm" && needsConfirmation(doc0.extracted, extracted) && !confirmed) {
    // 入力した修正は保存してから断る (修正が消えないように)
    await mutate((d) => {
      const doc = findDoc(d, user, id);
      assertEditable(doc, back);
      applyEdits(doc, extracted, warnings, user);
    });
    fail(back, "読み取りに自信がない項目 (黄色) があります。修正は保存しました。元の書類と見比べて確認し、「確認しました」にチェックを入れてから登録してください。");
  }
  let surveyId = "";
  if (intent === "survey" && BACKEND === "supabase" && missingTables().includes("survey_responses") && (await recheckMissingTables()).includes("survey_responses")) {
    fail(back, "データベースにアンケートの表がまだありません。開発担当が npm run db:migrate を実行すると登録できるようになります。");
  }
  await mutate((d) => {
    const doc = findDoc(d, user, id);
    assertEditable(doc, back);
    applyEdits(doc, extracted, warnings, user, confirmed);
    if (intent === "confirm") doc.status = "confirmed";
    addAudit(d, { userId: user.id, action: "update", entity: "document", entityId: id, entityLabel: doc.fileName, summary: intent === "confirm" ? "取込書類の読取内容を確認・確定" : "取込書類の読取内容を確認・修正", storeId: doc.storeId });
    if (intent === "survey") {
      // 案件: 入力された受注番号 → はがき No. で売上台帳の「ハガキ」欄と照合
      const ref = str(formData, "orderRef").normalize("NFKC").trim().split(/\s+/)[0]?.toUpperCase() ?? "";
      const no = extracted.postcardNo as string | undefined;
      const order = ref ? d.orders.find((o) => o.number.toUpperCase() === ref) : findOrderByPostcard(d, no, { storeId: storeFromPostcard(no), date: extracted.answeredOn as string | undefined });
      if (ref && !order) fail(back, `受注番号「${ref}」が見つかりません。番号を確認してください。`);
      if (order) assertStore(user, order.storeId, back);
      const users = new Set(d.users.map((u) => u.id));
      const pickUser = (v: string) => (v && users.has(v) ? v : undefined);
      const sv = surveyFromExtracted(d, {
        extracted,
        order,
        storeId: order?.storeId ?? storeFromPostcard(no) ?? doc.storeId,
        clerkUserId: pickUser(str(formData, "clerkUserId")),
        salesUserId: pickUser(str(formData, "salesUserId")),
        deliveryUserIds: formData.getAll("deliveryUserIds").map(String).filter((v) => users.has(v)),
        documentId: doc.id,
        userId: user.id,
      });
      if ("error" in sv) fail(back, sv.error);
      d.surveys.push(sv.survey);
      surveyId = sv.survey.id;
      doc.status = "confirmed";
      doc.linkedType = "survey";
      doc.linkedId = sv.survey.id;
      if (order) {
        relinkDocumentAttachments(d, doc.id, { type: "order", id: order.id, customerId: order.customerId, storeId: order.storeId });
        if (!order.postcardNo && sv.survey.postcardNo) order.postcardNo = sv.survey.postcardNo;
        order.progressNotes.push({ id: newId("pn"), at: nowIso(), userId: user.id, kind: "note", body: `お客様アンケートを登録 (はがき No.${sv.survey.postcardNo ?? "-"} / ①${sv.survey.phoneScore ?? "-"} ②${sv.survey.salesScore ?? "-"} ③${sv.survey.craftsmanScore ?? "-"} ④${sv.survey.finishScore ?? "-"})` });
        order.updatedAt = nowIso();
      }
      addAudit(d, { userId: user.id, action: "create", entity: "survey", entityId: sv.survey.id, entityLabel: `はがき No.${sv.survey.postcardNo ?? "-"}`, summary: `お客様アンケートを登録 (はがきの写真から${order ? ` / 受注 ${order.number}` : " / 案件未設定"})`, storeId: sv.survey.storeId });
    }
  });
  revalidatePath("/capture");
  if (intent === "survey") {
    revalidatePath("/kpi");
    redirect(withMsg(`/kpi/surveys/${surveyId}`, "アンケートを登録しました。返信率・評価・KPI に反映されています。"));
  }
  const customerId = str(formData, "customerId");
  switch (intent) {
    case "quote": {
      const qs = new URLSearchParams({ documentId: id });
      // 案件から撮影した見積書 (予定表の小さな画面・見積の作成の画面。captureCaseQuote): その案件 (お客様・問い合わせ・案件) の見積にして、元の画面に戻る
      const ctx = doc0.extracted?._case as { inquiryId?: string; customerId?: string; caseId?: string; returnTo?: string } | undefined;
      if (ctx?.returnTo) qs.set("returnTo", safeReturn(ctx.returnTo, "/schedule"));
      if (ctx?.customerId || ctx?.inquiryId || ctx?.caseId) {
        if (ctx.customerId) qs.set("customerId", ctx.customerId);
        if (ctx.inquiryId) qs.set("inquiryId", ctx.inquiryId);
        if (ctx.caseId) qs.set("caseId", ctx.caseId);
        redirect(`/quotes/new?${qs.toString()}`);
      }
      // 選んだお客様、なければ電話番号が 1 人のお客様と一致すればそのお客様、なければ氏名で検索
      if (customerId) qs.set("customerId", customerId);
      else setQuoteCustomer(qs, user, extracted);
      redirect(`/quotes/new?${qs.toString()}`);
    }
    case "expense":
      redirect(`/expenses/new?documentId=${id}`);
    case "purchase":
      redirect(`/purchases/new?documentId=${id}`);
    case "confirm":
      redirect(withMsg(back, "読取内容を確定して保存しました。"));
    default:
      redirect(withMsg(back, warnings.length ? `修正を保存しました (確認事項 ${warnings.length} 件)。` : "修正を保存しました。"));
  }
}

/** 入力された番号 (受注番号・問い合わせ番号・顧客コード) から保存先を探す */
function resolveTarget(db: Database, ref: string): { type: "order" | "inquiry" | "customer"; id: string; storeId: CapturedDocument["storeId"]; customerId?: string; label: string; href: string } | null {
  const key = ref.normalize("NFKC").trim().split(/\s+/)[0]?.toUpperCase();
  if (!key) return null;
  const o = db.orders.find((x) => x.number.toUpperCase() === key || x.id === ref.trim());
  if (o) return { type: "order", id: o.id, storeId: o.storeId, customerId: o.customerId, label: `受注 ${o.number}`, href: `/orders/${o.id}` };
  const i = db.inquiries.find((x) => x.number.toUpperCase() === key || x.id === ref.trim());
  if (i) return { type: "inquiry", id: i.id, storeId: i.storeId, customerId: i.customerId, label: `問い合わせ ${i.number}`, href: `/inquiries/${i.id}` };
  const c = db.customers.find((x) => x.code.toUpperCase() === key || x.id === ref.trim());
  if (c) return { type: "customer", id: c.id, storeId: c.storeId, customerId: c.id, label: `顧客 ${c.code} ${c.name}`, href: `/customers/${c.id}` };
  return null;
}

function summaryLines(kind: DocumentKind, ex: Record<string, unknown>): string {
  const lines: string[] = [`[${DOCUMENT_KIND_LABEL[kind]}]`];
  const add = (label: string, v: unknown) => {
    if (typeof v === "string" && v.trim()) lines.push(`${label}: ${v.trim()}`);
    else if (typeof v === "number") lines.push(`${label}: ${v.toLocaleString("ja-JP")}`);
  };
  add("件名", ex.title);
  add("お客様", ex.customerName ?? ex.siteName);
  add("現場", ex.siteAddress);
  add("施工予定日", ex.workDate);
  add("取引先", ex.partnerName);
  if (Array.isArray(ex.rooms) && ex.rooms.length) lines.push(`部屋: ${(ex.rooms as { name?: string; size?: string; tatamiCount?: number }[]).map((r) => [r.name, r.size ?? (r.tatamiCount ? `${r.tatamiCount}畳` : "")].filter(Boolean).join(" ")).join(" / ")}`);
  if (Array.isArray(ex.fittings) && ex.fittings.length) lines.push(`建具: ${(ex.fittings as { kind?: string; name?: string; count?: number; widthMm?: number; heightMm?: number }[]).map((f) => `${f.kind ?? ""}${f.name ? ` (${f.name})` : ""}${f.count ? ` ${f.count}枚` : ""}${f.widthMm && f.heightMm ? ` ${f.widthMm}×${f.heightMm}mm` : ""}`).join(" / ")}`);
  if (Array.isArray(ex.items) && ex.items.length) lines.push(`明細: ${(ex.items as { name: string; qty?: number; unit?: string }[]).map((i) => `${i.name}${i.qty !== undefined ? ` ${i.qty}${i.unit ?? ""}` : ""}`).join(" / ")}`);
  add("指示・仕様", ex.instructions);
  add("要約", ex.summary);
  add("備考", ex.note);
  return lines.join("\n").slice(0, 3000);
}

/** 図面・施工資料などを、受注・問い合わせ・顧客に保存する (元の画像はその記録の添付ファイルになる) */
export async function attachDocument(formData: FormData) {
  const user = await requireActionUser();
  const id = str(formData, "id");
  const back = `/capture?doc=${id}`;
  const ref = str(formData, "target");
  if (!ref) fail(back, "保存先の受注番号・問い合わせ番号・顧客コードを入力してください。");
  const db = getDb();
  const doc0 = findDoc(db, user, id);
  assertEditable(doc0, back);
  const target0 = resolveTarget(db, ref);
  if (!target0) fail(back, `「${ref}」に当たる受注・問い合わせ・顧客が見つかりません。番号を確認してください。`);
  // 店長はほかの店舗の受注・問い合わせ・顧客にも保存できる (permissions.ts の canEditCaseStore)
  assertCaseStore(user, target0.storeId, back);
  const { extracted, warnings } = normalizeExtracted(doc0.kind, parseEdited(formData, doc0.kind, back), db.products, { mode: calcMode(doc0) });
  let label = "";
  let href = "";
  await mutate((d) => {
    const doc = findDoc(d, user, id);
    assertEditable(doc, back);
    const target = resolveTarget(d, ref);
    if (!target) fail(back, "保存先が見つかりません。");
    label = target.label;
    href = target.href;
    applyEdits(doc, extracted, warnings, user);
    doc.status = "confirmed";
    doc.linkedType = target.type;
    doc.linkedId = target.id;
    relinkDocumentAttachments(d, doc.id, { type: target.type, id: target.id, customerId: target.customerId, storeId: target.storeId });
    const now = nowIso();
    const body = `取込書類「${doc.fileName}」を保存しました。\n${summaryLines(doc.kind, extracted)}`;
    if (target.type === "order") {
      const o = d.orders.find((x) => x.id === target.id)!;
      o.progressNotes.push({ id: newId("pn"), at: now, userId: user.id, kind: doc.kind === "drawing" ? "survey" : "note", body });
      o.updatedAt = now;
    }
    if (target.type === "inquiry") {
      const i = d.inquiries.find((x) => x.id === target.id)!;
      i.updatedAt = now;
    }
    addAudit(d, { userId: user.id, action: "update", entity: "document", entityId: id, entityLabel: doc.fileName, summary: `取込書類を${target.label}に保存`, storeId: doc.storeId });
    addAudit(d, { userId: user.id, action: "update", entity: target.type, entityId: target.id, entityLabel: target.label.replace(/^(受注|問い合わせ|顧客) /, ""), summary: `${DOCUMENT_KIND_LABEL[doc.kind]}「${doc.fileName}」を添付 (書類取込)`, storeId: target.storeId });
  });
  revalidatePath("/capture");
  revalidatePath(href);
  redirect(withMsg(href, `取込書類を${label}に保存しました (元の画像は添付ファイルにあります)。`));
}

export async function discardDocument(id: string) {
  const user = await requireActionUser();
  await mutate((db) => {
    const doc = findDoc(db, user, id);
    if (doc.status === "confirmed") fail(`/capture?doc=${id}`, "登録済みの書類は破棄できません。");
    doc.status = "discarded";
    addAudit(db, { userId: user.id, action: "status", entity: "document", entityId: id, entityLabel: doc.fileName, summary: "取込書類を破棄", storeId: doc.storeId });
  });
  revalidatePath("/capture");
  redirect(withMsg("/capture", "書類を破棄しました。"));
}

/** 図面など、データ化のみ行い保存 (確認画面の「確定して保存」と同じ。古い画面からの呼び出し用) */
export async function confirmDocument(id: string) {
  const user = await requireActionUser();
  await mutate((db) => {
    const doc = findDoc(db, user, id);
    if (doc.status === "discarded") fail("/capture", "破棄した書類は確定できません。もう一度取り込んでください。");
    doc.status = "confirmed";
    addAudit(db, { userId: user.id, action: "update", entity: "document", entityId: id, entityLabel: doc.fileName, summary: "取込書類の読取内容を確定", storeId: doc.storeId });
  });
  revalidatePath("/capture");
  redirect(withMsg(`/capture?doc=${id}`, "読取内容を確定しました。"));
}

/* ================================================================== */
/* 金額を書く前に撮影した手書き見積書 (/capture/calc)                      */
/* ================================================================== */

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** 計算の画面で確かめた数量・単価 (と税込・税抜・値引き) を保存する。ほかの読取項目はそのまま */
export async function saveCalc(formData: FormData) {
  const user = await requireActionUser();
  const id = str(formData, "id");
  const back = `/capture/calc?doc=${id}`;
  const raw = String(formData.get("data") ?? "");
  let data: { items?: unknown; taxMode?: unknown; discount?: unknown };
  try {
    if (raw.length > 200_000) throw new Error("too large");
    data = JSON.parse(raw || "{}");
  } catch {
    fail(back, "入力内容を読み取れませんでした。もう一度お試しください。");
  }
  if (!Array.isArray(data.items)) fail(back, "明細を読み取れませんでした。");
  const items = (data.items as Record<string, unknown>[]).slice(0, 100).map((r) => ({
    name: typeof r?.name === "string" ? r.name.slice(0, 200) : "",
    spec: typeof r?.spec === "string" ? r.spec.slice(0, 200) : "",
    unit: typeof r?.unit === "string" ? r.unit.slice(0, 20) : "",
    qty: num(r?.qty) ?? null,
    unitPrice: num(r?.unitPrice) ?? null,
    amount: num(r?.amount) ?? null,
    rate: num(r?.rate) ?? null,
    uncertain: r?.uncertain === true,
    corrected: r?.corrected === true,
  }));
  const taxMode = data.taxMode === "税抜" ? "税抜" : "税込";
  const discount = Math.max(0, Math.round(num(data.discount) ?? 0));
  const db = getDb();
  const doc0 = findDoc(db, user, id);
  assertEditable(doc0, back);
  if (doc0.kind !== "handwritten_quote") fail(back, "金額の計算は手書き見積書だけです。");
  const prev = Object.fromEntries(Object.entries(doc0.extracted ?? {}).filter(([k]) => !k.startsWith("_")));
  const { extracted, warnings } = normalizeExtracted("handwritten_quote", { ...prev, items, taxMode, discount: discount || null }, db.products, { mode: "calc" });
  let before = 0;
  await mutate((d) => {
    const doc = findDoc(d, user, id);
    assertEditable(doc, back);
    before = num(doc.extracted?.total) ?? 0;
    const meta = Object.fromEntries(Object.entries(doc.extracted ?? {}).filter(([k]) => k.startsWith("_") && k !== "_warnings" && k !== "_edited"));
    doc.extracted = { ...extracted, ...meta, _warnings: warnings, _edited: { by: user.id, at: nowIso() } };
    if (doc.status === "failed" || doc.status === "uploaded") doc.status = "extracted";
    addAudit(d, {
      userId: user.id,
      action: "update",
      entity: "document",
      entityId: id,
      entityLabel: doc.fileName,
      summary: `金額の計算: 数量・単価を確認・修正 (合計 ${num(extracted.total)?.toLocaleString("ja-JP") ?? "-"} 円)`,
      storeId: doc.storeId,
      changes: before !== num(extracted.total) ? [{ field: "total", before, after: num(extracted.total) ?? 0 }] : undefined,
    });
  });
  revalidatePath("/capture/calc");
  revalidatePath("/capture");
  redirect(withMsg(back, "確かめた数量・単価と計算結果を保存しました。この金額を見積書に書き写してください。"));
}

/**
 * 金額を書き写した見積書をもう一度撮影し、書き写した金額が計算と同じか確かめる。
 * 写真は同じ書類の添付ファイルに足し (計算に使った写真も残す)、読取結果は記入済みの見積書として置き換える
 * (このあと通常の確認画面で お客様・見積の登録へ進む)。計算の結果は _calc、照合の結果は _calcCheck に残す
 */
export async function recheckCalc(formData: FormData) {
  const user = await requireActionUser();
  const id = str(formData, "id");
  const back = `/capture/calc?doc=${id}`;
  const db = getDb();
  const doc0 = findDoc(db, user, id);
  assertEditable(doc0, back);
  if (doc0.kind !== "handwritten_quote") fail(back, "書き写しの確認は手書き見積書だけです。");
  const up = await readUpload(formData, back);
  if (!up && aiEnabled()) fail(back, "金額を書き写した見積書を撮影してください。");
  // 照合のもと: 計算の画面の結果 (保存されている明細から計算し直す)
  const ex0 = doc0.extracted ?? {};
  const calcItems = Array.isArray(ex0.items) ? (ex0.items as LineItem[]) : [];
  const taxIncluded = ex0.taxIncluded !== false;
  const discount = num(ex0.discount) ?? 0;
  const calc = calcSheet(calcItems, { taxIncluded, discount });
  const snapshot = {
    items: calcItems.map((it, i) => ({ name: it.name, spec: it.spec, qty: it.qty, unit: it.unit, unitPrice: it.unitPrice, amount: calc.rows[i].amount ?? undefined })),
    subtotal: calc.subtotal,
    discount: calc.discount,
    tax: calc.tax,
    total: calc.total,
    taxIncluded,
    at: nowIso(),
    by: user.id,
  };
  const result = await extractDocument({ kind: "handwritten_quote", fileName: up?.fileName ?? doc0.fileName, mimeType: up?.mimeType ?? "image/jpeg", base64: up?.base64, products: db.products, storeId: doc0.storeId });
  const failed = result.provider === "error";
  // 読めなかった写真は残さない (計算の画面の写真・「もう一度読み取る」は計算に使った写真のまま)
  const original = up && !failed ? await storeOriginal(user, formData, doc0, up) : undefined;
  let check: ReturnType<typeof compareTranscription> | undefined;
  await mutate((d) => {
    const doc = findDoc(d, user, id);
    assertEditable(doc, back);
    if (failed) {
      addAudit(d, { userId: user.id, action: "update", entity: "document", entityId: id, entityLabel: doc.fileName, summary: `金額の計算: 書き写した見積書の読取に失敗 (${result.error ?? ""})`, storeId: doc.storeId });
      return;
    }
    if (original) d.attachments.push(original);
    const readItems = Array.isArray(result.extracted.items) ? (result.extracted.items as LineItem[]) : [];
    const readTotal = num(result.extracted.totalTaxIncluded) ?? num(result.extracted.total);
    check = compareTranscription({ rows: snapshot.items, total: snapshot.total }, { rows: readItems, total: readTotal });
    const items = readItems.map((it, i) => (check!.rows.includes(i) ? { ...it, uncertain: true } : it));
    const head = check.issues.length
      ? `書き写しの確認: 計算と違う・読み取れない箇所が ${check.issues.length} 件あります。見積書の金額を確かめてください`
      : `書き写しの確認: ${check.checked} 行の金額と合計が、すべて計算と一致しました`;
    const ex = toExtracted({ ...result, extracted: { ...result.extracted, items }, warnings: [head, ...check.issues, ...result.warnings] }, false);
    doc.extracted = { ...ex, _calc: snapshot, _calcCheck: { checked: check.checked, matched: check.matched, issues: check.issues, totalMatched: check.totalMatched, at: nowIso() } };
    doc.confidence = result.confidence;
    doc.status = "extracted";
    addAudit(d, {
      userId: user.id,
      action: "update",
      entity: "document",
      entityId: id,
      entityLabel: doc.fileName,
      summary: `金額の計算: 書き写した見積書を照合 (${check.matched}/${check.checked} 行が一致${check.totalMatched === false ? "・合計が違う" : ""})`,
      storeId: doc.storeId,
      changes: [{ field: "status", before: "金額の計算", after: "記入済みの見積書" }],
    });
  }).catch(async (err) => {
    if (original) await discardStored(original);
    throw err;
  });
  revalidatePath("/capture");
  revalidatePath("/capture/calc");
  if (failed) redirect(withErr(back, `書き写した見積書を読み取れませんでした: ${result.error ?? "原因不明のエラー"} もう一度撮影してください。`));
  const c = check!;
  if (c.issues.length) redirect(withErr(`/capture?doc=${id}`, `書き写しの確認: 計算と違う・読み取れない箇所が ${c.issues.length} 件あります (黄色の行と上の注意を確かめてください)。`));
  redirect(withMsg(`/capture?doc=${id}`, `書き写しの確認: ${c.checked} 行の金額と合計が、すべて計算と一致しました。お客様・内容を確かめて見積を作成してください。`));
}
