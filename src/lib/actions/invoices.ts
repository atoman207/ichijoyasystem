"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, mutate, newId, nowIso } from "@/lib/db/store";
import type { Channel, PaymentMethod } from "@/lib/db/types";
import { toDateKey } from "@/lib/format";
import { CHANNEL_LABEL, PAYMENT_METHOD_LABEL } from "@/lib/constants";
import { canManageFinance } from "@/lib/auth/permissions";
import { assertStore, choice, fail, numField, requireActionUser, str, withMsg } from "./guards";

export async function recordPayment(invoiceId: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/invoices/${invoiceId}`;
  const amount = numField(formData, "amount");
  if (amount <= 0) fail(back, "入金額を入力してください。");
  await mutate((db) => {
    const inv = db.invoices.find((x) => x.id === invoiceId);
    if (!inv) fail("/invoices", "請求書が見つかりません。");
    assertStore(user, inv.storeId, back);
    if (inv.status === "void") fail(back, "無効化された請求書には入金できません。");
    const remaining = inv.total - inv.paidAmount;
    if (amount > remaining) fail(back, `入金額が残高 (¥${remaining.toLocaleString("ja-JP")}) を超えています。`);
    const now = nowIso();
    const method = choice(formData, "method", PAYMENT_METHOD_LABEL, "transfer");
    db.payments.push({ id: newId("pay"), invoiceId, date: str(formData, "date") || toDateKey(new Date()), amount, method, memo: str(formData, "memo") || undefined, recordedBy: user.id, createdAt: now });
    inv.paidAmount += amount;
    inv.status = inv.paidAmount >= inv.total ? "paid" : "partially_paid";
    inv.updatedAt = now;
    if (inv.status === "paid") {
      const o = db.orders.find((x) => x.id === inv.orderId);
      if (o) {
        o.status = "paid";
        o.updatedAt = now;
      }
    }
    addAudit(db, { userId: user.id, action: "create", entity: "payment", entityId: invoiceId, entityLabel: inv.number, summary: `入金を登録 (¥${amount.toLocaleString("ja-JP")} / ${PAYMENT_METHOD_LABEL[method]})${inv.status === "paid" ? " → 入金完了" : ""}`, storeId: inv.storeId });
  });
  revalidatePath("/invoices");
  revalidatePath("/");
  redirect(withMsg(back, "入金を登録しました。売掛残高と案件の状態に反映されています。"));
}

/** 送付・督促の記録 */
export async function logInvoiceContact(invoiceId: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/invoices/${invoiceId}`;
  const channel = choice(formData, "channel", CHANNEL_LABEL, "phone");
  const kind = str(formData, "kind") === "reminder" ? "督促" : "送付";
  await mutate((db) => {
    const inv = db.invoices.find((x) => x.id === invoiceId);
    if (!inv) fail("/invoices", "請求書が見つかりません。");
    assertStore(user, inv.storeId, back);
    const now = nowIso();
    if (kind === "送付") inv.sentVia = channel;
    inv.updatedAt = now;
    db.commLogs.push({ id: newId("cl"), customerId: inv.customerId, channel, direction: "outbound", subject: `ご請求書 ${inv.number} ${kind}`, body: str(formData, "body") || (kind === "督促" ? `お支払期限 (${inv.dueDate}) を過ぎているため、${CHANNEL_LABEL[channel]}でご連絡しました。` : `ご請求書を${CHANNEL_LABEL[channel]}でお送りしました。`), at: now, userId: user.id, relatedType: "invoice", relatedId: inv.id });
    addAudit(db, { userId: user.id, action: "send", entity: "invoice", entityId: inv.id, entityLabel: inv.number, summary: `請求書の${kind}を記録 (${CHANNEL_LABEL[channel]})`, storeId: inv.storeId });
  });
  revalidatePath(back);
  redirect(withMsg(back, `${kind}を記録しました。顧客のやりとり履歴にも残ります。`));
}

export async function voidInvoice(invoiceId: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/invoices/${invoiceId}`;
  if (!canManageFinance(user)) fail(back, "請求書の無効化は本部・管理者のみ行えます。");
  await mutate((db) => {
    const inv = db.invoices.find((x) => x.id === invoiceId);
    if (!inv) fail("/invoices", "請求書が見つかりません。");
    if (inv.status === "void") fail(back, "この請求書はすでに無効化されています。");
    if (inv.paidAmount > 0) fail(back, "入金済みの請求書は無効化できません。");
    inv.status = "void";
    inv.updatedAt = nowIso();
    // 受注が再発行した別の請求書を指しているときは、受注の状態を変えない
    const o = db.orders.find((x) => x.id === inv.orderId && x.invoiceId === inv.id);
    if (o) {
      o.invoiceId = undefined;
      o.status = "completed";
    }
    addAudit(db, { userId: user.id, action: "status", entity: "invoice", entityId: inv.id, entityLabel: inv.number, summary: `請求書を無効化 (${str(formData, "reason") || "理由未記入"})`, storeId: inv.storeId });
  });
  revalidatePath("/invoices");
  redirect(withMsg(back, "請求書を無効化しました。案件から再発行できます。"));
}
