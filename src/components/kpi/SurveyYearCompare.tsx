import type { CompareColumn } from "@/lib/survey-workbook/compare";
import { compareAnswers } from "@/lib/survey-workbook/compare";
import { Card, CardHeader } from "@/components/ui";

const SCORES: [string, string][] = [
  ["電話応対", "① 電話対応"],
  ["営業担当者", "② 営業の対応"],
  ["職人の対応", "③ 職人の対応"],
  ["工事の仕上り", "④ 工事の仕上がり"],
];

const pct = (n: number | undefined, d: number) => (d && n ? `${Math.round((n / d) * 1000) / 10}%` : "-");

/**
 * KPI → アンケート: 年度ごとの比較 (スプレッドシートの「4年比較」をすべての年度に広げたもの)。
 * 平成〜令和 4 年はスプレッドシートの集計表 (KPI → スプレッドシートの取込)、そのあとはシステムのはがき
 */
export function SurveyYearCompare({ cols, scopeLabel }: { cols: CompareColumn[]; scopeLabel: string }) {
  if (!cols.length) return null;
  const sheetYears = cols.filter((c) => c.source === "sheet").length;
  const priorities = compareAnswers(cols, "重視したこと").slice(0, 8);
  const media = compareAnswers(cols, "情報媒体").slice(0, 12);
  const row = (label: string, cells: string[], strong = false) => (
    <tr key={label} className="border-t border-line">
      <td className={`sticky left-0 bg-panel px-3 py-1.5 text-xs ${strong ? "font-medium text-ink" : "text-ink-2"}`}>{label}</td>
      {cells.map((v, i) => <td key={i} className="px-2 py-1.5 text-right text-xs tnum">{v}</td>)}
    </tr>
  );
  const head = (label: string) => (
    <tr key={`h-${label}`} className="bg-subtle/60"><td colSpan={cols.length + 1} className="px-3 py-1 text-[11px] font-medium text-ink-2">{label}</td></tr>
  );
  return (
    <Card className="mt-4" padded={false}>
      <div className="px-5 pt-5">
        <CardHeader
          title={`年度ごとの比較 (${scopeLabel})`}
          description={`${sheetYears ? "平成〜令和 4 年はスプレッドシート「お客様アンケート集計表」の集計表 (期間は表の見出し)、" : ""}そのあとはシステムのはがき (年度 = 12 月〜翌年 11 月)。割合の分母ははがきの枚数 (重視したこと・情報媒体は複数回答)`}
        />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="bg-subtle text-xs text-ink-2">
              <th className="sticky left-0 bg-subtle px-3 py-2 text-left font-medium">項目</th>
              {cols.map((c) => <th key={c.key} className="px-2 py-2 text-right font-medium" title={c.note}>{c.label}{c.source === "sheet" && <span className="block text-[10px] font-normal text-ink-3">集計表</span>}</th>)}
            </tr>
          </thead>
          <tbody>
            {row("はがきの枚数", cols.map((c) => c.cards.toLocaleString("ja-JP")), true)}
            {head("評価の平均 (5 段階)")}
            {SCORES.map(([q, label]) => row(label, cols.map((c) => (c.scores[q] === null || c.scores[q] === undefined ? "-" : c.scores[q]!.toFixed(2)))))}
            {row("次回も依頼したい「はい」", cols.map((c) => pct(c.answers["次回"]?.["はい"], Object.values(c.answers["次回"] ?? {}).reduce((a, v) => a + v, 0))))}
            {priorities.length > 0 && head("重視したこと (はがきの枚数に対する割合)")}
            {priorities.map((a) => row(a, cols.map((c) => pct(c.answers["重視したこと"]?.[a], c.cards))))}
            {media.length > 0 && head("情報媒体 (何を見て依頼したか)")}
            {media.map((a) => row(a, cols.map((c) => pct(c.answers["情報媒体"]?.[a], c.cards))))}
          </tbody>
        </table>
      </div>
      <p className="px-5 py-3 text-[11px] text-ink-3">集計表の「リピーター」は「以前頼んだことがある」、「ＨＰ」は「ホームページ」と同じ行にしています。令和の集計表の「工場」は合志店です。令和 3 年の集計表は回答数の行が 8 月で止まっているため、評価の回答の合計を枚数にしています。</p>
    </Card>
  );
}
