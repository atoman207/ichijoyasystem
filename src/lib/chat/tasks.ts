import "server-only";
import type { StoreId, Thread, User } from "@/lib/db/types";
import { addAudit, getDb, mutate, newId, nowIso } from "@/lib/db/store";
import { dueAtFrom, jstDate, type DueChoice } from "@/lib/inquiry-flow";
import { mentionNotices, taskNotices } from "@/lib/notify/events";
import { sendAndRecord } from "@/lib/notify/send";
import type { ChannelDef } from "./channels";
import { decodeMentions } from "./text";
import { setTaskThread, type RawMessage } from "./repo";
import type { ChatTaskInput } from "./types";

/**
 * チャットのメッセージから業務依頼を作る (「業務依頼にする」・送るときの「業務依頼として送る」)
 * ------------------------------------------------------------
 * 業務依頼は従来の threads (社内連絡・業務依頼) にそのまま作る。確認 → 報告 → 依頼した人の完了の確認、期限を過ぎたときの
 * 再通知、通知 (メール・Chatwork・プッシュ通知) はこれまでの業務依頼と同じ。メッセージには業務依頼の状態を出す (task_links)。
 * 見られる人: 業務依頼の決まり (依頼した人・依頼先・店舗のチャンネルはその店舗、ほかは依頼した人の店舗の社員・本部・管理者)。
 * 個人間の DM は管理者も見られないが、業務依頼にした内容は業務の記録として権限のある社員が確かめられる (お客様のご要望「■5」)
 */

export class ChatTaskError extends Error {}

export interface ChatTaskResult {
  thread: Thread;
}

export async function createChatTask(user: User, ch: ChannelDef, chName: string, msg: RawMessage, input: ChatTaskInput): Promise<ChatTaskResult> {
  const db0 = getDb();
  const valid = new Set(db0.users.filter((u) => u.active).map((u) => u.id));
  const assigneeIds = [...new Set(input.assigneeIds)].filter((id) => id && valid.has(id) && id !== user.id);
  if (!assigneeIds.length) throw new ChatTaskError("依頼先 (担当者) を 1 人以上選んでください (自分には依頼できません)。");
  const due = dueAtFrom(input.due as DueChoice, input.dueCustom, new Date());
  if (due.error) throw new ChatTaskError(due.error);
  const ctx = { users: db0.users.map((u) => ({ id: u.id, name: u.name })), stores: db0.stores.map((s) => ({ id: s.id, name: s.name })) };
  const text = decodeMentions(msg.body, ctx).trim();
  const files = msg.files.map((f) => `・${f.name}`).join("\n");
  const title = (input.title.trim() || text.split("\n")[0] || "チャットからの依頼").slice(0, 80);
  const where = ch.kind === "dm" ? "DM" : `#${chName}`;
  const body = `${text || "(本文なし)"}${files ? `\n\n添付: \n${files}` : ""}\n\n(チャット「${where}」のメッセージから依頼。資料・写真はチャットのメッセージで開けます)`;
  const storeId: StoreId | undefined = ch.kind === "store" && ch.storeId ? (ch.storeId as StoreId) : user.storeId;
  const id = newId("th");
  const now = nowIso();
  let thread: Thread | undefined;
  await mutate((db) => {
    if (db.threads.some((t) => t.id === id)) return;
    const t: Thread = {
      id,
      title,
      kind: "request",
      storeId,
      createdBy: user.id,
      participants: [...new Set([user.id, ...assigneeIds])],
      status: "open",
      createdAt: now,
      updatedAt: now,
      assigneeIds,
      ...(due.dueAt ? { dueAt: due.dueAt, dueDate: jstDate(new Date(due.dueAt)) } : {}),
      taskStatus: "requested",
    };
    db.threads.push(t);
    db.messages.push({ id: newId("msg"), threadId: id, userId: user.id, body, at: now, mentions: assigneeIds });
    addAudit(db, {
      userId: user.id,
      action: "create",
      entity: "thread",
      entityId: id,
      entityLabel: title,
      summary: `チャットから業務を依頼 (${title} / 依頼先: ${assigneeIds.map((a) => db.users.find((u) => u.id === a)?.name).join("・")}${due.dueAt ? ` / 期限 ${due.dueAt.slice(0, 16)}` : ""})`,
      storeId,
    });
    thread = t;
  });
  if (!thread) throw new ChatTaskError("業務依頼を作れませんでした。もう一度お試しください。");
  setTaskThread(msg.id, thread.id, ch.id);
  const db = getDb();
  const t = db.threads.find((x) => x.id === id) ?? thread;
  const first = db.messages.find((m) => m.threadId === id);
  const items = taskNotices(db, t, user.id, "request", body);
  if (first) items.push(...mentionNotices(db, t, { ...first, mentions: first.mentions.filter((m) => !assigneeIds.includes(m)) }));
  await sendAndRecord(items, user.id).catch((err) => console.warn("[chat] task notices failed:", (err as Error).message));
  return { thread: t };
}

