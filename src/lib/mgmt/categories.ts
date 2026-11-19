import type { Database, ItemCategory, Order } from "@/lib/db/types";
import type { AmountKey, OrderFact } from "@/lib/assistant/facts";
import { apportion } from "./decimal";
import { ruleAt } from "./rules";

/**
 * 品目 (管理会計の 7 区分) と、受注の売上の品目別の内訳
 * ------------------------------------------------------------
 * 売上シートの集計と同じ区分: 畳 / 襖 (襖・障子・網戸) / リフォーム (雑工事・クロス) / カーテン類 / 自社商品 / その他 / 諸経費。
 * 品目の名前・並び・有効は db.itemCategories で変えられる (ID は固定。行がない間は既定の名前)
 */

export const DEFAULT_CATEGORIES: ItemCategory[] = [
  { id: "tatami", name: "畳", sort: 1, active: true },
  { id: "fusuma", name: "襖 (障子・網戸を含む)", sort: 2, active: true },
  { id: "reform", name: "リフォーム", sort: 3, active: true },
  { id: "curtain", name: "カーテン類", sort: 4, active: true },
  { id: "own", name: "自社商品", sort: 5, active: true },
  { id: "other", name: "その他", sort: 6, active: true },
  { id: "misc", name: "諸経費", sort: 7, active: true },
];

export const CATEGORY_IDS = DEFAULT_CATEGORIES.map((c) => c.id);

/** 品目の一覧 (設定の行で上書き。並び順) */
export function itemCategories(db: Pick<Database, "itemCategories">): ItemCategory[] {
  const saved = new Map((db.itemCategories ?? []).map((c) => [c.id, c]));
  const extra = (db.itemCategories ?? []).filter((c) => !CATEGORY_IDS.includes(c.id));
  return [...DEFAULT_CATEGORIES.map((c) => ({ ...c, ...saved.get(c.id) })), ...extra].sort((a, b) => a.sort - b.sort);
}

export function categoryName(db: Pick<Database, "itemCategories">, id: string): string {
  return itemCategories(db).find((c) => c.id === id)?.name ?? id;
}

/** 売上台帳の内訳 (OrderAmounts) → 品目 */
export const AMOUNT_TO_CATEGORY: Record<Exclude<AmountKey, "discount">, string> = {
  tatami: "tatami",
  fusuma: "fusuma",
  shoji: "fusuma",
  amido: "fusuma",
  cloth: "reform",
  curtain: "curtain",
  own: "own",
  misc: "misc",
};

/** 受注の種別 (ServiceCategory) → 品目 (内訳がない受注) */
export const ORDER_CATEGORY_TO_ITEM: Record<Order["category"], string> = {
  tatami: "tatami",
  fusuma: "fusuma",
  shoji: "fusuma",
  amido: "fusuma",
  curtain: "curtain",
  cloth: "reform",
  other: "other",
};

/** 値引を案分する品目 (売上シートの値引案分: カーテン・諸経費には案分しない) */
const DISCOUNT_TARGETS = ["tatami", "fusuma", "reform", "own"];

/**
 * 受注 1 件の品目別の売上 (税込・円)。合計は受注の金額と一致する。
 * - 内訳は facts.ts (売上台帳の内訳 → 明細 → 見積・請求の明細の順) を使う
 * - 販売管理ソフトの「雑工事」の明細は諸経費ではなくリフォームに入れる (売上シートの「雑工事・クロス」)
 * - 品目の指定がない値引は設定 category.discount に従う
 */
export function orderCategorySales(db: Pick<Database, "mgmtRules">, order: Pick<Order, "total" | "category" | "amounts">, fact: Pick<OrderFact, "amounts" | "items" | "itemSource"> | undefined, date: string): Record<string, number> {
  const out: Record<string, number> = {};
  const add = (k: string, v: number) => {
    if (v) out[k] = (out[k] ?? 0) + v;
  };
  if (!fact || (!order.amounts && fact.itemSource === "none")) {
    add(ORDER_CATEGORY_TO_ITEM[order.category] ?? "other", order.total);
    return out;
  }
  const a = fact.amounts;
  for (const [k, cat] of Object.entries(AMOUNT_TO_CATEGORY)) add(cat, Math.round(a[k as AmountKey] ?? 0));
  // 雑工事 (販売管理ソフトの明細) は諸経費からリフォームへ
  const zatsu = fact.items.filter((i) => i.cat === "misc" && i.product.startsWith("雑工事")).reduce((s, i) => s + i.amount, 0);
  const shift = Math.max(0, Math.min(zatsu, out.misc ?? 0));
  if (shift) {
    add("misc", -shift);
    add("reform", shift);
  }
  const discount = Math.round(a.discount ?? 0);
  if (discount) {
    const mode = ruleAt(db, "category.discount", date).value;
    const weights = DISCOUNT_TARGETS.map((c) => Math.max(0, out[c] ?? 0));
    if (mode === "share4" && weights.some((w) => w > 0)) {
      apportion(discount, weights).forEach((v, i) => add(DISCOUNT_TARGETS[i], v));
    } else add("other", discount);
  }
  // 端数の差 (内訳の合計と受注の金額の差) は一番大きい品目で調整する
  const sum = Object.values(out).reduce((s, v) => s + v, 0);
  if (sum !== order.total) {
    const main = Object.entries(out).sort((x, y) => y[1] - x[1])[0]?.[0] ?? ORDER_CATEGORY_TO_ITEM[order.category] ?? "other";
    add(main, order.total - sum);
  }
  for (const k of Object.keys(out)) if (!out[k]) delete out[k];
  return out;
}

/** 受注の主な品目 (金額の一番大きい品目) */
export function mainCategory(sales: Record<string, number>, fallback: string): string {
  return Object.entries(sales).sort((x, y) => y[1] - x[1])[0]?.[0] ?? fallback;
}
