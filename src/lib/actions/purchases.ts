"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, mutate, newId, nextNumber, nowIso } from "@/lib/db/store";
import type { Database, PurchaseInvoice, User } from "@/lib/db/types";
import { addDays, toDateKey } from "@/lib/format";
import { canManageFinance } from "@/lib/auth/permissions";
import { choice, fail, numField, requireActionUser, str, withMsg } from "./guards";

function request(db: Database, p: PurchaseInvoice, user: User) {
  db.approvals.push({ id: newId("ap"), type: "purchase", targetId: p.id, title: `${p.number} ${db.suppliers.find((s) => s.id === p.supplierId)?.name ?? ""}`, amount: p.amount, storeId: "hq", requestedBy: user.id, requiredRole: "admin", status: "pending", requestComment: `支払期限 ${p.dueDate} · ${p.description}`, createdAt: nowIso() });
  p.status = "pending_approval";
  addAudit(db, { userId: user.id, action: "submit", entity: "purchase", entityId: p.id, entityLabel: p.number, summary: "仕入請求書の支払承認を申請 (管理者承認)", storeId: p.storeId });
}

export async function createPurchase(formData: FormData) {
  const user = await requireActionUser();
  const back = "/purchases";
  if (!canManageFinance(user)) fail(back, "仕入請求書の登録は本部・管理者が行います。");
  const amount = numField(formData, "amount");
  const selectedSupplier = str(formData, "supplierId");
  const newSupplierName = str(formData, "newSupplierName");
  if ((!selectedSupplier && !newSupplierName) || amount <= 0) fail(back, "仕入先と金額を入力してください。");
  const intent = str(formData, "intent");
  const id = newId("ap_inv");
  await mutate((db) => {
    const now = nowIso();
    // 一覧から選んだ仕入先は実在するものだけ。一覧にない仕入先は名前で登録する (同じ名前があればそれを使う)
    let supplierId = selectedSupplier;
    if (supplierId) {
      if (!db.suppliers.some((s) => s.id === supplierId)) fail(back, "仕入先が見つかりません。");
    } else {
      const existing = db.suppliers.find((s) => s.name === newSupplierName);
      if (existing) supplierId = existing.id;
      else {
        supplierId = newId("sup");
        db.suppliers.push({ id: supplierId, name: newSupplierName, category: "未分類", paymentTerms: "未設定", closingDay: 31 });
        addAudit(db, { userId: user.id, action: "create", entity: "supplier", entityId: supplierId, entityLabel: newSupplierName, summary: `仕入先を登録 (${newSupplierName})`, storeId: "hq" });
      }
    }
    const invoiceDate = str(formData, "invoiceDate") || toDateKey(new Date());
    const p: PurchaseInvoice = {
      id,
      number: nextNumber(db, "AP", db.purchases, invoiceDate),
      supplierId,
      storeId: "hq",
      invoiceDate,
      dueDate: str(formData, "dueDate") || addDays(invoiceDate, 30),
      amount,
      taxAmount: numField(formData, "taxAmount") || Math.floor(amount - amount / 1.1),
      description: str(formData, "description"),
      status: "received",
      source: choice(formData, "source", ["manual", "ocr"] as const, "manual"),
      documentId: str(formData, "documentId") || undefined,
      registeredBy: user.id,
      createdAt: now,
      updatedAt: now,
    };
    db.purchases.push(p);
    addAudit(db, { userId: user.id, action: "create", entity: "purchase", entityId: id, entityLabel: p.number, summary: `仕入請求書を登録 (${db.suppliers.find((s) => s.id === supplierId)?.name} ¥${amount.toLocaleString("ja-JP")})`, storeId: "hq" });
    const doc = db.documents.find((d) => d.id === p.documentId);
    if (doc) {
      doc.status = "confirmed";
      doc.linkedType = "purchase";
      doc.linkedId = id;
    }
    if (intent === "submit") request(db, p, user);
  });
  revalidatePath("/purchases");
  redirect(withMsg(`/purchases/${id}`, intent === "submit" ? "仕入請求書を登録し、管理者へ支払承認を申請しました。" : "仕入請求書を登録しました。"));
}

export async function submitPurchase(id: string) {
  const user = await requireActionUser();
  const back = `/purchases/${id}`;
  if (!canManageFinance(user)) fail(back, "本部・管理者のみ操作できます。");
  await mutate((db) => {
    const p = db.purchases.find((x) => x.id === id);
    if (!p) fail("/purchases", "仕入請求書が見つかりません。");
    if (p.status !== "received" && p.status !== "disputed") fail(back, "受領・照会中の請求書のみ申請できます。");
    request(db, p, user);
    p.updatedAt = nowIso();
  });
  revalidatePath(back);
  redirect(withMsg(back, "管理者へ支払承認を申請しました。"));
}

export async function markPurchasePaid(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/purchases/${id}`;
  if (!canManageFinance(user)) fail(back, "本部・管理者のみ操作できます。");
  await mutate((db) => {
    const p = db.purchases.find((x) => x.id === id);
    if (!p) fail("/purchases", "仕入請求書が見つかりません。");
    if (p.status !== "approved") fail(back, "支払承認済みの請求書のみ支払済みにできます。");
    p.status = "paid";
    p.paidAt = str(formData, "paidAt") || toDateKey(new Date());
    p.updatedAt = nowIso();
    addAudit(db, { userId: user.id, action: "status", entity: "purchase", entityId: id, entityLabel: p.number, summary: `仕入請求書を支払済みに変更 (¥${p.amount.toLocaleString("ja-JP")} / ${p.paidAt})`, storeId: "hq" });
  });
  revalidatePath("/purchases");
  redirect(withMsg(back, "支払済みにしました。買掛金残高に反映されます。"));
}
