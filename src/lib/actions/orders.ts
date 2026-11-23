"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, diffChanges, getDb, mutate, newId, nextNumber, nowIso } from "@/lib/db/store";
import type { Approval, StoreId } from "@/lib/db/types";
import { AUTO_APPROVAL_NOTE, settleOwnApproval } from "@/lib/approval-decide";
import { addDays, toDateKey } from "@/lib/format";
import { CATEGORY_LABEL, CHANNEL_LABEL, PROGRESS_KIND_LABEL } from "@/lib/constants";
import { approverRole, canAccessStore, canManageFinance, canSeeAllStores, isManagerOrAbove } from "@/lib/auth/permissions";
import { approvalSettings } from "@/lib/approval-rules";
import { fieldLabel, fieldValue } from "@/lib/field-labels";
import { notifyNewApprovals } from "@/lib/notify/approvals";
import { findConflicts, isDateKey, normTime, shortDate, timeLabel, toMinutes } from "@/lib/calendar";
import { orderEditable, removeUpcomingOrderEvents, syncHandoverMemo, syncOrderEvent } from "@/lib/db/schedule";
import { assertStore, choice, fail, requireActionUser, str, withMsg } from "./guards";
import { propagateOrderSite } from "@/lib/maps/store";
import { completedCaseLock, completedLockMessage } from "@/lib/case-access";
import { closedReason } from "@/lib/mgmt/close";
import { usesBatchBilling } from "@/lib/billing";

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
  if (o0.handovers?.length) fail(back, "この受注は品目ごとの引取・納品の日程で予定表に載せています。「引取・納品の日程」で変更してください。");
  const lock0 = completedCaseLock(db0, user, o0);
  if (lock0.locked) fail(back, completedLockMessage(lock0.reason));
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
    const siteBefore = o.siteAddress;
    o.siteAddress = str(formData, "siteAddress") || o.siteAddress;
    if (siteBefore !== o.siteAddress) propagateOrderSite(db, user, o, siteBefore);
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

/** 施工完了 → 売上計上 (売上計上日 = 施工完了日。個人・法人とも。請求書の発行日とは別に持つ) */
export async function completeOrder(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/orders/${id}`;
  let batch = false;
  await mutate((db) => {
    const o = db.orders.find((x) => x.id === id);
    if (!o) fail("/orders", "受注が見つかりません。");
    assertStore(user, o.storeId, back);
    if (!["confirmed", "scheduled", "in_progress"].includes(o.status)) fail(back, "この状態の案件は完了にできません。");
    const date = str(formData, "completedAt") || toDateKey(new Date());
    if (!isDateKey(date)) fail(back, "施工完了日を正しく入力してください。");
    // 管理会計で月次確定した月には売上を入れない (src/lib/mgmt/close.ts)
    const closed = closedReason(db, date, "施工完了 (売上計上)");
    if (closed) fail(back, closed);
    batch = usesBatchBilling(db.customers.find((c) => c.id === o.customerId));
    o.status = "completed";
    o.completedAt = date;
    o.salesDate = date;
    o.updatedAt = nowIso();
    o.progressNotes.push({ id: newId("pn"), at: nowIso(), userId: user.id, kind: "complete", body: str(formData, "body") || "施工完了。お客様確認済み。" });
    addAudit(db, { userId: user.id, action: "status", entity: "order", entityId: id, entityLabel: o.number, summary: `施工完了を登録 (売上計上日 ${date} / ¥${o.total.toLocaleString("ja-JP")})`, storeId: o.storeId });
  });
  revalidatePath(back);
  revalidatePath("/");
  redirect(withMsg(back, batch ? "施工完了を登録し、売上に計上しました (売上計上日 = 施工完了日)。このお客様はまとめ請求のため、請求書は締め日にまとめて発行します。" : "施工完了を登録し、売上に計上しました (売上計上日 = 施工完了日)。続けて請求書を発行できます。"));
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
    // 税抜の金額 = 合計 − 消費税 (税込の見積は内税)
    const subtotal = q && q.total === o.total ? q.total - q.tax : Math.round(o.total / 1.1);
    const tax = o.total - subtotal;
    // 発行時の明細を請求書に残す (見積があれば見積の明細。ない案件は「件名 一式」)
    const items = q && q.total === o.total ? q.items.map((i) => ({ ...i })) : [{ id: newId("qi"), name: o.title, qty: 1, unit: "式", unitPrice: subtotal, amount: subtotal }];
    const notes = str(formData, "notes") || undefined;
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
      title: o.title,
      items,
      taxIncluded: q && q.total === o.total ? q.taxIncluded : undefined,
      notes,
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
    });
    o.invoiceId = invoiceId;
    o.status = "invoiced";
    o.updatedAt = now;
    const num = db.invoices[db.invoices.length - 1].number;
    db.commLogs.push({ id: newId("cl"), customerId: o.customerId, storeId: o.storeId, channel: sentVia, direction: "outbound", subject: `ご請求書 ${num}`, body: `施工完了に伴い、ご請求書 (¥${o.total.toLocaleString("ja-JP")}) を${CHANNEL_LABEL[sentVia]}でお送りしました。お支払期限: ${addDays(today, dueDays)}`, at: now, userId: user.id, relatedType: "invoice", relatedId: invoiceId });
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
    const lock = completedCaseLock(db, user, o);
    if (lock.locked) fail(back, completedLockMessage(lock.reason));
    o.status = "cancelled";
    o.updatedAt = nowIso();
    o.progressNotes.push({ id: newId("pn"), at: nowIso(), userId: user.id, kind: "change", body: `キャンセル: ${str(formData, "reason") || "理由未記入"}` });
    removeUpcomingOrderEvents(db, o.id);
    addAudit(db, { userId: user.id, action: "status", entity: "order", entityId: id, entityLabel: o.number, summary: `受注をキャンセル (${str(formData, "reason") || "理由未記入"})`, storeId: o.storeId });
  });
  revalidatePath(back);
  redirect(withMsg(back, "受注をキャンセルしました。"));
}

/** 契約承認の差戻しの後、内容を見直して再申請する */
export async function resubmitOrder(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/orders/${id}`;
  let approvalId = "";
  let role = "";
  let auto = false;
  await mutate((db) => {
    const o = db.orders.find((x) => x.id === id);
    if (!o) fail("/orders", "受注が見つかりません。");
    assertStore(user, o.storeId, back);
    if (o.status !== "returned") fail(back, "差し戻された受注のみ再申請できます。");
    if (db.approvals.some((a) => a.targetId === o.id && a.type === "order" && a.status === "pending")) fail(back, "すでに承認待ちの申請があります。");
    const now = nowIso();
    const r = approverRole(db.users, o.storeId, o.total >= approvalSettings(db).quoteAdminThreshold, user.id);
    role = r;
    approvalId = newId("ap");
    const comment = str(formData, "comment");
    const approval: Approval = { id: approvalId, type: "order", targetId: o.id, title: `${o.number} ${o.title}`, amount: o.total, storeId: o.storeId, requestedBy: user.id, requiredRole: r, status: "pending", requestComment: comment ? `再申請: ${comment}` : "再申請", createdAt: now };
    db.approvals.push(approval);
    o.status = "pending_approval";
    o.updatedAt = now;
    o.progressNotes.push({ id: newId("pn"), at: now, userId: user.id, kind: "note", body: `契約承認を再申請しました${comment ? ` (${comment})` : ""}` });
    addAudit(db, { userId: user.id, action: "submit", entity: "order", entityId: o.id, entityLabel: o.number, summary: `契約承認を再申請 (${r === "admin" ? "管理者" : "店長"}承認)${comment ? ` ${comment}` : ""}`, storeId: o.storeId });
    auto = settleOwnApproval(db, approval, user, back);
  });
  await notifyNewApprovals([approvalId], user.id);
  revalidatePath(back);
  revalidatePath("/orders");
  redirect(withMsg(back, auto ? `${AUTO_APPROVAL_NOTE}し、契約を確定しました。` : `${role === "admin" ? "管理者" : "店長"}へ契約承認を再申請しました。`));
}

/**
 * 契約内容 (重要な情報) の変更を申請する: 契約日・契約金額 (見積から作っていない受注のみ。見積からの受注は見積の金額変更で直す)。
 * 承認されると受注に反映し、変更前後を履歴に残す
 */
export async function requestOrderChange(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/orders/${id}`;
  const reason = str(formData, "reason");
  if (!reason) fail(back, "変更の理由を入力してください。");
  let approvalId = "";
  let role = "";
  let auto = false;
  await mutate((db) => {
    const o = db.orders.find((x) => x.id === id);
    if (!o) fail("/orders", "受注が見つかりません。");
    assertStore(user, o.storeId, back);
    if (o.status === "cancelled") fail(back, "キャンセルした受注は変更できません。");
    const lock = completedCaseLock(db, user, o);
    if (lock.locked) fail(back, completedLockMessage(lock.reason));
    if (db.approvals.some((a) => a.targetId === o.id && a.type === "order_change" && a.status === "pending")) fail(back, "承認待ちの契約内容の変更があります。承認・差戻しの後にもう一度申請してください。");
    const changes: { field: string; before: unknown; after: unknown }[] = [];
    const contractDate = str(formData, "contractDate");
    if (contractDate && contractDate !== o.contractDate) {
      if (!isDateKey(contractDate)) fail(back, "契約日を正しく入力してください。");
      changes.push({ field: "contractDate", before: o.contractDate, after: contractDate });
    }
    // 施工完了日・売上計上日の訂正 (例: 完了日の入力の誤り)。売上計上日は施工完了日に合わせる (別の日にするときは売上計上日も入力する)。請求書の発行日は変えない
    const completedAt = str(formData, "completedAt");
    const salesDateRaw = str(formData, "salesDate");
    if ((completedAt && completedAt !== o.completedAt) || (salesDateRaw && salesDateRaw !== o.salesDate)) {
      if (!o.completedAt || !["completed", "invoiced", "paid"].includes(o.status)) fail(back, "施工完了日・売上計上日は、施工完了を登録した案件で直せます。");
      if ((completedAt && !isDateKey(completedAt)) || (salesDateRaw && !isDateKey(salesDateRaw))) fail(back, "施工完了日・売上計上日を正しく入力してください。");
      const nextCompleted = completedAt || o.completedAt;
      // 売上計上日を入力していない (または元のまま) で完了日だけ直したときは、売上計上日も完了日に合わせる
      const nextSales = salesDateRaw && salesDateRaw !== o.salesDate ? salesDateRaw : o.salesDate === o.completedAt || !o.salesDate ? nextCompleted : o.salesDate;
      if (nextSales < (contractDate || o.contractDate) && nextSales !== o.salesDate) fail(back, "売上計上日は契約日以降の日付にしてください。");
      for (const d of [o.salesDate, nextSales]) {
        const closed = closedReason(db, d, "売上計上日の変更");
        if (closed && nextSales !== o.salesDate) fail(back, closed);
      }
      if (nextCompleted !== o.completedAt) changes.push({ field: "completedAt", before: o.completedAt, after: nextCompleted });
      if (nextSales !== o.salesDate) changes.push({ field: "salesDate", before: o.salesDate, after: nextSales });
    }
    const totalRaw = str(formData, "total").replace(/[,¥\s]/g, "");
    if (totalRaw) {
      const total = Number(totalRaw);
      if (!Number.isFinite(total) || total <= 0) fail(back, "契約金額を正しく入力してください。");
      if (Math.round(total) !== o.total) {
        if (o.quoteId) fail(back, "見積から作った受注の金額は、見積の画面で「金額・内容の変更を申請」から直してください (版として残ります)。");
        if (db.invoices.some((i) => i.id === o.invoiceId && i.status !== "void")) fail(back, "請求書を発行済みのため、契約金額は変更できません。入金前であれば本部で請求書を無効化してから申請してください。");
        changes.push({ field: "total", before: o.total, after: Math.round(total) });
      }
    }
    if (!changes.length) fail(back, "変更する項目がありません。");
    const newTotal = (changes.find((c) => c.field === "total")?.after as number | undefined) ?? o.total;
    const r = approverRole(db.users, o.storeId, Math.max(o.total, newTotal) >= approvalSettings(db).quoteAdminThreshold, user.id);
    role = r;
    approvalId = newId("ap");
    const now = nowIso();
    const approval: Approval = { id: approvalId, type: "order_change", targetId: o.id, title: `${o.number} ${o.title}`, amount: newTotal, storeId: o.storeId, requestedBy: user.id, requiredRole: r, status: "pending", requestComment: reason, changes, createdAt: now };
    db.approvals.push(approval);
    o.progressNotes.push({ id: newId("pn"), at: now, userId: user.id, kind: "change", body: `契約内容の変更を申請 (${changes.map((c) => `${fieldLabel("order", c.field)} ${fieldValue(c.field, c.before)} → ${fieldValue(c.field, c.after)}`).join("、")} / 理由: ${reason})` });
    o.updatedAt = now;
    addAudit(db, { userId: user.id, action: "submit", entity: "order", entityId: o.id, entityLabel: o.number, summary: `契約内容の変更を申請 (${changes.map((c) => fieldLabel("order", c.field)).join("・")} / 理由: ${reason})`, storeId: o.storeId, changes });
    auto = settleOwnApproval(db, approval, user, back);
  });
  await notifyNewApprovals([approvalId], user.id);
  revalidatePath(back);
  redirect(withMsg(back, auto ? `${AUTO_APPROVAL_NOTE}し、契約内容の変更を反映しました。` : `契約内容の変更を${role === "admin" ? "管理者" : "店長"}へ申請しました。承認後に反映されます。`));
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
    const lock = completedCaseLock(db, user, o);
    if (lock.locked) fail(back, completedLockMessage(lock.reason));
    const before = { ...o };
    o.title = title;
    o.category = choice(formData, "category", CATEGORY_LABEL, o.category);
    o.siteAddress = str(formData, "siteAddress") || o.siteAddress;
    if (formData.has("receiptName")) o.receiptName = str(formData, "receiptName").slice(0, 100) || undefined;
    if (formData.has("workDetails")) o.workDetails = str(formData, "workDetails") || undefined;
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
    const changes = diffChanges(before, o, ["title", "category", "siteAddress", "receiptName", "storeId", "workDetails"]);
    if (changes.length === 0) fail(back, "変更はありませんでした。");
    o.updatedAt = nowIso();
    // 連動している施工の予定があれば、場所・店舗を合わせる (予定がない案件に新しく作ることはしない)
    if (db.schedule.some((e) => e.orderId === o.id && e.source === "order")) syncOrderEvent(db, o, user.id);
    // 案件の場所に合わせている今後の予定 (納品・訪問など) の場所も合わせる
    if (before.siteAddress !== o.siteAddress) propagateOrderSite(db, user, o, before.siteAddress);
    const storeName = db.stores.find((s) => s.id === o.storeId)?.name ?? o.storeId;
    const LABEL: Record<string, string> = { title: "件名", category: "種別", siteAddress: "施工場所", receiptName: "領収書の宛名", storeId: `担当店舗 (${storeName})`, workDetails: "施工内容" };
    if (changes.some((c) => c.field === "workDetails")) syncHandoverMemo(db, o);
    if (changes.some((c) => c.field === "workDetails")) o.progressNotes.push({ id: newId("pn"), at: nowIso(), userId: user.id, kind: "change", body: `施工内容を変更: ${o.workDetails ?? "(なし)"}` });
    addAudit(db, { userId: user.id, action: "update", entity: "order", entityId: id, entityLabel: o.number, summary: `案件情報を変更 (${changes.map((c) => LABEL[c.field] ?? c.field).join("・")})`, storeId: o.storeId, changes });
  });
  revalidatePath(back);
  revalidatePath("/orders");
  revalidatePath("/schedule");
  if (moved) redirect(withMsg("/orders", "案件の担当店舗を変更しました。"));
  redirect(withMsg(back, "案件情報を変更しました。予定表・関連する画面にも反映されます。"));
}
