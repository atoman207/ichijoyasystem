"use client";

import { Fragment, useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import clsx from "clsx";
import { Bot, Database, Eraser, Loader2, MessageCircleQuestion, SendHorizontal, Sparkles, ThumbsDown, ThumbsUp, X } from "lucide-react";
import Link from "@/components/ui/Link";
import { askChatbotAction, rateChatbotAnswer } from "@/lib/actions/chatbot";

/**
 * 画面左下のチャットボット (すべての画面に常に表示)。
 * 会話はこのタブのあいだだけ保存する (sessionStorage)。回答の仕組みは src/lib/chatbot/answer.ts
 */

type Source = "database" | "data" | "smalltalk" | "ai" | "docs" | "none";
interface Msg {
  role: "user" | "assistant";
  content: string;
  source?: Source;
  links?: { label: string; href: string }[];
  suggestions?: string[];
  qaId?: number;
  rated?: "up" | "down";
}

const STORAGE = "ichijoya-chatbot";
const STARTERS = ["見積の作り方を教えて", "経費の承認は誰がする？", "今日の予定は？", "パスワードを変えたい"];

const SOURCE_LABEL: Partial<Record<Source, { label: string; icon: ReactNode; className: string }>> = {
  database: { label: "データベースから回答", icon: <Database className="h-3 w-3" aria-hidden />, className: "bg-good-soft text-good-ink" },
  data: { label: "社内データから回答", icon: <Database className="h-3 w-3" aria-hidden />, className: "bg-info-soft text-info-ink" },
  docs: { label: "資料から回答", icon: <Database className="h-3 w-3" aria-hidden />, className: "bg-neutral-soft text-ink-2" },
  ai: { label: "AI が回答 (次回からはデータベースで回答)", icon: <Sparkles className="h-3 w-3" aria-hidden />, className: "bg-accent-soft text-accent-ink" },
};

/** **太字** と [名前](/画面) のリンクだけを表示に使う (アプリ内のパスのみリンクにする) */
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|\[([^\]]+)\]\((\/[^)\s]*)\)/g;
  let last = 0;
  let i = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(<strong key={`${key}-${i++}`}>{m[1]}</strong>);
    else
      out.push(
        <Link key={`${key}-${i++}`} href={m[3]} className="font-medium text-accent underline-offset-2 hover:underline">
          {m[2]}
        </Link>,
      );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function RichText({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <>
      {lines.map((line, i) => (
        <Fragment key={i}>
          {inline(line, String(i))}
          {i < lines.length - 1 && <br />}
        </Fragment>
      ))}
    </>
  );
}

export function ChatbotWidget({ userName }: { userName: string }) {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [pending, startTransition] = useTransition();
  const [loaded, setLoaded] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(STORAGE) ?? "null") as { open?: boolean; msgs?: Msg[] } | null;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- sessionStorage はブラウザでしか読めない
      if (saved?.msgs) setMsgs(saved.msgs.slice(-40));
      if (saved?.open) setOpen(true);
    } catch {
      /* 保存なし */
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    try {
      sessionStorage.setItem(STORAGE, JSON.stringify({ open, msgs: msgs.slice(-40) }));
    } catch {
      /* 容量超過など */
    }
  }, [open, msgs, loaded]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs, pending, open]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const send = (text: string) => {
    const q = text.trim();
    if (!q || pending) return;
    const history = msgs.map(({ role, content }) => ({ role, content }));
    setMsgs((m) => [...m, { role: "user", content: q }]);
    setInput("");
    startTransition(async () => {
      try {
        const r = await askChatbotAction(history, q);
        setMsgs((m) => [...m, { role: "assistant", content: r.answer, source: r.source, links: r.links, suggestions: r.suggestions, qaId: r.qaId }]);
      } catch {
        setMsgs((m) => [...m, { role: "assistant", content: "通信に失敗しました。画面を再読み込みしてから、もう一度お試しください。", source: "none" }]);
      }
    });
  };

  const rate = (index: number, good: boolean) => {
    const msg = msgs[index];
    if (!msg?.qaId || msg.rated) return;
    setMsgs((m) => m.map((x, i) => (i === index ? { ...x, rated: good ? "up" : "down" } : x)));
    void rateChatbotAnswer(msg.qaId, good);
  };

  const first = userName.split(/[\s　]/)[0] || userName;

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
          aria-label="システム案内のチャットボット"
          className="fixed inset-x-2 top-16 bottom-2 z-50 flex flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-pop animate-pop sm:inset-x-auto sm:top-auto sm:bottom-20 sm:left-6 sm:h-[min(600px,calc(100dvh-7rem))] sm:w-[400px]"
        >
          <header className="flex items-center gap-3 border-b border-line bg-accent-strong px-4 py-3 text-white">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white/15">
              <Bot className="h-5 w-5" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">システム案内</p>
              <p className="truncate text-[11px] text-white/75">使い方・画面の場所・権限・データの確認にお答えします</p>
            </div>
            {msgs.length > 0 && (
              <button type="button" onClick={() => setMsgs([])} className="grid h-8 w-8 place-items-center rounded-lg text-white/80 hover:bg-white/10 hover:text-white" aria-label="会話を消す" title="会話を消す">
                <Eraser className="h-4 w-4" aria-hidden />
              </button>
            )}
            <button type="button" onClick={() => setOpen(false)} className="grid h-8 w-8 place-items-center rounded-lg text-white/80 hover:bg-white/10 hover:text-white" aria-label="閉じる" title="閉じる (Esc)">
              <X className="h-4 w-4" aria-hidden />
            </button>
          </header>

          <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto bg-canvas px-3 py-4" aria-live="polite">
            <div className="flex gap-2">
              <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
                <Bot className="h-4 w-4" aria-hidden />
              </span>
              <div className="max-w-[85%] rounded-2xl rounded-tl-sm border border-line bg-panel px-3 py-2 text-sm leading-relaxed text-ink">
                {first} さん、お疲れさまです。システムのことなら何でも聞いてください。
                <br />
                操作の手順や画面の場所、権限のほか、「今日の予定」「未入金の請求」のようなデータの確認もできます。
              </div>
            </div>
            {msgs.length === 0 && (
              <div className="flex flex-wrap gap-1.5 pl-9">
                {STARTERS.map((s) => (
                  <button key={s} type="button" onClick={() => send(s)} className="rounded-full border border-accent/30 bg-panel px-3 py-1 text-xs text-accent-ink hover:bg-accent-soft">
                    {s}
                  </button>
                ))}
              </div>
            )}
            {msgs.map((m, i) =>
              m.role === "user" ? (
                <div key={i} className="flex justify-end">
                  <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-accent px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap text-white">{m.content}</div>
                </div>
              ) : (
                <div key={i} className="flex gap-2">
                  <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
                    <Bot className="h-4 w-4" aria-hidden />
                  </span>
                  <div className="min-w-0 max-w-[85%] space-y-1.5">
                    <div className="rounded-2xl rounded-tl-sm border border-line bg-panel px-3 py-2 text-sm leading-relaxed break-words text-ink">
                      <RichText text={m.content} />
                    </div>
                    {m.links && m.links.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {m.links.map((l) => (
                          <Link key={l.href} href={l.href} className="rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-medium text-accent-ink hover:bg-accent hover:text-white">
                            {l.label} →
                          </Link>
                        ))}
                      </div>
                    )}
                    {m.suggestions && m.suggestions.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {m.suggestions.map((s) => (
                          <button key={s} type="button" onClick={() => send(s)} className="rounded-full border border-line bg-panel px-2.5 py-0.5 text-left text-xs text-ink-2 hover:border-accent/40 hover:text-accent-ink">
                            {s}
                          </button>
                        ))}
                      </div>
                    )}
                    <div className="flex items-center gap-2 text-[11px] text-ink-3">
                      {m.source && SOURCE_LABEL[m.source] && (
                        <span className={clsx("inline-flex items-center gap-1 rounded-full px-2 py-0.5", SOURCE_LABEL[m.source]!.className)}>
                          {SOURCE_LABEL[m.source]!.icon}
                          {SOURCE_LABEL[m.source]!.label}
                        </span>
                      )}
                      {m.qaId && (
                        <span className="ml-auto flex items-center gap-0.5">
                          {m.rated ? (
                            <span>{m.rated === "up" ? "ありがとうございます" : "改善に使います"}</span>
                          ) : (
                            <>
                              <button type="button" onClick={() => rate(i, true)} className="grid h-6 w-6 place-items-center rounded hover:bg-good-soft hover:text-good-ink" aria-label="役に立った" title="役に立った">
                                <ThumbsUp className="h-3.5 w-3.5" aria-hidden />
                              </button>
                              <button type="button" onClick={() => rate(i, false)} className="grid h-6 w-6 place-items-center rounded hover:bg-critical-soft hover:text-critical-ink" aria-label="違っていた" title="違っていた">
                                <ThumbsDown className="h-3.5 w-3.5" aria-hidden />
                              </button>
                            </>
                          )}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ),
            )}
            {pending && (
              <div className="flex items-center gap-2 pl-9 text-xs text-ink-3">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                回答を考えています…
              </div>
            )}
          </div>

          <form
            className="flex items-end gap-2 border-t border-line bg-panel p-2.5"
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
          >
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send(input);
                }
              }}
              rows={1}
              maxLength={500}
              placeholder="質問を入力 (Enter で送信 / Shift+Enter で改行)"
              aria-label="質問"
              className="max-h-28 min-h-10 flex-1 resize-none rounded-xl border border-line bg-subtle px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:border-accent focus:bg-panel focus:outline-none"
            />
            <button type="submit" disabled={pending || !input.trim()} className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent text-white hover:bg-accent-hover disabled:opacity-40" aria-label="送信">
              <SendHorizontal className="h-4 w-4" aria-hidden />
            </button>
          </form>
        </section>
      )}
    </>
  );
}
