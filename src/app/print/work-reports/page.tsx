import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { syncDb } from "@/lib/db/store";
import type { StoreId } from "@/lib/db/types";
import { canViewWorkReport } from "@/lib/auth/permissions";
import { toDateKey } from "@/lib/format";
import { buildWorkReport, isMonthKey } from "@/lib/ops-reports/work-report";
import { PrintToolbar } from "@/components/features/PrintToolbar";
import { WorkReportHeadline, WorkReportSheet } from "@/components/ops-reports/WorkReportSheet";

export const dynamic = "force-dynamic";

/** 作業日報の印刷 (A4 横。画面と同じ集計) */
export default async function WorkReportPrintPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = await syncDb();
  const store = db.stores.find((s) => s.id === sp.store);
  const month = isMonthKey(sp.month) ? sp.month : toDateKey(new Date()).slice(0, 7);
  if (!store || !canViewWorkReport(user, store.id)) redirect("/work-reports?err=" + encodeURIComponent("この店舗の作業日報を閲覧する権限がありません。"));
  const report = buildWorkReport(db, store.id as StoreId, month);
  const t = report.totals;
  const back = `/work-reports?store=${store.id}&month=${month}`;

  return (
    <div className="min-h-screen bg-subtle py-6 print:bg-white print:py-0">
      <style>{"@page { size: A4 landscape; margin: 7mm; }"}</style>
      <PrintToolbar backHref={back} />
      <div className="mx-auto w-[287mm] max-w-full bg-white px-[6mm] py-[6mm] text-ink shadow print:w-auto print:px-0 print:py-0 print:shadow-none">
        <div className="mb-2 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold tracking-wide">作業日報 {Number(month.slice(0, 4))}年{Number(month.slice(5, 7))}月</h1>
            <p className="text-[10px] text-ink-2">
              {store.name} · 引取 {t.pickup.count} 件 (畳 {t.pickup.tatami} 枚) · 納品 {t.delivery.count} 件 (畳 {t.delivery.tatami} 枚) · 見積 {t.survey} 件 · 施工 {t.install} 件 · チラシ {t.flyerCopies.toLocaleString("ja-JP")} 枚 · 来店 {t.visitors} 人
            </p>
            <p className="text-[9px] text-ink-3">予定表から自動で集計 (出力 {toDateKey(new Date()).replaceAll("-", "/")})</p>
          </div>
          <WorkReportHeadline report={report} compact />
        </div>
        <WorkReportSheet report={report} links={false} print />
      </div>
    </div>
  );
}
