import Link from "@/components/ui/Link";
import { LogIn, LogOut, TriangleAlert } from "lucide-react";
import { canViewLeaveBalanceOf } from "@/lib/auth/permissions";
import { stampAttendance } from "@/lib/actions/timecard";
import { fmtDays, hrSettings, LEAVE_SLOT, LEAVE_TYPE } from "@/lib/hr/leave";
import { attendanceMonthOf, attendancePeriod, attentionDays, calcDay, clock, dayRecordId, fmtHm, leavesByDate, periodSummary, shiftOf, staffCategory, STAFF_CATEGORY, DAY_TYPE } from "@/lib/hr/timecard";
import { LiveClock } from "@/components/attendance/LiveClock";
import { PendingButton } from "@/components/ui/PendingButton";
import { Card, CardHeader, Note, Stat, buttonClass } from "@/components/ui";
import { mdw, ymLabel, type Ctx } from "./parts";

const BIG = "inline-flex h-20 w-full items-center justify-center gap-2 rounded-2xl text-xl font-semibold transition-colors focus:outline-none focus-visible:ring-4 focus-visible:ring-accent/25 disabled:cursor-not-allowed disabled:opacity-40 [&>svg]:h-6 [&>svg]:w-6";
const BIG_IN = `${BIG} bg-accent text-white shadow-card hover:bg-accent-hover`;
const BIG_OUT = `${BIG} border-2 border-accent bg-panel text-accent-ink hover:bg-accent-soft`;

/** 打刻 (キャスタイムの「ユーザースタンプ」: 出勤・退勤のボタンと、今日の状態・打刻漏れの知らせ・今月の集計) */
export function StampTab({ ctx }: { ctx: Ctx }) {
  const { db, user, today, settings: s, clerks } = ctx;
  const rec = db.attendanceDays.find((r) => r.id === dayRecordId(user.id, today));
  const category = staffCategory(s, user, clerks);
  const shift = shiftOf(s, user, clerks);
  const hr = hrSettings(db);
  const leaves = leavesByDate(db.leaveRequests, user.id, today, today).get(today) ?? [];
  const hw = db.holidayWorks.find((w) => w.userId === user.id && w.kind === "work" && w.date === today);
  const d = calcDay({ db, s, hr, category, shift, today }, today, { record: rec, leaves, holidayWork: hw });
  const ym = attendanceMonthOf(db, today);
  const { from, to } = attendancePeriod(db, ym);
  const sum = periodSummary(db, user, from, to < today ? to : today, today, clerks);
  const attention = attentionDays(db, user, today, clerks);
  const balance = canViewLeaveBalanceOf(user, user);
  const status = d.inMin === undefined ? (d.outMin !== undefined ? "退勤だけ打刻済み" : "未出勤") : d.outMin === undefined ? `出勤中 (${clock(d.inMin)}〜)` : `退勤済み (${clock(d.inMin)}〜${clock(d.outMin)})`;
  const ready = ctx.ready;
  return (
    <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
      <Card>
        <div className="flex flex-col items-center gap-4 py-2">
          <LiveClock />
          <p className="text-sm text-ink-2">
            {user.name} · {STAFF_CATEGORY[category].short} · シフト {shift.name} {shift.start}〜{shift.end}
            {shift.breaks.length ? ` (休憩 ${shift.breaks.map((b) => `${b.start}〜${b.end}`).join("・")})` : ""}
          </p>
          <p className="text-base font-medium text-ink" data-testid="stamp-status">
            {status}
          </p>
          {d.dayType !== "work" && <Note tone="warn">今日は{DAY_TYPE[d.dayType]}{d.holiday ? ` (${d.holiday})` : ""}です。{hw ? "休日出勤の申請は承認済みです。" : "休日出勤するときは、打刻のあとに勤務表から「休日出勤の申請」をしてください。"}</Note>}
          {leaves.length > 0 && (
            <Note tone="accent">
              今日の休暇: {leaves.map((l) => `${LEAVE_TYPE[l.type].label} (${LEAVE_SLOT[l.slot]})`).join("・")}
            </Note>
          )}
          <div className="grid w-full max-w-md grid-cols-2 gap-3">
            <form action={stampAttendance}>
              <input type="hidden" name="kind" value="in" />
              <input type="hidden" name="returnTo" value="/attendance?tab=stamp" />
              <PendingButton type="submit" disabled={!ready || Boolean(rec?.clockIn)} className={BIG_IN} data-testid="stamp-in">
                <LogIn className="h-5 w-5" aria-hidden /> 出勤
              </PendingButton>
            </form>
            <form action={stampAttendance}>
              <input type="hidden" name="kind" value="out" />
              <input type="hidden" name="returnTo" value="/attendance?tab=stamp" />
              <PendingButton type="submit" disabled={!ready || Boolean(rec?.clockOut)} className={BIG_OUT} data-testid="stamp-out">
                <LogOut className="h-5 w-5" aria-hidden /> 退勤
              </PendingButton>
            </form>
          </div>
          <p className="text-xs text-ink-3">打刻の時刻はサーバーの時刻で記録します。押し間違い・打刻漏れは勤務表の「直す」から打刻修正を申請してください (理由が必要です)。</p>
        </div>
      </Card>

      <div className="space-y-4">
        {!s.startDate && <Note tone="warn">打刻を使い始めた日がまだ設定されていません。設定されるまで、欠勤・打刻漏れは数えません (勤怠 → 設定、管理者)。</Note>}
        {attention.length > 0 && (
          <Card>
            <CardHeader title={<span className="inline-flex items-center gap-1.5 text-critical-ink"><TriangleAlert className="h-4 w-4" aria-hidden /> 確かめてください ({attention.length})</span>} description="打刻漏れ・休日の打刻など。勤務表の「直す」から申請します" />
            <ul className="space-y-1.5 text-sm">
              {attention.slice(0, 8).map((a) => (
                <li key={a.date} className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-ink">{mdw(a.date)}</span>
                  <span className="text-xs text-critical-ink">{a.warnings[0]}</span>
                </li>
              ))}
            </ul>
            <Link href={`/attendance?tab=sheet&month=${ym}`} className={buttonClass("secondary", "sm", "mt-3")}>勤務表で直す</Link>
          </Card>
        )}
        <Card>
          <CardHeader title={`${ymLabel(ym)} (${Number(from.slice(5, 7))}/${Number(from.slice(8))}〜${Number(to.slice(5, 7))}/${Number(to.slice(8))})`} description="今日までの集計" />
          <div className="grid grid-cols-2 gap-3">
            <Stat label="出勤日数" value={`${sum.attendDays} 日`} />
            <Stat label="遅刻・早退" value={fmtHm(sum.lateMin + sum.earlyMin)} />
            <Stat label="シフト外残業" value={fmtHm(sum.outsideMin)} sub={sum.fixedMin ? `固定残業 ${fmtHm(sum.fixedMin)}` : undefined} />
            <Stat label="有給の取得" value={`${fmtDays(sum.paidDays)}`} />
            {balance && <Stat label="有給の残り" value={fmtDays(sum.paidRemaining)} />}
            {balance && <Stat label="振休の残り" value={fmtDays(sum.compRemaining)} />}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link href={`/attendance?tab=sheet&month=${ym}`} className={buttonClass("secondary", "sm")}>勤務表を見る</Link>
            <Link href="/leave?tab=me" className={buttonClass("ghost", "sm")}>有給・振休を申請</Link>
          </div>
        </Card>
      </div>
    </div>
  );
}
