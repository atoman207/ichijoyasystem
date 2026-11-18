import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { faxConnection } from "@/lib/fax/adapter";
import { analyzeAndLink } from "@/lib/fax/inbound";
import { processFaxJobs } from "@/lib/fax/outbound";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * FAX の定期処理 (送信の状態の確認・通信エラーの自動の再送・結果の分からない送信を要確認に・AI の判定待ちの読み直し)
 * サーバーの cron から 2 分ごと: deploy/run-task.sh fax (curl -X POST -H "Authorization: Bearer $CRON_SECRET" .../api/cron/fax)
 */
export async function POST(req: Request) {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  if (!secret) return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 503 });
  const given = Buffer.from(req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "");
  const want = Buffer.from(secret);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const conn = faxConnection();
  const r = await processFaxJobs((id) => analyzeAndLink(id));
  return NextResponse.json({ ok: true, connection: conn.mode, ...r });
}
