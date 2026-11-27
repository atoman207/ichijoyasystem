"use server";

import { sameCaseSameDay } from "@/lib/case-duplicates";
import { buildCaseMap, caseSummary } from "@/lib/case-group";
import { caseForAdd, caseRecordIds, noteInquiryOnCase, type CaseAdd } from "@/lib/case-choice";
import { scheduleCheckLink } from "@/lib/msg-link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { BACKEND, addAudit, getDb, mutate, newId, nextCustomerCode, nextNumber, nowIso } from "@/lib/db/store";
import { missingTables, recheckMissingTables } from "@/lib/db/supabase";
import type { Attachment, CapturedDocument, Channel, CommLog, Customer, Database, Inquiry, InquiryIntake, MediaKey, ScheduleEvent, ScheduleKind, StoreId, User } from "@/lib/db/types";
import { attachmentsOf, detectType, discardStored, relinkDocumentAttachments, storeFile } from "@/lib/attachments";
import { readObject } from "@/lib/storage";
import { CHANNEL_LABEL, SCHEDULE_KIND } from "@/lib/constants";
import { findConflicts, isDateKey, periodLabel } from "@/lib/calendar";
import { mapTablesReady, saveEventLocationMode } from "@/lib/maps/store";
import { addChangeNotice, caseTarget } from "@/lib/change-notices";
import { canAccessStore, canEditCaseStore, canSeeAllStores } from "@/lib/auth/permissions";
import { createInquiryRequest } from "@/lib/inquiry-requests";
import { candidateLabel, findDuplicateCustomers, needsConfirmation } from "@/lib/duplicates";
import { newCaseStore } from "@/lib/store-area";
import { addInquiryPhone, canLinkToCustomer, isPlaceholderCustomer } from "@/lib/customer-link";
import { adoptPlaceholderCase, fillPlaceholderFromFields } from "@/lib/placeholder-customer";
import { placeholderMatches } from "@/lib/placeholder-match";
import { withPostal } from "@/lib/postal/lookup";
import { isCommonStaff } from "@/lib/staff-choices";
import { dueAtFrom } from "@/lib/inquiry-flow";
import { taskNotices } from "@/lib/notify/events";
import { sendAndRecord } from "@/lib/notify/send";
import { storeInquiryNotices } from "@/lib/notify/store-line";
import { MEDIA_LABEL, isMediaKey, mapMediaText, readMediaRules } from "@/lib/media";
import { toDateKey } from "@/lib/format";
import { withAiContext } from "@/lib/ai/usage";
import { readReception } from "@/lib/ai/reception";
import {
  RECEPTION_ACTION_LABEL,
  RECEPTION_CHANNELS,
  RECEPTION_FIELD_KEYS,
  RECEPTION_SOURCE_LABEL,
  RECEPTION_TYPE_LABEL,
  categoryKey,
  normalizeReception,
  receptionFieldsOf,
  receptionHref,
  receptionMetaOf,
  receptionRegOf,
  type ReceptionAction,
  type ReceptionAppointment,
  type ReceptionFields,
  type ReceptionMeta,
  type ReceptionReg,
  type ReceptionSource,
} from "@/lib/reception";
import { newReceptionDoc, providerLabel, pushReceptionDoc, receptionExtracted } from "@/lib/reception-docs";
import { assertStore, choice, fail, requireActionUser, resolveStoreId, str, withErr, withMsg } from "./guards";
import { placeTextOrEmpty } from "@/lib/maps/address";

/**
 * 受付 (すべての問い合わせの共通の入口。src/lib/reception.ts)
 * 取込: 手書きメモの写真・話して入力・文章 → AI が項目と内容の種類を読み取り → 確認待ち
 * 登録: 担当者が確かめて、問い合わせとして登録 (新規案件 / 既存の案件に追加 = Inquiry.caseId。どちらも問い合わせを作る) / 記録だけ / 記録しない。
 * 入口・媒体・担当店舗・担当者は確認の画面で 1 回だけ選び (読み取りの前には聞かない)、紐付け・保存のあとも _reg に残す (お客様のご要望 2026-11-26「■2」「■5」)
 */

const LIST = "/inquiries/reception";
// 写真は画面側で縮小してから送る (Server Action の送信は 4.5 MB まで)
const MAX_BYTES = 4 * 1024 * 1024;

const channelOf = (formData: FormData, fallback: (typeof RECEPTION_CHANNELS)[number] = "phone") => choice(formData, "channel", CHANNEL_LABEL, fallback);

/** 元の写真を受付の添付ファイルとして保存する (登録したら問い合わせ・案件に付け替える)。保存できなくても受付は登録する */
async function storePhoto(user: User, formData: FormData, doc: { id: string; storeId: CapturedDocument["storeId"]; fileName: string }, up: { fileName: string; mimeType: string; bytes: Buffer }): Promise<Attachment | undefined> {
  const noTable = BACKEND === "supabase" && missingTables().includes("attachments") && (await recheckMissingTables()).includes("attachments");
  if (noTable) return undefined;
  try {
    const thumb = formData.get("thumb");
    return await storeFile({
      user,
      parent: { type: "document", id: doc.id, storeId: doc.storeId, label: `受付メモ ${doc.fileName}`, href: receptionHref(doc.id), entity: "document" },
      file: { name: up.fileName, type: up.mimeType, bytes: up.bytes },
      thumb: thumb instanceof File && thumb.size > 0 ? { name: "thumb.jpg", type: "image/jpeg", bytes: Buffer.from(await thumb.arrayBuffer()) } : undefined,
      takenAt: str(formData, "takenAt") || undefined,
    });
  } catch (err) {
    console.warn("[reception] photo not stored:", (err as Error).message);
    return undefined;
  }
}

/** 受付を取り込む: source = photo (手書きメモの写真) / text (文章) / voice (話して入力した文章) */
export async function createReception(formData: FormData) {
  const user = await requireActionUser();
  const source: ReceptionSource = str(formData, "source") === "photo" ? "photo" : str(formData, "source") === "voice" ? "voice" : "text";
  const db = getDb();
  // 案件の画面の「この案件に問い合わせを追加」から開いたとき: 案件とお客様が決まっている (お客様のご要望 2026-11-26「■5」)
  const presetCase = str(formData, "caseId");
  const caseSum = presetCase ? caseSummary(db, presetCase, toDateKey(new Date())) : undefined;
  if (presetCase && !caseSum) fail(LIST, "案件が見つかりません。");
  // 顧客の画面から取り込むときはお客様が決まっている (お客様のご要望 2026-11-24「■6」)。受付の店舗はお客様の店舗 (扱えなければ自分の店舗)
  const presetId = str(formData, "customerId") || caseSum?.customerId || "";
  const preset = presetId ? db.customers.find((c) => c.id === presetId) : undefined;
  if (presetId && (!preset || !canEditCaseStore(user, preset.storeId))) fail(LIST, "お客様が見つからないか、このお客様の問い合わせを登録する権限がありません。");
  // 受付の店舗 (受付を見られる店舗。担当店舗は読み取りのあとの確認の画面で 1 回だけ選ぶ。お客様のご要望 2026-11-26「■2」)
  const storeId = resolveStoreId(user, str(formData, "storeId"), preset && canAccessStore(user, preset.storeId) ? preset.storeId : undefined);
  assertStore(user, storeId, LIST);
  // 入口は確認の画面で選ぶ (初期値は電話。お客様のご要望 2026-11-24「⑤」)
  const channel = channelOf(formData, "phone");
  let text: string | undefined;
  let photo: { fileName: string; mimeType: string; bytes: Buffer } | undefined;
  if (source === "photo") {
    const file = formData.get("file");
    const sample = str(formData, "sampleName");
    if (file instanceof File && file.size > 0) {
      if (file.size > MAX_BYTES) fail(LIST, "ファイルサイズは 4MB 以下にしてください (写真は自動で縮小されます)。");
      const t = detectType(file.name, file.type);
      if (!t || (!t.photo && t.contentType !== "application/pdf")) fail(LIST, "写真 (JPEG・PNG など) か PDF を取り込んでください。");
      photo = { fileName: file.name.slice(0, 200) || "memo.jpg", mimeType: t.contentType, bytes: Buffer.from(await file.arrayBuffer()) };
    } else if (!sample) fail(LIST, "メモを撮影するか、写真のファイルを選んでください。");
  } else {
    text = str(formData, "text").slice(0, 30_000);
    if (text.length < 4) fail(LIST, "受付の内容を入力するか、話して入力してください。");
  }
  const read = await withAiContext({ kind: "reception", userId: user.id }, () =>
    readReception(db, photo ? { image: { base64: photo.bytes.toString("base64"), mimeType: photo.mimeType, fileName: photo.fileName } } : { text, today: toDateKey(new Date()) }),
  );
  const id = newId("doc");
  const doc = newReceptionDoc({ id, uploadedBy: user.id, storeId, source, channel, fileName: photo?.fileName, text, read, customerId: preset?.id });
  if (caseSum && caseSum.customerId === preset?.id) doc.extracted = { ...(doc.extracted ?? {}), _reg: { caseId: caseSum.id } satisfies ReceptionReg };
  const original = photo ? await storePhoto(user, formData, doc, photo) : undefined;
  await mutate((d) => {
    if (original) d.attachments.push(original);
    pushReceptionDoc(d, doc, user.id);
  }).catch(async (err) => {
    if (original) await discardStored(original);
    throw err;
  });
  revalidatePath(LIST);
  revalidatePath("/inquiries");
  const href = receptionHref(id);
  if (read.provider === "error") redirect(withErr(href, `${read.error ?? "AI で読み取れませんでした。"} 内容を入力して登録するか、「もう一度読み取る」を押してください。`));
  redirect(withMsg(href, `読み取りました (${providerLabel(read.provider)})。内容と登録先を確かめてから登録してください。`));
}

function findReception(db: Database, user: User, id: string, back = LIST): CapturedDocument {
  const doc = db.documents.find((d) => d.id === id && d.kind === "reception");
  if (!doc) fail(back, "受付が見つかりません。");
  assertStore(user, doc.storeId, back);
  return doc;
}

function assertOpen(doc: CapturedDocument, back: string) {
  if (doc.status === "confirmed") fail(back, "この受付は登録済みです (登録先の画面で修正してください)。");
  if (doc.status === "discarded") fail(back, "この受付は閉じています。");
}

/** もう一度 AI で読み取る (保存してある写真・文章を使う) */
export async function rereadReception(formData: FormData) {
  const user = await requireActionUser();
  const id = str(formData, "id");
  const back = receptionHref(id);
  const db = getDb();
  const doc = findReception(db, user, id);
  assertOpen(doc, back);
  const meta = receptionMetaOf(doc);
  let input: Parameters<typeof readReception>[1];
  if (meta.source === "photo") {
    const original = attachmentsOf(db, "document", id)[0];
    const bytes = original ? await readObject(original.storageKey) : null;
    if (!original || !bytes) fail(back, "元の写真が保存されていないため読み直せません。もう一度撮影してください。");
    input = { image: { base64: bytes.toString("base64"), mimeType: original.contentType, fileName: original.fileName } };
  } else {
    if (!meta.text) fail(back, "読み直す文章がありません。");
    input = { text: meta.text, today: toDateKey(new Date()) };
  }
  const read = await withAiContext({ kind: "reception", userId: user.id }, () => readReception(db, input));
  await mutate((d) => {
    const x = findReception(d, user, id);
    assertOpen(x, back);
    x.extracted = receptionExtracted(read, meta);
    x.confidence = read.confidence;
    x.status = read.provider === "error" && meta.source === "photo" ? "failed" : "extracted";
    addAudit(d, { userId: user.id, action: "update", entity: "document", entityId: id, entityLabel: x.fileName, summary: `受付を読み直し (${providerLabel(read.provider)}${read.error ? `: ${read.error}` : ""})`, storeId: x.storeId });
  });
  revalidatePath(back);
  if (read.provider === "error") redirect(withErr(back, `${read.error ?? "AI で読み取れませんでした。"} 内容を入力して登録してください。`));
  redirect(withMsg(back, "読み直しました。内容を確かめてください。"));
}

/** 画面で直した受付の項目 */
function editedFields(formData: FormData, prev: ReceptionFields): ReceptionFields {
  const raw: Record<string, unknown> = {};
  for (const k of RECEPTION_FIELD_KEYS) if (k !== "uncertainFields" && formData.has(k)) raw[k] = str(formData, k);
  const next = normalizeReception({ ...prev, ...raw });
  // 要確認の項目は「確認しました」まで残す
  next.uncertainFields = formData.get("confirmedUncertain") === "on" ? [] : prev.uncertainFields;
  return next;
}

/**
 * 確認の画面で選んだ登録の値 (媒体・担当店舗・担当者・引き継ぎ・案件)。送られた項目だけ (ほかは前の値のまま)。
 * 紐付け・新規顧客の登録・修正の保存のあとも同じ値で開く (お客様のご要望 2026-11-26「■2 同じ情報は一度の入力で」)
 */
function regFromForm(formData: FormData, prev: ReceptionReg): ReceptionReg {
  const next: ReceptionReg = { ...prev };
  // 媒体・担当者は手で選んだときだけ残す (選んでいなければ、開くたびに案件の媒体・メモの言葉・案件の担当から決め直す)
  const media = str(formData, "media");
  if (formData.has("mediaPicked")) {
    if (str(formData, "mediaPicked") === "1" && isMediaKey(media)) next.media = media;
    else delete next.media;
  }
  const storeId = str(formData, "storeId");
  if (storeId && getDb().stores.some((s) => s.id === storeId)) {
    next.storeId = storeId as StoreId;
    next.storeManual = str(formData, "storeAuto") !== "1";
  }
  const assignee = str(formData, "assignedUserId");
  if (formData.has("assigneePicked")) {
    if (str(formData, "assigneePicked") === "1" && assignee) next.assigneeId = assignee;
    else delete next.assigneeId;
  }
  if (formData.has("handoffSent")) next.handoff = formData.get("handoff") === "on";
  if (formData.has("caseId")) next.caseId = str(formData, "caseId") || "new";
  return next;
}

function applyFields(doc: CapturedDocument, f: ReceptionFields, user: User, channel?: string, formData?: FormData) {
  const prev = doc.extracted ?? {};
  const meta = Object.fromEntries(Object.entries(prev).filter(([k]) => k.startsWith("_")));
  const reg = formData ? regFromForm(formData, receptionRegOf(prev._reg)) : undefined;
  doc.extracted = { ...f, ...meta, ...(channel ? { _channel: channel } : {}), ...(reg ? { _reg: reg } : {}), _edited: { by: user.id, at: nowIso() } };
  if (doc.status === "failed" || doc.status === "uploaded") doc.status = "extracted";
}

/** 直した内容 (と選んだ登録の値) を保存してから断る (入力した内容を消さない) */
async function saveAndFail(user: User, id: string, f: ReceptionFields, channel: Channel, formData: FormData, back: string, message: string): Promise<never> {
  await mutate((d) => {
    const doc = findReception(d, user, id);
    assertOpen(doc, back);
    applyFields(doc, f, user, channel, formData);
  });
  fail(back, message);
}

/** 受付の日時: 画面の入力 (日本時間) → 通話の開始 → 取り込んだ日時。未来の日時は断る */
function receivedAtOf(f: ReceptionFields, doc: CapturedDocument, meta: ReceptionMeta, back: string): string {
  if (f.receivedAt) {
    const d = new Date(`${f.receivedAt}:00+09:00`);
    if (Number.isNaN(d.getTime())) fail(back, "受付日時を正しく入力してください。");
    if (d.getTime() > Date.now() + 5 * 60 * 1000) fail(back, "受付日時に未来の日時は入力できません。");
    return d.toISOString();
  }
  return meta.call?.startedAt ?? doc.uploadedAt;
}

/** やりとりの記録の本文: 内容 + 文字起こし・メモの文字 */
function logBody(f: ReceptionFields, meta: ReceptionMeta): string {
  const lines = [
    f.summary,
    f.detail && f.detail !== f.summary ? f.detail : "",
    f.desiredDate ? `希望の日時: ${f.desiredDate}` : "",
    f.callback === "要" ? "折返し: 要" : "",
    meta.call?.recordingUrl ? `録音: ${meta.call.recordingUrl}` : "",
  ].filter(Boolean);
  const raw = meta.text || f.memoText;
  return [...lines, raw ? `\n--- ${meta.source === "photo" ? "メモの文字" : meta.source === "audio" || meta.source === "phone_api" ? "通話の文字起こし" : "入力した内容"} ---\n${raw}` : ""].filter(Boolean).join("\n").slice(0, 20000);
}

const MEDIA_REQUIRED = "媒体 (当社を知ったきっかけ) を選んでください。お客様に聞けなかったときは「不明」を選びます。";

/** 媒体 (問い合わせの登録では必須。言葉は対応表で読み替える)。選ばれていないときは fallback (既存の案件の媒体) */
function readMedia(formData: FormData, fallback?: MediaKey): MediaKey | undefined {
  const v = str(formData, "media");
  if (isMediaKey(v)) return v;
  const mapped = v ? mapMediaText(readMediaRules(getDb()).rules, v) : null;
  return mapped ?? fallback;
}

/** 番号・キー (inquiry:<id> など) から案件 */
function resolveCase(db: Database, key: string, ref: string): { type: "inquiry" | "quote" | "order"; id: string; number: string; storeId: CapturedDocument["storeId"]; customerId?: string; title: string; href: string; ownerId?: string } | null {
  const [type, id] = key.split(":");
  const num = ref.normalize("NFKC").trim().toUpperCase();
  const inq = type === "inquiry" ? db.inquiries.find((x) => x.id === id) : num ? db.inquiries.find((x) => x.number.toUpperCase() === num) : undefined;
  if (inq) return { type: "inquiry", id: inq.id, number: inq.number, storeId: inq.storeId, customerId: inq.customerId, title: inq.summary, href: `/inquiries/${inq.id}`, ownerId: inq.assignedUserId };
  const q = type === "quote" ? db.quotes.find((x) => x.id === id) : num ? db.quotes.find((x) => x.number.toUpperCase() === num) : undefined;
  if (q) return { type: "quote", id: q.id, number: q.number, storeId: q.storeId, customerId: q.customerId, title: q.title, href: `/quotes/${q.id}`, ownerId: q.estimatorId ?? q.createdBy };
  const o = type === "order" ? db.orders.find((x) => x.id === id) : num ? db.orders.find((x) => x.number.toUpperCase() === num) : undefined;
  if (o) {
    const quote = o.quoteId ? db.quotes.find((x) => x.id === o.quoteId) : undefined;
    return { type: "order", id: o.id, number: o.number, storeId: o.storeId, customerId: o.customerId, title: o.title, href: `/orders/${o.id}`, ownerId: quote?.estimatorId ?? quote?.createdBy ?? o.createdBy };
  }
  return null;
}

function decision(doc: CapturedDocument, d: ReceptionMeta["decision"]) {
  doc.extracted = { ...(doc.extracted ?? {}), _decision: d };
}

/**
 * 同じ案件・同じ日・同じ種類のまとまりの予定 (src/lib/case-duplicates.ts)。既存の案件に追加した問い合わせ (caseId) は、
 * その案件のすべての記録 (問い合わせ・見積・受注) の予定と比べる (つながり 問い合わせ ⇄ 見積 ⇄ 受注 だけでは案件のほかの記録の予定が見えないため)
 */
function caseDuplicates(d: Database, inq: Inquiry, date: string, kind: ScheduleKind, customerId?: string): ScheduleEvent[] {
  const ids = caseRecordIds(buildCaseMap(d), inq.id);
  const found = new Map<string, ScheduleEvent>();
  const probes = [{ inquiryId: inq.id, quoteId: inq.quoteId }, ...ids.inquiryIds.map((inquiryId) => ({ inquiryId })), ...ids.quoteIds.map((quoteId) => ({ quoteId })), ...ids.orderIds.map((orderId) => ({ orderId }))];
  for (const p of probes) for (const e of sameCaseSameDay(d, { date, kind, customerId, ...p })) found.set(e.id, e);
  return [...found.values()];
}

/**
 * 受付で読み取った日程 (確認の画面で直したもの) のうち「予定表に登録」を選んだものを、問い合わせの予定として登録する (mutate の中)。
 * 担当者は行ごとに選んだ人 (なければ問い合わせの担当)。担当者の予定と重なっていても登録し、注意を返す (登録したあとに予定表で直せる)。
 * 同じ案件・同じ日の予定があれば登録しない。lines = 結果の文、dates = 登録した予定の日 (「予定表で確認」のリンク。src/lib/msg-link.ts)
 */
function registerAppointments(d: Database, user: User, inq: Inquiry, list: ReceptionAppointment[], opts: { assigneeId: string; customerId?: string; noticeId?: string }): { lines: string[]; dates: { date: string; pickup?: boolean }[] } {
  const out: string[] = [];
  const skipped: string[] = [];
  const dates: { date: string; pickup?: boolean }[] = [];
  const now = nowIso();
  const active = new Set(d.users.filter((u) => u.active).map((u) => u.id));
  for (const a of list) {
    if (!a.register || !isDateKey(a.date)) continue;
    const kind = a.kind as ScheduleKind;
    // 同じ案件・同じ日の予定がすでにあれば登録しない (二重登録を防ぐ。お客様のご連絡 2026-11-26。src/lib/case-duplicates.ts)
    const dupe = caseDuplicates(d, inq, a.date, kind, opts.customerId);
    if (dupe.length) {
      skipped.push(`${SCHEDULE_KIND[kind].label} ${a.date.slice(5).replace("-", "/")} は同じ案件の予定 (${dupe.map((e) => `${SCHEDULE_KIND[e.kind].label} ${periodLabel(e)}`).join("・")}) があるため登録しませんでした`);
      continue;
    }
    const assignee = a.assigneeId && active.has(a.assigneeId) ? a.assigneeId : opts.assigneeId;
    const ev: ScheduleEvent = {
      id: newId("ev"),
      title: `${inq.contactName} ${SCHEDULE_KIND[kind].short ?? SCHEDULE_KIND[kind].label}`.trim(),
      kind,
      date: a.date,
      startTime: a.time || undefined,
      slot: a.time ? undefined : a.slot || undefined,
      storeId: inq.storeId,
      assigneeIds: [assignee],
      customerId: opts.customerId,
      inquiryId: inq.id,
      location: inq.siteAddress,
      memo: a.text ? `メモの日程: ${a.text}` : undefined,
      source: "manual",
      createdBy: user.id,
      createdAt: now,
      updatedBy: user.id,
      updatedAt: now,
    };
    const hits = findConflicts({ date: ev.date, startTime: ev.startTime, slot: ev.slot, assigneeIds: ev.assigneeIds }, d.schedule);
    d.schedule.push(ev);
    if (mapTablesReady() && (ev.customerId || ev.inquiryId)) saveEventLocationMode(d, user, ev, inq.siteAddress ? "custom" : "follow");
    addAudit(d, { userId: user.id, action: "create", entity: "schedule", entityId: ev.id, entityLabel: ev.title, summary: `受付のメモの日程から予定を登録 (${periodLabel(ev)} ${SCHEDULE_KIND[kind].label} / 案件 ${inq.number}${hits.length ? " / 担当者の予定と重複" : ""})`, storeId: ev.storeId });
    out.push(`${SCHEDULE_KIND[kind].label} ${periodLabel(ev)}${hits.length ? " (担当者の予定と重なっています。予定表で確かめてください)" : ""}`);
    dates.push({ date: ev.date, pickup: kind === "pickup" });
  }
  if (out.length) {
    if (inq.status === "new") inq.status = "in_progress";
    addChangeNotice(d, user.id, caseTarget(d, opts.noticeId ?? inq.id), "予定の追加", out.map((t) => ({ label: "予定", before: "(なし)", after: t })));
  }
  return { lines: [...out, ...skipped], dates };
}

/**
 * 問合せ登録の確認の画面の「お客様・案件の確認」(お客様のご要望 2026-11-25「問い合わせ登録時の顧客登録・紐付け」①②):
 * - link (既存のお客様に紐付ける) / new (新規顧客として登録 = その場で顧客を保存する) / unlink (紐付けをやめる)
 * 選んだお客様は受付に残し (_customerId)、そのあとの「問い合わせとして登録する」では、お客様を選び直さない。
 * 新規顧客は、問合せ登録から登録するときは誰でも登録できる (同じお客様の候補があれば「別のお客様です」の確認が要る)。問い合わせはまだ登録しない
 */
async function chooseReceptionCustomer(user: User, id: string, formData: FormData, f: ReceptionFields, channel: Channel, what: "new" | "unlink" | string): Promise<never> {
  const back = receptionHref(id);
  let message = "";
  await mutate((d) => {
    const doc = findReception(d, user, id);
    assertOpen(doc, back);
    applyFields(doc, f, user, channel, formData);
    const x = doc.extracted as Record<string, unknown>;
    // 案件の選択はお客様ごと (お客様を変えたら選び直す。お客様の案件を候補に出し直す)
    const reg = receptionRegOf(x._reg);
    if (what === "unlink" || what !== x._customerId) {
      delete reg.caseId;
      x._reg = reg;
    }
    if (what === "unlink") {
      const before = x._customerId;
      delete x._customerId;
      message = before ? "お客様の紐付けをやめました。もう一度お客様を選んでください (登録した顧客の情報は残っています)。" : "お客様は紐付いていません。";
      return;
    }
    if (what !== "new") {
      const c = d.customers.find((y) => y.id === what);
      if (!c) fail(back, "選んだお客様が見つかりません。");
      if (!canLinkToCustomer(d, user, c)) fail(back, "このお客様は閲覧の範囲の外のため紐付けられません。店舗または本部に依頼してください。");
      x._customerId = c.id;
      // 予定表 (スプレッドシート) から移行した仮のお客様 (名字と地区だけ): メモの電話番号・住所などを足して正式なお客様にする (お客様のご連絡 2026-11-27)
      const filled = isPlaceholderCustomer(c) ? fillPlaceholderFromFields(d, user, c, { name: f.customerName, kana: f.kana, phone: f.phone, address: f.address }) : undefined;
      addAudit(d, { userId: user.id, action: "update", entity: "document", entityId: id, entityLabel: doc.fileName, summary: `受付を既存の顧客 ${c.code} ${c.name} に紐付け`, storeId: doc.storeId });
      message = `${c.name} 様 (${c.code}) に紐付けました。${filled ? `${filled} ` : ""}新しいご依頼か、すでにある案件のご連絡かを選んで、内容を確かめてから登録してください。`;
      return;
    }
    // 新規顧客として登録 (この時点で顧客を保存する)
    const name = f.customerName || f.companyName;
    if (!name) fail(back, "お名前 (会社のときは会社名) を入れてから「新規顧客として登録」を押してください。入力した内容は保存しました。");
    const dup = findDuplicateCustomers(d, { name, phone: f.phone, otherPhones: [f.otherPhone].filter(Boolean), email: f.email, postalCode: f.postalCode, address: f.address });
    if (needsConfirmation(dup) && formData.get("confirmDuplicate") !== "on") {
      fail(back, `同じお客様の可能性がある顧客があります (${candidateLabel(dup)})。同じお客様なら候補の「このお客様に紐付ける」を、別のお客様なら「上の候補とは別のお客様です」にチェックしてから「新規顧客として登録」を押してください。`);
    }
    // 予定表 (スプレッドシート) から移行した予定の仮のお客様 (名字と地区だけ) と同じ人らしいとき: 二重にしないように確かめる (お客様のご連絡 2026-11-27)
    const sheet = placeholderMatches(d, { name: f.customerName, kana: f.kana, phones: [f.phone, f.otherPhone], addresses: [f.address, f.siteAddress], dates: f.appointments.map((a) => a.date) }, { visible: (c) => canLinkToCustomer(d, user, c) });
    if (sheet.length && formData.get("confirmDuplicate") !== "on") {
      const m = sheet[0];
      fail(back, `予定表から移行した予定のお客様「${m.customer.name}」様 (${m.customer.code}・${m.reason}) が仮に登録されています。同じお客様なら「予定表から移行した予定のお客様」の「このお客様に紐付ける」を、別のお客様なら「上の候補とは別のお客様です」にチェックしてから「新規顧客として登録」を押してください。`);
    }
    const now = nowIso();
    // お客様の店舗: 確認の画面の担当店舗 (手で選んだとき) > お客様の住所の担当エリア > 受付の店舗
    const storeId = newCaseStore(d, user, { requested: str(formData, "storeId") || doc.storeId, auto: str(formData, "storeAuto") === "1", address: f.address, customer: undefined }).storeId;
    const c: Customer = {
      id: newId("cust"),
      code: nextCustomerCode(d),
      name,
      kana: f.kana,
      type: !f.customerName && f.companyName ? "corporate" : "individual",
      phone: f.phone,
      ...(f.otherPhone ? { contacts: [{ id: newId("ct"), relation: "その他", phone: f.otherPhone }] } : {}),
      ...(f.email ? { email: f.email } : {}),
      postalCode: withPostal(f.address, f.postalCode),
      address: f.address,
      storeId,
      assignedUserId: user.id,
      preferredChannel: channel === "line" || channel === "email" ? channel : "phone",
      firstContactChannel: channel,
      tags: [],
      notes: `問合せ登録 (${RECEPTION_SOURCE_LABEL[receptionMetaOf(doc).source]}) から登録`,
      createdAt: now,
      updatedAt: now,
    };
    d.customers.push(c);
    x._customerId = c.id;
    x._customerCreated = c.id;
    addAudit(d, { userId: user.id, action: "create", entity: "customer", entityId: c.id, entityLabel: `${c.code} ${c.name}`, summary: `問合せ登録 (受付) から顧客を登録${needsConfirmation(dup) ? ` · 重複候補 ${candidateLabel(dup)} を確認済み` : ""}`, storeId });
    message = `新しいお客様 ${c.name} 様 (${c.code}) を顧客として登録しました。内容を確かめて「問い合わせとして登録する」を押してください。`;
  });
  revalidatePath(back);
  revalidatePath("/customers");
  redirect(withMsg(back, message));
}

/**
 * 受付を保存・登録する。intent = save (直した内容を保存) / inquiry (問い合わせ。caseId = "new" か追加する案件の ID) /
 * case (登録先で選んだ案件・案件番号に問い合わせを追加) / record / dismiss。quick = link:<顧客> / new / unlink / case:<案件>
 */
export async function registerReception(formData: FormData) {
  const user = await requireActionUser();
  const id = str(formData, "id");
  const back = receptionHref(id);
  // ワンタッチの登録 (確認の画面の上の「このお客様に紐付けて登録」「この案件のやりとりに追加」「新しいお客様として登録」。お客様のご要望 2026-11-24「追加 ③」)
  const quick = str(formData, "quick");
  // お客様の紐付け・新規顧客の登録は、その場で完了させる (お客様のご要望 2026-11-25「問い合わせ登録時の顧客登録・紐付け」①②):
  // link:<顧客> = このお客様に紐付ける / new = 新規顧客として登録する (顧客を保存) / unlink = 紐付けをやめる。どれも問い合わせはまだ登録しない
  const linkTo = quick.startsWith("link:") ? quick.slice("link:".length) : quick.startsWith("inquiry:") ? quick.slice("inquiry:".length) : undefined;
  const quickCase = quick.startsWith("case:") ? quick.slice("case:".length) : undefined;
  const db0 = getDb();
  const doc0 = findReception(db0, user, id);
  assertOpen(doc0, back);
  const prev = receptionFieldsOf(doc0);
  const f = editedFields(formData, prev);
  const meta0 = receptionMetaOf(doc0);
  const channel = channelOf(formData, meta0.channel);
  const confirmed = formData.get("confirmedUncertain") === "on";
  if (linkTo !== undefined || quick === "new" || quick === "unlink") return chooseReceptionCustomer(user, id, formData, f, channel, quick === "new" ? "new" : quick === "unlink" ? "unlink" : linkTo!);
  const intent = quickCase ? "case" : choice(formData, "intent", ["save", "inquiry", "case", "record", "dismiss"] as const, "save");

  if (intent === "save") {
    await mutate((d) => {
      const doc = findReception(d, user, id);
      assertOpen(doc, back);
      applyFields(doc, f, user, channel, formData);
      addAudit(d, { userId: user.id, action: "update", entity: "document", entityId: id, entityLabel: doc.fileName, summary: "受付の内容を確認・修正", storeId: doc.storeId });
    });
    revalidatePath(back);
    redirect(withMsg(back, "修正を保存しました。"));
  }

  if (intent === "dismiss") {
    const note = str(formData, "dismissNote").slice(0, 200) || (f.callType ? RECEPTION_TYPE_LABEL[f.callType] : "");
    await mutate((d) => {
      const doc = findReception(d, user, id);
      assertOpen(doc, back);
      applyFields(doc, f, user, channel);
      doc.status = "discarded";
      decision(doc, { action: "dismiss", at: nowIso(), by: user.id, note });
      addAudit(d, { userId: user.id, action: "status", entity: "document", entityId: id, entityLabel: doc.fileName, summary: `受付を記録せずに閉じる (${note || "理由なし"})`, storeId: doc.storeId });
    });
    revalidatePath(LIST);
    revalidatePath("/inquiries");
    redirect(withMsg(LIST, "受付を閉じました (問い合わせ・やりとりには記録していません)。"));
  }

  // 登録する前に、AI が自信がないとした項目を確かめてもらう
  if (prev.uncertainFields.length && !confirmed) {
    return saveAndFail(user, id, f, channel, formData, back, "読み取りに自信がない項目 (黄色) があります。修正は保存しました。メモ・会話と見比べて確かめ、「確認しました」にチェックを入れてから登録してください。");
  }

  const receivedAt = receivedAtOf(f, doc0, meta0, back);
  const urgent = f.urgency === "high";
  let href = "";
  let message = "";
  let notifyThreadId = "";
  let notifyNote = "";
  let newInquiryId = "";
  // 予定を登録したときの「予定表で確認」のリンク (お客様のご要望 2026-11-26「■8」。src/lib/msg-link.ts)
  let scheduleLink: { href: string; label: string } | undefined;

  if (intent === "inquiry" || intent === "case") {
    // 既存の案件に問い合わせを追加するときは、その案件 (お客様のご要望 2026-11-26「■5」。どちらでも問い合わせの記録を作る):
    // inquiry = 確認の画面の「② 案件」で選んだ案件 (caseId = 案件の ID。"new" = 新規案件)
    // case = 「登録先 (詳しく選ぶ)」の案件 (caseKey = <種類>:<ID>・caseRef = 案件番号) / ワンタッチの case:<案件の ID か 種類:ID>
    let caseRef = "";
    // 登録先で記録 (受注など) を選んだときは、その記録に連絡を書き残す
    let pickedRecord = false;
    if (intent === "case") {
      const key = quickCase ?? str(formData, "caseKey");
      const ref = quickCase ? "" : str(formData, "caseRef");
      if (!key && !ref) return saveAndFail(user, id, f, channel, formData, back, "問い合わせを追加する案件を選ぶか、案件番号を入力してください。");
      if (key && !ref && !key.includes(":")) caseRef = key;
      else {
        const t = resolveCase(db0, ref ? "" : key, ref);
        if (!t) return saveAndFail(user, id, f, channel, formData, back, ref ? `案件番号「${ref}」が見つかりません (INQ-・Q-・O- などの番号)。` : "選んだ案件が見つかりません。");
        caseRef = t.id;
        pickedRecord = true;
      }
    } else {
      const v = str(formData, "caseId");
      if (v && v !== "new") caseRef = v;
    }
    const add0 = caseRef ? caseForAdd(db0, user, caseRef, undefined, { record: pickedRecord }) : undefined;
    if (add0 && "error" in add0) return saveAndFail(user, id, f, channel, formData, back, add0.error);
    if (intent === "inquiry" && !f.summary) return saveAndFail(user, id, f, channel, formData, back, "用件 (要約) を入力してください。");
    const summary = f.summary || (add0 ? `案件 ${add0.number} の連絡` : "");
    // 媒体は必須 (確認の画面で 1 回だけ選ぶ。既存の案件に追加するときは、選ばなければ案件の媒体)
    const media = readMedia(formData, add0?.media);
    if (!media) return saveAndFail(user, id, f, channel, formData, back, MEDIA_REQUIRED);
    // お客様は必ず決める (紐付けた既存のお客様か、この画面で登録した新規顧客。案件番号で案件を選んだときは案件のお客様)。
    // お客様のない問い合わせは登録しない (お客様のご要望 2026-11-25「③」)
    const customerId = meta0.customerId ?? (intent === "case" ? add0?.customerId : undefined) ?? "";
    if (!customerId) return saveAndFail(user, id, f, channel, formData, back, "先に上の「お客様・案件の確認」で、既存のお客様に紐付けるか「新規顧客として登録」を押してください (問い合わせは必ずお客様に紐付けて保存します)。入力した内容は保存しました。");
    // 予定表から移行した仮のお客様の案件は、選んだお客様の案件にする (下の adoptPlaceholderCase。お客様のご連絡 2026-11-27)
    if (add0?.customerId && add0.customerId !== customerId && !isPlaceholderCustomer(db0.customers.find((c) => c.id === add0.customerId))) return saveAndFail(user, id, f, channel, formData, back, `案件 ${add0.number} は、紐付けたお客様の案件ではありません。案件を選び直すか、お客様を確かめてください。入力した内容は保存しました。`);
    const createdCustomer = meta0.customerId && (doc0.extracted as Record<string, unknown>)?._customerCreated === meta0.customerId ? db0.customers.find((c) => c.id === meta0.customerId)?.code ?? "" : "";
    let appointmentNote = "";
    let adoptNote = "";
    const addedPhones: string[] = [];
    // 担当者: 選んだ人 → (案件番号で追加するとき) 知らせる担当者 → 案件の担当 → 自分
    const pickedAssignee = str(formData, "assignedUserId") || (intent === "case" ? str(formData, "notifyUserId") : "");
    const handoff = formData.get("handoff") === "on" || (intent === "case" && formData.get("notifyOwner") === "on");
    const inqId = newId("inq");
    newInquiryId = inqId;
    await mutate((d) => {
      const doc = findReception(d, user, id);
      assertOpen(doc, back);
      const found = caseRef ? caseForAdd(d, user, caseRef, undefined, { record: pickedRecord }) : undefined;
      if (found && "error" in found) fail(back, found.error);
      let add: CaseAdd | undefined = found;
      const customer = d.customers.find((c) => c.id === customerId);
      if (!customer) fail(back, "選んだお客様が見つかりません。");
      // 紐付けられるお客様 = 顧客の一覧で見られるお客様 (ほかの店舗・本部で登録したお客様も。src/lib/customer-link.ts)
      if (!canLinkToCustomer(d, user, customer)) fail(back, "このお客様は閲覧の範囲の外のため紐付けられません。店舗または本部に依頼してください。");
      // 予定表 (スプレッドシート) から移行した仮のお客様の案件に追加: 案件と予定をこのお客様の案件にする (お客様のご連絡 2026-11-27
      // 「既存案件への紐付けができませんでした」。予定表の案件は名字と地区で仮に作ったお客様についている)
      if (add?.customerId && add.customerId !== customer.id) {
        const r = adoptPlaceholderCase(d, user, add.caseId, customer);
        if (!r.adopted) fail(back, r.error ?? `案件 ${add.number} は、紐付けたお客様の案件ではありません。`);
        adoptNote = r.note ? ` ${r.note}` : "";
        add = { ...add, customerId: customer.id };
      }
      // 担当店舗 (確認の画面で 1 回だけ選ぶ。お客様のご要望 2026-11-26「■2」): storeAuto = 1 は手で選んでいない (住所・案件で決める)
      const requested = str(formData, "storeId");
      const auto = str(formData, "storeAuto") === "1";
      // 既存の案件に追加: 案件の店舗 (手で選んだときは、その店舗の記録を変更できれば選んだ店舗)
      // 新規案件: 選んだ店舗 (自店舗・住所の担当エリアの店舗。全店舗のロールはすべて) > 住所 (施工現場 → お客様の住所) の担当エリア > お客様の店舗 > 受付の店舗 (お客様のご要望 2026-11-24「③」)
      const storeId: StoreId = add
        ? !auto && requested && d.stores.some((s) => s.id === requested) && canEditCaseStore(user, requested)
          ? requested
          : add.storeId
        : newCaseStore(d, user, { requested: requested || customer.storeId || doc.storeId, auto, address: f.siteAddress || f.address, customer }).storeId;
      const contactName = customer.name;
      const storeLabel = d.stores.find((s) => s.id === storeId)?.name ?? storeId;
      const selectable = (u: User) => canSeeAllStores(user) || u.storeId === storeId || u.role === "admin" || u.role === "hq_staff" || isCommonStaff(d, u);
      const activeUser = (uid: string | undefined) => (uid ? d.users.find((u) => u.id === uid && u.active) : undefined);
      let assignee = pickedAssignee ? activeUser(pickedAssignee) : undefined;
      if (pickedAssignee && !assignee) fail(back, "担当者が見つかりません。");
      if (!assignee) {
        // 選んでいないとき: 案件の担当 → 自分 (担当店舗の社員でなければ担当店舗の店長。画面の初期値と同じ)
        const owner = activeUser(add?.ownerId);
        const me = activeUser(user.id);
        const manager = activeUser(d.stores.find((s) => s.id === storeId)?.managerUserId);
        assignee = owner && selectable(owner) ? owner : me && selectable(me) ? me : (manager ?? me);
      }
      if (!assignee) fail(back, "担当者が見つかりません。");
      if (!selectable(assignee)) fail(back, `担当者は、担当店舗 (${storeLabel}) の社員か本部の社員から選んでください (自分で担当するときは、担当店舗を自店舗にしてください)。`);
      applyFields(doc, f, user, channel, formData);
      const now = nowIso();
      // 印・記号だけ (メモの丸印など) は施工現場にしない (maps/address.ts の isPlaceText)
      const siteRead = placeTextOrEmpty(f.siteAddress);
      const siteAddress = siteRead && siteRead !== (customer.address || f.address) ? siteRead : undefined;
      const detail = [
        f.detail,
        f.desiredDate ? `希望の日時: ${f.desiredDate}` : "",
        ...f.appointments.filter((a) => !a.register || !isDateKey(a.date)).map((a) => `メモの日程 (予定は未登録): ${a.text || `${a.date} ${a.time || (a.slot === "am" ? "午前" : a.slot === "pm" ? "午後" : "")}`.trim()}`),
        siteAddress ? `施工現場: ${siteAddress}` : "",
        f.otherPhone ? `ほかの電話番号: ${f.otherPhone}` : "",
        f.mediaText ? `当社を知ったきっかけ (聞いた言葉): ${f.mediaText}` : "",
        f.staffName ? `受けた人: ${f.staffName}` : "",
        `[受付 (${RECEPTION_SOURCE_LABEL[meta0.source]}) から登録]`,
      ]
        .filter(Boolean)
        .join("\n");
      const intake: InquiryIntake = { name: f.customerName || undefined, kana: f.kana || undefined, phone: f.phone || undefined, callbackPhone: f.otherPhone || undefined, email: f.email || undefined, postalCode: f.postalCode || undefined, address: f.address || undefined, desiredDate: f.desiredDate || undefined, urgency: f.urgency || undefined, mediaText: f.mediaText || undefined, recordingUrl: meta0.call?.recordingUrl, externalId: meta0.call?.id };
      const inq: Inquiry = {
        id: inqId,
        number: nextNumber(d, "INQ", d.inquiries, toDateKey(new Date(receivedAt))),
        customerId: customer.id,
        contactName,
        contactPhone: f.phone || customer.phone || undefined,
        channel,
        storeId,
        // 種別: 確認の画面の種別 (なければ追加する案件の種別)
        category: f.category ? categoryKey(f.category) : (add?.category ?? "other"),
        summary,
        detail,
        status: "new",
        assignedUserId: assignee.id,
        receivedAt,
        nextAction: `${urgent ? "至急: " : ""}${f.callback === "要" || channel === "phone" || channel === "mobile" ? "折返しの電話" : add ? "お客様へ連絡" : "お客様へ連絡 (見積・現地調査の日程)"}`,
        nextActionDue: toDateKey(new Date()),
        createdBy: user.id,
        updatedAt: now,
        media,
        source: "app",
        sourceRef: `reception:${doc.id}`,
        // 施工現場の住所 (依頼主の住所と違うとき。お客様のご要望 2026-11-25「⑨」)
        siteAddress,
        // 既存の案件に追加した問い合わせ (src/lib/case-group.ts)。問い合わせ一覧・案件の画面のどちらにも出る
        ...(add ? { caseId: add.caseId } : {}),
      };
      const cleanIntake = Object.fromEntries(Object.entries(intake).filter(([, v]) => v !== undefined && v !== "")) as InquiryIntake;
      if (Object.keys(cleanIntake).length) inq.intake = cleanIntake;
      d.inquiries.push(inq);
      addAudit(d, { userId: user.id, action: "create", entity: "inquiry", entityId: inqId, entityLabel: inq.number, summary: `受付から問い合わせを登録 (${contactName} / ${summary} / ${CHANNEL_LABEL[channel]} / 媒体: ${MEDIA_LABEL[media]}${add ? ` / 既存の案件 ${add.number} に追加` : ""})`, storeId });
      // やりとりの記録 (問い合わせの記録。お客様の履歴・案件の画面にも出る)
      const log: CommLog = { id: newId("cl"), customerId: customer.id, storeId, channel, direction: meta0.call?.direction === "outbound" ? "outbound" : "inbound", subject: `受付: ${summary}`.slice(0, 120), body: logBody(f, meta0), at: receivedAt, userId: user.id, relatedType: "inquiry", relatedId: inqId, contactName };
      d.commLogs.push(log);
      customer.updatedAt = now;
      // 既存の案件に追加: 受注の経過メモにも残し (受注の画面で分かるように)、案件の担当店舗に「変更のお知らせ」を出す
      if (add) noteInquiryOnCase(d, user.id, add, inq, { body: [f.detail, f.desiredDate ? `希望の日時: ${f.desiredDate}` : ""].filter(Boolean).join("\n"), via: "問合せ登録" });
      // 登録済みのお客様に紐付けたとき、メモの電話番号が登録にないなら「ほかの電話番号」に足す (次からその番号でも照合できる)
      if (!createdCustomer) for (const ph of [f.phone, f.otherPhone]) {
        const added = addInquiryPhone(d, user, customer, ph, `問合せ登録 ${inq.number} で聞いた番号`);
        if (added) addedPhones.push(added);
      }
      relinkDocumentAttachments(d, doc.id, { type: "inquiry", id: inqId, customerId: customer.id, storeId });
      // メモで決まっている日程を予定表に登録する (お客様のご要望 2026-11-25「⑦」: 読み取った日程を初期値に、確認の画面で直してから)
      const planned = registerAppointments(d, user, inq, f.appointments, { assigneeId: assignee.id, customerId: customer.id, noticeId: add?.target?.id });
      appointmentNote = planned.lines.length ? ` 予定表に ${planned.lines.join("・")} を登録しました。` : "";
      scheduleLink = scheduleCheckLink(planned.dates, storeId);
      doc.status = "confirmed";
      doc.linkedType = "inquiry";
      doc.linkedId = inqId;
      decision(doc, { action: add ? "case" : "inquiry", at: now, by: user.id, targetType: "inquiry", targetId: inqId, label: `問い合わせ ${inq.number}${add ? ` (案件 ${add.number})` : ""}`, href: `/inquiries/${inqId}` });
      addAudit(d, { userId: user.id, action: "update", entity: "document", entityId: id, entityLabel: doc.fileName, summary: `受付を問い合わせ ${inq.number} に登録${add ? ` (既存の案件 ${add.number} に追加)` : ""}`, storeId: doc.storeId });
      // 担当者がほかの人なら業務依頼で引き継ぐ (依頼 → 確認 → 報告で進める)
      if (handoff && assignee.id !== user.id) {
        const callback = inq.nextAction?.includes("折返し");
        notifyNote = `${urgent ? "【至急】" : ""}${add ? `案件 ${add.number} (${add.title}) について、お客様から連絡がありました (問い合わせ ${inq.number})。` : "受付から問い合わせを登録しました。"}内容を確認して、お客様へ${callback ? "折返し" : "連絡"}してください。対応したら「報告」で結果を書いてください。\n\n${detail}\n\n問い合わせ: /inquiries/${inqId}${add ? `\n案件: ${add.href}` : ""}`;
        // 期限: 至急は本日 12 時まで (過ぎていれば本日中)、ほかは本日中。期限を過ぎて返答がなければ自動で再通知 (src/lib/inquiry-followup.ts)
        const due = (urgent ? dueAtFrom("noon", undefined, new Date()) : {}).dueAt ?? dueAtFrom("today", undefined, new Date()).dueAt;
        const t = createInquiryRequest(d, { inquiry: inq, requestedBy: user.id, storeId, assignee, purpose: callback || add ? "contact" : "schedule", note: notifyNote, dueAt: due, urgent });
        notifyThreadId = t.id;
      }
      const phonesNote = addedPhones.length ? `。電話番号 ${addedPhones.join("・")} をお客様の「ほかの電話番号」に追加しました` : "";
      const handoffNote = notifyThreadId ? ` (${assignee.name} さんに引き継ぎました)` : "";
      if (add) {
        // 既存の案件に追加したときは案件の画面へ (案件の問い合わせ・見積・受注・予定がまとめて見える)
        href = add.href;
        message = `問い合わせ ${inq.number} を ${customer.name} 様の案件 ${add.number}${add.open ? "" : " (完了した案件)"} に追加しました${phonesNote}${handoffNote}。${adoptNote}${appointmentNote}`;
      } else {
        href = `/inquiries/${inqId}`;
        message = `問い合わせ ${inq.number} を${customer.name} 様${createdCustomer ? ` (新規顧客 ${createdCustomer})` : ""}の新しい案件として登録しました${phonesNote}${handoffNote}。${appointmentNote}`;
      }
    });
  } else {
    // record: 仕入先・協力業者 / お客様とのやりとりとして残す
    const supplierId = str(formData, "supplierId");
    const customerId = str(formData, "recordCustomerId");
    await mutate((d) => {
      const doc = findReception(d, user, id);
      assertOpen(doc, back);
      const supplier = supplierId ? d.suppliers.find((s) => s.id === supplierId) : undefined;
      const customer = customerId ? d.customers.find((c) => c.id === customerId) : undefined;
      if (supplierId && !supplier) fail(back, "仕入先・協力業者が見つかりません。");
      if (customerId && !customer) fail(back, "お客様が見つかりません。");
      if (!supplier && !customer) fail(back, "やりとりの相手 (仕入先・協力業者、またはお客様) を選んでください。相手を記録しないときは「記録しない」を選びます。");
      if (customer) assertStore(user, customer.storeId, back);
      applyFields(doc, f, user, channel);
      const now = nowIso();
      const storeId = customer?.storeId ?? doc.storeId;
      const log: CommLog = { id: newId("cl"), customerId: customer?.id, supplierId: supplier?.id, storeId, channel, direction: meta0.call?.direction === "outbound" ? "outbound" : "inbound", subject: `受付: ${f.summary || RECEPTION_TYPE_LABEL[f.callType || "other"]}`.slice(0, 120), body: logBody(f, meta0), at: receivedAt, userId: user.id, contactName: f.customerName || f.companyName || undefined };
      d.commLogs.push(log);
      if (customer) {
        customer.updatedAt = now;
        relinkDocumentAttachments(d, doc.id, { type: "customer", id: customer.id, customerId: customer.id, storeId: customer.storeId });
      }
      doc.status = "confirmed";
      if (customer) {
        doc.linkedType = "customer";
        doc.linkedId = customer.id;
      }
      const label = supplier ? `仕入先・協力業者「${supplier.name}」` : `お客様「${customer!.name}」`;
      const target = supplier ? `/suppliers/${supplier.id}` : `/customers/${customer!.id}`;
      decision(doc, { action: "record", at: now, by: user.id, targetType: supplier ? "supplier" : "customer", targetId: supplier?.id ?? customer!.id, label, href: target });
      addAudit(d, { userId: user.id, action: "create", entity: "comm", entityId: log.id, entityLabel: supplier?.name ?? customer!.name, summary: `受付をやりとりとして記録 (${label} / ${CHANNEL_LABEL[channel]})`, storeId });
      href = target;
      message = `${label}とのやりとりとして記録しました。`;
    });
  }

  // 知らせ (保存のあと。送れなくても登録は取り消さない)
  const db = getDb();
  if (notifyThreadId) {
    const t = db.threads.find((x) => x.id === notifyThreadId);
    if (t) await sendAndRecord(taskNotices(db, t, user.id, "request", f.summary), user.id).catch((err) => console.warn("[reception] task notice failed:", (err as Error).message));
  }
  if (newInquiryId) {
    const inq = db.inquiries.find((x) => x.id === newInquiryId);
    if (inq) await sendAndRecord(storeInquiryNotices(db, inq), user.id).catch((err) => console.warn("[reception] store LINE notice failed:", (err as Error).message));
  }
  revalidatePath(LIST);
  revalidatePath("/inquiries");
  if (href) revalidatePath(href);
  redirect(withMsg(href || LIST, message || RECEPTION_ACTION_LABEL[intent as ReceptionAction], scheduleLink));
}

