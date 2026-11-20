import Link from "@/components/ui/Link";
import { canApproveLeave, canViewLeaveOf } from "@/lib/auth/permissions";
import { userName } from "@/lib/db/queries";
import { fmtDateTime } from "@/lib/format";
import { compBalance, fmtDays, leaveConflicts, paidRemainingOn } from "@/lib/hr/leave";
import { decideLeaveRequest } from "@/lib/actions/leave";
import { Button, Card, Input, Note, StoreTag } from "@/components/ui";
import { LeaveStatusBadge, LeaveTypeBadge, leaveWhen, type Ctx } from "./parts";

/** 承認待ちの休暇 (店長は自店舗の社員、管理者は全員) と最近の判断 */
export function ApproveTab({ ctx }: { ctx: Ctx }) {
  const { db, user } = ctx;
  const storeMap = new Map(db.stores.map((s) => [s.id, s]));
  const pending = db.leaveRequests.filter((r) => r.status === "pending" && canApproveLeave(user, r)).sort((a, b) => a.date.localeCompare(b.date));
  const waiting = db.leaveRequests.filter((r) => r.status === "pending" && !canApproveLeave(user, r) && canViewLeaveOf(user, { id: r.userId, storeId: r.storeId })).sort((a, b) => a.date.localeCompare(b.date));
  const recent = db.leaveRequests
    .filter((r) => r.status !== "pending" && r.decidedBy && canViewLeaveOf(user, { id: r.userId, storeId: r.storeId }))
    .sort((a, b) => (b.decidedAt ?? "").localeCompare(a.decidedAt ?? ""))
    .slice(0, 20);

  return (
    <div className="space-y-4">
      <Note>店長は所属店舗の社員の申請、管理者はすべての申請を判断します (店長自身の休暇は管理者が承認)。承認すると予定表に「休暇」として登録され、残日数が減ります。却下は理由のコメントが必要です。</Note>
      {pending.length === 0 && <Card><p className="py-6 text-center text-sm text-ink-3">承認待ちの休暇はありません</p></Card>}
      {pending.map((r) => {
        const conflicts = leaveConflicts(db, r);
        const paidLeft = r.leaveType === "paid" ? paidRemainingOn(db, r.userId, r.date) : undefined;
        const comp = r.leaveType === "comp" ? compBalance(db, r.userId) : undefined;
        return (
          <Card key={r.id}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <LeaveTypeBadge type={r.leaveType} />
                  <span className="text-sm font-semibold text-ink">{userName(r.userId)}</span>
                  <StoreTag store={storeMap.get(r.storeId)} short />
                  <span className="text-sm tnum">{leaveWhen(r)} · {fmtDays(r.days)}</span>
                </div>
                <div className="mt-1 text-xs text-ink-3">
                  {r.number} · 申請 {userName(r.requestedBy)} {fmtDateTime(r.requestedAt)}
                  {r.reason && <> · 理由: {r.reason}</>}
                </div>
                <div className="mt-1 text-xs text-ink-2">
                  {paidLeft !== undefined && <>承認前の有給の残 {fmtDays(paidLeft)} → 承認後 {fmtDays(Math.max(0, paidLeft - r.days))}</>}
                  {comp && <>振休の残り {fmtDays(comp.remaining)} → 承認後 {fmtDays(Math.max(0, comp.remaining - r.days))}</>}
                  {" · "}
                  <Link href={`/leave?tab=me&user=${r.userId}`} className="text-accent hover:underline">この社員の残日数・履歴</Link>
                </div>
                {conflicts.length > 0 && (
                  <div className="mt-2 rounded-lg border border-warn/30 bg-warn-soft px-3 py-2 text-xs text-warn-ink">
                    この期間に予定が {conflicts.length} 件あります。承認したら予定表で担当を調整してください:
                    <ul className="mt-1 list-disc pl-4">
                      {conflicts.slice(0, 5).map((c) => <li key={c.event.id}><Link href={`/schedule/${c.event.id}`} className="hover:underline">{c.label}</Link></li>)}
                    </ul>
                  </div>
                )}
              </div>
            </div>
            {ctx.ready && (
              <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-line pt-3">
                <form action={decideLeaveRequest.bind(null, r.id, "approved")} className="flex flex-wrap items-center gap-2">
                  <input type="hidden" name="returnTo" value={ctx.returnTo} />
                  <Input name="comment" placeholder="コメント (任意)" className="h-8 w-48 text-xs" aria-label="承認のコメント" />
                  <Button type="submit" size="sm">承認</Button>
                </form>
                <form action={decideLeaveRequest.bind(null, r.id, "rejected")} className="flex flex-wrap items-center gap-2">
                  <input type="hidden" name="returnTo" value={ctx.returnTo} />
                  <Input name="comment" placeholder="却下の理由 (必須)" className="h-8 w-48 text-xs" aria-label="却下の理由" required />
                  <Button type="submit" size="sm" variant="danger">却下</Button>
                </form>
              </div>
            )}
          </Card>
        );
      })}
      {waiting.length > 0 && (
        <Card>
          <div className="mb-2 text-sm font-medium text-ink">ほかの承認者の判断を待っている申請</div>
          <ul className="divide-y divide-line text-sm">
            {waiting.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2 py-2">
                <LeaveTypeBadge type={r.leaveType} />
                <span>{userName(r.userId)}</span>
                <span className="tnum text-ink-2">{leaveWhen(r)} · {fmtDays(r.days)}</span>
                <span className="text-xs text-ink-3">{r.userId === user.id ? "管理者の承認待ち" : "所属店舗の店長の承認待ち"}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Card>
        <div className="mb-2 text-sm font-medium text-ink">最近の判断</div>
        <ul className="divide-y divide-line text-sm">
          {recent.length === 0 && <li className="py-4 text-center text-xs text-ink-3">まだありません</li>}
          {recent.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-2 py-2">
              <LeaveStatusBadge status={r.status} />
              <LeaveTypeBadge type={r.leaveType} />
              <span>{userName(r.userId)}</span>
              <span className="tnum text-ink-2">{leaveWhen(r)} · {fmtDays(r.days)}</span>
              <span className="text-xs text-ink-3">判断 {userName(r.decidedBy)} {fmtDateTime(r.decidedAt)}{r.decisionComment ? ` · ${r.decisionComment}` : ""}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
