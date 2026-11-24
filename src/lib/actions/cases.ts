"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, mutate, newId, nextNumber, nowIso } from "@/lib/db/store";
import type { Order, PaymentMethod, Quote, SiteInfo } from "@/lib/db/types";
import { syncHandoverMemo } from "@/lib/db/schedule";
import { canManageFinance, isManagerOrAbove } from "@/lib/auth/permissions";
import { PAYMENT_METHOD_LABEL } from "@/lib/constants";
import { toDateKey } from "@/lib/format";
import { netAmount } from "@/lib/quote-calc";
import { siteInfoFromForm, siteInfoLines } from "@/lib/site-info";
import { PLANNED_PAYMENT_LABEL, caseIndex, orderCase } from "@/lib/case-status";
import { postCash } from "@/lib/cashbook";
import { completedCaseLock, completedLockMessage, quoteCompletedLock } from "@/lib/case-access";
import { assertCaseStore, assertStore, choice, fail, numField, requireActionUser, safeReturn, str, withMsg } from "./guards";
import { isBatchInvoice } from "@/lib/billing";

/* ------------------------------------------------------------------ */
/* 現場情報・引継ぎ事項 (見積・受注)                                     */
/* ------------------------------------------------------------------ */

export async function updateSiteInfo(target: "quote" | "order", id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), `/${target === "quote" ? "quotes" : "orders"}/${id}`);
  const next = siteInfoFromForm(formData);
  await mutate((db) => {
    const rec = target === "quote" ? db.quotes.find((x) => x.id === id) : db.orders.find((x) => x.id === id);
    if (!rec) fail(back, "記録が見つかりません。");
    // 店長はほかの店舗の見積・受注も変更できる (permissions.ts の canEditCaseStore)
    assertCaseStore(user, rec.storeId, back);
    const lock = target === "quote" ? quoteCompletedLock(db, user, rec as Quote) : completedCaseLock(db, user, rec as Order);
    if (lock.locked) fail(back, completedLockMessage(lock.reason));
    const before = new Map(siteInfoLines(rec.siteInfo));
    const after = new Map(siteInfoLines(next));
    const labels = [...new Set([...before.keys(), ...after.keys()])].filter((k) => before.get(k) !== after.get(k));
    if (!labels.length) fail(back, "変更はありませんでした。");
    const now = nowIso();
    rec.siteInfo = next ? ({ ...next, updatedBy: user.id, updatedAt: now } satisfies SiteInfo) : undefined;
    rec.updatedAt = now;
    const changes = labels.map((k) => ({ field: k, before: before.get(k) ?? "", after: after.get(k) ?? "" }));
    if (target === "order") {
      const o = rec as Order;
      o.progressNotes.push({ id: newId("pn"), at: now, userId: user.id, kind: "change", body: `現場情報・引継ぎ事項を変更 (${labels.join("・")})` });
      syncHandoverMemo(db, o);
    } else {
      // 受注済みの見積なら、受注の現場情報も合わせる (受注側で書き換えていない項目)
      const o = db.orders.find((x) => x.quoteId === id && x.status !== "cancelled");
      if (o && !o.siteInfo) {
        o.siteInfo = rec.siteInfo;
        syncHandoverMemo(db, o);
      }
    }
    addAudit(db, { userId: user.id, action: "update", entity: target, entityId: id, entityLabel: rec.number, summary: `現場情報・引継ぎ事項を変更 (${labels.join("・")})`, storeId: rec.storeId, changes });
  });
  revalidatePath(back);
  revalidatePath("/cases");
  redirect(withMsg(back, "現場情報・引継ぎ事項を保存しました。変更は履歴に残り、施工の予定のメモにも反映されます。"));
}

/* ------------------------------------------------------------------ */
/* 案件の状態 (仕様・日程・請求の要否・入金の予定方法)                     */
/* ------------------------------------------------------------------ */

const PLANNED = Object.keys(PLANNED_PAYMENT_LABEL);

export async function updateCaseStatus(orderId: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/orders/${orderId}`;
  await mutate((db) => {
    const o = db.orders.find((x) => x.id === orderId);
    if (!o) fail("/orders", "案件が見つかりません。");
    assertCaseStore(user, o.storeId, back);
    const lock = completedCaseLock(db, user, o);
    if (lock.locked) fail(back, completedLockMessage(lock.reason));
    const before = { spec: o.specStatus ?? "fixed", specNote: o.specNote ?? "", schedule: o.scheduleStatus ?? "", billing: o.billing ?? "auto", planned: o.plannedPayment ?? "" };
    const spec = str(formData, "specStatus") === "pending" ? "pending" : "fixed";
    o.specStatus = spec;
    o.specNote = spec === "pending" ? str(formData, "specNote") || undefined : undefined;
    if (spec === "pending" && !o.specNote) fail(back, "未確定の仕様の内容を入力してください (例: 襖紙の柄をお客様が検討中)。");
    o.scheduleStatus = str(formData, "scheduleStatus") === "adjusting" && !o.scheduledStart ? "adjusting" : undefined;
    const billing = str(formData, "billing");
    o.billing = billing === "required" || billing === "not_required" ? billing : undefined;
    const planned = str(formData, "plannedPayment");
    o.plannedPayment = PLANNED.includes(planned) ? planned : undefined;
    const after = { spec: o.specStatus ?? "fixed", specNote: o.specNote ?? "", schedule: o.scheduleStatus ?? "", billing: o.billing ?? "auto", planned: o.plannedPayment ?? "" };
    const LABEL: Record<string, string> = { spec: "仕様", specNote: "未確定の仕様", schedule: "工事日程", billing: "請求書の要否", planned: "入金の予定方法" };
    const changes = (Object.keys(after) as (keyof typeof after)[]).filter((k) => before[k] !== after[k]).map((k) => ({ field: LABEL[k], before: before[k], after: after[k] }));
    if (!changes.length) fail(back, "変更はありませんでした。");
    const now = nowIso();
    o.updatedAt = now;
    o.progressNotes.push({ id: newId("pn"), at: now, userId: user.id, kind: "change", body: `案件の状態を変更 (${changes.map((c) => c.field).join("・")})${o.specNote ? `\n未確定の仕様: ${o.specNote}` : ""}` });
    addAudit(db, { userId: user.id, action: "update", entity: "order", entityId: o.id, entityLabel: o.number, summary: `案件の状態を変更 (${changes.map((c) => c.field).join("・")})`, storeId: o.storeId, changes });
  });
  revalidatePath(back);
  revalidatePath("/cases");
  redirect(withMsg(back, "案件の状態を保存しました。"));
}

/** 全処理完了 (請求・入金・その他の事務処理まで済んだ)。残っている処理があるときは理由が必要 */
export async function closeCase(orderId: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/orders/${orderId}`;
  if (!canManageFinance(user) && !isManagerOrAbove(user)) fail(back, "全処理完了の登録は店長・本部スタッフ・管理者が行います。");
  await mutate((db) => {
    const o = db.orders.find((x) => x.id === orderId);
    if (!o) fail("/orders", "案件が見つかりません。");
    assertCaseStore(user, o.storeId, back);
    if (!["completed", "invoiced", "paid"].includes(o.status)) fail(back, "工事完了後に登録できます。");
    if (o.closedAt) fail(back, "すでに全処理完了になっています。");
    const row = orderCase(o, caseIndex(db), toDateKey(new Date()));
    const left = row.tasks.filter((t) => t !== "全処理完了の登録");
    const reason = str(formData, "reason");
    if (left.length && !reason) fail(back, `残っている処理があります (${left.join("・")})。このまま完了にする場合は理由を入力してください。`);
    const now = nowIso();
    o.closedAt = now;
    o.closedBy = user.id;
    o.updatedAt = now;
    o.progressNotes.push({ id: newId("pn"), at: now, userId: user.id, kind: "complete", body: `案件の全処理を完了${reason ? ` (${reason})` : ""}` });
    addAudit(db, { userId: user.id, action: "status", entity: "order", entityId: o.id, entityLabel: o.number, summary: `案件の全処理を完了${left.length ? ` (残っていた処理: ${left.join("・")} / 理由: ${reason})` : ""}`, storeId: o.storeId });
  });
  revalidatePath(back);
  revalidatePath("/cases");
  redirect(withMsg(back, "案件を全処理完了にしました。"));
}

export async function reopenCase(orderId: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/orders/${orderId}`;
  if (!canManageFinance(user) && !isManagerOrAbove(user)) fail(back, "店長・本部スタッフ・管理者が行います。");
  await mutate((db) => {
    const o = db.orders.find((x) => x.id === orderId);
    if (!o) fail("/orders", "案件が見つかりません。");
    assertCaseStore(user, o.storeId, back);
    if (!o.closedAt) fail(back, "全処理完了になっていません。");
    o.closedAt = undefined;
    o.closedBy = undefined;
    o.updatedAt = nowIso();
    o.progressNotes.push({ id: newId("pn"), at: nowIso(), userId: user.id, kind: "change", body: `全処理完了を取り消し (${str(formData, "reason") || "理由未記入"})` });
    addAudit(db, { userId: user.id, action: "status", entity: "order", entityId: o.id, entityLabel: o.number, summary: `全処理完了を取り消し (${str(formData, "reason") || "理由未記入"})`, storeId: o.storeId });
  });
  revalidatePath(back);
  redirect(withMsg(back, "全処理完了を取り消しました。"));
}

/**
 * 納品時の集金・決済を記録 (請求書の送付が不要な案件)。
 * 入金の記録は請求書に付けるため、請求書がなければ社内用に発行してから入金を登録する
 */
export async function recordCollection(orderId: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/orders/${orderId}`;
  const amount = numField(formData, "amount");
  const method = choice(formData, "method", PAYMENT_METHOD_LABEL, "cash") as PaymentMethod;
  const date = str(formData, "date") || toDateKey(new Date());
  if (amount <= 0) fail(back, "金額を入力してください。");
  await mutate((db) => {
    const o = db.orders.find((x) => x.id === orderId);
    if (!o) fail("/orders", "案件が見つかりません。");
    // 集金・入金の記録 (請求書を作る) はその店舗の社員 (canAccessStore。店長もほかの店舗の入金は記録しない)
    assertStore(user, o.storeId, back);
    if (!["completed", "invoiced", "paid"].includes(o.status)) fail(back, "施工完了を登録してから集金を記録してください。");
    const now = nowIso();
    let inv = db.invoices.find((i) => i.id === o.invoiceId && i.status !== "void");
    if (inv && isBatchInvoice(inv)) fail(back, `この案件はまとめ請求書 ${inv.number} で請求しています。入金は請求書の画面で登録してください。`);
    if (!inv) {
      const q = db.quotes.find((x) => x.id === o.quoteId);
      const net = q && q.total === o.total ? netAmount(q) : Math.round(o.total / 1.1);
      const id = newId("inv");
      db.invoices.push({
        id,
        number: nextNumber(db, "INV", db.invoices, date),
        orderId: o.id,
        customerId: o.customerId,
        storeId: o.storeId,
        issueDate: date,
        dueDate: date,
        subtotal: net,
        tax: o.total - net,
        total: o.total,
        paidAmount: 0,
        status: "issued",
        sentVia: "visit",
        title: o.title,
        items: q && q.total === o.total ? q.items.map((i) => ({ ...i })) : [{ id: newId("qi"), name: o.title, qty: 1, unit: "式", unitPrice: net, amount: net }],
        taxIncluded: q && q.total === o.total ? q.taxIncluded : undefined,
        taxExempt: q && q.total === o.total ? q.taxExempt : undefined,
        notes: "納品時に集金 (請求書の送付なし)",
        createdBy: user.id,
        createdAt: now,
        updatedAt: now,
      });
      inv = db.invoices[db.invoices.length - 1];
      o.invoiceId = id;
      if (o.billing === undefined) o.billing = "not_required";
      addAudit(db, { userId: user.id, action: "create", entity: "invoice", entityId: id, entityLabel: inv.number, summary: "納品時の集金のため請求書 (社内用) を発行", storeId: o.storeId });
    }
    const remaining = inv.total - inv.paidAmount;
    if (amount > remaining) fail(back, `金額が残高 (¥${remaining.toLocaleString("ja-JP")}) を超えています。`);
    const paymentId = newId("pay");
    db.payments.push({ id: paymentId, invoiceId: inv.id, date, amount, method, memo: str(formData, "memo") || "納品時に集金・決済", recordedBy: user.id, createdAt: now });
    // 現金の集金は店舗の現金出納帳に記帳する
    if (method === "cash") {
      postCash(db, { storeId: o.storeId, date, direction: "in", amount, account: "売掛金回収 (現金入金)", counterparty: db.customers.find((c) => c.id === o.customerId)?.name, description: `${inv.number} 納品時の集金`, source: "payment", sourceId: paymentId, userId: user.id });
    }
    inv.paidAmount += amount;
    inv.status = inv.paidAmount >= inv.total ? "paid" : "partially_paid";
    inv.updatedAt = now;
    o.status = inv.status === "paid" ? "paid" : "invoiced";
    o.updatedAt = now;
    o.progressNotes.push({ id: newId("pn"), at: now, userId: user.id, kind: "note", body: `納品時に ${PAYMENT_METHOD_LABEL[method]} で ¥${amount.toLocaleString("ja-JP")} を受領${method === "card" || method === "paypay" ? " (決済会社からの入金待ち)" : ""}` });
    addAudit(db, { userId: user.id, action: "create", entity: "payment", entityId: inv.id, entityLabel: inv.number, summary: `納品時の集金を記録 (¥${amount.toLocaleString("ja-JP")} / ${PAYMENT_METHOD_LABEL[method]})`, storeId: o.storeId });
  });
  revalidatePath(back);
  revalidatePath("/cases");
  revalidatePath("/invoices");
  redirect(withMsg(back, method === "card" || method === "paypay" ? "受領を記録しました。決済会社からの入金を確認したら、請求の画面で「入金を確認」を押してください。" : "集金を記録しました。"));
}

/** カード・電子決済の入金 (決済会社からの振込) を確認 */
export async function settlePayment(paymentId: string, formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), "/invoices");
  await mutate((db) => {
    const p = db.payments.find((x) => x.id === paymentId);
    if (!p) fail(back, "入金の記録が見つかりません。");
    const inv = db.invoices.find((i) => i.id === p.invoiceId);
    if (!inv) fail(back, "請求書が見つかりません。");
    assertStore(user, inv.storeId, back);
    if (p.settledOn) fail(back, "すでに入金を確認しています。");
    p.settledOn = str(formData, "settledOn") || toDateKey(new Date());
    addAudit(db, { userId: user.id, action: "update", entity: "payment", entityId: inv.id, entityLabel: inv.number, summary: `${PAYMENT_METHOD_LABEL[p.method]} の入金を確認 (¥${p.amount.toLocaleString("ja-JP")} / ${p.settledOn})`, storeId: inv.storeId });
  });
  revalidatePath(back);
  revalidatePath("/cases");
  redirect(withMsg(back, "決済会社からの入金を確認しました。"));
}

/** 見積: お客様と打合せ中 (仕様・金額を調整中) の切り替え */
export async function setQuoteDiscussing(quoteId: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/quotes/${quoteId}`;
  const on = str(formData, "discussing") === "1";
  await mutate((db) => {
    const q = db.quotes.find((x) => x.id === quoteId);
    if (!q) fail("/quotes", "見積が見つかりません。");
    assertCaseStore(user, q.storeId, back);
    q.specStatus = on ? "discussing" : undefined;
    q.updatedAt = nowIso();
    addAudit(db, { userId: user.id, action: "update", entity: "quote", entityId: q.id, entityLabel: q.number, summary: on ? "お客様と打合せ中にしました" : "打合せ中を解除しました", storeId: q.storeId });
  });
  revalidatePath(back);
  revalidatePath("/cases");
  redirect(withMsg(back, on ? "「打合せ中」にしました。" : "「打合せ中」を解除しました。"));
}
