import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { addAudit, mutate, syncDb } from "@/lib/db/store";
import { canViewPromoAnalysis } from "@/lib/auth/permissions";
import { toCsv } from "@/lib/csv";
import { kpiSettings } from "@/lib/kpi-settings";
import { resolvePeriod } from "@/lib/kpi-period";
import { toDateKey } from "@/lib/format";
import { PROMO_CSV_SECTIONS, promoCsvRows, promoReport, type PromoCsvSection } from "@/lib/ops-reports/promo-analysis";

export const maxDuration = 60;

/**
 * 販促と媒体の分析の CSV (店長は自店舗・本部スタッフ・管理者)
 * /api/promotions?section=media|monthly|flyers|areas|years|promotions|surveys|inquiries &p=fy:2026 (または from=…&to=…) &store=koshi
 * 画面と同じ集計 (src/lib/ops-reports/promo-analysis.ts)。問い合わせの件数は 問い合わせ一覧 (?media=…&from=…&to=…) と一致する
 */
export async function GET(req: Request) {
  if (req.headers.get("next-router-prefetch") || req.headers.get("rsc")) return new NextResponse(null, { status: 204 });
  const user = await getSessionUser();
  if (!user || !canViewPromoAnalysis(user)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const sp = Object.fromEntries(new URL(req.url).searchParams.entries());
  const section = (sp.section ?? "media") as PromoCsvSection;
  if (!(section in PROMO_CSV_SECTIONS)) return NextResponse.json({ error: "unknown section" }, { status: 400 });
  const db = await syncDb();
  const rp = resolvePeriod(sp, kpiSettings(db).fiscalStartMonth, toDateKey(new Date()));
  const period = rp.period ?? { from: "2000-01-01", to: toDateKey(new Date()) };
  const report = promoReport(db, user, { from: period.from, to: period.to, store: sp.store });
  const storeName = (id: string) => db.stores.find((s) => s.id === id)?.name ?? id;
  const scope = report.scope.storeIds.length === 1 ? storeName(report.scope.storeIds[0]) : "全店舗";
  const label = `販促と媒体の分析 (${PROMO_CSV_SECTIONS[section]} · ${rp.label} · ${scope})`;
  await mutate((d) => {
    addAudit(d, { userId: user.id, action: "export", entity: "data", entityId: `promo_${section}`, entityLabel: label, summary: `データを書き出し: ${label}`, storeId: report.scope.storeIds.length === 1 ? report.scope.storeIds[0] : undefined });
  });
  const name = `promotions_${section}_${period.from}_${period.to}${report.scope.storeIds.length === 1 ? `_${report.scope.storeIds[0]}` : ""}.csv`;
  return new NextResponse(toCsv(promoCsvRows(report, section, storeName)), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}` },
  });
}
