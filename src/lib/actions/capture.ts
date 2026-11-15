"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { BACKEND, addAudit, getDb, mutate, newId, nowIso } from "@/lib/db/store";
import { missingTables, recheckMissingTables } from "@/lib/db/supabase";
import { attachmentsOf, detectType, discardStored, relinkDocumentAttachments, storeFile } from "@/lib/attachments";
import { readObject } from "@/lib/storage";
import type { Attachment, CapturedDocument, Database, DocumentKind, User } from "@/lib/db/types";
import { aiEnabled, extractDocument, FIELD_KEYS, normalizeExtracted, type OcrResult } from "@/lib/ai/ocr";
import { REGISTER_TARGETS } from "@/lib/capture-fields";
import { DOCUMENT_KIND_LABEL } from "@/lib/constants";
import { findOrderByPostcard, storeFromPostcard, surveyFromExtracted } from "@/lib/survey-link";
import { assertStore, choice, fail, requireActionUser, resolveStoreId, str, withErr, withMsg } from "./guards";
import { canAccessStore } from "@/lib/auth/permissions";

// 写真は画面側で縮小してから送る。PDF などは 4 MB まで (Vercel の 1 回の送信の上限 4.5 MB)
const MAX_BYTES = 4 * 1024 * 1024;

const PROVIDER_LABEL: Record<OcrResult["provider"], string> = { claude: "Claude", openai: "OpenAI", mock: "サンプル", error: "読取失敗" };

/** 読取結果を書類に保存する形 (_ で始まる項目は読取の記録) */
function toExtracted(result: OcrResult, sample: boolean): Record<string, unknown> {
  return {
    ...result.extracted,
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

function readMessage(result: OcrResult): string {
  return `読み取りが完了しました (${PROVIDER_LABEL[result.provider]} / 確度 ${Math.round(result.confidence * 100)}%)。内容を確認・修正してから登録してください。`;
}

function failMessage(result: OcrResult): string {
  return `AI で読み取れませんでした: ${result.error ?? "原因不明のエラー"} 内容を手入力して登録するか、「もう一度読み取る」を押してください。`;
}

export async function uploadDocument(formData: FormData) {
  const user = await requireActionUser();
  const back = "/capture";
  const kind = choice(formData, "kind", DOCUMENT_KIND_LABEL, "other");
  const storeId = resolveStoreId(user, str(formData, "storeId"));
  assertStore(user, storeId, back);
  const file = formData.get("file");
  const sampleName = str(formData, "sampleName").slice(0, 120);
  let fileName = sampleName || "sample.jpg";
  let mimeType = "image/jpeg";
  let base64: string | undefined;
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_BYTES) fail(back, "ファイルサイズは 4MB 以下にしてください (写真は自動で縮小されます)。");
    fileName = file.name.slice(0, 200) || "document";
    const t = detectType(fileName, file.type);
    if (!t || (!t.photo && t.contentType !== "application/pdf")) fail(back, "写真 (JPEG・PNG など) か PDF を取り込んでください。");
    mimeType = t.contentType;
    base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
  } else if (aiEnabled()) {
    fail(back, "書類を撮影するか、画像・PDF のファイルを選んでください。");
  }
  const db = getDb();
  const result = await extractDocument({ kind, fileName, mimeType, base64, products: db.products, storeId });
  const id = newId("doc");
  // 元の画像・PDF を保存する (確認画面・登録した見積・経費・仕入請求書・受注の画面で表示する)。保存できなくても読取結果は登録する
  let original: Attachment | undefined;
  const noTable = BACKEND === "supabase" && missingTables().includes("attachments") && (await recheckMissingTables()).includes("attachments");
  if (base64 && !noTable) {
    try {
      const thumb = formData.get("thumb");
      original = await storeFile({
        user,
        parent: { type: "document", id, storeId, label: `取込書類 ${fileName}`, href: `/capture?doc=${id}`, entity: "document" },
        file: { name: fileName, type: mimeType, bytes: Buffer.from(base64, "base64") },
        thumb: thumb instanceof File && thumb.size > 0 ? { name: "thumb.jpg", type: "image/jpeg", bytes: Buffer.from(await thumb.arrayBuffer()) } : undefined,
        takenAt: str(formData, "takenAt") || undefined,
      });
    } catch (err) {
      console.warn("[capture] original not stored:", (err as Error).message);
      original = undefined;
    }
  }
  const failed = result.provider === "error";
  await mutate((d) => {
    if (original) d.attachments.push(original!);
    d.documents.push({ id, kind, fileName, uploadedBy: user.id, storeId, uploadedAt: nowIso(), status: failed ? "failed" : "extracted", extracted: toExtracted(result, !base64), confidence: result.confidence });
    addAudit(d, { userId: user.id, action: "create", entity: "document", entityId: id, entityLabel: fileName, summary: `書類を取込・AI読取 (${DOCUMENT_KIND_LABEL[kind]} / ${PROVIDER_LABEL[result.provider]}${failed ? `: ${result.error}` : ""})`, storeId });
  }).catch(async (err) => {
    if (original) await discardStored(original);
    throw err;
  });
  revalidatePath(back);
  if (failed) redirect(withErr(`${back}?doc=${id}`, failMessage(result)));
  redirect(withMsg(`${back}?doc=${id}`, readMessage(result)));
}

function findDoc(db: Database, user: User, id: string): CapturedDocument {
  const doc = db.documents.find((d) => d.id === id);
  if (!doc) fail("/capture", "書類が見つかりません。");
  assertStore(user, doc.storeId, "/capture");
  return doc;
}

function assertEditable(doc: CapturedDocument, back: string) {
  if (doc.status === "confirmed") fail(back, "登録済みの書類は変更できません (登録先の画面で修正してください)。");
  if (doc.status === "discarded") fail(back, "破棄した書類は変更できません。もう一度取り込んでください。");
}

/** もう一度読み取る (種類を変えて読み直すこともできる)。保存してある元の画像・PDF を使う */
export async function retryExtraction(formData: FormData) {
  const user = await requireActionUser();
  const id = str(formData, "id");
  const back = `/capture?doc=${id}`;
  const db = getDb();
  const doc = findDoc(db, user, id);
  assertEditable(doc, back);
  const kind = choice(formData, "kind", DOCUMENT_KIND_LABEL, doc.kind);
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
  const result = await extractDocument({ kind, fileName: doc.fileName, mimeType, base64, products: db.products, storeId: doc.storeId });
  const failed = result.provider === "error";
  await mutate((d) => {
    const x = findDoc(d, user, id);
    assertEditable(x, back);
    const before = x.kind;
    x.kind = kind;
    x.extracted = toExtracted(result, sample);
    x.confidence = result.confidence;
    x.status = failed ? "failed" : "extracted";
    addAudit(d, { userId: user.id, action: "update", entity: "document", entityId: id, entityLabel: x.fileName, summary: `書類を読み直し (${before !== kind ? `${DOCUMENT_KIND_LABEL[before]} → ` : ""}${DOCUMENT_KIND_LABEL[kind]} / ${PROVIDER_LABEL[result.provider]}${failed ? `: ${result.error}` : ""})`, storeId: x.storeId });
  });
  revalidatePath("/capture");
  if (failed) redirect(withErr(back, failMessage(result)));
  redirect(withMsg(back, readMessage(result)));
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

const META_KEYS = ["_provider", "_model", "_aiWarnings", "_error", "_ms", "_readAt", "_sample", "_ai", "_accountCandidates"];

/** 読取の確認が必要か (AI が自信がないとした項目・行が残っている) */
function needsConfirmation(prev: Record<string, unknown> | undefined, edited: Record<string, unknown>): boolean {
  const fields = (edited.uncertainFields ?? prev?.uncertainFields) as unknown;
  const rows = Array.isArray(edited.items) && (edited.items as { uncertain?: boolean }[]).some((i) => i?.uncertain);
  return (Array.isArray(fields) && fields.length > 0) || rows;
}

function applyEdits(doc: CapturedDocument, edited: Record<string, unknown>, warnings: string[], user: User, confirmed = false) {
  const prev = doc.extracted ?? {};
  const meta = Object.fromEntries(META_KEYS.filter((k) => prev[k] !== undefined).map((k) => [k, prev[k]]));
  // AI が「自信がない」とした項目は、担当者が確認するまで残す
  const unsure = edited.uncertainFields ?? prev.uncertainFields;
  doc.extracted = { ...edited, ...(unsure ? { uncertainFields: unsure } : {}), ...meta, _warnings: warnings, _edited: { by: user.id, at: nowIso() }, ...(confirmed ? { _confirmed: { by: user.id, at: nowIso() } } : prev._confirmed ? { _confirmed: prev._confirmed } : {}) };
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
  const { extracted, warnings } = normalizeExtracted(doc0.kind, parseEdited(formData, doc0.kind, back), db.products);
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
      const cq = customerQuery(extracted.customerName ?? extracted.siteName);
      const qs = new URLSearchParams({ documentId: id });
      // 電話番号が 1 人のお客様と一致すれば、そのお客様を選ぶ
      const digits = typeof extracted.phone === "string" ? extracted.phone.replace(/\D/g, "") : "";
      const byPhone = !customerId && digits.length >= 9 ? getDb().customers.filter((c) => c.phone.replace(/\D/g, "") === digits && canAccessStore(user, c.storeId)) : [];
      if (customerId) qs.set("customerId", customerId);
      else if (byPhone.length === 1) qs.set("customerId", byPhone[0].id);
      else if (cq) qs.set("cq", cq);
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
  assertStore(user, target0.storeId, back);
  const { extracted, warnings } = normalizeExtracted(doc0.kind, parseEdited(formData, doc0.kind, back), db.products);
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
