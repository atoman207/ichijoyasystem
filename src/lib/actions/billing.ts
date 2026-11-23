"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { BACKEND, addAudit, mutate, newId, nextNumber, nowIso } from "@/lib/db/store";
import { missingTables, recheckMissingTables } from "@/lib/db/supabase";
import type { AuditChange, Invoice, Order, PurchasePayMethod, StoreId } from "@/lib/db/types";
import { canExportAccounting, canIssueInvoices } from "@/lib/auth/permissions";
import { CHANNEL_LABEL, PURCHASE_PAY_METHOD_LABEL } from "@/lib/constants";
import { isDateKey } from "@/lib/calendar";
import { ACCOUNTING_SCOPE_ID, accountingScope } from "@/lib/accounting";
import { batchAmounts, batchLines, batchTitle, invoiceCoversOrder, isRecognizedSale, normalizeTerms, termsText } from "@/lib/billing";
import { yen } from "@/lib/format";
import { assertStore, choice, fail, requireActionUser, safeReturn, str, withMsg } from "./guards";

/**
 * 締め日のまとめ請求 (法人のお客様)・お客様の請求の締め・会計データに出す支払方法
 * (お客様のご指示 2026-11-23「■4. 売上計上日と法人のまとめ請求」「■5. 売掛・買掛管理」。計算は src/lib/billing.ts・src/lib/ar-ap.ts)
 */

/** 締め日のまとめ請求: 選んだ完了済みの案件を 1 枚の請求書にする (案件ごとに 1 行・税込。消費税は請求書で 1 回だけ計算) */
export async function issueBatchInvoice(formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), "/invoices/batch");
  if (!canIssueInvoices(user)) fail(back, "請求書の発行は店長・本部スタッフ・管理者が行えます。");
  const customerId = str(formData, "customerId");
  const storeId = str(formData, "storeId") as StoreId;
  const periodFrom = str(formData, "periodFrom");
  const periodTo = str(formData, "periodTo");
  const issueDate = str(formData, "issueDate");
  const dueDate = str(formData, "dueDate");
  const orderIds = [...new Set(formData.getAll("orderIds").map(String).filter(Boolean))];
  if (!orderIds.length) fail(back, "請求する案件を選んでください。");
  if (![periodFrom, periodTo, issueDate, dueDate].every(isDateKey) || periodFrom > periodTo) fail(back, "締めの期間・発行日・支払期限を正しく入力してください。");
  if (dueDate < issueDate) fail(back, "支払期限は発行日以降の日付にしてください。");
  const sentVia = choice(formData, "sentVia", CHANNEL_LABEL, "mail");
  let invoiceId = "";
  let number = "";
  let count = 0;
  let total = 0;
  await mutate((db) => {
    const c = db.customers.find((x) => x.id === customerId);
    if (!c) fail(back, "お客様が見つかりません。");
    if (!db.stores.some((s) => s.id === storeId)) fail(back, "店舗が正しくありません。");
    assertStore(user, storeId, back);
    const orders: Order[] = [];
    for (const id of orderIds) {
      const o = db.orders.find((x) => x.id === id);
      if (!o || o.customerId !== c.id) fail(back, "このお客様の案件ではないものが含まれています。画面を開き直してください。");
      if (o.storeId !== storeId) fail(back, `${o.number} はほかの店舗の案件です。まとめ請求は店舗ごとに発行します。`);
      if (o.status !== "completed" || !isRecognizedSale(o)) fail(back, `${o.number} は施工完了・請求前の案件ではありません (状態が変わった可能性があります)。画面を開き直してください。`);
      if (db.invoices.some((i) => i.status !== "void" && invoiceCoversOrder(i, o.id))) fail(back, `${o.number} はすでに請求書を発行しています。`);
      if (o.salesDate! > periodTo) fail(back, `${o.number} の売上計上日 (${o.salesDate}) は締め日 (${periodTo}) より後です。次の締めで請求してください。`);
      if (o.salesDate! > issueDate) fail(back, `請求書の発行日は、案件の売上計上日 (${o.number}: ${o.salesDate}) 以降の日付にしてください。`);
      orders.push(o);
    }
    const lines = batchLines(db, c, orders);
    const amounts = batchAmounts(lines);
    const now = nowIso();
    invoiceId = newId("inv");
    number = nextNumber(db, "INV", db.invoices, issueDate);
    count = lines.length;
    total = amounts.total;
    const notes = str(formData, "notes").slice(0, 500) || undefined;
    const invoice: Invoice = {
      id: invoiceId,
      number,
      orderId: lines[0].orderId,
      orderIds: lines.map((l) => l.orderId),
      periodFrom,
      periodTo,
      orderLines: lines,
      customerId: c.id,
      storeId,
      issueDate,
      dueDate,
      subtotal: amounts.subtotal,
      tax: amounts.tax,
      total: amounts.total,
      paidAmount: 0,
      status: "issued",
      sentVia,
      title: str(formData, "title").slice(0, 100) || batchTitle(periodTo, lines.length),
      taxIncluded: true,
      notes,
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
    };
    db.invoices.push(invoice);
    for (const o of orders) {
      o.invoiceId = invoiceId;
      o.status = "invoiced";
      o.updatedAt = now;
      o.progressNotes.push({ id: newId("pn"), at: now, userId: user.id, kind: "note", body: `締め日 (${periodTo}) のまとめ請求書 ${number} に含めて請求しました (${lines.length} 件 · 合計 ${yen(amounts.total)})` });
    }
    db.commLogs.push({ id: newId("cl"), customerId: c.id, storeId, channel: sentVia, direction: "outbound", subject: `ご請求書 ${number} (${periodTo} 締め)`, body: `${periodFrom}〜${periodTo} に施工完了した ${lines.length} 件をまとめたご請求書 (${yen(amounts.total)}) を${CHANNEL_LABEL[sentVia]}でお送りしました。お支払期限: ${dueDate}`, at: now, userId: user.id, relatedType: "invoice", relatedId: invoiceId });
    addAudit(db, { userId: user.id, action: "create", entity: "invoice", entityId: invoiceId, entityLabel: number, summary: `締め日のまとめ請求書を発行 (${c.name} · ${periodTo} 締め · ${lines.length} 件: ${lines.map((l) => l.number).join("・")} · ${yen(amounts.total)} / ${CHANNEL_LABEL[sentVia]})`, storeId });
  });
  revalidatePath("/invoices");
  revalidatePath("/invoices/batch");
  revalidatePath("/finance");
  redirect(withMsg(`/invoices/${invoiceId}`, `まとめ請求書 ${number} を発行しました (${count} 件 · ${yen(total)})。各案件は「請求済」になりました。`));
}

/** お客様の請求の締め (まとめ請求の有無・締め日・支払期限)。変更は変更履歴に残る */
export async function updateBillingTerms(customerId: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/customers/${customerId}`;
  if (!canIssueInvoices(user)) fail(back, "請求の締めの設定は店長・本部スタッフ・管理者が行います。");
  const batch = formData.get("batch") === "on";
  const next = normalizeTerms({ batch, closingDay: Number(str(formData, "closingDay")), payMonthOffset: Number(str(formData, "payMonthOffset")), payDay: Number(str(formData, "payDay")), note: str(formData, "note") });
  await mutate((db) => {
    const c = db.customers.find((x) => x.id === customerId);
    if (!c) fail("/customers", "顧客が見つかりません。");
    assertStore(user, c.storeId, back);
    const before = c.billingTerms ? normalizeTerms(c.billingTerms) : undefined;
    const keys = ["batch", "closingDay", "payMonthOffset", "payDay", "note"] as const;
    const changes: AuditChange[] = keys
      .filter((k) => (before?.[k] ?? (k === "batch" ? false : undefined)) !== next[k])
      .map((k) => ({ field: `billingTerms.${k}`, before: before?.[k], after: next[k] }));
    if (!changes.length) fail(back, "変更はありませんでした。");
    c.billingTerms = next;
    c.updatedAt = nowIso();
    addAudit(db, { userId: user.id, action: "update", entity: "customer", entityId: c.id, entityLabel: c.name, summary: next.batch ? `請求の締めを設定 (まとめ請求: ${termsText(next)})` : "まとめ請求をやめて案件ごとの請求に戻した", storeId: c.storeId, changes });
  });
  revalidatePath(back);
  revalidatePath("/invoices/batch");
  redirect(withMsg(back, batch ? "請求の締めを保存しました。完了した案件は「締め日のまとめ請求」の画面からまとめて請求します。" : "まとめ請求をやめました。これからは案件ごとに請求書を発行します。"));
}

async function assertSettingsTable(back: string) {
  if (BACKEND === "supabase" && missingTables().includes("settings") && (await recheckMissingTables()).includes("settings")) fail(back, "データベースに設定の表がまだありません。");
}

/** 会計データに出す仕入の支払 (方法) と、ほかの方法で払う仕入の計上を出すか */
export async function updateAccountingScope(formData: FormData) {
  const back = "/accounting?tab=settings";
  const user = await requireActionUser();
  if (!canExportAccounting(user)) fail(back, "会計の設定は本部スタッフ・管理者が変更します。");
  await assertSettingsTable(back);
  const all = Object.keys(PURCHASE_PAY_METHOD_LABEL) as PurchasePayMethod[];
  const paymentMethods = all.filter((m) => formData.getAll("paymentMethods").map(String).includes(m));
  const nonBulkPurchases = str(formData, "nonBulkPurchases") === "exclude" ? "exclude" : "include";
  await mutate((db) => {
    const before = accountingScope(db);
    const value = { paymentMethods, nonBulkPurchases };
    const changes: AuditChange[] = [];
    if (before.paymentMethods.join(",") !== paymentMethods.join(",")) changes.push({ field: "paymentMethods", before: before.paymentMethods.map((m) => PURCHASE_PAY_METHOD_LABEL[m]).join("・") || "(なし)", after: paymentMethods.map((m) => PURCHASE_PAY_METHOD_LABEL[m]).join("・") || "(なし)" });
    if (before.nonBulkPurchases !== nonBulkPurchases) changes.push({ field: "nonBulkPurchases", before: before.nonBulkPurchases === "exclude" ? "出さない" : "出す", after: nonBulkPurchases === "exclude" ? "出さない" : "出す" });
    if (!changes.length) fail(back, "変更はありませんでした。");
    const now = new Date().toISOString();
    const row = db.settings.find((s) => s.id === ACCOUNTING_SCOPE_ID);
    if (row) Object.assign(row, { value, updatedBy: user.id, updatedAt: now });
    else db.settings.push({ id: ACCOUNTING_SCOPE_ID, value, updatedBy: user.id, updatedAt: now });
    addAudit(db, { userId: user.id, action: "update", entity: "settings", entityId: ACCOUNTING_SCOPE_ID, entityLabel: "会計データに出す支払", summary: `会計データに出す仕入の支払を変更 (${paymentMethods.map((m) => PURCHASE_PAY_METHOD_LABEL[m]).join("・") || "なし"} / ほかの方法の仕入の計上: ${nonBulkPurchases === "exclude" ? "出さない" : "出す"})`, changes });
  });
  revalidatePath("/accounting");
  redirect(withMsg(back, "会計データに出す支払の設定を保存しました。次に出力するデータから使われます。"));
}
