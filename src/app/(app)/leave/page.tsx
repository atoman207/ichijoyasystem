import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { toDateKey } from "@/lib/format";
import { canApproveLeave, canManageLeaveGrants, canManageLeaveSettings, canViewLeaveOf, canViewLeaveReport, isManagerOrAbove } from "@/lib/auth/permissions";
import { hrSettings, leaveEmployees } from "@/lib/hr/leave";
import { hrTablesReady } from "@/lib/hr/tables";
import { Flash, LinkTabs, Note, PageHeader } from "@/components/ui";
import type { Ctx } from "./parts";
import { MeTab } from "./tab-me";
import { ApproveTab } from "./tab-approve";
import { StaffTab } from "./tab-staff";
import { CompTab } from "./tab-comp";
import { YearTab } from "./tab-year";
import { SetupTab } from "./tab-setup";

export const metadata: Metadata = { title: "有給・休日出勤" };

/**
 * 有給・休日出勤の管理 (F-16)
 * 有給の残日数と休暇の申請 (全員)、承認 (店長・管理者)、社員ごとの一覧・休日出勤と振休・年度の取得状況 (店長は自店舗、本部・管理者は全員)、
 * 切り替え時点の残日数の取込とルール (本部・管理者)。計算は src/lib/hr/leave.ts、操作は src/lib/actions/leave.ts
 */
export default async function LeavePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const today = toDateKey(new Date());
  const employees = leaveEmployees(db).filter((u) => canViewLeaveOf(user, u));
  if (!employees.some((u) => u.id === user.id)) employees.unshift(user);
  const report = canViewLeaveReport(user);
  const approver = isManagerOrAbove(user);
  const pendingCount = db.leaveRequests.filter((r) => r.status === "pending" && canApproveLeave(user, r)).length;
  const tabs = [
    { id: "me", label: "自分の休暇・申請", show: true },
    { id: "approve", label: "承認待ち", show: approver, count: pendingCount },
    { id: "staff", label: "社員ごとの残日数", show: report },
    { id: "comp", label: "休日出勤・振休の未取得", show: report },
    { id: "year", label: "年度の取得状況・CSV", show: report },
    { id: "setup", label: "取込・ルール", show: canManageLeaveGrants(user) || canManageLeaveSettings(user) || report },
  ].filter((t) => t.show);
  const tab = tabs.some((t) => t.id === sp.tab) ? sp.tab! : pendingCount > 0 && !sp.tab ? "approve" : "me";
  const returnTo = `/leave?tab=${tab}${tab === "me" && sp.user ? `&user=${encodeURIComponent(sp.user)}` : ""}${tab === "year" && sp.mode ? `&mode=${sp.mode}` : ""}`;
  const ready = hrTablesReady();
  const ctx: Ctx = { db, user, sp, today, settings: hrSettings(db), employees, ready, returnTo };

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader
        title="有給・休日出勤"
        description="有給の残日数と休暇 (有給・振休・特別休暇。終日・午前・午後) の申請、店長・管理者の承認、休日出勤と振休の対応、年度 (7 月〜翌 6 月) の取得状況。承認した休暇は予定表に「休暇」として載り、予定の重複の警告に入ります。出勤・退勤の打刻・勤務表・打刻修正と休日出勤の申請・労務士へ送る勤務表は「勤怠」で行います"
      />
      <p className="mb-3 text-sm text-ink-2">
        <Link href="/attendance" className="text-accent underline-offset-2 hover:underline">勤怠 (打刻・勤務表・休日出勤の申請・労務士へ送る勤務表)</Link>
      </p>
      {!ready && <Note tone="warn">有給・休日出勤の表がまだデータベースにありません。管理者がデプロイ (npm run deploy) するまで、表示は空で、登録はできません。</Note>}
      <LinkTabs current={`/leave?tab=${tab}`} items={tabs.map((t) => ({ href: `/leave?tab=${t.id}`, label: t.label, count: "count" in t && t.count ? t.count : undefined }))} />
      {tab === "me" && <MeTab ctx={ctx} />}
      {tab === "approve" && <ApproveTab ctx={ctx} />}
      {tab === "staff" && <StaffTab ctx={ctx} />}
      {tab === "comp" && <CompTab ctx={ctx} />}
      {tab === "year" && <YearTab ctx={ctx} />}
      {tab === "setup" && <SetupTab ctx={ctx} />}
    </div>
  );
}
