import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { syncDb } from "@/lib/db/store";
import { toDateKey } from "@/lib/format";
import { canViewAttendanceOf, canViewLeaveBalanceOf } from "@/lib/auth/permissions";
import { documentSettings } from "@/lib/doc-settings";
import { fmtDays, LEAVE_SLOT, LEAVE_TYPE } from "@/lib/hr/leave";
import { attendanceEmployees, attendanceMonthOf, attendancePeriod, attendanceSettings, clock, fmtHm, periodSummary, staffCategory, STAFF_CATEGORY, WEEKDAY_JA, weekdayOf } from "@/lib/hr/timecard";
import { kpiSettings } from "@/lib/kpi-settings";
import { PrintToolbar } from "@/components/features/PrintToolbar";

export const dynamic = "force-dynamic";

/**
 * 勤務記録の印刷 (キャスタイムの「勤務記録一括出力 → プリントアウト」。1 人 = 1 枚、A4 縦)。
 * ?month=YYYY-MM (20 日締め) &user=<社員> (なければ見られる全員。役員は除く)。紙の申請書と照らし合わせて確かめる・出勤簿のファイルに綴じる用
 */
export default async function AttendancePrintPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = await syncDb();
  const today = toDateKey(new Date());
  const ym = sp.month && /^\d{4}-\d{2}$/.test(sp.month) ? sp.month : attendanceMonthOf(db, today);
  const { from, to } = attendancePeriod(db, ym);
  const s = attendanceSettings(db);
  const clerks = kpiSettings(db).clerkUserIds;
  const all = attendanceEmployees(db).filter((u) => canViewAttendanceOf(user, u));
  const users = sp.user ? all.filter((u) => u.id === sp.user) : all.filter((u) => staffCategory(s, u, clerks) !== "officer");
  if (!users.length) redirect(`/attendance?tab=sheet&err=${encodeURIComponent("印刷できる勤務表がありません。")}`);
  const company = documentSettings(db).companyName;
  const [y, m] = ym.split("-").map(Number);
  return (
    <div className="min-h-screen bg-subtle py-6 print:bg-white print:py-0">
      <style>{"@page { size: A4 portrait; margin: 8mm; } * { -webkit-print-color-adjust: exact; print-color-adjust: exact; } .sheet { break-after: page; } .sheet:last-child { break-after: auto; }"}</style>
      <PrintToolbar backHref={`/attendance?tab=sheet&month=${ym}`} />
      {users.map((u) => {
        const sum = periodSummary(db, u, from, to, today, clerks);
        const bal = canViewLeaveBalanceOf(user, u);
        return (
          <section key={u.id} className="sheet mx-auto mb-6 w-[210mm] max-w-full bg-white px-[8mm] py-[6mm] text-[10px] text-ink shadow print:mb-0 print:w-auto print:px-0 print:py-0 print:shadow-none">
            <div className="mb-2 flex items-end justify-between gap-3">
              <div>
                <h1 className="text-base font-semibold">
                  勤務記録 {y}年{m}月分 (令和{y - 2018}年)
                </h1>
                <p className="text-ink-2">
                  {u.name} · {db.stores.find((x) => x.id === u.storeId)?.shortName ?? ""} · {STAFF_CATEGORY[sum.category].label} · シフト {sum.shift.start}〜{sum.shift.end} · 期間 {from.replaceAll("-", "/")}〜{to.replaceAll("-", "/")}
                </p>
              </div>
              <p className="text-ink-3">
                {company} · 出力 {today.replaceAll("-", "/")}
              </p>
            </div>
            <table className="w-full border-collapse text-[9.5px]">
              <thead>
                <tr className="bg-subtle">
                  {["日", "曜", "区分", "出勤", "退勤", "休憩", "勤務", "遅刻", "早退", "シフト外", "深夜", "休暇", "備考"].map((h) => (
                    <th key={h} className="border border-line px-1 py-0.5 text-left font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sum.days.map((d) => (
                  <tr key={d.date} className={d.dayType !== "work" ? "bg-subtle/50" : ""}>
                    <td className="border border-line px-1">{Number(d.date.slice(8))}</td>
                    <td className={`border border-line px-1 ${weekdayOf(d.date) === 0 ? "text-critical-ink" : weekdayOf(d.date) === 6 ? "text-accent-ink" : ""}`}>{WEEKDAY_JA[weekdayOf(d.date)]}</td>
                    <td className="border border-line px-1">{d.dayType === "legal_off" ? "法休" : d.dayType === "scheduled_off" ? "所休" : ""}</td>
                    <td className="border border-line px-1 tabular-nums">{d.inMin !== undefined ? clock(d.inMin) : ""}</td>
                    <td className="border border-line px-1 tabular-nums">{d.outMin !== undefined ? clock(d.outMin) : ""}</td>
                    <td className="border border-line px-1 tabular-nums">{d.breakMin ? fmtHm(d.breakMin) : ""}</td>
                    <td className="border border-line px-1 tabular-nums">{d.workedMin ? fmtHm(d.workedMin) : ""}</td>
                    <td className="border border-line px-1 tabular-nums">{d.lateMin ? fmtHm(d.lateMin) : ""}</td>
                    <td className="border border-line px-1 tabular-nums">{d.earlyMin ? fmtHm(d.earlyMin) : ""}</td>
                    <td className="border border-line px-1 tabular-nums">{d.outsideMin ? fmtHm(d.outsideMin) : ""}</td>
                    <td className="border border-line px-1 tabular-nums">{d.nightMin ? fmtHm(d.nightMin) : ""}</td>
                    <td className="border border-line px-1">
                      {[...d.leaves.map((l) => `${LEAVE_TYPE[l.type].short}${l.slot === "day" ? "" : LEAVE_SLOT[l.slot]}`), d.holidayWork ? "休出" : ""].filter(Boolean).join(" ")}
                    </td>
                    <td className="border border-line px-1">{[d.absent ? "欠勤" : "", d.missing ? "打刻漏れ" : "", d.pending.length ? "申請中" : ""].filter(Boolean).join(" ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2">
              出勤 {sum.attendDays} 日 · 欠勤 {sum.absentDays} 日 · 遅刻・早退 {fmtHm(sum.lateMin + sum.earlyMin)} · 勤務 {fmtHm(sum.workedMin)} · シフト外残業 {fmtHm(sum.outsideMin)} (固定 {fmtHm(sum.fixedMin)} → 残業 {fmtHm(sum.overtimeMin)}) · 深夜 {fmtHm(sum.nightMin)} · 有給 {fmtDays(sum.paidDays)} · 振休消化 {fmtDays(sum.compDays)} · 休日出勤 {fmtDays(sum.holidayWorkDays)}
              {bal ? ` · 残: 有給 ${fmtDays(sum.paidRemaining)}・振休 ${fmtDays(sum.compRemaining)}` : ""}
            </p>
          </section>
        );
      })}
    </div>
  );
}
