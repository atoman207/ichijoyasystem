"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, mutate, newId, nowIso } from "@/lib/db/store";
import { toDateKey } from "@/lib/format";
import { CHANNEL_LABEL, PAYMENT_METHOD_LABEL } from "@/lib/constants";
import { canManageFinance, isManagerOrAbove } from "@/lib/auth/permissions";
import { postCash } from "@/lib/cashbook";
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
    const date = str(formData, "date") || toDateKey(new Date());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(back, "入金日を正しく入力してください。");
    const paymentId = newId("pay");
    db.payments.push({ id: paymentId, invoiceId, date, amount, method, memo: str(formData, "memo") || undefined, recordedBy: user.id, createdAt: now });
    // 現金の入金は店舗の現金出納帳に記帳する
    if (method === "cash") {
      const name = db.customers.find((c) => c.id === inv.customerId)?.name;
      postCash(db, { storeId: inv.storeId, date, direction: "in", amount, account: "売掛金回収 (現金入金)", counterparty: name, description: `${inv.number} の入金`, source: "payment", sourceId: paymentId, userId: user.id });
    }
    // 入金予定: 全額の入金・予定額を満たす入金で消す。予定額の一部の入金は予定額を減らす (予定額なし = 残高の全額の予定は、一部の入金では残す)
    if (inv.expectedDate) {
      const clearPlan = amount >= remaining || (inv.expectedAmount !== undefined && amount >= inv.expectedAmount);
      if (clearPlan) {
        inv.expectedDate = undefined;
        inv.expectedAmount = undefined;
        inv.expectedNote = undefined;
      } else if (inv.expectedAmount !== undefined) inv.expectedAmount -= amount;
    }
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
  revalidatePath("/cashbook");
  revalidatePath("/");
  redirect(withMsg(back, "入金を登録しました。売掛残高と案件の状態に反映されています (現金は現金出納帳にも記帳しました)。"));
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
    db.commLogs.push({ id: newId("cl"), customerId: inv.customerId, storeId: inv.storeId, channel, direction: "outbound", subject: `ご請求書 ${inv.number} ${kind}`, body: str(formData, "body") || (kind === "督促" ? `お支払期限 (${inv.dueDate}) を過ぎているため、${CHANNEL_LABEL[channel]}でご連絡しました。` : `ご請求書を${CHANNEL_LABEL[channel]}でお送りしました。`), at: now, userId: user.id, relatedType: "invoice", relatedId: inv.id });
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

/** 請求書の記載 (件名・備考・支払期限) を直す。金額の訂正は「無効化 → 見積の変更申請 (承認) → 再発行」で行う */
export async function updateInvoiceInfo(invoiceId: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/invoices/${invoiceId}`;
  if (!canManageFinance(user) && !isManagerOrAbove(user)) fail(back, "請求書の修正は店長・本部スタッフ・管理者が行えます。");
  await mutate((db) => {
    const inv = db.invoices.find((x) => x.id === invoiceId);
    if (!inv) fail("/invoices", "請求書が見つかりません。");
    assertStore(user, inv.storeId, back);
    if (inv.status === "void") fail(back, "無効化した請求書は修正できません。");
    if (inv.status === "paid") fail(back, "入金済みの請求書は修正できません。");
    const dueDate = str(formData, "dueDate");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) fail(back, "支払期限を入力してください。");
    if (dueDate < inv.issueDate) fail(back, "支払期限は発行日以降の日付にしてください。");
    const order = db.orders.find((o) => o.id === inv.orderId);
    const before = { title: inv.title ?? order?.title ?? "", notes: inv.notes ?? "", dueDate: inv.dueDate };
    const after = { title: str(formData, "title") || before.title, notes: str(formData, "notes"), dueDate };
    const LABEL: Record<string, string> = { title: "件名", notes: "備考", dueDate: "支払期限" };
    const changes = (Object.keys(after) as (keyof typeof after)[]).filter((k) => before[k] !== after[k]).map((k) => ({ field: k, before: before[k], after: after[k] }));
    if (!changes.length) fail(back, "変更はありませんでした。");
    inv.title = after.title;
    inv.notes = after.notes || undefined;
    inv.dueDate = after.dueDate;
    inv.updatedAt = nowIso();
    addAudit(db, { userId: user.id, action: "update", entity: "invoice", entityId: inv.id, entityLabel: inv.number, summary: `請求書の記載を修正 (${changes.map((c) => LABEL[c.field]).join("・")})`, storeId: inv.storeId, changes });
  });
  revalidatePath(back);
  revalidatePath("/invoices");
  redirect(withMsg(back, "請求書の記載を修正しました。PDF にも反映されます。"));
}

/** 入金予定 (お客様と約束した入金日・金額) の登録・変更・取消 */
export async function updateExpectedPayment(invoiceId: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/invoices/${invoiceId}`;
  const clear = str(formData, "intent") === "clear";
  await mutate((db) => {
    const inv = db.invoices.find((x) => x.id === invoiceId);
    if (!inv) fail("/invoices", "請求書が見つかりません。");
    assertStore(user, inv.storeId, back);
    if (inv.status === "void" || inv.status === "paid") fail(back, "無効・入金済みの請求書には入金予定を登録できません。");
    const remaining = inv.total - inv.paidAmount;
    const before = { expectedDate: inv.expectedDate, expectedAmount: inv.expectedAmount, expectedNote: inv.expectedNote };
    if (clear) {
      inv.expectedDate = undefined;
      inv.expectedAmount = undefined;
      inv.expectedNote = undefined;
    } else {
      const date = str(formData, "expectedDate");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(back, "入金予定日を入力してください。");
      const amount = numField(formData, "expectedAmount");
      if (amount < 0 || amount > remaining) fail(back, `入金予定額は残高 (¥${remaining.toLocaleString("ja-JP")}) 以下にしてください。`);
      inv.expectedDate = date;
      inv.expectedAmount = amount > 0 && amount < remaining ? Math.round(amount) : undefined;
      inv.expectedNote = str(formData, "expectedNote") || undefined;
    }
    const after = { expectedDate: inv.expectedDate, expectedAmount: inv.expectedAmount, expectedNote: inv.expectedNote };
    const changes = (Object.keys(after) as (keyof typeof after)[]).filter((k) => (before[k] ?? "") !== (after[k] ?? "")).map((k) => ({ field: k, before: before[k], after: after[k] }));
    if (!changes.length) fail(back, "変更はありませんでした。");
    inv.updatedAt = nowIso();
    addAudit(db, { userId: user.id, action: "update", entity: "invoice", entityId: inv.id, entityLabel: inv.number, summary: clear ? "入金予定を取り消し" : `入金予定を登録 (${inv.expectedDate} / ${inv.expectedAmount ? `¥${inv.expectedAmount.toLocaleString("ja-JP")}` : "残高の全額"})`, storeId: inv.storeId, changes });
  });
  revalidatePath(back);
  revalidatePath("/invoices");
  revalidatePath("/finance");
  redirect(withMsg(back, clear ? "入金予定を取り消しました。" : "入金予定を登録しました。入出金の予定・未入金の一覧に表示されます。"));
}
