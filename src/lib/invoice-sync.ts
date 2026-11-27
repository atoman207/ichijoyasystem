import type { Database, Invoice, Order } from "@/lib/db/types";
import { addAudit, newId, nowIso } from "@/lib/db/store";
import { invoiceOrderIds, liveInvoicesOfOrder } from "@/lib/billing";

/**
 * 売上確定のあとの金額の修正を請求書に反映する (お客様のご要望 2026-11-27「■1 売上確定・請求書発行」: 売上確定後も内容・金額を修正でき、
 * 売上・請求書・作業日報・インセンティブ集計に反映する)。
 * - 受注 1 件の請求書 (案件ごとの請求書) は、見積の新しい版の明細・税・合計で同じ請求書を直す (請求書の番号はそのまま。変更履歴に残す)
 * - 入金の記録がある請求書・法人のまとめ請求の請求書は直さない (amendBlockedByInvoice が断る。入金の記録・まとめ請求をやり直してから)
 * mutate の中で呼ぶ。import はデータの関数だけ (承認の反映 approval-decide.ts からも使う)
 */

/** 受注の有効な請求書 (受注 1 件の請求書だけ。まとめ請求の請求書は undefined と blocked) */
export function singleInvoiceOf(db: Pick<Database, "invoices">, o: Pick<Order, "id" | "invoiceId">): { invoice?: Invoice; batch?: Invoice } {
  const live = liveInvoicesOfOrder(db.invoices, o);
  const batch = live.find((i) => invoiceOrderIds(i).length > 1 || Boolean(i.orderLines?.length));
  if (batch) return { batch };
  return { invoice: live[0] };
}

/** 金額の修正を請求書に反映できない理由 (なければ undefined)。見積の ID か受注で調べる */
export function amendBlockedByInvoice(db: Pick<Database, "invoices" | "orders">, ref: { quoteId?: string; orderId?: string }): string | undefined {
  const o = ref.orderId ? db.orders.find((x) => x.id === ref.orderId) : db.orders.find((x) => x.quoteId === ref.quoteId && x.status !== "cancelled");
  if (!o) return undefined;
  const { invoice, batch } = singleInvoiceOf(db, o);
  if (batch) return `この案件はまとめ請求の請求書 ${batch.number} に入っているため、金額を変えられません。請求書の画面でまとめ請求を無効にしてから直してください。`;
  if (invoice && invoice.paidAmount > 0) return `請求書 ${invoice.number} に入金の記録 (¥${invoice.paidAmount.toLocaleString("ja-JP")}) があるため、金額を変えられません。入金の記録を取り消してから直してください。`;
  return undefined;
}

/**
 * 受注の金額 (見積の新しい版) を受注 1 件の請求書に写す。直した請求書の番号を返す (請求書がない・同じ金額・まとめ請求なら undefined)
 */
export function syncInvoiceToOrder(db: Database, o: Order, userId: string, reason: string): string | undefined {
  const { invoice: inv } = singleInvoiceOf(db, o);
  if (!inv || inv.paidAmount > 0) return undefined;
  const q = o.quoteId ? db.quotes.find((x) => x.id === o.quoteId) : undefined;
  const sameQuote = Boolean(q && q.total === o.total);
  const subtotal = q && sameQuote ? q.total - q.tax : Math.round(o.total / 1.1);
  const tax = o.total - subtotal;
  const items = q && sameQuote ? q.items.map((i) => ({ ...i })) : [{ id: newId("qi"), name: o.title, qty: 1, unit: "式", unitPrice: subtotal, amount: subtotal }];
  const before = { total: inv.total, subtotal: inv.subtotal, tax: inv.tax, items: JSON.stringify((inv.items ?? []).map((i) => [i.name, i.spec ?? "", i.qty, i.unit, i.unitPrice])) };
  const after = { total: o.total, subtotal, tax, items: JSON.stringify(items.map((i) => [i.name, i.spec ?? "", i.qty, i.unit, i.unitPrice])) };
  if (before.total === after.total && before.subtotal === after.subtotal && before.tax === after.tax && before.items === after.items) return undefined;
  inv.items = items;
  inv.subtotal = subtotal;
  inv.tax = tax;
  inv.total = o.total;
  inv.title = o.title;
  if (q && sameQuote) {
    inv.taxIncluded = q.taxIncluded;
    inv.taxExempt = q.taxExempt;
  }
  inv.updatedAt = nowIso();
  addAudit(db, {
    userId,
    action: "update",
    entity: "invoice",
    entityId: inv.id,
    entityLabel: inv.number,
    summary: `売上の修正に合わせて請求書の明細・金額を変更 (¥${before.total.toLocaleString("ja-JP")} → ¥${o.total.toLocaleString("ja-JP")}。理由: ${reason})。印刷し直してお渡しください`,
    storeId: inv.storeId,
    changes: [
      ...(before.total !== after.total ? [{ field: "total", before: before.total, after: after.total }] : []),
      ...(before.tax !== after.tax ? [{ field: "tax", before: before.tax, after: after.tax }] : []),
      ...(before.items !== after.items ? [{ field: "items", before: "変更前の明細", after: "見積の新しい版の明細" }] : []),
    ],
  });
  return inv.number;
}
