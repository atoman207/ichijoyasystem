"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { AlertTriangle, ArrowDown, AtSign, Bell, BellOff, Bookmark, Check, ChevronDown, ChevronLeft, FolderOpen, Hash, Inbox, ListTodo, Lock, LogOut, MessageSquare, Pin, Plus, Search, Settings2, SquarePen, Star, UserMinus, UserPlus, UsersRound, X } from "lucide-react";
import Link from "@/components/ui/Link";
import { Badge } from "@/components/ui";
import { toast } from "@/components/ui/toast";
import { ackChatMessage, addChatMembers, deleteChatMessage, editChatMessage, joinChatChannel, leaveChatChannel, markChatRead, markChatUnread, openDirect, pinChatMessage, reactChatMessage, removeChatMember, saveChatMessage, setChatChannelNotify, starChatChannel } from "@/lib/actions/chat";
import { chatNavKey, decodeMentions, matchName } from "@/lib/chat/text";
import type { ChatBootstrap, ChatChannelView, ChatCounts, ChatFile, ChatMessageView, ChatPrefs, ChatSyncResponse, ChatTaskInfo, InboxItem, WaitingItem } from "@/lib/chat/types";
import { isPrivateChannel } from "@/lib/chat/types";
import { CHAT_COUNTS_EVENT } from "./ChatBadge";
import { dayKey, dayLabel, dueLabel, fileUrl, fullWhen, getJson, shortWhen, signalChatRefresh, sizeLabel, timeLabel } from "./client";
import { Composer, type ComposerHandle } from "./Composer";
import { AckDialog, BrowseDialog, NewDmDialog, PeoplePicker, PrefsDialog, QuickSwitcher, ShareDialog, TaskDialog } from "./dialogs";
import { ChannelDialog, ManageDialog, type ManageRow } from "./channel-settings";
import { ChannelIcon, DayDivider, Lightbox, MessageBody, MessageItem, nameOf, ProfileCard, UnreadDivider, UserAvatar, type Dir, type MessageHandlers } from "./parts";

/* ================================================================== */
/* 型                                                                   */
/* ================================================================== */

export type ChatView = { kind: "channel"; id: string } | { kind: "inbox" } | { kind: "important" } | { kind: "saved" } | { kind: "search"; q: string; inId?: string; fromId?: string } | { kind: "files"; id: string } | { kind: "pins"; id: string };

export interface ThreadData {
  root: ChatMessageView;
  replies: ChatMessageView[];
  lastRead: string;
}

export interface ChatInitial {
  navKey: string;
  rev: number;
  channels: ChatChannelView[];
  counts: ChatCounts;
  inbox: InboxItem[];
  waiting: WaitingItem[];
  prefs: ChatPrefs;
  view: ChatView;
  channelId: string;
  messages: ChatMessageView[];
  hasMore: boolean;
  lastRead: string;
  focusId?: string;
  thread?: ThreadData;
  /** スマートフォンで最初にチャンネルの一覧を出す */
  mobileList: boolean;
}

/* ================================================================== */
/* メッセージの並びの更新                                                 */
/* ================================================================== */

function sortMsgs(list: ChatMessageView[]) {
  return list.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}

/** 変わったメッセージを差し込む (何も変わらなければ同じ配列を返す = 画面を描き直さない) */
function mergeMsgs(prev: ChatMessageView[], incoming: ChatMessageView[], tasks: Record<string, ChatTaskInfo> = {}, keepOlder = true): ChatMessageView[] {
  let changed = false;
  const map = new Map(prev.map((m) => [m.id, m]));
  const oldest = prev[0]?.at ?? "";
  for (const m of incoming) {
    const had = map.get(m.id);
    // 読み込んでいない古いメッセージは足さない (「前のメッセージ」で読む)
    if (!had && keepOlder && oldest && m.at < oldest) continue;
    if (!had || m.rev > had.rev || (m.rev === had.rev && JSON.stringify(m) !== JSON.stringify(had))) {
      map.set(m.id, m);
      changed = true;
    }
  }
  for (const [id, m] of map) {
    const t = m.task && tasks[m.task.threadId];
    if (t && JSON.stringify(t) !== JSON.stringify(m.task)) {
      map.set(id, { ...m, task: t });
      changed = true;
    }
  }
  return changed ? sortMsgs([...map.values()]) : prev;
}

const msgLink = (m: Pick<ChatMessageView, "channelId" | "id" | "parentId">) => `/chat?c=${encodeURIComponent(m.channelId)}&m=${encodeURIComponent(m.id)}${m.parentId ? `&t=${encodeURIComponent(m.parentId)}` : ""}`;

function viewUrl(view: ChatView, thread?: string): string {
  switch (view.kind) {
    case "channel":
      return `/chat?c=${encodeURIComponent(view.id)}${thread ? `&t=${encodeURIComponent(thread)}` : ""}`;
    case "files":
      return `/chat?view=files&c=${encodeURIComponent(view.id)}`;
    case "search":
      return `/chat?view=search&q=${encodeURIComponent(view.q)}`;
    case "pins":
      return `/chat?view=pins&c=${encodeURIComponent(view.id)}`;
    default:
      return `/chat?view=${view.kind}`;
  }
}

/* ================================================================== */
/* 本体                                                                 */
/* ================================================================== */

export function ChatApp({ boot, initial }: { boot: ChatBootstrap; initial: ChatInitial }) {
  const router = useRouter();
  const [online, setOnline] = useState<string[]>([]);
  const dir = useMemo<Dir>(() => ({ me: boot.me, users: new Map(boot.users.map((u) => [u.id, u])), stores: boot.stores, online: new Set(online) }), [boot, online]);
  const [typing, setTyping] = useState<{ channel: string[]; thread: string[] }>({ channel: [], thread: [] });
  /** サイドバーにない (参加していない公開の) チャンネルを開いているとき */
  const [preview, setPreview] = useState<ChatChannelView | null>(null);
  /** チャンネルの詳細 (概要・メンバー) を右に出す */
  const [details, setDetails] = useState<null | "about" | "members">(null);
  const [profile, setProfile] = useState<{ userId: string; anchor: DOMRect } | null>(null);
  const [channels, setChannels] = useState(initial.channels);
  const [counts, setCounts] = useState(initial.counts);
  const [inbox, setInbox] = useState(initial.inbox);
  const [waiting, setWaiting] = useState(initial.waiting);
  const [prefs, setPrefs] = useState(initial.prefs);
  const [view, setView] = useState<ChatView>(initial.view);
  const [cid, setCid] = useState(initial.channelId);
  const [msgs, setMsgs] = useState(initial.messages);
  const [hasMore, setHasMore] = useState(initial.hasMore);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loading, setLoading] = useState(false);
  const [lastReadOpen, setLastReadOpen] = useState(initial.lastRead);
  const [focusId, setFocusId] = useState(initial.focusId);
  const [thread, setThread] = useState<ThreadData | null>(initial.thread ?? null);
  const [showList, setShowList] = useState(initial.mobileList);
  const [height, setHeight] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [newBelow, setNewBelow] = useState(0);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [dialog, setDialog] = useState<
    | { kind: "dm" }
    | { kind: "channel"; channel?: ChatChannelView; back?: "manage"; messages?: number }
    | { kind: "manage" }
    | { kind: "task"; m: ChatMessageView }
    | { kind: "share"; m: ChatMessageView }
    | { kind: "browse" }
    | { kind: "switcher" }
    | { kind: "acks"; m: ChatMessageView }
    | { kind: "prefs" }
    | { kind: "image"; messageId: string; files: ChatFile[]; index: number }
    | null
  >(null);
  const [searchText, setSearchText] = useState(initial.view.kind === "search" ? initial.view.q : "");

  const revRef = useRef(initial.rev);
  const cidRef = useRef(initial.channelId);
  const viewRef = useRef<ChatView>(initial.view);
  const threadRef = useRef<ThreadData | null>(initial.thread ?? null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const threadScrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const marked = useRef<Record<string, string>>({});
  const navKeyRef = useRef(initial.navKey);
  const composerRef = useRef<ComposerHandle>(null);
  const loadSeq = useRef(0);
  useEffect(() => {
    cidRef.current = cid;
  }, [cid]);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);
  useEffect(() => {
    threadRef.current = thread;
  }, [thread]);

  const channel = channels.find((c) => c.id === cid) ?? (preview?.id === cid ? preview : undefined);
  // 知らせはシステム共通のトースト (src/components/ui/toast.ts)。チャットのエラーは小さなことが多いので 8 秒で消す
  const showToast = useCallback((text: string, tone: "good" | "bad" = "good") => {
    if (tone === "good") toast.success(text);
    else toast.error(text, { duration: 8000 });
  }, []);

  /* ---------------- 画面の場所 (URL) ---------------- */

  const pushUrl = useCallback((url: string, replace = false) => {
    const now = window.location.pathname + window.location.search;
    if (now === url) return;
    navKeyRef.current = chatNavKey(new URL(url, window.location.origin).searchParams);
    if (replace) window.history.replaceState(null, "", url);
    else window.history.pushState(null, "", url);
  }, []);

  /* ---------------- 読み込み ---------------- */

  const loadChannel = useCallback(async (id: string, focus?: string) => {
    const seq = ++loadSeq.current;
    setLoading(true);
    try {
      const r = await getJson<{ rev: number; channel: ChatChannelView; messages: ChatMessageView[]; hasMore: boolean; lastRead: string }>(`/api/chat/messages?c=${encodeURIComponent(id)}${focus ? `&around=${encodeURIComponent(focus)}` : ""}`);
      if (seq !== loadSeq.current) return;
      setPreview(r.channel);
      setMsgs(r.messages);
      setHasMore(r.hasMore);
      setLastReadOpen(r.lastRead);
      revRef.current = r.rev;
      atBottom.current = !focus;
      setNewBelow(0);
    } catch (e) {
      if (seq === loadSeq.current) {
        setMsgs([]);
        showToast(e instanceof Error ? e.message : "読み込めませんでした。", "bad");
      }
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [showToast]);

  const openThread = useCallback(
    async (rootId: string, opts: { push?: boolean } = {}) => {
      try {
        const r = await getJson<{ rev: number; root: ChatMessageView; replies: ChatMessageView[]; lastRead: string }>(`/api/chat/thread?id=${encodeURIComponent(rootId)}`);
        setThread({ root: r.root, replies: r.replies, lastRead: r.lastRead });
        if (opts.push !== false) pushUrl(viewUrl({ kind: "channel", id: r.root.channelId }, rootId));
      } catch (e) {
        showToast(e instanceof Error ? e.message : "スレッドを開けませんでした。", "bad");
      }
    },
    [pushUrl, showToast],
  );

  const openChannel = useCallback(
    async (id: string, opts: { focus?: string; thread?: string; push?: boolean } = {}) => {
      setView({ kind: "channel", id });
      setShowList(false);
      setEditing(null);
      if (!opts.thread) setThread(null);
      setFocusId(opts.focus);
      if (id !== cidRef.current || opts.focus || msgs.length === 0) {
        setCid(id);
        cidRef.current = id;
        await loadChannel(id, opts.focus);
      }
      try {
        localStorage.setItem("ichijoya-chat-last", id);
      } catch {
        // 保存できない
      }
      if (opts.push !== false) pushUrl(viewUrl({ kind: "channel", id }, opts.thread));
      if (opts.thread) void openThread(opts.thread, { push: false });
    },
    [loadChannel, msgs.length, openThread, pushUrl],
  );

  const go = useCallback(
    (v: ChatView) => {
      if (v.kind === "channel") return void openChannel(v.id);
      setView(v);
      setShowList(false);
      setThread(null);
      if ((v.kind === "files" || v.kind === "pins") && v.id !== cidRef.current) {
        setCid(v.id);
        cidRef.current = v.id;
      }
      pushUrl(viewUrl(v));
    },
    [openChannel, pushUrl],
  );

  /** URL から画面を決める (戻る・進む・ヘッダーのアイコン) */
  const applyUrl = useCallback(
    (sp: URLSearchParams) => {
      navKeyRef.current = chatNavKey(sp);
      const v = sp.get("view");
      const c = sp.get("c") ?? "";
      if (v === "inbox" || v === "important" || v === "saved") {
        setView({ kind: v });
        setShowList(false);
        setThread(null);
      } else if (v === "search") {
        const q = sp.get("q") ?? "";
        setSearchText(q);
        setView({ kind: "search", q });
        setShowList(false);
      } else if ((v === "files" || v === "pins") && c) {
        setCid(c);
        cidRef.current = c;
        setView({ kind: v, id: c });
        setShowList(false);
      } else if (c) void openChannel(c, { focus: sp.get("m") ?? undefined, thread: sp.get("t") ?? undefined, push: false });
      else setShowList(true);
    },
    [openChannel],
  );

  useEffect(() => {
    const onPop = () => applyUrl(new URLSearchParams(window.location.search));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [applyUrl]);

  // ヘッダーのアイコンなど、ほかの画面からチャットの場所を開いたとき (同じ画面の中の移動)
  useEffect(() => {
    if (initial.navKey !== navKeyRef.current) applyUrl(new URLSearchParams(window.location.search));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- サーバーの初期表示の場所が変わったときだけ
  }, [initial.navKey]);

  // 前回開いていたチャンネル (場所の指定がないとき。パソコンの幅だけ)
  useEffect(() => {
    if (initial.navKey !== chatNavKey({})) return;
    try {
      const last = localStorage.getItem("ichijoya-chat-last");
      if (last && last !== initial.channelId && initial.channels.some((c) => c.id === last) && window.matchMedia("(min-width: 768px)").matches) {
        const t = window.setTimeout(() => void openChannel(last, { push: false }), 0);
        return () => window.clearTimeout(t);
      }
    } catch {
      // 読めない
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 最初の 1 回だけ
  }, []);

  /* ---------------- 定期の更新 ---------------- */

  const sync = useCallback(async () => {
    const v = viewRef.current;
    const c = v.kind === "channel" || v.kind === "files" || v.kind === "pins" ? cidRef.current : "";
    const t = threadRef.current?.root.id ?? "";
    const sent = { c, t };
    try {
      const r = await getJson<ChatSyncResponse>(`/api/chat/sync?c=${encodeURIComponent(c)}&t=${encodeURIComponent(t)}&rev=${revRef.current}`);
      setChannels(r.channels);
      setCounts(r.counts);
      setOnline((prev) => (prev.length === r.online.length && prev.every((x, i) => x === r.online[i]) ? prev : r.online));
      setTyping((prev) => (prev.channel.join() === r.typing.join() && prev.thread.join() === r.threadTyping.join() ? prev : { channel: r.typing, thread: r.threadTyping }));
      setInbox(r.inbox);
      setWaiting(r.waiting);
      window.dispatchEvent(new CustomEvent(CHAT_COUNTS_EVENT, { detail: r.counts }));
      if (sent.c && sent.c === cidRef.current) {
        setMsgs((prev) => mergeMsgs(prev, r.messages, r.tasks));
        if (sent.t && threadRef.current?.root.id === sent.t) {
          const rootUpd = r.messages.find((m) => m.id === sent.t);
          setThread((th) => {
            if (!th || th.root.id !== sent.t) return th;
            const replies = mergeMsgs(th.replies, r.replies, r.tasks, false);
            const root = rootUpd && rootUpd.rev > th.root.rev ? rootUpd : th.root;
            return replies === th.replies && root === th.root ? th : { ...th, root, replies };
          });
        }
        revRef.current = Math.max(revRef.current, r.rev);
      }
    } catch {
      // 通信できないときは次の回に
    }
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer = 0;
    const loop = async () => {
      if (stopped) return;
      await sync();
      if (stopped) return;
      timer = window.setTimeout(loop, document.visibilityState === "visible" ? 3000 : 20000);
    };
    timer = window.setTimeout(loop, 1500);
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      window.clearTimeout(timer);
      void loop();
    };
    const onSw = (e: MessageEvent) => {
      if ((e.data as { type?: string } | null)?.type === "ichijoya-push") onVisible();
    };
    document.addEventListener("visibilitychange", onVisible);
    navigator.serviceWorker?.addEventListener("message", onSw);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      navigator.serviceWorker?.removeEventListener("message", onSw);
    };
  }, [sync]);

  /* ---------------- スクロール・既読 ---------------- */

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    setNewBelow(0);
  }, []);

  // チャンネルを開いたとき: 指定のメッセージ → ここから未読 → いちばん下
  const lastLoaded = useRef("");
  const markRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    if (view.kind !== "channel" || loading) return;
    const sig = `${cid}:${focusId ?? ""}:${msgs.length > 0}`;
    if (lastLoaded.current === sig) return;
    lastLoaded.current = sig;
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (!el) return;
      const target = focusId ? el.querySelector<HTMLElement>(`[data-mid="${CSS.escape(focusId)}"]`) : el.querySelector<HTMLElement>("[aria-label='ここから未読']");
      if (target) {
        target.scrollIntoView({ block: focusId ? "center" : "start" });
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      } else scrollToBottom();
      window.setTimeout(() => markRef.current(), 300);
    });
  }, [view.kind, cid, focusId, loading, msgs.length, scrollToBottom]);

  // 新しいメッセージ: いちばん下を見ているときは下までスクロール、そうでなければ「新しいメッセージ」を出す
  const lastCount = useRef(msgs.length);
  const lastNewest = useRef(msgs[msgs.length - 1]?.id);
  useEffect(() => {
    const newest = msgs[msgs.length - 1];
    if (newest && newest.id !== lastNewest.current && msgs.length >= lastCount.current) {
      if (atBottom.current || newest.userId === dir.me.id) requestAnimationFrame(() => scrollToBottom(true));
      else if (newest.userId !== dir.me.id) requestAnimationFrame(() => setNewBelow((n) => n + 1));
    }
    lastCount.current = msgs.length;
    lastNewest.current = newest?.id;
  }, [msgs, dir.me.id, scrollToBottom]);

  // 既読: 画面に出ているメッセージまで (Slack と同じ。下までスクロールしていなくても、見えているところまで既読にする)
  const markLatest = useCallback(() => {
    if (viewRef.current.kind !== "channel" || document.visibilityState !== "visible") return;
    const el = scrollRef.current;
    if (!el) return;
    const c = cidRef.current;
    const bottom = el.getBoundingClientRect().bottom - 8;
    let seen = "";
    const items = el.querySelectorAll<HTMLElement>("[data-mid]");
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].getBoundingClientRect().top < bottom) {
        seen = items[i].dataset.at ?? "";
        break;
      }
    }
    if (!seen || (marked.current[c] ?? "") >= seen) return;
    marked.current[c] = seen;
    const newest = msgs[msgs.length - 1];
    if (newest && seen >= newest.at) setChannels((list) => list.map((x) => (x.id === c ? { ...x, unread: 0 } : x)));
    void markChatRead(c, seen)
      .then(() => {
        void sync();
        signalChatRefresh();
      })
      .catch(() => undefined);
  }, [msgs, sync]);
  useEffect(() => {
    markRef.current = markLatest;
    const t = window.setTimeout(markLatest, 700);
    return () => window.clearTimeout(t);
  }, [markLatest, cid]);
  useEffect(() => {
    const on = () => markLatest();
    document.addEventListener("visibilitychange", on);
    window.addEventListener("focus", on);
    return () => {
      document.removeEventListener("visibilitychange", on);
      window.removeEventListener("focus", on);
    };
  }, [markLatest]);

  // スレッド: 開いたとき・返信が増えたときに下まで。既読にする
  const threadMarked = useRef("");
  const threadSeen = useRef("");
  useEffect(() => {
    if (!thread) return;
    const last = thread.replies[thread.replies.length - 1];
    const at = last?.at ?? thread.root.at;
    const seen = `${thread.root.id}:${thread.replies.length}`;
    if (threadSeen.current !== seen) {
      threadSeen.current = seen;
      requestAnimationFrame(() => {
        const el = threadScrollRef.current;
        if (el) el.scrollTo({ top: el.scrollHeight });
      });
    }
    const k = `${thread.root.id}@${at}`;
    if (threadMarked.current === k || document.visibilityState !== "visible") return;
    threadMarked.current = k;
    void markChatRead(`t:${thread.root.id}`, at)
      .then(() => signalChatRefresh())
      .catch(() => undefined);
  }, [thread]);

  const scrollMarkTimer = useRef(0);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (atBottom.current) setNewBelow(0);
    window.clearTimeout(scrollMarkTimer.current);
    scrollMarkTimer.current = window.setTimeout(markLatest, 400);
    if (el.scrollTop < 120 && hasMore && !loadingOlder) void loadOlder();
  };

  const loadOlder = async () => {
    const el = scrollRef.current;
    const first = msgs[0];
    if (!first || !hasMore || loadingOlder) return;
    setLoadingOlder(true);
    const before = el?.scrollHeight ?? 0;
    try {
      const r = await getJson<{ messages: ChatMessageView[]; hasMore: boolean }>(`/api/chat/messages?c=${encodeURIComponent(cid)}&before=${encodeURIComponent(first.at)}`);
      setMsgs((prev) => sortMsgs([...r.messages.filter((m) => !prev.some((p) => p.id === m.id)), ...prev]));
      setHasMore(r.hasMore);
      requestAnimationFrame(() => {
        if (el) el.scrollTop += el.scrollHeight - before;
      });
    } catch {
      showToast("前のメッセージを読み込めませんでした。", "bad");
    } finally {
      setLoadingOlder(false);
    }
  };

  /* ---------------- 画面の高さ (スマートフォンのキーボード) ---------------- */

  // 本文の枠 (@container・表示のアニメーション) の中では fixed が使えないため、見えている画面の高さから枠の高さを決める。
  // スマートフォンのキーボードが開いたときは見えている高さ (visualViewport) に合わせ、入力欄をキーボードの上に出す
  useEffect(() => {
    const vv = window.visualViewport;
    const on = () => {
      const el = wrapRef.current;
      if (!el) return;
      const viewH = vv?.height ?? window.innerHeight;
      const top = el.getBoundingClientRect().top - (vv?.offsetTop ?? 0);
      setHeight(Math.max(320, Math.round(viewH - Math.max(0, top) - 12)));
    };
    const first = requestAnimationFrame(on);
    const late = window.setTimeout(on, 260);
    vv?.addEventListener("resize", on);
    vv?.addEventListener("scroll", on);
    window.addEventListener("resize", on);
    return () => {
      cancelAnimationFrame(first);
      window.clearTimeout(late);
      vv?.removeEventListener("resize", on);
      vv?.removeEventListener("scroll", on);
      window.removeEventListener("resize", on);
    };
  }, []);

  /* ---------------- メッセージの操作 ---------------- */

  const patchMsg = useCallback((id: string, fn: (m: ChatMessageView) => ChatMessageView) => {
    setMsgs((list) => list.map((m) => (m.id === id ? fn(m) : m)));
    setThread((th) => (th ? { ...th, root: th.root.id === id ? fn(th.root) : th.root, replies: th.replies.map((m) => (m.id === id ? fn(m) : m)) } : th));
  }, []);

  const handlers: MessageHandlers = {
    onReply: (m) => void openThread(m.id),
    onReact: (m, emoji) => {
      const toggle = (x: ChatMessageView): ChatMessageView => {
        const r = x.reactions.find((y) => y.emoji === emoji);
        const mine = r?.userIds.includes(dir.me.id);
        const reactions = r
          ? x.reactions.map((y) => (y.emoji === emoji ? { ...y, userIds: mine ? y.userIds.filter((u) => u !== dir.me.id) : [...y.userIds, dir.me.id] } : y)).filter((y) => y.userIds.length)
          : [...x.reactions, { emoji, userIds: [dir.me.id] }];
        return { ...x, reactions };
      };
      patchMsg(m.id, toggle);
      void reactChatMessage(m.id, emoji)
        .then((r) => {
          if (!r.ok) {
            patchMsg(m.id, toggle);
            showToast(r.error ?? "リアクションできませんでした。", "bad");
          }
        })
        .catch(() => patchMsg(m.id, toggle));
    },
    onEdit: (m) => setEditing({ id: m.id, text: decodeMentions(m.body, { users: [...dir.users.values()], stores: dir.stores }) }),
    onDelete: (m) => {
      if (!confirm("このメッセージを削除しますか？ 添付した資料・写真も消えます。元には戻せません。")) return;
      void deleteChatMessage(m.id).then((r) => {
        if (!r.ok) return showToast(r.error ?? "削除できませんでした。", "bad");
        patchMsg(m.id, (x) => ({ ...x, deleted: true, body: "", files: [], reactions: [], important: false, ack: undefined, task: undefined }));
        if (thread?.root.id === m.id && !m.replyCount) setThread(null);
        showToast("メッセージを削除しました。");
        void sync();
      });
    },
    onTask: (m) => setDialog({ kind: "task", m }),
    onAck: (m) => {
      void ackChatMessage(m.id).then((r) => {
        if (!r.ok) return showToast(r.error ?? "確認を記録できませんでした。", "bad");
        patchMsg(m.id, (x) => (x.ack ? { ...x, ack: { ...x.ack, mine: new Date().toISOString(), done: x.ack.done + 1, ackedIds: x.ack.ackedIds ? [...x.ack.ackedIds, dir.me.id] : undefined, pendingIds: x.ack.pendingIds?.filter((p) => p !== dir.me.id) } } : x));
        setInbox((list) => list.filter((i) => i.key !== `imp:${m.id}`));
        showToast("確認しました。送った人に確認したことが伝わります。");
        void sync();
        signalChatRefresh();
      });
    },
    onAcks: (m) => setDialog({ kind: "acks", m }),
    onCopy: (m) => {
      const url = `${window.location.origin}${msgLink(m)}`;
      void navigator.clipboard?.writeText(url).then(
        () => showToast("リンクをコピーしました。"),
        () => showToast(url),
      );
    },
    onOpenImage: (m, files, index) => setDialog({ kind: "image", messageId: m.id, files, index }),
    onPin: (m) => {
      const on = !m.pinnedBy;
      patchMsg(m.id, (x) => ({ ...x, pinnedBy: on ? dir.me.id : undefined }));
      void pinChatMessage(m.id, on).then((r) => {
        if (!r.ok) {
          patchMsg(m.id, (x) => ({ ...x, pinnedBy: m.pinnedBy }));
          return showToast(r.error ?? "ピン留めできませんでした。", "bad");
        }
        showToast(on ? "チャンネルにピン留めしました。上の「ピン留め」からいつでも見られます。" : "ピン留めを外しました。");
        void sync();
      });
    },
    onSave: (m) => {
      const on = !m.saved;
      patchMsg(m.id, (x) => ({ ...x, saved: on || undefined }));
      void saveChatMessage(m.id, on).then((r) => {
        if (!r.ok) {
          patchMsg(m.id, (x) => ({ ...x, saved: m.saved }));
          return showToast(r.error ?? "保存できませんでした。", "bad");
        }
        showToast(on ? "「後で見る」に保存しました (左の「後で見る」)。" : "「後で見る」から外しました。");
      });
    },
    onUnread: (m) => {
      void markChatUnread(m.id).then((r) => {
        if (!r.ok) return showToast(r.error ?? "未読にできませんでした。", "bad");
        // 自分で未読にしたので、見ているあいだは自動で既読にしない (チャンネルを開き直すまで)
        marked.current[m.channelId] = "9999";
        setLastReadOpen(new Date(Date.parse(m.at) - 1).toISOString());
        showToast("ここから未読にしました。");
        void sync();
        signalChatRefresh();
      });
    },
    onShare: (m) => setDialog({ kind: "share", m }),
    onProfile: (userId, anchor) => setProfile({ userId, anchor }),
    onOpenThread: (rootId) => void openThread(rootId),
    onOpenShared: (sh) => void openChannel(sh.channelId, { focus: sh.messageId, thread: sh.parentId }),
  };

  /** 社員と DM を開く (プロフィール・メンバーの一覧・すばやく移動から) */
  const openDm = useCallback(
    async (userId: string) => {
      const r = await openDirect([userId]).catch(() => null);
      if (!r?.ok || !r.data) return showToast(r?.error ?? "DM を開けませんでした。", "bad");
      await sync();
      void openChannel(r.data.channelId);
    },
    [openChannel, showToast, sync],
  );

  // すばやく移動 (Ctrl / ⌘ + K)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setDialog({ kind: "switcher" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /** 公開のチャンネルに参加する (見るだけの状態から) */
  const join = async (id: string) => {
    const r = await joinChatChannel(id).catch(() => null);
    if (!r?.ok) return showToast(r?.error ?? "参加できませんでした。", "bad");
    showToast("チャンネルに参加しました。");
    await sync();
    await loadChannel(id);
  };

  /** チャンネルを削除したあと (開いていたら一覧に戻る) */
  const afterDelete = (id: string) => {
    if (cidRef.current === id) {
      setShowList(true);
      setDetails(null);
      setThread(null);
      setPreview(null);
      go({ kind: "inbox" });
    }
    void sync();
  };

  /** 最後に送った自分のメッセージを編集 (入力欄が空のときの ↑) */
  const editLast = () => {
    const mine = [...msgs].reverse().find((m) => m.userId === dir.me.id && !m.deleted);
    if (mine) handlers.onEdit(mine);
  };

  const canDelete = (m: ChatMessageView) => m.userId === dir.me.id || (dir.me.role === "admin" && channels.find((c) => c.id === m.channelId)?.kind !== "dm");

  const saveEdit = async () => {
    if (!editing) return;
    const r = await editChatMessage(editing.id, editing.text).catch(() => null);
    if (!r?.ok || !r.data) return showToast(r?.error ?? "保存できませんでした。", "bad");
    patchMsg(editing.id, () => r.data!.message);
    setEditing(null);
  };

  const editor = editing && (
    <div className="mt-1">
      <textarea
        autoFocus
        value={editing.text}
        onChange={(e) => setEditing({ ...editing, text: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Escape") setEditing(null);
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229 && window.matchMedia("(pointer: fine)").matches) {
            e.preventDefault();
            void saveEdit();
          }
        }}
        rows={3}
        className="w-full resize-y rounded-xl border border-accent bg-panel px-3 py-2 text-[14px] outline-none ring-4 ring-accent/15"
        aria-label="メッセージを編集"
      />
      <div className="mt-1.5 flex items-center gap-2">
        <button type="button" onClick={() => void saveEdit()} className="inline-flex h-8 items-center rounded-xl bg-accent px-3 text-xs font-medium text-white hover:bg-accent-hover">
          保存する
        </button>
        <button type="button" onClick={() => setEditing(null)} className="inline-flex h-8 items-center rounded-xl border border-line px-3 text-xs text-ink-2 hover:bg-subtle">
          やめる
        </button>
        <span className="text-[11px] text-ink-3">Esc でやめる</span>
      </div>
    </div>
  );

  const onSent = (m: ChatMessageView, info?: { taskError?: string }) => {
    if (m.parentId && m.alsoChannel) setMsgs((prev) => mergeMsgs(prev, [m], {}, false));
    if (m.parentId) {
      setThread((th) => (th && th.root.id === m.parentId ? { ...th, replies: mergeMsgs(th.replies, [m], {}, false), root: { ...th.root, replyCount: th.root.replyCount + 1, lastReplyAt: m.at, replyUserIds: [...new Set([...th.root.replyUserIds, m.userId])] } } : th));
      patchMsg(m.parentId, (x) => ({ ...x, replyCount: x.replyCount + 1, lastReplyAt: m.at, replyUserIds: [...new Set([...x.replyUserIds, m.userId])] }));
    } else {
      atBottom.current = true;
      setMsgs((prev) => mergeMsgs(prev, [m], {}, false));
    }
    if (info?.taskError) showToast(`メッセージは送りましたが、業務依頼を作れませんでした: ${info.taskError}`, "bad");
    else if (m.task) showToast("業務依頼として送りました。依頼先の要対応に届きます。");
    window.setTimeout(() => void sync(), 400);
  };

  const toggleStar = async (c: ChatChannelView) => {
    const on = !c.starred;
    setChannels((list) => list.map((x) => (x.id === c.id ? { ...x, starred: on } : x)));
    setPreview((p) => (p && p.id === c.id ? { ...p, starred: on } : p));
    const r = await starChatChannel(c.id, on).catch(() => null);
    if (!r?.ok) showToast(r?.error ?? "スターを付けられませんでした。", "bad");
    void sync();
  };

  const changeNotify = async (id: string, level: "all" | "priority") => {
    setChannels((list) => list.map((c) => (c.id === id ? { ...c, notify: level } : c)));
    setPreview((p) => (p && p.id === id ? { ...p, notify: level } : p));
    const r = await setChatChannelNotify(id, level).catch(() => null);
    if (!r?.ok) showToast(r?.error ?? "通知の設定を変えられませんでした。", "bad");
    else showToast(level === "all" ? "すべてのメッセージを通知します。" : "自分あて (メンション・重要・業務依頼) だけ通知します。");
    void sync();
  };

  /* ---------------- 表示 ---------------- */

  const sysChannels = channels.filter((c) => c.kind !== "dm" && c.kind !== "custom");
  // 自分の店舗のチャンネルを全社のすぐ下に
  const mine = sysChannels.find((c) => c.kind === "store" && c.storeId === dir.me.storeId);
  const ordered = [...sysChannels.filter((c) => c.kind === "all"), ...(mine ? [mine] : []), ...sysChannels.filter((c) => c.kind !== "all" && c !== mine), ...channels.filter((c) => c.kind === "custom")];
  const starred = ordered.concat(channels.filter((c) => c.kind === "dm")).filter((c) => c.starred);
  const dms = channels.filter((c) => c.kind === "dm").sort((a, b) => (b.lastAt ?? "").localeCompare(a.lastAt ?? ""));
  const isChannelView = view.kind === "channel" || view.kind === "files" || view.kind === "pins";
  const activeId = isChannelView ? cid : "";

  const sidebar = (
    <aside className={clsx("min-h-0 w-full flex-col border-line bg-subtle/50 @3xl:w-64 @3xl:shrink-0 @3xl:border-r @5xl:w-72", showList ? "flex" : "hidden @3xl:flex")} aria-label="チャンネルと DM">
      <div className="flex items-center gap-1 border-b border-line px-3 py-2.5">
        <h1 className="flex-1 text-base font-bold text-ink">チャット</h1>
        <button type="button" onClick={() => setDialog({ kind: "prefs" })} className="rounded-lg p-2 text-ink-2 hover:bg-panel hover:text-ink" aria-label="通知の設定" title="通知の設定 (通知音・プッシュ通知)" data-testid="chat-prefs">
          {prefs.sound ? <Bell className="h-[18px] w-[18px]" /> : <BellOff className="h-[18px] w-[18px]" />}
        </button>
        <button type="button" onClick={() => setDialog({ kind: "dm" })} className="rounded-lg p-2 text-ink-2 hover:bg-panel hover:text-ink" aria-label="新しいメッセージ (DM)" title="新しいメッセージ (DM)" data-testid="chat-new-dm">
          <SquarePen className="h-[18px] w-[18px]" />
        </button>
      </div>
      <div className="flex gap-1.5 px-3 pt-2.5">
        <form
          className="min-w-0 flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (searchText.trim()) go({ kind: "search", q: searchText.trim() });
          }}
          role="search"
        >
          <label className="relative block">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-ink-3" />
            <input value={searchText} onChange={(e) => setSearchText(e.target.value)} placeholder="メッセージ・資料を検索" className="h-9 w-full rounded-xl border border-line bg-panel pr-3 pl-8 text-sm outline-none focus:border-accent focus:ring-4 focus:ring-accent/15" aria-label="メッセージ・資料を検索" />
          </label>
        </form>
        <button type="button" onClick={() => setDialog({ kind: "switcher" })} className="hidden h-9 shrink-0 items-center rounded-xl border border-line bg-panel px-2 text-[11px] text-ink-3 hover:text-ink pointer-fine:inline-flex" title="すばやく移動 (Ctrl / ⌘ + K)" aria-label="すばやく移動">
          ⌘K
        </button>
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pt-2 pb-4">
        <SideButton active={view.kind === "inbox"} onClick={() => go({ kind: "inbox" })} icon={<Inbox className="h-4 w-4" />} label="要対応" testId="chat-side-inbox" right={counts.action > 0 ? <Count n={counts.action} tone="red" /> : undefined} strong={counts.action > 0} />
        <SideButton active={view.kind === "saved"} onClick={() => go({ kind: "saved" })} icon={<Bookmark className="h-4 w-4" />} label="後で見る" testId="chat-side-saved" />
        <SideButton active={view.kind === "important"} onClick={() => go({ kind: "important" })} icon={<AlertTriangle className="h-4 w-4" />} label="重要メッセージ" />
        <Link href="/messages" className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm text-ink-2 hover:bg-panel hover:text-ink">
          <ListTodo className="h-4 w-4" />
          <span className="flex-1 truncate">業務依頼・社内連絡</span>
          {waiting.length > 0 && <span className="text-[11px] text-ink-3" title="自分が報告して、依頼した人の完了を待っているもの">待ち {waiting.length}</span>}
        </Link>
        {starred.length > 0 && (
          <>
            <SectionTitle label="スター付き" />
            {starred.map((c) => (
              <ChannelRow key={`s-${c.id}`} c={c} dir={dir} active={activeId === c.id} onClick={() => void openChannel(c.id)} />
            ))}
          </>
        )}
        <SectionTitle
          label="チャンネル"
          onAdd={() => setDialog({ kind: "channel" })}
          addLabel="チャンネルを作成"
          extra={
            <>
              {boot.canAdminChannels && (
                <button type="button" onClick={() => setDialog({ kind: "manage" })} className="rounded-md p-1 text-ink-3 hover:bg-panel hover:text-ink" aria-label="チャンネルの管理 (管理者)" title="チャンネルの管理 (管理者): すべてのチャンネルの追加・変更・削除" data-testid="chat-manage">
                  <Settings2 className="h-3.5 w-3.5" />
                </button>
              )}
              <button type="button" onClick={() => setDialog({ kind: "browse" })} className="rounded-md p-1 text-ink-3 hover:bg-panel hover:text-ink" aria-label="チャンネルを探す" title="チャンネルを探す" data-testid="chat-browse">
                <Search className="h-3.5 w-3.5" />
              </button>
            </>
          }
        />
        {ordered.filter((c) => !c.starred).map((c) => (
          <ChannelRow key={c.id} c={c} dir={dir} active={activeId === c.id} onClick={() => void openChannel(c.id)} />
        ))}
        <button type="button" onClick={() => setDialog({ kind: "browse" })} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-ink-3 hover:bg-panel hover:text-ink">
          <span className="flex h-5 w-5 items-center justify-center rounded-md bg-line/70">
            <Plus className="h-3.5 w-3.5" />
          </span>
          チャンネルを探す・作成
        </button>
        <SectionTitle label="ダイレクトメッセージ" onAdd={() => setDialog({ kind: "dm" })} addLabel="新しい DM" />
        {dms.length === 0 && <p className="px-2.5 py-1 text-[11px] text-ink-3">右の「+」から、社員と 1 対 1・数人でやりとりできます。</p>}
        {dms.filter((c) => !c.starred).map((c) => (
          <ChannelRow key={c.id} c={c} dir={dir} active={activeId === c.id} onClick={() => void openChannel(c.id)} />
        ))}
      </nav>
    </aside>
  );

  const visible = msgs.filter((m) => !m.deleted || m.replyCount > 0);
  const rows: ReactNode[] = [];
  {
    let prev: ChatMessageView | undefined;
    let unreadShown = false;
    for (const m of visible) {
      const newDay = !prev || dayKey(prev.at) !== dayKey(m.at);
      if (newDay) rows.push(<DayDivider key={`d-${dayKey(m.at)}`} label={dayLabel(m.at)} />);
      let divider = false;
      if (!unreadShown && lastReadOpen && m.at > lastReadOpen && m.userId !== dir.me.id) {
        rows.push(<UnreadDivider key="unread" />);
        unreadShown = true;
        divider = true;
      }
      const compact = Boolean(prev && !newDay && !divider && prev.userId === m.userId && !prev.deleted && !m.important && !prev.important && !m.alsoChannel && !m.shared && Date.parse(m.at) - Date.parse(prev.at) < 5 * 60_000);
      rows.push(<MessageItem key={m.id} m={m} dir={dir} h={handlers} compact={compact} canDelete={canDelete(m)} highlight={m.id === focusId} editing={editing?.id === m.id} editor={editing?.id === m.id ? editor : undefined} />);
      prev = m;
    }
  }

  const tabCls = (on: boolean) => clsx("inline-flex h-9 shrink-0 items-center gap-1.5 border-b-2 px-2.5 text-[13px] font-medium", on ? "border-accent text-ink" : "border-transparent text-ink-3 hover:text-ink");
  const header =
    channel && isChannelView ? (
      <div className="border-b border-line">
        <div className="flex items-center gap-1.5 px-2 pt-2 pb-1 @xl:px-3">
          <button type="button" onClick={() => (setShowList(true), pushUrl("/chat"))} className="rounded-lg p-2 text-ink-2 hover:bg-subtle @3xl:hidden" aria-label="チャンネルの一覧に戻る">
            <ChevronLeft className="h-5 w-5" />
          </button>
          <button type="button" onClick={() => setDetails((d) => (d === "about" ? null : "about"))} className="group flex min-w-0 items-center gap-2 rounded-lg px-1 py-0.5 text-left hover:bg-subtle" aria-label="チャンネルの詳細" data-testid="chat-channel-details">
            <ChannelIcon c={channel} dir={dir} size={28} />
            <h2 className="truncate text-[16px] font-bold text-ink" data-testid="chat-channel-title">
              {channel.kind === "dm" ? channel.name : channel.name}
            </h2>
            <ChevronDown className="h-4 w-4 shrink-0 text-ink-3 group-hover:text-ink" />
          </button>
          <button type="button" onClick={() => void toggleStar(channel)} className={clsx("rounded-lg p-1.5", channel.starred ? "text-warn" : "text-ink-3 hover:bg-subtle hover:text-ink")} aria-label={channel.starred ? "スターを外す" : "スターを付ける"} title={channel.starred ? "スターを外す" : "スターを付ける (一覧の上に出す)"} data-testid="chat-star">
            <Star className={clsx("h-4 w-4", channel.starred && "fill-current")} />
          </button>
          <span className="min-w-0 flex-1 truncate text-[12px] text-ink-3 max-[560px]:hidden">{channel.kind !== "dm" && channel.topic}</span>
          <button type="button" onClick={() => setDetails((d) => (d === "members" ? null : "members"))} className={clsx("flex shrink-0 items-center gap-1.5 rounded-lg border px-1.5 py-1 hover:bg-subtle", details === "members" ? "border-accent/50 bg-accent-soft/50" : "border-line")} aria-label={`メンバー ${channel.memberIds.length} 人を見る`} title="メンバーを見る" data-testid="chat-members-button">
            <span className="flex -space-x-1.5">
              {channel.memberIds.slice(0, 3).map((id) => (
                <UserAvatar key={id} dir={dir} id={id} size={20} />
              ))}
            </span>
            <span className="text-[12px] font-semibold text-ink-2 tnum">{channel.memberIds.length}</span>
          </button>
          <button type="button" onClick={() => void changeNotify(channel.id, channel.notify === "all" ? "priority" : "all")} className={clsx("shrink-0 rounded-lg p-1.5", channel.notify === "all" ? "bg-accent-soft text-accent-ink" : "text-ink-2 hover:bg-subtle")} title={channel.notify === "all" ? "すべてのメッセージを通知 (押すと自分あてだけに)" : "自分あてだけ通知 (押すとすべて通知に)"} aria-label="このチャンネルの通知" data-testid="chat-notify-toggle">
            {channel.notify === "all" ? <Bell className="h-4 w-4" /> : <BellOff className="h-4 w-4" />}
          </button>
        </div>
        <div className="flex items-end gap-0.5 overflow-x-auto px-2 @xl:px-3" role="tablist">
          <button type="button" role="tab" aria-selected={view.kind === "channel"} onClick={() => void openChannel(channel.id)} className={tabCls(view.kind === "channel")}>
            <MessageSquare className="h-3.5 w-3.5" />
            メッセージ
          </button>
          <button type="button" role="tab" aria-selected={view.kind === "pins"} onClick={() => go({ kind: "pins", id: channel.id })} className={tabCls(view.kind === "pins")} data-testid="chat-tab-pins">
            <Pin className="h-3.5 w-3.5" />
            ピン留め{channel.pinCount ? ` ${channel.pinCount}` : ""}
          </button>
          <button type="button" role="tab" aria-selected={view.kind === "files"} onClick={() => go({ kind: "files", id: channel.id })} className={tabCls(view.kind === "files")}>
            <FolderOpen className="h-3.5 w-3.5" />
            資料・写真
          </button>
          <button type="button" role="tab" aria-selected={details === "members"} onClick={() => setDetails((d) => (d === "members" ? null : "members"))} className={tabCls(details === "members")}>
            <UsersRound className="h-3.5 w-3.5" />
            メンバー {channel.memberIds.length}
          </button>
        </div>
      </div>
    ) : null;

  const [dragging, setDragging] = useState(false);
  const joinBar = channel && !channel.canPost && channel.kind === "custom" && !channel.archived && (
    <div className="flex flex-wrap items-center justify-center gap-3 border-t border-line bg-subtle/60 px-4 py-3 text-center text-sm text-ink-2">
      <span>
        <strong className="text-ink"># {channel.name}</strong> を見ています。参加するとメッセージを送れます。
      </span>
      <button type="button" onClick={() => void join(channel.id)} className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-accent px-4 text-sm font-semibold text-white hover:bg-accent-hover" data-testid="chat-join">
        チャンネルに参加
      </button>
    </div>
  );
  const channelPane = channel && view.kind === "channel" && (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onDragOver={(e) => {
        if ([...e.dataTransfer.types].includes("Files") && channel.canPost) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const files = [...e.dataTransfer.files];
        if (files.length) composerRef.current?.addFiles(files);
      }}
    >
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto overscroll-contain pt-1 pb-2" data-testid="chat-messages">
        {hasMore && (
          <div className="flex justify-center py-3">
            <button type="button" onClick={() => void loadOlder()} disabled={loadingOlder} className="rounded-full border border-line px-3 py-1 text-xs text-ink-2 hover:bg-subtle">
              {loadingOlder ? "読み込んでいます…" : "前のメッセージを読む"}
            </button>
          </div>
        )}
        {!hasMore && !loading && <ChannelIntro c={channel} dir={dir} onMembers={() => setDetails("members")} />}
        {loading && msgs.length === 0 ? <p className="py-10 text-center text-sm text-ink-3">読み込んでいます…</p> : rows}
      </div>
      {newBelow > 0 && (
        <button type="button" onClick={() => scrollToBottom(true)} className="absolute left-1/2 z-10 inline-flex -translate-x-1/2 items-center gap-1 rounded-full bg-accent px-3 py-1.5 text-xs font-medium text-white shadow-lift" style={{ bottom: 130 }}>
          <ArrowDown className="h-3.5 w-3.5" />
          新しいメッセージ {newBelow} 件
        </button>
      )}
      {dragging && <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-accent bg-accent-soft/80 text-sm font-medium text-accent-ink">ここにファイルを落とすと添付します</div>}
      {channel.archived ? (
        <p className="border-t border-line bg-subtle px-4 py-3 text-center text-sm text-ink-3">このチャンネルはアーカイブしています (送れません)。</p>
      ) : joinBar ? (
        joinBar
      ) : (
        <Composer
          handleRef={composerRef}
          channel={channel}
          dir={dir}
          canImportant={boot.canImportant}
          maxFileBytes={boot.maxFileBytes}
          onSent={onSent}
          typing={typing.channel}
          onEditLast={editLast}
          placeholder={channel.kind === "dm" ? `${channel.name} さんへのメッセージ` : `# ${channel.name} へのメッセージ`}
        />
      )}
    </div>
  );

  const threadPane = thread && view.kind === "channel" && channel && !details && (
    <section className="absolute inset-0 z-20 flex min-h-0 flex-col bg-panel @7xl:static @7xl:z-auto @7xl:w-[400px] @7xl:shrink-0 @7xl:border-l @7xl:border-line" aria-label="スレッド">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-bold text-ink">スレッド</h3>
          <p className="truncate text-[11px] text-ink-3">{channel.kind === "dm" ? channel.name : `# ${channel.name}`}</p>
        </div>
        <button type="button" onClick={() => (setThread(null), pushUrl(viewUrl({ kind: "channel", id: channel.id }), true))} className="rounded-lg p-2 text-ink-2 hover:bg-subtle" aria-label="スレッドを閉じる">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div ref={threadScrollRef} className="min-h-0 flex-1 overflow-y-auto pt-2 pb-2">
        <MessageItem m={thread.root} dir={dir} h={{ ...handlers, onReply: undefined }} compact={false} inThread canDelete={canDelete(thread.root)} editing={editing?.id === thread.root.id} editor={editing?.id === thread.root.id ? editor : undefined} highlight={thread.root.id === focusId} />
        <div className="flex items-center gap-3 px-4 py-2 text-[11px] text-ink-3">
          {thread.replies.filter((r) => !r.deleted).length} 件の返信
          <span className="h-px flex-1 bg-line" />
        </div>
        {(() => {
          const out: ReactNode[] = [];
          let prev: ChatMessageView | undefined;
          let unreadShown = false;
          for (const m of thread.replies) {
            if (m.deleted) continue;
            let divider = false;
            if (!unreadShown && thread.lastRead && m.at > thread.lastRead && m.userId !== dir.me.id) {
              out.push(<UnreadDivider key="unread" />);
              unreadShown = divider = true;
            }
            const compact = Boolean(prev && !divider && prev.userId === m.userId && dayKey(prev.at) === dayKey(m.at) && Date.parse(m.at) - Date.parse(prev.at) < 5 * 60_000);
            out.push(<MessageItem key={m.id} m={m} dir={dir} h={handlers} compact={compact} inThread canDelete={canDelete(m)} highlight={m.id === focusId} editing={editing?.id === m.id} editor={editing?.id === m.id ? editor : undefined} />);
            prev = m;
          }
          return out;
        })()}
      </div>
      {!channel.archived && channel.canPost && <Composer channel={channel} parentId={thread.root.id} dir={dir} canImportant={boot.canImportant} maxFileBytes={boot.maxFileBytes} onSent={onSent} placeholder="返信する…" compact typing={typing.thread} />}
    </section>
  );

  const detailsPane = details && channel && isChannelView && (
    <DetailsPanel
      channel={channel}
      dir={dir}
      tab={details}
      onTab={setDetails}
      onClose={() => setDetails(null)}
      onDm={(id) => void openDm(id)}
      onAdd={async (ids) => {
        const r = await addChatMembers(channel.id, ids).catch(() => null);
        if (!r?.ok) return showToast(r?.error ?? "追加できませんでした。", "bad"), false;
        showToast(`${r.data?.added ?? ids.length} 人をメンバーに追加しました。`);
        await sync();
        await loadChannel(channel.id);
        return true;
      }}
      onRemove={async (id) => {
        if (!confirm(`${nameOf(dir, id)} さんをこのチャンネルから外しますか？`)) return;
        const r = await removeChatMember(channel.id, id).catch(() => null);
        if (!r?.ok) return showToast(r?.error ?? "外せませんでした。", "bad");
        showToast("メンバーから外しました。");
        await sync();
        await loadChannel(channel.id);
      }}
      onJoin={() => void join(channel.id)}
      onLeave={async () => {
        if (!confirm(`# ${channel.name} から抜けますか？`)) return;
        const r = await leaveChatChannel(channel.id).catch(() => null);
        if (!r?.ok) return showToast(r?.error ?? "抜けられませんでした。", "bad");
        showToast("チャンネルから抜けました。");
        setDetails(null);
        await sync();
        if (channel.visibility === "public") await loadChannel(channel.id);
        else {
          setShowList(true);
          go({ kind: "inbox" });
        }
      }}
      onEdit={() => setDialog({ kind: "channel", channel })}
      onNotify={(level) => void changeNotify(channel.id, level)}
    />
  );

  let main: ReactNode = channelPane;
  const back = () => (setShowList(true), pushUrl("/chat"));
  if (view.kind === "inbox") main = <InboxPane items={inbox} waiting={waiting} dir={dir} onOpen={(i) => (i.channelId && i.messageId ? void openChannel(i.channelId, { focus: i.messageId, thread: i.parentId }) : i.href ? router.push(i.href) : undefined)} onAck={(i) => i.messageId && handlers.onAck({ id: i.messageId } as ChatMessageView)} onBack={back} />;
  if (view.kind === "important") main = <ImportantPane dir={dir} h={handlers} onOpen={(m) => void openChannel(m.channelId, { focus: m.id, thread: m.parentId })} onBack={back} />;
  if (view.kind === "saved") main = <ListPane key="saved" url="/api/chat/saved" title="後で見る" sub="自分が保存したメッセージ (自分だけに見えます)" icon={<Bookmark className="h-4 w-4" />} empty="保存したメッセージはまだありません。メッセージの「…」→「後で見る」で保存できます。" dir={dir} onOpen={(m) => void openChannel(m.channelId, { focus: m.id, thread: m.parentId && !m.alsoChannel ? m.parentId : undefined })} onBack={back} onUnsave={(m) => handlers.onSave({ ...m, saved: true })} />;
  if (view.kind === "search") main = <SearchPane key={view.q} q={view.q} dir={dir} channels={channels} onOpen={(m) => void openChannel(m.channelId, { focus: m.id, thread: m.parentId && !m.alsoChannel ? m.parentId : undefined })} onBack={back} />;
  if (view.kind === "files" && channel) main = <FilesPane key={channel.id} channel={channel} onImage={(messageId, files, index) => setDialog({ kind: "image", messageId, files, index })} onOpen={(messageId, parentId) => void openChannel(channel.id, { focus: messageId, thread: parentId })} />;
  if (view.kind === "pins" && channel) main = <ListPane key={`pins-${channel.id}`} url={`/api/chat/pins?c=${encodeURIComponent(channel.id)}`} title="" sub="" icon={null} empty="ピン留めしたメッセージはまだありません。大事なメッセージの「…」→「チャンネルにピン留め」で、ここにまとめられます。" dir={dir} onOpen={(m) => void openChannel(channel.id, { focus: m.id, thread: m.parentId && !m.alsoChannel ? m.parentId : undefined })} embedded />;

  return (
    <div ref={wrapRef} className="-mt-2 mb-[-84px] h-[calc(100dvh-108px)] lg:-mt-4 lg:h-[calc(100dvh-108px)]" style={height ? { height } : undefined}>
      <div className="@container relative mx-auto flex h-full max-w-[1680px] overflow-hidden rounded-2xl border border-line bg-panel shadow-card" data-testid="chat-app">
        {sidebar}
        <section className={clsx("relative min-h-0 min-w-0 flex-1 flex-col", showList ? "hidden @3xl:flex" : "flex")}>
          {header}
          {main ?? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-ink-3">
              <Hash className="h-8 w-8" />
              左の一覧からチャンネル・DM を選んでください
            </div>
          )}
        </section>
        {threadPane}
        {detailsPane}
      </div>
      {dialog?.kind === "dm" && <NewDmDialog dir={dir} onClose={() => setDialog(null)} onOpen={(id) => (setDialog(null), void sync().then(() => openChannel(id)))} />}
      {dialog?.kind === "channel" && (
        <ChannelDialog
          key={dialog.channel?.id ?? "new"}
          dir={dir}
          channel={dialog.channel}
          messages={dialog.messages}
          onClose={() => setDialog(dialog.back === "manage" ? { kind: "manage" } : null)}
          onSaved={(id, info) => {
            const back = dialog.back;
            setDialog(back === "manage" ? { kind: "manage" } : null);
            void sync().then(() => {
              if (info?.archived && cidRef.current === id) {
                setShowList(true);
                setDetails(null);
                go({ kind: "inbox" });
              } else if (!info?.archived && back !== "manage") void openChannel(id);
              else if (cidRef.current === id) void loadChannel(id);
            });
            showToast(info?.note ?? (info?.archived ? "チャンネルをアーカイブしました。" : dialog.channel ? "チャンネルを保存しました。" : "チャンネルを作成しました。"), info?.note ? "bad" : "good");
          }}
          onDeleted={(id) => {
            setDialog(dialog.back === "manage" ? { kind: "manage" } : null);
            showToast("チャンネルを削除しました。");
            afterDelete(id);
          }}
        />
      )}
      {dialog?.kind === "manage" && (
        <ManageDialog
          dir={dir}
          onClose={() => setDialog(null)}
          onOpen={(id) => (setDialog(null), void openChannel(id))}
          onEdit={(row: ManageRow) => setDialog({ kind: "channel", channel: row, back: "manage", messages: row.messages })}
          onCreate={() => setDialog({ kind: "channel" })}
          onChanged={(text, deletedId) => {
            showToast(text);
            if (deletedId) afterDelete(deletedId);
            else void sync();
          }}
        />
      )}
      {dialog?.kind === "browse" && (
        <BrowseDialog
          onClose={() => setDialog(null)}
          onCreate={() => setDialog({ kind: "channel" })}
          onManage={boot.canAdminChannels ? () => setDialog({ kind: "manage" }) : undefined}
          onOpen={(id, doJoin) => {
            setDialog(null);
            if (doJoin) void joinChatChannel(id).then(async (r) => {
              if (!r.ok) return showToast(r.error ?? "参加できませんでした。", "bad");
              showToast("チャンネルに参加しました。");
              await sync();
              void openChannel(id);
            });
            else void openChannel(id);
          }}
        />
      )}
      {dialog?.kind === "share" && (
        <ShareDialog
          dir={dir}
          m={dialog.m}
          channels={channels}
          onClose={() => setDialog(null)}
          onDone={(target) => {
            setDialog(null);
            showToast("メッセージを共有しました。");
            void sync();
            if (target === cid) void loadChannel(cid);
          }}
        />
      )}
      {dialog?.kind === "switcher" && (
        <QuickSwitcher
          dir={dir}
          channels={channels}
          onClose={() => setDialog(null)}
          onPick={(x) => {
            setDialog(null);
            if (x.kind === "person") void openDm(x.id);
            else void openChannel(x.id);
          }}
        />
      )}
      {dialog?.kind === "task" && (
        <TaskDialog
          dir={dir}
          m={dialog.m}
          prefer={channel?.memberIds ?? []}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            showToast("業務依頼にしました。依頼先の要対応に届きます。");
            void sync();
            void loadChannel(cidRef.current, dialog.m.parentId ? undefined : dialog.m.id);
          }}
        />
      )}
      {dialog?.kind === "acks" && <AckDialog dir={dir} m={dialog.m} onClose={() => setDialog(null)} onReminded={(n) => (setDialog(null), showToast(`まだ確認していない ${n} 人にもう一度知らせました。`), void sync())} />}
      {dialog?.kind === "prefs" && <PrefsDialog prefs={prefs} vapidKey={boot.vapidKey} channels={channels} onClose={() => setDialog(null)} onPrefs={(p) => (setPrefs(p), signalChatRefresh())} onChannelNotify={(id, level) => void changeNotify(id, level)} />}
      {dialog?.kind === "image" && <Lightbox messageId={dialog.messageId} files={dialog.files} index={dialog.index} onClose={() => setDialog(null)} />}
      {profile && <ProfileCard dir={dir} userId={profile.userId} anchor={profile.anchor} onClose={() => setProfile(null)} onDm={(id) => void openDm(id)} />}
    </div>
  );
}

/* ================================================================== */
/* チャンネルの詳細 (概要・メンバー)                                      */
/* ================================================================== */

function DetailsPanel({
  channel,
  dir,
  tab,
  onTab,
  onClose,
  onDm,
  onAdd,
  onRemove,
  onJoin,
  onLeave,
  onEdit,
  onNotify,
}: {
  channel: ChatChannelView;
  dir: Dir;
  tab: "about" | "members";
  onTab: (t: "about" | "members") => void;
  onClose: () => void;
  onDm: (userId: string) => void;
  onAdd: (ids: string[]) => Promise<boolean>;
  onRemove: (userId: string) => void;
  onJoin: () => void;
  onLeave: () => void;
  onEdit: () => void;
  onNotify: (level: "all" | "priority") => void;
}) {
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState<string[] | null>(null);
  const members = channel.memberIds
    .map((id) => dir.users.get(id))
    .filter((u): u is NonNullable<typeof u> => Boolean(u))
    .filter((u) => !q.trim() || matchName(q, u.name, u.kana) > 0)
    .sort((a, b) => Number(dir.online.has(b.id)) - Number(dir.online.has(a.id)) || a.kana.localeCompare(b.kana, "ja"));
  const onlineCount = channel.memberIds.filter((id) => dir.online.has(id)).length;
  const kindNote: Record<string, string> = {
    all: "全社員が自動で参加しています (異動・退職で自動で入れ替わります)。",
    store: "この店舗に所属する社員と店長が自動で参加しています (異動・退職で自動で入れ替わります)。管理者がメンバーを足す・外すことができます。メンバー以外には見えません。",
    managers: "各店舗の店長が自動で参加しています。管理者がメンバーを足す・外すことができます。メンバー以外には見えません。",
    custom: channel.visibility === "public" ? "公開のチャンネルです。社員なら誰でも「チャンネルを探す」から参加できます。" : "非公開のチャンネルです。メンバーだけが見られます。",
    dm: "参加している本人同士だけが見られます (管理者も見られません)。",
  };
  const ROLE: Record<string, string> = { admin: "管理者", hq_staff: "本部", store_manager: "店長", store_staff: "" };
  return (
    <section className="absolute inset-0 z-30 flex min-h-0 flex-col bg-panel @6xl:static @6xl:z-auto @6xl:w-[360px] @6xl:shrink-0 @6xl:border-l @6xl:border-line" aria-label="チャンネルの詳細" data-testid="chat-details">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <ChannelIcon c={channel} dir={dir} size={28} />
        <h3 className="min-w-0 flex-1 truncate text-[15px] font-bold text-ink">{channel.kind === "dm" ? channel.name : `# ${channel.name}`}</h3>
        <button type="button" onClick={onClose} className="rounded-lg p-2 text-ink-2 hover:bg-subtle" aria-label="詳細を閉じる">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex gap-0.5 border-b border-line px-3" role="tablist">
        {(
          [
            ["about", "概要"],
            ["members", `メンバー ${channel.memberIds.length}`],
          ] as const
        ).map(([t, label]) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => onTab(t)} className={clsx("h-9 border-b-2 px-2.5 text-[13px] font-medium", tab === t ? "border-accent text-ink" : "border-transparent text-ink-3 hover:text-ink")}>
            {label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {tab === "about" ? (
          <div className="space-y-3 text-sm">
            {channel.kind !== "dm" && (
              <div className="flex items-center gap-3 rounded-xl border border-line p-3">
                <ChannelIcon c={channel} dir={dir} size={56} />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-1 text-[15px] font-bold text-ink"><ChannelName c={channel} /></div>
                  <div className="text-[11px] text-ink-3">{channel.image ? (channel.imageInherited ? "本部のチャンネルの画像" : "チャンネルの画像") : "画像は登録されていません"}</div>
                </div>
                {channel.canEditImage && (
                  <button type="button" onClick={onEdit} className="shrink-0 rounded-lg border border-line px-2.5 py-1.5 text-xs text-ink hover:bg-subtle" data-testid="chat-details-image">
                    {channel.image && !channel.imageInherited ? "画像を変える" : "画像を登録"}
                  </button>
                )}
              </div>
            )}
            <div className="rounded-xl border border-line p-3">
              <div className="text-[11px] font-semibold text-ink-3">説明</div>
              <p className="mt-0.5 whitespace-pre-wrap text-ink">{channel.topic || "(説明はありません)"}</p>
              <p className="mt-2 text-[11px] text-ink-3">{kindNote[channel.kind]}</p>
              {channel.kind === "custom" && (
                <p className="mt-1 text-[11px] text-ink-3">
                  作成: {nameOf(dir, channel.createdBy)}
                  {channel.createdAt ? ` · ${fullWhen(channel.createdAt)}` : ""} · {channel.visibility === "public" ? "公開" : "非公開"}
                </p>
              )}
            </div>
            <div className="rounded-xl border border-line p-3">
              <div className="mb-1.5 text-[11px] font-semibold text-ink-3">通常のメッセージの通知</div>
              <div className="flex rounded-lg border border-line p-0.5 text-xs">
                <button type="button" onClick={() => onNotify("all")} className={clsx("inline-flex flex-1 items-center justify-center gap-1 rounded-md px-2 py-1.5", channel.notify === "all" ? "bg-accent text-white" : "text-ink-2 hover:bg-subtle")}>
                  <Bell className="h-3.5 w-3.5" />
                  すべて
                </button>
                <button type="button" onClick={() => onNotify("priority")} className={clsx("inline-flex flex-1 items-center justify-center gap-1 rounded-md px-2 py-1.5", channel.notify === "priority" ? "bg-accent text-white" : "text-ink-2 hover:bg-subtle")}>
                  <BellOff className="h-3.5 w-3.5" />
                  自分あてだけ
                </button>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {(channel.canManage || channel.canEditImage) && (
                <button type="button" onClick={onEdit} className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-line px-3 text-[13px] text-ink hover:bg-subtle" data-testid="chat-details-settings">
                  <Settings2 className="h-4 w-4" />
                  {!channel.canManage ? "画像を変える" : channel.kind === "custom" ? "名前・説明・画像・公開範囲を変える" : channel.kind === "all" ? "説明・画像を変える" : "説明・画像・メンバーを変える"}
                </button>
              )}
              {channel.kind === "custom" && !channel.joined && channel.visibility === "public" && (
                <button type="button" onClick={onJoin} className="inline-flex h-9 items-center rounded-xl bg-accent px-3 text-[13px] font-semibold text-white hover:bg-accent-hover">
                  チャンネルに参加
                </button>
              )}
              {channel.kind === "custom" && channel.joined && channel.createdBy !== dir.me.id && (
                <button type="button" onClick={onLeave} className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-critical/30 px-3 text-[13px] text-critical-ink hover:bg-critical-soft">
                  <LogOut className="h-4 w-4" />
                  チャンネルから抜ける
                </button>
              )}
            </div>
          </div>
        ) : (
          <div>
            <p className="mb-2 text-[11px] text-ink-3">
              {kindNote[channel.kind]} オンライン {onlineCount} 人 / {channel.memberIds.length} 人
            </p>
            <label className="relative mb-2 block">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-ink-3" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="メンバーを探す" className="h-9 w-full rounded-xl border border-line bg-panel pr-3 pl-8 text-sm outline-none focus:border-accent focus:ring-4 focus:ring-accent/15" />
            </label>
            {channel.canAddMembers &&
              (adding ? (
                <div className="mb-3 rounded-xl border border-accent/40 bg-accent-soft/30 p-2.5">
                  <PeoplePicker dir={dir} value={adding} onChange={setAdding} exclude={channel.memberIds} label="追加する社員を探す" />
                  <div className="mt-2 flex justify-end gap-2">
                    <button type="button" onClick={() => setAdding(null)} className="h-8 rounded-lg border border-line px-3 text-xs hover:bg-subtle">
                      やめる
                    </button>
                    <button type="button" disabled={!adding.length} onClick={() => void onAdd(adding).then((ok) => ok && setAdding(null))} className="h-8 rounded-lg bg-accent px-3 text-xs font-semibold text-white disabled:opacity-50" data-testid="chat-add-members-save">
                      {adding.length ? `${adding.length} 人を追加` : "追加"}
                    </button>
                  </div>
                </div>
              ) : (
                <button type="button" onClick={() => setAdding([])} className="mb-2 flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-sm text-accent hover:bg-accent-soft" data-testid="chat-add-members">
                  <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-soft">
                    <UserPlus className="h-4 w-4" />
                  </span>
                  メンバーを追加
                </button>
              ))}
            <ul className="space-y-0.5" data-testid="chat-member-list">
              {members.map((u) => (
                <li key={u.id} className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-subtle">
                  <UserAvatar dir={dir} id={u.id} size={32} presence />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-semibold text-ink">{u.name}</span>
                      {u.id === dir.me.id && <span className="text-[10px] text-ink-3">(自分)</span>}
                      {channel.createdBy === u.id && channel.kind === "custom" && <span className="rounded bg-neutral-soft px-1 text-[10px] text-ink-2">作成者</span>}
                      {channel.addedIds?.includes(u.id) && <span className="rounded bg-neutral-soft px-1 text-[10px] text-ink-2" title="管理者が追加したメンバー">追加</span>}
                      {ROLE[u.role] && <span className="rounded bg-accent-soft px-1 text-[10px] text-accent-ink">{ROLE[u.role]}</span>}
                    </span>
                    <span className="block truncate text-[11px] text-ink-3">{[dir.stores.find((s) => s.id === u.storeId)?.name, u.title].filter(Boolean).join(" · ")}</span>
                  </span>
                  {u.id !== dir.me.id && (
                    <button type="button" onClick={() => onDm(u.id)} className="rounded-lg p-1.5 text-ink-3 opacity-70 hover:bg-panel hover:text-accent group-hover:opacity-100" aria-label={`${u.name} さんに DM`} title="DM を送る">
                      <MessageSquare className="h-4 w-4" />
                    </button>
                  )}
                  {channel.canRemoveMembers && !(channel.kind === "custom" && u.id === channel.createdBy) && (
                    <button type="button" onClick={() => onRemove(u.id)} className="rounded-lg p-1.5 text-ink-3 opacity-70 hover:bg-critical-soft hover:text-critical-ink group-hover:opacity-100" aria-label={`${u.name} さんを外す`} title="チャンネルから外す">
                      <UserMinus className="h-4 w-4" />
                    </button>
                  )}
                </li>
              ))}
              {!members.length && <li className="px-2 py-4 text-center text-xs text-ink-3">見つかりません</li>}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}

/* ================================================================== */
/* サイドバーの部品                                                      */
/* ================================================================== */

function Count({ n, tone }: { n: number; tone: "red" | "blue" | "gray" }) {
  return <span className={clsx("flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-[10px] font-semibold tnum", tone === "red" ? "bg-critical text-white" : tone === "blue" ? "bg-info text-white" : "bg-line text-ink-2")}>{n > 99 ? "99+" : n}</span>;
}

function SideButton({ active, onClick, icon, label, right, strong, testId }: { active: boolean; onClick: () => void; icon: ReactNode; label: string; right?: ReactNode; strong?: boolean; testId?: string }) {
  return (
    <button type="button" onClick={onClick} data-testid={testId} className={clsx("flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm", active ? "bg-accent text-white" : strong ? "font-semibold text-ink hover:bg-panel" : "text-ink-2 hover:bg-panel hover:text-ink")} aria-current={active ? "page" : undefined}>
      {icon}
      <span className="flex-1 truncate">{label}</span>
      {right}
    </button>
  );
}

function SectionTitle({ label, onAdd, addLabel, extra }: { label: string; onAdd?: () => void; addLabel?: string; extra?: ReactNode }) {
  return (
    <div className="mt-4 mb-1 flex items-center gap-0.5 px-2.5">
      <span className="flex-1 text-[11px] font-semibold tracking-wide text-ink-3">{label}</span>
      {extra}
      {onAdd && (
        <button type="button" onClick={onAdd} className="rounded-md p-1 text-ink-3 hover:bg-panel hover:text-ink" aria-label={addLabel} title={addLabel} data-testid={addLabel === "チャンネルを作成" ? "chat-create-channel" : undefined}>
          <Plus className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

function ChannelRow({ c, dir, active, onClick }: { c: ChatChannelView; dir: Dir; active: boolean; onClick: () => void }) {
  const unread = c.unread > 0;
  return (
    <button type="button" onClick={onClick} className={clsx("group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm", active ? "bg-accent text-white" : unread || c.mentions ? "font-bold text-ink hover:bg-panel" : "text-ink-2 hover:bg-panel hover:text-ink")} aria-current={active ? "page" : undefined} data-testid={`chat-ch-${c.id}`}>
      <ChannelIcon c={c} dir={dir} />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{c.name}</span>
        {c.kind === "dm" && c.lastPreview && <span className={clsx("block truncate text-[11px] font-normal", active ? "text-white/80" : "text-ink-3")}>{c.lastPreview}</span>}
      </span>
      {c.notify === "all" && c.kind !== "dm" && !c.mentions && !unread && <Bell className={clsx("h-3 w-3", active ? "text-white/70" : "text-ink-3")} aria-label="すべて通知" />}
      {c.mentions > 0 ? <Count n={c.mentions} tone="red" /> : unread ? c.notify === "all" ? <Count n={c.unread} tone="blue" /> : <span className={clsx("h-2 w-2 rounded-full", active ? "bg-white" : "bg-ink-2")} aria-label="未読あり" /> : null}
    </button>
  );
}

/** チャンネルの名前の前の印: 公開 = # / 非公開 = 鍵 (アイコンの右下の鍵の印と同じ区別) */
function ChannelName({ c }: { c: Pick<ChatChannelView, "kind" | "visibility" | "name"> }) {
  return (
    <>
      {isPrivateChannel(c) ? <Lock className="h-[0.85em] w-[0.85em] shrink-0" aria-label="非公開" /> : <span aria-hidden>#</span>}
      <span className="truncate">{c.name}</span>
    </>
  );
}

function ChannelIntro({ c, dir, onMembers }: { c: ChatChannelView; dir: Dir; onMembers: () => void }) {
  const text: Record<string, string> = {
    all: "全社員が参加するチャンネルです。全員へのお知らせ・全店舗で共有したい内容をここで公開します。",
    store: "この店舗の社員と店長が参加するチャンネルです。店舗の中の連絡・相談・写真の共有に使います (メンバーだけが見られます)。",
    managers: "各店舗の店長が参加するチャンネルです。店長への指示や店長会議の資料に使います (メンバーだけが見られます)。",
    custom: c.visibility === "public" ? "公開のチャンネルです。社員なら誰でも参加できます。" : "非公開のチャンネルです。メンバーだけが見られます。",
    dm: "参加している本人同士だけが見られる個別のメッセージです (管理者も見られません)。",
  };
  return (
    <div className="px-4 pt-6 pb-3 @xl:px-5">
      <ChannelIcon c={c} dir={dir} size={44} />
      <h3 className="mt-2 flex items-center gap-1 text-lg font-bold text-ink">{c.kind === "dm" ? c.name : <ChannelName c={c} />}</h3>
      <p className="mt-1 max-w-xl text-[13px] leading-relaxed text-ink-2">
        {text[c.kind]}
        {c.kind === "custom" && c.createdBy ? ` ${nameOf(dir, c.createdBy)} さんが${c.createdAt ? ` ${fullWhen(c.createdAt)} に` : ""}作成しました。` : ""}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" onClick={onMembers} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-3 text-xs text-ink hover:bg-subtle">
          <UsersRound className="h-3.5 w-3.5" />
          メンバー {c.memberIds.length} 人を見る
        </button>
      </div>
      <p className="mt-2 text-[12px] text-ink-3">@名前 でメンション・*太字* _斜体_ ~取り消し~ `コード` などの書式・「重要」で確認のお願い (店長以上)・「業務依頼」で期限つきの依頼。写真・資料はクリップのボタンか、貼り付け・ドラッグで送れます。Ctrl / ⌘ + K で別のチャンネル・社員へすばやく移動できます。</p>
    </div>
  );
}

/* ================================================================== */
/* 要対応・重要・検索・資料                                               */
/* ================================================================== */

function PaneHeader({ icon, title, sub, onBack }: { icon: ReactNode; title: string; sub?: string; onBack: () => void }) {
  return (
    <div className="flex items-center gap-2 border-b border-line px-2 py-2.5 @xl:px-3">
      <button type="button" onClick={onBack} className="rounded-lg p-2 text-ink-2 hover:bg-subtle @3xl:hidden" aria-label="チャンネルの一覧に戻る">
        <ChevronLeft className="h-5 w-5" />
      </button>
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-soft text-accent-ink">{icon}</span>
      <div className="min-w-0 flex-1">
        <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
        {sub && <p className="truncate text-[11px] text-ink-3">{sub}</p>}
      </div>
    </div>
  );
}

const KIND: Record<InboxItem["kind"], { label: string; icon: ReactNode; cls: string }> = {
  task: { label: "業務依頼", icon: <ListTodo className="h-4 w-4" />, cls: "bg-warn-soft text-warn-ink" },
  report: { label: "報告の確認", icon: <Check className="h-4 w-4" />, cls: "bg-accent-soft text-accent-ink" },
  important: { label: "重要", icon: <AlertTriangle className="h-4 w-4" />, cls: "bg-warn text-white" },
  mention: { label: "メンション", icon: <AtSign className="h-4 w-4" />, cls: "bg-info-soft text-info-ink" },
  thread_mention: { label: "メンション", icon: <AtSign className="h-4 w-4" />, cls: "bg-info-soft text-info-ink" },
};

function InboxPane({ items, waiting, dir, onOpen, onAck, onBack }: { items: InboxItem[]; waiting: WaitingItem[]; dir: Dir; onOpen: (i: InboxItem) => void; onAck: (i: InboxItem) => void; onBack: () => void }) {
  const groups: { title: string; hint: string; list: InboxItem[] }[] = [
    { title: "業務依頼", hint: "「確認しました」では消えず、報告して依頼した人が完了にするまで残ります", list: items.filter((i) => i.kind === "task" || i.kind === "report") },
    { title: "重要メッセージ (未確認)", hint: "「確認しました」を押すと消えます", list: items.filter((i) => i.kind === "important") },
    { title: "メンション", hint: "開いて読むと消えます", list: items.filter((i) => i.kind === "mention" || i.kind === "thread_mention") },
  ];
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="chat-inbox">
      <PaneHeader icon={<Inbox className="h-4 w-4" />} title={`要対応 (${items.length})`} sub="自分あての業務依頼・確認をお願いされた重要メッセージ・メンション" onBack={onBack} />
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 @xl:px-5">
        {items.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-16 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-good-soft text-good-ink">
              <Check className="h-6 w-6" />
            </span>
            <p className="text-sm font-medium text-ink">要対応はありません</p>
            <p className="text-xs text-ink-3">新しい業務依頼・重要メッセージ・メンションが届くと、ここと左上の緑の「チャット」のボタン (赤い数字) に出ます。</p>
          </div>
        )}
        {groups
          .filter((g) => g.list.length)
          .map((g) => (
            <section key={g.title} className="mb-5">
              <h3 className="mb-1 flex items-baseline gap-2 text-sm font-semibold text-ink">
                {g.title} <span className="text-xs font-normal text-ink-3">{g.list.length} 件 · {g.hint}</span>
              </h3>
              <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
                {g.list.map((i) => {
                  const k = KIND[i.kind];
                  return (
                    <li key={i.key} className="flex items-start gap-3 bg-panel px-3 py-2.5 hover:bg-subtle/60">
                      <span className={clsx("mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", k.cls)}>{k.icon}</span>
                      <button type="button" onClick={() => onOpen(i)} className="min-w-0 flex-1 text-left" data-testid="chat-inbox-item">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="text-sm font-medium text-ink">{i.title}</span>
                          {i.overdue && <Badge tone="critical" dot={false}>期限超過</Badge>}
                        </span>
                        <span className="mt-0.5 line-clamp-2 block text-xs text-ink-2">{i.detail}</span>
                        <span className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-ink-3">
                          {i.fromId && i.fromId !== "system" && (
                            <span className="inline-flex items-center gap-1">
                              <UserAvatar dir={dir} id={i.fromId} size={14} />
                              {nameOf(dir, i.fromId)}
                            </span>
                          )}
                          <span>{fullWhen(i.at)}</span>
                          {i.dueAt && <span className={i.overdue ? "font-medium text-critical-ink" : ""}>期限 {dueLabel(i.dueAt)}</span>}
                        </span>
                      </button>
                      {i.kind === "important" && (
                        <button type="button" onClick={() => onAck(i)} className="inline-flex h-8 shrink-0 items-center gap-1 rounded-xl bg-warn px-2.5 text-xs font-semibold text-white hover:brightness-95" data-testid="chat-inbox-ack">
                          <Check className="h-3.5 w-3.5" />
                          確認しました
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        {waiting.length > 0 && (
          <section className="mb-5">
            <h3 className="mb-1 text-sm font-semibold text-ink-2">
              報告済み (依頼した人の完了待ち) <span className="text-xs font-normal text-ink-3">{waiting.length} 件 · 数字には入りません</span>
            </h3>
            <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
              {waiting.map((w) => (
                <li key={w.key}>
                  <Link href={w.href} className="flex items-center gap-3 bg-panel px-3 py-2 text-sm hover:bg-subtle/60">
                    <ListTodo className="h-4 w-4 text-ink-3" />
                    <span className="min-w-0 flex-1 truncate text-ink-2">{w.title}</span>
                    <span className="text-[11px] text-ink-3">{w.otherId ? `${nameOf(dir, w.otherId)} さんの確認待ち` : ""}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

function ResultRow({ m, dir, onOpen, extra }: { m: ChatMessageView & { channelName?: string }; dir: Dir; onOpen: () => void; extra?: ReactNode }) {
  return (
    <li className="bg-panel px-3 py-2.5 hover:bg-subtle/60">
      <button type="button" onClick={onOpen} className="flex w-full items-start gap-3 text-left">
        <UserAvatar dir={dir} id={m.userId} size={32} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2 text-[12px] text-ink-3">
            <span className="text-sm font-semibold text-ink">{nameOf(dir, m.userId)}</span>
            <span>{m.channelName ? (m.channelName.startsWith("#") ? m.channelName : `# ${m.channelName}`) : ""}</span>
            <span>{fullWhen(m.at)}</span>
            {m.parentId && <span>(スレッド)</span>}
          </span>
          {m.body && <MessageBody m={m} dir={dir} className="line-clamp-3 text-[13px]" />}
          {m.files.length > 0 && <span className="mt-0.5 block truncate text-[11px] text-ink-3">📎 {m.files.map((f) => f.name).join("、")}</span>}
        </span>
      </button>
      {extra}
    </li>
  );
}

function ImportantPane({ dir, h, onOpen, onBack }: { dir: Dir; h: MessageHandlers; onOpen: (m: ChatMessageView) => void; onBack: () => void }) {
  const [list, setList] = useState<(ChatMessageView & { channelName: string })[] | null>(null);
  const [err, setErr] = useState("");
  const load = useCallback(() => {
    getJson<{ messages: (ChatMessageView & { channelName: string })[] }>("/api/chat/important")
      .then((r) => setList(r.messages))
      .catch((e) => setErr(e instanceof Error ? e.message : "読み込めませんでした。"));
  }, []);
  useEffect(load, [load]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PaneHeader icon={<AlertTriangle className="h-4 w-4" />} title="重要メッセージ" sub="管理者・本部・店長が「重要」を付けて送ったメッセージ (新しい順)" onBack={onBack} />
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 @xl:px-5">
        {err && <p className="text-sm text-critical-ink">{err}</p>}
        {!list && !err && <p className="py-8 text-center text-sm text-ink-3">読み込んでいます…</p>}
        {list && list.length === 0 && <p className="py-12 text-center text-sm text-ink-3">重要メッセージはまだありません。</p>}
        {list && list.length > 0 && (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
            {list.map((m) => (
              <ResultRow
                key={m.id}
                m={m}
                dir={dir}
                onOpen={() => onOpen(m)}
                extra={
                  m.ack && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-2 pl-11">
                      {m.ack.required && !m.ack.mine && (
                        <button type="button" onClick={() => (h.onAck(m), window.setTimeout(load, 600))} className="inline-flex h-7 items-center gap-1 rounded-lg bg-warn px-2.5 text-xs font-semibold text-white">
                          <Check className="h-3.5 w-3.5" />
                          確認しました
                        </button>
                      )}
                      {m.ack.mine && <span className="text-[11px] text-good-ink">✓ 確認済み ({timeLabel(m.ack.mine)})</span>}
                      <button type="button" disabled={!m.ack.pendingIds} onClick={() => h.onAcks(m)} className="rounded-lg bg-subtle px-2 py-0.5 text-[11px] text-ink-2 enabled:hover:bg-line/60">
                        確認 {m.ack.done} / {m.ack.total} 人
                      </button>
                    </div>
                  )
                }
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function SearchPane({ q, dir, channels, onOpen, onBack }: { q: string; dir: Dir; channels: ChatChannelView[]; onOpen: (m: ChatMessageView) => void; onBack: () => void }) {
  const [list, setList] = useState<(ChatMessageView & { channelName: string })[] | null>(null);
  const [err, setErr] = useState("");
  const [inId, setInId] = useState("");
  const [fromId, setFromId] = useState("");
  useEffect(() => {
    let stop = false;
    getJson<{ results: (ChatMessageView & { channelName: string })[] }>(`/api/chat/search?q=${encodeURIComponent(q)}${inId ? `&in=${encodeURIComponent(inId)}` : ""}${fromId ? `&from=${encodeURIComponent(fromId)}` : ""}`)
      .then((r) => !stop && (setList(r.results), setErr("")))
      .catch((e) => !stop && setErr(e instanceof Error ? e.message : "検索できませんでした。"));
    return () => {
      stop = true;
    };
  }, [q, inId, fromId]);
  const sel = "h-8 max-w-[48%] rounded-lg border border-line bg-panel px-2 text-xs outline-none focus:border-accent";
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="chat-search">
      <PaneHeader icon={<Search className="h-4 w-4" />} title={`「${q}」の検索結果`} sub="見られるチャンネル・DM のメッセージと資料の名前 (新しい順)" onBack={onBack} />
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 @xl:px-5">
        <select value={inId} onChange={(e) => setInId(e.target.value)} className={sel} aria-label="チャンネル・DM で絞る" data-testid="chat-search-in">
          <option value="">すべてのチャンネル・DM</option>
          {channels.map((c) => (
            <option key={c.id} value={c.id}>
              {c.kind === "dm" ? `DM: ${c.name}` : `# ${c.name}`}
            </option>
          ))}
        </select>
        <select value={fromId} onChange={(e) => setFromId(e.target.value)} className={sel} aria-label="送った人で絞る" data-testid="chat-search-from">
          <option value="">送った人: すべて</option>
          {[...dir.users.values()].map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 @xl:px-5">
        {err && <p className="text-sm text-critical-ink">{err}</p>}
        {!list && !err && <p className="py-8 text-center text-sm text-ink-3">検索しています…</p>}
        {list && list.length === 0 && <p className="py-12 text-center text-sm text-ink-3">見つかりませんでした。言葉や絞り込みを変えてお試しください。</p>}
        {list && list.length > 0 && (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
            {list.map((m) => (
              <ResultRow key={m.id} m={m} dir={dir} onOpen={() => onOpen(m)} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** メッセージの一覧 (後で見る・ピン留め) */
function ListPane({ url, title, sub, icon, empty, dir, onOpen, onBack, onUnsave, embedded = false }: { url: string; title: string; sub: string; icon: ReactNode; empty: string; dir: Dir; onOpen: (m: ChatMessageView) => void; onBack?: () => void; onUnsave?: (m: ChatMessageView) => void; embedded?: boolean }) {
  const [list, setList] = useState<(ChatMessageView & { channelName?: string })[] | null>(null);
  const [err, setErr] = useState("");
  const load = useCallback(() => {
    getJson<{ messages: (ChatMessageView & { channelName?: string })[] }>(url)
      .then((r) => setList(r.messages))
      .catch((e) => setErr(e instanceof Error ? e.message : "読み込めませんでした。"));
  }, [url]);
  useEffect(load, [load]);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid={embedded ? "chat-pins" : "chat-saved"}>
      {!embedded && onBack && <PaneHeader icon={icon} title={title} sub={sub} onBack={onBack} />}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 @xl:px-5">
        {err && <p className="text-sm text-critical-ink">{err}</p>}
        {!list && !err && <p className="py-8 text-center text-sm text-ink-3">読み込んでいます…</p>}
        {list && list.length === 0 && <p className="py-12 text-center text-sm text-ink-3">{empty}</p>}
        {list && list.length > 0 && (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
            {list.map((m) => (
              <ResultRow
                key={m.id}
                m={m}
                dir={dir}
                onOpen={() => onOpen(m)}
                extra={
                  onUnsave ? (
                    <div className="mt-1 pl-11">
                      <button type="button" onClick={() => (onUnsave(m), window.setTimeout(load, 500))} className="text-[11px] text-ink-3 hover:text-critical-ink">
                        「後で見る」から外す
                      </button>
                    </div>
                  ) : m.pinnedBy ? (
                    <p className="mt-1 pl-11 text-[11px] text-warn-ink">{nameOf(dir, m.pinnedBy)} がピン留め</p>
                  ) : undefined
                }
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

interface FileRow {
  messageId: string;
  parentId?: string;
  userId: string;
  at: string;
  file: ChatFile;
}

function FilesPane({ channel, onImage, onOpen }: { channel: ChatChannelView; onImage: (messageId: string, files: ChatFile[], index: number) => void; onOpen: (messageId: string, parentId?: string) => void }) {
  const [list, setList] = useState<FileRow[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    getJson<{ files: FileRow[] }>(`/api/chat/files?c=${encodeURIComponent(channel.id)}`)
      .then((r) => setList(r.files))
      .catch((e) => setErr(e instanceof Error ? e.message : "読み込めませんでした。"));
  }, [channel.id]);
  const photos = (list ?? []).filter((x) => x.file.photo);
  const docs = (list ?? []).filter((x) => !x.file.photo);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 @xl:px-5" data-testid="chat-files">
      {err && <p className="text-sm text-critical-ink">{err}</p>}
      {!list && !err && <p className="py-8 text-center text-sm text-ink-3">読み込んでいます…</p>}
      {list && list.length === 0 && <p className="py-12 text-center text-sm text-ink-3">このチャンネルにはまだ資料・写真がありません。</p>}
      {photos.length > 0 && (
        <section className="mb-5">
          <h3 className="mb-2 text-sm font-semibold text-ink">写真 ({photos.length})</h3>
          <div className="grid grid-cols-3 gap-1.5 @xl:grid-cols-5 @4xl:grid-cols-7">
            {photos.map((x) => (
              <button key={`${x.messageId}-${x.file.id}`} type="button" onClick={() => onImage(x.messageId, [x.file], 0)} className="relative overflow-hidden rounded-xl border border-line bg-subtle" title={`${x.file.name} · ${fullWhen(x.at)}`}>
                {/* eslint-disable-next-line @next/next/no-img-element -- ログインが必要な API から配信する */}
                <img src={fileUrl(x.messageId, x.file, { thumb: x.file.thumb })} alt={x.file.name} loading="lazy" className="aspect-square w-full object-cover" />
                {x.file.access === "managers" && <Lock className="absolute top-1 left-1 h-3.5 w-3.5 rounded bg-ink/70 p-0.5 text-white" />}
              </button>
            ))}
          </div>
        </section>
      )}
      {docs.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-semibold text-ink">資料 ({docs.length})</h3>
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
            {docs.map((x) => (
              <li key={`${x.messageId}-${x.file.id}`} className="flex items-center gap-3 bg-panel px-3 py-2">
                <a href={fileUrl(x.messageId, x.file)} target="_blank" rel="noopener" className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink hover:text-accent hover:underline">{x.file.name}</span>
                  <span className="block text-[11px] text-ink-3">
                    {sizeLabel(x.file.size)} · {shortWhen(x.at)}
                    {x.file.access === "managers" && " · 店長以上だけ"}
                  </span>
                </a>
                <button type="button" onClick={() => onOpen(x.messageId, x.parentId)} className="rounded-lg px-2 py-1 text-xs text-accent hover:bg-accent-soft">
                  メッセージを見る
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

