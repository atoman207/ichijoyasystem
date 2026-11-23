import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { liveSignature } from "@/lib/notify-live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** ヘッダーの件数の印 (AppShell が 1 分ごとに読み、変わったら画面を読み直す。src/lib/notify-live.ts) */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: { "Cache-Control": "private, no-store" } });
  return NextResponse.json(liveSignature(user), { headers: { "Cache-Control": "private, no-store" } });
}
