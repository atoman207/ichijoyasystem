import type { MaterialOrderCategory, MaterialOrderStatus } from "@/lib/db/types";
import { readXlsx } from "@/lib/xlsx";
import { xlsxRows } from "@/lib/survey-workbook/read";

/**
 * リフォーム発注管理票 (.xlsx) の読み取り
 * ------------------------------------------------------------
 * 原本・記入例の列: 業者 / 工事・材料等 / 数量 / 単位 / 単価 / 原価 / 発注日 / 施工・納品日 / 納品場所 / 備考
 * (記入例②は単位列なしの並びもある)。業者欄が空の行は直前の業者を引き継ぐ。小計・空行は除く。
 * 画面の「材料の発注」へ取り込むと、発注先・数量・必要な日・備考として残る (打刻・給与は対象外)
 */

const N = (s: string) => s.normalize("NFKC").replace(/[\s　]+/g, " ").trim();

export interface ReformSheetLine {
  supplierName?: string;
  name: string;
  qty?: number;
  unit?: string;
  unitPrice?: number;
  cost?: number;
  orderedOn?: string;
  neededBy?: string;
  deliveryPlace?: string;
  note?: string;
  category: MaterialOrderCategory;
  /** 発注日があれば発注済み、なければ未発注 */
  status: MaterialOrderStatus;
}

export interface ParsedReformSheet {
  sheetName: string;
  /** 工事名 (「工事名：Ａ様　改装工事」) */
  title?: string;
  address?: string;
  lines: ReformSheetLine[];
}

function parseNum(raw: unknown): number | undefined {
  if (raw === null || raw === undefined || raw === "") return undefined;
  const s = N(String(raw)).replace(/[,，]/g, "").replace(/円/g, "");
  if (!s || s === "0") return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/** 発注日・施工日を YYYY-MM-DD に (年がなければ year を使う) */
export function parseLooseDate(raw: unknown, year: number): string | undefined {
  const s = N(String(raw ?? ""));
  if (!s) return undefined;
  const iso = s.match(/^(\d{4})[\/\-年.](\d{1,2})[\/\-月.](\d{1,2})/);
  if (iso) return `${iso[1]}-${String(Number(iso[2])).padStart(2, "0")}-${String(Number(iso[3])).padStart(2, "0")}`;
  const md = s.match(/^(\d{1,2})[\/\-月.](\d{1,2})/);
  if (md) return `${year}-${String(Number(md[1])).padStart(2, "0")}-${String(Number(md[2])).padStart(2, "0")}`;
  return undefined;
}

function guessCategory(name: string, supplier: string): MaterialOrderCategory {
  const t = `${name} ${supplier}`;
  if (/襖|ふすま|引手|のぞみ|みやこ/i.test(t)) return "fusuma";
  if (/カーテン|ブラインド/i.test(t)) return "curtain";
  if (/クロス|壁紙|ビニル壁/i.test(t)) return "cloth";
  if (/畳|たたみ|ヘリ|縁/i.test(t)) return "tatami";
  if (/障子/i.test(t)) return "shoji";
  if (/網戸|アミ戸/i.test(t)) return "amido";
  return "reform";
}

function headerMeta(rows: string[][]): { title?: string; address?: string } {
  let title: string | undefined;
  let address: string | undefined;
  for (const row of rows.slice(0, 3)) {
    for (const cell of row) {
      const t = N(cell);
      const m = t.match(/工事名[:：]\s*(.*)$/);
      if (m && m[1].trim()) title = m[1].replace(/\s+/g, " ").trim();
      const a = t.match(/住所[:：]\s*(.*)$/);
      if (a && a[1].trim()) address = a[1].trim();
    }
  }
  return { title, address };
}

function isPhoneOrMeta(s: string): boolean {
  return /^(0\d{1,4}[-(]?\d|担当|紹介|電話|TEL)/i.test(s);
}

/** 見出し行の列位置 (単位がある / ない の両対応) */
function colMap(header: string[]): { supplier: number; name: number; qty: number; unit?: number; price: number; cost: number; ordered: number; needed: number; place: number; note: number } | null {
  const idx = (re: RegExp) => header.findIndex((h) => re.test(N(h)));
  const supplier = idx(/^業者/);
  const name = idx(/工事|材料/);
  const qty = idx(/^数量/);
  if (supplier < 0 || name < 0 || qty < 0) return null;
  const unit = idx(/^単位/);
  const price = idx(/^単価/);
  const cost = idx(/^原価/);
  const ordered = idx(/発注日/);
  const needed = idx(/施工|納品日/);
  const place = idx(/納品場所/);
  const note = idx(/^備考/);
  // 単位なし: 数量の次が単価
  if (unit < 0 && price < 0) {
    return { supplier, name, qty, price: qty + 1, cost: qty + 2, ordered: qty + 3, needed: qty + 4, place: qty + 5, note: qty + 6 };
  }
  if (unit < 0) {
    return { supplier, name, qty, price: price >= 0 ? price : qty + 1, cost: cost >= 0 ? cost : qty + 2, ordered: ordered >= 0 ? ordered : qty + 3, needed: needed >= 0 ? needed : qty + 4, place: place >= 0 ? place : qty + 5, note: note >= 0 ? note : qty + 6 };
  }
  return {
    supplier,
    name,
    qty,
    unit,
    price: price >= 0 ? price : unit + 1,
    cost: cost >= 0 ? cost : unit + 2,
    ordered: ordered >= 0 ? ordered : unit + 3,
    needed: needed >= 0 ? needed : unit + 4,
    place: place >= 0 ? place : unit + 5,
    note: note >= 0 ? note : unit + 6,
  };
}

function cell(row: string[], i: number): string {
  return N(row[i] ?? "");
}

/** 1 シートを読む (原本・記入例)。行がなければ null */
export function parseReformOrderSheet(sheetName: string, rows: string[][], opts?: { year?: number }): ParsedReformSheet | null {
  if (/原本\s*\(2\)/i.test(sheetName) && rows.every((r) => !r.some((c) => N(c)))) return null;
  const year = opts?.year ?? new Date().getFullYear();
  const meta = headerMeta(rows);
  let map: ReturnType<typeof colMap> = null;
  let start = 0;
  for (let i = 0; i < Math.min(rows.length, 6); i++) {
    const m = colMap(rows[i].map((c) => String(c ?? "")));
    if (m) {
      map = m;
      start = i + 1;
      break;
    }
  }
  if (!map) return null;
  const lines: ReformSheetLine[] = [];
  let lastSupplier = "";
  for (let i = start; i < rows.length; i++) {
    const row = rows[i];
    const name = cell(row, map.name);
    const supplierRaw = cell(row, map.supplier);
    if (/^小\s*計|^合計|^No\./i.test(name) || /^小\s*計|^合計/.test(supplierRaw)) break;
    if (/^小\s*計|^合計/.test(cell(row, map.cost)) || /^小\s*計/.test(cell(row, map.price))) break;
    // 電話番号・担当だけの行 (業者の続き) は材料名がないのでスキップ (業者は変えない)
    if (!name) {
      if (supplierRaw && !isPhoneOrMeta(supplierRaw)) lastSupplier = supplierRaw;
      continue;
    }
    if (/^(工事名|業者|住所)/.test(name)) continue;
    const supplier = supplierRaw && !isPhoneOrMeta(supplierRaw) ? supplierRaw : lastSupplier || undefined;
    if (supplierRaw && !isPhoneOrMeta(supplierRaw)) lastSupplier = supplierRaw;
    const qty = parseNum(row[map.qty]);
    const unit = map.unit !== undefined ? cell(row, map.unit) || undefined : undefined;
    const unitPrice = parseNum(row[map.price]);
    const cost = parseNum(row[map.cost]);
    const orderedOn = parseLooseDate(row[map.ordered], year);
    const neededBy = parseLooseDate(row[map.needed], year);
    const deliveryPlace = cell(row, map.place) || undefined;
    const noteParts = [cell(row, map.note), deliveryPlace ? `納品場所:${deliveryPlace}` : "", unitPrice !== undefined ? `単価${unitPrice}` : "", cost !== undefined ? `原価${cost}` : ""].filter(Boolean);
    // 材料名も数量も単価もなく、業者の見出しだけ (「KD材」など) はグループ見出し → 次の行の名前に残すためスキップしないが数量なしで登録
    if (!qty && !unitPrice && !cost && !orderedOn && !neededBy && !cell(row, map.note) && !deliveryPlace && !supplierRaw) continue;
    lines.push({
      supplierName: supplier,
      name: name.slice(0, 80),
      qty,
      unit: unit?.slice(0, 10),
      unitPrice,
      cost,
      orderedOn,
      neededBy,
      deliveryPlace,
      note: noteParts.join(" · ").slice(0, 300) || undefined,
      category: guessCategory(name, supplier ?? ""),
      status: orderedOn ? "ordered" : "unordered",
    });
  }
  // 空の原本も残す (取込のとき「原本を優先」の判定に使う。行がなければ pick が記入例へ)
  if (!lines.length && !meta.title && !/^原本/.test(N(sheetName))) return null;
  return { sheetName, title: meta.title, address: meta.address, lines };
}

/** ワークブック全体 (原本 + 記入例)。取込は通常「原本」か選んだシート */
export function parseReformOrderWorkbook(buf: Buffer, opts?: { year?: number; sheet?: string }): ParsedReformSheet[] {
  const out: ParsedReformSheet[] = [];
  for (const sh of readXlsx(buf)) {
    if (opts?.sheet && N(sh.name) !== N(opts.sheet)) continue;
    const parsed = parseReformOrderSheet(sh.name, xlsxRows(sh.rows), opts);
    if (parsed) out.push(parsed);
  }
  return out;
}

/** 取込用: 行のある「原本」を優先。空の原本しかないときは最初の行があるシート (記入例) */
export function pickReformImportSheet(sheets: ParsedReformSheet[]): ParsedReformSheet | undefined {
  const withLines = sheets.filter((s) => s.lines.length);
  return withLines.find((s) => /^原本/.test(N(s.sheetName)) && !/\(2\)/.test(s.sheetName)) ?? withLines[0];
}
