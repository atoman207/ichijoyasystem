"use client";

import { useActionState, useRef, useState } from "react";
import { Copy, FileText } from "lucide-react";
import { draftDocumentAction } from "@/lib/actions/ai";
import Link from "@/components/ui/Link";

type State = { ok: boolean; text: string; provider: string; message?: string; used?: { label: string; href: string } } | null;

/** 資料・報告文の作成 (/ai?tab=draft)。下書きは保存しない (コピーしてメール・LINE・文書に貼る) */
export function DraftForm({ templates, formats, defaultRef, aiEnabled }: { templates: { id: string; label: string; audience: string; hint: string }[]; formats: { id: string; label: string }[]; defaultRef?: string; aiEnabled: boolean }) {
  const [state, action, pending] = useActionState<State, FormData>(draftDocumentAction, null);
  const box = useRef<HTMLTextAreaElement>(null);
  const [copiedFor, setCopiedFor] = useState<State>(null);
  const copied = Boolean(state) && copiedFor === state;
  return (
    <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-5">
      <form action={action} className="space-y-3 rounded-xl border border-line bg-panel p-4 @4xl:col-span-2">
        <label className="block">
          <span className="label">作るもの</span>
          <select name="template" defaultValue="quote_send" className="field">
            <optgroup label="お客様向け">
              {templates.filter((t) => t.audience === "customer").map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </optgroup>
            <optgroup label="社内・取引先向け">
              {templates.filter((t) => t.audience !== "customer").map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </optgroup>
          </select>
        </label>
        <label className="block">
          <span className="label">形式</span>
          <select name="format" defaultValue="email" className="field">
            {formats.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="label">関係する記録の番号 (任意)</span>
          <input name="ref" defaultValue={defaultRef} placeholder="例: Q-2026-0012 / O-2026-0034 / INQ-2026-0101 / INV-2026-0008 / C-00012" className="field" autoComplete="off" />
          <span className="mt-1 block text-[11px] text-ink-3">見積・受注・問い合わせ・請求の番号か顧客コード。内容 (お客様名・金額・日程) が文面に入ります</span>
        </label>
        <label className="block">
          <span className="label">要点・依頼 (任意)</span>
          <textarea name="notes" className="field min-h-[110px]" placeholder="例: 納品は 11/26 午後。当日は駐車場を 1 台分空けてほしい" />
        </label>
        <button type="submit" disabled={pending} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-accent px-4 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-60">
          <FileText className="h-4 w-4" aria-hidden /> {pending ? "作成中… (最大 50 秒)" : "下書きを作る"}
        </button>
        {!aiEnabled && <p className="text-[11px] text-ink-3">AI の API キーが未設定のため、ひな形に記録の内容を差し込んだ定型文になります。</p>}
      </form>
      <div className="rounded-xl border border-line bg-panel p-4 @4xl:col-span-3" data-testid="draft-result">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium text-ink">下書き</span>
          {state?.ok && state.text && (
            <button type="button" onClick={() => void navigator.clipboard?.writeText(box.current?.value ?? state.text).then(() => setCopiedFor(state))} className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs hover:bg-subtle">
              <Copy className="h-3.5 w-3.5" aria-hidden /> {copied ? "コピーしました" : "コピー"}
            </button>
          )}
        </div>
        {state && !state.ok && <p className="text-sm text-critical-ink">{state.message}</p>}
        {state?.ok ? (
          <>
            <textarea ref={box} key={state.text} defaultValue={state.text} className="field min-h-[360px] font-sans text-sm leading-relaxed" aria-label="下書き" />
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ink-3">
              <span>{state.provider === "openai" ? "OpenAI で作成" : state.provider === "claude" ? "Claude で作成" : "定型文"}</span>
              {state.used && <span>参照: <Link href={state.used.href} className="text-accent hover:underline">{state.used.label}</Link></span>}
              <span>下書きは保存されません。内容を確認・修正してから使ってください。</span>
            </div>
            {state.message && <p className="mt-1 text-[11px] text-warn-ink">{state.message}</p>}
          </>
        ) : (
          !state && <p className="text-sm text-ink-3">左の欄を入力して「下書きを作る」を押すと、ここに文面が表示されます。【 】の部分は記録にない情報です。埋めてから使ってください。</p>
        )}
      </div>
    </div>
  );
}
