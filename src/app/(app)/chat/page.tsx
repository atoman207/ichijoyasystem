import type { Metadata } from "next";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canCreateChatChannel, canSendImportantChat } from "@/lib/auth/permissions";
import { avatarUrl } from "@/lib/account-rules";
import { chatState } from "@/lib/chat/inbox";
import { ALL_CHANNEL, canView, findChannel, storeChannelId } from "@/lib/chat/channels";
import { channelMessages, getMessage, messagesAround, prefsOf, readsOf, replies, toViews } from "@/lib/chat/repo";
import { currentRev } from "@/lib/chat/db";
import { chatNavKey } from "@/lib/chat/text";
import { vapidKeys } from "@/lib/notify/push";
import { CHAT_MAX_FILE_BYTES, type ChatBootstrap, type ChatUser } from "@/lib/chat/types";
import { ChatApp, type ChatInitial, type ChatView } from "@/components/chat/ChatApp";

export const metadata: Metadata = { title: "チャット" };
export const dynamic = "force-dynamic";

/**
 * チャット (チャンネル・DM・要対応)。お客様のご要望 2026-11-25 (other/docs/16〜18)
 * ?c=<チャンネル> &t=<スレッド> &m=<メッセージ> / ?view=inbox | important | files&c= | search&q=
 */
export default async function ChatPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const rev = currentRev();
  const state = chatState(db, user);
  const visible = new Set(state.channels.map((c) => c.id));

  // 開くチャンネル: 指定のメッセージ → 指定のチャンネル → 自分の店舗 → 全社
  const focus = sp.m ? getMessage(sp.m) : undefined;
  const focusOk = focus && visible.has(focus.channelId) && canView(user, findChannel(db, focus.channelId)) ? focus : undefined;
  const own = storeChannelId(user.storeId);
  const channelId = focusOk?.channelId ?? (sp.c && visible.has(sp.c) ? sp.c : visible.has(own) ? own : ALL_CHANNEL);
  const v = sp.view;
  const view: ChatView =
    v === "inbox" || v === "important"
      ? { kind: v }
      : v === "search" && sp.q
        ? { kind: "search", q: sp.q.slice(0, 100) }
        : v === "files" && sp.c && visible.has(sp.c)
          ? { kind: "files", id: sp.c }
          : { kind: "channel", id: channelId };

  const rootId = sp.t ?? focusOk?.parentId;
  const page = focusOk ? messagesAround(channelId, (focusOk.parentId ? getMessage(focusOk.parentId) : focusOk)?.at ?? focusOk.at) : channelMessages(channelId);
  const reads = readsOf(user.id);
  const root = rootId ? getMessage(rootId) : undefined;
  const thread = root && !root.parentId && root.channelId === channelId ? { root: toViews(user, [root], db)[0], replies: toViews(user, replies(root.id), db), lastRead: reads.get(`t:${root.id}`) ?? "" } : undefined;

  const users: ChatUser[] = db.users
    .filter((u) => u.active && !u.signupStatus)
    .map((u) => ({ id: u.id, name: u.name, kana: u.kana ?? "", storeId: u.storeId, role: u.role, title: u.title ?? "", avatar: avatarUrl(u) }));
  const me = users.find((u) => u.id === user.id) ?? { id: user.id, name: user.name, kana: user.kana ?? "", storeId: user.storeId, role: user.role, title: user.title ?? "", avatar: avatarUrl(user) };
  const boot: ChatBootstrap = {
    me,
    users,
    stores: db.stores.filter((s) => !s.mergedInto).map((s) => ({ id: s.id, name: s.name, color: s.color })),
    canImportant: canSendImportantChat(user),
    canCreateChannel: canCreateChatChannel(user),
    vapidKey: vapidKeys()?.publicKey ?? "",
    maxFileBytes: CHAT_MAX_FILE_BYTES,
  };
  const initial: ChatInitial = {
    navKey: chatNavKey(sp),
    rev,
    channels: state.channels,
    counts: state.counts,
    inbox: state.inbox,
    waiting: state.waiting,
    prefs: prefsOf(user.id),
    view,
    channelId: view.kind === "files" ? view.id : channelId,
    messages: view.kind === "files" ? [] : toViews(user, page.rows, db),
    hasMore: page.hasMore,
    lastRead: reads.get(channelId) ?? "",
    focusId: focusOk?.id,
    thread,
    mobileList: !sp.c && !sp.view && !sp.m,
  };
  return <ChatApp boot={boot} initial={initial} />;
}
