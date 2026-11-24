"use client";

import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { CalendarDays, Eraser, ExternalLink, History, Maximize2, MessageCircleQuestion, Minimize2, X } from "lucide-react";
import Link from "@/components/ui/Link";
import { AssistantConversation, BotAvatar, useChatState } from "./AssistantChat";

/**
 * 画面左下の「質問する」(すべての画面に常に表示)。押すと画面の中央にモーダルで開く (背面は暗くして操作を止める。
 * 背面のクリック・Esc・閉じるボタンで閉じ、閉じたら「質問する」のボタンに戻る。Tab はモーダルの中だけを回る)。
 * ログインした社員には社内 AI アシスタント (使い方・横断検索・売上の分析・社内資料・過去の相談)、
 * ログイン前の公開ページでは使い方の案内だけ。回答の仕組みは src/lib/chatbot/answer.ts と src/lib/assistant/agent.ts
 */

/** guest: ログイン前の公開ページ用 (個人データ・社内資料は答えず、使い方の案内に限る) */
export function ChatbotWidget({ userName, userId, avatarSrc, guest = false }: { userName?: string; userId?: string; avatarSrc?: string; guest?: boolean }) {
  const state = useChatState();
  const { open, setOpen, msgs, reset } = state;
  const [wide, setWide] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    // 開いた直後にフォーカス。少し遅らせてパネル描画後に当てる
    const t = window.setTimeout(() => inputRef.current?.focus(), 40);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
      // Tab はモーダルの中だけを回る
      if (e.key === "Tab" && panelRef.current) {
        const items = [...panelRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter((el) => el.offsetParent !== null);
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        } else if (!panelRef.current.contains(document.activeElement)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    // モーダルのあいだは背面をスクロールさせない
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const launcher = launcherRef.current;
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
      // 閉じたら「質問する」のボタンに戻す
      launcher?.focus();
    };
  }, [open, setOpen]);

  // 表が出たら広げる (狭い画面では常に全画面)
  const hasTable = msgs.some((m) => m.tables?.length);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 表が初めて出たときに一度だけ広げる
    if (hasTable) setWide(true);
  }, [hasTable]);

  return (
    <>
      {/* 画面左下: 「質問する」と、スマートフォン・タブレットでは「予定表」(お客様のご要望 2026-11-24「追加 ⑤」: いつでもどこからでも予定表へ) */}
      <div className={clsx("fixed z-40 flex items-center gap-2", "bottom-[max(1rem,env(safe-area-inset-bottom))] left-[max(1rem,env(safe-area-inset-left))] sm:bottom-6 sm:left-6", open && "invisible")}>
        <button
          ref={launcherRef}
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="chatbot-panel"
          aria-label={open ? "チャットボットを閉じる" : "チャットボットに質問する"}
          className="group flex h-12 items-center gap-2 rounded-full bg-accent pr-4 pl-3 text-sm font-medium text-white shadow-pop transition-all hover:-translate-y-0.5 hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <span className="relative grid h-7 w-7 place-items-center rounded-full bg-white/15">
            {open ? <X className="h-4 w-4" aria-hidden /> : <MessageCircleQuestion className="h-4 w-4" aria-hidden />}
            {!open && <span className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-accent bg-good" aria-hidden />}
          </span>
          <span>{open ? "閉じる" : "質問する"}</span>
        </button>
        {!guest && (
          <Link href="/schedule" className="flex h-12 items-center gap-1.5 rounded-full border border-line bg-panel pr-4 pl-3 text-sm font-medium text-ink shadow-pop transition-all hover:-translate-y-0.5 hover:bg-subtle lg:hidden" data-testid="schedule-launcher">
            <CalendarDays className="h-5 w-5 text-accent" aria-hidden />
            予定表
          </Link>
        )}
      </div>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-6">
          {/* 背面を暗くして操作を止める (押すと閉じる) */}
          <button type="button" tabIndex={-1} className="absolute inset-0 animate-fade bg-ink/45 backdrop-blur-sm motion-reduce:animate-none" aria-label="チャットを閉じる" onClick={() => setOpen(false)} />
          <section
            ref={panelRef}
            id="chatbot-panel"
            role="dialog"
            aria-modal="true"
            aria-label={guest ? "システム案内のチャットボット" : "社内 AI アシスタント"}
            className={clsx(
              "relative flex h-full w-full flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-pop ring-1 ring-black/5 animate-pop motion-reduce:animate-none",
              wide ? "sm:h-[min(880px,100%)] sm:max-w-[1120px]" : "sm:h-[min(760px,100%)] sm:max-w-[760px]",
            )}
          >
            <header className="flex items-center gap-2 border-b border-line bg-accent-strong px-3 py-2.5 text-white sm:px-4 sm:py-3">
              <BotAvatar size={36} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{guest ? "システム案内" : "社内 AI アシスタント"}</p>
                <p className="truncate text-[11px] text-white/75">{guest ? "使い方・ログインについて" : "使い方・検索・分析・社内資料"}</p>
              </div>
              {!guest && (
                <>
                  <Link href="/ai" className="grid h-8 w-8 place-items-center rounded-lg text-white/80 hover:bg-white/10 hover:text-white" aria-label="大きな画面で開く" title="AI アシスタント画面で開く">
                    <ExternalLink className="h-4 w-4" aria-hidden />
                  </Link>
                  <Link href="/ai?tab=history" className="grid h-8 w-8 place-items-center rounded-lg text-white/80 hover:bg-white/10 hover:text-white" aria-label="相談の履歴" title="相談の履歴">
                    <History className="h-4 w-4" aria-hidden />
                  </Link>
                </>
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
            <AssistantConversation state={state} guest={guest} userName={userName} user={!guest && userId && userName ? { id: userId, name: userName, avatarSrc } : undefined} variant="widget" wide={wide} inputRef={inputRef} />
          </section>
        </div>
      )}
    </>
  );
}
