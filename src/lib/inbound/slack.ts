import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Database, StoreId } from "@/lib/db/types";
import { addInbound, inboundSettings, setSlackNames, slackNames, touchSlackChannel } from "@/lib/inbound/feed";

/**
 * Slack の受信 (Events API。お客様のご要望 2026-11-26「Slack で送信されたメッセージを通知として表示」)
 * ------------------------------------------------------------
 * - Slack のアプリ (api.slack.com/apps) の Event Subscriptions の Request URL に https://<このシステム>/api/integrations/slack を設定し、
 *   Bot Events に message.channels・message.groups・message.im (と app_mention) を足して、アプリを通知したいチャンネルに招待する
 * - 署名の確認: SLACK_SIGNING_SECRET (アプリの Basic Information → Signing Secret)。X-Slack-Signature = v0= + HMAC-SHA256(v0:時刻:本文)。5 分より古い要求は断る
 * - 送り主・チャンネルの名前: SLACK_BOT_TOKEN (xoxb-…。users:read・channels:read・groups:read) があれば、受信のあとで取得して控える (なくても受信はできる)
 * - 知らせる店舗は 設定 → 外部連携・AI の「Slack のチャンネル」で決める (決めていないチャンネル・DM は本部・管理者だけ)
 * - 記録は通知の一覧 (src/lib/inbound/feed.ts) だけ。Slack のメッセージはやりとり履歴には入れない (お客様との連絡ではないため)
 */

const env = (name: string) => (process.env[name] ?? "").trim().replace(/^["']|["']$/g, "");
export const slackSigningSecret = () => env("SLACK_SIGNING_SECRET") || null;
export const slackBotToken = () => env("SLACK_BOT_TOKEN") || null;
const slackApiBase = () => (env("SLACK_API_BASE") || "https://slack.com/api").replace(/\/+$/, "");

/** Slack の署名を確かめる (時刻のずれは 5 分まで) */
export function verifySlackSignature(secret: string, raw: string, timestamp: string | null, signature: string | null, now = Date.now()): boolean {
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const expected = Buffer.from(`v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${raw}`).digest("hex")}`);
  const given = Buffer.from(signature.trim());
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export interface SlackEventBody {
  type?: string;
  challenge?: string;
  event_id?: string;
  team_id?: string;
  authorizations?: { user_id?: string; is_bot?: boolean }[];
  event?: {
    type?: string;
    subtype?: string;
    channel?: string;
    channel_type?: string;
    user?: string;
    bot_id?: string;
    text?: string;
    ts?: string;
    thread_ts?: string;
    files?: { name?: string; title?: string }[];
  };
}

/** Slack の書式 (<@U123>・<#C123|名前>・<https://…|文字>・&amp;) を読める文字にする */
export function slackPlainText(text: string, users: Record<string, string> = {}): string {
  return text
    .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]+))?>/g, (_m, id: string, label?: string) => `@${users[id] ?? label ?? id}`)
    .replace(/<#([CG][A-Z0-9]+)\|([^>]*)>/g, (_m, _id: string, name: string) => `#${name}`)
    .replace(/<!(here|channel|everyone)>/g, (_m, w: string) => `@${w}`)
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<(https?:\/\/[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** 通知にしないメッセージの種類 (編集・削除・参加・退出・ボットの投稿など)。ファイルの共有とスレッドの「チャンネルにも投稿」は通知する */
const KEEP_SUBTYPES = new Set(["file_share", "thread_broadcast"]);

/**
 * Events API の 1 件を通知の一覧に足す (mutate の中で呼ぶ)。足したら名前を取得する ID を返す
 */
export function recordSlackEvent(db: Database, body: SlackEventBody): { recorded: boolean; user?: string; channel?: string } {
  const ev = body.event;
  if (body.type !== "event_callback" || !ev || (ev.type !== "message" && ev.type !== "app_mention")) return { recorded: false };
  if (ev.subtype && !KEEP_SUBTYPES.has(ev.subtype)) return { recorded: false };
  if (ev.bot_id) return { recorded: false };
  const channel = String(ev.channel ?? "");
  const ts = String(ev.ts ?? "");
  if (!/^[CGD][A-Z0-9]+$/.test(channel) || !/^\d+\.\d+$/.test(ts)) return { recorded: false };
  // 自分 (このアプリのボット) の投稿は数えない
  const self = (body.authorizations ?? []).find((a) => a.is_bot)?.user_id;
  if (self && ev.user === self) return { recorded: false };
  const names = slackNames(db);
  const files = (ev.files ?? []).map((f) => `[ファイル] ${f.title || f.name || ""}`.trim());
  const text = [slackPlainText(String(ev.text ?? ""), names.users), ...files].filter(Boolean).join("\n") || "(本文なし)";
  const dm = ev.channel_type === "im" || channel.startsWith("D");
  const when = new Date(Math.round(Number(ts) * 1000)).toISOString();
  const store: StoreId = (!dm && inboundSettings(db).slackStores?.[channel]) || "hq";
  const added = addInbound(db, {
    id: `slack_${channel}_${ts.replace(".", "_")}`,
    channel: "slack",
    at: when,
    from: (ev.user && names.users[ev.user]) || "Slack のユーザー",
    fromDetail: dm ? "DM" : names.channels[channel] ? `#${names.channels[channel]}` : "Slack のチャンネル",
    text,
    storeId: store,
    ref: ev.thread_ts && ev.thread_ts !== ts ? "スレッドの返信" : undefined,
    slack: { channel, user: ev.user },
  });
  if (!added) return { recorded: false };
  if (!dm) touchSlackChannel(db, channel, when, names.channels[channel]);
  return { recorded: true, user: ev.user && !names.users[ev.user] ? ev.user : undefined, channel: !dm && !names.channels[channel] ? channel : undefined };
}

async function slackApi<T>(method: string, params: Record<string, string>, token: string): Promise<T | null> {
  try {
    const r = await fetch(`${slackApiBase()}/${method}?${new URLSearchParams(params)}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
    const j = (await r.json()) as T & { ok?: boolean };
    return j.ok ? j : null;
  } catch {
    return null;
  }
}

/** 受信のあとで送り主・チャンネルの名前を取得する (SLACK_BOT_TOKEN があるとき) */
export async function fetchSlackNames(ids: { users: string[]; channels: string[] }): Promise<{ users: Record<string, string>; channels: Record<string, string> }> {
  const token = slackBotToken();
  const out = { users: {} as Record<string, string>, channels: {} as Record<string, string> };
  if (!token) return out;
  for (const u of [...new Set(ids.users)].slice(0, 20)) {
    const r = await slackApi<{ user?: { real_name?: string; name?: string; profile?: { display_name?: string; real_name?: string } } }>("users.info", { user: u }, token);
    const n = r?.user?.profile?.display_name || r?.user?.profile?.real_name || r?.user?.real_name || r?.user?.name;
    if (n) out.users[u] = n;
  }
  for (const c of [...new Set(ids.channels)].slice(0, 20)) {
    const r = await slackApi<{ channel?: { name?: string } }>("conversations.info", { channel: c }, token);
    if (r?.channel?.name) out.channels[c] = r.channel.name;
  }
  return out;
}

export { setSlackNames };
