import type { Database, MaterialTransfer, StoreId } from "@/lib/db/types";
import { qtyTimesCost, round4 } from "./decimal";
import { correctionDate } from "./close";
import { costAt } from "./costing";

/**
 * 店舗間の材料移動 (原価の振替)
 * ------------------------------------------------------------
 * 店舗で仕入れて材料費にした材料 (襖紙・クロス・ベニアなど) を別の店舗へ渡したとき、渡した店舗の材料費を減らし、受け取った店舗の
 * 材料費を増やす (これまでの「材料移動」の表の襖材料などの欄。全社の材料費は変わらない)。
 * - 品目は使い道で選ぶ (例: ベニアを襖に使えば襖、リフォームに使えばリフォーム)。材料マスタの材料なら既定はその材料の品目
 * - 単価は 入力 → 材料マスタのその日の単価。金額 = 数量 × 単価 (円未満は四捨五入)
 * - 本部の在庫の材料 (畳表・畳縁・畳床) は在庫の移動で記録し、使ったときに原価にする (ここでは扱わない)
 * - アンケートのハガキ・タオルなど最終的に案分経費になるものは、材料移動ではなく案分経費として登録する
 * - 取消しは逆の行 (元の行は reversed)
 */

export interface TransferInput {
  date: string;
  fromStoreId: StoreId;
  toStoreId: StoreId;
  materialId?: string;
  name: string;
  itemCategory: string;
  qty: number;
  unitCost?: number;
  note?: string;
}

/** 入力を確かめて、単価・金額を決める (誤りなら理由) */
export function planTransfer(db: Pick<Database, "stores" | "materials" | "materialCosts">, input: TransferInput): { unitCost: number; amount: number; name: string; itemCategory: string } | string {
  if (!db.stores.some((s) => s.id === input.fromStoreId) || !db.stores.some((s) => s.id === input.toStoreId)) return "渡した店舗と受け取った店舗を選んでください。";
  if (input.fromStoreId === input.toStoreId) return "渡した店舗と受け取った店舗は別々に選んでください。";
  if (!(input.qty > 0)) return "数量は 0 より大きい数で入力してください。";
  const m = input.materialId ? db.materials.find((x) => x.id === input.materialId) : undefined;
  if (input.materialId && !m) return "材料が見つかりません。";
  const name = (input.name || m?.name || "").trim();
  if (!name) return "材料を選ぶか、品名を入力してください。";
  const itemCategory = input.itemCategory || m?.itemCategory || "";
  if (!itemCategory) return "品目 (使い道) を選んでください。";
  const unitCost = input.unitCost !== undefined && Number.isFinite(input.unitCost) ? input.unitCost : m ? costAt(db, m.id, input.date)?.unitCost : undefined;
  if (unitCost === undefined || !(unitCost >= 0)) return "単価を入力してください (材料マスタにその日の単価がありません)。";
  return { unitCost: round4(unitCost), amount: qtyTimesCost(round4(input.qty), round4(unitCost)), name, itemCategory };
}

/** 取消し (mutate の中で呼ぶ)。逆の行を足し、元の行に reversedBy を残す。確定した月は設定に従う */
export function reverseTransfer(db: Database, t: MaterialTransfer, input: { id: string; number: string; userId: string; now: string; today: string; reason: string }): MaterialTransfer | string {
  if (t.status !== "active" || t.reversalOf) return "この行は取り消せません (取消し済み、または取消しの行です)。";
  const date = correctionDate(db, t.date, input.today);
  if (date === null) return `${t.date.slice(0, 7)} は月次確定済みです。管理者が確定を解除してから取り消してください。`;
  const rev: MaterialTransfer = { ...t, id: input.id, number: input.number, date, reversalOf: t.id, reversedBy: undefined, note: `取消し: ${input.reason}`, createdBy: input.userId, createdAt: input.now };
  t.status = "reversed";
  t.reversedBy = rev.id;
  db.materialTransfers.push(rev);
  return rev;
}

export interface TransferSummaryRow {
  storeId: StoreId;
  /** 受け取った材料 (材料費 +) と渡した材料 (材料費 −)。品目ごと */
  received: Record<string, number>;
  sent: Record<string, number>;
  net: number;
}

/** 月の店舗ごとの材料移動の集計 (これまでの「材料移動」の表の店舗ごとの合計にあたる) */
export function transferSummary(db: Pick<Database, "materialTransfers" | "stores">, month: string): TransferSummaryRow[] {
  const rows = new Map<string, TransferSummaryRow>();
  const row = (id: StoreId) => rows.get(id) ?? rows.set(id, { storeId: id, received: {}, sent: {}, net: 0 }).get(id)!;
  for (const t of db.materialTransfers ?? []) {
    if (t.date.slice(0, 7) !== month) continue;
    const amt = t.reversalOf ? -t.amount : t.amount;
    const to = row(t.toStoreId);
    to.received[t.itemCategory] = (to.received[t.itemCategory] ?? 0) + amt;
    to.net += amt;
    const from = row(t.fromStoreId);
    from.sent[t.itemCategory] = (from.sent[t.itemCategory] ?? 0) + amt;
    from.net -= amt;
  }
  const order = db.stores.map((s) => s.id);
  return [...rows.values()].sort((a, b) => order.indexOf(a.storeId) - order.indexOf(b.storeId));
}
