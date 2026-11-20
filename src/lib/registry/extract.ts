import { readXlsx, zipEntries } from "@/lib/xlsx";

/**
 * データ台帳: ファイルの中身を文字にする (解読の段階)
 * ------------------------------------------------------------
 * 表計算 (シートごと)・Word (.docx)・PowerPoint (.pptx)・テキスト・CSV・zip (中のファイル名) を、
 * AI と検索が読める「節 (Section)」の並びにする。外部のサービスは使わない。
 * PDF・古い形式 (.doc・.xls) は呼び出し側が文字にしてから textSections に渡す (サーバーの pdftotext・スクリプトの SheetJS / LibreOffice)。
 * 画面の取込 (src/lib/registry/ingest.ts) とスクリプト (scripts/registry/scan-materials.mjs) の両方が使う
 */

export interface Section {
  /** シート名・スライド番号・見出し (なければファイル名) */
  title: string;
  text: string;
}

/** 1 つの節の文字の上限 (これより長い表は打ち切り、打ち切ったことを書く) */
export const SECTION_MAX_CHARS = 60_000;
const MAX_COLS = 40;

const cellText = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "" : v.toISOString().slice(0, 10);
  return String(v).replace(/[\r\n\t]+/g, " ").replace(/[ 　]{2,}/g, " ").trim();
};

/**
 * 表 (行 × 列) を文字にする。空の行は除き、行の後ろの空のセルは削る。列の位置が分かるように間の空のセルは残す。
 * 同じ行が続くときは 1 行にする
 */
export function rowsToText(rows: unknown[][], maxChars = SECTION_MAX_CHARS): string {
  const out: string[] = [];
  let size = 0;
  let prev = "";
  for (const row of rows) {
    const cells = row.slice(0, MAX_COLS).map(cellText);
    while (cells.length && !cells[cells.length - 1]) cells.pop();
    let first = 0;
    while (first < cells.length && !cells[first]) first++;
    if (first >= cells.length) continue;
    // 先頭の空のセルは 1 つにまとめる (結合セルの見出しで右にずれた行)
    const line = `${first > 0 ? "| " : ""}${cells.slice(first).join(" | ")}`;
    if (line === prev) continue;
    prev = line;
    if (size + line.length > maxChars) {
      out.push(`…(以下 ${rows.length} 行のうち途中まで)`);
      break;
    }
    out.push(line);
    size += line.length + 1;
  }
  return out.join("\n");
}

/** .xlsx / .xlsm (ライブラリなし。数式は計算済みの値) → シートごとの節 */
export function xlsxSections(buf: Buffer): Section[] {
  return readXlsx(buf).map((s) => {
    const rowNums = [...s.rows.keys()].sort((a, b) => a - b);
    const colIndex = (c: string) => [...c].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
    const rows: string[][] = rowNums.map((r) => {
      const cols = s.rows.get(r)!;
      const arr: string[] = [];
      for (const [c, v] of cols) {
        const i = colIndex(c);
        if (i < MAX_COLS) arr[i] = v;
      }
      return Array.from(arr, (v) => v ?? "");
    });
    return { title: s.name, text: rowsToText(rows) };
  });
}

const decodeXml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");

/** Word の XML (段落・表) → 文字。表の行はセルを「 | 」でつなぐ */
export function wordXmlToText(xml: string): string {
  const para = (p: string) =>
    decodeXml(
      p
        .replace(/<w:tab\/>/g, " ")
        .replace(/<w:br\/>/g, "\n")
        .replace(/<w:rPh\b[\s\S]*?<\/w:rPh>/g, "")
        .match(/<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>|\n/g)
        ?.map((t) => (t === "\n" ? "\n" : t.replace(/<[^>]+>/g, "")))
        .join("") ?? "",
    ).trim();
  const lines: string[] = [];
  // 表は行ごと、それ以外は段落ごと
  const body = xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, (tbl) => {
    const rows = [...tbl.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)].map((tr) => [...tr[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map((tc) => [...tc[0].matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)].map((p) => para(p[0])).filter(Boolean).join(" ")));
    return `<w:p><w:r><w:t>${rows
      .map((r) => r.join(" | ").replace(/^[\s|]+$/, ""))
      .filter(Boolean)
      .join("\u0001")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")}</w:t></w:r></w:p>`;
  });
  for (const p of body.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)) {
    const t = para(p[0]).replace(/\u0001/g, "\n");
    if (t) lines.push(t);
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** .docx → 本文 (ヘッダー・フッターは除く) */
export function docxText(buf: Buffer): string {
  const files = zipEntries(buf);
  const doc = files.get("word/document.xml")?.toString("utf8");
  if (!doc) throw new Error("Word (.docx) の本文が見つかりません。");
  return wordXmlToText(doc);
}

/** .pptx → スライドごとの節 */
export function pptxSections(buf: Buffer): Section[] {
  const files = zipEntries(buf);
  const slides = [...files.keys()]
    .map((k) => /^ppt\/slides\/slide(\d+)\.xml$/.exec(k))
    .filter((m): m is RegExpExecArray => Boolean(m))
    .sort((a, b) => Number(a[1]) - Number(b[1]));
  return slides
    .map((m) => {
      const xml = files.get(m[0])!.toString("utf8");
      const text = [...xml.matchAll(/<a:p\b[\s\S]*?<\/a:p>/g)]
        .map((p) => decodeXml([...p[0].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => t[1]).join("")).trim())
        .filter(Boolean)
        .join("\n");
      return { title: `スライド ${m[1]}`, text };
    })
    .filter((s) => s.text);
}

/** zip の中のファイルの名前 (中身は展開しない。暗号化・壊れた zip でも名前は読める) */
export function zipNames(buf: Buffer): string[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip の形式ではありません。");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const names: string[] = [];
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const flags = buf.readUInt16LE(p + 8);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const raw = buf.subarray(p + 46, p + 46 + nameLen);
    // 名前の文字コード: UTF-8 の印 (bit 11) か、UTF-8 として正しければ UTF-8。そうでなければ Shift_JIS (日本の Windows の zip)
    let name = raw.toString("utf8");
    if (!(flags & 0x800)) {
      try {
        name = new TextDecoder("utf-8", { fatal: true }).decode(raw);
      } catch {
        try {
          name = new TextDecoder("shift_jis").decode(raw);
        } catch {
          /* そのまま */
        }
      }
    }
    names.push(name);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

/** zip → 中のファイルの一覧 (名前で探せるように) */
export function zipListing(buf: Buffer): string {
  return zipNames(buf)
    .filter((n) => !n.endsWith("/") && !/(^|\/)(__MACOSX|\.DS_Store)/.test(n))
    .slice(0, 500)
    .join("\n");
}

/** 文字のファイル (CSV・テキスト・PDF の文字) を、見出しやページの区切りで節に分ける。区切りがなければ 1 節 */
export function textSections(title: string, text: string, opts: { pages?: boolean } = {}): Section[] {
  const clean = text.replace(/\r\n?/g, "\n").replace(/[ \t　]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!clean) return [];
  if (opts.pages && clean.includes("\f")) {
    const pages = clean.split("\f").map((p) => p.trim());
    // 短いページはまとめる (1 節 = 数ページ)
    const out: Section[] = [];
    let buf = "";
    let from = 1;
    pages.forEach((p, i) => {
      if (!p) return;
      if (buf && buf.length + p.length > 6000) {
        out.push({ title: from === i ? `${from} ページ` : `${from}〜${i} ページ`, text: buf.trim() });
        buf = "";
        from = i + 1;
      }
      buf += `${p}\n`;
    });
    if (buf.trim()) out.push({ title: from === pages.length ? `${from} ページ` : `${from}〜${pages.length} ページ`, text: buf.trim() });
    return out.length === 1 ? [{ title, text: out[0].text }] : out;
  }
  return [{ title, text: clean.slice(0, SECTION_MAX_CHARS * 4) }];
}

/** 文字コードの判定 (UTF-8 として読めなければ Shift_JIS) */
export function decodeText(buf: Buffer): string {
  const utf8 = buf.toString("utf8");
  if (!utf8.includes("�")) return utf8.replace(/^﻿/, "");
  try {
    return new TextDecoder("shift_jis").decode(buf);
  } catch {
    return utf8;
  }
}

export type ExtractKind = "spreadsheet" | "document" | "slides" | "pdf" | "text" | "archive" | "image" | "media" | "other";

export function kindOfExt(ext: string): ExtractKind {
  const e = ext.toLowerCase().replace(/^\./, "");
  if (["xlsx", "xlsm", "xls", "ods", "csv", "tsv"].includes(e)) return e === "csv" || e === "tsv" ? "text" : "spreadsheet";
  if (["docx", "doc", "rtf", "odt"].includes(e)) return "document";
  if (["pptx", "ppt"].includes(e)) return "slides";
  if (e === "pdf") return "pdf";
  if (["txt", "md", "json", "html", "htm"].includes(e)) return "text";
  if (["zip"].includes(e)) return "archive";
  if (["jpg", "jpeg", "png", "gif", "heic", "heif", "webp", "tif", "tiff", "bmp", "jfif", "ai", "psd"].includes(e)) return "image";
  if (["mp4", "mov", "mp3", "wav", "m4a", "avi", "prproj", "aly"].includes(e)) return "media";
  return "other";
}

/**
 * ライブラリなしで読める形式 (画面からの取込で使う)。.xls・.doc などは null (呼び出し側で変換)
 */
export function extractBuiltin(name: string, buf: Buffer): Section[] | null {
  const ext = (/\.([^.]+)$/.exec(name)?.[1] ?? "").toLowerCase();
  const base = name.replace(/\.[^.]+$/, "");
  switch (ext) {
    case "xlsx":
    case "xlsm":
      return xlsxSections(buf).filter((s) => s.text);
    case "docx":
      return textSections(base, docxText(buf));
    case "pptx":
      return pptxSections(buf);
    case "zip":
      return [{ title: `${base} (中のファイル)`, text: zipListing(buf) }];
    case "csv":
    case "tsv":
    case "txt":
    case "md":
      return textSections(base, decodeText(buf));
    default:
      return null;
  }
}
