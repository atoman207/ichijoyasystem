import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Channel, Database, Inquiry, ServiceCategory, StoreId } from "@/lib/db/types";
import { addAudit, nextNumber, nowIso } from "@/lib/db/store";
import { CATEGORY_LABEL } from "@/lib/constants";

/**
 * 外部からの受信 (LINE・Chatwork・Web フォーム) をやりとり履歴・問い合わせに登録する
 * ------------------------------------------------------------
 * - 署名・共有鍵を確かめてから呼ぶ (各ルート)
 * - 同じメッセージを 2 回受け取っても 1 件だけ登録する (メッセージの ID から記録の ID を決める)
 * - 登録した人は "system" (画面では「システム (外部連携)」)
 */

export const SYSTEM_USER = "system";

/** HMAC-SHA256 (base64) の署名を一定時間で比べる */
export function verifyHmac(key: string | Buffer, body: string, signature: string | null): boolean {
  if (!signature) return false;
  const expected = Buffer.from(createHmac("sha256", key).update(body).digest("base64"));
  const given = Buffer.from(signature.trim());
  return expected.length === given.length && timingSafeEqual(expected, given);
}

const safeId = (v: string) => v.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
const digits = (v: string | undefined) => (v ?? "").replace(/[^0-9]/g, "");

/** 未対応の問い合わせ (同じ相手からの続きのメッセージはここに追記する) */
function openInquiry(db: Database, refPrefix: string): Inquiry | undefined {
  return db.inquiries.find((i) => i.sourceRef?.startsWith(refPrefix) && (i.status === "new" || i.status === "in_progress"));
}

/* ---------------- LINE ---------------- */

export interface LineEvent {
  type?: string;
  timestamp?: number;
  webhookEventId?: string;
  source?: { type?: string; userId?: string };
  message?: { id?: string; type?: string; text?: string; fileName?: string };
}

const LINE_TYPE_LABEL: Record<string, string> = { image: "[画像]", video: "[動画]", audio: "[音声]", file: "[ファイル]", location: "[位置情報]", sticker: "[スタンプ]" };

/** LINE のメッセージ: 登録済みのお客様・協力業者 → やりとり履歴 / 未登録 → 問い合わせ (入口: LINE)。登録した件数を返す */
export function recordLineEvents(db: Database, events: LineEvent[]): number {
  let count = 0;
  for (const ev of events) {
    if (ev.type !== "message" || !ev.message?.id || !ev.source?.userId) continue;
    const msgId = safeId(ev.message.id);
    const userId = ev.source.userId;
    const text = ev.message.type === "text" ? String(ev.message.text ?? "") : `${LINE_TYPE_LABEL[ev.message.type ?? ""] ?? "[メッセージ]"}${ev.message.fileName ? ` ${ev.message.fileName}` : ""} (LINE のアプリで確認してください)`;
    const at = new Date(Number.isFinite(ev.timestamp) ? Number(ev.timestamp) : Date.now()).toISOString();
    const logId = `cl_line_${msgId}`;
    if (db.commLogs.some((c) => c.id === logId) || db.inquiries.some((i) => i.id === `inq_line_${msgId}`)) continue;
    const customer = db.customers.find((c) => c.lineId === userId);
    const supplier = customer ? undefined : db.suppliers.find((s) => s.lineId === userId);
    if (customer || supplier) {
      db.commLogs.push({ id: logId, customerId: customer?.id, supplierId: supplier?.id, storeId: customer?.storeId ?? "hq", channel: "line", direction: "inbound", subject: `LINE: ${text.slice(0, 30)}`, body: text, at, userId: SYSTEM_USER });
      addAudit(db, { userId: SYSTEM_USER, action: "create", entity: "comm", entityId: logId, entityLabel: customer?.name ?? supplier?.name ?? "", summary: `LINE のメッセージを受信 (${customer ? `お客様: ${customer.name}` : `協力業者・仕入先: ${supplier!.name}`})`, storeId: customer?.storeId ?? "hq" });
      count++;
      continue;
    }
    const ref = `line:${userId}`;
    const open = openInquiry(db, ref);
    if (open) {
      open.detail = `${open.detail}\n\n[${at.slice(0, 16).replace("T", " ")}] ${text}`.slice(0, 8000);
      open.updatedAt = nowIso();
      addAudit(db, { userId: SYSTEM_USER, action: "update", entity: "inquiry", entityId: open.id, entityLabel: open.number, summary: "LINE の続きのメッセージを追記", storeId: open.storeId });
      count++;
      continue;
    }
    count += createInquiry(db, { id: `inq_line_${msgId}`, channel: "line", storeId: "hq", contactName: "LINE のお客様 (未登録)", summary: text.split(/\r?\n/)[0].slice(0, 60) || "LINE のメッセージ", detail: `${text}\n\nLINE ユーザー ID: ${userId} (お客様を登録するときは顧客情報の LINE ID に入れると、次から自動でひも付きます)`, receivedAt: at, sourceRef: `${ref}:${msgId}` });
  }
  return count;
}

/* ---------------- Chatwork ---------------- */

export interface ChatworkPayload {
  webhook_event_type?: string;
  webhook_event?: { message_id?: string | number; room_id?: string | number; account_id?: string | number; body?: string; send_time?: number };
}

/** Chatwork の投稿: 協力業者・仕入先のルーム (ルーム ID を登録した取引先) の投稿をやりとり履歴に登録する */
export function recordChatworkEvent(db: Database, p: ChatworkPayload, selfAccountId?: string): "recorded" | "ignored" {
  const ev = p.webhook_event;
  if (!ev || !["message_created", "mention_to_me"].includes(p.webhook_event_type ?? "")) return "ignored";
  const room = String(ev.room_id ?? "");
  const msgId = safeId(String(ev.message_id ?? ""));
  if (!room || !msgId) return "ignored";
  if (selfAccountId && String(ev.account_id ?? "") === selfAccountId) return "ignored";
  const supplier = db.suppliers.find((s) => s.chatworkRoomId === room);
  if (!supplier) return "ignored";
  const logId = `cl_cw_${msgId}`;
  if (db.commLogs.some((c) => c.id === logId)) return "ignored";
  const body = String(ev.body ?? "").replace(/\[(To|rp|toall)[^\]]*\][^\n]*\n?/g, "").trim() || String(ev.body ?? "");
  // こちらから送った投稿 (送信履歴に同じ本文がある) は受信として数えない
  const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  if (db.deliveries.some((d) => d.channel === "chatwork" && d.recipient === room && d.createdAt >= since && d.body.trim() === body)) return "ignored";
  const at = new Date(Number.isFinite(ev.send_time) ? Number(ev.send_time) * 1000 : Date.now()).toISOString();
  db.commLogs.push({ id: logId, supplierId: supplier.id, storeId: "hq", channel: "chatwork", direction: "inbound", subject: `Chatwork: ${body.slice(0, 30)}`, body, at, userId: SYSTEM_USER });
  addAudit(db, { userId: SYSTEM_USER, action: "create", entity: "comm", entityId: logId, entityLabel: supplier.name, summary: `Chatwork の投稿を受信 (${supplier.name})`, storeId: "hq" });
  return "recorded";
}

/* ---------------- Web フォーム ---------------- */

export interface WebFormInput {
  id?: string;
  name?: string;
  kana?: string;
  phone?: string;
  email?: string;
  postalCode?: string;
  address?: string;
  category?: string;
  message?: string;
  store?: string;
}

/** Web フォームの送信を問い合わせ (入口: Webフォーム) にする。電話・メールが一致するお客様がいればひも付ける */
export function recordWebForm(db: Database, f: WebFormInput): { created: boolean; inquiry?: Inquiry; error?: string } {
  const name = (f.name ?? "").trim().slice(0, 60);
  const message = (f.message ?? "").trim().slice(0, 4000);
  if (!name || !message) return { created: false, error: "name と message は必須です" };
  const extId = f.id ? safeId(f.id) : "";
  if (extId) {
    const dup = db.inquiries.find((i) => i.sourceRef === `web:${extId}`);
    if (dup) return { created: false, inquiry: dup };
  }
  const store = db.stores.find((s) => s.id === f.store || s.name === f.store || s.shortName === f.store);
  const catKey = (Object.keys(CATEGORY_LABEL) as ServiceCategory[]).find((k) => k === f.category || CATEGORY_LABEL[k] === f.category);
  const phone = digits(f.phone);
  const customer = db.customers.find((c) => (phone.length >= 9 && digits(c.phone) === phone) || (f.email && c.email && c.email.toLowerCase() === f.email.trim().toLowerCase()));
  const detail = [
    message,
    "",
    `お名前: ${name}${f.kana ? ` (${f.kana})` : ""}`,
    f.phone ? `電話: ${f.phone}` : "",
    f.email ? `メール: ${f.email}` : "",
    f.postalCode || f.address ? `住所: ${f.postalCode ? `〒${f.postalCode} ` : ""}${f.address ?? ""}` : "",
  ]
    .filter((l, i) => i < 2 || l)
    .join("\n");
  const id = `inq_web_${extId || Date.now().toString(36)}`;
  const inq = buildInquiry(db, { id, channel: "web", storeId: store?.id ?? customer?.storeId ?? "hq", contactName: customer?.name ?? name, contactPhone: f.phone, customerId: customer?.id, category: catKey, summary: message.split(/\r?\n/)[0].slice(0, 60), detail, receivedAt: nowIso(), sourceRef: extId ? `web:${extId}` : "web" });
  db.inquiries.push(inq);
  addAudit(db, { userId: SYSTEM_USER, action: "create", entity: "inquiry", entityId: inq.id, entityLabel: inq.number, summary: `Web フォームから問い合わせを受信 (${name}${customer ? ` / 既存のお客様 ${customer.code}` : ""})`, storeId: inq.storeId });
  if (customer) db.commLogs.push({ id: `cl_${inq.id}`, customerId: customer.id, storeId: inq.storeId, channel: "web", direction: "inbound", subject: inq.summary, body: message, at: inq.receivedAt, userId: SYSTEM_USER, relatedType: "inquiry", relatedId: inq.id });
  return { created: true, inquiry: inq };
}

export function buildInquiry(db: Database, p: { id: string; channel: Channel; storeId: StoreId; contactName: string; contactPhone?: string; customerId?: string; category?: ServiceCategory; summary: string; detail: string; receivedAt: string; sourceRef: string }): Inquiry {
  return {
    id: p.id,
    number: nextNumber(db, "INQ", db.inquiries, p.receivedAt.slice(0, 10)),
    customerId: p.customerId,
    contactName: p.contactName,
    contactPhone: p.contactPhone || undefined,
    channel: p.channel,
    storeId: p.storeId,
    category: p.category ?? "other",
    summary: p.summary,
    detail: p.detail,
    status: "new",
    receivedAt: p.receivedAt,
    createdBy: SYSTEM_USER,
    updatedAt: nowIso(),
    source: "app",
    sourceRef: p.sourceRef,
  };
}

function createInquiry(db: Database, p: Parameters<typeof buildInquiry>[1]): number {
  const inq = buildInquiry(db, p);
  db.inquiries.push(inq);
  addAudit(db, { userId: SYSTEM_USER, action: "create", entity: "inquiry", entityId: inq.id, entityLabel: inq.number, summary: `${p.channel === "line" ? "LINE" : "外部"}から問い合わせを受信 (${p.summary})`, storeId: inq.storeId });
  return 1;
}
