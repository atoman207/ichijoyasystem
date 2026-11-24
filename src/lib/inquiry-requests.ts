import type { Database, Inquiry, StoreId, Thread, User } from "@/lib/db/types";
import { addAudit, newId, nowIso } from "@/lib/db/store";
import { SYSTEM_USER } from "@/lib/notify/inbound";
import { REQUEST_PURPOSE, dueLabel, isInquiryRequest, isOpenRequest, jstDate, storeMembers, type RequestPurpose } from "@/lib/inquiry-flow";

/**
 * 問い合わせの依頼 (担当店舗・担当者へ、期限つき) と、日程の登録・日程未定にしたときの依頼の完了 (mutate の中で呼ぶ)
 * お客様のご要望 2026-11-24「■ 問い合わせ受付後の業務フロー」①②⑤。対応状況の判定は src/lib/inquiry-flow.ts
 */

export interface RequestInput {
  inquiry: Inquiry;
  requestedBy: string;
  /** 依頼先の店舗 (担当者がいなければ店舗のメンバー全員に) */
  storeId: StoreId;
  assignee?: User;
  purpose: RequestPurpose;
  note: string;
  dueAt?: string;
  urgent?: boolean;
}

/** 依頼先 (担当者、なければ店舗の店長とスタッフ。いなければその店舗の全員) */
export function requestTargets(db: Pick<Database, "users" | "stores">, storeId: StoreId, assignee?: User): User[] {
  if (assignee) return [assignee];
  const members = storeMembers(db, storeId);
  return members.length ? members : db.users.filter((u) => u.active && u.storeId === storeId);
}

export function createInquiryRequest(db: Database, p: RequestInput): Thread {
  const now = nowIso();
  const id = newId("th");
  const targets = requestTargets(db, p.storeId, p.assignee);
  const purpose = REQUEST_PURPOSE[p.purpose];
  const customer = p.inquiry.customerId ? db.customers.find((c) => c.id === p.inquiry.customerId) : undefined;
  const who = customer?.name ?? p.inquiry.contactName;
  const t: Thread = {
    id,
    title: `${p.urgent ? "【至急】" : ""}${purpose.label}: ${p.inquiry.number} ${who} 様 ${p.inquiry.summary}`.slice(0, 120),
    kind: "request",
    storeId: p.storeId,
    createdBy: p.requestedBy,
    participants: [...new Set([p.requestedBy, ...targets.map((u) => u.id)].filter((x) => x !== SYSTEM_USER))],
    relatedType: "inquiry",
    relatedId: p.inquiry.id,
    relatedLabel: p.inquiry.number,
    status: "open",
    createdAt: now,
    updatedAt: now,
    assigneeIds: targets.map((u) => u.id),
    ...(p.assignee ? {} : { assigneeStoreId: p.storeId }),
    purpose: p.purpose,
    ...(p.dueAt ? { dueAt: p.dueAt, dueDate: jstDate(new Date(p.dueAt)) } : {}),
    taskStatus: "requested",
  };
  db.threads.push(t);
  db.messages.push({ id: newId("msg"), threadId: id, userId: p.requestedBy, body: p.note, at: now, mentions: targets.map((u) => u.id) });
  const target = p.assignee ? p.assignee.name : `${db.stores.find((s) => s.id === p.storeId)?.name ?? p.storeId} (店舗)`;
  addAudit(db, {
    userId: p.requestedBy,
    action: "create",
    entity: "thread",
    entityId: id,
    entityLabel: t.title,
    summary: `問い合わせ ${p.inquiry.number} の依頼 (${purpose.label} / 依頼先: ${target}${p.dueAt ? ` / 期限 ${dueLabel(p.dueAt, new Date())}` : ""})`,
    storeId: p.storeId,
  });
  return t;
}

/**
 * 日程を登録した・日程未定にしたときに、その問い合わせの「訪問日程の打ち合わせ」の依頼を完了にする (依頼者にメンションで知らせる)。
 * 完了にした依頼を返す
 */
export function closeScheduleRequests(db: Database, inquiryId: string, userId: string, text: string): Thread[] {
  const now = nowIso();
  const done: Thread[] = [];
  for (const t of db.threads) {
    if (!isInquiryRequest(t) || t.relatedId !== inquiryId || !isOpenRequest(t) || (t.purpose ?? "schedule") !== "schedule") continue;
    const before = t.taskStatus;
    t.taskStatus = "confirmed";
    t.status = "done";
    t.reportedAt ??= now;
    t.acknowledgedAt ??= now;
    t.confirmedAt = now;
    t.confirmedBy = userId;
    t.updatedAt = now;
    t.participants = [...new Set([...t.participants, userId].filter((x) => x !== SYSTEM_USER))];
    db.messages.push({ id: newId("msg"), threadId: t.id, userId, body: `${text} (依頼を完了にしました)`, at: now, mentions: t.createdBy !== userId && t.createdBy !== SYSTEM_USER ? [t.createdBy] : [], event: "confirm" });
    addAudit(db, { userId, action: "status", entity: "thread", entityId: t.id, entityLabel: t.title, summary: `業務依頼を完了 (${text})`, storeId: t.storeId, changes: [{ field: "taskStatus", before: before ?? null, after: "confirmed" }] });
    done.push(t);
  }
  return done;
}
