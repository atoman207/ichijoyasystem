import { NextResponse, after } from "next/server";
import { mutate, syncDb } from "@/lib/db/store";
import { fetchSlackNames, recordSlackEvent, setSlackNames, slackSigningSecret, verifySlackSignature, type SlackEventBody } from "@/lib/inbound/slack";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Slack の Events API (お客様のご要望 2026-11-26: Slack のメッセージをシステムの通知に)。src/lib/inbound/slack.ts
 * - 署名 (X-Slack-Signature・X-Slack-Request-Timestamp) を SLACK_SIGNING_SECRET で確かめる
 * - URL の確認 (url_verification) には challenge を返す
 * - Slack は 3 秒以内の応答を求めるので、名前の取得は応答のあと (after)
 * - 再送 (X-Slack-Retry-Num) は同じメッセージの ID で 1 件にする
 */
export async function POST(req: Request) {
  const secret = slackSigningSecret();
  if (!secret) return NextResponse.json({ error: "SLACK_SIGNING_SECRET is not configured" }, { status: 503 });
  const raw = await req.text();
  if (raw.length > 1_000_000) return NextResponse.json({ error: "payload too large" }, { status: 413 });
  if (!verifySlackSignature(secret, raw, req.headers.get("x-slack-request-timestamp"), req.headers.get("x-slack-signature"))) return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  let body: SlackEventBody;
  try {
    body = JSON.parse(raw) as SlackEventBody;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (body.type === "url_verification") return NextResponse.json({ challenge: String(body.challenge ?? "") });
  if (body.type !== "event_callback") return NextResponse.json({ ok: true });
  await syncDb();
  const r = await mutate((db) => recordSlackEvent(db, body));
  if (r.user || r.channel) {
    after(async () => {
      const names = await fetchSlackNames({ users: r.user ? [r.user] : [], channels: r.channel ? [r.channel] : [] });
      if (Object.keys(names.users).length || Object.keys(names.channels).length) {
        await syncDb();
        await mutate((db) => setSlackNames(db, names));
      }
    });
  }
  return NextResponse.json({ ok: true, recorded: r.recorded });
}
