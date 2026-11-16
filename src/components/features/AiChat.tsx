"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Bot, Send } from "lucide-react";
import { askAssistant } from "@/lib/actions/ai";
import type { ChatTurn } from "@/lib/ai/assistant";
import { Avatar } from "@/components/ui";
import Link from "@/components/ui/Link";

const SUGGESTIONS = ["今月の売上は？", "未入金の請求を教えて", "承認待ちの案件は？", "今日の予定", "未対応の問い合わせ", "施工中の現場の一覧", "今月の経費の内訳", "店舗ごとの比較", "支払方法は何が使える？", "見積送付のLINE文面を作って"];

/** 太字 (**…**) と、システム内の画面へのリンク ([番号](/orders/…)) だけを表示に反映する (外部の URL はリンクにしない) */
function renderInline(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*|\[[^\]]{1,80}\]\(\/[A-Za-z0-9/_?=&%.-]{1,200}\))/g);
  return parts.map((p, i) => {
    if (p.startsWith("**") && p.endsWith("**")) return <strong key={i}>{p.slice(2, -2)}</strong>;
    const m = /^\[([^\]]+)\]\((\/[^)]+)\)$/.exec(p);
    if (m && !m[2].startsWith("//")) return <Link key={i} href={m[2]} className="font-medium text-accent hover:underline">{m[1]}</Link>;
    return <span key={i}>{p}</span>;
  });
}

export function AiChat({ userName, userId, aiEnabled }: { userName: string; userId: string; aiEnabled: boolean }) {
  const [turns, setTurns] = useState<(ChatTurn & { provider?: string })[]>([
    { role: "assistant", content: `こんにちは、${userName} さん。一元化された社内データをもとに、売上・入金・承認・予定・問い合わせ・顧客履歴などの質問に答えます。${aiEnabled ? "" : "\n\n(AI の API キーが未設定のため、社内データから決まった形で回答します。キーを設定すると AI が自然文で応答し、文面作成や集計も行います)"}` },
  ]);
  const [input, setInput] = useState("");
  const [pending, start] = useTransition();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns]);

  function send(q: string) {
    const question = q.trim();
    if (!question || pending) return;
    const history = turns.map(({ role, content }) => ({ role, content }));
    setTurns((t) => [...t, { role: "user", content: question }]);
    setInput("");
    start(async () => {
      const reply = await askAssistant(history, question);
      setTurns((t) => [...t, { role: "assistant", content: reply.answer, provider: reply.provider }]);
    });
  }

  return (
    <div className="flex h-[calc(100vh-220px)] min-h-[480px] flex-col rounded-xl border border-line bg-panel">
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {turns.map((t, i) => (
          <div key={i} className={`flex gap-3 ${t.role === "user" ? "flex-row-reverse" : ""}`}>
            {t.role === "user" ? <Avatar name={userName} id={userId} size={30} /> : <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full bg-accent text-white"><Bot className="h-4 w-4" /></span>}
            <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${t.role === "user" ? "bg-subtle text-ink" : "border border-line text-ink"}`}>
              {renderInline(t.content)}
              {t.provider && <div className="mt-1 text-[10px] text-ink-3">{t.provider === "claude" ? "Claude による回答" : t.provider === "openai" ? "OpenAI による回答" : "社内データからの自動回答"}</div>}
            </div>
          </div>
        ))}
        {pending && (
          <div className="flex gap-3">
            <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full bg-accent text-white"><Bot className="h-4 w-4" /></span>
            <div className="rounded-2xl border border-line px-4 py-2.5 text-sm text-ink-3">考え中…</div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      <div className="border-t border-line p-3">
        <div className="mb-2 flex flex-wrap gap-1.5">
          {SUGGESTIONS.map((s) => (
            <button key={s} type="button" onClick={() => send(s)} className="rounded-full border border-line px-2.5 py-1 text-[11px] text-ink-2 hover:bg-subtle">{s}</button>
          ))}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
          className="flex gap-2"
        >
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="質問や依頼を入力 (例: 田中様の履歴 / O-2026-0012 の状況 / 支払方法は？)" className="field flex-1" />
          <button type="submit" disabled={pending || !input.trim()} className="inline-flex h-9 items-center gap-1 rounded-lg bg-accent px-4 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50">
            <Send className="h-4 w-4" /> 送信
          </button>
        </form>
      </div>
    </div>
  );
}
