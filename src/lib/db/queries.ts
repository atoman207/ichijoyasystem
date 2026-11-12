import "server-only";
import { getDb } from "./store";
import type {
  Approval,
  Customer,
  Database,
  Order,
  Quote,
  StoreId,
  User,
} from "./types";
import { canApprove, canSeeAllStores, scopeByStore } from "@/lib/auth/permissions";
import { addDays, toDateKey, toMonthKey } from "@/lib/format";
import { analyzeConflicts, compareEvents, lastDay, occursOn, periodLabel } from "@/lib/calendar";
import { caseEvents } from "./schedule";

/* ---------------- lookups ---------------- */

/** ID → 行 の索引 (配列ごとにキャッシュ。件数が変わったら作り直す) */
const indexCache = new WeakMap<object, { size: number; map: Map<string, unknown> }>();
export function byId<T extends { id: string }>(rows: T[], id: string): T | undefined {
  let idx = indexCache.get(rows);
  if (!idx || idx.size !== rows.length) {
    idx = { size: rows.length, map: new Map(rows.map((r) => [r.id, r])) };
    indexCache.set(rows, idx);
  }
  const hit = idx.map.get(id) as T | undefined;
  return hit && hit.id === id ? hit : rows.find((r) => r.id === id);
}

export function userById(id?: string): User | undefined {
  if (!id) return undefined;
  return byId(getDb().users, id);
}
export function userName(id?: string): string {
  return userById(id)?.name ?? "-";
}
export function storeById(id?: StoreId) {
  return getDb().stores.find((s) => s.id === id);
}
export function storeName(id?: StoreId): string {
  return storeById(id)?.name ?? "-";
}
export function customerById(id?: string): Customer | undefined {
  if (!id) return undefined;
  return byId(getDb().customers, id);
}
export function customerName(id?: string): string {
  return customerById(id)?.name ?? "-";
}
export function supplierName(id?: string): string {
  return getDb().suppliers.find((s) => s.id === id)?.name ?? "-";
}

/* ---------------- 入力フォームの顧客選択肢 ---------------- */

/** この件数までは全件をプルダウンに並べる。超える場合は検索して選ぶ (1 万件を超えると画面が重くなるため) */
export const CUSTOMER_OPTION_LIMIT = 300;

/**
 * 入力フォームの「お客様」の選択肢 (呼び出し側で店舗の範囲に絞ってから渡す)
 * - 件数が少なければ全件 (フリガナ順)
 * - 多ければ、検索語 (氏名・フリガナ・顧客コード・電話番号の一部) に一致する最大 50 件と、選択済みのお客様
 */
export function customerOptions(scoped: Customer[], q: string | undefined, selectedId?: string): { options: Customer[]; searchable: boolean; total: number } {
  const byKana = (a: Customer, b: Customer) => a.kana.localeCompare(b.kana, "ja");
  const total = scoped.length;
  if (total <= CUSTOMER_OPTION_LIMIT) return { options: [...scoped].sort(byKana), searchable: false, total };
  const term = (q ?? "").trim();
  const digits = term.replace(/[^0-9]/g, "");
  const hits = term
    ? scoped.filter((c) => c.name.includes(term) || c.kana.includes(term) || c.code.includes(term) || (digits.length >= 3 && c.phone.replace(/[^0-9]/g, "").includes(digits))).slice(0, 50)
    : [];
  const selected = selectedId ? scoped.find((c) => c.id === selectedId) : undefined;
  const options = [...(selected ? [selected] : []), ...hits.filter((c) => c.id !== selected?.id)].sort(byKana);
  return { options, searchable: true, total };
}

/* ---------------- notifications ---------------- */

export interface NotificationSummary {
  pendingApprovals: Approval[];
  myRequests: Approval[];
  mentions: { threadId: string; threadTitle: string; from: string; at: string; body: string }[];
  overdueInvoices: number;
  newInquiries: number;
  /** 今日の予定 (自分・自店舗・全社共通。全店舗ロールは全件) */
  todayEvents: number;
  /** 他の人があなたを担当者にして登録・変更した今後の予定 (直近 3 日以内の更新) */
  assignedEvents: { id: string; title: string; when: string; by: string; updated: boolean }[];
  /** あなたが担当する今後 14 日間の予定のうち、時間帯が重なっている組み合わせの数 */
  myConflicts: number;
  total: number;
}

export function notificationsFor(user: User): NotificationSummary {
  const db = getDb();
  const today = toDateKey(new Date());
  const pendingApprovals = db.approvals.filter((a) => a.status === "pending" && canApprove(user, a));
  const myRequests = db.approvals.filter((a) => a.status === "pending" && a.requestedBy === user.id);
  const threads = new Map(db.threads.map((t) => [t.id, t]));
  const mentions = db.messages
    .filter((m) => m.mentions.includes(user.id) && m.userId !== user.id)
    .filter((m) => threads.get(m.threadId)?.status === "open")
    .slice(-5)
    .reverse()
    .map((m) => ({ threadId: m.threadId, threadTitle: threads.get(m.threadId)?.title ?? "", from: userName(m.userId), at: m.at, body: m.body }));
  const invoices = scopeByStore(user, db.invoices);
  const overdueInvoices = invoices.filter((i) => i.status === "overdue" || (i.status === "issued" && i.dueDate < today)).length;
  const newInquiries = scopeByStore(user, db.inquiries).filter((i) => i.status === "new").length;
  const allStores = canSeeAllStores(user);
  const todayEvents = db.schedule.filter((e) => occursOn(e, today) && (allStores || e.assigneeIds.includes(user.id) || e.storeId === user.storeId || e.companyWide)).length;
  const horizon = addDays(today, 14);
  const mine = db.schedule.filter((e) => e.assigneeIds.includes(user.id) && lastDay(e) >= today && e.date <= horizon);
  const since = new Date(Date.now() - 3 * 86400000).toISOString();
  const assignedEvents = mine
    .filter((e) => {
      const by = e.updatedBy ?? e.createdBy;
      const at = e.updatedAt ?? e.createdAt ?? "";
      return Boolean(by) && by !== user.id && at >= since;
    })
    .sort(compareEvents)
    .slice(0, 5)
    .map((e) => ({ id: e.id, title: e.title, when: periodLabel(e), by: userName(e.updatedBy ?? e.createdBy), updated: Boolean(e.createdAt && e.updatedAt && e.updatedAt > e.createdAt) }));
  const myConflicts = analyzeConflicts(mine).pairs.filter((p) => p.userId === user.id).length;
  return {
    pendingApprovals,
    myRequests,
    mentions,
    overdueInvoices,
    newInquiries,
    todayEvents,
    assignedEvents,
    myConflicts,
    total: pendingApprovals.length + mentions.length + overdueInvoices + newInquiries + assignedEvents.length + (myConflicts > 0 ? 1 : 0),
  };
}

/* ---------------- dashboard / reports ---------------- */

export interface MonthlySales {
  month: string;
  byStore: Record<StoreId, number>;
  total: number;
}

/** 施工完了 (売上計上日) ベースの月次売上 */
export function monthlySales(db: Database, months = 12, now = new Date()): MonthlySales[] {
  const keys: string[] = [];
  const d = new Date(now.getFullYear(), now.getMonth(), 1);
  for (let i = months - 1; i >= 0; i--) {
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
    keys.push(toMonthKey(m));
  }
  const empty = (): Record<StoreId, number> => ({ koshi: 0, chuo: 0, nishi: 0, tamana: 0, hq: 0 });
  const map = new Map(keys.map((k) => [k, { month: k, byStore: empty(), total: 0 }]));
  for (const o of db.orders) {
    if (!o.salesDate) continue;
    const row = map.get(toMonthKey(o.salesDate));
    if (!row) continue;
    row.byStore[o.storeId] += o.total;
    row.total += o.total;
  }
  return keys.map((k) => map.get(k)!);
}

export interface StoreKpi {
  storeId: StoreId;
  salesThisMonth: number;
  salesLastMonth: number;
  salesYtd: number;
  orderCount: number;
  openInquiries: number;
  pendingApprovals: number;
  receivables: number;
  overdue: number;
  activeJobs: number;
  quoteWinRate: number;
}

export function storeKpis(db: Database, now = new Date()): StoreKpi[] {
  const thisMonth = toMonthKey(now);
  const lastMonth = toMonthKey(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  const year = String(now.getFullYear());
  const today = toDateKey(now);
  return db.stores.map((s) => {
    const orders = db.orders.filter((o) => o.storeId === s.id);
    const invoices = db.invoices.filter((i) => i.storeId === s.id);
    const quotes = db.quotes.filter((q) => q.storeId === s.id && ["accepted", "rejected", "expired"].includes(q.status));
    const won = quotes.filter((q) => q.status === "accepted").length;
    return {
      storeId: s.id,
      salesThisMonth: orders.filter((o) => o.salesDate && toMonthKey(o.salesDate) === thisMonth).reduce((a, o) => a + o.total, 0),
      salesLastMonth: orders.filter((o) => o.salesDate && toMonthKey(o.salesDate) === lastMonth).reduce((a, o) => a + o.total, 0),
      salesYtd: orders.filter((o) => o.salesDate && o.salesDate.startsWith(year)).reduce((a, o) => a + o.total, 0),
      orderCount: orders.filter((o) => o.contractDate && toMonthKey(o.contractDate) === thisMonth && o.status !== "cancelled").length,
      openInquiries: db.inquiries.filter((i) => i.storeId === s.id && (i.status === "new" || i.status === "in_progress")).length,
      pendingApprovals: db.approvals.filter((a) => a.storeId === s.id && a.status === "pending").length,
      receivables: invoices.filter((i) => ["issued", "partially_paid", "overdue"].includes(i.status)).reduce((a, i) => a + (i.total - i.paidAmount), 0),
      overdue: invoices.filter((i) => i.status === "overdue" || (i.status === "issued" && i.dueDate < today)).reduce((a, i) => a + (i.total - i.paidAmount), 0),
      activeJobs: orders.filter((o) => ["confirmed", "scheduled", "in_progress"].includes(o.status)).length,
      quoteWinRate: quotes.length ? won / quotes.length : 0,
    };
  });
}

export function categorySales(db: Database, months = 3, now = new Date()) {
  const from = toDateKey(new Date(now.getFullYear(), now.getMonth() - (months - 1), 1));
  const map = new Map<string, number>();
  for (const o of db.orders) {
    if (!o.salesDate || o.salesDate < from) continue;
    map.set(o.category, (map.get(o.category) ?? 0) + o.total);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

export function channelCounts(db: Database, days = 90, now = new Date()) {
  const from = addDays(toDateKey(now), -days);
  const map = new Map<string, number>();
  for (const i of db.inquiries) {
    if (i.receivedAt.slice(0, 10) < from) continue;
    map.set(i.channel, (map.get(i.channel) ?? 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

export function staffPerformance(db: Database, months = 3, now = new Date()) {
  const from = toDateKey(new Date(now.getFullYear(), now.getMonth() - (months - 1), 1));
  return db.users
    .filter((u) => u.role !== "admin")
    .map((u) => {
      const quotes = db.quotes.filter((q) => q.createdBy === u.id && q.createdAt.slice(0, 10) >= from);
      const orders = db.orders.filter((o) => o.createdBy === u.id && o.contractDate >= from && o.status !== "cancelled");
      const jobs = db.orders.filter((o) => o.workerIds.includes(u.id) && o.completedAt && o.completedAt >= from);
      return {
        user: u,
        quotes: quotes.length,
        orders: orders.length,
        orderAmount: orders.reduce((a, o) => a + o.total, 0),
        jobsCompleted: jobs.length,
      };
    })
    .filter((r) => r.quotes + r.orders + r.jobsCompleted > 0)
    .sort((a, b) => b.orderAmount - a.orderAmount);
}

/* ---------------- customer 360 ---------------- */

export function customerTimeline(db: Database, customerId: string) {
  const inquiries = db.inquiries.filter((i) => i.customerId === customerId);
  const quotes = db.quotes.filter((q) => q.customerId === customerId);
  const orders = db.orders.filter((o) => o.customerId === customerId);
  const invoices = db.invoices.filter((i) => i.customerId === customerId);
  const comms = db.commLogs.filter((c) => c.customerId === customerId).sort((a, b) => b.at.localeCompare(a.at));
  // 予定: お客様を直接指定したもの + お客様の案件 (問い合わせ・見積・受注) に紐づくもの
  const inqIds = new Set(inquiries.map((i) => i.id));
  const quoteIds = new Set(quotes.map((q) => q.id));
  const orderIds = new Set(orders.map((o) => o.id));
  const events = db.schedule.filter(
    (e) => e.customerId === customerId || (e.inquiryId && inqIds.has(e.inquiryId)) || (e.quoteId && quoteIds.has(e.quoteId)) || (e.orderId && orderIds.has(e.orderId)),
  );
  const lifetime = orders.filter((o) => o.salesDate).reduce((a, o) => a + o.total, 0);
  return { inquiries, quotes, orders, invoices, comms, events, lifetime };
}

export function quoteChain(db: Database, quote: Quote) {
  const inquiry = db.inquiries.find((i) => i.id === quote.inquiryId);
  const order = db.orders.find((o) => o.quoteId === quote.id);
  const invoice = order ? db.invoices.find((i) => i.orderId === order.id) : undefined;
  const payments = invoice ? db.payments.filter((p) => p.invoiceId === invoice.id) : [];
  const approvals = db.approvals.filter((a) => a.targetId === quote.id || (order && a.targetId === order.id));
  return { inquiry, order, invoice, payments, approvals };
}

export function orderChain(db: Database, order: Order) {
  const quote = db.quotes.find((q) => q.id === order.quoteId);
  const inquiry = quote ? db.inquiries.find((i) => i.id === quote.inquiryId) : undefined;
  const invoice = db.invoices.find((i) => i.orderId === order.id);
  const payments = invoice ? db.payments.filter((p) => p.invoiceId === invoice.id) : [];
  const events = caseEvents(db, { orderId: order.id, quoteId: quote?.id, inquiryId: inquiry?.id }).sort(compareEvents);
  const approvals = db.approvals.filter((a) => a.targetId === order.id || (quote && a.targetId === quote.id));
  return { quote, inquiry, invoice, payments, events, approvals };
}
