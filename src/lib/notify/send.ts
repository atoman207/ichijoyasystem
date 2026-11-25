import "server-only";
import type { Database, Delivery, DeliveryChannel } from "@/lib/db/types";
import { mutate, newId, nowIso } from "@/lib/db/store";
import { sendChatwork, sendEmail, sendLine, type MailAttachment, type SendResult } from "./channels";
import { chatworkConfig } from "./config";
import { pushLater } from "./push";

/**
 * 送信して送信履歴 (deliveries) に残す
 * ------------------------------------------------------------
 * - 業務の記録 (見積の送付・承認など) を保存した後に呼ぶ。送信に失敗しても業務の記録は取り消さない
 * - 設定がないサービスは送らずに status = skipped (記録のみ) で残す
 * - 送信は並列。1 件ずつの結果を返す
 */

export interface Outgoing {
  /** push = スマートフォン・パソコンのプッシュ通知 (src/lib/notify/push.ts。送信履歴には残さない) */
  channel: DeliveryChannel | "push";
  /** メールアドレス / LINE のユーザー ID / Chatwork のルーム ID (空なら社内通知のルーム) / プッシュ通知は社員の ID */
  to: string;
  toLabel?: string;
  subject?: string;
  body: string;
  attachments?: MailAttachment[];
  purpose: Delivery["purpose"];
  relatedType?: Delivery["relatedType"];
  relatedId?: string;
  /** プッシュ通知を押したときに開く画面 (同じサイトの中のパス) */
  link?: string;
  /** プッシュ通知: 自分あての優先の通知 (業務依頼・メンション) */
  priority?: boolean;
}

type Sendable = Outgoing & { channel: DeliveryChannel };

async function sendOne(o: Sendable): Promise<SendResult> {
  if (o.channel === "email") return sendEmail({ to: o.to, subject: o.subject ?? "", text: o.body, attachments: o.attachments });
  if (o.channel === "line") return sendLine({ to: o.to, text: o.subject ? `${o.subject}\n\n${o.body}` : o.body });
  return sendChatwork({ roomId: o.to || undefined, body: o.subject ? `[info][title]${o.subject}[/title]${o.body}[/info]` : o.body });
}

/** 送信して、保存前の送信履歴を返す */
export async function dispatch(items: Sendable[], userId: string): Promise<Delivery[]> {
  const results = await Promise.all(items.map((o) => sendOne(o).catch((err): SendResult => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))));
  return items.map((o, i) => {
    const r = results[i];
    const recipient = o.channel === "chatwork" && !o.to ? (chatworkConfig()?.roomId ?? "") || "(社内通知のルーム)" : o.to;
    return {
      id: newId("dlv"),
      channel: o.channel,
      recipient,
      recipientLabel: o.toLabel,
      subject: o.subject,
      body: o.body.slice(0, 8000),
      attachments: o.attachments?.length ? o.attachments.map((a) => a.filename) : undefined,
      status: r.ok ? "sent" : r.skipped ? "skipped" : "failed",
      error: r.ok || r.skipped ? undefined : r.error,
      purpose: o.purpose,
      relatedType: o.relatedType,
      relatedId: o.relatedId,
      userId,
      createdAt: nowIso(),
    } satisfies Delivery;
  });
}

/**
 * 送信して記録する。after で同じ書き込みの中に関連の記録 (やりとり履歴など) を足せる。
 * 送信履歴の表がまだないとき (テーブル定義の反映前) は、送信だけ行い記録の失敗は無視する
 */
export async function sendAndRecord(all: Outgoing[], userId: string, after?: (db: Database, deliveries: Delivery[]) => void): Promise<Delivery[]> {
  // プッシュ通知は応答のあとに送り、送信履歴には残さない (本文を管理者が見られる記録に重ねて残さない。端末ごとの結果は push.ts)
  const pushes = all.filter((o) => o.channel === "push");
  if (pushes.length) {
    const groups = new Map<string, { userIds: string[]; payload: { title: string; body: string; url: string; tag?: string; priority?: boolean } }>();
    for (const o of pushes) {
      const k = `${o.subject}\u0000${o.body}\u0000${o.link}`;
      const gr = groups.get(k) ?? { userIds: [], payload: { title: o.subject ?? "一畳屋", body: o.body, url: o.link || "/chat", tag: o.relatedId ? `${o.relatedType ?? "n"}-${o.relatedId}` : undefined, priority: o.priority } };
      gr.userIds.push(o.to);
      groups.set(k, gr);
    }
    pushLater([...groups.values()]);
  }
  const items = all.filter((o): o is Sendable => o.channel !== "push");
  if (!items.length) return [];
  const deliveries = await dispatch(items, userId);
  try {
    await mutate((db) => {
      db.deliveries.push(...deliveries);
      after?.(db, deliveries);
    });
  } catch (err) {
    console.warn("[notify] could not record deliveries:", err instanceof Error ? err.message : err);
    // 送信履歴を残せなくても、業務の記録 (やりとり履歴など) は残す
    if (after) await mutate((db) => after(db, deliveries)).catch((e) => console.warn("[notify] could not record related rows:", e instanceof Error ? e.message : e));
  }
  return deliveries;
}

/** 結果の短い説明 (画面のメッセージ用) */
export function deliverySummary(d: Delivery[]): string {
  const sent = d.filter((x) => x.status === "sent").length;
  const failed = d.filter((x) => x.status === "failed");
  const skipped = d.filter((x) => x.status === "skipped").length;
  const parts: string[] = [];
  if (sent) parts.push(`${sent} 件を送信しました`);
  if (skipped) parts.push(`${skipped} 件は送信の設定がないため記録のみです`);
  if (failed.length) parts.push(`${failed.length} 件は送信に失敗しました (${failed[0].error ?? "原因不明"})`);
  return parts.join("。");
}
