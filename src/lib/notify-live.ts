import "server-only";
import { createHash } from "node:crypto";
import type { User } from "@/lib/db/types";
import { getDb } from "@/lib/db/store";
import { notificationsFor, type NotificationSummary } from "@/lib/db/queries";
import { pendingReceptionCount } from "@/lib/reception";
import { canApproveLeave } from "@/lib/auth/permissions";

/**
 * ヘッダーの件数 (承認・問い合わせ・通知のベル) の印。画面を開いたままでも、新しい承認の申請・問い合わせが届いたら
 * 1 分以内にヘッダーの数字とベルを新しくする (お客様のご要望 2026-11-23: 承認の申請が来たらベルと承認のアイコンに件数)。
 * AppShell が /api/notifications/summary を 1 分ごとに読み、印が変わったときだけ画面を読み直す (router.refresh)
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
  ];
  return { sig: createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16), approvals: n.pendingApprovals.length };
}
