"use client";

import { useState, useTransition } from "react";
import { checkMessagingConnections, connectLineWebhook } from "@/lib/actions/line-groups";

type Result = { ok: boolean; lines: string[] };

function ResultBox({ title, r }: { title: string; r: Result }) {
  return (
    <div role="status" className={`rounded-lg px-3 py-2 text-xs ${r.ok ? "bg-good-soft text-good-ink" : "bg-warn-soft text-warn-ink"}`}>
      <div className="font-medium">{r.ok ? "✓ " : "⚠ "}{title}</div>
      <ul className="mt-1 space-y-0.5">{r.lines.map((l, i) => <li key={i} className="break-all">{l}</li>)}</ul>
    </div>
  );
}

/** 設定 → 外部連携・AI: LINE・Chatwork の接続の確認と、LINE の Webhook URL の設定 (ドメインを設定したあとに 1 回押す) */
export function MessagingConnectionCheck({ webhookReady }: { webhookReady: boolean }) {
  const [check, setCheck] = useState<{ line: Result; chatwork: Result } | null>(null);
  const [hook, setHook] = useState<Result | null>(null);
  const [pending, start] = useTransition();
  const btn = "inline-flex h-8 items-center rounded-lg border border-line bg-panel px-3 text-xs font-medium text-ink hover:bg-subtle disabled:opacity-50";
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={pending} className={btn} onClick={() => start(async () => setCheck(await checkMessagingConnections()))}>
          {pending ? "確認中…" : "LINE・Chatwork の接続を確認"}
        </button>
        <button type="button" disabled={pending || !webhookReady} className={btn} onClick={() => start(async () => setHook(await connectLineWebhook()))}>
          LINE の Webhook URL をこのシステムに設定
        </button>
      </div>
      {!webhookReady && <p className="text-[11px] text-ink-3">Webhook URL の設定は、APP_BASE_URL に https のドメインを設定して再起動すると使えます。</p>}
      {hook && <ResultBox title="LINE の Webhook URL" r={hook} />}
      {check && (
        <div className="grid grid-cols-1 gap-2 @xl:grid-cols-2">
          <ResultBox title="LINE" r={check.line} />
          <ResultBox title="Chatwork" r={check.chatwork} />
        </div>
      )}
    </div>
  );
}
