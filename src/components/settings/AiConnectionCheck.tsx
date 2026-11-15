"use client";

import { useState, useTransition } from "react";
import { checkAiConnection } from "@/lib/actions/settings";

/** 設定 → 外部連携・AI: 「接続を確認」(短い依頼を 1 回送り、結果を表示する) */
export function AiConnectionCheck({ enabled }: { enabled: boolean }) {
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="mt-3 space-y-2">
      <button
        type="button"
        disabled={pending || !enabled}
        onClick={() => start(async () => setResult(await checkAiConnection()))}
        className="inline-flex h-8 items-center rounded-lg border border-line bg-panel px-3 text-xs font-medium text-ink hover:bg-subtle disabled:opacity-50"
      >
        {pending ? "確認中… (最大 50 秒)" : "接続を確認"}
      </button>
      {!enabled && <p className="text-[11px] text-ink-3">API キーを設定すると確認できます。</p>}
      {result && (
        <p role="status" className={`rounded-lg px-3 py-2 text-xs ${result.ok ? "bg-good-soft text-good-ink" : "bg-critical-soft text-critical-ink"}`}>
          {result.ok ? "✓ " : "✕ "}
          {result.message}
        </p>
      )}
    </div>
  );
}
