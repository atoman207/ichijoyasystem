"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, getDb, newId, nowIso } from "@/lib/db/store";
import type { StoreId } from "@/lib/db/types";
import { toDateKey } from "@/lib/format";
import { CHANNEL_LABEL } from "@/lib/constants";
import { canAccessStore } from "@/lib/auth/permissions";
import { invoicePdfData, quotePdfData } from "@/lib/pdf/data";
import { renderInvoicePdf, renderQuotePdf } from "@/lib/pdf/render";
import { isEmail } from "@/lib/notify/channels";
import { lineConfig, mailConfig } from "@/lib/notify/config";
import { docLink } from "@/lib/notify/doc-link";
import { sendAndRecord, type Outgoing } from "@/lib/notify/send";
import { choice, fail, requireActionUser, str, withMsg } from "./guards";

/**
 * 見積書・請求書をお客様へ送る (メール: PDF を添付 / LINE: 期限つきの PDF のリンク)。
 * 送れたら、やりとり履歴・送信履歴・変更履歴に残し、見積は「送付済」、請求書は送付方法を記録する。
 * 送信の設定がないとき・送れなかったときは何も変えない (手渡し・郵送は「送付の記録」で残す)
 */
export async function sendDocument(kind: "quote" | "invoice", id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = kind === "quote" ? `/quotes/${id}` : `/invoices/${id}`;
  if (kind !== "quote" && kind !== "invoice") fail("/", "帳票の種類が正しくありません。");
  const channel = choice(formData, "channel", ["email", "line"] as const, "email");
  const to = str(formData, "to");
  const subject = str(formData, "subject").slice(0, 150);
  const message = str(formData, "message").slice(0, 3000);
  if (channel === "email" && !mailConfig()) fail(back, "メールの送信設定がありません (設定 → 外部連携・AI)。郵送・手渡しなどで送った場合は「送付の記録」に残してください。");
  if (channel === "line" && !lineConfig()) fail(back, "LINE の送信設定がありません (設定 → 外部連携・AI)。");
  if (channel === "email" && !isEmail(to)) fail(back, "送信先のメールアドレスを正しく入力してください。");
  if (channel === "line" && !/^U[0-9a-f]{32}$/.test(to)) fail(back, "LINE のユーザー ID (U で始まる 33 文字) を入力してください。お客様の LINE ID は顧客情報に登録できます。");
  if (!message) fail(back, "本文を入力してください。");

  const db = getDb();
  let pdf: Uint8Array;
  let fileName: string;
  let number: string;
  let storeId: StoreId;
  let customerId: string;
  let total: number;
  if (kind === "quote") {
    const q = db.quotes.find((x) => x.id === id);
    if (!q) fail("/quotes", "見積が見つかりません。");
    if (!canAccessStore(user, q.storeId)) fail("/quotes", "この見積を送る権限がありません。");
    if (q.status !== "approved" && q.status !== "sent" && q.status !== "accepted") fail(back, "承認済みの見積のみ送付できます。");
    const data = quotePdfData(db, q);
    if (!data) fail(back, "見積書を作成できませんでした。");
    pdf = await renderQuotePdf(data);
    fileName = `御見積書_${q.number}${q.version > 1 ? `_第${q.version}版` : ""}.pdf`;
    number = q.number;
    storeId = q.storeId;
    customerId = q.customerId;
    total = q.total;
  } else {
    const inv = db.invoices.find((x) => x.id === id);
    if (!inv) fail("/invoices", "請求書が見つかりません。");
    if (!canAccessStore(user, inv.storeId)) fail("/invoices", "この請求書を送る権限がありません。");
    if (inv.status === "void") fail(back, "無効化した請求書は送付できません。");
    pdf = await renderInvoicePdf(invoicePdfData(db, inv));
    fileName = `御請求書_${inv.number}.pdf`;
    number = inv.number;
    storeId = inv.storeId;
    customerId = inv.customerId;
    total = inv.total;
  }
  const customer = db.customers.find((c) => c.id === customerId);
  const link = docLink(kind, id, 14);
  const until = `${link.expiresAt.getFullYear()}/${link.expiresAt.getMonth() + 1}/${link.expiresAt.getDate()}`;
  const label = kind === "quote" ? "お見積書" : "ご請求書";
  const out: Outgoing =
    channel === "email"
      ? { channel, to, toLabel: customer?.name, subject: subject || `${label} ${number} 株式会社一畳屋`, body: message, attachments: [{ filename: fileName, contentType: "application/pdf", base64: Buffer.from(pdf).toString("base64") }], purpose: "document", relatedType: kind, relatedId: id }
      : { channel, to, toLabel: customer?.name, body: `${message}\n\n${label} (PDF): ${link.url}\n(リンクの有効期限: ${until})`, purpose: "document", relatedType: kind, relatedId: id };

  const [d] = await sendAndRecord([out], user.id, (d2, deliveries) => {
    const dl = deliveries[0];
    if (dl.status !== "sent") return;
    const now = nowIso();
    d2.commLogs.push({ id: newId("cl"), customerId, storeId, channel, direction: "outbound", subject: `${label} ${number} 送付`, body: `${label} (合計 ¥${total.toLocaleString("ja-JP")}) を${CHANNEL_LABEL[channel]}で送信しました (宛先: ${to})。`, at: now, userId: user.id, relatedType: kind, relatedId: id, deliveryId: dl.id });
    if (kind === "quote") {
      const q = d2.quotes.find((x) => x.id === id);
      if (q) {
        if (q.status === "approved") q.status = "sent";
        q.issuedAt = q.issuedAt ?? toDateKey(new Date());
        q.sentVia = channel;
        q.updatedAt = now;
        const inq = d2.inquiries.find((i) => i.id === q.inquiryId);
        if (inq && inq.status !== "won") inq.status = "quoted";
      }
    } else {
      const inv = d2.invoices.find((x) => x.id === id);
      if (inv) {
        inv.sentVia = channel;
        inv.updatedAt = now;
      }
    }
    addAudit(d2, { userId: user.id, action: "send", entity: kind, entityId: id, entityLabel: number, summary: `${label}を${CHANNEL_LABEL[channel]}で送信 (宛先: ${to}${channel === "email" ? " / PDF 添付" : " / PDF のリンク"})`, storeId });
  });
  if (d.status === "failed") fail(back, `送信できませんでした: ${d.error ?? "原因不明"}`);
  revalidatePath(back);
  redirect(withMsg(back, `${label}を${CHANNEL_LABEL[channel]}で送信しました。やりとり履歴・送信履歴に残りました。`));
}
