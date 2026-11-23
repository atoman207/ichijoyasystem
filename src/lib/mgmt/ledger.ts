import type { Database, MaterialKind, Order, OrderAttribution, StoreId } from "@/lib/db/types";
import { salesFacts } from "@/lib/assistant/facts";
import { exTax, type Rounding } from "./decimal";
import { ruleAt } from "./rules";
import { mainCategory, orderCategorySales } from "./categories";
import { adjustmentDate, ADJ_KIND_LABEL, ratePct } from "./attribution";
import { autoUsage, countedUsageIndex, STAGE_LABEL } from "./costing";
import { productionNoteIndex } from "./doko";
import { COST_TYPE_LABEL, linesExTax } from "./purchase-lines";
import { MOVE_KIND_LABEL } from "./stock";
import { COMMON_ACCOUNTS, defaultExpenseClass } from "./expense-class";

/**
 * 管理会計の元帳 (店舗別損益のすべての数字の元)
 * ------------------------------------------------------------
 * 売上・調整・材料費・外注費・経費・手入力を 1 行ずつの「元帳の行」にし、どの記録から来た数字かを持たせる (計算の根拠)。
 * 店舗別損益・品目別損益・案分の基準の粗利益は、すべてこの行を足し合わせて作る。金額は設定 pnl.basis (既定: 税抜)。
 *
 * 数え方:
 * - 外部売上: 受注 (キャンセルを除く) の売上計上日 (施工完了) で、受注の店舗 (= 売上帰属店舗) に計上。品目は categories.ts の内訳。
 *   税抜で表示するとき、免税 (輸出など)・非課税・不課税の受注 (売上の帰属の税区分) は消費税を引かない
 * - 店舗間の調整: 内部受注・本部の特殊配分・手入力 (依頼元 +・施工店舗 −。合計 0)。受注にひも付く行は受注の売上計上日
 * - 材料費: 材料の使用の行 (受注ごとに一番進んだ段階) → なければ移行データの畳原価 (Order.tatamiCost) → なければ材料構成からの自動計算
 *   (costing.ts の autoUsage)。受注の売上計上日に施工店舗で計上
 *   + 仕入明細の振り分け (材料費) + 手入力の差額調整 (畳表の差額など) + 店舗間の材料移動 (原価の振替。渡した店舗 −・受け取った店舗 +)。
 *   在庫の受入・在庫の店舗間の移動は材料費にしない (使ったときに原価)
 * - 外注費: 仕入明細の振り分け (外注費)
 * - 振り分けの済んでいない仕入 (明細の振り分けの行がない) は、勘定科目で 外注費 / 材料費 / 案分経費 / 店舗独自経費 に入れ「未振り分け」として暫定にする
 * - 経費: 承認済み・精算済みの経費。経費の区分 (登録した区分 → なければ expense-class.ts の既定) が案分経費なら案分の対象 (common_pool)、それ以外は店舗独自経費
 */

export type LedgerMetric =
  | "sales"
  | "adj_internal"
  | "adj_hq"
  | "adj_manual"
  | "material"
  | "outsource"
  | "labor"
  | "own_expense"
  | "common_pool"
  | "allocated"
  | "other_mgmt"
  | "budget";

export const METRIC_LABEL: Record<LedgerMetric, string> = {
  sales: "外部売上",
  adj_internal: "内部受注の配分",
  adj_hq: "本部の特殊配分",
  adj_manual: "手入力の売上調整",
  material: "材料費",
  outsource: "外注費",
  labor: "人件費",
  own_expense: "店舗独自経費",
  common_pool: "共通経費 (案分前)",
  allocated: "共通経費の案分額",
  other_mgmt: "その他管理経費",
  budget: "予算",
};

export interface LedgerRow {
  date: string;
  month: string;
  storeId: StoreId;
  metric: LedgerMetric;
  itemCategory: string;
  amount: number;
  /** 元の記録 (種類・ID・表示・画面のリンク) */
  source: { kind: string; id: string; label: string; href?: string };
  /** 暫定の理由 (未確定の設定・要確認・未振り分けなど) */
  provisional?: string;
  /** 予算の指標 */
  budgetMetric?: string;
  /** 材料の種類 (材料の使用の行。畳表の仮原価と実仕入の差額の計算に使う) */
  materialKind?: MaterialKind;
}

/** 消費税のかからない売上の税区分 */
const NO_TAX: NonNullable<OrderAttribution["taxCategory"]>[] = ["exempt", "non_taxable", "out_of_scope"];

const MATERIAL_ACCOUNTS = /仕入|材料|原材料|商品/;
const OUTSOURCE_ACCOUNTS = /外注/;

export function inRange(d: string | null | undefined, from: string, to: string): d is string {
  return Boolean(d) && d! >= from && d! <= to;
}

/** 税込 → 表示の金額 (設定 pnl.basis。税抜のときは その日の税率で税抜に直す) */
export function basisAmount(db: Database, amountIncl: number, date: string): number {
  if (ruleAt(db, "pnl.basis", date).value === "tax_included") return amountIncl;
  return exTax(amountIncl, ratePct(date), ruleAt(db, "tax.exclusion_rounding", date).value as Rounding);
}

/** 税抜 → 表示の金額 */
export function basisFromExTax(db: Database, amountEx: number, date: string): number {
  if (ruleAt(db, "pnl.basis", date).value !== "tax_included") return amountEx;
  return amountEx + Math.floor((amountEx * ratePct(date)) / 100);
}

/** 期間の元帳の行 (案分額 allocated は含まない。allocation.ts / pnl.ts で足す) */
export function baseLedger(db: Database, from: string, to: string): LedgerRow[] {
  const rows: LedgerRow[] = [];
  const push = (r: Omit<LedgerRow, "month">) => {
    if (r.amount) rows.push({ ...r, month: r.date.slice(0, 7) });
  };
  const { byId } = salesFacts(db);
  const orders = new Map(db.orders.map((o) => [o.id, o]));
  const usage = countedUsageIndex(db);
  const atts = new Map((db.orderAttributions ?? []).map((a) => [a.orderId, a]));
  const noTax = (orderId: string | undefined) => Boolean(orderId && NO_TAX.includes(atts.get(orderId)?.taxCategory ?? "unset"));
  // 税込 → 表示の金額 (消費税のかからない売上は税込 = 税抜)
  const salesBasis = (incl: number, date: string, orderId?: string) => (noTax(orderId) ? incl : basisAmount(db, incl, date));
  let notes: Map<string, string> | undefined;
  const catCache = new Map<string, Record<string, number>>();
  const salesOf = (o: Order) => {
    let c = catCache.get(o.id);
    if (!c) catCache.set(o.id, (c = orderCategorySales(db, o, byId.get(o.id), o.salesDate ?? o.contractDate)));
    return c;
  };

  // 外部売上と材料費 (受注)
  for (const o of db.orders) {
    if (o.status === "cancelled" || !inRange(o.salesDate, from, to)) continue;
    const date = o.salesDate!;
    const cats = salesOf(o);
    const src = { kind: "order", id: o.id, label: `受注 ${o.number} ${o.title}`, href: `/orders/${o.id}` };
    const taxNote = noTax(o.id) ? "消費税のかからない売上 (税区分の登録どおり)" : undefined;
    for (const [cat, incl] of Object.entries(cats)) push({ date, storeId: o.storeId, metric: "sales", itemCategory: cat, amount: salesBasis(incl, date, o.id), source: taxNote ? { ...src, label: `${src.label} (${taxNote})` } : src });
    const used = usage.get(o.id);
    const costHref = `/management?tab=cost&order=${o.id}`;
    if (used?.length) {
      for (const u of used) {
        const review = u.needsReview || u.amount === undefined;
        const usageSrc = { kind: "usage", id: u.id, label: `${STAGE_LABEL[u.stage]} ${o.number} ${u.productLabel ?? ""}`.trim(), href: costHref };
        if (review) {
          // 要確認の材料は金額 0 の行で残す (件数・理由を画面に出す。推測の金額は入れない)
          rows.push({ date, month: date.slice(0, 7), storeId: u.storeId, metric: "material", itemCategory: u.itemCategory, amount: 0, source: { ...usageSrc, label: `要確認: ${usageSrc.label} ${u.reviewNote ?? ""}`.trim() }, provisional: "要確認の材料 (金額なし)", materialKind: u.materialKind });
          continue;
        }
        push({
          date,
          storeId: u.storeId,
          metric: "material",
          itemCategory: u.itemCategory,
          amount: basisFromExTax(db, u.amount ?? 0, date),
          source: usageSrc,
          provisional: u.stage !== "actual" ? `${STAGE_LABEL[u.stage]} (実績ではない)` : u.spec?.inferred?.includes("既定") ? "畳床などを既定の仕様で計算" : undefined,
          materialKind: u.materialKind,
        });
      }
    } else if (o.tatamiCost) {
      push({ date, storeId: o.storeId, metric: "material", itemCategory: "tatami", amount: basisFromExTax(db, Math.round(o.tatamiCost), date), source: { ...src, kind: "tatami_cost", label: `畳原価 (売上台帳から移行) ${o.number}` } });
    } else if ((db.boms ?? []).length) {
      // 原価の行を登録していない受注: 売上明細の商品・数量と材料構成から自動で計算する (施工店舗に計上)
      notes ??= productionNoteIndex(db);
      const workStore = atts.get(o.id)?.workStoreId ?? o.storeId;
      const auto = autoUsage(db, o, byId.get(o.id), date, notes.get(o.id) ?? "");
      for (const u of auto.usages) {
        const autoSrc = { kind: "usage_auto", id: `${o.id}:${u.lineKey}`, label: `自動計算 ${o.number} ${u.productLabel ?? ""}`.trim(), href: costHref };
        if (u.needsReview || u.amount === undefined) {
          rows.push({ date, month: date.slice(0, 7), storeId: workStore, metric: "material", itemCategory: u.itemCategory, amount: 0, source: { ...autoSrc, label: `要確認: ${autoSrc.label} ${u.reviewNote ?? ""}`.trim() }, provisional: "要確認の材料 (金額なし)", materialKind: u.materialKind });
          continue;
        }
        push({ date, storeId: workStore, metric: "material", itemCategory: u.itemCategory, amount: basisFromExTax(db, u.amount, date), source: autoSrc, provisional: u.assumed ? "畳床などを既定の仕様で計算" : undefined, materialKind: u.materialKind });
      }
      for (const l of auto.unmatched) {
        rows.push({ date, month: date.slice(0, 7), storeId: workStore, metric: "material", itemCategory: l.itemCategory, amount: 0, source: { kind: "usage_auto", id: `${o.id}:${l.key}`, label: `要確認: 材料構成のない畳の明細 ${o.number} ${l.label} ×${l.qty}`, href: costHref }, provisional: "要確認の材料 (金額なし)" });
      }
    }
  }

  // 店舗間の売上調整
  for (const a of db.salesAdjustments ?? []) {
    const date = adjustmentDate(db, a, orders);
    if (!inRange(date, from, to)) continue;
    const o = a.orderId ? orders.get(a.orderId) : undefined;
    const cat = o ? mainCategory(salesOf(o), "other") : "other";
    const amt = a.base === "tax_included" ? salesBasis(a.amount, date, a.orderId) : basisFromExTax(db, a.amount, date);
    const metric: LedgerMetric = a.kind === "internal_order" ? "adj_internal" : a.kind === "hq_special" ? "adj_hq" : "adj_manual";
    const label = `${ADJ_KIND_LABEL[a.kind]} ${a.number}${a.reversalOf ? " (取消し)" : ""}${o ? ` ${o.number}` : ""}`;
    const provisional = a.provisional ? "暫定の設定で計算" : a.kind === "hq_special" && (a.treatment ?? "unset") === "unset" ? "会計上の扱いが未確定" : undefined;
    const src = { kind: "adjustment", id: a.id, label, href: `/management?tab=sales&adj=${a.id}` };
    if (a.kind === "hq_special" && a.treatment === "cost_only") continue; // 原価のみ計上: 売上は動かさない (原価は仕入の振り分け・材料の使用で施工店舗に)
    push({ date, storeId: a.fromStoreId, metric, itemCategory: cat, amount: amt, source: src, provisional });
    push({ date, storeId: a.toStoreId, metric, itemCategory: cat, amount: -amt, source: src, provisional });
  }

  // 仕入: 明細の振り分け (確定・未確定) と、振り分けのない仕入
  const allocsByPurchase = new Map<string, NonNullable<Database["purchaseLineAllocs"]>>();
  for (const a of db.purchaseLineAllocs ?? []) (allocsByPurchase.get(a.purchaseId) ?? allocsByPurchase.set(a.purchaseId, []).get(a.purchaseId)!).push(a);
  for (const p of db.purchases) {
    if (p.status === "rejected" || !inRange(p.invoiceDate, from, to)) continue;
    const date = p.invoiceDate;
    const allocs = allocsByPurchase.get(p.id) ?? [];
    const href = `/management?tab=purchases&purchase=${p.id}`;
    const ex = linesExTax(p);
    const confirmed = new Set(allocs.filter((a) => a.status === "confirmed").map((a) => a.itemId));
    for (const a of allocs.filter((x) => x.status === "confirmed")) {
      for (const s of a.splits) {
        const metric: LedgerMetric | null = s.costType === "material" ? "material" : s.costType === "outsource" ? "outsource" : s.costType === "store_expense" ? "own_expense" : s.costType === "common_expense" ? "common_pool" : s.costType === "other" ? "other_mgmt" : null;
        if (!metric) continue; // 在庫の受入は原価にしない
        push({ date, storeId: s.storeId, metric, itemCategory: s.itemCategory, amount: basisFromExTax(db, s.amount, date), source: { kind: "purchase_line", id: a.id, label: `仕入 ${p.number} ${a.lineNo} 行目 ${a.ocr.name} (${COST_TYPE_LABEL[s.costType]})`, href } });
      }
    }
    // 確定していない明細 (振り分け待ち) は勘定科目で仮に入れる
    for (const line of ex) {
      if (confirmed.has(line.itemId)) continue;
      const order = p.orderId ? orders.get(p.orderId) : undefined;
      const cat = order ? mainCategory(salesOf(order), "other") : "other";
      const metric: LedgerMetric = OUTSOURCE_ACCOUNTS.test(p.account ?? "") ? "outsource" : !p.account || MATERIAL_ACCOUNTS.test(p.account) ? "material" : COMMON_ACCOUNTS.test(p.account) || p.storeId === "hq" ? "common_pool" : "own_expense";
      push({ date, storeId: p.storeId, metric, itemCategory: cat, amount: basisFromExTax(db, line.exTax, date), source: { kind: "purchase", id: p.id, label: `仕入 ${p.number} (明細の振り分け前: ${p.account ?? "勘定科目なし"})`, href }, provisional: "仕入明細の振り分けが未確定" });
    }
  }

  // 経費 (承認済み・精算済み)
  const classes = new Map((db.expenseClasses ?? []).map((c) => [c.expenseId, c]));
  for (const e of db.expenses) {
    if ((e.status !== "approved" && e.status !== "paid") || !inRange(e.date, from, to)) continue;
    const cls = classes.get(e.id);
    const allocClass = cls?.allocClass ?? defaultExpenseClass(e).allocClass;
    const amount = basisFromExTax(db, e.amount - (e.taxAmount ?? 0), e.date);
    push({ date: e.date, storeId: e.storeId, metric: allocClass === "common" ? "common_pool" : "own_expense", itemCategory: "other", amount, source: { kind: "expense", id: e.id, label: `経費 ${e.number} ${e.account} ${e.vendor}${cls ? "" : ` (区分は勘定科目から自動: ${allocClass === "common" ? "案分経費" : "店舗独自経費"})`}`, href: `/expenses/${e.id}` } });
  }

  // 店舗間の材料移動 (原価の振替): 渡した店舗の材料費 −・受け取った店舗の材料費 + (全社の材料費は変わらない)
  for (const t of db.materialTransfers ?? []) {
    if (!inRange(t.date, from, to)) continue;
    const sign = t.reversalOf ? -1 : 1;
    const amt = basisFromExTax(db, t.amount, t.date) * sign;
    const src = { kind: "material_transfer", id: t.id, label: `材料移動 ${t.number} ${t.name} ×${t.qty}${t.reversalOf ? " (取消し)" : ""}`, href: `/management?tab=stock&month=${t.date.slice(0, 7)}` };
    push({ date: t.date, storeId: t.fromStoreId, metric: "material", itemCategory: t.itemCategory, amount: -amt, source: src });
    push({ date: t.date, storeId: t.toStoreId, metric: "material", itemCategory: t.itemCategory, amount: amt, source: src });
  }

  // 手入力 (人件費・管理経費・共通経費・材料の差額調整・予算)
  // 月単位の行は、期間にかかる月の分をそのまま数える (取り消した行も数え、取消しの行と相殺する)
  for (const m of db.mgmtEntries ?? []) {
    if (m.month < from.slice(0, 7) || m.month > to.slice(0, 7)) continue;
    const date = `${m.month}-01`;
    const metric: LedgerMetric = m.kind === "labor" ? "labor" : m.kind === "store_expense" ? "own_expense" : m.kind === "common_expense" ? "common_pool" : m.kind === "material_adjust" ? "material" : m.kind === "budget" ? "budget" : "other_mgmt";
    push({ date, storeId: m.storeId, metric, itemCategory: m.itemCategory ?? "other", amount: m.amount, budgetMetric: m.metric, source: { kind: "entry", id: m.id, label: `手入力 ${m.note ?? ""}${m.reversalOf ? " (取消し)" : ""}`.trim(), href: `/management?tab=entries&month=${m.month}` } });
  }

  // 在庫の廃棄・棚卸の調整 (その他管理経費。会計上の扱いは要確認)
  for (const s of db.stockMoves ?? []) {
    if (s.status === "draft" || (s.kind !== "dispose" && s.kind !== "adjust") || !inRange(s.date, from, to)) continue;
    const loss = s.kind === "dispose" || s.toLoc === "adjust" ? 1 : -1;
    const sign = s.reversalOf ? -loss : loss;
    const storeId = (s.kind === "adjust" && s.fromLoc === "adjust" ? s.toLoc : s.fromLoc)?.replace(/^store:/, "") as StoreId;
    push({ date: s.date, storeId, metric: "other_mgmt", itemCategory: "other", amount: basisFromExTax(db, sign * s.amount, s.date), source: { kind: "stock", id: s.id, label: `${MOVE_KIND_LABEL[s.kind]} ${s.number}`, href: `/management?tab=stock` }, provisional: "廃棄・棚卸差異の会計上の扱いは要確認" });
  }
  return rows;
}
