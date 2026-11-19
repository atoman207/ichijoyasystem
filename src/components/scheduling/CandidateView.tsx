"use client";

import { useState, useTransition } from "react";
import clsx from "clsx";
import { AlertTriangle, CalendarClock, ChevronDown, Factory, Loader2, MapPin, Truck, Users } from "lucide-react";
import Link from "@/components/ui/Link";
import type { Candidate } from "@/lib/scheduling/engine";
import { holdCandidatesAction, type HoldRequest } from "@/lib/actions/scheduling";
import { shortDate } from "@/lib/calendar";
import { buttonClass } from "@/components/ui";

/**
 * 候補 (日時・担当・車両・点数・理由・注意) の表示と、仮押さえのボタン
 * 計画の画面・案件の画面の「日程の提案」で共通
 */

export const SLOT_LABEL: Record<string, string> = { am: "午前", pm: "午後", day: "終日" };

export function scoreTone(score: number) {
  if (score >= 75) return "bg-good-soft text-good-ink";
  if (score >= 60) return "bg-info-soft text-info-ink";
  return "bg-neutral-soft text-ink-2";
}

export function whenLabel(c: Pick<Candidate, "date" | "endDate" | "startTime" | "endTime" | "slot">): string {
  return `${shortDate(c.date)}${c.endDate && c.endDate !== c.date ? `〜${shortDate(c.endDate)}` : ""} ${c.startTime ? `${c.startTime}${c.endTime ? `–${c.endTime}` : ""}` : SLOT_LABEL[c.slot ?? "day"]}`;
}

export function CandidateView({ c, compact = false, rank }: { c: Candidate; compact?: boolean; rank?: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {rank !== undefined && <span className="text-[11px] font-semibold text-ink-3">第 {rank} 候補</span>}
        <span className="text-sm font-semibold text-ink tnum">{whenLabel(c)}</span>
        <span className={clsx("rounded-full px-2 py-0.5 text-[11px] font-semibold tnum", scoreTone(c.score))}>{c.score} 点</span>
        {c.preference === "match" && <span className="rounded-full bg-good-soft px-2 py-0.5 text-[10px] text-good-ink">お客様の希望</span>}
        {c.helped && <span className="rounded-full bg-warn-soft px-2 py-0.5 text-[10px] text-warn-ink">応援</span>}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-ink-2">
        <span className="inline-flex items-center gap-1">
          <Users className="h-3.5 w-3.5 text-ink-3" aria-hidden />
          {(c.assigneeNames ?? []).join("・") || "担当未定"}
        </span>
        {c.travelMin !== undefined && (
          <span className="inline-flex items-center gap-1">
            <MapPin className="h-3.5 w-3.5 text-ink-3" aria-hidden />
            移動 約{c.travelMin}分{c.travelSource === "google" ? " (道路)" : " (目安)"}
          </span>
        )}
        {c.resourceNames && c.resourceNames.length > 0 && (
          <span className="inline-flex items-center gap-1">
            <Truck className="h-3.5 w-3.5 text-ink-3" aria-hidden />
            {c.resourceNames.join("・")}
          </span>
        )}
        {c.readyDate && (
          <span className="inline-flex items-center gap-1">
            <Factory className="h-3.5 w-3.5 text-ink-3" aria-hidden />
            {shortDate(c.readyDate)} 完成
          </span>
        )}
      </div>
      {c.warnings.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-[11px] text-warn-ink">
          {c.warnings.slice(0, compact ? 2 : 6).map((w) => (
            <li key={w} className="flex items-start gap-1">
              <AlertTriangle className="mt-px h-3 w-3 shrink-0" aria-hidden />
              {w}
            </li>
          ))}
        </ul>
      )}
      {c.reasons.length > 0 && (
        <>
          <button type="button" onClick={() => setOpen((v) => !v)} className="mt-1 inline-flex items-center gap-0.5 text-[11px] text-accent hover:underline" aria-expanded={open}>
            <ChevronDown className={clsx("h-3 w-3 transition", open && "rotate-180")} aria-hidden />
            理由
          </button>
          {open && (
            <ul className="mt-1 space-y-0.5 text-[11px] leading-relaxed text-ink-2">
              {c.reasons.map((r) => (
                <li key={r}>・{r}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

/** 候補を仮押さえする (第 1〜3 候補をまとめて)。押したあとは結果の文と計画の画面へのリンク */
export function HoldButton({ base, candidates, label = "仮押さえ", size = "sm", disabled }: { base: HoldRequest["base"]; candidates: Candidate[]; label?: string; size?: "sm" | "md"; disabled?: boolean }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (msg?.ok)
    return (
      <p className="text-xs text-good-ink">
        {msg.text}{" "}
        <Link href="/schedule/planning?tab=holds" className="font-medium text-accent hover:underline">
          仮押さえを見る →
        </Link>
      </p>
    );
  return (
    <div className="space-y-1">
      <button
        type="button"
        disabled={pending || disabled || !candidates.length}
        onClick={() =>
          start(async () => {
            try {
              const r = await holdCandidatesAction({ base, candidates });
              setMsg({ ok: r.ok, text: r.message });
            } catch {
              setMsg({ ok: false, text: "仮押さえできませんでした。画面を再読み込みしてから、もう一度お試しください。" });
            }
          })
        }
        className={buttonClass("secondary", size)}
        title="候補を仮押さえして、担当者に確認を依頼します (予定にはまだしません)"
      >
        {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <CalendarClock className="h-4 w-4" aria-hidden />}
        {label}
      </button>
      {msg && !msg.ok && <p className="text-xs text-critical-ink">{msg.text}</p>}
    </div>
  );
}

/** 一連の予定 (引き取り → 納品など) をまとめて仮押さえする */
export function ChainHoldButton({ steps, chainId }: { steps: { base: HoldRequest["base"]; candidates: Candidate[] }[]; chainId: string }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (msg?.ok)
    return (
      <p className="text-xs text-good-ink">
        {msg.text}{" "}
        <Link href="/schedule/planning?tab=holds" className="font-medium text-accent hover:underline">
          仮押さえを見る →
        </Link>
      </p>
    );
  return (
    <div className="space-y-1">
      <button
        type="button"
        disabled={pending || steps.some((s) => !s.candidates.length)}
        className={buttonClass("primary", "sm")}
        onClick={() =>
          start(async () => {
            const out: string[] = [];
            for (const s of steps) {
              const r = await holdCandidatesAction({ base: { ...s.base, chainId }, candidates: s.candidates }).catch(() => ({ ok: false, message: "仮押さえできませんでした。" }));
              if (!r.ok) {
                setMsg({ ok: false, text: r.message });
                return;
              }
              out.push(r.message.split("。")[0]);
            }
            setMsg({ ok: true, text: `${out.join("・")}。` });
          })
        }
      >
        {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <CalendarClock className="h-4 w-4" aria-hidden />}
        まとめて仮押さえ
      </button>
      {msg && !msg.ok && <p className="text-xs text-critical-ink">{msg.text}</p>}
    </div>
  );
}
