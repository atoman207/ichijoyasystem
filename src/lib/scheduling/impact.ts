import "server-only";
import type { Database, ScheduleEvent, ScheduleKind, StoreId } from "@/lib/db/types";
import { SCHEDULE_KIND } from "@/lib/constants";
import { dayOfWeek, lastDay, shortDate } from "@/lib/calendar";
import { activeHolds } from "./context";
import { loadMasters, profileOf } from "./masters";
import { STAGE } from "./request";
import { findSpec } from "./spec";

/**
 * 予定を変えたときの後続の予定への影響 (入力フォームの警告・保存後の注意)
 * ------------------------------------------------------------
 * - 案件の順番: 引き取りを後ろへずらすと納品が先になる / 前の段階の予定が後になる
 * - 製造の予定: 引き取りの日と製造の始まりが合わない・納品が完成より前
 * - 車両・設備の予約: 予定にひも付く予約の日が合わない (保存すると予約も動かす)
 * - 期限 (作業の内容の納品期限)・お客様の都合の悪い日・希望 (必ず)
 * - 担当者の勤務日 (社員の設定がある人)
 * - 同じ案件の仮押さえ
 */

export interface ImpactInput {
  id?: string;
  kind: ScheduleKind;
  date: string;
  endDate?: string;
  storeId: StoreId;
  assigneeIds: string[];
  orderId?: string;
  quoteId?: string;
  inquiryId?: string;
}

export function changeImpacts(db: Database, ev: ImpactInput, now = new Date()): string[] {
  const out: string[] = [];
  const myStage = STAGE[ev.kind];
  const sameCase = (e: Pick<ScheduleEvent, "orderId" | "quoteId" | "inquiryId">) => (ev.orderId && e.orderId === ev.orderId) || (ev.quoteId && e.quoteId === ev.quoteId) || (ev.inquiryId && e.inquiryId === ev.inquiryId);
  const end = lastDay(ev);
  if (myStage !== undefined && (ev.orderId || ev.quoteId || ev.inquiryId)) {
    for (const e of db.schedule) {
      if (e.id === ev.id || !sameCase(e)) continue;
      const st = STAGE[e.kind];
      if (st === undefined || st === myStage) continue;
      if (st > myStage && e.date < end) out.push(`同じ案件の「${SCHEDULE_KIND[e.kind].label}」(${shortDate(e.date)}) が、この${SCHEDULE_KIND[ev.kind].label}より前になります`);
      if (st > myStage && ev.kind === "pickup" && e.kind === "delivery" && e.date === ev.date) out.push(`納品 (${shortDate(e.date)}) が引き取りと同じ日です (納品は引き取りの翌日以降)`);
      if (st < myStage && lastDay(e) > ev.date) out.push(`同じ案件の「${SCHEDULE_KIND[e.kind].label}」(${shortDate(e.date)}) より前の日です`);
    }
  }
  for (const j of db.productionJobs ?? []) {
    if (j.status === "cancelled" || j.status === "done") continue;
    if (ev.id && j.pickupEventId === ev.id && j.startDate < ev.date) out.push(`製造の予定 (${shortDate(j.startDate)}〜) が引き取りより前です。保存すると製造の予定を作り直します`);
    if (ev.kind === "delivery" && ((ev.id && j.deliveryEventId === ev.id) || (ev.orderId && j.orderId === ev.orderId)) && ev.date <= j.endDate) out.push(`製造の完成 (${shortDate(j.endDate)}) より前・同じ日の納品です`);
  }
  if (ev.id) {
    const bookings = (db.resourceBookings ?? []).filter((b) => b.eventId === ev.id && b.date !== ev.date);
    const m = loadMasters(db);
    for (const b of bookings) out.push(`車両・設備「${m.resources.find((r) => r.id === b.resourceId)?.name ?? b.resourceId}」の予約 (${shortDate(b.date)}) も ${shortDate(ev.date)} に移します`);
  }
  const spec = findSpec(db, "event", ev.id) ?? findSpec(db, "order", ev.orderId) ?? findSpec(db, "quote", ev.quoteId) ?? findSpec(db, "inquiry", ev.inquiryId);
  if (spec) {
    if (spec.deadline && (ev.kind === "delivery" || ev.kind === "install") && end > spec.deadline) out.push(`納品・完了の期限 (${shortDate(spec.deadline)}) を過ぎます`);
    if (spec.avoidDates.includes(ev.date)) out.push(`お客様の都合の悪い日 (${shortDate(ev.date)}) です`);
    if (spec.preferenceStrength === "hard" && spec.preferredDates.length && !spec.preferredDates.includes(ev.date)) out.push(`お客様の希望の日 (${spec.preferredDates.map(shortDate).join("・")}) ではありません`);
  }
  const m = loadMasters(db);
  for (const uid of ev.assigneeIds) {
    const u = db.users.find((x) => x.id === uid);
    if (!u) continue;
    const p = profileOf(m, u);
    if (p.configured && !p.workDays.includes(dayOfWeek(ev.date))) out.push(`${u.name}の勤務日ではありません (${"日月火水木金土"[dayOfWeek(ev.date)]}曜)`);
  }
  const holds = activeHolds(db, now).filter((h) => sameCase(h) && h.kind === ev.kind && h.date !== ev.date);
  if (holds.length) out.push(`同じ案件の${SCHEDULE_KIND[ev.kind].label}の仮押さえ (${holds.map((h) => shortDate(h.date)).join("・")}) があります。不要なら解除してください`);
  return [...new Set(out)];
}

/** 予定の日が変わったとき、ひも付く車両・設備の予約も同じ日時に動かす (db は mutate の中のもの) */
export function moveBookingsWithEvent(db: Database, ev: ScheduleEvent): number {
  let n = 0;
  for (const b of db.resourceBookings ?? []) {
    if (b.eventId !== ev.id) continue;
    if (b.date === ev.date && b.endDate === ev.endDate && b.startTime === ev.startTime && b.endTime === ev.endTime) continue;
    Object.assign(b, { date: ev.date, endDate: ev.endDate, startTime: ev.startTime, endTime: ev.endTime, slot: ev.startTime ? undefined : ev.slot });
    n++;
  }
  return n;
}
