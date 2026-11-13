"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, diffChanges, getDb, mutate, newId, nextNumber, nowIso } from "@/lib/db/store";
import type { Channel, ProgressKind, StoreId } from "@/lib/db/types";
import { addDays, toDateKey } from "@/lib/format";
import { CATEGORY_LABEL, CHANNEL_LABEL, PROGRESS_KIND_LABEL } from "@/lib/constants";
import { canAccessStore, canManageFinance, canSeeAllStores, isManagerOrAbove } from "@/lib/auth/permissions";
import { findConflicts, isDateKey, normTime, shortDate, timeLabel, toMinutes } from "@/lib/calendar";
import { orderEditable, removeUpcomingOrderEvents, syncOrderEvent } from "@/lib/db/schedule";
import { assertStore, choice, fail, requireActionUser, str, withMsg } from "./guards";

/** 施工予定 (施工期間・時間帯・施工担当・現場住所) を設定し、予定表の「施工」の予定と連動させる */
export async function updateOrderSchedule(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/orders/${id}`;
  const start = str(formData, "scheduledStart");
  const end = str(formData, "scheduledEnd") || start;
  if (start && !isDateKey(start)) fail(back, "施工開始日を正しく入力してください。");
  if (end && (!isDateKey(end) || end < start)) fail(back, "施工終了日は施工開始日以降の日付にしてください。");
  const allDay = str(formData, "allDay") === "1";
  const startTime = allDay ? undefined : normTime(str(formData, "startTime"));
  const endTime = startTime ? normTime(str(formData, "endTime")) : undefined;
  if (startTime && endTime && toMinutes(endTime) <= toMinutes(startTime)) fail(back, "終了時刻は開始時刻より後にしてください。");
  const workerIds = [...new Set(formData.getAll("workerIds").map(String).filter(Boolean))];

  // 施工担当の予定の重複 (同じ案件の予定は対象外)
  const db0 = getDb();
  const o0 = db0.orders.find((x) => x.id === id);
  if (!o0) fail("/orders", "受注が見つかりません。");
  assertStore(user, o0.storeId, back);
  if (!orderEditable(o0)) fail(back, "完了済みの案件は変更できません。");
  if (start) {
    const quote = db0.quotes.find((q) => q.id === o0.quoteId);
    const hits = findConflicts(
      { date: start, endDate: end > start ? end : undefined, startTime, endTime, assigneeIds: workerIds.length ? workerIds : o0.workerIds, orderId: o0.id, quoteId: o0.quoteId, inquiryId: quote?.inquiryId },
      db0.schedule,
    );
    if (hits.length && str(formData, "allowOverlap") !== "1") {
      const list = hits.slice(0, 3).map((h) => `${db0.users.find((u) => u.id === h.userId)?.name} さん ${shortDate(h.day)} ${timeLabel(h.event)}「${h.event.title}」`).join("、");
      fail(back, `施工担当の予定が重複しています: ${list}${hits.length > 3 ? ` ほか ${hits.length - 3} 件` : ""}。日程・担当を見直すか「重複を承知で保存する」にチェックしてください。`);
    }
  }

  await mutate((db) => {
    const o = db.orders.find((x) => x.id === id);
    if (!o) fail("/orders", "受注が見つかりません。");
    const before = { start: o.scheduledStart, end: o.scheduledEnd, workers: [...o.workerIds] };
    o.scheduledStart = start || undefined;
    o.scheduledEnd = start ? end || start : undefined;
    if (workerIds.length) o.workerIds = workerIds;
    o.siteAddress = str(formData, "siteAddress") || o.siteAddress;
    if (o.status === "confirmed" && start) o.status = "scheduled";
    if (o.status === "scheduled" && !start) o.status = "confirmed";
    o.updatedAt = nowIso();
    // 予定表 (施工の予定) と連動
    syncOrderEvent(db, o, user.id, { startTime, endTime });
    const period = start ? `${start}${o.scheduledEnd && o.scheduledEnd !== start ? `〜${o.scheduledEnd}` : ""}${startTime ? ` ${startTime}${endTime ? `–${endTime}` : ""}` : " 終日"}` : "未定";
    o.progressNotes.push({ id: newId("pn"), at: nowIso(), userId: user.id, kind: "production", body: `施工予定を ${period} に設定 (担当: ${o.workerIds.map((w) => db.users.find((u) => u.id === w)?.name).join("・")})` });
    addAudit(db, { userId: user.id, action: "update", entity: "order", entityId: id, entityLabel: o.number, summary: `施工予定を更新 (${period})`, storeId: o.storeId, changes: [{ field: "scheduledStart", before: before.start, after: o.scheduledStart }, { field: "scheduledEnd", before: before.end, after: o.scheduledEnd }, { field: "workerIds", before: before.workers, after: o.workerIds }] });
  });
  revalidatePath(back);
  revalidatePath("/schedule");
  redirect(withMsg(back, start ? "施工予定を更新しました。担当者とともに予定表 (店舗のカレンダー) に反映されています。" : "施工予定を未定に戻しました。予定表からも外しました。"));
}

export async function addProgress(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/orders/${id}`;
  const body = str(formData, "body");
  const kind = choice(formData, "kind", PROGRESS_KIND_LABEL, "note");
  if (!body) fail(back, "進捗内容を入力してください。");
  await mutate((db) => {
    const o = db.orders.find((x) => x.id === id);
    if (!o) fail("/orders", "受注が見つかりません。");
    assertStore(user, o.storeId, back);
    o.progressNotes.push({ id: newId("pn"), at: nowIso(), userId: user.id, kind, body });
    if (kind === "install" && (o.status === "scheduled" || o.status === "confirmed")) o.status = "in_progress";
    o.updatedAt = nowIso();
    addAudit(db, { userId: user.id, action: "update", entity: "order", entityId: id, entityLabel: o.number, summary: `進捗を記録 (${PROGRESS_KIND_LABEL[kind]}: ${body.slice(0, 30)})`, storeId: o.storeId });
  });
  revalidatePath(back);
  redirect(withMsg(back, "進捗を記録しました。"));
}

/** 施工完了 → 売上計上 */
export async function completeOrder(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/orders/${id}`;
  await mutate((db) => {
    const o = db.orders.find((x) => x.id === id);
    if (!o) fail("/orders", "受注が見つかりません。");
    assertStore(user, o.storeId, back);
    if (!["confirmed", "scheduled", "in_progress"].includes(o.status)) fail(back, "この状態の案件は完了にできません。");
    const date = str(formData, "completedAt") || toDateKey(new Date());
    o.status = "completed";
    o.completedAt = date;
    o.salesDate = date;
    o.updatedAt = nowIso();
    o.progressNotes.push({ id: newId("pn"), at: nowIso(), userId: user.id, kind: "complete", body: str(formData, "body") || "施工完了。お客様確認済み。" });
    addAudit(db, { userId: user.id, action: "status", entity: "order", entityId: id, entityLabel: o.number, summary: `施工完了を登録 (売上計上日 ${date} / ¥${o.total.toLocaleString("ja-JP")})`, storeId: o.storeId });
  });
  revalidatePath(back);
  revalidatePath("/");
  redirect(withMsg(back, "施工完了を登録し、売上に計上しました。続けて請求書を発行できます。"));
}

export async function createInvoiceFromOrder(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/orders/${id}`;
  if (!canManageFinance(user) && !isManagerOrAbove(user)) fail(back, "請求書の発行は店長・本部・管理者が行えます。");
  let invoiceId = "";
  await mutate((db) => {
    const o = db.orders.find((x) => x.id === id);
    if (!o) fail("/orders", "受注が見つかりません。");
    assertStore(user, o.storeId, back);
    if (o.status !== "completed") fail(back, "施工完了後に請求書を発行できます。");
    if (o.invoiceId) fail(back, "すでに請求書が発行されています。");
    const q = db.quotes.find((x) => x.id === o.quoteId);
    const customer = db.customers.find((c) => c.id === o.customerId);
    const today = toDateKey(new Date());
    const dueDays = Number(str(formData, "dueDays")) || (customer?.type === "corporate" ? 30 : 14);
    const sentVia = choice(formData, "sentVia", CHANNEL_LABEL, "mail");
    const now = nowIso();
    invoiceId = newId("inv");
    const subtotal = q ? q.subtotal - q.discount : Math.round(o.total / 1.1);
    const tax = o.total - subtotal;
    db.invoices.push({
      id: invoiceId,
      number: nextNumber(db, "INV", db.invoices, today),
      orderId: o.id,
      customerId: o.customerId,
      storeId: o.storeId,
      issueDate: today,
      dueDate: addDays(today, dueDays),
      subtotal,
      tax,
      total: o.total,
      paidAmount: 0,
      status: "issued",
      sentVia,
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
    });
    o.invoiceId = invoiceId;
    o.status = "invoiced";
    o.updatedAt = now;
    const num = db.invoices[db.invoices.length - 1].number;
    db.commLogs.push({ id: newId("cl"), customerId: o.customerId, channel: sentVia, direction: "outbound", subject: `ご請求書 ${num}`, body: `施工完了に伴い、ご請求書 (¥${o.total.toLocaleString("ja-JP")}) を${CHANNEL_LABEL[sentVia]}でお送りしました。お支払期限: ${addDays(today, dueDays)}`, at: now, userId: user.id, relatedType: "invoice", relatedId: invoiceId });
    addAudit(db, { userId: user.id, action: "create", entity: "invoice", entityId: invoiceId, entityLabel: num, summary: `請求書を発行 (¥${o.total.toLocaleString("ja-JP")} / ${CHANNEL_LABEL[sentVia]})`, storeId: o.storeId });
  });
  revalidatePath("/invoices");
  redirect(withMsg(`/invoices/${invoiceId}`, "請求書を発行しました。"));
}

export async function cancelOrder(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/orders/${id}`;
  if (!isManagerOrAbove(user)) fail(back, "キャンセルは店長・管理者のみ行えます。");
  await mutate((db) => {
    const o = db.orders.find((x) => x.id === id);
    if (!o) fail("/orders", "受注が見つかりません。");
    assertStore(user, o.storeId, back);
    if (["invoiced", "paid", "cancelled"].includes(o.status)) fail(back, "請求済み・入金済みの案件はキャンセルできません。");
    o.status = "cancelled";
    o.updatedAt = nowIso();
    o.progressNotes.push({ id: newId("pn"), at: nowIso(), userId: user.id, kind: "change", body: `キャンセル: ${str(formData, "reason") || "理由未記入"}` });
    removeUpcomingOrderEvents(db, o.id);
    addAudit(db, { userId: user.id, action: "status", entity: "order", entityId: id, entityLabel: o.number, summary: `受注をキャンセル (${str(formData, "reason") || "理由未記入"})`, storeId: o.storeId });
  });
  revalidatePath(back);
  redirect(withMsg(back, "受注をキャンセルしました。"));
}

/**
 * 案件情報 (件名・種別・現場住所・担当店舗) の変更
 * - 担当店舗の変更は本部スタッフ・管理者のみ。案件の予定 (施工・訪問など) と承認待ちの申請も新しい店舗へ移す
 * - 請求済み・入金済み・キャンセルの案件は担当店舗を変えない (売上・請求の店舗が食い違わないように)
 */
export async function updateOrderInfo(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/orders/${id}`;
  const title = str(formData, "title");
  if (!title) fail(back, "件名は必須です。");
  let moved = false;
  await mutate((db) => {
    const o = db.orders.find((x) => x.id === id);
    if (!o) fail("/orders", "受注が見つかりません。");
    assertStore(user, o.storeId, back);
    const before = { ...o };
    o.title = title;
    o.category = choice(formData, "category", CATEGORY_LABEL, o.category);
    o.siteAddress = str(formData, "siteAddress") || o.siteAddress;
    const storeId = str(formData, "storeId");
    if (storeId && storeId !== o.storeId) {
      if (!canSeeAllStores(user)) fail(back, "担当店舗の変更は本部スタッフ・管理者が行います。");
      if (!db.stores.some((s) => s.id === storeId)) fail(back, "担当店舗が正しくありません。");
      if (["invoiced", "paid", "cancelled"].includes(o.status)) fail(back, "請求済み・入金済み・キャンセルの案件は、担当店舗を変更できません。");
      o.storeId = storeId as StoreId;
      for (const e of db.schedule) if (e.orderId === o.id) e.storeId = o.storeId;
      for (const a of db.approvals) if (a.status === "pending" && a.targetId === o.id) a.storeId = o.storeId;
      moved = !canAccessStore(user, o.storeId);
    }
    const changes = diffChanges(before, o, ["title", "category", "siteAddress", "storeId"]);
    if (changes.length === 0) fail(back, "変更はありませんでした。");
    o.updatedAt = nowIso();
    // 連動している施工の予定があれば、場所・店舗を合わせる (予定がない案件に新しく作ることはしない)
    if (db.schedule.some((e) => e.orderId === o.id && e.source === "order")) syncOrderEvent(db, o, user.id);
    const storeName = db.stores.find((s) => s.id === o.storeId)?.name ?? o.storeId;
    const LABEL: Record<string, string> = { title: "件名", category: "種別", siteAddress: "現場住所", storeId: `担当店舗 (${storeName})` };
    addAudit(db, { userId: user.id, action: "update", entity: "order", entityId: id, entityLabel: o.number, summary: `案件情報を変更 (${changes.map((c) => LABEL[c.field] ?? c.field).join("・")})`, storeId: o.storeId, changes });
  });
  revalidatePath(back);
  revalidatePath("/orders");
  revalidatePath("/schedule");
  if (moved) redirect(withMsg("/orders", "案件の担当店舗を変更しました。"));
  redirect(withMsg(back, "案件情報を変更しました。予定表・関連する画面にも反映されます。"));
}
