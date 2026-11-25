/**
 * 予定表 (Google スプレッドシートの月ごとのファイル「2026.12」など。日別のシート「1」〜「31」) の読み取り
 * (お客様のご要望 2026-11-23「■ 予定表の新システムへの移行について」)
 * ------------------------------------------------------------
 * 日別のシートの作り (スプレッド原紙と同じ):
 * - 店舗の欄 (B 列に「合志店」「中央店」… = db.stores の名前): A 列の「AM」「PM」で午前・午後、「上限」で欄の終わり。
 *   左が ハギ (引き取り。B 現場名・C〜J 畳/襖/障子/アミド の 表・新・K 備考・L 時間・担当)、右が シキ (納品。M〜W 同じ並び)、
 *   X〜AD は工場の製造の表 (現場名・新/表・枚数・表・ヘリ・サイズ・床。同じ現場名の引き取りのメモに「製造: …」として残す = 部屋ごとの仕様)
 * - 事務の欄 (B 列「事務」): 次の行の B・M・X が人の名前で、その下がその人の予定
 * - 右上の人の予定 (1 行目の名前 + 2 行目の「AM」「PM」の見出し。例: 光子): 見出しの下の行がその人の午前・午後の予定
 * 読み取るだけ (データベースに触れない)。顧客・案件との照合と登録は plan.ts
 */
import type { ScheduleKind, StoreId } from "@/lib/db/types";

export interface SheetGrid {
  /** シートの名前 (日別のシートは「1」〜「31」) */
  name: string;
  rows: string[][];
}

/** 予定の欄: ハギ = 引き取り側 / シキ = 納品側 / office = 事務の人の欄 / person = 右上の人の予定 / memo = 店舗の欄のお客様以外の書き込み */
export type SheetSide = "hagi" | "shiki" | "office" | "person" | "memo";

export interface SheetEvent {
  /** 取込の印 (日付・欄・書かれた文字。同じ日に同じ文字が複数あるときは #2 …)。取り込み直すときに同じ予定を見分ける */
  key: string;
  date: string;
  /** 店舗の欄なら店舗の ID、事務の欄は "office"、右上の人の予定は "person" */
  section: string;
  storeId?: StoreId;
  side: SheetSide;
  slot: "am" | "pm";
  /** 書かれたままの文字 (現場名の欄・予定の欄) */
  raw: string;
  /** 地区 (「(須屋)大岩」の「須屋」) */
  area?: string;
  /** お客様の名前 (様・邸・さんを除く) */
  name?: string;
  /** 名前のあとの言葉 (「近所 挨拶」など) */
  extra?: string;
  /** 予定の種類・状態の言葉 (現見・採寸・クレームなど) */
  tags: string[];
  /** お客様の予定か (地区つきの名前・枚数・〇〇邸・〇〇様・現見など) */
  customerLike: boolean;
  kind: ScheduleKind;
  /** 畳 表・新 / 襖 表・新 / 障子 表・新 / アミド 表・新 の枚数 */
  counts: number[];
  /** 枚数の文 (例: 畳 表替え6 / 襖 張替7)。予定のメモの 1 行目 (予定表の仕事内容・畳製造予定が読む) */
  countText: string;
  total: number;
  remark?: string;
  /** 「時間・担当」の欄 */
  staffText?: string;
  /** 事務の欄・右上の予定の人の名前 (シートの見出し) */
  person?: string;
  startTime?: string;
  endTime?: string;
  /** 工場の製造の表のうち、この引き取りの行 (表・ヘリ・サイズ・床) */
  production?: string[];
  /** 製造の表のヘリ「無し」の枚数 (へり無し畳) */
  herinashi?: number;
  /** 取込元 (ファイル#シート!行) */
  ref: string;
}

export interface SheetMonth {
  label: string;
  year: number;
  month: number;
  /** 読んだ日別のシート (日) */
  days: number[];
  events: SheetEvent[];
  /** 右上の予定・事務の欄の人の名前 */
  persons: string[];
  /** 毎日ある決まった書き込みとして省いた文字 (例: 集金準備) */
  templates: string[];
  problems: string[];
}

export interface SheetStore {
  id: StoreId;
  name: string;
  shortName?: string;
}

/** 文字をそろえる (全角英数・全角かっこ → 半角、前後の空白・改行の整理) */
export const nk = (v: unknown): string =>
  String(v ?? "")
    .normalize("NFKC")
    .replace(/[　\s]+/g, " ")
    .trim();
/** 比べるための文字 (空白を除く) */
export const fold = (v: unknown): string => nk(v).replace(/\s+/g, "");

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const validDate = (y: number, m: number, d: number) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};
const num = (v: unknown): number => {
  const n = Number(nk(v).replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** ファイル名・スプレッドシートの名前 (「2026.12」「2026.12.xlsx」「2026年12月」) → 年・月 */
export function monthOfLabel(label: string): { year: number; month: number } | undefined {
  const m = nk(label).match(/(20\d{2})\s*[.\-/年_]\s*(\d{1,2})(?!\d)/);
  if (!m) return undefined;
  const year = Number(m[1]);
  const month = Number(m[2]);
  return month >= 1 && month <= 12 ? { year, month } : undefined;
}

/* ---------------- 書き込みの見分け ---------------- */

/** 店舗の欄の中で予定ではない書き込み (欄の見出し・集計・メモ) */
const SKIP_RE = /^繰り?越|工場ストップ|^上限|まで$|^※|係数|翌日持越|集金準備|指示書|^AM$|^PM$|^計$|^合計|^現場名|^ハギ$|^シキ$|^無し$|^人$|^表$|^新$/;
const LEAVE_RE = /有休|有給|公休|振休|代休|休み|お休|欠勤|特休|慶弔/;
const SURVEY_RE = /現見|現調|見積(?!書)|見積のみ|下見/;
/** 現場見積 (現見 = 現場で見積もりをして、そのまま工事)。「現見かも」「現見になるかも」(まだ決まっていない) は通常の見積りのまま */
const ONSITE_RE = /現見(?![^、。\s]{0,8}かも)/;
/** 予定表の書き込みが現場見積 (現見) か (取り込み済みの予定の種類の直しにも使う) */
export const isOnsiteQuoteText = (raw: string): boolean => ONSITE_RE.test(nk(raw));
/** 現地調査 (現調・下見。見積とは分ける。お客様のご要望 2026-11-24「業務フロー ③」) */
const SITE_SURVEY_RE = /現調|現地調査|下見/;
/** 予定表の書き込みが現地調査 (現調) か (現見・見積の言葉があればそちらを先に見る) */
export const isSiteSurveyText = (raw: string): boolean => !ONSITE_RE.test(nk(raw)) && SITE_SURVEY_RE.test(nk(raw)) && !/見積(?!書)/.test(nk(raw));
/** 現場管理 (工事・施工の現場の確認・立ち会い・取り付けの立ち会い) */
const SITE_RE = /現場管理|現場確認|工事|立会|立ち会|取り?付け?|施工確認|養生/;
const MEASURE_RE = /採寸/;
const CLAIM_RE = /クレーム/;
const MEETING_RE = /会議|ミーティング|ズーム|zoom|打合せ|打ち合わせ|打合わせ|面談|研修|勉強会|説明会/i;
/** 名前から外す言葉 (予定の種類・状態) */
const TAG_RE = /(現見|現調|見積のみ|見積|採寸|点検|クレーム対応|クレーム|打合せ|打合わせ|打ち合わせ|下見|現場確認)/g;
/** 時刻の書き方 (名前から外す) */
const TIME_TEXT_RE = /\d{1,2}(?::\d{2})?\s*(?:時(?:半)?)?\s*[〜～~\-ー－]\s*(?:\d{1,2}(?::\d{2})?\s*時?(?:半)?)?|\d{1,2}:\d{2}|\d{1,2}時(?:半|\d{1,2}分)?(?:頃|以降|から)?/g;
/** 書き込みの頭の時刻 (「13時(高平)大西 建具採寸」) */
const LEAD_TIME_RE = new RegExp(`^(?:${TIME_TEXT_RE.source})\\s*`);
/** 名前の後ろに付く作業の言葉 (「佐藤補修」) */
const NAME_TAIL_RE = /(補修|手直し|手直|追加|残り)$/;
/** 時刻を除いた書き込み (件名に使う。時刻は予定の時刻に入れる) */
export const withoutTime = (raw: string): string => nk(nk(raw).replace(TIME_TEXT_RE, " ")) || nk(raw);

const COUNT_LABELS: [string, string, string][] = [
  ["畳", "表替え", "新調"],
  ["襖", "張替", "新調"],
  ["障子", "張替", "新"],
  ["網戸", "張替", "新"],
];

/** 枚数の 8 つの欄 → 「畳 表替え6・新調2 / 襖 張替4」(以前の移行と同じ書き方) */
export function countText(cells: number[]): string {
  const parts: string[] = [];
  COUNT_LABELS.forEach(([label, a, b], i) => {
    const x = cells[i * 2] ?? 0;
    const y = cells[i * 2 + 1] ?? 0;
    const p: string[] = [];
    if (x) p.push(`${a}${fmtNum(x)}`);
    if (y) p.push(`${b}${fmtNum(y)}`);
    if (p.length) parts.push(`${label} ${p.join("・")}`);
  });
  return parts.join(" / ");
}
const fmtNum = (n: number) => String(Math.round(n * 10) / 10);

/**
 * 時刻 (「8:30〜9:30」「8：30～9」「13：30-14：00」「10時」「4時以降」「8:30頃」)。午後の欄の 1〜7 時は 13〜19 時。
 * 終わりのない時刻は 1 時間の予定にする
 */
export function parseTime(text: string | undefined, slot: "am" | "pm"): { startTime: string; endTime: string } | undefined {
  if (!text) return undefined;
  const t = nk(text).replace(/[〜～~ー－−]/g, "-");
  const fix = (h: number) => (slot === "pm" && h >= 1 && h <= 7 ? h + 12 : h);
  let m = t.match(/(\d{1,2})(?::(\d{2}))?\s*時?(半)?\s*-\s*(\d{1,2})(?::(\d{2}))?\s*時?(半)?/);
  if (m) {
    const h1 = fix(Number(m[1]));
    let h2 = Number(m[4]);
    const m1 = m[3] ? 30 : Number(m[2] ?? 0);
    const m2 = m[6] ? 30 : Number(m[5] ?? 0);
    if (h2 < h1 && h2 + 12 <= 21) h2 += 12;
    if (h1 >= 6 && h1 <= 21 && h2 <= 22 && h2 * 60 + m2 > h1 * 60 + m1 && m1 < 60 && m2 < 60) return { startTime: `${pad(h1)}:${pad(m1)}`, endTime: `${pad(h2)}:${pad(m2)}` };
  }
  m = t.match(/(?:^|[^\d/])(\d{1,2}):(\d{2})/) ?? t.match(/(?:^|[^\d/])(\d{1,2})時(半|(\d{1,2})分)?/);
  if (m) {
    const h = fix(Number(m[1]));
    const mi = m[2] === "半" ? 30 : Number((m[2] === undefined || m[2] === "半" ? m[3] : m[2]) ?? 0);
    if (h >= 6 && h <= 21 && mi < 60) return { startTime: `${pad(h)}:${pad(mi)}`, endTime: `${pad(Math.min(h + 1, 23))}:${pad(mi)}` };
  }
  return undefined;
}

/** 備考の「AM」「PM」「午前」「午後」 */
function slotWord(text: string | undefined): "am" | "pm" | undefined {
  const t = nk(text);
  const am = /(?<![A-Za-z])AM(?![A-Za-z])|午前/i.test(t);
  const pm = /(?<![A-Za-z])PM(?![A-Za-z])|午後/i.test(t);
  return am === pm ? undefined : am ? "am" : "pm";
}

/**
 * 書き込み 1 つ → 地区・名前・お客様の予定か。
 * 「(須屋)大岩」「（植木町）早川　現見」「清原邸8〜9時 クロス工事」「（須屋）清原様 近所 挨拶」
 */
export function splitName(raw: string): { area?: string; name?: string; extra?: string; tags: string[]; customerLike: boolean } {
  const s = nk(nk(raw).replace(LEAD_TIME_RE, ""));
  const tags = [...s.matchAll(TAG_RE)].map((m) => m[1]);
  const paren = s.match(/^\(([^()]{1,20})\)\s*(.*)$/);
  const area = paren ? nk(paren[1]) : undefined;
  const rest = nk((paren ? paren[2] : s).replace(TAG_RE, " ").replace(TIME_TEXT_RE, " "));
  const honorific = /^(.{1,12}?)(邸|様|さま|さん)(.*)$/.exec(rest);
  if (honorific && honorific[1].trim()) {
    const name = nk(honorific[1]).replace(NAME_TAIL_RE, "") || nk(honorific[1]);
    return { area, name, extra: nk(honorific[3]) || undefined, tags, customerLike: true };
  }
  if (!paren) return { tags, customerLike: false };
  const tokens = rest.split(" ").filter(Boolean);
  const first = ((tokens[0] ?? "").replace(/[A-Za-zｦ-ﾟァ-ヶ]*\d+$/, "") || tokens[0] || "").replace(NAME_TAIL_RE, "") || tokens[0];
  return { area, name: first || undefined, extra: tokens.slice(1).join(" ") || undefined, tags, customerLike: Boolean(first) };
}

/**
 * 「襖 3」だけの行 (C〜J = 0・0・3・0・0・0・0・0) = 見積・現調・現場管理・会議などの 1 件の仕事量の目安
 * (実際の枚数ではない。お客様のご説明 2026-11-25。予定表の上限の行で 1 件 = 3 枚として足していた)
 */
export const isLoadPlaceholderCounts = (counts: number[]): boolean => counts.length >= 3 && counts.every((n, i) => (i === 2 ? n === 3 : !n));

/** 「襖 3」だけの引き取りの行で、名前・備考に見積・現調・現場の言葉があればその種類 (名前の欄だけで見ると引き取りになっていた) */
export function placeholderKind(raw: string, remark: string | undefined): ScheduleKind | undefined {
  const t = nk(`${raw} ${remark ?? ""}`);
  if (ONSITE_RE.test(t)) return undefined;
  if (isSiteSurveyText(t)) return "site_survey";
  if (SURVEY_RE.test(t)) return "survey";
  if (SITE_RE.test(t)) return "site";
  return undefined;
}

/** 予定の種類 */
export function kindOf(side: SheetSide, raw: string, total: number, customerLike: boolean): ScheduleKind {
  const s = nk(raw);
  if (LEAVE_RE.test(s) && !/^\(/.test(s)) return "leave";
  if (ONSITE_RE.test(s)) return "onsite_quote";
  if (isSiteSurveyText(s)) return "site_survey";
  if (SURVEY_RE.test(s)) return "survey";
  if (MEASURE_RE.test(s)) return "measure";
  // お客様の現場の工事・取り付けの確認 (枚数のある引き取り・納品の行は除く)
  if (customerLike && total === 0 && SITE_RE.test(s)) return "site";
  if (side === "hagi" || side === "shiki") {
    if (customerLike && CLAIM_RE.test(s) && total === 0) return "visit";
    if (total > 0) return side === "hagi" ? "pickup" : "delivery";
    if (customerLike) return side === "shiki" ? "delivery" : "visit";
  }
  if (MEETING_RE.test(s)) return "meeting";
  return customerLike ? "visit" : "other";
}

/* ---------------- シートの読み取り ---------------- */

interface Draft extends Omit<SheetEvent, "key"> {
  /** 店舗の欄の書き込みで、お客様以外 (メモ・社内の予定) */
  memoRow?: boolean;
}

function storeMatcher(stores: SheetStore[]) {
  const list = stores
    .filter((s) => s.id !== "hq")
    .flatMap((s) => [
      { id: s.id, word: fold(s.name) },
      ...(s.shortName ? [{ id: s.id, word: fold(s.shortName) }] : []),
    ])
    .filter((x) => x.word)
    .sort((a, b) => b.word.length - a.word.length);
  return (text: string): StoreId | undefined => {
    const t = fold(text);
    if (!t) return undefined;
    const hit = list.find((x) => t === x.word || t === `${x.word}店` || (t.startsWith(x.word) && /^店?(?:\(|$)/.test(t.slice(x.word.length))));
    return hit?.id;
  };
}

/** 枚数の欄 (8 つ) */
const countsAt = (r: string[], from: number) => Array.from({ length: 8 }, (_, i) => num(r[from + i]));

/** 1 日のシート → 予定の下書き */
function readDay(rows: string[][], date: string, ref: (row: number) => string, storeOf: (t: string) => StoreId | undefined, persons: Set<string>): Draft[] {
  const out: Draft[] = [];

  /* 右上の人の予定: 2 行目までに「AM」「PM」の見出し (12 列目より右) と、その上の名前 */
  for (let r = 0; r < Math.min(rows.length, 4); r++) {
    const row = rows[r] ?? [];
    const amCol = row.findIndex((v, c) => c >= 12 && nk(v) === "AM");
    if (amCol < 0) continue;
    const pmCol = row.findIndex((v, c) => c > amCol && nk(v) === "PM");
    let label = "";
    for (let up = r - 1; up >= 0 && !label; up--) label = nk(rows[up]?.[amCol]);
    if (!label || pmCol < 0) break;
    persons.add(label);
    for (let rr = r + 1; rr < Math.min(rows.length, r + 12); rr++) {
      const line = rows[rr] ?? [];
      if (/総数/.test(nk(line[0])) || /本日製造|製造枚数/.test(nk(line[amCol])) || /目標|人時/.test(nk(line[pmCol]))) break;
      for (const [from, to, slot] of [
        [amCol, pmCol, "am"],
        [pmCol, pmCol + 4, "pm"],
      ] as const) {
        for (let c = from; c < to; c++) {
          const text = nk(line[c]);
          if (!text) continue;
          const sp = splitName(text);
          const time = parseTime(text, slot);
          out.push({
            date,
            section: "person",
            side: "person",
            slot: time ? (Number(time.startTime.slice(0, 2)) >= 12 ? "pm" : "am") : slot,
            raw: text,
            ...sp,
            kind: kindOf("person", text, 0, sp.customerLike),
            counts: [],
            countText: "",
            total: 0,
            person: label,
            ...(time ?? {}),
            ref: ref(rr),
          });
        }
      }
    }
    break;
  }

  /* 店舗の欄・事務の欄 */
  let store: StoreId | undefined;
  let office: { cols: { col: number; name: string; end: number }[] } | undefined;
  let slot: "am" | "pm" = "am";
  let production = new Map<string, { text: string; herinashi: number }[]>();
  let sectionEvents: Draft[] = [];
  const closeSection = () => {
    // 製造の表を、同じ現場名の引き取りの予定に付ける
    for (const e of sectionEvents) {
      if (e.side !== "hagi") continue;
      const hits = production.get(fold(e.raw));
      if (!hits?.length) continue;
      e.production = hits.map((h) => h.text);
      const n = hits.reduce((a, h) => a + h.herinashi, 0);
      if (n) e.herinashi = n;
    }
    out.push(...sectionEvents);
    sectionEvents = [];
    production = new Map();
  };
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] ?? [];
    const a = nk(r[0]);
    const b = nk(r[1]);
    const header = b && !r.slice(2, 10).some((v) => num(v)) ? storeOf(b) : undefined;
    if (header) {
      closeSection();
      store = header;
      office = undefined;
      slot = "am";
      continue;
    }
    if (/^事務$|^事務所$|^本部$/.test(fold(b)) && !r.slice(2, 10).some((v) => num(v))) {
      closeSection();
      store = undefined;
      // 次の行が人の名前 (B・M・X 列)
      const names = rows[i + 1] ?? [];
      const cols = [1, 12, 23].map((col, k, all) => ({ col, name: nk(names[col]), end: all[k + 1] ?? col + 7 })).filter((x) => x.name && !/^AM$|^PM$/.test(x.name));
      office = { cols };
      for (const c of cols) persons.add(c.name);
      slot = "am";
      i++;
      continue;
    }
    if (a === "AM") slot = "am";
    if (a === "PM") slot = "pm";
    if (store) {
      if (a === "上限" || /^畳(のみ|は)/.test(b)) {
        closeSection();
        store = undefined;
        continue;
      }
      // 製造の表 (X〜AD)
      const site = nk(r[23]);
      const pieces = num(r[25]);
      if (site && pieces && !/^現場名$|^計$|本日製造/.test(site) && !storeOf(site)) {
        const herinashi = /^無し?$|^なし$/.test(nk(r[27])) ? pieces : 0;
        const cell = (v: unknown) => nk(v).replace(/^(\d+)\.0$/, "$1");
        // 「製造: 表 6枚 / 表 きずな / 縁 浮14 / サイズ 61 / 床 建材」(1 行 = 1 部屋の仕様。src/lib/tatami-spec.ts の roomsFromSheetMemo が読む)
        const heri = cell(r[27]);
        const text = [
          `製造: ${[cell(r[24]).replace(/\s+/g, ""), `${fmtNum(pieces)}枚`].filter(Boolean).join(" ")}`,
          cell(r[26]) && `表 ${cell(r[26])}`,
          herinashi ? `縁無${fmtNum(herinashi)}` : heri && `縁 ${heri}`,
          cell(r[28]) && `サイズ ${cell(r[28])}`,
          cell(r[29]) && `床 ${cell(r[29])}`,
        ]
          .filter(Boolean)
          .join(" / ");
        const k = fold(site);
        production.set(k, [...(production.get(k) ?? []), { text, herinashi }]);
      }
      for (const side of ["hagi", "shiki"] as const) {
        const base = side === "hagi" ? 1 : 12;
        const raw = nk(r[base]);
        if (!raw || SKIP_RE.test(raw)) continue;
        const counts = countsAt(r, base + 1);
        const total = counts.reduce((x, y) => x + y, 0);
        const remark = nk(r[base + 9]) || undefined;
        const staffText = nk(r[base + 10]) || undefined;
        const sp = splitName(raw);
        // 「襖 3」だけの行は 1 件の仕事量の目安 (見積・現調・会議など)。会議 (店長会議など) は社内の予定、備考に見積・現調とあれば見積・現調
        const placeholder = isLoadPlaceholderCounts(counts);
        const meetingRow = placeholder && !/^[(（]/.test(raw) && MEETING_RE.test(raw) && !SURVEY_RE.test(raw);
        const customerLike = !meetingRow && (sp.customerLike || total > 0 || ((SURVEY_RE.test(raw) || MEASURE_RE.test(raw)) && Boolean(nk(raw.replace(TAG_RE, "")))));
        const name = sp.name ?? (customerLike ? nk(raw.replace(TAG_RE, " ").replace(TIME_TEXT_RE, " ")).split(" ")[0] : undefined);
        let kind: ScheduleKind = meetingRow ? "meeting" : kindOf(side, raw, total, customerLike);
        if (placeholder && kind === "pickup") kind = placeholderKind(raw, remark) ?? kind;
        const memoRow = !customerLike && kind !== "leave";
        const rowSlot = slotWord(remark) ?? slot;
        const time = parseTime(remark, rowSlot) ?? parseTime(staffText, rowSlot) ?? (memoRow ? parseTime(raw, rowSlot) : undefined);
        sectionEvents.push({
          date,
          section: store,
          storeId: store,
          side: memoRow ? "memo" : side,
          slot: rowSlot,
          raw,
          area: sp.area,
          name: customerLike ? name : undefined,
          extra: sp.extra,
          tags: sp.tags,
          customerLike,
          kind,
          counts,
          countText: countText(counts),
          total,
          remark,
          staffText,
          ...(time ?? {}),
          ref: ref(i),
          memoRow,
        });
      }
      continue;
    }
    if (office) {
      for (const c of office.cols) {
        const raw = nk(r[c.col]);
        if (!raw || SKIP_RE.test(raw)) continue;
        const remark = r
          .slice(c.col + 1, c.end)
          .map(nk)
          .filter(Boolean)
          .join(" ") || undefined;
        const sp = splitName(raw);
        const time = parseTime(remark, slot) ?? parseTime(raw, slot);
        out.push({
          date,
          section: "office",
          side: "office",
          slot,
          raw,
          ...sp,
          kind: kindOf("office", raw, 0, sp.customerLike),
          counts: [],
          countText: "",
          total: 0,
          remark,
          person: c.name,
          ...(time ?? {}),
          ref: ref(i),
        });
      }
    }
  }
  closeSection();
  return out;
}

/**
 * 月のファイルの日別のシート → 予定。毎日 (シートの半分以上・5 日以上) 同じ文字のお客様以外の書き込みは
 * スプレッド原紙の決まった書き込み (集金準備など) として省く
 */
export function parseMonth(sheets: SheetGrid[], opts: { label: string; year: number; month: number; stores: SheetStore[] }): SheetMonth {
  const storeOf = storeMatcher(opts.stores);
  const problems: string[] = [];
  const persons = new Set<string>();
  const drafts: Draft[] = [];
  const days: number[] = [];
  for (const sh of sheets) {
    const t = nk(sh.name);
    if (!/^\d{1,2}$/.test(t)) continue;
    const day = Number(t);
    if (!validDate(opts.year, opts.month, day)) {
      problems.push(`シート「${sh.name}」: ${opts.year} 年 ${opts.month} 月にない日です`);
      continue;
    }
    days.push(day);
    const date = ymd(opts.year, opts.month, day);
    drafts.push(...readDay(sh.rows, date, (row) => `${opts.label}#${t}!${row + 1}`, storeOf, persons));
  }
  days.sort((a, b) => a - b);
  if (!days.length) problems.push(`${opts.label}: 日別のシート (「1」〜「31」) がありません`);

  // 決まった書き込み (お客様以外で、ほとんどの日にある同じ文字)
  const seen = new Map<string, Set<string>>();
  const tkey = (d: Draft) => `${d.section}|${d.side}|${d.person ?? ""}|${fold(d.raw)}`;
  for (const d of drafts) if (!d.customerLike) (seen.get(tkey(d)) ?? seen.set(tkey(d), new Set()).get(tkey(d))!).add(d.date);
  const limit = Math.max(5, Math.ceil(days.length * 0.5));
  const templates = new Set([...seen].filter(([, s]) => s.size >= limit).map(([k]) => k));

  const events: SheetEvent[] = [];
  const occurrence = new Map<string, number>();
  for (const d of drafts) {
    if (!d.customerLike && templates.has(tkey(d))) continue;
    const base = `${d.date}|${d.section}|${d.side === "memo" ? "memo" : d.side}|${d.person ?? ""}|${fold(d.raw)}`;
    const n = (occurrence.get(base) ?? 0) + 1;
    occurrence.set(base, n);
    const { memoRow: _memo, ...ev } = d;
    void _memo;
    events.push({ key: n > 1 ? `${base}#${n}` : base, ...ev });
  }
  return { label: opts.label, year: opts.year, month: opts.month, days, events, persons: [...persons], templates: [...templates].map((k) => k.split("|").slice(-1)[0]), problems };
}
