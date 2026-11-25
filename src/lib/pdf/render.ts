import "server-only";
import {
  C,
  CONTENT_W,
  LEFT,
  MARGIN,
  PAGE_W,
  RIGHT,
  Sheet,
  centerBaseline,
  fmtInt,
  fmtJpDate,
  fmtQty,
  fmtYen,
  type Watermark,
} from "./layout";
import type { InvoicePdfData, PdfBankAccount, PdfCompany, PdfLine, PurchaseOrderPdfData, QuotePdfData, ReceiptPdfData } from "./types";

/**
 * 帳票 PDF (御見積書・請求書・領収書)
 * ------------------------------------------------------------
 * Route Handler (Node ランタイム) から呼ぶ。ブラウザは使わず pdf-lib で A4 縦に描く。
 * - 1 ページ目: 表題 (中央)・番号と日付 (右上)・宛名と金額 (左)・会社と押印の余白 (右)
 * - 明細表: 入りきらなければ次のページへ続け、見出し行を繰り返す (ページ上部に「(続き)」)
 * - 合計・税率別内訳・お振込先・施工内容・備考は明細のあと (入らなければ次のページ)
 * - 2 ページ以上のときは下中央に「1 / 2」。下書きの見積・無効の請求書は斜めの透かし
 * 領収書は A4 縦の上半分に 1 枚
 */

const num = (v: number | undefined | null): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** 空の要素を除いて連結 */
const joinText = (parts: (string | false | null | undefined)[], sep: string): string =>
  parts
    .map((p) => (typeof p === "string" ? p.trim() : ""))
    .filter(Boolean)
    .join(sep);

const postal = (code?: string): string => {
  const v = code?.trim().replace(/^〒\s*/, "");
  return v ? `〒${v}` : "";
};

/** 金額の表記 (税込の大きな金額は末尾に「－」) */
const amountText = (n: number): string => (n < 0 ? fmtYen(n) : `${fmtYen(n)}－`);

// ---------------------------------------------------------------- 1 ページ目の上部

/** 表題 (字間を空けて中央・下に二重線)。tag は表題の右に小さく (訂正版・再発行) */
function titleBlock(s: Sheet, title: string, baseline: number, size: number, tag?: string): void {
  const cx = PAGE_W / 2;
  const tracking = size * (Array.from(title).length <= 3 ? 0.8 : 0.5);
  const w = s.spacedText(title, cx, baseline, size, tracking);
  const half = w / 2 + 10;
  s.hline(cx - half, cx + half, baseline + 8, { width: 1.3, color: C.ink });
  s.hline(cx - half, cx + half, baseline + 10.5, { width: 0.5, color: C.ink });
  if (tag) {
    const tagSize = 8.5;
    const tw = s.ts.width(s.ts.clean(tag), tagSize, "bold") + 10;
    const th = 15;
    const tx = cx + w / 2 + 12;
    const ttop = baseline - size * 0.38 - th / 2;
    s.rect(tx, ttop, tw, th, { stroke: C.accent, lineWidth: 0.9 });
    s.text(tag, tx + tw / 2, centerBaseline(ttop, th, tagSize), { size: tagSize, weight: "bold", color: C.accent, align: "center" });
  }
}

/** 番号・日付の欄 (右寄せ)。下端を返す */
function metaBlock(s: Sheet, rows: [string, string][], top: number, right: number, width: number): number {
  let t = top;
  const labelW = 50;
  for (const [label, value] of rows) {
    const bl = t + 10;
    if (label) s.text(label, right - width, bl, { size: 8, color: C.sub });
    const room = label ? width - labelW : width;
    s.text(value, right, bl, { size: 9, align: "right", maxWidth: room, shrinkTo: 7 });
    t += 14;
    s.hline(right - width, right, t - 1, { width: 0.4, color: C.ruleLight });
  }
  return t;
}

/** 宛名 (大きめの文字 + 右端に敬称 + 下線) と住所。下端を返す */
function customerBlock(s: Sheet, x: number, top: number, width: number, name: string, honorific: string, address?: string): number {
  const nameSize = 15;
  const honSize = 12;
  const hon = s.ts.clean(honorific) || "様";
  const honW = s.ts.width(hon, honSize);
  const lines = s.ts.wrap(name, nameSize, width - honW - 12, { weight: "bold", maxLines: 2 });
  let t = top;
  if (!lines.length) lines.push("");
  for (const line of lines) {
    t += nameSize + 3;
    s.text(line, x, t, { size: nameSize, weight: "bold" });
  }
  s.text(hon, x + width, t, { size: honSize, align: "right" });
  t += 6;
  s.hline(x, x + width, t, { width: 0.9, color: C.ink });
  for (const line of s.ts.wrap(address, 8.5, width, { maxLines: 2 })) {
    t += 12;
    s.text(line, x, t, { size: 8.5, color: C.sub });
  }
  return t;
}

/** 件名・現場・受注番号の行 (空の行は出さない)。下端を返す */
function infoRows(s: Sheet, x: number, top: number, width: number, rows: [string, string | undefined][]): number {
  const labelW = 50;
  const size = 9.5;
  let t = top;
  for (const [label, value] of rows) {
    const lines = s.ts.wrap(value, size, width - labelW - 2, { maxLines: 2 });
    if (!lines.length) continue;
    const bl = t + 14;
    s.text(label, x + 2, bl, { size: 8, color: C.sub });
    lines.forEach((line, i) => s.text(line, x + labelW, bl + i * 13, { size }));
    t = bl + (lines.length - 1) * 13 + 5;
    s.hline(x, x + width, t, { width: 0.4, color: C.ruleLight });
  }
  return t;
}

/** 御見積金額・ご請求金額の枠。下端を返す */
function amountBox(s: Sheet, x: number, top: number, width: number, label: string, amount: number): number {
  const h = 40;
  const labelW = 88;
  s.rect(x, top, labelW, h, { fill: C.ink });
  s.text(label, x + labelW / 2, centerBaseline(top, h, 10.5), { size: 10.5, weight: "bold", color: C.white, align: "center", maxWidth: labelW - 8 });
  const note = "(税込)";
  const noteSize = 8;
  const size = 19;
  const bl = centerBaseline(top, h, size);
  const noteRight = x + width - 10;
  const amountRight = noteRight - s.ts.width(note, noteSize) - 5;
  s.text(amountText(amount), amountRight, bl, { size, weight: "bold", align: "right", maxWidth: amountRight - x - labelW - 10, shrinkTo: 10 });
  s.text(note, noteRight, bl, { size: noteSize, color: C.sub, align: "right" });
  s.rect(x, top, width, h, { stroke: C.ink, lineWidth: 1 });
  return top + h;
}

interface AmountRow {
  label: string;
  value: string;
  strong?: boolean;
}

/** 金額の枠の下の行 (入金済み・差引ご請求額)。下端を返す */
function amountRows(s: Sheet, x: number, top: number, width: number, rows: AmountRow[]): number {
  let t = top;
  for (const r of rows) {
    const h = r.strong ? 23 : 18;
    const size = r.strong ? 12.5 : 9.5;
    s.text(r.label, x + 96, centerBaseline(t, h, 9), {
      size: r.strong ? 9.5 : 8.5,
      weight: r.strong ? "bold" : "regular",
      color: r.strong ? C.ink : C.sub,
    });
    s.text(r.value, x + width - 10, centerBaseline(t, h, size), {
      size,
      weight: r.strong ? "bold" : "regular",
      align: "right",
      maxWidth: width - 180,
      shrinkTo: 7,
    });
    t += h;
    s.hline(x + 88, x + width, t, { width: r.strong ? 0.8 : 0.4, color: r.strong ? C.ink : C.ruleLight });
  }
  return t;
}

/** 会社 (ロゴ・押印の余白・社名・住所・連絡先・登録番号・担当店舗・担当者)。下端を返す */
function companyBlock(
  s: Sheet,
  x: number,
  top: number,
  width: number,
  c: PdfCompany,
  o: { logoWidth: number; seal: number; staffName?: string },
): number {
  const logoH = s.logo(x, top, o.logoWidth);
  // 押印欄: 枠と「印」は描かず、押す場所 (ロゴの右・o.seal 四方) だけを空けておく (お客様のご要望 2026-11-24: 当面は印鑑なしで運用)
  let t = top + Math.max(logoH, o.seal - 2) + 4;
  t += 14;
  s.text(c.name, x, t, { size: 10.5, weight: "bold", maxWidth: width, shrinkTo: 8 });
  const small = 8;
  const lh = 11.6;
  const indent = 38;
  for (const line of s.ts.wrap(joinText([postal(c.postalCode), c.address], " "), small, width, { maxLines: 3 })) {
    t += lh;
    s.text(line, x, t, { size: small });
  }
  const tel = joinText([c.tel && `TEL ${c.tel}`, c.fax && `FAX ${c.fax}`], "　");
  if (tel) {
    t += lh;
    s.text(tel, x, t, { size: small, maxWidth: width });
  }
  for (const v of [c.email, c.website]) {
    if (!s.ts.clean(v)) continue;
    t += lh;
    s.text(v, x, t, { size: small, maxWidth: width });
  }
  const reg = s.ts.clean(c.registrationNumber);
  if (reg) {
    t += lh + 1;
    s.text("登録番号", x, t, { size: small, color: C.sub });
    s.text(reg, x + indent, t, { size: 8.5, maxWidth: width - indent });
  }
  const store = c.store;
  if (store && s.ts.clean(store.name)) {
    t += 6;
    s.hline(x, x + width, t, { width: 0.4, color: C.ruleLight });
    t += lh + 1;
    s.text("担当店舗", x, t, { size: small, color: C.sub });
    s.text(store.name, x + indent, t, { size: 8.5, weight: "bold", maxWidth: width - indent });
    for (const line of s.ts.wrap(joinText([postal(store.postalCode), store.address], " "), small, width - indent, { maxLines: 2 })) {
      t += lh;
      s.text(line, x + indent, t, { size: small });
    }
    if (s.ts.clean(store.phone)) {
      t += lh;
      s.text(`TEL ${store.phone}`, x + indent, t, { size: small, maxWidth: width - indent });
    }
  }
  if (s.ts.clean(o.staffName)) {
    t += lh + 2;
    s.text("担当者", x, t, { size: small, color: C.sub });
    s.text(o.staffName, x + indent, t, { size: 9, maxWidth: width - indent });
  }
  return t + 4;
}

interface FirstPageSpec {
  title: string;
  tag?: string;
  meta: [string, string][];
  customerName: string;
  honorific: string;
  customerAddress?: string;
  lead: string;
  info: [string, string | undefined][];
  amountLabel: string;
  amount: number;
  amountRows?: AmountRow[];
  company: PdfCompany;
  staffName?: string;
}

/** 見積書・請求書の 1 ページ目の上部。下端を返す */
function firstPage(s: Sheet, h: FirstPageSpec): number {
  titleBlock(s, h.title, MARGIN + 30, 22, h.tag);
  metaBlock(s, h.meta, MARGIN, RIGHT, 150);
  const top = MARGIN + 64;
  const leftW = 284;
  let lt = customerBlock(s, LEFT, top, leftW, h.customerName, h.honorific, h.customerAddress);
  lt += 20;
  s.text(h.lead, LEFT, lt, { size: 9.5 });
  lt = infoRows(s, LEFT, lt + 2, leftW, h.info);
  lt = amountBox(s, LEFT, lt + 12, leftW, h.amountLabel, h.amount);
  if (h.amountRows?.length) lt = amountRows(s, LEFT, lt, leftW, h.amountRows);
  const rightW = 205;
  const rt = companyBlock(s, RIGHT - rightW, top, rightW, h.company, { logoWidth: 150, seal: 40, staffName: h.staffName });
  return Math.max(lt, rt);
}

/** 2 ページ目以降の上部。本文の開始位置を返す */
function continuationHeader(s: Sheet, title: string, number: string, customer: string): number {
  const top = MARGIN;
  s.text(`${title} (続き)`, LEFT, top + 14, { size: 12, weight: "bold" });
  s.text(number, RIGHT, top + 8, { size: 8.5, color: C.sub, align: "right", maxWidth: 280 });
  s.text(customer, RIGHT, top + 20, { size: 8.5, align: "right", maxWidth: 280 });
  s.hline(LEFT, RIGHT, top + 27, { width: 0.8, color: C.ink });
  return top + 38;
}

// ---------------------------------------------------------------- 明細表

interface Column {
  label: string;
  width: number;
  align: "left" | "right" | "center";
}

const COLUMNS: Column[] = [
  { label: "品名", width: CONTENT_W - 346, align: "left" },
  { label: "仕様", width: 120, align: "left" },
  { label: "数量", width: 48, align: "right" },
  { label: "単位", width: 34, align: "center" },
  { label: "単価", width: 66, align: "right" },
  { label: "金額", width: 78, align: "right" },
];
const BODY_SIZE = 8.8;
const LINE_H = 11.8;
const PAD_X = 4.5;
const PAD_Y = 4.2;
const HEAD_H = 19;
/** 1 つの欄の行数の上限 (これを超える分は「…」。1 行がページに入りきらないことを防ぐ) */
const MAX_CELL_LINES = 12;

interface RowLayout {
  cells: string[][];
  height: number;
}

function layoutRow(s: Sheet, item: PdfLine): RowLayout {
  const wrapCell = (v: unknown, col: number) => s.ts.wrap(v, BODY_SIZE, COLUMNS[col].width - PAD_X * 2, { maxLines: MAX_CELL_LINES });
  const name = wrapCell(item.name, 0);
  const spec = wrapCell(item.spec, 1);
  const lines = Math.max(1, name.length, spec.length);
  return {
    cells: [name, spec, [fmtQty(item.qty)], [s.ts.clean(item.unit)], [fmtInt(item.unitPrice)], [fmtInt(item.amount)]],
    height: lines * LINE_H + PAD_Y * 2,
  };
}

function drawTableHead(s: Sheet, top: number, taxIncluded = false): void {
  s.rect(LEFT, top, CONTENT_W, HEAD_H, { fill: C.fill });
  let x = LEFT;
  for (const col of COLUMNS) {
    s.text(taxIncluded && (col.label === "単価" || col.label === "金額") ? `${col.label}(税込)` : col.label, x + col.width / 2, centerBaseline(top, HEAD_H, 8.5), { size: 8.5, weight: "bold", align: "center" });
    x += col.width;
  }
}

function drawTableRow(s: Sheet, row: RowLayout, index: number): void {
  const top = s.y;
  if (index % 2 === 1) s.rect(LEFT, top, CONTENT_W, row.height, { fill: C.zebra });
  let x = LEFT;
  COLUMNS.forEach((col, ci) => {
    const inner = col.width - PAD_X * 2;
    const ax = col.align === "right" ? x + col.width - PAD_X : col.align === "center" ? x + col.width / 2 : x + PAD_X;
    row.cells[ci].forEach((line, li) => {
      const bl = top + PAD_Y + li * LINE_H + LINE_H / 2 + BODY_SIZE * 0.36;
      // 数値・単位は縮めて収める (末尾を切ると金額を読み違えるため)
      s.text(line, ax, bl, { size: BODY_SIZE, align: col.align, maxWidth: inner, shrinkTo: ci >= 2 ? 5.5 : undefined });
    });
    x += col.width;
  });
  s.hline(LEFT, RIGHT, top + row.height, { width: 0.35, color: C.ruleLight });
}

/** 縦の区切り・見出しの下線・外枠 (ページごとの表の範囲) */
function drawTableGrid(s: Sheet, top: number, bottom: number): void {
  let x = LEFT;
  for (const col of COLUMNS.slice(0, -1)) {
    x += col.width;
    s.line(x, top, x, bottom, { width: 0.4, color: C.ruleLight });
  }
  s.hline(LEFT, RIGHT, top + HEAD_H, { width: 0.8, color: C.ink });
  s.rect(LEFT, top, CONTENT_W, bottom - top, { stroke: C.ink, lineWidth: 0.8 });
}

function itemsTable(s: Sheet, items: PdfLine[], taxIncluded = false): void {
  const rows: RowLayout[] = items.length
    ? items.map((item) => layoutRow(s, item))
    : [{ cells: [["明細はありません"], [], [], [], [], []], height: LINE_H + PAD_Y * 2 }];
  let segmentTop = s.y;
  const open = (firstRowHeight: number) => {
    if (!s.fits(HEAD_H + firstRowHeight)) s.addPage();
    segmentTop = s.y;
    drawTableHead(s, segmentTop, taxIncluded);
    s.y += HEAD_H;
  };
  open(rows[0].height);
  rows.forEach((row, i) => {
    if (!s.fits(row.height)) {
      drawTableGrid(s, segmentTop, s.y);
      s.addPage();
      open(row.height);
    }
    drawTableRow(s, row, i);
    s.y += row.height;
  });
  drawTableGrid(s, segmentTop, s.y);
}

// ---------------------------------------------------------------- 合計・内訳・振込先・文章

interface Sums {
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  /** 単価・小計が税込 (消費税は内税として表示) */
  taxIncluded?: boolean;
  /** 非課税 (消費税 0。「非課税」と表示) */
  taxExempt?: boolean;
}

const TOTALS_W = 236;
const TOTAL_ROW_H = 18;
const GRAND_H = 24;
const BREAKDOWN_GAP = 8;
const BREAKDOWN_HEAD_H = 15;
const BREAKDOWN_ROW_H = 18;
const SECTION_HEAD_H = 18;

function totalsHeight(sums: Sums, breakdown: boolean): number {
  const rows = sums.discount > 0 ? 3 : 2;
  return rows * TOTAL_ROW_H + GRAND_H + (breakdown ? BREAKDOWN_GAP + BREAKDOWN_HEAD_H + BREAKDOWN_ROW_H : 0);
}

/** 小計・値引き・消費税・合計 (請求書は税率別内訳も)。下端を返す */
function drawTotals(s: Sheet, x: number, top: number, width: number, sums: Sums, breakdown: boolean): number {
  const labelW = 104;
  const rows: [string, string][] = [[sums.taxIncluded && !sums.taxExempt ? "小計 (税込)" : "小計", fmtYen(sums.subtotal)]];
  if (sums.discount > 0) rows.push(["値引き", fmtYen(-sums.discount)]);
  rows.push(sums.taxExempt ? ["消費税", "非課税"] : [sums.taxIncluded ? "うち消費税 (10%)" : "消費税 (10%)", fmtYen(sums.tax)]);
  let t = top;
  for (const [label, value] of rows) {
    s.rect(x, t, labelW, TOTAL_ROW_H, { fill: C.fill });
    s.text(label, x + 8, centerBaseline(t, TOTAL_ROW_H, 8.5), { size: 8.5 });
    s.text(value, x + width - 8, centerBaseline(t, TOTAL_ROW_H, 9.5), { size: 9.5, align: "right", maxWidth: width - labelW - 14, shrinkTo: 6 });
    t += TOTAL_ROW_H;
    s.hline(x, x + width, t, { width: 0.4, color: C.ruleLight });
  }
  s.rect(x, t, labelW, GRAND_H, { fill: C.ink });
  s.text(sums.taxExempt ? "合計 (非課税)" : sums.taxIncluded ? "合計 (税込)" : "合計", x + 8, centerBaseline(t, GRAND_H, 10), { size: 10, weight: "bold", color: C.white });
  s.text(fmtYen(sums.total), x + width - 8, centerBaseline(t, GRAND_H, 12.5), {
    size: 12.5,
    weight: "bold",
    align: "right",
    maxWidth: width - labelW - 14,
    shrinkTo: 7,
  });
  s.hline(x, x + width, t, { width: 0.8, color: C.ink });
  s.rect(x, top, width, t + GRAND_H - top, { stroke: C.ink, lineWidth: 0.8 });
  t += GRAND_H;
  if (breakdown) t = sums.taxExempt ? drawTaxBreakdown(s, x, t + BREAKDOWN_GAP, width, sums.total, 0, "非課税") : drawTaxBreakdown(s, x, t + BREAKDOWN_GAP, width, sums.taxIncluded ? sums.total - sums.tax : sums.subtotal - sums.discount, sums.tax);
  return t;
}

/** 適格請求書の税率別内訳: 10% 対象の金額 (税抜) と消費税額。下端を返す */
function drawTaxBreakdown(s: Sheet, x: number, top: number, width: number, taxable: number, tax: number, kind: "10%対象" | "非課税" = "10%対象"): number {
  const first = 62;
  const widths = [first, (width - first) * 0.55, (width - first) * 0.45];
  const heads = ["税率区分", kind === "非課税" ? "対象金額" : "対象金額 (税抜)", "消費税額"];
  const values = [kind, fmtYen(taxable), kind === "非課税" ? "-" : fmtYen(tax)];
  const rowTop = top + BREAKDOWN_HEAD_H;
  s.rect(x, top, width, BREAKDOWN_HEAD_H, { fill: C.fill });
  let cx = x;
  widths.forEach((w, i) => {
    s.text(heads[i], cx + w / 2, centerBaseline(top, BREAKDOWN_HEAD_H, 7.5), { size: 7.5, color: C.sub, align: "center" });
    if (i === 0) s.text(values[i], cx + w / 2, centerBaseline(rowTop, BREAKDOWN_ROW_H, 8.5), { size: 8.5, align: "center" });
    else s.text(values[i], cx + w - 8, centerBaseline(rowTop, BREAKDOWN_ROW_H, 9), { size: 9, align: "right", maxWidth: w - 12, shrinkTo: 6 });
    if (i > 0) s.line(cx, top, cx, rowTop + BREAKDOWN_ROW_H, { width: 0.4, color: C.ruleLight });
    cx += w;
  });
  s.hline(x, x + width, rowTop, { width: 0.4, color: C.ruleLight });
  s.rect(x, top, width, BREAKDOWN_HEAD_H + BREAKDOWN_ROW_H, { stroke: C.rule, lineWidth: 0.6 });
  return rowTop + BREAKDOWN_ROW_H;
}

/** 小見出し (左に赤の短い縦線・下に罫線)。下端を返す */
function sectionHeading(s: Sheet, x: number, top: number, width: number, label: string): number {
  s.rect(x, top + 3, 2.6, 11, { fill: C.accent });
  s.text(label, x + 8, top + 12.6, { size: 9.5, weight: "bold" });
  s.hline(x, x + width, top + SECTION_HEAD_H, { width: 0.5, color: C.rule });
  return top + SECTION_HEAD_H;
}

const bankHeight = (accounts: PdfBankAccount[]): number => SECTION_HEAD_H + (accounts.length ? accounts.reduce((a, b) => a + (b.holderKana ? 42 : 30), 0) + 4 : 20);

/** お振込先 (口座ごとに 2 行)。下端を返す */
function drawBankAccounts(s: Sheet, x: number, top: number, width: number, accounts: PdfBankAccount[]): number {
  let t = sectionHeading(s, x, top, width, "お振込先");
  if (!accounts.length) {
    t += 15;
    s.text("お振込先は別途ご案内いたします。", x + 4, t, { size: 9, maxWidth: width - 8 });
    return t + 5;
  }
  for (const a of accounts) {
    t += 14;
    s.text(joinText([a.bank, a.branch], "　"), x + 4, t, { size: 9, weight: "bold", maxWidth: width - 8 });
    t += 13;
    s.text(joinText([a.type, a.number, a.holder && `口座名義 ${a.holder}`], "　"), x + 4, t, { size: 8.5, maxWidth: width - 8 });
    if (a.holderKana) {
      t += 12;
      s.text(`口座名義 (カナ) ${a.holderKana}`, x + 4, t, { size: 8.5, maxWidth: width - 8 });
    }
    t += 3;
  }
  return t + 4;
}

/** 施工内容・備考などの文章 (改行を残して折り返す。ページをまたぐときは見出しに「(続き)」) */
function textSection(s: Sheet, label: string, body: string | undefined): void {
  const size = 9;
  const lineH = 13.5;
  const indent = 6;
  const lines = s.ts.wrap(body, size, CONTENT_W - indent * 2, { multiline: true, maxLines: 500 });
  if (!lines.length) return;
  s.y += 14;
  // 見出しだけがページの下に残らないよう、最初の数行と一緒に置く
  s.ensure(SECTION_HEAD_H + 4 + lineH * Math.min(lines.length, 3));
  s.y = sectionHeading(s, LEFT, s.y, CONTENT_W, label) + 4;
  for (const line of lines) {
    if (!s.fits(lineH)) {
      s.addPage();
      s.y = sectionHeading(s, LEFT, s.y, CONTENT_W, `${label} (続き)`) + 4;
    }
    if (line) s.text(line, LEFT + indent, centerBaseline(s.y, lineH, size), { size });
    s.y += lineH;
  }
}

const DRAFT_MARK: Watermark = { text: "下書き (承認前)", size: 66, color: C.watermarkGrey, opacity: 0.14 };
const VOID_MARK: Watermark = { text: "無効", size: 190, color: C.watermarkRed, opacity: 0.18 };

// ---------------------------------------------------------------- 御見積書

export async function renderQuotePdf(data: QuotePdfData): Promise<Uint8Array> {
  const version = Math.max(1, Math.floor(num(data.version)) || 1);
  const s = await Sheet.create({
    title: `御見積書 ${data.number}${version > 1 ? ` 第${version}版` : ""}`,
    subject: "御見積書",
    author: data.company.name,
  });
  s.onNewPage = () => continuationHeader(s, "御見積書", `見積番号 ${data.number}`, `${data.customerName} ${data.honorific}`);
  s.addPage();

  const meta: [string, string][] = [["見積番号", data.number]];
  if (version > 1) meta.push(["", data.revisionLabel?.trim() || `第${version}版`]);
  meta.push(["発行日", fmtJpDate(data.issuedOn)]);
  if (data.validUntil) meta.push(["有効期限", fmtJpDate(data.validUntil)]);

  s.y =
    firstPage(s, {
      title: "御見積書",
      meta,
      customerName: data.customerName,
      honorific: data.honorific,
      customerAddress: data.customerAddress,
      lead: "下記のとおりお見積り申し上げます。",
      info: [
        ["件名", data.title],
        ["現場", data.siteAddress],
      ],
      amountLabel: "御見積金額",
      amount: num(data.total),
      company: data.company,
      staffName: data.staffName,
    }) + 18;

  itemsTable(s, data.items ?? [], Boolean(data.taxIncluded) && !data.taxExempt);

  const sums: Sums = { subtotal: num(data.subtotal), discount: num(data.discount), tax: num(data.tax), total: num(data.total), taxIncluded: Boolean(data.taxIncluded), taxExempt: Boolean(data.taxExempt) };
  s.y += 12;
  s.ensure(totalsHeight(sums, false));
  s.y = drawTotals(s, RIGHT - TOTALS_W, s.y, TOTALS_W, sums, false);

  textSection(s, "施工内容", data.workDetails);
  textSection(s, "備考", data.notes);
  return s.finish(data.draft ? DRAFT_MARK : undefined);
}

// ---------------------------------------------------------------- 請求書

export async function renderInvoicePdf(data: InvoicePdfData): Promise<Uint8Array> {
  // 納品書: 請求書と同じ書式・内容で、表題・番号の見出し・冒頭の文・金額の見出しだけを変える (お客様のご要望 2026-11-25)
  const docTitle = data.delivery ? "納品書" : "請求書";
  const numberLabel = data.delivery ? "納品番号" : "請求番号";
  const s = await Sheet.create({
    title: `${docTitle} ${data.number}${data.corrected ? " (訂正版)" : ""}`,
    subject: docTitle,
    author: data.company.name,
  });
  s.onNewPage = () => continuationHeader(s, docTitle, `${numberLabel} ${data.number}`, `${data.customerName} ${data.honorific}`);
  s.addPage();

  const meta: [string, string][] = [
    [numberLabel, data.number],
    ["発行日", fmtJpDate(data.issuedOn)],
  ];
  if (data.dueDate) meta.push(["お支払期限", fmtJpDate(data.dueDate)]);
  if (data.transactionDate) meta.push(["取引年月日", fmtJpDate(data.transactionDate)]);
  if (data.transactionPeriod) {
    // まとめ請求: 締め日と締めの期間 (案件ごとの施工完了日は明細に)
    const md = (d: string) => `${Number(d.slice(5, 7))}月${Number(d.slice(8, 10))}日`;
    meta.push(["締め日", fmtJpDate(data.transactionPeriod.to)]);
    if (data.transactionPeriod.from) meta.push(["取引期間", `${md(data.transactionPeriod.from)}〜${md(data.transactionPeriod.to)}`]);
  }

  const total = num(data.total);
  // 入金済み・差引ご請求額は載せない (お客様にまぎらわしいため。入金の状況はシステムの中で管理する。お客様のご要望 2026-11-25「①」)

  s.y =
    firstPage(s, {
      title: docTitle,
      tag: data.corrected ? "訂正版" : undefined,
      meta,
      customerName: data.customerName,
      honorific: data.honorific,
      customerAddress: data.customerAddress,
      lead: data.delivery ? "下記のとおり納品いたしました。" : "下記のとおりご請求申し上げます。",
      info: [
        ["件名", data.title],
        ["現場", data.siteAddress],
        ["受注番号", data.orderNumber],
      ],
      amountLabel: data.delivery ? "合計金額" : "ご請求金額",
      amount: total,
      company: data.company,
    }) + 18;

  itemsTable(s, data.items ?? [], Boolean(data.taxIncluded) && !data.taxExempt);

  // 合計・税率別内訳 (右) とお振込先 (左) を並べる
  const sums: Sums = { subtotal: num(data.subtotal), discount: num(data.discount), tax: num(data.tax), total, taxIncluded: Boolean(data.taxIncluded), taxExempt: Boolean(data.taxExempt) };
  const banks = (data.company.bankAccounts ?? []).filter((b) => b && (s.ts.clean(b.bank) || s.ts.clean(b.number)));
  const height = Math.max(bankHeight(banks), totalsHeight(sums, true));
  s.y += 12;
  s.ensure(height);
  drawBankAccounts(s, LEFT, s.y, CONTENT_W - TOTALS_W - 24, banks);
  drawTotals(s, RIGHT - TOTALS_W, s.y, TOTALS_W, sums, true);
  s.y += height;

  textSection(s, "備考", data.notes);
  return s.finish(data.voided ? VOID_MARK : undefined);
}

// ---------------------------------------------------------------- 領収書

/** 金額の枠 (領収書)。下端を返す */
function receiptAmountBox(s: Sheet, x: number, top: number, width: number, amount: number): number {
  const h = 50;
  const labelW = 64;
  s.rect(x, top, width, h, { fill: C.zebra });
  s.rect(x, top, labelW, h, { fill: C.ink });
  s.text("金額", x + labelW / 2, centerBaseline(top, h, 12), { size: 12, weight: "bold", color: C.white, align: "center" });
  const size = 26;
  const bl = centerBaseline(top, h, size);
  const noteRight = x + width - 12;
  const note = "(税込)";
  const room = width - labelW - 2 * (s.ts.width(note, 8.5) + 22);
  s.text(amountText(amount), x + labelW + (width - labelW) / 2, bl, { size, weight: "bold", align: "center", maxWidth: room, shrinkTo: 12 });
  s.text(note, noteRight, bl, { size: 8.5, color: C.sub, align: "right" });
  s.rect(x, top, width, h, { stroke: C.ink, lineWidth: 1.1 });
  return top + h;
}

/** 内訳 (税抜金額・消費税額) と支払方法・請求書番号。下端を返す */
function receiptDetails(s: Sheet, x: number, top: number, width: number, data: ReceiptPdfData): number {
  let t = sectionHeading(s, x, top, width, "内訳");
  const rows: [string, string][] = [
    ...((data.taxExempt
      ? [
          ["非課税", fmtYen(num(data.taxable))],
          ["消費税額", "-"],
        ]
      : [
          ["税抜金額", fmtYen(num(data.taxable))],
          ["消費税額 (10%)", fmtYen(num(data.tax))],
        ]) as [string, string][]),
  ];
  for (const [label, value] of rows) {
    t += 16;
    s.text(label, x + 4, t, { size: 8.5, color: C.sub });
    s.text(value, x + width - 4, t, { size: 9.5, align: "right", maxWidth: width - 90, shrinkTo: 6 });
    t += 5;
    s.hline(x, x + width, t, { width: 0.4, color: C.ruleLight });
  }
  // 支払方法ごとの内訳 (2 つ以上、または 1 つでも金額つき)。1 つだけのときは「お支払方法」の行
  const parts = data.parts ?? [];
  if (parts.length > 1) {
    t += 16;
    s.text("お支払の内訳", x + 4, t, { size: 8.5, weight: "bold", color: C.sub });
    for (const p of parts) {
      t += 14;
      s.text(p.label, x + 10, t, { size: 8.5, color: C.sub, maxWidth: 90 });
      s.text(fmtYen(p.amount), x + width - 4, t, { size: 9, align: "right", maxWidth: width - 100, shrinkTo: 6 });
    }
    t += 5;
    s.hline(x, x + width, t, { width: 0.4, color: C.ruleLight });
  }
  const extra: [string, string | undefined][] = [
    ["お支払方法", parts.length > 1 ? undefined : (parts[0]?.label ?? data.paymentMethod)],
    ["請求書番号", data.invoiceNumber],
  ];
  for (const [label, value] of extra) {
    if (!s.ts.clean(value)) continue;
    t += 16;
    s.text(label, x + 4, t, { size: 8.5, color: C.sub });
    s.text(value, x + 60, t, { size: 9, maxWidth: width - 64 });
  }
  return t + 4;
}

/** 収入印紙の貼付欄 (点線の枠) */
function stampBox(s: Sheet, x: number, top: number, width: number, height: number): void {
  s.rect(x, top, width, height, { stroke: C.faint, lineWidth: 0.7, dash: [3, 2] });
  s.text("収入印紙", x + width / 2, centerBaseline(top, height, 8), { size: 8, color: C.faint, align: "center" });
}

export async function renderReceiptPdf(data: ReceiptPdfData): Promise<Uint8Array> {
  const s = await Sheet.create({
    title: `領収書 ${data.number}${data.reissue ? ` (再発行${data.reissueNo ? ` ${data.reissueNo} 回目` : ""})` : ""}`,
    subject: "領収書",
    author: data.company.name,
  });
  s.addPage();

  const top = MARGIN;
  const pad = 24;
  const inL = LEFT + pad;
  const inR = RIGHT - pad;

  titleBlock(s, "領収書", top + 52, 26, data.reissue ? (data.reissueNo ? `再発行 ${data.reissueNo}` : "再発行") : undefined);

  // 宛名 (左) / 番号・発行日 (右)
  const rowTop = top + 84;
  let t = customerBlock(s, inL, rowTop, 290, data.customerName, data.honorific);
  metaBlock(
    s,
    [
      ["No.", data.number],
      ["発行日", fmtJpDate(data.issuedOn)],
    ],
    rowTop + 2,
    inR,
    150,
  );

  // 金額・但し書き
  const boxX = inL + 30;
  const boxW = inR - inL - 60;
  t = receiptAmountBox(s, boxX, t + 18, boxW, num(data.amount));
  t += 26;
  s.text("但し", boxX, t, { size: 10, color: C.sub });
  s.text(data.purpose, boxX + 28, t, { size: 11, maxWidth: boxW - 28 });
  s.hline(boxX, boxX + boxW, t + 6, { width: 0.6, color: C.rule });
  t += 24;
  s.text("上記正に領収いたしました。", boxX, t, { size: 10 });

  // 内訳 (左)・収入印紙・会社 (右)
  const low = t + 20;
  const detailW = 196;
  const companyW = 180;
  const companyX = inR - companyW;
  const leftBottom = receiptDetails(s, inL, low, detailW, data);
  const rightBottom = companyBlock(s, companyX, low + 2, companyW, data.company, { logoWidth: 118, seal: 36 });
  let stampBottom = low;
  if (num(data.taxable) >= 50000) {
    const sw = 62;
    const sh = 74;
    stampBox(s, inL + detailW + (companyX - inL - detailW - sw) / 2, low + 2, sw, sh);
    stampBottom = low + 2 + sh;
  }

  // 枠 (二重線)
  const bottom = Math.max(leftBottom, rightBottom, stampBottom) + 18;
  s.rect(LEFT, top, CONTENT_W, bottom - top, { stroke: C.ink, lineWidth: 1.2 });
  s.rect(LEFT + 3.5, top + 3.5, CONTENT_W - 7, bottom - top - 7, { stroke: C.ink, lineWidth: 0.4 });
  return s.finish();
}

// ---------------------------------------------------------------- 発注書

interface GridColumn {
  label: string;
  width: number;
  align: "left" | "right" | "center";
  /** 数値・日付など、縮めて 1 行に収める欄 */
  fit?: boolean;
}

/**
 * 罫線つきの表 (見出しの行をページごとに繰り返す)。cells は列ごとの文字。
 * plain: 背景の色を使わない (FAX は白黒 2 値のため、灰色の塗りは網点になって読みにくい)。minRowH: 行の高さの最小 (手書きの追記の余白)
 */
function gridTable(s: Sheet, columns: GridColumn[], rows: string[][], empty: string, opts: { plain?: boolean; minRowH?: number } = {}): void {
  const layouts = (rows.length ? rows : [[empty]]).map((cells) => {
    const wrapped = columns.map((col, ci) => (col.fit ? [s.ts.clean(cells[ci] ?? "")] : s.ts.wrap(cells[ci] ?? "", BODY_SIZE, col.width - PAD_X * 2, { multiline: true, maxLines: MAX_CELL_LINES })));
    const lines = Math.max(1, ...wrapped.map((w) => w.length));
    return { wrapped, height: Math.max(opts.minRowH ?? 0, lines * LINE_H + PAD_Y * 2) };
  });
  const head = (top: number) => {
    if (!opts.plain) s.rect(LEFT, top, CONTENT_W, HEAD_H, { fill: C.fill });
    let x = LEFT;
    for (const col of columns) {
      s.text(col.label, x + col.width / 2, centerBaseline(top, HEAD_H, 8.2), { size: 8.2, weight: "bold", align: "center", maxWidth: col.width - 4, shrinkTo: 6 });
      x += col.width;
    }
  };
  const grid = (top: number, bottom: number) => {
    let x = LEFT;
    for (const col of columns.slice(0, -1)) {
      x += col.width;
      s.line(x, top, x, bottom, { width: opts.plain ? 0.5 : 0.4, color: opts.plain ? C.ink : C.ruleLight });
    }
    s.hline(LEFT, RIGHT, top + HEAD_H, { width: 0.8, color: C.ink });
    s.rect(LEFT, top, CONTENT_W, bottom - top, { stroke: C.ink, lineWidth: 0.8 });
  };
  let segmentTop = s.y;
  const open = (h: number) => {
    if (!s.fits(HEAD_H + h)) s.addPage();
    segmentTop = s.y;
    head(segmentTop);
    s.y += HEAD_H;
  };
  open(layouts[0].height);
  layouts.forEach((row, i) => {
    if (!s.fits(row.height)) {
      grid(segmentTop, s.y);
      s.addPage();
      open(row.height);
    }
    const top = s.y;
    if (!opts.plain && i % 2 === 1) s.rect(LEFT, top, CONTENT_W, row.height, { fill: C.zebra });
    let x = LEFT;
    const pad = opts.minRowH ? Math.max(PAD_Y, (row.height - row.wrapped.reduce((m, w) => Math.max(m, w.length), 1) * LINE_H) / 2) : PAD_Y;
    columns.forEach((col, ci) => {
      const inner = col.width - PAD_X * 2;
      const ax = col.align === "right" ? x + col.width - PAD_X : col.align === "center" ? x + col.width / 2 : x + PAD_X;
      row.wrapped[ci].forEach((line, li) => {
        const bl = top + pad + li * LINE_H + LINE_H / 2 + BODY_SIZE * 0.36;
        s.text(line, ax, bl, { size: BODY_SIZE, align: col.align, maxWidth: inner, shrinkTo: col.fit ? 5.5 : undefined });
      });
      x += col.width;
    });
    s.hline(LEFT, RIGHT, top + row.height, { width: opts.plain ? 0.5 : 0.35, color: opts.plain ? C.ink : C.ruleLight });
    s.y += row.height;
  });
  grid(segmentTop, s.y);
}

const PO_DRAFT_MARK: Watermark = { text: "下書き", size: 120, color: C.watermarkGrey, opacity: 0.14 };
const PO_CANCEL_MARK: Watermark = { text: "取消", size: 190, color: C.watermarkRed, opacity: 0.18 };
/** 手書きの発注書と同じ 10 行 (明細が多いときは行を足して次のページへ続ける) */
const PO_MIN_ROWS = 10;
const WEEKDAY = ["日", "月", "火", "水", "木", "金", "土"];

/** "2026-11-19" → "令和8年11月19日" (令和より前・形が違うときは西暦の表記) */
function fmtWareki(s?: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s ?? "");
  if (!m) return fmtJpDate(s);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (`${m[1]}-${m[2]}-${m[3]}` < "2019-05-01") return fmtJpDate(s);
  const n = y - 2018;
  return `令和${n === 1 ? "元" : n}年${mo}月${d}日`;
}

/** 着日: "2026-12-05" → "12/5(土)" */
function fmtArrival(s?: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s ?? "");
  if (!m) return "";
  const w = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
  return `${Number(m[2])}/${Number(m[3])}(${WEEKDAY[w]})`;
}

/** 受注確認欄 (仕入先が記入して FAX で返信する。発注番号を載せ、返信 FAX の照合に使う)。下端を返す */
function poReplyBox(s: Sheet, data: PurchaseOrderPdfData): void {
  const h = 58;
  s.y += 14;
  s.ensure(h + 4);
  const top = s.y;
  const head = 18;
  s.rect(LEFT, top, CONTENT_W, h, { stroke: C.ink, lineWidth: 0.8 });
  s.hline(LEFT, RIGHT, top + head, { width: 0.5, color: C.ink });
  s.text(joinText([`受注確認 (ご記入のうえ、この用紙を FAX でご返信ください${data.replyFax ? `　返信先 FAX ${data.replyFax}` : ""})`, `発注番号 ${data.number}`], "　　"), LEFT + 8, centerBaseline(top, head, 8.4), { size: 8.4, weight: "bold", maxWidth: CONTENT_W - 16, shrinkTo: 6.5 });
  const rowH = (h - head) / 2;
  s.text("□ お受けします　　□ 一部お受けします　　□ お受けできません", LEFT + 10, centerBaseline(top + head, rowH, 9), { size: 9, maxWidth: CONTENT_W / 2 + 40 });
  s.text("納品予定日　　　月　　　日", RIGHT - 10, centerBaseline(top + head, rowH, 9), { size: 9, align: "right" });
  s.hline(LEFT, RIGHT, top + head + rowH, { width: 0.5, color: C.ink });
  s.text("貴社名・ご担当", LEFT + 10, centerBaseline(top + head + rowH, rowH, 8.4), { size: 8.4, color: C.sub });
  s.text("※ 発注番号は消さずにご返信ください", RIGHT - 10, centerBaseline(top + head + rowH, rowH, 7.6), { size: 7.6, color: C.sub, align: "right" });
  s.y = top + h;
}

export async function renderPurchaseOrderPdf(data: PurchaseOrderPdfData): Promise<Uint8Array> {
  const version = Math.max(1, Math.floor(num(data.version)) || 1);
  const s = await Sheet.create({ title: `発注書 ${data.number}${version > 1 ? ` 第${version}版` : ""}`, subject: "発注書", author: data.companyName });
  s.onNewPage = () => continuationHeader(s, "発注書", `発注番号 ${data.number}`, `${data.supplierName} 御中`);
  s.addPage();

  // 上: 表題 (中央)・発注番号と発注日 (右上)
  titleBlock(s, "発注書", MARGIN + 24, 18, version > 1 ? "訂正版" : undefined);
  const meta: [string, string][] = [["発注番号", data.number]];
  if (version > 1) meta.push(["", data.revisionLabel?.trim() || `第${version}版 (訂正)`]);
  meta.push(["発注日", fmtWareki(data.issuedOn)]);
  metaBlock(s, meta, MARGIN, RIGHT, 148);

  // 左: 発注元の店舗 (大きく)・仕入先 御中 / 右: 会社・店舗・担当・連絡先 (手書きの発注書と同じ並び)
  const top = MARGIN + 62;
  const leftW = 280;
  s.text(data.storeName, LEFT, top + 22, { size: 22, weight: "bold", maxWidth: leftW, shrinkTo: 14 });
  let lt = customerBlock(s, LEFT, top + 34, leftW, data.supplierName, "御中", joinText([data.supplierFax && `FAX ${data.supplierFax}`, data.supplierContact && `ご担当 ${data.supplierContact} 様`], "　"));
  const rx = RIGHT - 210;
  let rt = top + 4;
  const line = (text: string, size: number, weight: "regular" | "bold" = "regular", color = C.ink) => {
    rt += size + 5;
    s.text(text, rx, rt, { size, weight, color, maxWidth: 210, shrinkTo: size - 2 });
  };
  line(`${data.companyName}　${data.storeName}`, 10.5, "bold");
  line(`担当：${data.staffName ?? ""}`, 10);
  if (data.replyFax) line(`FAX　${data.replyFax}`, 10.5, "bold");
  if (data.storeTel) line(`TEL　${data.storeTel}`, 9);
  for (const l of s.ts.wrap(data.storeAddress, 8, 210, { maxLines: 2 })) line(l, 8, "regular", C.sub);
  lt += 16;
  s.text("下記のとおり発注いたします。", LEFT, lt, { size: 9.5 });
  s.y = Math.max(lt, rt) + 10;

  // 明細の表: 品名・数量・現場名・着日・備考 (手書きの発注書と同じ列。品番・仕様は品名の下、案件番号は現場名の下)
  const cols: GridColumn[] = [
    { label: "", width: 22, align: "center", fit: true },
    { label: "品名", width: 188, align: "left" },
    { label: "数量", width: 54, align: "right" },
    { label: "現場名", width: 116, align: "left" },
    { label: "着日", width: 50, align: "center", fit: true },
    { label: "備考", width: CONTENT_W - 22 - 188 - 54 - 116 - 50, align: "left" },
  ];
  const rows = data.lines.map((l, i) => [
    String(i + 1),
    [l.name, [l.code && `品番 ${l.code}`, l.spec].filter((x) => x && s.ts.clean(x)).join("　")].filter(Boolean).join("\n"),
    `${fmtQty(l.qty)}${s.ts.clean(l.unit) ? ` ${s.ts.clean(l.unit)}` : ""}`,
    [l.site, l.orderNumber].filter((x) => x && s.ts.clean(x)).join("\n"),
    fmtArrival(l.arrival),
    [l.notes, typeof l.unitPrice === "number" ? `単価 ${fmtYen(l.unitPrice)}` : ""].filter((x) => x && s.ts.clean(x)).join("\n"),
  ]);
  for (let i = rows.length; i < PO_MIN_ROWS; i++) rows.push([String(i + 1), "", "", "", "", ""]);
  gridTable(s, cols, rows, "", { plain: true, minRowH: 26 });

  // 納品先・備考・受注確認
  s.y += 10;
  s.ensure(18);
  s.text("納品先", LEFT, s.y + 11, { size: 8.5, color: C.sub });
  s.text(joinText([data.deliveryPlace, data.deliveryAddress], "　"), LEFT + 40, s.y + 11, { size: 9.5, maxWidth: CONTENT_W - 40, shrinkTo: 7.5 });
  s.y += 16;
  textSection(s, "備考", data.notes);
  poReplyBox(s, data);
  return s.finish(data.cancelled ? PO_CANCEL_MARK : data.draft ? PO_DRAFT_MARK : undefined);
}
