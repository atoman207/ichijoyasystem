"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, diffChanges, mutate, newId, nextNumber, nowIso } from "@/lib/db/store";
import { duplicatePurchase } from "@/lib/mgmt/purchase-lines";
import type { Approval, Database, PurchaseInvoice, PurchaseItem, StoreId, User } from "@/lib/db/types";
import { AUTO_APPROVAL_NOTE, settleOwnApproval } from "@/lib/approval-decide";
import { toDateKey } from "@/lib/format";
import { PURCHASE_ACCOUNTS, PURCHASE_PAY_METHOD_LABEL } from "@/lib/constants";
import { canEditSuppliers, canPay, canRegisterPurchase, canSeeAllStores, canViewPurchase } from "@/lib/auth/permissions";
import { relinkDocumentAttachments } from "@/lib/attachments";
import { dueDateFor, supplierTerms } from "@/lib/suppliers";
import { postCash } from "@/lib/cashbook";
import { fieldLabel } from "@/lib/field-labels";
import { notifyNewApprovals } from "@/lib/notify/approvals";
import { assertStore, choice, fail, numField, requireActionUser, safeReturn, str, withMsg } from "./guards";

const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);

/** 支払依頼 (支払承認の申請)。仕入の支払は金額にかかわらず管理者が承認する。管理者の依頼は承認を省略して、その場で承認済みにする (auto = true) */
function request(db: Database, p: PurchaseInvoice, user: User, comment?: string): { approvalId: string; auto: boolean } {
  const approvalId = newId("ap");
  const supplier = db.suppliers.find((s) => s.id === p.supplierId)?.name ?? "";
  const approval: Approval = {
    id: approvalId,
    type: "purchase",
    targetId: p.id,
    title: `${p.number} ${supplier}`,
    amount: p.amount,
    storeId: p.storeId,
    requestedBy: user.id,
    requiredRole: "admin",
    status: "pending",
    requestComment: [`支払予定日 ${p.scheduledPayDate ?? p.dueDate}`, p.description, comment].filter(Boolean).join(" · "),
    createdAt: nowIso(),
  };
  db.approvals.push(approval);
  p.status = "pending_approval";
  addAudit(db, { userId: user.id, action: "submit", entity: "purchase", entityId: p.id, entityLabel: p.number, summary: `支払依頼を申請 (管理者承認 / ¥${p.amount.toLocaleString("ja-JP")} / 支払予定日 ${p.scheduledPayDate ?? p.dueDate})`, storeId: p.storeId });
  return { approvalId, auto: settleOwnApproval(db, approval, user, `/purchases/${p.id}`) };
}

/** 支払依頼のあとの案内 (管理者の依頼は承認を省略して支払承認済み) */
const requestedText = (auto: boolean) => (auto ? `${AUTO_APPROVAL_NOTE}し、支払を承認済みにしました。` : "管理者へ支払依頼を申請しました。");

/** 仕入内容 (明細)。JSON の配列 [{name, spec, qty, unit, unitPrice}] */
function parseItems(raw: string, back: string): PurchaseItem[] {
  if (!raw.trim()) return [];
  let rows: unknown;
  try {
    rows = JSON.parse(raw);
  } catch {
    fail(back, "仕入内容の形式が正しくありません。");
  }
  if (!Array.isArray(rows)) fail(back, "仕入内容の形式が正しくありません。");
  const items: PurchaseItem[] = [];
  for (const r of (rows as Record<string, unknown>[]).slice(0, 100)) {
    const name = String(r?.name ?? "").trim().slice(0, 100);
    if (!name) continue;
    const qty = Number(r.qty);
    const unitPrice = Number(r.unitPrice);
    if (!Number.isFinite(qty) || qty <= 0) fail(back, `「${name}」の数量が正しくありません。`);
    if (!Number.isFinite(unitPrice)) fail(back, `「${name}」の単価が正しくありません。`);
    items.push({ id: newId("pi"), name, spec: String(r.spec ?? "").trim().slice(0, 100) || undefined, qty, unit: String(r.unit ?? "").trim().slice(0, 10) || "式", unitPrice, amount: Math.round(qty * unitPrice) });
  }
  return items;
}

interface Fields {
  supplierId: string;
  newSupplier?: string;
  storeId: StoreId;
  invoiceDate: string;
  dueDate: string;
  scheduledPayDate?: string;
  amount: number;
  taxAmount: number;
  items?: PurchaseItem[];
  account: string;
  orderId?: string;
  supplierInvoiceNo?: string;
  description: string;
}

/** 登録・修正のフォームを読む (仕入先は db で確かめる) */
function readFields(db: Database, user: User, formData: FormData, back: string, current?: PurchaseInvoice): Fields {
  const selected = str(formData, "supplierId");
  const newName = str(formData, "newSupplierName");
  if (!selected && !newName) fail(back, "仕入先を選ぶか、新しい仕入先の名前を入力してください。");
  if (selected && !db.suppliers.some((s) => s.id === selected)) fail(back, "仕入先が見つかりません。");
  if (!selected && !canEditSuppliers(user) && !db.suppliers.some((s) => s.name === newName)) fail(back, "新しい仕入先の登録は本部が行います。一覧から選ぶか、本部に仕入先の登録を依頼してください。");
  const supplier = selected ? db.suppliers.find((s) => s.id === selected) : db.suppliers.find((s) => s.name === newName);
  // 店舗: 本部・管理者は選べる (既定は本部)。店長は自店舗
  const reqStore = str(formData, "storeId");
  const storeId: StoreId = canSeeAllStores(user) ? (db.stores.some((s) => s.id === reqStore) ? (reqStore as StoreId) : (current?.storeId ?? "hq")) : user.storeId;
  assertStore(user, storeId, back);
  const invoiceDate = str(formData, "invoiceDate") || toDateKey(new Date());
  if (!isDate(invoiceDate)) fail(back, "請求日を正しく入力してください。");
  const dueRaw = str(formData, "dueDate");
  const dueDate = dueRaw || dueDateFor(invoiceDate, supplierTerms(supplier));
  if (!isDate(dueDate)) fail(back, "支払期限を正しく入力してください。");
  if (dueDate < invoiceDate) fail(back, "支払期限は請求日以降の日付にしてください。");
  const payRaw = str(formData, "scheduledPayDate");
  if (payRaw && !isDate(payRaw)) fail(back, "支払予定日を正しく入力してください。");
  const items = parseItems(str(formData, "items"), back);
  const sum = items.reduce((a, i) => a + i.amount, 0);
  const amountRaw = Math.round(numField(formData, "amount"));
  const amount = amountRaw > 0 ? amountRaw : sum;
  if (amount <= 0) fail(back, "金額 (税込) を入力するか、仕入内容を入力してください。");
  const taxRaw = str(formData, "taxAmount");
  const taxAmount = taxRaw === "" ? Math.floor(amount - amount / 1.1) : Math.round(numField(formData, "taxAmount"));
  if (taxAmount < 0 || taxAmount > amount) fail(back, "消費税は 0 円以上、金額以下にしてください。");
  // 案件 (受注番号)
  let orderId: string | undefined;
  const orderRef = str(formData, "orderRef").normalize("NFKC").trim().toUpperCase();
  if (orderRef) {
    const o = db.orders.find((x) => x.number.toUpperCase() === orderRef || x.id === orderRef.toLowerCase());
    if (!o) fail(back, `受注番号「${orderRef}」が見つかりません。`);
    if (!canSeeAllStores(user) && o.storeId !== user.storeId) fail(back, "他店舗の案件は指定できません。");
    orderId = o.id;
  }
  const account = str(formData, "account");
  return {
    supplierId: supplier?.id ?? "",
    newSupplier: supplier ? undefined : newName,
    storeId,
    invoiceDate,
    dueDate,
    scheduledPayDate: payRaw || undefined,
    amount,
    taxAmount,
    items: items.length ? items : undefined,
    account: (PURCHASE_ACCOUNTS as readonly string[]).includes(account) ? account : "仕入高",
    orderId,
    supplierInvoiceNo: str(formData, "supplierInvoiceNo").slice(0, 40) || undefined,
    description: str(formData, "description"),
  };
}

export async function createPurchase(formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "back"), "/purchases/new");
  if (!canRegisterPurchase(user)) fail("/purchases", "仕入請求書の登録は店長・本部・管理者が行います。");
  const intent = str(formData, "intent");
  const id = newId("ap_inv");
  let approvalId = "";
  let auto = false;
  await mutate((db) => {
    const f = readFields(db, user, formData, back);
    const now = nowIso();
    let supplierId = f.supplierId;
    if (!supplierId && f.newSupplier) {
      supplierId = newId("sup");
      db.suppliers.push({ id: supplierId, name: f.newSupplier, kind: "supplier", category: "未分類", paymentTerms: "", closingDay: 31, active: true, createdAt: now, updatedAt: now });
      addAudit(db, { userId: user.id, action: "create", entity: "supplier", entityId: supplierId, entityLabel: f.newSupplier, summary: `仕入先を登録 (${f.newSupplier} / 仕入請求書の登録から)`, storeId: "hq" });
    }
    const documentId = str(formData, "documentId");
    const doc = documentId ? db.documents.find((d) => d.id === documentId) : undefined;
    if (doc && (doc.linkedId || doc.status === "discarded")) fail("/capture?doc=" + doc.id, "この取込書類はすでに登録済み (または破棄済み) です。");
    // 二重登録の防止: 同じ仕入先・同じ請求書番号の仕入 (却下を除く) があれば断る (同じ請求書の再取込で仕入・原価が重複しない)
    const dup = supplierId ? duplicatePurchase(db, supplierId, f.supplierInvoiceNo) : undefined;
    if (dup) fail(back, `同じ仕入先・同じ請求書番号 (${f.supplierInvoiceNo}) の仕入が登録済みです (${dup.number})。二重に登録しないよう確かめてください。`);
    const p: PurchaseInvoice = {
      id,
      number: nextNumber(db, "AP", db.purchases, f.invoiceDate),
      supplierId,
      storeId: f.storeId,
      invoiceDate: f.invoiceDate,
      dueDate: f.dueDate,
      scheduledPayDate: f.scheduledPayDate,
      amount: f.amount,
      taxAmount: f.taxAmount,
      items: f.items,
      account: f.account,
      orderId: f.orderId,
      supplierInvoiceNo: f.supplierInvoiceNo,
      description: f.description,
      status: "received",
      source: doc ? "ocr" : "manual",
      documentId: doc?.id,
      registeredBy: user.id,
      createdAt: now,
      updatedAt: now,
    };
    db.purchases.push(p);
    const supplierName = db.suppliers.find((s) => s.id === supplierId)?.name;
    addAudit(db, { userId: user.id, action: "create", entity: "purchase", entityId: id, entityLabel: p.number, summary: `仕入請求書を登録 (${supplierName} ¥${p.amount.toLocaleString("ja-JP")} / ${p.account}${p.items ? ` / 明細 ${p.items.length} 行` : ""})`, storeId: p.storeId });
    if (doc) {
      doc.status = "confirmed";
      doc.linkedType = "purchase";
      doc.linkedId = id;
      relinkDocumentAttachments(db, doc.id, { type: "purchase", id, storeId: p.storeId });
    }
    if (f.orderId) {
      const o = db.orders.find((x) => x.id === f.orderId);
      if (o) {
        o.progressNotes.push({ id: newId("pn"), at: now, userId: user.id, kind: "production", body: `仕入を登録: ${supplierName} ¥${p.amount.toLocaleString("ja-JP")} (${p.number})${p.description ? ` ${p.description}` : ""}` });
        o.updatedAt = now;
      }
    }
    if (intent === "submit") ({ approvalId, auto } = request(db, p, user));
  });
  await notifyNewApprovals(approvalId ? [approvalId] : [], user.id);
  revalidatePath("/purchases");
  redirect(withMsg(`/purchases/${id}`, intent === "submit" ? `仕入請求書を登録し、${requestedText(auto)}` : "仕入請求書を登録しました。内容を確認して支払依頼を申請してください。"));
}

/** 受領・照会中 (差戻し) の仕入請求書を修正する (修正してそのまま支払依頼もできる) */
export async function updatePurchase(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/purchases/${id}/edit`;
  const intent = str(formData, "intent");
  let approvalId = "";
  let auto = false;
  await mutate((db) => {
    const p = db.purchases.find((x) => x.id === id);
    if (!p) fail("/purchases", "仕入請求書が見つかりません。");
    if (!canViewPurchase(user, p) || !canRegisterPurchase(user)) fail("/purchases", "この仕入請求書を修正する権限がありません。");
    if (p.status !== "received" && p.status !== "disputed") fail(`/purchases/${id}`, "支払依頼の前 (受領) と差戻し (照会中) の請求書のみ修正できます。");
    const f = readFields(db, user, formData, back, p);
    if (!f.supplierId) fail(back, "仕入先は一覧から選んでください。");
    const dup = duplicatePurchase(db, f.supplierId, f.supplierInvoiceNo, p.id);
    if (dup) fail(back, `同じ仕入先・同じ請求書番号 (${f.supplierInvoiceNo}) の仕入が登録済みです (${dup.number})。`);
    const before = { ...p };
    Object.assign(p, {
      supplierId: f.supplierId,
      storeId: f.storeId,
      invoiceDate: f.invoiceDate,
      dueDate: f.dueDate,
      scheduledPayDate: f.scheduledPayDate,
      amount: f.amount,
      taxAmount: f.taxAmount,
      items: f.items,
      account: f.account,
      orderId: f.orderId,
      supplierInvoiceNo: f.supplierInvoiceNo,
      description: f.description,
    });
    const changes = diffChanges(before, p, ["supplierId", "storeId", "invoiceDate", "dueDate", "scheduledPayDate", "amount", "taxAmount", "account", "orderId", "supplierInvoiceNo", "description"]);
    if (JSON.stringify((before.items ?? []).map((i) => [i.name, i.qty, i.unitPrice])) !== JSON.stringify((p.items ?? []).map((i) => [i.name, i.qty, i.unitPrice]))) changes.push({ field: "items", before: `${before.items?.length ?? 0} 行`, after: `${p.items?.length ?? 0} 行` });
    if (changes.length) {
      p.updatedAt = nowIso();
      addAudit(db, { userId: user.id, action: "update", entity: "purchase", entityId: id, entityLabel: p.number, summary: `仕入請求書を修正 (${changes.map((c) => fieldLabel("purchase", c.field)).join("・")})`, storeId: p.storeId, changes });
    } else if (intent !== "submit") fail(back, "変更はありませんでした。");
    if (intent === "submit") ({ approvalId, auto } = request(db, p, user, p.status === "disputed" ? "照会後に再申請" : undefined));
  });
  await notifyNewApprovals(approvalId ? [approvalId] : [], user.id);
  revalidatePath("/purchases");
  redirect(withMsg(`/purchases/${id}`, intent === "submit" ? auto ? `仕入請求書を修正し、${requestedText(auto)}` : "修正して管理者へ支払依頼を申請しました。" : "仕入請求書を修正しました。"));
}

export async function submitPurchase(id: string, formData?: FormData) {
  const user = await requireActionUser();
  const back = `/purchases/${id}`;
  let approvalId = "";
  let auto = false;
  await mutate((db) => {
    const p = db.purchases.find((x) => x.id === id);
    if (!p) fail("/purchases", "仕入請求書が見つかりません。");
    if (!canViewPurchase(user, p) || !canRegisterPurchase(user)) fail("/purchases", "この仕入請求書を申請する権限がありません。");
    if (p.status !== "received" && p.status !== "disputed") fail(back, "受領・照会中の請求書のみ支払依頼できます。");
    ({ approvalId, auto } = request(db, p, user, formData ? str(formData, "comment") : undefined));
    p.updatedAt = nowIso();
  });
  await notifyNewApprovals([approvalId], user.id);
  revalidatePath(back);
  redirect(withMsg(back, requestedText(auto)));
}

/** 支払待ち (承認済み) の支払予定日を変える (資金繰りに合わせて) */
export async function reschedulePurchase(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/purchases/${id}`;
  if (!canPay(user)) fail(back, "支払予定日の変更は本部・管理者が行います。");
  const date = str(formData, "scheduledPayDate");
  if (!isDate(date)) fail(back, "支払予定日を入力してください。");
  await mutate((db) => {
    const p = db.purchases.find((x) => x.id === id);
    if (!p) fail("/purchases", "仕入請求書が見つかりません。");
    if (p.status === "paid" || p.status === "rejected") fail(back, "支払完了・却下の請求書は変更できません。");
    const before = p.scheduledPayDate ?? p.dueDate;
    if (before === date) fail(back, "変更はありませんでした。");
    p.scheduledPayDate = date;
    p.updatedAt = nowIso();
    addAudit(db, { userId: user.id, action: "update", entity: "purchase", entityId: id, entityLabel: p.number, summary: `支払予定日を変更 (${before} → ${date})`, storeId: p.storeId, changes: [{ field: "scheduledPayDate", before, after: date }] });
  });
  revalidatePath(back);
  revalidatePath("/purchases");
  redirect(withMsg(back, "支払予定日を変更しました。"));
}

/** 支払完了 (支払日・方法・振込の記録)。現金で払ったときは店舗の現金出納帳に出金として記帳する */
export async function markPurchasePaid(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/purchases/${id}`;
  if (!canPay(user)) fail(back, "支払の処理は本部・管理者が行います。");
  const paidAt = str(formData, "paidAt") || toDateKey(new Date());
  if (!isDate(paidAt)) fail(back, "支払日を正しく入力してください。");
  const method = choice(formData, "payMethod", PURCHASE_PAY_METHOD_LABEL, "transfer");
  let cash = false;
  await mutate((db) => {
    const p = db.purchases.find((x) => x.id === id);
    if (!p) fail("/purchases", "仕入請求書が見つかりません。");
    if (p.status !== "approved") fail(back, "支払承認済み (支払待ち) の請求書のみ支払完了にできます。");
    p.status = "paid";
    p.paidAt = paidAt;
    p.payMethod = method;
    p.payReference = str(formData, "payReference").slice(0, 100) || undefined;
    p.paidBy = user.id;
    p.updatedAt = nowIso();
    const supplier = db.suppliers.find((s) => s.id === p.supplierId)?.name;
    if (method === "cash") {
      cash = Boolean(postCash(db, { storeId: p.storeId, date: paidAt, direction: "out", amount: p.amount, account: "仕入 (現金払い)", counterparty: supplier, description: `${p.number} の支払${p.description ? ` (${p.description})` : ""}`, source: "purchase", sourceId: p.id, userId: user.id }));
    }
    addAudit(db, { userId: user.id, action: "status", entity: "purchase", entityId: id, entityLabel: p.number, summary: `支払完了 (¥${p.amount.toLocaleString("ja-JP")} / ${paidAt} / ${PURCHASE_PAY_METHOD_LABEL[method]}${p.payReference ? ` / ${p.payReference}` : ""})`, storeId: p.storeId });
  });
  revalidatePath("/purchases");
  revalidatePath("/finance");
  revalidatePath("/cashbook");
  redirect(withMsg(back, cash ? "支払完了にしました。現金出納帳に出金として記帳しました。" : "支払完了にしました。買掛金の残高に反映されます。"));
}

/** 受領・照会中・支払却下の請求書の削除 (登録した本人・本部・管理者) */
export async function deletePurchase(id: string) {
  const user = await requireActionUser();
  await mutate((db) => {
    const idx = db.purchases.findIndex((x) => x.id === id);
    if (idx < 0) fail("/purchases", "仕入請求書が見つかりません。");
    const p = db.purchases[idx];
    if (!canViewPurchase(user, p) || (p.registeredBy !== user.id && !canPay(user))) fail(`/purchases/${id}`, "登録した本人・本部・管理者のみ削除できます。");
    if (!["received", "disputed", "rejected"].includes(p.status)) fail(`/purchases/${id}`, "支払依頼中・支払待ち・支払完了の請求書は削除できません。");
    db.purchases.splice(idx, 1);
    const doc = p.documentId ? db.documents.find((d) => d.id === p.documentId && d.linkedType === "purchase" && d.linkedId === id) : undefined;
    if (doc) {
      doc.status = "extracted";
      doc.linkedType = undefined;
      doc.linkedId = undefined;
      for (const a of db.attachments) {
        if (a.parentType === "purchase" && a.parentId === id && a.fileName === doc.fileName.slice(0, 200)) {
          a.parentType = "document";
          a.parentId = doc.id;
          a.storeId = doc.storeId;
        }
      }
    }
    addAudit(db, { userId: user.id, action: "delete", entity: "purchase", entityId: id, entityLabel: p.number, summary: `仕入請求書を削除 (¥${p.amount.toLocaleString("ja-JP")})`, storeId: p.storeId });
  });
  revalidatePath("/purchases");
  redirect(withMsg("/purchases", "仕入請求書を削除しました。"));
}
