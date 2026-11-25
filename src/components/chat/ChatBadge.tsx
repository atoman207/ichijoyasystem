"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { MessagesSquare } from "lucide-react";
import Link from "@/components/ui/Link";
import { ICON_BUTTON, ICON_ZOOM } from "@/components/layout/header-parts";
import type { ChatCounts, ChatSummary } from "@/lib/chat/types";
import { CHAT_REFRESH_EVENT, playChime, pushState, setAppBadge, swRegistration, unlockAudioOnce } from "./client";

/** チャットの画面がチャットのアイコンに数字を渡す合図 (同じ画面の中) */
export const CHAT_COUNTS_EVENT = "ichijoya-chat-counts";

/**
 * ヘッダーのチャットのアイコン (お客様のご要望 2026-11-25「通知はチャットのアイコンに」)
 * - 赤い数字 = 要対応 (業務依頼・報告の確認・未確認の重要メッセージ・未読のメンション)。青い数字 = 未読のメッセージ (DM・すべて通知のチャンネル)
 * - 新しい要対応が届いたら 2 音、通常のメッセージは 1 音 (本人の設定で止められる)。15 秒ごと・画面に戻ったとき・プッシュ通知が届いたときに確かめる
 * - ホーム画面のアプリのアイコンにも数字を出す。プッシュ通知のサービスワーカーを登録する
 */
export function ChatBadge({ initial, active }: { initial: ChatSummary; active: boolean }) {
  const router = useRouter();
  const [s, setS] = useState<ChatSummary>(initial);
  const prev = useRef<ChatCounts>(initial);
  const sound = useRef(initial.prefs.sound);
  const pushOn = useRef(false);

  useEffect(() => {
    unlockAudioOnce();
    void swRegistration();
    void pushState().then((p) => (pushOn.current = p.state === "on"));
  }, []);

  useEffect(() => {
    let stopped = false;
    let busy = false;
    const apply = (c: ChatCounts, prefs?: ChatSummary["prefs"]) => {
      const p = prev.current;
      if (prefs) sound.current = prefs.sound;
      // 画面を閉じていてプッシュ通知を受け取る端末なら、端末の通知が鳴るので画面では鳴らさない
      const quiet = document.visibilityState !== "visible" && pushOn.current;
      if (sound.current && !quiet) {
        if (c.actionKey !== p.actionKey && c.action > p.action) playChime("priority");
        else if (c.unreadKey !== p.unreadKey && c.unread > p.unread) playChime("normal");
      }
      prev.current = c;
      setS((x) => ({ ...x, ...c, prefs: prefs ?? x.prefs }));
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
  }, [initial.action, initial.unread, router]);

  const label = [s.action ? `要対応 ${s.action} 件` : "", s.unread ? `未読 ${s.unread} 件` : ""].filter(Boolean).join("・");
  return (
    <Link
      href={s.action > 0 ? "/chat?view=inbox" : "/chat"}
      prefetch={false}
      aria-label={label ? `チャット (${label})` : "チャット"}
      title={label ? `チャット: ${label}` : "チャット (チャンネル・DM・業務依頼)"}
      data-testid="header-chat"
      className={clsx(ICON_BUTTON, "relative", active && "bg-subtle text-ink")}
    >
      <MessagesSquare className={clsx("h-5 w-5", ICON_ZOOM)} />
      {s.action > 0 && (
        <span className="absolute top-1 right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-critical px-1 text-[10px] leading-none font-semibold text-white ring-2 ring-panel tnum" aria-hidden data-testid="header-chat-action">
          {s.action > 99 ? "99+" : s.action}
        </span>
      )}
      {s.unread > 0 && (
        <span className="absolute right-1 bottom-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-info px-1 text-[9px] leading-none font-semibold text-white ring-2 ring-panel tnum" aria-hidden data-testid="header-chat-unread">
          {s.unread > 99 ? "99+" : s.unread}
        </span>
      )}
    </Link>
  );
}
