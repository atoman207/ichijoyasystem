"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, mutate, newId, nowIso } from "@/lib/db/store";
import type { RelatedType, StoreId, ThreadKind } from "@/lib/db/types";
import { canViewThread } from "@/lib/auth/permissions";
import { THREAD_KIND_LABEL } from "@/lib/constants";
import { choice, fail, requireActionUser, str, withMsg } from "./guards";

export async function createThread(formData: FormData) {
  const user = await requireActionUser();
  const back = "/messages/new";
  const title = str(formData, "title");
  const body = str(formData, "body");
  if (!title || !body) fail(back, "件名と本文を入力してください。");
  const id = newId("th");
  await mutate((db) => {
    const now = nowIso();
    const mentions = formData.getAll("mentions").map(String).filter((m) => m && m !== user.id);
    const participants = [...new Set([user.id, ...mentions])];
    const relatedType: RelatedType | undefined = (["inquiry", "quote", "order", "invoice", "expense", "purchase", "customer"] as const).find((t) => t === str(formData, "relatedType"));
    const relatedId = str(formData, "relatedId") || undefined;
    let relatedLabel: string | undefined;
    if (relatedType && relatedId) {
      const coll = relatedType === "quote" ? db.quotes : relatedType === "order" ? db.orders : relatedType === "inquiry" ? db.inquiries : relatedType === "invoice" ? db.invoices : relatedType === "expense" ? db.expenses : relatedType === "purchase" ? db.purchases : undefined;
      relatedLabel = (coll as { id: string; number: string }[] | undefined)?.find((x) => x.id === relatedId)?.number;
      if (relatedType === "customer") relatedLabel = db.customers.find((c) => c.id === relatedId)?.name;
    }
    // 店舗の指定は実在する店舗だけ (空欄は全社向け)
    const requestedStore = str(formData, "storeId");
    const storeId = db.stores.some((s) => s.id === requestedStore) ? (requestedStore as StoreId) : undefined;
    db.threads.push({
      id,
      title,
      kind: choice(formData, "kind", THREAD_KIND_LABEL, "notice"),
      storeId,
      createdBy: user.id,
      participants,
      relatedType,
      relatedId,
      relatedLabel,
      status: "open",
      createdAt: now,
      updatedAt: now,
    });
    db.messages.push({ id: newId("msg"), threadId: id, userId: user.id, body, at: now, mentions });
    addAudit(db, { userId: user.id, action: "create", entity: "thread", entityId: id, entityLabel: title, summary: `社内連絡を作成 (${title})`, storeId });
  });
  revalidatePath("/messages");
  redirect(withMsg(`/messages/${id}`, "社内連絡を作成しました。メンションした相手に通知されます。"));
}

export async function postMessage(threadId: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/messages/${threadId}`;
  const body = str(formData, "body");
  if (!body) fail(back, "本文を入力してください。");
  await mutate((db) => {
    const t = db.threads.find((x) => x.id === threadId);
    if (!t) fail("/messages", "スレッドが見つかりません。");
    if (!canViewThread(user, t)) fail("/messages", "このスレッドに投稿する権限がありません。");
    const now = nowIso();
    const mentions = formData.getAll("mentions").map(String).filter((m) => m && m !== user.id);
    db.messages.push({ id: newId("msg"), threadId, userId: user.id, body, at: now, mentions });
    t.participants = [...new Set([...t.participants, user.id, ...mentions])];
    t.updatedAt = now;
    if (t.status === "done") t.status = "open";
    addAudit(db, { userId: user.id, action: "update", entity: "thread", entityId: t.id, entityLabel: t.title, summary: `社内連絡に返信 (${t.title})`, storeId: t.storeId });
  });
  revalidatePath(back);
  redirect(withMsg(back, "返信を投稿しました。"));
}

export async function setThreadStatus(threadId: string, status: "open" | "done") {
  const user = await requireActionUser();
  const back = `/messages/${threadId}`;
  await mutate((db) => {
    const t = db.threads.find((x) => x.id === threadId);
    if (!t) fail("/messages", "スレッドが見つかりません。");
    if (!canViewThread(user, t)) fail("/messages", "このスレッドを変更する権限がありません。");
    t.status = status;
    t.updatedAt = nowIso();
    addAudit(db, { userId: user.id, action: "status", entity: "thread", entityId: threadId, entityLabel: t.title, summary: `社内連絡を${status === "done" ? "完了" : "再開"}`, storeId: t.storeId });
  });
  revalidatePath("/messages");
  redirect(withMsg(back, status === "done" ? "完了にしました。" : "再開しました。"));
}
