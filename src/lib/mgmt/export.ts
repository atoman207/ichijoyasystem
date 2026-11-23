import type { Database } from "@/lib/db/types";
import { storePnl } from "./pnl";
import { METRIC_LABEL } from "./ledger";
import { categoryName } from "./categories";
import { compareStoreIds } from "@/lib/store-order";

/**
 * 管理会計の CSV (税理士へ渡す資料・社内の確認用)
 * ------------------------------------------------------------
 * - pnl: 店舗別損益 / items: 店舗 × 品目の売上・材料費・外注費・粗利益・材料原価率
 * - moves: 店舗間の振り分け (内部受注・本部の特殊配分・手入力の調整・店舗間の材料移動・畳表の差額・共通経費の案分)。
 *   これまで税理士に渡していた「材料移動」の表に当たる
 * - ledger: 元帳の全行 (どの記録から来た数字か = 計算の根拠)
 * 金額は画面と同じ計算 (storePnl)。storeIds を渡すとその店舗の行だけ
 */

export const MGMT_EXPORTS = {
  pnl: "店舗別損益",
  items: "品目別 (店舗 × 品目)",
  moves: "店舗間の振り分け (内部受注・材料移動・畳表の差額・案分)",
  ledger: "元帳 (計算の根拠)",
} as const;
export type MgmtExport = keyof typeof MGMT_EXPORTS;

const MOVE_KINDS = new Set(["adjustment", "material_transfer", "allocation", "allocation_preview"]);

export function mgmtExportRows(db: Database, kind: MgmtExport, from: string, to: string, storeIds?: string[]): (string | number | null)[][] {
  const r = storePnl(db, from, to, { storeIds });
  const head = [`期間 ${from}〜${to}`, `金額: ${r.basis}`, r.provisional ? "暫定を含む" : "確定の数字", r.closedMonths.length ? `月次確定: ${r.closedMonths.join("・")}` : "月次確定なし"];
  if (kind === "pnl") {
    const rows: (string | number | null)[][] = [head, ["店舗", "外部売上", "内部受注の配分", "本部の特殊配分", "手入力の売上調整", "管理売上", "材料費", "外注費", "粗利益", "人件費", "店舗独自経費", "共通経費の案分額", "その他管理経費", "店舗の損益", "材料原価率 (%)", "粗利率 (%)", "暫定の理由"]];
    for (const s of [...r.stores, ...(storeIds ? [] : [r.total])]) {
      rows.push([s.storeName, s.externalSales, s.adjInternal, s.adjHq, s.adjManual, s.mgmtSales, s.material, s.outsource, s.gross, s.labor, s.ownExpense, s.allocated, s.otherMgmt, s.profit, s.materialRate, s.grossRate, s.provisional.join(" / ")]);
    }
    return rows;
  }
  if (kind === "items") {
    const rows: (string | number | null)[][] = [head, ["店舗", "品目", "売上 (管理売上)", "材料費", "外注費", "粗利益", "材料原価率 (%)"]];
    // 店舗を絞ったときは「全社」の行を出さない (その店舗だけの合計を全社と誤解しないように)
    for (const c of r.categories) {
      if (c.storeId === "all" && storeIds) continue;
      rows.push([c.storeId === "all" ? "全社" : (db.stores.find((s) => s.id === c.storeId)?.name ?? c.storeId), c.name, c.sales, c.material, c.outsource, c.gross, c.materialRate]);
    }
    return rows;
  }
  const filter = kind === "moves" ? (x: (typeof r.rows)[number]) => MOVE_KINDS.has(x.source.kind) || (x.source.kind === "entry" && /畳表の差額|広告宣伝費の予算超過/.test(x.source.label)) : () => true;
  const rows: (string | number | null)[][] = [head, ["日付", "月", "店舗", "指標", "品目", "金額", "元の記録", "記録の ID", "暫定の理由"]];
  for (const x of r.rows.filter(filter).sort((a, b) => a.date.localeCompare(b.date) || compareStoreIds(a.storeId, b.storeId))) {
    rows.push([x.date, x.month, db.stores.find((s) => s.id === x.storeId)?.name ?? x.storeId, METRIC_LABEL[x.metric], categoryName(db, x.itemCategory), x.amount, x.source.label, x.source.id, x.provisional ?? ""]);
  }
  return rows;
}
