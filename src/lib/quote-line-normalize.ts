import type { Database, QuoteItem } from "@/lib/db/types";
import { autoItemCategory, autoUnit } from "@/lib/line-kind";
import { isItemCategory, SERVICE_TO_ITEM } from "@/lib/mgmt/categories";

/**
 * 登録済みの見積の明細の単位・管理会計の品目を、品名・仕様からそろえる
 * (お客様のご要望 2026-11-23「■1」: 「単位に関しては今日登録したものも反映してほしい」。見積の明細の入力と同じ判定 src/lib/line-kind.ts)
 * - 単位: 数を数える単位 (式・面・枚・畳・個・ヶ所…) を、品名・仕様から決まる単位に (m・㎡ など長さ・面積の単位は変えない)
 * - 品目: 商品マスタから選んでいない行で品目が空 (自動) のとき、品名・仕様から決まる品目が見積の種別の品目と違えば入れる
 *   (例: 畳の見積の「襖」の行 → 襖 (障子・網戸を含む))。手で選んだ品目は変えない
 * 金額・数量・品名は変えない。同じ受注の請求書の同じ明細 (行数・品名・金額が同じ) にもそろえる
 */

/** 数を数える単位 (品名・仕様から選び直してよい単位。QuoteEditor の SOFT_UNITS と同じ) */
const SOFT_UNITS = new Set(["", "式", "一式", "面", "枚", "畳", "帖", "個", "ヶ所", "箇所", "本"]);

export interface LineFix {
  quoteId: string;
  number: string;
  line: number;
  name: string;
  field: "unit" | "itemCategory";
  before?: string;
  after: string;
}

function fixItem(db: Pick<Database, "products" | "itemCategories">, it: QuoteItem, serviceCategory: string): { unit?: string; itemCategory?: string } {
  const pc = it.productId ? db.products.find((p) => p.id === it.productId)?.category : undefined;
  const out: { unit?: string; itemCategory?: string } = {};
  const u = autoUnit(it.name, it.spec, pc);
  if (u && u !== it.unit && SOFT_UNITS.has((it.unit ?? "").trim())) out.unit = u;
  if (!it.productId && !it.itemCategory) {
    const c = autoItemCategory(it.name, it.spec);
    const fallback = SERVICE_TO_ITEM[serviceCategory as keyof typeof SERVICE_TO_ITEM] ?? "other";
    if (c && c !== fallback && isItemCategory(db, c)) out.itemCategory = c;
  }
  return out;
}

/** 直す内容 (見積の作成日時 createdAt が from 以上 to 未満。ISO の日時) */
export function planLineFixes(db: Pick<Database, "quotes" | "products" | "itemCategories">, range: { from: string; to: string }): LineFix[] {
  const out: LineFix[] = [];
  for (const q of db.quotes) {
    if (q.createdAt < range.from || q.createdAt >= range.to) continue;
    q.items.forEach((it, k) => {
      const f = fixItem(db, it, q.category);
      if (f.unit) out.push({ quoteId: q.id, number: q.number, line: k + 1, name: `${it.name}${it.spec ? ` ${it.spec}` : ""}`, field: "unit", before: it.unit, after: f.unit });
      if (f.itemCategory) out.push({ quoteId: q.id, number: q.number, line: k + 1, name: `${it.name}${it.spec ? ` ${it.spec}` : ""}`, field: "itemCategory", before: it.itemCategory, after: f.itemCategory });
    });
  }
  return out;
}

/** 直す (mutate の中で呼ぶ)。直した見積の ID ごとの内容を返す */
export function applyLineFixes(db: Database, fixes: LineFix[], now: string): Map<string, LineFix[]> {
  const byQuote = new Map<string, LineFix[]>();
  for (const f of fixes) byQuote.set(f.quoteId, [...(byQuote.get(f.quoteId) ?? []), f]);
  for (const [quoteId, list] of byQuote) {
    const q = db.quotes.find((x) => x.id === quoteId);
    if (!q) {
      byQuote.delete(quoteId);
      continue;
    }
    for (const f of list) {
      const it = q.items[f.line - 1];
      if (!it || (it[f.field] ?? "") !== (f.before ?? "")) continue;
      if (f.field === "unit") it.unit = f.after;
      else it.itemCategory = f.after;
    }
    q.updatedAt = now;
    // 同じ受注の請求書の同じ明細にもそろえる
    const orderIds = new Set([q.orderId, ...db.orders.filter((o) => o.quoteId === q.id).map((o) => o.id)].filter(Boolean));
    for (const inv of db.invoices.filter((i) => orderIds.has(i.orderId) && i.items?.length === q.items.length)) {
      if (!inv.items!.every((x, k) => x.name === q.items[k].name && x.amount === q.items[k].amount)) continue;
      inv.items!.forEach((x, k) => {
        x.unit = q.items[k].unit;
        if (q.items[k].itemCategory) x.itemCategory = q.items[k].itemCategory;
      });
      inv.updatedAt = now;
    }
  }
  return byQuote;
}
