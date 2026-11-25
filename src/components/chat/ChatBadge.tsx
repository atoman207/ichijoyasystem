"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { MessagesSquare } from "lucide-react";
import Link from "@/components/ui/Link";
import { ICON_BUTTON } from "@/components/layout/header-parts";
import type { ChatCounts, ChatSummary } from "@/lib/chat/types";
import { CHAT_REFRESH_EVENT, playChime, pushState, setAppBadge, swRegistration, unlockAudioOnce } from "./client";

/** チャットの画面がチャットのボタンに数字を渡す合図 (同じ画面の中) */
export const CHAT_COUNTS_EVENT = "ichijoya-chat-counts";

/**
 * ヘッダーのチャット (お客様のご要望 2026-11-25「通知はチャットのアイコンに」「ヘッダーに常に表示・アニメーションで目立たせる」)
 * ------------------------------------------------------------
 * - ChatLive (表示なし・1 つだけ): 15 秒ごと・画面に戻ったとき・プッシュ通知が届いたときに数を確かめ、新しい要対応は 2 音・
 *   通常のメッセージは 1 音を鳴らす (本人の設定)。ホーム画面のアプリのアイコンにも数字を出す。プッシュ通知のサービスワーカーを登録する
 * - ChatPinnedButton: パソコン・タブレットはロゴの右 (予定表の隣) に常に出す緑のボタン。光の輪と光の帯で目立たせ、
 *   要対応があるときはアイコンがベルのように揺れ、新しく届いたときは弾む
 * - ChatIconButton: スマートフォン (ヘッダーが狭い) は右上のアイコン。同じアニメーション
 * - 赤い数字 = 要対応 (業務依頼・報告の確認・未確認の重要メッセージ・未読のメンション)、青い数字 = 未読 (DM・すべて通知のチャンネル)
 * - 動きを減らす設定の端末 (prefers-reduced-motion) では動かさない
 */

interface LiveState {
  summary: ChatSummary | null;
  /** 新しいものが届いた回数 (アニメーションをやり直す印) */
  burst: number;
}

let live: LiveState = { summary: null, burst: 0 };
const listeners = new Set<() => void>();
function setLive(next: Partial<LiveState>) {
  live = { ...live, ...next };
  for (const l of listeners) l();
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

function useLive(initial: ChatSummary): { s: ChatSummary; burst: number } {
  const snap = useSyncExternalStore(
    subscribe,
    () => live,
    () => live,
  );
  return { s: snap.summary ?? initial, burst: snap.burst };
}

/** 数を確かめ、音・アプリの数字・新着の印を更新する (AppShell に 1 つだけ置く) */
export function ChatLive({ initial }: { initial: ChatSummary }) {
  const router = useRouter();
  const prev = useRef<ChatCounts>(initial);
  const sound = useRef(initial.prefs.sound);
  const pushOn = useRef(false);

  useEffect(() => {
    unlockAudioOnce();
    void swRegistration();
    void pushState().then((p) => (pushOn.current = p.state === "on"));
    if (!live.summary) setLive({ summary: initial });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 最初の 1 回だけ
  }, []);

  useEffect(() => {
    let stopped = false;
    let busy = false;
    const apply = (c: ChatCounts, prefs?: ChatSummary["prefs"]) => {
      const p = prev.current;
      if (prefs) sound.current = prefs.sound;
      const newAction = c.actionKey !== p.actionKey && c.action > p.action;
      const newUnread = c.unreadKey !== p.unreadKey && c.unread > p.unread;
      // 画面を閉じていてプッシュ通知を受け取る端末なら、端末の通知が鳴るので画面では鳴らさない
      const quiet = document.visibilityState !== "visible" && pushOn.current;
      if (sound.current && !quiet) {
        if (newAction) playChime("priority");
        else if (newUnread) playChime("normal");
      }
      prev.current = c;
      const base = live.summary ?? initial;
      setLive({ summary: { ...base, ...c, prefs: prefs ?? base.prefs }, burst: newAction || newUnread ? live.burst + 1 : live.burst });
      setAppBadge(c.action + c.unread);
    };
    const check = async () => {
      if (stopped || busy) return;
      busy = true;
      try {
        const res = await fetch("/api/chat/summary", { cache: "no-store", headers: { accept: "application/json" } });
        if (res.ok) {
          const j = (await res.json()) as ChatSummary;
          if (!stopped) apply(j, j.prefs);
        }
      } catch {
        // 通信できないときは次の回に
      } finally {
        busy = false;
      }
    };
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void check();
    }, 15_000);
    // 画面を閉じているあいだも 1 分ごと (パソコンの別のタブで開いているとき、音で知らせる)
    const slow = window.setInterval(() => {
      if (document.visibilityState !== "visible") void check();
    }, 60_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    const onCounts = (e: Event) => {
      const c = (e as CustomEvent<ChatCounts>).detail;
      if (c) apply(c);
    };
    const onRefresh = () => void check();
    const onSw = (e: MessageEvent) => {
      const d = e.data as { type?: string; url?: string } | null;
      if (d?.type === "ichijoya-push") void check();
      if (d?.type === "ichijoya-open" && d.url?.startsWith("/")) router.push(d.url);
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    window.addEventListener(CHAT_COUNTS_EVENT, onCounts);
    window.addEventListener(CHAT_REFRESH_EVENT, onRefresh);
    navigator.serviceWorker?.addEventListener("message", onSw);
    setAppBadge(initial.action + initial.unread);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.clearInterval(slow);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener(CHAT_COUNTS_EVENT, onCounts);
      window.removeEventListener(CHAT_REFRESH_EVENT, onRefresh);
      navigator.serviceWorker?.removeEventListener("message", onSw);
    };
  }, [initial, router]);

  return null;
}

function labelOf(s: ChatSummary) {
  return [s.action ? `要対応 ${s.action} 件` : "", s.unread ? `未読 ${s.unread} 件` : ""].filter(Boolean).join("・");
}

/** 新しく届いたとき、しばらく弾ませる (burst が増えた直後の 1 回) */
function useBurst(burst: number): boolean {
  const [on, setOn] = useState(false);
  const last = useRef(burst);
  useEffect(() => {
    if (burst === last.current) return;
    last.current = burst;
    const start = window.setTimeout(() => setOn(true), 0);
    const end = window.setTimeout(() => setOn(false), 950);
    return () => {
      window.clearTimeout(start);
      window.clearTimeout(end);
    };
  }, [burst]);
  return on;
}

function Counts({ s, compact }: { s: ChatSummary; compact?: boolean }) {
  return (
    <>
      {s.action > 0 && (
        <span className={clsx("absolute flex", compact ? "top-1 right-1" : "-top-1.5 -right-1.5")} aria-hidden>
          {/* 要対応があるあいだは数字のまわりに光の輪を広げる */}
          <span className="absolute inset-0 animate-ping rounded-full bg-critical/60 motion-reduce:hidden" />
          <span className="relative flex h-4 min-w-4 items-center justify-center rounded-full bg-critical px-1 text-[10px] leading-none font-semibold text-white ring-2 ring-panel tnum" data-testid="header-chat-action">
            {s.action > 99 ? "99+" : s.action}
          </span>
        </span>
      )}
      {s.unread > 0 && (
        <span className={clsx("absolute flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-info px-1 text-[9px] leading-none font-semibold text-white ring-2 ring-panel tnum", compact ? "right-1 bottom-0.5" : "-right-1.5 -bottom-1.5")} aria-hidden data-testid="header-chat-unread">
          {s.unread > 99 ? "99+" : s.unread}
        </span>
      )}
    </>
  );
}

/** パソコン・タブレット: ロゴの右 (予定表の隣) に常に出す、目立つチャットのボタン */
export function ChatPinnedButton({ initial, active, onClick }: { initial: ChatSummary; active: boolean; onClick?: () => void }) {
  const { s, burst } = useLive(initial);
  const popping = useBurst(burst);
  const label = labelOf(s);
  return (
    <Link
      href={s.action > 0 ? "/chat?view=inbox" : "/chat"}
      prefetch={false}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      aria-label={label ? `チャット (${label})` : "チャット (チャンネル・DM・業務依頼)"}
      title={label ? `チャット: ${label}` : "チャット (チャンネル・DM・業務依頼)"}
      data-testid="header-chat"
      className={clsx(
        // スマートフォンはヘッダーが狭いため右上のアイコン (ChatIconButton)
        "group relative hidden h-9 shrink-0 items-center gap-1.5 rounded-xl bg-linear-to-br from-good to-wa-green px-2.5 text-sm font-semibold text-white outline-none transition-transform duration-200 hover:-translate-y-px focus-visible:ring-4 focus-visible:ring-good/30 sm:inline-flex sm:h-10 md:px-3.5",
        "animate-chat-glow motion-reduce:animate-none motion-reduce:shadow-[0_8px_18px_-10px_rgba(18,161,80,0.9)]",
        popping && "animate-chat-burst!",
        active && "ring-2 ring-white ring-offset-2 ring-offset-good/40",
      )}
    >
      <span className="pointer-events-none absolute inset-0 overflow-hidden rounded-xl" aria-hidden>
        {/* 光の帯 (予定表のボタンと時間をずらす) */}
        <span className="absolute inset-y-0 left-0 w-1/3 bg-linear-to-r from-transparent via-white/45 to-transparent animate-pin-shine [animation-delay:1.6s] motion-reduce:hidden" />
      </span>
      <MessagesSquare className={clsx("relative h-[18px] w-[18px] sm:h-5 sm:w-5", s.action > 0 ? "animate-chat-ring motion-reduce:animate-none" : "animate-pin-wiggle [animation-delay:2.4s] motion-reduce:animate-none")} strokeWidth={2.2} aria-hidden />
      <span className="relative hidden md:inline">チャット</span>
      <Counts s={s} />
    </Link>
  );
}

/** スマートフォン: 右上のチャットのアイコン (同じ数字とアニメーション) */
export function ChatIconButton({ initial, active }: { initial: ChatSummary; active: boolean }) {
  const { s, burst } = useLive(initial);
  const popping = useBurst(burst);
  const label = labelOf(s);
  return (
    <Link
      href={s.action > 0 ? "/chat?view=inbox" : "/chat"}
      prefetch={false}
      aria-label={label ? `チャット (${label})` : "チャット"}
      title={label ? `チャット: ${label}` : "チャット (チャンネル・DM・業務依頼)"}
      data-testid="header-chat-mobile"
      className={clsx(ICON_BUTTON, "relative bg-good-soft text-good-ink sm:hidden", popping && "animate-chat-burst", active && "ring-2 ring-good/40")}
    >
      <MessagesSquare className={clsx("h-5 w-5", s.action > 0 ? "animate-chat-ring motion-reduce:animate-none" : "animate-pin-wiggle motion-reduce:animate-none")} strokeWidth={2.2} />
      <Counts s={s} compact />
    </Link>
  );
}
