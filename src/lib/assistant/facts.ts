import "server-only";
import type { Database, Order, OrderAmounts, Product, QuoteItem } from "@/lib/db/types";
import { ITEM_KEY, taxRate } from "@/lib/sales-ledger";
import { compactName, orderStaffIndex } from "@/lib/order-staff";
import { AMOUNT_TO_CATEGORY, itemToAmountKey, lineItemCategory } from "@/lib/mgmt/categories";

/**
 * 売上の分析用データ (受注 1 件 = 1 行、明細 1 行 = 1 行)
 * ------------------------------------------------------------
 * - 受注: 売上計上日・店舗・顧客・担当・施工担当・種別ごとの金額 (OrderAmounts)・記録された原価 (畳原価 + 案件にひも付いた仕入)
 * - 明細: 販売管理ソフトから移行した受注は、経過メモの「明細 (税抜|税込): 畳 きずな 6×¥11,000=¥66,000 / …」を読む。
 *   システムで作った受注は見積 (金額が同じとき) または請求書の明細を使う。金額はすべて税込 (税抜の明細は当時の税率で換算)
 * - 担当者・施工担当: src/lib/order-staff.ts (経営ダッシュボードと同じ)。移行した受注は経過メモの「担当者欄」の 1 番目 = 担当・2 番目 = 施工担当
 *   (3 番目は伝票の入力者なので数えない)。システムで登録した受注は見積の担当者 (なければ受注の作成者)
 * データ (約 4 万 4 千件・明細 14 万行) は 1 回作ったらメモリに置き、受注・見積・仕入・請求の件数と更新日時が変わったときだけ作り直す
 */

export type AmountKey = keyof OrderAmounts;

export const AMOUNT_LABEL: Record<AmountKey, string> = {
  tatami: "畳",
  fusuma: "襖",
  shoji: "障子",
  amido: "網戸",
  curtain: "カーテン・ブラインド",
  cloth: "クロス",
  own: "自社商品・小売",
  misc: "諸経費・雑工事",
  discount: "値引",
};
export const AMOUNT_KEYS = Object.keys(AMOUNT_LABEL) as AmountKey[];

export interface ItemFact {
  cat: AmountKey;
  /** 品名 (分類つき。例: 畳 きずな / 網戸 18メッシュ 大) */
  product: string;
  qty: number;
  /** 税込の単価・金額 */
  unitPrice: number;
  amount: number;
  /** 管理会計の品目 (新システムの見積・請求の明細だけ。明細で選んだ品目 → 商品の品目 → 見積の種別。src/lib/mgmt/categories.ts) */
  mgmtCat?: string;
}

export interface OrderFact {
  id: string;
  number: string;
  /** 売上計上日 (施工完了)。未完了は空 */
  salesDate?: string;
  contractDate: string;
  status: Order["status"];
  storeId: Order["storeId"];
  customerId: string;
  title: string;
  total: number;
  amounts: OrderAmounts;
  /** 畳原価 (移行データの売上台帳) */
  tatamiCost: number;
  /** 案件にひも付いた仕入 (税込) */
  purchaseCost: number;
  /** 担当 (営業担当) の名前 (空白なし)。移行データは「担当者欄」の 1 番目、ほかは見積の担当者 (order-staff.ts) */
  staff: string[];
  /** 施工担当 (社員 ID。取込で社員と照合できた人) */
  workerIds: string[];
  /** 施工担当の名前 (社員は登録の名前、アカウントのない人は担当者欄の名前) */
  workerNames: string[];
  /** 地区 (顧客の地区 → 施工場所の先頭) */
  area: string;
  items: ItemFact[];
  /** 明細の出どころ */
  itemSource: "ledger" | "quote" | "invoice" | "none";
}

const EMPTY_AMOUNTS = (): OrderAmounts => ({ tatami: 0, fusuma: 0, shoji: 0, amido: 0, curtain: 0, cloth: 0, own: 0, misc: 0, discount: 0 });

const CATEGORY_TO_AMOUNT: Record<string, AmountKey> = { tatami: "tatami", fusuma: "fusuma", shoji: "shoji", amido: "amido", curtain: "curtain", cloth: "cloth", other: "misc" };

const num = (s: string) => Number(s.replace(/,/g, ""));
const ITEM_RE = /^(\S+)\s+(.*?)\s*(-?\d+(?:\.\d+)?)×¥(-?[\d,]+)=¥(-?[\d,]+)$/;

/** 経過メモの「明細 (税抜): …」を読む */
export function parseLedgerItems(body: string, date: string): ItemFact[] | null {
  const line = body.split("\n").find((l) => l.startsWith("明細 ("));
  if (!line) return null;
  const m = line.match(/^明細 \((税込|税抜)\):\s*(.*)$/);
  if (!m) return null;
  const factor = m[1] === "税込" ? 1 : 1 + taxRate(date);
  const out: ItemFact[] = [];
  for (const part of m[2].split(" / ")) {
    const x = part.trim().match(ITEM_RE);
    if (!x) continue;
    const head = x[1] === "-" ? "" : x[1];
    const cat = ITEM_KEY[head] ?? "misc";
    const name = x[2].trim();
    const qty = Number(x[3]);
    out.push({ cat, product: [head, name].filter(Boolean).join(" ") || "(品名なし)", qty, unitPrice: Math.round(num(x[4]) * factor), amount: Math.round(num(x[5]) * factor) });
  }
  return out;
}

function itemsFromQuote(items: QuoteItem[], taxIncluded: boolean | undefined, date: string, cat: AmountKey, products: Map<string, Product>, serviceCategory: Order["category"]): ItemFact[] {
  const factor = taxIncluded ? 1 : 1 + taxRate(date);
  return items.map((i) => {
    const product = i.productId ? products.get(i.productId) : undefined;
    const productKey = product ? (CATEGORY_TO_AMOUNT[product.category] ?? "misc") : undefined;
    const money = { qty: i.qty, unitPrice: Math.round(i.unitPrice * factor), amount: Math.round(i.amount * factor) };
    if (!product && !i.itemCategory && /値引/.test(i.name)) return { cat: "discount" as AmountKey, product: [AMOUNT_LABEL.discount, i.name, i.spec].filter(Boolean).join(" "), ...money };
    // 管理会計の品目 (明細で選んだ品目 → 商品の品目 → 見積の種別)。内訳のキーは、品目が既定と同じなら今まで通り (障子・網戸なども区別)、違えば品目に合うキー
    const defaultKey = productKey ?? cat;
    const mgmtCat = lineItemCategory(i, product, serviceCategory);
    const c: AmountKey = defaultKey !== "discount" && AMOUNT_TO_CATEGORY[defaultKey] === mgmtCat ? defaultKey : itemToAmountKey(mgmtCat);
    const label = [AMOUNT_LABEL[c], i.name, i.spec].filter(Boolean).join(" ");
    return { cat: c, product: label, ...money, mgmtCat };
  });
}

function areaOf(db: Database, o: Order, customerArea: Map<string, string>): string {
  const a = customerArea.get(o.customerId);
  if (a) return a;
  const site = (o.siteAddress ?? "").replace(/^熊本県/, "").trim();
  // 「熊本市東区保田窪2-1-21」→「熊本市東区保田窪」、「松木」→「松木」
  return site.replace(/[0-9０-９\-－‐ー].*$/, "").slice(0, 12);
}

function buildOrderFacts(db: Database): OrderFact[] {
  const staffIdx = orderStaffIndex(db);
  const customerArea = new Map((db.customers ?? []).filter((c) => c.area).map((c) => [c.id, c.area!]));
  const quoteById = new Map((db.quotes ?? []).map((q) => [q.id, q]));
  const products = new Map((db.products ?? []).map((p) => [p.id, p]));
  const invoiceByOrder = new Map((db.invoices ?? []).filter((i) => i.status !== "void" && i.items?.length).map((i) => [i.orderId, i]));
  const purchaseByOrder = new Map<string, number>();
  for (const p of db.purchases ?? []) if (p.orderId && p.status !== "rejected") purchaseByOrder.set(p.orderId, (purchaseByOrder.get(p.orderId) ?? 0) + p.amount);

  const out: OrderFact[] = [];
  for (const o of db.orders ?? []) {
    if (o.status === "cancelled") continue;
    const date = o.salesDate ?? o.contractDate;
    let items: ItemFact[] = [];
    let itemSource: OrderFact["itemSource"] = "none";
    for (const n of o.progressNotes) {
      if (!n.body.includes("明細 (")) continue;
      const parsed = parseLedgerItems(n.body, date);
      if (parsed?.length) {
        items = items.concat(parsed);
        itemSource = "ledger";
      }
    }
    const mainCat = CATEGORY_TO_AMOUNT[o.category] ?? "misc";
    if (!items.length) {
      const q = o.quoteId ? quoteById.get(o.quoteId) : undefined;
      const inv = invoiceByOrder.get(o.id);
      if (q && q.total === o.total && q.items.length) {
        items = itemsFromQuote(q.items, q.taxIncluded, date, mainCat, products, o.category);
        if (q.discount > 0) items.push({ cat: "discount", product: "値引", qty: 1, unitPrice: -Math.round(q.discount * (q.taxIncluded ? 1 : 1 + taxRate(date))), amount: -Math.round(q.discount * (q.taxIncluded ? 1 : 1 + taxRate(date))) });
        itemSource = "quote";
      } else if (inv?.items?.length) {
        items = itemsFromQuote(inv.items, inv.taxIncluded, date, mainCat, products, o.category);
        itemSource = "invoice";
      }
    }
    let amounts = o.amounts;
    if (!amounts) {
      amounts = EMPTY_AMOUNTS();
      if (items.length) {
        for (const i of items) amounts[i.cat] += i.amount;
        // 明細の合計と契約金額の差 (端数・値引き) は主な種別で調整する
        const diff = o.total - AMOUNT_KEYS.reduce((a, k) => a + amounts![k], 0);
        amounts[mainCat] += diff;
      } else amounts[mainCat] = o.total;
    }
    out.push({
      id: o.id,
      number: o.number,
      salesDate: o.salesDate,
      contractDate: o.contractDate,
      status: o.status,
      storeId: o.storeId,
      customerId: o.customerId,
      title: o.title,
      total: o.total,
      amounts,
      tatamiCost: o.tatamiCost ?? 0,
      purchaseCost: purchaseByOrder.get(o.id) ?? 0,
      staff: (() => {
        const keys = staffIdx.byOrder.get(o.id)?.sales ?? [];
        return keys.length ? keys.map((k) => compactName(staffIdx.label(k))) : ["(不明)"];
      })(),
      workerIds: o.workerIds,
      workerNames: (staffIdx.byOrder.get(o.id)?.workers ?? []).map((k) => staffIdx.label(k)),
      area: areaOf(db, o, customerArea),
      items,
      itemSource,
    });
  }
  return out;
}

const g = globalThis as typeof globalThis & { __ichijoyaSalesFacts?: { sig: string; facts: OrderFact[]; byId: Map<string, OrderFact> } };

function signature(db: Database): string {
  let latest = "";
  for (const o of db.orders ?? []) if (o.updatedAt > latest) latest = o.updatedAt;
  for (const p of db.purchases ?? []) if (p.updatedAt > latest) latest = p.updatedAt;
  let quoteLatest = "";
  for (const q of db.quotes ?? []) if (q.updatedAt > quoteLatest) quoteLatest = q.updatedAt;
  for (const i of db.invoices ?? []) if ((i.updatedAt ?? "") > quoteLatest) quoteLatest = i.updatedAt ?? "";
  const users = (db.users ?? []).map((u) => `${u.id}:${u.name}:${u.active ? 1 : 0}`).join(",");
  // 商品の種別・管理会計の品目が変わると明細の品目が変わる
  const products = (db.products ?? []).map((p) => `${p.id}:${p.category}:${p.mgmtCategory ?? ""}`).join(",");
  return [db.orders?.length, db.quotes?.length, db.purchases?.length, db.invoices?.length, latest, quoteLatest, users, products].join("|");
}

/** 売上の分析用データ (キャンセルを除く全受注。閲覧範囲の絞り込みは呼び出し側で行う) */
export function salesFacts(db: Database): { facts: OrderFact[]; byId: Map<string, OrderFact> } {
  const sig = signature(db);
  if (g.__ichijoyaSalesFacts?.sig === sig) return g.__ichijoyaSalesFacts;
  const facts = buildOrderFacts(db);
  g.__ichijoyaSalesFacts = { sig, facts, byId: new Map(facts.map((f) => [f.id, f])) };
  return g.__ichijoyaSalesFacts;
}
