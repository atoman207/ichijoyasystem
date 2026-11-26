/**
 * 住所の正規化 (地図の場所の照合用)
 * ------------------------------------------------------------
 * - 元の住所 (顧客・見積・受注・予定の文字) は書き換えない。ここでは照合用のキーと表示用の整えた文字を作るだけ
 * - キー = 都道府県 + 市区町村・町名 + 番地 (数字を「-」でつなぐ)。建物名・部屋番号はキーに入れない
 *   (同じ番地の建物は住宅地図・地図の位置が同じため。部屋番号は各記録の住所の文字に残る)
 * - 番地のない住所 (「合志市須屋」「水前寺」)・市区町村のない住所 (「菊陽ハイツ9号」) は precision = "area"。
 *   別のお客様と同じ場所として自動で結び付けない (取り違えを防ぐ)
 * このファイルは画面 (クライアント) とテストからも読み込むため、サーバー専用の import をしない
 */

export type AddressPrecision = "house" | "area" | "none";

export interface NormalizedAddress {
  /** 元の文字 */
  original: string;
  /** 表示用 (全角英数・ハイフンの揺れを整え、空白を 1 つにしたもの。都道府県は書かれたまま) */
  display: string;
  /** 住所に書かれていた郵便番号 (7 桁の数字) */
  postalCode?: string;
  /** 都道府県 (書かれていなければ既定の都道府県) */
  prefecture: string;
  /** 住所に都道府県が書かれていた */
  prefectureWritten: boolean;
  /**
   * 地図の検索・ゼンリン GIS の地点検索に使う住所 (都道府県の後ろから、番地まで。書かれたままの形。建物名・部屋番号は入れない。
   * 番地のない住所はそのまま)。都道府県・熊本市を補った検索の文字は src/lib/maps/query.ts の mapSearchAddress
   */
  core: string;
  /** 市区町村・町名 (照合用。空白・大字を除き、郡を外したもの) */
  town: string;
  /** 番地 (数字を「-」でつないだもの。例: 3-12-5) */
  houseNumber?: string;
  /** 建物名 (番地の後ろ。照合には使わない) */
  building?: string;
  /** 部屋番号・階 (例: 201号室 / 9F) */
  room?: string;
  /** 照合用のキー (precision が none のときは空) */
  key: string;
  precision: AddressPrecision;
  /** 照合・確認のための注意 (例: 番地がありません) */
  notes: string[];
}

/** 既定の都道府県 (住所に都道府県が書かれていないとき。一畳屋のお客様はほぼ熊本県) */
export const DEFAULT_PREFECTURE = "熊本県";

const KANJI_DIGIT: Record<string, number> = { 〇: 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 漢数字 (〜九千九百九十九) を数に直す。直せないときは null */
function kanjiToNumber(s: string): number | null {
  if (!s) return null;
  // 「二〇一」のような位取りのない書き方
  if (!/[十百千]/.test(s)) {
    let n = 0;
    for (const ch of s) {
      if (!(ch in KANJI_DIGIT)) return null;
      n = n * 10 + KANJI_DIGIT[ch];
    }
    return n;
  }
  let total = 0;
  let cur = 0;
  for (const ch of s) {
    if (ch in KANJI_DIGIT) cur = KANJI_DIGIT[ch];
    else if (ch === "十" || ch === "百" || ch === "千") {
      const unit = ch === "十" ? 10 : ch === "百" ? 100 : 1000;
      total += (cur || 1) * unit;
      cur = 0;
    } else return null;
  }
  return total + cur;
}

const HYPHENS = /[‐‑‒–—―−﹣－⁃]/g;
const PREF_RE = /^(北海道|東京都|京都府|大阪府|[^\s\d市区町村郡]{2,3}県)/;
const KUMAMOTO_WARDS = /^(中央区|東区|西区|南区|北区)/;

/** 文字の揺れをそろえる (全角英数 → 半角・ハイフンの種類・空白) */
export function cleanAddressText(text: string | undefined | null): string {
  if (!text) return "";
  let s = text.normalize("NFKC");
  s = s.replace(HYPHENS, "-");
  // 数字の間の長音・「の」はハイフン (1ー2 / 1の2)
  s = s.replace(/(\d)\s*[ーｰ]\s*(?=\d)/g, "$1-").replace(/(\d)の(?=\d)/g, "$1-");
  // 漢数字の丁目・番地・号
  s = s.replace(/([〇零一二三四五六七八九十百千]+)(?=丁目|番地|番|号)/g, (m) => {
    const n = kanjiToNumber(m);
    return n == null ? m : String(n);
  });
  s = s.replace(/(番地?|丁目)の(?=\d)/g, "$1");
  s = s.replace(/[\s　]+/g, " ").trim();
  return s;
}

/**
 * 住所を正規化する。defaultPrefecture は住所に都道府県が書かれていないときの都道府県
 */
export function normalizeAddress(text: string | undefined | null, defaultPrefecture = DEFAULT_PREFECTURE): NormalizedAddress {
  const original = text ?? "";
  let s = cleanAddressText(original);
  const notes: string[] = [];
  let postalCode: string | undefined;
  const pm = /(?:〒\s*)?(\d{3})-?(\d{4})(?!\d)/.exec(s);
  // 郵便番号は先頭か「〒」付きのときだけ (番地の「1234-5678」を郵便番号と取り違えない)
  if (pm && (pm.index === 0 || s[pm.index] === "〒")) {
    postalCode = `${pm[1]}${pm[2]}`;
    s = (s.slice(0, pm.index) + s.slice(pm.index + pm[0].length)).trim();
  }
  s = s.replace(/^日本\s*/, "");
  const display = s;
  if (!s) {
    return { original, display, postalCode, prefecture: defaultPrefecture, prefectureWritten: false, town: "", core: "", key: "", precision: "none", notes: ["住所がありません"] };
  }
  let prefecture = defaultPrefecture;
  const pref = PREF_RE.exec(s);
  if (pref) {
    prefecture = pref[1];
    s = s.slice(pref[0].length).trim();
  }
  const afterPref = s;

  // 番地: 最初の数字から、空白をまたがずに続く「数字 + 丁目・番地・番・号・-」のまとまり
  const hn = /(\d+)((?:丁目|番地|番|号|-)?(?:\d+(?:丁目|番地|番|号|-)?)*)/.exec(s);
  let townRaw = s;
  let houseNumber: string | undefined;
  let rest = "";
  let chomeOnly = false;
  let houseText = "";
  if (hn) {
    townRaw = s.slice(0, hn.index);
    const block = hn[0];
    // 書かれたままの番地 (3 つ目の数字まで。4 つ目以降は部屋番号)
    houseText = (/^\d+(?:丁目|番地|番|号|-)?(?:\d+(?:丁目|番地|番|号|-)?){0,2}/.exec(block)?.[0] ?? block).replace(/-+$/, "");
    rest = s.slice(hn.index + block.length);
    const groups = block.match(/\d+/g) ?? [];
    chomeOnly = groups.length === 1 && /丁目$/.test(block);
    // 4 つ目以降の数字は部屋番号 (例: 1-2-3-201)
    const head = groups.slice(0, 3);
    const tail = groups.slice(3);
    houseNumber = head.map((g) => String(Number(g))).join("-");
    if (tail.length) rest = `${tail.join("-")}${rest}`;
  }
  let town = townRaw.replace(/\s+/g, "").replace(/大字/g, "").replace(/[ヶヵｹ]/g, "ケ").replace(/の/g, "ノ");
  // 郡は省略されることが多いので外す (菊池郡菊陽町 → 菊陽町)
  town = town.replace(/^([^市区町村]{1,6})郡(?=.{1,}[町村])/, "");
  if (prefecture === "熊本県" && KUMAMOTO_WARDS.test(town)) town = `熊本市${town}`;

  // 建物名・部屋番号
  let building: string | undefined;
  let room: string | undefined;
  rest = rest.replace(/^[\s\-,、]+/, "").trim();
  if (rest) {
    const rm = /(?:\s|^)?(#?\d+[A-Za-z]?(?:号室|号|室|階|F)?|[A-Za-z]\d*-?\d+)$/.exec(rest);
    if (rm && rm.index + rm[0].length === rest.length && /\d/.test(rm[1])) {
      room = rm[1].replace(/^#/, "");
      building = rest.slice(0, rm.index).trim() || undefined;
    } else {
      building = rest;
    }
    if (building) building = building.replace(/\s+/g, " ").replace(/^[\-,、]+|[\-,、]+$/g, "").trim() || undefined;
  }

  const hasMunicipality = /[市区町村]/.test(town);
  let precision: AddressPrecision = "house";
  if (!houseNumber || chomeOnly) {
    precision = "area";
    notes.push(chomeOnly ? "番地がありません (丁目まで)" : "番地がありません");
  }
  if (!town) {
    precision = "area";
    notes.push("市区町村・町名がありません");
  } else if (!hasMunicipality) {
    precision = "area";
    notes.push("市区町村が書かれていません");
  }
  const key = `${prefecture}${town}${houseNumber ? houseNumber : ""}`;
  // 番地まである住所は建物名・部屋番号を外す (Google マップ・ゼンリン GIS が建物名を別の場所と取り違えないように)
  const core = precision === "house" ? `${townRaw.trim()}${houseText}` : afterPref;
  return { original, display, postalCode, prefecture, prefectureWritten: Boolean(pref), town, core, houseNumber, building, room, key, precision, notes };
}

/** 2 つの住所が同じ場所 (番地まで同じ) か。番地のない住所どうしは同じとみなさない */
export function sameHouse(a: string | undefined | null, b: string | undefined | null, defaultPrefecture = DEFAULT_PREFECTURE): boolean {
  const x = normalizeAddress(a, defaultPrefecture);
  const y = normalizeAddress(b, defaultPrefecture);
  return x.precision === "house" && y.precision === "house" && x.key === y.key;
}

/**
 * 住所の文字が同じか (空白・全角半角・ハイフンの揺れだけの違いは同じ)。番地のない住所の比較に使う
 */
export function sameAddressText(a: string | undefined | null, b: string | undefined | null): boolean {
  const x = cleanAddressText(a).replace(/\s+/g, "");
  const y = cleanAddressText(b).replace(/\s+/g, "");
  return Boolean(x) && x === y;
}

/** 番地のない短い地名 (例: 須屋) が住所 (例: 合志市須屋1234-5) の一部か。「同じ地区です」の案内に使う (自動では結び付けない) */
export function areaWithin(area: string | undefined | null, address: string | undefined | null): boolean {
  const a = cleanAddressText(area).replace(/\s+/g, "").replace(/^熊本県/, "");
  const b = cleanAddressText(address).replace(/\s+/g, "");
  return a.length >= 2 && !/\d/.test(a) && b.includes(a);
}

/**
 * 番地のない地区 (予定表の取込の「豊岡」「植木平井」「菊鹿町池永」など) が、番地まである住所 (「合志市豊岡459」「熊本市北区植木町平井123」) の地区か。
 * areaWithin より広く、途中の「町」「村」「大字」「字」の省略も同じとみる。数字のある地区 (「須屋12」) は数字の途中で切れないときだけ (須屋12 = 須屋12-3、須屋12 ≠ 須屋1234)
 */
export function areaMatches(area: string | undefined | null, address: string | undefined | null): boolean {
  const flat = (t: string | undefined | null) => cleanAddressText(t).replace(/\s+/g, "").replace(/^(?:〒?\d{3}-?\d{4})/, "").replace(/^日本/, "");
  const a = flat(area).replace(/^(北海道|東京都|京都府|大阪府|[^\d市区町村郡]{2,3}県)/, "");
  const b = flat(address);
  if (a.length < 2 || !b) return false;
  const loose = (t: string) => t.replace(/大字|字/g, "").replace(/[町村](?=.)/g, "").replace(/[ヶヵ]/g, "ケ");
  const found = (x: string, y: string) => {
    if (x.length < 2) return false;
    for (let i = y.indexOf(x); i >= 0; i = y.indexOf(x, i + 1)) {
      if (!/\d$/.test(x) || !/^\d/.test(y.slice(i + x.length))) return true;
    }
    return false;
  };
  return found(a, b) || found(loose(a), loose(b));
}

export const PRECISION_LABEL: Record<AddressPrecision, string> = {
  house: "番地まで",
  area: "番地なし・地区まで (位置は要確認)",
  none: "住所なし",
};
