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

/**
 * 店舗への依頼 (問い合わせの担当者への依頼で、担当者を決めずに店舗へ依頼したとき) と、期限を過ぎたときの再通知を、
 * その店舗の LINE グループに送る (お客様のご要望 2026-11-24「業務フロー ①②」: 今は LINE で依頼している)。
 * 送り先は新しい問い合わせと同じグループ (店舗別グループ・「問い合わせを知らせる」)
 */
export function storeRequestNotices(
  db: Pick<Database, "settings" | "customers">,
  inq: Pick<Inquiry, "id" | "number" | "contactName" | "contactPhone" | "customerId" | "summary" | "intake">,
  p: { storeId: string; what: "request" | "remind"; purpose: string; note?: string; due?: string; from?: string },
): Outgoing[] {
  const groups = lineGroups(db).filter((g) => g.status === "joined" && g.purpose === "store" && g.notifyInquiries && g.storeId === p.storeId);
  if (!groups.length) return [];
  const customer = inq.customerId ? db.customers.find((c) => c.id === inq.customerId) : undefined;
  const body = [
    p.what === "remind" ? `【期限を過ぎました】${inq.number}` : `【依頼】${p.purpose} ${inq.number}`,
    p.from ? `依頼: ${p.from}` : "",
    `お客様: ${customer?.name ?? inq.contactName} 様`,
    (customer?.phone || inq.contactPhone) ? `電話: ${customer?.phone || inq.contactPhone}` : "",
    (customer?.address || inq.intake?.address) ? `住所: ${customer?.address || inq.intake?.address}` : "",
    `内容: ${inq.summary}`,
    p.due ? `期限: ${p.due}` : "",
    p.note ? `\n${p.note.slice(0, 500)}` : "",
    "",
    p.what === "remind" ? "日程が決まったら、問い合わせの画面の「日程を登録」で入れてください:" : "問い合わせの画面で確認・日程の登録をしてください:",
    `${appBaseUrl()}/inquiries/${inq.id}`,
  ]
    .filter((l, i, a) => l || (i > 0 && a[i - 1]))
    .join("\n");
  return groups.map((g) => ({ channel: "line" as const, to: g.id, toLabel: g.label || g.name || "店舗の LINE グループ", body, purpose: "notify" as const, relatedType: "inquiry" as const, relatedId: inq.id }));
}
