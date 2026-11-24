import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { syncDb } from "@/lib/db/store";
import { searchCustomers } from "@/lib/link-search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };

/** 既存の顧客の検索 (問い合わせを顧客にひも付けるとき。入力するたびに呼ぶ)。?q=お名前・フリガナ・住所・町名・電話・顧客コード */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  const q = (new URL(req.url).searchParams.get("q") ?? "").slice(0, 60);
  const db = await syncDb();
  return NextResponse.json({ items: searchCustomers(db, user, q) }, { headers: NO_STORE });
}
