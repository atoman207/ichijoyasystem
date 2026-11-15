"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, mutate, nowIso } from "@/lib/db/store";
import { canApprove, canCancelApproval } from "@/lib/auth/permissions";
import { APPROVAL_TYPE_LABEL } from "@/lib/constants";
import type { Database, Approval } from "@/lib/db/types";
import { removeUpcomingOrderEvents, syncOrderEvent } from "@/lib/db/schedule";
import { fail, requireActionUser, safeReturn, str, withMsg } from "./guards";

function applyDecision(db: Database, a: Approval, decision: "approved" | "rejected", userId: string, comment: string) {
  const now = nowIso();
  switch (a.type) {
    case "quote": {
      const q = db.quotes.find((x) => x.id === a.targetId);
      if (!q) return;
      if (decision === "approved") {
        q.status = "approved";
        q.approvedBy = userId;
        q.approvedAt = now;
        // 現場で手書きの見積書をお渡し済み → 承認と同時に「送付済 (手渡し)」にする
        if (q.handedOver) {
          q.status = "sent";
          q.sentVia = "visit";
          q.issuedAt = q.issuedAt ?? now.slice(0, 10);
          db.commLogs.push({ id: `cl_${Date.now()}`, customerId: q.customerId, channel: "visit", direction: "outbound", subject: `お見積書 ${q.number}`, body: `現場で手書きの見積書 (合計 ¥${q.total.toLocaleString("ja-JP")}) をお渡し済み。システムの見積として承認しました。`, at: now, userId, relatedType: "quote", relatedId: q.id });
        }
      } else {
        q.status = "draft";
      }
      q.updatedAt = now;
      addAudit(db, { userId, action: decision === "approved" ? "approve" : "reject", entity: "quote", entityId: q.id, entityLabel: q.number, summary: decision === "approved" ? "見積を承認" : `見積を差戻し${comment ? ` (${comment})` : ""}`, storeId: q.storeId });
      break;
    }
    case "quote_amend": {
      const q = db.quotes.find((x) => x.id === a.targetId);
      if (!q || !q.pendingChange) return;
      const before = q.total;
      if (decision === "approved") {
        const pc = q.pendingChange;
        // 変更前の版を残す (版の履歴・旧版の PDF 用)
        q.revisions = [
          ...(q.revisions ?? []),
          {
            version: q.version,
            title: q.title,
            items: q.items,
            taxIncluded: q.taxIncluded,
            subtotal: q.subtotal,
            discount: q.discount,
            tax: q.tax,
            total: q.total,
            workDetails: q.workDetails,
            notes: q.notes,
            validUntil: q.validUntil,
            approvedBy: q.approvedBy,
            approvedAt: q.approvedAt,
            changeReason: pc.reason,
            changeRequestedBy: pc.requestedBy,
            changeApprovedBy: userId,
            replacedAt: now,
          },
        ];
        const beforeTitle = q.title;
        const beforeWork = q.workDetails ?? "";
        q.items = pc.items;
        q.discount = pc.discount;
        q.subtotal = pc.subtotal;
        q.tax = pc.tax;
        q.total = pc.total;
        if (pc.title !== undefined && pc.title) q.title = pc.title;
        if (pc.taxIncluded !== undefined) q.taxIncluded = pc.taxIncluded || undefined;
        if (pc.workDetails !== undefined) q.workDetails = pc.workDetails || undefined;
        if (pc.notes !== undefined) q.notes = pc.notes || undefined;
        q.version += 1;
        q.approvedBy = userId;
        q.approvedAt = now;
        // 受注済みなら受注金額・施工内容も連動 (受注側で施工内容を書き換えていた場合は残す)
        const o = db.orders.find((x) => x.quoteId === q.id && x.status !== "cancelled");
        if (o) {
          const notes: string[] = [];
          if (o.total !== q.total) notes.push(`受注金額を ¥${before.toLocaleString("ja-JP")} → ¥${q.total.toLocaleString("ja-JP")} に更新`);
          o.total = q.total;
          if (q.title !== beforeTitle && o.title === beforeTitle) {
            o.title = q.title;
            notes.push(`件名を「${q.title}」に変更`);
          }
          if ((q.workDetails ?? "") !== beforeWork && (o.workDetails ?? "") === beforeWork) {
            o.workDetails = q.workDetails;
            notes.push("施工内容を見積の第" + q.version + "版に合わせて更新");
          }
          o.updatedAt = now;
          o.progressNotes.push({ id: `pn_${Date.now()}`, at: now, userId, kind: "change", body: `見積 ${q.number} 第${q.version}版の承認により${notes.length ? notes.join("、") : "内容を更新"} (理由: ${pc.reason})` });
        }
        const changes: { field: string; before: unknown; after: unknown }[] = [{ field: "total", before, after: q.total }];
        if (q.title !== beforeTitle) changes.push({ field: "title", before: beforeTitle, after: q.title });
        addAudit(db, { userId, action: "approve", entity: "quote", entityId: q.id, entityLabel: q.number, summary: `見積の変更を承認 (第${q.version}版。理由: ${pc.reason})`, storeId: q.storeId, changes });
      } else {
        addAudit(db, { userId, action: "reject", entity: "quote", entityId: q.id, entityLabel: q.number, summary: `見積の変更を却下${comment ? ` (${comment})` : ""}`, storeId: q.storeId });
      }
      q.pendingChange = undefined;
      q.updatedAt = now;
      break;
    }
    case "order": {
      const o = db.orders.find((x) => x.id === a.targetId);
      if (!o) return;
      if (decision === "approved") {
        o.status = o.scheduledStart ? "scheduled" : "confirmed";
        o.approvedBy = userId;
        const q = db.quotes.find((x) => x.id === o.quoteId);
        if (q) {
          q.status = "accepted";
          q.updatedAt = now;
          const inq = db.inquiries.find((x) => x.id === q.inquiryId);
          if (inq) inq.status = "won";
        }
        o.progressNotes.push({ id: `pn_${Date.now()}`, at: now, userId, kind: "note", body: "契約が承認されました。施工日の調整・材料手配を進めてください。" });
        // 受注登録時に施工予定日があれば、予定表の施工予定を確定状態で保つ
        if (o.scheduledStart) syncOrderEvent(db, o, userId);
      } else {
        o.status = "cancelled";
        o.progressNotes.push({ id: `pn_${Date.now()}`, at: now, userId, kind: "note", body: `契約承認が却下されました${comment ? ` (${comment})` : ""}` });
        removeUpcomingOrderEvents(db, o.id);
        releaseQuoteFromOrder(db, o.id);
      }
      o.updatedAt = now;
      addAudit(db, { userId, action: decision === "approved" ? "approve" : "reject", entity: "order", entityId: o.id, entityLabel: o.number, summary: decision === "approved" ? "受注 (契約) を承認" : "受注 (契約) を却下", storeId: o.storeId });
      break;
    }
    case "expense": {
      const e = db.expenses.find((x) => x.id === a.targetId);
      if (!e) return;
      e.status = decision;
      if (decision === "approved") {
        e.approvedBy = userId;
        e.approvedAt = now;
      }
      e.updatedAt = now;
      addAudit(db, { userId, action: decision === "approved" ? "approve" : "reject", entity: "expense", entityId: e.id, entityLabel: e.number, summary: decision === "approved" ? "経費を承認" : `経費を差戻し${comment ? ` (${comment})` : ""}`, storeId: e.storeId });
      break;
    }
    case "purchase": {
      const p = db.purchases.find((x) => x.id === a.targetId);
      if (!p) return;
      p.status = decision === "approved" ? "approved" : "disputed";
      if (decision === "approved") p.approvedBy = userId;
      p.updatedAt = now;
      addAudit(db, { userId, action: decision === "approved" ? "approve" : "reject", entity: "purchase", entityId: p.id, entityLabel: p.number, summary: decision === "approved" ? "仕入請求書の支払を承認" : "仕入請求書を照会中に変更", storeId: p.storeId });
      break;
    }
  }
}

/** 受注を解消したとき (契約承認の却下・取下げ)、見積を受注登録の前の状態に戻す (再度「受注登録」「失注」ができるように) */
function releaseQuoteFromOrder(db: Database, orderId: string) {
  const o = db.orders.find((x) => x.id === orderId);
  const q = o ? db.quotes.find((x) => x.id === o.quoteId && x.orderId === o.id) : undefined;
  if (q) {
    q.orderId = undefined;
    q.updatedAt = nowIso();
  }
}

/** 見積から作った受注に有効な請求書があるか (あれば金額変更を反映しない。受注と請求書の金額が食い違うため) */
function quoteInvoiced(db: Database, quoteId: string): boolean {
  return db.orders.some((o) => o.quoteId === quoteId && o.status !== "cancelled" && db.invoices.some((i) => i.id === o.invoiceId && i.status !== "void"));
}

export async function decideApproval(approvalId: string, decision: "approved" | "rejected", formData: FormData) {
  const user = await requireActionUser();
  const returnTo = safeReturn(str(formData, "returnTo"), "/approvals");
  const comment = str(formData, "comment");
  let label = "";
  await mutate((db) => {
    const a = db.approvals.find((x) => x.id === approvalId);
    if (!a) fail(returnTo, "承認依頼が見つかりません。");
    if (a.status !== "pending") fail(returnTo, "この依頼はすでに処理済みです。");
    if (a.requestedBy === user.id) fail(returnTo, "自分が申請した依頼は承認・差し戻しできません。他の承認者に依頼してください。");
    if (!canApprove(user, a)) fail(returnTo, `この依頼は${a.requiredRole === "admin" ? "管理者" : "店長"}のみ承認できます。`);
    if (decision === "approved" && a.type === "quote_amend" && quoteInvoiced(db, a.targetId)) {
      fail(returnTo, "請求書を発行済みの案件のため、金額変更を反映できません。入金前であれば請求書を無効化してから承認するか、却下してください。");
    }
    a.status = decision;
    a.decidedBy = user.id;
    a.decidedAt = nowIso();
    a.decisionComment = comment || undefined;
    label = `${APPROVAL_TYPE_LABEL[a.type]}: ${a.title}`;
    applyDecision(db, a, decision, user.id, comment);
    addAudit(db, { userId: user.id, action: decision === "approved" ? "approve" : "reject", entity: "approval", entityId: a.id, entityLabel: a.title, summary: `${APPROVAL_TYPE_LABEL[a.type]}を${decision === "approved" ? "承認" : "却下"}`, storeId: a.storeId });
  });
  revalidatePath("/", "layout");
  redirect(withMsg(returnTo, `${label} を${decision === "approved" ? "承認" : "却下"}しました。関連する画面に反映されています。`));
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
      if (o && o.status === "pending_approval") {
        o.status = "cancelled";
        removeUpcomingOrderEvents(db, o.id);
        releaseQuoteFromOrder(db, o.id);
      }
    } else if (a.type === "purchase") {
      const p = db.purchases.find((x) => x.id === a.targetId);
      if (p && p.status === "pending_approval") p.status = "received";
    }
    addAudit(db, { userId: user.id, action: "status", entity: "approval", entityId: a.id, entityLabel: a.title, summary: `${APPROVAL_TYPE_LABEL[a.type]}の申請を取下げ`, storeId: a.storeId });
  });
  revalidatePath("/", "layout");
  redirect(withMsg(returnTo, "申請を取り下げました。"));
}
