import type { Database, ScheduleEvent, ScheduleKind, StoreId } from "@/lib/db/types";

/**
 * 見積の訪問が、その場で現見 (現場見積 → そのまま工事) になったとき (お客様のご要望 2026-11-25「予定表からの見積取込・受注登録」)
 * ------------------------------------------------------------
 * 受注の作業 (引き取り・施工) の日が、同じ案件の訪問の予定 (見積・現調・現見) と同じ日なら、新しい予定を足さずに、その訪問の予定を
 * 受注の予定に切り替える (種類は「現見」。担当者・メモ・時間はそのまま)。作業が別の日なら、訪問の予定は残して作業の予定を足す。
 * 同じ案件 = 同じ受注・見積・問い合わせの予定、または案件のつながっていないそのお客様の予定 (予定表から直接入れた訪問)。
 * 切り替えた予定 = source "order" の「現見」。日程を別の日に動かす・受注を取り消すと、訪問の予定に戻す (消さない: restoreVisit)
 * import は型だけ (handover-events.ts・schedule.ts・予定表の小さな画面のデータで共通)
 */

export const VISIT_KINDS: readonly ScheduleKind[] = ["survey", "site_survey", "onsite_quote"];

/** 切り替えたあとの種類 */
export const ADOPTED_KIND: ScheduleKind = "onsite_quote";

export interface CaseKeys {
  orderId?: string;
  quoteId?: string;
  inquiryId?: string;
  customerId?: string;
}

const time = (e: ScheduleEvent) => e.startTime ?? (e.slot === "am" ? "09:00" : e.slot === "pm" ? "13:00" : "99:99");

/** 同じ案件の訪問の予定か (ほかの案件にひも付いた予定・受注の予定は除く) */
export function isCaseVisit(e: ScheduleEvent, k: CaseKeys): boolean {
  if (!VISIT_KINDS.includes(e.kind) || e.source === "order") return false;
  if (e.orderId && e.orderId !== k.orderId) return false;
  if (e.quoteId && e.quoteId !== k.quoteId) return false;
  if (e.inquiryId && e.inquiryId !== k.inquiryId) return false;
  if (e.orderId || e.quoteId || e.inquiryId) return true;
  return Boolean(k.customerId && e.customerId === k.customerId);
}

/** その日の同じ案件の訪問の予定 (1 日だけの予定。現見を先、早い時間を先) */
export function sameDayVisit(db: Pick<Database, "schedule">, k: CaseKeys, date: string, used: Set<string> = new Set()): ScheduleEvent | undefined {
  return db.schedule
    .filter((e) => !used.has(e.id) && e.date === date && (!e.endDate || e.endDate === e.date) && isCaseVisit(e, k))
    .sort((a, b) => Number(b.kind === "onsite_quote") - Number(a.kind === "onsite_quote") || time(a).localeCompare(time(b)))[0];
}

/** 案件のすべての訪問の予定 (予定表の小さな画面の「受注にする」で、どの日なら切り替わるかを見せる) */
export function caseVisits(db: Pick<Database, "schedule">, k: CaseKeys): ScheduleEvent[] {
  return db.schedule.filter((e) => isCaseVisit(e, k)).sort((a, b) => a.date.localeCompare(b.date) || time(a).localeCompare(time(b)));
}

/** 訪問から切り替えた受注の予定か (受注の予定で種類が現見) */
export const isAdoptedVisit = (e: Pick<ScheduleEvent, "source" | "kind">): boolean => e.source === "order" && e.kind === ADOPTED_KIND;

const KIND_JA: Partial<Record<ScheduleKind, string>> = { survey: "見積り (現地調査)", site_survey: "現地調査", onsite_quote: "現場見積 (現見)" };

/** 切り替えの変更履歴の内容 (addAudit に渡す) */
export function adoptionAudit(e: ScheduleEvent, beforeKind: ScheduleKind, order: { number: string; storeId: StoreId }, userId: string) {
  return {
    userId,
    action: "update" as const,
    entity: "schedule",
    entityId: e.id,
    entityLabel: e.title,
    summary: `訪問の予定 (${e.date}) を受注 ${order.number} の「現見」の予定に切り替え (同じ日の作業のため、新しい予定は足していません)`,
    storeId: order.storeId,
    changes: [{ field: "kind", before: KIND_JA[beforeKind] ?? beforeKind, after: "現場見積 (現見)" }],
  };
}

/** 受注の予定から外すとき、切り替えた訪問の予定は消さずに訪問の予定に戻す (受注とのつながりを外す) */
export function restoreVisit(e: ScheduleEvent, actorId: string, now: string): void {
  e.source = "manual";
  e.sourceRef = undefined;
  e.orderId = undefined;
  e.updatedBy = actorId;
  e.updatedAt = now;
}
