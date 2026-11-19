"use client";

import { Fragment, useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import clsx from "clsx";
import { ArrowDown, AudioLines, Check, Copy, Database, FileSearch, Loader2, Mic, SendHorizontal, Sparkles, Square, Table2, ThumbsDown, ThumbsUp, Timer, UserRound, Volume2, VolumeX, X } from "lucide-react";
import Link from "@/components/ui/Link";
import { Avatar } from "@/components/ui";
import { IchijoyaMark } from "@/components/brand/Logo";
import { askChatbotAction, rateChatbotAnswer } from "@/lib/actions/chatbot";
import type { AnalysisResult, AnalysisSpec } from "@/lib/assistant/analyze";
import { AnalysisTable } from "./AnalysisTable";
import { browserCanListen, browserCanSpeak, canRecord, RATES, useRecorder, useSpeaker, type RecResult, type VoiceMode } from "./voice";
import { isStopPhrase } from "@/lib/speech-text";
import type { AgentProgress } from "@/lib/assistant/agent";
import { applyProgress, fmtSeconds, newProgress, rememberAnswerMs, ThinkingProgress, type ProgressState } from "./ThinkingProgress";

/**
 * 「質問する」の会話 (画面左下のチャットボットと AI アシスタントの画面で共通)
 * - 会話はこのタブのあいだだけブラウザに保存する (sessionStorage)。サーバーには相談の履歴として残る (AI アシスタント → 相談の履歴)
 * - 集計の表・グラフ、回答の根拠 (記録・資料・集計)、調べた内容を回答の下に表示する
 * - 続けて質問すると、前の回答で使った集計の条件を引き継ぐ (「店舗別にして」「前年と比べて」)
 * - 音声: マイクのボタンで話して質問し (話し終わると自動で送る)、回答を 20 代の日本人女性の声で読み上げる (./voice.ts)。
 *   声で聞いた質問の回答は自動で読み上げる。「読み上げ」をオンにすると、文字で聞いた回答も読み上げる
 * - 会話モード: 押すと、話す → 回答の要点を読み上げる → 読み終わると自動でまた聞く、をくり返す (手を使わずに続けて相談できる)。
 *   「終わり」「ありがとう」と言う・声が 2 回続けて聞こえない・Esc・「終わる」で終える。読み上げ中にマイクを押すと読み上げを止めて話せる
 * - 読み上げの速さ (0.9〜1.4 倍) はこのブラウザーに保存する。サーバーの音声入力が使えないときは、ブラウザーの音声認識に切り替える
 * - 顔: AI は一畳屋のマーク、質問した人はログインしている人の顔写真 (なければ名前の頭文字)
 */

type Source = "database" | "data" | "smalltalk" | "ai" | "agent" | "analysis" | "docs" | "none";
interface Msg {
  role: "user" | "assistant";
  content: string;
  /** 声で聞いた質問 */
  voice?: boolean;
  source?: Source;
  links?: { label: string; href: string }[];
  suggestions?: string[];
  qaId?: number;
  logId?: number;
  rated?: "up" | "down";
  tables?: AnalysisResult[];
  sources?: { label: string; href?: string; kind: string }[];
  tools?: { name: string; summary: string }[];
  /** 質問から回答までの時間 (ミリ秒) */
  ms?: number;
}

type Reply = Awaited<ReturnType<typeof askChatbotAction>>;

/** 途中で切れた (回答の作成はサーバーで始まっている) ので、もう一度送り直さない */
class StreamBroken extends Error {}

/**
 * 質問を /api/assistant/ask に送り、途中の知らせ (道具を使うたび) を受けながら回答を待つ。
 * 使えないとき (古いサーバー・通信の中継で溜められるなど) は、知らせが 1 つも届く前なら呼び出し元が Server Action に切り替える
 */
async function askStream(body: { history: unknown; question: string; convId: string; voice: boolean }, onEvent: (e: AgentProgress) => void): Promise<Reply> {
  const res = await fetch("/api/assistant/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
  if (!res.ok || !res.body || !(res.headers.get("content-type") ?? "").includes("ndjson")) throw new Error("stream unavailable");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let started = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buf += dec.decode(value, { stream: true });
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const m = JSON.parse(line) as { type: "progress"; event: AgentProgress } | { type: "done"; reply: Reply };
        started = true;
        if (m.type === "progress") onEvent(m.event);
        else if (m.type === "done") return m.reply;
      }
      if (done) break;
    }
  } catch (err) {
    if (started) throw new StreamBroken((err as Error).message);
    throw err;
  }
  if (started) throw new StreamBroken("stream ended");
  throw new Error("stream ended");
}

const STORAGE = "ichijoya-chatbot";
const READ_ALOUD = "ichijoya-chatbot-read-aloud";
/** 表示ラベルを短くし、押すと送る全文は question。ウィジェットの最初の画面が読みやすくなる */
const STARTERS: { label: string; question: string }[] = [
  { label: "店舗別の売上と粗利", question: "今年の店舗別の売上と粗利を比較して" },
  { label: "来週の合志店の予定", question: "来週の合志店の予定は？" },
  { label: "売上が減っている商品", question: "前年同期と比べて売上が減っている商品は？" },
  { label: "見積の作り方", question: "見積の作り方を教えて" },
];
const PAGE_STARTERS: { label: string; question: string }[] = [
  { label: "期間の店舗別売上・粗利", question: "今年4月1日から10月31日までの店舗別売上と粗利を比較して" },
  { label: "畳の品目別売上 (3年)", question: "過去3年間の畳の品目別売上を比較して" },
  { label: "きずなの数量・単価", question: "合志店の「きずな」の今年の販売数量と平均単価は？" },
  { label: "顧客別売上ランキング", question: "任意の期間の顧客別売上ランキングを出して (今年)" },
  { label: "売上が減っている商品", question: "前年同期と比べて売上が減っている商品は？" },
  { label: "来週の合志店の予定", question: "来週の合志店の予定を教えて" },
  { label: "店長会議の決定事項", question: "店長会議で決まったことを教えて" },
  { label: "問い合わせから入金まで", question: "問い合わせから入金までの操作手順を教えて" },
];
const GUEST_STARTERS: { label: string; question: string }[] = [
  { label: "何ができる？", question: "このシステムは何ができる？" },
  { label: "ログインの仕方", question: "ログインの仕方は？" },
  { label: "新規登録の流れ", question: "新規登録の流れは？" },
  { label: "見積の作り方", question: "見積の作り方を教えて" },
];

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

/** AI の顔 (一畳屋のマーク) */
export function BotAvatar({ size = 28 }: { size?: number }) {
  return (
    <span className="grid shrink-0 place-items-center rounded-full border border-line bg-white shadow-sm" style={{ width: size, height: size }} aria-hidden>
      <IchijoyaMark className="h-auto w-[62%]" />
    </span>
  );
}

export interface ChatUser {
  id: string;
  name: string;
  /** 顔写真の URL (/api/avatars/…)。なければ名前の頭文字 */
  avatarSrc?: string;
}

function UserAvatar({ user }: { user?: ChatUser }) {
  if (!user) {
    return (
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-subtle text-ink-3" aria-hidden>
        <UserRound className="h-4 w-4" />
      </span>
    );
  }
  return <Avatar name={user.name} id={user.id} size={28} src={user.avatarSrc} />;
}

const fmtSec = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

export function AssistantConversation({
  state,
  guest = false,
  userName,
  user,
  variant = "widget",
  wide = false,
  inputRef,
}: {
  state: ReturnType<typeof useChatState>;
  guest?: boolean;
  userName?: string;
  /** ログインしている人 (質問の横に顔写真を出す) */
  user?: ChatUser;
  variant?: "widget" | "page";
  wide?: boolean;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const { msgs, setMsgs, convId } = state;
  const [input, setInput] = useState("");
  const [pending, startTransition] = useTransition();
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [copied, setCopied] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const ownRef = useRef<HTMLTextAreaElement>(null);
  const ref = inputRef ?? ownRef;

  // 入力欄の高さを内容に合わせる (最大 8 行くらい)
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 40), 128)}px`;
  }, [input, ref]);

  // ---- 音声: サーバーの音声 (ログインした社員) かブラウザーの音声か ----
  const [voice, setVoice] = useState<{ tts: VoiceMode; stt: VoiceMode }>({ tts: "none", stt: "none" });
  const [readAloud, setReadAloud] = useState(false);
  useEffect(() => {
    const tts: VoiceMode = browserCanSpeak() ? "browser" : "none";
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 保存した設定はブラウザでしか読めない
      setReadAloud(localStorage.getItem(READ_ALOUD) === "1");
    } catch {
      /* 保存なし */
    }
    if (guest) {
      setVoice({ tts, stt: browserCanListen() ? "browser" : "none" });
      return;
    }
    let alive = true;
    fetch("/api/assistant/voice", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ tts?: boolean; stt?: boolean }>) : null))
      .then((s) => alive && setVoice({ tts: s?.tts ? "server" : tts, stt: s?.stt && canRecord() ? "server" : browserCanListen() ? "browser" : "none" }))
      .catch(() => alive && setVoice({ tts, stt: browserCanListen() ? "browser" : "none" }));
    return () => {
      alive = false;
    };
  }, [guest]);
  const toggleRead = () => {
    const next = !readAloud;
    setReadAloud(next);
    try {
      localStorage.setItem(READ_ALOUD, next ? "1" : "0");
    } catch {
      /* 保存できない */
    }
    if (!next) speaker.stop();
  };

  const speaker = useSpeaker(voice.tts);
  const sendRef = useRef<(text: string, opts?: { voice?: boolean }) => void>(() => {});

  // ---- 会話モード (話す → 読み上げ → また聞く) ----
  const [talk, setTalk] = useState(false);
  const talkRef = useRef(false);
  const emptyRef = useRef(0);
  const startRef = useRef<() => void>(() => {});
  const [talkNote, setTalkNote] = useState("");
  const endTalk = (note = "") => {
    talkRef.current = false;
    setTalk(false);
    emptyRef.current = 0;
    setTalkNote(note);
  };
  const listenAgain = () => {
    window.setTimeout(() => {
      if (talkRef.current) startRef.current();
    }, 350);
  };
  const onRecDone = (r: RecResult) => {
    if (!talkRef.current) return;
    if (r === "text") {
      emptyRef.current = 0;
      return;
    }
    if (r === "empty") {
      emptyRef.current++;
      if (emptyRef.current >= 2) endTalk("声が聞こえないため、会話モードを終えました。");
      else listenAgain();
      return;
    }
    endTalk(r === "error" ? "音声入力に失敗したため、会話モードを終えました。" : "");
  };
  const recorder = useRecorder(voice.stt, (text) => sendRef.current(text, { voice: true }), {
    onDone: onRecDone,
    onServerFail: () => setVoice((v) => ({ ...v, stt: browserCanListen() ? "browser" : "none" })),
  });
  const recording = recorder.state === "recording" || recorder.state === "starting";
  useEffect(() => {
    startRef.current = recorder.start;
  });
  useEffect(() => {
    if (!talk) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        recorder.cancel();
        speaker.stop();
        endTalk();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const toggleTalk = () => {
    if (talk) {
      recorder.cancel();
      speaker.stop();
      endTalk();
      return;
    }
    speaker.stop();
    speaker.unlock();
    talkRef.current = true;
    emptyRef.current = 0;
    setTalkNote("");
    setTalk(true);
    if (recorder.state === "idle") recorder.start();
  };

  const scrollToBottom = (smooth = true) => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    setAtBottom(true);
  };

  useEffect(() => {
    if (atBottom) scrollToBottom(true);
    // 新しいメッセージで下端にいるときだけ追従 (上にスクロールして読んでいるときは邪魔しない)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- atBottom の最新値で追従を決める
  }, [msgs, pending]);

  const copyAnswer = async (index: number, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(index);
      window.setTimeout(() => setCopied((v) => (v === index ? null : v)), 1600);
    } catch {
      /* 権限なしなど */
    }
  };

  const send = (text: string, opts: { voice?: boolean } = {}) => {
    const q = text.trim();
    if (!q || pending) return;
    speaker.stop();
    speaker.unlock();
    // 会話モードを終える言葉 (「終わり」「ありがとう」)
    if (opts.voice && talkRef.current && isStopPhrase(q)) {
      endTalk("会話モードを終えました。");
      if (voice.tts !== "none") void speaker.speak(-1, "はい。会話モードを終わります。", false);
      return;
    }
    const history = msgs.map(({ role, content, tables }) => ({ role, content, specs: tables?.map((t) => t.spec as AnalysisSpec) }));
    // 回答の位置 (読み上げに使う): 今の会話 + 質問 の次
    const answerIndex = msgs.length + 1;
    const speakAnswer = Boolean(opts.voice) || readAloud || talkRef.current;
    setMsgs((m) => [...m, { role: "user", content: q, voice: opts.voice || undefined }]);
    setInput("");
    setProgress(newProgress());
    startTransition(async () => {
      const t0 = Date.now();
      try {
        // ログインした社員: 途中の知らせつき (いま何を調べているかを表示)。使えなければ Server Action
        let r: Reply;
        if (guest) r = await askChatbotAction(history, q, convId, { voice: Boolean(opts.voice) });
        else {
          try {
            r = await askStream({ history, question: q, convId, voice: Boolean(opts.voice) }, (e) => setProgress((p) => (p ? applyProgress(p, e) : p)));
          } catch (err) {
            if (err instanceof StreamBroken) throw err;
            r = await askChatbotAction(history, q, convId, { voice: Boolean(opts.voice) });
          }
        }
        const ms = Date.now() - t0;
        rememberAnswerMs(ms);
        setProgress(null);
        setMsgs((m) => [...m, { role: "assistant", content: r.answer, source: r.source as Source, links: r.links, suggestions: r.suggestions, qaId: r.qaId, logId: r.logId, tables: r.tables, sources: r.sources, tools: r.tools, ms }]);
        if (speakAnswer && voice.tts !== "none") void speaker.speak(answerIndex, r.answer, Boolean(r.tables?.length), { brief: talkRef.current, onEnd: () => talkRef.current && listenAgain() });
        else if (talkRef.current) listenAgain();
      } catch {
        setProgress(null);
        setMsgs((m) => [...m, { role: "assistant", content: "通信に失敗しました。画面を再読み込みしてから、もう一度お試しください。", source: "none" }]);
        if (talkRef.current) endTalk("通信に失敗したため、会話モードを終えました。");
      }
    });
  };
  useEffect(() => {
    sendRef.current = send;
  });

  const startVoice = () => {
    // 押した操作の中で、あとから回答を再生できるようにしておく (iPhone など)
    speaker.stop();
    speaker.unlock();
    recorder.start();
  };

  const rate = (index: number, good: boolean) => {
    const msg = msgs[index];
    if ((!msg?.qaId && !msg?.logId) || msg.rated) return;
    setMsgs((m) => m.map((x, i) => (i === index ? { ...x, rated: good ? "up" : "down" } : x)));
    void rateChatbotAnswer(msg.qaId, good, msg.logId);
  };

  const first = (user?.name ?? userName ?? "").split(/[\s　]/)[0] || userName;
  const starters = guest ? GUEST_STARTERS : variant === "page" ? PAGE_STARTERS : STARTERS;
  const bubbleMax = wide || variant === "page" ? "max-w-[92%]" : "max-w-[85%]";
  const voiceError = recorder.error || speaker.error;

  return (
    <>
      <div className="relative min-h-0 flex-1">
        <div
          ref={listRef}
          className="h-full space-y-3 overflow-y-auto overscroll-contain bg-canvas px-3 py-4 scroll-smooth"
          aria-live="polite"
          onScroll={() => {
            const el = listRef.current;
            if (!el) return;
            setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 96);
          }}
        >
          <div className="flex gap-2">
            <BotAvatar />
            <div className={clsx(bubbleMax, "rounded-2xl rounded-tl-sm border border-line bg-panel px-3 py-2.5 text-sm leading-relaxed text-ink")}>
              {guest ? (
                <>
                  こんにちは。システムの使い方・ログイン・新規登録についてお答えします。
                  {variant === "page" && <span className="mt-1 block text-xs text-ink-3">予定や売上などのデータは、ログイン後に聞けます。</span>}
                </>
              ) : variant === "widget" ? (
                <>
                  {first} さん、お疲れさまです。使い方・検索・売上の集計など、気軽に聞いてください。
                  {voice.stt !== "none" && <span className="mt-1 block text-xs text-ink-3">マイクで声の質問もできます。</span>}
                </>
              ) : (
                <>
                  {first} さん、お疲れさまです。操作の手順、お客様・案件・予定の検索、売上や粗利の集計にお答えします。回答には根拠を付けます。
                  {voice.stt !== "none" && <span className="mt-1 block text-xs text-ink-3">マイクのボタンで声の質問ができます。回答も読み上げます。</span>}
                </>
              )}
            </div>
          </div>
          {msgs.length === 0 && (
            <div className="space-y-1.5 pl-9">
              <p className="text-[11px] font-medium text-ink-3">よくある質問</p>
              <div className="flex flex-wrap gap-1.5">
                {starters.map((s) => (
                  <button
                    key={s.question}
                    type="button"
                    disabled={pending}
                    title={s.question}
                    onClick={() => send(s.question)}
                    className="rounded-full border border-accent/25 bg-panel px-3 py-1.5 text-left text-xs text-accent-ink transition hover:border-accent/50 hover:bg-accent-soft disabled:opacity-40"
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          {msgs.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="flex justify-end gap-2">
                <div className={clsx(bubbleMax, "rounded-2xl rounded-tr-sm bg-accent px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap text-white")}>
                  {m.voice && <Mic className="mr-1 inline h-3.5 w-3.5 -translate-y-px opacity-80" aria-label="声で質問" />}
                  {m.content}
                </div>
                <UserAvatar user={user} />
              </div>
            ) : (
              <div key={i} className="flex gap-2">
                <BotAvatar />
                <div className={clsx("min-w-0 space-y-1.5", m.tables?.length ? "flex-1" : bubbleMax)}>
                  <div className={clsx("rounded-2xl rounded-tl-sm border bg-panel px-3 py-2.5 text-sm leading-relaxed break-words text-ink", speaker.speakingId === i ? "border-accent/50 ring-2 ring-accent/15" : "border-line")}>
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
                        <button key={s} type="button" disabled={pending} onClick={() => send(s)} className="rounded-full border border-line bg-panel px-2.5 py-0.5 text-left text-xs text-ink-2 hover:border-accent/40 hover:text-accent-ink disabled:opacity-40">
                          {s}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-3">
                    {m.source && SOURCE_LABEL[m.source] && (
                      <span className={clsx("inline-flex items-center gap-1 rounded-full px-2 py-0.5", SOURCE_LABEL[m.source]!.className)}>
                        {SOURCE_LABEL[m.source]!.icon}
                        <span className={variant === "widget" ? "max-sm:sr-only" : undefined}>{SOURCE_LABEL[m.source]!.label}</span>
                      </span>
                    )}
                    {typeof m.ms === "number" && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-subtle px-2 py-0.5 tabular-nums" title={m.tools?.length ? `調べた内容 ${m.tools.length} 件` : undefined}>
                        <Timer className="h-3 w-3" aria-hidden />
                        {fmtSeconds(m.ms)}
                        {m.tools?.length ? <span className="max-sm:hidden">・調べた内容 {m.tools.length} 件</span> : null}
                      </span>
                    )}
                    <span className="ml-auto flex items-center gap-0.5">
                      <button
                        type="button"
                        onClick={() => void copyAnswer(i, m.content)}
                        className="grid h-6 w-6 place-items-center rounded hover:bg-subtle hover:text-ink"
                        aria-label={copied === i ? "コピーしました" : "回答をコピー"}
                        title={copied === i ? "コピーしました" : "回答をコピー"}
                      >
                        {copied === i ? <Check className="h-3.5 w-3.5 text-good" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
                      </button>
                      {voice.tts !== "none" &&
                        (speaker.speakingId === i ? (
                          <button type="button" onClick={speaker.stop} className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-accent-ink hover:bg-accent-soft" aria-label="読み上げを止める" title="読み上げを止める">
                            <Square className="h-3 w-3 fill-current" aria-hidden /> 止める
                          </button>
                        ) : speaker.loadingId === i ? (
                          <span className="grid h-6 w-6 place-items-center" aria-label="読み上げの準備中">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                          </span>
                        ) : (
                          <button type="button" onClick={() => void speaker.speak(i, m.content, Boolean(m.tables?.length))} className="grid h-6 w-6 place-items-center rounded hover:bg-accent-soft hover:text-accent-ink" aria-label="回答を読み上げる" title="回答を読み上げる">
                            <Volume2 className="h-3.5 w-3.5" aria-hidden />
                          </button>
                        ))}
                      {(m.qaId || m.logId) &&
                        (m.rated ? (
                          <span className="px-1">{m.rated === "up" ? "ありがとうございます" : "改善に使います"}</span>
                        ) : (
                          <>
                            <button type="button" onClick={() => rate(i, true)} className="grid h-6 w-6 place-items-center rounded hover:bg-good-soft hover:text-good-ink" aria-label="役に立った" title="役に立った">
                              <ThumbsUp className="h-3.5 w-3.5" aria-hidden />
                            </button>
                            <button type="button" onClick={() => rate(i, false)} className="grid h-6 w-6 place-items-center rounded hover:bg-critical-soft hover:text-critical-ink" aria-label="違っていた" title="違っていた">
                              <ThumbsDown className="h-3.5 w-3.5" aria-hidden />
                            </button>
                          </>
                        ))}
                    </span>
                  </div>
                </div>
              </div>
            ),
          )}
          {pending && progress && (
            <div className="flex gap-2" aria-busy="true">
              <BotAvatar />
              <div className={clsx(bubbleMax, "min-w-0 flex-1")}>
                <ThinkingProgress state={progress} guest={guest} />
              </div>
            </div>
          )}
        </div>
        {!atBottom && (
          <button
            type="button"
            onClick={() => scrollToBottom(true)}
            className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full border border-line bg-panel px-3 py-1.5 text-xs font-medium text-ink-2 shadow-md hover:bg-subtle hover:text-ink"
            aria-label="最新のメッセージへ"
          >
            <ArrowDown className="h-3.5 w-3.5" aria-hidden />
            最新へ
          </button>
        )}
      </div>

      {(talk || talkNote) && (
        <div className={clsx("flex items-center gap-2 border-t border-line px-3 py-2 text-xs", talk ? "bg-accent-soft text-accent-ink" : "bg-panel text-ink-2")} role="status" aria-live="polite">
          <AudioLines className={clsx("h-4 w-4 shrink-0", talk && "animate-pulse")} aria-hidden />
          <span className="min-w-0 flex-1">
            {!talk
              ? talkNote
              : recorder.state === "transcribing"
                ? "会話モード: 聞き取っています…"
                : recording
                  ? "会話モード: お話しください (「終わり」で終了)"
                  : pending
                    ? "会話モード: 考えています…"
                    : speaker.speakingId !== null || speaker.loadingId !== null
                      ? "会話モード: 読み上げています (マイクを押すと止めて話せます)"
                      : "会話モード"}
          </span>
          {talk ? (
            <button type="button" onClick={toggleTalk} className="shrink-0 rounded-md bg-white/70 px-2 py-0.5 font-medium text-accent-ink hover:bg-white">
              終わる
            </button>
          ) : (
            <button type="button" onClick={() => setTalkNote("")} className="grid h-5 w-5 shrink-0 place-items-center rounded hover:bg-subtle" aria-label="閉じる">
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          )}
        </div>
      )}

      {(recorder.state !== "idle" || voiceError) && (
        <div className="border-t border-line bg-panel px-3 py-2 text-xs" role="status" aria-live="polite">
          {recorder.state === "transcribing" ? (
            <span className="flex items-center gap-2 text-ink-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> 声を文字にしています…
            </span>
          ) : recording ? (
            <div className="flex items-center gap-2">
              <span className="relative flex h-2.5 w-2.5 shrink-0">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-critical opacity-60" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-critical" />
              </span>
              <span className="shrink-0 font-medium text-ink">{recorder.state === "starting" ? "マイクを準備しています…" : "お話しください"}</span>
              <span className="tnum shrink-0 text-ink-3">{fmtSec(recorder.seconds)}</span>
              <span className="h-1.5 min-w-8 flex-1 overflow-hidden rounded-full bg-subtle" aria-hidden>
                <span className="block h-full rounded-full bg-accent transition-[width] duration-100" style={{ width: `${Math.round(recorder.level * 100)}%` }} />
              </span>
              <button type="button" onClick={recorder.cancel} className="shrink-0 rounded-md px-2 py-0.5 text-ink-2 hover:bg-subtle" title="録音をやめる (送らない)">
                やめる
              </button>
            </div>
          ) : (
            <div className="flex items-start gap-2 text-critical-ink">
              <span className="min-w-0 flex-1">{voiceError}</span>
              <button
                type="button"
                onClick={() => {
                  recorder.clearError();
                  speaker.clearError();
                }}
                className="grid h-5 w-5 shrink-0 place-items-center rounded hover:bg-critical-soft"
                aria-label="閉じる"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            </div>
          )}
          {recording && recorder.interim && <p className="mt-1 truncate text-ink-2">{recorder.interim}</p>}
          {recording && !recorder.interim && recorder.state === "recording" && <p className="mt-1 text-ink-3">話し終わると自動で送ります。すぐに送るときはもう一度マイクを押してください。</p>}
        </div>
      )}

      <form
        className="border-t border-line bg-panel pb-[max(0.5rem,env(safe-area-inset-bottom))]"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        {/* 音声の副操作は入力欄の上にまとめ、送信・マイクを押しやすくする */}
        {voice.tts !== "none" ? (
          <div className="flex items-center gap-1 border-b border-line/70 px-2.5 pt-1.5 pb-1">
            <button
              type="button"
              onClick={toggleRead}
              className={clsx("inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[11px] font-medium", readAloud ? "bg-accent-soft text-accent-ink" : "text-ink-3 hover:bg-subtle hover:text-ink")}
              aria-pressed={readAloud}
              aria-label={readAloud ? "回答の読み上げ: オン" : "回答の読み上げ: オフ"}
              title={readAloud ? "回答を自動で読み上げる: オン" : "回答を自動で読み上げる: オフ (声の質問は読み上げます)"}
            >
              {readAloud ? <Volume2 className="h-3.5 w-3.5" aria-hidden /> : <VolumeX className="h-3.5 w-3.5" aria-hidden />}
              読み上げ
            </button>
            {(readAloud || talk) && (
              <button
                type="button"
                onClick={() => speaker.setRate(RATES[(RATES.indexOf(speaker.rate as (typeof RATES)[number]) + 1) % RATES.length])}
                className="inline-flex h-7 items-center rounded-lg px-2 text-[11px] font-semibold text-ink-2 tnum hover:bg-subtle"
                aria-label={`読み上げの速さ ${speaker.rate} 倍`}
                title="読み上げの速さ (押すと変更)"
              >
                {speaker.rate}×
              </button>
            )}
            {voice.stt !== "none" && (
              <button
                type="button"
                onClick={toggleTalk}
                disabled={pending && !talk}
                className={clsx("inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[11px] font-medium disabled:opacity-40", talk ? "bg-accent text-white" : "text-ink-3 hover:bg-subtle hover:text-ink")}
                aria-pressed={talk}
                aria-label={talk ? "会話モードを終える" : "会話モード"}
                title={talk ? "会話モードを終える (Esc)" : "会話モード: 話す → 読み上げ → また聞く"}
              >
                <AudioLines className="h-3.5 w-3.5" aria-hidden />
                会話
              </button>
            )}
            <span className="ml-auto hidden text-[10px] text-ink-3 sm:inline">Enter 送信 · Shift+Enter 改行</span>
          </div>
        ) : (
          <div className="hidden items-center justify-end border-b border-line/70 px-2.5 pt-1.5 pb-1 sm:flex">
            <span className="text-[10px] text-ink-3">Enter 送信 · Shift+Enter 改行</span>
          </div>
        )}
        <div className="flex items-end gap-1.5 p-2.5">
          <div className="relative min-w-0 flex-1">
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
              rows={1}
              maxLength={1000}
              placeholder={voice.stt !== "none" ? "質問を入力、またはマイクで話す" : "質問を入力してください"}
              aria-label="質問"
              disabled={pending || recording}
              className="max-h-32 min-h-10 w-full resize-none rounded-xl border border-line bg-subtle px-3 py-2.5 text-sm leading-snug text-ink placeholder:text-ink-3 focus:border-accent focus:bg-panel focus:outline-none disabled:opacity-60"
            />
            {input.length >= 800 && (
              <span className={clsx("pointer-events-none absolute right-2 bottom-1.5 text-[10px] tnum", input.length >= 980 ? "text-critical-ink" : "text-ink-3")} aria-live="polite">
                {input.length}/1000
              </span>
            )}
          </div>
          {voice.stt !== "none" && (
            <button
              type="button"
              onClick={recording ? recorder.stop : startVoice}
              disabled={pending || recorder.state === "transcribing"}
              className={clsx("grid h-10 w-10 shrink-0 place-items-center rounded-xl disabled:opacity-40", recording ? "animate-pulse bg-critical text-white hover:bg-critical/90" : "border border-accent/40 text-accent hover:bg-accent-soft")}
              aria-label={recording ? "話し終えて送る" : "声で質問する"}
              title={recording ? "話し終えて送る" : "声で質問する (マイク)"}
            >
              {recorder.state === "transcribing" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : recording ? <Square className="h-4 w-4 fill-current" aria-hidden /> : <Mic className="h-4 w-4" aria-hidden />}
            </button>
          )}
          <button type="submit" disabled={pending || !input.trim() || recording} className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent text-white hover:bg-accent-hover disabled:opacity-40" aria-label="送信">
            {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <SendHorizontal className="h-4 w-4" aria-hidden />}
          </button>
        </div>
      </form>
    </>
  );
}
