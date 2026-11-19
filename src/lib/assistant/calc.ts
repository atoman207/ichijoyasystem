/**
 * AI アシスタントの計算の道具 (calculate)
 * ------------------------------------------------------------
 * AI が自分で暗算せず、道具の結果の数字どうしの差・比・割合・合計・平均を正確に出すための電卓。
 * eval は使わず、四則演算と決まった関数だけを読む小さな構文解析で計算する。
 * 式の中の数字は、それまでの道具の結果にあるものだけを使わせる (agent.ts が checkCalcInputs で確かめる。
 * 推測した数字を電卓に通して「根拠のある数字」に見せかけないため)
 *
 * 使える書き方: 数字 (1,234,567 のカンマ可)・+ - * / ( )・× ÷・関数 round(x, 桁)・floor・ceil・abs・min・max・sum・avg・
 * pct(a, b) = a ÷ b × 100 (割合 %)・growth(新, 旧) = (新 − 旧) ÷ 旧 × 100 (増減率 %)
 */

export type CalcResult = { ok: true; value: number } | { ok: false; error: string };

type Tok = { t: "num"; v: number; raw: string } | { t: "op"; v: string } | { t: "id"; v: string };

function tokenize(src: string): Tok[] | string {
  const s = src.normalize("NFKC").replace(/×/g, "*").replace(/÷/g, "/").replace(/−/g, "-");
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const num = /^(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?/.exec(s.slice(i));
    if (num) {
      out.push({ t: "num", v: Number(num[0].replace(/,/g, "")), raw: num[0] });
      i += num[0].length;
      continue;
    }
    const id = /^[a-z_]+/i.exec(s.slice(i));
    if (id) {
      out.push({ t: "id", v: id[0].toLowerCase() });
      i += id[0].length;
      continue;
    }
    if ("+-*/(),".includes(ch)) {
      out.push({ t: "op", v: ch });
      i++;
      continue;
    }
    return `使えない文字があります: ${ch}`;
  }
  return out;
}

const FN: Record<string, (args: number[]) => number> = {
  round: ([x, d = 0]) => {
    const f = Math.pow(10, Math.round(d));
    return Math.round(x * f) / f;
  },
  floor: ([x]) => Math.floor(x),
  ceil: ([x]) => Math.ceil(x),
  abs: ([x]) => Math.abs(x),
  min: (a) => Math.min(...a),
  max: (a) => Math.max(...a),
  sum: (a) => a.reduce((s, x) => s + x, 0),
  avg: (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN),
  pct: ([a, b]) => (a / b) * 100,
  growth: ([a, b]) => ((a - b) / b) * 100,
};

/** 式を計算する (四則演算と FN の関数だけ) */
export function evaluate(expr: string): CalcResult {
  if (!expr.trim()) return { ok: false, error: "式が空です。" };
  if (expr.length > 1000) return { ok: false, error: "式が長すぎます。" };
  const toks = tokenize(expr);
  if (typeof toks === "string") return { ok: false, error: toks };
  let p = 0;
  const peek = () => toks[p];
  const take = () => toks[p++];
  const expect = (v: string) => {
    const t = take();
    if (!t || t.t !== "op" || t.v !== v) throw new Error(`「${v}」が足りません。`);
  };
  // expr := term (('+'|'-') term)* / term := unary (('*'|'/') unary)* / unary := '-' unary | primary
  const parseExpr = (): number => {
    let v = parseTerm();
    for (let t = peek(); t && t.t === "op" && (t.v === "+" || t.v === "-"); t = peek()) {
      take();
      v = t.v === "+" ? v + parseTerm() : v - parseTerm();
    }
    return v;
  };
  const parseTerm = (): number => {
    let v = parseUnary();
    for (let t = peek(); t && t.t === "op" && (t.v === "*" || t.v === "/"); t = peek()) {
      take();
      const r = parseUnary();
      if (t.v === "/" && r === 0) throw new Error("0 で割ることはできません。");
      v = t.v === "*" ? v * r : v / r;
    }
    return v;
  };
  const parseUnary = (): number => {
    const t = peek();
    if (t && t.t === "op" && (t.v === "-" || t.v === "+")) {
      take();
      return t.v === "-" ? -parseUnary() : parseUnary();
    }
    return parsePrimary();
  };
  const parsePrimary = (): number => {
    const t = take();
    if (!t) throw new Error("式が途中で終わっています。");
    if (t.t === "num") return t.v;
    if (t.t === "op" && t.v === "(") {
      const v = parseExpr();
      expect(")");
      return v;
    }
    if (t.t === "id") {
      const fn = FN[t.v];
      if (!fn) throw new Error(`使えない関数です: ${t.v} (使えるのは ${Object.keys(FN).join("・")})`);
      expect("(");
      const args: number[] = [];
      if (!(peek()?.t === "op" && peek()?.v === ")")) {
        args.push(parseExpr());
        while (peek()?.t === "op" && peek()?.v === ",") {
          take();
          args.push(parseExpr());
        }
      }
      expect(")");
      if (!args.length) throw new Error(`${t.v} に値がありません。`);
      if ((t.v === "pct" || t.v === "growth") && args[1] === 0) throw new Error("0 で割ることはできません (割る数が 0 です)。");
      return fn(args);
    }
    throw new Error(`式の書き方が正しくありません (${t.v})。`);
  };
  try {
    const v = parseExpr();
    if (p < toks.length) throw new Error("式の終わりに余分なものがあります。");
    if (!Number.isFinite(v)) throw new Error("計算できませんでした (結果が数になりません)。");
    return { ok: true, value: v };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** 式の中の数字 (書いたままの形と値) */
export function literalsOf(expr: string): { raw: string; value: number }[] {
  const toks = tokenize(expr);
  if (typeof toks === "string") return [];
  return toks.filter((t): t is Extract<Tok, { t: "num" }> => t.t === "num").map((t) => ({ raw: t.raw, value: t.v }));
}

/**
 * 式の数字が根拠 (それまでの道具の結果・質問) にあるか。小さな定数 (100 以下: 桁・割合の 100・月数など) と
 * 10 のべき乗 (1,000・10,000 = 千円・万円への換算) は確かめない
 */
export function checkCalcInputs(expr: string, evidence: number[]): string[] {
  const missing: string[] = [];
  for (const n of literalsOf(expr)) {
    const v = Math.abs(n.value);
    if (v <= 100 || /^10*$/.test(String(v))) continue;
    if (!evidence.some((e) => Math.abs(Math.abs(e) - v) < 0.5)) missing.push(n.raw);
  }
  return [...new Set(missing)];
}

/** 結果の書き方 (整数はカンマ区切り、小数は 2 桁まで) */
export function formatCalc(v: number): string {
  const r = Math.round(v * 100) / 100;
  return Number.isInteger(r) ? r.toLocaleString("ja-JP") : r.toLocaleString("ja-JP", { minimumFractionDigits: 1, maximumFractionDigits: 2 });
}
