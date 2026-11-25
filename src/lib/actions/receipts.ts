"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, getDb, mutate, nowIso } from "@/lib/db/store";
import type { Receipt } from "@/lib/db/types";
import { canAccessStore, canEditCaseStore, canVoidReceipt } from "@/lib/auth/permissions";
import { isDateKey } from "@/lib/calendar";
import { toDateKey } from "@/lib/format";
import { RECEIPT_TO_PAYMENT, activeReceipts, cleanParts, partLabel } from "@/lib/receipts";
import { makeReceipt } from "@/lib/receipt-issue";
import { applyPayment } from "@/lib/payments";
import { BACKEND } from "@/lib/db/store";
import { missingTables, recheckMissingTables } from "@/lib/db/supabase";
import { fail, requireActionUser, safeReturn, str, withMsg } from "./guards";

/**
 * 領収書の発行・取り消し・入金の記録 (お客様のご要望 2026-11-25「⑦」「⑧」。計算と確かめは src/lib/receipts.ts)
 * 発行は請求書を見られる社員 (canIssueReceipt。現場で集金した社員が発行する)、取り消しは請求書の店舗の社員と発行した本人 (canVoidReceipt)、
 * 入金の記録は請求書の店舗の社員 (請求書の画面の「入金を登録」と同じ)
 */

const yen = (n: number) => `¥${n.toLocaleString("ja-JP")}`;

async function assertTable(back: string) {
  if (BACKEND !== "supabase" || !missingTables().includes("receipts")) return;
  if ((await recheckMissingTables()).includes("receipts")) fail(back, "領収書の台帳のテーブル (receipts) がまだデータベースにありません。開発担当がデプロイ (npm run deploy) すると発行できるようになります。");
}

/** 領収書の発行 (請求書の画面・受注の画面・予定表の小さな画面)。発行のあとは同じ画面に戻り、「印刷」を押す */
export async function issueReceipt(formData: FormData) {
  const user = await requireActionUser();
  const invoiceId = str(formData, "invoiceId");
  const back = safeReturn(str(formData, "returnTo"), `/invoices/${invoiceId}`);
  await assertTable(back);
  let parts: Receipt["parts"] = [];
  try {
    parts = cleanParts(JSON.parse(str(formData, "parts") || "[]"));
  } catch {
    fail(back, "支払方法の内訳を読めませんでした。もう一度入力してください。");
  }
  const amount = Math.round(Number(str(formData, "amount").normalize("NFKC").replace(/[,，円¥\s]/g, "")));
  const issueDate = str(formData, "issueDate") || toDateKey(new Date());
  if (!isDateKey(issueDate)) fail(back, "領収日を正しく入力してください。");
  const honorific = str(formData, "honorific");
  let number = "";
  await mutate((db) => {
    const res = makeReceipt(db, user, { invoiceId, amount, parts, issueDate, addressee: str(formData, "addressee"), honorific: honorific === "様" || honorific === "御中" ? honorific : undefined, purpose: str(formData, "purpose"), note: str(formData, "note") });
    if (res.error) fail(back, res.error);
    number = res.receipt!.number;
  });
  revalidatePath(`/invoices/${invoiceId}`);
  redirect(withMsg(back, `領収書 ${number} を発行しました。「印刷」を押して PDF を出してください。`));
}

/** 領収書の取り消し (書き損じ・金額や内訳の誤り。理由は必須。取り消した領収書は残り、印刷できなくなる) */
export async function voidReceipt(id: string, formData: FormData) {
  const user = await requireActionUser();
  const reason = str(formData, "reason").slice(0, 200);
  const db0 = getDb();
  const r0 = (db0.receipts ?? []).find((x) => x.id === id);
  const back = safeReturn(str(formData, "returnTo"), r0 ? `/invoices/${r0.invoiceId}` : "/invoices");
  if (!r0) fail(back, "領収書が見つかりません。");
  if (!canVoidReceipt(user, r0)) fail(back, "この領収書を取り消せるのは、請求書の店舗の社員・本部・管理者と発行した本人です。");
  if (!reason) fail(back, "取り消しの理由を入力してください (例: 内訳の誤り・宛名の書き直し)。");
  await mutate((db) => {
    const r = db.receipts.find((x) => x.id === id);
    if (!r) fail(back, "領収書が見つかりません。");
    if (r.status === "void") fail(back, "この領収書はすでに取り消してあります。");
    const now = nowIso();
    r.status = "void";
    r.voidReason = reason;
    r.voidedAt = now;
    r.voidedBy = user.id;
    r.updatedAt = now;
    addAudit(db, { userId: user.id, action: "update", entity: "receipt", entityId: r.id, entityLabel: r.number, summary: `領収書を取り消し (${yen(r.amount)} · 理由: ${reason})`, storeId: r.storeId, changes: [{ field: "状態", before: "発行済み", after: "取り消し" }] });
  });
  revalidatePath(`/invoices/${r0.invoiceId}`);
  redirect(withMsg(back, `領収書 ${r0.number} を取り消しました。お客様にお渡しした領収書は回収してください。`));
}

/** 領収書の内訳で入金を記録する (領収書を発行したが入金が未記録のとき。支払方法ごとに 1 件。請求書の店舗の社員) */
export async function recordReceiptPayments(id: string, formData: FormData) {
  const user = await requireActionUser();
  const db0 = getDb();
  const r0 = (db0.receipts ?? []).find((x) => x.id === id);
  const back = safeReturn(str(formData, "returnTo"), r0 ? `/invoices/${r0.invoiceId}` : "/invoices");
  if (!r0 || r0.status !== "issued") fail(back, "有効な領収書が見つかりません。");
  if (!canAccessStore(user, r0.storeId)) fail(back, "入金の記録は請求書の店舗の社員・本部・管理者が行えます。");
  const date = str(formData, "date") || r0.issueDate;
  if (!isDateKey(date)) fail(back, "入金日を正しく入力してください。");
  let total = 0;
  await mutate((db) => {
    const r = db.receipts.find((x) => x.id === id)!;
    const inv = db.invoices.find((x) => x.id === r.invoiceId);
    if (!inv) fail(back, "請求書が見つかりません。");
    const receipted = activeReceipts(db, inv.id).reduce((a, x) => a + x.amount, 0);
    let left = Math.min(r.amount, Math.max(0, receipted - inv.paidAmount), inv.total - inv.paidAmount);
    if (left <= 0) fail(back, "この領収書の分の入金はすでに記録されています。");
    for (const p of r.parts) {
      const amount = Math.min(p.amount, left);
      if (amount <= 0) continue;
      const err = applyPayment(db, user.id, inv, { date, amount, method: RECEIPT_TO_PAYMENT[p.method], memo: `領収書 ${r.number} (${partLabel(p)})` });
      if (err) fail(back, err);
      left -= amount;
      total += amount;
    }
  });
  revalidatePath(`/invoices/${r0.invoiceId}`);
  revalidatePath("/cashbook");
  redirect(withMsg(back, `領収書 ${r0.number} の内訳で入金 ${yen(total)} を記録しました (現金は現金出納帳にも記帳しました)。`));
}

/** 領収書を発行する・しない (案件ごと。空 = 入金の予定方法から自動)。お客様のご要望 2026-11-25「⑦」 */
export async function setReceiptWanted(orderId: string, formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), `/orders/${orderId}`);
  const v = str(formData, "wanted");
  const next = v === "1" ? true : v === "0" ? false : undefined;
  await mutate((db) => {
    const o = db.orders.find((x) => x.id === orderId);
    if (!o) fail(back, "受注が見つかりません。");
    if (!canEditCaseStore(user, o.storeId) && !canAccessStore(user, o.storeId)) fail(back, "この案件の領収書の設定は変えられません。");
    const label = (x: boolean | undefined) => (x === undefined ? "自動 (入金の予定方法から)" : x ? "発行する" : "発行しない");
    if (o.receiptWanted === next) return;
    const before = o.receiptWanted;
    o.receiptWanted = next;
    o.updatedAt = nowIso();
    addAudit(db, { userId: user.id, action: "update", entity: "order", entityId: o.id, entityLabel: o.number, summary: `領収書を${label(next)}に設定`, storeId: o.storeId, changes: [{ field: "receiptWanted", before: label(before), after: label(next) }] });
  });
  revalidatePath(back.split("?")[0]);
  redirect(withMsg(back, next === undefined ? "領収書の発行を自動 (入金の予定方法から) にしました。" : `この案件の領収書を「${next ? "発行する" : "発行しない"}」にしました。`));
}
