import "server-only";
import { createHash } from "node:crypto";
import type { User } from "@/lib/db/types";
import { getDb } from "@/lib/db/store";
import { notificationsFor, type NotificationSummary } from "@/lib/db/queries";
import { pendingReceptionCount } from "@/lib/reception";
import { canApproveLeave, canApproveSignup, canTriageFax, canViewFax } from "@/lib/auth/permissions";
import { unreadNotices } from "@/lib/change-notices";
import { INBOUND_BELL_DAYS, inboundForUser } from "@/lib/inbound/feed";

/**
 * ヘッダーの件数 (承認・問い合わせ・通知のベル) の印。画面を開いたままでも、新しい承認の申請・問い合わせが届いたら
 * 1 分以内にヘッダーの数字とベルを新しくする (お客様のご要望 2026-11-23: 承認の申請が来たらベルと承認のアイコンに件数)。
 * AppShell が /api/notifications/summary を 1 分ごとに読み、印が変わったときだけ画面を読み直す (router.refresh)。
 * 読み直すと、新しく届いた通知が画面の右上にトーストで出る (2026-11-26。AppShell の freshNotices)。そのため、ベルに出る
 * 予定の担当・変更・予定の重複・FAX・新規登録の申請も印に入れる
 */
export function liveSignature(user: User, summary?: NotificationSummary): { sig: string; approvals: number } {
  const db = getDb();
  const n = summary ?? notificationsFor(user);
  const leave = (db.leaveRequests ?? []).filter((r) => r.status === "pending" && canApproveLeave(user, r)).map((r) => r.id);
  const parts = [
    n.pendingApprovals.map((a) => a.id).sort().join(","),
    String(n.newInquiries + pendingReceptionCount(db, user)),
    n.mentions.map((m) => `${m.threadId}@${m.at}`).join(","),
    String(n.taskCount),
    leave.sort().join(","),
    String(n.overdueInvoices),
    // 案件の変更のお知らせ (未読)
    unreadNotices(db, user).slice(0, 20).map((c) => `${c.id}@${c.at}`).join(","),
    // 担当になった・変わった予定と予定の重複 (ベルの「予定の担当になりました」「予定が変更されました」)
    n.assignedEvents.map((e) => `${e.id}@${e.stamp}`).join(","),
    String(n.myConflicts),
    // FAX: 要確認の受信 (仕分けをする人)・自分が担当の未確認の返信
    String((db.faxMessages ?? []).filter((f) => f.direction === "inbound" && ((f.triage === "review" && canTriageFax(user)) || (f.assignedUserId === user.id && f.purchaseOrderId && !f.checkedAt && canViewFax(user, f)))).length),
    // 新規登録の申請 (管理者)
    canApproveSignup(user) ? String(db.users.filter((u) => u.signupStatus === "pending").length) : "",
    // 外部から届いたメッセージ (LINE・メール・Slack・Chatwork。src/lib/inbound/feed.ts): 新しいものが届いたら読み直す
    inboundForUser(db, user, { days: INBOUND_BELL_DAYS }).slice(0, 5).map((i) => i.id).join(","),
  ];
  return { sig: createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16), approvals: n.pendingApprovals.length };
}
