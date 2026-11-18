import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { canAccessStore, canManagePurchaseOrders } from "@/lib/auth/permissions";
import { syncDb } from "@/lib/db/store";
import { orderOption } from "@/lib/purchase-order-options";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 発注書の明細に加える案件 (受注) の検索: /api/orders/lookup?q=<受注番号・お客様・件名>
 * 発注書を作れる人だけ。閲覧できる店舗の受注だけを返す (最大 20 件。進行中の案件を先に)
 */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "ログインが必要です。" }, { status: 401 });
  if (!canManagePurchaseOrders(user)) return NextResponse.json({ error: "発注書を作成する権限がありません。" }, { status: 403 });
  const q = (new URL(req.url).searchParams.get("q") ?? "").normalize("NFKC").trim().toLowerCase();
  if (q.length < 2) return NextResponse.json({ orders: [] });
  const db = await syncDb();
  const customers = new Map(db.customers.map((c) => [c.id, c]));
  const active = new Set(["confirmed", "scheduled", "in_progress", "pending_approval"]);
  const hits = db.orders
    .filter((o) => canAccessStore(user, o.storeId) && o.status !== "cancelled")
    .filter((o) => `${o.number} ${o.title} ${customers.get(o.customerId)?.name ?? ""} ${customers.get(o.customerId)?.kana ?? ""}`.normalize("NFKC").toLowerCase().includes(q))
    .sort((a, b) => Number(active.has(b.status)) - Number(active.has(a.status)) || b.contractDate.localeCompare(a.contractDate))
    .slice(0, 20);
  return NextResponse.json({ orders: hits.map((o) => orderOption(db, o)) });
}
