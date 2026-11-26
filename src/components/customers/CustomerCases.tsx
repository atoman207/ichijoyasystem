import Link from "@/components/ui/Link";
import { INQUIRY_STATUS, INVOICE_STATUS, ORDER_STATUS, QUOTE_STATUS } from "@/lib/constants";
import { yen } from "@/lib/format";
import type { CaseGroupRow, CaseRow } from "@/lib/customer-cases";
export { customerCaseGroups, customerCaseRows } from "@/lib/customer-cases";
import { STAGE_TONE } from "@/lib/case-status";
import { Badge, Card, CardHeader, StatusBadge } from "@/components/ui";
import { ChevronDown, ClipboardList, FolderOpen } from "lucide-react";

/**
 * 顧客の画面の「案件の一覧」(お客様のご要望 2026-11-25「① 顧客情報画面の表示優先順位」):
 * 案件数・進行中の数字を押すとここに来る。進行中の案件と過去の案件を分け、1 行を押すと施工内容・明細・金額を開く
 * (受注の明細 = 見積 → 請求書 → 移行した受注は経過メモの「明細 (税抜|税込): …」)。受注・見積・請求書の画面へのリンクつき
 */

function StatusTag({ s }: { s: CaseRow["status"] }) {
  if (s.kind === "order")
    return (
      <span className="inline-flex flex-wrap gap-1">
        <StatusBadge value={s.value as keyof typeof ORDER_STATUS} map={ORDER_STATUS} />
        {s.invoice && <StatusBadge value={s.invoice as keyof typeof INVOICE_STATUS} map={INVOICE_STATUS} />}
      </span>
    );
  if (s.kind === "quote") return <StatusBadge value={s.value as keyof typeof QUOTE_STATUS} map={QUOTE_STATUS} />;
  return <StatusBadge value={s.value as keyof typeof INQUIRY_STATUS} map={INQUIRY_STATUS} />;
}

function CaseItem({ r }: { r: CaseRow }) {
  return (
    <li className="rounded-xl border border-line" data-testid="customer-case">
      <details className="group">
        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 hover:bg-subtle/60 [&::-webkit-details-marker]:hidden">
          <ChevronDown className="h-4 w-4 shrink-0 text-ink-3 transition-transform group-open:rotate-180" aria-hidden />
          <span className="text-xs text-ink-3 tnum">{r.dateLabel}</span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{r.title}</span>
          <StatusTag s={r.status} />
          {r.total !== undefined && <span className="text-sm font-semibold text-ink tnum">{yen(r.total)}</span>}
        </summary>
        <div className="space-y-2 border-t border-line px-3 py-2.5 text-xs">
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-ink-2">
            <span className="font-mono text-ink-3">{r.number}</span>
            {r.category && <span>種別: {r.category}</span>}
            {r.site && <span>施工場所: {r.site}</span>}
          </div>
          {r.work && (
            <div>
              <div className="font-medium text-ink">施工内容</div>
              <p className="whitespace-pre-wrap text-ink-2">{r.work}</p>
            </div>
          )}
          {r.lines.length > 0 ? (
            <div>
              <div className="font-medium text-ink">明細{r.linesNote ? <span className="ml-1 font-normal text-ink-3">{r.linesNote}</span> : null}</div>
              <div className="mt-1 overflow-x-auto">
                <table className="w-full min-w-[420px] text-xs">
                  <thead>
                    <tr className="text-ink-3">
                      <th className="py-1 text-left font-medium">品名・仕様</th>
                      <th className="py-1 text-right font-medium">数量</th>
                      <th className="py-1 text-right font-medium">単価</th>
                      <th className="py-1 text-right font-medium">金額</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.lines.map((l, i) => (
                      <tr key={i} className="border-t border-line/60">
                        <td className="py-1 pr-2 text-ink">
                          {l.name}
                          {l.spec ? <span className="text-ink-3"> ({l.spec})</span> : null}
                        </td>
                        <td className="py-1 text-right tnum">
                          {l.qty}
                          {l.unit ?? ""}
                        </td>
                        <td className="py-1 text-right tnum">{yen(l.unitPrice)}</td>
                        <td className="py-1 text-right tnum">{yen(l.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                  {r.totals && (
                    <tfoot>
                      {r.totals.map((t) => (
                        <tr key={t.label} className="border-t border-line/60">
                          <td colSpan={3} className="py-1 text-right text-ink-2">
                            {t.label}
                          </td>
                          <td className="py-1 text-right font-semibold tnum">{yen(t.value)}</td>
                        </tr>
                      ))}
                    </tfoot>
                  )}
                </table>
              </div>
            </div>
          ) : (
            r.total !== undefined && <p className="text-ink-3">明細の記録はありません (合計 {yen(r.total)})。</p>
          )}
          <div className="flex flex-wrap gap-2 pt-1">
            {r.links.map((l) => (
              <Link key={l.href} href={l.href} className="rounded-lg border border-line px-2 py-1 text-accent hover:border-accent/50 hover:bg-accent-soft/40">
                {l.label} を開く
              </Link>
            ))}
          </div>
        </div>
      </details>
    </li>
  );
}

/** 案件の一覧 (進行中 / 過去の案件)。過去の案件は新しい 30 件まで、all で全件 */
export function CustomerCasesCard({ rows, all, allHref }: { rows: CaseRow[]; all: boolean; allHref: string }) {
  const open = rows.filter((r) => r.open);
  const past = rows.filter((r) => !r.open);
  const shown = all ? past : past.slice(0, 30);
  return (
    <Card id="cases">
      <CardHeader title="案件の一覧" icon={<ClipboardList />} description="行を押すと施工内容・明細・金額が開きます。受注・見積・請求書の画面へも進めます" />
      <section id="cases-open" className="scroll-mt-24">
        <h3 className="mb-1.5 text-xs font-semibold text-ink-2">進行中の案件 ({open.length} 件)</h3>
        {open.length ? (
          <ul className="space-y-1.5">
            {open.map((r) => (
              <CaseItem key={r.key} r={r} />
            ))}
          </ul>
        ) : (
          <p className="text-xs text-ink-3">進行中の案件はありません</p>
        )}
      </section>
      <section id="cases-past" className="mt-4 scroll-mt-24">
        <h3 className="mb-1.5 text-xs font-semibold text-ink-2">過去の案件 ({past.length} 件)</h3>
        {past.length ? (
          <ul className="space-y-1.5">
            {shown.map((r) => (
              <CaseItem key={r.key} r={r} />
            ))}
          </ul>
        ) : (
          <p className="text-xs text-ink-3">過去の案件はありません</p>
        )}
        {shown.length < past.length && (
          <Link href={allHref} className="mt-2 inline-flex text-xs font-medium text-accent hover:underline">
            すべての案件を表示 (ほか {past.length - shown.length} 件)
          </Link>
        )}
      </section>
    </Card>
  );
}

/**
 * 顧客の画面の案件の一覧 (案件ごと。お客様のご要望 2026-11-26「■7 顧客詳細画面」): 進行中の案件 / 過去の案件履歴。
 * 1 つの案件 (src/lib/case-group.ts) に問い合わせ・見積・受注がいくつあっても 1 行。押すと案件の記録 (受注・見積・問い合わせ) と明細が開き、
 * 「案件の画面を開く」で見積・施工内容・金額・やりとり・写真・資料をすべて確認できる
 */
function CaseGroupItem({ g }: { g: CaseGroupRow }) {
  return (
    <li className="rounded-xl border border-line" data-testid="customer-case-group">
      <details className="group/c">
        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 hover:bg-subtle/60 [&::-webkit-details-marker]:hidden">
          <ChevronDown className="h-4 w-4 shrink-0 text-ink-3 transition-transform group-open/c:rotate-180" aria-hidden />
          <span className="text-xs text-ink-3 tnum">{g.dateLabel}</span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{g.title || "(件名なし)"}</span>
          <Badge tone={g.open ? STAGE_TONE[g.stage] : "neutral"}>{g.stageLabel}</Badge>
          {g.amount !== undefined && (
            <span className="text-sm font-semibold text-ink tnum" title={g.amountLabel}>
              {yen(g.amount)}
            </span>
          )}
        </summary>
        <div className="space-y-2 border-t border-line px-3 py-2.5 text-xs">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ink-2">
            <span>
              案件 <span className="font-mono text-ink">{g.number}</span>
            </span>
            <span>{g.detail}</span>
            <span className="text-ink-3">
              問い合わせ {g.counts.inquiries} · 見積 {g.counts.quotes} · 受注 {g.counts.orders}
            </span>
            <Link href={g.href} className="ml-auto inline-flex items-center gap-1 rounded-lg border border-accent/30 bg-accent-soft px-2.5 py-1 font-medium text-accent-ink hover:bg-accent-soft/70" data-testid="customer-case-open">
              <FolderOpen className="h-3.5 w-3.5" aria-hidden />
              案件の画面を開く
            </Link>
          </div>
          <ul className="space-y-1.5">
            {g.records.map((r) => (
              <CaseItem key={r.key} r={r} />
            ))}
          </ul>
        </div>
      </details>
    </li>
  );
}

export function CustomerCaseGroupsCard({ groups, all, allHref }: { groups: CaseGroupRow[]; all: boolean; allHref: string }) {
  const open = groups.filter((g) => g.open);
  const past = groups.filter((g) => !g.open);
  const shown = all ? past : past.slice(0, 30);
  return (
    <Card id="cases">
      <CardHeader title="案件" icon={<ClipboardList />} description="案件 = お問い合わせごとの箱 (見積・受注・予定・請求・写真をまとめる)。行を押すと見積・受注・明細が開き、「案件の画面を開く」でその案件のすべてを確認・操作できます" />
      <section id="cases-open" className="scroll-mt-24">
        <h3 className="mb-1.5 text-xs font-semibold text-ink-2">進行中の案件 ({open.length} 件)</h3>
        {open.length ? (
          <ul className="space-y-1.5">
            {open.map((g) => (
              <CaseGroupItem key={g.key} g={g} />
            ))}
          </ul>
        ) : (
          <p className="text-xs text-ink-3">進行中の案件はありません</p>
        )}
      </section>
      <section id="cases-past" className="mt-4 scroll-mt-24">
        <h3 className="mb-1.5 text-xs font-semibold text-ink-2">過去の案件 ({past.length} 件)</h3>
        {past.length ? (
          <ul className="space-y-1.5">
            {shown.map((g) => (
              <CaseGroupItem key={g.key} g={g} />
            ))}
          </ul>
        ) : (
          <p className="text-xs text-ink-3">過去の案件はありません</p>
        )}
        {shown.length < past.length && (
          <Link href={allHref} className="mt-2 inline-flex text-xs font-medium text-accent hover:underline">
            すべての案件を表示 (ほか {past.length - shown.length} 件)
          </Link>
        )}
      </section>
    </Card>
  );
}
