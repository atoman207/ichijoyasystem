"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, getDb, mutate, nowIso } from "@/lib/db/store";
import { canApprove, canCancelApproval } from "@/lib/auth/permissions";
import { APPROVAL_STATUS, APPROVAL_TYPE_LABEL } from "@/lib/constants";
import type { Approval } from "@/lib/db/types";
import { removeUpcomingOrderEvents } from "@/lib/db/schedule";
import { applyDecision, quoteInvoiced, releaseQuoteFromOrder, type Decision } from "@/lib/approval-decide";
import { approvalHref } from "@/lib/approval-href";
import { approvalResultNotices } from "@/lib/notify/events";
import { sendAndRecord } from "@/lib/notify/send";
import { fail, requireActionUser, safeReturn, str, withMsg } from "./guards";

/** 承認の反映 (applyDecision) は src/lib/approval-decide.ts。管理者の申請は申請と同時に承認済みになる (settleOwnApproval) */
export type { Decision } from "@/lib/approval-decide";

export async function decideApproval(approvalId: string, decision: Decision, formData: FormData) {
  const user = await requireActionUser();
  const returnTo = safeReturn(str(formData, "returnTo"), "/approvals");
  const comment = str(formData, "comment");
  if (!["approved", "returned", "rejected"].includes(decision)) fail(returnTo, "判断の種類が正しくありません。");
  if (decision !== "approved" && !comment) fail(returnTo, `${decision === "returned" ? "差戻し" : "却下"}の理由をコメントに入力してください (申請者に伝わります)。`);
  let label = "";
  let decided: Approval | undefined;
  await mutate((db) => {
    const a = db.approvals.find((x) => x.id === approvalId);
    if (!a) fail(returnTo, "承認依頼が見つかりません。");
    if (a.status !== "pending") fail(returnTo, "この依頼はすでに処理済みです。");
    if (a.requestedBy === user.id) fail(returnTo, "自分が申請した依頼は承認・差戻し・却下できません。他の承認者に依頼してください。");
    if (!canApprove(user, a)) fail(returnTo, `この依頼は${a.requiredRole === "admin" ? "管理者" : "店長"}のみ判断できます。`);
    // 入金の記録がある・まとめ請求の請求書の案件は金額の変更を反映しない (受注 1 件の入金前の請求書は反映のときに直す。src/lib/invoice-sync.ts)
    const invoiceBlock = decision === "approved" && a.type === "quote_amend" ? quoteInvoiced(db, a.targetId) : undefined;
    if (invoiceBlock) fail(returnTo, `${invoiceBlock} (または差し戻してください)`);
    a.status = decision;
    a.decidedBy = user.id;
    a.decidedAt = nowIso();
    a.decisionComment = comment || undefined;
    label = `${APPROVAL_TYPE_LABEL[a.type]}: ${a.title}`;
    applyDecision(db, a, decision, user.id, comment, returnTo);
    addAudit(db, { userId: user.id, action: decision === "approved" ? "approve" : "reject", entity: "approval", entityId: a.id, entityLabel: a.title, summary: `${APPROVAL_TYPE_LABEL[a.type]}を${APPROVAL_STATUS[decision].label}${comment ? ` (${comment})` : ""}`, storeId: a.storeId });
    decided = { ...a };
  });
  if (decided) await sendAndRecord(approvalResultNotices(getDb(), decided, approvalHref(decided)), user.id);
  revalidatePath("/", "layout");
  const done = decision === "approved" ? "承認しました。関連する画面に反映されています。" : decision === "returned" ? "差し戻しました。申請者が修正して再申請できます。" : "却下しました。";
  redirect(withMsg(returnTo, `${label} を${done}`));
}

export async function cancelApproval(approvalId: string, formData: FormData) {
  const user = await requireActionUser();
  const returnTo = safeReturn(str(formData, "returnTo"), "/approvals");
  await mutate((db) => {
    const a = db.approvals.find((x) => x.id === approvalId);
    if (!a) fail(returnTo, "承認依頼が見つかりません。");
    if (a.status !== "pending") fail(returnTo, "この依頼はすでに処理済みです。");
    if (!canCancelApproval(user, a)) fail(returnTo, "申請者本人または管理者のみ取下げできます。");
    a.status = "cancelled";
    a.decidedBy = user.id;
    a.decidedAt = nowIso();
    if (a.type === "quote") {
      const q = db.quotes.find((x) => x.id === a.targetId);
      if (q && q.status === "pending_approval") q.status = "draft";
    } else if (a.type === "quote_amend") {
      const q = db.quotes.find((x) => x.id === a.targetId);
      if (q) q.pendingChange = undefined;
    } else if (a.type === "expense") {
      const e = db.expenses.find((x) => x.id === a.targetId);
      if (e && e.status === "pending_approval") e.status = "draft";
    } else if (a.type === "order") {
      const o = db.orders.find((x) => x.id === a.targetId);
      if (o && (o.status === "pending_approval" || o.status === "returned")) {
        o.status = "cancelled";
        removeUpcomingOrderEvents(db, o.id);
        releaseQuoteFromOrder(db, o.id);
      }
    } else if (a.type === "purchase") {
      const p = db.purchases.find((x) => x.id === a.targetId);
      if (p && p.status === "pending_approval") p.status = "received";
    }
    // order_change / customer_change / handover_change / store_change / inquiry_delete は申請を取り下げるだけ (対象は変えていない)
    addAudit(db, { userId: user.id, action: "status", entity: "approval", entityId: a.id, entityLabel: a.title, summary: `${APPROVAL_TYPE_LABEL[a.type]}の申請を取下げ`, storeId: a.storeId });
  });
  revalidatePath("/", "layout");
  redirect(withMsg(returnTo, "申請を取り下げました。"));
}
