"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, getDb, mutate, newId, nowIso } from "@/lib/db/store";
import type { Message, RelatedType, StoreId, TaskStatus } from "@/lib/db/types";
import { canViewThread } from "@/lib/auth/permissions";
import { TASK_STATUS, THREAD_KIND_LABEL } from "@/lib/constants";
import { mentionNotices, taskNotices } from "@/lib/notify/events";
import { sendAndRecord, type Outgoing } from "@/lib/notify/send";
import { choice, fail, requireActionUser, str, withMsg } from "./guards";

const RELATED: RelatedType[] = ["inquiry", "quote", "order", "invoice", "expense", "purchase", "customer", "supplier"];

export async function createThread(formData: FormData) {
  const user = await requireActionUser();
  const back = "/messages/new";
  const title = str(formData, "title");
  const body = str(formData, "body");
  if (!title || !body) fail(back, "件名と本文を入力してください。");
  const kind = choice(formData, "kind", THREAD_KIND_LABEL, "notice");
  const assigneeIds = [...new Set(formData.getAll("assigneeIds").map(String).filter((m) => m && m !== user.id))];
  const dueDate = str(formData, "dueDate");
  if (kind === "request" && !assigneeIds.length) fail(back, "業務依頼は依頼先 (担当者) を 1 人以上選んでください。");
  if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) fail(back, "期限を正しく入力してください。");
  const id = newId("th");
  let firstMessage: Message | undefined;
  await mutate((db) => {
    const now = nowIso();
    const valid = new Set(db.users.filter((u) => u.active).map((u) => u.id));
    const mentions = [...new Set([...formData.getAll("mentions").map(String), ...assigneeIds])].filter((m) => m && m !== user.id && valid.has(m));
    if (assigneeIds.some((a) => !valid.has(a))) fail(back, "依頼先に無効な社員が含まれています。");
    const participants = [...new Set([user.id, ...mentions])];
    const relatedType = RELATED.find((t) => t === str(formData, "relatedType"));
    const relatedId = relatedType ? str(formData, "relatedId") || undefined : undefined;
    let relatedLabel: string | undefined;
    if (relatedType && relatedId) {
      const coll = relatedType === "quote" ? db.quotes : relatedType === "order" ? db.orders : relatedType === "inquiry" ? db.inquiries : relatedType === "invoice" ? db.invoices : relatedType === "expense" ? db.expenses : relatedType === "purchase" ? db.purchases : undefined;
      relatedLabel = (coll as { id: string; number: string }[] | undefined)?.find((x) => x.id === relatedId)?.number;
      if (relatedType === "customer") relatedLabel = db.customers.find((c) => c.id === relatedId)?.name;
      if (relatedType === "supplier") relatedLabel = db.suppliers.find((s) => s.id === relatedId)?.name;
    }
    // 店舗の指定は実在する店舗だけ (空欄は全社向け)
    const requestedStore = str(formData, "storeId");
    const storeId = db.stores.some((s) => s.id === requestedStore) ? (requestedStore as StoreId) : undefined;
    const isTask = kind === "request";
    db.threads.push({
      id,
      title,
      kind,
      storeId,
      createdBy: user.id,
      participants,
      relatedType: relatedLabel ? relatedType : undefined,
      relatedId: relatedLabel ? relatedId : undefined,
      relatedLabel,
      status: "open",
      createdAt: now,
      updatedAt: now,
      ...(isTask ? { assigneeIds, dueDate: dueDate || undefined, taskStatus: "requested" as TaskStatus } : {}),
    });
    firstMessage = { id: newId("msg"), threadId: id, userId: user.id, body, at: now, mentions };
    db.messages.push(firstMessage);
    addAudit(db, { userId: user.id, action: "create", entity: "thread", entityId: id, entityLabel: title, summary: isTask ? `業務を依頼 (${title} / 依頼先: ${assigneeIds.map((a) => db.users.find((u) => u.id === a)?.name).join("・")}${dueDate ? ` / 期限 ${dueDate}` : ""})` : `社内連絡を作成 (${title})`, storeId });
  });
  const db = getDb();
  const t = db.threads.find((x) => x.id === id);
  if (t && firstMessage) {
    const items: Outgoing[] = kind === "request" ? taskNotices(db, t, user.id, "request", body) : mentionNotices(db, t, firstMessage);
    // 依頼の通知を送った相手には、同じ内容のメンションの通知を重ねて送らない
    if (kind === "request") items.push(...mentionNotices(db, t, { ...firstMessage, mentions: firstMessage.mentions.filter((m) => !(t.assigneeIds ?? []).includes(m)) }));
    await sendAndRecord(items, user.id);
  }
  revalidatePath("/messages");
  redirect(withMsg(`/messages/${id}`, kind === "request" ? "業務を依頼しました。依頼先の通知に表示されます。" : "社内連絡を作成しました。メンションした相手に通知されます。"));
}

export async function postMessage(threadId: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/messages/${threadId}`;
  const body = str(formData, "body");
  if (!body) fail(back, "本文を入力してください。");
  let msg: Message | undefined;
  await mutate((db) => {
    const t = db.threads.find((x) => x.id === threadId);
    if (!t) fail("/messages", "スレッドが見つかりません。");
    if (!canViewThread(user, t)) fail("/messages", "このスレッドに投稿する権限がありません。");
    const now = nowIso();
    const valid = new Set(db.users.filter((u) => u.active).map((u) => u.id));
    const mentions = formData.getAll("mentions").map(String).filter((m) => m && m !== user.id && valid.has(m));
    msg = { id: newId("msg"), threadId, userId: user.id, body, at: now, mentions };
    db.messages.push(msg);
    t.participants = [...new Set([...t.participants, user.id, ...mentions])];
    t.updatedAt = now;
    if (t.status === "done" && !t.taskStatus) t.status = "open";
    addAudit(db, { userId: user.id, action: "update", entity: "thread", entityId: t.id, entityLabel: t.title, summary: `社内連絡に返信 (${t.title})`, storeId: t.storeId });
  });
  const db = getDb();
  const t = db.threads.find((x) => x.id === threadId);
  if (t && msg) await sendAndRecord(mentionNotices(db, t, msg), user.id);
  revalidatePath(back);
  redirect(withMsg(back, "返信を投稿しました。"));
}

export async function setThreadStatus(threadId: string, status: "open" | "done") {
  const user = await requireActionUser();
  const back = `/messages/${threadId}`;
  if (status !== "open" && status !== "done") fail(back, "状態が正しくありません。");
  await mutate((db) => {
    const t = db.threads.find((x) => x.id === threadId);
    if (!t) fail("/messages", "スレッドが見つかりません。");
    if (!canViewThread(user, t)) fail("/messages", "このスレッドを変更する権限がありません。");
    if (t.taskStatus) fail(back, "業務依頼は「確認 → 報告 → 完了」の操作で状態を変えます。");
    t.status = status;
    t.updatedAt = nowIso();
    addAudit(db, { userId: user.id, action: "status", entity: "thread", entityId: threadId, entityLabel: t.title, summary: `社内連絡を${status === "done" ? "完了" : "再開"}`, storeId: t.storeId });
  });
  revalidatePath("/messages");
  redirect(withMsg(back, status === "done" ? "完了にしました。" : "再開しました。"));
}

type TaskStep = "ack" | "report" | "confirm" | "reopen";

const STEP: Record<TaskStep, { from: TaskStatus[]; to: TaskStatus; label: string; by: "assignee" | "requester"; needsBody: boolean }> = {
  ack: { from: ["requested"], to: "acknowledged", label: "確認しました (対応します)", by: "assignee", needsBody: false },
  report: { from: ["requested", "acknowledged"], to: "reported", label: "対応を報告", by: "assignee", needsBody: true },
  confirm: { from: ["reported"], to: "confirmed", label: "報告を確認 (完了)", by: "requester", needsBody: false },
  reopen: { from: ["reported"], to: "acknowledged", label: "報告を差し戻し", by: "requester", needsBody: true },
};

/** 業務依頼の操作: 依頼先が「確認」「報告」、依頼者が「確認 (完了)」「差し戻し」 */
export async function taskStep(threadId: string, step: TaskStep, formData: FormData) {
  const user = await requireActionUser();
  const back = `/messages/${threadId}`;
  const def = Object.prototype.hasOwnProperty.call(STEP, step) ? STEP[step] : undefined;
  if (!def) fail(back, "操作が正しくありません。");
  const body = str(formData, "body");
  if (def.needsBody && !body) fail(back, step === "report" ? "報告の内容を入力してください。" : "差し戻す理由を入力してください。");
  await mutate((db) => {
    const t = db.threads.find((x) => x.id === threadId);
    if (!t || !t.taskStatus) fail("/messages", "業務依頼が見つかりません。");
    const isAssignee = (t.assigneeIds ?? []).includes(user.id);
    const isRequester = t.createdBy === user.id || user.role === "admin";
    if (def.by === "assignee" && !isAssignee) fail(back, "依頼先の担当者が操作します。");
    if (def.by === "requester" && !isRequester) fail(back, "依頼した人が操作します。");
    if (!def.from.includes(t.taskStatus)) fail(back, `「${TASK_STATUS[t.taskStatus].label}」の依頼には、この操作はできません。`);
    const now = nowIso();
    const before = t.taskStatus;
    t.taskStatus = def.to;
    if (step === "ack") t.acknowledgedAt = now;
    if (step === "report") {
      t.reportedAt = now;
      t.acknowledgedAt ??= now;
    }
    if (step === "confirm") {
      t.confirmedAt = now;
      t.confirmedBy = user.id;
      t.status = "done";
    }
    if (step === "reopen") t.status = "open";
    t.updatedAt = now;
    t.participants = [...new Set([...t.participants, user.id])];
    db.messages.push({ id: newId("msg"), threadId, userId: user.id, body: body || def.label, at: now, mentions: [], event: step });
    addAudit(db, { userId: user.id, action: "status", entity: "thread", entityId: t.id, entityLabel: t.title, summary: `業務依頼: ${def.label}${body ? ` (${body.slice(0, 40)})` : ""}`, storeId: t.storeId, changes: [{ field: "taskStatus", before: TASK_STATUS[before].label, after: TASK_STATUS[def.to].label }] });
  });
  const db = getDb();
  const t = db.threads.find((x) => x.id === threadId);
  if (t) await sendAndRecord(taskNotices(db, t, user.id, step, body), user.id);
  revalidatePath("/messages");
  revalidatePath(back);
  redirect(withMsg(back, step === "confirm" ? "報告を確認し、依頼を完了にしました。" : step === "reopen" ? "報告を差し戻しました。" : step === "report" ? "対応を報告しました。依頼者に通知されます。" : "依頼を確認しました。"));
}
