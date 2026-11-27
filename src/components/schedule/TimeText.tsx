import clsx from "clsx";
import { AMPM_LABEL, ampmCounts, ampmOf, type AmPm } from "@/lib/ampm";

/**
 * 予定表の時間の表示 (お客様のご要望 2026-11-27「■3」): 午前 = オレンジ・午後 = 青の帯と文字、時間指定なしは灰色。
 * 色だけに頼らないよう、title とスクリーンリーダー向けに「午前」「午後」を添える。色は globals.css の --color-am・--color-pm
 */
export const AMPM_CLASS: Record<AmPm, string> = {
  am: "bg-am-soft text-am-ink",
  pm: "bg-pm-soft text-pm-ink",
  none: "text-ink-2",
};

export function TimeText({ e, text, className }: { e: { startTime?: string; slot?: string }; text: string; className?: string }) {
  const b = ampmOf(e);
  if (!text) return null;
  return (
    <span className={clsx("inline-flex shrink-0 items-center rounded px-1 font-semibold tnum", AMPM_CLASS[b], className)} title={AMPM_LABEL[b]} data-ampm={b}>
      {b !== "none" && <span className="sr-only">{AMPM_LABEL[b]} </span>}
      {text}
    </span>
  );
}

/** 日ごとの午前・午後の件数 (週・月・一覧の日の見出し)。どちらも 0 件なら出さない */
export function AmPmCounts({ list, className }: { list: { startTime?: string; slot?: string }[]; className?: string }) {
  const c = ampmCounts(list);
  if (!c.am && !c.pm) return null;
  return (
    <span className={clsx("inline-flex items-center gap-1 text-[10px] font-semibold tnum", className)} aria-label={`午前 ${c.am} 件・午後 ${c.pm} 件`} data-testid="ampm-counts">
      <span className="rounded bg-am-soft px-1 text-am-ink">午前 {c.am}</span>
      <span className="rounded bg-pm-soft px-1 text-pm-ink">午後 {c.pm}</span>
    </span>
  );
}
