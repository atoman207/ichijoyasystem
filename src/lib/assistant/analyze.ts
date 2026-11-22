import "server-only";
import type { Database, StoreId, User } from "@/lib/db/types";
import { canReadStoreRecords, canSeeAllCustomerRecords, canSeeAllStoreFigures, canViewExpense, canViewPurchase } from "@/lib/auth/permissions";
import { CATEGORY_LABEL, CHANNEL_LABEL, INQUIRY_STATUS, QUOTE_STATUS, SCHEDULE_KIND } from "@/lib/constants";
import { addDays, toDateKey } from "@/lib/format";
import { AMOUNT_KEYS, AMOUNT_LABEL, salesFacts, type AmountKey, type ItemFact, type OrderFact } from "./facts";
import { apportion } from "@/lib/mgmt/decimal";

/**
 * 自由な条件の集計 (AI アシスタントの「分析」)
 * ------------------------------------------------------------
 * 期間・対象 (売上・問い合わせ・見積・経費・仕入・入金・予定)・集計の軸 (年・月・店舗・種別・商品・顧客・担当・地区…)・
 * 絞り込み・前年同期 / 前の期間との比較を組み合わせて表を作る。AI はこの関数を道具として呼び、数字は必ずここで計算する
 * (AI に計算させない)。閲覧範囲は経営ダッシュボードと同じ (店舗のロールは自店舗だけ)。
 */

export type Subject = "sales" | "inquiries" | "quotes" | "expenses" | "purchases" | "payments" | "schedule";

export interface AnalysisSpec {
  subject?: Subject;
  metrics?: string[];
  group_by?: string[];
  from?: string;
  to?: string;
  /** 売上の日付: sales = 売上計上日 (施工完了) / contract = 契約日 (受注金額) */
  date_basis?: "sales" | "contract";
  stores?: string[];
  categories?: string[];
  products?: string[];
  customers?: string[];
  staff?: string[];
  areas?: string[];
  compare?: "previous_period" | "previous_year" | "none";
  only?: "decreased" | "increased";
  sort_by?: string;
  order?: "asc" | "desc";
  limit?: number;
  pivot?: boolean;
  title?: string;
  /** VPS のデータベースへの SQL で集計したとき (query_database) */
  sql?: string;
  /** 状態で絞る (コード。例: 問い合わせ new・in_progress / 経費 pending_approval)。省略時は既定 (売上はキャンセル以外、経費は承認済・精算済、仕入は却下以外) */
  statuses?: string[];
}

export type ColumnKind = "text" | "yen" | "count" | "number" | "percent";
export interface AnalysisColumn {
  key: string;
  label: string;
  kind: ColumnKind;
}
export type Cell = string | number | null;
export interface AnalysisChart {
  /** time = 時系列 (折れ線・積み上げ棒) / bars = 項目の比較 */
  kind: "time" | "bars";
  x: string;
  /** 店舗の系列は店舗の色 (固定) */
  series: { key: string; label: string; color?: string }[];
  /** 横軸が店舗のとき、店舗ごとの色 (店舗名 → 色) */
  pointColors?: Record<string, string>;
  unit: "yen" | "count" | "plain";
}
export interface AnalysisResult {
  ok: true;
  title: string;
  period: { from: string; to: string; label: string };
  compareLabel?: string;
  spec: AnalysisSpec;
  columns: AnalysisColumn[];
  rows: Record<string, Cell>[];
  total: Record<string, Cell>;
  /** 表示しきれなかった行の数 */
  omitted: number;
  notes: string[];
  chart?: AnalysisChart;
}
export interface AnalysisError {
  ok: false;
  error: string;
  /** 代わりに使える画面と操作 */
  hint?: string;
}

/* ================================================================== */
/* 軸・指標の定義                                                        */
/* ================================================================== */

const TIME_DIMS = ["year", "half", "quarter", "month", "week", "day", "weekday"] as const;
const DIM_LABEL: Record<string, string> = {
  year: "年",
  half: "半期",
  quarter: "四半期",
  month: "月",
  week: "週",
  day: "日",
  weekday: "曜日",
  store: "店舗",
  category: "種別",
  product: "商品・品目",
  customer: "顧客",
  customer_type: "顧客区分",
  staff: "担当者",
  worker: "施工担当",
  area: "地区",
  channel: "受付経路",
  status: "状態",
  account: "勘定科目",
  supplier: "仕入先",
  vendor: "支払先",
  method: "支払方法",
  kind: "予定の種類",
};

interface MetricDef {
  label: string;
  kind: ColumnKind;
  calc: (a: Acc) => number | null;
}

interface Acc {
  s: Record<string, number>;
  orders: Set<string>;
  customers: Set<string>;
  n: number;
}
const newAcc = (): Acc => ({ s: {}, orders: new Set(), customers: new Set(), n: 0 });
const sum = (a: Acc, k: string) => a.s[k] ?? 0;
const ratio = (x: number, y: number) => (y ? x / y : null);

const SALES_METRICS: Record<string, MetricDef> = {
  sales: { label: "売上 (税込)", kind: "yen", calc: (a) => sum(a, "sales") },
  order_count: { label: "件数", kind: "count", calc: (a) => a.orders.size },
  avg_order: { label: "1件あたりの売上", kind: "yen", calc: (a) => (a.orders.size ? Math.round(sum(a, "sales") / a.orders.size) : null) },
  quantity: { label: "数量", kind: "number", calc: (a) => sum(a, "qty") },
  avg_unit_price: { label: "平均単価 (税込)", kind: "yen", calc: (a) => (sum(a, "qty") ? Math.round(sum(a, "sales") / sum(a, "qty")) : null) },
  cost: { label: "記録された原価", kind: "yen", calc: (a) => sum(a, "cost") },
  gross: { label: "粗利 (売上−記録された原価)", kind: "yen", calc: (a) => sum(a, "sales") - sum(a, "cost") },
  gross_margin: { label: "粗利率", kind: "percent", calc: (a) => ratio(sum(a, "sales") - sum(a, "cost"), sum(a, "sales")) },
  tatami_gross: { label: "畳の粗利 (原価の記録がある案件)", kind: "yen", calc: (a) => sum(a, "tSales") - sum(a, "tCost") },
  tatami_margin: { label: "畳の粗利率", kind: "percent", calc: (a) => ratio(sum(a, "tSales") - sum(a, "tCost"), sum(a, "tSales")) },
  customer_count: { label: "顧客数", kind: "count", calc: (a) => a.customers.size },
  simple_gross: { label: "簡易粗利 (売上−畳原価−仕入−経費)", kind: "yen", calc: (a) => sum(a, "sales") - sum(a, "tCost") - sum(a, "purchases") - sum(a, "expenses") },
};

const COUNT_AMOUNT: Record<string, MetricDef> = {
  count: { label: "件数", kind: "count", calc: (a) => a.n },
  amount: { label: "金額 (税込)", kind: "yen", calc: (a) => sum(a, "amount") },
};

const METRICS: Record<Subject, Record<string, MetricDef>> = {
  sales: SALES_METRICS,
  inquiries: {
    count: COUNT_AMOUNT.count,
    won_count: { label: "受注になった問い合わせの件数", kind: "count", calc: (a) => sum(a, "won") },
    conversion: { label: "受注率", kind: "percent", calc: (a) => ratio(sum(a, "won"), a.n) },
  },
  quotes: {
    count: COUNT_AMOUNT.count,
    amount: { label: "見積金額 (税込)", kind: "yen", calc: (a) => sum(a, "amount") },
    won_count: { label: "受注になった見積の件数 (見積から受注)", kind: "count", calc: (a) => sum(a, "won") },
    win_rate: { label: "成約率", kind: "percent", calc: (a) => ratio(sum(a, "won"), sum(a, "decided")) },
    avg_amount: { label: "平均見積額", kind: "yen", calc: (a) => (a.n ? Math.round(sum(a, "amount") / a.n) : null) },
  },
  expenses: { amount: COUNT_AMOUNT.amount, count: COUNT_AMOUNT.count },
  purchases: { amount: COUNT_AMOUNT.amount, count: COUNT_AMOUNT.count },
  payments: { amount: { label: "入金額", kind: "yen", calc: (a) => sum(a, "amount") }, count: COUNT_AMOUNT.count },
  schedule: { count: { label: "予定の件数", kind: "count", calc: (a) => a.n }, days: { label: "延べ日数", kind: "number", calc: (a) => sum(a, "days") } },
};

const DIMS: Record<Subject, string[]> = {
  sales: [...TIME_DIMS, "store", "category", "product", "customer", "customer_type", "staff", "worker", "area", "channel"],
  inquiries: [...TIME_DIMS, "store", "channel", "category", "status", "staff", "area", "customer"],
  quotes: [...TIME_DIMS, "store", "category", "status", "staff", "customer"],
  expenses: [...TIME_DIMS, "store", "account", "staff", "vendor", "method"],
  purchases: [...TIME_DIMS, "store", "supplier", "account"],
  payments: [...TIME_DIMS, "store", "method", "customer"],
  schedule: [...TIME_DIMS, "store", "kind", "staff", "area"],
};

const DEFAULT_METRICS: Record<Subject, string[]> = {
  sales: ["sales", "order_count"],
  inquiries: ["count"],
  quotes: ["count", "amount", "win_rate"],
  expenses: ["amount", "count"],
  purchases: ["amount", "count"],
  payments: ["amount", "count"],
  schedule: ["count"],
};

const SUBJECT_LABEL: Record<Subject, string> = { sales: "売上", inquiries: "問い合わせ", quotes: "見積", expenses: "経費", purchases: "仕入", payments: "入金", schedule: "予定" };

/** AI の道具の説明に使う (指標と軸の一覧) */
export function analysisCatalog(): string {
  return (Object.keys(METRICS) as Subject[])
    .map((s) => `- ${s} (${SUBJECT_LABEL[s]}): 指標 ${Object.entries(METRICS[s]).map(([k, m]) => `${k}=${m.label}`).join(", ")} / 軸 ${DIMS[s].map((d) => `${d}=${DIM_LABEL[d]}`).join(", ")}`)
    .join("\n");
}

/* ================================================================== */
/* 値の正規化                                                            */
/* ================================================================== */

const norm = (v: string) => v.normalize("NFKC").toLowerCase().replace(/[\s　]+/g, "");
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
const isDate = (v?: string): v is string => Boolean(v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)));

function timeKey(dim: string, date: string): string {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  switch (dim) {
    case "year":
      return `${y}年`;
    case "half":
      return `${y}年${m <= 6 ? "上期 (1-6月)" : "下期 (7-12月)"}`;
    case "quarter":
      return `${y}年Q${Math.ceil(m / 3)}`;
    case "month":
      return `${y}年${String(m).padStart(2, "0")}月`;
    case "week": {
      // 週の始まり (月曜) の日付
      const d = new Date(`${date}T00:00:00Z`);
      const back = (d.getUTCDay() + 6) % 7;
      return `${addDays(date, -back)} の週`;
    }
    case "day":
      return date;
    case "weekday":
      return `${new Date(`${date}T00:00:00Z`).getUTCDay()}:${WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]}曜`;
  }
  return date;
}
const displayKey = (dim: string, key: string) => (dim === "weekday" ? key.replace(/^\d:/, "") : key);

function shiftYear(date: string, years: number): string {
  const y = Number(date.slice(0, 4)) + years;
  const md = date.slice(5);
  // うるう日
  if (md === "02-29") return `${y}-02-28`;
  return `${y}-${md}`;
}
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

/* ================================================================== */
/* 集計の材料 (原子)                                                     */
/* ================================================================== */

interface Atom {
  date: string;
  store: StoreId;
  dims: Record<string, string | string[] | undefined>;
  v: Record<string, number>;
  orderId?: string;
  customerId?: string;
}

interface Ctx {
  db: Database;
  user: User;
  stores: Set<StoreId>;
  userName: (id?: string) => string;
  storeName: (id: StoreId) => string;
  customerLabel: (id?: string) => string;
}

function matchAny(value: string | undefined, keywords: string[]): boolean {
  if (!keywords.length) return true;
  const v = norm(value ?? "");
  return keywords.some((k) => v.includes(norm(k)));
}

/** 集計できる店舗: 経営の数字の閲覧の範囲 (閲覧の範囲の設定で全社員が全店舗。src/lib/access-policy.ts。経費・仕入は記録ごとに本人の権限で絞る) */
function resolveStores(db: Database, user: User, wanted: string[] | undefined): { ids: Set<StoreId>; scoped: boolean; denied: StoreId[] } {
  const all = canSeeAllStoreFigures(user);
  const visible = all ? db.stores.map((s) => s.id) : [user.storeId];
  if (!wanted?.length) return { ids: new Set(visible), scoped: !all, denied: [] };
  const ids = new Set<StoreId>();
  for (const w of wanted) {
    const n = norm(w);
    for (const s of db.stores) if (s.id === w || norm(s.name).includes(n) || norm(s.shortName) === n || n.includes(norm(s.shortName))) ids.add(s.id);
  }
  return { ids: new Set([...ids].filter((id) => visible.includes(id))), scoped: !all, denied: [...ids].filter((id) => !visible.includes(id)) };
}

function categoryKeys(wanted: string[] | undefined): Set<AmountKey> | null {
  if (!wanted?.length) return null;
  const out = new Set<AmountKey>();
  for (const w of wanted) {
    const n = norm(w);
    for (const k of AMOUNT_KEYS) if (k === w || norm(AMOUNT_LABEL[k]).includes(n) || n.includes(norm(AMOUNT_LABEL[k]).slice(0, 2))) out.add(k);
    if (/クロス|壁紙/.test(w)) out.add("cloth");
    if (/カーテン|ブラインド/.test(w)) out.add("curtain");
    if (/値引/.test(w)) out.add("discount");
  }
  return out;
}

function salesAtoms(ctx: Ctx, spec: AnalysisSpec, from: string, to: string, needItems: boolean, splitCategory: boolean, notes: Set<string>): Atom[] {
  const { db } = ctx;
  const { facts } = salesFacts(db);
  const basis = spec.date_basis === "contract" ? "contract" : "sales";
  const cats = categoryKeys(spec.categories);
  const products = spec.products ?? [];
  const customers = spec.customers ?? [];
  const staffKw = spec.staff ?? [];
  const areas = spec.areas ?? [];
  const customerById = new Map(db.customers.map((c) => [c.id, c]));
  const quoteById = new Map(db.quotes.map((q) => [q.id, q]));
  const orderById = new Map(db.orders.map((o) => [o.id, o]));
  const inquiryById = new Map(db.inquiries.map((i) => [i.id, i]));
  const channelOf = (f: OrderFact): string => {
    const o = orderById.get(f.id);
    const media = o?.siteInfo?.media?.[0] ?? o?.siteInfo?.mediaOther;
    if (media) return media;
    const q = o?.quoteId ? quoteById.get(o.quoteId) : undefined;
    const inq = q?.inquiryId ? inquiryById.get(q.inquiryId) : undefined;
    if (inq) return CHANNEL_LABEL[inq.channel];
    const c = customerById.get(f.customerId);
    return c ? CHANNEL_LABEL[c.firstContactChannel] : "未登録";
  };
  const out: Atom[] = [];
  let inRange = 0;
  let withItems = 0;
  let tatamiOrders = 0;
  let tatamiCosted = 0;
  let costUnallocated = 0;
  for (const f of facts) {
    if (!ctx.stores.has(f.storeId)) continue;
    if (spec.statuses?.length && !spec.statuses.includes(f.status)) continue;
    const date = basis === "contract" ? f.contractDate : f.salesDate;
    if (!date || date < from || date > to) continue;
    if (customers.length) {
      const c = customerById.get(f.customerId);
      if (!c || !customers.some((k) => matchAny(`${c.name} ${c.kana} ${c.code}`, [k]))) continue;
    }
    if (staffKw.length && !f.staff.some((s) => matchAny(s, staffKw)) && !f.workerNames.some((w) => matchAny(w, staffKw))) continue;
    if (areas.length && !matchAny(f.area, areas) && !matchAny(orderById.get(f.id)?.siteAddress, areas)) continue;
    inRange++;
    if (f.amounts.tatami > 0) {
      tatamiOrders++;
      if (f.tatamiCost > 0) tatamiCosted++;
    }
    const c = customerById.get(f.customerId);
    const base = {
      store: f.storeId,
      date,
      orderId: f.id,
      customerId: f.customerId,
    };
    const commonDims = (): Atom["dims"] => ({
      customer: ctx.customerLabel(f.customerId),
      customer_type: c?.type === "corporate" ? "法人" : "個人",
      staff: f.staff,
      worker: f.workerNames.length ? f.workerNames : ["(未設定)"],
      area: f.area || "(不明)",
      channel: channelOf(f),
    });
    if (needItems) {
      if (!f.items.length) continue;
      withItems++;
      const alloc = itemCosts(f);
      if (alloc.unallocated) costUnallocated++;
      for (const [idx, it] of f.items.entries()) {
        if (cats && !cats.has(it.cat)) continue;
        if (products.length && !matchAny(it.product, products)) continue;
        const tCost = alloc.tatami[idx];
        out.push({ ...base, dims: { ...commonDims(), category: AMOUNT_LABEL[it.cat], product: it.product }, v: { sales: it.amount, qty: it.qty, cost: tCost + alloc.purchase[idx], tSales: f.tatamiCost > 0 && it.cat === "tatami" ? it.amount : 0, tCost } });
      }
      continue;
    }
    const costTotal = f.tatamiCost + f.purchaseCost;
    const tCostedSales = f.tatamiCost > 0 ? f.amounts.tatami : 0;
    if (splitCategory || cats) {
      // 種別ごとの金額に分ける (原価は畳原価を畳へ、仕入は案件の主な種別へ)
      const main = AMOUNT_KEYS.filter((k) => k !== "discount").sort((a, b) => f.amounts[b] - f.amounts[a])[0];
      for (const k of AMOUNT_KEYS) {
        const amt = f.amounts[k];
        if (!amt) continue;
        if (cats && !cats.has(k)) continue;
        const cost = (k === "tatami" ? f.tatamiCost : 0) + (k === main ? f.purchaseCost : 0);
        out.push({ ...base, dims: { ...commonDims(), category: AMOUNT_LABEL[k] }, v: { sales: amt, cost, tSales: k === "tatami" ? tCostedSales : 0, tCost: k === "tatami" ? f.tatamiCost : 0 } });
      }
    } else {
      out.push({ ...base, dims: commonDims(), v: { sales: f.total, cost: costTotal, tSales: tCostedSales, tCost: f.tatamiCost } });
    }
  }
  if (needItems) notes.add(`商品・数量の集計は明細のある受注 ${withItems.toLocaleString("ja-JP")} 件 (期間内の受注 ${inRange.toLocaleString("ja-JP")} 件のうち) から。明細の金額は税込に換算 (税抜の明細は当時の税率)`);
  if (needItems) notes.add("商品 (明細) ごとの原価は記録がないため、案件の原価 (畳原価は畳の明細へ、案件にひも付いた仕入は案件の主な種別の明細へ) を明細の金額で按分した目安です。値引きの行には配りません");
  if (needItems && costUnallocated) notes.add(`原価を配る明細がなかった受注 ${costUnallocated.toLocaleString("ja-JP")} 件の原価は、商品別の表に入っていません`);
  if (tatamiOrders) notes.add(`畳原価の記録: 期間内の畳の案件 ${tatamiOrders.toLocaleString("ja-JP")} 件のうち ${tatamiCosted.toLocaleString("ja-JP")} 件 (${Math.round((tatamiCosted / tatamiOrders) * 100)}%)`);
  return out;
}

/**
 * 受注の原価を明細に配る (商品別の粗利の目安。合計は案件の原価と必ず一致する)
 * - 畳原価 → 畳の明細へ、明細の金額の比で按分
 * - 案件にひも付いた仕入 → 案件の主な種別 (種別ごとの集計と同じ) の明細へ、金額の比で按分。その種別の明細がなければ全明細へ
 * - 値引き・金額 0 以下の行には配らない
 */
function itemCosts(f: OrderFact): { tatami: number[]; purchase: number[]; unallocated: boolean } {
  const zeros = () => f.items.map(() => 0);
  const tatami = zeros();
  const purchase = zeros();
  let unallocated = false;
  const spread = (total: number, pick: (it: ItemFact) => boolean, into: number[]): boolean => {
    const yen = Math.round(total);
    if (!yen) return true;
    const idx = f.items.map((it, i) => (it.cat !== "discount" && it.amount > 0 && pick(it) ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) return false;
    const parts = apportion(yen, idx.map((i) => Math.max(1, Math.round(f.items[i].amount))));
    idx.forEach((i, k) => (into[i] += parts[k]));
    return true;
  };
  if (!spread(f.tatamiCost, (it) => it.cat === "tatami", tatami) && !spread(f.tatamiCost, () => true, tatami)) unallocated = true;
  const main = AMOUNT_KEYS.filter((k) => k !== "discount").sort((a, b) => f.amounts[b] - f.amounts[a])[0];
  if (!spread(f.purchaseCost, (it) => it.cat === main, purchase) && !spread(f.purchaseCost, () => true, purchase)) unallocated = true;
  return { tatami, purchase, unallocated };
}

function otherAtoms(ctx: Ctx, subject: Subject, spec: AnalysisSpec, from: string, to: string): Atom[] {
  const { db, user } = ctx;
  const out: Atom[] = [];
  const inR = (d?: string) => Boolean(d) && d!.slice(0, 10) >= from && d!.slice(0, 10) <= to;
  const customerOk = (id?: string) => !spec.customers?.length || (id && matchAny(ctx.customerLabel(id), spec.customers));
  const staffOk = (ids: (string | undefined)[]) => !spec.staff?.length || ids.some((id) => id && matchAny(ctx.userName(id), spec.staff!));
  const cats = spec.categories?.length ? spec.categories : null;
  const catOk = (c: string) => !cats || cats.some((k) => k === c || matchAny(CATEGORY_LABEL[c as keyof typeof CATEGORY_LABEL], [k]));
  const area = (customerId?: string) => db.customers.find((c) => c.id === customerId)?.area;
  const statusOk = (st: string, fallback: (st: string) => boolean) => (spec.statuses?.length ? spec.statuses.includes(st) : fallback(st));
  switch (subject) {
    case "inquiries": {
      const won = new Set(db.orders.filter((o) => o.status !== "cancelled").map((o) => o.quoteId).filter(Boolean) as string[]);
      for (const i of db.inquiries) {
        if (!ctx.stores.has(i.storeId) || !inR(i.receivedAt) || !customerOk(i.customerId) || !staffOk([i.assignedUserId, i.createdBy]) || !catOk(i.category) || !statusOk(i.status, () => true)) continue;
        out.push({ date: i.receivedAt.slice(0, 10), store: i.storeId, customerId: i.customerId, dims: { channel: CHANNEL_LABEL[i.channel], category: CATEGORY_LABEL[i.category], status: INQUIRY_STATUS[i.status].label, staff: ctx.userName(i.assignedUserId), area: i.area || area(i.customerId) || "(不明)", customer: i.customerId ? ctx.customerLabel(i.customerId) : i.contactName }, v: { won: i.status === "won" || (i.quoteId && won.has(i.quoteId)) ? 1 : 0 } });
      }
      break;
    }
    case "quotes":
      for (const q of db.quotes) {
        const d = q.issuedAt ?? q.createdAt;
        if (!ctx.stores.has(q.storeId) || !inR(d) || !customerOk(q.customerId) || !staffOk([q.estimatorId, q.createdBy]) || !catOk(q.category) || !statusOk(q.status, () => true)) continue;
        const wonQ = Boolean(q.orderId) || q.status === "accepted";
        const decided = wonQ || q.status === "rejected" || q.status === "expired";
        out.push({ date: d.slice(0, 10), store: q.storeId, customerId: q.customerId, dims: { category: CATEGORY_LABEL[q.category], status: QUOTE_STATUS[q.status].label, staff: ctx.userName(q.estimatorId ?? q.createdBy), customer: ctx.customerLabel(q.customerId) }, v: { amount: q.total, won: wonQ ? 1 : 0, decided: decided ? 1 : 0 } });
      }
      break;
    case "expenses":
      for (const e of db.expenses) {
        if (!ctx.stores.has(e.storeId) || !inR(e.date) || !statusOk(e.status, (st) => ["approved", "paid"].includes(st)) || !canViewExpense(user, e) || !staffOk([e.submittedBy])) continue;
        if (spec.products?.length && !matchAny(`${e.account} ${e.vendor} ${e.description}`, spec.products)) continue;
        out.push({ date: e.date, store: e.storeId, dims: { account: e.account || "(未設定)", staff: ctx.userName(e.submittedBy), vendor: e.vendor || "(不明)", method: { cash: "現金", card: "カード", transfer: "振込" }[e.paymentMethod] ?? e.paymentMethod }, v: { amount: e.amount } });
      }
      break;
    case "purchases":
      for (const p of db.purchases) {
        if (!ctx.stores.has(p.storeId) || !inR(p.invoiceDate) || !statusOk(p.status, (st) => st !== "rejected") || !canViewPurchase(user, p)) continue;
        const sup = db.suppliers.find((s) => s.id === p.supplierId)?.name ?? "(不明)";
        if (spec.customers?.length && !matchAny(sup, spec.customers)) continue;
        if (spec.products?.length && !matchAny(`${p.description} ${(p.items ?? []).map((i) => i.name).join(" ")}`, spec.products)) continue;
        out.push({ date: p.invoiceDate, store: p.storeId, dims: { supplier: sup, account: p.account || "(未設定)" }, v: { amount: p.amount } });
      }
      break;
    case "payments": {
      const inv = new Map(db.invoices.map((i) => [i.id, i]));
      const METHOD: Record<string, string> = { cash: "現金", transfer: "振込", card: "カード", paypay: "PayPay", other: "その他" };
      for (const p of db.payments) {
        const i = inv.get(p.invoiceId);
        if (!i || !ctx.stores.has(i.storeId) || !inR(p.date) || !customerOk(i.customerId)) continue;
        out.push({ date: p.date, store: i.storeId, customerId: i.customerId, dims: { method: METHOD[p.method] ?? p.method, customer: ctx.customerLabel(i.customerId) }, v: { amount: p.amount } });
      }
      break;
    }
    case "schedule":
      for (const e of db.schedule) {
        // 予定表は全社で共有。店舗の絞り込みだけ行う
        const storeOk = spec.stores?.length ? ctx.stores.has(e.storeId) : true;
        if (!storeOk || !inR(e.date) || !staffOk(e.assigneeIds)) continue;
        if (spec.products?.length && !matchAny(`${e.title} ${e.memo ?? ""}`, spec.products)) continue;
        const days = e.endDate && e.endDate > e.date ? daysBetween(e.date, e.endDate) + 1 : 1;
        out.push({ date: e.date, store: e.storeId, customerId: e.customerId, dims: { kind: SCHEDULE_KIND[e.kind]?.label ?? e.kind, staff: e.assigneeIds.length ? e.assigneeIds.map((a) => ctx.userName(a)) : ["(担当なし)"], area: e.location?.replace(/^熊本県/, "").replace(/[0-9０-９\-－].*$/, "").slice(0, 12) || "(不明)" }, v: { days } });
      }
      break;
  }
  return out;
}

/* ================================================================== */
/* 集計                                                                 */
/* ================================================================== */

function dimValues(a: Atom, dim: string, ctx: Ctx): string[] {
  if ((TIME_DIMS as readonly string[]).includes(dim)) return [timeKey(dim, a.date)];
  // 顧客情報を見られない店舗のお客様の名前は出さない (経営の数字だけ全店舗に公開しているとき)
  if (dim === "customer" && !canReadStoreRecords(ctx.user, a.store)) return ["(ほかの店舗のお客様)"];
  if (dim === "store") return [`${String(storeOrder(ctx, a.store)).padStart(2, "0")}:${ctx.storeName(a.store)}`];
  const v = a.dims[dim];
  if (v === undefined) return ["(なし)"];
  return Array.isArray(v) ? (v.length ? v : ["(なし)"]) : [v];
}
function storeOrder(ctx: Ctx, id: StoreId) {
  return ctx.db.stores.findIndex((s) => s.id === id);
}
const showKey = (dim: string, key: string) => (dim === "store" ? key.replace(/^\d+:/, "") : displayKey(dim, key));

function aggregate(atoms: Atom[], dims: string[], ctx: Ctx): { groups: Map<string, { keys: string[]; acc: Acc }>; total: Acc } {
  const groups = new Map<string, { keys: string[]; acc: Acc }>();
  const total = newAcc();
  const add = (acc: Acc, a: Atom) => {
    for (const [k, v] of Object.entries(a.v)) acc.s[k] = (acc.s[k] ?? 0) + v;
    if (a.orderId) acc.orders.add(a.orderId);
    if (a.customerId) acc.customers.add(a.customerId);
    acc.n++;
  };
  for (const a of atoms) {
    add(total, a);
    let combos: string[][] = [[]];
    for (const d of dims) {
      const vals = dimValues(a, d, ctx);
      combos = combos.flatMap((c) => vals.map((v) => [...c, v]));
    }
    for (const keys of combos) {
      const id = keys.join("\u0001");
      let g = groups.get(id);
      if (!g) groups.set(id, (g = { keys, acc: newAcc() }));
      add(g.acc, a);
    }
  }
  return { groups, total };
}

function periodLabel(from: string, to: string) {
  return `${from.replaceAll("-", "/")}〜${to.replaceAll("-", "/")}`;
}

export function runAnalysis(db: Database, user: User, raw: AnalysisSpec, now = new Date()): AnalysisResult | AnalysisError {
  const subject: Subject = raw.subject && raw.subject in METRICS ? raw.subject : "sales";
  const metricDefs = METRICS[subject];
  const today = toDateKey(now);
  let from = isDate(raw.from) ? raw.from : addDays(today, -364);
  let to = isDate(raw.to) ? raw.to : today;
  if (from > to) [from, to] = [to, from];
  // 「sales_diff」のように比較の列名を指標に書かれたときは、元の指標にして並べ替えに使う
  const suffixed = (raw.metrics ?? []).find((m) => /_(diff|prev|ratio)$/.test(m) && m.replace(/_(diff|prev|ratio)$/, "") in metricDefs);
  if (suffixed && !raw.sort_by) raw = { ...raw, sort_by: suffixed };
  const baseMetrics = [...new Set((raw.metrics ?? []).map((m) => (/_(diff|prev|ratio)$/.test(m) && m.replace(/_(diff|prev|ratio)$/, "") in metricDefs ? m.replace(/_(diff|prev|ratio)$/, "") : m)))];
  const unknownMetrics = baseMetrics.filter((m) => !(m in metricDefs));
  const metrics = baseMetrics.filter((m) => m in metricDefs).slice(0, 4);
  if (!metrics.length) metrics.push(...DEFAULT_METRICS[subject]);
  const unknownDims = (raw.group_by ?? []).filter((d) => !DIMS[subject].includes(d));
  const dims = [...new Set((raw.group_by ?? []).filter((d) => DIMS[subject].includes(d)))].slice(0, 3);
  if (unknownMetrics.length || unknownDims.length) {
    return {
      ok: false,
      error: `${SUBJECT_LABEL[subject]}の集計では ${[...unknownMetrics, ...unknownDims].join("・")} は使えません。使える指標: ${Object.keys(metricDefs).join(", ")} / 使える軸: ${DIMS[subject].join(", ")}`,
      hint: subject === "sales" ? "商品ごとの原価・粗利は cost・gross・gross_margin で出せます (案件の原価を明細の金額で按分した目安)。" : undefined,
    };
  }
  const notes = new Set<string>();
  const { ids: figureStores, scoped, denied } = resolveStores(db, user, raw.stores);
  // お客様の名前で絞る集計は、顧客情報を見られる店舗のお客様だけ (経営の数字だけ全店舗に公開しているとき)
  const stores = raw.customers?.length && !canSeeAllCustomerRecords(user) ? new Set([...figureStores].filter((id) => canReadStoreRecords(user, id))) : figureStores;
  // 閲覧できない店舗を指定した: 自店舗だけに黙って絞らず、権限の範囲外と返す (お客様の決定 2026-11-20)
  if (denied.length) return { ok: false, error: `${denied.map((id) => db.stores.find((s) => s.id === id)?.name ?? id).join("・")}のデータは、この人の閲覧の権限の範囲外です (見られるのは ${db.stores.find((s) => s.id === user.storeId)?.name ?? "自店舗"} だけ)。`, hint: "回答では「その情報は閲覧の権限の範囲外のため、お答えできません」と伝える。自店舗の数字をほかの店舗・全社の数字として書かない。" };
  if (!stores.size) return { ok: false, error: "指定の店舗が見つからないか、閲覧できない店舗です。", hint: canSeeAllStoreFigures(user) ? undefined : "店舗のロールは自店舗のデータだけを集計できます。" };
  if (scoped) notes.add(`閲覧範囲: ${db.stores.find((s) => s.id === user.storeId)?.name ?? "自店舗"} のデータだけを集計しています`);

  const userNameMap = new Map(db.users.map((u) => [u.id, u.name]));
  const customerMap = new Map(db.customers.map((c) => [c.id, `${c.name} (${c.code})`]));
  const storeMap = new Map(db.stores.map((s) => [s.id, s.name]));
  const ctx: Ctx = {
    db,
    user,
    stores,
    userName: (id) => (id ? (userNameMap.get(id) ?? "(退職・不明)") : "(未設定)"),
    storeName: (id) => storeMap.get(id) ?? id,
    customerLabel: (id) => (id ? (customerMap.get(id) ?? "(不明)") : "(未登録)"),
  };

  const needItems = subject === "sales" && (dims.includes("product") || Boolean(raw.products?.length) || metrics.some((m) => m === "quantity" || m === "avg_unit_price"));
  const splitCategory = subject === "sales" && dims.includes("category");
  if (needItems && metrics.includes("simple_gross")) {
    return { ok: false, error: "簡易粗利 (売上−畳原価−仕入−経費) は商品 (明細) ごとには出せません。", hint: "商品別の粗利は gross (売上−案件の原価を明細の金額で按分した目安) を使ってください。" };
  }
  if (metrics.includes("simple_gross") && dims.some((d) => !(TIME_DIMS as readonly string[]).includes(d) && d !== "store")) {
    return { ok: false, error: "簡易粗利 (売上−畳原価−仕入−経費) は期間と店舗の軸でだけ集計できます。", hint: "種別・顧客・担当者の軸では gross (売上−記録された原価) を使ってください。" };
  }

  const build = (f: string, t: string, noteSet: Set<string>): Atom[] => {
    if (subject !== "sales") return otherAtoms(ctx, subject, raw, f, t);
    const atoms = salesAtoms(ctx, raw, f, t, needItems, splitCategory, noteSet);
    if (metrics.includes("simple_gross")) {
      for (const a of otherAtoms(ctx, "expenses", { ...raw, staff: undefined, products: undefined }, f, t)) atoms.push({ ...a, v: { expenses: a.v.amount } });
      for (const a of otherAtoms(ctx, "purchases", { ...raw, customers: undefined, products: undefined }, f, t)) atoms.push({ ...a, v: { purchases: a.v.amount } });
    }
    return atoms;
  };

  const atoms = build(from, to, notes);
  const { groups, total } = aggregate(atoms, dims, ctx);

  // ---- 比較 (前年同期・前の期間) ----
  let compareLabel: string | undefined;
  let prevGroups: Map<string, { keys: string[]; acc: Acc }> | undefined;
  let prevTotal: Acc | undefined;
  const compare = raw.compare && raw.compare !== "none" ? raw.compare : undefined;
  const timeDimUsed = dims.some((d) => (TIME_DIMS as readonly string[]).includes(d));
  if (compare) {
    const pf = compare === "previous_year" ? shiftYear(from, -1) : addDays(from, -(daysBetween(from, to) + 1));
    const pt = compare === "previous_year" ? shiftYear(to, -1) : addDays(from, -1);
    compareLabel = `${compare === "previous_year" ? "前年同期" : "前の期間"} (${periodLabel(pf, pt)})`;
    const p = aggregate(build(pf, pt, new Set()), dims, ctx);
    prevTotal = p.total;
    // 時間の軸があるときは、比較先の行を同じ位置 (1 年前・同じ長さ前) にずらして突き合わせる
    prevGroups = new Map();
    for (const [, g] of p.groups) {
      const keys = g.keys.map((k, i) => {
        const d = dims[i];
        if (!(TIME_DIMS as readonly string[]).includes(d) || d === "weekday") return k;
        if (compare === "previous_year") return k.replace(/^(\d{4})/, (y) => String(Number(y) + 1)).replace(/^(\d{4}-\d{2}-\d{2})/, (x) => shiftYear(x, 1));
        return k; // 前の期間との比較は、時間の軸では突き合わせられない (合計の比較だけ)
      });
      prevGroups.set(keys.join("\u0001"), { keys, acc: g.acc });
    }
    if (compare === "previous_period" && timeDimUsed) notes.add("前の期間との比較は合計だけです (月・年の軸の行どうしは突き合わせません)");
  }

  const primary = metrics[0];
  const pdef = metricDefs[primary];
  // ---- 行 ----
  const keysUnion = new Map<string, string[]>();
  for (const [id, g] of groups) keysUnion.set(id, g.keys);
  if (prevGroups && !(compare === "previous_period" && timeDimUsed)) for (const [id, g] of prevGroups) if (!keysUnion.has(id)) keysUnion.set(id, g.keys);

  type Row = { keys: string[]; acc: Acc; prev?: Acc };
  let rows: Row[] = [...keysUnion.entries()].map(([id, keys]) => ({ keys, acc: groups.get(id)?.acc ?? newAcc(), prev: compare && !(compare === "previous_period" && timeDimUsed) ? (prevGroups?.get(id)?.acc ?? newAcc()) : undefined }));
  const val = (r: Row, m: string) => metricDefs[m].calc(r.acc);
  const diffOf = (r: Row) => (r.prev ? (pdef.calc(r.acc) ?? 0) - (pdef.calc(r.prev) ?? 0) : 0);
  if (raw.only && compare) rows = rows.filter((r) => (raw.only === "decreased" ? diffOf(r) < 0 : diffOf(r) > 0));

  // ---- 並べ替え ----
  const firstTime = dims[0] && (TIME_DIMS as readonly string[]).includes(dims[0]);
  const sortKey = raw.sort_by ?? (raw.only ? `${primary}_diff` : firstTime ? "label" : primary);
  const dir = raw.order === "asc" ? 1 : raw.order === "desc" ? -1 : sortKey === "label" ? 1 : raw.only === "decreased" ? 1 : -1;
  rows.sort((a, b) => {
    if (sortKey === "label" || !(sortKey in metricDefs || sortKey.endsWith("_diff") || sortKey.endsWith("_prev") || sortKey.endsWith("_ratio"))) return a.keys.join("|").localeCompare(b.keys.join("|"), "ja") * dir;
    const pick = (r: Row) => {
      if (sortKey.endsWith("_diff")) return diffOf(r);
      if (sortKey.endsWith("_prev")) return r.prev ? (pdef.calc(r.prev) ?? 0) : 0;
      if (sortKey.endsWith("_ratio")) return r.prev && pdef.calc(r.prev) ? (pdef.calc(r.acc) ?? 0) / (pdef.calc(r.prev) as number) : 0;
      return val(r, sortKey) ?? -Infinity;
    };
    return (pick(a) - pick(b)) * dir || a.keys.join("|").localeCompare(b.keys.join("|"), "ja");
  });

  // ---- 表 ----
  const limit = Math.min(200, Math.max(1, Math.floor(raw.limit ?? (dims.length ? 50 : 1))));
  const pivot = dims.length === 2 && (raw.pivot ?? firstTime) && !compare;
  const columns: AnalysisColumn[] = [];
  const outRows: Record<string, Cell>[] = [];
  const totalRow: Record<string, Cell> = {};
  let omitted = 0;
  let chart: AnalysisChart | undefined;
  const unit: AnalysisChart["unit"] = pdef.kind === "yen" ? "yen" : pdef.kind === "count" ? "count" : "plain";

  if (pivot) {
    // 1 つ目の軸を行、2 つ目の軸を列にする (列は合計の大きい順に 10 まで。残りは「その他」)
    const colTotals = new Map<string, number>();
    for (const r of rows) colTotals.set(r.keys[1], (colTotals.get(r.keys[1]) ?? 0) + (val(r, primary) ?? 0));
    const colKeys = [...colTotals.entries()].sort((a, b) => (dims[1] === "store" || (TIME_DIMS as readonly string[]).includes(dims[1]) ? a[0].localeCompare(b[0], "ja") : b[1] - a[1])).map(([k]) => k);
    const shown = colKeys.slice(0, 10);
    const rest = colKeys.length > 10;
    columns.push({ key: "k0", label: DIM_LABEL[dims[0]], kind: "text" });
    shown.forEach((k, i) => columns.push({ key: `c${i}`, label: showKey(dims[1], k), kind: pdef.kind }));
    if (rest) columns.push({ key: "rest", label: "その他", kind: pdef.kind });
    columns.push({ key: "sum", label: `合計 (${pdef.label})`, kind: pdef.kind });
    const byFirst = new Map<string, Map<string, Row>>();
    for (const r of rows) {
      let m = byFirst.get(r.keys[0]);
      if (!m) byFirst.set(r.keys[0], (m = new Map()));
      m.set(r.keys[1], r);
    }
    // 行の合計は、2 つ目の軸を外して集計し直した値 (件数・顧客数を重ねて数えないように)
    const firstOnly = aggregate(atoms, [dims[0]], ctx).groups;
    const firstKeys = [...byFirst.keys()].sort((a, b) => (firstTime || dims[0] === "store" ? a.localeCompare(b, "ja") : (pdef.calc(firstOnly.get(b)!.acc) ?? 0) - (pdef.calc(firstOnly.get(a)!.acc) ?? 0)));
    for (const fk of firstKeys.slice(0, limit)) {
      const m = byFirst.get(fk)!;
      const row: Record<string, Cell> = { k0: showKey(dims[0], fk) };
      shown.forEach((k, i) => (row[`c${i}`] = m.get(k) ? pdef.calc(m.get(k)!.acc) : pdef.kind === "percent" ? null : 0));
      if (rest) {
        const restAcc = newAcc();
        for (const [k, r] of m) if (!shown.includes(k)) for (const [sk, sv] of Object.entries(r.acc.s)) restAcc.s[sk] = (restAcc.s[sk] ?? 0) + sv;
        row.rest = pdef.kind === "count" ? null : pdef.calc(restAcc);
      }
      row.sum = pdef.calc(firstOnly.get(fk)?.acc ?? newAcc());
      outRows.push(row);
    }
    omitted = Math.max(0, firstKeys.length - limit);
    totalRow.k0 = "合計";
    shown.forEach((k, i) => {
      const colAcc = aggregate(atoms.filter((a) => dimValues(a, dims[1], ctx).includes(k)), [], ctx).total;
      totalRow[`c${i}`] = pdef.calc(colAcc);
    });
    totalRow.sum = pdef.calc(total);
    const storeColor = (k: string) => (dims[1] === "store" ? db.stores.find((st) => st.name === showKey("store", k))?.color : undefined);
    chart = { kind: firstTime ? "time" : "bars", x: "k0", series: shown.map((k, i) => ({ key: `c${i}`, label: showKey(dims[1], k), color: storeColor(k) })), unit };
    if (metrics.length > 1) notes.add(`表は「${pdef.label}」だけを ${DIM_LABEL[dims[0]]} × ${DIM_LABEL[dims[1]]} で並べています`);
  } else {
    dims.forEach((d, i) => columns.push({ key: `k${i}`, label: DIM_LABEL[d], kind: "text" }));
    for (const m of metrics) columns.push({ key: m, label: metricDefs[m].label, kind: metricDefs[m].kind });
    if (compare) {
      columns.push({ key: `${primary}_prev`, label: `${pdef.label} (${compare === "previous_year" ? "前年同期" : "前の期間"})`, kind: pdef.kind });
      if (pdef.kind !== "percent") columns.push({ key: `${primary}_diff`, label: "増減", kind: pdef.kind });
      columns.push({ key: `${primary}_ratio`, label: pdef.kind === "percent" ? "増減 (ポイント)" : "前年比", kind: pdef.kind === "percent" ? "number" : "percent" });
    }
    const list = dims.length ? rows : [{ keys: [], acc: total, prev: prevTotal }];
    for (const r of list.slice(0, limit)) {
      const row: Record<string, Cell> = {};
      r.keys.forEach((k, i) => (row[`k${i}`] = showKey(dims[i], k)));
      for (const m of metrics) row[m] = metricDefs[m].calc(r.acc);
      if (compare) {
        const cur = pdef.calc(r.acc);
        const prev = r.prev ? pdef.calc(r.prev) : null;
        row[`${primary}_prev`] = prev;
        if (pdef.kind !== "percent") row[`${primary}_diff`] = cur !== null && prev !== null ? cur - prev : null;
        row[`${primary}_ratio`] = pdef.kind === "percent" ? (cur !== null && prev !== null ? Math.round((cur - prev) * 1000) / 10 : null) : prev ? (cur ?? 0) / prev : null;
      }
      outRows.push(row);
    }
    omitted = dims.length ? Math.max(0, rows.length - limit) : 0;
    if (dims.length) {
      dims.forEach((_, i) => (totalRow[`k${i}`] = i === 0 ? "合計" : ""));
      for (const m of metrics) totalRow[m] = metricDefs[m].calc(total);
      if (compare && prevTotal) {
        const cur = pdef.calc(total);
        const prev = pdef.calc(prevTotal);
        totalRow[`${primary}_prev`] = prev;
        if (pdef.kind !== "percent") totalRow[`${primary}_diff`] = cur !== null && prev !== null ? cur - prev : null;
        totalRow[`${primary}_ratio`] = pdef.kind === "percent" ? (cur !== null && prev !== null ? Math.round((cur - prev) * 1000) / 10 : null) : prev ? (cur ?? 0) / prev : null;
      }
    }
    if (dims.length === 1 && outRows.length > 1) chart = { kind: firstTime ? "time" : "bars", x: "k0", series: [{ key: primary, label: pdef.label }], unit, pointColors: dims[0] === "store" ? Object.fromEntries(db.stores.map((st) => [st.name, st.color])) : undefined };
  }

  // ---- 注記 ----
  if (subject === "sales") {
    notes.add(raw.date_basis === "contract" ? "受注金額 = 契約日が期間内の受注 (税込・キャンセルを除く)" : "売上 = 売上計上日 (施工完了日) が期間内の受注 (税込・キャンセルを除く)。経営ダッシュボードと同じ基準");
    if (metrics.some((m) => ["cost", "gross", "gross_margin"].includes(m))) notes.add("原価は「畳原価 (売上台帳の記録)」と「案件にひも付いた仕入」だけです。襖・障子・網戸などの材料原価は記録がないため、粗利は実際より大きく出ます");
    if (dims.includes("staff") || raw.staff?.length) notes.add("担当者: 移行した受注は販売管理ソフトの「担当者欄」の 1 番目 (担当。3 番目の伝票の入力者は数えない)、システムで登録した受注は見積の担当者 (見積がなければ受注を登録した社員)。経営ダッシュボードの担当者別と同じ");
    if (dims.includes("worker")) notes.add("施工担当: 受注に登録された施工担当と、移行した受注の「担当者欄」の 2 番目 (複数名のときはそれぞれに全額を計上)");
    if (dims.includes("category") && !needItems) notes.add("種別ごとの金額は受注の種別別の内訳 (売上台帳の畳・襖・障子…の欄)。件数はその種別を含む受注の数");
    if (dims.includes("channel")) notes.add("受付経路: 見積の媒体 → 問い合わせの入口 → 顧客の初回接点 の順に使っています (移行データの多くは未登録)");
  }
  if (subject === "quotes") notes.add("成約率 = 受注になった見積 ÷ 結果が出た見積 (受注・失注・期限切れ)");
  if (subject === "schedule") notes.add("予定表は全社で共有。複数日の予定は開始日で数え、延べ日数は終了日までの日数");
  if (subject === "expenses") notes.add("経費は承認済・精算済のもの");

  const dimText = dims.map((d) => DIM_LABEL[d]).join("×");
  const title = raw.title?.slice(0, 60) || `${SUBJECT_LABEL[subject]}${dimText ? ` (${dimText})` : ""} ${periodLabel(from, to)}`;
  const spec: AnalysisSpec = { ...raw, subject, metrics, group_by: dims, from, to };
  return { ok: true, title, period: { from, to, label: periodLabel(from, to) }, compareLabel, spec, columns, rows: outRows, total: totalRow, omitted, notes: [...notes], chart };
}

/** AI に返す文字 (表を Markdown にする。行が多いときは先頭だけ) */
export function analysisText(r: AnalysisResult, maxRows = 40): string {
  const fmt = (c: AnalysisColumn, v: Cell) => {
    if (v === null || v === undefined) return "-";
    if (typeof v === "string") return v;
    if (c.kind === "yen") return `¥${Math.round(v).toLocaleString("ja-JP")}`;
    if (c.kind === "percent") return `${(v * 100).toFixed(1)}%`;
    if (c.kind === "count") return `${Math.round(v).toLocaleString("ja-JP")}`;
    return v.toLocaleString("ja-JP", { maximumFractionDigits: 1 });
  };
  const head = `| ${r.columns.map((c) => c.label).join(" | ")} |\n|${r.columns.map(() => "---").join("|")}|`;
  const body = r.rows.slice(0, maxRows).map((row) => `| ${r.columns.map((c) => fmt(c, row[c.key])).join(" | ")} |`).join("\n");
  const total = Object.keys(r.total).length ? `\n| ${r.columns.map((c) => fmt(c, r.total[c.key] ?? "")).join(" | ")} |` : "";
  const more = r.rows.length > maxRows || r.omitted ? `\n(ほか ${r.rows.length - Math.min(maxRows, r.rows.length) + r.omitted} 行)` : "";
  return [`【${r.title}】期間 ${r.period.label}${r.compareLabel ? ` / 比較: ${r.compareLabel}` : ""}`, head, body + total + more, r.notes.length ? `注記:\n${r.notes.map((n) => `- ${n}`).join("\n")}` : ""].filter(Boolean).join("\n");
}
