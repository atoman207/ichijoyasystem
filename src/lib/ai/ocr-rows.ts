/**
 * 手書き見積書の明細の行を省かない (お客様のご要望 2026-11-26「■1」: 読み取れない行も行そのものは残し、読み取れる範囲で取り込む。
 * 行があれば手入力で直せる。お客様に渡した見積書とシステムの見積書の明細の順番を同じにする)
 * ------------------------------------------------------------
 * AI には先に明細の欄の書き込みのある行を数えさせ (lineCount)、各行に用紙の何行目か (line) を付けさせる。
 * - 書き込みのない行 (空欄の行) だけを除き、ほかは読めなくても残す (品名が空でも数字があれば・要確認の印があれば)
 * - 並べ替えない (AI が返した順 = 用紙の上から順)
 * - 数えた行より少ないときは、足りない行を空の行 (要確認) として入れる。line の番号の抜けがちょうど足りない数なら
 *   その位置に、そうでなければ最後に入れる (位置は画面の「上へ」「下へ」で直せる)
 * import なし (AI の呼び出し・テストの両方から使う)
 */

type RawRow = Record<string, unknown>;

/** 1 枚の見積書の明細の行数として信じる上限 (これより大きい lineCount は数え間違いとして使わない) */
export const MAX_LINE_COUNT = 100;

const hasText = (v: unknown) => typeof v === "string" && v.trim() !== "";
const hasNumber = (v: unknown) => (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && /\d/.test(v));

/** 何かが書かれている行か (品名・規格・数量・単価・金額のどれか、または AI が「読みにくい・書き直した」とした行) */
export function hasRowContent(r: unknown): boolean {
  if (!r || typeof r !== "object" || Array.isArray(r)) return false;
  const row = r as RawRow;
  return hasText(row.name) || hasText(row.spec) || ["qty", "unitPrice", "amount"].some((k) => hasNumber(row[k])) || row.uncertain === true || row.corrected === true;
}

/** AI が数えた明細の行数 (整数・1〜上限のときだけ) */
export function countedLines(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_LINE_COUNT ? v : undefined;
}

/** 読み取れなかった行の代わりの空の行 (要確認) */
export function placeholderRow(): RawRow {
  return { name: "", spec: "", qty: null, unit: "", unitPrice: null, amount: null, uncertain: true, corrected: false };
}

export interface RowCheck {
  /** 書き込みのある行として返ってきた行 */
  read: number;
  /** AI が数えた行数 (なければ undefined) */
  counted?: number;
  /** 数えた行数より少ない行数 */
  missing: number;
}

/** 読み取りの結果の行数の確かめ (少なければ読み直す) */
export function checkRows(items: unknown, lineCount: unknown): RowCheck {
  const read = Array.isArray(items) ? items.filter(hasRowContent).length : 0;
  const counted = countedLines(lineCount);
  return { read, counted, missing: counted ? Math.max(0, counted - read) : 0 };
}

export interface RowReconcile {
  rows: RawRow[];
  read: number;
  counted?: number;
  /** 足した空の行の数 */
  padded: number;
  /** 足した空の行の位置 (用紙の何行目か。分かったときだけ) */
  positions: number[];
  warnings: string[];
}

const stripLine = (r: RawRow): RawRow => {
  const rest = { ...r };
  delete rest.line;
  return rest;
};

/**
 * 明細の行をそろえる: 空欄の行だけを除き、順番はそのまま、足りない行は空の行 (要確認) で埋める
 */
export function reconcileRows(items: unknown, lineCount: unknown): RowReconcile {
  const list = (Array.isArray(items) ? (items as unknown[]) : []).filter(hasRowContent) as RawRow[];
  const counted = countedLines(lineCount);
  const missing = counted ? Math.max(0, counted - list.length) : 0;
  if (!missing) return { rows: list.map(stripLine), read: list.length, counted, padded: 0, positions: [], warnings: [] };

  // line の番号が 1〜counted の範囲で上から順に増えていて、抜けている番号がちょうど足りない数なら、その位置に入れる
  const lines = list.map((r) => r.line);
  const increasing = lines.every((n, i) => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= counted! && (i === 0 || n > (lines[i - 1] as number)));
  const holes = increasing ? Array.from({ length: counted! }, (_, i) => i + 1).filter((n) => !lines.includes(n)) : [];
  const out: RawRow[] = [];
  let positions: number[] = [];
  if (increasing && holes.length === missing) {
    positions = holes;
    let k = 0;
    for (let n = 1; n <= counted!; n++) {
      if (holes.includes(n)) out.push(placeholderRow());
      else out.push(stripLine(list[k++]));
    }
  } else {
    out.push(...list.map(stripLine));
    for (let i = 0; i < missing; i++) out.push(placeholderRow());
  }
  const where = positions.length ? `用紙の ${positions.join("・")} 行目` : "最後";
  return {
    rows: out,
    read: list.length,
    counted,
    padded: missing,
    positions,
    warnings: [
      `用紙の明細は ${counted} 行ありますが、読み取れたのは ${list.length} 行です。読み取れなかった ${missing} 行を空の行 (黄色) として${where}に入れました。写真と見比べて品名・数量・単価を入力してください${positions.length ? "" : " (位置が違うときは行の「上へ」「下へ」で動かせます)"}。`,
    ],
  };
}

/** 読み直しの依頼の文 (1 回目より行が少なかったとき) */
export function retryInstruction(check: RowCheck): string {
  return [
    `前回の読み取りでは、明細の欄に書き込みのある行が ${check.counted} 行あると数えましたが、items には ${check.read} 行しかありませんでした。`,
    `明細の欄をもう一度、いちばん上の行から 1 行ずつ確かめ、書き込みのある行を ${check.counted} 行すべて、用紙の上から順に items に入れてください (並べ替えない・まとめない)。`,
    "読めない行も省かず、品名が読めなければ空文字、数字が読めなければ null にして、その行の uncertain を true にしてください。〃 の行・諸経費・▲ の値引き・金券の行も 1 行です。",
  ].join("\n");
}
