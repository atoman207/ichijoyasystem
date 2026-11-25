import "server-only";
import type { Database, Receipt, User } from "@/lib/db/types";
import { addAudit, newId, nextNumber, nowIso } from "@/lib/db/store";
import { canIssueReceipt } from "@/lib/auth/permissions";
import { invoiceAccessInfo } from "@/lib/case-access";
import { activeReceipts, partLabel, receiptError, receiptHeading, receiptTax } from "@/lib/receipts";

const yen = (n: number) => `¥${n.toLocaleString("ja-JP")}`;

/** 新しい領収書を作る (mutate の中。問題があれば理由の文を返す) */
export function makeReceipt(db: Database, user: User, input: { invoiceId: string; amount: number; parts: Receipt["parts"]; issueDate: string; addressee?: string; honorific?: "様" | "御中"; purpose?: string; note?: string; via?: string }): { receipt?: Receipt; error?: string } {
  const inv = db.invoices.find((x) => x.id === input.invoiceId);
  if (!inv) return { error: "請求書が見つかりません。" };
  if (!canIssueReceipt(user, invoiceAccessInfo(db, user, inv).access)) return { error: "この請求書の領収書を発行する権限がありません。" };
  const err = receiptError({ amount: input.amount, parts: input.parts }, inv, db);
  if (err) return { error: err };
  const order = db.orders.find((o) => o.id === inv.orderId);
  const customer = db.customers.find((c) => c.id === inv.customerId);
  const head = receiptHeading(customer, inv, order);
  const now = nowIso();
  db.receipts ??= [];
  const r: Receipt = {
    id: newId("rc"),
    number: nextNumber(db, "R", db.receipts, input.issueDate),
    invoiceId: inv.id,
    orderId: order?.id,
    customerId: inv.customerId,
    storeId: inv.storeId,
    issueDate: input.issueDate,
    addressee: input.addressee?.trim() || head.addressee,
    honorific: input.honorific ?? head.honorific,
    purpose: input.purpose?.trim() || head.purpose,
    amount: input.amount,
    tax: receiptTax(inv, input.amount),
    ...(inv.taxExempt ? { taxExempt: true } : {}),
    parts: input.parts,
    status: "issued",
    ...(input.note?.trim() ? { note: input.note.trim().slice(0, 200) } : {}),
    createdBy: user.id,
    createdAt: now,
    updatedAt: now,
  };
  db.receipts.push(r);
  addAudit(db, {
    userId: user.id,
    action: "create",
    entity: "receipt",
    entityId: r.id,
    entityLabel: r.number,
    summary: `領収書を発行 (${inv.number} / ${yen(r.amount)} / ${r.parts.map((p) => `${partLabel(p)} ${yen(p.amount)}`).join("・")}${inv.paidAmount < activeReceipts(db, inv.id).reduce((a, x) => a + x.amount, 0) ? " · 入金の記録より先に発行" : ""}${input.via ? ` · ${input.via}` : ""})`,
    storeId: inv.storeId,
  });
  return { receipt: r };
}

