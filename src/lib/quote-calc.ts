/**
 * 見積の合計 (内税・外税・非課税の 3 つの書き方)
 * ------------------------------------------------------------
 * - 内税 (税込。見積の標準。お客様のご要望 2026-11-24「① 見積書の消費税表示」・手書き見積書の「税込」):
 *   単価・小計は税込。合計 = 小計 − 値引き。消費税は内税 = 合計 × 10/110 (切り捨て)
 * - 外税 (税抜。業者様への見積など): 小計 = 明細の合計 (税抜)。消費税 = (小計 − 値引き) × 10% (切り捨て)。合計 = 小計 − 値引き + 消費税
 * - 非課税 (業者様への見積など): 消費税 0。合計 = 小計 − 値引き
 * どれも 税抜の金額 = 合計 − 消費税 (売上・請求書の 10% 対象額。非課税は合計のまま)
 * 値引きの行 (単価がマイナス) は明細の合計に含める
 */

export const TAX_RATE = 0.1;

/** included = 内税 (税込) / excluded = 外税 (税抜) / exempt = 非課税 */
export type TaxMode = "included" | "excluded" | "exempt";

export const TAX_MODE_LABEL: Record<TaxMode, string> = { included: "内税 (税込)", excluded: "外税 (税抜)", exempt: "非課税" };

/** 記録 (見積・請求書・変更の申請) の税の書き方。taxExempt が優先 */
export function taxModeOf(x: { taxIncluded?: boolean; taxExempt?: boolean } | undefined): TaxMode {
  if (x?.taxExempt) return "exempt";
  return x?.taxIncluded ? "included" : "excluded";
}

/** フォームの値 (taxMode = included / excluded / exempt。古いフォームは taxIncluded = "1") */
export function parseTaxMode(raw: { taxMode?: string | null; taxIncluded?: string | null }): TaxMode {
  if (raw.taxMode === "included" || raw.taxMode === "excluded" || raw.taxMode === "exempt") return raw.taxMode;
  return raw.taxIncluded === "1" ? "included" : "excluded";
}

/** 記録に書く値 (内税 = taxIncluded、非課税 = taxExempt。外税はどちらもなし) */
export function taxFields(mode: TaxMode): { taxIncluded?: true; taxExempt?: true } {
  return mode === "included" ? { taxIncluded: true } : mode === "exempt" ? { taxExempt: true } : {};
}

export interface QuoteTotals {
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
}

/** mode: TaxMode か、以前の書き方の true (内税) / false (外税) */
export function quoteTotals(items: { amount: number }[], discount: number, mode: TaxMode | boolean = false): QuoteTotals {
  const m: TaxMode = mode === true ? "included" : mode === false ? "excluded" : mode;
  const subtotal = items.reduce((s, i) => s + Math.round(i.amount), 0);
  const d = Math.min(Math.max(0, Math.round(discount || 0)), Math.max(0, subtotal));
  if (m === "included") {
    const total = subtotal - d;
    return { subtotal, discount: d, tax: Math.floor((Math.max(0, total) * 10) / 110), total };
  }
  if (m === "exempt") return { subtotal, discount: d, tax: 0, total: subtotal - d };
  const tax = Math.floor(Math.max(0, subtotal - d) * TAX_RATE);
  return { subtotal, discount: d, tax, total: subtotal - d + tax };
}

/** 税抜の金額 (売上・請求の基準) */
export const netAmount = (q: { total: number; tax: number }): number => q.total - q.tax;
