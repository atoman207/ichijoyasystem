import "server-only";
import type { Channel, Database, Order, User } from "@/lib/db/types";
import { addAudit, newId, nextNumber, nowIso } from "@/lib/db/store";
import { addDays } from "@/lib/format";
import { CHANNEL_LABEL } from "@/lib/constants";
export { PRE_ISSUE_STATUSES, canIssueFor } from "@/lib/invoice-rules";

/**
 * 受注 1 件の請求書を作る (受注の画面の「請求書を発行」と、予定表の「まとめて印刷」の事前発行で共通。mutate の中で呼ぶ)
 * ------------------------------------------------------------
 * 施工完了のあと: 受注は「請求済」。施工完了の前 (納品・施工の日にお渡しする請求書。お客様のご要望 2026-11-25「⑦」): 受注の状態は変えず、
 * 施工完了の登録で「請求済」になる。売上・売掛は施工完了 (売上計上日) から数える (billing.ts の awaitsCompletion)
 */

export function buildOrderInvoice(db: Database, user: User, o: Order, opts: { issueDate: string; dueDays: number; sentVia: Channel; notes?: string; note?: string }): string {
  const q = db.quotes.find((x) => x.id === o.quoteId);
  const pre = o.status !== "completed";
  const now = nowIso();
  const invoiceId = newId("inv");
  // 税抜の金額 = 合計 − 消費税 (税込の見積は内税)
  const sameQuote = Boolean(q && q.total === o.total);
  const subtotal = q && sameQuote ? q.total - q.tax : Math.round(o.total / 1.1);
  const tax = o.total - subtotal;
  // 発行時の明細を請求書に残す (見積があれば見積の明細。ない案件は「件名 一式」)
  const items = q && sameQuote ? q.items.map((i) => ({ ...i })) : [{ id: newId("qi"), name: o.title, qty: 1, unit: "式", unitPrice: subtotal, amount: subtotal }];
  const number = nextNumber(db, "INV", db.invoices, opts.issueDate);
  db.invoices.push({
    id: invoiceId,
    number,
    orderId: o.id,
    customerId: o.customerId,
    storeId: o.storeId,
    issueDate: opts.issueDate,
    dueDate: addDays(opts.issueDate, opts.dueDays),
    subtotal,
    tax,
    total: o.total,
    paidAmount: 0,
    status: "issued",
    sentVia: opts.sentVia,
    title: o.title,
    items,
    taxIncluded: sameQuote ? q!.taxIncluded : undefined,
    taxExempt: sameQuote ? q!.taxExempt : undefined,
    notes: opts.notes,
    createdBy: user.id,
    createdAt: now,
    updatedAt: now,
  });
  o.invoiceId = invoiceId;
  if (!pre) o.status = "invoiced";
  o.updatedAt = now;
  db.commLogs.push({ id: newId("cl"), customerId: o.customerId, storeId: o.storeId, channel: opts.sentVia, direction: "outbound", subject: `ご請求書 ${number}`, body: `${pre ? "納品・施工の日にお渡しするご請求書" : "施工完了に伴い、ご請求書"} (¥${o.total.toLocaleString("ja-JP")}) を${pre ? "発行しました" : `${CHANNEL_LABEL[opts.sentVia]}でお送りしました`}。お支払期限: ${addDays(opts.issueDate, opts.dueDays)}`, at: now, userId: user.id, relatedType: "invoice", relatedId: invoiceId });
  addAudit(db, { userId: user.id, action: "create", entity: "invoice", entityId: invoiceId, entityLabel: number, summary: `請求書を発行 (¥${o.total.toLocaleString("ja-JP")} / ${pre ? "施工完了の前に発行 (納品・施工の日にお渡し)" : CHANNEL_LABEL[opts.sentVia]})${opts.note ? ` · ${opts.note}` : ""}`, storeId: o.storeId });
  return invoiceId;
}
