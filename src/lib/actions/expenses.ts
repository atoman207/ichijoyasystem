"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, mutate, newId, nextNumber, nowIso } from "@/lib/db/store";
import type { Database, Expense, ExpensePaymentMethod, User } from "@/lib/db/types";
import { toDateKey } from "@/lib/format";
import { APPROVAL_RULES, EXPENSE_METHOD_LABEL } from "@/lib/constants";
import { approverLabel, approverRole, canManageFinance, canViewExpense } from "@/lib/auth/permissions";
import { assertStore, choice, fail, numField, requireActionUser, resolveStoreId, str, withMsg } from "./guards";

function request(db: Database, e: Expense, user: User) {
  // 金額が基準以上、本部の経費、承認できる店長がいない店舗は管理者
  const over = e.amount >= APPROVAL_RULES.expenseAdminThreshold;
  const role = approverRole(db.users, e.storeId, over, user.id);
  db.approvals.push({ id: newId("ap"), type: "expense", targetId: e.id, title: `${e.number} ${e.vendor} (${e.account})`, amount: e.amount, storeId: e.storeId, requestedBy: user.id, requiredRole: role, status: "pending", requestComment: e.description || undefined, createdAt: nowIso() });
  e.status = "pending_approval";
  addAudit(db, { userId: user.id, action: "submit", entity: "expense", entityId: e.id, entityLabel: e.number, summary: `経費精算を申請 (${approverLabel(role, over, "¥5万")})`, storeId: e.storeId });
  return role;
}

export async function createExpense(formData: FormData) {
  const user = await requireActionUser();
  const back = "/expenses/new";
  const amount = numField(formData, "amount");
  const vendor = str(formData, "vendor");
  if (!vendor) fail(back, "支払先を入力してください。");
  if (amount <= 0) fail(back, "金額を入力してください。");
  const storeId = resolveStoreId(user, str(formData, "storeId"));
  assertStore(user, storeId, back);
  const intent = str(formData, "intent");
  const id = newId("exp");
  let role = "";
  await mutate((db) => {
    const now = nowIso();
    const date = str(formData, "date") || toDateKey(new Date());
    const e: Expense = {
      id,
      number: nextNumber(db, "EXP", db.expenses, date),
      storeId,
      submittedBy: user.id,
      date,
      vendor,
      amount,
      taxAmount: numField(formData, "taxAmount") || Math.floor(amount - amount / 1.1),
      account: str(formData, "account") || "雑費",
      paymentMethod: choice(formData, "paymentMethod", EXPENSE_METHOD_LABEL, "cash"),
      description: str(formData, "description"),
      status: "draft",
      source: choice(formData, "source", ["manual", "ocr"] as const, "manual"),
      documentId: str(formData, "documentId") || undefined,
      createdAt: now,
      updatedAt: now,
    };
    db.expenses.push(e);
    addAudit(db, { userId: user.id, action: "create", entity: "expense", entityId: id, entityLabel: e.number, summary: `経費を登録 (${vendor} ¥${amount.toLocaleString("ja-JP")} / ${e.account})`, storeId });
    const doc = db.documents.find((d) => d.id === e.documentId);
    if (doc) {
      doc.status = "confirmed";
      doc.linkedType = "expense";
      doc.linkedId = id;
    }
    if (intent === "submit") role = request(db, e, user);
  });
  revalidatePath("/expenses");
  redirect(withMsg(`/expenses/${id}`, intent === "submit" ? `経費を登録し、${role === "admin" ? "管理者" : "店長"}へ承認を申請しました。` : "経費を下書き保存しました。"));
}

export async function submitExpense(id: string) {
  const user = await requireActionUser();
  const back = `/expenses/${id}`;
  let role = "";
  await mutate((db) => {
    const e = db.expenses.find((x) => x.id === id);
    if (!e) fail("/expenses", "経費が見つかりません。");
    assertStore(user, e.storeId, back);
    if (!canViewExpense(user, e)) fail(back, "自分の経費のみ申請できます。");
    if (e.status !== "draft" && e.status !== "rejected") fail(back, "下書きまたは差戻しの経費のみ申請できます。");
    role = request(db, e, user);
    e.updatedAt = nowIso();
  });
  revalidatePath(back);
  redirect(withMsg(back, `${role === "admin" ? "管理者" : "店長"}へ承認を申請しました。`));
}

export async function markExpensePaid(id: string) {
  const user = await requireActionUser();
  const back = `/expenses/${id}`;
  if (!canManageFinance(user)) fail(back, "精算処理は本部・管理者が行います。");
  await mutate((db) => {
    const e = db.expenses.find((x) => x.id === id);
    if (!e) fail("/expenses", "経費が見つかりません。");
    if (e.status !== "approved") fail(back, "承認済みの経費のみ精算できます。");
    e.status = "paid";
    e.updatedAt = nowIso();
    addAudit(db, { userId: user.id, action: "status", entity: "expense", entityId: id, entityLabel: e.number, summary: `経費を精算済みに変更 (¥${e.amount.toLocaleString("ja-JP")})`, storeId: e.storeId });
  });
  revalidatePath("/expenses");
  redirect(withMsg(back, "精算済みにしました。現金出納帳・経費集計に反映されます。"));
}

export async function deleteExpense(id: string) {
  const user = await requireActionUser();
  await mutate((db) => {
    const idx = db.expenses.findIndex((x) => x.id === id);
    if (idx < 0) fail("/expenses", "経費が見つかりません。");
    const e = db.expenses[idx];
    assertStore(user, e.storeId, `/expenses/${id}`);
    if (!canViewExpense(user, e)) fail(`/expenses/${id}`, "自分の経費のみ削除できます。");
    if (e.status !== "draft" && e.status !== "rejected") fail(`/expenses/${id}`, "下書き・差戻しの経費のみ削除できます。");
    db.expenses.splice(idx, 1);
    addAudit(db, { userId: user.id, action: "delete", entity: "expense", entityId: id, entityLabel: e.number, summary: "経費を削除", storeId: e.storeId });
  });
  revalidatePath("/expenses");
  redirect(withMsg("/expenses", "経費を削除しました。"));
}
