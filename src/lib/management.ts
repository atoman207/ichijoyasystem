import type { Channel, Database, Order, Quote, ServiceCategory, StoreId, User } from "@/lib/db/types";
import { canSeeAllStoreFigures } from "@/lib/auth/permissions";
import { addDays, fmtMonth, toDateKey, toMonthKey } from "@/lib/format";
import { CATEGORY_LABEL, CHANNEL_LABEL, ROLE_LABEL } from "@/lib/constants";
import { NAME_KEY_PREFIX, orderStaffIndex } from "@/lib/order-staff";
import { orderDate, storeKpi } from "@/lib/kpi";
import { adjustmentDate, adjustmentLines } from "@/lib/mgmt/attribution";
import { taxRate } from "@/lib/sales-ledger";
import { SCORE_QUESTIONS, type ScoreKey } from "@/lib/survey";

/**
 * 経営ダッシュボード (レポート) の集計
 * ------------------------------------------------------------
 * 期間 (から〜まで)・店舗・担当者で絞り込み、売上・受注・問い合わせ・施工・請求・入金・経費・仕入を集計する。
 * - 売上: 受注の売上計上日 (施工完了) が期間内のもの (キャンセルを除く)。税込
 * - 受注: 契約日が期間内のもの (キャンセルを除く)
 * - 請求: 請求日が期間内のもの (下書き・無効を除く) / 入金: 入金日が期間内のもの
 * - 経費: 日付が期間内で、承認済・精算済のもの (承認待ちは別に数える)
 * - 仕入: 請求日が期間内のもの (支払却下を除く)
 * - 畳原価: 売上に数えた受注の畳原価 (販売管理ソフトの売上台帳から移行した値)
 * - 簡易粗利 = 売上 − 畳原価 − 仕入 − 経費 (税込のまま。会計上の利益ではない。AI アシスタントの simple_gross と同じ)
 * - 店舗間の売上の配分 (お客様のご要望 2026-11-23「■3」: 内部受注の配分を経営ダッシュボードにも): 売上は施工店舗に付け、
 *   内部受注・本部の特殊配分・手入力の調整 (管理会計の sales_adjustments) を「配分」として依頼元 +・施工店舗 − で別に示す
 *   (配分後の売上・配分後の簡易粗利。全店では 0。計上日と金額は管理会計の元帳と同じ。担当者で絞ったときは数えない)
 * - 未入金残高・期日超過は「今日時点」の値 (期間に関係しない)
 * - 前年同期: 期間を 1 年前にずらす。期間の終わりが今日より後なら今日までにそろえる (今年の途中と昨年の同じ日までを比べる)
 * - 移行データ (販売管理ソフトから移行した受注。source = import): 状態はすべて「入金済」、契約日 = 売上計上日で、見積・請求書・入金の記録はない。
 *   そのため受注の進み具合と「問い合わせ → 見積 → 受注」はシステムで登録した受注だけで数え、移行データは別に示す
 * - 担当者: src/lib/order-staff.ts (AI アシスタントと同じ)。担当 = 見積の担当者 / 移行データは担当者欄の 1 番目。
 *   施工完了は施工担当。アカウントのない人 (退職者など) も名前で 1 行にする
 * 店舗のロールは自店舗だけ。担当者で絞ると、その人が担当・施工担当の受注と、その人の問い合わせ・見積・経費・仕入だけを数える
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
const slash = (d: string) => d.replaceAll("-", "/");

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
  const label = preset === "custom" ? `${slash(from)} 〜 ${slash(to)}` : `${PERIOD_LABEL[preset]} (${slash(from)} 〜 ${slash(to)})`;
  return { preset, from, to, label };
}

/** 日付 (YYYY-MM-DD) を n 年ずらす。2/29 はない年なら 2/28 */
export function shiftYears(d: string, n: number): string {
  const y = Number(d.slice(0, 4)) + n;
  const md = d.slice(5, 10);
  if (md === "02-29" && !(y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0))) return `${y}-02-28`;
  return `${String(y).padStart(4, "0")}-${md}`;
}

/** 前年同期 (期間を 1 年前にずらす。期間が今日をまたぐときは、終わりを今日にそろえてからずらす) */
export function previousYearRange(from: string, to: string, today: string): { from: string; to: string } {
  const end = from <= today && to > today ? today : to;
  return { from: shiftYears(from, -1), to: shiftYears(end, -1) };
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

/** 販売管理ソフトから移行した受注 (状態はすべて入金済・契約日 = 売上計上日・見積と請求書なし) */
export const isImportedOrder = (o: Pick<Order, "source">): boolean => o.source === "import";

export interface MgmtFilter {
  from: string;
  to: string;
  storeId?: StoreId;
  /** 担当者のキー (社員 ID、またはアカウントのない人は "name:<名前>"。order-staff.ts) */
  staffId?: string;
}

export interface MgmtTotals {
  sales: number;
  salesCount: number;
  /** うち移行データの売上 */
  importedSales: number;
  importedSalesCount: number;
  orderCount: number;
  orderAmount: number;
  /** 受注のうちシステムで登録したもの (問い合わせ → 見積 → 受注 の受注) */
  funnelOrders: number;
  /** 受注のうち移行データ */
  importedOrderCount: number;
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
  /** 期間内の経費の記録の件数 (却下・差戻しを除く) */
  expenseCount: number;
  purchases: number;
  purchaseCount: number;
  /** 売上に数えた受注の畳原価 */
  tatamiCost: number;
  /** 簡易粗利 = 売上 − 畳原価 − 仕入 − 経費 */
  gross: number;
  /**
   * 内部受注・本部の特殊配分・手入力の売上調整による店舗間の売上の配分 (税込。管理会計の sales_adjustments と同じ行。
   * 依頼元の店舗 +・施工店舗 −、全店では 0。担当者で絞ったときは数えない)
   */
  allocation: number;
  /** 配分後の売上 = 売上 (施工店舗) + 配分 */
  salesAllocated: number;
  /** 配分後の簡易粗利 = 配分後の売上 − 畳原価 − 仕入 − 経費 */
  grossAllocated: number;
}

export interface MgmtMonth {
  month: string;
  sales: number;
  byStore: Record<string, number>;
  /** 前年同月の売上 */
  prevSales: number;
  orderAmount: number;
  received: number;
  tatamiCost: number;
  expenses: number;
  purchases: number;
  /** 店舗間の売上の配分 (内部受注など。全店では 0) と店舗ごとの配分 */
  allocation: number;
  allocByStore: Record<string, number>;
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
  /** 前年同期の売上と伸び (前年同期の売上がなければ null) */
  prevSales: number;
  salesGrowth: number | null;
}

export interface StaffRow {
  /** 担当者のキー (社員 ID または "name:<名前>") */
  key: string;
  /** アカウントのある社員の ID */
  userId?: string;
  name: string;
  role: string;
  hasAccount: boolean;
  active: boolean;
  storeId?: StoreId;
  storeName: string;
  inquiries: number;
  quotes: number;
  orderCount: number;
  orderAmount: number;
  sales: number;
  jobsCompleted: number;
  expenses: number;
}

export interface StaffOption {
  key: string;
  name: string;
  storeId: StoreId;
  active: boolean;
  hasAccount: boolean;
}

export interface SurveyRow {
  storeId: StoreId | "all";
  storeName: string;
  /** アンケートはがきの枚数 */
  n: number;
  /** 返信率 (個人のお客様の施工完了に対する割合。0〜1) */
  replyRate: number | null;
  scores: Record<ScoreKey, number | null>;
  /** 次回も依頼したい (はい ÷ はい・いいえ の回答。0〜1) */
  againRate: number | null;
}

export interface MgmtReport {
  filter: MgmtFilter;
  stores: { id: StoreId; name: string; color: string }[];
  totals: MgmtTotals;
  /** 前年同期 (totals) と、比べる今期 (base: 期間の終わりを今日にそろえた今期。期間が今日をまたがなければ totals と同じ) */
  previous: { from: string; to: string; label: string; totals: MgmtTotals; base: MgmtTotals };
  months: MgmtMonth[];
  /** システムで登録した受注の進み具合 (契約日が期間内) */
  pipeline: PipelineRow[];
  /** 契約日が期間内の移行データ (キャンセルを除く) */
  migrated: { count: number; amount: number };
  invoiceStatus: { key: string; label: string; count: number; amount: number; balance: number }[];
  storeRows: StoreRow[];
  staffRows: StaffRow[];
  categories: { key: ServiceCategory | string; label: string; amount: number; count: number }[];
  channels: { key: Channel | string; label: string; count: number }[];
  expenseAccounts: { account: string; amount: number; count: number }[];
  /** お客様アンケート (KPI の画面と同じ集計。店舗ごと + 複数店舗のときは合計) */
  surveys: SurveyRow[];
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
  return {
    sales: 0,
    salesCount: 0,
    importedSales: 0,
    importedSalesCount: 0,
    orderCount: 0,
    orderAmount: 0,
    funnelOrders: 0,
    importedOrderCount: 0,
    inquiries: 0,
    quotes: 0,
    jobsCompleted: 0,
    invoiced: 0,
    invoiceCount: 0,
    received: 0,
    receivables: 0,
    overdue: 0,
    overdueCount: 0,
    expenses: 0,
    expensesPending: 0,
    expenseCount: 0,
    purchases: 0,
    purchaseCount: 0,
    tatamiCost: 0,
    gross: 0,
    allocation: 0,
    salesAllocated: 0,
    grossAllocated: 0,
  };
}

type Range = { from: string; to: string };
const inRange = (d: string | undefined, f: Range) => Boolean(d) && d!.slice(0, 10) >= f.from && d!.slice(0, 10) <= f.to;

/** 見積の担当 (営業担当)。order-staff.ts と同じ */
const quoteStaff = (q: Pick<Quote, "estimatorId" | "createdBy">): string | undefined => q.estimatorId ?? q.createdBy;

/** 閲覧できる店舗 (店舗のロールは自店舗だけ。閲覧の範囲 = 経営の数字は全社員 のときは全店舗 = policyReader の写しで判定) */
export function visibleStores(db: Database, user: User): StoreId[] {
  return canSeeAllStoreFigures(user) ? db.stores.map((s) => s.id) : [user.storeId];
}

/**
 * 担当者の絞り込み候補: 閲覧できる店舗の社員 (退職者を含む。記録が残っているため) と、
 * 移行データの担当者欄にだけ名前があるアカウントのない人 (受注がいちばん多い店舗に並べる)
 */
export function staffOptions(db: Database, user: User): StaffOption[] {
  const stores = new Set(visibleStores(db, user));
  const order = new Map(db.stores.map((s, i) => [s.id, i]));
  const byStore = (a: StaffOption, b: StaffOption) => (order.get(a.storeId) ?? 99) - (order.get(b.storeId) ?? 99);
  const kana = new Map(db.users.map((u) => [u.id, u.kana]));
  const users: StaffOption[] = db.users
    .filter((u) => stores.has(u.storeId) && u.id !== "system")
    .map((u) => ({ key: u.id, name: u.name, storeId: u.storeId, active: u.active, hasAccount: true }))
    .sort((a, b) => byStore(a, b) || (kana.get(a.key) ?? "").localeCompare(kana.get(b.key) ?? "", "ja"));
  const idx = orderStaffIndex(db);
  const unlinked: StaffOption[] = [];
  for (const [key, counts] of idx.unlinked) {
    const top = [...counts].filter(([s]) => stores.has(s)).sort((a, b) => b[1] - a[1])[0];
    if (top) unlinked.push({ key, name: idx.label(key), storeId: top[0], active: false, hasAccount: false });
  }
  unlinked.sort((a, b) => byStore(a, b) || a.name.localeCompare(b.name, "ja"));
  return [...users, ...unlinked];
}

export function managementReport(db: Database, user: User, filter: MgmtFilter, now = new Date()): MgmtReport {
  const today = toDateKey(now);
  const allowed = visibleStores(db, user);
  const storeIds = filter.storeId && allowed.includes(filter.storeId) ? [filter.storeId] : allowed;
  const inStores = new Set<StoreId>(storeIds);
  const staff = filter.staffId;
  const stores = db.stores.filter((s) => inStores.has(s.id)).map((s) => ({ id: s.id, name: s.name, color: s.color }));
  const range: Range = { from: filter.from, to: filter.to };
  const prevRange = previousYearRange(filter.from, filter.to, today);
  /** 前年同期と比べる今期 (終わりを今日にそろえる) */
  const cmpRange: Range = { from: filter.from, to: filter.from <= today && filter.to > today ? today : filter.to };

  // ---- 範囲内の記録 (店舗・担当者で絞る) ----
  const idx = orderStaffIndex(db);
  const NONE = { sales: [] as string[], workers: [] as string[] };
  const staffOf = (o: Order) => idx.byOrder.get(o.id) ?? NONE;
  const scoped = db.orders.filter((o) => inStores.has(o.storeId) && (!staff || staffOf(o).sales.includes(staff) || staffOf(o).workers.includes(staff)));
  const orderIds = new Set(scoped.map((o) => o.id));
  // 集計に使うのは前年同期の始まり〜期間の終わりの受注だけ (全期間の約 4 万件を何度も見ない)
  const win: Range = { from: prevRange.from, to: range.to };
  const orders = scoped.filter((o) => inRange(o.salesDate, win) || inRange(o.contractDate, win) || inRange(o.completedAt, win));
  const quotes = db.quotes.filter((q) => inStores.has(q.storeId) && (!staff || quoteStaff(q) === staff));
  const inquiries = db.inquiries.filter((i) => inStores.has(i.storeId) && (!staff || i.assignedUserId === staff || i.createdBy === staff));
  const invoices = db.invoices.filter((i) => inStores.has(i.storeId) && (!staff || orderIds.has(i.orderId) || (i.orderIds ?? []).some((id) => orderIds.has(id))) && i.status !== "draft" && i.status !== "void");
  const invoiceById = new Map(invoices.map((i) => [i.id, i]));
  const payments = db.payments.filter((p) => invoiceById.has(p.invoiceId));
  const expenses = db.expenses.filter((e) => inStores.has(e.storeId) && (!staff || e.submittedBy === staff));
  const purchases = db.purchases.filter((p) => inStores.has(p.storeId) && p.status !== "rejected" && (!staff || p.registeredBy === staff));

  // ---- 店舗間の売上の配分 (内部受注・本部の特殊配分・手入力の調整。管理会計の元帳 src/lib/mgmt/ledger.ts と同じ行・同じ計上日) ----
  // 計上日 = 調整の日付、なければ受注の売上計上日 (施工完了前は未計上)。取消しの行は負の金額で打ち消す。
  // 本部の特殊配分で「原価のみ計上」の行は売上を動かさない。税抜で計算した行は計上日の税率で税込にそろえる (この画面の売上は税込)。
  // 担当者で絞ったときは数えない (店舗の単位の配分のため)
  const adjs = staff ? [] : (db.salesAdjustments ?? []).filter((a) => !(a.kind === "hq_special" && a.treatment === "cost_only"));
  const orderIndex = adjs.length ? new Map(db.orders.map((o) => [o.id, o])) : undefined;
  const allocations = adjs.flatMap((a) => {
    const date = adjustmentDate(db, a, orderIndex);
    if (!date) return [];
    const amount = a.base === "tax_excluded" ? Math.round(a.amount * (1 + taxRate(date))) : a.amount;
    return [{ date, lines: adjustmentLines({ fromStoreId: a.fromStoreId, toStoreId: a.toStoreId, amount }) }];
  });

  // ---- 合計 ----
  const totalsFor = (sid: StoreId | undefined, f: Range): MgmtTotals => {
    const t = emptyTotals();
    const own = <T extends { storeId: StoreId }>(rows: T[]) => (sid ? rows.filter((r) => r.storeId === sid) : rows);
    for (const o of own(orders)) {
      if (o.status === "cancelled") continue;
      const imported = isImportedOrder(o);
      if (inRange(o.salesDate, f)) {
        t.sales += o.total;
        t.salesCount++;
        t.tatamiCost += o.tatamiCost ?? 0;
        if (imported) {
          t.importedSales += o.total;
          t.importedSalesCount++;
        }
      }
      if (inRange(o.contractDate, f)) {
        t.orderCount++;
        t.orderAmount += o.total;
        if (imported) t.importedOrderCount++;
        else t.funnelOrders++;
      }
      if (inRange(o.completedAt, f)) t.jobsCompleted++;
    }
    t.inquiries = own(inquiries).filter((i) => inRange(i.receivedAt, f)).length;
    t.quotes = own(quotes).filter((q) => inRange(q.createdAt, f)).length;
    for (const i of own(invoices)) {
      if (inRange(i.issueDate, f)) {
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
      if ((!sid || inv.storeId === sid) && inRange(p.date, f)) t.received += p.amount;
    }
    for (const e of own(expenses)) {
      if (!inRange(e.date, f)) continue;
      if (COUNTED_EXPENSE.includes(e.status)) {
        t.expenses += e.amount;
        t.expenseCount++;
      } else if (e.status === "pending_approval") {
        t.expensesPending += e.amount;
        t.expenseCount++;
      }
    }
    for (const p of own(purchases)) {
      if (!inRange(p.invoiceDate, f)) continue;
      t.purchases += p.amount;
      t.purchaseCount++;
    }
    t.gross = t.sales - t.tatamiCost - t.purchases - t.expenses;
    for (const a of allocations) {
      if (!inRange(a.date, f)) continue;
      for (const line of a.lines) if (inStores.has(line.storeId) && (!sid || line.storeId === sid)) t.allocation += line.amount;
    }
    t.salesAllocated = t.sales + t.allocation;
    t.grossAllocated = t.gross + t.allocation;
    return t;
  };
  const totals = totalsFor(undefined, range);
  const sameCmp = cmpRange.to === range.to;
  const previous = { ...prevRange, label: `${slash(prevRange.from)} 〜 ${slash(prevRange.to)}`, totals: totalsFor(undefined, prevRange), base: sameCmp ? totals : totalsFor(undefined, cmpRange) };

  // ---- 月次 ----
  const monthKeys = monthsBetween(filter.from, filter.to);
  const monthMap = new Map<string, MgmtMonth>(monthKeys.map((k) => [k, { month: k, sales: 0, byStore: Object.fromEntries(storeIds.map((s) => [s, 0])), prevSales: 0, orderAmount: 0, received: 0, tatamiCost: 0, expenses: 0, purchases: 0, allocation: 0, allocByStore: Object.fromEntries(storeIds.map((s) => [s, 0])) }]));
  const bump = (d: string | undefined, fn: (row: MgmtMonth) => void) => {
    if (!inRange(d, range)) return;
    const row = monthMap.get(d!.slice(0, 7));
    if (row) fn(row);
  };
  const prevMonthsRange: Range = { from: shiftYears(filter.from, -1), to: shiftYears(filter.to, -1) };
  for (const o of orders) {
    if (o.status === "cancelled") continue;
    bump(o.salesDate, (r) => {
      r.sales += o.total;
      r.byStore[o.storeId] = (r.byStore[o.storeId] ?? 0) + o.total;
      r.tatamiCost += o.tatamiCost ?? 0;
    });
    bump(o.contractDate, (r) => (r.orderAmount += o.total));
    if (inRange(o.salesDate, prevMonthsRange)) {
      const row = monthMap.get(shiftYears(o.salesDate!.slice(0, 10), 1).slice(0, 7));
      if (row) row.prevSales += o.total;
    }
  }
  for (const p of payments) bump(p.date, (r) => (r.received += p.amount));
  for (const e of expenses) if (COUNTED_EXPENSE.includes(e.status)) bump(e.date, (r) => (r.expenses += e.amount));
  for (const p of purchases) bump(p.invoiceDate, (r) => (r.purchases += p.amount));
  for (const a of allocations) {
    bump(a.date, (r) => {
      for (const line of a.lines) {
        if (!inStores.has(line.storeId)) continue;
        r.allocation += line.amount;
        r.allocByStore[line.storeId] = (r.allocByStore[line.storeId] ?? 0) + line.amount;
      }
    });
  }

  // ---- 受注の進み具合 (契約日が期間内。システムで登録した受注だけ。移行データは別に数える) ----
  const periodOrders = orders.filter((o) => inRange(o.contractDate, range));
  const systemOrders = periodOrders.filter((o) => !isImportedOrder(o));
  const pipeline = PIPELINE.map((p) => {
    const rows = systemOrders.filter((o) => p.statuses.includes(o.status));
    return { ...p, count: rows.length, amount: rows.reduce((a, o) => a + o.total, 0) };
  });
  const migratedRows = periodOrders.filter((o) => isImportedOrder(o) && o.status !== "cancelled");
  const migrated = { count: migratedRows.length, amount: migratedRows.reduce((a, o) => a + o.total, 0) };

  // ---- 請求の状況 (請求日が期間内) ----
  const periodInvoices = invoices.filter((i) => inRange(i.issueDate, range));
  const invoiceStatus = ["issued", "partially_paid", "overdue", "paid"].map((k) => {
    const rows = periodInvoices.filter((i) => (k === "overdue" ? i.status === "overdue" || (OPEN_INVOICE.includes(i.status) && i.dueDate < today) : k === "issued" || k === "partially_paid" ? i.status === k && i.dueDate >= today : i.status === k));
    return { key: k, label: INVOICE_LABEL[k], count: rows.length, amount: rows.reduce((a, i) => a + i.total, 0), balance: rows.reduce((a, i) => a + (i.total - i.paidAmount), 0) };
  });

  // ---- 店舗別 ----
  const storeRows: StoreRow[] = stores.map((s) => {
    const t = totalsFor(s.id, range);
    const prevSales = totalsFor(s.id, prevRange).sales;
    const curSales = sameCmp ? t.sales : totalsFor(s.id, cmpRange).sales;
    const decided = quotes.filter((q) => q.storeId === s.id && inRange(q.createdAt, range) && ["accepted", "rejected", "expired"].includes(q.status));
    const won = decided.filter((q) => q.status === "accepted").length;
    return { ...t, storeId: s.id, storeName: s.name, winRate: decided.length ? won / decided.length : null, avgOrder: t.orderCount ? Math.round(t.orderAmount / t.orderCount) : 0, prevSales, salesGrowth: prevSales > 0 ? (curSales - prevSales) / prevSales : null };
  });

  // ---- 担当者別 (担当 = 見積の担当者 / 移行データは担当者欄の 1 番目。施工完了は施工担当) ----
  type Acc = Omit<StaffRow, "key" | "userId" | "name" | "role" | "hasAccount" | "active" | "storeId" | "storeName"> & { stores: Map<StoreId, number> };
  const acc = new Map<string, Acc>();
  const get = (key: string): Acc => {
    let a = acc.get(key);
    if (!a) {
      a = { inquiries: 0, quotes: 0, orderCount: 0, orderAmount: 0, sales: 0, jobsCompleted: 0, expenses: 0, stores: new Map() };
      acc.set(key, a);
    }
    return a;
  };
  const seenAt = (a: Acc, s: StoreId) => a.stores.set(s, (a.stores.get(s) ?? 0) + 1);
  for (const o of orders) {
    if (o.status === "cancelled") continue;
    const st = staffOf(o);
    const contracted = inRange(o.contractDate, range);
    const sold = inRange(o.salesDate, range);
    for (const k of st.sales) {
      if (!contracted && !sold) continue;
      const a = get(k);
      if (contracted) {
        a.orderCount++;
        a.orderAmount += o.total;
      }
      if (sold) a.sales += o.total;
      seenAt(a, o.storeId);
    }
    if (inRange(o.completedAt, range))
      for (const k of st.workers) {
        const a = get(k);
        a.jobsCompleted++;
        seenAt(a, o.storeId);
      }
  }
  for (const i of inquiries) if (i.assignedUserId && inRange(i.receivedAt, range)) get(i.assignedUserId).inquiries++;
  for (const q of quotes) {
    const k = quoteStaff(q);
    if (k && inRange(q.createdAt, range)) get(k).quotes++;
  }
  for (const e of expenses) if (inRange(e.date, range) && COUNTED_EXPENSE.includes(e.status)) get(e.submittedBy).expenses += e.amount;
  const storeName = new Map(db.stores.map((s) => [s.id, s.name]));
  const staffRows: StaffRow[] = [...acc]
    .filter(([key, a]) => key !== "system" && (!staff || key === staff) && a.inquiries + a.quotes + a.orderCount + a.jobsCompleted + a.expenses + a.sales > 0)
    .map(([key, a]) => {
      const u = idx.userOf(key);
      const { stores: seen, ...metrics } = a;
      const sid = u?.storeId ?? [...seen].sort((x, y) => y[1] - x[1])[0]?.[0];
      return {
        key,
        userId: u?.id,
        name: idx.label(key),
        role: u ? ROLE_LABEL[u.role] : key.startsWith(NAME_KEY_PREFIX) ? "アカウントなし" : "退職・不明",
        hasAccount: Boolean(u),
        active: Boolean(u?.active),
        storeId: sid,
        storeName: sid ? (storeName.get(sid) ?? sid) : "-",
        ...metrics,
      };
    })
    .sort((a, b) => b.sales - a.sales || b.orderAmount - a.orderAmount || b.jobsCompleted - a.jobsCompleted || a.name.localeCompare(b.name, "ja"));

  // ---- 種別・入口・勘定科目 ----
  const cat = new Map<string, { amount: number; count: number }>();
  for (const o of orders) {
    if (o.status === "cancelled" || !inRange(o.salesDate, range)) continue;
    const c = cat.get(o.category) ?? { amount: 0, count: 0 };
    c.amount += o.total;
    c.count++;
    cat.set(o.category, c);
  }
  const categories = [...cat.entries()].map(([key, v]) => ({ key, label: CATEGORY_LABEL[key as ServiceCategory] ?? key, ...v })).sort((a, b) => b.amount - a.amount);
  const ch = new Map<string, number>();
  for (const i of inquiries) if (inRange(i.receivedAt, range)) ch.set(i.channel, (ch.get(i.channel) ?? 0) + 1);
  const channels = [...ch.entries()].map(([key, count]) => ({ key, label: CHANNEL_LABEL[key as Channel] ?? key, count })).sort((a, b) => b.count - a.count);
  const accounts = new Map<string, { amount: number; count: number }>();
  for (const e of expenses) {
    if (!inRange(e.date, range) || !COUNTED_EXPENSE.includes(e.status)) continue;
    const a = accounts.get(e.account) ?? { amount: 0, count: 0 };
    a.amount += e.amount;
    a.count++;
    accounts.set(e.account, a);
  }
  const expenseAccounts = [...accounts.entries()].map(([account, v]) => ({ account, ...v })).sort((a, b) => b.amount - a.amount);

  // ---- お客様アンケート (KPI と同じ storeKpi。担当者の絞り込みは使わない) ----
  const kpiDb = { ...db, orders: db.orders.filter((o) => inRange(orderDate(o), range)) };
  const surveyRow = (sid: StoreId | undefined, name: string): SurveyRow => {
    const k = storeKpi(kpiDb, range, sid);
    return {
      storeId: sid ?? "all",
      storeName: name,
      n: k.surveys,
      replyRate: k.replyRate === null ? null : k.replyRate / 100,
      scores: k.scores,
      againRate: k.againAnswered ? k.againYes / k.againAnswered : null,
    };
  };
  const surveys = stores.map((s) => surveyRow(s.id, s.name)).filter((x) => x.n > 0);
  if (surveys.length > 1 && stores.length === db.stores.length) surveys.push(surveyRow(undefined, "全店舗"));

  return {
    filter: { ...filter, storeId: storeIds.length === 1 && filter.storeId ? filter.storeId : undefined },
    stores,
    totals,
    previous,
    months: monthKeys.map((k) => monthMap.get(k)!),
    pipeline,
    migrated,
    invoiceStatus,
    storeRows,
    staffRows,
    categories,
    channels,
    expenseAccounts,
    surveys,
  };
}

/** 前年同期との伸び (前年同期が 0 なら null) */
export function growth(cur: number, prev: number): number | null {
  return prev > 0 ? (cur - prev) / prev : null;
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
  surveys: "お客様アンケート",
} as const;

export type MgmtCsvSection = keyof typeof MGMT_CSV_SECTIONS;

const TOTAL_COLUMNS: [keyof MgmtTotals, string][] = [
  ["sales", "売上 (税込)"],
  ["allocation", "内部受注などの配分"],
  ["salesAllocated", "配分後の売上"],
  ["salesCount", "売上件数"],
  ["importedSales", "うち移行データの売上"],
  ["orderCount", "受注件数"],
  ["orderAmount", "受注金額"],
  ["funnelOrders", "受注件数 (システムで登録)"],
  ["inquiries", "問い合わせ"],
  ["quotes", "見積"],
  ["jobsCompleted", "施工完了"],
  ["invoiced", "請求額"],
  ["received", "入金額"],
  ["receivables", "未入金残高 (今日時点)"],
  ["overdue", "うち期日超過"],
  ["tatamiCost", "畳原価"],
  ["purchases", "仕入"],
  ["expenses", "経費 (承認済・精算済)"],
  ["expensesPending", "経費 (承認待ち)"],
  ["gross", "簡易粗利 (売上−畳原価−仕入−経費)"],
  ["grossAllocated", "配分後の簡易粗利"],
];

/** 今日時点の値 (前年同期と比べない) */
const POINT_IN_TIME = new Set<keyof MgmtTotals>(["receivables", "overdue"]);

const percent1 = (v: number | null) => (v === null ? "" : Math.round(v * 1000) / 10);
const score2 = (v: number | null) => (v === null ? "" : Math.round(v * 100) / 100);

export function mgmtCsvRows(r: MgmtReport, section: MgmtCsvSection, periodLabel: string): (string | number)[][] {
  switch (section) {
    case "summary":
      return [["項目", "値", "前年同期"], ["期間", periodLabel, r.previous.label], ...TOTAL_COLUMNS.map(([k, label]) => [label, r.totals[k], POINT_IN_TIME.has(k) ? "" : r.previous.totals[k]])];
    case "monthly":
      return [
        ["月", "売上", ...r.stores.map((s) => `売上 ${s.name}`), ...r.stores.map((s) => `配分後の売上 ${s.name}`), "前年同月の売上", "受注金額", "入金額", "畳原価", "仕入", "経費", "簡易粗利"],
        ...r.months.map((m) => [fmtMonth(m.month), m.sales, ...r.stores.map((s) => m.byStore[s.id] ?? 0), ...r.stores.map((s) => (m.byStore[s.id] ?? 0) + (m.allocByStore[s.id] ?? 0)), m.prevSales, m.orderAmount, m.received, m.tatamiCost, m.purchases, m.expenses, m.sales - m.tatamiCost - m.purchases - m.expenses]),
      ];
    case "stores":
      return [["店舗", ...TOTAL_COLUMNS.map(([, l]) => l), "成約率 (%)", "平均受注単価", "前年同期の売上", "前年同期比 (%)"], ...r.storeRows.map((s) => [s.storeName, ...TOTAL_COLUMNS.map(([k]) => s[k]), percent1(s.winRate), s.avgOrder, s.prevSales, percent1(s.salesGrowth)])];
    case "staff":
      return [["担当者", "役割", "所属", "アカウント", "問い合わせ (担当)", "見積", "受注件数", "受注金額", "売上 (担当)", "施工完了", "経費"], ...r.staffRows.map((s) => [s.name, s.role, s.storeName, s.hasAccount ? (s.active ? "あり" : "あり (無効)") : "なし", s.inquiries, s.quotes, s.orderCount, s.orderAmount, s.sales, s.jobsCompleted, s.expenses])];
    case "pipeline":
      return [["状態", "件数", "金額"], ...r.pipeline.map((p) => [p.label, p.count, p.amount]), ["移行データ (販売管理ソフトの売上・入金済として移行)", r.migrated.count, r.migrated.amount]];
    case "invoices":
      return [["状態", "件数", "請求額", "未入金残高"], ...r.invoiceStatus.map((i) => [i.label, i.count, i.amount, i.balance])];
    case "categories":
      return [["種別", "件数", "売上"], ...r.categories.map((c) => [c.label, c.count, c.amount])];
    case "channels":
      return [["入口", "件数"], ...r.channels.map((c) => [c.label, c.count])];
    case "expenses":
      return [["勘定科目", "件数", "金額"], ...r.expenseAccounts.map((e) => [e.account, e.count, e.amount])];
    case "surveys":
      return [["店舗", "回答数", "返信率 (%)", ...SCORE_QUESTIONS.map((q) => `${q.no} ${q.label}`), "次回も依頼したい (%)"], ...r.surveys.map((s) => [s.storeName, s.n, percent1(s.replyRate), ...SCORE_QUESTIONS.map((q) => score2(s.scores[q.key])), percent1(s.againRate)])];
  }
}
