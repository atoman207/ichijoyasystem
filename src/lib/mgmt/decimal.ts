/**
 * 管理会計の数値計算 (浮動小数点で計算しない)
 * ------------------------------------------------------------
 * - 金額は円の整数。計算の途中は BigInt (整数) で行い、最後に決めた方法で円に丸める
 * - 数量・単価は小数 4 桁までの十進数 (データベースは numeric)。読み込んだ数値は 4 桁に丸めて BigInt (×10,000) にしてから使う
 * - 率は 1/10,000 単位の整数 (bp。20% = 2000)、案分率は 1/1,000,000 単位の整数 (ppm) で持つ
 * - 端数の処理 (floor / round / ceil) は設定 (rules.ts) で選ぶ。按分は合計が必ず元の金額に一致する (largest remainder)
 */

export type Rounding = "floor" | "round" | "ceil";

export const ROUNDING_LABEL: Record<Rounding, string> = {
  floor: "切り捨て",
  round: "四捨五入",
  ceil: "切り上げ",
};

// tsconfig の target が ES2017 のため BigInt のリテラル (10n) は使わない
const SCALE = BigInt(10000);

/** 小数 4 桁までの十進数を ×10,000 の BigInt にする ("12.5" / 12.5 → BigInt(125000))。不正な値は例外 */
export function dec4(x: number | string | bigint): bigint {
  if (typeof x === "bigint") return x * SCALE;
  const s = typeof x === "number" ? (Number.isFinite(x) ? x.toFixed(4) : "") : x.trim().replace(/,/g, "");
  const m = s.match(/^(-?)(\d+)(?:\.(\d+))?$/);
  if (!m) throw new Error(`数値ではありません: ${String(x)}`);
  const frac = (m[3] ?? "").padEnd(5, "0");
  // 5 桁目で四捨五入 (number からは toFixed(4) 済み)
  let v = BigInt(m[2]) * SCALE + BigInt(frac.slice(0, 4));
  if (Number(frac[4]) >= 5) v += BigInt(1);
  return m[1] ? -v : v;
}

/** ×10,000 の BigInt を十進数の文字列にする (BigInt(125000) → "12.5") */
export function fmtDec4(v: bigint): string {
  const neg = v < BigInt(0);
  const a = neg ? -v : v;
  const i = a / SCALE;
  const f = (a % SCALE).toString().padStart(4, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${i}${f ? `.${f}` : ""}`;
}

/** 4 桁に丸めた number (保存用) */
export function round4(x: number | string): number {
  return Number(fmtDec4(dec4(x)));
}

/** 整数の割り算を決めた方法で丸める (分母が負のときは符号をそろえる。0 は例外) */
export function divRound(n: bigint, d: bigint, mode: Rounding): bigint {
  if (d === BigInt(0)) throw new Error("分母が 0 です");
  if (d < BigInt(0)) {
    n = -n;
    d = -d;
  }
  const q = n / d; // 0 方向に切り捨て
  const r = n % d;
  if (r === BigInt(0)) return q;
  if (mode === "floor") return n < BigInt(0) ? q - BigInt(1) : q;
  if (mode === "ceil") return n < BigInt(0) ? q : q + BigInt(1);
  // 四捨五入 (0.5 は 0 から遠い方へ)
  const twice = (r < BigInt(0) ? -r : r) * BigInt(2);
  if (twice >= d) return n < BigInt(0) ? q - BigInt(1) : q + BigInt(1);
  return q;
}

/** 安全な整数 (円) か確かめて number にする */
export function toYen(v: bigint): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`金額が大きすぎます: ${v}`);
  return n;
}

/** 数量 × 単価 → 円 (丸め方を指定) */
export function qtyTimesCost(qty: number | string, unitCost: number | string, mode: Rounding = "round"): number {
  return toYen(divRound(dec4(qty) * dec4(unitCost), SCALE * SCALE, mode));
}

/** 金額 × 率 (bp) → 円 */
export function applyBp(amount: number, bp: number, mode: Rounding): number {
  if (!Number.isInteger(bp)) throw new Error("率は 1/10,000 単位の整数で指定します");
  return toYen(divRound(BigInt(amount) * BigInt(bp), BigInt(10000), mode));
}

/** 税込の金額から消費税額 (税率は % の整数。8 → 8%) */
export function taxIncludedPart(amountIncl: number, ratePct: number, mode: Rounding = "floor"): number {
  if (!ratePct) return 0;
  return toYen(divRound(BigInt(amountIncl) * BigInt(ratePct), BigInt(100 + ratePct), mode));
}

/** 税込 → 税抜 */
export function exTax(amountIncl: number, ratePct: number, mode: Rounding = "floor"): number {
  return amountIncl - taxIncludedPart(amountIncl, ratePct, mode);
}

/** 率を ppm (1/1,000,000) で表す (分子/分母)。分母が 0 以下は null */
export function ratioPpm(num: number, den: number): number | null {
  if (den <= 0) return null;
  return toYen(divRound(BigInt(num) * BigInt(1000000), BigInt(den), "round"));
}

/** 原価率・前年比などの百分率 (小数 1 桁)。分母が 0 以下 (売上がない・マイナス) のときは null (計算不能) */
export function percent1(num: number, den: number): number | null {
  if (den <= 0) return null;
  const v = divRound(BigInt(num) * BigInt(1000), BigInt(den), "round");
  return Number(v) / 10;
}

export type ApportionMethod = "largest_remainder" | "largest_share";

export const APPORTION_LABEL: Record<ApportionMethod, string> = {
  largest_remainder: "切り捨てた残りを、端数の大きい順に 1 円ずつ (同じなら並び順)",
  largest_share: "切り捨てた残りを、案分額の最も大きい先へまとめて",
};

/**
 * 金額を重み (正の整数) で按分する。結果の合計は必ず total に一致する (決定的)。
 * - 重みは 0 以上。合計が 0 のときは例外 (呼び出し側で保留にする)
 * - total が負のときは符号を外して按分し、最後に戻す
 */
export function apportion(total: number, weights: (number | bigint)[], method: ApportionMethod = "largest_remainder"): number[] {
  if (!Number.isSafeInteger(total)) throw new Error("按分する金額は円の整数で指定します");
  const w = weights.map((x) => BigInt(x));
  if (w.some((x) => x < BigInt(0))) throw new Error("按分の重みに負の値があります");
  const sum = w.reduce((a, b) => a + b, BigInt(0));
  if (sum === BigInt(0)) throw new Error("按分の重みの合計が 0 です");
  const sign = total < 0 ? -BigInt(1) : BigInt(1);
  const t = BigInt(total) * sign;
  const base = w.map((x) => (t * x) / sum);
  const rem = w.map((x, i) => t * x - base[i] * sum); // 余り (分母 sum)
  let left = t - base.reduce((a, b) => a + b, BigInt(0));
  const order = w.map((_, i) => i);
  if (method === "largest_share") {
    order.sort((a, b) => (base[b] > base[a] ? 1 : base[b] < base[a] ? -1 : a - b));
    if (left > BigInt(0)) base[order[0]] += left;
    left = BigInt(0);
  } else {
    order.sort((a, b) => (rem[b] > rem[a] ? 1 : rem[b] < rem[a] ? -1 : a - b));
    for (let k = 0; left > BigInt(0); k = (k + 1) % order.length) {
      if (w[order[k]] === BigInt(0)) continue;
      base[order[k]] += BigInt(1);
      left -= BigInt(1);
    }
  }
  return base.map((x) => toYen(x * sign));
}
