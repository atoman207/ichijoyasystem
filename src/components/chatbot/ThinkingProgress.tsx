"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import { BarChart3, BookOpen, Calculator, CalendarDays, Check, Database, FileSearch, History, LayoutDashboard, Loader2, Search, ShieldCheck, Sparkles, TrendingUp, type LucideIcon } from "lucide-react";
import type { AgentProgress } from "@/lib/assistant/agent";

/**
 * 「質問する」の回答を待つあいだの表示 (いま何をしているか・経過時間・進み具合)
 * ------------------------------------------------------------
 * /api/assistant/ask が送る途中の知らせ (AgentProgress) を順に並べる。進み具合の帯は、これまでの回答にかかった時間の
 * 平均 (ブラウザーに保存) を目安にした見込みで、回答が届くまでは 94% で止める (実際の残り時間ではない)
 */

export interface ProgressStep {
  id: string;
  name: string;
  label: string;
  status: "running" | "done";
  summary?: string;
}

export interface ProgressState {
  startedAt: number;
  phase: "thinking" | "prepare" | "checking" | "done";
  phaseLabel: string;
  steps: ProgressStep[];
  /** 途中の知らせが届いている (届かないときは経過時間だけで表示する) */
  live: boolean;
}

export const newProgress = (): ProgressState => ({ startedAt: Date.now(), phase: "thinking", phaseLabel: "質問を読み解いています", steps: [], live: false });

/** 途中の知らせを表示の状態に重ねる */
export function applyProgress(s: ProgressState, e: AgentProgress): ProgressState {
  if (e.type === "phase") return { ...s, live: true, phase: e.phase, phaseLabel: e.label };
  if (e.type !== "tool") return s;
  const i = s.steps.findIndex((x) => x.id === e.id);
  const step: ProgressStep = { id: e.id, name: e.name, label: e.label, status: e.status === "done" ? "done" : "running", summary: e.summary };
  const steps = i >= 0 ? s.steps.map((x, k) => (k === i ? { ...x, ...step } : x)) : [...s.steps, step];
  return { ...s, live: true, steps };
}

const ICON: Record<string, LucideIcon> = {
  search_records: Search,
  get_record: FileSearch,
  list_schedule: CalendarDays,
  suggest_schedule: CalendarDays,
  plan_schedule: CalendarDays,
  day_route: CalendarDays,
  schedule_holds: CalendarDays,
  schedule_setup: CalendarDays,
  analyze: BarChart3,
  management_accounting: BarChart3,
  query_database: Database,
  describe_database: Database,
  business_overview: LayoutDashboard,
  search_guides: BookOpen,
  search_history: History,
  calculate: Calculator,
  forecast: TrendingUp,
};

const STAGES = ["受付", "調査", "計算・確認", "回答の作成"] as const;
const CALC = new Set(["analyze", "query_database", "calculate", "forecast", "management_accounting", "business_overview"]);

function stageOf(s: ProgressState): number {
  if (s.phase === "checking") return 2;
  const running = s.steps.some((x) => x.status === "running");
  if (running) return s.steps.some((x) => x.status === "running" && CALC.has(x.name)) ? 2 : 1;
  if (s.steps.length) return 3;
  return s.live ? 1 : 0;
}

/* ---------------- 回答にかかった時間の目安 (ブラウザーに保存) ---------------- */

const MS_KEY = "ichijoya-chatbot-ms";

export function expectedAnswerMs(): number {
  try {
    const v = Number(localStorage.getItem(MS_KEY));
    if (Number.isFinite(v) && v > 500) return Math.min(60_000, v);
  } catch {
    /* 保存なし */
  }
  return 6000;
}

/** かかった時間を目安に重ねる (直近を重く見る平均) */
export function rememberAnswerMs(ms: number): void {
  try {
    const prev = expectedAnswerMs();
    localStorage.setItem(MS_KEY, String(Math.round(prev * 0.7 + Math.min(ms, 90_000) * 0.3)));
  } catch {
    /* 保存できない */
  }
}

export const fmtSeconds = (ms: number) => `${(ms / 1000).toFixed(1)} 秒`;

/* ---------------- 表示 ---------------- */

/** compact: 回答の文字が届きはじめたあとの 1 行の表示 (経過時間だけ) */
export function ThinkingProgress({ state, guest = false, className, compact = false }: { state: ProgressState; guest?: boolean; className?: string; compact?: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  const [expected] = useState(expectedAnswerMs);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(id);
  }, []);
  const ms = Math.max(0, now - state.startedAt);
  const ratio = Math.min(0.94, 1 - Math.exp(-ms / Math.max(1500, expected * 0.9)));
  const stage = stageOf(state);
  const running = state.steps.filter((x) => x.status === "running");
  if (compact) {
    return (
      <p className={clsx("flex items-center gap-1.5 px-1 text-[11px] text-ink-3", className)} role="status" aria-live="polite">
        <Loader2 className="h-3 w-3 animate-spin text-accent motion-reduce:animate-none" aria-hidden />
        {state.phase === "checking" ? "数字と根拠を確かめています" : "回答を書いています"}
        <span className="font-mono tabular-nums text-accent-ink">{fmtSeconds(ms)}</span>
      </p>
    );
  }
  const headline = running.length ? `${running.map((x) => x.label).join("・")}しています` : state.steps.length && state.phase !== "checking" ? "結果を読んで回答をまとめています" : guest ? "回答を考えています" : state.phaseLabel;

  return (
    <div className={clsx("w-full overflow-hidden rounded-2xl rounded-tl-sm border border-accent/20 bg-panel shadow-sm", className)} role="status" aria-live="polite" aria-busy="true">
      <div className="flex items-center gap-3 px-3.5 pt-3">
        {/* 回る光の輪 (考えている印) */}
        <span className="relative grid h-9 w-9 shrink-0 place-items-center" aria-hidden>
          <span className="absolute inset-0 animate-[spin_2.4s_linear_infinite] rounded-full bg-[conic-gradient(from_0deg,var(--color-accent),transparent_40%,var(--color-accent)_70%,transparent)] opacity-70 motion-reduce:animate-none" />
          <span className="absolute inset-[3px] rounded-full bg-panel" />
          <Sparkles className="relative h-4 w-4 text-accent" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-ink">{headline}…</p>
          <p className="text-[11px] text-ink-3">
            {state.phase === "checking" ? "答えの数字を、調べた結果と突き合わせています" : guest ? "使い方の資料から探しています" : "システムのデータを調べて、計算してから答えます"}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="font-mono text-base font-semibold tabular-nums text-accent-ink">{fmtSeconds(ms)}</p>
          <p className="text-[10px] text-ink-3">目安 約 {Math.max(1, Math.round(expected / 1000))} 秒</p>
        </div>
      </div>

      {/* 進み具合の帯 (見込み。届くまでは 94% で止まる) */}
      <div className="mx-3.5 mt-2.5 h-1.5 overflow-hidden rounded-full bg-subtle" aria-hidden>
        <div className="relative h-full rounded-full bg-gradient-to-r from-accent/60 via-accent to-accent/60 transition-[width] duration-300 ease-out" style={{ width: `${Math.round(ratio * 100)}%` }}>
          <span className="absolute inset-0 animate-pulse rounded-full bg-white/30 motion-reduce:animate-none" />
        </div>
      </div>

      {/* 段階 */}
      {!guest && (
        <ol className="mx-3.5 mt-2.5 grid grid-cols-4 gap-1 text-[10px]" aria-label="回答までの段階">
          {STAGES.map((label, i) => (
            <li key={label} className={clsx("flex items-center gap-1 truncate", i < stage ? "text-good-ink" : i === stage ? "font-semibold text-accent-ink" : "text-ink-3")}>
              <span className={clsx("grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full", i < stage ? "bg-good-soft" : i === stage ? "bg-accent-soft" : "bg-subtle")} aria-hidden>
                {i < stage ? <Check className="h-2.5 w-2.5" /> : <span className={clsx("h-1.5 w-1.5 rounded-full", i === stage ? "animate-pulse bg-accent motion-reduce:animate-none" : "bg-ink-3/40")} />}
              </span>
              <span className="truncate">{label}</span>
            </li>
          ))}
        </ol>
      )}

      {/* 調べていること (道具ごと) */}
      {state.steps.length > 0 && (
        <ul className="mx-2 mt-2 max-h-40 space-y-0.5 overflow-y-auto pb-1">
          {state.steps.map((x) => {
            const Icon = ICON[x.name] ?? Sparkles;
            return (
              <li key={x.id} className="flex items-start gap-2 rounded-lg px-1.5 py-1 text-xs animate-pop motion-reduce:animate-none">
                <span className={clsx("mt-px grid h-5 w-5 shrink-0 place-items-center rounded-md", x.status === "done" ? "bg-good-soft text-good-ink" : "bg-accent-soft text-accent-ink")} aria-hidden>
                  {x.status === "done" ? <Icon className="h-3 w-3" /> : <Loader2 className="h-3 w-3 animate-spin" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={clsx("font-medium", x.status === "done" ? "text-ink-2" : "text-ink")}>{x.label}</span>
                  {x.summary && <span className="block truncate text-[11px] text-ink-3">{x.summary}</span>}
                </span>
                {x.status === "done" && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-good" aria-label="完了" />}
              </li>
            );
          })}
        </ul>
      )}
      {state.phase === "checking" && (
        <p className="mx-3.5 mt-1 flex items-center gap-1.5 text-[11px] text-warn-ink">
          <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> 根拠を確かめ直しています
        </p>
      )}
      <div className="h-3" />
    </div>
  );
}
