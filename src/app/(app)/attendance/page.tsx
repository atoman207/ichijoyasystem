import type { Metadata } from "next";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { toDateKey } from "@/lib/format";
import { canApproveAttendance, canApproveLeave, canManageAttendance, canViewAttendance } from "@/lib/auth/permissions";
import { attendanceTablesReady } from "@/lib/hr/tables";
import { attendanceSettings } from "@/lib/hr/timecard";
import { kpiSettings } from "@/lib/kpi-settings";
import { Flash, LinkTabs, Note, PageHeader } from "@/components/ui";
import type { Ctx } from "./parts";
import { StampTab } from "./tab-stamp";
import { SheetTab } from "./tab-sheet";
import { RequestsTab } from "./tab-requests";
import { MonthlyTab } from "./tab-monthly";
import { IncentiveTab } from "./tab-incentive";
import { SetupTab } from "./tab-setup";

export const metadata: Metadata = { title: "勤怠" };
export const dynamic = "force-dynamic";

/**
 * 勤怠 (キャスタイムの代わり。お客様のご要望 2026-11-26)
 * 打刻 (全員) → 勤務表 (日ごとの出勤・退勤・休憩・遅刻早退・残業・休暇。打刻修正・休日出勤の申請) → 申請・承認 (店長・管理者。まとめて承認) →
 * 労務士へ送る勤務表 (打刻・休暇・インセンティブから作る → 確定 → .xlsx をメールで送る。本部・管理者) → インセンティブ → 設定。
 * 計算は src/lib/hr/timecard.ts・attendance-build.ts・incentive-month.ts、操作は src/lib/actions/timecard.ts (と以前の月次表の attendance.ts)
 */
export default async function AttendancePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const today = toDateKey(new Date());
  const ctx: Ctx = { db, user, sp, today, settings: attendanceSettings(db), clerks: kpiSettings(db).clerkUserIds, ready: attendanceTablesReady() };
  const approver = user.role === "admin" || user.role === "store_manager";
  const pending =
    db.attendanceRequests.filter((r) => r.status === "pending" && canApproveAttendance(user, r)).length + db.leaveRequests.filter((r) => r.status === "pending" && canApproveLeave(user, r)).length;
  const tabs = [
    { id: "stamp", label: "打刻", show: true },
    { id: "sheet", label: "勤務表", show: true },
    { id: "requests", label: approver ? "申請・承認" : "申請", show: true, count: pending },
    { id: "monthly", label: "労務士へ送る勤務表", show: canViewAttendance(user) },
    { id: "incentive", label: "インセンティブ", show: canManageAttendance(user) },
    { id: "setup", label: "設定", show: canManageAttendance(user) },
  ].filter((t) => t.show);
  // 以前の月次表の画面 (?id= / ?month=) は「労務士へ送る勤務表」
  const fallback = (sp.id || sp.month) && tabs.some((t) => t.id === "monthly") ? "monthly" : "stamp";
  const tab = tabs.some((t) => t.id === sp.tab) ? sp.tab! : fallback;
  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader
        title="勤怠"
        description="出勤・退勤の打刻、勤務表 (日ごとの出勤・退勤・休憩・遅刻早退・残業・休暇)、打刻修正・休日出勤の申請と承認、労務士へ送る勤務表 (インセンティブを備考に)。有給・振休の申請は「有給・休暇」と共通です"
      />
      {!ctx.ready && <Note tone="warn">勤怠の表がまだデータベースにありません。管理者がデプロイ (npm run deploy) するまで、表示は空で、打刻・登録はできません。</Note>}
      <LinkTabs current={`/attendance?tab=${tab}`} items={tabs.map((t) => ({ href: `/attendance?tab=${t.id}`, label: t.label, count: "count" in t && t.count ? t.count : undefined }))} />
      {tab === "stamp" && <StampTab ctx={ctx} />}
      {tab === "sheet" && <SheetTab ctx={ctx} />}
      {tab === "requests" && <RequestsTab ctx={ctx} />}
      {tab === "monthly" && <MonthlyTab ctx={ctx} />}
      {tab === "incentive" && <IncentiveTab ctx={ctx} />}
      {tab === "setup" && <SetupTab ctx={ctx} />}
    </div>
  );
}
