import { requireUser } from "@/lib/auth/session";
import { syncDb } from "@/lib/db/store";
import { toDateKey } from "@/lib/format";
import { documentSettings } from "@/lib/doc-settings";
import { closedDayMap, holidayResolver, yearSummary } from "@/lib/holiday-calendar";
import { PrintToolbar } from "@/components/features/PrintToolbar";
import { HolidayYear } from "@/components/schedule/HolidayYear";

export const dynamic = "force-dynamic";

/** 休日カレンダーの印刷 (A4 横・1 年で 1 枚。画面と同じ休業日・祝日) */
export default async function HolidayPrintPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  await requireUser();
  const db = await syncDb();
  const today = toDateKey(new Date());
  const y = Number(sp.year);
  const year = Number.isInteger(y) && y >= 2000 && y <= 2099 ? y : Number(today.slice(0, 4));
  const closed = new Map([...closedDayMap(db)].map(([d, h]) => [d, h.label]));
  const s = yearSummary(db, year);
  const company = documentSettings(db).companyName;

  return (
    <div className="min-h-screen bg-subtle py-6 print:bg-white print:py-0">
      <style>{"@page { size: A4 landscape; margin: 7mm; } * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }"}</style>
      <PrintToolbar backHref={`/schedule/holidays?year=${year}`} />
      <div className="mx-auto w-[287mm] max-w-full bg-white px-[6mm] py-[5mm] text-ink shadow print:w-auto print:px-0 print:py-0 print:shadow-none">
        <div className="mb-2 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold tracking-wide">休日カレンダー {year}年</h1>
            <p className="text-[10px] text-ink-2">
              {company ? `${company} · ` : ""}休業日 {s.closed} 日 · 営業日 {s.workdays} 日
            </p>
          </div>
          <p className="text-[9px] text-ink-3">
            <span className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-critical-soft align-middle ring-1 ring-critical/30" />
            休業日 · 赤字 = 日曜・祝日 · 青字 = 土曜 · 出力 {today.replaceAll("-", "/")}
          </p>
        </div>
        <HolidayYear year={year} closed={closed} holidayOf={holidayResolver(db)} print />
      </div>
    </div>
  );
}
