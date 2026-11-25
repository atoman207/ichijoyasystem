import "server-only";
import type { Database, User } from "@/lib/db/types";
import { canViewThread } from "@/lib/auth/permissions";
import { canAddMembers, canManage, canPost, dmName, isJoined, isViewer, visibleChannels, type ChannelDef } from "./channels";
import { channelNotify, channelStats, mentionRows, notifyFor, pendingImportant, pinCounts, readsOf, starsOf, type ChannelStat, type RawMessage } from "./repo";
import { preview } from "./text";
import type { ChatChannelView, ChatCounts, InboxItem, WaitingItem } from "./types";

/**
 * 要対応 (チャットのアイコンの赤い数字) と未読 (青い数字)
 * ------------------------------------------------------------
 * お客様のご要望 2026-11-25「■3 DM の通知」「■6 既存のメンション・業務依頼との連携」:
 * - 要対応 (赤): 自分への業務依頼 (依頼された・期限超過・差し戻し)、自分が依頼して報告が届いたもの、確認していない重要メッセージ、
 *   未読のメンション (チャットと従来の社内連絡)。業務依頼は既読や「確認しました」では消えず、報告と依頼した人の完了の確認まで残る
 * - 未読 (青): DM と「すべて通知」にしたチャンネルの未読のメッセージ。要対応とは数字を分ける (混同しない)
 * - メンションは 30 日、重要メッセージは 90 日で数字から外す (古いものがいつまでも残らないように。記録はそのまま)
 */

const MENTION_DAYS = 30;
const IMPORTANT_DAYS = 90;
const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString();

export interface ChatState {
  channels: ChatChannelView[];
  defs: ChannelDef[];
  counts: ChatCounts;
  inbox: InboxItem[];
  waiting: WaitingItem[];
}

/** 短い印 (新しいものが届いたかを画面で比べるだけ) */
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

const ctxOf = (db: Database) => ({ users: db.users.map((u) => ({ id: u.id, name: u.name })), stores: db.stores.map((s) => ({ id: s.id, name: s.name })) });

/** メンションが未読か (チャンネルのメッセージはチャンネルの既読、スレッドの返信はそのスレッドの既読と比べる) */
function unreadMention(m: RawMessage, reads: Map<string, string>): boolean {
  const key = m.parentId ? `t:${m.parentId}` : m.channelId;
  return m.at > (reads.get(key) ?? "");
}

export function chatState(db: Database, user: User, opts: { withLists?: boolean } = {}): ChatState {
  const defs = visibleChannels(db, user);
  const byId = new Map(defs.map((d) => [d.id, d]));
  const reads = readsOf(user.id);
  const notify = channelNotify(user.id);
  const since = daysAgo(IMPORTANT_DAYS);
  const stats = channelStats(user.id, defs.map((d) => d.id), reads, since);
  const ctx = ctxOf(db);
  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

  // 未読のメンション・確認していない重要メッセージ (見られるチャンネルのものだけ)
  const mentionMsgs = mentionRows(user.id, daysAgo(MENTION_DAYS)).filter((m) => byId.has(m.channelId) && m.userId !== user.id && unreadMention(m, reads));
  const important = pendingImportant(user.id, since).filter((m) => byId.has(m.channelId) && m.userId !== user.id);
  const importantIds = new Set(important.map((m) => m.id));
  const items: InboxItem[] = [];
  const nameOf = (id?: string) => db.users.find((u) => u.id === id)?.name ?? "";
  const chName = (d: ChannelDef) => (d.kind === "dm" ? dmName(db, d, user.id) : d.name);
  for (const m of important) {
    const d = byId.get(m.channelId)!;
    items.push({ key: `imp:${m.id}`, kind: "important", title: `重要: ${preview(m.body, ctx, 60) || "(資料・写真)"}`, detail: `${chName(d)} · ${nameOf(m.userId)} さん · 「確認しました」を押すまで残ります`, fromId: m.userId, at: m.at, channelId: m.channelId, messageId: m.id, parentId: m.parentId, channelName: chName(d) });
  }
  for (const m of mentionMsgs) {
    if (importantIds.has(m.id)) continue;
    const d = byId.get(m.channelId)!;
    items.push({ key: `men:${m.id}`, kind: "mention", title: `${nameOf(m.userId)} さんからメンション`, detail: `${chName(d)}${m.parentId ? " (スレッド)" : ""} · ${preview(m.body, ctx, 80)}`, fromId: m.userId, at: m.at, channelId: m.channelId, messageId: m.id, parentId: m.parentId, channelName: chName(d) });
  }

  // 業務依頼 (従来の threads)。依頼された: 依頼・確認済み (対応中・差し戻しを含む)。依頼した: 報告が届いたもの
  const waiting: WaitingItem[] = [];
  for (const t of db.threads) {
    if (!t.taskStatus || t.taskStatus === "confirmed") continue;
    const mine = (t.assigneeIds ?? []).includes(user.id);
    const overdue = Boolean(t.dueAt ? Date.parse(t.dueAt) < Date.now() : t.dueDate && t.dueDate < today);
    const due = t.dueAt ?? (t.dueDate ? `${t.dueDate}T23:59:00+09:00` : undefined);
    if (mine && (t.taskStatus === "requested" || t.taskStatus === "acknowledged")) {
      const reopened = db.messages.some((m) => m.threadId === t.id && m.event === "reopen") && t.taskStatus === "acknowledged" && Boolean(t.reportedAt);
      items.push({
        key: `task:${t.id}`,
        kind: "task",
        title: `${overdue ? "期限超過の依頼" : reopened ? "差し戻された依頼" : t.taskStatus === "requested" ? "新しい業務依頼" : "対応中の依頼"}: ${t.title}`,
        detail: `依頼 ${t.createdBy === "system" ? "システム" : nameOf(t.createdBy)} さん · 対応したら「報告」を押してください`,
        fromId: t.createdBy,
        at: t.updatedAt,
        href: `/messages/${t.id}`,
        dueAt: due,
        overdue,
        status: t.taskStatus,
      });
    } else if (t.taskStatus === "reported" && t.createdBy === user.id) {
      const reporter = db.messages.filter((m) => m.threadId === t.id && m.event === "report").slice(-1)[0]?.userId;
      items.push({ key: `rep:${t.id}`, kind: "report", title: `報告があります: ${t.title}`, detail: `${nameOf(reporter)} さんの報告を確かめて「完了」にしてください`, fromId: reporter, at: t.reportedAt ?? t.updatedAt, href: `/messages/${t.id}`, status: t.taskStatus });
    } else if (mine && t.taskStatus === "reported") {
      waiting.push({ key: `wait:${t.id}`, title: t.title, href: `/messages/${t.id}`, at: t.reportedAt ?? t.updatedAt, status: t.taskStatus, otherId: t.createdBy });
    }
  }

  // 従来の社内連絡のメンション (スレッドを開くと既読)
  const mentionSince = daysAgo(MENTION_DAYS);
  const threads = new Map(db.threads.map((t) => [t.id, t]));
  const seenThreads = new Set<string>();
  for (let i = db.messages.length - 1; i >= 0; i--) {
    const m = db.messages[i];
    if (m.at < mentionSince) continue;
    if (!m.mentions.includes(user.id) || m.userId === user.id || m.event) continue;
    const t = threads.get(m.threadId);
    if (!t || t.status !== "open" || !canViewThread(user, t) || seenThreads.has(t.id)) continue;
    // 依頼先への最初のメンションは業務依頼として数える (二重にしない)
    if ((t.assigneeIds ?? []).includes(user.id) && t.taskStatus && t.taskStatus !== "confirmed") continue;
    if (m.at <= (reads.get(`thread:${t.id}`) ?? "")) continue;
    seenThreads.add(t.id);
    items.push({ key: `tm:${t.id}`, kind: "thread_mention", title: `${nameOf(m.userId)} さんからメンション (社内連絡)`, detail: `${t.title} · ${m.body.replace(/\s+/g, " ").slice(0, 80)}`, fromId: m.userId, at: m.at, href: `/messages/${t.id}` });
  }

  const rank: Record<InboxItem["kind"], number> = { task: 0, report: 1, important: 2, mention: 3, thread_mention: 3 };
  items.sort((a, b) => Number(b.overdue ?? false) - Number(a.overdue ?? false) || rank[a.kind] - rank[b.kind] || b.at.localeCompare(a.at));

  // チャンネルの一覧 (サイドバー: 参加しているチャンネル・DM。公開のチャンネルで参加していないものは「チャンネルを探す」から)
  const stars = starsOf(user.id);
  const pins = pinCounts(defs.map((d) => d.id));
  const channels: ChatChannelView[] = defs
    .filter((d) => isJoined(user.id, d))
    .map((d) => {
      const pending = important.filter((m) => m.channelId === d.id && !m.parentId).length;
      return channelView(db, user, d, { stat: stats.get(d.id), pending, notify: notifyFor(user.id, d, notify), starred: stars.has(d.id), pinCount: pins.get(d.id) ?? 0 });
    });

  const unreadChannels = channels.filter((c) => c.notify === "all" && c.unread > 0);
  const unread = unreadChannels.reduce((a, c) => a + c.unread, 0);
  const latestUnread = unreadChannels.map((c) => c.lastAt ?? "").sort().pop() ?? "";
  const actionKey = `${items.length}:${hash(items.map((i) => `${i.key}@${i.at}`).sort().join(","))}`;
  return {
    channels,
    defs,
    counts: { action: items.length, unread, actionKey, unreadKey: `${unread}:${latestUnread}` },
    inbox: opts.withLists === false ? [] : items,
    waiting: opts.withLists === false ? [] : waiting,
  };
}

/** チャンネル 1 つの画面の形 (サイドバー・参加していない公開のチャンネルを開いたとき) */
export function channelView(
  db: Database,
  user: User,
  d: ChannelDef,
  extra: { stat?: ChannelStat; pending?: number; notify?: ChatChannelView["notify"]; starred?: boolean; pinCount?: number } = {},
): ChatChannelView {
  const ctx = ctxOf(db);
  const s = extra.stat ?? { unread: 0, mentions: 0 };
  const joined = isJoined(user.id, d);
  const last = s.lastAt ? (s.lastBody ? preview(s.lastBody, ctx, 60) : s.lastFiles ? "(資料・写真)" : "") : undefined;
  return {
    id: d.id,
    kind: d.kind,
    name: d.kind === "dm" ? dmName(db, d, user.id) : d.name,
    topic: d.topic,
    storeId: d.storeId,
    color: d.color,
    memberIds: d.memberIds,
    viewer: isViewer(user, d) || undefined,
    unread: joined ? s.unread : 0,
    mentions: joined ? Math.max(s.mentions, 0) + (extra.pending ?? 0) : 0,
    lastAt: s.lastAt,
    lastUserId: s.lastUserId,
    lastPreview: last,
    notify: extra.notify ?? (d.kind === "dm" ? "all" : "priority"),
    canManage: canManage(user, d),
    archived: Boolean(d.archivedAt) || undefined,
    createdBy: d.createdBy,
    createdAt: d.createdAt,
    visibility: d.visibility,
    joined,
    canPost: canPost(user, d),
    canAddMembers: canAddMembers(user, d),
    starred: Boolean(extra.starred),
    pinCount: extra.pinCount ?? 0,
  };
}
