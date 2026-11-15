import type { CapturedDocument } from "@/lib/db/types";

/**
 * 手書き見積書の読取の正確さ
 * ------------------------------------------------------------
 * AI が読み取ったままの値 (_ai) と、担当者が確認・修正して登録した値を項目ごとに比べる。
 * 実際の筆跡でどれだけ直しが必要だったかを、登録が増えるほど正確に把握できる
 */

const norm = (v: unknown): string => (v === undefined || v === null ? "" : Array.isArray(v) ? [...v].map(String).sort().join("|") : String(v).normalize("NFKC").replace(/[\s　]/g, ""));

export const ACCURACY_FIELDS: [string, string][] = [
  ["customerName", "氏名"],
  ["phone", "Tel"],
  ["siteAddress", "住所"],
  ["quoteDate", "日付"],
  ["totalTaxIncluded", "税込合計金額"],
  ["paymentMethod", "支払い方法"],
  ["pickupAt", "引取日時"],
  ["deliveryAt", "納品日時"],
  ["note", "備考"],
  ["fusumaPaper", "襖紙"],
];

export interface AccuracyStats {
  docs: number;
  fields: { key: string; label: string; checked: number; matched: number }[];
  items: { checked: number; name: number; qty: number; unitPrice: number; amount: number; rowCount: number };
}

export function accuracyStats(docs: CapturedDocument[]): AccuracyStats {
  const target = docs.filter((d) => d.kind === "handwritten_quote" && d.status === "confirmed" && d.extracted?._ai && d.extracted?._edited);
  const fields = ACCURACY_FIELDS.map(([key, label]) => ({ key, label, checked: 0, matched: 0 }));
  const items = { checked: 0, name: 0, qty: 0, unitPrice: 0, amount: 0, rowCount: 0 };
  for (const d of target) {
    const ai = d.extracted!._ai as Record<string, unknown>;
    const fin = d.extracted!;
    for (const f of fields) {
      if (norm(fin[f.key]) === "" && norm(ai[f.key]) === "") continue;
      f.checked++;
      if (norm(fin[f.key]) === norm(ai[f.key])) f.matched++;
    }
    const a = Array.isArray(ai.items) ? (ai.items as Record<string, unknown>[]) : [];
    const b = Array.isArray(fin.items) ? (fin.items as Record<string, unknown>[]) : [];
    if (a.length === b.length) items.rowCount++;
    for (let i = 0; i < b.length; i++) {
      items.checked++;
      const x = a[i] ?? {};
      if (norm(x.name) === norm(b[i].name)) items.name++;
      if (norm(x.qty) === norm(b[i].qty)) items.qty++;
      if (norm(x.unitPrice) === norm(b[i].unitPrice)) items.unitPrice++;
      if (norm(x.amount) === norm(b[i].amount)) items.amount++;
    }
  }
  return { docs: target.length, fields: fields.filter((f) => f.checked > 0), items };
}
