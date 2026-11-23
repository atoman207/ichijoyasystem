import type { SurveyResponse } from "@/lib/db/types";
import { MEDIA_OPTIONS, PRIORITY_OPTIONS, SCORE_LABEL, SCORE_QUESTIONS, tallyAnswers } from "@/lib/survey";
import { surveyKpiDate } from "@/lib/kpi-core";

/**
 * アンケートの集計表 (スプレッドシートの「H26集計」〜「R4集計」と同じ形)
 * ------------------------------------------------------------
 * 行 = 設問 × 回答 (①〜④ は 大変不満〜大変満足、⑤ 重視したこと・⑥ 依頼のきっかけは選択肢 (複数回答)、⑦ 次回も依頼したいか)、
 * 列 = 集計月 + 合計 + 割合。割合の分母はその設問に答えたはがきの枚数 (シートの集計表の多くの表と同じ。⑤⑥ は複数回答のため合計が 100% を超える)。
 * 選択肢にない書き方 (移行データの「R」= 以前頼んだことがある など) は読み替え、自由記述は「その他」(survey.ts の tallyAnswers)
 */

export interface TallyRow {
  answer: string;
  byMonth: number[];
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
  months: string[];
  cards: number[];
  totalCards: number;
  sections: TallySection[];
}

export function surveyTally(cards: SurveyResponse[], months: string[]): SurveyTally {
  const idx = new Map(months.map((m, i) => [m, i]));
  const list = cards.filter((s) => idx.has(surveyKpiDate(s).slice(0, 7)));
  const monthOf = (s: SurveyResponse) => idx.get(surveyKpiDate(s).slice(0, 7))!;
  const perMonth = months.map(() => 0);
  for (const s of list) perMonth[monthOf(s)]++;
  const section = (no: string, question: string, answers: readonly string[], pick: (s: SurveyResponse) => string[]): TallySection => {
    const rows = new Map<string, number[]>(answers.map((a) => [a, months.map(() => 0)]));
    let respondents = 0;
    for (const s of list) {
      const got = pick(s);
      if (!got.length) continue;
      respondents++;
      for (const a of got) {
        if (!rows.has(a)) rows.set(a, months.map(() => 0));
        rows.get(a)![monthOf(s)]++;
      }
    }
    return {
      no,
      question,
      respondents,
      rows: [...rows.entries()].map(([answer, byMonth]) => {
        const total = byMonth.reduce((a, b) => a + b, 0);
        return { answer, byMonth, total, share: respondents ? total / respondents : null };
      }),
    };
  };
  const scoreAnswers = [1, 2, 3, 4, 5].map((n) => SCORE_LABEL[n]);
  const sections: TallySection[] = SCORE_QUESTIONS.map((q) => section(q.no, q.label, scoreAnswers, (s) => (typeof s[q.key] === "number" ? [SCORE_LABEL[s[q.key] as number]] : [])));
  sections.push(section("⑤", "ご利用にあたって重視されたこと (複数回答)", PRIORITY_OPTIONS, (s) => tallyAnswers(s.priorityList?.length ? s.priorityList : s.priorities, PRIORITY_OPTIONS).options));
  sections.push(section("⑥", "何を見てご依頼いただいたか (複数回答)", MEDIA_OPTIONS, (s) => tallyAnswers(s.mediaList?.length ? s.mediaList : s.media, MEDIA_OPTIONS).options));
  sections.push(
    section("⑦", "次回も依頼したいか", ["はい", "わからない", "いいえ"], (s) => {
      const v = s.wouldUseAgain ?? "";
      return /はい/.test(v) ? ["はい"] : /いいえ/.test(v) ? ["いいえ"] : /わから/.test(v) ? ["わからない"] : [];
    }),
  );
  return { months, cards: perMonth, totalCards: list.length, sections };
}
