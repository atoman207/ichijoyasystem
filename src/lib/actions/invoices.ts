"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, mutate, newId, nowIso } from "@/lib/db/store";
import { toDateKey } from "@/lib/format";
import { CHANNEL_LABEL, PAYMENT_METHOD_LABEL } from "@/lib/constants";
import { canManageFinance, isManagerOrAbove } from "@/lib/auth/permissions";
import { invoiceOrderIds } from "@/lib/billing";
import { assertStore, choice, fail, numField, requireActionUser, str, withMsg } from "./guards";
import { applyPayment } from "@/lib/payments";

export async function recordPayment(invoiceId: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/invoices/${invoiceId}`;
  const amount = numField(formData, "amount");
  if (amount <= 0) fail(back, "入金額を入力してください。");
  await mutate((db) => {
    const inv = db.invoices.find((x) => x.id === invoiceId);
    if (!inv) fail("/invoices", "請求書が見つかりません。");
    assertStore(user, inv.storeId, back);
    const date = str(formData, "date") || toDateKey(new Date());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(back, "入金日を正しく入力してください。");
    const err = applyPayment(db, user.id, inv, { date, amount, method: choice(formData, "method", PAYMENT_METHOD_LABEL, "transfer"), memo: str(formData, "memo") || undefined });
    if (err) fail(back, err);
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
    // 受注が再発行した別の請求書を指しているときは、受注の状態を変えない (まとめ請求は対象の受注すべて)
    const ids = new Set(invoiceOrderIds(inv));
    for (const o of db.orders) {
      if (!ids.has(o.id) || o.invoiceId !== inv.id) continue;
      o.invoiceId = undefined;
      if (o.status === "invoiced") o.status = "completed";
      o.updatedAt = nowIso();
    }
    addAudit(db, { userId: user.id, action: "status", entity: "invoice", entityId: inv.id, entityLabel: inv.number, summary: `請求書を無効化 (${str(formData, "reason") || "理由未記入"})`, storeId: inv.storeId });
  });
  revalidatePath("/invoices");
  revalidatePath("/invoices/batch");
  redirect(withMsg(back, "請求書を無効化しました。案件から再発行できます (まとめ請求は、締め日のまとめ請求の画面から発行し直せます)。"));
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
