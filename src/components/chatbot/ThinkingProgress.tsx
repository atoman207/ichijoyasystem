"use client";

import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { IchijoyaMark } from "@/components/brand/Logo";
import type { AgentProgress } from "@/lib/assistant/agent";

/**
 * 「質問する」の回答を待つあいだの表示
 * ------------------------------------------------------------
 * 待ち時間を短く感じられるよう、チャットでよくある「考え中」のドットと、一畳屋マークのゆるい動き、
 * 短い一言メッセージを出す。途中の知らせ (AgentProgress) は 1 行の状況にまとめ、段階の表や道具の一覧は出さない
 * (社員が迷わない・画面が騒がしくならない)。進み具合の帯はこれまでの回答時間の目安で、94% で止める
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

const TIPS_STAFF = [
  "少々お待ちください。データを確かめています",
  "もうしばらくお待ちください",
  "調べながら答えをまとめています",
  "数字は計算してからお伝えします",
  "あと少しでお答えできます",
] as const;

const TIPS_GUEST = [
  "少々お待ちください",
  "使い方の案内を探しています",
  "もうしばらくお待ちください",
] as const;

function statusLine(state: ProgressState, guest: boolean): string {
  if (state.phase === "checking") return "数字と根拠を確かめています";
  const running = state.steps.filter((x) => x.status === "running");
  if (running.length) return `${running.map((x) => x.label).join("・")}しています`;
  if (state.steps.length) return "結果を読んで回答をまとめています";
  if (guest) return "回答を考えています";
  return state.phaseLabel || "質問を読み解いています";
}

/** ゆるい待ちのドット (チャットの「入力中…」と同じ感覚) */
function WaitingDots({ className }: { className?: string }) {
  return (
    <span className={clsx("inline-flex items-end gap-1", className)} aria-hidden>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 rounded-full bg-accent/80 animate-wait-dot motion-reduce:animate-none"
          style={{ animationDelay: `${i * 0.16}s` }}
        />
      ))}
    </span>
  );
}

/** compact: 回答の文字が届きはじめたあとの 1 行の表示 */
export function ThinkingProgress({ state, guest = false, className, compact = false }: { state: ProgressState; guest?: boolean; className?: string; compact?: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  const [expected] = useState(expectedAnswerMs);
  const tips = guest ? TIPS_GUEST : TIPS_STAFF;
  const [tipIndex, setTipIndex] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => setTipIndex((n) => (n + 1) % tips.length), 3200);
    return () => window.clearInterval(id);
  }, [tips.length]);

  const ms = Math.max(0, now - state.startedAt);
  const ratio = Math.min(0.94, 1 - Math.exp(-ms / Math.max(1500, expected * 0.9)));
  const line = useMemo(() => statusLine(state, guest), [state, guest]);
  const tip = tips[tipIndex % tips.length];
  const doneCount = state.steps.filter((x) => x.status === "done").length;

  if (compact) {
    return (
      <p className={clsx("flex items-center gap-2 px-1 text-[11px] text-ink-3", className)} role="status" aria-live="polite">
        <WaitingDots />
        <span className="min-w-0 truncate">{state.phase === "checking" ? "数字と根拠を確かめています" : "回答を書いています"}</span>
        <span className="ml-auto shrink-0 font-mono tabular-nums text-accent-ink">{fmtSeconds(ms)}</span>
      </p>
    );
  }

  return (
    <div
      className={clsx("w-full overflow-hidden rounded-2xl rounded-tl-sm border border-accent/15 bg-panel shadow-sm", className)}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="flex items-center gap-3 px-3.5 pt-3.5 pb-1">
        {/* マークがゆるく上下する (待ち時間のあいだの目安) */}
        <span className="relative grid h-11 w-11 shrink-0 place-items-center" aria-hidden>
          <span className="absolute inset-0 rounded-full bg-accent-soft animate-wait-pulse motion-reduce:animate-none" />
          <span className="relative grid h-9 w-9 place-items-center rounded-full border border-line bg-white shadow-sm animate-wait-float motion-reduce:animate-none">
            <IchijoyaMark className="h-auto w-[58%]" />
          </span>
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-sm font-medium text-ink">
            <span className="truncate">{line}</span>
            <WaitingDots className="shrink-0" />
          </p>
          <p key={tip} className="mt-0.5 truncate text-[11px] text-ink-3 animate-fade motion-reduce:animate-none">
            {tip}
          </p>
        </div>
        <div className="shrink-0 text-right" title={`これまでの目安 約 ${Math.max(1, Math.round(expected / 1000))} 秒`}>
          <p className="font-mono text-sm font-semibold tabular-nums text-accent-ink">{fmtSeconds(ms)}</p>
          <p className="text-[10px] text-ink-3">お待ちください</p>
        </div>
      </div>

      {/* やわらかい進み具合 (見込み。届くまでは 94% で止まる) */}
      <div className="mx-3.5 mt-2.5 h-1.5 overflow-hidden rounded-full bg-subtle" aria-hidden>
        <div
          className="relative h-full rounded-full bg-accent/70 transition-[width] duration-500 ease-out"
          style={{ width: `${Math.round(ratio * 100)}%` }}
        >
          <span className="absolute inset-0 animate-wait-shine bg-linear-to-r from-transparent via-white/50 to-transparent motion-reduce:animate-none" />
        </div>
      </div>

      {/* 調べた内容は件数だけ (道具の一覧は出さない) */}
      {(doneCount > 0 || state.phase === "checking") && (
        <p className="mx-3.5 mt-2 mb-3 text-[11px] text-ink-3">
          {state.phase === "checking"
            ? "答えの数字を、調べた結果と突き合わせています"
            : guest
              ? "案内をまとめています"
              : `調べた項目 ${doneCount} 件 · 続けて確認しています`}
        </p>
      )}
      {doneCount === 0 && state.phase !== "checking" && <div className="h-3" />}
    </div>
  );
}
