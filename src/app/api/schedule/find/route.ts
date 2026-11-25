import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { syncDb } from "@/lib/db/store";
import { canViewCompanySchedule } from "@/lib/auth/permissions";
import { searchSchedule } from "@/lib/schedule-find";
import { toDateKey } from "@/lib/format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };

/** 予定表の検索 (?q= お客様名・住所・町名・電話番号。src/lib/schedule-find.ts の searchSchedule) */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  if (!canViewCompanySchedule(user)) return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  const q = (new URL(req.url).searchParams.get("q") ?? "").slice(0, 60);
  const db = await syncDb();
  return NextResponse.json(searchSchedule(db, user, q, toDateKey(new Date())), { headers: NO_STORE });
}
