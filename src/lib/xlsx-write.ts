import { deflateRawSync } from "node:zlib";

/**
 * .xlsx の書き出し (ライブラリを使わない最小限の実装。読み取りは src/lib/xlsx.ts)
 * ------------------------------------------------------------
 * シートごとに 行 × 列 の値 (文字・数値・空) を書く。書式は 文字の大きさ・太字・下線・折り返し・罫線・寄せ、列の幅・行の高さ、セルの結合、
 * 印刷の設定 (用紙・向き・1 ページに収める・余白)。労務士へ送る勤務表 (src/lib/hr/attendance-xlsx.ts。いまの「令和○年度.xlsx」の見た目) に使う
 */

export interface XStyle {
  bold?: boolean;
  underline?: boolean;
  /** 文字の大きさ (pt。既定 11) */
  size?: number;
  wrap?: boolean;
  border?: boolean;
  align?: "left" | "center" | "right";
  /** 縦の位置 (既定: 罫線・大きさのあるセルは中央) */
  valign?: "top" | "center";
  /** 文字列の表示形式 (「@」= 文字。時刻の「0:21」を数にしない) */
  text?: boolean;
}

export type XCell = string | number | null | undefined | ({ v: string | number | null | undefined } & XStyle);

export interface XPage {
  /** 9 = A4 */
  paper?: number;
  orientation?: "portrait" | "landscape";
  /** 1 ページに収める */
  fitToPage?: boolean;
  /** 余白 (インチ) */
  margins?: { left: number; right: number; top: number; bottom: number; header: number; footer: number };
}

export interface XSheet {
  name: string;
  rows: XCell[][];
  /** 列の幅 (文字数) */
  widths?: number[];
  /** 行の高さ (pt。行の番号 - 1 の位置。空 = 既定) */
  heights?: (number | undefined)[];
  /** 結合 ("A1:C1") */
  merges?: string[];
  page?: XPage;
}

export interface XBook {
  /** 既定のフォント (既定 游ゴシック) */
  font?: string;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** zip を作る (deflate) */
export function makeZip(files: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const comp = deflateRawSync(f.data);
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 の名前
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, comp);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // XML に書けない制御文字を除く (改行・タブは残す)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");

export function colName(i: number): string {
  let n = i + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** セルの書式 → 書式の番号 (styles.xml の cellXfs)。同じ書式は 1 つにまとめる */
class StyleTable {
  private fonts = new Map<string, number>();
  private xfs = new Map<string, number>();
  private fontXml: string[] = [];
  private xfXml: string[] = [];
  constructor(private fontName: string) {
    this.font({});
    this.xfXml.push(`<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>`);
    this.xfs.set("", 0);
  }
  private font(st: XStyle): number {
    const key = `${st.bold ? "b" : ""}${st.underline ? "u" : ""}${st.size ?? 11}`;
    const hit = this.fonts.get(key);
    if (hit !== undefined) return hit;
    const id = this.fontXml.length;
    this.fontXml.push(`<font>${st.bold ? "<b/>" : ""}${st.underline ? "<u/>" : ""}<sz val="${st.size ?? 11}"/><name val="${esc(this.fontName)}"/><family val="3"/><charset val="128"/></font>`);
    this.fonts.set(key, id);
    return id;
  }
  of(st: XStyle): number {
    const valign = st.valign ?? (st.border || st.size || st.align ? "center" : st.wrap ? "top" : undefined);
    const key = JSON.stringify([st.bold, st.underline, st.size, st.wrap, st.border, st.align, valign, st.text]);
    if (key === JSON.stringify([undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined])) return 0;
    const hit = this.xfs.get(key);
    if (hit !== undefined) return hit;
    const fontId = this.font(st);
    const align = st.align || valign || st.wrap ? `<alignment${st.align ? ` horizontal="${st.align}"` : ""}${valign ? ` vertical="${valign}"` : ""}${st.wrap ? ` wrapText="1"` : ""}/>` : "";
    const id = this.xfXml.length;
    this.xfXml.push(
      `<xf numFmtId="${st.text ? 49 : 0}" fontId="${fontId}" fillId="0" borderId="${st.border ? 1 : 0}" xfId="0"${st.text ? ` applyNumberFormat="1"` : ""}${fontId ? ` applyFont="1"` : ""}${st.border ? ` applyBorder="1"` : ""}${align ? ` applyAlignment="1">${align}</xf>` : "/>"}`,
    );
    this.xfs.set(key, id);
    return id;
  }
  xml(): string {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="${this.fontXml.length}">${this.fontXml.join("")}</fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color auto="1"/></left><right style="thin"><color auto="1"/></right><top style="thin"><color auto="1"/></top><bottom style="thin"><color auto="1"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${this.xfXml.length}">${this.xfXml.join("")}</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
  }
}

function sheetXml(sh: XSheet, styles: StyleTable): string {
  const cols = sh.widths?.length ? `<cols>${sh.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>` : "";
  const count = Math.max(sh.rows.length, sh.heights?.length ?? 0);
  const rows = Array.from({ length: count }, (_, ri) => {
    const row = sh.rows[ri] ?? [];
    const cells = row
      .map((raw, ci) => {
        const c = raw !== null && typeof raw === "object" ? raw : { v: raw };
        const s = raw !== null && typeof raw === "object" ? styles.of(raw) : 0;
        const ref = `${colName(ci)}${ri + 1}`;
        const sa = s ? ` s="${s}"` : "";
        if (c.v === null || c.v === undefined || c.v === "") return s ? `<c r="${ref}"${sa}/>` : "";
        if (typeof c.v === "number" && Number.isFinite(c.v)) return `<c r="${ref}"${sa}><v>${c.v}</v></c>`;
        return `<c r="${ref}"${sa} t="inlineStr"><is><t xml:space="preserve">${esc(String(c.v))}</t></is></c>`;
      })
      .join("");
    const ht = sh.heights?.[ri];
    const attrs = ht ? ` ht="${ht}" customHeight="1"` : "";
    return cells || attrs ? `<row r="${ri + 1}"${attrs}>${cells}</row>` : "";
  }).join("");
  const merges = sh.merges?.length ? `<mergeCells count="${sh.merges.length}">${sh.merges.map((m) => `<mergeCell ref="${m}"/>`).join("")}</mergeCells>` : "";
  const pg = sh.page;
  const m = pg?.margins ?? { left: 0.7, right: 0.7, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 };
  const sheetPr = pg?.fitToPage ? `<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>` : "";
  const setup = pg ? `<pageSetup paperSize="${pg.paper ?? 9}" orientation="${pg.orientation ?? "portrait"}"${pg.fitToPage ? ` fitToWidth="1" fitToHeight="1"` : ""}/>` : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${sheetPr}<sheetFormatPr defaultRowHeight="13.5"/>${cols}<sheetData>${rows}</sheetData>${merges}<pageMargins left="${m.left}" right="${m.right}" top="${m.top}" bottom="${m.bottom}" header="${m.header}" footer="${m.footer}"/>${setup}</worksheet>`;
}

/** シート名に使えない文字を除く (31 文字まで) */
const sheetName = (s: string) => s.replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Sheet";

export function writeXlsx(sheets: XSheet[], book: XBook = {}): Buffer {
  const list = sheets.length ? sheets : [{ name: "Sheet1", rows: [] }];
  const styles = new StyleTable(book.font ?? "游ゴシック");
  const sheetFiles = list.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s, styles) }));
  const names = list.map((s) => sheetName(s.name));
  const files = [
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${list.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`,
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${list.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    },
    { name: "xl/styles.xml", data: styles.xml() },
    ...sheetFiles,
  ];
  return makeZip(files.map((f) => ({ name: f.name, data: Buffer.from(f.data, "utf8") })));
}
