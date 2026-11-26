/**
 * 明細の行の挿入・移動 (お客様のご要望 2026-11-26「■1」: お客様に渡した手書きの見積書と明細の順番を同じにするため、
 * 読み取った行と行の間の好きな位置に行を入れられるように)。見積の明細 (QuoteEditor) と書類取込の確認 (DocumentReview) で共通。
 * 画面に見える順番がそのまま保存の順番になる (行の配列の順に送る)。import なし (テストからも読む)
 */

/** index の位置 (0 = 先頭、rows.length = 最後) に行を入れた新しい配列 */
export function insertRow<T>(rows: readonly T[], index: number, row: T): T[] {
  const at = Math.max(0, Math.min(rows.length, Math.trunc(Number.isFinite(index) ? index : rows.length)));
  return [...rows.slice(0, at), row, ...rows.slice(at)];
}

/** index の行を 1 つ上 (delta = -1) か下 (+1) へ動かした新しい配列。端の行は動かさない */
export function moveRow<T>(rows: readonly T[], index: number, delta: -1 | 1): T[] {
  const to = index + delta;
  if (index < 0 || index >= rows.length || to < 0 || to >= rows.length) return [...rows];
  const next = [...rows];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

/** 行を消した新しい配列 */
export function removeRowAt<T>(rows: readonly T[], index: number): T[] {
  return rows.filter((_, i) => i !== index);
}
