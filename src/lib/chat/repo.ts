import "server-only";
import type { Database, User } from "@/lib/db/types";
import { canViewChatFile, isChatLead } from "@/lib/auth/permissions";
import { chatDb, jsonArr, nextRev, str, tx, type SqliteDb } from "./db";
import { parseMentions } from "./text";
import type { ChatAckInfo, ChatFile, ChatLink, ChatMessageView, ChatPrefs, ChatReaction, ChatTaskInfo, NotifyLevel } from "./types";
import type { ChannelDef } from "./channels";

/**
 * チャットのメッセージ・既読・リアクション・確認の読み書き (SQLite。src/lib/chat/db.ts)
 * 権限の確かめは呼ぶ側 (src/lib/actions/chat.ts・/api/chat/*) で行う
 */

export interface StoredFile extends ChatFile {
  key: string;
  thumbKey?: string;
  uploadedBy: string;
}

export interface RawMessage {
  id: string;
  channelId: string;
  parentId?: string;
  userId: string;
  body: string;
  at: string;
  editedAt?: string;
  deletedAt?: string;
  deletedBy?: string;
  important: boolean;
  recipients: string[];
  mentionAll: boolean;
  files: StoredFile[];
  links: ChatLink[];
  taskThreadId?: string;
  replyCount: number;
  lastReplyAt?: string;
  replyUsers: string[];
  remindedAt?: string;
  rev: number;
}

export function rowToMessage(r: Record<string, unknown>): RawMessage {
  return {
    id: String(r.id),
    channelId: String(r.channel_id),
    parentId: str(r.parent_id),
    userId: String(r.user_id),
    body: String(r.body ?? ""),
    at: String(r.at),
    editedAt: str(r.edited_at),
    deletedAt: str(r.deleted_at),
    deletedBy: str(r.deleted_by),
    important: Number(r.important) === 1,
    recipients: jsonArr<string>(r.recipients),
    mentionAll: Number(r.mention_all) === 1,
    files: jsonArr<StoredFile>(r.files),
    links: jsonArr<ChatLink>(r.links),
    taskThreadId: str(r.task_thread_id),
    replyCount: Number(r.reply_count ?? 0),
    lastReplyAt: str(r.last_reply_at),
    replyUsers: jsonArr<string>(r.reply_users),
    remindedAt: str(r.reminded_at),
    rev: Number(r.rev ?? 0),
  };
}

export function getMessage(id: string): RawMessage | undefined {
  const r = chatDb().prepare("select * from messages where id = ?").get(id);
  return r ? rowToMessage(r) : undefined;
}

/* ---------------- 一覧 ---------------- */

const PAGE = 50;

/** チャンネルのメッセージ (スレッドの返信を除く。古い順に返す) */
export function channelMessages(channelId: string, opts: { before?: string; limit?: number } = {}): { rows: RawMessage[]; hasMore: boolean } {
  const limit = Math.min(Math.max(opts.limit ?? PAGE, 1), 200);
  const rows = opts.before
    ? chatDb().prepare("select * from messages where channel_id = ? and parent_id is null and at < ? order by at desc, id desc limit ?").all(channelId, opts.before, limit + 1)
    : chatDb().prepare("select * from messages where channel_id = ? and parent_id is null order by at desc, id desc limit ?").all(channelId, limit + 1);
  const hasMore = rows.length > limit;
  return { rows: rows.slice(0, limit).map(rowToMessage).reverse(), hasMore };
}

/** あるメッセージの前後 (検索・要対応から開いたとき) */
export function messagesAround(channelId: string, at: string, span = 25): { rows: RawMessage[]; hasMore: boolean } {
  const before = chatDb().prepare("select * from messages where channel_id = ? and parent_id is null and at < ? order by at desc, id desc limit ?").all(channelId, at, span + 1);
  const after = chatDb().prepare("select * from messages where channel_id = ? and parent_id is null and at >= ? order by at, id limit ?").all(channelId, at, span * 4);
  return { rows: [...before.slice(0, span).reverse(), ...after].map(rowToMessage), hasMore: before.length > span };
}

/** スレッドの返信 (古い順) */
export function replies(parentId: string): RawMessage[] {
  return chatDb().prepare("select * from messages where parent_id = ? order by at, id").all(parentId).map(rowToMessage);
}

/** rev より後に変わったメッセージ (開いているチャンネルのスレッドの返信を除く行・開いているスレッドの返信) */
export function changedSince(channelId: string, rev: number, threadId?: string): { messages: RawMessage[]; replies: RawMessage[] } {
  const db = chatDb();
  const messages = db.prepare("select * from messages where channel_id = ? and rev > ? and parent_id is null order by at, id limit 300").all(channelId, rev).map(rowToMessage);
  const reps = threadId ? db.prepare("select * from messages where parent_id = ? and rev > ? order by at, id limit 300").all(threadId, rev).map(rowToMessage) : [];
  return { messages, replies: reps };
}

/** チャンネルの資料・写真 (新しい順) */
export function channelFiles(channelId: string, limit = 200): { message: RawMessage; file: StoredFile }[] {
  const rows = chatDb().prepare("select * from messages where channel_id = ? and deleted_at is null and files != '[]' order by at desc limit ?").all(channelId, limit).map(rowToMessage);
  return rows.flatMap((m) => m.files.map((file) => ({ message: m, file })));
}

/** 本文の検索 (見られるチャンネルの中だけ。新しい順) */
export function searchMessages(channelIds: string[], q: string, limit = 60): RawMessage[] {
  const words = q.trim().split(/[\s　]+/).filter(Boolean).slice(0, 5);
  if (!words.length || !channelIds.length) return [];
  const where = words.map(() => "(body like ? escape '\\' or files like ? escape '\\')").join(" and ");
  const esc = (w: string) => `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const params = words.flatMap((w) => [esc(w), esc(w)]);
  const ph = channelIds.map(() => "?").join(",");
  return chatDb()
    .prepare(`select * from messages where deleted_at is null and channel_id in (${ph}) and ${where} order by at desc limit ?`)
    .all(...channelIds, ...params, limit)
    .map(rowToMessage);
}

/** 重要メッセージ (見られるチャンネルの中。新しい順) */
export function importantMessages(channelIds: string[], limit = 100): RawMessage[] {
  if (!channelIds.length) return [];
  const ph = channelIds.map(() => "?").join(",");
  return chatDb().prepare(`select * from messages where important = 1 and deleted_at is null and channel_id in (${ph}) order by at desc limit ?`).all(...channelIds, limit).map(rowToMessage);
}

/* ---------------- 画面に渡す形 ---------------- */

function reactionsOf(db: SqliteDb, ids: string[]): Map<string, ChatReaction[]> {
  const out = new Map<string, ChatReaction[]>();
  if (!ids.length) return out;
  const rows = db.prepare(`select message_id, emoji, user_id from reactions where message_id in (${ids.map(() => "?").join(",")}) order by at`).all(...ids);
  for (const r of rows) {
    const list = out.get(String(r.message_id)) ?? [];
    let x = list.find((e) => e.emoji === r.emoji);
    if (!x) list.push((x = { emoji: String(r.emoji), userIds: [] }));
    x.userIds.push(String(r.user_id));
    out.set(String(r.message_id), list);
  }
  return out;
}

function acksOf(db: SqliteDb, ids: string[]): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  if (!ids.length) return out;
  const rows = db.prepare(`select message_id, user_id, at from acks where message_id in (${ids.map(() => "?").join(",")})`).all(...ids);
  for (const r of rows) {
    const m = out.get(String(r.message_id)) ?? new Map<string, string>();
    m.set(String(r.user_id), String(r.at));
    out.set(String(r.message_id), m);
  }
  return out;
}

export function taskInfo(db: Pick<Database, "threads">, threadId: string | undefined, today: string): ChatTaskInfo | undefined {
  if (!threadId) return undefined;
  const t = db.threads.find((x) => x.id === threadId);
  if (!t || !t.taskStatus) return undefined;
  const open = t.taskStatus !== "confirmed";
  const overdue = open && Boolean(t.dueAt ? Date.parse(t.dueAt) < Date.now() : t.dueDate && t.dueDate < today);
  return { threadId: t.id, title: t.title, status: t.taskStatus, assigneeIds: t.assigneeIds ?? [], createdBy: t.createdBy, dueAt: t.dueAt, dueDate: t.dueDate, overdue };
}

const publicFile = (f: StoredFile): ChatFile => ({ id: f.id, name: f.name, type: f.type, size: f.size, photo: f.photo, video: f.video, width: f.width, height: f.height, thumb: Boolean(f.thumbKey), access: f.access });

/** 画面に渡す形 (見られない資料は数だけ。確認の一覧は送った人・店長以上だけ) */
export function toViews(user: User, rows: RawMessage[], db: Pick<Database, "threads">): ChatMessageView[] {
  if (!rows.length) return [];
  const sql = chatDb();
  const ids = rows.map((r) => r.id);
  const reactions = reactionsOf(sql, ids);
  const acks = acksOf(sql, rows.filter((r) => r.important).map((r) => r.id));
  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  return rows.map((m) => {
    const deleted = Boolean(m.deletedAt);
    const files = deleted ? [] : m.files.filter((f) => canViewChatFile(user, f.access));
    const mentions = parseMentions(m.body);
    let ack: ChatAckInfo | undefined;
    if (m.important && !deleted) {
      const a = acks.get(m.id) ?? new Map<string, string>();
      const total = m.recipients.length;
      const done = m.recipients.filter((id) => a.has(id)).length;
      const seeAll = m.userId === user.id || isChatLead(user);
      ack = {
        required: m.recipients.includes(user.id),
        mine: a.get(user.id),
        done,
        total,
        ...(seeAll ? { ackedIds: m.recipients.filter((id) => a.has(id)), pendingIds: m.recipients.filter((id) => !a.has(id)), remindedAt: m.remindedAt } : {}),
      };
    }
    return {
      id: m.id,
      channelId: m.channelId,
      parentId: m.parentId,
      userId: m.userId,
      body: deleted ? "" : m.body,
      at: m.at,
      editedAt: deleted ? undefined : m.editedAt,
      deleted: deleted || undefined,
      important: m.important && !deleted,
      mentions: deleted ? [] : mentions.userIds,
      mentionAll: !deleted && mentions.all,
      files: files.map(publicFile),
      hiddenFiles: deleted ? 0 : m.files.length - files.length,
      reactions: deleted ? [] : (reactions.get(m.id) ?? []),
      replyCount: m.replyCount,
      lastReplyAt: m.lastReplyAt,
      replyUserIds: m.replyUsers,
      ack,
      task: deleted ? undefined : taskInfo(db, m.taskThreadId, today),
      links: deleted ? [] : m.links,
      rev: m.rev,
    };
  });
}

/* ---------------- 書き込み ---------------- */

export interface NewMessage {
  id: string;
  channel: ChannelDef;
  parentId?: string;
  userId: string;
  body: string;
  at: string;
  important: boolean;
  recipients: string[];
  mentionAll: boolean;
  /** メンションの宛先 (@名前・@店舗・@全員を展開して、見られる人に絞ったもの。送った人を除く) */
  mentionIds: string[];
  files: StoredFile[];
  links: ChatLink[];
  uploadIds: string[];
}

export function insertMessage(m: NewMessage): RawMessage {
  return tx((db) => {
    const rev = nextRev(db);
    if (m.parentId) {
      const root = db.prepare("select reply_users from messages where id = ?").get(m.parentId);
      const users = [...new Set([...jsonArr<string>(root?.reply_users), m.userId])].slice(-20);
      db.prepare("update messages set reply_count = reply_count + 1, last_reply_at = ?, reply_users = ?, rev = ? where id = ?").run(m.at, JSON.stringify(users), rev, m.parentId);
    }
    db.prepare(
      `insert into messages (id, channel_id, parent_id, user_id, body, at, important, recipients, mention_all, files, links, rev)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(m.id, m.channel.id, m.parentId ?? null, m.userId, m.body, m.at, m.important ? 1 : 0, JSON.stringify(m.recipients), m.mentionAll ? 1 : 0, JSON.stringify(m.files), JSON.stringify(m.links), rev);
    const ins = db.prepare("insert or ignore into mentions (message_id, user_id, channel_id, at) values (?, ?, ?, ?)");
    for (const uid of m.mentionIds) ins.run(m.id, uid, m.channel.id, m.at);
    if (m.uploadIds.length) {
      const up = db.prepare("update uploads set message_id = ? where id = ? and user_id = ?");
      for (const id of m.uploadIds) up.run(m.id, id, m.userId);
    }
    // 送った人は自分のメッセージまで既読
    markReadIn(db, m.userId, m.parentId ? `t:${m.parentId}` : m.channel.id, m.at);
    if (m.channel.kind === "dm" || m.channel.kind === "custom") db.prepare("update channels set updated_at = ?, rev = ? where id = ?").run(m.at, rev, m.channel.id);
    return rowToMessage(db.prepare("select * from messages where id = ?").get(m.id)!);
  });
}

export function updateBody(id: string, body: string, links: ChatLink[], mentionIds: string[], mentionAll: boolean, at: string): RawMessage {
  return tx((db) => {
    const rev = nextRev(db);
    db.prepare("update messages set body = ?, links = ?, mention_all = ?, edited_at = ?, rev = ? where id = ?").run(body, JSON.stringify(links), mentionAll ? 1 : 0, at, rev, id);
    // 新しく宛先になった人だけを足す (すでに読んだメンションを未読に戻さない)
    const msg = db.prepare("select channel_id, at from messages where id = ?").get(id);
    const ins = db.prepare("insert or ignore into mentions (message_id, user_id, channel_id, at) values (?, ?, ?, ?)");
    for (const uid of mentionIds) ins.run(id, uid, String(msg?.channel_id ?? ""), String(msg?.at ?? at));
    db.prepare(`delete from mentions where message_id = ? ${mentionIds.length ? `and user_id not in (${mentionIds.map(() => "?").join(",")})` : ""}`).run(id, ...mentionIds);
    return rowToMessage(db.prepare("select * from messages where id = ?").get(id)!);
  });
}

export function softDelete(id: string, by: string, at: string): RawMessage {
  return tx((db) => {
    const rev = nextRev(db);
    const m = rowToMessage(db.prepare("select * from messages where id = ?").get(id)!);
    db.prepare("update messages set deleted_at = ?, deleted_by = ?, body = '', files = '[]', links = '[]', important = 0, rev = ? where id = ?").run(at, by, rev, id);
    db.prepare("delete from mentions where message_id = ?").run(id);
    db.prepare("delete from reactions where message_id = ?").run(id);
    if (m.parentId) {
      const left = Number(db.prepare("select count(*) n from messages where parent_id = ? and deleted_at is null").get(m.parentId)?.n ?? 0);
      db.prepare("update messages set reply_count = ?, rev = ? where id = ?").run(left, rev, m.parentId);
    }
    return m;
  });
}

export function toggleReaction(messageId: string, userId: string, emoji: string, at: string): boolean {
  return tx((db) => {
    const rev = nextRev(db);
    const had = db.prepare("select 1 from reactions where message_id = ? and user_id = ? and emoji = ?").get(messageId, userId, emoji);
    if (had) db.prepare("delete from reactions where message_id = ? and user_id = ? and emoji = ?").run(messageId, userId, emoji);
    else db.prepare("insert into reactions (message_id, user_id, emoji, at) values (?, ?, ?, ?)").run(messageId, userId, emoji, at);
    db.prepare("update messages set rev = ? where id = ?").run(rev, messageId);
    return !had;
  });
}

/** 重要メッセージの「確認しました」(確認すると既読にもする) */
export function ack(messageId: string, userId: string, at: string): void {
  tx((db) => {
    const rev = nextRev(db);
    db.prepare("insert or ignore into acks (message_id, user_id, at) values (?, ?, ?)").run(messageId, userId, at);
    db.prepare("update messages set rev = ? where id = ?").run(rev, messageId);
  });
}

export function setReminded(messageId: string, at: string): void {
  tx((db) => {
    const rev = nextRev(db);
    db.prepare("update messages set reminded_at = ?, rev = ? where id = ?").run(at, rev, messageId);
  });
}

export function setTaskThread(messageId: string, threadId: string, channelId: string): void {
  tx((db) => {
    const rev = nextRev(db);
    db.prepare("update messages set task_thread_id = ?, rev = ? where id = ?").run(threadId, rev, messageId);
    db.prepare("insert or replace into task_links (thread_id, message_id, channel_id) values (?, ?, ?)").run(threadId, messageId, channelId);
  });
}

/** 業務依頼 → 元のメッセージ */
export function taskLink(threadId: string): { messageId: string; channelId: string } | undefined {
  const r = chatDb().prepare("select message_id, channel_id from task_links where thread_id = ?").get(threadId);
  return r ? { messageId: String(r.message_id), channelId: String(r.channel_id) } : undefined;
}

/* ---------------- 既読 ---------------- */

function markReadIn(db: SqliteDb, userId: string, key: string, at: string) {
  db.prepare("insert into reads (user_id, key, at) values (?, ?, ?) on conflict (user_id, key) do update set at = max(reads.at, excluded.at)").run(userId, key, at);
}

/** 既読にする (今より先の日時にはしない) */
export function markRead(userId: string, key: string, at: string): void {
  const now = new Date().toISOString();
  markReadIn(chatDb(), userId, key, at > now ? now : at);
}

export function readsOf(userId: string): Map<string, string> {
  return new Map(chatDb().prepare("select key, at from reads where user_id = ?").all(userId).map((r) => [String(r.key), String(r.at)]));
}

/* ---------------- 通知の設定 ---------------- */

export function defaultNotify(ch: Pick<ChannelDef, "kind">): NotifyLevel {
  return ch.kind === "dm" ? "all" : "priority";
}

export function channelNotify(userId: string): Map<string, NotifyLevel> {
  return new Map(chatDb().prepare("select channel_id, notify from channel_prefs where user_id = ?").all(userId).map((r) => [String(r.channel_id), r.notify === "all" ? "all" : "priority"]));
}

export function notifyFor(userId: string, ch: Pick<ChannelDef, "id" | "kind">, cache?: Map<string, NotifyLevel>): NotifyLevel {
  return (cache ?? channelNotify(userId)).get(ch.id) ?? defaultNotify(ch);
}

export function setChannelNotify(userId: string, channelId: string, notify: NotifyLevel): void {
  chatDb().prepare("insert into channel_prefs (user_id, channel_id, notify) values (?, ?, ?) on conflict (user_id, channel_id) do update set notify = excluded.notify").run(userId, channelId, notify);
}

export function prefsOf(userId: string): ChatPrefs {
  const r = chatDb().prepare("select sound, push from prefs where user_id = ?").get(userId);
  return { sound: r ? Number(r.sound) === 1 : true, push: r ? Number(r.push) === 1 : true };
}

export function setPrefs(userId: string, p: ChatPrefs): void {
  chatDb()
    .prepare("insert into prefs (user_id, sound, push, updated_at) values (?, ?, ?, ?) on conflict (user_id) do update set sound = excluded.sound, push = excluded.push, updated_at = excluded.updated_at")
    .run(userId, p.sound ? 1 : 0, p.push ? 1 : 0, new Date().toISOString());
}

/* ---------------- 預かった資料 (送る前) ---------------- */

export interface UploadRow {
  id: string;
  userId: string;
  channelId: string;
  file: StoredFile;
  messageId?: string;
  createdAt: string;
}

export function saveUpload(u: { id: string; userId: string; channelId: string; file: StoredFile; at: string }): void {
  chatDb().prepare("insert into uploads (id, user_id, channel_id, meta, key, thumb_key, created_at) values (?, ?, ?, ?, ?, ?, ?)").run(u.id, u.userId, u.channelId, JSON.stringify(u.file), u.file.key, u.file.thumbKey ?? null, u.at);
}

export function findUploads(ids: string[], userId: string, channelId: string): UploadRow[] {
  if (!ids.length) return [];
  return chatDb()
    .prepare(`select * from uploads where id in (${ids.map(() => "?").join(",")}) and user_id = ? and channel_id = ? and message_id is null`)
    .all(...ids, userId, channelId)
    .map((r) => ({ id: String(r.id), userId: String(r.user_id), channelId: String(r.channel_id), file: JSON.parse(String(r.meta)) as StoredFile, messageId: str(r.message_id), createdAt: String(r.created_at) }));
}

/** 送らなかった資料 (2 日より前) を消す。消すファイルの key を返す */
export function staleUploads(before: string): { ids: string[]; keys: string[] } {
  const rows = chatDb().prepare("select id, key, thumb_key from uploads where message_id is null and created_at < ? limit 200").all(before);
  return { ids: rows.map((r) => String(r.id)), keys: rows.flatMap((r) => [String(r.key), str(r.thumb_key) ?? ""].filter(Boolean)) };
}

export function dropUploads(ids: string[]): void {
  if (!ids.length) return;
  chatDb().prepare(`delete from uploads where id in (${ids.map(() => "?").join(",")})`).run(...ids);
}

/* ---------------- チャンネル (追加したチャンネル・DM) ---------------- */

export function upsertChannel(c: { id: string; kind: "custom" | "dm"; name: string; topic?: string; members: string[]; createdBy: string; at: string }): void {
  tx((db) => {
    const rev = nextRev(db);
    db.prepare(
      `insert into channels (id, kind, name, topic, members, created_by, created_at, updated_at, rev) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (id) do update set name = excluded.name, topic = excluded.topic, members = excluded.members, updated_at = excluded.updated_at, rev = excluded.rev`,
    ).run(c.id, c.kind, c.name, c.topic ?? "", JSON.stringify(c.members), c.createdBy, c.at, c.at, rev);
  });
}

export function ensureChannel(c: { id: string; kind: "dm"; members: string[]; createdBy: string; at: string }): void {
  tx((db) => {
    const rev = nextRev(db);
    db.prepare("insert or ignore into channels (id, kind, name, topic, members, created_by, created_at, updated_at, rev) values (?, 'dm', '', '', ?, ?, ?, ?, ?)").run(c.id, JSON.stringify(c.members), c.createdBy, c.at, c.at, rev);
  });
}

export function findGroupDm(members: string[]): string | undefined {
  const want = [...members].sort().join(",");
  const rows = chatDb().prepare("select id, members from channels where kind = 'dm' and id like 'dm\\_%' escape '\\'").all();
  return rows.find((r) => jsonArr<string>(r.members).slice().sort().join(",") === want)?.id as string | undefined;
}

export function archiveChannel(id: string, at: string, archived: boolean): void {
  tx((db) => {
    const rev = nextRev(db);
    db.prepare("update channels set archived_at = ?, updated_at = ?, rev = ? where id = ?").run(archived ? at : null, at, rev, id);
  });
}

/* ---------------- チャンネルの未読・最後のメッセージ ---------------- */

export interface ChannelStat {
  unread: number;
  mentions: number;
  lastAt?: string;
  lastUserId?: string;
  lastBody?: string;
  lastFiles?: number;
}

export function channelStats(userId: string, channelIds: string[], reads: Map<string, string>, since: string): Map<string, ChannelStat> {
  const db = chatDb();
  const out = new Map<string, ChannelStat>();
  const count = db.prepare("select count(*) n from messages where channel_id = ? and parent_id is null and deleted_at is null and user_id != ? and at > ?");
  const last = db.prepare("select user_id, body, at, files from messages where channel_id = ? and parent_id is null and deleted_at is null order by at desc limit 1");
  const ment = db.prepare(
    `select count(*) n from mentions mn join messages m on m.id = mn.message_id
     where mn.user_id = ? and mn.channel_id = ? and m.deleted_at is null and m.parent_id is null and m.at > ? and m.at > ?`,
  );
  for (const id of channelIds) {
    const read = reads.get(id) ?? "";
    const from = read > since ? read : since;
    const l = last.get(id);
    out.set(id, {
      unread: Number(count.get(id, userId, from)?.n ?? 0),
      mentions: Number(ment.get(userId, id, read, since)?.n ?? 0),
      lastAt: str(l?.at),
      lastUserId: str(l?.user_id),
      lastBody: str(l?.body),
      lastFiles: l ? jsonArr(l.files).length : 0,
    });
  }
  return out;
}

/** 自分あてのメンション (未削除・期間内)。既読かどうかは呼ぶ側で reads と比べる */
export function mentionRows(userId: string, since: string): RawMessage[] {
  return chatDb()
    .prepare("select m.* from mentions mn join messages m on m.id = mn.message_id where mn.user_id = ? and mn.at > ? and m.deleted_at is null order by m.at desc limit 200")
    .all(userId, since)
    .map(rowToMessage);
}

/** 自分が確認していない重要メッセージ (期間内) */
export function pendingImportant(userId: string, since: string): RawMessage[] {
  return chatDb()
    .prepare(
      `select * from messages where important = 1 and deleted_at is null and at > ? and recipients like ?
       and id not in (select message_id from acks where user_id = ?) order by at desc limit 200`,
    )
    .all(since, `%"${userId}"%`, userId)
    .map(rowToMessage);
}
