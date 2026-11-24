import type { Customer } from "@/lib/db/types";
import { cleanAddressText } from "@/lib/maps/address";

/**
 * 既存のお客様との照合 (住所・お名前) の部品 (お客様のご要望 2026-11-24「問い合わせ登録の紐付け候補」)
 * ------------------------------------------------------------
 * 手書きのメモ・電話の受付の住所は、県・郡・市・区を省いて「○○町△△117」「北区○○5丁目9-17」「○○2127」のように書かれることが多い。
 * 登録済みのお客様の住所も「□□郡○○町△△117」「熊本市北区○○町△△213-5」「○○」(移行した顧客は町名だけ) とばらばら。
 * そのため、県・市区郡を省いても同じ住所と分かるように、住所を「町名 + 番地」に分けて比べる。
 *   exact   = 町名と番地が同じ (片方の住所がもう片方の住所の終わりの部分と同じ: 「○○町△△117」と「□□郡○○町△△117」)
 *   partial = 町名が同じで、番地の一部が同じ (「○○2127」と「○○2127-120」。号まで書かれていないメモ)
 *   building = 番地が同じで、部屋番号が違う (同じマンション・アパートのほかのお宅)
 *   town    = 町名だけ同じ (番地がないか違う) — 同じ町のほかのお宅のことがあるため、住所の一致には数えない
 * 建物名は比べない (書き方がまちまち)。部屋番号は両方にあるときだけ比べる。データは変えない (純粋関数)
 */

export type AddressMatch = "exact" | "partial" | "building" | "town";

const PREF = /^(東京都|北海道|(?:京都|大阪)府|[^\d]{2,3}?県)/;
/** 町名の前の 郡+町村・市 (+区)・区 (熊本市を省いた「北区」) */
const HEAD = /^(?:[^\d]{1,6}?郡[^\d]{1,5}?[町村]|[^\d]{1,6}?市(?:[^\d]{1,4}?区)?|[^\d]{1,3}?区)/;

export interface AddressParts {
  /** 番地の前まで (県を除く。例: □□郡○○町△△) */
  town: string;
  /** 市区郡を除いた町名 (例: △△・○○町△△) */
  core: string;
  /** 番地 (例: 117・5-9-17・2127-120)。なければ "" */
  num: string;
  /** 建物名のあとの部屋番号 (例: 1409・602)。なければ "" */
  room: string;
}

export function addressParts(raw: string | undefined | null): AddressParts {
  let t = cleanAddressText(raw ?? "")
    .replace(/\s+/g, "")
    .replace(PREF, "")
    .replace(/(丁目|番地|番|号)/g, "-")
    .replace(/(\d)の(?=\d)/g, "$1-")
    .replace(/-{2,}/g, "-");
  t = t.replace(/^-+/, "");
  const i = t.search(/\d/);
  const town = (i < 0 ? t : t.slice(0, i)).replace(/-+$/, "");
  const numRaw = i < 0 ? "" : (/^[\d-]+/.exec(t.slice(i))?.[0] ?? "");
  const num = numRaw.replace(/-+$/, "");
  const after = i < 0 ? "" : t.slice(i + numRaw.length);
  // 建物名 (数字でない文字) のあとの最後の数 = 部屋番号 (「○○ハイム弍番館1409」「△△マンション602-」)
  const room = /[^\d-]/.test(after) ? (/(\d+)-?$/.exec(after)?.[1] ?? "") : "";
  const head = HEAD.exec(town)?.[0] ?? "";
  const core = town.slice(head.length) || town;
  return { town, core, num, room };
}

/** 町名が同じか (市区郡の書き方が違っても: 「○○町△△」と「□□郡○○町△△」・「北区○○」と「熊本市北区○○」) */
function sameTown(a: AddressParts, b: AddressParts): boolean {
  if (!a.town || !b.town) return false;
  if (a.core && a.core === b.core) return true;
  const [s, l] = a.town.length <= b.town.length ? [a.town, b.town] : [b.town, a.town];
  return l.endsWith(s) && (s.length >= 2 || a.num !== "" || b.num !== "");
}

/** 番地の一部が同じ (片方が短い: 「2127」と「2127-120」。短い方は 3 桁以上か 2 つ以上の数) */
function partialNumber(a: string, b: string): boolean {
  if (!a || !b || a === b) return false;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (!l.startsWith(`${s}-`)) return false;
  return s.includes("-") || s.replace(/-/g, "").length >= 3;
}

/** 2 つの住所の一致の度合い (一致しないときは undefined) */
export function addressMatch(a: string | undefined | null, b: string | undefined | null): AddressMatch | undefined {
  const x = addressParts(a);
  const y = addressParts(b);
  if (!sameTown(x, y)) return undefined;
  if (x.num && x.num === y.num) return x.room && y.room && x.room !== y.room ? "building" : "exact";
  if (partialNumber(x.num, y.num)) return "partial";
  return "town";
}

/** 移行した顧客の地区 (住所の欄がない) が、受付の住所の町名に含まれる */
export function areaInAddress(area: string | undefined, address: string | undefined): boolean {
  const a = cleanAddressText(area ?? "").replace(/\s+/g, "");
  if (a.length < 2) return false;
  return addressParts(address).town.includes(a);
}

/* ---------------- お名前 ---------------- */

const SAMA = /(様|さま|さん|殿|御中)$/u;
const squash = (s: string | undefined) => (s ?? "").normalize("NFKC").replace(/[\s　]+/g, "").replace(SAMA, "");
const toKata = (s: string) => s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
const isKana = (s: string) => /^[\p{Script=Hiragana}\p{Script=Katakana}ー]+$/u.test(s);

/** お客様の姓 (空白の前。空白がなければ名前の全体 = 移行した顧客は姓だけのことが多い) */
const surnameOf = (name: string) => squash((name ?? "").normalize("NFKC").trim().split(/[\s　]+/)[0]);

export type NameMatch = "full" | "surname";

/**
 * 受付のお名前とお客様の一致: full = 氏名が同じ / surname = 名字が同じ。
 * 受付のお名前は「村上八司」(空白なし)・「石原」(姓だけ)・「オガタ」「さかもと とくじゅ」(かな) のことがあるので、
 * 空白があれば姓どうし、なければ お客様の姓で始まるか (1 文字の姓は全体が同じときだけ) で比べる。かなはお客様のふりがなと比べる
 */
export function nameMatch(input: { name?: string; kana?: string }, c: Pick<Customer, "name" | "kana">): NameMatch | undefined {
  const raw = (input.name ?? "").normalize("NFKC").trim().replace(SAMA, "").trim();
  const full = squash(raw);
  if (!full) return undefined;
  const cFull = squash(c.name);
  if (cFull && cFull === full) return "full";
  const cSei = surnameOf(c.name);
  const spaced = /[\s　]/.test(raw);
  const sei = spaced ? squash(raw.split(/[\s　]+/)[0]) : "";
  if (cSei) {
    if (spaced ? sei === cSei : full === cSei || (cSei.length >= 2 && full.startsWith(cSei))) return "surname";
  }
  // かな (受付のお名前がかな・または ふりがなの欄) → お客様のふりがな
  const kanaIn = [input.kana, isKana(full) ? raw : ""].map((k) => toKata((k ?? "").normalize("NFKC").trim())).filter(Boolean);
  const cKana = toKata((c.kana ?? "").normalize("NFKC").trim());
  if (cKana && kanaIn.length) {
    const cKanaFull = cKana.replace(/[\s　]+/g, "");
    const cKanaSei = cKana.split(/[\s　]+/)[0];
    for (const k of kanaIn) {
      const kf = k.replace(/[\s　]+/g, "");
      if (kf && kf === cKanaFull) return "full";
      const ks = /[\s　]/.test(k) ? k.split(/[\s　]+/)[0] : "";
      if (cKanaSei.length >= 2 && (ks ? ks === cKanaSei : kf.startsWith(cKanaSei))) return "surname";
    }
  }
  return undefined;
}
