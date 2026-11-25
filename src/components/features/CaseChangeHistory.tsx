import Link from "@/components/ui/Link";
import type { Database } from "@/lib/db/types";
import { caseNotices, noticeTime } from "@/lib/change-notices";
import { Badge, Card, CardHeader } from "@/components/ui";

/**
 * この案件の変更の履歴 (お客様のご要望 2026-11-25「⑥ 変更履歴は案件ごとに保存し、後から確認できる形」)。
 * 問い合わせ・見積・受注のどの段階で変えたものも、案件としてまとめて新しい順に出す (変更のお知らせ = src/lib/change-notices.ts)
 */
export function CaseChangeHistory({ db, ids }: { db: Pick<Database, "changeNotices" | "users">; ids: (string | undefined)[] }) {
  const list = caseNotices(db, ids.filter((x): x is string => Boolean(x)));
  const name = (id: string) => db.users.find((u) => u.id === id)?.name ?? "-";
  return (
    <Card id="case-changes">
      <CardHeader title="この案件の変更の履歴" description="予定・明細・金額・担当・お客様・施工店舗などの変更 (いつ・誰が・何を・変更前 → 変更後)。問い合わせから受注までまとめて出します" action={<Link href="/notices?tab=all" className="text-xs text-accent hover:underline">変更のお知らせ</Link>} />
      {list.length === 0 ? (
        <p className="text-xs text-ink-3">まだ変更はありません。</p>
      ) : (
        <ol className="space-y-2" data-testid="case-change-history">
          {list.slice(0, 60).map((n) => (
            <li key={n.id} className="rounded-lg border border-line px-3 py-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="neutral" dot={false}>
                  {n.topic}
                </Badge>
                <span className="text-ink-3 tnum">{noticeTime(n.at)}</span>
                <span className="text-ink-2">{name(n.actorId)}</span>
              </div>
              <ul className="mt-1 space-y-0.5">
                {n.lines.map((l, i) => (
                  <li key={i} className="text-ink">
                    <span className="text-ink-3">{l.label}: </span>
                    {l.before && l.before !== "(空)" ? (
                      <>
                        <span className="text-ink-3 line-through decoration-ink-3/50">{l.before}</span>
                        <span className="mx-1 text-ink-3">→</span>
                      </>
                    ) : null}
                    <span className="font-medium">{l.after}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
          {list.length > 60 && <li className="text-[11px] text-ink-3">ほか {list.length - 60} 件 (変更のお知らせの一覧で絞り込めます)</li>}
        </ol>
      )}
    </Card>
  );
}
