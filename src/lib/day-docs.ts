import type { Database, Order, ReceiptMethod, ScheduleEvent, ScheduleKind, StoreId, User } from "@/lib/db/types";
import { caseChainOf } from "@/lib/case-store";
import { invoiceAccessInfo, quoteAccessInfo } from "@/lib/case-access";
import { canAccessStore, canIssueInvoice, canIssueReceipt, canOutputDocument } from "@/lib/auth/permissions";
import { liveInvoicesOfOrder } from "@/lib/billing";
import { PRE_ISSUE_STATUSES } from "@/lib/invoice-rules";
import { activeReceipts, receiptChecks, receiptDraft, receiptWanted, type ReceiptCheck, type ReceiptWanted } from "@/lib/receipts";
import { outputsOf } from "@/lib/doc-outputs";
import { periodLabel } from "@/lib/calendar";
import { SCHEDULE_KIND } from "@/lib/constants";

/**
 * その日の納品・施工の案件の帳票 (予定表の「帳票をまとめて印刷」。お客様のご要望 2026-11-25「⑦ 請求書・領収書の一括印刷」)
 * ------------------------------------------------------------
 * 日付・店舗の納品・施工・現場見積の予定から案件 (受注 → 見積 → 問い合わせ) を集め、案件ごとに 見積書・請求書・領収書 を印刷できるかを出す。
 * 請求書がなければ、請求書を発行できる人 (店長・本部・管理者。その店舗) は施工完了の前でも発行して印刷できる (受注の状態は変えない)。
 * 領収書は案件ごとに発行する・しない (Order.receiptWanted。未設定は入金の予定方法: 現金・訪問集金 = 発行する)
 */

export const DAY_DOC_KINDS: readonly ScheduleKind[] = ["delivery", "install", "onsite_quote"];

export interface DayDocRow {
  /** 案件の先頭の記録 (受注 → 見積 → 問い合わせ) の ID */
  key: string;
  storeId: StoreId;
  customerName: string;
  customerId?: string;
  caseNumber: string;
  caseHref: string;
  title: string;
  /** その日の予定 (時刻・種類) */
  events: { id: string; kind: ScheduleKind; label: string; period: string }[];
  sortKey: string;
  quote?: { id: string; number: string; version: number; draft: boolean; outputs: number; canPrint: boolean };
  order?: { id: string; number: string; status: Order["status"]; total: number };
  invoice?: { id: string; number: string; total: number; paidAmount: number; outputs: number; canPrint: boolean };
  /** 請求書がないとき: 発行して印刷できるか */
  invoiceIssue?: { ok: boolean; pre: boolean; reason?: string };
  receipt?: {
    wanted: ReceiptWanted;
    issued: { id: string; number: string; amount: number; outputs: number }[];
    /** 新しく発行できる残り (請求書がまだないときは受注の金額) */
    remaining: number;
    method: ReceiptMethod;
    canIssue: boolean;
    reason?: string;
  };
  checks: ReceiptCheck[];
}

const time = (e: ScheduleEvent) => e.startTime ?? (e.slot === "am" ? "09:00" : e.slot === "pm" ? "13:00" : "99:99");

/** その日・その店舗 ("all" = 全店舗) の帳票の一覧 */
export function dayDocRows(db: Database, user: User, date: string, store: StoreId | "all"): DayDocRow[] {
  const rows = new Map<string, DayDocRow>();
  const events = db.schedule.filter((e) => DAY_DOC_KINDS.includes(e.kind) && (e.date === date || (e.endDate && e.date <= date && date <= e.endDate)) && (store === "all" || e.storeId === store));
  for (const e of events) {
    const chain = caseChainOf(db, e.orderId ?? e.quoteId ?? e.inquiryId);
    if (!chain) continue;
    const key = chain.head.id;
    const ev = { id: e.id, kind: e.kind, label: SCHEDULE_KIND[e.kind].label, period: periodLabel(e) };
    const have = rows.get(key);
    if (have) {
      have.events.push(ev);
      if (time(e) < have.sortKey) have.sortKey = time(e);
      continue;
    }
    const customerId = chain.order?.customerId ?? chain.quote?.customerId ?? chain.inquiry?.customerId;
    const customer = customerId ? db.customers.find((c) => c.id === customerId) : undefined;
    const row: DayDocRow = {
      key,
      storeId: chain.head.storeId,
      customerName: customer?.name ?? chain.inquiry?.contactName ?? "",
      customerId,
      caseNumber: chain.head.number,
      caseHref: `/${chain.head.type === "order" ? "orders" : chain.head.type === "quote" ? "quotes" : "inquiries"}/${chain.head.id}`,
      title: chain.head.title,
      events: [ev],
      sortKey: time(e),
      checks: [],
    };
    const q = chain.quote;
    if (q && q.status !== "rejected" && q.status !== "expired") {
      row.quote = { id: q.id, number: q.number, version: q.version, draft: q.status === "draft" || q.status === "pending_approval", outputs: outputsOf(db, "quote", q.id, q.version).length, canPrint: canOutputDocument(user, quoteAccessInfo(db, user, q).access) };
    }
    const o = chain.order;
    if (o && o.status !== "cancelled") {
      row.order = { id: o.id, number: o.number, status: o.status, total: o.total };
      const inv = liveInvoicesOfOrder(db.invoices, o)[0];
      const wanted = receiptWanted(o);
      if (inv) {
        const access = invoiceAccessInfo(db, user, inv).access;
        row.invoice = { id: inv.id, number: inv.number, total: inv.total, paidAmount: inv.paidAmount, outputs: outputsOf(db, "invoice", inv.id).length, canPrint: canOutputDocument(user, access) };
        const d = receiptDraft(db, inv, o);
        row.receipt = {
          wanted,
          issued: activeReceipts(db, inv.id).map((r) => ({ id: r.id, number: r.number, amount: r.amount, outputs: outputsOf(db, "receipt", r.id).length })),
          remaining: d.remaining,
          method: d.parts[0]?.method ?? "cash",
          canIssue: canIssueReceipt(user, access) && d.remaining > 0,
          reason: d.remaining <= 0 ? "発行済み" : undefined,
        };
        row.checks = receiptChecks(db, inv, o);
      } else {
        const issueOk = o.status === "completed" || PRE_ISSUE_STATUSES.includes(o.status);
        const can = canIssueInvoice(user) && canAccessStore(user, o.storeId);
        row.invoiceIssue = issueOk ? (can ? { ok: true, pre: o.status !== "completed" } : { ok: false, pre: false, reason: "請求書の発行は店長・本部・管理者 (その店舗) が行えます" }) : { ok: false, pre: false, reason: o.status === "pending_approval" || o.status === "returned" ? "契約の承認待ち" : "この状態の案件は請求書を発行できません" };
        row.receipt = {
          wanted,
          issued: [],
          remaining: o.total,
          method: receiptDraft(db, { id: "-", total: o.total, paidAmount: 0 }, o).parts[0]?.method ?? "cash",
          canIssue: Boolean(row.invoiceIssue.ok),
          reason: row.invoiceIssue.ok ? undefined : "請求書を発行すると領収書も発行できます",
        };
      }
    }
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => a.sortKey.localeCompare(b.sortKey) || a.customerName.localeCompare(b.customerName, "ja"));
}
