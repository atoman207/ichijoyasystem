import type { Database, Order } from "@/lib/db/types";
import { liveInvoicesOfOrder } from "@/lib/billing";

/**
 * 請求書を受注から発行できるか (受注の画面・予定表の「帳票をまとめて印刷」で共通。import は型と billing.ts だけ)
 * 施工完了のあと、または施工完了の前 (受注確定・施工予定・施工中) の納品・施工の日にお渡しする請求書 (お客様のご要望 2026-11-25「⑦」)
 */

/** 施工完了の前に請求書を発行できる受注の状態 */
export const PRE_ISSUE_STATUSES: readonly Order["status"][] = ["confirmed", "scheduled", "in_progress"];

export function canIssueFor(db: Pick<Database, "invoices">, o: Order): { ok: boolean; pre: boolean; reason?: string } {
  if (o.invoiceId && liveInvoicesOfOrder(db.invoices, o).length) return { ok: false, pre: false, reason: "すでに請求書が発行されています。" };
  if (o.status === "completed") return { ok: true, pre: false };
  if (PRE_ISSUE_STATUSES.includes(o.status)) return { ok: true, pre: true };
  return { ok: false, pre: false, reason: o.status === "pending_approval" || o.status === "returned" ? "契約の承認のあとに請求書を発行できます。" : "この状態の案件には請求書を発行できません。" };
}

