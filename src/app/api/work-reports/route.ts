import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { addAudit, mutate, syncDb } from "@/lib/db/store";
import type { StoreId } from "@/lib/db/types";
import { canViewWorkReport } from "@/lib/auth/permissions";
import { toCsv } from "@/lib/csv";
import { buildWorkReport, isMonthKey, workLinesCsvRows, workReportCsvRows } from "@/lib/ops-reports/work-report";

/**
 * 作業日報の CSV (その店舗のメンバー・全店舗ロール)
 * /api/work-reports?store=koshi&month=2026-11&section=sheet|lines
 *   sheet = 作業日報の表計算と同じ並び (合計・見出しの集計つき) / lines = 明細 (1 行 = 予定 1 件、チラシ・来店の手入力)
 * 画面・印刷と同じ集計 (src/lib/ops-reports/work-report.ts)。UTF-8 (BOM 付き)
 */
export async function GET(req: Request) {
  if (req.headers.get("next-router-prefetch") || req.headers.get("rsc")) return new NextResponse(null, { status: 204 });
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const sp = new URL(req.url).searchParams;
  const db = await syncDb();
  const store = db.stores.find((s) => s.id === sp.get("store"));
  const month = sp.get("month") ?? "";
  if (!store || !isMonthKey(month)) return NextResponse.json({ error: "store と month (YYYY-MM) を指定してください" }, { status: 400 });
  if (!canViewWorkReport(user, store.id)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const section = sp.get("section") === "lines" ? "lines" : "sheet";
  const report = buildWorkReport(db, store.id as StoreId, month);
  const label = `作業日報 (${store.name} · ${month} · ${section === "lines" ? "明細" : "日報の並び"})`;
  await mutate((d) => {
    addAudit(d, { userId: user.id, action: "export", entity: "data", entityId: `work_report_${store.id}_${month}`, entityLabel: label, summary: `データを書き出し: ${label}`, storeId: store.id });
  });
  const name = `work_report_${store.id}_${month}${section === "lines" ? "_lines" : ""}.csv`;
  return new NextResponse(toCsv(section === "lines" ? workLinesCsvRows(report) : workReportCsvRows(report, store.name)), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}` },
  });
}
