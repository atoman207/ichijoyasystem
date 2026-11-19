"use client";

import { Fragment, useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import clsx from "clsx";
import { Bot, Database, FileSearch, Loader2, SendHorizontal, Sparkles, Table2, ThumbsDown, ThumbsUp } from "lucide-react";
import Link from "@/components/ui/Link";
import { askChatbotAction, rateChatbotAnswer } from "@/lib/actions/chatbot";
import type { AnalysisResult, AnalysisSpec } from "@/lib/assistant/analyze";
import { AnalysisTable } from "./AnalysisTable";

/**
 * 「質問する」の会話 (画面左下のチャットボットと AI アシスタントの画面で共通)
 * - 会話はこのタブのあいだだけブラウザに保存する (sessionStorage)。サーバーには相談の履歴として残る (AI アシスタント → 相談の履歴)
 * - 集計の表・グラフ、回答の根拠 (記録・資料・集計)、調べた内容を回答の下に表示する
 * - 続けて質問すると、前の回答で使った集計の条件を引き継ぐ (「店舗別にして」「前年と比べて」)
 */

type Source = "database" | "data" | "smalltalk" | "ai" | "agent" | "analysis" | "docs" | "none";
interface Msg {
  role: "user" | "assistant";
  content: string;
  source?: Source;
  links?: { label: string; href: string }[];
  suggestions?: string[];
  qaId?: number;
  logId?: number;
  rated?: "up" | "down";
  tables?: AnalysisResult[];
  sources?: { label: string; href?: string; kind: string }[];
  tools?: { name: string; summary: string }[];
}

const STORAGE = "ichijoya-chatbot";
const STARTERS = ["今年の店舗別の売上と粗利を比較して", "来週の合志店の予定は？", "前年同期と比べて売上が減っている商品は？", "見積の作り方を教えて"];
const PAGE_STARTERS = [
  "今年4月1日から10月31日までの店舗別売上と粗利を比較して",
  "過去3年間の畳の品目別売上を比較して",
  "合志店の「きずな」の今年の販売数量と平均単価は？",
  "任意の期間の顧客別売上ランキングを出して (今年)",
  "前年同期と比べて売上が減っている商品は？",
  "来週の合志店の予定を教えて",
  "店長会議で決まったことを教えて",
  "問い合わせから入金までの操作手順を教えて",
];
const GUEST_STARTERS = ["このシステムは何ができる？", "ログインの仕方は？", "新規登録の流れは？", "見積の作り方を教えて"];

const SOURCE_LABEL: Partial<Record<Source, { label: string; icon: ReactNode; className: string }>> = {
  agent: { label: "システムのデータを調べて回答", icon: <FileSearch className="h-3 w-3" aria-hidden />, className: "bg-good-soft text-good-ink" },
  analysis: { label: "集計 (AI なし)", icon: <Table2 className="h-3 w-3" aria-hidden />, className: "bg-good-soft text-good-ink" },
  database: { label: "データベースから回答", icon: <Database className="h-3 w-3" aria-hidden />, className: "bg-good-soft text-good-ink" },
  data: { label: "社内データから回答", icon: <Database className="h-3 w-3" aria-hidden />, className: "bg-info-soft text-info-ink" },
  docs: { label: "資料から回答", icon: <Database className="h-3 w-3" aria-hidden />, className: "bg-neutral-soft text-ink-2" },
  ai: { label: "AI が資料をもとに回答", icon: <Sparkles className="h-3 w-3" aria-hidden />, className: "bg-accent-soft text-accent-ink" },
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

export function RichText({ text }: { text: string }) {
  const lines = text.replace(/^#{1,4}\s+/gm, "").split("\n");
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

const newConvId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** 保存する会話 (容量を超えないよう、古い表の行を減らす) */
function forStorage(msgs: Msg[]): Msg[] {
  const recent = msgs.slice(-30);
  return recent.map((m, i) => (m.tables?.length ? { ...m, tables: i < recent.length - 6 ? undefined : m.tables.map((t) => ({ ...t, rows: t.rows.slice(0, 80) })) } : m));
}

/** 会話の状態。画面左下のチャットボットと AI アシスタントの画面は別の会話 (storageKey) にする */
export function useChatState(storageKey = STORAGE) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [convId, setConvId] = useState("");
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? "null") as { open?: boolean; msgs?: Msg[]; convId?: string } | null;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- sessionStorage はブラウザでしか読めない
      if (saved?.msgs) setMsgs(saved.msgs.slice(-30));
      if (saved?.open) setOpen(true);
      setConvId(saved?.convId || newConvId());
    } catch {
      setConvId(newConvId());
    }
    setLoaded(true);
  }, [storageKey]);
  useEffect(() => {
    if (!loaded) return;
    try {
      sessionStorage.setItem(storageKey, JSON.stringify({ open, msgs: forStorage(msgs), convId }));
    } catch {
      try {
        sessionStorage.setItem(storageKey, JSON.stringify({ open, msgs: forStorage(msgs).map((m) => ({ ...m, tables: undefined })), convId }));
      } catch {
        /* 容量超過など */
      }
    }
  }, [open, msgs, loaded, convId, storageKey]);
  const reset = () => {
    setMsgs([]);
    setConvId(newConvId());
  };
  return { msgs, setMsgs, convId, open, setOpen, reset };
}

export function AssistantConversation({
  state,
  guest = false,
  userName,
  variant = "widget",
  wide = false,
  inputRef,
}: {
  state: ReturnType<typeof useChatState>;
  guest?: boolean;
  userName?: string;
  variant?: "widget" | "page";
  wide?: boolean;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const { msgs, setMsgs, convId } = state;
  const [input, setInput] = useState("");
  const [pending, startTransition] = useTransition();
  const [elapsed, setElapsed] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const ownRef = useRef<HTMLTextAreaElement>(null);
  const ref = inputRef ?? ownRef;

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs, pending]);

  useEffect(() => {
    if (!pending) return;
    const t0 = Date.now();
    const id = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 1000);
    return () => {
      clearInterval(id);
      setElapsed(0);
    };
  }, [pending]);

  const send = (text: string) => {
    const q = text.trim();
    if (!q || pending) return;
    const history = msgs.map(({ role, content, tables }) => ({ role, content, specs: tables?.map((t) => t.spec as AnalysisSpec) }));
    setMsgs((m) => [...m, { role: "user", content: q }]);
    setInput("");
    startTransition(async () => {
      try {
        const r = await askChatbotAction(history, q, convId);
        setMsgs((m) => [...m, { role: "assistant", content: r.answer, source: r.source as Source, links: r.links, suggestions: r.suggestions, qaId: r.qaId, logId: r.logId, tables: r.tables, sources: r.sources, tools: r.tools }]);
      } catch {
        setMsgs((m) => [...m, { role: "assistant", content: "通信に失敗しました。画面を再読み込みしてから、もう一度お試しください。", source: "none" }]);
      }
    });
  };

  const rate = (index: number, good: boolean) => {
    const msg = msgs[index];
    if ((!msg?.qaId && !msg?.logId) || msg.rated) return;
    setMsgs((m) => m.map((x, i) => (i === index ? { ...x, rated: good ? "up" : "down" } : x)));
    void rateChatbotAnswer(msg.qaId, good, msg.logId);
  };

  const first = (userName ?? "").split(/[\s　]/)[0] || userName;
  const starters = guest ? GUEST_STARTERS : variant === "page" ? PAGE_STARTERS : STARTERS;
  const bubbleMax = wide || variant === "page" ? "max-w-[92%]" : "max-w-[85%]";

  return (
    <>
      <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto bg-canvas px-3 py-4" aria-live="polite">
        <div className="flex gap-2">
          <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
            <Bot className="h-4 w-4" aria-hidden />
          </span>
          <div className={clsx(bubbleMax, "rounded-2xl rounded-tl-sm border border-line bg-panel px-3 py-2 text-sm leading-relaxed text-ink")}>
            {guest ? (
              <>
                こんにちは。一畳屋 統合業務システムの案内です。
                <br />
                システムの使い方や画面の場所、ログイン・新規登録についてお答えします。予定や売上などのデータは、ログイン後に聞けます。
              </>
            ) : (
              <>
                {first} さん、お疲れさまです。業務で分からないことは、まずここで聞いてください。
                <br />
                操作の手順、お客様・案件・予定・議事録の検索、売上や粗利の集計 (期間・店舗・商品・顧客・担当者を自由に組み合わせ) にお答えします。回答には根拠の記録を付けます。
              </>
            )}
          </div>
        </div>
        {msgs.length === 0 && (
          <div className="flex flex-wrap gap-1.5 pl-9">
            {starters.map((s) => (
              <button key={s} type="button" onClick={() => send(s)} className="rounded-full border border-accent/30 bg-panel px-3 py-1 text-left text-xs text-accent-ink hover:bg-accent-soft">
                {s}
              </button>
            ))}
          </div>
        )}
        {msgs.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="flex justify-end">
              <div className={clsx(bubbleMax, "rounded-2xl rounded-tr-sm bg-accent px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap text-white")}>{m.content}</div>
            </div>
          ) : (
            <div key={i} className="flex gap-2">
              <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
                <Bot className="h-4 w-4" aria-hidden />
              </span>
              <div className={clsx("min-w-0 space-y-1.5", m.tables?.length ? "flex-1" : bubbleMax)}>
                <div className="rounded-2xl rounded-tl-sm border border-line bg-panel px-3 py-2 text-sm leading-relaxed break-words text-ink">
                  <RichText text={m.content} />
                </div>
                {m.tables?.map((t, ti) => (
                  <AnalysisTable key={`${i}-${ti}`} result={t} compact={variant === "widget" && !wide} />
                ))}
                {m.links && m.links.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {m.links.map((l) => (
                      <Link key={l.href} href={l.href} className="rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-medium text-accent-ink hover:bg-accent hover:text-white">
                        {l.label} →
                      </Link>
                    ))}
                  </div>
                )}
                {m.sources && m.sources.length > 0 && (
                  <details className="rounded-lg border border-line bg-panel px-2.5 py-1.5 text-xs text-ink-2">
                    <summary className="cursor-pointer select-none font-medium text-ink-2 hover:text-ink">回答の根拠 ({m.sources.length})</summary>
                    <ul className="mt-1.5 space-y-1">
                      {m.sources.map((s, si) => (
                        <li key={si} className="flex items-start gap-1.5">
                          <span className="shrink-0 rounded bg-subtle px-1.5 py-px text-[10px] text-ink-3">{s.kind}</span>
                          {s.href ? (
                            <Link href={s.href} className="min-w-0 text-accent hover:underline">
                              {s.label}
                            </Link>
                          ) : (
                            <span className="min-w-0">{s.label}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                    {m.tools && m.tools.length > 0 && (
                      <div className="mt-1.5 border-t border-line pt-1.5 text-[11px] text-ink-3">
                        <p className="font-medium">調べた内容</p>
                        <ul>
                          {m.tools.map((t, ti) => (
                            <li key={ti}>
                              ・{t.name}: {t.summary}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </details>
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
                  {(m.qaId || m.logId) && (
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
            {guest ? "回答を考えています…" : elapsed < 4 ? "回答を考えています…" : `データを調べています… (${elapsed} 秒。集計は 1 分ほどかかることがあります)`}
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
          ref={ref}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send(input);
            }
          }}
          rows={variant === "page" ? 2 : 1}
          maxLength={1000}
          placeholder="質問を入力 (Enter で送信 / Shift+Enter で改行)"
          aria-label="質問"
          className="max-h-32 min-h-10 flex-1 resize-none rounded-xl border border-line bg-subtle px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:border-accent focus:bg-panel focus:outline-none"
        />
        <button type="submit" disabled={pending || !input.trim()} className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent text-white hover:bg-accent-hover disabled:opacity-40" aria-label="送信">
          <SendHorizontal className="h-4 w-4" aria-hidden />
        </button>
      </form>
    </>
  );
}
