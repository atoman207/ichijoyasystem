import type { Database, Inquiry } from "@/lib/db/types";
import { CATEGORY_LABEL, CHANNEL_LABEL } from "@/lib/constants";
import { lineGroups } from "@/lib/line-groups";
import { fmtDateTime } from "@/lib/format";
import { appBaseUrl } from "./config";
import type { Outgoing } from "./send";

/**
 * 新しい問い合わせを、その店舗の LINE グループに知らせる (店舗別グループ。設定 → 外部連携・AI の LINE グループで
 * 用途 =「店舗別グループ」・店舗・「問い合わせを知らせる」を選んだグループだけ)
 * ------------------------------------------------------------
 * 一畳屋の運用: 事務がメモした お名前・電話・依頼の内容 を店舗の LINE グループに送り、店舗が日程を返す → 事務が転記していた。
 * システムでは問い合わせを 1 回登録すると店舗のグループに届き、店舗はリンクから問い合わせを開いて予定を登録する (転記しない)。
 * LINE の送信 (プッシュ) は公式アカウントのプランの月の通数を使う
 */
export function storeInquiryNotices(db: Pick<Database, "settings" | "customers">, inq: Pick<Inquiry, "id" | "number" | "storeId" | "contactName" | "contactPhone" | "customerId" | "category" | "summary" | "detail" | "channel" | "receivedAt" | "nextActionDue" | "intake">): Outgoing[] {
  const groups = lineGroups(db).filter((g) => g.status === "joined" && g.purpose === "store" && g.notifyInquiries && g.storeId === inq.storeId);
  if (!groups.length) return [];
  const customer = inq.customerId ? db.customers.find((c) => c.id === inq.customerId) : undefined;
  const address = customer?.address ?? inq.intake?.address;
  const body = [
    `【新しい問い合わせ】${inq.number}`,
    `お客様: ${inq.contactName} 様${customer ? ` (登録済み ${customer.code})` : ""}`,
    inq.contactPhone ? `電話: ${inq.contactPhone}` : "",
    address ? `住所: ${address}` : "",
    `種類: ${CATEGORY_LABEL[inq.category] ?? inq.category} / 受付: ${CHANNEL_LABEL[inq.channel] ?? inq.channel} ${fmtDateTime(inq.receivedAt)}`,
    `内容: ${inq.summary}`,
    inq.intake?.desiredDate ? `ご希望の日: ${inq.intake.desiredDate}` : "",
    inq.nextActionDue ? `対応の期限: ${inq.nextActionDue}` : "",
    "",
    `日程はシステムで登録してください (LINE で返信すると事務の転記が要ります):`,
    `${appBaseUrl()}/inquiries/${inq.id}`,
  ]
    .filter((l, i, a) => l || (i > 0 && a[i - 1]))
    .join("\n");
  return groups.map((g) => ({ channel: "line" as const, to: g.id, toLabel: g.label || g.name || "店舗の LINE グループ", body, purpose: "notify" as const, relatedType: "inquiry" as const, relatedId: inq.id }));
}
