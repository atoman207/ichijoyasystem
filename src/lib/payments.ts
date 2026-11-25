import "server-only";
import type { Database, Invoice, PaymentMethod } from "@/lib/db/types";
import { addAudit, newId, nowIso } from "@/lib/db/store";
import { PAYMENT_METHOD_LABEL } from "@/lib/constants";
import { postCash } from "@/lib/cashbook";
import { settleInvoiceOrders } from "@/lib/billing";

/**
 * 入金の記録 (請求書の画面の「入金を登録」と、領収書の内訳からの入金の記録で共通。mutate の中で呼ぶ)。
 * 現金は店舗の現金出納帳に記帳し、入金予定を消し、請求書・案件の状態を進める。問題があれば理由の文を返す (書かない)
 */
export function applyPayment(db: Database, userId: string, inv: Invoice, p: { date: string; amount: number; method: PaymentMethod; memo?: string }): string | undefined {
  if (inv.status === "void") return "無効化された請求書には入金できません。";
  const { amount, method, date } = p;
  if (!(amount > 0)) return "入金額を入力してください。";
  const remaining = inv.total - inv.paidAmount;
  if (amount > remaining) return `入金額が残高 (¥${remaining.toLocaleString("ja-JP")}) を超えています。`;
  const now = nowIso();
  const paymentId = newId("pay");
  db.payments.push({ id: paymentId, invoiceId: inv.id, date, amount, method, memo: p.memo, recordedBy: userId, createdAt: now });
  // 現金の入金は店舗の現金出納帳に記帳する
  if (method === "cash") {
    const name = db.customers.find((c) => c.id === inv.customerId)?.name;
    postCash(db, { storeId: inv.storeId, date, direction: "in", amount, account: "売掛金回収 (現金入金)", counterparty: name, description: `${inv.number} の入金`, source: "payment", sourceId: paymentId, userId });
  }
  // 入金予定: 全額の入金・予定額を満たす入金で消す。予定額の一部の入金は予定額を減らす (予定額なし = 残高の全額の予定は、一部の入金では残す)
  if (inv.expectedDate) {
    const clearPlan = amount >= remaining || (inv.expectedAmount !== undefined && amount >= inv.expectedAmount);
    if (clearPlan) {
      inv.expectedDate = undefined;
      inv.expectedAmount = undefined;
      inv.expectedNote = undefined;
    } else if (inv.expectedAmount !== undefined) inv.expectedAmount -= amount;
  }
  inv.paidAmount += amount;
  inv.status = inv.paidAmount >= inv.total ? "paid" : "partially_paid";
  inv.updatedAt = now;
  // 受注の状態: 入金を割り当てた額 (まとめ請求は売上計上日の古い順) が受注の金額に届いた案件を入金済みに
  settleInvoiceOrders(db, inv, now);
  addAudit(db, { userId, action: "create", entity: "payment", entityId: inv.id, entityLabel: inv.number, summary: `入金を登録 (¥${amount.toLocaleString("ja-JP")} / ${PAYMENT_METHOD_LABEL[method]})${inv.status === "paid" ? " → 入金完了" : ""}${p.memo ? ` · ${p.memo}` : ""}`, storeId: inv.storeId });
  return undefined;
}
