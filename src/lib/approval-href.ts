import type { Approval } from "@/lib/db/types";

/** 承認依頼の対象の画面 */
export function approvalHref(a: Pick<Approval, "type" | "targetId">): string {
  switch (a.type) {
    case "quote":
    case "quote_amend":
      return `/quotes/${a.targetId}`;
    case "order":
    case "order_change":
    case "handover_change":
      return `/orders/${a.targetId}`;
    case "expense":
      return `/expenses/${a.targetId}`;
    case "purchase":
      return `/purchases/${a.targetId}`;
    case "customer_change":
    case "record_view":
      return `/customers/${a.targetId}`;
    case "inquiry_delete":
      return `/inquiries/${a.targetId}`;
    case "customer_delete":
      // 削除したあとは顧客の画面が統合先へ移る (src/lib/customer-delete.ts の deletedCustomerOf)
      return `/customers/${a.targetId}`;
    case "store_change":
      // 案件のいちばん進んだ記録 (o_ = 受注 / q_ = 見積 / inq_ = 問い合わせ)
      return a.targetId.startsWith("o_") ? `/orders/${a.targetId}` : a.targetId.startsWith("q_") ? `/quotes/${a.targetId}` : a.targetId.startsWith("inq_") ? `/inquiries/${a.targetId}` : "/approvals";
    default:
      return "/approvals";
  }
}
