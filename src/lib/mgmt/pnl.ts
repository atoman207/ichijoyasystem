import type { Database, StoreId } from "@/lib/db/types";
import { percent1 } from "./decimal";
import { baseLedger, inRange, METRIC_LABEL, type LedgerMetric, type LedgerRow } from "./ledger";
import { confirmedRun, monthRange, previewAllocation } from "./allocation";
import { itemCategories } from "./categories";
import { isClosed } from "./close";
import { stockTotals } from "./stock";
import { ruleAt } from "./rules";

/**
 * 店舗別損益・品目別損益・月次の照合
 * ------------------------------------------------------------
 * 元帳 (ledger.ts) の行を足し合わせる。共通経費の案分額は、確定した案分があればその結果、なければその月の計算 (暫定)。保留の月は案分しない。
 * 管理売上 = 外部売上 + 店舗間の調整 / 粗利益 = 管理売上 − 材料費 − 外注費 /
 * 店舗の損益 = 粗利益 − 人件費 − 店舗独自経費 − 共通経費の案分額 − その他管理経費
 */

export interface StorePnl {
  storeId: StoreId;
  storeName: string;
  externalSales: number;
  adjInternal: number;
  adjHq: number;
  adjManual: number;
  mgmtSales: number;
  material: number;
  outsource: number;
  gross: number;
  labor: number;
  ownExpense: number;
  allocated: number;
  otherMgmt: number;
  profit: number;
  /** 材料原価率 (%)。売上が 0 のときは null (計算不能) */
  materialRate: number | null;
  grossRate: number | null;
  budget: Record<string, number>;
  provisional: string[];
}

export interface CategoryPnl {
  storeId: StoreId | "all";
  itemCategory: string;
  name: string;
  sales: number;
  material: number;
  outsource: number;
  gross: number;
  materialRate: number | null;
}

export interface PnlResult {
  from: string;
  to: string;
  basis: string;
  stores: StorePnl[];
  total: StorePnl;
  categories: CategoryPnl[];
  /** 月ごとの案分の状態 */
  allocations: { month: string; status: "confirmed" | "provisional" | "held" | "empty"; poolTotal: number; holdReason?: string; runId?: string }[];
  /** 確定済みの月 / 暫定を含むか */
  closedMonths: string[];
  provisional: boolean;
  rows: LedgerRow[];
}

function months(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.slice(0, 7).split("-").map(Number);
  const end = to.slice(0, 7);
  for (;;) {
    const k = `${y}-${String(m).padStart(2, "0")}`;
    if (k > end) break;
    out.push(k);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

const empty = (storeId: StoreId, storeName: string): StorePnl => ({ storeId, storeName, externalSales: 0, adjInternal: 0, adjHq: 0, adjManual: 0, mgmtSales: 0, material: 0, outsource: 0, gross: 0, labor: 0, ownExpense: 0, allocated: 0, otherMgmt: 0, profit: 0, materialRate: null, grossRate: null, budget: {}, provisional: [] });

const FIELD: Partial<Record<LedgerMetric, keyof StorePnl>> = {
  sales: "externalSales",
  adj_internal: "adjInternal",
  adj_hq: "adjHq",
  adj_manual: "adjManual",
  material: "material",
  outsource: "outsource",
  labor: "labor",
  own_expense: "ownExpense",
  allocated: "allocated",
  other_mgmt: "otherMgmt",
};

/** 期間の元帳 (案分額を含む) と案分の状態 */
export function fullLedger(db: Database, from: string, to: string): { rows: LedgerRow[]; allocations: PnlResult["allocations"] } {
  const rows = baseLedger(db, from, to);
  const allocations: PnlResult["allocations"] = [];
  for (const month of months(from, to)) {
    const run = confirmedRun(db, month);
    if (run) {
      for (const r of run.results) rows.push({ date: `${month}-01`, month, storeId: r.storeId, metric: "allocated", itemCategory: "other", amount: r.amount, source: { kind: "allocation", id: run.id, label: `共通経費の案分 ${run.number} (確定)`, href: `/management?tab=alloc&month=${month}` } });
      allocations.push({ month, status: "confirmed", poolTotal: run.poolTotal, runId: run.id });
      continue;
    }
    const { from: mf, to: mt } = monthRange(month);
    // 期間が月の途中までのときも、案分はその月全体の計算 (共通経費・粗利益は月単位)
    const monthRows = mf >= from && mt <= to ? rows.filter((r) => r.month === month) : baseLedger(db, mf, mt);
    const p = previewAllocation(db, month, { rows: monthRows });
    if (p.status === "ok") {
      for (const r of p.results) rows.push({ date: `${month}-01`, month, storeId: r.storeId, metric: "allocated", itemCategory: "other", amount: r.amount, source: { kind: "allocation_preview", id: month, label: `共通経費の案分 ${month} (未確定の計算)`, href: `/management?tab=alloc&month=${month}` }, provisional: "共通経費の案分が未確定" });
    }
    allocations.push({ month, status: p.status === "ok" ? "provisional" : p.status, poolTotal: p.poolTotal, holdReason: p.holdReason });
  }
  return { rows, allocations };
}

export function storePnl(db: Database, from: string, to: string, opts: { storeIds?: string[] } = {}): PnlResult {
  const { rows, allocations } = fullLedger(db, from, to);
  const visible = opts.storeIds ? new Set(opts.storeIds) : undefined;
  const byStore = new Map<string, StorePnl>();
  for (const s of db.stores) if (!visible || visible.has(s.id)) byStore.set(s.id, empty(s.id, s.name));
  const total = empty("hq", "全社");
  for (const r of rows) {
    const targets = [byStore.get(r.storeId), total].filter(Boolean) as StorePnl[];
    if (!byStore.get(r.storeId) && visible) continue;
    for (const t of targets) {
      if (r.metric === "budget") {
        t.budget[r.budgetMetric ?? "sales"] = (t.budget[r.budgetMetric ?? "sales"] ?? 0) + r.amount;
        continue;
      }
      const f = FIELD[r.metric];
      if (f) (t[f] as number) += r.amount;
      if (r.provisional && !t.provisional.includes(r.provisional)) t.provisional.push(r.provisional);
    }
  }
  const finish = (p: StorePnl) => {
    p.mgmtSales = p.externalSales + p.adjInternal + p.adjHq + p.adjManual;
    p.gross = p.mgmtSales - p.material - p.outsource;
    p.profit = p.gross - p.labor - p.ownExpense - p.allocated - p.otherMgmt;
    p.materialRate = percent1(p.material, p.mgmtSales);
    p.grossRate = percent1(p.gross, p.mgmtSales);
    return p;
  };
  const stores = [...byStore.values()].map(finish);
  finish(total);
  // 品目別 (店舗 × 品目 と 全社 × 品目)
  const cats = itemCategories(db);
  const catMap = new Map<string, CategoryPnl>();
  const cat = (storeId: StoreId | "all", id: string) => {
    const k = `${storeId}|${id}`;
    return catMap.get(k) ?? catMap.set(k, { storeId, itemCategory: id, name: cats.find((c) => c.id === id)?.name ?? id, sales: 0, material: 0, outsource: 0, gross: 0, materialRate: null }).get(k)!;
  };
  for (const r of rows) {
    if (visible && !visible.has(r.storeId)) continue;
    const field = r.metric === "sales" || r.metric.startsWith("adj_") ? "sales" : r.metric === "material" ? "material" : r.metric === "outsource" ? "outsource" : null;
    if (!field) continue;
    for (const s of [r.storeId, "all"] as const) cat(s, r.itemCategory)[field] += r.amount;
  }
  const categories = [...catMap.values()].map((c) => ({ ...c, gross: c.sales - c.material - c.outsource, materialRate: percent1(c.material, c.sales) }));
  categories.sort((a, b) => (cats.find((c) => c.id === a.itemCategory)?.sort ?? 99) - (cats.find((c) => c.id === b.itemCategory)?.sort ?? 99));
  const closedMonths = months(from, to).filter((m) => isClosed(db, m));
  return {
    from,
    to,
    basis: ruleAt(db, "pnl.basis", to).value === "tax_included" ? "税込" : "税抜",
    stores,
    total,
    categories,
    allocations,
    closedMonths,
    provisional: rows.some((r) => r.provisional),
    rows: visible ? rows.filter((r) => visible.has(r.storeId)) : rows,
  };
}

/** 数字の根拠 (元帳の行。店舗・指標・品目で絞る) */
export function pnlSources(result: Pick<PnlResult, "rows">, filter: { storeId?: string; metric?: LedgerMetric | "gross_sales"; itemCategory?: string }, limit = 200): { rows: LedgerRow[]; count: number; sum: number } {
  const match = (r: LedgerRow) =>
    (!filter.storeId || r.storeId === filter.storeId) &&
    (!filter.itemCategory || r.itemCategory === filter.itemCategory) &&
    (!filter.metric || (filter.metric === "gross_sales" ? r.metric === "sales" || r.metric.startsWith("adj_") : r.metric === filter.metric));
  const all = result.rows.filter(match);
  return { rows: all.slice(0, limit), count: all.length, sum: all.reduce((a, r) => a + r.amount, 0) };
}

export interface Reconciliation {
  month: string;
  externalSales: number;
  storeMgmtSalesSum: number;
  adjustmentsNet: number;
  ok: boolean;
  checks: { label: string; ok: boolean; detail: string }[];
}

/** 月次の照合: 全社の外部売上 = 店舗別管理売上の合計 (調整の合計 0)、案分額の合計 = 共通経費、元の伝票との一致、在庫の合計 */
export function reconcile(db: Database, month: string): Reconciliation {
  const { from, to } = monthRange(month);
  const res = storePnl(db, from, to);
  const ext = res.total.externalSales;
  const sumMgmt = res.stores.reduce((a, s) => a + s.mgmtSales, 0);
  const adjNet = res.stores.reduce((a, s) => a + s.adjInternal + s.adjHq + s.adjManual, 0);
  const checks: Reconciliation["checks"] = [];
  checks.push({ label: "全社の外部売上 = 店舗別の管理売上の合計", ok: ext === sumMgmt, detail: `外部売上 ${ext.toLocaleString("ja-JP")} 円 / 店舗の合計 ${sumMgmt.toLocaleString("ja-JP")} 円` });
  checks.push({ label: "店舗間の調整の合計 = 0 (内部受注を外部売上に二重に数えていない)", ok: adjNet === 0, detail: `${adjNet.toLocaleString("ja-JP")} 円` });
  // 受注の売上 (元の伝票) と元帳の外部売上
  const orderSales = db.orders.filter((o) => o.status !== "cancelled" && inRange(o.salesDate, from, to)).reduce((a, o) => a + o.total, 0);
  const ledgerSalesIncl = res.rows.filter((r) => r.metric === "sales").length;
  checks.push({ label: "受注 (元の伝票) の件数・金額", ok: true, detail: `受注の税込合計 ${orderSales.toLocaleString("ja-JP")} 円 (元帳の売上の行 ${ledgerSalesIncl} 行。店舗別損益は${res.basis})` });
  for (const a of res.allocations) {
    if (a.status === "confirmed") {
      const run = db.allocationRuns.find((r) => r.id === a.runId)!;
      const sum = run.results.reduce((x, r) => x + r.amount, 0);
      checks.push({ label: `共通経費の案分額の合計 = 共通経費 (${a.month})`, ok: sum === run.poolTotal, detail: `案分額 ${sum.toLocaleString("ja-JP")} 円 / 共通経費 ${run.poolTotal.toLocaleString("ja-JP")} 円` });
      const now = previewAllocation(db, a.month);
      if (now.poolTotal !== run.poolTotal) checks.push({ label: `確定後に共通経費が変わっていないか (${a.month})`, ok: false, detail: `確定時 ${run.poolTotal.toLocaleString("ja-JP")} 円 → 今 ${now.poolTotal.toLocaleString("ja-JP")} 円 (案分の訂正が必要)` });
    } else checks.push({ label: `共通経費の案分 (${a.month})`, ok: a.status === "empty", detail: a.status === "held" ? `保留: ${a.holdReason}` : a.status === "provisional" ? "未確定 (計算のみ)" : "案分する共通経費なし" });
  }
  // 仕入: 振り分けの合計 = 明細の税抜の金額 (確定した明細)
  const badSplits = (db.purchaseLineAllocs ?? []).filter((a) => a.status === "confirmed" && a.splits.reduce((x, s) => x + s.amount, 0) !== a.ocr.amountExTax);
  checks.push({ label: "仕入明細の振り分けの合計 = 明細の金額", ok: badSplits.length === 0, detail: badSplits.length ? `${badSplits.length} 明細が一致しません` : "すべて一致" });
  const st = stockTotals(db, to);
  checks.push({ label: "在庫の金額 (月末)", ok: true, detail: `${st.amount.toLocaleString("ja-JP")} 円 (店舗間の移動では変わらない)` });
  return { month, externalSales: ext, storeMgmtSalesSum: sumMgmt, adjustmentsNet: adjNet, ok: checks.every((c) => c.ok), checks };
}

export { METRIC_LABEL };
