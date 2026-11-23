import { readXlsx } from "@/lib/xlsx";
import { xlsxRows } from "@/lib/survey-workbook/read";
import { monthOfLabel, nk, parseMonth, type SheetMonth, type SheetStore } from "./parse";

/**
 * 予定表の月のファイル (Google スプレッドシートの「ファイル → ダウンロード → Microsoft Excel (.xlsx)」) → 予定 (parse.ts)
 * 年・月はファイル名 (「2026.12.xlsx」「2026.12 - ….xlsx」) から。日別のシート「1」〜「31」だけを読む
 */

/** 1 つのファイルの上限 (サーバーの受け取りの上限 10 MB に収める) */
export const MAX_SHEET_FILE_BYTES = 9.5 * 1024 * 1024;

export function readScheduleWorkbook(name: string, bytes: Uint8Array, stores: SheetStore[], monthHint?: { year: number; month: number }): SheetMonth {
  const label = nk(name).replace(/\.(xlsx|xlsm)$/i, "").slice(0, 60);
  const ym = monthHint ?? monthOfLabel(label);
  if (!ym) throw new Error(`「${name}」の年・月が分かりません。ファイル名を「2026.12.xlsx」のように年.月にしてください`);
  if (!/\.(xlsx|xlsm)$/i.test(nk(name))) throw new Error(`「${name}」は .xlsx ではありません。Google スプレッドシートの「ファイル → ダウンロード → Microsoft Excel (.xlsx)」で保存したファイルを選んでください`);
  const sheets = readXlsx(Buffer.from(bytes), { sheet: (n) => /^\d{1,2}$/.test(nk(n)) }).map((s) => ({ name: s.name, rows: xlsxRows(s.rows) }));
  return parseMonth(sheets, { label, year: ym.year, month: ym.month, stores });
}
