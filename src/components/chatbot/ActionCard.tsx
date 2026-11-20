"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import { AlertTriangle, Check, Loader2, Play, X } from "lucide-react";
import Link from "@/components/ui/Link";
import { Button } from "@/components/ui";
import type { ProposedAction } from "@/lib/assistant/actions";

/**
 * AI アシスタントの実行の確認のカード (src/lib/assistant/actions.ts)
 * 内容を確かめて「実行する」を押すと /api/assistant/action が画面のボタンと同じ処理で実行する。AI は自分では実行しない
 */

type State = { phase: "idle" } | { phase: "running" } | { phase: "done" | "failed"; message: string; href?: string } | { phase: "cancelled" };

const DONE_KEY = "ichijoya.assistant.actions.v1";

function remembered(id: string): { ok: boolean; message: string; href?: string } | undefined {
  try {
    const all = JSON.parse(sessionStorage.getItem(DONE_KEY) ?? "{}") as Record<string, { ok: boolean; message: string; href?: string }>;
    return all[id];
  } catch {
    return undefined;
  }
}

function remember(id: string, r: { ok: boolean; message: string; href?: string }) {
  try {
    const all = JSON.parse(sessionStorage.getItem(DONE_KEY) ?? "{}") as Record<string, unknown>;
    all[id] = r;
    sessionStorage.setItem(DONE_KEY, JSON.stringify(all));
  } catch {
    /* 保存できなくても実行の結果はサーバーに残る */
  }
}

export function ActionCard({ action }: { action: ProposedAction }) {
  const [state, setState] = useState<State>(() => {
    if (typeof window === "undefined") return { phase: "idle" };
    const r = remembered(action.id);
    return r ? { phase: r.ok ? "done" : "failed", message: r.message, href: r.href } : { phase: "idle" };
  });
  // 確認の期限 (30 分) を過ぎたらボタンを消す
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setExpired(true), Math.max(0, new Date(action.expiresAt).getTime() - Date.now()));
    return () => clearTimeout(t);
  }, [action.expiresAt]);

  async function run() {
    setState({ phase: "running" });
    try {
      const res = await fetch("/api/assistant/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: action.token }) });
      const r = (await res.json().catch(() => null)) as { ok?: boolean; message?: string; href?: string } | null;
      const out = { ok: Boolean(r?.ok), message: r?.message || (res.ok ? "実行しました。" : "実行できませんでした。"), href: r?.href };
      setState({ phase: out.ok ? "done" : "failed", message: out.message, href: out.href });
      if (out.ok) remember(action.id, out);
    } catch {
      setState({ phase: "failed", message: "通信できませんでした。もう一度押してください。" });
    }
  }

  return (
    <div className={clsx("rounded-xl border bg-panel px-3 py-2.5 text-sm shadow-xs", action.danger ? "border-critical/30" : "border-accent/30")}>
      <div className="flex items-center gap-1.5 font-semibold text-ink">
        <Play className={clsx("h-3.5 w-3.5", action.danger ? "text-critical-ink" : "text-accent")} aria-hidden />
        {action.title}
        <span className="ml-auto text-[11px] font-normal text-ink-3">確認してから実行</span>
      </div>
      <dl className="mt-1.5 grid grid-cols-1 gap-x-3 gap-y-0.5 text-xs @xl:grid-cols-[auto_1fr]">
        {action.fields.map((f, i) => (
          <div key={i} className="contents">
            <dt className="text-ink-3">{f.label}</dt>
            <dd className="min-w-0 break-words text-ink">{f.value}</dd>
          </div>
        ))}
      </dl>
      {action.warnings.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 text-xs text-warn-ink">
          {action.warnings.map((w, i) => (
            <li key={i} className="flex gap-1">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
              <span>{w}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {state.phase === "idle" || state.phase === "running" ? (
          expired ? (
            <span className="text-xs text-ink-3">確認の期限 (30 分) が過ぎました。もう一度 AI アシスタントに頼んでください。</span>
          ) : (
            <>
              <Button type="button" size="sm" variant={action.danger ? "danger" : "primary"} disabled={state.phase === "running"} onClick={() => void run()}>
                {state.phase === "running" ? <Loader2 className="animate-spin" aria-hidden /> : <Check aria-hidden />}
                {state.phase === "running" ? "実行しています" : action.confirmLabel}
              </Button>
              <Button type="button" size="sm" variant="ghost" disabled={state.phase === "running"} onClick={() => setState({ phase: "cancelled" })}>
                <X aria-hidden />
                やめる
              </Button>
            </>
          )
        ) : state.phase === "cancelled" ? (
          <span className="text-xs text-ink-3">実行をやめました (何も変えていません)。</span>
        ) : (
          <div className={clsx("flex w-full flex-wrap items-center gap-2 rounded-lg px-2 py-1.5 text-xs", state.phase === "done" ? "bg-good-soft text-good-ink" : "bg-critical-soft text-critical-ink")}>
            {state.phase === "done" ? <Check className="h-3.5 w-3.5" aria-hidden /> : <AlertTriangle className="h-3.5 w-3.5" aria-hidden />}
            <span className="min-w-0 flex-1 break-words">{state.message}</span>
            {state.href && (
              <Link href={state.href} className="font-medium underline underline-offset-2">
                開く →
              </Link>
            )}
            {state.phase === "failed" && !expired && (
              <button type="button" className="font-medium underline underline-offset-2" onClick={() => void run()}>
                もう一度
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
