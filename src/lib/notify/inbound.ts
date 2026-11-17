import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { AttachmentParent, Channel, Database, Inquiry, ServiceCategory, StoreId } from "@/lib/db/types";
import { addAudit, nextNumber, nowIso } from "@/lib/db/store";
import { CATEGORY_LABEL } from "@/lib/constants";
import { detectType } from "@/lib/attachments";
import { LINE_GROUP_ID_RE, MAX_PENDING, ensureLineGroup, findLineGroup, lineGroupName, touchLineGroups, type LineGroup, type PendingLineMessage } from "@/lib/line-groups";

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
  source?: { type?: string; userId?: string; groupId?: string; roomId?: string };
  message?: { id?: string; type?: string; text?: string; fileName?: string; contentProvider?: { type?: string } };
}

const LINE_TYPE_LABEL: Record<string, string> = { image: "[画像]", video: "[動画]", audio: "[音声]", file: "[ファイル]", location: "[位置情報]", sticker: "[スタンプ]" };

/** 受信のあとで LINE から本体を取得して添付ファイルに保存する写真・資料 */
export interface LineMediaJob {
  messageId: string;
  fileName: string;
  parentType: Extract<AttachmentParent, "order" | "customer" | "inquiry">;
  parentId: string;
  /** 保存したら本文を書き換えるやりとり履歴 */
  logId?: string;
  caption?: string;
}

export interface LineInboundResult {
  recorded: number;
  media: LineMediaJob[];
  /** 名前を LINE から取得するグループ */
  groupsToName: string[];
}

export const LINE_MEDIA_SAVING = "(写真・資料に保存しています)";
export const LINE_MEDIA_SAVED = "(写真・資料に保存しました)";
export const LINE_MEDIA_APP = "(LINE のアプリで確認してください)";

/** 写真・資料として保存するファイル名 (保存できない種類は undefined) */
export function lineMediaFileName(m: { id: string; type?: string; fileName?: string; contentProvider?: { type?: string } }, at: string): string | undefined {
  if (m.contentProvider?.type === "external") return undefined;
  const stamp = at.slice(0, 19).replace(/[-:]/g, "").replace("T", "_");
  const name = m.type === "image" ? `LINE_${stamp}_${m.id}.jpg` : m.type === "file" ? (m.fileName || `LINE_${stamp}_${m.id}`).slice(0, 200) : undefined;
  return name && detectType(name, "") ? name : undefined;
}

function lineText(m: { type?: string; text?: string; fileName?: string }, saving: boolean): string {
  if (m.type === "text") return String(m.text ?? "");
  return `${LINE_TYPE_LABEL[m.type ?? ""] ?? "[メッセージ]"}${m.fileName ? ` ${m.fileName}` : ""} ${saving ? LINE_MEDIA_SAVING : LINE_MEDIA_APP}`;
}

/**
 * LINE の Webhook のイベントを登録する
 * - 1 対 1: 登録済みのお客様・協力業者 → やりとり履歴 / 未登録 → 問い合わせ (入口: LINE)
 * - グループ・複数人トーク: 案件・協力業者にひも付けたグループ → 案件のやりとり履歴 / 未登録 → グループの一覧に保留 (設定 → 外部連携・AI)
 * - 写真・ファイルは media に入れ、ルートが応答のあとで取得して添付ファイルに保存する
 */
export function recordLineEvents(db: Database, events: LineEvent[]): LineInboundResult {
  const res: LineInboundResult = { recorded: 0, media: [], groupsToName: [] };
  for (const ev of events) {
    const at = new Date(Number.isFinite(ev.timestamp) ? Number(ev.timestamp) : Date.now()).toISOString();
    const groupId = ev.source?.type === "group" ? ev.source.groupId : ev.source?.type === "room" ? ev.source.roomId : undefined;
    const kind = ev.source?.type === "room" ? "room" : "group";

    // 公式アカウントがグループに招待された・グループから外れた
    if (ev.type === "join" && groupId && LINE_GROUP_ID_RE.test(groupId)) {
      const g = ensureLineGroup(db, groupId, kind, at);
      g.status = "joined";
      delete g.leftAt;
      if (kind === "group") res.groupsToName.push(groupId);
      addAudit(db, { userId: SYSTEM_USER, action: "create", entity: "settings", entityId: groupId, entityLabel: lineGroupName(g), summary: "LINE の公式アカウントがグループに参加しました (設定 → 外部連携・AI、または受注の画面で案件にひも付けてください)" });
      res.recorded++;
      continue;
    }
    if (ev.type === "leave" && groupId) {
      const g = findLineGroup(db, groupId);
      if (g) {
        g.status = "left";
        g.leftAt = at;
        touchLineGroups(db, SYSTEM_USER);
        addAudit(db, { userId: SYSTEM_USER, action: "update", entity: "settings", entityId: groupId, entityLabel: lineGroupName(g), summary: "LINE の公式アカウントがグループから退出しました" });
        res.recorded++;
      }
      continue;
    }

    if (ev.type !== "message" || !ev.message?.id) continue;
    const msgId = safeId(ev.message.id);
    if (!msgId) continue;
    const logId = `cl_line_${msgId}`;
    if (db.commLogs.some((c) => c.id === logId) || db.inquiries.some((i) => i.id === `inq_line_${msgId}`)) continue;
    const fileName = lineMediaFileName({ ...ev.message, id: msgId }, at);

    // ---- グループ・複数人トーク ----
    if (groupId) {
      if (!LINE_GROUP_ID_RE.test(groupId)) continue;
      const g = ensureLineGroup(db, groupId, kind, at);
      if (g.status === "left") {
        g.status = "joined";
        delete g.leftAt;
      }
      if (!g.name && kind === "group" && !res.groupsToName.includes(groupId)) res.groupsToName.push(groupId);
      if (g.pending.some((p) => p.id === msgId)) continue;
      g.lastMessageAt = at;
      g.messageCount = (g.messageCount ?? 0) + 1;
      const pm: PendingLineMessage = { id: msgId, at, userId: ev.source?.userId, type: ev.message.type ?? "", text: ev.message.type === "text" ? String(ev.message.text ?? "").slice(0, 5000) : "", fileName: ev.message.type === "file" ? ev.message.fileName : undefined };
      if (!g.orderId && !g.supplierId) {
        g.pending.push(pm);
        if (g.pending.length > MAX_PENDING) g.pending.splice(0, g.pending.length - MAX_PENDING);
        res.recorded++;
        continue;
      }
      const job = recordLineGroupMessage(db, g, pm, Boolean(fileName));
      if (job) res.media.push(job);
      res.recorded++;
      continue;
    }

    // ---- 1 対 1 ----
    const userId = ev.source?.userId;
    if (!userId) continue;
    const customer = db.customers.find((c) => c.lineId === userId);
    const supplier = customer ? undefined : db.suppliers.find((s) => s.lineId === userId);
    // 協力業者・仕入先の写真は登録先 (案件) が分からないため保存しない
    const saveTo = customer ? { parentType: "customer" as const, parentId: customer.id } : undefined;
    if (customer || supplier) {
      const text = lineText(ev.message, Boolean(fileName && saveTo));
      db.commLogs.push({ id: logId, customerId: customer?.id, supplierId: supplier?.id, storeId: customer?.storeId ?? "hq", channel: "line", direction: "inbound", subject: `LINE: ${text.slice(0, 30)}`, body: text, at, userId: SYSTEM_USER });
      addAudit(db, { userId: SYSTEM_USER, action: "create", entity: "comm", entityId: logId, entityLabel: customer?.name ?? supplier?.name ?? "", summary: `LINE のメッセージを受信 (${customer ? `お客様: ${customer.name}` : `協力業者・仕入先: ${supplier!.name}`})`, storeId: customer?.storeId ?? "hq" });
      if (fileName && saveTo) res.media.push({ messageId: msgId, fileName, ...saveTo, logId, caption: "LINE で受信" });
      res.recorded++;
      continue;
    }
    const text = lineText(ev.message, Boolean(fileName));
    const ref = `line:${userId}`;
    const open = openInquiry(db, ref);
    if (open) {
      open.detail = `${open.detail}\n\n[${at.slice(0, 16).replace("T", " ")}] ${text}`.slice(0, 8000);
      open.updatedAt = nowIso();
      addAudit(db, { userId: SYSTEM_USER, action: "update", entity: "inquiry", entityId: open.id, entityLabel: open.number, summary: "LINE の続きのメッセージを追記", storeId: open.storeId });
      if (fileName) res.media.push({ messageId: msgId, fileName, parentType: "inquiry", parentId: open.id, caption: "LINE で受信" });
      res.recorded++;
      continue;
    }
    const inqId = `inq_line_${msgId}`;
    res.recorded += createInquiry(db, { id: inqId, channel: "line", storeId: "hq", contactName: "LINE のお客様 (未登録)", summary: text.split(/\r?\n/)[0].slice(0, 60) || "LINE のメッセージ", detail: `${text}\n\nLINE ユーザー ID: ${userId} (お客様を登録するときは顧客情報の LINE ID に入れると、次から自動でひも付きます)`, receivedAt: at, sourceRef: `${ref}:${msgId}` });
    if (fileName) res.media.push({ messageId: msgId, fileName, parentType: "inquiry", parentId: inqId, caption: "LINE で受信" });
  }
  return res;
}

/**
 * ひも付け済みのグループのメッセージを、案件 (受注) のやりとり履歴に登録する (mutate の中で呼ぶ)。
 * 写真・資料を保存するときは取得の依頼を返す
 */
export function recordLineGroupMessage(db: Database, g: LineGroup, m: PendingLineMessage, saveMedia: boolean): LineMediaJob | undefined {
  const logId = `cl_line_${m.id}`;
  if (db.commLogs.some((c) => c.id === logId)) return undefined;
  const order = g.orderId ? db.orders.find((o) => o.id === g.orderId) : undefined;
  const supplier = g.supplierId ? db.suppliers.find((s) => s.id === g.supplierId) : undefined;
  const senderCustomer = m.userId ? db.customers.find((c) => c.lineId === m.userId) : undefined;
  const senderSupplier = m.userId && !senderCustomer ? db.suppliers.find((s) => s.lineId === m.userId) : undefined;
  const fileName = saveMedia && order ? lineMediaFileName({ id: m.id, type: m.type, fileName: m.fileName }, m.at) : undefined;
  const text = lineText(m, Boolean(fileName));
  const gname = lineGroupName(g);
  const storeId = order?.storeId ?? "hq";
  db.commLogs.push({
    id: logId,
    customerId: order?.customerId,
    supplierId: supplier?.id ?? senderSupplier?.id,
    storeId,
    channel: "line",
    direction: "inbound",
    subject: `LINE (${gname.slice(0, 20)}): ${text.slice(0, 30)}`,
    body: text,
    at: m.at,
    userId: SYSTEM_USER,
    relatedType: order ? "order" : undefined,
    relatedId: order?.id,
    contactName: senderCustomer?.name ?? senderSupplier?.name ?? (m.userId ? "グループのメンバー" : undefined),
  });
  addAudit(db, { userId: SYSTEM_USER, action: "create", entity: "comm", entityId: logId, entityLabel: order?.number ?? supplier?.name ?? gname, summary: `LINE グループ「${gname}」のメッセージを受信${order ? ` (案件 ${order.number})` : ""}`, storeId });
  return fileName && order ? { messageId: m.id, fileName, parentType: "order", parentId: order.id, logId, caption: `LINE グループ「${gname}」で受信` } : undefined;
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
