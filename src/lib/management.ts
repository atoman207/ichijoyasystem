import type { Channel, Database, Order, ServiceCategory, StoreId, User } from "@/lib/db/types";
import { canSeeAllStores } from "@/lib/auth/permissions";
import { addDays, fmtMonth, toDateKey, toMonthKey } from "@/lib/format";
import { CATEGORY_LABEL, CHANNEL_LABEL, ROLE_LABEL } from "@/lib/constants";

/**
 * 経営ダッシュボード (レポート) の集計
 * ------------------------------------------------------------
 * 期間 (から〜まで)・店舗・担当者で絞り込み、売上・受注・問い合わせ・施工・請求・入金・経費・仕入を集計する。
 * - 売上: 受注の売上計上日 (施工完了) が期間内のもの。税込
 * - 受注: 契約日が期間内のもの (キャンセルを除く)
 * - 請求: 請求日が期間内のもの (下書き・無効を除く) / 入金: 入金日が期間内のもの
 * - 経費: 日付が期間内で、承認済・精算済のもの (承認待ちは別に数える)
 * - 仕入: 請求日が期間内のもの (支払却下を除く)
 * - 未入金残高・期日超過は「今日時点」の値 (期間に関係しない)
 * - 簡易粗利 = 売上 − 仕入 − 経費 (税込のまま。会計上の利益ではない)
 * 店舗のロールは自店舗だけ。担当者で絞ると、その人が作成・担当した記録だけを数える
 */

export type PeriodPreset = "this_month" | "last_month" | "last_3m" | "last_6m" | "last_12m" | "this_year" | "last_year" | "custom";

export const PERIOD_LABEL: Record<PeriodPreset, string> = {
  this_month: "今月",
  last_month: "先月",
  last_3m: "直近3か月",
  last_6m: "直近6か月",
  last_12m: "直近12か月",
  this_year: "今年 (1月〜)",
  last_year: "昨年 (1〜12月)",
  custom: "期間を指定",
};

export interface Period {
  preset: PeriodPreset;
  from: string;
  to: string;
  label: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (v?: string) => (v && DATE_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00`)) ? v : undefined);

/** 画面・CSV の検索条件から期間を決める (既定: 直近12か月)。指定期間は最長 5 年 */
export function resolvePeriod(sp: { period?: string; from?: string; to?: string; months?: string }, now = new Date()): Period {
  const y = now.getFullYear();
  const m = now.getMonth();
  const monthStart = (yy: number, mm: number) => toDateKey(new Date(yy, mm, 1));
  const monthEnd = (yy: number, mm: number) => toDateKey(new Date(yy, mm + 1, 0));
  const today = toDateKey(now);
  // 旧画面の ?months=3|6|12 も受け付ける
  const legacy = sp.months === "3" ? "last_3m" : sp.months === "6" ? "last_6m" : sp.months === "12" ? "last_12m" : undefined;
  let preset = ((sp.period && sp.period in PERIOD_LABEL ? sp.period : undefined) ?? legacy ?? (sp.from || sp.to ? "custom" : "last_12m")) as PeriodPreset;
  let from: string;
  let to: string;
  switch (preset) {
    case "this_month":
      from = monthStart(y, m);
      to = monthEnd(y, m);
      break;
    case "last_month":
      from = monthStart(y, m - 1);
      to = monthEnd(y, m - 1);
      break;
    case "last_3m":
    case "last_6m":
    case "last_12m": {
      const n = preset === "last_3m" ? 3 : preset === "last_6m" ? 6 : 12;
      from = monthStart(y, m - (n - 1));
      to = monthEnd(y, m);
      break;
    }
    case "this_year":
      from = `${y}-01-01`;
      to = `${y}-12-31`;
      break;
    case "last_year":
      from = `${y - 1}-01-01`;
      to = `${y - 1}-12-31`;
      break;
    default: {
      const f = validDate(sp.from);
      const t = validDate(sp.to);
      if (!f && !t) {
        preset = "last_12m";
        from = monthStart(y, m - 11);
        to = monthEnd(y, m);
      } else {
        from = f ?? monthStart(Number((t ?? today).slice(0, 4)), Number((t ?? today).slice(5, 7)) - 1);
        to = t ?? today;
        if (from > to) [from, to] = [to, from];
        const min = addDays(to, -366 * 5);
        if (from < min) from = min;
      }
    }
  }
  const label = preset === "custom" ? `${from.replaceAll("-", "/")} 〜 ${to.replaceAll("-", "/")}` : `${PERIOD_LABEL[preset]} (${from.replaceAll("-", "/")} 〜 ${to.replaceAll("-", "/")})`;
  return { preset, from, to, label };
}

/** 期間に含まれる月 (YYYY-MM)。最長 60 か月 */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let mo = Number(from.slice(5, 7)) - 1;
  const end = to.slice(0, 7);
  for (let i = 0; i < 60; i++) {
    const key = toMonthKey(new Date(y, mo, 1));
    out.push(key);
    if (key >= end) break;
    mo++;
    if (mo > 11) {
      mo = 0;
      y++;
    }
  }
  return out;
}

export interface MgmtFilter {
  from: string;
  to: string;
  storeId?: StoreId;
  staffId?: string;
}

export interface MgmtTotals {
  sales: number;
  salesCount: number;
  orderCount: number;
  orderAmount: number;
  inquiries: number;
  quotes: number;
  jobsCompleted: number;
  invoiced: number;
  invoiceCount: number;
  received: number;
  receivables: number;
  overdue: number;
  overdueCount: number;
  expenses: number;
  expensesPending: number;
  purchases: number;
  gross: number;
}

export interface MgmtMonth {
  month: string;
  sales: number;
  byStore: Record<string, number>;
  orderAmount: number;
  received: number;
  expenses: number;
  purchases: number;
}

export interface PipelineRow {
  key: string;
  label: string;
  count: number;
  amount: number;
  /** 一覧で開くときの受注の状態 */
  statuses: Order["status"][];
}

export interface StoreRow extends MgmtTotals {
  storeId: StoreId;
  storeName: string;
  winRate: number | null;
  avgOrder: number;
}

export interface StaffRow {
  userId: string;
  name: string;
  role: string;
  storeId: StoreId;
  storeName: string;
  inquiries: number;
  quotes: number;
  orderCount: number;
  orderAmount: number;
  sales: number;
  jobsCompleted: number;
  expenses: number;
}

export interface MgmtReport {
  filter: MgmtFilter;
  stores: { id: StoreId; name: string; color: string }[];
  totals: MgmtTotals;
  months: MgmtMonth[];
  pipeline: PipelineRow[];
  invoiceStatus: { key: string; label: string; count: number; amount: number; balance: number }[];
  storeRows: StoreRow[];
  staffRows: StaffRow[];
  categories: { key: ServiceCategory | string; label: string; amount: number; count: number }[];
  channels: { key: Channel | string; label: string; count: number }[];
  expenseAccounts: { account: string; amount: number; count: number }[];
}

const OPEN_INVOICE = ["issued", "partially_paid", "overdue"];
const COUNTED_EXPENSE = ["approved", "paid"];

/** 受注の進み具合 (契約日が期間内の受注を、今の状態で分ける) */
const PIPELINE: { key: string; label: string; statuses: Order["status"][] }[] = [
  { key: "approval", label: "契約の承認待ち・差戻し", statuses: ["pending_approval", "returned"] },
  { key: "confirmed", label: "受注 (施工日の調整前)", statuses: ["confirmed"] },
  { key: "scheduled", label: "施工予定", statuses: ["scheduled"] },
  { key: "in_progress", label: "施工中", statuses: ["in_progress"] },
  { key: "completed", label: "施工完了 (未請求)", statuses: ["completed"] },
  { key: "invoiced", label: "請求済 (入金待ち)", statuses: ["invoiced"] },
  { key: "paid", label: "入金済", statuses: ["paid"] },
  { key: "cancelled", label: "キャンセル", statuses: ["cancelled"] },
];

const INVOICE_LABEL: Record<string, string> = { issued: "発行済 (入金待ち)", partially_paid: "一部入金", overdue: "期日超過", paid: "入金済" };

function emptyTotals(): MgmtTotals {
  return { sales: 0, salesCount: 0, orderCount: 0, orderAmount: 0, inquiries: 0, quotes: 0, jobsCompleted: 0, invoiced: 0, invoiceCount: 0, received: 0, receivables: 0, overdue: 0, overdueCount: 0, expenses: 0, expensesPending: 0, purchases: 0, gross: 0 };
}

const inRange = (d: string | undefined, f: MgmtFilter) => Boolean(d) && d!.slice(0, 10) >= f.from && d!.slice(0, 10) <= f.to;

/** 閲覧できる店舗 (店舗のロールは自店舗だけ) */
export function visibleStores(db: Database, user: User): StoreId[] {
  return canSeeAllStores(user) ? db.stores.map((s) => s.id) : [user.storeId];
}

/** 担当者の絞り込み候補: 閲覧できる店舗の社員 (退職者を含む。記録が残っているため) */
export function staffOptions(db: Database, user: User): User[] {
  const stores = new Set(visibleStores(db, user));
  return db.users.filter((u) => stores.has(u.storeId) && u.id !== "system").sort((a, b) => a.storeId.localeCompare(b.storeId) || a.kana.localeCompare(b.kana, "ja"));
}

export function managementReport(db: Database, user: User, filter: MgmtFilter, now = new Date()): MgmtReport {
  const today = toDateKey(now);
  const allowed = visibleStores(db, user);
  const storeIds = filter.storeId && allowed.includes(filter.storeId) ? [filter.storeId] : allowed;
  const inStores = new Set<StoreId>(storeIds);
  const staff = filter.staffId;
  const stores = db.stores.filter((s) => inStores.has(s.id)).map((s) => ({ id: s.id, name: s.name, color: s.color }));

  // ---- 範囲内の記録 (店舗・担当者で絞る) ----
  const orders = db.orders.filter((o) => inStores.has(o.storeId) && (!staff || o.createdBy === staff || o.workerIds.includes(staff)));
  const orderIds = new Set(orders.map((o) => o.id));
  const quotes = db.quotes.filter((q) => inStores.has(q.storeId) && (!staff || q.createdBy === staff));
  const inquiries = db.inquiries.filter((i) => inStores.has(i.storeId) && (!staff || i.assignedUserId === staff || i.createdBy === staff));
  const invoices = db.invoices.filter((i) => inStores.has(i.storeId) && (!staff || orderIds.has(i.orderId)) && i.status !== "draft" && i.status !== "void");
  const invoiceById = new Map(invoices.map((i) => [i.id, i]));
  const payments = db.payments.filter((p) => invoiceById.has(p.invoiceId));
  const expenses = db.expenses.filter((e) => inStores.has(e.storeId) && (!staff || e.submittedBy === staff));
  const purchases = db.purchases.filter((p) => inStores.has(p.storeId) && p.status !== "rejected" && (!staff || p.registeredBy === staff));

  // ---- 合計 ----
  const totalsFor = (sid?: StoreId): MgmtTotals => {
    const t = emptyTotals();
    const own = <T extends { storeId: StoreId }>(rows: T[]) => (sid ? rows.filter((r) => r.storeId === sid) : rows);
    for (const o of own(orders)) {
      if (inRange(o.salesDate, filter)) {
        t.sales += o.total;
        t.salesCount++;
      }
      if (inRange(o.contractDate, filter) && o.status !== "cancelled") {
        t.orderCount++;
        t.orderAmount += o.total;
      }
      if (inRange(o.completedAt, filter)) t.jobsCompleted++;
    }
    t.inquiries = own(inquiries).filter((i) => inRange(i.receivedAt, filter)).length;
    t.quotes = own(quotes).filter((q) => inRange(q.createdAt, filter)).length;
    for (const i of own(invoices)) {
      if (inRange(i.issueDate, filter)) {
        t.invoiced += i.total;
        t.invoiceCount++;
      }
      if (OPEN_INVOICE.includes(i.status)) {
        const bal = i.total - i.paidAmount;
        t.receivables += bal;
        if (i.status === "overdue" || i.dueDate < today) {
          t.overdue += bal;
          t.overdueCount++;
        }
      }
    }
    for (const p of payments) {
      const inv = invoiceById.get(p.invoiceId)!;
      if ((!sid || inv.storeId === sid) && inRange(p.date, filter)) t.received += p.amount;
    }
    for (const e of own(expenses)) {
      if (!inRange(e.date, filter)) continue;
      if (COUNTED_EXPENSE.includes(e.status)) t.expenses += e.amount;
      else if (e.status === "pending_approval") t.expensesPending += e.amount;
    }
    t.purchases = own(purchases).filter((p) => inRange(p.invoiceDate, filter)).reduce((a, p) => a + p.amount, 0);
    t.gross = t.sales - t.purchases - t.expenses;
    return t;
  };
  const totals = totalsFor();

  // ---- 月次 ----
  const monthKeys = monthsBetween(filter.from, filter.to);
  const monthMap = new Map<string, MgmtMonth>(monthKeys.map((k) => [k, { month: k, sales: 0, byStore: Object.fromEntries(storeIds.map((s) => [s, 0])), orderAmount: 0, received: 0, expenses: 0, purchases: 0 }]));
  const bump = (d: string | undefined, fn: (row: MgmtMonth) => void) => {
    if (!inRange(d, filter)) return;
    const row = monthMap.get(d!.slice(0, 7));
    if (row) fn(row);
  };
  for (const o of orders) {
    bump(o.salesDate, (r) => {
      r.sales += o.total;
      r.byStore[o.storeId] = (r.byStore[o.storeId] ?? 0) + o.total;
    });
    if (o.status !== "cancelled") bump(o.contractDate, (r) => (r.orderAmount += o.total));
  }
  for (const p of payments) bump(p.date, (r) => (r.received += p.amount));
  for (const e of expenses) if (COUNTED_EXPENSE.includes(e.status)) bump(e.date, (r) => (r.expenses += e.amount));
  for (const p of purchases) bump(p.invoiceDate, (r) => (r.purchases += p.amount));

  // ---- 受注の進み具合 (契約日が期間内) ----
  const periodOrders = orders.filter((o) => inRange(o.contractDate, filter));
  const pipeline = PIPELINE.map((p) => {
    const rows = periodOrders.filter((o) => p.statuses.includes(o.status));
    return { ...p, count: rows.length, amount: rows.reduce((a, o) => a + o.total, 0) };
  });

  // ---- 請求の状況 (請求日が期間内) ----
  const periodInvoices = invoices.filter((i) => inRange(i.issueDate, filter));
  const invoiceStatus = ["issued", "partially_paid", "overdue", "paid"].map((k) => {
    const rows = periodInvoices.filter((i) => (k === "overdue" ? i.status === "overdue" || (OPEN_INVOICE.includes(i.status) && i.dueDate < today) : k === "issued" || k === "partially_paid" ? i.status === k && i.dueDate >= today : i.status === k));
    return { key: k, label: INVOICE_LABEL[k], count: rows.length, amount: rows.reduce((a, i) => a + i.total, 0), balance: rows.reduce((a, i) => a + (i.total - i.paidAmount), 0) };
  });

  // ---- 店舗別 ----
  const storeRows: StoreRow[] = stores.map((s) => {
    const t = totalsFor(s.id);
    const decided = quotes.filter((q) => q.storeId === s.id && inRange(q.createdAt, filter) && ["accepted", "rejected", "expired"].includes(q.status));
    const won = decided.filter((q) => q.status === "accepted").length;
    return { ...t, storeId: s.id, storeName: s.name, winRate: decided.length ? won / decided.length : null, avgOrder: t.orderCount ? Math.round(t.orderAmount / t.orderCount) : 0 };
  });

  // ---- 担当者別 ----
  const people = staffOptions(db, user).filter((u) => (!staff || u.id === staff) && (!filter.storeId || u.storeId === filter.storeId || orders.some((o) => o.storeId === filter.storeId && (o.createdBy === u.id || o.workerIds.includes(u.id)))));
  const storeName = new Map(db.stores.map((s) => [s.id, s.name]));
  const staffRows: StaffRow[] = people
    .map((u) => {
      const created = orders.filter((o) => o.createdBy === u.id);
      return {
        userId: u.id,
        name: u.name,
        role: ROLE_LABEL[u.role],
        storeId: u.storeId,
        storeName: storeName.get(u.storeId) ?? u.storeId,
        inquiries: inquiries.filter((i) => i.assignedUserId === u.id && inRange(i.receivedAt, filter)).length,
        quotes: quotes.filter((q) => q.createdBy === u.id && inRange(q.createdAt, filter)).length,
        orderCount: created.filter((o) => inRange(o.contractDate, filter) && o.status !== "cancelled").length,
        orderAmount: created.filter((o) => inRange(o.contractDate, filter) && o.status !== "cancelled").reduce((a, o) => a + o.total, 0),
        sales: created.filter((o) => inRange(o.salesDate, filter)).reduce((a, o) => a + o.total, 0),
        jobsCompleted: orders.filter((o) => o.workerIds.includes(u.id) && inRange(o.completedAt, filter)).length,
        expenses: expenses.filter((e) => e.submittedBy === u.id && inRange(e.date, filter) && COUNTED_EXPENSE.includes(e.status)).reduce((a, e) => a + e.amount, 0),
      };
    })
    .filter((r) => r.inquiries + r.quotes + r.orderCount + r.jobsCompleted + r.expenses + r.sales > 0)
    .sort((a, b) => b.orderAmount - a.orderAmount || b.sales - a.sales);

  // ---- 種別・入口・勘定科目 ----
  const cat = new Map<string, { amount: number; count: number }>();
  for (const o of orders) {
    if (!inRange(o.salesDate, filter)) continue;
    const c = cat.get(o.category) ?? { amount: 0, count: 0 };
    c.amount += o.total;
    c.count++;
    cat.set(o.category, c);
  }
  const categories = [...cat.entries()].map(([key, v]) => ({ key, label: CATEGORY_LABEL[key as ServiceCategory] ?? key, ...v })).sort((a, b) => b.amount - a.amount);
  const ch = new Map<string, number>();
  for (const i of inquiries) if (inRange(i.receivedAt, filter)) ch.set(i.channel, (ch.get(i.channel) ?? 0) + 1);
  const channels = [...ch.entries()].map(([key, count]) => ({ key, label: CHANNEL_LABEL[key as Channel] ?? key, count })).sort((a, b) => b.count - a.count);
  const acc = new Map<string, { amount: number; count: number }>();
  for (const e of expenses) {
    if (!inRange(e.date, filter) || !COUNTED_EXPENSE.includes(e.status)) continue;
    const a = acc.get(e.account) ?? { amount: 0, count: 0 };
    a.amount += e.amount;
    a.count++;
    acc.set(e.account, a);
  }
  const expenseAccounts = [...acc.entries()].map(([account, v]) => ({ account, ...v })).sort((a, b) => b.amount - a.amount);

  return { filter: { ...filter, storeId: storeIds.length === 1 && filter.storeId ? filter.storeId : undefined }, stores, totals, months: monthKeys.map((k) => monthMap.get(k)!), pipeline, invoiceStatus, storeRows, staffRows, categories, channels, expenseAccounts };
}

/* ================================================================== */
/* CSV                                                                  */
/* ================================================================== */

export const MGMT_CSV_SECTIONS = {
  summary: "集計の概要",
  monthly: "月次推移",
  stores: "店舗別",
  staff: "担当者別",
  pipeline: "受注の進み具合",
  invoices: "請求の状況",
  categories: "種別別の売上",
  channels: "問い合わせの入口別",
  expenses: "経費の勘定科目別",
} as const;

export type MgmtCsvSection = keyof typeof MGMT_CSV_SECTIONS;

const TOTAL_COLUMNS: [keyof MgmtTotals, string][] = [
  ["sales", "売上 (税込)"],
  ["salesCount", "売上件数"],
  ["orderCount", "受注件数"],
  ["orderAmount", "受注金額"],
  ["inquiries", "問い合わせ"],
  ["quotes", "見積"],
  ["jobsCompleted", "施工完了"],
  ["invoiced", "請求額"],
  ["received", "入金額"],
  ["receivables", "未入金残高 (今日時点)"],
  ["overdue", "うち期日超過"],
  ["expenses", "経費 (承認済・精算済)"],
  ["expensesPending", "経費 (承認待ち)"],
  ["purchases", "仕入"],
  ["gross", "簡易粗利 (売上−仕入−経費)"],
];

export function mgmtCsvRows(r: MgmtReport, section: MgmtCsvSection, periodLabel: string): (string | number)[][] {
  switch (section) {
    case "summary":
      return [["項目", "値"], ["期間", periodLabel], ...TOTAL_COLUMNS.map(([k, label]) => [label, r.totals[k]])];
    case "monthly":
      return [["月", "売上", ...r.stores.map((s) => `売上 ${s.name}`), "受注金額", "入金額", "経費", "仕入", "簡易粗利"], ...r.months.map((m) => [fmtMonth(m.month), m.sales, ...r.stores.map((s) => m.byStore[s.id] ?? 0), m.orderAmount, m.received, m.expenses, m.purchases, m.sales - m.purchases - m.expenses])];
    case "stores":
      return [["店舗", ...TOTAL_COLUMNS.map(([, l]) => l), "成約率 (%)", "平均受注単価"], ...r.storeRows.map((s) => [s.storeName, ...TOTAL_COLUMNS.map(([k]) => s[k]), s.winRate === null ? "" : Math.round(s.winRate * 1000) / 10, s.avgOrder])];
    case "staff":
      return [["担当者", "役割", "所属", "問い合わせ (担当)", "見積", "受注件数", "受注金額", "売上 (受注担当)", "施工完了", "経費"], ...r.staffRows.map((s) => [s.name, s.role, s.storeName, s.inquiries, s.quotes, s.orderCount, s.orderAmount, s.sales, s.jobsCompleted, s.expenses])];
    case "pipeline":
      return [["状態", "件数", "金額"], ...r.pipeline.map((p) => [p.label, p.count, p.amount])];
    case "invoices":
      return [["状態", "件数", "請求額", "未入金残高"], ...r.invoiceStatus.map((i) => [i.label, i.count, i.amount, i.balance])];
    case "categories":
      return [["種別", "件数", "売上"], ...r.categories.map((c) => [c.label, c.count, c.amount])];
    case "channels":
      return [["入口", "件数"], ...r.channels.map((c) => [c.label, c.count])];
    case "expenses":
      return [["勘定科目", "件数", "金額"], ...r.expenseAccounts.map((e) => [e.account, e.count, e.amount])];
  }
}
