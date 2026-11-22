import type { StoreId, SurveyHistoryRow } from "@/lib/db/types";
import { sha } from "./claims";
import { nk, nkTight, parseNum, storeOfLabel, type WorkbookTab } from "./tabs";

/**
 * 「H26集計」〜「R4集計」のタブ → アンケートの過去の集計 (survey_history)
 * ------------------------------------------------------------
 * 「アンケート集計 Ｈ２６」「アンケート集計 R２～３ 工場」の見出しのセルごとに 1 つの表として読む:
 * 見出しの行の右に期間の列 (１３００台… / 7月〜6月) と「合計」。その下の行に 設問 (左の列・空欄は上と同じ)・回答・期間ごとの件数・合計。
 * 期間の合計 (「合計」の列) を 1 行として残す (月ごとの件数は資料庫で読める)。設問の小計の行 (回答が空欄) は読まない。
 * 平成の表は全社、令和の表は店舗ごと (工場 = 合志店・中央店・西店・玉名店。「合計」の表は店舗の表の合計なので読まない)
 */

export const HISTORY_QUESTIONS = ["回答数", "電話応対", "営業担当者", "職人の対応", "工事の仕上り", "重視したこと", "情報媒体", "次回"] as const;

/** 5 段階の評価の回答 → 点 */
export const SCORE_ANSWER: Record<string, number> = { 大変不満: 1, 不満: 2, 普通: 3, 満足: 4, 大変満足: 5 };

function question(raw: string): string {
  const t = nkTight(raw);
  if (/電話/.test(t)) return "電話応対";
  if (/営業/.test(t)) return "営業担当者";
  if (/職人/.test(t)) return "職人の対応";
  if (/仕上/.test(t)) return "工事の仕上り";
  if (/重視/.test(t)) return "重視したこと";
  if (/媒体/.test(t)) return "情報媒体";
  if (/次回/.test(t)) return "次回";
  return t;
}

/** 見出し「アンケート集計 Ｈ２６」「R２～３ 工場」→ 年度・店舗 */
export function parseHistoryTitle(text: string): { fiscalLabel: string; startYear: number; store?: StoreId | "total" } | null {
  const t = nk(text).replace(/\s+/g, " ");
  const m = t.match(/([HR])\s*(\d{1,2})(?:\s*[~～〜-]\s*(\d{1,2}))?\s*(.*)$/i);
  if (!m) return null;
  const era = m[1].toUpperCase();
  const n = Number(m[2]);
  const startYear = era === "H" ? 1988 + n : 2018 + n;
  const rest = nkTight(m[4] ?? "");
  const store = !rest ? undefined : /合計/.test(rest) ? "total" : (storeOfLabel(rest) as StoreId | undefined);
  if (rest && !store) return null;
  return { fiscalLabel: `${era}${n}`, startYear, store };
}

interface Block {
  r: number;
  c: number;
  title: ReturnType<typeof parseHistoryTitle> & object;
  periodCols: number[];
  totalCol: number;
}

function findBlocks(rows: string[][]): Block[] {
  const blocks: Block[] = [];
  rows.forEach((row, r) => {
    row.forEach((cell, c) => {
      if (!/^アンケート集計/.test(nkTight(cell))) return;
      const title = parseHistoryTitle(nk(cell).replace(/^アンケート集計/, ""));
      if (!title) return;
      // 期間の列: 見出しの行の右。「合計」まで
      let totalCol = -1;
      const periodCols: number[] = [];
      for (let k = c + 2; k < Math.min(row.length, c + 40); k++) {
        const h = nkTight(row[k]);
        if (h === "合計") {
          totalCol = k;
          break;
        }
        if (h) periodCols.push(k);
      }
      if (totalCol < 0) return;
      blocks.push({ r, c, title, periodCols, totalCol });
    });
  });
  return blocks;
}

export interface HistoryParse {
  rows: SurveyHistoryRow[];
  blocks: { fiscalLabel: string; storeId?: StoreId; questions: number }[];
  problems: string[];
}

export function parseHistoryTab(tab: WorkbookTab, importedAt: string): HistoryParse {
  const blocks = findBlocks(tab.rows);
  const out: SurveyHistoryRow[] = [];
  const info: HistoryParse["blocks"] = [];
  const problems: string[] = [];
  if (!blocks.length) problems.push(`「${tab.title}」: 「アンケート集計」の表が見つかりません`);
  for (const b of blocks) {
    if (b.title.store === "total") continue;
    const storeId = b.title.store as StoreId | undefined;
    const header = tab.rows[b.r];
    const sub = tab.rows[b.r + 1] ?? [];
    const subLabels = b.periodCols.map((k) => nk(sub[k])).filter((x) => x && parseNum(x) === undefined);
    const first = nk(header[b.periodCols[0]]);
    const last = nk(header[b.periodCols.at(-1)!]);
    const period = `${first}〜${last}${subLabels.length ? ` (${subLabels[0]}〜${subLabels.at(-1)})` : ""}`;
    let q = "";
    let started = false;
    const seen = new Set<string>();
    let blanks = 0;
    for (let r = b.r + 1; r < tab.rows.length; r++) {
      const row = tab.rows[r];
      // 次の表の見出し (同じ列) で終わり
      if (r > b.r && /^アンケート集計/.test(nkTight(row[b.c]))) break;
      const qCell = nk(row[b.c]);
      const aCell = nkTight(row[b.c + 1]);
      const total = parseNum(row[b.totalCol]);
      const periodNums = b.periodCols.map((k) => parseNum(row[k]));
      const any = qCell || aCell || total !== undefined || periodNums.some((x) => x !== undefined);
      if (!any) {
        if (started && ++blanks >= 3) break;
        continue;
      }
      blanks = 0;
      if (qCell) q = question(qCell);
      if (!q && !aCell) {
        // 設問の前の数の行 = 回答数 (はがきの枚数)
        if (!seen.has("回答数") && (total !== undefined || periodNums.some((x) => x !== undefined))) {
          const count = total ?? periodNums.reduce<number>((a, x) => a + (x ?? 0), 0);
          seen.add("回答数");
          out.push(rowOf(tab.title, b, storeId, period, "回答数", "", count, importedAt));
        }
        continue;
      }
      if (!q || !aCell) continue; // 小計の行
      started = true;
      const count = total ?? periodNums.reduce<number>((a, x) => a + (x ?? 0), 0);
      const k = `${q}|${aCell}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(rowOf(tab.title, b, storeId, period, q, aCell, count, importedAt));
    }
    info.push({ fiscalLabel: b.title.fiscalLabel, storeId, questions: new Set(out.filter((x) => x.fiscalLabel === b.title.fiscalLabel && x.storeId === storeId).map((x) => x.question)).size });
  }
  return { rows: out, blocks: info, problems };
}

function rowOf(sheet: string, b: Block, storeId: StoreId | undefined, period: string, question: string, answer: string, count: number, importedAt: string): SurveyHistoryRow {
  const ref = `sheet:history:${nkTight(sheet)}:${storeId ?? "all"}:${question}:${answer}`;
  return { id: `svh_${sha(ref)}`, fiscalLabel: b.title.fiscalLabel, startYear: b.title.startYear, period, storeId, question, answer, count, sourceRef: ref, importedAt };
}

/* ------------------------------------------------------------------ */
/* 年度ごとの比較 (過去の集計 + システムの回答)                              */
/* ------------------------------------------------------------------ */

export interface HistoryColumn {
  label: string;
  /** はがきの枚数 (割合の分母) */
  cards: number;
  scores: Record<string, number | null>;
  /** 回答 → 件数 (重視したこと・情報媒体・次回) */
  answers: Record<string, Record<string, number>>;
  source: "sheet" | "system";
}

/** 期間の表 (1 つの年度・店舗の集まり) を比較の列にする */
export function historyColumn(label: string, rows: SurveyHistoryRow[]): HistoryColumn {
  const answers: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    if (r.question === "回答数") continue;
    answers[r.question] ??= {};
    answers[r.question][r.answer] = (answers[r.question][r.answer] ?? 0) + r.count;
  }
  const scores: Record<string, number | null> = {};
  for (const q of ["電話応対", "営業担当者", "職人の対応", "工事の仕上り"]) {
    const a = answers[q] ?? {};
    let n = 0;
    let sum = 0;
    for (const [k, v] of Object.entries(a)) {
      const p = SCORE_ANSWER[nkTight(k)];
      if (p) {
        n += v;
        sum += p * v;
      }
    }
    scores[q] = n ? sum / n : null;
  }
  // 分母: 回答数 (はがきの枚数) と、1 つだけ選ぶ設問の回答の合計の大きい方 (シートの回答数の行が途中で止まっている年度がある)
  const cardRows = rows.filter((r) => r.question === "回答数").reduce((a, r) => a + r.count, 0);
  const single = ["電話応対", "営業担当者", "職人の対応", "工事の仕上り", "次回"].map((q) => Object.values(answers[q] ?? {}).reduce((a, v) => a + v, 0));
  return { label, cards: Math.max(cardRows, ...single), scores, answers, source: "sheet" };
}
