import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { runInquiryFollowups } from "@/lib/inquiry-followup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** 期限を過ぎた問い合わせの依頼の再通知 (定期実行。deploy/run-task.sh inquiry-followup。CRON_SECRET で確かめる) */
export async function POST(req: Request) {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  if (!secret) return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 503 });
  const given = Buffer.from(req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "");
  const want = Buffer.from(secret);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const r = await runInquiryFollowups();
  return NextResponse.json({ ok: true, ...r });
}
