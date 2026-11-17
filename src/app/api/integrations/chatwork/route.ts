import { NextResponse } from "next/server";
import { mutate, syncDb } from "@/lib/db/store";
import { chatworkWebhookTokens } from "@/lib/notify/config";
import { recordChatworkEvent, verifyHmac, type ChatworkPayload } from "@/lib/notify/inbound";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Chatwork の Webhook (ルームイベント: メッセージ作成)
 * Chatwork の Webhook 設定の URL に https://<このシステム>/api/integrations/chatwork を設定し、表示されたトークンを CHATWORK_WEBHOOK_TOKEN に入れる
 * (Webhook はルームごとに作り、トークンもルームごとに違う。複数のルームはカンマ区切りで並べる)。
 * 署名 (x-chatworkwebhooksignature = トークンを base64 で戻した鍵で本文を HMAC-SHA256 → base64) が合う受信だけを登録する。
 * 協力業者・仕入先の台帳で Chatwork のルーム ID を登録したルームの投稿だけを、やりとり履歴に残す
 */
export async function POST(req: Request) {
  const tokens = chatworkWebhookTokens();
  if (!tokens.length) return NextResponse.json({ error: "CHATWORK_WEBHOOK_TOKEN is not configured" }, { status: 503 });
  const raw = await req.text();
  if (raw.length > 1_000_000) return NextResponse.json({ error: "payload too large" }, { status: 413 });
  const sig = req.headers.get("x-chatworkwebhooksignature") ?? new URL(req.url).searchParams.get("chatwork_webhook_signature");
  if (!tokens.some((t) => verifyHmac(Buffer.from(t, "base64"), raw, sig))) return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  let payload: ChatworkPayload;
  try {
    payload = JSON.parse(raw) as ChatworkPayload;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  await syncDb();
  const self = (process.env.CHATWORK_SELF_ACCOUNT_ID ?? "").trim() || undefined;
  const result = await mutate((db) => recordChatworkEvent(db, payload, self));
  return NextResponse.json({ ok: true, result });
}
