import "server-only";
import { createHash } from "node:crypto";
import { faxConnection, faxLocalNumber, faxWebhookSecret } from "@/lib/fax/adapter";

/**
 * 外部への送信・外部からの受信の設定 (環境変数。値は画面に出さない)
 * ------------------------------------------------------------
 * メール:   SMTP_HOST・SMTP_PORT (465)・SMTP_USER・SMTP_PASSWORD (会社のメールアカウント。優先)、
 *           または RESEND_API_KEY (Resend) / SENDGRID_API_KEY (SendGrid)。MAIL_FROM (送信元。例: 株式会社一畳屋 <info@ichijoya.co.jp>)
 * LINE:     LINE_CHANNEL_ACCESS_TOKEN (送信) / LINE_CHANNEL_SECRET (受信の署名の確認)
 * Chatwork: CHATWORK_API_TOKEN (送信) / CHATWORK_ROOM_ID (社内通知のルーム) / CHATWORK_WEBHOOK_TOKEN (受信の署名の確認。ルームごとのトークンをカンマ区切り) / CHATWORK_SELF_ACCOUNT_ID (連携用アカウントの ID。自分の投稿を受信に数えない)
 * Web フォーム: WEBFORM_SECRET (受信の共有鍵)
 * 画面へのリンク: APP_BASE_URL (例: https://ichijoyasystem.vercel.app)。未設定なら Vercel の URL
 * 接続先の URL (*_API_BASE) は検証用に差し替えられる (通常は設定しない)
 * 設定がないサービスは送らずに「記録のみ」として送信履歴に残す (src/lib/notify/send.ts)
 */

const env = (name: string) => (process.env[name] ?? "").trim().replace(/^["']|["']$/g, "");

export type MailProvider = "smtp" | "resend" | "sendgrid";

export type MailConfig =
  | { provider: "smtp"; host: string; port: number; secure: boolean; user: string; pass: string; from: string }
  | { provider: "resend" | "sendgrid"; apiKey: string; from: string; base: string };

/**
 * メールの送信設定。SMTP (会社のメールアカウント。例: Xserver の sv***.xserver.jp) があればそれを使い、
 * なければ Resend → SendGrid の順。SMTP の送信元 (MAIL_FROM) は SMTP_USER と同じドメインにする (違うと届かないことがある)
 */
export function mailConfig(): MailConfig | null {
  const host = env("SMTP_HOST");
  const user = env("SMTP_USER");
  const pass = env("SMTP_PASSWORD");
  if (host && user && pass) {
    const port = Number(env("SMTP_PORT")) || 465;
    const secureEnv = env("SMTP_SECURE").toLowerCase();
    // 465 は最初から SSL/TLS、587 は STARTTLS (secure=false のあとで暗号化する)
    const secure = secureEnv ? !["false", "0", "off", "no"].includes(secureEnv) : port === 465;
    return { provider: "smtp", host, port, secure, user, pass, from: env("MAIL_FROM") || user };
  }
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

/** LINE の写真・ファイルの本体を取得する接続先 */
export function lineDataBase(): string {
  return env("LINE_DATA_API_BASE") || "https://api-data.line.me";
}

/** LINE の Webhook URL (このシステムの受信先) */
export function lineWebhookUrl(): string {
  return `${appBaseUrl()}/api/integrations/line`;
}

export function chatworkConfig(): { token: string; roomId: string; base: string } | null {
  const token = env("CHATWORK_API_TOKEN");
  return token ? { token, roomId: env("CHATWORK_ROOM_ID"), base: env("CHATWORK_API_BASE") || "https://api.chatwork.com/v2" } : null;
}

/**
 * Chatwork の Webhook のトークン。Chatwork の Webhook はルームごとに作り、トークンもルームごとに違うため、
 * 複数のルームを受信するときはカンマ (または空白) で区切って並べる
 */
export function chatworkWebhookTokens(): string[] {
  return [...new Set(env("CHATWORK_WEBHOOK_TOKEN").split(/[\s,]+/).filter(Boolean))];
}

export function chatworkWebhookToken(): string | null {
  return chatworkWebhookTokens()[0] ?? null;
}

export function webformSecret(): string | null {
  return env("WEBFORM_SECRET") || null;
}

/** 既存の AI システム (AI テキスト相談・AI 音声相談・AI 電話受付) からの受信の共有鍵 */
export function aiIntakeSecret(): string | null {
  return env("AI_INTAKE_SECRET") || null;
}

/** 電話のシステム (録音・文字起こしのできるクラウド電話など) から通話の内容を受け取る共有鍵 (/api/integrations/phone-call) */
export function phoneIntakeSecret(): string | null {
  return env("PHONE_INTAKE_SECRET") || null;
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
  key: "email" | "line" | "chatwork" | "webform" | "ai_intake" | "fax";
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
      detail: mail ? `${mail.provider === "smtp" ? `SMTP ${mail.host}:${mail.port} (${mail.user})` : mail.provider === "resend" ? "Resend" : "SendGrid"} · 送信元 ${mail.from}` : "SMTP_HOST・SMTP_USER・SMTP_PASSWORD (会社のメールアカウント) か、RESEND_API_KEY / SENDGRID_API_KEY と MAIL_FROM を設定すると送信します",
    },
    {
      key: "line",
      name: "LINE 公式アカウント (Messaging API)",
      configured: Boolean(line),
      detail: line ? "送信の設定あり (LINE_CHANNEL_ACCESS_TOKEN)" : "LINE_CHANNEL_ACCESS_TOKEN を設定すると、お客様・協力業者へ LINE で送れます (相手の LINE ユーザー ID が必要)",
      inbound: { configured: Boolean(lineSecret()), path: "/api/integrations/line", detail: lineSecret() ? "受信の署名確認の設定あり (LINE_CHANNEL_SECRET)。1 対 1 のメッセージ・現場のグループのメッセージ・写真・資料を登録します" : "LINE_CHANNEL_SECRET を設定すると、受信したメッセージ (1 対 1・グループ) をやりとり履歴・問い合わせに登録します" },
    },
    {
      key: "chatwork",
      name: "Chatwork",
      configured: Boolean(cw),
      detail: cw ? `送信の設定あり${cw.roomId ? ` · 社内通知のルーム ${cw.roomId}` : " · 社内通知のルーム (CHATWORK_ROOM_ID) は未設定"}` : "CHATWORK_API_TOKEN を設定すると、協力業者のルームへの連絡と社内ルームへの通知を送ります",
      inbound: { configured: chatworkWebhookTokens().length > 0, path: "/api/integrations/chatwork", detail: chatworkWebhookTokens().length ? `受信の署名確認の設定あり (CHATWORK_WEBHOOK_TOKEN: Webhook ${chatworkWebhookTokens().length} 件)` : "CHATWORK_WEBHOOK_TOKEN を設定すると、協力業者のルームの投稿をやりとり履歴に登録します (Webhook はルームごと。トークンはカンマ区切りで複数)" },
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
    faxStatusItem(),
  ];
}

/** クラウド FAX (src/lib/fax/adapter.ts) */
function faxStatusItem(): IntegrationStatus {
  const c = faxConnection();
  const local = faxLocalNumber();
  return {
    key: "fax",
    name: "クラウド FAX (発注書の送信・受信 FAX の取り込み)",
    configured: c.mode === "live" || c.mode === "mock",
    detail: `${c.label}${local ? ` · 自社の FAX 番号 ${local}` : ""} · ${c.detail}`,
    inbound: { configured: (c.mode === "live" || c.mode === "mock") && Boolean(faxWebhookSecret()), path: "/api/integrations/fax", detail: "FAX サービスからの受信・送信の状態の通知 (形式と署名は FAX サービスごと。FAX_WEBHOOK_SECRET)" },
  };
}
