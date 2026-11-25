import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { syncDb } from "@/lib/db/store";
import { canViewCompanySchedule } from "@/lib/auth/permissions";
import { placeCandidates } from "@/lib/schedule-find";
import { toDateKey } from "@/lib/format";
import type { StoreId } from "@/lib/db/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };

/** 場所からの訪問の候補日 (?address= 住所・町名 &store= 店舗 (空 = 住所の担当エリア・all = 全店舗) &days= 7〜90。src/lib/schedule-find.ts) */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  if (!canViewCompanySchedule(user)) return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  const sp = new URL(req.url).searchParams;
  const address = (sp.get("address") ?? "").slice(0, 120);
  const db = await syncDb();
  const store = sp.get("store") ?? "";
  const storeId = store === "all" ? "all" : db.stores.some((s) => s.id === store) ? (store as StoreId) : undefined;
  const days = Number(sp.get("days")) || 30;
  const nearKm = Math.min(Math.max(Number(sp.get("nearKm")) || 6, 1), 30);
  return NextResponse.json(placeCandidates(db, { address, storeId, today: toDateKey(new Date()), days, nearKm }), { headers: NO_STORE });
}
