import Link from "@/components/ui/Link";
import { Printer } from "lucide-react";
import { canApproveAttendance, canRequestAttendanceFor, canViewLeaveBalanceOf } from "@/lib/auth/permissions";
import { requestAttendance } from "@/lib/actions/timecard";
import { fmtDays, LEAVE_SLOT, LEAVE_TYPE } from "@/lib/hr/leave";
import { KIND_LABEL, attendancePeriod, clock, fmtHm, periodSummary, STAFF_CATEGORY, type DayCalc } from "@/lib/hr/timecard";
import { PendingButton } from "@/components/ui/PendingButton";
import { Badge, Card, CardHeader, Field, Input, Note, Select, Stat, buttonClass } from "@/components/ui";
import { DayTypeBadge, mdw, monthChoices, visibleEmployees, ymLabel, type Ctx } from "./parts";

const hm = (m?: number) => (m === undefined ? "" : clock(m));
const zero = (m: number) => (m > 0 ? fmtHm(m) : "");

/** 勤務表 (キャスタイムの「勤務表」: 日ごとの打刻・休憩・勤務・遅刻・早退・シフト外残業・深夜・休暇。行の「直す」から打刻修正・休日出勤を申請) */
export function SheetTab({ ctx }: { ctx: Ctx }) {
  const { db, user, sp, today, clerks } = ctx;
  const employees = visibleEmployees(ctx);
  const target = employees.find((u) => u.id === sp.user) ?? user;
  const months = monthChoices(ctx);
  const ym = sp.month && /^\d{4}-\d{2}$/.test(sp.month) ? sp.month : months[1];
  const { from, to } = attendancePeriod(db, ym);
  const sum = periodSummary(db, target, from, to, today, clerks);
  const balance = canViewLeaveBalanceOf(user, target);
  const canAsk = canRequestAttendanceFor(user, target) && ctx.ready;
  const settles = canApproveAttendance(user, { userId: target.id, storeId: target.storeId });
  const back = `/attendance?tab=sheet&month=${ym}${target.id !== user.id ? `&user=${target.id}` : ""}`;
  const store = db.stores.find((s) => s.id === target.storeId);
  return (
    <div className="space-y-4">
      <Card>
        <form method="get" action="/attendance" className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="tab" value="sheet" />
          {employees.length > 1 && (
            <Field label="社員">
              <Select name="user" defaultValue={target.id}>
                {employees.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                    {u.id === user.id ? " (自分)" : ""} · {db.stores.find((s) => s.id === u.storeId)?.shortName ?? ""}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="月 (20 日締め)">
            <Select name="month" defaultValue={ym}>
              {months.map((m) => (
                <option key={m} value={m}>
                  {ymLabel(m)}
                </option>
              ))}
            </Select>
          </Field>
          <button type="submit" className={buttonClass("secondary", "md")}>表示</button>
          <Link href={`/print/attendance?month=${ym}&user=${target.id}`} className={buttonClass("ghost", "md")} target="_blank">
            <Printer aria-hidden /> 印刷
          </Link>
        </form>
      </Card>

      <Card>
        <CardHeader
          title={`${target.name} · ${ymLabel(ym)}`}
          description={`${Number(from.slice(5, 7))}/${Number(from.slice(8))}〜${Number(to.slice(5, 7))}/${Number(to.slice(8))} · ${store?.shortName ?? ""} · ${STAFF_CATEGORY[sum.category].label} · シフト ${sum.shift.name} ${sum.shift.start}〜${sum.shift.end}`}
        />
        <div className="grid grid-cols-2 gap-3 @xl:grid-cols-4 @4xl:grid-cols-8">
          <Stat label="出勤日数" value={`${sum.attendDays}`} />
          {sum.category !== "part" && <Stat label="欠勤" value={`${sum.absentDays}`} tone={sum.absentDays ? "warn" : undefined} />}
          {sum.category !== "part" && <Stat label="遅刻・早退" value={fmtHm(sum.lateMin + sum.earlyMin)} />}
          <Stat label={sum.category === "part" ? "出勤時間" : "勤務時間"} value={fmtHm(sum.workedMin)} />
          {sum.category !== "part" && <Stat label="シフト外残業" value={fmtHm(sum.outsideMin)} sub={`固定 ${fmtHm(sum.fixedMin)} → 残業 ${fmtHm(sum.overtimeMin)}`} />}
          {sum.nightMin > 0 && <Stat label="深夜" value={fmtHm(sum.nightMin)} />}
          <Stat label="有給" value={fmtDays(sum.paidDays)} />
          {sum.compDays > 0 && <Stat label="振休消化" value={fmtDays(sum.compDays)} />}
          {sum.holidayWorkDays > 0 && <Stat label="休日出勤" value={fmtDays(sum.holidayWorkDays)} />}
          {balance && <Stat label="有給の残り" value={fmtDays(sum.paidRemaining)} sub={`${to} 時点`} />}
          {balance && <Stat label="振休の残り" value={fmtDays(sum.compRemaining)} />}
        </div>
        {(sum.missing > 0 || sum.pendingRequests > 0) && (
          <div className="mt-3">
            <Note tone="warn">
              {sum.missing > 0 ? `打刻漏れが ${sum.missing} 日あります。` : ""}
              {sum.pendingRequests > 0 ? `承認待ちの申請が ${sum.pendingRequests} 件あります。` : ""}
              締めまでに直してください (労務士へ送る勤務表に反映されません)。
            </Note>
          </div>
        )}
      </Card>

      <Card padded={false}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-left text-xs">
            <thead className="bg-subtle text-ink-2">
              <tr>
                <th className="px-2 py-2">日付</th>
                <th className="px-2 py-2">出勤</th>
                <th className="px-2 py-2">退勤</th>
                <th className="px-2 py-2">休憩</th>
                <th className="px-2 py-2">勤務</th>
                <th className="px-2 py-2">遅刻</th>
                <th className="px-2 py-2">早退</th>
                <th className="px-2 py-2">シフト外</th>
                <th className="px-2 py-2">深夜</th>
                <th className="px-2 py-2">休暇・休日出勤</th>
                <th className="px-2 py-2">状態</th>
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {sum.days.map((d) => (
                <DayRow key={d.date} d={d} ctx={ctx} targetId={target.id} canAsk={canAsk && d.date <= today} settles={settles} back={back} />
              ))}
            </tbody>
            <tfoot className="border-t-2 border-line bg-subtle font-medium">
              <tr>
                <td className="px-2 py-2">合計</td>
                <td className="px-2 py-2" colSpan={3}>
                  出勤 {sum.attendDays} 日{sum.absentDays ? ` · 欠勤 ${sum.absentDays} 日` : ""}
                </td>
                <td className="px-2 py-2">{fmtHm(sum.workedMin)}</td>
                <td className="px-2 py-2">{zero(sum.lateMin)}</td>
                <td className="px-2 py-2">{zero(sum.earlyMin)}</td>
                <td className="px-2 py-2">{zero(sum.outsideMin)}</td>
                <td className="px-2 py-2">{zero(sum.nightMin)}</td>
                <td className="px-2 py-2" colSpan={3}>
                  有給 {fmtDays(sum.paidDays)}
                  {sum.compDays ? ` · 振休 ${fmtDays(sum.compDays)}` : ""}
                  {sum.specialDays ? ` · 特別休暇 ${fmtDays(sum.specialDays)}` : ""}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>
      <p className="text-xs text-ink-3">
        休憩は、シフトの休憩の時間に働いていた (出勤〜退勤の中にまるごと入る) ときだけ引きます。早退・遅刻で休憩をとらなかった時間は勤務です。遅刻・早退はシフトの勤務時間のうち出勤前・退勤後の時間 (半日の休暇の日はその半分を除く)。
        休日 (会社の休業日) の打刻は、休日出勤の申請が承認されると出勤日数に入ります。有給・振休・特別休暇は <Link href={`/leave?tab=me${target.id !== user.id ? `&user=${target.id}` : ""}`} className="text-accent hover:underline">有給・休暇</Link> で申請します。
      </p>
    </div>
  );
}

function DayRow({ d, ctx, targetId, canAsk, settles, back }: { d: DayCalc; ctx: Ctx; targetId: string; canAsk: boolean; settles: boolean; back: string }) {
  const off = d.dayType !== "work";
  const warn = d.missing || d.warnings.length > 0;
  const tone = d.date === ctx.today ? "bg-accent-soft/40" : off ? "bg-subtle/60" : "";
  const leaveText = [
    ...d.leaves.map((l) => `${LEAVE_TYPE[l.type].short}${l.slot === "day" ? "" : `(${LEAVE_SLOT[l.slot]})`}`),
    ...(d.holidayWork ? [`休日出勤${d.holidayWork.slot === "day" ? "" : `(${LEAVE_SLOT[d.holidayWork.slot]})`}`] : []),
  ].join(" ");
  const breakText = d.breaks.filter((b) => b.counted).length ? fmtHm(d.breakMin) : d.inMin !== undefined && d.outMin !== undefined ? "0:00" : "";
  const skipped = d.breaks.filter((b) => b.skipped);
  return (
    <tr className={`border-t border-line align-top ${tone}`}>
      <td className="whitespace-nowrap px-2 py-1.5">
        <span className={off ? "text-critical-ink" : "text-ink"}>{mdw(d.date)}</span>
        {d.holiday && <div className="text-[10px] text-ink-3">{d.holiday}</div>}
        <div className="mt-0.5">
          <DayTypeBadge d={d} />
        </div>
      </td>
      <td className="px-2 py-1.5 tabular-nums">{hm(d.inMin)}</td>
      <td className="px-2 py-1.5 tabular-nums">{d.outMin !== undefined && d.outMin >= 1440 ? `翌${clock(d.outMin - 1440)}` : hm(d.outMin)}</td>
      <td className="px-2 py-1.5 tabular-nums">
        {breakText}
        {skipped.length > 0 && <div className="text-[10px] text-ink-3">外した休憩 {skipped.length}</div>}
      </td>
      <td className="px-2 py-1.5 tabular-nums">{zero(d.workedMin)}</td>
      <td className="px-2 py-1.5 tabular-nums">{zero(d.lateMin)}</td>
      <td className="px-2 py-1.5 tabular-nums">{zero(d.earlyMin)}</td>
      <td className="px-2 py-1.5 tabular-nums">{zero(d.outsideMin)}</td>
      <td className="px-2 py-1.5 tabular-nums">{zero(d.nightMin)}</td>
      <td className="px-2 py-1.5">{leaveText}</td>
      <td className="px-2 py-1.5">
        {d.absent && <Badge tone="critical" dot={false}>欠勤</Badge>}
        {d.working && <Badge tone="good" dot={false}>出勤中</Badge>}
        {d.pending.map((p) => (
          <Badge key={p.id} tone="warn" dot={false}>
            {KIND_LABEL[p.kind]} 申請中
          </Badge>
        ))}
        {warn && <div className="mt-0.5 max-w-[14rem] text-[11px] text-critical-ink">{d.warnings.join(" / ")}</div>}
      </td>
      <td className="px-2 py-1.5">
        {canAsk && (
          <details className="group">
            <summary className="cursor-pointer list-none text-accent hover:underline">{off && !d.holidayWork ? "申請" : "直す"}</summary>
            <div className="mt-2 w-[20rem] max-w-[80vw] space-y-3 rounded-xl border border-line bg-panel p-3 shadow-card">
              {!off || d.holidayWork ? <CorrectionForm d={d} targetId={targetId} back={back} settles={settles} /> : <HolidayWorkForm d={d} targetId={targetId} back={back} settles={settles} />}
              {d.record?.log.length ? (
                <div className="border-t border-line pt-2 text-[11px] text-ink-3">
                  <div className="mb-1 font-medium text-ink-2">打刻の記録</div>
                  <ul className="space-y-0.5">
                    {d.record.log.slice(-8).map((l, i) => (
                      <li key={i}>
                        {l.at.slice(5, 16).replace("T", " ")} {l.kind === "in" ? "出勤" : l.kind === "out" ? "退勤" : l.kind === "breaks" ? "休憩" : l.kind === "clear" ? "取消" : "修正"} {l.value ?? ""}
                        {l.before ? ` (前: ${l.before})` : ""} · {ctx.db.users.find((u) => u.id === l.by)?.name ?? ""}
                        {l.note ? ` · ${l.note}` : ""}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </details>
        )}
      </td>
    </tr>
  );
}

function CorrectionForm({ d, targetId, back, settles }: { d: DayCalc; targetId: string; back: string; settles: boolean }) {
  return (
    <form action={requestAttendance} className="space-y-2">
      <input type="hidden" name="kind" value="correction" />
      <input type="hidden" name="userId" value={targetId} />
      <input type="hidden" name="date" value={d.date} />
      <input type="hidden" name="returnTo" value={back} />
      <div className="text-xs font-medium text-ink">打刻修正 {mdw(d.date)}</div>
      <div className="grid grid-cols-2 gap-2">
        <Field label="出勤">
          <Input name="clockIn" defaultValue={hm(d.inMin)} placeholder="08:00" inputMode="numeric" />
        </Field>
        <Field label="退勤" hint="翌朝は 25:30 など">
          <Input name="clockOut" defaultValue={hm(d.outMin)} placeholder="17:00" inputMode="numeric" />
        </Field>
      </div>
      {d.shift.breaks.length > 0 && (
        <fieldset className="space-y-1 text-xs">
          <label className="flex items-center gap-1.5">
            <input type="checkbox" name="changeBreaks" value="1" /> 休憩を直す (とらなかった休憩にチェック)
          </label>
          {d.shift.breaks.map((b, i) => (
            <label key={i} className="ml-5 flex items-center gap-1.5 text-ink-2">
              <input type="checkbox" name={`skip_${i}`} value="1" defaultChecked={d.breaks[i]?.skipped} /> {b.start}〜{b.end} をとらなかった
            </label>
          ))}
        </fieldset>
      )}
      <Field label="理由" required>
        <Input name="reason" required placeholder="例: 退勤の打刻を忘れた" />
      </Field>
      <PendingButton type="submit" className={buttonClass("primary", "sm")}>
        {settles ? "直す (承認済みにする)" : "打刻修正を申請"}
      </PendingButton>
    </form>
  );
}

function HolidayWorkForm({ d, targetId, back, settles }: { d: DayCalc; targetId: string; back: string; settles: boolean }) {
  return (
    <form action={requestAttendance} className="space-y-2">
      <input type="hidden" name="kind" value="holiday_work" />
      <input type="hidden" name="userId" value={targetId} />
      <input type="hidden" name="date" value={d.date} />
      <input type="hidden" name="returnTo" value={back} />
      <div className="text-xs font-medium text-ink">休日出勤 {mdw(d.date)} (承認で振休が付きます)</div>
      <Field label="区分">
        <Select name="slot" defaultValue="day">
          <option value="day">終日 (振休 1 日)</option>
          <option value="am">午前 (振休 0.5 日)</option>
          <option value="pm">午後 (振休 0.5 日)</option>
        </Select>
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="出勤" hint="打刻があれば空で可">
          <Input name="clockIn" defaultValue={hm(d.inMin)} placeholder="08:00" inputMode="numeric" />
        </Field>
        <Field label="退勤">
          <Input name="clockOut" defaultValue={hm(d.outMin)} placeholder="17:00" inputMode="numeric" />
        </Field>
      </div>
      <Field label="理由" required>
        <Input name="reason" required placeholder="例: 現場の納品のため" />
      </Field>
      <PendingButton type="submit" className={buttonClass("primary", "sm")}>
        {settles ? "休日出勤を登録 (承認済み)" : "休日出勤を申請"}
      </PendingButton>
    </form>
  );
}
