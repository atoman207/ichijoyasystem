/**
 * 受注の品目ごとの引取日・納品日 (お客様のご要望 2026-11-23「■ 予定表への反映方法」「■ 引取日・納品日の登録・変更」)
 * ------------------------------------------------------------
 * - 畳・襖・障子・網戸は、予定表に「引き取り」と「納品」の日だけを載せる (間の日には出さない)。
 *   リフォーム (工事) はこれまでどおり施工期間 (開始日〜終了日) の「施工」の予定。
 * - 1 つの案件の品目ごとに引取日・納品日を持つ (例: 畳の表替えは当日納品・襖は後日納品)。
 *   同じ日・同じ時間の引き取り (納品) は 1 回の訪問として予定表の予定 1 件にまとめる。
 * - はじめて入れる日程 (空 → 日付) はすぐに反映し、登録済みの日程の変更 (日付・時間の変更・削除) は承認を経て反映する
 *   (承認の type = handover_change。管理者の申請は承認を省略)。
 * - 予定表の予定は受注と連動 (source = "order"・sourceRef = "handover:<pickup|delivery|install>:<日程の行の ID>+…")。
 * - 引取日・納品日は日付 + 時間 (指定なし / 午前 AM / 午後 PM / 時刻)。午前・午後は予定表の予定の slot (お客様のご要望 2026-11-23「■ 引取日・納品日の設定について（追加）」)。
 * - 襖・障子・網戸 (LINKED_ITEMS) は同じ案件でまとめて引取・納品することが多いため、受注の画面では 1 つの品目に入れた日程を
 *   ほかの品目にも入れる (同じ日程の組 linkedCluster)。品目ごとに外して別の日程にもできる。保存する形は品目ごとの日程のまま。
 *
 * ブラウザー (受注の画面の入力) とサーバーの両方から使う純粋関数。データベースには触れない。
 */
import type { HandoverItem, HandoverSlot, OrderHandover } from "@/lib/db/types";
import { isDateKey, normTime, shortDate, toMinutes } from "@/lib/calendar";
import { addDays } from "@/lib/format";
import { lineKind, type LineInfo } from "@/lib/line-kind";

export interface HandoverItemDef {
  label: string;
  /** handover = 引き取り・納品の 2 つの予定 / install = 施工期間の予定 (リフォーム) */
  mode: "handover" | "install";
  /** 既定で引取当日に納品するか (畳の表替え・裏返し) */
  sameDay: boolean;
  /** 入力の欄に出す説明 */
  hint: string;
}

export const HANDOVER_ITEM: Record<HandoverItem, HandoverItemDef> = {
  tatami_omote: { label: "畳 表替え", mode: "handover", sameDay: true, hint: "基本は引取当日に納品" },
  tatami_ura: { label: "畳 裏返し", mode: "handover", sameDay: true, hint: "基本は引取当日に納品" },
  tatami_new: { label: "畳 新調", mode: "handover", sameDay: false, hint: "引取日と別の日 (後日) に納品" },
  fusuma: { label: "襖", mode: "handover", sameDay: false, hint: "基本は後日納品 (当日納品もできます)" },
  shoji: { label: "障子", mode: "handover", sameDay: false, hint: "基本は後日納品 (当日納品もできます)" },
  amido: { label: "網戸", mode: "handover", sameDay: false, hint: "基本は後日納品 (当日納品もできます)" },
  other: { label: "その他", mode: "handover", sameDay: false, hint: "引き取り・納品のある品目" },
  reform: { label: "リフォーム・工事", mode: "install", sameDay: false, hint: "施工期間 (開始日〜終了日) で予定表に載ります" },
};

export const HANDOVER_ITEMS = Object.keys(HANDOVER_ITEM) as HandoverItem[];
export const isHandoverItem = (v: unknown): v is HandoverItem => typeof v === "string" && v in HANDOVER_ITEM;

/** 予定表の予定の役割 */
export type HandoverRole = "pickup" | "delivery" | "install";
export const HANDOVER_ROLE_LABEL: Record<HandoverRole, string> = { pickup: "引き取り", delivery: "納品", install: "施工" };

/** 日程の行の上限 (1 案件) */
export const MAX_HANDOVERS = 20;

export const handoverLabel = (r: Pick<OrderHandover, "item" | "label">): string => r.label?.trim() || HANDOVER_ITEM[r.item].label;
export const isInstall = (r: Pick<OrderHandover, "item">): boolean => HANDOVER_ITEM[r.item].mode === "install";

/** 午前・午後 (時刻を決めない時間帯) */
export const HANDOVER_SLOT_LABEL: Record<HandoverSlot, string> = { am: "午前", pm: "午後" };
export const isHandoverSlot = (v: unknown): v is HandoverSlot => v === "am" || v === "pm";

/** 1 つの品目に入れた日程をほかの品目にも入れる品目 (襖・障子・網戸。同じ案件でまとめて引取・納品することが多い) */
export const LINKED_ITEMS: readonly HandoverItem[] = ["fusuma", "shoji", "amido"];
export const isLinkedItem = (item: HandoverItem): boolean => LINKED_ITEMS.includes(item);

/* ---------------- 明細から品目を見分ける ---------------- */

/** 明細の種類 (src/lib/line-kind.ts) → 引取・納品の品目。縁・引手・値引き・諸経費などは品目にしない (undefined) */
function itemOfKind(k: LineInfo | undefined): HandoverItem | undefined {
  switch (k?.kind) {
    case "tatami":
      return k.tatami === "new" ? "tatami_new" : k.tatami === "ura" ? "tatami_ura" : "tatami_omote";
    case "fusuma":
    case "butsuma":
      return "fusuma";
    case "shoji":
    case "amido":
      return k.kind;
    case "curtain":
    case "reform":
      return "reform";
  }
  return undefined;
}

/**
 * 明細 1 行の品目。品名・仕様の言葉 → 商品の分類 (ServiceCategory) の順で決める (src/lib/line-kind.ts の lineKind)。
 * 縁・引手・値引き・諸経費などは品目にしない (undefined)。品名と仕様が分かれているときは name・spec を渡す
 * (品名が「襖」「畳」だけの行は仕様の「引き手」「縁」を先に見る)
 */
export function classifyLine(text: string, productCategory?: string, spec?: string): HandoverItem | undefined {
  return itemOfKind(lineKind(text, spec, productCategory));
}

/** 受注の種別 (見積の明細がないとき) の品目 */
const CATEGORY_ITEM: Record<string, HandoverItem> = { tatami: "tatami_omote", fusuma: "fusuma", shoji: "shoji", amido: "amido", cloth: "reform", curtain: "reform" };

export interface HandoverLine {
  name: string;
  spec?: string;
  qty?: number;
  unit?: string;
  /** 商品マスタの分類 (ServiceCategory) */
  productCategory?: string;
}

interface ItemGroup {
  item: HandoverItem;
  qty: number;
  unit?: string;
  mixedUnit: boolean;
}

/** 明細を品目ごとにまとめる (出てきた順。数量は単位がそろうときだけ足す) */
export function groupLines(lines: HandoverLine[], category?: string): ItemGroup[] {
  const groups: ItemGroup[] = [];
  for (const l of lines) {
    const item = classifyLine(l.name, l.productCategory, l.spec);
    if (!item) continue;
    const unit = l.unit?.trim() || undefined;
    const qty = typeof l.qty === "number" && Number.isFinite(l.qty) && l.qty > 0 ? l.qty : 0;
    const g = groups.find((x) => x.item === item);
    if (!g) groups.push({ item, qty, unit, mixedUnit: false });
    else {
      if (g.unit !== unit) g.mixedUnit = true;
      g.qty += qty;
    }
  }
  if (!groups.length && category && CATEGORY_ITEM[category]) groups.push({ item: CATEGORY_ITEM[category], qty: 0, mixedUnit: true });
  return groups;
}

/** 件名に出す名前 (例: 畳 表替え 16枚・襖 4面)。数量の単位が「式」や混ざるときは数量を出さない */
function groupLabel(g: ItemGroup): string | undefined {
  if (g.mixedUnit || !g.qty || !g.unit || /式|一式|件|回|ヶ所|箇所/.test(g.unit)) return undefined;
  const n = Math.round(g.qty * 100) / 100;
  return `${HANDOVER_ITEM[g.item].label} ${n}${g.unit}`;
}

/** 引取・納品で予定表に載せる品目があるか (なければこれまでどおりの施工予定) */
export function hasHandoverItems(lines: HandoverLine[], category?: string): boolean {
  return groupLines(lines, category).some((g) => HANDOVER_ITEM[g.item].mode === "handover");
}

/* ---------------- 手書きの日時の読み取り (見積書の「引取日時」「納品日時」) ---------------- */

export interface DateTimeHint {
  date?: string;
  start?: string;
  end?: string;
  /** 時刻がなく「AM」「午前」「PM」「午後」だけ書いてあるときの時間帯 */
  slot?: HandoverSlot;
}

export interface TextChunk extends DateTimeHint {
  /** この部分に書かれた品目 (畳・襖・障子・網戸)。空なら全部の品目 */
  kinds: ("tatami" | "fusuma" | "shoji" | "amido")[];
  /** 当日・一日仕上げ・即日 */
  sameDay: boolean;
  /** 翌日 */
  nextDay: boolean;
}

const KIND_WORDS: [TextChunk["kinds"][number], RegExp][] = [
  ["tatami", /畳|たたみ|タタミ|表替/],
  ["fusuma", /襖|フスマ|ふすま/],
  ["shoji", /障子/],
  ["amido", /網戸|アミ戸|あみ戸/],
];

/** 月/日 → 基準の日に近い年の日付 (基準の 60 日より前なら翌年) */
export function resolveMonthDay(month: number, day: number, ref: string): string | undefined {
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const y = Number(ref.slice(0, 4));
  for (const year of [y, y + 1]) {
    const d = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (!isDateKey(d)) return undefined;
    if (d >= addDays(ref, -60)) return d;
  }
  return undefined;
}

/** 時刻 (「8:30」「8時半」「3時」)。1〜6 時は午後とみなす (営業時間の 15 時を「3時」と書くため) */
function hourMinute(h: string, m?: string, half?: string): string | undefined {
  let hh = Number(h);
  const mm = half ? 30 : m ? Number(m) : 0;
  if (hh >= 1 && hh <= 6) hh += 12;
  return normTime(`${hh}:${String(mm).padStart(2, "0")}`);
}

const DATE_IN_TEXT = /(\d{1,2})\s*[/月]\s*(\d{1,2})\s*日?(?:\s*[(（][^)）]{1,3}[)）])?/g;
const TIME_RANGE = /(\d{1,2})(?::(\d{2})|時(半)?)?\s*[-〜~ー－–]\s*(\d{1,2})(?::(\d{2})|時(半)?)/;
const TIME_ONE = /(\d{1,2})(?::(\d{2})|時(半)?)/;
/** 「PM2-5」「午後2〜5」(時刻の印なしの数字の範囲。午前・午後が書いてあるときだけ) */
const AMPM_RANGE = /(AM|PM|午前|午後)\s*(\d{1,2})(?::(\d{2}))?\s*[-〜~ー－–]\s*(\d{1,2})(?::(\d{2}))?(?![\d/月])/i;
/** 時刻のない「AM」「午前 (中)」「PM」「午後」(英字の言葉の一部は数えない) */
const SLOT_AM = /(?<![A-Za-z])(?:AM|A\.M\.?)(?![A-Za-z])|午前/i;
const SLOT_PM = /(?<![A-Za-z])(?:PM|P\.M\.?)(?![A-Za-z])|午後/i;

/**
 * 「12/2 8:30〜9:00」「畳 一日仕上 15:00〜17:00、襖 12/4」「12/2(水) 8:30-9:00 襖引取 12/4畳表替え」のような手書きの日時を、
 * 部分ごとの日付・時間・品目に分ける (受注の画面の入力の初期値に使う。人が確かめてから保存する)
 */
export function parseScheduleText(text: string | undefined, ref: string): TextChunk[] {
  if (!text?.trim()) return [];
  const out: TextChunk[] = [];
  // 「12/3 畳、障子」: 日付のない品目だけの部分は、前の部分の日付を引き継ぐ
  let lastDate: string | undefined;
  for (const seg of text.normalize("NFKC").split(/[、,，;；\n]|\s\/\s/)) {
    if (!seg.trim()) continue;
    const dates = [...seg.matchAll(DATE_IN_TEXT)];
    // 日付が 2 つ以上なら日付ごとに分ける (日付の後ろの言葉がその日の品目)。1 つ以下なら部分全体
    const pieces = dates.length >= 2 ? dates.map((m, i) => seg.slice(i === 0 ? 0 : m.index, i + 1 < dates.length ? dates[i + 1].index : seg.length)) : [seg];
    for (const piece of pieces) {
      const dm = [...piece.matchAll(DATE_IN_TEXT)][0];
      const date = dm ? resolveMonthDay(Number(dm[1]), Number(dm[2]), ref) : undefined;
      const rest = dm ? piece.slice(0, dm.index) + " " + piece.slice(dm.index! + dm[0].length) : piece;
      let start: string | undefined;
      let end: string | undefined;
      const ap = AMPM_RANGE.exec(rest);
      const r = TIME_RANGE.exec(rest);
      if (ap) {
        const pm = /PM|午後/i.test(ap[1]);
        const h = (v: string) => (pm && Number(v) < 12 ? String(Number(v) + 12) : v);
        start = normTime(`${h(ap[2])}:${ap[3] ?? "00"}`);
        end = normTime(`${h(ap[4])}:${ap[5] ?? "00"}`);
        if (start && end && toMinutes(end) <= toMinutes(start)) end = undefined;
      } else if (r) {
        start = hourMinute(r[1], r[2], r[3]);
        end = hourMinute(r[4], r[5], r[6]);
        if (start && end && toMinutes(end) <= toMinutes(start)) end = undefined;
      } else {
        const one = TIME_ONE.exec(rest);
        if (one) start = hourMinute(one[1], one[2], one[3]);
      }
      // 時刻がなく午前・午後だけ (「12/4 AM」「翌日 午後」)。両方書いてあるときは決めない
      const am = SLOT_AM.test(rest);
      const pmWord = SLOT_PM.test(rest);
      const slot: HandoverSlot | undefined = start || am === pmWord ? undefined : am ? "am" : "pm";
      const kinds = KIND_WORDS.filter(([, re]) => re.test(piece)).map(([k]) => k);
      const sameDay = /当日|一日仕上|1日仕上|即日|日帰り/.test(piece);
      const nextDay = /翌日/.test(piece);
      const inherited = !date && !start && !slot && !sameDay && !nextDay && kinds.length > 0 ? lastDate : undefined;
      if (date) lastDate = date;
      if (date || start || slot || sameDay || nextDay) out.push({ date, start, end, ...(slot ? { slot } : {}), kinds, sameDay, nextDay });
      else if (inherited) out.push({ date: inherited, kinds, sameDay: false, nextDay: false });
    }
  }
  return out;
}

const KIND_OF_ITEM: Partial<Record<HandoverItem, TextChunk["kinds"][number]>> = { tatami_omote: "tatami", tatami_ura: "tatami", tatami_new: "tatami", fusuma: "fusuma", shoji: "shoji", amido: "amido" };

/** 品目に当たる部分 (品目の言葉のある部分を優先、なければ品目の言葉のない部分) */
function chunkFor(chunks: TextChunk[], item: HandoverItem): TextChunk | undefined {
  const k = KIND_OF_ITEM[item];
  return (k ? chunks.find((c) => c.kinds.includes(k)) : undefined) ?? chunks.find((c) => c.kinds.length === 0);
}

/* ---------------- 初期値 (受注の画面・見積から受注にするとき) ---------------- */

let seq = 0;
/** 日程の行の ID (受注の中で一意) */
export function newHandoverId(): string {
  seq = (seq + 1) % 1296;
  return `hv_${Date.now().toString(36)}${seq.toString(36).padStart(2, "0")}${Math.random().toString(36).slice(2, 5)}`;
}

export interface SuggestInput {
  lines: HandoverLine[];
  category?: string;
  /** 見積書の「引取日時」「納品日時」(手書きの文字) */
  pickupText?: string;
  deliveryText?: string;
  /** 決まっている引取日 (見積から受注にするときの入力。手書きの日時より優先) */
  pickupDate?: string;
  /** 手書きの日時に引取日がないときの引取日 (以前の施工開始日) */
  fallbackPickup?: string;
  /** 以前の施工終了日 (施工期間で登録していた受注) */
  endDate?: string;
  /** 年を決める基準の日 (契約日など) */
  ref: string;
}

/**
 * 明細と手書きの日時から日程の行の初期値を作る。
 * 畳の表替え・裏返しは引取当日に納品、そのほかは納品日を空にする (後日。手書きの日時に書いてあればその日)。
 * 襖・障子・網戸は、手書きの日時が品目を分けて書いていなければ同じ日程 (空の側はほかの品目の日程を入れる)
 */
export function suggestHandovers(input: SuggestInput): OrderHandover[] {
  const pick = parseScheduleText(input.pickupText, input.ref);
  const pickupRef = input.pickupDate ?? pick.find((c) => c.date)?.date ?? input.fallbackPickup ?? input.ref;
  const deliv = parseScheduleText(input.deliveryText, pickupRef);
  return fillLinked(groupLines(input.lines, input.category).map((g) => {
    const def = HANDOVER_ITEM[g.item];
    const label = groupLabel(g);
    const p = chunkFor(pick, g.item);
    const pickupDate = input.pickupDate ?? p?.date ?? pick.find((c) => c.date && c.kinds.length === 0)?.date ?? input.fallbackPickup;
    const row: OrderHandover = { id: newHandoverId(), item: g.item, ...(label ? { label } : {}) };
    if (def.mode === "install") {
      if (pickupDate) row.pickupDate = pickupDate;
      if (input.endDate && pickupDate && input.endDate > pickupDate) row.deliveryDate = input.endDate;
      return cleanRow(row);
    }
    if (pickupDate) row.pickupDate = pickupDate;
    if (p?.start) row.pickupStart = p.start;
    if (p?.end) row.pickupEnd = p.end;
    if (pickupDate && !p?.start && p?.slot) row.pickupSlot = p.slot;
    const d = chunkFor(deliv, g.item);
    const sameDay = d ? d.sameDay || (!d.date && !d.nextDay && def.sameDay) : def.sameDay;
    let deliveryDate = d?.date;
    if (!deliveryDate && pickupDate) {
      if (d?.nextDay) deliveryDate = addDays(pickupDate, 1);
      else if (sameDay) deliveryDate = pickupDate;
      else if (input.endDate && input.endDate > pickupDate) deliveryDate = input.endDate;
    }
    if (deliveryDate) row.deliveryDate = deliveryDate;
    if (d?.start) row.deliveryStart = d.start;
    if (d?.end) row.deliveryEnd = d.end;
    if (deliveryDate && !d?.start && d?.slot) row.deliverySlot = d.slot;
    return cleanRow(row);
  }));
}

/** 襖・障子・網戸の行で、引き取り (納品) の日程が空の行に、最初に日程のある襖・障子・網戸の行の値を入れる */
function fillLinked(rows: OrderHandover[]): OrderHandover[] {
  const linked = rows.filter((r) => isLinkedItem(r.item));
  if (linked.length < 2) return rows;
  for (const side of ["pickup", "delivery"] as const) {
    const fields = SIDE_FIELDS[side];
    const src = linked.find((r) => r[fields[0]]);
    if (!src) continue;
    for (const r of linked) {
      if (r === src || r[fields[0]]) continue;
      // 納品が引き取りより前になるときは入れない (引取日の違う行)
      if (side === "delivery" && r.pickupDate && src.deliveryDate! < r.pickupDate) continue;
      for (const f of fields) setField(r, f, src[f]);
    }
  }
  return rows.map(cleanRow);
}

/* ---------------- 入力の確かめ・正規化 ---------------- */

/** 引き取り・納品の日程の欄 (日付・開始時刻・終了時刻・午前/午後の順) */
export const SIDE_FIELDS = {
  pickup: ["pickupDate", "pickupStart", "pickupEnd", "pickupSlot"],
  delivery: ["deliveryDate", "deliveryStart", "deliveryEnd", "deliverySlot"],
} as const;
const ALL_FIELDS = [...SIDE_FIELDS.pickup, ...SIDE_FIELDS.delivery] as const;
type DateField = (typeof ALL_FIELDS)[number];
const isSlotField = (f: DateField): f is "pickupSlot" | "deliverySlot" => f.endsWith("Slot");

/** 日程の欄に値を入れる (空・undefined なら消す) */
function setField(r: OrderHandover, f: DateField, v: string | undefined): void {
  if (v) (r as unknown as Record<string, string>)[f] = v;
  else delete r[f];
}

/** キーの順番をそろえ、空の項目を省いた行 (比べるとき・保存するときに同じ形にする) */
function cleanRow(r: OrderHandover): OrderHandover {
  const out: OrderHandover = { id: r.id, item: r.item };
  if (r.label?.trim()) out.label = r.label.trim().slice(0, 40);
  for (const f of ALL_FIELDS) if (r[f]) setField(out, f, r[f]);
  return out;
}

/**
 * 同じ日の引き取り → 納品の順の確かめに使う、時間の幅 (分)。午前 0〜720・午後 720〜1440・時刻は開始の 1 分。
 * 時間の指定がなければ undefined (確かめない)
 */
function sideWindow(start?: string, slot?: HandoverSlot): [number, number] | undefined {
  if (start) return [toMinutes(start), toMinutes(start) + 1];
  return slot === "am" ? [0, 720] : slot === "pm" ? [720, 1440] : undefined;
}

/** 同じ日程か (キーの順番に関わらず比べる。データベースの jsonb はキーの順番を変えるため) */
export function sameHandovers(a: unknown, b: unknown): boolean {
  const canon = (v: unknown): string => {
    const r = cleanHandovers(v);
    return JSON.stringify(r.rows.map((x) => ALL_FIELDS.reduce<Record<string, string>>((o, f) => ({ ...o, [f]: x[f] ?? "" }), { id: x.id, item: x.item, label: x.label ?? "" })));
  };
  return canon(a) === canon(b);
}

/**
 * 画面・申請から受け取った日程の確かめ。返すのはキーの順番をそろえた行 (保存・比較に使う)。
 * - 日付は YYYY-MM-DD、時刻は HH:MM。時間だけで日付がない・終わりが始まりより前・納品が引き取りより前は誤り
 * - 品目のない行は省く
 */
export function cleanHandovers(raw: unknown): { rows: OrderHandover[]; error?: string } {
  if (raw === undefined || raw === null || raw === "") return { rows: [] };
  if (!Array.isArray(raw)) return { rows: [], error: "日程の形式が正しくありません。" };
  if (raw.length > MAX_HANDOVERS) return { rows: [], error: `品目は ${MAX_HANDOVERS} 行までです。` };
  const rows: OrderHandover[] = [];
  const ids = new Set<string>();
  for (const x of raw as Record<string, unknown>[]) {
    if (!x || typeof x !== "object" || !isHandoverItem(x.item)) continue;
    let id = typeof x.id === "string" && /^hv_[a-z0-9]{3,30}$/.test(x.id) ? x.id : newHandoverId();
    if (ids.has(id)) id = newHandoverId();
    ids.add(id);
    const row: OrderHandover = { id, item: x.item };
    const name = typeof x.label === "string" ? x.label.trim().slice(0, 40) : "";
    if (name) row.label = name;
    const label = handoverLabel(row);
    for (const f of ALL_FIELDS) {
      const v = typeof x[f] === "string" ? (x[f] as string).trim() : "";
      if (!v) continue;
      if (f.endsWith("Date")) {
        if (!isDateKey(v)) return { rows: [], error: `「${label}」の日付を正しく入力してください。` };
        setField(row, f, v);
      } else if (isSlotField(f)) {
        if (!isHandoverSlot(v)) return { rows: [], error: `「${label}」の時間帯は午前 (AM) か午後 (PM) を選んでください。` };
        setField(row, f, v);
      } else {
        const t = normTime(v);
        if (!t) return { rows: [], error: `「${label}」の時刻を正しく入力してください。` };
        setField(row, f, t);
      }
    }
    const install = isInstall(row);
    const sides = install ? [SIDE_FIELDS.pickup] : [SIDE_FIELDS.pickup, SIDE_FIELDS.delivery];
    for (const [d, s, e, slot] of sides) {
      const what = install ? "施工" : d === "pickupDate" ? "引き取り" : "納品";
      // 時刻を入れたときは時刻 (午前・午後は使わない)
      if (row[s]) delete row[slot];
      if (!row[d] && (row[s] || row[e] || row[slot])) return { rows: [], error: `「${label}」の${what}の日付を入力してください (時間だけでは予定表に載せられません)。` };
      if (!row[s] && row[e]) return { rows: [], error: `「${label}」の${what}の開始時刻を入力してください。` };
      if (row[s] && row[e] && toMinutes(row[e]!) <= toMinutes(row[s]!)) return { rows: [], error: `「${label}」の${what}の終了時刻は開始時刻より後にしてください。` };
    }
    if (install) {
      // 施工: 終了日は開始日以降 (時間帯は各日の時間)。終了日の時刻・時間帯の欄は使わない
      delete row.deliveryStart;
      delete row.deliveryEnd;
      delete row.deliverySlot;
      if (row.deliveryDate && !row.pickupDate) return { rows: [], error: `「${label}」の施工開始日を入力してください。` };
      if (row.deliveryDate && row.pickupDate && row.deliveryDate < row.pickupDate) return { rows: [], error: `「${label}」の施工終了日は施工開始日以降にしてください。` };
      if (row.deliveryDate === row.pickupDate) delete row.deliveryDate;
    } else {
      if (row.deliveryDate && row.pickupDate && row.deliveryDate < row.pickupDate) return { rows: [], error: `「${label}」の納品日は引取日以降にしてください。` };
      if (row.deliveryDate && row.pickupDate && row.deliveryDate === row.pickupDate) {
        // 当日納品: 納品の時間 (午前・午後・時刻) が引き取りより前は誤り (例: 引き取り 午後 → 納品 午前)
        const p = sideWindow(row.pickupStart, row.pickupSlot);
        const dv = sideWindow(row.deliveryStart, row.deliverySlot);
        if (p && dv && dv[1] <= p[0]) {
          const both = row.deliveryStart && row.pickupStart;
          return { rows: [], error: `「${label}」は当日納品の${both ? "時刻" : "時間"}が引き取りの${both ? "時刻" : "時間"}より前です。` };
        }
      }
    }
    rows.push(cleanRow(row));
  }
  return { rows };
}

/* ---------------- 登録と変更の区別 (変更だけ承認) ---------------- */

type Side = "pickup" | "delivery" | "install";
const sideFields = (row: OrderHandover, side: Side): readonly DateField[] => (side === "install" ? ALL_FIELDS : SIDE_FIELDS[side]);
const sidesOf = (row: OrderHandover): Side[] => (isInstall(row) ? ["install"] : ["pickup", "delivery"]);
const sideHasDate = (row: OrderHandover, side: Side) => Boolean(side === "delivery" ? row.deliveryDate : row.pickupDate);
const sameSide = (a: OrderHandover, b: OrderHandover, side: Side) => sideFields(a, side).every((f) => (a[f] ?? "") === (b[f] ?? ""));

export interface HandoverDiff {
  /** すぐに反映する日程 (はじめて入れた日程・品目と名前の変更・日程のない行の追加と削除) */
  immediate: OrderHandover[];
  /** 承認が要る (登録済みの日付・時間の変更・取り消し、日程のある行の削除) */
  needsApproval: boolean;
  /** 登録した内容 (進捗・変更履歴の説明) */
  registered: string[];
  /** 承認が要る変更の説明 */
  changed: string[];
}

/**
 * 今の日程 (before) と入力 (after) を比べ、すぐに反映する分と承認が要る分に分ける。
 * 引き取り・納品 (施工は期間) の単位で、前に日付がなかったものは登録、日付があって何か変わったものは変更
 */
export function handoverDiff(beforeRaw: OrderHandover[] | undefined, afterRaw: OrderHandover[]): HandoverDiff {
  const before = cleanHandovers(beforeRaw ?? []).rows;
  const after = cleanHandovers(afterRaw).rows;
  const byId = new Map(before.map((r) => [r.id, r]));
  const immediate: OrderHandover[] = [];
  const registered: string[] = [];
  const changed: string[] = [];
  for (const a of after) {
    const b = byId.get(a.id);
    if (!b) {
      immediate.push(a);
      if (rowHasDate(a)) registered.push(`${handoverLabel(a)}: ${rowText(a)}`);
      continue;
    }
    // 品目・名前は承認なしで変える。日程は引き取り・納品ごとに
    const merged: OrderHandover = { ...b, item: a.item, label: a.label };
    if (!a.label) delete merged.label;
    // 品目の種類 (引取・納品 ⇔ 施工) が変わった行は、日程の扱いが変わるので行ごと変更とみなす
    if (isInstall(a) !== isInstall(b)) {
      if (rowHasDate(b)) {
        immediate.push(b);
        changed.push(`${handoverLabel(b)}: ${rowText(b)} → ${handoverLabel(a)}: ${rowText(a)}`);
      } else {
        immediate.push(a);
        if (rowHasDate(a)) registered.push(`${handoverLabel(a)}: ${rowText(a)}`);
      }
      continue;
    }
    for (const side of sidesOf(a)) {
      if (sameSide(a, b, side)) continue;
      if (!sideHasDate(b, side)) {
        for (const f of sideFields(a, side)) setField(merged, f, a[f]);
        registered.push(`${handoverLabel(a)} の${sideName(a, side)}: ${sideText(a, side)}`);
      } else {
        changed.push(`${handoverLabel(a)} の${sideName(a, side)}: ${sideText(b, side)} → ${sideText(a, side)}`);
      }
    }
    immediate.push(cleanRow(merged));
  }
  const afterIds = new Set(after.map((r) => r.id));
  for (const b of before) {
    if (afterIds.has(b.id)) continue;
    if (rowHasDate(b)) {
      // 日程のある行の削除は承認のあと。それまでは今の日程のまま残す (元の並びの位置に)
      const at = before.indexOf(b);
      immediate.splice(Math.min(at, immediate.length), 0, b);
      changed.push(`${handoverLabel(b)} を削除 (${rowText(b)})`);
    }
  }
  return { immediate, needsApproval: changed.length > 0, registered, changed };
}

const rowHasDate = (r: OrderHandover) => Boolean(r.pickupDate || r.deliveryDate);
const sideName = (r: OrderHandover, side: Side) => (side === "install" ? "施工" : side === "pickup" ? "引取" : "納品");

/* ---------------- 表示 ---------------- */

const hm = (t: string) => t.replace(/^0(\d)/, "$1");
/** 時間の文字 (「 8:30–9:00」「 午前」。指定なしは空) */
const timeText = (s?: string, e?: string, slot?: HandoverSlot) => (s ? ` ${hm(s)}${e ? `–${hm(e)}` : ""}` : slot ? ` ${HANDOVER_SLOT_LABEL[slot]}` : "");

/** 引き取り・納品・施工の 1 つの日時 (例: 12/2(火) 8:30–9:00 / 12/4(木) 午前) */
export function sideText(r: OrderHandover, side: Side): string {
  if (side === "install") {
    if (!r.pickupDate) return "未定";
    return `${shortDate(r.pickupDate)}${r.deliveryDate && r.deliveryDate > r.pickupDate ? `〜${shortDate(r.deliveryDate)}` : ""}${timeText(r.pickupStart, r.pickupEnd, r.pickupSlot)}`;
  }
  const [d, s, e, slot] = SIDE_FIELDS[side];
  return r[d] ? `${shortDate(r[d]!)}${timeText(r[s], r[e], r[slot])}` : "未定";
}

/** 1 行の日程 (例: 引取 12/2(火) 8:30–9:00 → 納品 12/2(火) 15:00–17:00) */
export function rowText(r: OrderHandover): string {
  if (isInstall(r)) return `施工 ${sideText(r, "install")}`;
  const same = r.pickupDate && r.deliveryDate === r.pickupDate ? " (当日納品)" : "";
  return `引取 ${sideText(r, "pickup")} → 納品 ${sideText(r, "delivery")}${same}`;
}

/** 日程の全体 (変更履歴・通知の文) */
export function handoverText(rows: unknown): string {
  const list = cleanHandovers(rows).rows;
  return list.length ? list.map((r) => `${handoverLabel(r)}: ${rowText(r)}`).join(" / ") : "(なし)";
}

/** 変更の申請の内容 (承認の画面・通知・受注の画面。品目ごと・引き取り/納品ごとの「前 → 後」) */
export function handoverChangeLines(beforeRaw: unknown, afterRaw: unknown): string[] {
  const before = cleanHandovers(beforeRaw).rows;
  const after = cleanHandovers(afterRaw).rows;
  const byId = new Map(before.map((r) => [r.id, r]));
  const out: string[] = [];
  for (const a of after) {
    const b = byId.get(a.id);
    if (!b) {
      out.push(`${handoverLabel(a)} を追加: ${rowText(a)}`);
      continue;
    }
    if (handoverLabel(a) !== handoverLabel(b)) out.push(`品目の名前: ${handoverLabel(b)} → ${handoverLabel(a)}`);
    if (isInstall(a) !== isInstall(b)) {
      out.push(`${handoverLabel(a)}: ${rowText(b)} → ${rowText(a)}`);
      continue;
    }
    for (const side of sidesOf(a)) if (!sameSide(a, b, side)) out.push(`${handoverLabel(a)} の${sideName(a, side)}: ${sideText(b, side)} → ${sideText(a, side)}`);
  }
  const ids = new Set(after.map((r) => r.id));
  for (const b of before) if (!ids.has(b.id)) out.push(`${handoverLabel(b)} を削除 (${rowText(b)})`);
  return out;
}

/* ---------------- 予定表の予定 ---------------- */

export interface HandoverGroup {
  role: HandoverRole;
  date: string;
  /** 施工の終了日 (複数日の施工だけ) */
  endDate?: string;
  start?: string;
  end?: string;
  /** 時刻のない午前・午後 (予定表の予定の slot) */
  slot?: HandoverSlot;
  rowIds: string[];
  labels: string[];
}

/**
 * 予定表に載せる予定 (引き取り・納品は同じ日・同じ時間 (時刻・午前・午後) の品目を 1 件にまとめる。施工は品目ごと)。
 * 日付の早い順、同じ日は 時間 (指定なし → 午前 9 時 → 午後 13 時の位置) → 引き取り → 施工 → 納品の順
 */
export function handoverGroups(rowsRaw: OrderHandover[] | undefined): HandoverGroup[] {
  const rows = cleanHandovers(rowsRaw ?? []).rows;
  const map = new Map<string, HandoverGroup>();
  const add = (role: HandoverRole, r: OrderHandover, date: string, start?: string, end?: string, slot?: HandoverSlot, endDate?: string) => {
    const sl = start ? undefined : slot;
    const key = role === "install" ? `install|${r.id}` : `${role}|${date}|${start ?? ""}|${end ?? ""}|${sl ?? ""}`;
    const g = map.get(key) ?? { role, date, ...(endDate ? { endDate } : {}), ...(start ? { start } : {}), ...(end ? { end } : {}), ...(sl ? { slot: sl } : {}), rowIds: [], labels: [] };
    g.rowIds.push(r.id);
    g.labels.push(handoverLabel(r));
    map.set(key, g);
  };
  for (const r of rows) {
    if (isInstall(r)) {
      if (r.pickupDate) add("install", r, r.pickupDate, r.pickupStart, r.pickupEnd, r.pickupSlot, r.deliveryDate && r.deliveryDate > r.pickupDate ? r.deliveryDate : undefined);
      continue;
    }
    if (r.pickupDate) add("pickup", r, r.pickupDate, r.pickupStart, r.pickupEnd, r.pickupSlot);
    if (r.deliveryDate) add("delivery", r, r.deliveryDate, r.deliveryStart, r.deliveryEnd, r.deliverySlot);
  }
  const order: Record<HandoverRole, number> = { pickup: 0, install: 1, delivery: 2 };
  const at = (g: HandoverGroup) => g.start ?? (g.slot === "am" ? "09:00" : g.slot === "pm" ? "13:00" : "");
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date) || at(a).localeCompare(at(b)) || order[a.role] - order[b.role]);
}

/** 予定表の予定の印 (sourceRef) */
export const HANDOVER_REF_PREFIX = "handover:";
export const handoverRef = (g: Pick<HandoverGroup, "role" | "rowIds">) => `${HANDOVER_REF_PREFIX}${g.role}:${g.rowIds.join("+")}`;
export function parseHandoverRef(ref: string | undefined): { role: HandoverRole; rowIds: string[] } | undefined {
  const m = ref?.match(/^handover:(pickup|delivery|install):([a-z0-9_+]+)$/);
  return m ? { role: m[1] as HandoverRole, rowIds: m[2].split("+").filter(Boolean) } : undefined;
}

/** 日程の最初の日・最後の日 (受注の scheduledStart / scheduledEnd) */
export function handoverSpan(rowsRaw: OrderHandover[] | undefined): { start?: string; end?: string } {
  const days = handoverGroups(rowsRaw).flatMap((g) => [g.date, g.endDate ?? g.date]);
  if (!days.length) return {};
  days.sort();
  return { start: days[0], end: days[days.length - 1] };
}

/**
 * 予定表で予定 (引き取り・納品・施工) の日時を変えたときの、受注の日程の入力 (変更の申請に使う)。
 * その予定にまとめた品目の行だけを変える (午前・午後は時刻がないときだけ)
 */
export function applyEventMove(
  rowsRaw: OrderHandover[] | undefined,
  ref: { role: HandoverRole; rowIds: string[] },
  when: { date: string; endDate?: string; start?: string; end?: string; slot?: HandoverSlot },
): OrderHandover[] {
  const ids = new Set(ref.rowIds);
  const slot = when.start ? undefined : when.slot;
  return cleanHandovers(rowsRaw ?? []).rows.map((r) => {
    if (!ids.has(r.id)) return r;
    const next: OrderHandover = { ...r };
    const [d, s, e, sl] = SIDE_FIELDS[ref.role === "install" ? "pickup" : ref.role];
    setField(next, d, when.date);
    setField(next, s, when.start);
    setField(next, e, when.start ? when.end : undefined);
    setField(next, sl, slot);
    if (ref.role === "install") setField(next, "deliveryDate", when.endDate && when.endDate > when.date ? when.endDate : undefined);
    return cleanRow(next);
  });
}

/**
 * 予定表で連動する予定を削除したとき (お客様のご要望 2026-11-24「予定表から予定の削除」): その予定の品目の引取 (または納品・施工) の日時を受注の日程から外す。
 * 品目の行と、もう片方の日程 (引取を消したときの納品など) は残す (案件の情報は消さない)
 */
export function applyEventRemoval(rowsRaw: OrderHandover[] | undefined, ref: { role: HandoverRole; rowIds: string[] }): OrderHandover[] {
  const ids = new Set(ref.rowIds);
  return cleanHandovers(rowsRaw ?? []).rows.map((r) => {
    if (!ids.has(r.id)) return r;
    const next: OrderHandover = { ...r };
    for (const f of SIDE_FIELDS[ref.role === "install" ? "pickup" : ref.role]) setField(next, f, undefined);
    if (ref.role === "install") setField(next, "deliveryDate", undefined);
    return cleanRow(next);
  });
}

/* ---------------- 襖・障子・網戸の同じ日程 (受注の画面の入力) ---------------- */

/** 日程の欄の値をつないだ印 (同じ日程かを比べる。空は "") */
export function scheduleKey(r: OrderHandover): string {
  return ALL_FIELDS.map((f) => r[f] ?? "").join("|");
}

/**
 * 受注の画面を開いたときに「同じ日程」としてまとめる襖・障子・網戸の行の ID。
 * 同じ日程の行がいちばん多い組 (同じ数なら先に出てくる組)。襖・障子・網戸が 1 行以下ならまとめない (空)
 */
export function linkedCluster(rows: OrderHandover[]): string[] {
  const linked = rows.filter((r) => isLinkedItem(r.item));
  if (linked.length < 2) return [];
  const byKey = new Map<string, string[]>();
  for (const r of linked) {
    const k = scheduleKey(r);
    byKey.set(k, [...(byKey.get(k) ?? []), r.id]);
  }
  let best: string[] = [];
  for (const ids of byKey.values()) if (ids.length > best.length) best = ids;
  return best;
}

/** 受注の画面の入力の初期値に使う、行の日程の欄の値 (空は "") */
export type HandoverFormRow = { id: string; item: HandoverItem; label: string } & Record<DateField, string>;
export function toFormRows(rows: OrderHandover[]): HandoverFormRow[] {
  return rows.map((r) => ({ id: r.id, item: r.item, label: r.label ?? "", ...ALL_FIELDS.reduce((o, f) => ({ ...o, [f]: r[f] ?? "" }), {} as Record<DateField, string>) }));
}
