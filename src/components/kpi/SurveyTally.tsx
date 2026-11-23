import Link from "@/components/ui/Link";
import { Download } from "lucide-react";
import type { SurveyTally as Tally } from "@/lib/survey-tally";
import { Card, CardHeader } from "@/components/ui";

export interface TallyExtraRow {
  label: string;
  values: string[];
  total: string;
}

/**
 * アンケートの集計表 (シートの「集計」タブと同じ形: 設問 × 回答 × 列 + 合計 + 割合)。
 * 列は 月 (店舗ごとの表) か 店舗 (合計の表)。axisHref で切り替えのリンク、csvHref で CSV
 */
export function SurveyTally({ tally, scopeLabel, extraRows = [], axisHref, csvHref }: { tally: Tally; scopeLabel: string; extraRows?: TallyExtraRow[]; axisHref?: { month: string; store: string }; csvHref?: string }) {
  if (!tally.columns.length) return null;
  const byStore = tally.axis === "store";
  const tab = (active: boolean) => `rounded-md px-2 py-1 text-[11px] font-medium ${active ? "bg-accent text-white" : "border border-line text-ink-2 hover:bg-subtle"}`;
  return (
    <Card className="mt-4" padded={false} id="tally">
      <div className="px-5 pt-5">
        <CardHeader
          title={`アンケート集計表 ①〜⑦ (${scopeLabel})`}
          description={
            byStore
              ? "スプレッドシートの「R4集計」などの合計の表 (店舗 × 設問 × 回答) と同じ形です。割合 = その設問に答えたはがきの枚数に対する割合 (⑤⑥ は複数回答のため合計は 100% を超えます)。数えるはがきは KPI と同じ (担当の名前が未記入のはがきは数えない)"
              : "スプレッドシートの「H26集計」〜「R4集計」の店舗ごとの表と同じ形です。月 = はがきの集計月。割合 = その設問に答えたはがきの枚数に対する割合 (⑤⑥ は複数回答のため合計は 100% を超えます)"
          }
          action={
            <span className="flex flex-wrap items-center gap-1.5">
              {axisHref && (
                <>
                  <Link href={axisHref.month} className={tab(!byStore)} aria-current={!byStore ? "true" : undefined}>列: 月</Link>
                  <Link href={axisHref.store} className={tab(byStore)} aria-current={byStore ? "true" : undefined}>列: 店舗</Link>
                </>
              )}
              {csvHref && (
                <a href={csvHref} download className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[11px] font-medium text-ink-2 hover:bg-subtle hover:text-ink">
                  <Download className="h-3 w-3" aria-hidden /> CSV
                </a>
              )}
            </span>
          }
        />
      </div>
      <div className="max-h-[36rem] overflow-auto">
        <table className={`w-full text-[11px] ${byStore ? "min-w-[640px]" : "min-w-[880px]"}`} data-testid="survey-tally">
          <thead className="sticky top-0 z-10">
            <tr className="bg-subtle text-ink-2">
              <th className="sticky left-0 bg-subtle px-3 py-1.5 text-left font-medium">設問</th>
              <th className="px-2 py-1.5 text-left font-medium">回答</th>
              {tally.columns.map((c) => <th key={c.key} className="px-1.5 py-1.5 text-right font-medium" title={c.title}>{c.label}</th>)}
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
            {extraRows.map((e) => (
              <tr key={e.label} className="border-t border-line/40 bg-accent-soft/10">
                <td className="sticky left-0 bg-panel px-3 py-1 text-ink-2">{e.label}</td>
                <td />
                {e.values.map((v, i) => <td key={i} className="px-1.5 py-1 text-right tnum">{v}</td>)}
                <td className="px-2 py-1 text-right font-medium tnum">{e.total}</td>
                <td />
              </tr>
            ))}
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
                  {r.byCol.map((n, j) => <td key={j} className="px-1.5 py-1 text-right tnum">{n || ""}</td>)}
                  <td className="px-2 py-1 text-right font-medium tnum">{r.total}</td>
                  <td className="px-3 py-1 text-right tnum text-ink-2">{r.share === null ? "-" : `${(r.share * 100).toFixed(1)}%`}</td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>
      <p className="px-5 py-3 text-[11px] text-ink-3">⑤ 重視したこと・⑥ 依頼のきっかけで選択肢にない書き方は読み替えます (移行データの「R」= 以前頼んだことがある・「DM」= ダイレクトメール・「HP」= ホームページ など)。自由記述は「その他」に数えます。⑦ は はい・わからない・いいえ。①〜⑦ はインセンティブとは別の集計です (インセンティブに使うのは ①〜④ の平均)。</p>
    </Card>
  );
}
