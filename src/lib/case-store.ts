import type { AuditChange, Database, Inquiry, Order, Quote, StoreId } from "@/lib/db/types";
import { addAudit, newId, nowIso } from "@/lib/db/store";
import { liveInvoicesOfOrder } from "@/lib/billing";
import { closedReason } from "@/lib/mgmt/close";

/**
 * 案件の施工店舗の変更 (お客様のご要望 2026-11-24「予定表から施工店舗の変更」「売上は原則として施工店舗に帰属」「施工店舗の変更は店長の承認」)
 * ------------------------------------------------------------
 * 施工店舗 = 案件 (問い合わせ → 見積 → 受注) の店舗 (storeId)。受注の店舗が売上の帰属店舗 (経営ダッシュボード・管理会計・KPI)。
 * 変えるときは案件の記録 (問い合わせ・見積・受注) と、案件の予定 (全社の予定を除く) の店舗をそろえて変える。お客様の店舗は変えない。
 * 予定表の小さな画面から申請する (承認の type = store_change。承認者は今の施工店舗の店長。店長・管理者の申請は承認を省略。
 * 施工完了・請求済・入金済の受注は確定した売上なので管理者の承認 = approval-decide.ts の touchesConfirmedSales)。
 * 請求書を発行した案件・月次確定の月の売上は変えない (請求書の店舗・確定した数字とずれるため)
 */

export type CaseHeadType = "order" | "quote" | "inquiry";

export interface CaseChain {
  inquiry?: Inquiry;
  quote?: Quote;
  order?: Order;
  /** いちばん進んだ記録 (承認の targetId) */
  head: { type: CaseHeadType; id: string; number: string; title: string; storeId: StoreId };
}

/** 記録の ID の種類 (o_ = 受注 / q_ = 見積 / inq_ = 問い合わせ) */
export function caseHeadType(id: string | undefined): CaseHeadType | undefined {
  if (!id) return undefined;
  if (id.startsWith("o_")) return "order";
  if (id.startsWith("q_")) return "quote";
  if (id.startsWith("inq_")) return "inquiry";
  return undefined;
}

/** 案件のつながり (受注 ⇄ 見積 ⇄ 問い合わせ)。どの段階の ID からでも */
export function caseChainOf(db: Pick<Database, "orders" | "quotes" | "inquiries">, id: string | undefined): CaseChain | undefined {
  const type = caseHeadType(id);
  if (!type || !id) return undefined;
  let order: Order | undefined;
  let quote: Quote | undefined;
  let inquiry: Inquiry | undefined;
  if (type === "order") {
    order = db.orders.find((o) => o.id === id);
    quote = order?.quoteId ? db.quotes.find((q) => q.id === order!.quoteId) : undefined;
  } else if (type === "quote") {
    quote = db.quotes.find((q) => q.id === id);
    order = quote ? db.orders.find((o) => (quote!.orderId ? o.id === quote!.orderId : o.quoteId === quote!.id)) : undefined;
  } else {
    inquiry = db.inquiries.find((i) => i.id === id);
    quote = inquiry?.quoteId ? db.quotes.find((q) => q.id === inquiry!.quoteId) : undefined;
    order = quote ? db.orders.find((o) => (quote!.orderId ? o.id === quote!.orderId : o.quoteId === quote!.id)) : undefined;
  }
  if (!inquiry && quote?.inquiryId) inquiry = db.inquiries.find((i) => i.id === quote!.inquiryId);
  const h = order ?? quote ?? inquiry;
  if (!h) return undefined;
  const headType: CaseHeadType = order ? "order" : quote ? "quote" : "inquiry";
  const title = order?.title ?? quote?.title ?? inquiry?.summary ?? "";
  return { inquiry, quote, order, head: { type: headType, id: h.id, number: h.number, title, storeId: h.storeId } };
}

export const chainIds = (c: CaseChain) => [c.order?.id, c.quote?.id, c.inquiry?.id].filter((x): x is string => Boolean(x));

/** 承認待ちの施工店舗の変更 (同じ案件のどの記録でも) */
export function pendingStoreChange(db: Pick<Database, "approvals">, c: CaseChain) {
  const ids = new Set(chainIds(c));
  return db.approvals.find((a) => a.type === "store_change" && a.status === "pending" && ids.has(a.targetId));
}

/** 施工店舗を変えられない理由 (変えられるときは undefined) */
export function storeChangeBlocker(db: Pick<Database, "stores" | "invoices" | "periodCloses" | "mgmtRules">, c: CaseChain, to: string): string | undefined {
  if (!db.stores.some((s) => s.id === to)) return "店舗が正しくありません。";
  if (to === c.head.storeId) return "今と同じ店舗です。";
  const o = c.order;
  if (o?.status === "cancelled") return "キャンセルした受注のため、施工店舗は変えられません。";
  if (o && liveInvoicesOfOrder(db.invoices, o).length) return "請求書を発行済みの案件のため、施工店舗は変えられません (請求書の店舗と売上の店舗がずれるため)。管理者にご相談ください。";
  if (o && (o.status === "completed" || o.status === "invoiced" || o.status === "paid")) {
    const closed = closedReason(db, o.salesDate ?? o.completedAt?.slice(0, 10), "施工店舗 (売上の店舗) の変更");
    if (closed) return closed;
  }
  return undefined;
}

/** 案件の予定 (全社の予定を除く) */
export function caseEvents(db: Pick<Database, "schedule">, c: CaseChain) {
  return db.schedule.filter((e) => !e.companyWide && ((c.order && e.orderId === c.order.id) || (c.quote && e.quoteId === c.quote.id) || (c.inquiry && e.inquiryId === c.inquiry.id)));
}

/**
 * 施工店舗を変える (承認の反映・承認の省略から呼ぶ。mutate の中)。案件の記録と案件の予定の店舗をそろえる。
 * 変えた記録・予定の数を返す
 */
export function applyCaseStoreChange(db: Database, userId: string, c: CaseChain, to: StoreId, reason?: string): { records: number; events: number } {
  const now = nowIso();
  const storeName = (id: string) => db.stores.find((s) => s.id === id)?.name ?? id;
  const from = c.head.storeId;
  let records = 0;
  const note = `施工店舗を${storeName(from)}から${storeName(to)}に変更${reason ? ` (理由: ${reason})` : ""}`;
  const touch = (entity: "order" | "quote" | "inquiry", r: { id: string; number: string; storeId: StoreId; updatedAt?: string } | undefined) => {
    if (!r || r.storeId === to) return;
    const changes: AuditChange[] = [{ field: "storeId", before: r.storeId, after: to }];
    r.storeId = to;
    r.updatedAt = now;
    records++;
    addAudit(db, { userId, action: "update", entity, entityId: r.id, entityLabel: r.number, summary: note + (entity === "order" ? " / 売上は新しい施工店舗に計上" : ""), storeId: to, changes });
  };
  touch("order", c.order);
  touch("quote", c.quote);
  touch("inquiry", c.inquiry);
  if (c.order) c.order.progressNotes.push({ id: newId("pn"), at: now, userId, kind: "change", body: `${note}。売上は${storeName(to)}に計上します。` });
  let events = 0;
  for (const e of caseEvents(db, c)) {
    if (e.storeId === to) continue;
    const before = e.storeId;
    e.storeId = to;
    e.updatedBy = userId;
    e.updatedAt = now;
    events++;
    addAudit(db, { userId, action: "update", entity: "schedule", entityId: e.id, entityLabel: e.title, summary: `案件の施工店舗の変更に合わせて予定の店舗を変更 (${storeName(before)} → ${storeName(to)})`, storeId: to, changes: [{ field: "storeId", before, after: to }] });
  }
  return { records, events };
}
