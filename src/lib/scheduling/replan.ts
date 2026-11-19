import "server-only";
import type { Database, ScheduleKind, StoreId, User } from "@/lib/db/types";
import { canAccessStore } from "@/lib/auth/permissions";
import { SCHEDULE_KIND } from "@/lib/constants";
import { addDays, daysBetween, toDateKey } from "@/lib/format";
import { toMinutes } from "@/lib/calendar";
import { SUGGEST_KINDS } from "@/lib/schedule-capacity";
import type { TravelFn } from "@/lib/geo/routing";
import { createPlanContext, eventItem } from "./context";
import { evaluateJob, pickDiverse, type Candidate } from "./engine";
import { loadMasters } from "./masters";
import { buildRequest } from "./request";
import { waitingJobs } from "./optimize";

/**
 * 取消し・延期で空いた枠の使い方 (キャンセル発生時の再編成の提案)
 * ------------------------------------------------------------
 * 予定を削除した・後ろへずらしたとき、その日 (空いた枠) に
 *  ① 同じ店舗の後の日の予定を前倒しできるもの (お客様を早く案内できる・移動が減る)
 *  ② まだ日程のない案件 (問い合わせの現地調査・受注の引き取り/施工/納品) を入れられるもの
 * を点数の順に提案する。自動では動かさない (前倒しはお客様・担当者に連絡してから変更する)
 */

export interface FreedSlot {
  storeId: StoreId;
  date: string;
  kind?: ScheduleKind;
  title?: string;
  assigneeIds: string[];
  at: string;
  by?: string;
  eventId: string;
  reason: "deleted" | "moved";
}

export interface PullForwardOption {
  type: "advance" | "waiting";
  eventId?: string;
  key?: string;
  title: string;
  kind: ScheduleKind;
  /** 前倒し: いまの日 */
  currentDate?: string;
  daysEarlier?: number;
  href?: string;
  candidate: Candidate;
  rank: number;
}

/** 最近の取消し・延期 (変更履歴から。今日以降の日のもの) */
export function recentFreedSlots(db: Database, user: User, opts: { days?: number; now?: Date } = {}): FreedSlot[] {
  const now = opts.now ?? new Date();
  const today = toDateKey(now);
  const since = new Date(now.getTime() - (opts.days ?? 7) * 86_400_000).toISOString();
  const out: FreedSlot[] = [];
  for (const l of db.auditLogs) {
    if (l.entity !== "schedule" || l.at < since || !l.storeId || !canAccessStore(user, l.storeId as StoreId)) continue;
    const ch = (f: string) => l.changes?.find((c) => c.field === f);
    const date = ch("date");
    if (!date) continue;
    const before = typeof date.before === "string" ? date.before : undefined;
    if (!before || before < today) continue;
    const kind = ch("kind")?.before as ScheduleKind | undefined;
    if (kind && !SUGGEST_KINDS.includes(kind)) continue;
    if (l.action === "delete") out.push({ storeId: l.storeId as StoreId, date: before, kind, title: l.entityLabel, assigneeIds: (ch("assigneeIds")?.before as string[]) ?? [], at: l.at, by: l.userId, eventId: l.entityId, reason: "deleted" });
    else if (l.action === "update" && typeof date.after === "string" && date.after > before) out.push({ storeId: l.storeId as StoreId, date: before, kind, title: l.entityLabel, assigneeIds: [], at: l.at, by: l.userId, eventId: l.entityId, reason: "moved" });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date)).slice(0, 20);
}

/** 空いた日に入れられる予定・案件 */
export function pullForwardInto(db: Database, user: User, slot: { storeId: StoreId; date: string }, opts: { now?: Date; limit?: number; travel?: TravelFn } = {}): PullForwardOption[] {
  const now = opts.now ?? new Date();
  const today = toDateKey(now);
  if (slot.date < today) return [];
  const m = loadMasters(db);
  const ctx = createPlanContext(db, user, { now, from: slot.date, to: addDays(slot.date, 45), travel: opts.travel, masters: m });
  const out: PullForwardOption[] = [];
  const later = db.schedule
    .filter((e) => e.storeId === slot.storeId && SUGGEST_KINDS.includes(e.kind) && e.date > slot.date && e.date <= addDays(slot.date, 30) && e.source !== "order" && !e.endDate && canAccessStore(user, e.storeId))
    .filter((e) => (db.jobSpecs ?? []).find((s) => s.id === `js_event_${e.id}`)?.preferenceStrength !== "hard")
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 40);
  for (const e of later) {
    const built = buildRequest(ctx, { storeId: e.storeId, kind: e.kind, orderId: e.orderId, quoteId: e.quoteId, inquiryId: e.inquiryId, customerId: e.customerId, address: e.location, assigneeIds: e.assigneeIds.length ? e.assigneeIds : undefined, eventId: e.id, title: e.title, memo: e.memo, minutes: e.startTime && e.endTime ? Math.max(15, toMinutes(e.endTime) - toMinutes(e.startTime)) : undefined }, e.id);
    if ("error" in built) continue;
    // 案件の順番 (納品は引き取りの後) を守る: 前の段階より前には入れない
    if (built.req.earliest > slot.date) continue;
    ctx.remove(e.id);
    const best = pickDiverse(evaluateJob(ctx, { ...built.req, earliest: slot.date, latest: slot.date }).candidates, 1)[0];
    ctx.add(eventItem(e));
    if (!best) continue;
    const daysEarlier = daysBetween(slot.date, e.date);
    const prio = built.req.job.priority === "urgent" ? 3 : built.req.job.priority === "high" ? 2 : 1;
    out.push({ type: "advance", eventId: e.id, title: e.title, kind: e.kind, currentDate: e.date, daysEarlier, href: `/schedule/${e.id}`, candidate: best, rank: best.score + Math.min(30, daysEarlier * 2) * prio });
  }
  for (const w of waitingJobs(db, user, { storeIds: [slot.storeId], now, limit: 30 })) {
    const built = buildRequest(ctx, w, w.key);
    if ("error" in built || built.req.earliest > slot.date) continue;
    const best = pickDiverse(evaluateJob(ctx, { ...built.req, earliest: slot.date, latest: slot.date }).candidates, 1)[0];
    if (!best) continue;
    const waited = daysBetween(w.since, today);
    out.push({ type: "waiting", key: w.key, title: w.label, kind: w.kind, href: w.href, candidate: best, rank: best.score + Math.min(30, waited) });
  }
  return out.sort((a, b) => b.rank - a.rank).slice(0, opts.limit ?? 6);
}

export function describeFreed(f: FreedSlot): string {
  return `${f.reason === "deleted" ? "取消し" : "延期"}: ${f.title ?? ""} (${f.kind ? SCHEDULE_KIND[f.kind].label : "予定"})`;
}
