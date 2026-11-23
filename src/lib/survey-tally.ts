import type { SurveyResponse } from "@/lib/db/types";
import { MEDIA_OPTIONS, PRIORITY_OPTIONS, SCORE_LABEL, SCORE_QUESTIONS, tallyAnswers } from "@/lib/survey";
import { surveyKpiDate } from "@/lib/kpi-core";

/**
 * アンケートの集計表 (スプレッドシート「お客様アンケート集計表」の「H26集計」〜「R4集計」と同じ形)
 * ------------------------------------------------------------
 * 行 = 設問 × 回答 (①〜④ は 大変不満〜大変満足、⑤ 重視したこと・⑥ 依頼のきっかけは選択肢 (複数回答)、⑦ 次回も依頼したいか)。
 * 列は 2 通り (シートの表と同じ):
 *  - 月 (surveyTally): 店舗ごとの表「アンケート集計 R4〜5 ○○店」= 集計月 + 合計 + 割合
 *  - 店舗 (surveyTallyByStore): 合計の表「アンケート集計 R4〜5 合計」= 店舗 + 合計 + 割合
 * 割合の分母はその設問に答えたはがきの枚数 (⑤⑥ は複数回答のため合計が 100% を超える)。
 * 選択肢にない書き方 (移行データの「R」= 以前頼んだことがある など) は読み替え、自由記述は「その他」(survey.ts の tallyAnswers)。
 * 集計に入れるはがき (ハガキ№・担当の名前の決まり・集計月) は KPI と同じ (kpi-basis.ts の kpiCards で絞ってから渡す)
 */

export interface TallyColumn {
  key: string;
  label: string;
  title?: string;
}

export interface TallyRow {
  answer: string;
  /** 列 (月・店舗) ごとの件数 */
  byCol: number[];
  total: number;
  share: number | null;
}

export interface TallySection {
  no: string;
  question: string;
  respondents: number;
  rows: TallyRow[];
}

export interface SurveyTally {
  axis: "month" | "store";
  columns: TallyColumn[];
  /** 列ごとのはがきの枚数 */
  cards: number[];
  totalCards: number;
  sections: TallySection[];
}

/** ⑦ の回答 (はい・わからない・いいえ) */
export function againAnswer(v: string | undefined): "はい" | "わからない" | "いいえ" | undefined {
  const t = v ?? "";
  return /はい/.test(t) ? "はい" : /いいえ/.test(t) ? "いいえ" : /わから/.test(t) ? "わからない" : undefined;
}

function tallyBy(cards: SurveyResponse[], axis: SurveyTally["axis"], columns: TallyColumn[], colOf: (s: SurveyResponse) => string): SurveyTally {
  const idx = new Map(columns.map((c, i) => [c.key, i]));
  const list = cards.filter((s) => idx.has(colOf(s)));
  const col = (s: SurveyResponse) => idx.get(colOf(s))!;
  const perCol = columns.map(() => 0);
  for (const s of list) perCol[col(s)]++;
  const section = (no: string, question: string, answers: readonly string[], pick: (s: SurveyResponse) => string[]): TallySection => {
    const rows = new Map<string, number[]>(answers.map((a) => [a, columns.map(() => 0)]));
    let respondents = 0;
    for (const s of list) {
      const got = pick(s);
      if (!got.length) continue;
      respondents++;
      for (const a of got) {
        if (!rows.has(a)) rows.set(a, columns.map(() => 0));
        rows.get(a)![col(s)]++;
      }
    }
    return {
      no,
      question,
      respondents,
      rows: [...rows.entries()].map(([answer, byCol]) => {
        const total = byCol.reduce((a, b) => a + b, 0);
        return { answer, byCol, total, share: respondents ? total / respondents : null };
      }),
    };
  };
  const scoreAnswers = [1, 2, 3, 4, 5].map((n) => SCORE_LABEL[n]);
  const sections: TallySection[] = SCORE_QUESTIONS.map((q) => section(q.no, q.label, scoreAnswers, (s) => (typeof s[q.key] === "number" ? [SCORE_LABEL[s[q.key] as number]] : [])));
  sections.push(section("⑤", "ご利用にあたって重視されたこと (複数回答)", PRIORITY_OPTIONS, (s) => tallyAnswers(s.priorityList?.length ? s.priorityList : s.priorities, PRIORITY_OPTIONS).options));
  sections.push(section("⑥", "何を見てご依頼いただいたか (複数回答)", MEDIA_OPTIONS, (s) => tallyAnswers(s.mediaList?.length ? s.mediaList : s.media, MEDIA_OPTIONS).options));
  sections.push(
    section("⑦", "次回も依頼したいか", ["はい", "わからない", "いいえ"], (s) => {
      const a = againAnswer(s.wouldUseAgain);
      return a ? [a] : [];
    }),
  );
  return { axis, columns, cards: perCol, totalCards: list.length, sections };
}

/** 月の列 (集計月) */
export function surveyTally(cards: SurveyResponse[], months: string[]): SurveyTally {
  const columns = months.map((m) => ({ key: m, label: `${Number(m.slice(5, 7))}月`, title: m }));
  return tallyBy(cards, "month", columns, (s) => surveyKpiDate(s).slice(0, 7));
}

/** 店舗の列 (シートの合計の表。はがきの店舗) */
export function surveyTallyByStore(cards: SurveyResponse[], stores: { id: string; label: string }[]): SurveyTally {
  return tallyBy(cards, "store", stores.map((s) => ({ key: s.id, label: s.label })), (s) => s.storeId);
}

/** 集計表の CSV の行 (画面と同じ形。1 行目は見出し) */
export function tallyCsvRows(t: SurveyTally, extra: { label: string; values: (string | number)[]; total: string | number }[] = []): (string | number)[][] {
  const pct = (v: number | null) => (v === null ? "" : `${(v * 100).toFixed(1)}%`);
  const rows: (string | number)[][] = [["設問", "回答", ...t.columns.map((c) => c.label), "合計", "割合"]];
  rows.push(["回答数 (はがき)", "", ...t.cards, t.totalCards, ""]);
  for (const e of extra) rows.push([e.label, "", ...e.values, e.total, ""]);
  for (const s of t.sections) {
    s.rows.forEach((r, i) => rows.push([i === 0 ? `${s.no} ${s.question}` : "", r.answer, ...r.byCol, r.total, pct(r.share)]));
    rows.push(["", `回答したはがき`, ...t.columns.map(() => ""), s.respondents, ""]);
  }
  return rows;
}
