import "server-only";
import nodemailer, { type Transporter } from "nodemailer";
import { chatworkConfig, lineConfig, mailConfig, type MailConfig } from "./config";

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

/* ---------------- SMTP (会社のメールアカウント) ---------------- */

type SmtpConfig = Extract<MailConfig, { provider: "smtp" }>;
const g = globalThis as typeof globalThis & { __ichijoyaSmtp?: { key: string; transporter: Transporter } };

/** 接続を使い回す (設定が変わったら作り直す) */
function smtpTransport(cfg: SmtpConfig): Transporter {
  const key = `${cfg.host}:${cfg.port}:${cfg.secure}:${cfg.user}:${cfg.pass.length}`;
  if (g.__ichijoyaSmtp?.key === key) return g.__ichijoyaSmtp.transporter;
  g.__ichijoyaSmtp?.transporter.close();
  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    // 587 (STARTTLS) のときも暗号化なしでは送らない
    requireTLS: !cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    pool: true,
    maxConnections: 2,
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: 30_000,
  });
  g.__ichijoyaSmtp = { key, transporter };
  return transporter;
}

function smtpError(err: unknown): string {
  const e = err as { code?: string; responseCode?: number; response?: string; message?: string };
  if (e.code === "EAUTH") return "SMTP の認証に失敗しました (SMTP_USER・SMTP_PASSWORD を確認してください)";
  if (e.code === "ETIMEDOUT" || e.code === "ECONNECTION" || e.code === "ESOCKET" || e.code === "EDNS") return `SMTP サーバーに接続できませんでした (${e.code}: ${(e.message ?? "").slice(0, 120)})`;
  if (e.responseCode) return `SMTP ${e.responseCode}: ${(e.response ?? e.message ?? "").slice(0, 200)}`;
  return `送信できませんでした: ${(e.message ?? String(err)).slice(0, 200)}`;
}

async function sendSmtp(cfg: SmtpConfig, p: { to: string; subject: string; text: string; attachments?: MailAttachment[] }): Promise<SendResult> {
  try {
    const info = await smtpTransport(cfg).sendMail({
      from: cfg.from,
      to: p.to,
      subject: p.subject,
      text: p.text,
      attachments: p.attachments?.map((a) => ({ filename: a.filename, content: Buffer.from(a.base64, "base64"), contentType: a.contentType })),
    });
    if (info.rejected?.length) return { ok: false, error: `受け付けられなかった宛先: ${info.rejected.map(String).join(", ")}` };
    return { ok: true, providerId: info.messageId };
  } catch (err) {
    return { ok: false, error: smtpError(err) };
  }
}

/** メールの接続の確認 (SMTP はログインまで。送信はしない) */
export async function verifyMail(): Promise<{ ok: boolean; lines: string[] }> {
  const cfg = mailConfig();
  if (!cfg) return { ok: false, lines: ["メールの送信設定がありません (SMTP_HOST・SMTP_USER・SMTP_PASSWORD)。"] };
  if (cfg.provider !== "smtp") return { ok: true, lines: [`${cfg.provider === "resend" ? "Resend" : "SendGrid"} · 送信元 ${cfg.from} (接続の確認はテスト送信で行ってください)`] };
  const lines = [`SMTP: ${cfg.host}:${cfg.port} (${cfg.secure ? "SSL/TLS" : "STARTTLS"}) · アカウント ${cfg.user} · 送信元 ${cfg.from}`];
  const fromAddr = parseAddress(cfg.from).email.toLowerCase();
  if (fromAddr.split("@")[1] !== cfg.user.toLowerCase().split("@")[1]) lines.push(`⚠ 送信元 (${fromAddr}) のドメインがアカウントと違います。届かないことがあります。`);
  try {
    await smtpTransport(cfg).verify();
    lines.push("ログインできました (送信の準備ができています)。届くかどうかは「テスト送信」で確かめてください。");
    return { ok: true, lines };
  } catch (err) {
    lines.push(smtpError(err));
    return { ok: false, lines };
  }
}

export async function sendEmail(p: { to: string; subject: string; text: string; attachments?: MailAttachment[] }): Promise<SendResult> {
  const cfg = mailConfig();
  if (!cfg) return { ok: false, skipped: true };
  if (!isEmail(p.to)) return { ok: false, error: "メールアドレスの形が正しくありません" };
  if (cfg.provider === "smtp") return sendSmtp(cfg, p);
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

/** LINE の送り先: ユーザー ID (U…)・グループ ID (C…)・複数人トーク ID (R…) */
export const isLineTarget = (v: string | undefined): v is string => Boolean(v && /^[UCR][0-9a-f]{32}$/.test(v));

/** LINE のプッシュメッセージ (テキスト 1 通。5,000 文字まで) */
export async function sendLine(p: { to: string; text: string }): Promise<SendResult> {
  const cfg = lineConfig();
  if (!cfg) return { ok: false, skipped: true };
  if (!isLineTarget(p.to)) return { ok: false, error: "LINE の送り先 (U で始まるユーザー ID、または C・R で始まるグループの ID。33 文字) が正しくありません" };
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
