import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { syncDb } from "@/lib/db/store";
import { runKnowledgeCron } from "@/lib/knowledge-sync";
import { SYSTEM_USER } from "@/lib/notify/inbound";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 社内資料の定期処理 (毎時。deploy/ichijoya.cron → deploy/run-task.sh knowledge-sync)
 * - Google スプレッドシートの同期 (一方向: シート → システム)。失敗・大量の削除は書かずに止め、担当者・本部・管理者に知らせる
 * - 1 日 1 回、確認期限を過ぎた社内資料の担当者に知らせる
 * - 実行した時刻を残す (社内資料の画面で「定期の同期が止まっていないか」を確かめる)
 * サーバーの cron から呼ぶ: curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" https://<ドメイン>/api/cron/knowledge-sync
 */
export async function POST(req: Request) {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  if (!secret) return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 503 });
  const given = Buffer.from(req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "");
  const want = Buffer.from(secret);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await syncDb();
  const r = await runKnowledgeCron(SYSTEM_USER);
  return NextResponse.json({ ok: r.ok, synced: r.results.length, results: r.results, reviewNotified: r.reviewNotified });
}
