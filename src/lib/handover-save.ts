import "server-only";
import type { Approval, Database, Order, OrderHandover, User } from "@/lib/db/types";
import { addAudit, newId, nowIso } from "@/lib/db/store";
import { approverRole } from "@/lib/auth/permissions";
import { settleOwnApproval } from "@/lib/approval-decide";
import { followMovedEvents, syncHandoverEvents } from "@/lib/db/handover-events";
import { cleanHandovers, handoverDiff, handoverGroups, handoverText, hasHandoverItems, sameHandovers, suggestHandovers, type HandoverLine } from "@/lib/handover";
import { findConflicts, shortDate, timeLabel } from "@/lib/calendar";
import { fail } from "@/lib/actions/guards";
import { approvalSettings } from "@/lib/approval-rules";
import { addChangeNotice, caseTarget } from "@/lib/change-notices";
import type { ChangeNoticeLine } from "@/lib/db/types";

/** handoverDiff の文 (「畳 (表替え) の引取: 11/26 → 11/28」) → お知らせの行 */
export function diffLine(text: string, registered: boolean): ChangeNoticeLine {
  const i = text.indexOf(": ");
  const label = i > 0 ? text.slice(0, i) : "日程";
  const rest = i > 0 ? text.slice(i + 2) : text;
  if (registered) return { label, before: "(なし)", after: rest };
  const j = rest.indexOf(" → ");
  return j >= 0 ? { label, before: rest.slice(0, j), after: rest.slice(j + 3) } : { label, after: rest };
}

/**
 * 受注の引取・納品の日程の保存 (受注の画面の「引取・納品の日程」と、予定表で連動する予定の日時を変えたとき)
 * ------------------------------------------------------------
 * はじめて入れる日程はすぐに反映する。登録済みの日程の変更も既定は承認なしで反映し、担当店舗・本部・管理者に知らせる
 * (お客様のご要望 2026-11-25「⑥」。src/lib/change-notices.ts)。設定 → 承認ルールで「予定の変更に承認を必要とする」にしたときだけ承認の申請 (type = handover_change)。
 * 承認者は店舗の店長 (店長本人・本部の案件は管理者。approverRole)。管理者の申請は承認を省略してそのまま反映する。
 * mutate の中で呼ぶ (db は mutate の中のもの)。
 */

export const pendingHandoverChange = (db: Pick<Database, "approvals">, orderId: string): Approval | undefined =>
  db.approvals.find((a) => a.type === "handover_change" && a.targetId === orderId && a.status === "pending");

export interface PlanSaveResult {
  /** すぐに反映した (登録・品目の名前・担当など) */
  applied: boolean;
  /** 変更の申請 (承認待ち。管理者の申請は auto = true で反映済み) */
  approval?: Approval;
  auto: boolean;
  registered: string[];
  changed: string[];
  followUps: string[];
}

export function savePlan(
  db: Database,
  user: User,
  o: Order,
  requestedRaw: OrderHandover[],
  opts: { back: string; reason?: string; workerIds?: string[]; via: "order" | "schedule"; silent?: boolean; noticeTopic?: string },
): PlanSaveResult {
  const pending = pendingHandoverChange(db, o.id);
  const before = cleanHandovers(o.handovers ?? []).rows;
  const requested = cleanHandovers(requestedRaw).rows;
  const diff = handoverDiff(before, requested);
  if (pending && (diff.needsApproval || diff.registered.length)) {
    fail(opts.back, `承認待ちの引取・納品日の変更があります (${pending.createdAt.slice(5, 10).replace("-", "/")} 申請)。承認・差戻しのあとに保存してください。急ぐときは申請を取り下げてから、まとめて保存し直してください。`);
  }
  // 予定の変更・削除は承認なし (お客様のご要望 2026-11-25「⑥」。設定 → 承認ルールで承認を必要にもできる): 登録済みの日程の変更もそのまま反映する
  const direct = diff.needsApproval && !approvalSettings(db).scheduleChange;
  const immediate = direct ? requested : diff.immediate;
  const now = nowIso();
  const prevWorkers = [...o.workerIds];
  const workersChanged = Boolean(opts.workerIds?.length) && opts.workerIds!.join() !== prevWorkers.join();
  const planChanged = !sameHandovers(before, immediate) || (o.handovers === undefined && immediate.length > 0);
  const result: PlanSaveResult = { applied: false, auto: false, registered: diff.registered, changed: diff.changed, followUps: [] };

  if (planChanged || workersChanged) {
    o.handovers = immediate.length || o.handovers ? immediate : undefined;
    if (workersChanged) o.workerIds = [...opts.workerIds!];
    const { moved } = syncHandoverEvents(db, o, user.id, { prevWorkers });
    result.followUps = followMovedEvents(db, user, moved);
    o.updatedAt = now;
    result.applied = true;
    const lines = [
      ...diff.registered,
      ...(direct ? diff.changed : []),
      ...(workersChanged ? [`担当: ${o.workerIds.map((w) => db.users.find((u) => u.id === w)?.name ?? "-").join("・")}`] : []),
    ];
    const verb = direct && diff.changed.length ? "変更" : "登録";
    if (lines.length || planChanged) {
      o.progressNotes.push({ id: newId("pn"), at: now, userId: user.id, kind: direct && diff.changed.length ? "change" : "production", body: `引取・納品の日程を${opts.via === "schedule" ? "予定表から" : ""}${verb}: ${lines.join(" / ") || handoverText(o.handovers)}${direct && opts.reason ? ` (${opts.reason})` : ""}` });
    }
    // 担当店舗・本部・管理者へのお知らせ (どの品目の何日を何日に)
    if (!opts.silent) {
      const noticeRows = [...diff.registered.map((t) => diffLine(t, true)), ...(direct ? diff.changed.map((t) => diffLine(t, false)) : [])];
      if (workersChanged) noticeRows.push({ label: "施工担当", before: prevWorkers.map((w) => db.users.find((u) => u.id === w)?.name ?? "-").join("・") || "(なし)", after: o.workerIds.map((w) => db.users.find((u) => u.id === w)?.name ?? "-").join("・") });
      addChangeNotice(db, user.id, caseTarget(db, o.id), opts.noticeTopic ?? (direct && diff.changed.length ? "引取・納品の日程の変更" : "引取・納品の日程の登録"), noticeRows);
    }
    addAudit(db, {
      userId: user.id,
      action: "update",
      entity: "order",
      entityId: o.id,
      entityLabel: o.number,
      summary: `引取・納品の日程を${verb} (${(direct && diff.changed.length ? diff.changed.join(" / ") : handoverText(o.handovers)).slice(0, 120)})`,
      storeId: o.storeId,
      changes: [
        ...(planChanged ? [{ field: "handovers", before, after: o.handovers ?? [] }] : []),
        ...(workersChanged ? [{ field: "workerIds", before: prevWorkers, after: o.workerIds }] : []),
      ],
    });
  }

  if (diff.needsApproval && !direct) {
    const customer = db.customers.find((c) => c.id === o.customerId);
    const role = approverRole(db.users, o.storeId, false, user.id);
    const approval: Approval = {
      id: newId("ap"),
      type: "handover_change",
      targetId: o.id,
      title: `${o.number} ${customer ? `${customer.name} 様 ` : ""}${o.title}`,
      amount: 0,
      storeId: o.storeId,
      requestedBy: user.id,
      requiredRole: role,
      status: "pending",
      requestComment: opts.reason?.trim() || undefined,
      changes: [{ field: "handovers", before: cleanHandovers(o.handovers ?? []).rows, after: requested }],
      createdAt: now,
    };
    db.approvals.push(approval);
    o.progressNotes.push({ id: newId("pn"), at: now, userId: user.id, kind: "change", body: `引取・納品日の変更を申請${opts.via === "schedule" ? " (予定表から)" : ""}: ${diff.changed.join(" / ")}${approval.requestComment ? ` (理由: ${approval.requestComment})` : ""}` });
    o.updatedAt = now;
    addAudit(db, { userId: user.id, action: "submit", entity: "order", entityId: o.id, entityLabel: o.number, summary: `引取・納品日の変更を申請 (${diff.changed.join(" / ").slice(0, 150)})`, storeId: o.storeId, changes: approval.changes });
    result.approval = approval;
    result.auto = settleOwnApproval(db, approval, user, opts.back);
  }
  return result;
}

/**
 * 保存の前に、新しく入れる・変える日時の担当者の予定の重複を確かめる (同じ案件の予定は数えない)。
 * 今の予定と同じ日時のものは確かめない (重複を承知で保存した予定を、保存のたびに止めないように)
 */
export function planConflicts(db: Database, o: Order, requestedRaw: OrderHandover[], workerIds: string[]): string[] {
  const quote = db.quotes.find((q) => q.id === o.quoteId);
  const key = (g: { role: string; date: string; endDate?: string; start?: string; end?: string; slot?: string }) => `${g.role}|${g.date}|${g.endDate ?? ""}|${g.start ?? ""}|${g.end ?? ""}|${g.slot ?? ""}`;
  const current = new Set(handoverGroups(o.handovers).map(key));
  const out: string[] = [];
  for (const g of handoverGroups(cleanHandovers(requestedRaw).rows)) {
    if (current.has(key(g))) continue;
    const hits = findConflicts(
      { date: g.date, endDate: g.endDate, startTime: g.start, endTime: g.start ? g.end : undefined, slot: g.start ? undefined : g.slot, assigneeIds: workerIds.length ? workerIds : o.workerIds, orderId: o.id, quoteId: o.quoteId, inquiryId: quote?.inquiryId },
      db.schedule,
    );
    for (const h of hits) out.push(`${db.users.find((u) => u.id === h.userId)?.name ?? "-"} さん ${shortDate(h.day)} ${timeLabel(h.event)}「${h.event.title}」`);
  }
  return [...new Set(out)];
}

/** 見積の明細 → 品目を見分ける明細 (商品マスタの分類つき) */
export function quoteHandoverLines(db: Pick<Database, "products">, items: { name: string; spec?: string; qty: number; unit: string; productId?: string }[] | undefined): HandoverLine[] {
  return (items ?? []).map((i) => ({ name: i.name, spec: i.spec, qty: i.qty, unit: i.unit, productCategory: i.productId ? db.products.find((p) => p.id === i.productId)?.category : undefined }));
}

/** 受注の明細 (見積から) */
export function orderHandoverLines(db: Pick<Database, "products" | "quotes">, o: Order): HandoverLine[] {
  return quoteHandoverLines(db, db.quotes.find((q) => q.id === o.quoteId)?.items);
}

/** 受注を品目ごとの引取・納品の日程で扱うか (日程があるか、畳・襖・障子・網戸の明細・種別がある) */
export function usesHandoverPlan(db: Pick<Database, "products" | "quotes">, o: Order): boolean {
  return Boolean(o.handovers?.length) || hasHandoverItems(orderHandoverLines(db, o), o.category);
}

/** 受注の画面の初期値 (日程がまだないとき): 明細・手書きの日時・以前の施工期間から */
export function suggestOrderHandovers(db: Pick<Database, "products" | "quotes">, o: Order): OrderHandover[] {
  return suggestHandovers({ lines: orderHandoverLines(db, o), category: o.category, pickupText: o.siteInfo?.pickupAt, deliveryText: o.siteInfo?.deliveryAt, fallbackPickup: o.scheduledStart, endDate: o.scheduledEnd, ref: o.contractDate });
}
