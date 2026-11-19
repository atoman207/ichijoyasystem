import "server-only";
import type { Database, User } from "@/lib/db/types";
import { canViewMgmt, mgmtStores } from "@/lib/mgmt/access";
import { storePnl, type StorePnl } from "@/lib/mgmt/pnl";
import { confirmedRun, monthRange, previewAllocation } from "@/lib/mgmt/allocation";
import { itemCategories } from "@/lib/mgmt/categories";
import { adjustmentDate, ADJ_KIND_LABEL } from "@/lib/mgmt/attribution";
import { countedUsageIndex } from "@/lib/mgmt/costing";
import { ruleAt, ruleLabel, RULE_DEFS } from "@/lib/mgmt/rules";
import { isClosed } from "@/lib/mgmt/close";
import { yen } from "@/lib/format";

/**
 * AI アシスタントの道具 management_accounting (管理会計の読み取り専用の集計)
 * ------------------------------------------------------------
 * 店舗別損益・品目別・内部受注・共通経費の案分・未確認の仕入明細・月次の推移を、管理会計の画面と同じ計算 (src/lib/mgmt) で返す。
 * 書き込みはしない。閲覧範囲は管理会計の画面と同じ (管理者・本部スタッフは全店舗、店長は自店舗、店舗スタッフは不可)。
 * 回答に 対象期間・金額の税 (税抜/税込)・集計条件・確定か暫定か を必ず含める
 */

export type MgmtView = "store_pnl" | "items" | "internal_orders" | "allocation" | "pending" | "trend" | "settings";

const pct = (v: number | null) => (v === null ? "計算不能" : `${v.toFixed(1)}%`);

function pnlLine(p: StorePnl): string {
  return `- ${p.storeName}: 外部売上 ${yen(p.externalSales)} / 店舗間の調整 ${yen(p.adjInternal + p.adjHq + p.adjManual)} (内部受注 ${yen(p.adjInternal)}) / 管理売上 ${yen(p.mgmtSales)} / 材料費 ${yen(p.material)} / 外注費 ${yen(p.outsource)} / 粗利益 ${yen(p.gross)} (粗利率 ${pct(p.grossRate)}・材料原価率 ${pct(p.materialRate)}) / 人件費 ${yen(p.labor)} / 店舗独自経費 ${yen(p.ownExpense)} / 共通経費の案分額 ${yen(p.allocated)} / その他 ${yen(p.otherMgmt)} / 店舗の損益 ${yen(p.profit)}${p.provisional.length ? ` 【暫定: ${p.provisional.join("・")}】` : ""}`;
}

const shiftYear = (d: string, n: number) => `${Number(d.slice(0, 4)) + n}${d.slice(4)}`;

export function managementAccounting(db: Database, user: User, args: { view?: string; from?: string; to?: string; store?: string; month?: string }, today: string): string {
  if (!canViewMgmt(user)) return "管理会計 (店舗別損益・原価) は 店長・本部スタッフ・管理者 が見られます。この質問には答えられません。";
  const visible = mgmtStores(user);
  const isDate = (v?: string) => /^\d{4}-\d{2}-\d{2}$/.test(v ?? "");
  const from = isDate(args.from) ? args.from! : `${today.slice(0, 4)}-01-01`;
  const to = isDate(args.to) ? args.to! : today;
  const store = args.store ? db.stores.find((s) => s.id === args.store || s.name.includes(args.store!) || args.store!.includes(s.shortName)) : undefined;
  if (store && visible && !visible.includes(store.id)) return `${store.name}の管理会計は見られません (自店舗だけ)。`;
  const storeIds = store ? [store.id] : visible;
  const view = (args.view ?? "store_pnl") as MgmtView;
  const head = (basis: string) => `対象期間 ${from}〜${to}・金額は${basis}・範囲 ${store ? store.name : visible ? db.stores.find((s) => s.id === visible[0])?.name : "全店舗"}`;

  if (view === "store_pnl") {
    const r = storePnl(db, from, to, { storeIds });
    const prev = storePnl(db, shiftYear(from, -1), shiftYear(to, -1), { storeIds });
    const L = [`# 店舗別損益 (${head(r.basis)})`];
    L.push(`計算: 管理売上 = 外部売上 + 店舗間の調整 (合計 0) / 粗利益 = 管理売上 − 材料費 − 外注費 / 店舗の損益 = 粗利益 − 人件費 − 店舗独自経費 − 共通経費の案分額 − その他`);
    for (const s of r.stores) L.push(pnlLine(s));
    if (!storeIds) L.push(pnlLine(r.total));
    L.push("");
    L.push(`## 前年同期 (${shiftYear(from, -1)}〜${shiftYear(to, -1)}) との比較`);
    for (const s of r.stores) {
      const p = prev.stores.find((x) => x.storeId === s.storeId);
      if (!p) continue;
      L.push(`- ${s.storeName}: 管理売上 ${yen(p.mgmtSales)} → ${yen(s.mgmtSales)} (${yen(s.mgmtSales - p.mgmtSales)}) / 粗利益 ${yen(p.gross)} → ${yen(s.gross)} (${s.gross - p.gross >= 0 ? "+" : ""}${yen(s.gross - p.gross)}${s.gross < p.gross ? "・減少" : ""})`);
    }
    L.push("");
    L.push(`共通経費の案分: ${r.allocations.map((a) => `${a.month} ${a.status === "confirmed" ? "確定" : a.status === "held" ? `保留 (${a.holdReason})` : a.status === "provisional" ? "未確定 (計算のみ)" : "なし"}`).join(" / ") || "-"}`);
    L.push(`月次確定: ${r.closedMonths.length ? r.closedMonths.join("・") : "なし"} / 数字の状態: ${r.provisional ? "暫定を含む" : "確定の数字"}`);
    return L.join("\n");
  }

  if (view === "items") {
    const r = storePnl(db, from, to, { storeIds });
    const prev = storePnl(db, shiftYear(from, -1), shiftYear(to, -1), { storeIds });
    const L = [`# 品目別 (${head(r.basis)})`, "材料原価率 = 材料費 ÷ 売上 × 100 (売上 0 は計算不能)"];
    const keys = store ? [store.id] : storeIds ?? ["all"];
    for (const k of keys) {
      L.push(`## ${k === "all" ? "全社" : db.stores.find((s) => s.id === k)?.name}`);
      for (const c of itemCategories(db)) {
        const x = r.categories.find((y) => y.storeId === k && y.itemCategory === c.id);
        const p = prev.categories.find((y) => y.storeId === k && y.itemCategory === c.id);
        if (!x && !p) continue;
        L.push(`- ${c.name}: 売上 ${yen(x?.sales ?? 0)} (前年同期 ${yen(p?.sales ?? 0)}) / 材料費 ${yen(x?.material ?? 0)} / 外注費 ${yen(x?.outsource ?? 0)} / 粗利益 ${yen(x?.gross ?? 0)} / 材料原価率 ${pct(x?.materialRate ?? null)}`);
      }
    }
    if (!store && !storeIds) {
      L.push("## 店舗 × 品目 (売上・材料原価率)");
      for (const s of db.stores) {
        const rows = r.categories.filter((y) => y.storeId === s.id && (y.sales || y.material));
        if (rows.length) L.push(`- ${s.name}: ${rows.map((y) => `${y.name} ${yen(y.sales)} (原価率 ${pct(y.materialRate)})`).join(" / ")}`);
      }
    }
    L.push(`数字の状態: ${r.provisional ? "暫定を含む" : "確定の数字"}`);
    return L.join("\n");
  }

  if (view === "internal_orders") {
    const orders = new Map(db.orders.map((o) => [o.id, o]));
    const rows = db.salesAdjustments.filter((a) => {
      const d = adjustmentDate(db, a, orders);
      return d && d >= from && d <= to && (!storeIds || storeIds.includes(a.fromStoreId) || storeIds.includes(a.toStoreId));
    });
    const sum = new Map<string, { n: number; amount: number }>();
    for (const a of rows) {
      const k = `${ADJ_KIND_LABEL[a.kind]}: ${db.stores.find((s) => s.id === a.fromStoreId)?.name} ← ${db.stores.find((s) => s.id === a.toStoreId)?.name}`;
      const cur = sum.get(k) ?? sum.set(k, { n: 0, amount: 0 }).get(k)!;
      cur.n += a.reversalOf ? -1 : 1;
      cur.amount += a.amount;
    }
    const rate = (k: string) => `${ruleLabel(k, ruleAt(db, k, to).value)}${ruleAt(db, k, to).status === "provisional" ? " (暫定)" : ""}`;
    return [
      `# 店舗間の売上調整 (対象期間 ${from}〜${to}。受注にひも付く行は売上計上日で数える。金額は計上時の金額 (内部受注は${rate("internal.base")}))`,
      `配分率: 通常工事 ${rate("internal.rate.normal")} / リフォーム工事 ${rate("internal.rate.reform")} / 端数 ${rate("internal.rounding")}。依頼元 + ・施工店舗 − で、全社の外部売上は変わらない`,
      ...[...sum].map(([k, v]) => `- ${k}: ${v.n} 件 ${yen(v.amount)}`),
      rows.length ? "" : "この期間の調整はありません。",
      `取消しの行を含む (取消しは金額がマイナス)。暫定の行: ${rows.filter((a) => a.provisional).length} 件`,
    ].join("\n");
  }

  if (view === "allocation") {
    const month = /^\d{4}-\d{2}$/.test(args.month ?? "") ? args.month! : to.slice(0, 7);
    const run = confirmedRun(db, month);
    const p = previewAllocation(db, month);
    const name = (id: string) => db.stores.find((s) => s.id === id)?.name ?? id;
    const visibleRow = (id: string) => !visible || (visible as string[]).includes(id);
    if (run) return [`# 共通経費の案分 ${month} (確定 ${run.number}・${run.confirmedAt?.slice(0, 10)})`, `共通経費 ${yen(run.poolTotal)} / 方法 ${run.method === "manual_ratio" ? `指定の比率 (${run.methodReason})` : "基準の比率"} / 基準 ${ruleLabel("alloc.basis", run.rules["alloc.basis"]?.value ?? "gross")}`, ...run.results.filter((r) => visibleRow(r.storeId)).map((r) => `- ${name(r.storeId)}: 基準 ${yen(run.basis.find((b) => b.storeId === r.storeId)?.gross ?? 0)} / 率 ${(r.ratePpm / 10000).toFixed(2)}% / 案分額 ${yen(r.amount)}`), `合計 ${yen(run.results.reduce((a, r) => a + r.amount, 0))} (共通経費と一致)`, p.poolTotal !== run.poolTotal ? `注意: 確定後に共通経費が ${yen(p.poolTotal)} に変わっています (訂正が必要)` : ""].join("\n");
    return [`# 共通経費の案分 ${month} (未確定)`, `共通経費 ${yen(p.poolTotal)} / 状態 ${p.status === "held" ? `保留: ${p.holdReason}` : p.status === "empty" ? "案分する共通経費なし" : "計算のみ (管理者の確定待ち)"}`, ...p.results.filter((r) => visibleRow(r.storeId)).map((r) => `- ${name(r.storeId)}: 率 ${(r.ratePpm / 10000).toFixed(2)}% / 案分額 ${yen(r.amount)} (暫定)`)].join("\n");
  }

  if (view === "pending") {
    const inRange = (d: string) => d >= from && d <= to;
    const purchases = new Map(db.purchases.map((p) => [p.id, p]));
    const lines = db.purchaseLineAllocs.filter((a) => a.status !== "confirmed" && purchases.get(a.purchaseId) && inRange(purchases.get(a.purchaseId)!.invoiceDate) && (!storeIds || storeIds.includes(purchases.get(a.purchaseId)!.storeId)));
    const notAnalyzed = db.purchases.filter((p) => p.status !== "rejected" && inRange(p.invoiceDate) && (!storeIds || storeIds.includes(p.storeId)) && !db.purchaseLineAllocs.some((a) => a.purchaseId === p.id));
    const usage = countedUsageIndex(db);
    const review = [...usage.values()].flat().filter((u) => u.needsReview && (!storeIds || storeIds.includes(u.storeId)));
    const drafts = db.stockMoves.filter((m) => m.status === "draft" && (!storeIds || storeIds.includes(m.storeId)));
    const held: string[] = [];
    for (let d = new Date(`${from.slice(0, 7)}-01T00:00:00Z`); d.toISOString().slice(0, 7) <= to.slice(0, 7); d.setUTCMonth(d.getUTCMonth() + 1)) {
      const m = d.toISOString().slice(0, 7);
      if (isClosed(db, m) || confirmedRun(db, m)) continue;
      const p = previewAllocation(db, m, { rows: undefined });
      if (p.status === "held") held.push(`${m} (${p.holdReason})`);
      else if (p.status === "ok") held.push(`${m} (未確定)`);
    }
    return [
      `# 確認・確定が必要なもの (対象期間 ${from}〜${to})`,
      `- 仕入明細の振り分けが未確定: ${lines.length} 明細 (うち要確認 ${lines.filter((a) => a.status === "needs_review").length})${lines.slice(0, 8).map((a) => `\n  ・${purchases.get(a.purchaseId)?.number} ${a.lineNo} 行目 ${a.ocr.name} ${yen(a.ocr.amountExTax)} (税抜)${a.ai?.needsReview ? ` 要確認: ${a.ai.reason.split(" / ").filter((x) => x.startsWith("要確認")).join("・")}` : ""}`).join("")}`,
      `- まだ自動判定していない仕入: ${notAnalyzed.length} 件${notAnalyzed.slice(0, 5).map((p) => ` ${p.number}`).join("")}`,
      `- 要確認の材料原価 (畳床の仕様など): ${review.length} 行`,
      `- 申請中の在庫の移動: ${drafts.length} 件`,
      `- 共通経費の案分が未確定・保留の月: ${held.join(" / ") || "なし"}`,
      `画面: /management (仕入明細の振り分け・材料原価・在庫・共通経費の案分)`,
    ].join("\n");
  }

  if (view === "trend") {
    const L = [`# 月ごとの推移 (${to.slice(0, 7)} までの 12 か月・店舗別・${storePnl(db, from, to).basis})`];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1 - i, 1));
      const m = d.toISOString().slice(0, 7);
      const r = monthRange(m);
      const p = storePnl(db, r.from, r.to, { storeIds });
      L.push(`- ${m}: ${p.stores.map((s) => `${s.storeName} 管理売上 ${yen(s.mgmtSales)}・粗利益 ${yen(s.gross)}`).join(" / ")}${p.provisional ? " (暫定を含む)" : ""}`);
    }
    return L.join("\n");
  }

  // settings: 設定の値と状態 (未確定の項目)
  return [`# 管理会計の設定 (${to} 時点)`, ...Object.entries(RULE_DEFS).map(([k, d]) => {
    const v = ruleAt(db, k, to);
    return `- ${d.label}: ${ruleLabel(k, v.value)} (${v.status === "confirmed" ? "確認済み" : "暫定・未確定"}) 根拠: ${d.basis}`;
  })].join("\n");
}
