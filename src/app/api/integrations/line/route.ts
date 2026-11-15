import { NextResponse } from "next/server";
import { mutate, syncDb } from "@/lib/db/store";
import { lineSecret } from "@/lib/notify/config";
import { recordLineEvents, verifyHmac, type LineEvent } from "@/lib/notify/inbound";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * LINE 公式アカウント (Messaging API) の Webhook
 * LINE Developers の Webhook URL に https://<このシステム>/api/integrations/line を設定する。
 * 署名 (x-line-signature = チャネルシークレットで本文を HMAC-SHA256 → base64) が合う受信だけを登録する
 */
export async function POST(req: Request) {
  const secret = lineSecret();
  if (!secret) return NextResponse.json({ error: "LINE_CHANNEL_SECRET is not configured" }, { status: 503 });
  const raw = await req.text();
  if (raw.length > 1_000_000) return NextResponse.json({ error: "payload too large" }, { status: 413 });
  if (!verifyHmac(secret, raw, req.headers.get("x-line-signature"))) return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  let events: LineEvent[] = [];
  try {
    const body = JSON.parse(raw) as { events?: LineEvent[] };
    events = Array.isArray(body.events) ? body.events.slice(0, 100) : [];
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  // 接続の確認 (events が空) にも 200 を返す
  if (!events.length) return NextResponse.json({ ok: true, recorded: 0 });
  await syncDb();
  const recorded = await mutate((db) => recordLineEvents(db, events));
  return NextResponse.json({ ok: true, recorded });
}
