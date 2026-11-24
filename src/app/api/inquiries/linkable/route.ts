import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { syncDb } from "@/lib/db/store";
import { canEditCaseStore } from "@/lib/auth/permissions";
import { linkableInquiries } from "@/lib/link-search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };

/** 顧客の画面: このお客様にひも付けられる問い合わせ (?customer=<顧客 ID>&q=番号・お名前・電話・内容・住所) */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  const sp = new URL(req.url).searchParams;
  const db = await syncDb();
  const customer = db.customers.find((c) => c.id === sp.get("customer"));
  if (!customer || !canEditCaseStore(user, customer.storeId)) return NextResponse.json({ items: [] }, { headers: NO_STORE });
  return NextResponse.json({ items: linkableInquiries(db, user, customer, (sp.get("q") ?? "").slice(0, 60)) }, { headers: NO_STORE });
}
