import { inflateRawSync } from "node:zlib";

/**
 * .xlsx (Excel・Google スプレッドシートの書き出し) の読み取り (ライブラリを使わない最小限の実装)
 * ------------------------------------------------------------
 * zip の中の workbook.xml・sharedStrings.xml・各シートの XML から、シートごとの セル (A1 形式) → 文字 を返す。
 * 数式は計算済みの値 (v) を読む。書式・結合セルは扱わない。読み取り専用 (管理会計の地域一覧・原価マスタの取込に使う)
 */

export interface XlsxSheet {
  name: string;
  /** 行番号 (1〜) → 列 (A, B, …) → 値 */
  rows: Map<number, Map<string, string>>;
}

function entries(buf: Buffer): Map<string, Buffer> {
  // 中央ディレクトリの終わり (EOCD) を後ろから探す
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("xlsx (zip) の形式ではありません。");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("xlsx の中身を読めません。");
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const lNameLen = buf.readUInt16LE(local + 26);
    const lExtraLen = buf.readUInt16LE(local + 28);
    const start = local + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(start, start + csize);
    if (method === 0) out.set(name, Buffer.from(data));
    else if (method === 8) out.set(name, inflateRawSync(data, { maxOutputLength: 200 * 1024 * 1024 }));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** zip の中のファイル (名前 → 中身)。.docx・.pptx の読み取り (src/lib/registry/extract.ts) にも使う */
export const zipEntries = entries;

const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, "&");

/** <t> の文字をつなげる (ふりがな <rPh> は除く) */
const texts = (xml: string) => [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decode(m[1])).join("");

export function readXlsx(buf: Buffer, opts: { sheet?: (name: string) => boolean } = {}): XlsxSheet[] {
  const files = entries(buf);
  const text = (n: string) => files.get(n)?.toString("utf8") ?? "";
  const shared = [...text("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1]));
  const rels = new Map([...text("xl/_rels/workbook.xml.rels").matchAll(/<Relationship\b[^>]*?Id="([^"]+)"[^>]*?Target="([^"]+)"/g)].map((m) => [m[1], m[2]]));
  const sheets: XlsxSheet[] = [];
  for (const m of text("xl/workbook.xml").matchAll(/<sheet\b[^>]*?name="([^"]*)"[^>]*?r:id="([^"]+)"/g)) {
    const name = decode(m[1]);
    if (opts.sheet && !opts.sheet(name)) continue;
    const target = rels.get(m[2]);
    if (!target) continue;
    const path = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
    const xml = text(path);
    const rows = new Map<number, Map<string, string>>();
    for (const c of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1];
      const ref = /\br="([A-Z]+)(\d+)"/.exec(attrs);
      if (!ref) continue;
      const t = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const body = c[2] ?? "";
      let v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let value: string;
      if (t === "s") value = v !== undefined ? (shared[Number(v)] ?? "") : "";
      else if (t === "inlineStr") value = texts(body);
      else value = v !== undefined ? decode(v) : "";
      v = undefined;
      if (value === "") continue;
      const r = Number(ref[2]);
      (rows.get(r) ?? rows.set(r, new Map()).get(r)!).set(ref[1], value);
    }
    sheets.push({ name, rows });
  }
  return sheets;
}

/** 地域一覧のシート (名前の前後の空白は無視) から 店舗名・町名 の行 */
export function areaRowsFromXlsx(buf: Buffer): { sheet: string; rows: { store: string; town: string; ref: string }[] } | null {
  const sheet = readXlsx(buf, { sheet: (n) => n.trim() === "地域一覧" })[0];
  if (!sheet) return null;
  const out: { store: string; town: string; ref: string }[] = [];
  // 見出しの行 (「店舗」「町名」) を探し、その列を使う。見つからなければ B 列・C 列
  let storeCol = "B";
  let townCol = "C";
  let headerRow = 0;
  for (const [r, cols] of [...sheet.rows].sort((a, b) => a[0] - b[0]).slice(0, 10)) {
    for (const [col, v] of cols) {
      if (/店舗/.test(v)) storeCol = col;
      if (/町名|地域/.test(v)) townCol = col;
    }
    if ([...cols.values()].some((v) => /町名/.test(v))) {
      headerRow = r;
      break;
    }
  }
  let last = "";
  for (const [r, cols] of [...sheet.rows].sort((a, b) => a[0] - b[0])) {
    if (r <= headerRow) continue;
    const town = (cols.get(townCol) ?? "").trim();
    const store = (cols.get(storeCol) ?? "").trim() || last;
    if (store) last = store;
    if (town) out.push({ store, town, ref: `${townCol}${r}` });
  }
  return { sheet: sheet.name, rows: out };
}
