import "server-only";
import type { Database } from "@/lib/db/types";
import { addDays, toDateKey } from "@/lib/format";
import type { AnalysisSpec } from "./analyze";

/**
 * AI を使えないとき (キーなし・使いすぎの制限) の集計の読み取り。
 * 「今年の4月1日から10月31日までの店舗別売上と粗利」「過去3年間の畳の品目別売上」「前年同期と比べて減っている商品」
 * のような質問から、期間・軸・指標・比較を言葉の決まりで読み取る。読み取れなければ null (通常の回答へ)
 */

export const ANALYSIS_WORDS = /売上|売り上げ|粗利|利益|販売数|販売数量|数量|単価|成約率|受注率|集計|推移|ランキング|上位|トップ|比較|前年|昨年比|前年比|件数/;

const pad = (n: number) => String(n).padStart(2, "0");
const lastDayOf = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

function parsePeriod(q: string, today: string): { from: string; to: string; years?: number } | null {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const s = q.normalize("NFKC");
  // 2026年4月1日 / 4月1日 / 2026/4/1 / 4/1 (年がなければ今年。「昨年の」なら前年)
  const baseYear = /昨年|去年|前年の/.test(s) && !/前年同期|前年比|前年と/.test(s) ? y - 1 : y;
  const date = String.raw`(?:(\d{4})[年/\-])?(\d{1,2})[月/\-](\d{1,2})日?`;
  const range = s.match(new RegExp(`${date}\\s*(?:から|〜|~|－|-|より)\\s*${date}`));
  if (range) {
    const fy = Number(range[1] ?? baseYear);
    const ty = Number(range[4] ?? range[1] ?? baseYear);
    return { from: `${fy}-${pad(Number(range[2]))}-${pad(Number(range[3]))}`, to: `${ty}-${pad(Number(range[5]))}-${pad(Number(range[6]))}` };
  }
  const months = s.match(/(?:(\d{4})年)?(\d{1,2})月\s*(?:から|〜|~|-)\s*(?:(\d{4})年)?(\d{1,2})月/);
  if (months) {
    const fy = Number(months[1] ?? baseYear);
    const ty = Number(months[3] ?? months[1] ?? baseYear);
    return { from: `${fy}-${pad(Number(months[2]))}-01`, to: `${ty}-${pad(Number(months[4]))}-${pad(lastDayOf(ty, Number(months[4])))}` };
  }
  const past = s.match(/過去\s*(\d{1,2})\s*年/);
  if (past) {
    const n = Math.min(20, Number(past[1]));
    return { from: `${y - n + 1}-01-01`, to: today, years: n };
  }
  const recent = s.match(/(?:直近|過去)\s*(\d{1,2})\s*(?:か月|ヶ月|カ月|ケ月)/);
  if (recent) return { from: addDays(today, -Math.round(Number(recent[1]) * 30.4)), to: today };
  const yearOnly = s.match(/(\d{4})年(?!\d{1,2}月)/);
  if (yearOnly) {
    const yy = Number(yearOnly[1]);
    return { from: `${yy}-01-01`, to: yy === y ? today : `${yy}-12-31` };
  }
  if (/今月/.test(s)) return { from: `${y}-${pad(m)}-01`, to: today };
  if (/先月|前月/.test(s)) {
    const py = m === 1 ? y - 1 : y;
    const pm = m === 1 ? 12 : m - 1;
    return { from: `${py}-${pad(pm)}-01`, to: `${py}-${pad(pm)}-${pad(lastDayOf(py, pm))}` };
  }
  if (/昨年|去年/.test(s)) return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` };
  if (/今年|本年|年初/.test(s)) return { from: `${y}-01-01`, to: today };
  return null;
}

export function heuristicSpec(db: Pick<Database, "stores">, q: string, now = new Date()): AnalysisSpec | null {
  const s = q.normalize("NFKC");
  if (!ANALYSIS_WORDS.test(s)) return null;
  const today = toDateKey(now);
  const period = parsePeriod(s, today);
  const group: string[] = [];
  const dim = (re: RegExp, d: string) => {
    if (re.test(s) && !group.includes(d)) group.push(d);
  };
  if (period?.years) group.push("year");
  dim(/店舗(別|ごと|毎)|店ごと|店舗を比較|店別/, "store");
  dim(/月(別|ごと|毎)|月次|推移/, "month");
  dim(/年(別|ごと|毎)|年次|年度別/, "year");
  dim(/商品(別|ごと)|品目(別|ごと)|品名(別|ごと)|商品ランキング|売れ筋|減少している商品|減っている商品|増えている商品/, "product");
  dim(/種別|カテゴリ|分野別|工事種類/, "category");
  dim(/顧客(別|ごと)|お客様(別|ごと)|顧客ランキング|得意先(別|ごと)/, "customer");
  dim(/担当者?(別|ごと)|営業(別|ごと)/, "staff");
  dim(/施工担当|職人(別|ごと)/, "worker");
  dim(/地区(別|ごと)|地域(別|ごと)|エリア(別|ごと)/, "area");
  if (!period && !group.length) return null;
  const metrics: string[] = [];
  if (/粗利|利益/.test(s)) metrics.push("sales", "gross", "gross_margin");
  if (/数量|販売数|枚数/.test(s)) metrics.push(metrics.includes("sales") ? "quantity" : "quantity");
  if (/単価/.test(s)) metrics.push("avg_unit_price");
  if (!metrics.length || (!metrics.includes("sales") && !metrics.includes("quantity"))) metrics.unshift("sales");
  if (/件数/.test(s) && !metrics.includes("order_count")) metrics.push("order_count");
  const needItems = group.includes("product") || metrics.some((m) => m === "quantity" || m === "avg_unit_price");
  const products = [...s.matchAll(/[「『"]([^」』"]{1,30})[」』"]/g)].map((m) => m[1]);
  const stores = db.stores.filter((st) => s.includes(st.shortName) || s.includes(st.name)).map((st) => st.id);
  const categories = ["畳", "襖", "障子", "網戸", "カーテン", "クロス"].filter((c) => new RegExp(`${c}(?!店)`).test(s) && !(c === "畳" && /一畳屋/.test(s) && s.split("畳").length <= 2));
  const spec: AnalysisSpec = {
    subject: "sales",
    metrics: needItems ? metrics.filter((m) => !["gross", "gross_margin"].includes(m)) : metrics,
    group_by: group.slice(0, 3),
    from: period?.from,
    to: period?.to,
    stores: stores.length ? stores : undefined,
    categories: categories.length ? categories : undefined,
    products: products.length ? products : undefined,
    compare: /前年同期|前年比|前年と|昨年と比|去年と比/.test(s) ? "previous_year" : undefined,
    only: /減少|減って|下がって|落ちて/.test(s) ? "decreased" : /増加|増えて|伸びて/.test(s) ? "increased" : undefined,
    limit: /ランキング|上位|トップ|ベスト/.test(s) ? 10 : undefined,
  };
  return spec;
}

/**
 * 続けての質問 (「月別にして」「前年と比べて」「上位10件」「合志店だけ」) で、前の集計の条件を変える。
 * 変える言葉がなければ null (前の集計を繰り返さない)
 */
export function refineSpec(db: Pick<Database, "stores">, prev: AnalysisSpec, q: string, now = new Date()): AnalysisSpec | null {
  const s = q.normalize("NFKC");
  const parsed = heuristicSpec(db, `売上 ${s}`, now);
  if (!parsed) return null;
  const changed: Partial<AnalysisSpec> = {};
  if (parsed.group_by?.length) changed.group_by = parsed.group_by;
  if (parsed.from && parsed.to && /今年|昨年|去年|今月|先月|過去|直近|\d{4}年|月\s*(から|〜)|日\s*(から|〜)/.test(s)) Object.assign(changed, { from: parsed.from, to: parsed.to });
  if (parsed.compare) changed.compare = parsed.compare;
  if (parsed.only) changed.only = parsed.only;
  if (parsed.limit) changed.limit = parsed.limit;
  if (parsed.stores) changed.stores = parsed.stores;
  if (/すべて表示|全部表示|全件/.test(s)) changed.limit = 200;
  if (!Object.keys(changed).length) return null;
  return { ...prev, ...changed };
}
