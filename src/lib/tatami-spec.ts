/**
 * 畳の製造の仕様 (部屋ごと) — お客様のご要望 2026-11-23「畳製造予定: 畳表・畳縁・畳床・寸法を部屋ごとに」
 * ------------------------------------------------------------
 * 製造の現場は、畳数だけでなく 部屋ごとに 畳表・畳縁 (縁無)・畳床 (種類・厚み)・寸法 が分からないと作れない。
 * - 仕様は TatamiRoom (types.ts) の並び。見積 (Quote.tatamiRooms)・受注 (Order.tatamiRooms)・畳製造予定の受注のない行
 *   (TatamiProduction.rooms) に持つ。どこにもなければ見積の明細と手書きの備考 (サイズ・わら・建材) から自動で作る (roomsFromLines)
 * - 移行した予定表の引き取りは、工場の製造の表の行 (予定のメモの「製造: …」) から作る (roomsFromSheetMemo)
 * - 空の項目は未確定。画面では「寸法未確認」「畳床未確認」のように出し、あとから入れ・直せる (表替え・裏返しは今の床を使う)
 * - 1 部屋に寸法が 2 種類以上 (「630×290－4枚、580×630－2枚」) は sizes に寸法ごとの枚数 (roomSizes で 1 種類の size と同じに扱う)
 * - マイトスタット巻き込み (製造の加工) は部屋ごとの mite。見積の明細の「マイトスタット巻き込み」から部屋が決まるときだけ自動で付け、
 *   決まらなければ「マイトの部屋を確認」。敷き込み (現場で敷く) は製造に関係ないので付けない (お客様のご要望 2026-11-26)
 * ブラウザー (入力の部品) とサーバーの両方から使う純粋関数。データベースには触れない
 */
import type { QuoteItem, SiteInfo, TatamiRoom, TatamiSize } from "@/lib/db/types";
import { lineKind, miteKindOf } from "@/lib/line-kind";

export type TatamiWork = TatamiRoom["work"];
export const TATAMI_WORK_LABEL: Record<TatamiWork, string> = { omote: "表替え", ura: "裏返し", new: "新調" };
export const TATAMI_WORKS = Object.keys(TATAMI_WORK_LABEL) as TatamiWork[];

/** 畳床の種類 (入力の候補。ほかの書き方もできる) */
export const DOKO_TYPES = ["本ワラ床", "わらサンド床", "建材床", "建材床 (3型)", "建材床 (ポリスチレン)", "床暖房用畳床", "うす床"];
/** 寸法 (入力の候補。mm で「880×1760」とも書ける) */
export const SIZE_CHOICES = ["本間 (京間)", "中京間 (三六)", "六一間", "江戸間 (五八)", "団地間 (五六)"];
export const THICKNESS_CHOICES = ["15mm", "20mm", "25mm", "30mm", "35mm", "40mm", "45mm", "50mm", "55mm", "60mm"];
/** 1 案件の部屋の上限 */
export const MAX_ROOMS = 30;
/** 1 部屋の寸法の種類の上限 */
export const MAX_SIZES = 6;

const nk = (v: unknown) =>
  String(v ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();

let seq = 0;
export function newRoomId(): string {
  seq = (seq + 1) % 1296;
  return `tr_${Date.now().toString(36)}${seq.toString(36).padStart(2, "0")}${Math.random().toString(36).slice(2, 5)}`;
}

/** 部屋の見出し (空なら「部屋 1」…) */
export const roomLabel = (r: Pick<TatamiRoom, "room">, i: number): string => r.room?.trim() || `部屋 ${i + 1}`;
export const fmtQty = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** 厚みを書くべき畳床 (建材床・床暖房用など。本ワラ床・わらサンド床は決まった厚み) */
export const needsThickness = (doko: string | undefined) => Boolean(doko && !/本ワラ|本わら|わらサンド|ワラサンド|^わら床|^ワラ床|今の床/.test(doko));

/** 未確定の項目 (表示は「寸法未確認」など)。表替え・裏返しは今の床を使うので畳床は聞かない。裏返しは今の畳表 */
export function roomPending(r: TatamiRoom): string[] {
  const out: string[] = [];
  if (!(r.qty > 0)) out.push("畳数");
  if (r.work !== "ura" && !r.omote?.trim()) out.push("畳表");
  if (!r.herinashi && !r.heri?.trim()) out.push("畳縁");
  if (r.work === "new") {
    if (!r.doko?.trim()) out.push("畳床");
    else if (needsThickness(r.doko) && !r.dokoThickness?.trim()) out.push("厚み");
  }
  if (!roomSizes(r).length) out.push("寸法");
  return out;
}

/** 部屋の寸法 (寸法ごとの枚数。1 種類の size も 1 行にする) */
export function roomSizes(r: Pick<TatamiRoom, "size" | "sizes">): TatamiSize[] {
  const list = (r.sizes ?? []).filter((x) => x?.size?.trim());
  if (list.length) return list;
  return r.size?.trim() ? [{ size: r.size.trim() }] : [];
}

/** 寸法の文 (例: 630×290 4枚・580×630 2枚 / 本間) */
export function sizesText(r: Pick<TatamiRoom, "size" | "sizes">): string {
  return roomSizes(r)
    .map((x) => `${x.size}${x.qty ? ` ${fmtQty(x.qty)}枚` : ""}`)
    .join("・");
}

/** 部屋の合計 (畳数・へり無し畳の枚数) */
export function roomTotals(rooms: TatamiRoom[]): { qty: number; herinashi: number; herinashiSeen: boolean; pending: number } {
  let qty = 0;
  let herinashi = 0;
  let pending = 0;
  for (const r of rooms) {
    qty += r.qty > 0 ? r.qty : 0;
    if (r.herinashi) herinashi += r.qty > 0 ? r.qty : 0;
    if (roomPending(r).length) pending++;
  }
  return { qty, herinashi, herinashiSeen: rooms.some((r) => r.herinashi), pending };
}

/* ---------------- 明細の言葉から読む ---------------- */

const SIZE_WORDS: [RegExp, string][] = [
  [/中京間|三六/, "中京間 (三六)"],
  [/本間|(?<!中)京間/, "本間 (京間)"],
  [/江戸間|五八/, "江戸間 (五八)"],
  [/団地間|五六/, "団地間 (五六)"],
  [/六一/, "六一間"],
  [/六三/, "六三間"],
  [/六四/, "六四間"],
  [/六〇|六十間/, "六〇間"],
];
const MM_SIZE = /(\d{3,4})\s*[x×*＊]\s*(\d{3,4})/;
const MM_SIZE_ALL = /(\d{3,4})\s*[x×*＊]\s*(\d{3,4})(?:\s*[-−ー－‐:：=＝]?\s*(\d{1,3}(?:\.\d)?)(?![\d.x×*＊])\s*(?:枚|畳|帖)?)?/g;

/**
 * 寸法と枚数の並び (「630×290－4枚、580×630－2枚」→ 2 種類)。mm の寸法が 2 つ以上あるときだけ (1 つなら sizeIn)
 */
export function sizesIn(text: string): TatamiSize[] {
  const t = nk(text);
  const out: TatamiSize[] = [];
  for (const m of t.matchAll(MM_SIZE_ALL)) {
    const qty = m[3] ? Number(m[3]) : undefined;
    out.push({ size: `${m[1]}×${m[2]}`, ...(qty && qty > 0 ? { qty } : {}) });
  }
  return out.length >= 2 ? out.slice(0, MAX_SIZES) : [];
}

/** 寸法の言葉 (本間・五八・六一・880×1760) */
export function sizeIn(text: string): string | undefined {
  const t = nk(text);
  const mm = MM_SIZE.exec(t);
  if (mm) return `${mm[1]}×${mm[2]}`;
  return SIZE_WORDS.find(([re]) => re.test(t))?.[1];
}

/** 畳床の厚み (「55mm」「t=19」「厚40」) */
export function thicknessIn(text: string): string | undefined {
  const t = nk(text);
  const m = /(?:t\s*=?\s*|厚み?\s*)(\d{1,2}(?:\.\d)?)(?!\d)/i.exec(t) ?? /(?<![\d.])(\d{1,2}(?:\.\d)?)\s*(?:mm|ミリ|㎜|厚)/i.exec(t);
  return m ? `${m[1]}mm` : undefined;
}

const DOKO_WORDS: [RegExp, string][] = [
  [/床暖/, "床暖房用畳床"],
  [/わらサンド|ワラサンド|藁サンド/, "わらサンド床"],
  [/本ワラ|本わら|本藁|わら床|ワラ床|藁床|稲わら/, "本ワラ床"],
  [/(?:3|三|III)型/i, "建材床 (3型)"],
  [/(?:2|二|II)型/i, "建材床 (2型)"],
  [/(?:1|一|I)型床/i, "建材床 (1型)"],
  [/スタイロ|ポリスチレン/, "建材床 (ポリスチレン)"],
  [/オールボード/, "建材床 (オールボード)"],
  [/たたみっこ/, "建材床 (たたみっこ)"],
  [/建材/, "建材床"],
  [/うす床|薄床|薄畳/, "うす床"],
];
/** 畳床の種類 (新調の明細の言葉から) */
export function dokoIn(text: string): string | undefined {
  const t = nk(text);
  return DOKO_WORDS.find(([re]) => re.test(t))?.[1];
}

const ROOM_RE = /(?:[1-3一二三]\s*階|[1-3]\s*F)?\s*(?:和室|洋室|仏間|客間|居間|座敷|茶の間|寝室|子供部屋|床の間|納戸|離れ|事務所|道場)(?:\s*\d+(?:\.\d)?\s*(?:畳|帖))?|(?:[1-3一二三]\s*階|[1-3]\s*F)\s*(?:\d+(?:\.\d)?\s*(?:畳|帖))?|\d+(?:\.\d)?\s*(?:畳|帖)間/;
/** 部屋の言葉 (「1階 和室」「仏間」「6畳間」) */
export function roomIn(text: string): string | undefined {
  const m = ROOM_RE.exec(nk(text));
  return m ? nk(m[0]) : undefined;
}

/** 畳表の品名 (明細の品名・仕様から作業・数量・寸法・畳床・部屋の言葉を除いた残り) */
function omoteIn(name: string, spec: string | undefined, work: TatamiWork): string | undefined {
  if (work === "ura") return undefined;
  let t = nk(`${name} ${spec ?? ""}`);
  t = t
    .replace(MM_SIZE, " ")
    .replace(ROOM_RE, " ")
    .replace(/畳表替え?|畳表|表替え?|畳替え|裏返し|新調|縁代込み?|へり代込み?|ヘリ代込み?|縁込み?|へり無し|ヘリ無し|縁無し?|琉球|半畳|炉(?:あり|有り?|付き?)?/g, " ")
    .replace(/(?<![\w])\d+(?:\.\d)?\s*(?:畳|帖|枚)(?:間)?/g, " ")
    .replace(/中京間|本間|京間|江戸間|団地間|三六|五八|五六|六一|六三|六四|六〇/g, " ")
    .replace(/(?:t\s*=?\s*|厚み?\s*)\d{1,2}(?:\.\d)?(?:mm|ミリ|㎜)?|\d{1,2}(?:\.\d)?\s*(?:mm|ミリ|㎜|厚)/gi, " ")
    .replace(/本ワラ床?|本わら床?|わらサンド床?|ワラサンド床?|わら床|ワラ床|稲わら|床暖房?用?(?:畳床)?|(?:[1-3一二三]|III|II|I)型床?|スタイロ床?|ポリスチレン床?|オールボード|たたみっこ|建材床?|うす床|薄床|畳床/gi, " ")
    .replace(/(^|\s)畳(?=\s|$)/g, " ")
    .replace(/[+＋()（）・/]+/g, " ");
  t = nk(t);
  return t || undefined;
}

/** 縁の明細の品名 (「畳縁 アラベスク510」→「アラベスク510」) */
function heriIn(name: string, spec: string | undefined): string | undefined {
  const t = nk(`${name} ${spec ?? ""}`)
    .replace(/畳縁|畳へり|縁代|へり|ヘリ|縁/g, " ")
    .replace(/(?<![\w])\d+(?:\.\d)?\s*(?:畳|帖|枚|m)(?![\w])/g, " ")
    .replace(/(^|\s)畳(?=\s|$)/g, " ");
  return nk(t) || undefined;
}

/** 数える単位 (畳・枚・帖・空) の数量だけを畳数にする (「一式」「m」は未確認) */
const pieceQty = (qty: number, unit: string | undefined) => (Number.isFinite(qty) && qty > 0 && /^(畳|枚|帖|)$/.test(nk(unit)) ? Math.round(qty * 10) / 10 : 0);

/** 手書きの備考の「わら A / B」「建材 A / B」(表替え・裏返しの今の床) */
function existingFloor(site: SiteInfo | undefined): string | undefined {
  const parts = [site?.straw ? `わら ${nk(site.straw)}` : "", site?.material ? `建材 ${nk(site.material)}` : ""].filter(Boolean);
  return parts.length ? `今の床 (${parts.join("・")})` : undefined;
}

export interface LineSource {
  items: Pick<QuoteItem, "name" | "spec" | "qty" | "unit" | "productId" | "dokoMaterialId">[];
  siteInfo?: SiteInfo;
  /** 商品マスタの分類 */
  productCategory?: (productId: string) => string | undefined;
  /** 材料マスタの名前 (見積の明細で選んだ畳床) */
  materialName?: (materialId: string) => string | undefined;
}

/**
 * 見積の明細 → 部屋ごとの仕様 (畳の明細 1 行 = 1 部屋)。
 * 縁の明細が 1 行ならすべての部屋に、複数なら畳数が同じ部屋 → 並びの順に当てる (決まらなければ品名を並べて「部屋を確認」)。
 * 寸法が明細になければ手書きの備考の「サイズ」(例: 本間・610 t=19。呼び名でなければ書かれたまま) を使う。
 * 畳床の厚みは明細に書いてあるときだけ (建材床は見積の時点で決まらないことが多いため、備考の数字からは決めない)
 */
export function roomsFromLines(src: LineSource): TatamiRoom[] {
  const lines = src.items.map((it) => ({ it, k: lineKind(it.name, it.spec, it.productId ? src.productCategory?.(it.productId) : undefined) }));
  const tatami = lines.filter((x) => x.k?.kind === "tatami");
  const heriLines = lines.filter((x) => x.k?.kind === "heri").map((x) => ({ name: heriIn(x.it.name, x.it.spec), qty: pieceQty(x.it.qty, x.it.unit) })).filter((x) => x.name);
  const siteSizeText = nk(src.siteInfo?.sizes);
  const floor = existingFloor(src.siteInfo);
  const rooms: TatamiRoom[] = tatami.map(({ it, k }) => {
    const text = nk(`${it.name} ${it.spec ?? ""}`);
    const work: TatamiWork = k?.tatami ?? "omote";
    const r: TatamiRoom = { id: newRoomId(), work, qty: pieceQty(it.qty, it.unit) };
    const room = roomIn(text);
    if (room) r.room = room;
    const omote = omoteIn(it.name, it.spec, work);
    if (omote) r.omote = omote;
    if (k?.herinashi) r.herinashi = true;
    const many = sizesIn(text);
    const size = sizeIn(text) ?? (siteSizeText ? sizeIn(siteSizeText) ?? siteSizeText : undefined);
    if (many.length) r.sizes = many;
    else if (size) r.size = size;
    // 畳の行そのものに「マイトスタット巻き込み」と書いてある
    if (miteKindOf(text) === "wrap") r.mite = true;
    if (work === "new") {
      const doko = (it.dokoMaterialId ? src.materialName?.(it.dokoMaterialId) : undefined) ?? dokoIn(text);
      if (doko) r.doko = doko;
      const th = thicknessIn(text);
      if (th) r.dokoThickness = th;
    } else if (floor) r.doko = floor;
    const notes = [k?.half ? "半畳" : "", /炉/.test(text) ? "炉あり" : ""].filter(Boolean);
    if (notes.length) r.note = notes.join("・");
    return r;
  });
  // 備考の「サイズ」に寸法が 2 種類以上 (部屋が 1 つのときだけ。部屋が複数なら どの部屋か分からないので書かれたまま)
  const siteMany = sizesIn(siteSizeText);
  if (siteMany.length && rooms.length === 1 && !rooms[0].sizes) {
    rooms[0].sizes = siteMany;
    delete rooms[0].size;
  }
  // マイトスタット巻き込みの明細 (別の行): 部屋が 1 つ・畳数が全部屋の合計・畳数が同じ部屋が 1 つ なら その部屋。決まらなければ「部屋を確認」
  const miteLines = lines.filter((x) => x.k?.kind === "mite" && x.k.mite === "wrap").map((x) => pieceQty(x.it.qty, x.it.unit));
  if (miteLines.length && rooms.length && !rooms.some((r) => r.mite)) {
    const total = rooms.reduce((a, r) => a + (r.qty > 0 ? r.qty : 0), 0);
    const want = miteLines.reduce((a, q) => a + q, 0);
    const pick = (list: TatamiRoom[]) => list.forEach((r) => (r.mite = true));
    if (rooms.length === 1 || (want > 0 && Math.abs(want - total) < 0.01)) pick(rooms);
    else {
      const hits = miteLines.map((q) => rooms.filter((r) => q > 0 && r.qty === q));
      if (hits.every((h) => h.length === 1) && new Set(hits.map((h) => h[0].id)).size === hits.length) pick(hits.map((h) => h[0]));
      else for (const r of rooms) r.note = [r.note, "マイト (巻き込み) の部屋を確認"].filter(Boolean).join("・");
    }
  }
  // 縁
  const need = rooms.filter((r) => !r.herinashi);
  if (heriLines.length === 1) for (const r of need) r.heri = heriLines[0].name;
  else if (heriLines.length > 1) {
    const left = [...heriLines];
    const open = [...need];
    for (const h of [...left]) {
      const hits = open.filter((r) => r.qty > 0 && r.qty === h.qty);
      if (hits.length === 1) {
        hits[0].heri = h.name;
        open.splice(open.indexOf(hits[0]), 1);
        left.splice(left.indexOf(h), 1);
      }
    }
    if (left.length && left.length === open.length) open.forEach((r, i) => (r.heri = left[i].name));
    else if (left.length && open.length) {
      for (const r of open) {
        r.heri = left.map((h) => h.name).join("・");
        r.note = [r.note, "縁は部屋を確認"].filter(Boolean).join("・");
      }
    }
  }
  return rooms;
}

/**
 * 移行した予定表の引き取りのメモの「製造: 表 6枚 / 表 きずな / 縁 浮14 / サイズ 61 / 床 建材」(工場の製造の表の 1 行 = 1 部屋)
 */
export function roomsFromSheetMemo(memo: string | undefined): TatamiRoom[] {
  const out: TatamiRoom[] = [];
  for (const line of String(memo ?? "").split("\n")) {
    const m = /^製造:\s*(.*)$/.exec(nk(line));
    if (!m) continue;
    const segs = m[1].split(" / ").map(nk);
    const head = segs.shift() ?? "";
    const qm = /(\d+(?:\.\d)?)\s*枚/.exec(head);
    const kind = nk(head.replace(/(\d+(?:\.\d)?)\s*枚/, ""));
    const work: TatamiWork = /裏|うら/.test(kind) ? "ura" : /新/.test(kind) ? "new" : "omote";
    const r: TatamiRoom = { id: `tr_sheet${out.length + 1}`, work, qty: qm ? Number(qm[1]) : 0 };
    const notes = [/半/.test(kind) ? "半畳" : "", /炉/.test(kind) ? "炉あり" : ""].filter(Boolean);
    for (const s of segs) {
      const kv = /^(表|縁|サイズ|床)\s+(.+)$/.exec(s);
      if (/^縁無/.test(s)) r.herinashi = true;
      else if (kv?.[1] === "表") r.omote = kv[2];
      else if (kv?.[1] === "縁") {
        if (/^無し?$|^なし$/.test(kv[2])) r.herinashi = true;
        else r.heri = kv[2];
      } else if (kv?.[1] === "サイズ") r.size = kv[2];
      else if (kv?.[1] === "床") {
        const th = thicknessIn(kv[2]);
        r.doko = work === "new" ? (dokoIn(kv[2]) ?? kv[2]) : `今の床 (${kv[2]})`;
        if (th && work === "new") r.dokoThickness = th;
      }
    }
    if (notes.length) r.note = notes.join("・");
    out.push(r);
  }
  return out;
}

/* ---------------- 入力の確かめ ---------------- */

const str = (v: unknown, max: number) => (typeof v === "string" ? nk(v).slice(0, max) : "");

/** 画面から受け取った部屋の並びの確かめ。何も書いていない行は省く */
export function cleanRooms(raw: unknown): { rooms: TatamiRoom[]; error?: string } {
  if (raw === undefined || raw === null || raw === "") return { rooms: [] };
  if (!Array.isArray(raw)) return { rooms: [], error: "仕様の形式が正しくありません。" };
  if (raw.length > MAX_ROOMS) return { rooms: [], error: `部屋は ${MAX_ROOMS} 行までです。` };
  const rooms: TatamiRoom[] = [];
  const ids = new Set<string>();
  for (const x of raw as Record<string, unknown>[]) {
    if (!x || typeof x !== "object") continue;
    const work = x.work === "ura" || x.work === "new" ? x.work : "omote";
    const q = typeof x.qty === "number" ? x.qty : Number(String(x.qty ?? "").normalize("NFKC"));
    if (x.qty !== undefined && x.qty !== "" && (!Number.isFinite(q) || q < 0 || q > 500)) return { rooms: [], error: "畳数は 0〜500 の数で入れてください (半畳は 0.5)。" };
    let id = typeof x.id === "string" && /^tr_[a-z0-9]{3,30}$/.test(x.id) ? x.id : newRoomId();
    if (ids.has(id)) id = newRoomId();
    const r: TatamiRoom = { id, work, qty: Number.isFinite(q) && q > 0 ? Math.round(q * 10) / 10 : 0 };
    const set = (k: "room" | "omote" | "heri" | "doko" | "dokoThickness" | "size" | "note", max: number) => {
      const v = str(x[k], max);
      if (v) r[k] = v;
    };
    set("room", 30);
    set("omote", 60);
    set("heri", 60);
    set("doko", 40);
    set("dokoThickness", 20);
    set("size", 40);
    set("note", 100);
    if (x.herinashi === true || x.herinashi === "1" || x.herinashi === "true") {
      r.herinashi = true;
      delete r.heri;
    }
    if (x.mite === true || x.mite === "1" || x.mite === "true") r.mite = true;
    // 寸法ごとの枚数 (2 種類以上)。1 種類で枚数がなければ size にする
    if (Array.isArray(x.sizes)) {
      const list: TatamiSize[] = [];
      for (const z of x.sizes as Record<string, unknown>[]) {
        const size = str(z?.size, 40);
        if (!size) continue;
        const zq = typeof z.qty === "number" ? z.qty : Number(String(z.qty ?? "").normalize("NFKC"));
        if (z.qty !== undefined && z.qty !== "" && (!Number.isFinite(zq) || zq < 0 || zq > 500)) return { rooms: [], error: "寸法ごとの枚数は 0〜500 の数で入れてください。" };
        list.push({ size, ...(Number.isFinite(zq) && zq > 0 ? { qty: Math.round(zq * 10) / 10 } : {}) });
      }
      if (list.length > MAX_SIZES) return { rooms: [], error: `1 部屋の寸法は ${MAX_SIZES} 種類までです。` };
      if (list.length === 1 && !list[0].qty) {
        r.size = list[0].size;
      } else if (list.length) {
        r.sizes = list;
        delete r.size;
      }
    }
    if (r.dokoThickness && /^\d+(\.\d)?$/.test(r.dokoThickness)) r.dokoThickness = `${r.dokoThickness}mm`;
    const empty = !r.qty && !r.room && !r.omote && !r.heri && !r.herinashi && !r.doko && !r.dokoThickness && !r.size && !r.sizes && !r.mite && !r.note;
    if (empty) continue;
    ids.add(id);
    rooms.push(r);
  }
  return { rooms };
}

/** 同じ仕様か (保存の要否) */
export function sameRooms(a: TatamiRoom[] | undefined, b: TatamiRoom[] | undefined): boolean {
  const canon = (v: TatamiRoom[] | undefined) => JSON.stringify(cleanRooms(v ?? []).rooms.map((r) => [r.id, r.room ?? "", r.work, r.qty, r.omote ?? "", r.heri ?? "", Boolean(r.herinashi), r.doko ?? "", r.dokoThickness ?? "", r.size ?? "", (r.sizes ?? []).map((z) => [z.size, z.qty ?? 0]), Boolean(r.mite), r.note ?? ""]));
  return canon(a) === canon(b);
}

/** 1 部屋の文 (変更履歴・一覧の表示。例: 和室 表替え 6畳 表 きずな / 縁 マス菊 / 床 今の床 / 寸法未確認) */
export function roomText(r: TatamiRoom, i: number): string {
  const floor = r.work === "new" ? (r.doko ? `床 ${r.doko}${r.dokoThickness ? ` ${r.dokoThickness}` : needsThickness(r.doko) ? " (厚み未確認)" : ""}` : "畳床未確認") : r.doko ? `床 ${r.doko}` : "";
  return [
    `${roomLabel(r, i)} ${TATAMI_WORK_LABEL[r.work]} ${r.qty > 0 ? `${fmtQty(r.qty)}畳` : "畳数未確認"}`,
    r.work === "ura" ? "" : r.omote ? `表 ${r.omote}` : "畳表未確認",
    r.mite ? "マイト (巻き込み)" : "",
    r.herinashi ? "縁無" : r.heri ? `縁 ${r.heri}` : "畳縁未確認",
    floor,
    roomSizes(r).length ? `寸法 ${sizesText(r)}` : "寸法未確認",
    r.note ?? "",
  ]
    .filter(Boolean)
    .join(" / ");
}

export function roomsText(rooms: TatamiRoom[] | undefined): string {
  const list = cleanRooms(rooms ?? []).rooms;
  return list.length ? list.map(roomText).join(" ／ ") : "(なし)";
}
