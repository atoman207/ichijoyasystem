import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getDb, syncDb } from "@/lib/db/store";
import { knowledgeSources } from "@/lib/knowledge";
import { syncSource } from "@/lib/knowledge-sync";
import { SYSTEM_USER } from "@/lib/notify/inbound";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 社内資料 (Google スプレッドシート) の定期同期
 * サーバーの cron から呼ぶ: curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" https://<ドメイン>/api/cron/knowledge-sync
 * (deploy/README.md の「定期実行」を参照)
 */
export async function POST(req: Request) {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  if (!secret) return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 503 });
  const given = Buffer.from(req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "");
  const want = Buffer.from(secret);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await syncDb();
  const results: { source: string; ok: boolean; message: string }[] = [];
  for (const s of knowledgeSources(getDb())) {
    const r = await syncSource(s.id, SYSTEM_USER);
    results.push({ source: s.label, ...r });
  }
  return NextResponse.json({ ok: results.every((r) => r.ok), synced: results.length, results });
}
