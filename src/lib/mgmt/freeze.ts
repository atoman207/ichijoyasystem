import type { Database } from "@/lib/db/types";
import { salesFacts } from "@/lib/assistant/facts";
import { monthRange } from "./allocation";
import { countedUsageIndex, recordUsages } from "./costing";
import { lineItemCategory, orderLineSource, syncInvoiceLineCategories } from "./categories";
import { productionNoteIndex } from "./doko";
import { orderAutoCost, purchaseMaterialCoverage } from "./ledger";

/**
 * 月次確定のときに、その月の計算の元を固定する (mutate の中で呼ぶ)
 * ------------------------------------------------------------
 * 自動で決まる値 (材料構成からの自動計算の材料原価・「自動」の明細の品目) は、あとから材料マスタ・材料構成・商品の品目・製造の予定を
 * 変えると変わってしまう。確定した月の数字が変わらないように、確定のときに
 * - 原価の行を登録していない受注の自動計算の材料原価を、材料の使用の行 (実績・source = bom) として保存する (その日の単価の写し)
 * - 見積・請求書の明細で品目が「自動」の行に、その時の品目を書く
 * 元帳は確定した月の受注を自動計算しない (ledger.ts)。確定を解除しても保存した行は残る (訂正は材料原価のタブで登録し直す)
 */
export function freezeMonth(db: Database, month: string, input: { userId: string; now: string; makeId: () => string }): { orders: number; usages: number; lines: number } {
  const { from, to } = monthRange(month);
  const { byId } = salesFacts(db);
  const notes = productionNoteIndex(db);
  const coverage = purchaseMaterialCoverage(db);
  const used = countedUsageIndex(db);
  const products = new Map(db.products.map((p) => [p.id, p]));
  let orders = 0;
  let usages = 0;
  let lines = 0;
  for (const o of db.orders) {
    if (o.status === "cancelled" || !o.salesDate || o.salesDate < from || o.salesDate > to) continue;
    // 明細の品目 (「自動」の行に今の品目を書く)
    const src = orderLineSource(db, o);
    if (src) {
      let changed = false;
      for (const it of src.items) {
        if (it.itemCategory) continue;
        it.itemCategory = lineItemCategory(it, it.productId ? products.get(it.productId) : undefined, o.category);
        changed = true;
        lines++;
      }
      if (changed) {
        src.record.updatedAt = input.now;
        if (src.kind === "quote") syncInvoiceLineCategories(db, o.id, src.items, input.now);
      }
    }
    // 自動計算の材料原価を行として保存する
    if (used.get(o.id)?.length || o.tatamiCost) continue;
    const auto = orderAutoCost(db, o, byId.get(o.id), { notes, coverage });
    if (!auto || auto.stopped || !auto.usages.length) continue;
    const rows = recordUsages(db, o, auto.storeId, "actual", auto.usages, { userId: input.userId, now: input.now, date: o.salesDate, source: "bom", makeId: input.makeId });
    orders++;
    usages += rows.length;
  }
  return { orders, usages, lines };
}
