import { NextResponse } from "next/server";
import { BACKEND, syncDb } from "@/lib/db/store";

export const dynamic = "force-dynamic";
// 起動直後は全データの読み込み (約 6 万行) を待つため、実行時間の上限を長めにする
export const maxDuration = 60;

/**
 * 死活監視用。データベースを読めるかどうかも確かめる (件数などの中身は返さない)
 * - Vercel で Supabase の環境変数が未設定のときは、サンプルデータで動いてしまうため "not_configured" (503) を返す
 * - timeZone: サーバーの日付・時刻の基準 (instrumentation.ts で日本時間に設定)
 */
export async function GET() {
  const time = new Date().toISOString();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const base = { service: "ichijoya-ims", backend: BACKEND, timeZone, time };
  if (process.env.VERCEL === "1" && BACKEND === "json" && process.env.DATA_BACKEND !== "json") {
    return NextResponse.json({ ok: false, ...base, db: "not_configured" }, { status: 503 });
  }
  try {
    await syncDb();
    return NextResponse.json({ ok: true, ...base, db: "ok" });
  } catch {
    return NextResponse.json({ ok: false, ...base, db: "error" }, { status: 503 });
  }
}
