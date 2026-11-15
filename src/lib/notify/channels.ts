import "server-only";
import { chatworkConfig, lineConfig, mailConfig } from "./config";

/**
 * 外部サービスへの送信 (メール・LINE・Chatwork)。ここでは送るだけで、記録は send.ts が行う
 * - 設定がないときは { skipped: true } を返す (送らない)
 * - 失敗は例外にせず { ok: false, error } を返す (業務の操作は止めない)
 */

export interface SendResult {
  ok: boolean;
  skipped?: boolean;
  error?: string;
  providerId?: string;
}

export interface MailAttachment {
  filename: string;
  contentType: string;
  /** 本体 (base64) */
  base64: string;
}

const TIMEOUT_MS = 15_000;

async function readError(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const msg = j.message ?? (Array.isArray(j.errors) ? (j.errors as { message?: string }[]).map((e) => e.message).join(" / ") : undefined) ?? j.error;
    return `HTTP ${res.status}${msg ? `: ${String(msg).slice(0, 300)}` : ""}`;
  } catch {
    return `HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ""}`;
  }
}

function networkError(err: unknown): string {
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return "送信先が時間内に応答しませんでした";
  return err instanceof Error ? `送信できませんでした: ${err.message}` : "送信できませんでした";
}

/** 「名前 <address>」を分ける */
export function parseAddress(v: string): { email: string; name?: string } {
  const m = v.match(/^\s*(.*?)\s*<\s*([^>]+)\s*>\s*$/);
  return m ? { email: m[2], name: m[1].replace(/^"|"$/g, "") || undefined } : { email: v.trim() };
}

export const isEmail = (v: string | undefined): v is string => Boolean(v && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(v.trim()));

export async function sendEmail(p: { to: string; subject: string; text: string; attachments?: MailAttachment[] }): Promise<SendResult> {
  const cfg = mailConfig();
  if (!cfg) return { ok: false, skipped: true };
  if (!isEmail(p.to)) return { ok: false, error: "メールアドレスの形が正しくありません" };
  try {
    if (cfg.provider === "resend") {
      const res = await fetch(`${cfg.base}/emails`, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: cfg.from,
          to: [p.to],
          subject: p.subject,
          text: p.text,
          ...(p.attachments?.length ? { attachments: p.attachments.map((a) => ({ filename: a.filename, content: a.base64, content_type: a.contentType })) } : {}),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) return { ok: false, error: await readError(res) };
      const j = (await res.json().catch(() => ({}))) as { id?: string };
      return { ok: true, providerId: j.id };
    }
    const from = parseAddress(cfg.from);
    const res = await fetch(`${cfg.base}/v3/mail/send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: p.to }] }],
        from: { email: from.email, ...(from.name ? { name: from.name } : {}) },
        subject: p.subject,
        content: [{ type: "text/plain", value: p.text }],
        ...(p.attachments?.length ? { attachments: p.attachments.map((a) => ({ content: a.base64, filename: a.filename, type: a.contentType, disposition: "attachment" })) } : {}),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, error: await readError(res) };
    return { ok: true, providerId: res.headers.get("x-message-id") ?? undefined };
  } catch (err) {
    return { ok: false, error: networkError(err) };
  }
}

/** LINE のプッシュメッセージ (テキスト 1 通。5,000 文字まで) */
export async function sendLine(p: { to: string; text: string }): Promise<SendResult> {
  const cfg = lineConfig();
  if (!cfg) return { ok: false, skipped: true };
  if (!/^U[0-9a-f]{32}$/.test(p.to)) return { ok: false, error: "LINE のユーザー ID (U で始まる 33 文字) が正しくありません" };
  try {
    const res = await fetch(`${cfg.base}/v2/bot/message/push`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ to: p.to, messages: [{ type: "text", text: p.text.slice(0, 5000) }] }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, error: await readError(res) };
    return { ok: true, providerId: res.headers.get("x-line-request-id") ?? undefined };
  } catch (err) {
    return { ok: false, error: networkError(err) };
  }
}

/** Chatwork のルームへ投稿 (roomId 省略時は社内通知のルーム) */
export async function sendChatwork(p: { roomId?: string; body: string }): Promise<SendResult> {
  const cfg = chatworkConfig();
  if (!cfg) return { ok: false, skipped: true };
  const roomId = p.roomId || cfg.roomId;
  if (!roomId) return { ok: false, skipped: true };
  if (!/^\d+$/.test(roomId)) return { ok: false, error: "Chatwork のルーム ID (数字) が正しくありません" };
  try {
    const res = await fetch(`${cfg.base}/rooms/${roomId}/messages`, {
      method: "POST",
      headers: { "X-ChatWorkToken": cfg.token, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ body: p.body.slice(0, 10000) }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, error: await readError(res) };
    const j = (await res.json().catch(() => ({}))) as { message_id?: string };
    return { ok: true, providerId: j.message_id };
  } catch (err) {
    return { ok: false, error: networkError(err) };
  }
}
