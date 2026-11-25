import { createHash } from "node:crypto";
import type { Database, StoreId, SurveyResponse } from "@/lib/db/types";
import { decodeCsv, parseCsv } from "@/lib/csv";
import { readXlsx } from "@/lib/xlsx";
import { xlsxRows } from "@/lib/survey-workbook/read";
import { nk, nkTight, parseMonth, parseNum, parseYear, storeOfLabel } from "@/lib/survey-workbook/tabs";
import { normPostcardNo } from "@/lib/survey";
import { staffMatcher, type StaffAliases } from "@/lib/survey-workbook/staff";
import { kpiBasis, monthKey, type KpiBasis } from "./kpi-basis";
import { compareStoreIds } from "@/lib/store-order";

/**
 * KPI の分母・集計月の取込 (確認 → 取り込む)
 * ------------------------------------------------------------
 * 1. 年間チラシ計画 (Google スプレッドシート) の「個人件数売上」タブ → 店舗 × 月の個人件数 (返信率の分母)
 *    表「個人売上目標・実績（2025年度）」(年度 = 7 月〜翌 6 月) の店舗ごとの「本年度実績」の「件数」の列。空欄の月 (まだ記入していない月) は読まない
 * 2. アンケートハガキ（回答）の「フォームの回答 1」タブ → 移行したはがき (sourceRef = …#フォームの回答 1!<行>) の集計月 (「年」「月」の列)。
 *    「年」が空欄の行 (2024 年) は入力日 (タイムスタンプ) から決める (前月のはがきを月初に入力していたため、月が入力日の月より後なら前年)。
 *    移行 (10/16 の写し) のあとにフォームに入力したはがき (システムにない行) は、新しいはがきとして登録する (移行と同じ列の読み方。
 *    同じハガキ№ のはがきがシステムにあれば登録しない = 写真・手入力で登録済み)
 *    「月」が空欄の行 (月の書き忘れ) は、同じ日に続けて入力した前後の行の月にする (前後の月が違うときは決めない = 入力日の月のまま)
 * 3. アンケートハガキ（回答）の「ピボット テーブル <年>.<月>」タブの「ハガキ個人件数」の表 → 店舗 × 月の個人件数。
 *    KPI シートの返信率の分母に実際に使った値 (年間チラシ計画の値をその時点で写したもの。計画の値はあとで直ることがある)。
 *    年度ごとに一番新しいピボット (タブの名前の年月) の値を使い、年間チラシ計画の取込より優先する (計画の取込で上書きしない)
 * 一方向 (シート → システム)。手入力した個人件数は取り込みで上書きしない。読み取った内容は storage.ts の imports/kpi-basis/ に一時保存する
 */

export type BasisSourceKind = "individual" | "cardMonths" | "pivot";

export const BASIS_SOURCE_LABEL: Record<BasisSourceKind, string> = {
  individual: "年間チラシ計画「個人件数売上」→ 個人件数",
  cardMonths: "アンケートハガキ（回答）「フォームの回答 1」→ はがきの集計月",
  pivot: "アンケートハガキ（回答）「ピボット テーブル」の「ハガキ個人件数」→ 個人件数 (KPI シートの返信率に使った値)",
};

export interface IndividualValue {
  storeId: StoreId;
  month: string;
  value: number;
  /** シートの場所 (例: 個人件数売上!H53) */
  ref: string;
  /** pivot = アンケートハガキ（回答）のピボットの値 (年間チラシ計画より優先)。なし = 年間チラシ計画 */
  src?: "pivot";
}

export interface CardMonthRow {
  /** シートの行 (1 から) */
  row: number;
  month: string;
  postcardNo?: string;
  /** 入力日時 (ISO。照合用) */
  at?: string;
  /** タイムスタンプも ハガキ№ もない行 (2 人目以降の担当を手で書き足した行) の内容 */
  attached?: { at?: string; salesName?: string; salesScore?: number; craftsmanName?: string; craftsmanScore?: number };
  /** タイムスタンプのある行 (はがき 1 枚) の内容 (システムにない行を新しいはがきとして登録するとき) */
  card?: CardContent;
  /** 「月」が空欄で、同じ日に入力した前後の行の月にした */
  inferred?: boolean;
}

/** はがき 1 枚の回答 (フォームの列。scripts/import/extract-client-data.mjs の移行と同じ読み方) */
export interface CardContent {
  store?: StoreId;
  phoneScore?: number;
  salesName?: string;
  salesScore?: number;
  craftsmanName?: string;
  craftsmanScore?: number;
  finishScore?: number;
  priorities?: string;
  media?: string;
  wouldUseAgain?: string;
}

export interface BasisPreview {
  label: string;
  individual: IndividualValue[];
  cardMonths: CardMonthRow[];
  /** カードの行のシート名 (sourceRef の # の後ろ) */
  cardSheet?: string;
  problems: string[];
  by: string;
  at: string;
}

const colName = (i: number): string => {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

/* ------------------------------------------------------------------ */
/* 年間チラシ計画「個人件数売上」                                         */
/* ------------------------------------------------------------------ */

const STORE_HEAD = /^(合志|中央|西|玉名)\s*[（(]/;

/** 「個人件数売上」のタブ → 店舗 × 月の個人件数 (本年度実績の件数) */
export function parseIndividualSheet(rows: string[][], sheetName = "個人件数売上"): { values: IndividualValue[]; problems: string[] } {
  const values: IndividualValue[] = [];
  const problems: string[] = [];
  // 年度の表の見出し「個人売上目標・実績（2025年度）」
  const blocks: { r: number; fy: number }[] = [];
  rows.forEach((row, r) => row.forEach((c) => {
    const m = nk(c).match(/個人売上目標.*実績.*?(20\d\d)\s*年度/);
    if (m) blocks.push({ r, fy: Number(m[1]) });
  }));
  if (!blocks.length) problems.push(`${sheetName}: 「個人売上目標・実績（○○年度）」の表が見つかりません`);
  blocks.forEach((b, bi) => {
    const end = bi + 1 < blocks.length ? blocks[bi + 1].r : rows.length;
    for (let r = b.r; r < end; r++) {
      rows[r]?.forEach((cell, c) => {
        const head = nk(cell).match(STORE_HEAD);
        if (!head) return;
        const storeId = storeOfLabel(head[1]) as StoreId;
        // 「本年度実績」の列 (店舗の見出しのすぐ下の行。右へ 14 列まで)
        let col = -1;
        let headRow = -1;
        for (let k = r; k <= Math.min(end - 1, r + 3) && col < 0; k++) {
          for (let j = c; j < Math.min((rows[k] ?? []).length, c + 14); j++) {
            if (/^本年度実績$/.test(nkTight(rows[k][j]))) {
              col = j;
              headRow = k;
              break;
            }
          }
        }
        if (col < 0) {
          problems.push(`${sheetName} ${b.fy}年度 ${head[1]}: 「本年度実績」の列が見つかりません`);
          return;
        }
        // 月の行 (「7月」〜「6月」。月の名前は左の列にある)。「累計」の行で終わり
        for (let k = headRow + 1; k < Math.min(end, headRow + 20); k++) {
          const row = rows[k] ?? [];
          if (row.slice(0, col).some((v) => /^累計$/.test(nkTight(v)))) break;
          let mo: number | undefined;
          for (let j = col - 1; j >= 0 && mo === undefined; j--) mo = parseMonth(row[j]);
          if (mo === undefined) continue;
          const v = parseNum(row[col]);
          if (v === undefined) continue;
          if (v < 0 || v > 5000 || !Number.isInteger(v)) {
            problems.push(`${sheetName}!${colName(col)}${k + 1}: 件数として読めない値 (${row[col]})`);
            continue;
          }
          // 年度 = 7 月〜翌 6 月 (2025年度 = 2025-07〜2026-06)
          const y = mo >= 7 ? b.fy : b.fy + 1;
          values.push({ storeId, month: `${y}-${String(mo).padStart(2, "0")}`, value: v, ref: `${sheetName}!${colName(col)}${k + 1}` });
        }
      });
    }
  });
  // 同じ店舗・月が 2 回 (年度の表の重なり) あれば後の表 (新しい年度) を使う
  const byKey = new Map<string, IndividualValue>();
  for (const v of values) byKey.set(monthKey(v.storeId, v.month), v);
  return { values: [...byKey.values()].sort((a, b) => a.month.localeCompare(b.month) || compareStoreIds(a.storeId, b.storeId)), problems };
}

/* ------------------------------------------------------------------ */
/* アンケートハガキ（回答）「フォームの回答 1」                            */
/* ------------------------------------------------------------------ */

/** タイムスタンプ (CSV の「12/9/2025 10:47:28」/ .xlsx の日付の数値) → ISO (日本時間) */
export function parseStamp(v: string): string | undefined {
  const t = nk(v);
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) return new Date(`${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}T${m[4].padStart(2, "0")}:${m[5]}:${m[6] ?? "00"}+09:00`).toISOString();
  const y = t.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})/);
  if (y) return new Date(`${y[1]}-${y[2].padStart(2, "0")}-${y[3].padStart(2, "0")}T${y[4].padStart(2, "0")}:${y[5]}:00+09:00`).toISOString();
  const n = Number(t);
  // .xlsx の日付 (1900 年からの日数。日本時間のまま入っている)
  if (Number.isFinite(n) && n > 40000 && n < 80000) return new Date(Math.round((n - 25569) * 86400000) - 9 * 3600000).toISOString();
  return undefined;
}

/** 「フォームの回答 1」→ 行ごとの集計月 */
export function parseCardMonthSheet(rows: string[][], sheetName = "フォームの回答 1"): { rows: CardMonthRow[]; problems: string[] } {
  const problems: string[] = [];
  const head = rows[0]?.map(nkTight) ?? [];
  const col = (re: RegExp) => head.findIndex((h) => re.test(h));
  const c = { ts: col(/タイムスタンプ/), month: col(/^月$/), year: col(/^年$/), store: col(/^店舗$/), phone: col(/電話対応/), salesP: col(/^営業担当者$/), sales: col(/^営業対応$/), craftP: col(/^担当職人$/), craft: col(/^職人対応$/), finish: col(/仕上り|仕上がり/), priority: col(/重視/), media: col(/情報媒体|何を見て/), again: col(/次回/) };
  if (c.ts < 0 || c.month < 0) return { rows: [], problems: [`${sheetName}: 見出し (タイムスタンプ・月) が見つかりません`] };
  // ハガキ№ の列 (見出しが空欄のことがある): タイムスタンプの次の列
  const noCol = head.findIndex((h) => /ハガキ/.test(h)) >= 0 ? head.findIndex((h) => /ハガキ/.test(h)) : c.ts + 1;
  const out: CardMonthRow[] = [];
  let noMonth = 0;
  const yearFixes: string[] = [];
  let prev: { y: number; at?: string } | undefined;
  const score = (v: unknown) => {
    const n = parseNum(v);
    return n !== undefined && n >= 1 && n <= 5 ? n : undefined;
  };
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || nkTight(r[c.ts]) === "タイムスタンプ") {
      prev = undefined;
      continue;
    }
    const at = parseStamp(r[c.ts] ?? "");
    const mo = parseMonth(r[c.month]);
    if (!at && mo === undefined) continue;
    const text = (k: number) => (k >= 0 ? nk(r[k]) || undefined : undefined);
    const content = (): CardContent => {
      const st = c.store >= 0 ? storeOfLabel(nk(r[c.store])) : undefined;
      return {
        store: st && st !== "office" ? st : undefined,
        phoneScore: c.phone >= 0 ? score(r[c.phone]) : undefined,
        salesName: text(c.salesP),
        salesScore: c.sales >= 0 ? score(r[c.sales]) : undefined,
        craftsmanName: text(c.craftP),
        craftsmanScore: c.craft >= 0 ? score(r[c.craft]) : undefined,
        finishScore: c.finish >= 0 ? score(r[c.finish]) : undefined,
        priorities: text(c.priority),
        media: text(c.media),
        wouldUseAgain: text(c.again),
      };
    };
    if (mo === undefined) {
      noMonth++;
      // 集計月は決められないが、はがき 1 枚として登録できるように残す (集計月は入力日の月)
      if (at) out.push({ row: i + 1, month: "", postcardNo: normPostcardNo(nk(r[noCol]).replace(/^(\d+)\.0+$/, "$1")) || undefined, at, card: content() });
      continue;
    }
    let y = c.year >= 0 ? parseYear(r[c.year]) : undefined;
    if (at) {
      // 入力日 (日本時間) の年。月が入力日の月より後 (12 月分を 1 月に入力) なら前年。
      // 「年」が空欄 (2024 年) のときと、「年」が入力日と合わない (書き写しの誤り。例: 2026/02/03 に入力した 1 月分が「2025年」) ときはこちらを使う
      const jst = new Date(Date.parse(at) + 9 * 3600000);
      const yAt = jst.getUTCFullYear() - (mo > jst.getUTCMonth() + 1 ? 1 : 0);
      if (y && y !== yAt) yearFixes.push(`${i + 1} 行目 (「${nk(r[c.year])}」→ ${yAt} 年 ${mo} 月)`);
      y = yAt;
    }
    // タイムスタンプも年もない行 (上のはがきの 2 人目以降の担当を手で書き足した行) は上の行の年
    if (!y && prev) y = prev.y;
    if (!y) continue;
    // .xlsx の数値のセルは「14144.0」と読めることがある
    const no = normPostcardNo(nk(r[noCol]).replace(/^(\d+)\.0+$/, "$1"));
    const row: CardMonthRow = { row: i + 1, month: `${y}-${String(mo).padStart(2, "0")}`, postcardNo: no || undefined, at, card: at ? content() : undefined };
    if (!at && !no) {
      // 書き足した行: 移行 (タイムスタンプのある行だけを読んだ) で漏れているため、②③ の評価の行として足せるように内容も残す
      row.attached = {
        at: prev?.at,
        salesName: c.salesP >= 0 ? nk(r[c.salesP]) || undefined : undefined,
        salesScore: c.sales >= 0 ? score(r[c.sales]) : undefined,
        craftsmanName: c.craftP >= 0 ? nk(r[c.craftP]) || undefined : undefined,
        craftsmanScore: c.craft >= 0 ? score(r[c.craft]) : undefined,
      };
    }
    out.push(row);
    prev = { y, at: at ?? prev?.at };
  }
  if (yearFixes.length) problems.push(`${sheetName}: 「年」が入力日と合わない行 ${yearFixes.length} 行は、入力日から年を決めました (${yearFixes.slice(0, 6).join("・")}${yearFixes.length > 6 ? " ほか" : ""})`);
  // 「月」が空欄の行: 同じ日 (日本時間) に続けて入力した前後の行の月 (前後で違えば決めない)
  const inferred: string[] = [];
  const dayOf = (at: string | undefined) => (at ? new Date(Date.parse(at) + 9 * 3600000).toISOString().slice(0, 10) : undefined);
  out.forEach((row, i) => {
    if (row.month || !row.at) return;
    const day = dayOf(row.at);
    const near = (step: number): string | undefined => {
      for (let j = i + step; j >= 0 && j < out.length; j += step) {
        const o = out[j];
        if (!o.at) continue;
        if (dayOf(o.at) !== day) return undefined;
        if (o.month) return o.month;
      }
      return undefined;
    };
    const before = near(-1);
    const after = near(1);
    const month = before && after ? (before === after ? before : undefined) : (before ?? after);
    if (!month) return;
    row.month = month;
    row.inferred = true;
    inferred.push(`${row.row} 行目${row.postcardNo ? ` (No.${row.postcardNo})` : ""} → ${month.slice(0, 4)} 年 ${Number(month.slice(5))} 月`);
  });
  if (inferred.length) problems.push(`${sheetName}: 「月」が空欄の行 ${inferred.length} 行は、同じ日に続けて入力した前後の行の月にしました (${inferred.slice(0, 6).join("・")}${inferred.length > 6 ? " ほか" : ""})。違う月のはがきなら、取り込んだあと「アンケート」の画面で集計月を直してください`);
  const left = noMonth - inferred.length;
  if (left > 0) problems.push(`${sheetName}: 「月」が空欄の行が ${left} 行あります (集計月を決められないため、入力日の月のままにします)`);
  return { rows: out, problems };
}

/* ------------------------------------------------------------------ */
/* アンケートハガキ（回答）「ピボット テーブル <年>.<月>」の「ハガキ個人件数」 */
/* ------------------------------------------------------------------ */

/** タブの名前「ピボット テーブル 2025.11」「ピボット テーブル 2024.12-2」→ 年・月 (年度の判定と、新しい順の比較に使う) */
export function pivotSheetMonth(name: string): { y: number; m: number; key: string } | undefined {
  const t = nk(name).match(/(20\d\d)\s*[.\-/年]\s*(\d{1,2})(?:\s*月)?(?:\s*[-‐ー]\s*(\d+))?/);
  if (!t) return undefined;
  const y = Number(t[1]);
  const m = Number(t[2]);
  if (m < 1 || m > 12) return undefined;
  return { y, m, key: `${y}-${String(m).padStart(2, "0")}-${String(Number(t[3] ?? 0)).padStart(2, "0")}` };
}

/**
 * ピボットのタブの「ハガキ個人件数」の表 (見出し「月 | 合志 | 中央 | 玉名 | 西」、行 = 12, 1, 2 … 11) → 店舗 × 月の個人件数。
 * 年度 (12 月〜翌 11 月) はタブの名前の年月で決める (2025.11 → 2025 年度、2024.12 → 2025 年度)。空欄の月は読まない
 */
export function parsePivotIndividual(rows: string[][], sheetName: string, fiscalStartMonth = 12): { values: IndividualValue[]; fy?: number; problems: string[] } {
  const problems: string[] = [];
  const values: IndividualValue[] = [];
  const at = pivotSheetMonth(sheetName);
  const start = rows.findIndex((r) => r.some((c) => nkTight(c) === "ハガキ個人件数"));
  if (start < 0) return { values, problems };
  if (!at) {
    problems.push(`${sheetName || "ピボット"}: タブの名前に年月 (例: ピボット テーブル 2026.9) がないため、「ハガキ個人件数」の年度が決められません`);
    return { values, problems };
  }
  const fy = fiscalStartMonth > 1 && at.m >= fiscalStartMonth ? at.y + 1 : at.y;
  // 見出しの行 (「月」と店舗の名前)
  let head = -1;
  for (let r = start; r < Math.min(rows.length, start + 4) && head < 0; r++) if (rows[r].some((c) => nkTight(c) === "月")) head = r;
  if (head < 0) {
    problems.push(`${sheetName}: 「ハガキ個人件数」の見出し (月・店舗) が見つかりません`);
    return { values, fy, problems };
  }
  const monthCol = rows[head].findIndex((c) => nkTight(c) === "月");
  const storeCols: { col: number; storeId: StoreId }[] = [];
  rows[head].forEach((c, col) => {
    const st = col > monthCol ? storeOfLabel(nk(c)) : undefined;
    if (st && st !== "office" && st !== "hq") storeCols.push({ col, storeId: st });
  });
  for (let r = head + 1; r < Math.min(rows.length, head + 16); r++) {
    const mt = nkTight(rows[r][monthCol]).replace(/月$/, "");
    if (!/^\d{1,2}$/.test(mt)) break;
    const mo = Number(mt);
    if (mo < 1 || mo > 12) break;
    const y = fiscalStartMonth > 1 && mo >= fiscalStartMonth ? fy - 1 : fy;
    for (const { col, storeId } of storeCols) {
      const v = parseNum(rows[r][col]);
      if (v === undefined) continue;
      if (v < 0 || v > 5000 || !Number.isInteger(v)) {
        problems.push(`${sheetName}!${colName(col)}${r + 1}: 件数として読めない値 (${rows[r][col]})`);
        continue;
      }
      values.push({ storeId, month: `${y}-${String(mo).padStart(2, "0")}`, value: v, ref: `${sheetName}!${colName(col)}${r + 1}`, src: "pivot" });
    }
  }
  return { values, fy, problems };
}

/* ------------------------------------------------------------------ */
/* ファイル・シート → 読み取り                                            */
/* ------------------------------------------------------------------ */

export const MAX_BASIS_BYTES = 4 * 1024 * 1024;

/** 中身で見分ける */
export function detectBasisSheet(rows: string[][]): BasisSourceKind | null {
  const top = rows.slice(0, 80);
  if (top.some((r) => r.some((c) => /個人売上目標.*実績.*年度/.test(nk(c))))) return "individual";
  if (rows.slice(0, 120).some((r) => r.some((c) => nkTight(c) === "ハガキ個人件数"))) return "pivot";
  const head = (rows[0] ?? []).map(nkTight);
  if (head.some((h) => /タイムスタンプ/.test(h)) && head.includes("月") && head.includes("店舗")) return "cardMonths";
  return null;
}

/** 読み取ったシート (行 × 列) を種類ごとに集める */
export function readBasisSheets(sheets: { name: string; rows: string[][]; source: string }[]): Pick<BasisPreview, "individual" | "cardMonths" | "cardSheet" | "problems"> {
  const individual: IndividualValue[] = [];
  const cardMonths: CardMonthRow[] = [];
  const problems: string[] = [];
  let cardSheet: string | undefined;
  // ピボット: 年度ごとに一番新しいタブ (名前の年月) だけを使う (あとのタブほど計画の値の直しが入っている)
  const pivots = new Map<number, { key: string; values: IndividualValue[]; name: string }>();
  for (const sh of sheets) {
    const kind = detectBasisSheet(sh.rows);
    if (kind === "pivot") {
      const r = parsePivotIndividual(sh.rows, sh.name);
      problems.push(...r.problems);
      const at = pivotSheetMonth(sh.name);
      if (r.fy === undefined || !at || !r.values.length) continue;
      const cur = pivots.get(r.fy);
      if (!cur || at.key > cur.key) pivots.set(r.fy, { key: at.key, values: r.values, name: sh.name });
    } else if (kind === "individual") {
      const r = parseIndividualSheet(sh.rows, sh.name || "個人件数売上");
      individual.push(...r.values);
      problems.push(...r.problems);
    } else if (kind === "cardMonths") {
      if (cardSheet) {
        problems.push(`${sh.source}: はがきの回答のシートが 2 つあります。最初のシートだけを読みます`);
        continue;
      }
      const r = parseCardMonthSheet(sh.rows, sh.name || "フォームの回答 1");
      cardMonths.push(...r.rows);
      problems.push(...r.problems);
      cardSheet = sh.name || "フォームの回答 1";
    }
  }
  // 同じ店舗・月は ピボット (KPI シートの返信率に使った値) を年間チラシ計画より優先する
  const merged = new Map<string, IndividualValue>();
  for (const v of individual) merged.set(monthKey(v.storeId, v.month), v);
  for (const p of [...pivots.values()].sort((a, b) => a.key.localeCompare(b.key))) for (const v of p.values) merged.set(monthKey(v.storeId, v.month), v);
  if (pivots.size) problems.push(`ピボットの「ハガキ個人件数」: ${[...pivots.entries()].sort((a, b) => a[0] - b[0]).map(([fy, p]) => `${fy}年度は「${p.name}」(${new Set(p.values.map((v) => v.month)).size} か月)`).join("・")} の値を使います`);
  const values = [...merged.values()].sort((a, b) => a.month.localeCompare(b.month) || compareStoreIds(a.storeId, b.storeId));
  if (!values.length && !cardMonths.length) problems.push("読み取れるシートがありません (年間チラシ計画の「個人件数売上」、アンケートハガキ（回答）の「フォームの回答 1」・「ピボット テーブル」)");
  return { individual: values, cardMonths, cardSheet, problems };
}

/** アップロードしたファイル (.xlsx・タブの CSV) → シート */
export function basisSheetsFromFiles(files: { name: string; bytes: Uint8Array }[]): { sheets: { name: string; rows: string[][]; source: string }[]; problems: string[] } {
  const sheets: { name: string; rows: string[][]; source: string }[] = [];
  const problems: string[] = [];
  for (const f of files) {
    const name = f.name.normalize("NFKC");
    try {
      if (/\.(xlsx|xlsm)$/i.test(name)) {
        for (const sh of readXlsx(Buffer.from(f.bytes), { sheet: (n) => /個人件数売上|フォームの回答\s*1$|ピボット/.test(n.normalize("NFKC").trim()) })) sheets.push({ name: sh.name.trim(), rows: xlsxRows(sh.rows), source: `${name} のシート「${sh.name.trim()}」` });
      } else if (/\.(csv|tsv|txt)$/i.test(name)) {
        const { text } = decodeCsv(f.bytes);
        // 空の行も残す (行の番号を表計算の行に合わせる。移行したはがきは行の番号で照合する)
        const rows = /\.tsv$/i.test(name) ? text.split(/\r?\n/).map((l) => l.split("\t")) : parseCsv(text, { keepEmpty: true });
        const tab = name.replace(/\.(csv|tsv|txt)$/i, "").match(/\s-\s(.+)$/)?.[1]?.trim();
        sheets.push({ name: tab ?? "", rows, source: name });
      } else problems.push(`${name}: CSV か .xlsx のファイルを選んでください`);
    } catch (e) {
      problems.push(`${name}: 読み取れませんでした (${(e as Error).message})`);
    }
  }
  return { sheets, problems };
}

export function basisHash(p: Pick<BasisPreview, "individual" | "cardMonths">): string {
  return createHash("sha256").update(JSON.stringify([p.individual, p.cardMonths])).digest("hex").slice(0, 24);
}

/* ------------------------------------------------------------------ */
/* 計画 (確認) と取込                                                    */
/* ------------------------------------------------------------------ */

export type ValueAction = "create" | "update" | "unchanged" | "manual" | "pivot";

export interface IndividualPlanItem extends IndividualValue {
  action: ValueAction;
  current?: number;
}

export interface CardMonthPlan {
  /** 集計月を書く (新しく・変わる) */
  changes: { surveyId: string; row: number; from?: string; to: string; storeId: StoreId }[];
  unchanged: number;
  /** システムに同じ行のはがきがない (移行のあとに入力した行など) */
  notInSystem: number;
  /** 行の番号は合うが、はがき No.・入力日時が違う (シートの行が並べ替えられた) */
  mismatch: number;
  /** 集計月ごとの はがきの枚数 (取込後) と、入力日で数えたときの枚数 */
  byMonth: { month: string; after: number; before: number }[];
  /** 移行で漏れた 2 人目以降の担当の行 (タイムスタンプのない行)。②③ の評価の行として足す */
  adds: AttachedAdd[];
  /** 書き足した行のうち、担当者が社員のアカウントに決まらない行 (足さない) */
  unresolved: number;
  /** 移行のあとにフォームに入力したはがき (システムにない行)。新しいはがきとして登録する */
  newCards: NewCard[];
  /** システムにない行だが、同じハガキ№ のはがきがシステムにある (写真・手入力で登録済み。登録しない) */
  registered: number;
}

export interface NewCard extends CardContent {
  row: number;
  /** 集計月 (「月」が空欄なら空 = 入力日の月) */
  month: string;
  at: string;
  postcardNo?: string;
  salesUserId?: string;
  craftsmanUserId?: string;
  orderId?: string;
  customerId?: string;
  /** 社員のアカウントに決まらなかった担当の名前 (名前の文字は残す) */
  unresolvedNames: string[];
}

export interface AttachedAdd {
  row: number;
  month: string;
  at?: string;
  salesName?: string;
  salesUserId?: string;
  salesScore?: number;
  craftsmanName?: string;
  craftsmanUserId?: string;
  craftsmanScore?: number;
}

export interface BasisPlan {
  individual: IndividualPlanItem[];
  cards: CardMonthPlan;
  counts: { individual: Record<ValueAction, number> };
}

type PlanDb = Pick<Database, "surveys" | "settings"> & Partial<Pick<Database, "users" | "orders">>;

/** はがきの行番号 (sourceRef = …アンケートハガキ（回答）.xlsx#フォームの回答 1!<行>) */
function surveyRow(s: Pick<SurveyResponse, "sourceRef">, sheet: string): number | undefined {
  const m = s.sourceRef?.match(/アンケートハガキ.*#(.+?)!(\d+)$/);
  if (!m || m[1].normalize("NFKC").trim() !== sheet.normalize("NFKC").trim()) return undefined;
  return Number(m[2]);
}

export function planBasisImport(db: PlanDb, p: Pick<BasisPreview, "individual" | "cardMonths" | "cardSheet">, basisIn?: KpiBasis): BasisPlan {
  const basis = basisIn ?? kpiBasis(db);
  const counts: BasisPlan["counts"] = { individual: { create: 0, update: 0, unchanged: 0, manual: 0, pivot: 0 } };
  const individual: IndividualPlanItem[] = p.individual.map((v) => {
    const cur = basis.months[monthKey(v.storeId, v.month)];
    // 手入力の値は上書きしない。ピボットの値 (KPI シートの返信率に使った値) は年間チラシ計画の取込で上書きしない。
    // 同じ値でも 計画 → ピボット は更新 (どこの値かの表示が変わる)
    const pivotNow = cur?.individualSrc === "pivot";
    const action: ValueAction =
      cur?.individual === undefined
        ? "create"
        : cur.individualSrc === "manual"
          ? cur.individual === v.value ? "unchanged" : "manual"
          : pivotNow && v.src !== "pivot"
            ? cur.individual === v.value ? "unchanged" : "pivot"
            : cur.individual === v.value && pivotNow === (v.src === "pivot")
              ? "unchanged"
              : "update";
    counts.individual[action]++;
    return { ...v, action, current: cur?.individual };
  });
  const cards: CardMonthPlan = { changes: [], unchanged: 0, notInSystem: 0, mismatch: 0, byMonth: [], adds: [], unresolved: 0, newCards: [], registered: 0 };
  if (p.cardMonths.length) {
    const sheet = p.cardSheet ?? "フォームの回答 1";
    const byRow = new Map<number, SurveyResponse>();
    // 担当者の名前 → 社員 (移行のときに決めた対応をそのまま使う)
    const salesBy = new Map<string, string>();
    const craftBy = new Map<string, string>();
    for (const s of db.surveys) {
      const r = surveyRow(s, sheet);
      if (r) byRow.set(r, s);
      if (s.salesName && s.salesUserId) salesBy.set(nkTight(s.salesName), s.salesUserId);
      if (s.craftsmanName && s.craftsmanUserId) craftBy.set(nkTight(s.craftsmanName), s.craftsmanUserId);
    }
    // 新しいはがき: 担当者は移行の対応 → 社員の名前 (お客様アンケート集計表の取込と同じ対応表)、案件は売上台帳のハガキ欄の番号
    // 担当者の名前の対応表 (KPI → スプレッドシートの取込 の設定 survey_workbook の staffAliases。survey-workbook/plan.ts の workbookSettings と同じ値)
    const wb = (db.settings.find((x) => x.id === "survey_workbook")?.value ?? {}) as { staffAliases?: unknown };
    const aliases = wb.staffAliases && typeof wb.staffAliases === "object" && !Array.isArray(wb.staffAliases) ? (wb.staffAliases as StaffAliases) : {};
    const match = staffMatcher((db.users ?? []).filter((u) => !u.id.startsWith("u_review")), aliases);
    const personOf = (name: string | undefined, known: Map<string, string>): { id?: string; unresolved?: string } => {
      if (!name) return {};
      const hit = known.get(nkTight(name));
      if (hit) return { id: hit };
      for (const part of nk(name).split(/[\s・、,，/／&＆]+/).filter(Boolean)) {
        const m = match(part);
        if (m.userId) return { id: m.userId };
      }
      return { unresolved: name };
    };
    const cardNo = (v: string | undefined) => normPostcardNo(v).replace(/^[A-Z]+/, "");
    const registeredNos = new Set(db.surveys.map((x) => cardNo(x.postcardNo)).filter(Boolean));
    const orderByNo = new Map((db.orders ?? []).filter((o) => o.postcardNo && o.status !== "cancelled").map((o) => [cardNo(o.postcardNo), o]));
    const after = new Map<string, number>();
    const before = new Map<string, number>();
    for (const row of p.cardMonths) {
      const s = byRow.get(row.row);
      if (!s && row.at && row.card) {
        const no = cardNo(row.postcardNo);
        if (no && registeredNos.has(no)) {
          cards.registered++;
          continue;
        }
        const sales = personOf(row.card.salesName, salesBy);
        const craft = personOf(row.card.craftsmanName, craftBy);
        const o = no ? orderByNo.get(no) : undefined;
        cards.newCards.push({ ...row.card, row: row.row, month: row.month, at: row.at, postcardNo: row.postcardNo, salesUserId: sales.id, craftsmanUserId: craft.id, orderId: o?.id, customerId: o?.customerId, unresolvedNames: [sales.unresolved, craft.unresolved].filter((x): x is string => Boolean(x)) });
        if (no) registeredNos.add(no);
        if (row.postcardNo && row.month) after.set(row.month, (after.get(row.month) ?? 0) + 1);
        continue;
      }
      if (!s) {
        const a = row.attached;
        if (a && ((a.craftsmanName && a.craftsmanScore !== undefined) || (a.salesName && a.salesScore !== undefined))) {
          const salesUserId = a.salesName ? salesBy.get(nkTight(a.salesName)) : undefined;
          const craftsmanUserId = a.craftsmanName ? craftBy.get(nkTight(a.craftsmanName)) : undefined;
          if ((a.craftsmanName && !craftsmanUserId) || (a.salesName && !salesUserId)) cards.unresolved++;
          else cards.adds.push({ row: row.row, month: row.month, at: a.at, salesName: a.salesName, salesUserId, salesScore: a.salesScore, craftsmanName: a.craftsmanName, craftsmanUserId, craftsmanScore: a.craftsmanScore });
          continue;
        }
        cards.notInSystem++;
        continue;
      }
      // 同じ行か: はがき No. が同じ、No. がなければ入力日時が 2 分以内
      const sameNo = row.postcardNo && s.postcardNo ? normPostcardNo(s.postcardNo) === row.postcardNo : undefined;
      // 移行の登録日時は日本時間をそのまま世界時として読んだもの (9 時間ずれる) があるため、どちらでも同じ行とみる
      const diff = row.at && s.receivedAt ? Math.abs(Date.parse(row.at) - Date.parse(s.receivedAt)) : NaN;
      const sameAt = Number.isNaN(diff) ? undefined : diff <= 120000 || Math.abs(diff - 9 * 3600000) <= 120000;
      if (sameNo === false || (sameNo === undefined && sameAt === false)) {
        cards.mismatch++;
        continue;
      }
      // 「月」が空欄の行: 集計月は書かない (入力日の月のまま)
      if (!row.month) {
        cards.unchanged++;
        continue;
      }
      if (s.postcardNo) {
        after.set(row.month, (after.get(row.month) ?? 0) + 1);
        const m0 = (s.answeredOn ?? s.receivedAt).slice(0, 7);
        before.set(m0, (before.get(m0) ?? 0) + 1);
      }
      if (s.countMonth === row.month) {
        cards.unchanged++;
        continue;
      }
      cards.changes.push({ surveyId: s.id, row: row.row, from: s.countMonth, to: row.month, storeId: s.storeId });
    }
    cards.byMonth = [...new Set([...after.keys(), ...before.keys()])].sort().map((month) => ({ month, after: after.get(month) ?? 0, before: before.get(month) ?? 0 }));
  }
  return { individual, cards, counts };
}

export interface BasisApplyResult {
  individual: number;
  cardMonths: number;
  added: number;
  /** 新しいはがき (移行のあとにフォームに入力した行) */
  newCards: number;
  summary: string;
  changedMonths: { field: string; before: number | null; after: number }[];
}

/** 取り込む (mutate の中で呼ぶ)。計画はここで作り直す */
export function applyBasisImport(db: Pick<Database, "surveys" | "settings"> & Partial<Pick<Database, "users" | "orders">>, p: Pick<BasisPreview, "individual" | "cardMonths" | "cardSheet" | "label">, opts: { userId: string; now: string }): { basis: KpiBasis; result: BasisApplyResult } {
  const basis = kpiBasis(db);
  const plan = planBasisImport(db, p, basis);
  const changedMonths: BasisApplyResult["changedMonths"] = [];
  let individual = 0;
  for (const v of plan.individual) {
    if (v.action !== "create" && v.action !== "update") continue;
    const k = monthKey(v.storeId, v.month);
    const cur = basis.months[k] ?? {};
    basis.months[k] = { ...cur, individual: v.value, individualSrc: v.src === "pivot" ? "pivot" : "import", updatedBy: opts.userId, updatedAt: opts.now };
    changedMonths.push({ field: `individual.${v.storeId}.${v.month}`, before: v.current ?? null, after: v.value });
    individual++;
  }
  const byId = new Map(db.surveys.map((s) => [s.id, s]));
  let cardMonths = 0;
  for (const c of plan.cards.changes) {
    const s = byId.get(c.surveyId);
    if (!s) continue;
    s.countMonth = c.to;
    s.updatedAt = opts.now;
    cardMonths++;
  }
  // 移行で漏れた 2 人目以降の担当の行 (②③ の評価だけに使う。はがきの枚数には入らない)
  const sheet = p.cardSheet ?? "フォームの回答 1";
  const prefix = db.surveys.map((s) => s.sourceRef?.match(/^(.*アンケートハガキ[^#]*)#/)?.[1]).find(Boolean) ?? "アンケートハガキ（回答）.xlsx";
  let added = 0;
  for (const a of plan.cards.adds) {
    const sourceRef = `${prefix}#${sheet}!${a.row}`;
    db.surveys.push({
      id: `sv_${createHash("sha256").update(sourceRef).digest("hex").slice(0, 12)}`,
      receivedAt: a.at ?? `${a.month}-01T00:00:00.000Z`,
      storeId: "hq",
      countMonth: a.month,
      salesName: a.salesName,
      salesUserId: a.salesUserId,
      salesScore: a.salesScore,
      craftsmanName: a.craftsmanName,
      craftsmanUserId: a.craftsmanUserId,
      craftsmanScore: a.craftsmanScore,
      sourceRef,
      source: "import",
      createdBy: opts.userId,
      createdAt: opts.now,
      updatedAt: opts.now,
    });
    added++;
  }
  // 移行のあとにフォームに入力したはがき (新しいはがき 1 枚ずつ)
  let newCards = 0;
  for (const c of plan.cards.newCards) {
    const sourceRef = `${prefix}#${sheet}!${c.row}`;
    db.surveys.push({
      id: `sv_${createHash("sha256").update(sourceRef).digest("hex").slice(0, 12)}`,
      receivedAt: c.at,
      postcardNo: c.postcardNo,
      storeId: c.store ?? "hq",
      orderId: c.orderId,
      customerId: c.customerId,
      countMonth: c.month || undefined,
      phoneScore: c.phoneScore,
      salesName: c.salesName,
      salesUserId: c.salesUserId,
      salesScore: c.salesScore,
      craftsmanName: c.craftsmanName,
      craftsmanUserId: c.craftsmanUserId,
      craftsmanScore: c.craftsmanScore,
      finishScore: c.finishScore,
      priorities: c.priorities,
      media: c.media,
      wouldUseAgain: c.wouldUseAgain,
      sourceRef,
      source: "import",
      createdBy: opts.userId,
      createdAt: opts.now,
      updatedAt: opts.now,
    });
    newCards++;
  }
  const parts = [
    p.individual.length ? `個人件数 ${individual} か月分 (変更なし ${plan.counts.individual.unchanged}・手入力のため取り込まない ${plan.counts.individual.manual}${plan.counts.individual.pivot ? `・ピボットの値のため取り込まない ${plan.counts.individual.pivot}` : ""})` : "",
    p.cardMonths.length ? `はがきの集計月 ${cardMonths} 行 (変更なし ${plan.cards.unchanged}・システムにない行 ${plan.cards.notInSystem}・行が合わない ${plan.cards.mismatch})${added ? `・移行で漏れた 2 人目以降の担当の行を追加 ${added} 行` : ""}${newCards ? `・新しいはがき ${newCards} 枚` : ""}${plan.cards.registered ? `・登録済みのため取り込まない ${plan.cards.registered} 枚` : ""}` : "",
  ].filter(Boolean);
  const summary = parts.join(" / ") || "変更はありませんでした";
  basis.lastImport = { at: opts.now, by: opts.userId, label: p.label, summary };
  return { basis, result: { individual, cardMonths, added, newCards, summary, changedMonths } };
}
