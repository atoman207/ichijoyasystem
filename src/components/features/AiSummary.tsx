"use client";

import { useState, useTransition } from "react";
import { Copy, Sparkles } from "lucide-react";
import { summarizeRecord } from "@/lib/actions/ai";

/**
 * 「AI で要約」(見積・受注・経費・顧客・問い合わせの詳細画面)
 * 押したときだけ要約する (保存しない)。AI の API キーがないときは記録から自動でまとめる
 */
export function AiSummary({ kind, id, label = "AI で要約" }: { kind: "quote" | "order" | "expense" | "customer" | "inquiry"; id: string; label?: string }) {
  const [result, setResult] = useState<{ text: string; provider: string; message?: string } | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [pending, start] = useTransition();
  const run = () =>
    start(async () => {
      setError("");
      setCopied(false);
      try {
        const r = await summarizeRecord(kind, id);
        if (!r.ok) setError(r.message ?? "要約できませんでした。");
        else setResult(r);
      } catch {
        setError("要約できませんでした。時間をおいてもう一度お試しください。");
      }
    });
  return (
    <div className="rounded-xl border border-line bg-panel p-3" data-testid="ai-summary">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-sm font-medium text-ink"><Sparkles className="h-4 w-4 text-accent" aria-hidden /> 要約</span>
        <button type="button" onClick={run} disabled={pending} className="rounded-lg border border-line px-3 py-1 text-xs font-medium text-accent hover:bg-accent-soft disabled:opacity-60">
          {pending ? "まとめています… (最大 50 秒)" : result ? "もう一度要約する" : label}
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-critical-ink">{error}</p>}
      {result && (
        <div className="mt-2">
          <div className="text-sm leading-relaxed whitespace-pre-wrap text-ink">{result.text}</div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-ink-3">
            <span>{result.provider === "openai" ? "OpenAI による要約" : result.provider === "claude" ? "Claude による要約" : "記録から自動でまとめました"}</span>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(result.text).then(() => setCopied(true));
              }}
              className="inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5 hover:bg-subtle"
            >
              <Copy className="h-3 w-3" aria-hidden /> {copied ? "コピーしました" : "コピー"}
            </button>
          </div>
          {result.message && <p className="mt-1 text-[11px] text-warn-ink">{result.message}</p>}
          <p className="mt-1 text-[11px] text-ink-3">要約は保存されません。内容は元の記録で確認してください。</p>
        </div>
      )}
    </div>
  );
}
