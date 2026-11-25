"use server";

import { addAudit, getDb, mutate, newId, nowIso } from "@/lib/db/store";
import type { Database, User } from "@/lib/db/types";
import { canCreateChatChannel, canDeleteChatMessage, canSendImportantChat, canViewThread, isChatLead } from "@/lib/auth/permissions";
import { removeObjects } from "@/lib/storage";
import { canAddMembers, canManage, canPost, canView, directId, dmName, findChannel, newChannelId, storeChannelName, viewersOf, type ChannelDef } from "@/lib/chat/channels";
import { ack, archiveChannel, ensureChannel, findGroupDm, findUploads, getMessage, insertMessage, markRead, markUnreadFrom, notifyFor, prefsOf, setChannelNotify, setMembers, setPin, setPrefs, setReminded, setSaved, setStar, setTyping, softDelete, toViews, toggleReaction, updateBody, upsertChannel, type RawMessage, channelNotify } from "@/lib/chat/repo";
import { ALL_EMOJI } from "@/lib/chat/emoji";
import { caseNumbers, encodeMentions, parseMentions, preview, type MentionCtx } from "@/lib/chat/text";
import { createChatTask, ChatTaskError } from "@/lib/chat/tasks";
import { CHAT_MAX_BODY, CHAT_MAX_FILES, DM_MAX_MEMBERS, type ActionResult, type ChatLink, type ChatMessageView, type ChatPrefs, type ChatTaskInput, type NotifyLevel, type SharedMessage } from "@/lib/chat/types";
import { pushLater, pushToUsers, type PushPayload } from "@/lib/notify/push";
import { requireActionUser } from "./guards";

/**
 * チャット (チャンネル・DM) の操作 (お客様のご要望 2026-11-25。画面は src/components/chat)
 * ------------------------------------------------------------
 * 画面から直接呼ぶ Server Action。結果は { ok, error, data } で返す (画面を移らない)。
 * 順序: requireActionUser → チャンネルを見られるか (permissions.ts の canViewChatChannel) → 書き込み (SQLite) → プッシュ通知 (応答のあと)
 * メッセージの本文は変更履歴 (audit_logs) に残さない (DM の本文を管理者が見られる記録に残さないため)。
 * チャンネルの追加・変更・アーカイブは変更履歴に残す (名前とメンバーだけ)
 */

const fail = <T>(error: string): ActionResult<T> => ({ ok: false, error });
/** 本文の「@全員」「@all」(メールアドレスの途中を除く) */
const ALL_TEXT = /(^|[^A-Za-z0-9._%+-])[@＠](全員|all)(?![A-Za-z0-9])/;

function mentionCtx(db: Database, user: User): MentionCtx {
  return {
    users: db.users.filter((u) => u.active).map((u) => ({ id: u.id, name: u.name })),
    stores: db.stores.flatMap((s) => [{ id: s.id, name: s.name }, ...(s.kind === "hq" ? [{ id: s.id, name: storeChannelName(s) }] : [])]),
    allowAll: canSendImportantChat(user),
  };
}

const channelLabel = (db: Database, ch: ChannelDef, me: User) => (ch.kind === "dm" ? dmName(db, ch, me.id) : ch.name);

/** 本文の案件の番号を、見つかった記録の画面へのリンクにする */
function caseLinks(db: Database, body: string): ChatLink[] {
  const out: ChatLink[] = [];
  for (const n of caseNumbers(body)) {
    const hit =
      (n.startsWith("INQ-") && db.inquiries.find((x) => x.number === n) && `/inquiries/${db.inquiries.find((x) => x.number === n)!.id}`) ||
      (n.startsWith("INV-") && db.invoices.find((x) => x.number === n) && `/invoices/${db.invoices.find((x) => x.number === n)!.id}`) ||
      (n.startsWith("Q-") && db.quotes.find((x) => x.number === n) && `/quotes/${db.quotes.find((x) => x.number === n)!.id}`) ||
      (n.startsWith("O-") && db.orders.find((x) => x.number === n) && `/orders/${db.orders.find((x) => x.number === n)!.id}`);
    if (hit) out.push({ text: n, href: hit });
  }
  return out;
}

/** メンションの宛先 (@名前・@店舗・@全員を展開し、そのチャンネルを見られる人に絞る。送った人を除く) */
function mentionTargets(db: Database, ch: ChannelDef, body: string, senderId: string): string[] {
  const p = parseMentions(body);
  const viewers = new Set(viewersOf(db, ch).map((u) => u.id));
  const ids = new Set<string>(p.userIds);
  for (const sid of p.storeIds) for (const u of db.users) if (u.active && u.storeId === sid) ids.add(u.id);
  if (p.all) for (const id of ch.memberIds) ids.add(id);
  ids.delete(senderId);
  return [...ids].filter((id) => viewers.has(id));
}

const msgUrl = (m: Pick<RawMessage, "channelId" | "id" | "parentId">) => `/chat?c=${encodeURIComponent(m.channelId)}&m=${encodeURIComponent(m.id)}${m.parentId ? `&t=${encodeURIComponent(m.parentId)}` : ""}`;

/** 新しいメッセージのプッシュ通知の宛先 (自分あて = 優先 / すべて通知にしている人 = 通常) */
function messagePushes(db: Database, ch: ChannelDef, m: RawMessage, sender: User, mentionIds: string[], skip: Set<string>): { userIds: string[]; payload: PushPayload }[] {
  const ctx = { users: db.users.map((u) => ({ id: u.id, name: u.name })), stores: db.stores.map((s) => ({ id: s.id, name: s.name })) };
  const text = preview(m.body, ctx, 160) || (m.files.length ? `資料・写真 ${m.files.length} 件` : "");
  const mention = new Set(mentionIds);
  const recipients = new Set(m.important ? m.recipients : []);
  const root = m.parentId ? getMessage(m.parentId) : undefined;
  const participants = new Set(root ? [root.userId, ...root.replyUsers] : []);
  const priority: string[] = [];
  const normal: string[] = [];
  for (const v of viewersOf(db, ch)) {
    if (v.id === sender.id || skip.has(v.id)) continue;
    if (mention.has(v.id) || recipients.has(v.id)) priority.push(v.id);
    else if (m.parentId && !m.alsoChannel) {
      if (participants.has(v.id) && (root?.userId === v.id || notifyFor(v.id, ch, channelNotify(v.id)) === "all")) normal.push(v.id);
    } else if (notifyFor(v.id, ch, channelNotify(v.id)) === "all") normal.push(v.id);
  }
  const where = ch.kind === "dm" ? (ch.memberIds.length > 2 ? `${sender.name} (${dmName(db, ch, sender.id)})` : sender.name) : `#${ch.name} · ${sender.name}`;
  const url = msgUrl(m);
  const out: { userIds: string[]; payload: PushPayload }[] = [];
  if (priority.length) {
    const head = m.important ? "【重要】" : "@あなた ";
    out.push({ userIds: priority, payload: { title: `${head}${where}`, body: `${m.parentId ? "(スレッド) " : ""}${text}`, url, tag: `chat-${m.id}`, priority: true } });
  }
  if (normal.length) out.push({ userIds: normal, payload: { title: where, body: `${m.parentId ? "(スレッド) " : ""}${text}`, url, tag: `chat-${ch.id}` } });
  return out;
}

/* ================================================================== */
/* メッセージ                                                          */
/* ================================================================== */

export interface SendInput {
  channelId: string;
  parentId?: string;
  /** スレッドの返信を「チャンネルにも送信」する */
  alsoChannel?: boolean;
  body: string;
  important?: boolean;
  uploadIds?: string[];
  /** 資料・写真ごとの公開範囲 (預けた ID → managers = 店長以上だけ。書いていないものはメンバー全員) */
  fileAccess?: Record<string, "members" | "managers">;
  task?: ChatTaskInput;
}

export async function sendChatMessage(input: SendInput): Promise<ActionResult<{ message: ChatMessageView; taskError?: string }>> {
  const user = await requireActionUser();
  const db = getDb();
  const ch = findChannel(db, String(input.channelId ?? ""));
  if (!canView(user, ch)) return fail("このチャンネルに送る権限がありません。");
  if (!canPost(user, ch)) return fail("このチャンネルに参加してから送ってください (「チャンネルに参加」)。");
  if (ch.archivedAt) return fail("アーカイブしたチャンネルには送れません。");
  const ctx = mentionCtx(db, user);
  const raw = String(input.body ?? "").replace(/\r\n/g, "\n").trim();
  if (raw.length > CHAT_MAX_BODY) return fail(`本文は ${CHAT_MAX_BODY.toLocaleString()} 文字までです。`);
  const uploadIds = [...new Set((input.uploadIds ?? []).map(String))].slice(0, CHAT_MAX_FILES + 1);
  if (uploadIds.length > CHAT_MAX_FILES) return fail(`資料・写真は 1 回に ${CHAT_MAX_FILES} 件までです。`);
  const uploads = findUploads(uploadIds, user.id, ch.id);
  if (uploads.length !== uploadIds.length) return fail("資料・写真の送信の準備ができていないものがあります。選び直してください。");
  if (!raw && !uploads.length) return fail("メッセージを入力してください。");
  const managersOnly = uploads.filter((u) => input.fileAccess?.[u.id] === "managers" || u.file.access === "managers");
  if (managersOnly.length && !isChatLead(user)) return fail("資料を「店長以上だけ」にできるのは管理者・本部・店長です。");
  let parentId: string | undefined;
  if (input.parentId) {
    const root = getMessage(String(input.parentId));
    if (!root || root.channelId !== ch.id || root.parentId) return fail("返信先のメッセージが見つかりません。");
    if (root.deletedAt) return fail("削除されたメッセージには返信できません。");
    parentId = root.id;
  }
  const important = Boolean(input.important) && !parentId;
  if (important && !canSendImportantChat(user)) return fail("重要メッセージを送れるのは管理者・本部・店長です。");
  // @全員 を使えない人が書いたときは、知らせずに送らない (届いたと思わせないため)
  if (!ctx.allowAll && ALL_TEXT.test(raw)) return fail("@全員 を使えるのは管理者・本部・店長です。知らせたい人を @名前 で選ぶか、@店舗 を使ってください。");
  const body = encodeMentions(raw, ctx);
  const p = parseMentions(body);
  if (p.all && !ctx.allowAll) return fail("@全員 を使えるのは管理者・本部・店長です。");
  const mentionIds = mentionTargets(db, ch, body, user.id);
  const recipients = important ? ch.memberIds.filter((id) => id !== user.id) : [];
  if (important && !recipients.length) return fail("このチャンネルには確認をお願いする相手がいません。");
  if (input.task) {
    const ids = (input.task.assigneeIds ?? []).filter((id) => id && id !== user.id);
    if (!ids.length) return fail("業務依頼の依頼先 (担当者) を 1 人以上選んでください。");
  }
  const at = nowIso();
  const msg = insertMessage({
    id: newId("cm"),
    channel: ch,
    parentId,
    userId: user.id,
    body,
    at,
    important,
    recipients,
    mentionAll: p.all,
    mentionIds,
    files: uploads.map((u) => ({ ...u.file, access: managersOnly.some((x) => x.id === u.id) ? "managers" : "members" })),
    links: caseLinks(db, body),
    uploadIds: uploads.map((u) => u.id),
    alsoChannel: Boolean(parentId && input.alsoChannel),
  });
  let taskError: string | undefined;
  let taskAssignees = new Set<string>();
  if (input.task) {
    try {
      await createChatTask(user, ch, channelLabel(db, ch, user), msg, input.task);
      taskAssignees = new Set(input.task.assigneeIds);
    } catch (err) {
      taskError = err instanceof ChatTaskError ? err.message : "業務依頼を作れませんでした。メッセージの「業務依頼にする」からもう一度お試しください。";
      if (!(err instanceof ChatTaskError)) console.error("[chat] task create failed:", err);
    }
  }
  // 業務依頼にした相手には業務依頼の通知が届くので、メッセージの通知を重ねない
  pushLater(messagePushes(getDb(), ch, msg, user, mentionIds, taskAssignees));
  const fresh = getMessage(msg.id) ?? msg;
  return { ok: true, data: { message: toViews(user, [fresh], getDb())[0], taskError } };
}

export async function editChatMessage(id: string, text: string): Promise<ActionResult<{ message: ChatMessageView }>> {
  const user = await requireActionUser();
  const db = getDb();
  const m = getMessage(String(id));
  if (!m || m.deletedAt) return fail("メッセージが見つかりません。");
  const ch = findChannel(db, m.channelId);
  if (!canView(user, ch)) return fail("このメッセージを変更する権限がありません。");
  if (m.userId !== user.id) return fail("自分が送ったメッセージだけ変更できます。");
  const raw = String(text ?? "").replace(/\r\n/g, "\n").trim();
  if (!raw && !m.files.length) return fail("本文を空にするときは、メッセージを削除してください。");
  if (raw.length > CHAT_MAX_BODY) return fail(`本文は ${CHAT_MAX_BODY.toLocaleString()} 文字までです。`);
  const ctx = mentionCtx(db, user);
  if (!ctx.allowAll && ALL_TEXT.test(raw)) return fail("@全員 を使えるのは管理者・本部・店長です。");
  const body = encodeMentions(raw, ctx);
  const p = parseMentions(body);
  if (p.all && !ctx.allowAll) return fail("@全員 を使えるのは管理者・本部・店長です。");
  const before = new Set(mentionTargets(db, ch, m.body, user.id));
  const mentionIds = mentionTargets(db, ch, body, user.id);
  const updated = updateBody(m.id, body, caseLinks(db, body), mentionIds, p.all, nowIso());
  // 新しくメンションした人にだけ知らせる
  const added = mentionIds.filter((x) => !before.has(x));
  if (added.length) pushLater(messagePushes(db, ch, { ...updated, important: false }, user, added, new Set()).filter((x) => x.payload.priority));
  return { ok: true, data: { message: toViews(user, [updated], db)[0] } };
}

export async function deleteChatMessage(id: string): Promise<ActionResult> {
  const user = await requireActionUser();
  const db = getDb();
  const m = getMessage(String(id));
  if (!m || m.deletedAt) return fail("メッセージが見つかりません。");
  const ch = findChannel(db, m.channelId);
  if (!canView(user, ch) || !canDeleteChatMessage(user, m, ch)) return fail("このメッセージを削除する権限がありません。");
  softDelete(m.id, user.id, nowIso());
  // 資料・写真の本体も消す (削除したメッセージの資料を残さない)
  const keys = m.files.flatMap((f) => [f.key, f.thumbKey ?? ""]).filter(Boolean);
  if (keys.length) await removeObjects(keys).catch((err) => console.warn("[chat] file cleanup failed:", (err as Error).message));
  return { ok: true };
}

export async function reactChatMessage(id: string, emoji: string): Promise<ActionResult<{ on: boolean }>> {
  const user = await requireActionUser();
  if (!ALL_EMOJI.includes(emoji)) return fail("使えない絵文字です。");
  const m = getMessage(String(id));
  if (!m || m.deletedAt) return fail("メッセージが見つかりません。");
  if (!canView(user, findChannel(getDb(), m.channelId))) return fail("このメッセージを見る権限がありません。");
  return { ok: true, data: { on: toggleReaction(m.id, user.id, emoji, nowIso()) } };
}

/** 重要メッセージの「確認しました」 */
export async function ackChatMessage(id: string): Promise<ActionResult> {
  const user = await requireActionUser();
  const m = getMessage(String(id));
  if (!m || m.deletedAt || !m.important) return fail("確認する重要メッセージが見つかりません。");
  if (!canView(user, findChannel(getDb(), m.channelId))) return fail("このメッセージを見る権限がありません。");
  if (!m.recipients.includes(user.id)) return fail("このメッセージの確認をお願いされていません。");
  const at = nowIso();
  ack(m.id, user.id, at);
  markRead(user.id, m.parentId ? `t:${m.parentId}` : m.channelId, m.at);
  return { ok: true };
}

/** 重要メッセージを、まだ確認していない人にもう一度知らせる (送った人・管理者。10 分に 1 回まで) */
export async function remindChatMessage(id: string): Promise<ActionResult<{ count: number }>> {
  const user = await requireActionUser();
  const db = getDb();
  const m = getMessage(String(id));
  if (!m || m.deletedAt || !m.important) return fail("重要メッセージが見つかりません。");
  const ch = findChannel(db, m.channelId);
  if (!canView(user, ch)) return fail("このメッセージを見る権限がありません。");
  if (m.userId !== user.id && user.role !== "admin") return fail("もう一度知らせられるのは、送った人と管理者です。");
  if (m.remindedAt && Date.now() - Date.parse(m.remindedAt) < 10 * 60_000) return fail("少し前に知らせたばかりです。10 分ほどたってからお試しください。");
  const view = toViews(user, [m], db)[0];
  const pending = (view.ack?.pendingIds ?? []).filter((x) => db.users.some((u) => u.id === x && u.active));
  if (!pending.length) return fail("全員が確認済みです。");
  setReminded(m.id, nowIso());
  const ctx = { users: db.users.map((u) => ({ id: u.id, name: u.name })), stores: db.stores.map((s) => ({ id: s.id, name: s.name })) };
  pushLater([{ userIds: pending, payload: { title: `【重要・再通知】#${channelLabel(db, ch, user)} · ${db.users.find((u) => u.id === m.userId)?.name ?? ""}`, body: `確認をお願いします: ${preview(m.body, ctx, 150)}`, url: msgUrl(m), tag: `chat-${m.id}`, priority: true } }]);
  return { ok: true, data: { count: pending.length } };
}

/** 既読にする。key = チャンネルの ID / t:<スレッドの最初のメッセージ> / thread:<社内連絡のスレッド> */
export async function markChatRead(key: string, at: string): Promise<ActionResult> {
  const user = await requireActionUser();
  const db = getDb();
  const k = String(key ?? "");
  const when = typeof at === "string" && !Number.isNaN(Date.parse(at)) ? new Date(at).toISOString() : nowIso();
  if (k.startsWith("thread:")) {
    const t = db.threads.find((x) => x.id === k.slice(7));
    if (!t || !canViewThread(user, t)) return fail("スレッドが見つかりません。");
  } else if (k.startsWith("t:")) {
    const root = getMessage(k.slice(2));
    if (!root || !canView(user, findChannel(db, root.channelId))) return fail("スレッドが見つかりません。");
  } else if (!canView(user, findChannel(db, k))) return fail("チャンネルが見つかりません。");
  markRead(user.id, k, when);
  return { ok: true };
}

/* ================================================================== */
/* 業務依頼                                                            */
/* ================================================================== */

export async function makeChatTask(messageId: string, task: ChatTaskInput): Promise<ActionResult<{ threadId: string }>> {
  const user = await requireActionUser();
  const db = getDb();
  const m = getMessage(String(messageId));
  if (!m || m.deletedAt) return fail("メッセージが見つかりません。");
  const ch = findChannel(db, m.channelId);
  if (!canView(user, ch)) return fail("このメッセージを見る権限がありません。");
  if (m.taskThreadId && db.threads.some((t) => t.id === m.taskThreadId)) return fail("このメッセージはすでに業務依頼にしています。");
  try {
    const r = await createChatTask(user, ch, channelLabel(db, ch, user), m, task);
    return { ok: true, data: { threadId: r.thread.id } };
  } catch (err) {
    if (err instanceof ChatTaskError) return fail(err.message);
    console.error("[chat] task create failed:", err);
    return fail("業務依頼を作れませんでした。時間をおいてもう一度お試しください。");
  }
}

/* ================================================================== */
/* 通知の設定                                                          */
/* ================================================================== */

export async function setChatChannelNotify(channelId: string, level: NotifyLevel): Promise<ActionResult> {
  const user = await requireActionUser();
  if (level !== "all" && level !== "priority") return fail("通知の設定が正しくありません。");
  if (!canView(user, findChannel(getDb(), String(channelId)))) return fail("チャンネルが見つかりません。");
  setChannelNotify(user.id, String(channelId), level);
  return { ok: true };
}

export async function setChatPrefs(p: ChatPrefs): Promise<ActionResult<ChatPrefs>> {
  const user = await requireActionUser();
  const next = { sound: Boolean(p?.sound), push: Boolean(p?.push) };
  setPrefs(user.id, next);
  return { ok: true, data: prefsOf(user.id) };
}

/** この端末 (登録したすべての端末) にテストの通知を送る */
export async function testChatPush(): Promise<ActionResult<{ sent: number; devices: number }>> {
  const user = await requireActionUser();
  if (!prefsOf(user.id).push) return fail("プッシュ通知がオフになっています。オンにしてからお試しください。");
  const r = await pushToUsers([user.id], { title: "一畳屋 チャット", body: "テストの通知です。この通知が届けば、システムを閉じていてもお知らせが届きます。", url: "/chat", tag: "chat-test", priority: true });
  if (!r.devices) return fail("この端末はまだ通知を受け取る登録がありません。「この端末で通知を受け取る」を押してください。");
  if (!r.sent) return fail("通知を送れませんでした。端末の通知の設定を確かめて、もう一度「この端末で通知を受け取る」を押してください。");
  return { ok: true, data: { sent: r.sent, devices: r.devices } };
}

/* ================================================================== */
/* チャンネル・DM                                                      */
/* ================================================================== */

function cleanMembers(db: Database, ids: string[]): string[] {
  const valid = new Set(db.users.filter((u) => u.active && !u.signupStatus).map((u) => u.id));
  return [...new Set(ids.map(String))].filter((id) => valid.has(id));
}

/** DM を開く (相手 1 人は 1 対 1。いなければ自分のメモ。2〜8 人はグループ。同じ顔ぶれのグループがあればそれを開く) */
export async function openDirect(memberIds: string[]): Promise<ActionResult<{ channelId: string }>> {
  const user = await requireActionUser();
  const db = getDb();
  const others = cleanMembers(db, memberIds ?? []).filter((id) => id !== user.id);
  if (others.length > DM_MAX_MEMBERS) return fail(`DM の相手は ${DM_MAX_MEMBERS} 人までです。人数が多いときはチャンネルを使ってください。`);
  const at = nowIso();
  if (others.length <= 1) {
    const other = others[0] ?? user.id;
    const id = directId(user.id, other);
    ensureChannel({ id, kind: "dm", members: [...new Set([user.id, other])], createdBy: user.id, at });
    return { ok: true, data: { channelId: id } };
  }
  const members = [user.id, ...others];
  const found = findGroupDm(members);
  if (found) return { ok: true, data: { channelId: found } };
  const id = newChannelId("dm");
  upsertChannel({ id, kind: "dm", name: "", members, createdBy: user.id, at });
  return { ok: true, data: { channelId: id } };
}

const NAME_MAX = 40;

export async function createChatChannel(input: { name: string; topic?: string; memberIds: string[]; visibility?: "public" | "private" }): Promise<ActionResult<{ channelId: string }>> {
  const user = await requireActionUser();
  if (!canCreateChatChannel(user)) return fail("チャンネルを追加する権限がありません。");
  const db = getDb();
  const name = String(input?.name ?? "").replace(/^#/, "").trim();
  if (!name) return fail("チャンネルの名前を入力してください。");
  if (name.length > NAME_MAX) return fail(`名前は ${NAME_MAX} 文字までです。`);
  const visibility = input.visibility === "public" ? "public" : "private";
  const members = [...new Set([user.id, ...cleanMembers(db, input.memberIds ?? [])])];
  // 公開のチャンネルは自分だけで作ってもよい (ほかの社員はあとから参加する)。非公開はメンバーを選ぶ
  if (visibility === "private" && members.length < 2) return fail("非公開のチャンネルはメンバーを 1 人以上選んでください。");
  const id = newChannelId("c");
  const topic = String(input.topic ?? "").trim().slice(0, 200);
  upsertChannel({ id, kind: "custom", name, topic, members, createdBy: user.id, at: nowIso(), visibility });
  await mutate((d) => addAudit(d, { userId: user.id, action: "create", entity: "chat_channel", entityId: id, entityLabel: `#${name}`, summary: `チャットのチャンネルを追加 (#${name} / ${visibility === "public" ? "公開" : "非公開"} / メンバー ${members.length} 人)` })).catch((err) => console.warn("[chat] audit failed:", (err as Error).message));
  return { ok: true, data: { channelId: id } };
}

export async function updateChatChannel(id: string, input: { name: string; topic?: string; memberIds: string[]; visibility?: "public" | "private" }): Promise<ActionResult> {
  const user = await requireActionUser();
  const db = getDb();
  const ch = findChannel(db, String(id));
  if (!ch || ch.kind !== "custom" || !canView(user, ch) || !canManage(user, ch)) return fail("このチャンネルを変更する権限がありません。");
  const name = String(input?.name ?? "").replace(/^#/, "").trim();
  if (!name) return fail("チャンネルの名前を入力してください。");
  if (name.length > NAME_MAX) return fail(`名前は ${NAME_MAX} 文字までです。`);
  // 変更した人と作成した人はメンバーに残す (抜けるときは「チャンネルから抜ける」)
  const members = [...new Set([user.id, ...cleanMembers(db, [...(ch.createdBy ? [ch.createdBy] : []), ...(input.memberIds ?? [])])])];
  const visibility = input.visibility === "public" || (input.visibility === undefined && ch.visibility === "public") ? "public" : "private";
  if (visibility === "private" && members.length < 2) return fail("非公開のチャンネルはメンバーを 1 人以上選んでください。");
  const topic = String(input.topic ?? "").trim().slice(0, 200);
  upsertChannel({ id: ch.id, kind: "custom", name, topic, members, createdBy: ch.createdBy ?? user.id, at: nowIso(), visibility });
  const nameOf = (x: string) => db.users.find((u) => u.id === x)?.name ?? x;
  const added = members.filter((x) => !ch.memberIds.includes(x)).map(nameOf);
  const removed = ch.memberIds.filter((x) => !members.includes(x)).map(nameOf);
  await mutate((d) =>
    addAudit(d, {
      userId: user.id,
      action: "update",
      entity: "chat_channel",
      entityId: ch.id,
      entityLabel: `#${name}`,
      summary: `チャットのチャンネルを変更 (#${name})`,
      changes: [
        ...(ch.name !== name ? [{ field: "name", before: ch.name, after: name }] : []),
        ...((ch.topic ?? "") !== topic ? [{ field: "topic", before: ch.topic ?? "", after: topic }] : []),
        ...((ch.visibility ?? "private") !== visibility ? [{ field: "visibility", before: ch.visibility === "public" ? "公開" : "非公開", after: visibility === "public" ? "公開" : "非公開" }] : []),
        ...(added.length || removed.length ? [{ field: "members", before: removed.length ? `外した: ${removed.join("・")}` : "", after: added.length ? `追加: ${added.join("・")}` : "" }] : []),
      ],
    }),
  ).catch((err) => console.warn("[chat] audit failed:", (err as Error).message));
  return { ok: true };
}

export async function archiveChatChannel(id: string, archived: boolean): Promise<ActionResult> {
  const user = await requireActionUser();
  const db = getDb();
  const ch = findChannel(db, String(id));
  if (!ch || ch.kind !== "custom" || !canManage(user, ch)) return fail("このチャンネルをアーカイブする権限がありません (作成した人・管理者)。");
  archiveChannel(ch.id, nowIso(), Boolean(archived));
  await mutate((d) => addAudit(d, { userId: user.id, action: "status", entity: "chat_channel", entityId: ch.id, entityLabel: `#${ch.name}`, summary: `チャットのチャンネルを${archived ? "アーカイブ" : "元に戻す"} (#${ch.name})`, changes: [{ field: "archived", before: archived ? "使用中" : "アーカイブ", after: archived ? "アーカイブ" : "使用中" }] })).catch((err) => console.warn("[chat] audit failed:", (err as Error).message));
  return { ok: true };
}

/** 追加したチャンネルから抜ける (作成した人は抜けられない。管理者に頼むかアーカイブする) */
export async function leaveChatChannel(id: string): Promise<ActionResult> {
  const user = await requireActionUser();
  const db = getDb();
  const ch = findChannel(db, String(id));
  if (!ch || ch.kind !== "custom" || !ch.memberIds.includes(user.id)) return fail("このチャンネルから抜けられません。");
  if (ch.createdBy === user.id) return fail("作成した人はチャンネルから抜けられません。使わなくなったときはアーカイブしてください。");
  const members = ch.memberIds.filter((x) => x !== user.id);
  setMembers(ch.id, members, nowIso());
  await mutate((d) => addAudit(d, { userId: user.id, action: "update", entity: "chat_channel", entityId: ch.id, entityLabel: `#${ch.name}`, summary: `チャットのチャンネルから抜けた (#${ch.name})`, changes: [{ field: "members", before: `外した: ${user.name}`, after: "" }] })).catch((err) => console.warn("[chat] audit failed:", (err as Error).message));
  return { ok: true };
}

/** 公開のチャンネルに参加する */
export async function joinChatChannel(id: string): Promise<ActionResult> {
  const user = await requireActionUser();
  const db = getDb();
  const ch = findChannel(db, String(id));
  if (!ch || ch.kind !== "custom" || ch.visibility !== "public" || ch.archivedAt) return fail("参加できるチャンネルが見つかりません。");
  if (!ch.memberIds.includes(user.id)) setMembers(ch.id, [...ch.memberIds, user.id], nowIso());
  return { ok: true };
}

/** メンバーを追加する (そのチャンネルのメンバーなら誰でも) */
export async function addChatMembers(id: string, memberIds: string[]): Promise<ActionResult<{ added: number }>> {
  const user = await requireActionUser();
  const db = getDb();
  const ch = findChannel(db, String(id));
  if (!ch || !canAddMembers(user, ch)) return fail("このチャンネルにメンバーを追加する権限がありません (メンバーになってから追加できます)。");
  if (ch.archivedAt) return fail("アーカイブしたチャンネルです。");
  const add = cleanMembers(db, memberIds ?? []).filter((x) => !ch.memberIds.includes(x));
  if (!add.length) return fail("追加する社員を選んでください。");
  setMembers(ch.id, [...ch.memberIds, ...add], nowIso());
  const names = add.map((x) => db.users.find((u) => u.id === x)?.name ?? x);
  await mutate((d) => addAudit(d, { userId: user.id, action: "update", entity: "chat_channel", entityId: ch.id, entityLabel: `#${ch.name}`, summary: `チャットのチャンネルにメンバーを追加 (#${ch.name})`, changes: [{ field: "members", before: "", after: `追加: ${names.join("・")}` }] })).catch((err) => console.warn("[chat] audit failed:", (err as Error).message));
  return { ok: true, data: { added: add.length } };
}

/** メンバーを外す (作成した人・管理者。作成した人は外せない) */
export async function removeChatMember(id: string, memberId: string): Promise<ActionResult> {
  const user = await requireActionUser();
  const db = getDb();
  const ch = findChannel(db, String(id));
  if (!ch || ch.kind !== "custom" || !canManage(user, ch)) return fail("メンバーを外せるのは、チャンネルを作成した人と管理者です。");
  if (memberId === ch.createdBy) return fail("チャンネルを作成した人は外せません。");
  if (!ch.memberIds.includes(memberId)) return fail("メンバーではありません。");
  setMembers(ch.id, ch.memberIds.filter((x) => x !== memberId), nowIso());
  const name = db.users.find((u) => u.id === memberId)?.name ?? memberId;
  await mutate((d) => addAudit(d, { userId: user.id, action: "update", entity: "chat_channel", entityId: ch.id, entityLabel: `#${ch.name}`, summary: `チャットのチャンネルのメンバーを外した (#${ch.name})`, changes: [{ field: "members", before: `外した: ${name}`, after: "" }] })).catch((err) => console.warn("[chat] audit failed:", (err as Error).message));
  return { ok: true };
}

/** ピン留め (チャンネルのメンバーなら誰でも。Slack と同じ) */
export async function pinChatMessage(id: string, on: boolean): Promise<ActionResult> {
  const user = await requireActionUser();
  const m = getMessage(String(id));
  if (!m || m.deletedAt) return fail("メッセージが見つかりません。");
  const ch = findChannel(getDb(), m.channelId);
  if (!canPost(user, ch)) return fail("このチャンネルのメンバーがピン留めできます。");
  setPin(ch.id, m.id, user.id, Boolean(on), nowIso());
  return { ok: true };
}

/** 後で見る (自分だけ) */
export async function saveChatMessage(id: string, on: boolean): Promise<ActionResult> {
  const user = await requireActionUser();
  const m = getMessage(String(id));
  if (!m || m.deletedAt) return fail("メッセージが見つかりません。");
  if (!canView(user, findChannel(getDb(), m.channelId))) return fail("このメッセージを見る権限がありません。");
  setSaved(user.id, m.id, Boolean(on), nowIso());
  return { ok: true };
}

/** ここから未読にする */
export async function markChatUnread(id: string): Promise<ActionResult> {
  const user = await requireActionUser();
  const m = getMessage(String(id));
  if (!m || m.deletedAt) return fail("メッセージが見つかりません。");
  if (!canView(user, findChannel(getDb(), m.channelId))) return fail("このメッセージを見る権限がありません。");
  markUnreadFrom(user.id, m.parentId && !m.alsoChannel ? `t:${m.parentId}` : m.channelId, m.at);
  return { ok: true };
}

/** スター (自分の一覧の上に出す) */
export async function starChatChannel(id: string, on: boolean): Promise<ActionResult> {
  const user = await requireActionUser();
  if (!canView(user, findChannel(getDb(), String(id)))) return fail("チャンネルが見つかりません。");
  setStar(user.id, String(id), Boolean(on), nowIso());
  return { ok: true };
}

/** 入力中 (画面が数秒ごとに知らせる) */
export async function chatTyping(channelId: string, parentId?: string): Promise<ActionResult> {
  const user = await requireActionUser();
  const ch = findChannel(getDb(), String(channelId));
  if (!canPost(user, ch)) return { ok: false };
  setTyping(user.id, parentId ? `t:${parentId}` : ch.id);
  return { ok: true };
}

/** メッセージを別のチャンネル・DM に共有する (転送。元のメッセージを見られる人が、送れるところに) */
export async function shareChatMessage(id: string, targetId: string, comment: string): Promise<ActionResult<{ message: ChatMessageView }>> {
  const user = await requireActionUser();
  const db = getDb();
  const m = getMessage(String(id));
  if (!m || m.deletedAt) return fail("メッセージが見つかりません。");
  const src = findChannel(db, m.channelId);
  if (!canView(user, src)) return fail("このメッセージを見る権限がありません。");
  const target = findChannel(db, String(targetId));
  if (!canPost(user, target)) return fail("共有先に送る権限がありません (参加しているチャンネル・DM を選んでください)。");
  if (target.archivedAt) return fail("アーカイブしたチャンネルには送れません。");
  const raw = String(comment ?? "").replace(/\r\n/g, "\n").trim();
  if (raw.length > CHAT_MAX_BODY) return fail(`本文は ${CHAT_MAX_BODY.toLocaleString()} 文字までです。`);
  const ctx = mentionCtx(db, user);
  if (!ctx.allowAll && ALL_TEXT.test(raw)) return fail("@全員 を使えるのは管理者・本部・店長です。");
  const body = encodeMentions(raw, ctx);
  const p = parseMentions(body);
  const shared: SharedMessage = {
    channelId: src.id,
    channelName: src.kind === "dm" ? "DM" : src.name,
    messageId: m.id,
    parentId: m.parentId,
    userId: m.userId,
    body: m.body,
    at: m.at,
    links: m.links,
    fileNames: m.files.map((f) => f.name),
  };
  const mentionIds = mentionTargets(db, target, body, user.id);
  const msg = insertMessage({ id: newId("cm"), channel: target, userId: user.id, body, at: nowIso(), important: false, recipients: [], mentionAll: p.all, mentionIds, files: [], links: caseLinks(db, body), uploadIds: [], shared });
  pushLater(messagePushes(db, target, { ...msg, body: body || `共有: ${preview(m.body, { users: ctx.users, stores: ctx.stores }, 120)}` }, user, mentionIds, new Set()));
  return { ok: true, data: { message: toViews(user, [msg], db)[0] } };
}
