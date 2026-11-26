import type { Database } from "@/lib/db/types";
import { addAudit } from "@/lib/db/store";
import { addInbound } from "@/lib/inbound/feed";

/**
 * 会社のメールボックスに届いたメールを記録する (src/lib/inbound/mail.ts が IMAP で読んだあとに呼ぶ。mutate の中)
 * - 差出人がお客様 (顧客のメール)・協力業者・仕入先 (取引先のメール) なら、やりとり履歴 (channel = email・受信) にも残し、その店舗に知らせる
 * - そのほか (未登録の差出人・社員) は通知の一覧だけ (本部・管理者)。迷惑メールを問い合わせにしないため、問い合わせは自動では作らない
 * - 自動送信・メールマガジン (Auto-Submitted・Precedence: bulk/list・List-Id・List-Unsubscribe) は bulk = 一覧だけ (ベルに出さない)
 * - 自分のアドレスから届いたメール (システムの送信の控えなど) は記録しない
 */

export interface MailLike {
  fromAddress?: string;
  fromName?: string;
  subject?: string;
  text?: string;
  /** 送信日時 (ISO。なければ受け取った日時) */
  date?: string;
  autoSubmitted?: string;
  precedence?: string;
  listId?: boolean;
  listUnsubscribe?: boolean;
}

const SYSTEM_USER = "system";

/** 自動送信・メールマガジンか */
export function isBulkMail(m: Pick<MailLike, "autoSubmitted" | "precedence" | "listId" | "listUnsubscribe">): boolean {
  const auto = (m.autoSubmitted ?? "").trim().toLowerCase();
  if (auto && auto !== "no") return true;
  if (/^(bulk|list|junk|auto_reply)$/i.test((m.precedence ?? "").trim())) return true;
  return Boolean(m.listId || m.listUnsubscribe);
}

/** 本文から引用 (> の行)・前のメールの全文 (「-----Original Message-----」「〜 wrote:」「〜 のメッセージ:」以下) を外す */
export function mailBodyText(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const l = line.trim();
    if (/^-{2,}\s*(original message|元のメッセージ|転送されたメッセージ|forwarded message)/i.test(l)) break;
    // 返信の前の行: 「On … wrote:」「… さんは書きました:」「2026年11月25日(水) 10:00 名前 <アドレス>:」(Gmail)・「2026/11/25 10:00, 名前 wrote:」
    if (/^on .{4,200} wrote:$/i.test(l) || /^.{4,120}(さんは書きました|wrote)[:：]$/.test(l) || /^20\d{2}[/年-].{2,80}(書きました|のメッセージ)[:：]?$/.test(l) || /^20\d{2}[/年-].{2,160}<[^<>\s]+@[^<>\s]+>\s*[:：]$/.test(l)) break;
    if (/^>/.test(l)) continue;
    out.push(line.replace(/\s+$/, ""));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * 1 通を記録する。id = 通知の ID (mail_<UIDVALIDITY>_<UID>)、at = 受け取った日時 (IMAP の INTERNALDATE)。
 * selfAddresses = このシステムが送るときのアドレス (MAIL_FROM・SMTP_USER)
 */
export function recordMail(db: Database, m: MailLike, meta: { id: string; at: string; selfAddresses?: string[] }): "recorded" | "duplicate" | "self" {
  const addr = (m.fromAddress ?? "").trim().toLowerCase();
  if (addr && (meta.selfAddresses ?? []).some((a) => a.trim().toLowerCase() === addr)) return "self";
  const logId = `cl_${meta.id}`;
  if (db.commLogs.some((c) => c.id === logId) || (db.settings.find((s) => s.id === "inbound_feed")?.value as { items?: { id: string }[] } | undefined)?.items?.some((i) => i.id === meta.id)) return "duplicate";
  const customer = addr ? db.customers.find((c) => (c.email ?? "").trim().toLowerCase() === addr) : undefined;
  const supplier = !customer && addr ? db.suppliers.find((s) => (s.email ?? "").trim().toLowerCase() === addr) : undefined;
  const staff = !customer && !supplier && addr ? db.users.find((u) => u.email.toLowerCase() === addr || (u.notifyEmail ?? "").toLowerCase() === addr) : undefined;
  const subject = (m.subject ?? "").trim() || "(件名なし)";
  const body = mailBodyText(m.text ?? "") || "(本文なし)";
  const bulk = isBulkMail(m);
  const storeId = customer?.storeId ?? "hq";
  const senderName = (m.fromName ?? "").trim();
  if ((customer || supplier) && !bulk) {
    db.commLogs.push({
      id: logId,
      customerId: customer?.id,
      supplierId: supplier?.id,
      storeId,
      channel: "email",
      direction: "inbound",
      subject: `メール: ${subject}`.slice(0, 200),
      body: body.slice(0, 8000),
      at: meta.at,
      userId: SYSTEM_USER,
      contactName: senderName || undefined,
    });
    addAudit(db, { userId: SYSTEM_USER, action: "create", entity: "comm", entityId: logId, entityLabel: customer?.name ?? supplier?.name ?? "", summary: `メールを受信 (${customer ? `お客様: ${customer.name}` : `協力業者・仕入先: ${supplier!.name}`} · ${subject.slice(0, 40)})`, storeId });
  }
  addInbound(db, {
    id: meta.id,
    channel: "email",
    at: meta.at,
    from: customer ? `${customer.name} 様` : supplier ? supplier.name : staff ? `${staff.name} (社員)` : senderName || addr || "差出人不明",
    fromDetail: addr || undefined,
    subject,
    text: body,
    storeId,
    href: customer ? `/customers/${customer.id}` : supplier ? `/suppliers/${supplier.id}` : undefined,
    ref: customer ? "お客様" : supplier ? "協力業者・仕入先" : staff ? "社員" : bulk ? "自動送信・メールマガジン" : "未登録の差出人",
    bulk: bulk || undefined,
  });
  return "recorded";
}
