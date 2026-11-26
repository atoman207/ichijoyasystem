import Link from "@/components/ui/Link";
import clsx from "clsx";
import { ArrowRight, Check, CircleDot, FolderOpen, Minus } from "lucide-react";
import { Badge } from "@/components/ui";
import type { CaseFlowView, StepState } from "@/lib/case-flow";

/**
 * 案件の流れ (受付 → 依頼 → 日程 → 見積 → 受注 → 施工 → 売上・請求 → 入金) と「次にやること」
 * (お客様のご要望 2026-11-24「■ 問い合わせ受付後の業務フロー ④⑦」)。問い合わせ・見積・受注の画面の上に置く
 */

const STATE_CLASS: Record<StepState, string> = {
  done: "border-good/40 bg-good-soft text-good-ink",
  current: "border-accent bg-accent-soft text-accent-ink ring-2 ring-accent/30",
  todo: "border-line bg-panel text-ink-3",
  skip: "border-dashed border-line bg-subtle/50 text-ink-3",
};

function StepIcon({ state }: { state: StepState }) {
  if (state === "done") return <Check className="h-3.5 w-3.5" aria-hidden />;
  if (state === "current") return <CircleDot className="h-3.5 w-3.5" aria-hidden />;
  if (state === "skip") return <Minus className="h-3.5 w-3.5" aria-hidden />;
  return <span className="h-2 w-2 rounded-full border border-current" aria-hidden />;
}

export function CaseFlowBar({ flow }: { flow: CaseFlowView }) {
  const steps = flow.steps.filter((s, i) => !(s.state === "skip" && i === 0));
  const next = flow.next;
  return (
    <section aria-label="案件の流れと次にやること" className="mb-4 rounded-2xl border border-line/70 bg-panel p-3 shadow-card" data-testid="case-flow">
      {/* 案件の画面 (この案件の問い合わせ・見積・受注・予定・請求・資料をまとめて見て、そこから操作する) */}
      {flow.caseRef && (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 border-b border-line/70 pb-2">
          <span className="text-xs text-ink-2">
            案件 <span className="font-mono font-medium text-ink">{flow.caseRef.number}</span>
            <span className="ml-2 text-ink-3">問い合わせ {flow.caseRef.inquiries} · 見積 {flow.caseRef.quotes} · 受注 {flow.caseRef.orders}</span>
          </span>
          <Link href={flow.caseRef.href} className="inline-flex items-center gap-1 rounded-lg border border-accent/30 bg-accent-soft px-2.5 py-1 text-xs font-medium text-accent-ink hover:bg-accent-soft/70" data-testid="case-flow-case">
            <FolderOpen className="h-3.5 w-3.5" aria-hidden />
            案件の画面を開く
          </Link>
        </div>
      )}
      <ol className="flex flex-wrap items-stretch gap-1.5">
        {steps.map((s, i) => {
          const body = (
            <>
              <span className="flex items-center gap-1 font-medium whitespace-nowrap">
                <StepIcon state={s.state} />
                {s.label}
              </span>
              {s.detail && <span className="block max-w-[11rem] truncate text-[10px] leading-tight opacity-90">{s.detail}</span>}
            </>
          );
          return (
            <li key={s.key} className="flex items-center gap-1.5">
              {s.href && s.state !== "todo" ? (
                <Link href={s.href} className={clsx("block rounded-lg border px-2 py-1 text-xs transition hover:brightness-95", STATE_CLASS[s.state])} aria-current={s.state === "current" ? "step" : undefined}>
                  {body}
                </Link>
              ) : (
                <span className={clsx("block rounded-lg border px-2 py-1 text-xs", STATE_CLASS[s.state])} aria-current={s.state === "current" ? "step" : undefined}>
                  {body}
                </span>
              )}
              {i < steps.length - 1 && <ArrowRight className="h-3 w-3 shrink-0 text-ink-3" aria-hidden />}
            </li>
          );
        })}
      </ol>
      {(next || flow.badge) && (
        <div className={clsx("mt-2.5 flex flex-col gap-2 rounded-xl px-3 py-2 @xl:flex-row @xl:items-center", next?.tone === "critical" ? "bg-critical-soft/70" : next?.tone === "warn" ? "bg-warn-soft/70" : "bg-subtle/70")}>
          <div className="min-w-0 flex-1 text-sm">
            <span className="mr-2 text-xs font-semibold text-ink-2">次にやること</span>
            {flow.badge && (
              <Badge tone={flow.badge.tone} dot={false} className="mr-2">
                {flow.badge.label}
              </Badge>
            )}
            <span className={clsx("font-medium", next?.tone === "critical" ? "text-critical-ink" : "text-ink")}>{next?.text ?? ""}</span>
            {next?.who && <span className="ml-2 text-xs text-ink-2">担当: {next.who}</span>}
          </div>
          {next?.href && next.button && (
            <Link href={next.href} className={clsx("inline-flex shrink-0 items-center justify-center gap-1 rounded-lg px-3 py-1.5 text-sm font-medium text-white", next.tone === "critical" ? "bg-critical hover:brightness-95" : "bg-accent hover:bg-accent-hover")} data-testid="case-flow-next">
              {next.button}
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          )}
        </div>
      )}
    </section>
  );
}
