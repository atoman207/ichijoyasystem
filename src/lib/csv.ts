/**
 * CSV の読み書き (ブラウザ・サーバー共通)
 * ------------------------------------------------------------
 * - 読み込み: RFC 4180 (ダブルクォート・改行を含む項目)。文字コードは UTF-8 (BOM あり/なし) と
 *   Shift_JIS (Excel で「CSV」保存したファイル) を自動判定する
 * - 書き出し: UTF-8 (BOM 付き。Excel・Google スプレッドシートでそのまま開ける)。
 *   = + - @ で始まる値は先頭に ' を付け、表計算ソフトで数式として実行されないようにする
 */

/** バイト列を文字列にする (UTF-8 として正しく読めなければ Shift_JIS) */
export function decodeCsv(bytes: Uint8Array): { text: string; encoding: "UTF-8" | "Shift_JIS" } {
  const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(start)), encoding: "UTF-8" };
  } catch {
    return { text: new TextDecoder("shift_jis").decode(bytes), encoding: "Shift_JIS" };
  }
}

/** CSV の文字列を行 × 項目の配列にする (空行は除く) */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((v) => v.trim() !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((v) => v.trim() !== "")) rows.push(row);
  return rows;
}

function cell(v: string | number | null | undefined): string {
  let s = v == null ? "" : String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 行 × 項目の配列を CSV (BOM 付き UTF-8 用の文字列) にする */
export function toCsv(rows: (string | number | null | undefined)[][]): string {
  return "﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}
