import "server-only";
import { createHash } from "node:crypto";

/**
 * 外部への送信・外部からの受信の設定 (環境変数。値は画面に出さない)
 * ------------------------------------------------------------
 * メール:   RESEND_API_KEY (Resend) または SENDGRID_API_KEY (SendGrid) と MAIL_FROM (送信元。例: 一畳屋 <info@example.co.jp>)
 * LINE:     LINE_CHANNEL_ACCESS_TOKEN (送信) / LINE_CHANNEL_SECRET (受信の署名の確認)
 * Chatwork: CHATWORK_API_TOKEN (送信) / CHATWORK_ROOM_ID (社内通知のルーム) / CHATWORK_WEBHOOK_TOKEN (受信の署名の確認)
 * Web フォーム: WEBFORM_SECRET (受信の共有鍵)
 * 画面へのリンク: APP_BASE_URL (例: https://ichijoyasystem.vercel.app)。未設定なら Vercel の URL
 * 接続先の URL (*_API_BASE) は検証用に差し替えられる (通常は設定しない)
 * 設定がないサービスは送らずに「記録のみ」として送信履歴に残す (src/lib/notify/send.ts)
 */

const env = (name: string) => (process.env[name] ?? "").trim().replace(/^["']|["']$/g, "");

export type MailProvider = "resend" | "sendgrid";

export function mailConfig(): { provider: MailProvider; apiKey: string; from: string; base: string } | null {
  const from = env("MAIL_FROM");
  const resend = env("RESEND_API_KEY");
  if (resend && from) return { provider: "resend", apiKey: resend, from, base: env("RESEND_API_BASE") || "https://api.resend.com" };
  const sendgrid = env("SENDGRID_API_KEY");
  if (sendgrid && from) return { provider: "sendgrid", apiKey: sendgrid, from, base: env("SENDGRID_API_BASE") || "https://api.sendgrid.com" };
  return null;
}

export function lineConfig(): { token: string; base: string } | null {
  const token = env("LINE_CHANNEL_ACCESS_TOKEN");
  return token ? { token, base: env("LINE_API_BASE") || "https://api.line.me" } : null;
}

export function lineSecret(): string | null {
  return env("LINE_CHANNEL_SECRET") || null;
}

export function chatworkConfig(): { token: string; roomId: string; base: string } | null {
  const token = env("CHATWORK_API_TOKEN");
  return token ? { token, roomId: env("CHATWORK_ROOM_ID"), base: env("CHATWORK_API_BASE") || "https://api.chatwork.com/v2" } : null;
}

export function chatworkWebhookToken(): string | null {
  return env("CHATWORK_WEBHOOK_TOKEN") || null;
}

export function webformSecret(): string | null {
  return env("WEBFORM_SECRET") || null;
}

/** 既存の AI システム (AI テキスト相談・AI 音声相談・AI 電話受付) からの受信の共有鍵 */
export function aiIntakeSecret(): string | null {
  return env("AI_INTAKE_SECRET") || null;
}

/** 通知・送付文に入れる画面の URL の先頭 (末尾の / なし) */
export function appBaseUrl(): string {
  const v = env("APP_BASE_URL") || (env("VERCEL_PROJECT_PRODUCTION_URL") ? `https://${env("VERCEL_PROJECT_PRODUCTION_URL")}` : env("VERCEL_URL") ? `https://${env("VERCEL_URL")}` : "http://localhost:3000");
  return v.replace(/\/+$/, "");
}

/** 共有リンク (見積書・請求書の PDF をログインなしで開くリンク) の署名鍵。セッションと同じ秘密情報から別の用途の鍵を導く */
export function linkSecret(): string {
  const base = env("SESSION_SECRET") || (env("SUPABASE_SECRET_KEY") ? `supabase:${env("SUPABASE_SECRET_KEY")}` : "ichijoya-demo-secret");
  return createHash("sha256").update(`ichijoya-doc-link:${base}`).digest("base64url");
}

export interface IntegrationStatus {
  key: "email" | "line" | "chatwork" | "webform" | "ai_intake";
  name: string;
  configured: boolean;
  detail: string;
  /** 受信 (Webhook) の設定 */
  inbound?: { configured: boolean; path: string; detail: string };
}

/** 設定画面に出す接続の状態 (値は出さない) */
export function integrationStatuses(): IntegrationStatus[] {
  const mail = mailConfig();
  const line = lineConfig();
  const cw = chatworkConfig();
  return [
    {
      key: "email",
      name: "メール (見積書・請求書の送付・社内通知)",
      configured: Boolean(mail),
      detail: mail ? `${mail.provider === "resend" ? "Resend" : "SendGrid"} · 送信元 ${mail.from}` : "RESEND_API_KEY または SENDGRID_API_KEY と MAIL_FROM を設定すると送信します",
    },
    {
      key: "line",
      name: "LINE 公式アカウント (Messaging API)",
      configured: Boolean(line),
      detail: line ? "送信の設定あり (LINE_CHANNEL_ACCESS_TOKEN)" : "LINE_CHANNEL_ACCESS_TOKEN を設定すると、お客様・協力業者へ LINE で送れます (相手の LINE ユーザー ID が必要)",
      inbound: { configured: Boolean(lineSecret()), path: "/api/integrations/line", detail: lineSecret() ? "受信の署名確認の設定あり (LINE_CHANNEL_SECRET)" : "LINE_CHANNEL_SECRET を設定すると、受信したメッセージをやりとり履歴・問い合わせに登録します" },
    },
    {
      key: "chatwork",
      name: "Chatwork",
      configured: Boolean(cw),
      detail: cw ? `送信の設定あり${cw.roomId ? ` · 社内通知のルーム ${cw.roomId}` : " · 社内通知のルーム (CHATWORK_ROOM_ID) は未設定"}` : "CHATWORK_API_TOKEN を設定すると、協力業者のルームへの連絡と社内ルームへの通知を送ります",
      inbound: { configured: Boolean(chatworkWebhookToken()), path: "/api/integrations/chatwork", detail: chatworkWebhookToken() ? "受信の署名確認の設定あり (CHATWORK_WEBHOOK_TOKEN)" : "CHATWORK_WEBHOOK_TOKEN を設定すると、協力業者のルームの投稿をやりとり履歴に登録します" },
    },
    {
      key: "webform",
      name: "Web サイトのお問い合わせフォーム",
      configured: Boolean(webformSecret()),
      detail: webformSecret() ? "受信の共有鍵の設定あり (WEBFORM_SECRET)" : "WEBFORM_SECRET を設定すると、フォームの送信を問い合わせとして登録します",
      inbound: { configured: Boolean(webformSecret()), path: "/api/integrations/webform", detail: "POST (JSON)。ヘッダー Authorization: Bearer <WEBFORM_SECRET>" },
    },
    {
      key: "ai_intake",
      name: "既存の AI システム (AI テキスト相談・AI 音声相談・AI 電話受付)",
      configured: Boolean(aiIntakeSecret()),
      detail: aiIntakeSecret() ? "受信の共有鍵の設定あり (AI_INTAKE_SECRET)" : "AI_INTAKE_SECRET を設定すると、各 AI システムの受付を問い合わせとして登録し、担当者に引き継ぎます",
      inbound: { configured: Boolean(aiIntakeSecret()), path: "/api/integrations/ai-intake?source=phone", detail: "POST (JSON)。ヘッダー Authorization: Bearer <AI_INTAKE_SECRET>。source は chat / voice / phone" },
    },
  ];
}
