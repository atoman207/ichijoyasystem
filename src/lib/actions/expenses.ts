"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, diffChanges, mutate, newId, nextNumber, nowIso } from "@/lib/db/store";
import type { Approval, Database, Expense, User } from "@/lib/db/types";
import { AUTO_APPROVAL_NOTE, settleOwnApproval } from "@/lib/approval-decide";
import { toDateKey } from "@/lib/format";
import { EXPENSE_ACCOUNTS, EXPENSE_METHOD_LABEL } from "@/lib/constants";
import { approverLabel, approverRole, canPay, canViewExpense } from "@/lib/auth/permissions";
import { relinkDocumentAttachments } from "@/lib/attachments";
import { approvalSettings, manYen } from "@/lib/approval-rules";
import { postCash } from "@/lib/cashbook";
import { fieldLabel } from "@/lib/field-labels";
import { isExpenseAccount, mergeCandidates, suggestAccounts, type AccountCandidate } from "@/lib/expense-account";
import { aiEnabled, generateJson } from "@/lib/ai/provider";
import { notifyNewApprovals } from "@/lib/notify/approvals";
import { assertStore, choice, fail, numField, requireActionUser, resolveStoreId, str, withMsg } from "./guards";

/** 経費の承認の申請。管理者の申請は承認を省略して、その場で承認済みにする (auto = true) */
function request(db: Database, e: Expense, user: User): { role: "store_manager" | "admin"; approvalId: string; auto: boolean } {
  // 金額が基準以上、本部の経費、承認できる店長がいない店舗は管理者
  const threshold = approvalSettings(db).expenseAdminThreshold;
  const over = e.amount >= threshold;
  const role = approverRole(db.users, e.storeId, over, user.id);
  const approvalId = newId("ap");
  const approval: Approval = { id: approvalId, type: "expense", targetId: e.id, title: `${e.number} ${e.vendor} (${e.account})`, amount: e.amount, storeId: e.storeId, requestedBy: user.id, requiredRole: role, status: "pending", requestComment: e.description || undefined, createdAt: nowIso() };
  db.approvals.push(approval);
  e.status = "pending_approval";
  addAudit(db, { userId: user.id, action: "submit", entity: "expense", entityId: e.id, entityLabel: e.number, summary: `経費精算を申請 (${approverLabel(role, over, manYen(threshold))})`, storeId: e.storeId });
  return { role, approvalId, auto: settleOwnApproval(db, approval, user, `/expenses/${e.id}`) };
}

/** 申請のあとの案内 (管理者の申請は承認を省略して承認済み) */
const submittedText = (role: string, auto: boolean) => (auto ? `${AUTO_APPROVAL_NOTE}し、承認済みにしました。` : `${role === "admin" ? "管理者" : "店長"}へ承認を申請しました。`);

/** フォームの経費の項目 (登録・修正で共通) */
function readFields(formData: FormData, back: string) {
  const amount = Math.round(numField(formData, "amount"));
  const vendor = str(formData, "vendor");
  if (!vendor) fail(back, "支払先を入力してください。");
  if (amount <= 0) fail(back, "金額を入力してください。");
  const date = str(formData, "date") || toDateKey(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(back, "日付を正しく入力してください。");
  const account = str(formData, "account");
  const taxRaw = str(formData, "taxAmount");
  const taxAmount = taxRaw === "" ? Math.floor(amount - amount / 1.1) : Math.round(numField(formData, "taxAmount"));
  if (taxAmount < 0 || taxAmount > amount) fail(back, "消費税は 0 円以上、金額以下にしてください。");
  return {
    vendor,
    amount,
    date,
    taxAmount,
    account: isExpenseAccount(account) ? account : "雑費",
    paymentMethod: choice(formData, "paymentMethod", EXPENSE_METHOD_LABEL, "cash"),
    description: str(formData, "description"),
  };
}

export async function createExpense(formData: FormData) {
  const user = await requireActionUser();
  const back = "/expenses/new";
  const f = readFields(formData, back);
  const storeId = resolveStoreId(user, str(formData, "storeId"));
  assertStore(user, storeId, back);
  const intent = str(formData, "intent");
  const id = newId("exp");
  let role = "";
  let auto = false;
  let approvalId = "";
  await mutate((db) => {
    const now = nowIso();
    const documentId = str(formData, "documentId");
    const doc = documentId ? db.documents.find((d) => d.id === documentId) : undefined;
    if (doc && (doc.linkedId || doc.status === "discarded")) fail("/capture?doc=" + doc.id, "この取込書類はすでに登録済み (または破棄済み) です。");
    const e: Expense = {
      id,
      number: nextNumber(db, "EXP", db.expenses, f.date),
      storeId,
      submittedBy: user.id,
      ...f,
      status: "draft",
      source: doc ? "ocr" : "manual",
      documentId: doc?.id,
      createdAt: now,
      updatedAt: now,
    };
    db.expenses.push(e);
    addAudit(db, { userId: user.id, action: "create", entity: "expense", entityId: id, entityLabel: e.number, summary: `経費を登録 (${f.vendor} ¥${f.amount.toLocaleString("ja-JP")} / ${e.account})`, storeId });
    if (doc) {
      doc.status = "confirmed";
      doc.linkedType = "expense";
      doc.linkedId = id;
      relinkDocumentAttachments(db, doc.id, { type: "expense", id, storeId });
    }
    if (intent === "submit") ({ role, approvalId, auto } = request(db, e, user));
  });
  await notifyNewApprovals(approvalId ? [approvalId] : [], user.id);
  revalidatePath("/expenses");
  redirect(withMsg(`/expenses/${id}`, intent === "submit" ? `経費を登録し、${submittedText(role, auto)}` : "経費を下書き保存しました。"));
}

/** 下書き・差戻しの経費の修正 (修正後にそのまま再申請もできる) */
export async function updateExpense(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/expenses/${id}/edit`;
  const f = readFields(formData, back);
  const intent = str(formData, "intent");
  let role = "";
  let auto = false;
  let approvalId = "";
  await mutate((db) => {
    const e = db.expenses.find((x) => x.id === id);
    if (!e) fail("/expenses", "経費が見つかりません。");
    assertStore(user, e.storeId, back);
    if (!canViewExpense(user, e)) fail(`/expenses/${id}`, "自分の経費のみ修正できます。");
    if (e.status !== "draft" && e.status !== "rejected") fail(`/expenses/${id}`, "下書き・差戻しの経費のみ修正できます。");
    const before = { ...e };
    Object.assign(e, f);
    const changes = diffChanges(before, e, ["vendor", "date", "amount", "taxAmount", "account", "paymentMethod", "description"]);
    if (changes.length) {
      e.updatedAt = nowIso();
      addAudit(db, { userId: user.id, action: "update", entity: "expense", entityId: id, entityLabel: e.number, summary: `経費を修正 (${changes.map((c) => fieldLabel("expense", c.field)).join("・")})`, storeId: e.storeId, changes });
    } else if (intent !== "submit") fail(back, "変更はありませんでした。");
    if (intent === "submit") ({ role, approvalId, auto } = request(db, e, user));
  });
  await notifyNewApprovals(approvalId ? [approvalId] : [], user.id);
  revalidatePath("/expenses");
  redirect(withMsg(`/expenses/${id}`, intent === "submit" ? auto ? `経費を修正し、${submittedText(role, auto)}` : `修正して${role === "admin" ? "管理者" : "店長"}へ再申請しました。` : "経費を修正しました。"));
}

export async function submitExpense(id: string) {
  const user = await requireActionUser();
  const back = `/expenses/${id}`;
  let role = "";
  let auto = false;
  let approvalId = "";
  await mutate((db) => {
    const e = db.expenses.find((x) => x.id === id);
    if (!e) fail("/expenses", "経費が見つかりません。");
    assertStore(user, e.storeId, back);
    if (!canViewExpense(user, e)) fail(back, "自分の経費のみ申請できます。");
    if (e.status !== "draft" && e.status !== "rejected") fail(back, "下書きまたは差戻しの経費のみ申請できます。");
    ({ role, approvalId, auto } = request(db, e, user));
    e.updatedAt = nowIso();
  });
  await notifyNewApprovals([approvalId], user.id);
  revalidatePath(back);
  redirect(withMsg(back, submittedText(role, auto)));
}

/** 精算 (立て替えた人へ支払う)。現金の経費は店舗の現金出納帳に出金として記帳する */
export async function markExpensePaid(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/expenses/${id}`;
  if (!canPay(user)) fail(back, "精算処理は本部・管理者が行います。");
  const paidAt = str(formData, "paidAt") || toDateKey(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidAt)) fail(back, "精算日を正しく入力してください。");
  let cash = false;
  await mutate((db) => {
    const e = db.expenses.find((x) => x.id === id);
    if (!e) fail("/expenses", "経費が見つかりません。");
    if (e.status !== "approved") fail(back, "承認済みの経費のみ精算できます。");
    e.status = "paid";
    e.paidAt = paidAt;
    e.paidBy = user.id;
    e.updatedAt = nowIso();
    if (e.paymentMethod === "cash") {
      cash = Boolean(postCash(db, { storeId: e.storeId, date: paidAt, direction: "out", amount: e.amount, account: e.account, counterparty: db.users.find((u) => u.id === e.submittedBy)?.name, description: `${e.number} ${e.vendor} の精算${e.description ? ` (${e.description})` : ""}`, source: "expense", sourceId: e.id, userId: user.id }));
    }
    addAudit(db, { userId: user.id, action: "status", entity: "expense", entityId: id, entityLabel: e.number, summary: `経費を精算済みに変更 (¥${e.amount.toLocaleString("ja-JP")} / 精算日 ${paidAt})`, storeId: e.storeId });
  });
  revalidatePath("/expenses");
  revalidatePath("/cashbook");
  redirect(withMsg(back, cash ? "精算済みにしました。現金出納帳に出金として記帳しました。" : "精算済みにしました。"));
}

export async function deleteExpense(id: string) {
  const user = await requireActionUser();
  await mutate((db) => {
    const idx = db.expenses.findIndex((x) => x.id === id);
    if (idx < 0) fail("/expenses", "経費が見つかりません。");
    const e = db.expenses[idx];
    assertStore(user, e.storeId, `/expenses/${id}`);
    if (!canViewExpense(user, e)) fail(`/expenses/${id}`, "自分の経費のみ削除できます。");
    if (!["draft", "rejected", "denied"].includes(e.status)) fail(`/expenses/${id}`, "下書き・差戻し・却下の経費のみ削除できます。");
    db.expenses.splice(idx, 1);
    // 取込書類から作った経費なら、書類を確認待ちに戻す (元の画像も書類に戻す)
    const doc = e.documentId ? db.documents.find((d) => d.id === e.documentId && d.linkedType === "expense" && d.linkedId === id) : undefined;
    if (doc) {
      doc.status = "extracted";
      doc.linkedType = undefined;
      doc.linkedId = undefined;
      for (const a of db.attachments) {
        if (a.parentType === "expense" && a.parentId === id && a.fileName === doc.fileName.slice(0, 200)) {
          a.parentType = "document";
          a.parentId = doc.id;
          a.storeId = doc.storeId;
        }
      }
    }
    addAudit(db, { userId: user.id, action: "delete", entity: "expense", entityId: id, entityLabel: e.number, summary: `経費を削除 (${e.vendor} ¥${e.amount.toLocaleString("ja-JP")})`, storeId: e.storeId });
  });
  revalidatePath("/expenses");
  redirect(withMsg("/expenses", "経費を削除しました。"));
}

/**
 * 勘定科目の候補 (経費の登録・修正の画面から呼ぶ)。
 * ルールの候補はいつでも、AI の候補は API キーがあり ai = true のときだけ (理由つき・最大 3 件)
 */
export async function suggestExpenseAccounts(input: { vendor?: string; description?: string; amount?: number; ai?: boolean }): Promise<{ candidates: AccountCandidate[]; ai: "used" | "off" | "error"; message?: string }> {
  await requireActionUser();
  const vendor = String(input.vendor ?? "").slice(0, 200);
  const description = String(input.description ?? "").slice(0, 500);
  const amount = Number.isFinite(Number(input.amount)) ? Number(input.amount) : 0;
  const rule = suggestAccounts({ vendor, description, amount });
  if (!input.ai || !aiEnabled() || !(vendor || description)) return { candidates: rule, ai: "off" };
  try {
    const r = await generateJson<{ candidates: { account: string; reason: string }[] }>({
      system: [
        "あなたは畳・襖・障子・網戸の専門店 (株式会社一畳屋) の経理担当です。経費の支払先・内容・金額から、勘定科目の候補を選んでください。",
        "- 候補は指定の一覧から選び、可能性の高い順に最大 3 つ。理由は 30 文字以内の日本語で書いてください。",
        "- 備品・道具は 10 万円未満なら消耗品費、10 万円以上なら工具器具備品にしてください。",
        "- 施工に使う畳表・襖紙・障子紙などの材料は材料費です。",
      ].join("\n"),
      parts: [{ type: "text", text: `支払先: ${vendor || "(なし)"}\n内容: ${description || "(なし)"}\n金額 (税込): ${amount ? `${amount} 円` : "(なし)"}` }],
      schema: {
        type: "object",
        properties: {
          candidates: {
            type: "array",
            items: { type: "object", properties: { account: { type: "string", enum: [...EXPENSE_ACCOUNTS] }, reason: { type: "string" } }, required: ["account", "reason"], additionalProperties: false },
          },
        },
        required: ["candidates"],
        additionalProperties: false,
      },
      schemaName: "ichijoya_expense_account",
      maxTokens: 1500,
      effort: "low",
    });
    const ai: AccountCandidate[] = (r.data.candidates ?? []).filter((c) => isExpenseAccount(c.account)).map((c) => ({ account: c.account as AccountCandidate["account"], reason: String(c.reason ?? "").slice(0, 60), source: "ai" }));
    return { candidates: mergeCandidates(ai, rule), ai: "used" };
  } catch (err) {
    console.warn("[expenses] account suggestion failed:", err instanceof Error ? err.message : err);
    return { candidates: rule, ai: "error", message: "AI の候補を取得できませんでした。ルールの候補を表示しています。" };
  }
}
