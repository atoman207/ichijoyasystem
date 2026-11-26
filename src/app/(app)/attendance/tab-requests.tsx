import Link from "@/components/ui/Link";
import type { AttendanceRequest, LeaveRequest } from "@/lib/db/types";
import { canApproveAttendance, canApproveLeave, canCancelAttendanceRequest, canViewAttendanceOf } from "@/lib/auth/permissions";
import { bulkApproveAttendance, cancelAttendance, decideAttendance } from "@/lib/actions/timecard";
import { fmtDays, LEAVE_SLOT, LEAVE_STATUS, LEAVE_TYPE } from "@/lib/hr/leave";
import { KIND_LABEL, shiftOf } from "@/lib/hr/timecard";
import { PendingButton } from "@/components/ui/PendingButton";
import { Badge, Card, CardHeader, EmptyState, Input, Select, buttonClass } from "@/components/ui";
import { mdw, type Ctx } from "./parts";

type Row = { key: string; kind: "at" | "lv"; userId: string; storeId: string; date: string; requestedAt: string; label: string; detail: string; reason?: string; requestedBy: string; at?: AttendanceRequest; lv?: LeaveRequest };

/**
 * 申請・承認 (キャスタイムの「管理者申請一覧」: 全員分の申請を種類・社員で絞り、1 件ずつ承認・否認、まとめて承認)。
 * 打刻修正・休日出勤 (attendance_requests) と 有給・振休・特別休暇 (leave_requests) を 1 つの一覧に
 */
export function RequestsTab({ ctx }: { ctx: Ctx }) {
  const { db, user, sp, settings, clerks } = ctx;
  const nameOf = (id: string) => db.users.find((u) => u.id === id)?.name ?? "-";
  const breakNames = (userId: string) => {
    const u = db.users.find((x) => x.id === userId);
    return u ? shiftOf(settings, u, clerks).breaks.map((b) => `${b.start}〜${b.end}`) : [];
  };
  const atRow = (r: AttendanceRequest): Row => {
    const names = breakNames(r.userId);
    const parts = [r.kind === "holiday_work" ? LEAVE_SLOT[r.slot ?? "day"] : "", r.clockIn ? `出勤 ${r.clockIn}` : "", r.clockOut ? `退勤 ${r.clockOut}` : "", r.skipBreaks ? `休憩を外す: ${r.skipBreaks.length ? r.skipBreaks.map((i) => names[i] ?? `休憩${i + 1}`).join("・") : "なし (元に戻す)"}` : ""].filter(Boolean);
    const prev = r.previous ? [r.previous.clockIn ? `出勤 ${r.previous.clockIn}` : "出勤 なし", r.previous.clockOut ? `退勤 ${r.previous.clockOut}` : "退勤 なし"].join(" · ") : "打刻なし";
    return { key: `at:${r.id}`, kind: "at", userId: r.userId, storeId: r.storeId, date: r.date, requestedAt: r.requestedAt, label: `${r.number} ${KIND_LABEL[r.kind]}`, detail: `${parts.join(" / ")}${r.kind === "correction" ? ` (申請の前: ${prev})` : ""}`, reason: r.reason, requestedBy: r.requestedBy, at: r };
  };
  const lvRow = (r: LeaveRequest): Row => ({
    key: `lv:${r.id}`,
    kind: "lv",
    userId: r.userId,
    storeId: r.storeId,
    date: r.date,
    requestedAt: r.requestedAt,
    label: `${r.number} ${LEAVE_TYPE[r.leaveType].label}`,
    detail: `${r.endDate && r.endDate > r.date ? `〜${mdw(r.endDate)} ` : ""}${LEAVE_SLOT[r.slot]} · ${fmtDays(r.days)}`,
    reason: r.reason,
    requestedBy: r.requestedBy,
    lv: r,
  });
  const typeFilter = sp.type === "correction" || sp.type === "holiday_work" || sp.type === "leave" ? sp.type : "";
  const who = sp.who ?? "";
  const pass = (r: Row) => (!who || r.userId === who) && (!typeFilter || (typeFilter === "leave" ? r.kind === "lv" : r.at?.kind === typeFilter));
  const approvable = [
    ...db.attendanceRequests.filter((r) => r.status === "pending" && canApproveAttendance(user, r)).map(atRow),
    ...db.leaveRequests.filter((r) => r.status === "pending" && canApproveLeave(user, r)).map(lvRow),
  ]
    .filter(pass)
    .sort((a, b) => a.date.localeCompare(b.date) || a.requestedAt.localeCompare(b.requestedAt));
  const mine = db.attendanceRequests
    .filter((r) => r.userId === user.id || r.requestedBy === user.id)
    .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
    .slice(0, 40);
  const decided = db.attendanceRequests
    .filter((r) => r.status !== "pending" && r.decidedBy && (canApproveAttendance(user, r) || canViewAttendanceOf(user, { id: r.userId, storeId: r.storeId })) && r.userId !== user.id)
    .sort((a, b) => (b.decidedAt ?? b.updatedAt).localeCompare(a.decidedAt ?? a.updatedAt))
    .slice(0, 30);
  const approver = user.role === "admin" || user.role === "store_manager";
  const people = [...new Set([...db.attendanceRequests, ...db.leaveRequests].filter((r) => r.status === "pending").map((r) => r.userId))].filter((id) => canViewAttendanceOf(user, { id, storeId: db.users.find((u) => u.id === id)?.storeId ?? "" }));
  const back = `/attendance?tab=requests${typeFilter ? `&type=${typeFilter}` : ""}${who ? `&who=${who}` : ""}`;
  return (
    <div className="space-y-4">
      {approver && (
        <Card>
          <CardHeader title={`承認待ち (${approvable.length})`} description="打刻修正・休日出勤と、有給・振休・特別休暇。チェックしてまとめて承認できます (却下は 1 件ずつ理由を入れて)" />
          <form method="get" action="/attendance" className="mb-3 flex flex-wrap items-end gap-2 text-sm">
            <input type="hidden" name="tab" value="requests" />
            <Select name="type" defaultValue={typeFilter} aria-label="申請の種類">
              <option value="">すべての種類</option>
              <option value="correction">打刻修正</option>
              <option value="holiday_work">休日出勤</option>
              <option value="leave">有給・振休・特別休暇</option>
            </Select>
            <Select name="who" defaultValue={who} aria-label="社員">
              <option value="">すべての社員</option>
              {people.map((id) => (
                <option key={id} value={id}>
                  {nameOf(id)}
                </option>
              ))}
            </Select>
            <button type="submit" className={buttonClass("secondary", "sm")}>絞り込む</button>
          </form>
          {approvable.length === 0 ? (
            <EmptyState title="承認待ちの申請はありません" />
          ) : (
            <>
              <form id="bulk-approve" action={bulkApproveAttendance}>
                <input type="hidden" name="returnTo" value={back} />
              </form>
              <ul className="divide-y divide-line">
                {approvable.map((r) => (
                  <li key={r.key} className="flex flex-col gap-2 py-3 @3xl:flex-row @3xl:items-start @3xl:justify-between">
                    <label className="flex min-w-0 items-start gap-2">
                      <input type="checkbox" name="pick" value={r.key} form="bulk-approve" className="mt-1" defaultChecked />
                      <span className="min-w-0">
                        <span className="font-medium text-ink">{nameOf(r.userId)}</span> <span className="text-ink-2">{mdw(r.date)}</span> <Badge tone={r.kind === "lv" ? "accent" : r.at?.kind === "holiday_work" ? "warn" : "info"} dot={false}>{r.label}</Badge>
                        <span className="block text-xs text-ink-2">{r.detail}</span>
                        {r.reason && <span className="block text-xs text-ink-3">理由: {r.reason}</span>}
                        {r.requestedBy !== r.userId && <span className="block text-[11px] text-ink-3">{nameOf(r.requestedBy)} さんが代わりに申請</span>}
                      </span>
                    </label>
                    {r.kind === "at" ? (
                      <form action={decideAttendance} className="flex shrink-0 flex-wrap items-center gap-1.5">
                        <input type="hidden" name="id" value={r.at!.id} />
                        <input type="hidden" name="returnTo" value={back} />
                        <Input name="comment" placeholder="コメント (却下は必須)" className="w-48" aria-label="コメント" />
                        <PendingButton type="submit" name="decision" value="approved" className={buttonClass("primary", "sm")}>承認</PendingButton>
                        <PendingButton type="submit" name="decision" value="rejected" className={buttonClass("danger", "sm")}>却下</PendingButton>
                      </form>
                    ) : (
                      <Link href="/leave?tab=approve" className={buttonClass("secondary", "sm", "shrink-0")}>有給・休暇で判断</Link>
                    )}
                  </li>
                ))}
              </ul>
              <div className="mt-3 border-t border-line pt-3">
                <PendingButton type="submit" form="bulk-approve" className={buttonClass("primary", "md")}>チェックした申請をまとめて承認</PendingButton>
              </div>
            </>
          )}
        </Card>
      )}

      <Card>
        <CardHeader title="自分の申請・代わりに出した申請" description="打刻修正・休日出勤。有給・振休は「有給・休暇」に出ます" action={<Link href="/attendance?tab=sheet" className={buttonClass("secondary", "sm")}>勤務表から申請</Link>} />
        {mine.length === 0 ? (
          <p className="text-sm text-ink-3">申請はありません。勤務表の行の「直す」から申請します。</p>
        ) : (
          <RequestList rows={mine} ctx={ctx} back={back} />
        )}
      </Card>

      {decided.length > 0 && (
        <Card>
          <CardHeader title="最近処理した申請" />
          <RequestList rows={decided} ctx={ctx} back={back} />
        </Card>
      )}
    </div>
  );
}

function RequestList({ rows, ctx, back }: { rows: AttendanceRequest[]; ctx: Ctx; back: string }) {
  const { db, user } = ctx;
  const nameOf = (id?: string) => db.users.find((u) => u.id === id)?.name ?? "-";
  return (
    <ul className="divide-y divide-line text-sm">
      {rows.map((r) => (
        <li key={r.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
          <div className="min-w-0">
            <span className="font-mono text-xs text-ink-3">{r.number}</span> <span className="font-medium text-ink">{nameOf(r.userId)}</span> {mdw(r.date)} {KIND_LABEL[r.kind]} <Badge tone={LEAVE_STATUS[r.status].tone} dot={false}>{LEAVE_STATUS[r.status].label}</Badge>
            <div className="text-xs text-ink-2">
              {[r.clockIn && `出勤 ${r.clockIn}`, r.clockOut && `退勤 ${r.clockOut}`, r.kind === "holiday_work" && LEAVE_SLOT[r.slot ?? "day"]].filter(Boolean).join(" / ")} · 理由: {r.reason}
            </div>
            {r.decidedBy && (
              <div className="text-[11px] text-ink-3">
                {nameOf(r.decidedBy)} さんが{r.status === "rejected" ? "却下" : "承認"}
                {r.decisionComment ? ` (${r.decisionComment})` : ""}
              </div>
            )}
          </div>
          {canCancelAttendanceRequest(user, r) && (
            <form action={cancelAttendance} className="flex items-center gap-1.5">
              <input type="hidden" name="id" value={r.id} />
              <input type="hidden" name="returnTo" value={back} />
              {r.status === "approved" && <Input name="reason" placeholder="取消しの理由" className="w-40" aria-label="取消しの理由" />}
              <PendingButton type="submit" className={buttonClass("ghost", "sm")}>{r.status === "approved" ? "承認を取り消す" : "取り下げる"}</PendingButton>
            </form>
          )}
        </li>
      ))}
    </ul>
  );
}
