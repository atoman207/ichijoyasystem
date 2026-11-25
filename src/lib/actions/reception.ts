"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { BACKEND, addAudit, getDb, mutate, newId, nextCustomerCode, nextNumber, nowIso } from "@/lib/db/store";
import { missingTables, recheckMissingTables } from "@/lib/db/supabase";
import type { Attachment, CapturedDocument, CommLog, Customer, Database, Inquiry, InquiryIntake, ScheduleEvent, ScheduleKind, Thread, User } from "@/lib/db/types";
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
import { addInquiryPhone, canLinkToCustomer } from "@/lib/customer-link";
import { withPostal } from "@/lib/postal/lookup";
import { isCommonStaff } from "@/lib/staff-choices";
import { userCanCreateCustomer } from "@/lib/ops-settings";
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
  type ReceptionAction,
  type ReceptionAppointment,
  type ReceptionFields,
  type ReceptionMeta,
  type ReceptionSource,
} from "@/lib/reception";
import { newReceptionDoc, providerLabel, pushReceptionDoc, receptionExtracted } from "@/lib/reception-docs";
import { assertStore, choice, fail, requireActionUser, resolveStoreId, str, withErr, withMsg } from "./guards";

/**
 * 受付 (すべての問い合わせの共通の入口。src/lib/reception.ts)
 * 取込: 手書きメモの写真・話して入力・文章 → AI が項目と内容の種類を読み取り → 確認待ち
 * 登録: 担当者が確かめて、問い合わせとして登録 / 案件のやりとりに追加 / 記録だけ / 記録しない
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
  // 顧客の画面から取り込むときはお客様が決まっている (お客様のご要望 2026-11-24「■6」)。受付の店舗はお客様の店舗 (扱えなければ自分の店舗)
  const presetId = str(formData, "customerId");
  const preset = presetId ? db.customers.find((c) => c.id === presetId) : undefined;
  if (presetId && (!preset || !canEditCaseStore(user, preset.storeId))) fail(LIST, "お客様が見つからないか、このお客様の問い合わせを登録する権限がありません。");
  const storeId = resolveStoreId(user, str(formData, "storeId"), preset && canAccessStore(user, preset.storeId) ? preset.storeId : undefined);
  assertStore(user, storeId, LIST);
  const channel = channelOf(formData, source === "photo" ? "visit" : "phone");
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

function applyFields(doc: CapturedDocument, f: ReceptionFields, user: User, channel?: string) {
  const prev = doc.extracted ?? {};
  const meta = Object.fromEntries(Object.entries(prev).filter(([k]) => k.startsWith("_")));
  doc.extracted = { ...f, ...meta, ...(channel ? { _channel: channel } : {}), _edited: { by: user.id, at: nowIso() } };
  if (doc.status === "failed" || doc.status === "uploaded") doc.status = "extracted";
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

/** 媒体 (問い合わせの登録では必須。言葉は対応表で読み替える) */
function readMedia(formData: FormData, back: string) {
  const v = str(formData, "media");
  if (isMediaKey(v)) return v;
  const mapped = v ? mapMediaText(readMediaRules(getDb()).rules, v) : null;
  if (!mapped) fail(back, "媒体 (当社を知ったきっかけ) を選んでください。お客様に聞けなかったときは「不明」を選びます。");
  return mapped;
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

/** 案件の担当者への業務依頼 (受付の連絡を伝える。依頼 → 確認 → 報告 → 完了) */
function caseTask(db: Database, p: { user: User; assigneeId: string; target: NonNullable<ReturnType<typeof resolveCase>>; summary: string; note: string; urgent: boolean }): Thread {
  const now = nowIso();
  const id = newId("th");
  const t: Thread = {
    id,
    title: `${p.urgent ? "【至急】" : ""}連絡: ${p.target.number} ${p.summary}`.slice(0, 120),
    kind: "request",
    storeId: p.target.storeId,
    createdBy: p.user.id,
    participants: [...new Set([p.user.id, p.assigneeId])],
    relatedType: p.target.type,
    relatedId: p.target.id,
    relatedLabel: p.target.number,
    status: "open",
    createdAt: now,
    updatedAt: now,
    assigneeIds: [p.assigneeId],
    dueDate: toDateKey(new Date()),
    taskStatus: "requested",
  };
  db.threads.push(t);
  db.messages.push({ id: newId("msg"), threadId: id, userId: p.user.id, body: p.note.slice(0, 4000), at: now, mentions: [p.assigneeId] });
  addAudit(db, { userId: p.user.id, action: "create", entity: "thread", entityId: id, entityLabel: t.title, summary: `受付の連絡を案件 ${p.target.number} の担当者に依頼 (依頼先: ${db.users.find((u) => u.id === p.assigneeId)?.name ?? p.assigneeId})`, storeId: p.target.storeId });
  return t;
}

function decision(doc: CapturedDocument, d: ReceptionMeta["decision"]) {
  doc.extracted = { ...(doc.extracted ?? {}), _decision: d };
}

/**
 * 受付を保存・登録する。intent = save (直した内容を保存) / inquiry / case / record / dismiss
 */
/**
 * 受付で読み取った日程 (確認の画面で直したもの) のうち「予定表に登録」を選んだものを、問い合わせの予定として登録する (mutate の中)。
 * 担当者は行ごとに選んだ人 (なければ問い合わせの担当)。重複していても登録し、注意を返す (登録したあとに予定表で直せる)
 */
function registerAppointments(d: Database, user: User, inq: Inquiry, list: ReceptionAppointment[], opts: { assigneeId: string; customerId?: string }): string[] {
  const out: string[] = [];
  const now = nowIso();
  const active = new Set(d.users.filter((u) => u.active).map((u) => u.id));
  for (const a of list) {
    if (!a.register || !isDateKey(a.date)) continue;
    const kind = a.kind as ScheduleKind;
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
  }
  if (out.length) {
    if (inq.status === "new") inq.status = "in_progress";
    addChangeNotice(d, user.id, caseTarget(d, inq.id), "予定の追加", out.map((t) => ({ label: "予定", before: "(なし)", after: t })));
  }
  return out;
}

export async function registerReception(formData: FormData) {
  const user = await requireActionUser();
  const id = str(formData, "id");
  const back = receptionHref(id);
  // ワンタッチの登録 (確認の画面の上の「このお客様に紐付けて登録」「この案件のやりとりに追加」「新しいお客様として登録」。お客様のご要望 2026-11-24「追加 ③」)
  const quick = str(formData, "quick");
  const quickCustomer = quick.startsWith("inquiry:") ? quick.slice("inquiry:".length) : undefined;
  const quickCase = quick.startsWith("case:") ? quick.slice("case:".length) : undefined;
  const newCustomer = quick === "new";
  const intent = quickCustomer !== undefined || newCustomer ? "inquiry" : quickCase ? "case" : choice(formData, "intent", ["save", "inquiry", "case", "record", "dismiss"] as const, "save");
  const db0 = getDb();
  const doc0 = findReception(db0, user, id);
  assertOpen(doc0, back);
  const prev = receptionFieldsOf(doc0);
  const f = editedFields(formData, prev);
  const meta0 = receptionMetaOf(doc0);
  const channel = channelOf(formData, meta0.channel);
  const confirmed = formData.get("confirmedUncertain") === "on";

  if (intent === "save") {
    await mutate((d) => {
      const doc = findReception(d, user, id);
      assertOpen(doc, back);
      applyFields(doc, f, user, channel);
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
    await mutate((d) => {
      const doc = findReception(d, user, id);
      assertOpen(doc, back);
      applyFields(doc, f, user, channel);
    });
    fail(back, "読み取りに自信がない項目 (黄色) があります。修正は保存しました。メモ・会話と見比べて確かめ、「確認しました」にチェックを入れてから登録してください。");
  }

  const receivedAt = receivedAtOf(f, doc0, meta0, back);
  const urgent = f.urgency === "high";
  let href = "";
  let message = "";
  let notifyThreadId = "";
  let notifyNote = "";
  let newInquiryId = "";

  if (intent === "inquiry") {
    if (!f.summary) fail(back, "用件 (要約) を入力してください。");
    const media = readMedia(formData, back);
    const customerId = quickCustomer ?? (newCustomer ? "" : str(formData, "customerId"));
    const canCreate = newCustomer && userCanCreateCustomer(db0, user);
    let createdCustomer = "";
    let appointmentNote = "";
    const addedPhones: string[] = [];
    const assigneeId = str(formData, "assignedUserId") || user.id;
    const handoff = formData.get("handoff") === "on";
    const inqId = newId("inq");
    newInquiryId = inqId;
    await mutate((d) => {
      const doc = findReception(d, user, id);
      assertOpen(doc, back);
      let customer = customerId ? d.customers.find((c) => c.id === customerId) : undefined;
      if (customerId && !customer) fail(back, "選んだお客様が見つかりません。");
      // 紐付けられるお客様 = 顧客の一覧で見られるお客様 (ほかの店舗・本部で登録したお客様も。src/lib/customer-link.ts)
      if (customer && !canLinkToCustomer(d, user, customer)) fail(back, "このお客様は閲覧の範囲の外のため紐付けられません。店舗または本部に依頼してください。");
      // 担当店舗: 選んだ店舗 (自店舗・住所の担当エリアの店舗。全店舗のロールはすべて) > 住所の担当エリア > お客様の店舗 > 受付の店舗 (お客様のご要望 2026-11-24「③」)
      const storeId = newCaseStore(d, user, { requested: str(formData, "storeId") || (customer?.storeId ?? doc.storeId), address: f.siteAddress || f.address, customer }).storeId;
      // 新しいお客様として登録 (顧客も同時に登録。二重登録を防ぐため、同じお客様の候補があれば「別のお客様」の確認が要る)
      if (newCustomer && canCreate) {
        const name = f.customerName || f.companyName;
        if (!name) fail(back, "お名前 (または会社名) を入力してから「新しいお客様として登録」を押してください。");
        const dup = findDuplicateCustomers(d, { name, phone: f.phone, otherPhones: [f.otherPhone].filter(Boolean), email: f.email, postalCode: f.postalCode, address: f.address });
        if (needsConfirmation(dup) && formData.get("confirmDuplicate") !== "on") {
          applyFields(doc, f, user, channel);
          fail(back, `同じお客様の可能性がある顧客があります (${candidateLabel(dup)})。同じお客様なら「このお客様に紐付けて登録」を、別のお客様なら「上の候補とは別のお客様です」にチェックしてから押してください。`);
        }
        const now0 = nowIso();
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
          assignedUserId: assigneeId,
          preferredChannel: channel === "line" || channel === "email" ? channel : "phone",
          firstContactChannel: channel,
          tags: [],
          notes: `問合せ登録 (${RECEPTION_SOURCE_LABEL[meta0.source]}) から登録`,
          createdAt: now0,
          updatedAt: now0,
        };
        d.customers.push(c);
        customer = c;
        createdCustomer = `${c.code} ${c.name}`;
        addAudit(d, { userId: user.id, action: "create", entity: "customer", entityId: c.id, entityLabel: `${c.code} ${c.name}`, summary: `問合せ登録 (受付) から顧客を登録${needsConfirmation(dup) ? ` · 重複候補 ${candidateLabel(dup)} を確認済み` : ""}`, storeId });
      }
      const contactName = customer?.name ?? f.customerName;
      if (!contactName) fail(back, "お客様のお名前を入力するか、登録済みのお客様を選んでください。");
      const assignee = d.users.find((u) => u.id === assigneeId && u.active);
      if (!assignee) fail(back, "担当者が見つかりません。");
      if (!canSeeAllStores(user) && assignee.storeId !== storeId && assignee.role !== "admin" && assignee.role !== "hq_staff" && !isCommonStaff(d, assignee)) fail(back, `担当者は、担当店舗 (${d.stores.find((s) => s.id === storeId)?.name ?? storeId}) の社員か本部の社員から選んでください (自分で担当するときは、担当店舗を自店舗にしてください)。`);
      applyFields(doc, f, user, channel);
      const now = nowIso();
      const detail = [
        f.detail,
        f.desiredDate ? `希望の日時: ${f.desiredDate}` : "",
        ...f.appointments.filter((a) => !a.register || !isDateKey(a.date)).map((a) => `メモの日程 (予定は未登録): ${a.text || `${a.date} ${a.time || (a.slot === "am" ? "午前" : a.slot === "pm" ? "午後" : "")}`.trim()}`),
        f.siteAddress && f.siteAddress !== (customer?.address ?? f.address) ? `施工現場: ${f.siteAddress}` : "",
        !customer && (f.postalCode || f.address) ? `住所: ${f.postalCode ? `〒${f.postalCode} ` : ""}${f.address}` : "",
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
        customerId: customer?.id,
        contactName,
        contactPhone: f.phone || customer?.phone || undefined,
        channel,
        storeId,
        category: categoryKey(f.category),
        summary: f.summary,
        detail,
        status: "new",
        assignedUserId: assignee.id,
        receivedAt,
        nextAction: `${urgent ? "至急: " : ""}${f.callback === "要" || channel === "phone" || channel === "mobile" ? "折返しの電話" : "お客様へ連絡 (見積・現地調査の日程)"}`,
        nextActionDue: toDateKey(new Date()),
        createdBy: user.id,
        updatedAt: now,
        media,
        source: "app",
        sourceRef: `reception:${doc.id}`,
        // 施工現場の住所 (依頼主の住所と違うとき。お客様のご要望 2026-11-25「⑨」)
        siteAddress: f.siteAddress && f.siteAddress !== (customer?.address ?? f.address) ? f.siteAddress : undefined,
      };
      const cleanIntake = Object.fromEntries(Object.entries(intake).filter(([, v]) => v !== undefined && v !== "")) as InquiryIntake;
      if (Object.keys(cleanIntake).length) inq.intake = cleanIntake;
      d.inquiries.push(inq);
      addAudit(d, { userId: user.id, action: "create", entity: "inquiry", entityId: inqId, entityLabel: inq.number, summary: `受付から問い合わせを登録 (${contactName} / ${f.summary} / ${CHANNEL_LABEL[channel]} / 媒体: ${MEDIA_LABEL[media]})`, storeId });
      // やりとりの記録 (お客様が未登録でも問い合わせの記録に残る。あとで顧客にひも付けると移る)
      const log: CommLog = { id: newId("cl"), customerId: customer?.id, storeId, channel, direction: meta0.call?.direction === "outbound" ? "outbound" : "inbound", subject: `受付: ${f.summary}`.slice(0, 120), body: logBody(f, meta0), at: receivedAt, userId: user.id, relatedType: "inquiry", relatedId: inqId, contactName };
      d.commLogs.push(log);
      if (customer) customer.updatedAt = now;
      // 登録済みのお客様に紐付けたとき、メモの電話番号が登録にないなら「ほかの電話番号」に足す (次からその番号でも照合できる)
      if (customer && !createdCustomer) for (const ph of [f.phone, f.otherPhone]) {
        const added = addInquiryPhone(d, user, customer, ph, `問合せ登録 ${inq.number} で聞いた番号`);
        if (added) addedPhones.push(added);
      }
      relinkDocumentAttachments(d, doc.id, { type: "inquiry", id: inqId, customerId: customer?.id, storeId });
      // メモで決まっている日程を予定表に登録する (お客様のご要望 2026-11-25「⑦」: 読み取った日程を初期値に、確認の画面で直してから)
      const planned = registerAppointments(d, user, inq, f.appointments, { assigneeId: assignee.id, customerId: customer?.id });
      appointmentNote = planned.length ? ` 予定表に ${planned.join("・")} を登録しました。` : "";
      doc.status = "confirmed";
      doc.linkedType = "inquiry";
      doc.linkedId = inqId;
      decision(doc, { action: "inquiry", at: now, by: user.id, targetType: "inquiry", targetId: inqId, label: `問い合わせ ${inq.number}`, href: `/inquiries/${inqId}` });
      addAudit(d, { userId: user.id, action: "update", entity: "document", entityId: id, entityLabel: doc.fileName, summary: `受付を問い合わせ ${inq.number} に登録`, storeId: doc.storeId });
      // 担当者がほかの人なら業務依頼で引き継ぐ (依頼 → 確認 → 報告で進める)
      if (handoff && assignee.id !== user.id) {
        notifyNote = `${urgent ? "【至急】" : ""}受付から問い合わせを登録しました。内容を確認して、お客様へ${inq.nextAction?.includes("折返し") ? "折返し" : "連絡"}してください。対応したら「報告」で結果を書いてください。\n\n${detail}\n\n問い合わせ: /inquiries/${inqId}`;
        // 期限: 至急は本日 12 時まで (過ぎていれば本日中)、ほかは本日中。期限を過ぎて返答がなければ自動で再通知 (src/lib/inquiry-followup.ts)
        const due = (urgent ? dueAtFrom("noon", undefined, new Date()) : {}).dueAt ?? dueAtFrom("today", undefined, new Date()).dueAt;
        const t = createInquiryRequest(d, { inquiry: inq, requestedBy: user.id, storeId, assignee, purpose: inq.nextAction?.includes("折返し") ? "contact" : "schedule", note: notifyNote, dueAt: due, urgent });
        notifyThreadId = t.id;
      }
      href = `/inquiries/${inqId}`;
      message = `問い合わせ ${inq.number} を登録しました${createdCustomer ? `。新しいお客様 (${createdCustomer}) も登録しました` : customer ? ` (${customer.name} 様に紐付け${addedPhones.length ? `。電話番号 ${addedPhones.join("・")} をお客様の「ほかの電話番号」に追加` : ""})` : ""}${notifyThreadId ? ` (${assignee.name} さんに引き継ぎました)` : ""}。${customer ? "" : newCustomer ? "顧客の新規登録は事務担当が行います (問い合わせの画面の「顧客として登録する」)。" : "お客様が未登録のため、画面の「顧客として登録する」で登録できます。"}${appointmentNote}`;
    });
  } else if (intent === "case") {
    const key = quickCase ?? str(formData, "caseKey");
    const ref = quickCase ? "" : str(formData, "caseRef");
    if (!key && !ref) fail(back, "やりとりを追加する案件を選ぶか、案件番号を入力してください。");
    const target0 = resolveCase(db0, ref ? "" : key, ref);
    if (!target0) fail(back, ref ? `案件番号「${ref}」が見つかりません (INQ-・Q-・O- などの番号)。` : "選んだ案件が見つかりません。");
    if (!canAccessStore(user, target0.storeId)) fail(back, "ほかの店舗の案件には追加できません。");
    const notify = formData.get("notifyOwner") === "on";
    const notifyTo = str(formData, "notifyUserId") || target0.ownerId || "";
    await mutate((d) => {
      const doc = findReception(d, user, id);
      assertOpen(doc, back);
      const target = resolveCase(d, ref ? "" : key, ref)!;
      applyFields(doc, f, user, channel);
      const now = nowIso();
      const subject = `受付: ${f.summary || RECEPTION_TYPE_LABEL[f.callType || "existing_case"]}`.slice(0, 120);
      const contactName = f.customerName || d.customers.find((c) => c.id === target.customerId)?.name;
      d.commLogs.push({ id: newId("cl"), customerId: target.customerId, storeId: target.storeId, channel, direction: meta0.call?.direction === "outbound" ? "outbound" : "inbound", subject, body: logBody(f, meta0), at: receivedAt, userId: user.id, relatedType: target.type, relatedId: target.id, contactName });
      if (target.type === "order") {
        const o = d.orders.find((x) => x.id === target.id)!;
        o.progressNotes.push({ id: newId("pn"), at: now, userId: user.id, kind: "note", body: `お客様から連絡 (${CHANNEL_LABEL[channel]}): ${f.summary}${f.detail && f.detail !== f.summary ? `\n${f.detail}` : ""}${f.desiredDate ? `\n希望の日時: ${f.desiredDate}` : ""}`.slice(0, 3000) });
        o.updatedAt = now;
      } else if (target.type === "inquiry") {
        const i = d.inquiries.find((x) => x.id === target.id)!;
        i.updatedAt = now;
      }
      relinkDocumentAttachments(d, doc.id, { type: target.type, id: target.id, customerId: target.customerId, storeId: target.storeId });
      doc.status = "confirmed";
      doc.linkedType = target.type;
      doc.linkedId = target.id;
      const label = `${target.type === "order" ? "受注" : target.type === "quote" ? "見積" : "問い合わせ"} ${target.number}`;
      decision(doc, { action: "case", at: now, by: user.id, targetType: target.type, targetId: target.id, label, href: target.href });
      addAudit(d, { userId: user.id, action: "update", entity: target.type, entityId: target.id, entityLabel: target.number, summary: `受付の連絡をやりとりに追加 (${CHANNEL_LABEL[channel]} / ${f.summary})`, storeId: target.storeId });
      addAudit(d, { userId: user.id, action: "update", entity: "document", entityId: id, entityLabel: doc.fileName, summary: `受付を${label}のやりとりに追加`, storeId: doc.storeId });
      if (notify && notifyTo && notifyTo !== user.id) {
        const assignee = d.users.find((u) => u.id === notifyTo && u.active);
        if (!assignee) fail(back, "知らせる担当者が見つかりません。");
        notifyNote = `${urgent ? "【至急】" : ""}${label} (${target.title}) について連絡がありました。内容を確認して対応してください。対応したら「報告」で結果を書いてください。\n\n${logBody(f, meta0).slice(0, 3000)}\n\n案件: ${target.href}`;
        notifyThreadId = caseTask(d, { user, assigneeId: assignee.id, target, summary: f.summary || "受付の連絡", note: notifyNote, urgent }).id;
      }
      href = target.href;
      message = `${label} のやりとりに追加しました${notifyThreadId ? " (担当者に業務依頼で知らせました)" : ""}。`;
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
  redirect(withMsg(href || LIST, message || RECEPTION_ACTION_LABEL[intent as ReceptionAction]));
}

