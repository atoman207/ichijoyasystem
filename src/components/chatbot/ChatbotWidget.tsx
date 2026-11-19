"use client";

import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { Bot, Eraser, History, Maximize2, MessageCircleQuestion, Minimize2, X } from "lucide-react";
import Link from "@/components/ui/Link";
import { AssistantConversation, useChatState } from "./AssistantChat";

/**
 * 画面左下の「質問する」(すべての画面に常に表示)。
 * ログインした社員には社内 AI アシスタント (使い方・横断検索・売上の分析・社内資料・過去の相談)、
 * ログイン前の公開ページでは使い方の案内だけ。回答の仕組みは src/lib/chatbot/answer.ts と src/lib/assistant/agent.ts
 */

/** guest: ログイン前の公開ページ用 (個人データ・社内資料は答えず、使い方の案内に限る) */
export function ChatbotWidget({ userName, guest = false }: { userName?: string; guest?: boolean }) {
  const state = useChatState();
  const { open, setOpen, msgs, reset } = state;
  const [wide, setWide] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  // 表が出たら広げる (狭い画面では常に全画面)
  const hasTable = msgs.some((m) => m.tables?.length);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 表が初めて出たときに一度だけ広げる
    if (hasTable) setWide(true);
  }, [hasTable]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="chatbot-panel"
        aria-label={open ? "チャットボットを閉じる" : "チャットボットに質問する"}
        className={clsx(
          "group fixed bottom-4 left-4 z-40 flex h-12 items-center gap-2 rounded-full bg-accent pr-4 pl-3 text-sm font-medium text-white shadow-pop transition-all hover:-translate-y-0.5 hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:bottom-6 sm:left-6",
          open && "max-sm:hidden",
        )}
      >
        <span className="relative grid h-7 w-7 place-items-center rounded-full bg-white/15">
          {open ? <X className="h-4 w-4" aria-hidden /> : <MessageCircleQuestion className="h-4 w-4" aria-hidden />}
          {!open && <span className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-accent bg-good" aria-hidden />}
        </span>
        <span>{open ? "閉じる" : "質問する"}</span>
      </button>

      {open && (
        <section
          id="chatbot-panel"
          role="dialog"
          aria-label={guest ? "システム案内のチャットボット" : "社内 AI アシスタント"}
          className={clsx(
            "fixed inset-x-2 top-16 bottom-2 z-50 flex flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-pop animate-pop sm:inset-x-auto sm:top-auto sm:bottom-20 sm:left-6",
            wide ? "sm:h-[min(820px,calc(100dvh-7rem))] sm:w-[min(920px,calc(100vw-3rem))]" : "sm:h-[min(600px,calc(100dvh-7rem))] sm:w-[400px]",
          )}
        >
          <header className="flex items-center gap-2 border-b border-line bg-accent-strong px-4 py-3 text-white">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white/15">
              <Bot className="h-5 w-5" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">{guest ? "システム案内" : "社内 AI アシスタント"}</p>
              <p className="truncate text-[11px] text-white/75">{guest ? "使い方・画面の場所・ログインについてお答えします" : "使い方・検索・売上の分析・社内資料にお答えします"}</p>
            </div>
            {!guest && (
              <Link href="/ai?tab=history" className="grid h-8 w-8 place-items-center rounded-lg text-white/80 hover:bg-white/10 hover:text-white" aria-label="相談の履歴" title="相談の履歴">
                <History className="h-4 w-4" aria-hidden />
              </Link>
            )}
            <button type="button" onClick={() => setWide((v) => !v)} className="hidden h-8 w-8 place-items-center rounded-lg text-white/80 hover:bg-white/10 hover:text-white sm:grid" aria-label={wide ? "小さくする" : "大きくする"} title={wide ? "小さくする" : "大きくする (表・グラフを見やすく)"}>
              {wide ? <Minimize2 className="h-4 w-4" aria-hidden /> : <Maximize2 className="h-4 w-4" aria-hidden />}
            </button>
            {msgs.length > 0 && (
              <button type="button" onClick={reset} className="grid h-8 w-8 place-items-center rounded-lg text-white/80 hover:bg-white/10 hover:text-white" aria-label="新しい会話にする" title="新しい会話にする">
                <Eraser className="h-4 w-4" aria-hidden />
              </button>
            )}
            <button type="button" onClick={() => setOpen(false)} className="grid h-8 w-8 place-items-center rounded-lg text-white/80 hover:bg-white/10 hover:text-white" aria-label="閉じる" title="閉じる (Esc)">
              <X className="h-4 w-4" aria-hidden />
            </button>
          </header>
          <AssistantConversation state={state} guest={guest} userName={userName} variant="widget" wide={wide} inputRef={inputRef} />
        </section>
      )}
    </>
  );
}
