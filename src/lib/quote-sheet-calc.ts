import { quoteTotals } from "@/lib/quote-calc";

/**
 * 手書き見積書の金額の計算 (「金額を書く前に撮影」の流れ)
 * ------------------------------------------------------------
 * 現場で品名・数量・単価まで記入した見積書を撮影し、AI が読み取った数量・単価から
 * 各行の金額・割合の値引き・小計・消費税・合計をシステムが計算する (AI には計算させない)。
 * 職人は画面の金額を確かめてから、お客様に渡す見積書に書き写す。
 * 確認画面 (ブラウザー) とサーバー (ocr.ts の整形・書き写しの照合) の両方で使うため、ここは純粋な関数だけ。
 *
 * - 金額 = 数量 × 単価 (円未満は四捨五入。数量は 4.5 畳などの小数も可)
 * - 数量か単価がない行は、金額欄に書かれた金額 (諸経費・▲ の値引き・金券など) をそのまま使う
 * - 「2割引」「1割5分引」「20%引」の行 (数量・単価・金額なし) は割合の値引き:
 *   その行より上で、直前の値引きの行より後の行の合計 × 割合 (円未満切り捨て) を引く。
 *   対象が 2 行以上のときは、どの行の値引きか確かめてもらう (ambiguous)
 * - 小計・消費税・合計は quote-calc.ts の quoteTotals (税込 = 内税 / 税抜 = 外税 10%)
 */

export interface SheetRow {
  name?: string;
  spec?: string;
  qty?: number | null;
  unitPrice?: number | null;
  amount?: number | null;
  /** 割合の値引き (0.2 = 2割)。あれば金額は上の行から計算し直す */
  rate?: number | null;
}

export interface SheetRowResult {
  /** この行の金額 (値引きはマイナス)。計算できないときは null */
  amount: number | null;
  /** calc = 数量 × 単価 / written = 書かれた (入力した) 金額 / rate = 割合の値引き / missing = 計算できない */
  source: "calc" | "written" | "rate" | "missing";
  /** 割合の値引き: 割合と、計算のもとにした金額・行 (0 から数えた番号) */
  rate?: number;
  base?: number;
  baseRows?: number[];
  /** 割合の値引きの対象が 2 行以上 (どの行の値引きか確かめる) */
  ambiguous?: boolean;
  /** 数量 × 単価と、金額欄に書かれた金額が違う */
  writtenDiffers?: number;
}

export interface SheetResult {
  rows: SheetRowResult[];
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  /** 金額が決まらない行 (0 から数えた番号) */
  missing: number[];
}

const yen = (n: number) => Math.round(n).toLocaleString("ja-JP");
/** 値引きは見積書と同じ ▲ で書く */
const signedYen = (n: number) => (n < 0 ? `▲${yen(-n)}` : yen(n));

/** 「2割引」「1割5分引き」「20%引」「15％OFF」などから割合を読む (なければ undefined) */
export function discountRate(text: string | undefined): number | undefined {
  const t = (text ?? "").normalize("NFKC").replace(/\s+/g, "");
  if (!t) return undefined;
  const OFF = "(?:引|びき|ひき|off|オフ|値引|割引)";
  let m = t.match(new RegExp(`(\\d+(?:\\.\\d+)?)割(\\d)分${OFF}`, "i"));
  let r: number | undefined;
  if (m) r = Number(m[1]) / 10 + Number(m[2]) / 100;
  else if ((m = t.match(new RegExp(`(\\d+(?:\\.\\d+)?)割${OFF}`, "i")))) r = Number(m[1]) / 10;
  else if ((m = t.match(new RegExp(`(\\d+(?:\\.\\d+)?)%${OFF}`, "i")))) r = Number(m[1]) / 100;
  else if (/半額/.test(t)) r = 0.5;
  return r !== undefined && Number.isFinite(r) && r > 0 && r < 1 ? Math.round(r * 10000) / 10000 : undefined;
}

const has = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

/** 割合の値引きの行か (rate があるか、数量・単価・金額がなく品名・規格に「2割引」などがある) */
export function rowRate(r: SheetRow): number | undefined {
  if (has(r.rate) && r.rate > 0 && r.rate < 1) return r.rate;
  if (has(r.qty) || has(r.unitPrice) || has(r.amount)) return undefined;
  return discountRate(`${r.name ?? ""} ${r.spec ?? ""}`);
}

/** 各行の金額と合計を計算する */
export function calcSheet(rows: SheetRow[], opts: { taxIncluded: boolean; discount?: number }): SheetResult {
  const out: SheetRowResult[] = [];
  const missing: number[] = [];
  // 割合の値引きの対象: 直前の値引きの行より後の、金額が決まった行
  let group: number[] = [];
  rows.forEach((r, i) => {
    const rate = rowRate(r);
    if (rate !== undefined) {
      const base = group.reduce((a, j) => a + (out[j].amount ?? 0), 0);
      const amount = base > 0 ? -Math.floor(base * rate) : null;
      out.push({ amount, source: amount === null ? "missing" : "rate", rate, base, baseRows: [...group], ambiguous: group.length > 1 });
      if (amount === null) missing.push(i);
      group = [];
      return;
    }
    let res: SheetRowResult;
    if (has(r.qty) && has(r.unitPrice)) {
      const amount = Math.round(r.qty * r.unitPrice);
      res = { amount, source: "calc", ...(has(r.amount) && Math.abs(Math.round(r.amount) - amount) > 0 && Math.abs(Math.round(r.amount)) !== Math.abs(amount) ? { writtenDiffers: Math.round(r.amount) } : {}) };
    } else if (has(r.amount)) {
      res = { amount: Math.round(r.amount), source: "written" };
    } else {
      res = { amount: null, source: "missing" };
      missing.push(i);
    }
    out.push(res);
    if (res.amount !== null && res.amount < 0) group = [];
    else if (res.amount !== null) group.push(i);
  });
  const totals = quoteTotals(out.map((r) => ({ amount: r.amount ?? 0 })), opts.discount ?? 0, opts.taxIncluded);
  return { rows: out, ...totals, missing };
}

/** 割合の値引きの説明 (例: 「上の 1 行 52,360 円 × 2割」) */
export function rateBasis(r: SheetRowResult): string {
  if (r.source !== "rate" && !(r.source === "missing" && r.rate)) return "";
  const pct = r.rate !== undefined ? (Math.round(r.rate * 1000) % 100 === 0 ? `${Math.round(r.rate * 10)}割` : `${Math.round(r.rate * 1000) / 10}%`) : "";
  if (!r.baseRows?.length) return `${pct}引き: 上に対象の行がありません。金額を入力してください`;
  return `上の ${r.baseRows.length} 行 ${yen(r.base ?? 0)} 円 × ${pct}`;
}

/* ================================================================== */
/* 書き写しの照合 (金額を書き写した見積書をもう一度撮影したとき)              */
/* ================================================================== */

export interface ReadRow {
  name?: string;
  qty?: number;
  unitPrice?: number;
  amount?: number;
  /** 金額欄が読み取れず、数量 × 単価で埋めた行 (書き写した金額ではない) */
  amountCalculated?: boolean;
}

export interface TranscriptionCheck {
  /** 照合した行の数・一致した行の数 */
  checked: number;
  matched: number;
  /** 違い (利用者向けの文) */
  issues: string[];
  /** 違いのあった、もう一度読み取った明細の行 (0 から数えた番号) */
  rows: number[];
  /** 合計 (税込合計金額) が一致したか (読み取れなければ null) */
  totalMatched: boolean | null;
}

const sameNum = (a: number | undefined, b: number | undefined) => a !== undefined && b !== undefined && Math.abs(a - b) < 0.001;

/**
 * 計算した金額 (calc) と、書き写した後の見積書から読み取った金額 (read) を比べる。
 * 行の対応づけ: ① 数量・単価が同じ行 → ② 金額が同じ行 → ③ 同じ順番の行 (行の読み落としで順番がずれても照合できるように)
 */
export function compareTranscription(calc: { rows: (SheetRow & { amount?: number | null })[]; total: number }, read: { rows: ReadRow[]; total?: number }): TranscriptionCheck {
  const used = new Set<number>();
  const pair = new Map<number, number>();
  const targets = calc.rows.map((c, i) => ({ c, i })).filter(({ c }) => has(c.amount));
  const take = (i: number, pick: (r: ReadRow, k: number) => boolean) => {
    if (pair.has(i)) return;
    const j = read.rows.findIndex((r, k) => !used.has(k) && pick(r, k));
    if (j >= 0) {
      used.add(j);
      pair.set(i, j);
    }
  };
  for (const { c, i } of targets) if (has(c.qty) && has(c.unitPrice)) take(i, (r) => sameNum(r.qty, c.qty ?? undefined) && sameNum(r.unitPrice, c.unitPrice ?? undefined));
  for (const { c, i } of targets) take(i, (r) => !r.amountCalculated && has(r.amount) && Math.abs(Math.round(r.amount)) === Math.abs(Math.round(c.amount!)));
  for (const { i } of targets) take(i, (_r, k) => k === i);

  const issues: string[] = [];
  const rows: number[] = [];
  let matched = 0;
  for (const { c, i } of targets) {
    const label = `${i + 1} 行目「${(c.name ?? "").slice(0, 16)}${c.spec ? ` ${c.spec.slice(0, 12)}` : ""}」`;
    const j = pair.get(i);
    if (j === undefined) {
      issues.push(`${label} が、書き写した見積書から見つかりません`);
      continue;
    }
    const r = read.rows[j];
    // 計算に使った数量・単価と、書き写した見積書の数量・単価が違う = 最初の読み取りの読み違い (書き写した金額が計算と同じでも知らせる)
    if (has(c.qty) && has(c.unitPrice) && has(r.qty) && has(r.unitPrice) && !(sameNum(r.qty, c.qty) && sameNum(r.unitPrice, c.unitPrice))) {
      issues.push(`${label}: 計算に使った 数量 × 単価 (${c.qty} × ${signedYen(c.unitPrice)}) と、見積書の数量 × 単価 (${r.qty} × ${signedYen(r.unitPrice)}) が違います。用紙の数字を確かめ、金額を直してください`);
      rows.push(j);
      continue;
    }
    if (r.amountCalculated || !has(r.amount)) {
      issues.push(`${label} の金額が読み取れません (書き写したか確かめてください)`);
      rows.push(j);
    } else if (Math.abs(Math.round(r.amount)) === Math.abs(Math.round(c.amount!))) {
      matched++;
    } else {
      issues.push(`${label} の金額: 書き写した ${signedYen(r.amount)} 円 / 計算 ${signedYen(c.amount!)} 円`);
      rows.push(j);
    }
  }
  let totalMatched: boolean | null = null;
  if (read.total !== undefined) {
    totalMatched = Math.round(read.total) === Math.round(calc.total);
    if (!totalMatched) issues.push(`合計: 書き写した ${yen(read.total)} 円 / 計算 ${yen(calc.total)} 円`);
  } else {
    issues.push(`合計 (税込合計金額) が読み取れません (計算 ${yen(calc.total)} 円)`);
  }
  return { checked: targets.length, matched, issues, rows, totalMatched };
}
