import type { Database, Order } from "@/lib/db/types";
import { liveInvoicesOfOrder } from "@/lib/billing";
import { salesReadiness } from "@/lib/sales-ready";

/**
 * 請求書を受注から発行できるか (受注の画面・予定表の「帳票をまとめて印刷」で共通。import は型と billing.ts だけ)
 * 施工完了のあと、または施工完了の前 (受注確定・施工予定・施工中) の納品・施工の日にお渡しする請求書 (お客様のご要望 2026-11-25「⑦」)
 */

/** 施工完了の前に請求書を発行できる受注の状態 */
export const PRE_ISSUE_STATUSES: readonly Order["status"][] = ["confirmed", "scheduled", "in_progress"];

/**
 * needsSetup = 作業の担当・ポスティングが未登録 (受注の画面の「作業の担当・ポスティング」で登録すると発行できる。
 * お客様のご要望 2026-11-27「■3」: 売上登録 (請求書の発行) の前に担当者とポスティングの枚数を確定する。src/lib/sales-ready.ts)
 */
export function canIssueFor(db: Pick<Database, "invoices">, o: Order): { ok: boolean; pre: boolean; reason?: string; needsSetup?: boolean } {
  if (o.invoiceId && liveInvoicesOfOrder(db.invoices, o).length) return { ok: false, pre: false, reason: "すでに請求書が発行されています。" };
  const pre = PRE_ISSUE_STATUSES.includes(o.status);
  if (o.status !== "completed" && !pre) return { ok: false, pre: false, reason: o.status === "pending_approval" || o.status === "returned" ? "契約の承認のあとに請求書を発行できます。" : "この状態の案件には請求書を発行できません。" };
  const ready = salesReadiness(o);
  if (!ready.ok) return { ok: false, pre, reason: ready.reason, needsSetup: true };
  return { ok: true, pre };
}

