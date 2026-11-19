import type { Customer, StoreId } from "@/lib/db/types";

/**
 * 住所・地区名からおおよその位置を求める (予定の候補日の提案で、現場どうしの距離と移動時間の目安に使う)
 * ------------------------------------------------------------
 * - 外部の地図サービスは使わない (お客様の住所を社外に送らない)。熊本県内の市区町村の役場付近の位置と、
 *   主な町名の位置 (目安) を持ち、住所の「市区町村 + 町名」で引く
 * - 予定表の「(御代志) ○○ 引き取り」「中島町」のような町名だけの場所は、お客様の住所から覚えた
 *   「町名 → 市区町村」の対応 (同じ店舗のお客様を優先) で市区町村を決める
 * - 距離は直線距離 × 1.3 (道路の回り道の目安)、移動時間は 距離 ÷ 時速 + 5 分 (駐車・積み込み)
 * 精度は町名の単位 (数 km)。候補日の順位付けと目安の表示に使い、正確な所要時間とはしない
 */

export type GeoPrecision = "locality" | "municipality" | "unknown";

export interface GeoPoint {
  lat: number;
  lng: number;
  /** 表示用の地名 (例: 合志市 御代志 / 熊本市北区) */
  label: string;
  precision: GeoPrecision;
}

interface Place {
  name: string;
  lat: number;
  lng: number;
  /** 合併前の町村名など (住所に残っていることがある) */
  aliases?: string[];
  /** 主な町名 (市区町村名の後ろの先頭一致で引く) */
  localities?: Record<string, [number, number]>;
}

/** 熊本県の市区町村 (熊本市は区ごと) と、近隣の市。位置は役場付近の目安 */
const PLACES: Place[] = [
  {
    name: "熊本市中央区",
    lat: 32.803,
    lng: 130.708,
    localities: {
      坪井: [32.815, 130.715], 京町: [32.815, 130.7], 黒髪: [32.815, 130.727], 水前寺: [32.796, 130.73], 大江: [32.795, 130.724], 帯山: [32.806, 130.746],
      渡鹿: [32.786, 130.735], 出水: [32.785, 130.742], 本荘: [32.79, 130.716], 九品寺: [32.795, 130.72], 新町: [32.802, 130.695], 子飼本町: [32.812, 130.722],
      南熊本: [32.787, 130.725], 神水: [32.797, 130.74], 国府: [32.794, 130.735], 新屋敷: [32.797, 130.725], 草葉町: [32.808, 130.722], 横手: [32.797, 130.69],
    },
  },
  {
    name: "熊本市東区",
    lat: 32.79,
    lng: 130.765,
    localities: {
      健軍: [32.79, 130.765], 長嶺: [32.81, 130.78], 保田窪: [32.797, 130.745], 戸島: [32.8, 130.8], 小山: [32.8, 130.815], 尾ノ上: [32.785, 130.752],
      若葉: [32.776, 130.776], 秋津: [32.77, 130.77], 画図町: [32.765, 130.737], 江津: [32.776, 130.737], 月出: [32.8, 130.757], 花立: [32.786, 130.786],
      桜木: [32.784, 130.79], 沼山津: [32.775, 130.792], 御領: [32.81, 130.795], 東町: [32.78, 130.757], 錦ケ丘: [32.795, 130.762], 渡鹿: [32.786, 130.737],
    },
  },
  {
    name: "熊本市西区",
    lat: 32.8,
    lng: 130.66,
    localities: {
      河内町: [32.81, 130.59], 松尾町: [32.78, 130.61], 島崎: [32.81, 130.676], 花園: [32.815, 130.684], 上熊本: [32.815, 130.693], 春日: [32.79, 130.69],
      田崎: [32.795, 130.682], 小島: [32.77, 130.63], 中島町: [32.765, 130.62], 池上町: [32.786, 130.66], 城山: [32.79, 130.66], 蓮台寺: [32.785, 130.68],
      戸坂町: [32.815, 130.666], 二本木: [32.795, 130.695], 谷尾崎町: [32.8, 130.665], 中原町: [32.78, 130.63],
    },
  },
  {
    name: "熊本市南区",
    lat: 32.735,
    lng: 130.705,
    aliases: ["下益城郡城南町", "下益城郡富合町", "城南町", "富合町"],
    localities: {
      城南町: [32.7, 130.735], 富合町: [32.715, 130.695], 川尻: [32.75, 130.69], 田迎: [32.77, 130.72], 近見: [32.77, 130.69], 刈草: [32.76, 130.7],
      平成: [32.776, 130.716], 南高江: [32.75, 130.705], 野田: [32.745, 130.705], 御幸: [32.752, 130.723], 銭塘町: [32.735, 130.66], 天明: [32.73, 130.64],
      幸田: [32.765, 130.71], 島町: [32.745, 130.68], 白藤: [32.755, 130.705], 八幡: [32.755, 130.69], 良町: [32.765, 130.72], 流通団地: [32.74, 130.725],
    },
  },
  {
    name: "熊本市北区",
    lat: 32.86,
    lng: 130.71,
    aliases: ["鹿本郡植木町", "植木町"],
    localities: {
      植木町: [32.905, 130.69], 龍田: [32.83, 130.752], 清水: [32.835, 130.715], 武蔵ケ丘: [32.855, 130.762], 楠: [32.845, 130.755], 八景水谷: [32.835, 130.716],
      高平: [32.838, 130.7], 鹿子木町: [32.87, 130.69], 改寄町: [32.89, 130.655], 硯川町: [32.865, 130.705], 麻生田: [32.84, 130.735], 弓削: [32.85, 130.75],
      四方寄町: [32.865, 130.7], 貢町: [32.875, 130.66], 楡木: [32.86, 130.745], 飛田: [32.838, 130.72], 兎谷: [32.835, 130.73], 打越町: [32.825, 130.71],
      徳王: [32.83, 130.705], 須屋: [32.865, 130.76], 楠野町: [32.86, 130.735], 大窪: [32.83, 130.69], 釜尾町: [32.85, 130.69], 立福寺町: [32.86, 130.685],
    },
  },
  {
    name: "合志市",
    lat: 32.886,
    lng: 130.79,
    aliases: ["菊池郡西合志町", "菊池郡合志町", "西合志町", "合志町"],
    localities: {
      御代志: [32.89, 130.745], 須屋: [32.868, 130.765], 竹迫: [32.895, 130.787], 豊岡: [32.886, 130.81], 野々島: [32.9, 130.755], 上庄: [32.902, 130.79],
      幾久富: [32.88, 130.806], 合生: [32.88, 130.775], 栄: [32.89, 130.775], 黒石: [32.895, 130.735], 原口: [32.902, 130.81], 福原: [32.905, 130.77],
      御代志野: [32.892, 130.75], 群: [32.887, 130.765], 平島: [32.875, 130.79], 出仲間: [32.882, 130.77], 永江: [32.893, 130.725], 新開: [32.876, 130.748],
    },
  },
  {
    name: "菊池市",
    lat: 32.979,
    lng: 130.813,
    aliases: ["菊池郡泗水町", "菊池郡七城町", "菊池郡旭志村", "泗水町", "七城町", "旭志村"],
    localities: { 泗水町: [32.93, 130.795], 七城町: [32.99, 130.765], 旭志: [32.975, 130.88], 隈府: [32.98, 130.815], 西寺: [32.96, 130.8], 赤星: [32.955, 130.79] },
  },
  {
    name: "菊池郡菊陽町",
    lat: 32.863,
    lng: 130.828,
    aliases: ["菊陽町"],
    localities: { 光の森: [32.86, 130.785], 原水: [32.872, 130.845], 津久礼: [32.855, 130.818], 辛川: [32.86, 130.8], 久保田: [32.87, 130.81], 武蔵ケ丘: [32.86, 130.775], 杉並台: [32.87, 130.8], 曲手: [32.85, 130.83] },
  },
  {
    name: "菊池郡大津町",
    lat: 32.879,
    lng: 130.868,
    aliases: ["大津町"],
    localities: { 室: [32.88, 130.87], 引水: [32.87, 130.845], 陣内: [32.875, 130.88], 大津: [32.879, 130.868], 杉水: [32.9, 130.855], 森: [32.885, 130.89], 美咲野: [32.89, 130.86] },
  },
  {
    name: "玉名市",
    lat: 32.929,
    lng: 130.563,
    aliases: ["玉名郡岱明町", "玉名郡横島町", "玉名郡天水町", "岱明町", "横島町", "天水町"],
    localities: { 岱明町: [32.9, 130.53], 横島町: [32.895, 130.575], 天水町: [32.87, 130.605], 築地: [32.93, 130.57], 繁根木: [32.926, 130.56], 高瀬: [32.93, 130.56], 大倉: [32.95, 130.57], 小島: [32.91, 130.55] },
  },
  {
    name: "山鹿市",
    lat: 33.017,
    lng: 130.691,
    aliases: ["鹿本郡鹿本町", "鹿本郡鹿北町", "鹿本郡菊鹿町", "鹿本郡鹿央町", "鹿本町", "鹿北町", "菊鹿町", "鹿央町"],
    localities: { 鹿本町: [33.02, 130.73], 鹿北町: [33.09, 130.7], 菊鹿町: [33.05, 130.77], 鹿央町: [32.99, 130.7], 山鹿: [33.017, 130.691] },
  },
  { name: "荒尾市", lat: 32.987, lng: 130.433 },
  { name: "玉名郡玉東町", lat: 32.918, lng: 130.629, aliases: ["玉東町"] },
  { name: "玉名郡長洲町", lat: 32.931, lng: 130.453, aliases: ["長洲町"] },
  { name: "玉名郡和水町", lat: 32.98, lng: 130.61, aliases: ["玉名郡菊水町", "玉名郡三加和町", "和水町", "菊水町", "三加和町"], localities: { 江田: [32.975, 130.63], 板楠: [33.01, 130.64] } },
  { name: "玉名郡南関町", lat: 33.062, lng: 130.541, aliases: ["南関町"] },
  { name: "上益城郡益城町", lat: 32.791, lng: 130.816, aliases: ["益城町"] },
  { name: "上益城郡嘉島町", lat: 32.74, lng: 130.757, aliases: ["嘉島町"] },
  { name: "上益城郡御船町", lat: 32.715, lng: 130.802, aliases: ["御船町"] },
  { name: "上益城郡甲佐町", lat: 32.652, lng: 130.811, aliases: ["甲佐町"] },
  { name: "上益城郡山都町", lat: 32.687, lng: 130.991, aliases: ["上益城郡矢部町", "上益城郡清和村", "上益城郡蘇陽町", "山都町"] },
  { name: "阿蘇市", lat: 32.952, lng: 131.121, aliases: ["阿蘇郡一の宮町", "阿蘇郡阿蘇町", "阿蘇郡波野村"] },
  { name: "阿蘇郡西原村", lat: 32.835, lng: 130.904, aliases: ["西原村"] },
  { name: "阿蘇郡南阿蘇村", lat: 32.83, lng: 131.0, aliases: ["阿蘇郡長陽村", "阿蘇郡白水村", "阿蘇郡久木野村", "南阿蘇村"] },
  { name: "阿蘇郡高森町", lat: 32.822, lng: 131.122, aliases: ["高森町"] },
  { name: "阿蘇郡小国町", lat: 33.122, lng: 131.069 },
  { name: "阿蘇郡南小国町", lat: 33.098, lng: 131.071 },
  { name: "阿蘇郡産山村", lat: 32.992, lng: 131.212 },
  { name: "宇土市", lat: 32.687, lng: 130.659 },
  {
    name: "宇城市",
    lat: 32.643,
    lng: 130.67,
    aliases: ["宇土郡三角町", "宇土郡不知火町", "下益城郡松橋町", "下益城郡小川町", "下益城郡豊野町"],
    localities: { 三角町: [32.615, 130.455], 不知火町: [32.625, 130.62], 小川町: [32.595, 130.69], 豊野町: [32.655, 130.74], 松橋町: [32.643, 130.67] },
  },
  { name: "下益城郡美里町", lat: 32.638, lng: 130.789, aliases: ["美里町"] },
  { name: "八代市", lat: 32.507, lng: 130.602 },
  { name: "八代郡氷川町", lat: 32.582, lng: 130.674 },
  { name: "天草市", lat: 32.459, lng: 130.193 },
  { name: "上天草市", lat: 32.587, lng: 130.43 },
  { name: "天草郡苓北町", lat: 32.513, lng: 130.054 },
  { name: "水俣市", lat: 32.212, lng: 130.409 },
  { name: "人吉市", lat: 32.21, lng: 130.763 },
  { name: "葦北郡芦北町", lat: 32.299, lng: 130.493 },
  { name: "葦北郡津奈木町", lat: 32.235, lng: 130.44 },
  { name: "球磨郡錦町", lat: 32.201, lng: 130.841 },
  { name: "球磨郡あさぎり町", lat: 32.241, lng: 130.898 },
  { name: "球磨郡多良木町", lat: 32.264, lng: 130.936 },
  { name: "球磨郡湯前町", lat: 32.276, lng: 130.983 },
  { name: "球磨郡水上村", lat: 32.315, lng: 131.007 },
  { name: "球磨郡相良村", lat: 32.235, lng: 130.798 },
  { name: "球磨郡五木村", lat: 32.395, lng: 130.828 },
  { name: "球磨郡山江村", lat: 32.245, lng: 130.765 },
  { name: "球磨郡球磨村", lat: 32.251, lng: 130.65 },
  { name: "大牟田市", lat: 33.03, lng: 130.446 },
  { name: "みやま市", lat: 33.152, lng: 130.475 },
  { name: "久留米市", lat: 33.319, lng: 130.508 },
];

const flat = (s: string) => s.normalize("NFKC").replace(/[\s　]+/g, "").replace(/ヶ/g, "ケ").replace(/之/g, "の");

interface Key {
  key: string;
  place: Place;
}

/** 住所の先頭と照合する名前 (長いものから) */
const KEYS: Key[] = (() => {
  const out: Key[] = [];
  for (const p of PLACES) {
    out.push({ key: flat(p.name), place: p });
    // 「菊池郡菊陽町」は「菊陽町」だけで書かれることもある
    const short = p.name.replace(/^.+?郡/, "");
    if (short !== p.name) out.push({ key: flat(short), place: p });
    for (const a of p.aliases ?? []) out.push({ key: flat(a), place: p });
  }
  return out.sort((a, b) => b.key.length - a.key.length);
})();

const KUMAMOTO_CITY = PLACES.filter((p) => p.name.startsWith("熊本市"));

/** 町名の先頭一致 (長いものから)。返すのは町名と位置 */
function matchLocality(place: Place, rest: string): { name: string; at: [number, number] } | undefined {
  if (!place.localities || !rest) return undefined;
  let best: { name: string; at: [number, number]; len: number } | undefined;
  for (const [name, at] of Object.entries(place.localities)) {
    const k = flat(name);
    // 「泗水町」は「泗水吉冨」(予定表の地区) のように「町」を付けずに書かれることもある
    const keys = k.length >= 3 && k.endsWith("町") ? [k, k.slice(0, -1)] : [k];
    for (const key of keys) if (rest.startsWith(key) && (!best || key.length > best.len)) best = { name, at, len: key.length };
  }
  return best && { name: best.name, at: best.at };
}

/** 住所の市区町村より後ろの、町名の部分 (番地・丁目より前) */
export function localityOf(rest: string): string {
  const s = flat(rest).replace(/^大字/, "");
  const m = s.match(/^([^\d\-－‐丁番号]+?)(?:\d|丁目|番地?|-|$)/);
  const t = (m?.[1] ?? "").replace(/(字|大字)$/, "");
  return t.length >= 1 && t.length <= 8 ? t : "";
}

function point(place: Place, loc?: { name: string; at: [number, number] }): GeoPoint {
  const label = place.name.replace(/^.+?郡/, "");
  if (loc) return { lat: loc.at[0], lng: loc.at[1], label: `${label} ${loc.name}`, precision: "locality" };
  return { lat: place.lat, lng: place.lng, label, precision: "municipality" };
}

/** 住所 (市区町村から始まるもの) を位置にする。市区町村が分からないときは undefined */
export function geocodeAddress(address: string | undefined | null): GeoPoint | undefined {
  if (!address) return undefined;
  let s = flat(address).replace(/^〒?\d{3}-?\d{4}/, "").replace(/^熊本県/, "").replace(/^福岡県/, "");
  // 区のない「熊本市○○」(政令市になる前の住所) は、町名から区を探す
  if (s.startsWith("熊本市") && !/^熊本市(中央|東|西|南|北)区/.test(s)) {
    const rest = s.slice(3);
    for (const p of KUMAMOTO_CITY) {
      const loc = matchLocality(p, rest);
      if (loc) return point(p, loc);
    }
    return point(PLACES[0]);
  }
  for (const k of KEYS) {
    if (!s.startsWith(k.key)) continue;
    s = s.slice(k.key.length);
    // 合併前の町村名 (例: 菊池郡泗水町) は、その町名を手がかりにする
    const alias = k.place.aliases?.find((a) => flat(a) === k.key);
    const aliasLoc = alias ? matchLocality(k.place, flat(alias).replace(/^.+?郡/, "")) : undefined;
    return point(k.place, matchLocality(k.place, s) ?? aliasLoc);
  }
  return undefined;
}

/* ---------------- 町名だけの場所 (予定表の地区) ---------------- */

interface LocalityIndex {
  builtAt: number;
  size: number;
  /** 町名 → 市区町村ごとのお客様の数 (全体) */
  all: Map<string, Map<string, number>>;
  /** 店舗ごと */
  byStore: Map<StoreId, Map<string, Map<string, number>>>;
}

const g = globalThis as typeof globalThis & { __ichijoyaGeoIndex?: LocalityIndex };
const PLACE_BY_NAME = new Map(PLACES.map((p) => [p.name, p]));

function placeOf(address: string): { place: Place; rest: string } | undefined {
  let s = flat(address).replace(/^〒?\d{3}-?\d{4}/, "").replace(/^熊本県/, "");
  if (s.startsWith("熊本市") && !/^熊本市(中央|東|西|南|北)区/.test(s)) return undefined;
  for (const k of KEYS) {
    if (!s.startsWith(k.key)) continue;
    s = s.slice(k.key.length);
    return { place: k.place, rest: s };
  }
  return undefined;
}

/** お客様の住所から「町名 → 市区町村」の対応を作る (10 分ごと、お客様の数が変わったときだけ作り直す) */
function localityIndex(customers: Pick<Customer, "address" | "storeId" | "area">[]): LocalityIndex {
  const cur = g.__ichijoyaGeoIndex;
  if (cur && cur.size === customers.length && Date.now() - cur.builtAt < 10 * 60_000) return cur;
  const all = new Map<string, Map<string, number>>();
  const byStore = new Map<StoreId, Map<string, Map<string, number>>>();
  const add = (m: Map<string, Map<string, number>>, loc: string, place: string) => {
    let row = m.get(loc);
    if (!row) m.set(loc, (row = new Map()));
    row.set(place, (row.get(place) ?? 0) + 1);
  };
  for (const c of customers) {
    if (!c.address) continue;
    const hit = placeOf(c.address);
    if (!hit) continue;
    const locs = new Set<string>();
    const loc = localityOf(hit.rest);
    if (loc) {
      locs.add(loc);
      // 「中島町」と「中島」のどちらでも引けるように
      if (loc.length >= 3 && loc.endsWith("町")) locs.add(loc.slice(0, -1));
    }
    if (c.area) {
      const a = flat(c.area).replace(/^.+?[市町村]/, "");
      if (a && a.length <= 8) locs.add(a);
    }
    let st = byStore.get(c.storeId);
    if (!st) byStore.set(c.storeId, (st = new Map()));
    for (const l of locs) {
      add(all, l, hit.place.name);
      add(st, l, hit.place.name);
    }
  }
  const idx: LocalityIndex = { builtAt: Date.now(), size: customers.length, all, byStore };
  g.__ichijoyaGeoIndex = idx;
  return idx;
}

function bestPlace(row: Map<string, number> | undefined): string | undefined {
  if (!row?.size) return undefined;
  return [...row.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * 予定の場所・住所・地区名を位置にする。
 * 住所 (市区町村から) → 町名だけ (店舗のお客様の住所で覚えた市区町村) → 件名の「(地区)」の順に試す
 */
export function geocodePlace(
  text: string | undefined | null,
  ctx: { storeId?: StoreId; customers: Pick<Customer, "address" | "storeId" | "area">[]; title?: string },
): GeoPoint | undefined {
  const direct = geocodeAddress(text);
  if (direct) return direct;
  const candidates: string[] = [];
  if (text) candidates.push(text);
  const paren = ctx.title?.match(/^[(（]([^)）]{1,12})[)）]/)?.[1];
  if (paren) candidates.push(paren);
  if (!candidates.length) return undefined;
  const idx = localityIndex(ctx.customers);
  for (const raw of candidates) {
    const t = flat(raw).replace(/^(熊本県)/, "");
    if (!t || t.length > 20) continue;
    // 「泗水吉冨」のように、合併前の町名と町名がつながっていることもある
    for (const name of [t, localityOf(t)].filter(Boolean)) {
      const own = ctx.storeId ? bestPlace(idx.byStore.get(ctx.storeId)?.get(name)) : undefined;
      const placeName = own ?? bestPlace(idx.all.get(name));
      const place = placeName ? PLACE_BY_NAME.get(placeName) : undefined;
      if (place) return point(place, matchLocality(place, name));
    }
    // 町名の表に直接あるもの (例: 植木町・城南町)
    for (const p of PLACES) {
      const loc = matchLocality(p, t);
      if (loc && flat(loc.name).length >= 2) return point(p, loc);
    }
  }
  return undefined;
}

/* ---------------- 距離と移動時間 ---------------- */

/** 直線距離 (km) */
export function straightKm(a: Pick<GeoPoint, "lat" | "lng">, b: Pick<GeoPoint, "lat" | "lng">): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 道路距離の目安 (km)。同じ町名どうしは 1 km とする */
export function roadKm(a: GeoPoint, b: GeoPoint): number {
  if (a.label === b.label) return a.precision === "locality" ? 1 : 3;
  return Math.max(1, straightKm(a, b) * 1.3);
}

/** 移動時間の目安 (分): 道路距離 ÷ 時速 + 5 分 */
export function travelMinutes(a: GeoPoint, b: GeoPoint, speedKmh: number): number {
  return Math.round((roadKm(a, b) / Math.max(10, speedKmh)) * 60 + 5);
}
