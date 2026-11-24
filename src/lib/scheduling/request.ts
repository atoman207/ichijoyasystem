import "server-only";
import type { ScheduleEvent, ScheduleKind, StoreId, User } from "@/lib/db/types";
import { canAccessStore } from "@/lib/auth/permissions";
import { SCHEDULE_KIND } from "@/lib/constants";
import { addDays } from "@/lib/format";
import { isDateKey, lastDay, shortDate } from "@/lib/calendar";
import { geocodePlace, type GeoPoint } from "@/lib/geo/kumamoto";
import { activeHolds, type PlanContext } from "./context";
import type { JobRequest, SuggestSlot } from "./engine";
import { describeItems, resolveJob, siteMinutes, SPEC_SOURCE_LABEL } from "./spec";

/**
 * 提案の入力 (画面・AI アシスタント・案件の画面) から、計算の依頼 (JobRequest) を作る。
 * 案件 (受注・見積・問い合わせ) は利用者の閲覧範囲で読む (見られない案件の住所・数量は使わない)
 */

export interface SuggestInput {
  storeId: StoreId;
  kind: ScheduleKind;
  durationDays?: number;
  slot?: SuggestSlot;
  address?: string;
  customerId?: string;
  orderId?: string;
  inquiryId?: string;
  quoteId?: string;
  tatamiCount?: number;
  staffCount?: number;
  assigneeIds?: string[];
  from?: string;
  to?: string;
  eventId?: string;
  minutes?: number;
  limit?: number;
  /** 予定の件名・メモ (保存前の入力。作業の内容の推定に使う) */
  title?: string;
  memo?: string;
}

/** 案件の段階の順番 (先の段階の予定より後に入れる) */
export const STAGE: Partial<Record<ScheduleKind, number>> = { survey: 0, onsite_quote: 0, visit: 0, measure: 1, pickup: 2, install: 3, delivery: 4 };

export interface BuiltRequest {
  req: JobRequest;
  notes: string[];
  site?: GeoPoint;
  caseEvents: ScheduleEvent[];
}

export function buildRequest(ctx: Pick<PlanContext, "db" | "m" | "user" | "today" | "capOf" | "stats" | "now">, input: SuggestInput, key = "new"): BuiltRequest | { error: string } {
  const { db, m, user } = ctx;
  const notes: string[] = [];
  const store = db.stores.find((s) => s.id === input.storeId);
  if (!store) return { error: "店舗が見つかりません。" };
  const kind = input.kind;
  const cap = ctx.capOf(store.id);

  const visible = <T extends { storeId: StoreId }>(x: T | undefined): T | undefined => (x && canAccessStore(user, x.storeId) ? x : undefined);
  const order = visible(input.orderId ? db.orders.find((o) => o.id === input.orderId) : undefined);
  const quote = visible(input.quoteId ? db.quotes.find((q) => q.id === input.quoteId) : order?.quoteId ? db.quotes.find((q) => q.id === order.quoteId) : undefined);
  const inquiry = visible(input.inquiryId ? db.inquiries.find((i) => i.id === input.inquiryId) : quote?.inquiryId ? db.inquiries.find((i) => i.id === quote.inquiryId) : undefined);
  const customerId = input.customerId ?? order?.customerId ?? quote?.customerId ?? inquiry?.customerId;
  const customer = visible(customerId ? db.customers.find((c) => c.id === customerId) : undefined);
  if ((input.orderId && !order) || (input.quoteId && !quote) || (input.inquiryId && !inquiry) || (input.customerId && !customer))
    notes.push("案件・お客様の一部は閲覧の権限がないため、住所・数量・希望の手がかりに使っていません。");

  const caseEvents = db.schedule.filter((e) => e.id !== input.eventId && ((order && e.orderId === order.id) || (quote && e.quoteId === quote.id) || (inquiry && e.inquiryId === inquiry.id)));
  const caseHolds = activeHolds(db, ctx.now).filter((h) => (order && h.orderId === order.id) || (quote && h.quoteId === quote.id) || (inquiry && h.inquiryId === inquiry.id));
  const address = input.address?.trim() || order?.siteAddress || quote?.siteAddress || customer?.address || inquiry?.area || "";
  const site = address ? geocodePlace(address, { storeId: store.id, customers: db.customers }) : undefined;
  if (site) notes.push(`現場の場所: ${site.label} (${site.precision === "locality" ? "町名まで推定" : "市区町村まで推定"})。`);
  else notes.push(address ? "現場の住所から場所を特定できなかったため、移動の距離は比べていません (市区町村から書くと精度が上がります)。" : "現場の住所がないため、移動の距離は比べていません (住所を入れると、近くの現場とまとめて回れる日を優先します)。");

  const job = resolveJob(db, m, {
    kind,
    eventId: input.eventId,
    orderId: order?.id,
    quoteId: quote?.id,
    inquiryId: inquiry?.id,
    order,
    quote,
    text: `${input.title ?? ""}\n${input.memo ?? ""}`,
    tatamiCount: input.tatamiCount,
    caseEvents,
  });
  if (job.items.length) notes.push(`作業の内容: ${describeItems(job)} (${SPEC_SOURCE_LABEL[job.source]})。`);
  const production = kind === "pickup" && job.production.size > 0;

  const fixed = [...new Set(input.assigneeIds ?? [])].map((id) => db.users.find((u) => u.id === id && u.active)).filter((u): u is User => Boolean(u));
  const staffCount = fixed.length || Math.max(1, Math.min(6, Math.round(input.staffCount ?? job.staffCount ?? ctx.stats.stores[store.id]?.teamSize[kind] ?? 1)));
  const duration = Math.max(1, Math.min(10, Math.round(input.durationDays ?? 1)));
  const sm = siteMinutes(job, kind);
  const minutes = Math.max(15, Math.min(600, Math.round(input.minutes ?? sm.minutes)));
  if (!input.minutes && sm.from === "workType") notes.push(`作業時間: ${minutes} 分 (作業種別の標準工数から)。`);
  const slots: SuggestSlot[] = input.slot ? [input.slot] : kind === "install" || minutes >= 300 ? ["day"] : ["am", "pm"];

  /* ---- 探す期間 (案件の先の段階の予定・引き取り可能日・製造の完成より後) ---- */
  let earliest = addDays(ctx.today, cap.leadDays);
  const myStage = STAGE[kind] ?? 0;
  let afterPickup: string | undefined;
  for (const e of [...caseEvents, ...caseHolds.map((h) => ({ ...h, title: `[仮] ${h.title}` }))]) {
    const st = STAGE[e.kind];
    if (st === undefined || st >= myStage) continue;
    const after = kind === "delivery" && e.kind === "pickup" ? addDays(lastDay(e), 1) : lastDay(e);
    if (kind === "delivery" && e.kind === "pickup" && (!afterPickup || e.date > afterPickup)) afterPickup = e.date;
    if (after > earliest) {
      earliest = after;
      notes.push(`同じ案件の「${SCHEDULE_KIND[e.kind].label}」(${shortDate(e.date)}) より後の日から探しました${kind === "delivery" && e.kind === "pickup" ? " (納品は引き取りの翌日以降)" : ""}。`);
    }
  }
  // 納品: 製造の完成 (製造の予定があればその終わりの日、なければ作業種別の製造日数)
  if (kind === "delivery" && afterPickup) {
    const pj = (db.productionJobs ?? []).find((j) => j.status !== "cancelled" && ((order && j.orderId === order.id) || (quote && j.quoteId === quote.id)));
    const ready = pj ? addDays(pj.endDate, m.rules.deliveryGapDays + 1) : job.leadDays > 0 ? addDays(afterPickup, job.leadDays + m.rules.deliveryGapDays) : undefined;
    if (ready && ready > earliest) {
      earliest = ready;
      notes.push(pj ? `製造の予定 (${shortDate(pj.endDate)} に完成) の後から探しました。` : `製造日数 ${job.leadDays} 日 (作業種別の標準) の後から探しました。`);
    }
  }
  if (kind === "pickup" && job.pickupFrom && job.pickupFrom > earliest) {
    earliest = job.pickupFrom;
    notes.push(`引き取りができる日 (${shortDate(job.pickupFrom)}) から探しました。`);
  }
  const from = isDateKey(input.from) && input.from > earliest ? input.from : earliest;
  let to = isDateKey(input.to) && input.to >= from ? input.to : addDays(from, cap.horizonDays - 1);
  if (job.strength === "hard" && job.preferredDates.length) {
    const last = [...job.preferredDates].sort().at(-1)!;
    if (last > to) to = last;
  }
  if (to > addDays(from, 61)) to = addDays(from, 61);
  if (job.deadline && job.deadline < from) notes.push(`期限 (${shortDate(job.deadline)}) を過ぎているため、期限に間に合う候補はありません。`);

  if (job.strength !== "none" && (job.preferredDates.length || job.preferredWeekdays.length))
    notes.push(`お客様の希望 (${job.strength === "hard" ? "必ず" : "できれば"}): ${[...job.preferredDates.map(shortDate), ...job.preferredWeekdays.map((d) => `${"日月火水木金土"[d]}曜`)].join("・")}${job.preferredSlot ? ` ${job.preferredSlot === "am" ? "午前" : job.preferredSlot === "pm" ? "午後" : "終日"}` : ""}${job.preferredTime ? ` ${job.preferredTime}` : ""}`);
  if (job.priority !== "normal") notes.push(`優先度: ${job.priority === "urgent" ? "緊急" : job.priority === "high" ? "高" : "低"}`);

  return {
    req: {
      key,
      storeId: store.id,
      kind,
      title: input.title?.trim() || `${SCHEDULE_KIND[kind].label}${customer ? ` ${customer.name}様` : ""}`,
      durationDays: duration,
      slots,
      minutes,
      staffCount,
      fixed,
      site,
      job,
      earliest: from,
      latest: to,
      afterPickup,
      production,
      orderId: order?.id,
      quoteId: quote?.id,
      inquiryId: inquiry?.id,
      customerId: customer?.id,
      location: address || undefined,
    },
    notes,
    site,
    caseEvents,
  };
}
