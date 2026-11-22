import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { syncDb } from "@/lib/db/store";
import { runWorkbookSync } from "@/lib/survey-workbook/preview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * お客様アンケート集計表 (Google スプレッドシート) の定期の同期 (一方向: シート → システム。毎日)
 * KPI → スプレッドシートの取込 で URL を登録し「定期の同期」をオンにしたときだけ取り込む (オフのときは何もしない)。
 * サーバーの cron から呼ぶ: curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" https://<ドメイン>/api/cron/survey-workbook
 */
export async function POST(req: Request) {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  if (!secret) return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 503 });
  const given = Buffer.from(req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "");
  const want = Buffer.from(secret);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await syncDb();
  const r = await runWorkbookSync();
  return NextResponse.json(r, { status: r.ok ? 200 : 500 });
}
