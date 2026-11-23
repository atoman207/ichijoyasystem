import type { Database, StoreId, SurveyResponse } from "@/lib/db/types";
import { MEDIA_OPTIONS, PRIORITY_OPTIONS, tallyAnswers } from "@/lib/survey";
import { surveyKpiDate } from "@/lib/kpi-core";
import { countsCard, kpiBasis, scoreAverage, type AverageMode } from "@/lib/kpi-basis";
import { fiscalYearOf } from "@/lib/kpi-settings";
import { historyColumn, type HistoryColumn } from "./history";
import { nkTight } from "./tabs";

/**
 * アンケートの年度ごとの比較 (KPI → アンケート)。シートの「4年比較」をすべての年度に広げたもの:
 * 過去の集計 (H26〜R4。survey_history) と、システムのはがきの回答 (年度ごと) を同じ形の列にして並べる。
 * 割合の分母ははがきの枚数 (重視したこと・情報媒体は複数回答)
 */

/** シートの回答の書き方 → システムの選択肢の書き方 (情報媒体) */
const MEDIA_ALIAS: Record<string, string> = { リピーター: "以前頼んだことがある", HP: "ホームページ", ホームページ: "ホームページ", CM: "CM", DM: "ダイレクトメール" };

function normAnswer(question: string, answer: string): string {
  const t = nkTight(answer);
  if (question === "情報媒体") return MEDIA_ALIAS[t] ?? t;
  return t;
}

export interface CompareColumn extends HistoryColumn {
  key: string;
  sortKey: string;
  note?: string;
}

function systemColumn(fy: number, cards: SurveyResponse[], average: AverageMode): CompareColumn {
  const answers: Record<string, Record<string, number>> = { 重視したこと: {}, 情報媒体: {}, 次回: {} };
  const add = (q: string, a: string) => (answers[q][a] = (answers[q][a] ?? 0) + 1);
  for (const s of cards) {
    // 選択肢にない書き方 (「R」= 以前頼んだことがある・DM など) は読み替え、自由記述は「その他」(survey.ts の tallyAnswers)
    for (const p of tallyAnswers(s.priorityList?.length ? s.priorityList : s.priorities, PRIORITY_OPTIONS).options) add("重視したこと", p);
    for (const m of tallyAnswers(s.mediaList?.length ? s.mediaList : s.media, MEDIA_OPTIONS).options) add("情報媒体", m);
    const again = s.wouldUseAgain ?? "";
    if (/はい/.test(again)) add("次回", "はい");
    else if (/いいえ/.test(again)) add("次回", "いいえ");
    else if (/わから/.test(again)) add("次回", "わからない");
  }
  const avg = (xs: (number | undefined)[]) => scoreAverage(xs, average).avg;
  return {
    key: `sys:${fy}`,
    sortKey: `${fy - 1}-12`,
    label: `${fy}年度`,
    cards: cards.length,
    scores: { 電話応対: avg(cards.map((c) => c.phoneScore)), 営業担当者: avg(cards.map((c) => c.salesScore)), 職人の対応: avg(cards.map((c) => c.craftsmanScore)), 工事の仕上り: avg(cards.map((c) => c.finishScore)) },
    answers,
    source: "system",
  };
}

/**
 * storeId を指定すると その店舗の表 (令和の店舗別の表) とその店舗のはがき。指定しなければ 全社 (平成の全社の表 + 令和の店舗の表の合計) と全店舗のはがき。
 * 店舗のロールには必ず自店舗を指定する (全社・ほかの店舗の数字を見せない)
 */
export function surveyYearComparison(db: Pick<Database, "surveys" | "surveyHistory"> & Partial<Pick<Database, "settings">>, opts: { storeId?: StoreId; fiscalStartMonth: number }): CompareColumn[] {
  const basis = kpiBasis(db);
  const cols: CompareColumn[] = [];
  const hist = (db.surveyHistory ?? []).filter((h) => !opts.storeId || h.storeId === opts.storeId);
  const groups = new Map<string, typeof hist>();
  for (const h of hist) groups.set(h.fiscalLabel, [...(groups.get(h.fiscalLabel) ?? []), { ...h, answer: normAnswer(h.question, h.answer) }]);
  for (const [label, rows] of groups) {
    const col = historyColumn(label, rows);
    cols.push({ ...col, key: `sheet:${label}`, sortKey: `${rows[0].startYear}-${label.startsWith("R") ? "07" : "01"}`, note: rows[0].period });
  }
  // システムのはがき (年度ごと)
  const byFy = new Map<number, SurveyResponse[]>();
  for (const s of db.surveys) {
    if (!countsCard(s, basis) || (opts.storeId && s.storeId !== opts.storeId)) continue;
    const fy = fiscalYearOf(surveyKpiDate(s), opts.fiscalStartMonth);
    byFy.set(fy, [...(byFy.get(fy) ?? []), s]);
  }
  for (const [fy, list] of byFy) cols.push(systemColumn(fy, list, basis.average));
  return cols.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
}

/** 比較の表に出す回答 (どれかの列に 1 件以上ある回答。多い順) */
export function compareAnswers(cols: CompareColumn[], question: string): string[] {
  const total = new Map<string, number>();
  for (const c of cols) for (const [a, n] of Object.entries(c.answers[question] ?? {})) total.set(a, (total.get(a) ?? 0) + (c.cards ? n / c.cards : 0));
  return [...total.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([a]) => a);
}
