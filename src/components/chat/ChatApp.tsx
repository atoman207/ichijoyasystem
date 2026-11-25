"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { AlertTriangle, ArrowDown, AtSign, Bell, BellOff, Check, ChevronLeft, FolderOpen, Hash, Inbox, ListTodo, Lock, Megaphone, MessageSquarePlus, Plus, Search, Settings2, Store, UsersRound, X } from "lucide-react";
import Link from "@/components/ui/Link";
import { Badge } from "@/components/ui";
import { ackChatMessage, deleteChatMessage, editChatMessage, markChatRead, reactChatMessage, setChatChannelNotify } from "@/lib/actions/chat";
import { chatNavKey, decodeMentions } from "@/lib/chat/text";
import type { ChatBootstrap, ChatChannelView, ChatCounts, ChatFile, ChatMessageView, ChatPrefs, ChatSyncResponse, ChatTaskInfo, InboxItem, WaitingItem } from "@/lib/chat/types";
import { CHAT_COUNTS_EVENT } from "./ChatBadge";
import { dayKey, dayLabel, dueLabel, fileUrl, fullWhen, getJson, shortWhen, signalChatRefresh, sizeLabel, timeLabel } from "./client";
import { Composer, type ComposerHandle } from "./Composer";
import { AckDialog, ChannelDialog, MembersDialog, NewDmDialog, PrefsDialog, TaskDialog } from "./dialogs";
import { DayDivider, Lightbox, MessageBody, MessageItem, nameOf, UnreadDivider, UserAvatar, type Dir, type MessageHandlers } from "./parts";

/* ================================================================== */
/* 型                                                                   */
/* ================================================================== */

export type ChatView = { kind: "channel"; id: string } | { kind: "inbox" } | { kind: "important" } | { kind: "search"; q: string } | { kind: "files"; id: string };

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
    default:
      return `/chat?view=${view.kind}`;
  }
}

/* ================================================================== */
/* 本体                                                                 */
/* ================================================================== */

export function ChatApp({ boot, initial }: { boot: ChatBootstrap; initial: ChatInitial }) {
  const router = useRouter();
  const dir = useMemo<Dir>(() => ({ me: boot.me, users: new Map(boot.users.map((u) => [u.id, u])), stores: boot.stores }), [boot]);
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
  const [toast, setToast] = useState<{ text: string; tone: "good" | "bad" } | null>(null);
  const [newBelow, setNewBelow] = useState(0);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [dialog, setDialog] = useState<
    | { kind: "dm" }
    | { kind: "channel"; channel?: ChatChannelView }
    | { kind: "members"; channel: ChatChannelView }
    | { kind: "task"; m: ChatMessageView }
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

  const channel = channels.find((c) => c.id === cid);
  const showToast = useCallback((text: string, tone: "good" | "bad" = "good") => {
    setToast({ text, tone });
    window.setTimeout(() => setToast((t) => (t?.text === text ? null : t)), 3500);
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
      const r = await getJson<{ rev: number; messages: ChatMessageView[]; hasMore: boolean; lastRead: string }>(`/api/chat/messages?c=${encodeURIComponent(id)}${focus ? `&around=${encodeURIComponent(focus)}` : ""}`);
      if (seq !== loadSeq.current) return;
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
      if (v.kind === "files" && v.id !== cidRef.current) {
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
      if (v === "inbox" || v === "important") {
        setView({ kind: v });
        setShowList(false);
        setThread(null);
      } else if (v === "search") {
        const q = sp.get("q") ?? "";
        setSearchText(q);
        setView({ kind: "search", q });
        setShowList(false);
      } else if (v === "files" && c) {
        setCid(c);
        cidRef.current = c;
        setView({ kind: "files", id: c });
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
    const c = v.kind === "channel" || v.kind === "files" ? cidRef.current : "";
    const t = threadRef.current?.root.id ?? "";
    const sent = { c, t };
    try {
      const r = await getJson<ChatSyncResponse>(`/api/chat/sync?c=${encodeURIComponent(c)}&t=${encodeURIComponent(t)}&rev=${revRef.current}`);
      setChannels(r.channels);
      setCounts(r.counts);
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

  const changeNotify = async (id: string, level: "all" | "priority") => {
    setChannels((list) => list.map((c) => (c.id === id ? { ...c, notify: level } : c)));
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
  const dms = channels.filter((c) => c.kind === "dm").sort((a, b) => (b.lastAt ?? "").localeCompare(a.lastAt ?? ""));

  const sidebar = (
    <aside className={clsx("min-h-0 w-full flex-col border-line bg-subtle/50 @3xl:w-64 @3xl:shrink-0 @3xl:border-r @5xl:w-72", showList ? "flex" : "hidden @3xl:flex")} aria-label="チャンネルと DM">
      <div className="flex items-center gap-1 border-b border-line px-3 py-2.5">
        <h1 className="flex-1 text-base font-semibold text-ink">チャット</h1>
        <button type="button" onClick={() => setDialog({ kind: "prefs" })} className="rounded-lg p-2 text-ink-2 hover:bg-panel hover:text-ink" aria-label="通知の設定" title="通知の設定 (通知音・プッシュ通知)" data-testid="chat-prefs">
          {prefs.sound ? <Bell className="h-[18px] w-[18px]" /> : <BellOff className="h-[18px] w-[18px]" />}
        </button>
        <button type="button" onClick={() => setDialog({ kind: "dm" })} className="rounded-lg p-2 text-ink-2 hover:bg-panel hover:text-ink" aria-label="新しい DM" title="新しい DM (個別のメッセージ)" data-testid="chat-new-dm">
          <MessageSquarePlus className="h-[18px] w-[18px]" />
        </button>
      </div>
      <form
        className="px-3 pt-2.5"
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
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pt-2 pb-4">
        <SideButton active={view.kind === "inbox"} onClick={() => go({ kind: "inbox" })} icon={<Inbox className="h-4 w-4" />} label="要対応" testId="chat-side-inbox" right={counts.action > 0 ? <Count n={counts.action} tone="red" /> : undefined} strong={counts.action > 0} />
        <SideButton active={view.kind === "important"} onClick={() => go({ kind: "important" })} icon={<AlertTriangle className="h-4 w-4" />} label="重要メッセージ" />
        <Link href="/messages" className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm text-ink-2 hover:bg-panel hover:text-ink">
          <ListTodo className="h-4 w-4" />
          <span className="flex-1 truncate">業務依頼・社内連絡</span>
          {waiting.length > 0 && <span className="text-[11px] text-ink-3" title="自分が報告して、依頼した人の完了を待っているもの">待ち {waiting.length}</span>}
        </Link>
        <SectionTitle label="チャンネル" onAdd={boot.canCreateChannel ? () => setDialog({ kind: "channel" }) : undefined} addLabel="チャンネルを追加" />
        {ordered.map((c) => (
          <ChannelRow key={c.id} c={c} dir={dir} active={(view.kind === "channel" || view.kind === "files") && cid === c.id} onClick={() => void openChannel(c.id)} />
        ))}
        <SectionTitle label="ダイレクトメッセージ" onAdd={() => setDialog({ kind: "dm" })} addLabel="新しい DM" />
        {dms.length === 0 && <p className="px-2.5 py-1 text-[11px] text-ink-3">右の「+」から、社員と 1 対 1・数人でやりとりできます。</p>}
        {dms.map((c) => (
          <ChannelRow key={c.id} c={c} dir={dir} active={view.kind === "channel" && cid === c.id} onClick={() => void openChannel(c.id)} />
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
      const compact = Boolean(prev && !newDay && !divider && prev.userId === m.userId && !prev.deleted && !m.important && !prev.important && Date.parse(m.at) - Date.parse(prev.at) < 5 * 60_000);
      rows.push(<MessageItem key={m.id} m={m} dir={dir} h={handlers} compact={compact} canDelete={canDelete(m)} highlight={m.id === focusId} editing={editing?.id === m.id} editor={editing?.id === m.id ? editor : undefined} />);
      prev = m;
    }
  }

  const header =
    channel && (view.kind === "channel" || view.kind === "files") ? (
      <div className="flex items-center gap-2 border-b border-line px-2 py-2 @xl:px-3">
        <button type="button" onClick={() => (setShowList(true), pushUrl("/chat"))} className="rounded-lg p-2 text-ink-2 hover:bg-subtle @3xl:hidden" aria-label="チャンネルの一覧に戻る">
          <ChevronLeft className="h-5 w-5" />
        </button>
        <ChannelIcon c={channel} dir={dir} size={32} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-semibold text-ink" data-testid="chat-channel-title">
            {channel.kind === "dm" ? channel.name : `# ${channel.name}`}
          </h2>
          <button type="button" onClick={() => setDialog({ kind: "members", channel })} className="block max-w-full truncate text-left text-[11px] text-ink-3 hover:text-ink">
            <UsersRound className="mr-0.5 inline h-3 w-3" />
            {channel.memberIds.length} 人{channel.viewer ? " · 本部・管理者として表示中" : ""}
            {channel.topic && channel.kind !== "dm" ? ` · ${channel.topic}` : ""}
          </button>
        </div>
        <button type="button" onClick={() => void changeNotify(channel.id, channel.notify === "all" ? "priority" : "all")} className={clsx("inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs", channel.notify === "all" ? "bg-accent-soft text-accent-ink" : "text-ink-2 hover:bg-subtle")} title={channel.notify === "all" ? "すべてのメッセージを通知 (押すと自分あてだけに)" : "自分あてだけ通知 (押すとすべて通知に)"} aria-label="このチャンネルの通知" data-testid="chat-notify-toggle">
          {channel.notify === "all" ? <Bell className="h-4 w-4" /> : <BellOff className="h-4 w-4" />}
          <span className="hidden @xl:inline">{channel.notify === "all" ? "すべて通知" : "自分あてだけ"}</span>
        </button>
        <button type="button" onClick={() => (view.kind === "files" ? void openChannel(channel.id) : go({ kind: "files", id: channel.id }))} className={clsx("inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs", view.kind === "files" ? "bg-accent-soft text-accent-ink" : "text-ink-2 hover:bg-subtle")} aria-label="資料・写真の一覧" title="このチャンネルの資料・写真">
          <FolderOpen className="h-4 w-4" />
          <span className="hidden @xl:inline">資料・写真</span>
        </button>
        {channel.canManage && (
          <button type="button" onClick={() => setDialog({ kind: "channel", channel })} className="rounded-lg p-2 text-ink-2 hover:bg-subtle" aria-label="チャンネルの設定">
            <Settings2 className="h-4 w-4" />
          </button>
        )}
      </div>
    ) : null;

  const [dragging, setDragging] = useState(false);
  const channelPane = channel && view.kind === "channel" && (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onDragOver={(e) => {
        if ([...e.dataTransfer.types].includes("Files")) {
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
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2" data-testid="chat-messages">
        {hasMore && (
          <div className="flex justify-center py-3">
            <button type="button" onClick={() => void loadOlder()} disabled={loadingOlder} className="rounded-full border border-line px-3 py-1 text-xs text-ink-2 hover:bg-subtle">
              {loadingOlder ? "読み込んでいます…" : "前のメッセージを読む"}
            </button>
          </div>
        )}
        {!hasMore && !loading && <ChannelIntro c={channel} dir={dir} />}
        {loading && msgs.length === 0 ? <p className="py-10 text-center text-sm text-ink-3">読み込んでいます…</p> : rows}
      </div>
      {newBelow > 0 && (
        <button type="button" onClick={() => scrollToBottom(true)} className="absolute left-1/2 z-10 inline-flex -translate-x-1/2 items-center gap-1 rounded-full bg-accent px-3 py-1.5 text-xs font-medium text-white shadow-lift" style={{ bottom: 120 }}>
          <ArrowDown className="h-3.5 w-3.5" />
          新しいメッセージ {newBelow} 件
        </button>
      )}
      {dragging && (
        <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-accent bg-accent-soft/80 text-sm font-medium text-accent-ink">ここにファイルを落とすと添付します</div>
      )}
      {channel.archived ? (
        <p className="border-t border-line bg-subtle px-4 py-3 text-center text-sm text-ink-3">このチャンネルはアーカイブしています (送れません)。</p>
      ) : (
        <Composer
          handleRef={composerRef}
          channel={channel}
          dir={dir}
          canImportant={boot.canImportant}
          maxFileBytes={boot.maxFileBytes}
          onSent={onSent}
          placeholder={channel.kind === "dm" ? `${channel.name} さんにメッセージ` : `# ${channel.name} にメッセージ (@ でメンション)`}
        />
      )}
    </div>
  );

  const threadPane = thread && view.kind === "channel" && channel && (
    <section className="absolute inset-0 z-20 flex min-h-0 flex-col bg-panel @7xl:static @7xl:z-auto @7xl:w-[400px] @7xl:shrink-0 @7xl:border-l @7xl:border-line" aria-label="スレッド">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-semibold text-ink">スレッド</h3>
          <p className="truncate text-[11px] text-ink-3">{channel.kind === "dm" ? channel.name : `# ${channel.name}`}</p>
        </div>
        <button type="button" onClick={() => (setThread(null), pushUrl(viewUrl({ kind: "channel", id: channel.id }), true))} className="rounded-lg p-2 text-ink-2 hover:bg-subtle" aria-label="スレッドを閉じる">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div ref={threadScrollRef} className="min-h-0 flex-1 overflow-y-auto pb-2">
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
      {!channel.archived && <Composer channel={channel} parentId={thread.root.id} dir={dir} canImportant={boot.canImportant} maxFileBytes={boot.maxFileBytes} onSent={onSent} placeholder="スレッドに返信" compact />}
    </section>
  );

  let main: ReactNode = channelPane;
  if (view.kind === "inbox") main = <InboxPane items={inbox} waiting={waiting} dir={dir} onOpen={(i) => (i.channelId && i.messageId ? void openChannel(i.channelId, { focus: i.messageId, thread: i.parentId }) : i.href ? router.push(i.href) : undefined)} onAck={(i) => i.messageId && handlers.onAck({ id: i.messageId } as ChatMessageView)} onBack={() => (setShowList(true), pushUrl("/chat"))} />;
  if (view.kind === "important") main = <ImportantPane dir={dir} h={handlers} onOpen={(m) => void openChannel(m.channelId, { focus: m.id, thread: m.parentId })} onBack={() => (setShowList(true), pushUrl("/chat"))} />;
  if (view.kind === "search") main = <SearchPane key={view.q} q={view.q} dir={dir} onOpen={(m) => void openChannel(m.channelId, { focus: m.id, thread: m.parentId })} onBack={() => (setShowList(true), pushUrl("/chat"))} />;
  if (view.kind === "files" && channel) main = <FilesPane key={channel.id} channel={channel} onImage={(messageId, files, index) => setDialog({ kind: "image", messageId, files, index })} onOpen={(messageId, parentId) => void openChannel(channel.id, { focus: messageId, thread: parentId })} />;

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
      </div>
      {dialog?.kind === "dm" && <NewDmDialog dir={dir} onClose={() => setDialog(null)} onOpen={(id) => (setDialog(null), void sync().then(() => openChannel(id)))} />}
      {dialog?.kind === "channel" && (
        <ChannelDialog
          dir={dir}
          channel={dialog.channel}
          onClose={() => setDialog(null)}
          onSaved={(id, gone) => {
            setDialog(null);
            void sync().then(() => {
              if (gone) {
                setShowList(true);
                go({ kind: "inbox" });
              } else void openChannel(id);
            });
            showToast(gone ? "チャンネルを一覧から外しました。" : "チャンネルを保存しました。");
          }}
        />
      )}
      {dialog?.kind === "members" && <MembersDialog dir={dir} channel={dialog.channel} onClose={() => setDialog(null)} />}
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
      {toast &&
        createPortal(
          <div className={clsx("fixed top-[92px] left-1/2 z-[90] max-w-[90vw] -translate-x-1/2 rounded-xl px-4 py-2.5 text-sm font-medium text-white shadow-pop animate-pop", toast.tone === "good" ? "bg-ink" : "bg-critical")} role="status">
            {toast.text}
          </div>,
          document.body,
        )}
    </div>
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

function SectionTitle({ label, onAdd, addLabel }: { label: string; onAdd?: () => void; addLabel: string }) {
  return (
    <div className="mt-4 mb-1 flex items-center px-2.5">
      <span className="flex-1 text-[11px] font-semibold tracking-wide text-ink-3">{label}</span>
      {onAdd && (
        <button type="button" onClick={onAdd} className="rounded-md p-1 text-ink-3 hover:bg-panel hover:text-ink" aria-label={addLabel} title={addLabel}>
          <Plus className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

function ChannelIcon({ c, dir, size = 20 }: { c: ChatChannelView; dir: Dir; size?: number }) {
  if (c.kind === "dm") {
    const others = c.memberIds.filter((id) => id !== dir.me.id);
    if (others.length <= 1) return <UserAvatar dir={dir} id={others[0] ?? dir.me.id} size={size} />;
    return (
      <span className="flex shrink-0 items-center justify-center rounded-full bg-neutral-soft text-ink-2" style={{ width: size, height: size }}>
        <UsersRound className="h-[60%] w-[60%]" />
      </span>
    );
  }
  const Icon = c.kind === "all" ? Megaphone : c.kind === "store" ? Store : c.kind === "managers" ? Lock : Hash;
  return (
    <span className="flex shrink-0 items-center justify-center rounded-lg text-white" style={{ width: size, height: size, background: c.color ?? (c.kind === "all" ? "#4a5ae8" : c.kind === "managers" ? "#8a5a00" : "#64748b") }}>
      <Icon className="h-[58%] w-[58%]" />
    </span>
  );
}

function ChannelRow({ c, dir, active, onClick }: { c: ChatChannelView; dir: Dir; active: boolean; onClick: () => void }) {
  const unread = c.unread > 0;
  return (
    <button type="button" onClick={onClick} className={clsx("group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm", active ? "bg-accent text-white" : unread || c.mentions ? "font-semibold text-ink hover:bg-panel" : "text-ink-2 hover:bg-panel hover:text-ink")} aria-current={active ? "page" : undefined} data-testid={`chat-ch-${c.id}`}>
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

function ChannelIntro({ c, dir }: { c: ChatChannelView; dir: Dir }) {
  const text: Record<string, string> = {
    all: "全社員が参加するチャンネルです。全員へのお知らせ・全店舗で共有したい内容をここで公開します。",
    store: "この店舗の社員が自動で参加するチャンネルです。店舗の中の連絡・相談・写真の共有に使います (本部・管理者も見られます)。",
    managers: "店長・本部・管理者だけが参加するチャンネルです。店長への指示や店長会議の資料に使います。",
    custom: "メンバーだけが見られるチャンネルです。",
    dm: "参加している本人同士だけが見られる個別のメッセージです (管理者も見られません)。",
  };
  return (
    <div className="px-4 pt-6 pb-3 @xl:px-5">
      <ChannelIcon c={c} dir={dir} size={44} />
      <h3 className="mt-2 text-lg font-semibold text-ink">{c.kind === "dm" ? c.name : `# ${c.name}`}</h3>
      <p className="mt-1 max-w-xl text-[13px] leading-relaxed text-ink-2">{text[c.kind]}</p>
      <p className="mt-1 text-[12px] text-ink-3">@名前 でメンション・「重要」で確認のお願い (店長以上)・「業務依頼」で期限つきの依頼。写真・資料は 📎 か、貼り付け・ドラッグで送れます。</p>
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

function SearchPane({ q, dir, onOpen, onBack }: { q: string; dir: Dir; onOpen: (m: ChatMessageView) => void; onBack: () => void }) {
  const [list, setList] = useState<(ChatMessageView & { channelName: string })[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    getJson<{ results: (ChatMessageView & { channelName: string })[] }>(`/api/chat/search?q=${encodeURIComponent(q)}`)
      .then((r) => setList(r.results))
      .catch((e) => setErr(e instanceof Error ? e.message : "検索できませんでした。"));
  }, [q]);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="chat-search">
      <PaneHeader icon={<Search className="h-4 w-4" />} title={`「${q}」の検索結果`} sub="見られるチャンネル・DM のメッセージと資料の名前 (新しい順・60 件まで)" onBack={onBack} />
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 @xl:px-5">
        {err && <p className="text-sm text-critical-ink">{err}</p>}
        {!list && !err && <p className="py-8 text-center text-sm text-ink-3">検索しています…</p>}
        {list && list.length === 0 && <p className="py-12 text-center text-sm text-ink-3">見つかりませんでした。言葉を変えてお試しください。</p>}
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

