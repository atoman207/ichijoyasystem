import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import fontkit from "@pdf-lib/fontkit";
import type { Font as FontFace } from "@pdf-lib/fontkit";
import { PDFDocument, degrees, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import { LOGO_ACCENT_RGB, LOGO_PATHS, LOGO_VIEWBOX } from "./logo-paths";

/**
 * 帳票 PDF の描画部品 (用紙・色・フォント・文字の整形と折り返し・罫線・ロゴ・透かし・改ページ)
 * ------------------------------------------------------------
 * - 座標は「用紙の上端からの距離 (pt)」で受け取り、pdf-lib の下端基準へここで直す
 * - 文字は描く前に必ず clean() を通す (制御文字を除き、フォントにない文字は落とすか "?" にする)
 * - フォントは Noto Sans JP (src/assets/fonts、OFL)。読み込みと解析は 1 回だけ (モジュール内に保持) で、PDF にはサブセットを埋め込む
 */

// ---------------------------------------------------------------- 用紙・色

/** A4 縦 (pt) */
export const PAGE_W = 595.28;
export const PAGE_H = 841.89;
export const MARGIN = 40;
export const LEFT = MARGIN;
export const RIGHT = PAGE_W - MARGIN;
export const CONTENT_W = RIGHT - LEFT;
/** 本文の下端 (この下はページ番号) */
export const CONTENT_BOTTOM = PAGE_H - MARGIN - 4;

export const C = {
  ink: rgb(0.13, 0.13, 0.15),
  sub: rgb(0.37, 0.37, 0.41),
  faint: rgb(0.6, 0.6, 0.64),
  rule: rgb(0.55, 0.55, 0.58),
  ruleLight: rgb(0.8, 0.8, 0.82),
  fill: rgb(0.925, 0.925, 0.935),
  zebra: rgb(0.966, 0.966, 0.973),
  white: rgb(1, 1, 1),
  accent: rgb(...LOGO_ACCENT_RGB),
  watermarkGrey: rgb(0.45, 0.45, 0.48),
  watermarkRed: rgb(0.86, 0.12, 0.12),
};

// ---------------------------------------------------------------- 書式

const safe = (n: number): number => (typeof n === "number" && Number.isFinite(n) ? n : 0);
/** 負の数の記号 (U+2212 マイナス) */
const MINUS = String.fromCharCode(0x2212);
/** 全角空白 (U+3000) */
const WIDE_SPACE = String.fromCharCode(0x3000);

/** 3 桁区切りの整数 (負は "−1,000") */
export function fmtInt(n: number): string {
  const v = Math.round(safe(n));
  const digits = String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return v < 0 ? `${MINUS}${digits}` : digits;
}

/** "￥1,234" (負は "−￥1,234") */
export function fmtYen(n: number): string {
  const v = Math.round(safe(n));
  return v < 0 ? `${MINUS}￥${fmtInt(-v)}` : `￥${fmtInt(v)}`;
}

const qtyFormat = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 3 });

/** 数量 (整数は小数点なし、4.5 は 4.5) */
export function fmtQty(n: number): string {
  return qtyFormat.format(safe(n)).replace(/^-/, MINUS);
}

/** "2026-11-14" → "2026年11月14日" (形が違うときはそのまま) */
export function fmtJpDate(s?: string | null): string {
  if (!s) return "";
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s.trim());
  return m ? `${Number(m[1])}年${Number(m[2])}月${Number(m[3])}日` : s;
}

/** 高さ height の帯の上下中央に文字を置くときのベースライン (上端からの距離) */
export function centerBaseline(top: number, height: number, size: number): number {
  return top + height / 2 + size * 0.36;
}

// ---------------------------------------------------------------- フォント

export type Weight = "regular" | "bold";

interface Face {
  bytes: Uint8Array;
  font: FontFace;
  /** コードポイントごとの送り幅 (1 em = 1) */
  advance: Map<number, number>;
}
type Faces = Record<Weight, Face>;

/** pdf-lib に渡すバイト列 → 解析済みのフォント (PDF ごとに作り直さない) */
const parsedFonts = new WeakMap<Uint8Array, FontFace>();

/**
 * サブセットの loca 表を長い形式 (version 1) に固定する。
 * @pdf-lib/fontkit 1.1.1 の TrueType サブセットは encode() で this.loca = { offsets: [] } とし、グリフの合計が 64 KB 未満だと
 * 短い形式 (オフセット ÷ 2) で書く。Noto Sans JP は奇数バイトのグリフが多く、÷ 2 でオフセットがずれて字が欠ける
 * (pdf-lib 標準の registerFontkit(fontkit) + subset でも起きる)。元のフォントと同じ長い形式にすれば正しい (fontkit 本家の修正と同じ考え方)
 */
function withLongLoca<T extends object>(subset: T): T {
  let loca: unknown;
  Object.defineProperty(subset, "loca", {
    configurable: true,
    enumerable: true,
    get: () => loca,
    set: (value: unknown) => {
      if (value && typeof value === "object" && (value as { version?: number }).version == null) (value as { version?: number }).version = 1;
      loca = value;
    },
  });
  return subset;
}

function toFace(bytes: Uint8Array): Face {
  const font = fontkit.create(bytes);
  // pdf-lib は文字列を font.layout(text).glyphs でグリフに直す (描画・幅の計算とも、使うのは glyphs だけ)。
  // OpenType の置換・位置調整 (GSUB/GPOS) は和文の帳票には要らず 1 回 ~1 ms かかるため、cmap の対応だけにする。
  // 折り返し・右寄せの幅 (advance) と描画が同じグリフになり、ずれない
  Object.defineProperty(font, "layout", { value: (text: string) => ({ glyphs: font.glyphsForString(text) }) });
  const createSubset = font.createSubset.bind(font);
  Object.defineProperty(font, "createSubset", { value: () => withLongLoca(createSubset()) });
  parsedFonts.set(bytes, font);
  return { bytes, font, advance: new Map() };
}

let facesPromise: Promise<Faces> | null = null;

function loadFaces(): Promise<Faces> {
  facesPromise ??= Promise.all([
    fs.readFile(path.join(process.cwd(), "src/assets/fonts/NotoSansJP-Regular.ttf")),
    fs.readFile(path.join(process.cwd(), "src/assets/fonts/NotoSansJP-Bold.ttf")),
  ])
    .then(([regular, bold]) => ({ regular: toFace(regular), bold: toFace(bold) }))
    .catch((err: unknown) => {
      facesPromise = null;
      throw new Error(`[pdf] フォント (src/assets/fonts/NotoSansJP-*.ttf) を読み込めません: ${err instanceof Error ? err.message : String(err)}`);
    });
  return facesPromise;
}

/** registerFontkit に渡す。読み込み済みのフォントは解析し直さない */
const fontkitWithCache = {
  create: (bytes: Uint8Array, postscriptName?: string) => parsedFonts.get(bytes) ?? fontkit.create(bytes, postscriptName),
} as unknown as Parameters<PDFDocument["registerFontkit"]>[0];

// ---------------------------------------------------------------- 文字の整形・計測・折り返し

/** フォントにないときは黙って落とす文字 (絵文字・異体字セレクタ・結合文字・書式制御など、なくても読めるもの) */
const SILENT = new RegExp("[\\p{Extended_Pictographic}\\p{Emoji_Modifier}\\p{Regional_Indicator}\\p{Cf}\\p{Mn}\\p{Me}]", "u");
/** 行末の空白 (半角・全角) */
const TRAILING_SPACES = new RegExp(`[ ${WIDE_SPACE}]+$`, "gm");
/** 行頭に置かない文字 (句読点・閉じ括弧・小書きの仮名・長音) */
const NO_LINE_START = new Set(Array.from("、。，．,.)）]］}｝」』】〕〉》’”:：;；!！?？・ー～…‥ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ々ゝゞヽヾ%％"));
/** 行末に置かない文字 (開き括弧など) */
const NO_LINE_END = new Set(Array.from("(（[［{｛「『【〔〈《‘“￥¥$＄〒#＃"));
/** 英数字の語 (途中では折り返さない) */
const isWordChar = (ch: string | undefined): boolean => ch !== undefined && ch.length === 1 && ch > " " && ch <= "~";

/** 分かれた濁点・アクセント記号 (U+0300–036F, U+3099, U+309A) を含むか。含むときだけ NFC で合成する */
function hasCombiningMark(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 0x300 && c <= 0x36f) || c === 0x3099 || c === 0x309a) return true;
  }
  return false;
}

/** 改行として扱う文字 (LF, NEL, LINE/PARAGRAPH SEPARATOR) */
const isLineBreak = (cp: number): boolean => cp === 0x0a || cp === 0x85 || cp === 0x2028 || cp === 0x2029;

const renderable = new Map<number, boolean>();

export interface WrapOptions {
  weight?: Weight;
  /** これを超えた分は切り、最後の行の末尾を「…」にする */
  maxLines?: number;
  /** true: 改行を残す (段落ごとに折り返す)。false: 改行は空白にする */
  multiline?: boolean;
}

export class Typesetter {
  constructor(private readonly faces: Faces) {}

  private hasGlyph(cp: number): boolean {
    let ok = renderable.get(cp);
    if (ok === undefined) {
      ok = this.faces.regular.font.hasGlyphForCodePoint(cp) && this.faces.bold.font.hasGlyphForCodePoint(cp);
      if (renderable.size > 20000) renderable.clear();
      renderable.set(cp, ok);
    }
    return ok;
  }

  /**
   * 描ける文字だけにする: 制御文字を除く / フォントにない絵文字・装飾は落とす / その他のない文字は "?"。
   * multiline=false では改行・タブを空白にして前後の空白を除く
   */
  clean(raw: unknown, multiline = false): string {
    if (raw === null || raw === undefined) return "";
    let s = String(raw);
    if (hasCombiningMark(s)) s = s.normalize("NFC");
    s = s.replace(/\r\n?/g, "\n");
    if (!multiline) s = s.replace(/[\n\t]+/g, " ");
    let out = "";
    for (const ch of s) {
      const cp = ch.codePointAt(0) ?? 0;
      if (isLineBreak(cp)) {
        out += multiline ? "\n" : " ";
        continue;
      }
      if (cp === 0x09) {
        out += "  ";
        continue;
      }
      if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) continue;
      if (cp === 0x20 || this.hasGlyph(cp)) {
        out += ch;
        continue;
      }
      if ((cp >= 0xd800 && cp <= 0xdfff) || SILENT.test(ch)) continue;
      out += /\s/.test(ch) ? " " : "?";
    }
    return multiline ? out.replace(TRAILING_SPACES, "").replace(/^\n+|\n+$/g, "") : out.trim();
  }

  private advance(weight: Weight, ch: string): number {
    const face = this.faces[weight];
    const cp = ch.codePointAt(0) ?? 0;
    let a = face.advance.get(cp);
    if (a === undefined) {
      a = face.font.glyphForCodePoint(cp).advanceWidth / face.font.unitsPerEm;
      face.advance.set(cp, a);
    }
    return a;
  }

  /** 文字列の幅 (pt)。clean() 済みの文字列を渡す */
  width(text: string, size: number, weight: Weight = "regular"): number {
    let w = 0;
    for (const ch of text) w += this.advance(weight, ch);
    return w * size;
  }

  /** 幅に収まるよう末尾を「…」にする */
  fit(text: string, size: number, maxWidth: number, weight: Weight = "regular"): string {
    if (this.width(text, size, weight) <= maxWidth) return text;
    const room = maxWidth - this.width("…", size, weight);
    let w = 0;
    let out = "";
    for (const ch of text) {
      const cw = this.advance(weight, ch) * size;
      if (w + cw > room) break;
      w += cw;
      out += ch;
    }
    return `${out.trimEnd()}…`;
  }

  /** 文字の幅で折り返す (和文は 1 文字ごと・英数字の語は途中で切らない・簡単な禁則) */
  wrap(raw: unknown, size: number, maxWidth: number, opts: WrapOptions = {}): string[] {
    const weight = opts.weight ?? "regular";
    const text = this.clean(raw, opts.multiline ?? false);
    if (!text) return [];
    const lines: string[] = [];
    for (const para of text.split("\n")) lines.push(...this.breakParagraph(para, size, maxWidth, weight));
    const max = opts.maxLines ?? Infinity;
    if (lines.length <= max) return lines;
    const kept = lines.slice(0, Math.max(1, max));
    const last = kept.length - 1;
    kept[last] = this.fit(`${kept[last]}…`, size, maxWidth, weight);
    return kept;
  }

  private breakParagraph(para: string, size: number, maxWidth: number, weight: Weight): string[] {
    if (!para) return [""];
    const chars = Array.from(para);
    const widths = chars.map((ch) => this.advance(weight, ch) * size);
    const out: string[] = [];
    let i = 0;
    while (i < chars.length) {
      let w = 0;
      let j = i;
      while (j < chars.length && w + widths[j] <= maxWidth + 0.01) w += widths[j++];
      if (j >= chars.length) {
        out.push(chars.slice(i).join("").trimEnd());
        break;
      }
      if (j === i) j = i + 1; // 1 文字も入らない幅
      let brk = j;
      // 英数字の語の途中なら語の頭で切る (行の先頭から続く長い語は途中で切る)
      if (isWordChar(chars[brk]) && isWordChar(chars[brk - 1])) {
        let k = brk - 1;
        while (k > i && isWordChar(chars[k - 1])) k--;
        if (k > i) brk = k;
      }
      // 行頭禁則 (前の文字ごと次の行へ送る)・行末禁則
      while (brk > i + 1 && NO_LINE_START.has(chars[brk])) brk--;
      while (brk > i + 1 && NO_LINE_END.has(chars[brk - 1])) brk--;
      out.push(chars.slice(i, brk).join("").trimEnd());
      i = brk;
      while (i < chars.length && chars[i] === " ") i++;
    }
    return out;
  }
}

// ---------------------------------------------------------------- 文書 (ページ・描画)

export interface TextStyle {
  size: number;
  weight?: Weight;
  color?: RGB;
  /** x の意味: left = 左端 / right = 右端 / center = 中心 */
  align?: "left" | "right" | "center";
  /** これより広いときは縮小 (shrinkTo の大きさまで)、それでも入らなければ末尾を「…」で切る */
  maxWidth?: number;
  shrinkTo?: number;
  opacity?: number;
}

export interface BoxStyle {
  fill?: RGB;
  stroke?: RGB;
  lineWidth?: number;
  dash?: number[];
  opacity?: number;
}

export interface Watermark {
  text: string;
  size: number;
  color: RGB;
  opacity: number;
}

export interface SheetMeta {
  /** 例: "御見積書 Q-2026-0012" */
  title: string;
  subject: string;
  author: string;
}

export class Sheet {
  readonly pages: PDFPage[] = [];
  private current: PDFPage | null = null;
  /** 次に描く位置 (上端からの距離) */
  y = MARGIN;
  /** 2 ページ目以降の上部 (見出しを描いて本文の開始位置を返す) */
  onNewPage: (() => number) | null = null;

  private constructor(
    readonly doc: PDFDocument,
    readonly ts: Typesetter,
    private readonly fonts: Record<Weight, PDFFont>,
  ) {}

  static async create(meta: SheetMeta): Promise<Sheet> {
    const faces = await loadFaces();
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkitWithCache);
    const [regular, bold] = await Promise.all([
      doc.embedFont(faces.regular.bytes, { subset: true }),
      doc.embedFont(faces.bold.bytes, { subset: true }),
    ]);
    const ts = new Typesetter(faces);
    const author = ts.clean(meta.author);
    doc.setTitle(ts.clean(meta.title), { showInWindowTitleBar: true });
    doc.setSubject(ts.clean(meta.subject));
    if (author) doc.setAuthor(author);
    doc.setCreator("一畳屋 業務システム");
    doc.setProducer("一畳屋 業務システム (pdf-lib)");
    doc.setLanguage("ja-JP");
    return new Sheet(doc, ts, { regular, bold });
  }

  get page(): PDFPage {
    if (!this.current) throw new Error("[pdf] addPage() の前に描画しています");
    return this.current;
  }

  addPage(): PDFPage {
    this.current = this.doc.addPage([PAGE_W, PAGE_H]);
    this.pages.push(this.current);
    this.y = this.pages.length > 1 && this.onNewPage ? this.onNewPage() : MARGIN;
    return this.current;
  }

  /** 今のページの残りに高さ h が入るか */
  fits(h: number): boolean {
    return this.y + h <= CONTENT_BOTTOM;
  }

  /** 入らなければ改ページ */
  ensure(h: number): void {
    if (!this.fits(h)) this.addPage();
  }

  /** 1 行の文字を描き、描いた幅を返す (baseline は上端からの距離) */
  text(raw: unknown, x: number, baseline: number, style: TextStyle): number {
    let s = this.ts.clean(raw);
    if (!s) return 0;
    const weight = style.weight ?? "regular";
    let size = style.size;
    let w = this.ts.width(s, size, weight);
    if (style.maxWidth !== undefined && w > style.maxWidth) {
      if (style.shrinkTo !== undefined && style.shrinkTo < size) {
        size = Math.max(style.shrinkTo, (size * style.maxWidth) / w);
        w = this.ts.width(s, size, weight);
      }
      if (w > style.maxWidth) {
        s = this.ts.fit(s, size, style.maxWidth, weight);
        w = this.ts.width(s, size, weight);
      }
    }
    const left = style.align === "right" ? x - w : style.align === "center" ? x - w / 2 : x;
    this.page.drawText(s, {
      x: left,
      y: PAGE_H - baseline,
      size,
      font: this.fonts[weight],
      color: style.color ?? C.ink,
      opacity: style.opacity,
    });
    return w;
  }

  /** 字間を空けた見出し (例: 御 見 積 書)。中心 cx に置き、全体の幅を返す */
  spacedText(raw: string, cx: number, baseline: number, size: number, tracking: number): number {
    const chars = Array.from(this.ts.clean(raw));
    const widths = chars.map((ch) => this.ts.width(ch, size, "bold"));
    const total = widths.reduce((a, b) => a + b, 0) + tracking * Math.max(0, chars.length - 1);
    let x = cx - total / 2;
    chars.forEach((ch, i) => {
      this.text(ch, x, baseline, { size, weight: "bold" });
      x += widths[i] + tracking;
    });
    return total;
  }

  rect(x: number, top: number, width: number, height: number, style: BoxStyle): void {
    this.page.drawRectangle({
      x,
      y: PAGE_H - top - height,
      width,
      height,
      color: style.fill,
      borderColor: style.stroke,
      borderWidth: style.stroke ? (style.lineWidth ?? 0.5) : 0,
      borderDashArray: style.dash,
      opacity: style.opacity,
    });
  }

  line(x1: number, t1: number, x2: number, t2: number, style: { width?: number; color?: RGB; dash?: number[] } = {}): void {
    this.page.drawLine({
      start: { x: x1, y: PAGE_H - t1 },
      end: { x: x2, y: PAGE_H - t2 },
      thickness: style.width ?? 0.5,
      color: style.color ?? C.rule,
      dashArray: style.dash,
    });
  }

  /** 横線 (上端からの距離 t) */
  hline(x1: number, x2: number, t: number, style: { width?: number; color?: RGB; dash?: number[] } = {}): void {
    this.line(x1, t, x2, t, style);
  }

  /** ロゴ (左上を x, top に置く)。描いた高さを返す */
  logo(x: number, top: number, width: number): number {
    const scale = width / LOGO_VIEWBOX.width;
    for (const p of LOGO_PATHS) {
      this.page.drawSvgPath(p.d, { x, y: PAGE_H - top, scale, color: p.accent ? C.accent : C.ink });
    }
    return LOGO_VIEWBOX.height * scale;
  }

  /** ページ中央に斜めの透かし */
  private watermark(page: PDFPage, mark: Watermark): void {
    const text = this.ts.clean(mark.text);
    if (!text) return;
    const angle = 32;
    const rad = (angle * Math.PI) / 180;
    // 透かしが用紙からはみ出さない大きさに抑える
    const span = PAGE_W * 0.9;
    let size = mark.size;
    const w0 = this.ts.width(text, size, "bold");
    if (w0 * Math.cos(rad) > span) size = (size * span) / (w0 * Math.cos(rad));
    const w = this.ts.width(text, size, "bold");
    const h = size * 0.36;
    const cx = PAGE_W / 2;
    const cy = PAGE_H / 2;
    page.drawText(text, {
      x: cx - (w / 2) * Math.cos(rad) + h * Math.sin(rad),
      y: cy - (w / 2) * Math.sin(rad) - h * Math.cos(rad),
      size,
      font: this.fonts.bold,
      color: mark.color,
      opacity: mark.opacity,
      rotate: degrees(angle),
    });
  }

  /** 透かし・ページ番号 (2 ページ以上のとき「1 / 2」) を入れて PDF にする */
  async finish(mark?: Watermark): Promise<Uint8Array> {
    const total = this.pages.length;
    this.pages.forEach((page, i) => {
      this.current = page;
      if (mark) this.watermark(page, mark);
      if (total > 1) this.text(`${i + 1} / ${total}`, PAGE_W / 2, PAGE_H - 22, { size: 8, color: C.sub, align: "center" });
    });
    return this.doc.save();
  }
}
