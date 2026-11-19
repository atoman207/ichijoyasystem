import type { Bom, BomLine, Database, Material, MaterialCost, MaterialKind, MaterialUsage, Order } from "@/lib/db/types";
import type { OrderFact } from "@/lib/assistant/facts";
import { qtyTimesCost, round4 } from "./decimal";
import { ruleAt, prevDay } from "./rules";
import { ORDER_CATEGORY_TO_ITEM, AMOUNT_TO_CATEGORY } from "./categories";

/**
 * 材料原価 (材料マスタ・原価単価の履歴・材料構成 (BOM)・材料の使用)
 * ------------------------------------------------------------
 * - 原価は「使用数量 × その日の単価」。単価を変えるときは新しい行を足す (確定した使用の行は当時の単価の写しを持つため変わらない)
 * - 材料構成は商品 1 単位 (畳 1 枚) あたりの使用量。半畳は材料ごとの係数で表す (主材料 0.5・副資材 1 など)
 * - 副資材は設定 sub_material.unit_cost (畳 1 枚あたり。半畳も 1 枚) で計算する
 * - 畳床は商品名だけでは決まらない: 製造仕様 (種類・厚み・規格) で材料を選ぶ。選ばれていない行は「要確認」で、原価に推測の金額を入れない
 * - 段階: estimate (見積の予想原価) → planned (施工・製造の使用予定) → actual (使用実績)。受注ごとに一番進んだ段階の行だけを原価に数える
 */

export const MATERIAL_KIND_LABEL: Record<MaterialKind, string> = {
  omote: "畳表 (い草)",
  chem_omote: "化学畳表",
  heri: "畳縁",
  doko: "畳床",
  sub: "副資材",
  cloth: "クロス・壁紙",
  paper: "襖紙・障子紙",
  other: "その他の材料",
};

export const STAGE_LABEL: Record<MaterialUsage["stage"], string> = { estimate: "予想原価 (見積)", planned: "使用予定 (施工・製造)", actual: "実績" };
const STAGE_RANK: Record<MaterialUsage["stage"], number> = { estimate: 1, planned: 2, actual: 3 };

export const SIZE_LABEL: Record<string, string> = { gohachi: "五八間 (江戸間)", rokuichi: "六一間", rokumaru: "六〇間", honma: "本間 (京間)", other: "その他" };

/** その日の単価 (なければ undefined) */
export function costAt(db: Pick<Database, "materialCosts">, materialId: string, date: string): MaterialCost | undefined {
  return (db.materialCosts ?? [])
    .filter((c) => c.materialId === materialId && c.validFrom <= date && (!c.validTo || date <= c.validTo))
    .sort((a, b) => b.validFrom.localeCompare(a.validFrom) || b.createdAt.localeCompare(a.createdAt))[0];
}

/** 単価を変える (mutate の中で呼ぶ)。前の行は開始日の前日で閉じる (行は消さない) */
export function setMaterialCost(db: Database, input: { materialId: string; unitCost: number; kind: MaterialCost["kind"]; validFrom: string; note?: string }, userId: string, id: string, now: string): MaterialCost {
  const F = input.validFrom;
  const same = db.materialCosts.filter((c) => c.materialId === input.materialId);
  const later = same.filter((c) => c.validFrom > F && (!c.validTo || c.validTo >= c.validFrom)).sort((a, b) => a.validFrom.localeCompare(b.validFrom))[0];
  for (const c of same) if (c.validFrom <= F && (!c.validTo || c.validTo >= F)) c.validTo = prevDay(F);
  const row: MaterialCost = { id, materialId: input.materialId, unitCost: round4(input.unitCost), kind: input.kind, validFrom: F, note: input.note, createdBy: userId, createdAt: now };
  if (later) row.validTo = prevDay(later.validFrom);
  db.materialCosts.push(row);
  return row;
}

const activeBom = (b: Bom, date: string) => b.validFrom <= date && (!b.validTo || date <= b.validTo);

/** 商品 (商品マスタの ID) または品名に合う材料構成。品名は matchName を含むもののうち一番長く一致したもの */
export function bomFor(db: Pick<Database, "boms">, productId: string | undefined, label: string, date: string): Bom | undefined {
  const boms = (db.boms ?? []).filter((b) => activeBom(b, date));
  if (productId) {
    const b = boms.find((x) => x.productId === productId);
    if (b) return b;
  }
  const t = label.replace(/[\s　]/g, "");
  return boms
    .filter((b) => b.matchName && t.includes(b.matchName.replace(/[\s　]/g, "")))
    .sort((a, b) => (b.matchName?.length ?? 0) - (a.matchName?.length ?? 0))[0];
}

/** 原価を計算する明細 (商品・品名・数量)。見積から受注した受注は見積の明細、移行した受注は売上台帳の明細 */
export interface CostingLine {
  key: string;
  productId?: string;
  label: string;
  qty: number;
  itemCategory: string;
}

export function costingLines(db: Pick<Database, "quotes" | "products">, order: Pick<Order, "quoteId" | "category" | "total">, fact: Pick<OrderFact, "items" | "itemSource" | "total"> | undefined): CostingLine[] {
  const q = order.quoteId ? db.quotes.find((x) => x.id === order.quoteId) : undefined;
  if (q && q.items.length) {
    const products = new Map(db.products.map((p) => [p.id, p]));
    return q.items
      .filter((i) => i.qty > 0)
      .map((i) => ({ key: i.id, productId: i.productId, label: [i.name, i.spec].filter(Boolean).join(" "), qty: i.qty, itemCategory: ORDER_CATEGORY_TO_ITEM[products.get(i.productId ?? "")?.category ?? order.category] ?? "other" }));
  }
  return (fact?.items ?? [])
    .filter((i) => i.qty > 0 && i.cat !== "discount")
    .map((i, n) => ({ key: `item${n}`, label: i.product, qty: i.qty, itemCategory: AMOUNT_TO_CATEGORY[i.cat as keyof typeof AMOUNT_TO_CATEGORY] ?? "other" }));
}

/** 畳床などの製造仕様 (明細ごとに選んだ材料) */
export type SpecChoice = Record<string, { materialId: string; dokoType?: string; thickness?: number; size?: string }>;

export interface PlannedUsage extends Omit<MaterialUsage, "id" | "createdBy" | "createdAt" | "status" | "stage" | "source" | "date" | "storeId" | "orderId"> {
  lineKey: string;
  /** 計算の説明 */
  explain: string;
}

/**
 * 明細と材料構成から、使う材料と原価を計算する (保存はしない)。
 * - 材料の単価・副資材の単価は date の日の値
 * - 畳床 (材料の決まっていない行) は spec で選んだ材料を使う。選ばれていなければ要確認 (金額なし)
 * - 材料構成のない畳の明細は要確認 (畳以外の明細で材料構成がないものは、仕入の振り分けで原価を計上するため対象外)
 */
export function planUsage(db: Database, lines: CostingLine[], date: string, spec: SpecChoice = {}): { usages: PlannedUsage[]; unmatched: CostingLine[] } {
  const materials = new Map((db.materials ?? []).map((m) => [m.id, m]));
  const usages: PlannedUsage[] = [];
  const unmatched: CostingLine[] = [];
  const sub = ruleAt(db, "sub_material.unit_cost", date);
  for (const line of lines) {
    const bom = bomFor(db, line.productId, line.label, date);
    if (!bom) {
      if (line.itemCategory === "tatami") unmatched.push(line);
      continue;
    }
    bom.lines.forEach((bl: BomLine, idx: number) => {
      const qty = round4(Number(line.qty) * Number(bl.qty));
      const base = { lineKey: `${line.key}:${idx}`, materialKind: bl.materialKind, qty, bomId: bom.id, productLabel: line.label, sheets: line.qty };
      if (bl.materialKind === "sub" && !bl.materialId) {
        const unit = Number(sub.value);
        usages.push({ ...base, itemCategory: line.itemCategory, unitCost: unit, costId: sub.ruleId ?? "default:sub_material.unit_cost", amount: qtyTimesCost(qty, unit), explain: `副資材 ${unit} 円 × ${qty}` });
        return;
      }
      const chosen = bl.materialId ? undefined : spec[`${line.key}:${idx}`] ?? spec[line.key];
      const m: Material | undefined = bl.materialId ? materials.get(bl.materialId) : chosen ? materials.get(chosen.materialId) : undefined;
      if (!m) {
        usages.push({ ...base, itemCategory: line.itemCategory, needsReview: true, reviewNote: bl.materialId ? "材料構成の材料が材料マスタにありません" : `${MATERIAL_KIND_LABEL[bl.materialKind]}の仕様 (種類・厚み・規格) を選んでください`, explain: "要確認 (原価に入れていません)" });
        return;
      }
      const c = costAt(db, m.id, date);
      if (!c) {
        usages.push({ ...base, materialId: m.id, itemCategory: m.itemCategory || line.itemCategory, needsReview: true, reviewNote: `${m.name}の ${date} 時点の単価がありません`, explain: "要確認 (単価なし)" });
        return;
      }
      usages.push({
        ...base,
        materialId: m.id,
        itemCategory: m.itemCategory || line.itemCategory,
        unitCost: c.unitCost,
        costId: c.id,
        amount: qtyTimesCost(qty, c.unitCost),
        spec: chosen ? { dokoType: chosen.dokoType ?? m.spec, thickness: chosen.thickness ?? m.thickness, size: chosen.size ?? m.size } : undefined,
        explain: `${m.name} ${c.unitCost.toLocaleString("ja-JP")} 円${c.kind === "provisional" ? " (仮原価)" : ""} × ${qty}${Number(bl.qty) !== 1 ? ` (係数 ${bl.qty})` : ""}`,
      });
    });
  }
  return { usages, unmatched };
}

/** 受注の原価に数える使用の行 (一番進んだ段階の、有効な行) */
export function countedUsages(db: Pick<Database, "materialUsages">, orderId: string): MaterialUsage[] {
  const rows = (db.materialUsages ?? []).filter((u) => u.orderId === orderId && u.status === "active");
  if (!rows.length) return [];
  const top = Math.max(...rows.map((u) => STAGE_RANK[u.stage]));
  return rows.filter((u) => STAGE_RANK[u.stage] === top);
}

/** 受注ごとの数える使用の行 (全件を 1 回で) */
export function countedUsageIndex(db: Pick<Database, "materialUsages">): Map<string, MaterialUsage[]> {
  const byOrder = new Map<string, MaterialUsage[]>();
  for (const u of db.materialUsages ?? []) if (u.status === "active") (byOrder.get(u.orderId) ?? byOrder.set(u.orderId, []).get(u.orderId)!).push(u);
  const out = new Map<string, MaterialUsage[]>();
  for (const [id, rows] of byOrder) {
    const top = Math.max(...rows.map((u) => STAGE_RANK[u.stage]));
    out.set(id, rows.filter((u) => STAGE_RANK[u.stage] === top));
  }
  return out;
}

/**
 * 使用の行を登録する (mutate の中で呼ぶ)。同じ受注の、同じか前の段階の有効な行は superseded にする
 * (実績の行を入れ直すときは前の実績の行を reversed にする)。行は消さない
 */
export function recordUsages(db: Database, order: Pick<Order, "id" | "storeId">, storeId: Order["storeId"], stage: MaterialUsage["stage"], planned: PlannedUsage[], input: { userId: string; now: string; date: string; source: MaterialUsage["source"]; makeId: () => string }): MaterialUsage[] {
  for (const u of db.materialUsages) {
    if (u.orderId !== order.id || u.status !== "active") continue;
    if (STAGE_RANK[u.stage] < STAGE_RANK[stage]) u.status = "superseded";
    else if (u.stage === stage) u.status = stage === "actual" ? "reversed" : "superseded";
  }
  const rows: MaterialUsage[] = planned.map((p) => ({
    id: input.makeId(),
    orderId: order.id,
    storeId,
    materialId: p.materialId,
    materialKind: p.materialKind,
    itemCategory: p.itemCategory,
    qty: p.qty,
    unitCost: p.unitCost,
    costId: p.costId,
    amount: p.amount,
    stage,
    source: input.source,
    bomId: p.bomId,
    productLabel: p.productLabel,
    sheets: p.sheets,
    spec: p.spec,
    needsReview: p.needsReview,
    reviewNote: p.reviewNote,
    status: "active",
    date: input.date,
    createdBy: input.userId,
    createdAt: input.now,
    ...(stage === "actual" ? { confirmedBy: input.userId, confirmedAt: input.now } : {}),
  }));
  db.materialUsages.push(...rows);
  return rows;
}
