import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { addAudit, mutate, syncDb } from "@/lib/db/store";
import { canViewReports } from "@/lib/auth/permissions";
import { policyReader } from "@/lib/access-policy";
import { toCsv } from "@/lib/csv";
import { visibleStores } from "@/lib/management";
import { salesCheck, salesCheckCsv, salesCheckPeriod, type SalesCheckCsvKind } from "@/lib/sales-check";
import type { StoreId } from "@/lib/db/types";

export const maxDuration = 60;

const KINDS: Record<SalesCheckCsvKind, string> = { months: "月別・店舗別", stores: "店舗別の合計", "ledger-only": "売上台帳だけにある売上" };

/**
 * 売上の照合 (/data/sales-check) の CSV。?kind=months|stores|ledger-only &from=YYYY-MM&to=YYYY-MM (または year=YYYY) &store=koshi
 * 見られる店舗は経営ダッシュボードと同じ (閲覧の範囲の設定)。UTF-8 (BOM 付き)
 */
export async function GET(req: Request) {
  if (req.headers.get("next-router-prefetch") || req.headers.get("rsc")) return new NextResponse(null, { status: 204 });
  const sessionUser = await getSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const db = await syncDb();
  const user = policyReader(db, sessionUser);
  if (!canViewReports(user)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const sp = Object.fromEntries(new URL(req.url).searchParams.entries());
  const kind = (sp.kind ?? "months") as SalesCheckCsvKind;
  if (!(kind in KINDS)) return NextResponse.json({ error: "unknown kind" }, { status: 400 });
  const period = salesCheckPeriod(sp);
  const allowed = visibleStores(db, user);
  const stores: StoreId[] = sp.store && allowed.includes(sp.store as StoreId) ? [sp.store as StoreId] : allowed;
  const c = salesCheck(db, { from: period.from, to: period.to, stores });
  const label = `売上の照合 (${KINDS[kind]} · ${period.label} · ${stores.length === 1 ? (db.stores.find((s) => s.id === stores[0])?.name ?? stores[0]) : "全店舗"})`;
  await mutate((d) => {
    addAudit(d, { userId: user.id, action: "export", entity: "data", entityId: `sales_check_${kind}`, entityLabel: label, summary: `データを書き出し: ${label}`, storeId: stores.length === 1 ? stores[0] : undefined });
  });
  const name = `sales-check_${kind}_${period.from}_${period.to}${stores.length === 1 ? `_${stores[0]}` : ""}.csv`;
  return new NextResponse(toCsv(salesCheckCsv(c, kind, db, stores)), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}` },
  });
}
