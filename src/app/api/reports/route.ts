import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { addAudit, mutate, syncDb } from "@/lib/db/store";
import { canViewReports } from "@/lib/auth/permissions";
import { toCsv } from "@/lib/csv";
import { MGMT_CSV_SECTIONS, managementReport, mgmtCsvRows, resolvePeriod, staffOptions, type MgmtCsvSection } from "@/lib/management";
import type { StoreId } from "@/lib/db/types";

export const maxDuration = 60;

/**
 * 経営ダッシュボードの CSV (店長・本部スタッフ・管理者。店長は自店舗のみ)
 * /api/reports?section=summary|monthly|stores|staff|pipeline|invoices|categories|channels|expenses
 * |surveys &period=last_12m (または from=YYYY-MM-DD&to=YYYY-MM-DD) &store=koshi &staff=<社員 ID または name:<名前>>
 * 画面と同じ集計 (src/lib/management.ts)。UTF-8 (BOM 付き)
 */
export async function GET(req: Request) {
  if (req.headers.get("next-router-prefetch") || req.headers.get("rsc")) return new NextResponse(null, { status: 204 });
  const user = await getSessionUser();
  if (!user || !canViewReports(user)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const sp = Object.fromEntries(new URL(req.url).searchParams.entries());
  const section = (sp.section ?? "summary") as MgmtCsvSection;
  if (!(section in MGMT_CSV_SECTIONS)) return NextResponse.json({ error: "unknown section" }, { status: 400 });
  const db = await syncDb();
  const period = resolvePeriod(sp);
  const store = db.stores.some((s) => s.id === sp.store) ? (sp.store as StoreId) : undefined;
  const staffOption = sp.staff ? staffOptions(db, user).find((o) => o.key === sp.staff) : undefined;
  const staff = staffOption?.key;
  const report = managementReport(db, user, { from: period.from, to: period.to, storeId: store, staffId: staff });
  const scope = [report.filter.storeId ? db.stores.find((s) => s.id === report.filter.storeId)?.name : report.stores.length === 1 ? report.stores[0].name : "全店舗", staffOption ? `担当 ${staffOption.name}` : ""].filter(Boolean).join(" · ");
  const label = `経営ダッシュボード (${MGMT_CSV_SECTIONS[section]} · ${period.label} · ${scope})`;
  await mutate((d) => {
    addAudit(d, { userId: user.id, action: "export", entity: "data", entityId: `report_${section}`, entityLabel: label, summary: `データを書き出し: ${label}`, storeId: report.stores.length === 1 ? report.stores[0].id : undefined });
  });
  const name = `report_${section}_${period.from}_${period.to}${report.stores.length === 1 ? `_${report.stores[0].id}` : ""}.csv`;
  return new NextResponse(toCsv(mgmtCsvRows(report, section, period.label)), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}` },
  });
}
