/**
 * 見積の合計 (税抜・税込の 2 つの書き方)
 * ------------------------------------------------------------
 * - 税抜 (システムの標準): 小計 = 明細の合計 (税抜)。消費税 = (小計 − 値引き) × 10% (切り捨て)。合計 = 小計 − 値引き + 消費税
 * - 税込 (手書き見積書の「税込」): 単価・小計は税込。合計 = 小計 − 値引き。消費税は内税 = 合計 × 10/110 (切り捨て)
 * どちらも 税抜の金額 = 合計 − 消費税 (売上・請求書の 10% 対象額)
 * 値引きの行 (単価がマイナス) は明細の合計に含める
 */

export const TAX_RATE = 0.1;

export interface QuoteTotals {
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
}

export function quoteTotals(items: { amount: number }[], discount: number, taxIncluded = false): QuoteTotals {
  const subtotal = items.reduce((s, i) => s + Math.round(i.amount), 0);
  const d = Math.min(Math.max(0, Math.round(discount || 0)), Math.max(0, subtotal));
  if (taxIncluded) {
    const total = subtotal - d;
    return { subtotal, discount: d, tax: Math.floor((Math.max(0, total) * 10) / 110), total };
  }
  const tax = Math.floor(Math.max(0, subtotal - d) * TAX_RATE);
  return { subtotal, discount: d, tax, total: subtotal - d + tax };
}

/** 税抜の金額 (売上・請求の基準) */
export const netAmount = (q: { total: number; tax: number }): number => q.total - q.tax;
