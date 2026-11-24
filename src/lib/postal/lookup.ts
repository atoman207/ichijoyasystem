import data from "./kyushu.json";
import { cleanAddressText } from "@/lib/maps/address";

/**
 * 住所 → 郵便番号 (お客様のご要望 2026-11-24「① 郵便番号の自動設定」)
 * ------------------------------------------------------------
 * データは日本郵便の郵便番号データ (九州 7 県。scripts/import/build-postal.mjs で作る src/lib/postal/kyushu.json)。
 * お客様の住所は県・郡・熊本市を省いて書かれることが多い (「合志市須屋…」「北区清水万石…」「大津町室…」「須屋 1-1」) ため:
 *   県がなければ熊本県 → ほかの九州の県。市区町村は 全体・郡を省いた形 (大津町 = 菊池郡大津町)・熊本市を省いた区 (北区 = 熊本市北区)・区のない熊本市 で探し、
 *   そのあとの町域を一番長く一致したもので決める。市区町村が書かれていないときは熊本県の町域から探し、1 つに決まるときだけ。
 * 町域が丁目などで分かれて郵便番号が 2 つ以上あるとき・候補が 2 つ以上あるとき・町域が分からないときは決めない (「以下に掲載がない場合」の番号は使わない)
 */

type TownMap = Record<string, string | string[]>;
const PREFS = (data as { prefs: Record<string, Record<string, TownMap>> }).prefs;
export const POSTAL_SOURCE = (data as { source: string; fetchedAt: string }).source;
export const POSTAL_FETCHED_AT = (data as { fetchedAt: string }).fetchedAt;

const DEFAULT_PREF = "熊本県";
const PREF_RE = /^(東京都|北海道|(?:京都|大阪)府|[^\d]{2,3}?県)/;

export interface PostalHit {
  /** 郵便番号 (例: 861-1102) */
  postalCode: string;
  pref: string;
  city: string;
  town: string;
  /** 住所に県・市区町村が書かれていなかったので補った */
  inferred: boolean;
}

export type PostalResult = { ok: true; hit: PostalHit } | { ok: false; reason: "no_address" | "not_found" | "ambiguous"; candidates?: string[] };

const fmt = (z: string) => `${z.slice(0, 3)}-${z.slice(3)}`;

/** 比べるための住所 (〒・県の前の空白・大字を除く) */
function prep(address: string): string {
  return cleanAddressText(address)
    .replace(/\s+/g, "")
    .replace(/^〒?\d{3}-?\d{4}/, "")
    .replace(/^日本/, "")
    .replace(/大字/g, "")
    .replace(/ヶ/g, "ケ")
    .replace(/ヵ/g, "カ");
}

/** 町域の比べ方: 「ヶ」「ケ」は同じ (武蔵ケ丘・武蔵ヶ丘)。途中の「町」の省略 (泗水町永 = 泗水永) も同じとみる */
const keyOf = (town: string) => town.replace(/ヶ/g, "ケ").replace(/ヵ/g, "カ");
const withoutMachi = (town: string) => town.replace(/町(?=.)/g, "");

interface Cand {
  pref: string;
  city: string;
  rest: string;
  inferred: boolean;
}

/** 住所の頭の市区町村の候補 */
function cityCandidates(pref: string, t: string, isDefault: boolean): Cand[] {
  const cities = Object.keys(PREFS[pref] ?? {});
  const out: Cand[] = [];
  for (const city of cities) {
    if (t.startsWith(city)) out.push({ pref, city, rest: t.slice(city.length), inferred: false });
    const noGun = city.replace(/^[^\d]+?郡/, "");
    if (noGun !== city && t.startsWith(noGun)) out.push({ pref, city, rest: t.slice(noGun.length), inferred: true });
    // 政令市の区: 「北区…」(熊本市を省いた)・「熊本市…」(区を省いた)。県が書かれていないときは熊本県だけ (福岡市にも同じ区の名前がある)
    const m = /^(.+?市)(.+?区)$/.exec(city);
    if (m && isDefault) {
      if (t.startsWith(m[2])) out.push({ pref, city, rest: t.slice(m[2].length), inferred: true });
      if (t.startsWith(m[1]) && !t.startsWith(city)) out.push({ pref, city, rest: t.slice(m[1].length), inferred: true });
    }
  }
  // いちばん長く一致した市区町村を残す (「熊本市」と「熊本市北区」なら後の方)
  const consumed = (c: Cand) => t.length - c.rest.length;
  const best = Math.max(0, ...out.map(consumed));
  return out.filter((c) => consumed(c) === best || /^(.+?市)(.+?区)$/.test(c.city));
}

function townsOf(c: Cand): { town: string; len: number; zip: string | string[] }[] {
  const map = PREFS[c.pref]?.[c.city] ?? {};
  const out: { town: string; len: number; zip: string | string[] }[] = [];
  for (const [town, zip] of Object.entries(map)) {
    if (!town) continue;
    const k = keyOf(town);
    if (c.rest.startsWith(k)) out.push({ town, len: k.length, zip });
    else {
      const short = withoutMachi(k);
      if (short !== k && short.length >= 2 && c.rest.startsWith(short)) out.push({ town, len: short.length, zip });
    }
  }
  return out;
}

/**
 * 住所から郵便番号を決める。prefer = 候補が 2 つ以上のときの手がかり (例: お客様の担当店舗の地域の町。1 つに絞れたときだけ使う)
 */
export function postalFromAddress(address: string | undefined | null, opts: { prefer?: (h: { pref: string; city: string; town: string }) => boolean } = {}): PostalResult {
  const t0 = prep(address ?? "");
  if (t0.length < 2) return { ok: false, reason: "no_address" };
  const pm = PREF_RE.exec(t0);
  const written = pm && PREFS[pm[1]] ? pm[1] : undefined;
  const t = pm ? t0.slice(pm[0].length) : t0;
  const order = written ? [written] : [DEFAULT_PREF, ...Object.keys(PREFS).filter((p) => p !== DEFAULT_PREF)];
  let cands: Cand[] = [];
  for (const pref of order) {
    cands = cityCandidates(pref, t, pref === DEFAULT_PREF);
    if (cands.length) break;
  }
  // 市区町村が書かれていない (「須屋1-1」): 熊本県の町域から探す
  if (!cands.length && (!written || written === DEFAULT_PREF)) cands = Object.keys(PREFS[DEFAULT_PREF] ?? {}).map((city) => ({ pref: DEFAULT_PREF, city, rest: t, inferred: true }));
  const hits = cands.flatMap((c) => townsOf(c).map((h) => ({ ...h, c })));
  if (!hits.length) return { ok: false, reason: "not_found" };
  const longest = Math.max(...hits.map((h) => h.len));
  // 市区町村を書かずに町名だけのときは 2 文字以上の町域だけ (「栄」のような短い町名はほかの市にもある)
  let top = hits.filter((h) => h.len === longest && (h.c.rest !== t || longest >= 2));
  const zipsOf = (list: typeof top) => [...new Set(list.flatMap((h) => (Array.isArray(h.zip) ? h.zip : [h.zip])))];
  let zips = zipsOf(top);
  if (zips.length > 1 && opts.prefer) {
    const narrowed = top.filter((h) => opts.prefer!({ pref: h.c.pref, city: h.c.city, town: h.town }));
    if (narrowed.length && zipsOf(narrowed).length === 1) {
      top = narrowed;
      zips = zipsOf(narrowed);
    }
  }
  if (zips.length !== 1 || top.some((h) => Array.isArray(h.zip))) return { ok: false, reason: "ambiguous", candidates: zips.map(fmt).slice(0, 5) };
  const h = top[0];
  // inferred = 市区町村 (郡・熊本市・区) を補った・町名だけから決めた
  return { ok: true, hit: { postalCode: fmt(zips[0]), pref: h.c.pref, city: h.c.city, town: h.town, inferred: h.c.inferred } };
}

/** 郵便番号が空なら住所から入れる (登録・変更のとき)。決まらなければ元のまま */
export function withPostal(address: string | undefined, postalCode: string | undefined): string {
  if ((postalCode ?? "").replace(/\D/g, "").length) return postalCode ?? "";
  const r = postalFromAddress(address);
  return r.ok ? r.hit.postalCode : (postalCode ?? "");
}

/**
 * 保存するときの郵便番号 (顧客の登録・変更): 入力があればそのまま。空なら住所から。
 * 住所を変えたのに郵便番号が前の住所から自動で入れた番号のまま (= 手で直していない) なら、新しい住所から入れ直す (決まらなければ空)
 */
export function postalForSave(address: string | undefined, input: string | undefined, prev?: { address?: string; postalCode?: string }): string {
  const typed = (input ?? "").trim();
  if (prev && typed && typed === (prev.postalCode ?? "").trim() && (address ?? "") !== (prev.address ?? "")) {
    const old = postalFromAddress(prev.address);
    if (old.ok && old.hit.postalCode === typed) {
      const r = postalFromAddress(address);
      return r.ok ? r.hit.postalCode : "";
    }
  }
  return withPostal(address, typed);
}
