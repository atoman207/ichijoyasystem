import "server-only";
import { addAudit, nowIso } from "@/lib/db/store";
import type { Approval, AuditChange, Database, User } from "@/lib/db/types";
import { skipsApproval } from "@/lib/auth/permissions";
import { APPROVAL_TYPE_LABEL } from "@/lib/constants";
import { removeUpcomingOrderEvents, syncOrderEvent } from "@/lib/db/schedule";
import { followMovedEvents, syncHandoverEvents } from "@/lib/db/handover-events";
import { cleanHandovers, handoverChangeLines, sameHandovers } from "@/lib/handover";
import { fieldLabel, fieldValue } from "@/lib/field-labels";
import { fail } from "@/lib/actions/guards";
import { propagateCustomerAddress } from "@/lib/maps/store";
import { closedReason } from "@/lib/mgmt/close";
import { applyCaseStoreChange, caseChainOf, storeChangeBlocker } from "@/lib/case-store";

/**
 * 承認の反映 (承認・差戻し・却下で申請の対象を変える処理)
 * - 承認者の判断 (src/lib/actions/approvals.ts の decideApproval) と、管理者の申請の承認の省略 (settleOwnApproval) で共通
 * - Server Action のファイルには同期の関数を置けないため、ここに分けている
 */

export type Decision = "approved" | "returned" | "rejected";

/**
 * 承認の判断を反映する (承認 / 差戻し / 却下)
 * - 承認: 申請の内容を反映する
 * - 差戻し: 申請者へ戻す。修正して再申請できる状態にする (見積・経費は下書き・差戻し、受注は「契約差戻し」、仕入は「照会中」)
 * - 却下: 申請を認めない。経費は「却下」(再申請不可)、仕入は「支払却下」、受注 (契約) はキャンセル、見積は下書きに戻す
 */
export function applyDecision(db: Database, a: Approval, decision: Decision, userId: string, comment: string, back: string) {
  const now = nowIso();
  const word = decision === "approved" ? "承認" : decision === "returned" ? "差戻し" : "却下";
  const note = comment ? ` (${comment})` : "";
  const action = decision === "approved" ? "approve" : "reject";
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
          db.commLogs.push({ id: `cl_${Date.now()}`, customerId: q.customerId, storeId: q.storeId, channel: "visit", direction: "outbound", subject: `お見積書 ${q.number}`, body: `現場で手書きの見積書 (合計 ¥${q.total.toLocaleString("ja-JP")}) をお渡し済み。システムの見積として承認しました。`, at: now, userId, relatedType: "quote", relatedId: q.id });
        }
      } else {
        q.status = "draft";
      }
      q.updatedAt = now;
      addAudit(db, { userId, action, entity: "quote", entityId: q.id, entityLabel: q.number, summary: decision === "approved" ? "見積を承認" : `見積を${word}${note}`, storeId: q.storeId });
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
            taxExempt: q.taxExempt,
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
        // 非課税: 申請に書かれていれば反映 (以前の申請は taxExempt がない = 変えない。内税・外税の申請なら外す)
        if (pc.taxExempt !== undefined) q.taxExempt = pc.taxExempt || undefined;
        else if (pc.taxIncluded) q.taxExempt = undefined;
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
        const changes: AuditChange[] = [{ field: "total", before, after: q.total }];
        if (q.title !== beforeTitle) changes.push({ field: "title", before: beforeTitle, after: q.title });
        addAudit(db, { userId, action: "approve", entity: "quote", entityId: q.id, entityLabel: q.number, summary: `見積の変更を承認 (第${q.version}版。理由: ${pc.reason})`, storeId: q.storeId, changes });
      } else {
        addAudit(db, { userId, action: "reject", entity: "quote", entityId: q.id, entityLabel: q.number, summary: `見積の変更を${word}${note}`, storeId: q.storeId });
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
      } else if (decision === "returned") {
        // 差戻し: 受注は残し、内容を見直して再申請できるようにする (施工予定の仮押さえも残す)
        o.status = "returned";
        o.progressNotes.push({ id: `pn_${Date.now()}`, at: now, userId, kind: "note", body: `契約承認が差し戻されました${note}。内容を見直して再申請してください。` });
      } else {
        o.status = "cancelled";
        o.progressNotes.push({ id: `pn_${Date.now()}`, at: now, userId, kind: "note", body: `契約承認が却下されました${note}` });
        removeUpcomingOrderEvents(db, o.id);
        releaseQuoteFromOrder(db, o.id);
      }
      o.updatedAt = now;
      addAudit(db, { userId, action, entity: "order", entityId: o.id, entityLabel: o.number, summary: decision === "approved" ? "受注 (契約) を承認" : `受注 (契約) を${word}${note}`, storeId: o.storeId });
      break;
    }
    case "expense": {
      const e = db.expenses.find((x) => x.id === a.targetId);
      if (!e) return;
      e.status = decision === "approved" ? "approved" : decision === "returned" ? "rejected" : "denied";
      if (decision === "approved") {
        e.approvedBy = userId;
        e.approvedAt = now;
      }
      e.updatedAt = now;
      addAudit(db, { userId, action, entity: "expense", entityId: e.id, entityLabel: e.number, summary: decision === "approved" ? "経費を承認" : `経費を${word}${note}`, storeId: e.storeId });
      break;
    }
    case "purchase": {
      const p = db.purchases.find((x) => x.id === a.targetId);
      if (!p) return;
      p.status = decision === "approved" ? "approved" : decision === "returned" ? "disputed" : "rejected";
      if (decision === "approved") p.approvedBy = userId;
      p.updatedAt = now;
      addAudit(db, { userId, action, entity: "purchase", entityId: p.id, entityLabel: p.number, summary: decision === "approved" ? "仕入請求書の支払を承認" : decision === "returned" ? `支払依頼を差戻し (照会中)${note}` : `支払依頼を却下${note}`, storeId: p.storeId });
      break;
    }
    case "order_change": {
      const o = db.orders.find((x) => x.id === a.targetId);
      if (!o) return;
      if (decision === "approved") {
        assertUnchanged("order", o as unknown as Record<string, unknown>, a.changes ?? [], back);
        if (a.changes?.some((c) => c.field === "total")) {
          if (o.quoteId) fail(back, "見積から作った受注の金額は、見積の金額変更で直します。この申請は却下してください。");
          if (db.invoices.some((i) => i.id === o.invoiceId && i.status !== "void")) fail(back, "請求書を発行済みの案件のため、契約金額を変更できません。入金前であれば請求書を無効化してから承認してください。");
        }
        // 売上計上日の変更: 申請のあとに管理会計で月次確定した月にはかけない (src/lib/mgmt/close.ts)
        const sales = a.changes?.find((c) => c.field === "salesDate");
        if (sales) {
          for (const d of [sales.before, sales.after]) {
            const closed = typeof d === "string" ? closedReason(db, d, "売上計上日の変更") : null;
            if (closed) fail(back, closed);
          }
        }
        applyChanges(o as unknown as Record<string, unknown>, a.changes ?? []);
        o.updatedAt = now;
        o.progressNotes.push({ id: `pn_${Date.now()}`, at: now, userId, kind: "change", body: `契約内容の変更が承認されました: ${describe("order", a.changes ?? [])}` });
        addAudit(db, { userId, action: "approve", entity: "order", entityId: o.id, entityLabel: o.number, summary: `契約内容の変更を承認 (${(a.changes ?? []).map((c) => fieldLabel("order", c.field)).join("・")})`, storeId: o.storeId, changes: a.changes });
      } else {
        addAudit(db, { userId, action: "reject", entity: "order", entityId: o.id, entityLabel: o.number, summary: `契約内容の変更を${word}${note}`, storeId: o.storeId });
      }
      break;
    }
    case "handover_change": {
      // 受注の引取日・納品日 (品目ごと) の変更 (src/lib/handover.ts)。承認で日程を置き換え、予定表の予定も動かす
      const o = db.orders.find((x) => x.id === a.targetId);
      if (!o) return;
      const change = a.changes?.find((c) => c.field === "handovers");
      const lines = change ? handoverChangeLines(change.before, change.after) : [];
      if (decision === "approved" && change) {
        if (o.status === "cancelled") fail(back, "キャンセルした受注のため、日程の変更を反映できません。この申請は却下してください。");
        if (!sameHandovers(o.handovers ?? [], change.before)) fail(back, "申請のあとに引取・納品の日程が変更されています。古い内容で上書きしないよう、この申請は差し戻して出し直してください。");
        o.handovers = cleanHandovers(change.after).rows;
        const { moved } = syncHandoverEvents(db, o, userId);
        const follow = followMovedEvents(db, db.users.find((u) => u.id === userId), moved);
        o.updatedAt = now;
        o.progressNotes.push({ id: `pn_${Date.now()}`, at: now, userId, kind: "change", body: `引取・納品日の変更が承認されました: ${lines.join(" / ")}${follow.length ? ` (${follow.join(" ")})` : ""}` });
        addAudit(db, { userId, action: "approve", entity: "order", entityId: o.id, entityLabel: o.number, summary: `引取・納品日の変更を承認 (${lines.join(" / ").slice(0, 150)})`, storeId: o.storeId, changes: a.changes });
      } else {
        o.progressNotes.push({ id: `pn_${Date.now()}`, at: now, userId, kind: "change", body: `引取・納品日の変更が${word}されました${note}: ${lines.join(" / ")} (予定表は前の日程のままです)` });
        o.updatedAt = now;
        addAudit(db, { userId, action: "reject", entity: "order", entityId: o.id, entityLabel: o.number, summary: `引取・納品日の変更を${word}${note}`, storeId: o.storeId });
      }
      break;
    }
    case "customer_change": {
      const c = db.customers.find((x) => x.id === a.targetId);
      if (!c) return;
      if (decision === "approved") {
        assertUnchanged("customer", c as unknown as Record<string, unknown>, a.changes ?? [], back);
        const beforeAddress = c.address;
        applyChanges(c as unknown as Record<string, unknown>, a.changes ?? []);
        c.updatedAt = now;
        // 住所の変更の承認: 施工場所がお客様の住所と同じ進行中の受注と、お客様の場所に合わせている今後の予定にも反映する
        if (beforeAddress !== c.address) propagateCustomerAddress(db, { id: userId }, c, beforeAddress);
        addAudit(db, { userId, action: "approve", entity: "customer", entityId: c.id, entityLabel: c.name, summary: `顧客の重要情報の変更を承認 (${(a.changes ?? []).map((x) => fieldLabel("customer", x.field)).join("・")})`, storeId: c.storeId, changes: a.changes });
      } else {
        addAudit(db, { userId, action: "reject", entity: "customer", entityId: c.id, entityLabel: c.name, summary: `顧客の重要情報の変更を${word}${note}`, storeId: c.storeId });
      }
      break;
    }
    case "store_change": {
      // 案件の施工店舗 (= 売上の店舗) の変更 (src/lib/case-store.ts)。承認で案件の記録と案件の予定の店舗をそろえて変える
      const chain = caseChainOf(db, a.targetId);
      const change = a.changes?.find((c) => c.field === "storeId");
      if (!chain || !change) return;
      const storeName = (id: unknown) => db.stores.find((s) => s.id === id)?.name ?? String(id ?? "");
      const what = `${storeName(change.before)} → ${storeName(change.after)}`;
      if (decision === "approved") {
        if (chain.head.storeId !== change.before) fail(back, "申請のあとに案件の店舗が変わっています。古い内容で上書きしないよう、この申請は差し戻して出し直してください。");
        const blocker = storeChangeBlocker(db, chain, String(change.after));
        if (blocker) fail(back, `${blocker} この申請は却下してください。`);
        const r = applyCaseStoreChange(db, userId, chain, String(change.after), a.requestComment);
        addAudit(db, { userId, action: "approve", entity: chain.head.type, entityId: chain.head.id, entityLabel: chain.head.number, summary: `施工店舗の変更を承認 (${what} / 記録 ${r.records} 件・予定 ${r.events} 件)`, storeId: String(change.after), changes: a.changes });
      } else {
        if (chain.order) chain.order.progressNotes.push({ id: `pn_${Date.now()}`, at: now, userId, kind: "change", body: `施工店舗の変更 (${what}) が${word}されました${note}` });
        addAudit(db, { userId, action: "reject", entity: chain.head.type, entityId: chain.head.id, entityLabel: chain.head.number, summary: `施工店舗の変更 (${what}) を${word}${note}`, storeId: chain.head.storeId });
      }
      break;
    }
    case "record_view": {
      // 閲覧の申請: 承認すると、申請者が決まった日数だけお客様の情報を閲覧のみで見られる (判定は src/lib/case-access.ts の viewGrantUntil)。記録は変えない
      const c = db.customers.find((x) => x.id === a.targetId);
      if (!c) return;
      const requester = db.users.find((u) => u.id === a.requestedBy)?.name ?? "-";
      addAudit(db, { userId, action, entity: "customer", entityId: c.id, entityLabel: c.name, summary: decision === "approved" ? `${requester} さんの顧客情報の閲覧の申請を承認` : `${requester} さんの顧客情報の閲覧の申請を${word}${note}`, storeId: c.storeId });
      break;
    }
  }
}

/** 申請の後に同じ項目がほかで変わっていたら反映しない (古い内容で上書きしないように) */
function assertUnchanged(entity: string, target: Record<string, unknown>, changes: AuditChange[], back: string) {
  const norm = (v: unknown) => (v === undefined || v === null || v === "" ? "" : JSON.stringify(v));
  const moved = changes.filter((c) => norm(target[c.field]) !== norm(c.before));
  if (moved.length) fail(back, `申請の後に「${moved.map((c) => fieldLabel(entity, c.field)).join("・")}」が変更されています。古い内容で上書きしないよう、この申請は差し戻して出し直してください。`);
}

function applyChanges(target: Record<string, unknown>, changes: AuditChange[]) {
  for (const c of changes) target[c.field] = c.after === "" || c.after === null ? undefined : c.after;
}

function describe(entity: string, changes: AuditChange[]): string {
  return changes.map((c) => `${fieldLabel(entity, c.field)} ${fieldValue(c.field, c.before)} → ${fieldValue(c.field, c.after)}`).join("、");
}

/** 受注を解消したとき (契約承認の却下・取下げ)、見積を受注登録の前の状態に戻す (再度「受注登録」「失注」ができるように) */
export function releaseQuoteFromOrder(db: Database, orderId: string) {
  const o = db.orders.find((x) => x.id === orderId);
  const q = o ? db.quotes.find((x) => x.id === o.quoteId && x.orderId === o.id) : undefined;
  if (q) {
    q.orderId = undefined;
    q.updatedAt = nowIso();
  }
}

/** 見積から作った受注に有効な請求書があるか (あれば金額変更を反映しない。受注と請求書の金額が食い違うため) */
export function quoteInvoiced(db: Database, quoteId: string): boolean {
  return db.orders.some((o) => o.quoteId === quoteId && o.status !== "cancelled" && db.invoices.some((i) => i.id === o.invoiceId && i.status !== "void"));
}

/** 承認を省略したときの画面の言葉 (「…し、反映しました」) */
export const AUTO_APPROVAL_NOTE = "承認不要の申請のため承認を省略";

/** 確定した売上 (施工完了・請求済・入金済の受注) に関わる申請か。店長の申請でも承認を省略しない (お客様の決定 2026-11-24「追加 ①」) */
export function touchesConfirmedSales(db: Database, a: Pick<Approval, "type" | "targetId" | "changes">): boolean {
  const done = (status?: string) => status === "completed" || status === "invoiced" || status === "paid";
  if (a.type === "order_change" || a.type === "handover_change") {
    const o = db.orders.find((x) => x.id === a.targetId);
    return done(o?.status) || (a.changes ?? []).some((c) => c.field === "completedAt" || c.field === "salesDate");
  }
  if (a.type === "quote_amend") return db.orders.some((o) => o.quoteId === a.targetId && done(o.status));
  // 施工店舗の変更: 施工完了・請求済・入金済の受注は確定した売上の店舗が変わる
  if (a.type === "store_change") return done(caseChainOf(db, a.targetId)?.order?.status);
  return false;
}

/**
 * 管理者 (社長) の申請は承認を省略する (permissions.ts の skipsApproval)。
 * 申請を作った直後 (同じ mutate の中) に呼ぶ。申請の記録は残し、申請者本人が承認したものとして、その場で内容を反映する。
 * 省略したら true (呼び出し側は「承認を申請しました」ではなく「反映しました」と伝える)。管理者でなければ何もしない (false)
 */
export function settleOwnApproval(db: Database, a: Approval, user: Pick<User, "id" | "role">, back: string): boolean {
  if (!skipsApproval(user, a.type) || a.requestedBy !== user.id || a.status !== "pending") return false;
  // 店長の申請でも、確定した売上・入金に関わる変更は管理者の承認を待つ
  if (user.role !== "admin" && touchesConfirmedSales(db, a)) return false;
  const note = `${user.role === "admin" ? "管理者" : "店長"}の申請のため承認を省略`;
  if (a.type === "quote_amend" && quoteInvoiced(db, a.targetId)) fail(back, "請求書を発行済みの案件のため、金額変更を反映できません。入金前であれば請求書を無効化してから変更してください。");
  a.status = "approved";
  a.decidedBy = user.id;
  a.decidedAt = nowIso();
  a.decisionComment = note;
  applyDecision(db, a, "approved", user.id, "", back);
  addAudit(db, { userId: user.id, action: "approve", entity: "approval", entityId: a.id, entityLabel: a.title, summary: `${APPROVAL_TYPE_LABEL[a.type]}を承認 (${note})`, storeId: a.storeId });
  return true;
}
