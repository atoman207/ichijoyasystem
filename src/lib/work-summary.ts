/**
 * 予定表の仕事内容と数量の省略表記 (お客様のご要望 2026-11-23「■2. 予定表への仕事内容・数量の表示」)
 * ------------------------------------------------------------
 * 例: 畳 12 畳・襖 6 枚・障子 4 枚・網戸 2 枚 →「タ12 フ6 シ4 ア2」。へり無し畳は製造に時間がかかるため「タ12(縁無6)」のように目立たせる
 * (枚数が分からなければ「タ9(縁無)」、すべて縁無の半畳なら「タ12(縁無半)」)。数量の分からない品目は記号だけ (「フ」)。
 *
 * 数量の元:
 * - 明細 (見積・受注): countsFromLines。品名・仕様で種類を決める (src/lib/line-kind.ts)。縁・引手・値引き・諸経費は数えない
 * - 文字 (予定表の件名・メモ。移行した予定表の「畳 表替え12 / 襖 張替3」、手書きのメモの「タ6フ1」「縁無半12」): countsFromText
 * 予定表の件名の右の「引き取り」「納品」などの言葉は表示しない (種類はアイコンと色で表す。stripKindWords)。
 *
 * ブラウザーとサーバーの両方から使う純粋関数。
 */
import { isPieceUnit, lineKind } from "@/lib/line-kind";

export type WorkKey = "tatami" | "fusuma" | "shoji" | "amido" | "curtain";

export interface WorkCounts {
  tatami: number;
  fusuma: number;
  shoji: number;
  amido: number;
  curtain: number;
  /** へり無し畳の枚数 (分からなければ 0) */
  herinashi: number;
  /** へり無し畳がある (枚数が分からなくても) */
  herinashiSeen: boolean;
  /** へり無し畳が半畳 */
  herinashiHalf: boolean;
  /** 数量は分からないが、ある品目 */
  seen: Partial<Record<WorkKey, boolean>>;
  /**
   * 品目の数量のうち新調 (新) の枚数 (残りは 表替え・裏返し・張替え = 表)。日ごとの予定表の「畳 (表・新)」の欄
   * (お客様のご要望 2026-11-25「日ごとの予定表の表示形式」。src/lib/day-sheet.ts)
   */
  fresh: Partial<Record<WorkKey, number>>;
}

export function emptyCounts(): WorkCounts {
  return { tatami: 0, fusuma: 0, shoji: 0, amido: 0, curtain: 0, herinashi: 0, herinashiSeen: false, herinashiHalf: false, seen: {}, fresh: {} };
}

/** 新調の言い方 (品名・仕様・予定表の「新調2」「新2」) */
export const NEW_WORK = /新調|新規|新品|新作|新設|新床|新畳|^新$/;

/** 新調の枚数を足す */
function addFresh(c: WorkCounts, key: WorkKey, n: number) {
  if (n > 0) c.fresh[key] = round((c.fresh[key] ?? 0) + n);
}

export const WORK_KEYS: WorkKey[] = ["tatami", "fusuma", "shoji", "amido", "curtain"];
/** 省略表記の記号 (お客様の予定表の書き方: タ・フ・シ・ア) */
export const WORK_MARK: Record<WorkKey, string> = { tatami: "タ", fusuma: "フ", shoji: "シ", amido: "ア", curtain: "カーテン" };
export const WORK_LABEL: Record<WorkKey, string> = { tatami: "畳", fusuma: "襖", shoji: "障子", amido: "網戸", curtain: "カーテン" };

export function hasWork(c: WorkCounts | undefined): boolean {
  return Boolean(c && (WORK_KEYS.some((k) => c[k] > 0 || c.seen[k]) || c.herinashiSeen));
}

const round = (n: number) => Math.round(n * 10) / 10;

/* ---------------- 明細から ---------------- */

export interface WorkLine {
  name: string;
  spec?: string;
  qty?: number;
  unit?: string;
  /** 商品マスタの分類 (ServiceCategory) */
  productCategory?: string;
}

/** 明細から数える (縁・引手・値引き・諸経費は数えない。仏間は襖があることだけ) */
export function countsFromLines(lines: WorkLine[]): WorkCounts {
  const c = emptyCounts();
  for (const l of lines) {
    const k = lineKind(l.name, l.spec, l.productCategory);
    if (!k) continue;
    const key: WorkKey | undefined = k.kind === "tatami" ? "tatami" : k.kind === "fusuma" || k.kind === "shoji" || k.kind === "amido" || k.kind === "curtain" ? k.kind : k.kind === "butsuma" ? "fusuma" : undefined;
    if (!key) continue;
    const qty = typeof l.qty === "number" && Number.isFinite(l.qty) && l.qty > 0 ? l.qty : 0;
    // 仏間 (一式) は枚数が分からないので「襖がある」だけ。m・㎡ の行も数えない
    const n = k.kind === "butsuma" || !isPieceUnit(l.unit) ? 0 : qty;
    if (n) c[key] = round(c[key] + n);
    else c.seen[key] = true;
    // 新調: 畳は line-kind の tatami = new、襖・障子・網戸は品名・仕様の「新調」「新規」
    if (n && (k.kind === "tatami" ? k.tatami === "new" : NEW_WORK.test(`${l.name ?? ""} ${l.spec ?? ""}`.normalize("NFKC")))) addFresh(c, key, n);
    if (k.kind === "tatami" && k.herinashi) {
      c.herinashiSeen = true;
      if (n) c.herinashi = round(c.herinashi + n);
      if (k.half) c.herinashiHalf = true;
    }
  }
  return c;
}

/* ---------------- 文字から ---------------- */

const STRUCTURED = /(?<![\d.])(畳|襖|フスマ|障子|網戸|アミ戸|カーテン)[ \t]*([^\d\s/、,()（）・]{0,8}?)[ \t]*(\d{1,3}(?:\.\d)?)(?![\d:/])/g;
const KEY_OF: Record<string, WorkKey> = { 畳: "tatami", 襖: "fusuma", フスマ: "fusuma", 障子: "shoji", 網戸: "amido", アミ戸: "amido", カーテン: "curtain" };
/** 手書きの省略 (「タ6フ1」「タ4半」「シ ア」「タ新6」= 新調)。カタカナの言葉の一部 (シート・アラベスク・フローリング) は除く */
const SHORTHAND = /(?<![ァ-ヶー])([タフシア])(?![ァ-ヶー])(新)?(\d{1,3})?(半)?/g;
/** 「畳 表替え6・新調2」の「・新調2」(同じ品目の続き) */
const CONTINUED = /^[ \t]*・[ \t]*([^\d\s/、,()（）・]{0,8}?)[ \t]*(\d{1,3}(?:\.\d)?)(?![\d:/])/;
/** 数量のない品目の言葉 (「障子見積のみ」「10時 畳」「アミ戸見積り」)。部屋の広さ「6畳」・「畳縁」「畳表」は除く */
const WORD = /(?<![\d.])(畳|襖|フスマ|障子|網戸|アミ戸|カーテン)(?!縁|表[^替]|床|寄せ)/g;
const SHORT_KEY: Record<string, WorkKey> = { タ: "tatami", フ: "fusuma", シ: "shoji", ア: "amido" };
/** へり無し畳 (「縁無半12」「ヘリ無し半9」「縁無1帖」「琉球」)。「縁無から縁付」(縁付きに変える) は除く */
const HERINASHI_TEXT = /(?:縁|へり|ヘリ)\s*(?:無し?|なし|ナシ)(?!から)(半)?(\d{1,3})?(?![\d/:.])|琉球/g;

/**
 * 文字から数える。まず「畳 表替え12 / 襖 張替3」の形 (移行した予定表の 1 行目・受注の予定の件名) を読み、
 * なければ (shorthand = true のとき) 手書きの省略「タ6フ1」を読む。へり無し畳は両方で見る
 */
export function countsFromText(text: string | undefined, opts: { shorthand?: boolean } = {}): WorkCounts {
  const c = emptyCounts();
  const t = (text ?? "").normalize("NFKC");
  if (!t.trim()) return c;
  let found = false;
  for (const m of t.matchAll(STRUCTURED)) {
    // 「畳縁」「畳表」「畳床」は品名の一部、「6畳間」は部屋の広さ
    if (m[1] === "畳" && /^(縁|表[^替]|床|寄せ|間)/.test(m[2])) continue;
    const n = Number(m[3]);
    if (!(n > 0 && n <= 300)) continue;
    const key = KEY_OF[m[1]];
    c[key] = round(c[key] + n);
    if (NEW_WORK.test(m[2])) addFresh(c, key, n);
    found = true;
    // 同じ品目の続き「畳 表替え6・新調2」(移行した予定表の書き方。以前は「・新調2」を数えていなかった)
    let rest = t.slice((m.index ?? 0) + m[0].length);
    for (let x = CONTINUED.exec(rest); x; x = CONTINUED.exec(rest)) {
      const k2 = Number(x[2]);
      if (k2 > 0 && k2 <= 300) {
        c[key] = round(c[key] + k2);
        if (NEW_WORK.test(x[1])) addFresh(c, key, k2);
      }
      rest = rest.slice(x[0].length);
    }
  }
  if (!found && opts.shorthand) {
    for (const m of t.matchAll(SHORTHAND)) {
      const key = SHORT_KEY[m[1]];
      // 「タ4半」= 4 畳半、「タ新6」= 新調 6
      const n = m[3] ? Number(m[3]) + (m[4] ? 0.5 : 0) : 0;
      if (n > 0 && n <= 300) {
        c[key] = round(c[key] + n);
        if (m[2]) addFresh(c, key, n);
      } else c.seen[key] = true;
    }
    for (const m of t.matchAll(WORD)) {
      const key = KEY_OF[m[1]];
      if (!c[key]) c.seen[key] = true;
    }
  }
  for (const m of t.matchAll(HERINASHI_TEXT)) {
    c.herinashiSeen = true;
    if (m[1]) c.herinashiHalf = true;
    const n = m[2] ? Number(m[2]) : 0;
    if (n > 0 && n <= 300) c.herinashi = round(c.herinashi + n);
  }
  if (c.herinashiSeen && !c.tatami) c.seen.tatami = true;
  return c;
}

/** 2 つの数え方を足す (同じ予定の明細が複数の行のとき) */
export function mergeCounts(a: WorkCounts, b: WorkCounts): WorkCounts {
  const c = emptyCounts();
  for (const k of WORK_KEYS) {
    c[k] = round(a[k] + b[k]);
    if (a.seen[k] || b.seen[k]) c.seen[k] = true;
  }
  for (const k of WORK_KEYS) addFresh(c, k, (a.fresh?.[k] ?? 0) + (b.fresh?.[k] ?? 0));
  c.herinashi = round(a.herinashi + b.herinashi);
  c.herinashiSeen = a.herinashiSeen || b.herinashiSeen;
  c.herinashiHalf = a.herinashiHalf || b.herinashiHalf;
  return c;
}

/* ---------------- 表示 ---------------- */

export interface WorkToken {
  key: WorkKey;
  /** 「タ12」「フ6」「フ」 */
  text: string;
  /** へり無し畳の注記「(縁無6)」(目立たせる) */
  note?: string;
}

const num = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** 省略表記の部品 (並び: タ フ シ ア カーテン) */
export function workTokens(c: WorkCounts | undefined): WorkToken[] {
  if (!c) return [];
  const out: WorkToken[] = [];
  for (const k of WORK_KEYS) {
    let n = c[k];
    if (k === "tatami" && c.herinashi > n) n = c.herinashi;
    const seen = n > 0 || c.seen[k] || (k === "tatami" && c.herinashiSeen);
    if (!seen) continue;
    const token: WorkToken = { key: k, text: `${WORK_MARK[k]}${n > 0 ? num(n) : ""}` };
    if (k === "tatami" && c.herinashiSeen) {
      const part = c.herinashi > 0 && c.herinashi < n ? num(c.herinashi) : "";
      token.note = `(縁無${c.herinashiHalf ? "半" : ""}${part})`;
    }
    out.push(token);
  }
  return out;
}

/** 省略表記の文字 (例: タ12(縁無6) フ6 シ4 ア2) */
export function workText(c: WorkCounts | undefined): string {
  return workTokens(c)
    .map((t) => `${t.text}${t.note ?? ""}`)
    .join(" ");
}

/** 読み上げ・ツールチップ用 (例: 畳 12 (うちへり無し 6)・襖 6・障子 4・網戸 2) */
export function workDescription(c: WorkCounts | undefined): string {
  if (!c) return "";
  return workTokens(c)
    .map((t) => {
      const n = t.text.slice(WORK_MARK[t.key].length);
      const herinashi = t.note ? ` (${c.herinashi > 0 && c.herinashi < c.tatami ? `うちへり無し${c.herinashiHalf ? "半畳" : ""} ${num(c.herinashi)}` : `へり無し${c.herinashiHalf ? "半畳" : ""}`})` : "";
      return `${WORK_LABEL[t.key]}${n ? ` ${n}` : ""}${herinashi}`;
    })
    .join("・");
}

/* ---------------- 件名 ---------------- */

/** 案件の予定 (引き取り・納品・現地調査・見積・採寸・顧客訪問・現場管理) の件名の最後の種類の言葉 (と受注の予定の品目の括弧) */
const KIND_WORDS = /\s*(?:引き取り|引取り?|納品|顧客訪問|現地調査・見積|現地調査|現場見積\s*[(（]現見[)）]|現場見積|現見|見積り?|採寸|現場管理)(?:\s*[(（][^)）]*[)）])?\s*$/;
const STRIP_KINDS = new Set(["pickup", "delivery", "survey", "site_survey", "onsite_quote", "measure", "visit", "site"]);

/** 予定表に出す件名: 「(清水万石) 谷本 引き取り」→「(清水万石) 谷本」(種類はアイコンと色で表す) */
export function stripKindWords(title: string, kind: string): string {
  if (!STRIP_KINDS.has(kind)) return title;
  const t = title.replace(KIND_WORDS, "").trim();
  return t || title;
}
