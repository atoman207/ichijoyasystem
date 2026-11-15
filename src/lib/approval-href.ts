import type { Approval } from "@/lib/db/types";

/** 承認依頼の対象の画面 */
export function approvalHref(a: Pick<Approval, "type" | "targetId">): string {
  switch (a.type) {
    case "quote":
    case "quote_amend":
      return `/quotes/${a.targetId}`;
    case "order":
    case "order_change":
      return `/orders/${a.targetId}`;
    case "expense":
      return `/expenses/${a.targetId}`;
    case "purchase":
      return `/purchases/${a.targetId}`;
    case "customer_change":
      return `/customers/${a.targetId}`;
    default:
      return "/approvals";
  }
}
