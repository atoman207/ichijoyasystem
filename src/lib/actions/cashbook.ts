"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, diffChanges, mutate, newId, nextNumber, nowIso } from "@/lib/db/store";
import type { CashEntry, StoreId } from "@/lib/db/types";
import { toDateKey } from "@/lib/format";
import { CASH_IN_ACCOUNTS, CASH_OUT_ACCOUNTS, EXPENSE_ACCOUNTS } from "@/lib/constants";
import { canEditCashEntry, canViewCashbook } from "@/lib/auth/permissions";
import { fieldLabel } from "@/lib/field-labels";
import { fail, numField, requireActionUser, resolveStoreId, safeReturn, str, withMsg } from "./guards";

/** 科目の選択肢 (入金 / 出金)。出金は経費の勘定科目も使える */
function validAccount(direction: "in" | "out", account: string, opening: boolean): boolean {
  if (opening) return true;
  if (direction === "in") return (CASH_IN_ACCOUNTS as readonly string[]).includes(account);
  return (CASH_OUT_ACCOUNTS as readonly string[]).includes(account) || (EXPENSE_ACCOUNTS as readonly string[]).includes(account);
}

function readEntry(formData: FormData, back: string, opening: boolean) {
  const direction: "in" | "out" = opening ? "in" : str(formData, "direction") === "out" ? "out" : "in";
  const date = str(formData, "date") || toDateKey(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(back, "日付を正しく入力してください。");
  const amount = Math.round(numField(formData, "amount"));
  if (amount <= 0) fail(back, "金額を入力してください。");
  const account = opening ? "前期繰越" : str(formData, direction === "in" ? "accountIn" : "accountOut") || str(formData, "account");
  if (!validAccount(direction, account, opening)) fail(back, "科目を選んでください。");
  return { opening, direction, date, amount, account, counterparty: str(formData, "counterparty").slice(0, 100) || undefined, description: str(formData, "description").slice(0, 200) };
}

export async function createCashEntry(formData: FormData) {
  const user = await requireActionUser();
  const storeId = resolveStoreId(user, str(formData, "storeId"));
  const back = safeReturn(str(formData, "returnTo"), `/cashbook?store=${storeId}`);
  if (!canViewCashbook(user, storeId)) fail(back, "この店舗の現金出納帳に記帳する権限がありません。");
  const f = readEntry(formData, back, str(formData, "kind") === "opening");
  await mutate((db) => {
    if (f.opening && db.cashEntries.some((c) => c.storeId === storeId && c.source === "opening")) fail(back, "この店舗の繰越 (残高の起点) はすでに登録されています。金額を直すときは、その行を修正してください。");
    const now = nowIso();
    const e: CashEntry = {
      id: newId("cash"),
      number: nextNumber(db, "CASH", db.cashEntries, f.date),
      storeId: storeId as StoreId,
      date: f.date,
      direction: f.direction,
      amount: f.amount,
      account: f.account,
      counterparty: f.counterparty,
      description: f.description,
      source: f.opening ? "opening" : "manual",
      recordedBy: user.id,
      createdAt: now,
      updatedAt: now,
    };
    db.cashEntries.push(e);
    addAudit(db, { userId: user.id, action: "create", entity: "cash", entityId: e.id, entityLabel: e.number, summary: `現金出納を記帳 (${f.opening ? "繰越" : f.direction === "in" ? "入金" : "出金"} ¥${f.amount.toLocaleString("ja-JP")} / ${f.account}${f.description ? ` / ${f.description}` : ""})`, storeId: e.storeId });
  });
  revalidatePath("/cashbook");
  redirect(withMsg(back, "記帳しました。"));
}

export async function updateCashEntry(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), "/cashbook");
  await mutate((db) => {
    const e = db.cashEntries.find((x) => x.id === id);
    if (!e) fail(back, "記帳が見つかりません。");
    if (!canEditCashEntry(user, e) || (e.source !== "manual" && e.source !== "opening")) fail(back, "この記帳は修正できません (自動で記帳した行は、元の入金・経費・仕入の記録が正です)。");
    const f = readEntry(formData, back, e.source === "opening");
    const before = { ...e };
    e.date = f.date;
    e.direction = e.source === "opening" ? "in" : f.direction;
    e.amount = f.amount;
    e.account = e.source === "opening" ? "前期繰越" : f.account;
    e.counterparty = f.counterparty;
    e.description = f.description;
    const changes = diffChanges(before, e, ["date", "direction", "amount", "account", "counterparty", "description"]);
    if (!changes.length) fail(back, "変更はありませんでした。");
    e.updatedAt = nowIso();
    addAudit(db, { userId: user.id, action: "update", entity: "cash", entityId: e.id, entityLabel: e.number, summary: `現金出納の記帳を修正 (${changes.map((c) => fieldLabel("cash", c.field)).join("・")})`, storeId: e.storeId, changes });
  });
  revalidatePath("/cashbook");
  redirect(withMsg(back, "記帳を修正しました。"));
}

export async function deleteCashEntry(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), "/cashbook");
  await mutate((db) => {
    const idx = db.cashEntries.findIndex((x) => x.id === id);
    if (idx < 0) fail(back, "記帳が見つかりません。");
    const e = db.cashEntries[idx];
    if (!canEditCashEntry(user, e)) fail(back, "この記帳を削除する権限がありません。");
    db.cashEntries.splice(idx, 1);
    addAudit(db, { userId: user.id, action: "delete", entity: "cash", entityId: e.id, entityLabel: e.number, summary: `現金出納の記帳を削除 (${e.direction === "in" ? "入金" : "出金"} ¥${e.amount.toLocaleString("ja-JP")} / ${e.account} / ${e.date})`, storeId: e.storeId });
  });
  revalidatePath("/cashbook");
  redirect(withMsg(back, "記帳を削除しました。"));
}
