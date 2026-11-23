import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { addAudit, mutate, syncDb } from "@/lib/db/store";
import { policyReader } from "@/lib/access-policy";
import { toCsv } from "@/lib/csv";
import { canViewMgmt, mgmtStores } from "@/lib/mgmt/access";
import { MGMT_EXPORTS, mgmtExportRows, type MgmtExport } from "@/lib/mgmt/export";

export const maxDuration = 60;

/**
 * 管理会計の CSV (店長・本部スタッフ・管理者。閲覧の範囲は画面と同じ: 店長は自店舗、経営の数字を全社員に公開しているときは全店舗)
 * /api/management?kind=pnl|items|moves|ledger&from=YYYY-MM-DD&to=YYYY-MM-DD
 * 金額は画面と同じ計算 (src/lib/mgmt/export.ts)。UTF-8 (BOM 付き)
 */
export async function GET(req: Request) {
  if (req.headers.get("next-router-prefetch") || req.headers.get("rsc")) return new NextResponse(null, { status: 204 });
  const sessionUser = await getSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const db = await syncDb();
  const user = policyReader(db, sessionUser);
  if (!canViewMgmt(user)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const sp = new URL(req.url).searchParams;
  const kind = (sp.get("kind") ?? "pnl") as MgmtExport;
  if (!(kind in MGMT_EXPORTS)) return NextResponse.json({ error: "unknown kind" }, { status: 400 });
  const isDate = (v: string | null) => /^\d{4}-\d{2}-\d{2}$/.test(v ?? "");
  const from = sp.get("from");
  const to = sp.get("to");
  if (!isDate(from) || !isDate(to) || from! > to!) return NextResponse.json({ error: "from と to (YYYY-MM-DD) を指定してください" }, { status: 400 });
  const storeIds = mgmtStores(user);
  const label = `管理会計 (${MGMT_EXPORTS[kind]} · ${from}〜${to}${storeIds ? ` · ${db.stores.find((s) => s.id === storeIds[0])?.name}` : ""})`;
  await mutate((d) => {
    addAudit(d, { userId: sessionUser.id, action: "export", entity: "data", entityId: `management_${kind}`, entityLabel: label, summary: `データを書き出し: ${label}`, storeId: storeIds?.[0] });
  });
  const name = `management_${kind}_${from}_${to}${storeIds ? `_${storeIds[0]}` : ""}.csv`;
  return new NextResponse(toCsv(mgmtExportRows(db, kind, from!, to!, storeIds)), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}` },
  });
}
