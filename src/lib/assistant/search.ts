import "server-only";
import type { Database, StoreId, User } from "@/lib/db/types";
import { canAccessStore, canSeeAllStores, canViewExpense, canViewFax, canViewKnowledge, canViewPurchase, canViewPurchaseOrder, canViewSourceFiles, canViewSuppliers, canViewThread } from "@/lib/auth/permissions";
import { CATEGORY_LABEL, CHANNEL_LABEL, EXPENSE_STATUS, INQUIRY_STATUS, INVOICE_STATUS, ORDER_STATUS, PROGRESS_KIND_LABEL, PURCHASE_ORDER_STATUS, PURCHASE_STATUS, QUOTE_STATUS, SCHEDULE_KIND } from "@/lib/constants";
import { fmtDate, yen } from "@/lib/format";
import { contactLine, customerPhoneDigits } from "@/lib/customer-contacts";
import { siteInfoText } from "@/lib/site-info";
import { salesFacts } from "./facts";

/**
 * システム内の横断検索 (AI アシスタントの道具)
 * ------------------------------------------------------------
 * 顧客・問い合わせ・見積・受注 (施工)・請求・入金・予定・経費・仕入・仕入先・発注書・連絡履歴・社内連絡・社内資料 (議事録・ルール)・
 * クレーム手直し・アンケート・口コミ・FAX・現場写真・資料台帳を 1 つの索引で探す。
 * - 検索の文字は NFKC・小文字・空白なしにそろえ、言葉をすべて含む記録 (AND) を優先、なければ一部を含む記録 (OR)
 * - 閲覧できるかは記録ごとに permissions.ts の関数で確かめる (画面と同じ範囲)
 * - 索引は 1 回作ったらメモリに置き、件数・更新日時が変わったときだけ作り直す
 */

export type RecordType =
  | "customer"
  | "inquiry"
  | "quote"
  | "order"
  | "invoice"
  | "payment"
  | "schedule"
  | "expense"
  | "purchase"
  | "supplier"
  | "purchase_order"
  | "comm"
  | "thread"
  | "knowledge"
  | "quality"
  | "survey"
  | "review"
  | "fax"
  | "photo"
  | "file";

export const RECORD_TYPE_LABEL: Record<RecordType, string> = {
  customer: "顧客",
  inquiry: "問い合わせ",
  quote: "見積",
  order: "受注・施工",
  invoice: "請求",
  payment: "入金",
  schedule: "予定",
  expense: "経費",
  purchase: "仕入",
  supplier: "仕入先・協力業者",
  purchase_order: "発注書",
  comm: "連絡履歴",
  thread: "社内連絡",
  knowledge: "社内資料",
  quality: "クレーム・手直し",
  survey: "アンケート",
  review: "口コミ",
  fax: "FAX",
  photo: "現場写真",
  file: "資料台帳",
};

export interface Entry {
  type: RecordType;
  id: string;
  /** 正規化した本文 (検索用) */
  text: string;
  /** 正規化した見出し (当たると重く数える) */
  head: string;
  date: string;
  storeId?: StoreId;
}

export const normText = (v: string) => v.normalize("NFKC").toLowerCase().replace(/[\s　]+/g, "");

const g = globalThis as typeof globalThis & { __ichijoyaSearchIndex?: { sig: string; entries: Entry[] } };

function signature(db: Database): string {
  const cols = [db.customers, db.inquiries, db.quotes, db.orders, db.invoices, db.payments, db.schedule, db.expenses, db.purchases, db.suppliers, db.purchaseOrders, db.commLogs, db.threads, db.messages, db.knowledge, db.qualityIssues, db.surveys, db.reviews, db.faxMessages] as { updatedAt?: string; createdAt?: string; at?: string }[][];
  let latest = "";
  for (const c of cols) for (const r of c) {
    const t = r.updatedAt ?? r.createdAt ?? r.at ?? "";
    if (t > latest) latest = t;
  }
  return [...cols.map((c) => c.length), latest].join("|");
}

function buildIndex(db: Database): Entry[] {
  const out: Entry[] = [];
  const cname = new Map(db.customers.map((c) => [c.id, c.name]));
  const uname = new Map(db.users.map((u) => [u.id, u.name]));
  const sname = new Map(db.suppliers.map((s) => [s.id, s.name]));
  const push = (type: RecordType, id: string, head: string, body: (string | undefined)[], date: string | undefined, storeId?: StoreId) =>
    out.push({ type, id, head: normText(head), text: normText([head, ...body].filter(Boolean).join(" ")), date: (date ?? "").slice(0, 10), storeId });
  for (const c of db.customers) push("customer", c.id, `${c.name} ${c.kana} ${c.code}`, [c.phone, ...(c.contacts ?? []).map(contactLine), customerPhoneDigits(c).join(" "), c.email, c.address, c.area, c.tags.join(" "), c.notes, c.tradeStopped ? `取引停止 ${c.tradeStopNote ?? ""}` : ""], c.updatedAt, c.storeId);
  for (const i of db.inquiries) push("inquiry", i.id, `${i.number} ${i.summary}`, [i.contactName, i.contactPhone, cname.get(i.customerId ?? ""), i.detail, i.nextAction, i.result, i.area, CATEGORY_LABEL[i.category], CHANNEL_LABEL[i.channel], uname.get(i.assignedUserId ?? "")], i.receivedAt, i.storeId);
  for (const q of db.quotes) push("quote", q.id, `${q.number} ${q.title}`, [cname.get(q.customerId), q.workDetails, q.notes, q.siteAddress, q.receiptName, q.items.map((x) => `${x.name} ${x.spec ?? ""}`).join(" "), siteInfoText(q.siteInfo), uname.get(q.estimatorId ?? q.createdBy)], q.issuedAt ?? q.createdAt, q.storeId);
  for (const o of db.orders) push("order", o.id, `${o.number} ${o.title}`, [cname.get(o.customerId), o.siteAddress, o.receiptName, o.workDetails, o.fusumaPaper, siteInfoText(o.siteInfo), o.progressNotes.map((n) => n.body).join(" "), o.workerIds.map((w) => uname.get(w)).join(" ")], o.salesDate ?? o.contractDate, o.storeId);
  for (const i of db.invoices) push("invoice", i.id, `${i.number} ${i.title ?? ""}`, [cname.get(i.customerId), i.notes, i.expectedNote], i.issueDate, i.storeId);
  const invById = new Map(db.invoices.map((i) => [i.id, i]));
  for (const p of db.payments) {
    const inv = invById.get(p.invoiceId);
    if (inv) push("payment", p.id, `入金 ${inv.number}`, [cname.get(inv.customerId), p.memo, `${p.amount}`], p.date, inv.storeId);
  }
  for (const e of db.schedule) push("schedule", e.id, e.title, [SCHEDULE_KIND[e.kind]?.label, e.location, e.memo, e.assigneeIds.map((a) => uname.get(a)).join(" "), cname.get(e.customerId ?? "")], e.date, e.storeId);
  for (const e of db.expenses) push("expense", e.id, `${e.number} ${e.vendor}`, [e.account, e.description, uname.get(e.submittedBy)], e.date, e.storeId);
  for (const p of db.purchases) push("purchase", p.id, `${p.number} ${sname.get(p.supplierId) ?? ""}`, [p.description, p.account, p.supplierInvoiceNo, (p.items ?? []).map((x) => `${x.name} ${x.spec ?? ""}`).join(" ")], p.invoiceDate, p.storeId);
  for (const s of db.suppliers) push("supplier", s.id, `${s.name} ${s.kana ?? ""}`, [s.category, s.contactName, s.phone, s.fax, s.address, s.notes, s.paymentTerms], s.updatedAt ?? s.createdAt);
  for (const p of db.purchaseOrders) push("purchase_order", p.id, `${p.number} ${sname.get(p.supplierId) ?? ""}`, [p.lines.map((l) => `${l.name} ${l.code ?? ""} ${l.spec ?? ""} ${l.orderNumber ?? ""}`).join(" "), p.notes, p.deliveryPlace], p.issuedOn, p.storeId);
  for (const l of db.commLogs) push("comm", l.id, l.subject || l.body.slice(0, 30), [l.body, cname.get(l.customerId ?? ""), sname.get(l.supplierId ?? ""), l.contactName, CHANNEL_LABEL[l.channel], uname.get(l.userId)], l.at, l.storeId ?? db.customers.find((c) => c.id === l.customerId)?.storeId);
  const msgs = new Map<string, string[]>();
  for (const m of db.messages) msgs.set(m.threadId, [...(msgs.get(m.threadId) ?? []), m.body]);
  for (const t of db.threads) push("thread", t.id, t.title, [t.relatedLabel, ...(msgs.get(t.id) ?? [])], t.updatedAt, t.storeId);
  for (const k of db.knowledge) if (k.active) push("knowledge", k.id, `${k.title} ${k.tags.join(" ")}`, [k.category, k.body], k.recordDate ?? k.updatedAt);
  for (const q of db.qualityIssues) push("quality", q.id, `${q.number} ${q.description.slice(0, 40)}`, [q.description, q.cause, q.countermeasure, q.category, cname.get(q.customerId ?? "")], q.occurredOn, q.storeId);
  for (const s of db.surveys) if (s.comment || s.priorities) push("survey", s.id, `アンケート ${s.postcardNo ?? ""}`, [s.comment, s.priorities, s.salesName, s.craftsmanName, cname.get(s.customerId ?? "")], s.receivedAt, s.storeId);
  for (const r of db.reviews) push("review", r.id, `口コミ ${r.reviewerName ?? ""}`, [r.comment, r.note], r.postedOn, r.storeId);
  for (const f of db.faxMessages) push("fax", f.id, `${f.number} ${f.remoteName ?? ""}`, [f.ai?.summary, f.ai?.documentType, f.ai?.senderName, f.remoteNumber, sname.get(f.supplierId ?? "")], f.at, f.storeId);
  for (const p of db.photoAlbums) push("photo", p.id, p.title, [p.customerName, p.area], p.date, p.storeId);
  for (const f of db.sourceFiles) push("file", f.id, f.name, [f.folderName, f.path], f.modifiedOn);
  return out;
}

/** 横断検索の索引 (記録ごとの見出しと本文。VPS のデータベースの search_docs にも同じものを入れる) */
export function searchEntries(db: Database): Entry[] {
  return index(db);
}

function index(db: Database): Entry[] {
  const sig = signature(db);
  if (g.__ichijoyaSearchIndex?.sig === sig) return g.__ichijoyaSearchIndex.entries;
  const entries = buildIndex(db);
  g.__ichijoyaSearchIndex = { sig, entries };
  return entries;
}

const COLLECTION_OF: Record<RecordType, keyof Database> = {
  customer: "customers",
  inquiry: "inquiries",
  quote: "quotes",
  order: "orders",
  invoice: "invoices",
  payment: "payments",
  schedule: "schedule",
  expense: "expenses",
  purchase: "purchases",
  supplier: "suppliers",
  purchase_order: "purchaseOrders",
  comm: "commLogs",
  thread: "threads",
  knowledge: "knowledge",
  quality: "qualityIssues",
  survey: "surveys",
  review: "reviews",
  fax: "faxMessages",
  photo: "photoAlbums",
  file: "sourceFiles",
};
/** ID の一覧 (配列ごと。追加・削除で件数が変わったら作り直す) */
const idCache = new WeakMap<object, { len: number; ids: Set<string> }>();
function recordExists(db: Database, e: Entry): boolean {
  const rows = db[COLLECTION_OF[e.type]] as unknown as { id: string }[];
  if (!Array.isArray(rows)) return false;
  let c = idCache.get(rows);
  if (!c || c.len !== rows.length) idCache.set(rows, (c = { len: rows.length, ids: new Set(rows.map((r) => r.id)) }));
  return c.ids.has(e.id);
}

/** 記録ごとの閲覧権限 (画面と同じ判定) */
function canSee(db: Database, user: User, e: Entry): boolean {
  switch (e.type) {
    case "schedule":
    case "knowledge":
      return e.type === "schedule" ? true : canViewKnowledge(user, db.knowledge.find((k) => k.id === e.id) ?? {});
    case "expense": {
      const x = db.expenses.find((r) => r.id === e.id);
      return Boolean(x && canViewExpense(user, x));
    }
    case "purchase": {
      const x = db.purchases.find((r) => r.id === e.id);
      return Boolean(x && canViewPurchase(user, x));
    }
    case "supplier":
      return canViewSuppliers(user);
    case "purchase_order": {
      const x = db.purchaseOrders.find((r) => r.id === e.id);
      return Boolean(x && canViewPurchaseOrder(user, x));
    }
    case "thread": {
      const x = db.threads.find((r) => r.id === e.id);
      return Boolean(x && canViewThread(user, x));
    }
    case "fax": {
      const x = db.faxMessages.find((r) => r.id === e.id);
      return Boolean(x && canViewFax(user, x));
    }
    case "file":
      return canViewSourceFiles(user);
    case "comm": {
      const x = db.commLogs.find((r) => r.id === e.id);
      if (x?.supplierId && !x.customerId) return canViewSuppliers(user);
      return !e.storeId || canAccessStore(user, e.storeId);
    }
    default:
      return !e.storeId || canAccessStore(user, e.storeId);
  }
}

export interface SearchHit {
  type: RecordType;
  typeLabel: string;
  id: string;
  label: string;
  date: string;
  snippet: string;
  href?: string;
  score: number;
}

export function recordHref(type: RecordType, id: string, db?: Database): string | undefined {
  switch (type) {
    case "customer":
      return `/customers/${id}`;
    case "inquiry":
      return `/inquiries/${id}`;
    case "quote":
      return `/quotes/${id}`;
    case "order":
      return `/orders/${id}`;
    case "invoice":
      return `/invoices/${id}`;
    case "payment": {
      const p = db?.payments.find((x) => x.id === id);
      return p ? `/invoices/${p.invoiceId}` : undefined;
    }
    case "schedule":
      return `/schedule/${id}`;
    case "expense":
      return `/expenses/${id}`;
    case "purchase":
      return `/purchases/${id}`;
    case "supplier":
      return `/suppliers/${id}`;
    case "purchase_order":
      return `/purchase-orders/${id}`;
    case "comm": {
      const l = db?.commLogs.find((x) => x.id === id);
      return l?.customerId ? `/customers/${l.customerId}` : l?.supplierId ? `/suppliers/${l.supplierId}` : "/contacts";
    }
    case "thread":
      return `/messages/${id}`;
    case "knowledge":
      return `/knowledge/${id}`;
    case "quality":
      return "/kpi/quality";
    case "survey":
      return "/kpi/surveys";
    case "review":
      return "/kpi/reviews";
    case "fax":
      return `/fax/${id}`;
    case "photo":
      return "/materials";
    case "file":
      return "/materials?tab=files";
  }
}

/** 一覧に出す見出しと抜粋 (元の記録から作る) */
function describe(db: Database, type: RecordType, id: string): { label: string; snippet: string } {
  const cn = (cid?: string) => db.customers.find((c) => c.id === cid)?.name ?? "";
  const un = (uid?: string) => db.users.find((u) => u.id === uid)?.name ?? "";
  switch (type) {
    case "customer": {
      const c = db.customers.find((x) => x.id === id)!;
      return { label: `${c.name} 様 (${c.code})`, snippet: [c.address, c.phone, c.contacts?.length ? `ほかの連絡先 ${c.contacts.length} 件` : "", c.tradeStopped ? "取引停止" : "", c.notes.slice(0, 60)].filter(Boolean).join(" / ") };
    }
    case "inquiry": {
      const i = db.inquiries.find((x) => x.id === id)!;
      return { label: `問い合わせ ${i.number} ${i.contactName}`, snippet: `${fmtDate(i.receivedAt)} [${CHANNEL_LABEL[i.channel]}] ${i.summary} (${INQUIRY_STATUS[i.status].label}, 担当 ${un(i.assignedUserId) || "-"})` };
    }
    case "quote": {
      const q = db.quotes.find((x) => x.id === id)!;
      return { label: `見積 ${q.number} ${cn(q.customerId)} 様`, snippet: `${q.title} ${yen(q.total)} ${QUOTE_STATUS[q.status].label} (${fmtDate(q.issuedAt ?? q.createdAt)}, 見積担当 ${un(q.estimatorId ?? q.createdBy)})` };
    }
    case "order": {
      const o = db.orders.find((x) => x.id === id)!;
      const f = salesFacts(db).byId.get(id);
      return { label: `受注 ${o.number} ${cn(o.customerId)} 様`, snippet: `${o.title} ${yen(o.total)} ${ORDER_STATUS[o.status].label} 施工 ${fmtDate(o.salesDate ?? o.scheduledStart ?? o.contractDate)} / 現場 ${o.siteAddress || "-"} / 担当 ${f?.staff.join("・") ?? un(o.createdBy)}${o.workerIds.length ? ` / 施工 ${o.workerIds.map(un).join("・")}` : ""}${f?.items.length ? ` / 明細: ${f.items.slice(0, 4).map((i) => `${i.product}×${i.qty}`).join("、")}` : ""}` };
    }
    case "invoice": {
      const i = db.invoices.find((x) => x.id === id)!;
      return { label: `請求 ${i.number} ${cn(i.customerId)} 様`, snippet: `${yen(i.total)} 入金 ${yen(i.paidAmount)} ${INVOICE_STATUS[i.status].label} 期限 ${fmtDate(i.dueDate)}` };
    }
    case "payment": {
      const p = db.payments.find((x) => x.id === id)!;
      const i = db.invoices.find((x) => x.id === p.invoiceId);
      return { label: `入金 ${fmtDate(p.date)} ${cn(i?.customerId)} 様`, snippet: `${yen(p.amount)} (請求 ${i?.number ?? "-"})${p.memo ? ` ${p.memo}` : ""}` };
    }
    case "schedule": {
      const e = db.schedule.find((x) => x.id === id)!;
      return { label: `予定 ${fmtDate(e.date)}${e.endDate && e.endDate !== e.date ? `〜${fmtDate(e.endDate)}` : ""} ${e.title}`, snippet: `[${SCHEDULE_KIND[e.kind]?.label ?? e.kind}] ${db.stores.find((s) => s.id === e.storeId)?.shortName ?? ""}${e.startTime ? ` ${e.startTime}${e.endTime ? `-${e.endTime}` : ""}` : e.slot ? ` ${e.slot === "am" ? "午前" : "午後"}` : ""} 担当 ${e.assigneeIds.map(un).join("・") || "-"}${e.location ? ` @${e.location}` : ""}${e.memo ? ` / ${e.memo.slice(0, 80)}` : ""}` };
    }
    case "expense": {
      const e = db.expenses.find((x) => x.id === id)!;
      return { label: `経費 ${e.number} ${e.vendor}`, snippet: `${fmtDate(e.date)} ${yen(e.amount)} ${e.account} ${e.description} (${EXPENSE_STATUS[e.status].label}, ${un(e.submittedBy)})` };
    }
    case "purchase": {
      const p = db.purchases.find((x) => x.id === id)!;
      return { label: `仕入 ${p.number} ${db.suppliers.find((s) => s.id === p.supplierId)?.name ?? ""}`, snippet: `${fmtDate(p.invoiceDate)} ${yen(p.amount)} ${p.description} (${PURCHASE_STATUS[p.status].label})` };
    }
    case "supplier": {
      const s = db.suppliers.find((x) => x.id === id)!;
      return { label: `${s.name}`, snippet: [s.category, s.phone && `TEL ${s.phone}`, s.fax && `FAX ${s.fax}`, s.paymentTerms].filter(Boolean).join(" / ") };
    }
    case "purchase_order": {
      const p = db.purchaseOrders.find((x) => x.id === id)!;
      return { label: `発注書 ${p.number} ${db.suppliers.find((s) => s.id === p.supplierId)?.name ?? ""}`, snippet: `${fmtDate(p.issuedOn)} ${PURCHASE_ORDER_STATUS[p.status].label} ${p.lines.map((l) => `${l.name}×${l.qty}${l.unit}`).join("、").slice(0, 120)}` };
    }
    case "comm": {
      const l = db.commLogs.find((x) => x.id === id)!;
      return { label: `連絡 ${fmtDate(l.at)} ${cn(l.customerId) || db.suppliers.find((s) => s.id === l.supplierId)?.name || l.contactName || ""}`, snippet: `[${CHANNEL_LABEL[l.channel]}・${l.direction === "inbound" ? "受" : "発"}] ${l.subject} ${l.body.slice(0, 100)} (${un(l.userId)})` };
    }
    case "thread": {
      const t = db.threads.find((x) => x.id === id)!;
      const last = db.messages.filter((m) => m.threadId === id).at(-1);
      return { label: `社内連絡 ${t.title}`, snippet: `${fmtDate(t.updatedAt)} ${last ? `${un(last.userId)}: ${last.body.slice(0, 100)}` : ""}` };
    }
    case "knowledge": {
      const k = db.knowledge.find((x) => x.id === id)!;
      return { label: `社内資料「${k.title}」(${k.category || "その他"})`, snippet: `${k.recordDate ? `${fmtDate(k.recordDate)} ` : ""}${k.body.slice(0, 160)}` };
    }
    case "quality": {
      const q = db.qualityIssues.find((x) => x.id === id)!;
      return { label: `${q.kind === "claim" ? "クレーム" : q.kind === "rework" ? "手直し" : "クレーム・手直し"} ${q.number}`, snippet: `${fmtDate(q.occurredOn)} ${q.description.slice(0, 80)}${q.countermeasure ? ` / 対応: ${q.countermeasure.slice(0, 60)}` : ""}` };
    }
    case "survey": {
      const s = db.surveys.find((x) => x.id === id)!;
      return { label: `アンケート ${fmtDate(s.answeredOn ?? s.receivedAt)}`, snippet: `${s.comment ?? ""} ${s.priorities ?? ""}`.slice(0, 140) };
    }
    case "review": {
      const r = db.reviews.find((x) => x.id === id)!;
      return { label: `口コミ ${fmtDate(r.postedOn)} ${r.reviewerName ?? ""}`, snippet: `${r.rating ? `★${r.rating} ` : ""}${(r.comment ?? "").slice(0, 120)}` };
    }
    case "fax": {
      const f = db.faxMessages.find((x) => x.id === id)!;
      return { label: `FAX ${f.number} ${f.direction === "inbound" ? "受信" : "送信"} ${f.remoteName ?? f.remoteNumber}`, snippet: `${fmtDate(f.at)} ${f.ai?.documentType ?? ""} ${f.ai?.summary ?? ""}`.slice(0, 140) };
    }
    case "photo": {
      const p = db.photoAlbums.find((x) => x.id === id)!;
      return { label: `現場写真 ${p.title}`, snippet: `${p.date ?? ""} ${p.customerName ?? ""} ${p.area ?? ""} ${p.photoCount} 枚` };
    }
    case "file": {
      const f = db.sourceFiles.find((x) => x.id === id)!;
      return { label: `資料 ${f.name}`, snippet: `${f.folderName} / ${f.path}` };
    }
  }
}

export interface SearchOptions {
  query: string;
  types?: string[];
  from?: string;
  to?: string;
  store?: string;
  limit?: number;
}

export interface SearchResult {
  hits: SearchHit[];
  /** 種類ごとの当たった件数 (閲覧できるものだけ) */
  counts: Partial<Record<RecordType, number>>;
  total: number;
  /** AND で見つからず、一部の言葉で探した */
  partial: boolean;
}

/** 検索の言葉 (空白・読点で区切る。助詞の「の」「は」などは区切りにしない: 地名・品名を壊さないため) */
export function queryTerms(q: string): string[] {
  return [
    ...new Set(
      q
        .normalize("NFKC")
        .split(/[\s　、,，。・/]+/)
        .map((t) => normText(t.replace(/^(様|さん)$/, "").replace(/(様|さま|さん|邸)$/, "")))
        .filter((t) => t.length >= 1),
    ),
  ].slice(0, 8);
}

/**
 * 検索の候補を VPS のデータベース (src/lib/datastore/mirror.ts の search_docs・search_fts) から取る関数。
 * データベースが使えないとき (準備中・サンプルデータ) は undefined を返し、メモリの索引で探す
 */
export type SearchProvider = (q: { terms: string[]; mode: "and" | "or"; types: RecordType[]; storeId?: string; from?: string; to?: string; limit: number }) => Entry[] | undefined;
const gp = globalThis as typeof globalThis & { __ichijoyaSearchProvider?: SearchProvider };
export function setSearchProvider(fn: SearchProvider | undefined): void {
  gp.__ichijoyaSearchProvider = fn;
}
/** 最後の検索をどこで行ったか (回答の根拠の表示用) */
export let lastSearchSource: "database" | "memory" = "memory";

export function searchAll(db: Database, user: User, opts: SearchOptions): SearchResult {
  const terms = queryTerms(opts.query ?? "");
  const types = new Set((opts.types ?? []).filter((t): t is RecordType => t in RECORD_TYPE_LABEL));
  const store = opts.store ? db.stores.find((s) => s.id === opts.store || s.name.includes(opts.store!) || s.shortName === opts.store) : undefined;
  const from = opts.from && /^\d{4}-\d{2}-\d{2}$/.test(opts.from) ? opts.from : "";
  const to = opts.to && /^\d{4}-\d{2}-\d{2}$/.test(opts.to) ? opts.to : "";
  const limit = Math.min(40, Math.max(1, opts.limit ?? 15));
  const inMemory = () => index(db).filter((e) => (!types.size || types.has(e.type)) && (!store || e.storeId === store.id) && (!from || e.date >= from) && (!to || (e.date && e.date <= to)));
  // VPS のデータベースで候補を探す (なければメモリの索引)
  const provider = gp.__ichijoyaSearchProvider;
  const fromDb = (mode: "and" | "or") => {
    try {
      return provider?.({ terms, mode, types: [...types], storeId: store?.id, from: from || undefined, to: to || undefined, limit: 4000 });
    } catch (err) {
      console.warn("[search] database search failed, using memory:", (err as Error).message);
      return undefined;
    }
  };
  const dbPool = fromDb("and");
  lastSearchSource = dbPool ? "database" : "memory";
  let pool = dbPool ?? inMemory();
  const score = (e: Entry, needAll: boolean): number => {
    if (!terms.length) return 1;
    let s = 0;
    let hit = 0;
    for (const t of terms) {
      if (e.text.includes(t)) {
        hit++;
        s += e.head.includes(t) ? 5 : 2;
        if (e.head === t || e.head.startsWith(t)) s += 3;
      } else if (needAll) return 0;
    }
    return hit ? s + hit * 3 : 0;
  };
  let partial = false;
  let found = pool.map((e) => ({ e, s: score(e, true) })).filter((x) => x.s > 0);
  if (!found.length && terms.length > 1) {
    partial = true;
    if (dbPool) pool = fromDb("or") ?? inMemory();
    found = pool.map((e) => ({ e, s: score(e, false) })).filter((x) => x.s > terms.length * 3);
  }
  // 閲覧の権限は、システムの今の記録で確かめる (データベースの写しにあっても、消された記録は出さない)
  found = found.filter((x) => recordExists(db, x.e) && canSee(db, user, x.e));
  const counts: Partial<Record<RecordType, number>> = {};
  for (const x of found) counts[x.e.type] = (counts[x.e.type] ?? 0) + 1;
  // 点数の高い順 → 新しい順 (言葉のない一覧 (予定の一覧など) は日付の順)
  found.sort((a, b) => (terms.length ? b.s - a.s || b.e.date.localeCompare(a.e.date) : types.has("schedule") && types.size === 1 ? a.e.date.localeCompare(b.e.date) : b.e.date.localeCompare(a.e.date)));
  // 1 種類に偏らないよう、種類ごとに上位から順に取る
  const picked: typeof found = [];
  if (!types.size && terms.length) {
    const byType = new Map<RecordType, typeof found>();
    for (const x of found) byType.set(x.e.type, [...(byType.get(x.e.type) ?? []), x]);
    const queues = [...byType.values()];
    while (picked.length < limit && queues.some((q) => q.length)) for (const q of queues) if (q.length && picked.length < limit) picked.push(q.shift()!);
    picked.sort((a, b) => b.s - a.s || b.e.date.localeCompare(a.e.date));
  } else picked.push(...found.slice(0, limit));
  const hits = picked.map(({ e, s }) => {
    const d = describe(db, e.type, e.id);
    return { type: e.type, typeLabel: RECORD_TYPE_LABEL[e.type], id: e.id, label: d.label, date: e.date, snippet: d.snippet, href: recordHref(e.type, e.id, db), score: s };
  });
  return { hits, counts, total: found.length, partial };
}

/* ================================================================== */
/* 記録の詳細                                                            */
/* ================================================================== */

export interface RecordDetail {
  ok: boolean;
  type?: RecordType;
  id?: string;
  label?: string;
  href?: string;
  text: string;
}

/** 番号 (O-2026-0012・Q-…・INQ-…・INV-…・C-…・PO-…・FX-…) または ID から記録を探す */
function findByRef(db: Database, type: string | undefined, ref: string): { type: RecordType; id: string } | undefined {
  const r = ref.trim();
  const up = r.toUpperCase();
  const tries: [RecordType, { id: string; number?: string; code?: string }[]][] = [
    ["customer", db.customers],
    ["inquiry", db.inquiries],
    ["quote", db.quotes],
    ["order", db.orders],
    ["invoice", db.invoices],
    ["schedule", db.schedule],
    ["expense", db.expenses],
    ["purchase", db.purchases],
    ["supplier", db.suppliers],
    ["purchase_order", db.purchaseOrders],
    ["knowledge", db.knowledge],
    ["quality", db.qualityIssues],
    ["fax", db.faxMessages],
    ["thread", db.threads],
  ];
  for (const [t, rows] of tries) {
    if (type && type !== t) continue;
    const hit = rows.find((x) => x.id === r || x.number?.toUpperCase() === up || x.code?.toUpperCase() === up);
    if (hit) return { type: t, id: hit.id };
  }
  return undefined;
}

export function getRecord(db: Database, user: User, type: string | undefined, ref: string): RecordDetail {
  const found = findByRef(db, type, ref);
  if (!found) return { ok: false, text: `「${ref}」に当てはまる記録は見つかりませんでした。番号 (例: O-2026-0012) か、検索結果の ID を指定してください。` };
  const entry = index(db).find((e) => e.type === found.type && e.id === found.id);
  if (!entry || !canSee(db, user, entry)) return { ok: false, text: "この記録を閲覧する権限がありません。" };
  const un = (id?: string) => (id ? (db.users.find((u) => u.id === id)?.name ?? "(退職・不明)") : "-");
  const cn = (id?: string) => db.customers.find((c) => c.id === id)?.name ?? "-";
  const store = (id?: string) => db.stores.find((s) => s.id === id)?.name ?? "-";
  const lines: string[] = [];
  const href = recordHref(found.type, found.id, db);
  const link = (t: RecordType, id: string, label: string) => `[${label}](${recordHref(t, id, db)})`;
  const facts = salesFacts(db).byId;
  const orderLine = (o: (typeof db.orders)[number]) => {
    const f = facts.get(o.id);
    return `- ${link("order", o.id, o.number)} ${fmtDate(o.salesDate ?? o.contractDate)} ${o.title} ${yen(o.total)} ${ORDER_STATUS[o.status].label} 担当 ${f?.staff.join("・") ?? un(o.createdBy)}${o.workerIds.length ? ` 施工 ${o.workerIds.map(un).join("・")}` : ""}${o.siteAddress ? ` 現場 ${o.siteAddress}` : ""}${f?.items.length ? `\n  明細: ${f.items.map((i) => `${i.product} ${i.qty}×${yen(i.unitPrice)}`).join(" / ").slice(0, 300)}` : ""}`;
  };
  switch (found.type) {
    case "customer": {
      const c = db.customers.find((x) => x.id === found.id)!;
      const orders = db.orders.filter((o) => o.customerId === c.id).sort((a, b) => (b.salesDate ?? b.contractDate).localeCompare(a.salesDate ?? a.contractDate));
      const quotes = db.quotes.filter((q) => q.customerId === c.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const inquiries = db.inquiries.filter((i) => i.customerId === c.id).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
      const invoices = db.invoices.filter((i) => i.customerId === c.id && i.status !== "void");
      const comms = db.commLogs.filter((l) => l.customerId === c.id).sort((a, b) => b.at.localeCompare(a.at));
      const events = db.schedule.filter((e) => e.customerId === c.id).sort((a, b) => b.date.localeCompare(a.date));
      const sales = orders.filter((o) => o.salesDate && o.status !== "cancelled").reduce((a, o) => a + o.total, 0);
      lines.push(`顧客 ${link("customer", c.id, `${c.name} 様`)} (${c.code} / ${c.kana} / ${c.type === "corporate" ? "法人" : "個人"} / 担当店舗 ${store(c.storeId)} / 担当者 ${un(c.assignedUserId)})`);
      if (c.tradeStopped) lines.push(`※ 取引停止${c.tradeStopNote ? ` (${c.tradeStopNote})` : ""}`);
      lines.push(`電話 ${c.phone || "-"}${c.contacts?.length ? ` / ほかの連絡先: ${c.contacts.map(contactLine).join("、")}` : ""} / メール ${c.email ?? "-"} / LINE ${c.lineId ?? "-"}`);
      lines.push(`住所 〒${c.postalCode} ${c.address}${c.area ? ` (地区 ${c.area})` : ""} / 初回接点 ${CHANNEL_LABEL[c.firstContactChannel]} / 登録 ${fmtDate(c.createdAt)}`);
      if (c.notes) lines.push(`備考: ${c.notes.slice(0, 300)}`);
      lines.push(`累計売上 ${yen(sales)} (受注 ${orders.length} 件 / 見積 ${quotes.length} 件 / 問い合わせ ${inquiries.length} 件 / 未入金 ${yen(invoices.reduce((a, i) => a + i.total - i.paidAmount, 0))})`);
      const staffSeq = orders.map((o) => facts.get(o.id)?.staff.join("・") ?? un(o.createdBy));
      if (staffSeq.length) lines.push(`前回の担当者: ${staffSeq[0]}${orders[0].workerIds.length ? ` (施工 ${orders[0].workerIds.map(un).join("・")})` : ""} / これまでの担当者: ${[...new Set(staffSeq)].join("、")}`);
      if (orders.length) lines.push(`## 受注・施工の履歴 (新しい順)\n${orders.slice(0, 15).map(orderLine).join("\n")}${orders.length > 15 ? `\n(ほか ${orders.length - 15} 件)` : ""}`);
      if (quotes.length) lines.push(`## 見積\n${quotes.slice(0, 8).map((q) => `- ${link("quote", q.id, q.number)} ${fmtDate(q.issuedAt ?? q.createdAt)} ${q.title} ${yen(q.total)} ${QUOTE_STATUS[q.status].label}`).join("\n")}`);
      if (inquiries.length) lines.push(`## 問い合わせ\n${inquiries.slice(0, 8).map((i) => `- ${link("inquiry", i.id, i.number)} ${fmtDate(i.receivedAt)} [${CHANNEL_LABEL[i.channel]}] ${i.summary} (${INQUIRY_STATUS[i.status].label}, 担当 ${un(i.assignedUserId)})`).join("\n")}`);
      if (invoices.length) lines.push(`## 請求\n${invoices.slice(0, 8).map((i) => `- ${link("invoice", i.id, i.number)} ${fmtDate(i.issueDate)} ${yen(i.total)} 入金 ${yen(i.paidAmount)} ${INVOICE_STATUS[i.status].label}`).join("\n")}`);
      if (events.length) lines.push(`## 予定\n${events.slice(0, 8).map((e) => `- ${fmtDate(e.date)} [${SCHEDULE_KIND[e.kind]?.label}] ${e.title} 担当 ${e.assigneeIds.map(un).join("・") || "-"}`).join("\n")}`);
      if (comms.length) lines.push(`## 連絡履歴\n${comms.slice(0, 8).map((l) => `- ${fmtDate(l.at)} [${CHANNEL_LABEL[l.channel]}・${l.direction === "inbound" ? "受" : "発"}] ${l.subject}: ${l.body.slice(0, 100)} (${un(l.userId)})`).join("\n")}`);
      break;
    }
    case "order": {
      const o = db.orders.find((x) => x.id === found.id)!;
      const f = facts.get(o.id);
      const q = o.quoteId ? db.quotes.find((x) => x.id === o.quoteId) : undefined;
      lines.push(`受注 ${link("order", o.id, o.number)} ${link("customer", o.customerId, `${cn(o.customerId)} 様`)} / ${o.title} / ${CATEGORY_LABEL[o.category]} / ${store(o.storeId)} / ${ORDER_STATUS[o.status].label}`);
      lines.push(`契約 ${fmtDate(o.contractDate)} ${yen(o.total)} / 施工 ${o.scheduledStart ? fmtDate(o.scheduledStart) : "未定"}${o.scheduledEnd && o.scheduledEnd !== o.scheduledStart ? `〜${fmtDate(o.scheduledEnd)}` : ""} / 完了 ${o.completedAt ? fmtDate(o.completedAt) : "-"} / 売上計上 ${o.salesDate ? fmtDate(o.salesDate) : "-"}`);
      lines.push(`担当 ${f?.staff.join("・") ?? un(o.createdBy)} / 施工担当 ${o.workerIds.map(un).join("・") || "-"} / 施工場所 ${o.siteAddress || "-"}${o.receiptName ? ` / 領収書の宛名 ${o.receiptName}` : ""}${q ? ` / 見積 ${link("quote", q.id, q.number)}` : ""}`);
      if (o.tatamiCost) lines.push(`畳原価 ${yen(o.tatamiCost)}`);
      if (f?.items.length) lines.push(`## 明細 (税込)\n${f.items.map((i) => `- ${i.product} ${i.qty} × ${yen(i.unitPrice)} = ${yen(i.amount)}`).join("\n")}`);
      if (o.workDetails) lines.push(`施工内容: ${o.workDetails}`);
      const si = siteInfoText(o.siteInfo);
      if (si) lines.push(`現場情報: ${si}`);
      if (o.progressNotes.length) lines.push(`## 経過 (新しい順)\n${[...o.progressNotes].reverse().slice(0, 10).map((n) => `- ${fmtDate(n.at)} [${PROGRESS_KIND_LABEL[n.kind] ?? n.kind}] ${un(n.userId)}: ${n.body.replace(/\n/g, " ").slice(0, 200)}`).join("\n")}`);
      const ev = db.schedule.filter((e) => e.orderId === o.id);
      if (ev.length) lines.push(`## 予定\n${ev.map((e) => `- ${fmtDate(e.date)} [${SCHEDULE_KIND[e.kind]?.label}] ${e.title} 担当 ${e.assigneeIds.map(un).join("・") || "-"}`).join("\n")}`);
      const inv = db.invoices.filter((i) => i.orderId === o.id);
      if (inv.length) lines.push(`## 請求\n${inv.map((i) => `- ${link("invoice", i.id, i.number)} ${yen(i.total)} 入金 ${yen(i.paidAmount)} ${INVOICE_STATUS[i.status].label}`).join("\n")}`);
      const pos = db.purchaseOrders.filter((p) => p.orderIds.includes(o.id));
      if (pos.length && canViewSuppliers(user)) lines.push(`## 発注書\n${pos.map((p) => `- ${link("purchase_order", p.id, p.number)} ${db.suppliers.find((s) => s.id === p.supplierId)?.name ?? ""} ${fmtDate(p.issuedOn)} ${PURCHASE_ORDER_STATUS[p.status].label}`).join("\n")}`);
      const pur = db.purchases.filter((p) => p.orderId === o.id && canViewPurchase(user, p));
      if (pur.length) lines.push(`## 仕入\n${pur.map((p) => `- ${link("purchase", p.id, p.number)} ${db.suppliers.find((s) => s.id === p.supplierId)?.name ?? ""} ${yen(p.amount)} ${p.description}`).join("\n")}`);
      const qi = db.qualityIssues.filter((x) => x.orderId === o.id);
      if (qi.length) lines.push(`## クレーム・手直し\n${qi.map((x) => `- ${x.number} ${fmtDate(x.occurredOn)} ${x.description.slice(0, 100)}${x.countermeasure ? ` / 対応: ${x.countermeasure.slice(0, 80)}` : ""}`).join("\n")}`);
      break;
    }
    case "supplier": {
      const s = db.suppliers.find((x) => x.id === found.id)!;
      lines.push(`仕入先 ${link("supplier", s.id, s.name)} (${s.kind === "partner" ? "協力業者" : "仕入先"} / ${s.category}) TEL ${s.phone ?? "-"} FAX ${s.fax ?? "-"} 担当 ${s.contactName ?? "-"} / 支払条件 ${s.paymentTerms}`);
      if (s.notes) lines.push(`備考: ${s.notes}`);
      const pos = db.purchaseOrders.filter((p) => p.supplierId === s.id && canViewPurchaseOrder(user, p)).sort((a, b) => b.issuedOn.localeCompare(a.issuedOn));
      if (pos.length) lines.push(`## 発注の履歴 (新しい順)\n${pos.slice(0, 15).map((p) => `- ${link("purchase_order", p.id, p.number)} ${fmtDate(p.issuedOn)} ${store(p.storeId)} ${PURCHASE_ORDER_STATUS[p.status].label}: ${p.lines.map((l) => `${l.name}${l.spec ? ` ${l.spec}` : ""}×${l.qty}${l.unit}${l.orderNumber ? ` (${l.orderNumber})` : ""}`).join("、").slice(0, 200)}`).join("\n")}`);
      const pur = db.purchases.filter((p) => p.supplierId === s.id && canViewPurchase(user, p)).sort((a, b) => b.invoiceDate.localeCompare(a.invoiceDate));
      if (pur.length) lines.push(`## 仕入 (請求) の履歴\n${pur.slice(0, 15).map((p) => `- ${link("purchase", p.id, p.number)} ${fmtDate(p.invoiceDate)} ${yen(p.amount)} ${p.description} (${PURCHASE_STATUS[p.status].label})`).join("\n")}\n合計 ${yen(pur.reduce((a, p) => a + p.amount, 0))} (${pur.length} 件)`);
      if (!pos.length && !pur.length) lines.push("発注・仕入の記録はまだありません。");
      break;
    }
    case "knowledge": {
      const k = db.knowledge.find((x) => x.id === found.id)!;
      lines.push(`社内資料 ${link("knowledge", k.id, k.title)} (分類 ${k.category || "その他"}${k.recordDate ? ` / 日付 ${fmtDate(k.recordDate)}` : ""} / 更新 ${fmtDate(k.updatedAt)})`);
      lines.push(k.body.slice(0, 6000));
      break;
    }
    default: {
      const d = describe(db, found.type, found.id);
      lines.push(`${RECORD_TYPE_LABEL[found.type]} ${href ? `[${d.label}](${href})` : d.label}`);
      lines.push(d.snippet);
      if (found.type === "inquiry") {
        const i = db.inquiries.find((x) => x.id === found.id)!;
        lines.push(`詳細: ${i.detail.slice(0, 1500)}`);
        if (i.customerId) lines.push(`顧客: ${link("customer", i.customerId, `${cn(i.customerId)} 様`)}`);
      }
      if (found.type === "quote") {
        const q = db.quotes.find((x) => x.id === found.id)!;
        lines.push(`明細: ${q.items.map((i) => `${i.name}${i.spec ? ` ${i.spec}` : ""} ${i.qty}${i.unit}×${yen(i.unitPrice)}`).join(" / ")}${q.discount ? ` / 値引 ${yen(q.discount)}` : ""} (${q.taxIncluded ? "税込" : "税抜"})`);
        if (q.workDetails) lines.push(`施工内容: ${q.workDetails}`);
        if (q.siteAddress) lines.push(`施工場所: ${q.siteAddress}`);
      }
      if (found.type === "thread") lines.push(db.messages.filter((m) => m.threadId === found.id).slice(-10).map((m) => `- ${fmtDate(m.at)} ${un(m.userId)}: ${m.body.slice(0, 200)}`).join("\n"));
      if (found.type === "schedule") {
        const e = db.schedule.find((x) => x.id === found.id)!;
        if (e.orderId) lines.push(`受注: ${link("order", e.orderId, db.orders.find((o) => o.id === e.orderId)?.number ?? "受注")}`);
        if (e.memo) lines.push(`メモ: ${e.memo.slice(0, 800)}`);
      }
      if (found.type === "quality") {
        const q = db.qualityIssues.find((x) => x.id === found.id)!;
        lines.push(`原因: ${q.cause ?? "-"} / 対策: ${q.countermeasure ?? "-"} / 状態: ${q.status === "resolved" ? "解決" : "対応中"} / 担当 ${q.responsibleUserIds.map(un).join("・")}`);
      }
    }
  }
  const text = lines.join("\n");
  return { ok: true, type: found.type, id: found.id, label: describe(db, found.type, found.id).label, href, text: text.length > 9000 ? `${text.slice(0, 9000)}\n(以下省略)` : text };
}

/** 予定の一覧 (期間・店舗・担当者・種類・言葉で絞る)。予定表は全社で共有 */
export function listSchedule(db: Database, opts: { from: string; to: string; store?: string; staff?: string; kind?: string; keyword?: string; limit?: number }): { text: string; count: number; links: { label: string; href: string }[] } {
  const un = (id: string) => db.users.find((u) => u.id === id)?.name ?? "-";
  const store = opts.store ? db.stores.find((s) => s.id === opts.store || s.name.includes(opts.store!) || opts.store!.includes(s.shortName)) : undefined;
  const kw = opts.keyword ? normText(opts.keyword) : "";
  const staffKw = opts.staff ? normText(opts.staff) : "";
  const kind = opts.kind ? Object.entries(SCHEDULE_KIND).find(([k, v]) => k === opts.kind || v.label.includes(opts.kind!))?.[0] : undefined;
  const list = db.schedule
    .filter((e) => (e.endDate ?? e.date) >= opts.from && e.date <= opts.to)
    .filter((e) => !store || e.storeId === store.id || e.companyWide)
    .filter((e) => !staffKw || e.assigneeIds.some((a) => normText(un(a)).includes(staffKw)))
    .filter((e) => !kind || e.kind === kind)
    .filter((e) => !kw || normText(`${e.title} ${e.memo ?? ""} ${e.location ?? ""}`).includes(kw))
    .sort((a, b) => a.date.localeCompare(b.date) || (a.startTime ?? "").localeCompare(b.startTime ?? ""));
  const limit = Math.min(120, opts.limit ?? 80);
  const text = list
    .slice(0, limit)
    .map((e) => `- ${fmtDate(e.date, { weekday: true })}${e.endDate && e.endDate !== e.date ? `〜${fmtDate(e.endDate)}` : ""} ${e.startTime ? `${e.startTime}${e.endTime ? `-${e.endTime}` : ""}` : e.slot === "am" ? "午前" : e.slot === "pm" ? "午後" : "終日"} [${SCHEDULE_KIND[e.kind]?.label ?? e.kind}] ${e.title} (${db.stores.find((s) => s.id === e.storeId)?.shortName ?? ""}${e.companyWide ? "・全社" : ""} / ${e.assigneeIds.map(un).join("・") || "担当なし"}${e.location ? ` @${e.location}` : ""}) [開く](/schedule/${e.id})`)
    .join("\n");
  return { text: `${opts.from}〜${opts.to} の予定 ${list.length} 件${store ? ` (${store.name}・全社共通を含む)` : ""}${list.length > limit ? ` (先頭 ${limit} 件)` : ""}\n${text}`, count: list.length, links: list.slice(0, 5).map((e) => ({ label: `${fmtDate(e.date)} ${e.title}`.slice(0, 30), href: `/schedule/${e.id}` })) };
}

export function storeScopeNote(db: Database, user: User): string {
  return canSeeAllStores(user) ? "全店舗" : `${db.stores.find((s) => s.id === user.storeId)?.name ?? "自店舗"} (顧客・案件・売上は自店舗のみ。予定は全社共有)`;
}
