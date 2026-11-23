import type { SurveyTally as Tally } from "@/lib/survey-tally";
import { Card, CardHeader } from "@/components/ui";

const monthHead = (m: string) => `${Number(m.slice(5, 7))}月`;

/** アンケートの集計表 (シートの「集計」タブと同じ形: 設問 × 回答 × 月 + 合計 + 割合) */
export function SurveyTally({ tally, scopeLabel }: { tally: Tally; scopeLabel: string }) {
  if (!tally.months.length) return null;
  return (
    <Card className="mt-4" padded={false}>
      <div className="px-5 pt-5">
        <CardHeader
          title={`アンケート集計表 (${scopeLabel})`}
          description="スプレッドシートの「H26集計」〜「R4集計」と同じ形の表です。月 = はがきの集計月。割合 = その設問に答えたはがきの枚数に対する割合 (⑤⑥ は複数回答のため合計は 100% を超えます)"
        />
      </div>
      <div className="max-h-[36rem] overflow-auto">
        <table className="w-full min-w-[880px] text-[11px]">
          <thead className="sticky top-0 z-10">
            <tr className="bg-subtle text-ink-2">
              <th className="sticky left-0 bg-subtle px-3 py-1.5 text-left font-medium">設問</th>
              <th className="px-2 py-1.5 text-left font-medium">回答</th>
              {tally.months.map((m) => <th key={m} className="px-1.5 py-1.5 text-right font-medium" title={m}>{monthHead(m)}</th>)}
              <th className="px-2 py-1.5 text-right font-medium">合計</th>
              <th className="px-3 py-1.5 text-right font-medium">割合</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-t border-line bg-accent-soft/30 font-semibold">
              <td className="sticky left-0 bg-accent-soft/30 px-3 py-1">回答数 (はがき)</td>
              <td />
              {tally.cards.map((n, i) => <td key={i} className="px-1.5 py-1 text-right tnum">{n || ""}</td>)}
              <td className="px-2 py-1 text-right tnum">{tally.totalCards}</td>
              <td />
            </tr>
            {tally.sections.map((s) =>
              s.rows.map((r, i) => (
                <tr key={`${s.no}-${r.answer}`} className={`border-t ${i === 0 ? "border-line" : "border-line/40"}`}>
                  {i === 0 ? (
                    <td rowSpan={s.rows.length} className="sticky left-0 bg-panel px-3 py-1 align-top">
                      <span className="font-medium text-ink">{s.no} {s.question}</span>
                      <span className="block text-[10px] text-ink-3">回答 {s.respondents} 枚</span>
                    </td>
                  ) : null}
                  <td className="px-2 py-1 text-ink-2">{r.answer}</td>
                  {r.byMonth.map((n, j) => <td key={j} className="px-1.5 py-1 text-right tnum">{n || ""}</td>)}
                  <td className="px-2 py-1 text-right font-medium tnum">{r.total}</td>
                  <td className="px-3 py-1 text-right tnum text-ink-2">{r.share === null ? "-" : `${(r.share * 100).toFixed(1)}%`}</td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
