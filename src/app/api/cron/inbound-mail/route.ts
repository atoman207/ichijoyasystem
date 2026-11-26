import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { pollInboundMail } from "@/lib/inbound/mail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** 会社のメールボックスの新しいメールを通知にする (定期実行。deploy/run-task.sh inbound-mail。CRON_SECRET で確かめる。src/lib/inbound/mail.ts) */
export async function POST(req: Request) {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  if (!secret) return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 503 });
  const given = Buffer.from(req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "");
  const want = Buffer.from(secret);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const r = await pollInboundMail({ force: true });
  return NextResponse.json(r, { status: r.ok ? 200 : 502 });
}
