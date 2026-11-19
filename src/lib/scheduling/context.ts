import "server-only";
import type { Customer, Database, Order, ResourceBooking, ScheduleEvent, ScheduleHold, ScheduleKind, StoreId, User } from "@/lib/db/types";
import { SCHEDULE_KIND } from "@/lib/constants";
import { addDays, toDateKey } from "@/lib/format";
import { dayOfWeek, eventDays, lastDay, monthEnd, monthStart, toMinutes } from "@/lib/calendar";
import { geocodeAddress, geocodePlace, type GeoPoint } from "@/lib/geo/kumamoto";
import { createTravel, type TravelFn } from "@/lib/geo/routing";
import { effectiveCapacity, isClosedDay, JOB_KINDS, scheduleStats, VISIT_KINDS, workOf, type DayLoad, type EffectiveCapacity, type ScheduleStats } from "@/lib/schedule-capacity";
import { loadMasters, profileOf, type Masters, type Process, type StaffProfile } from "./masters";
import { resolveJob, type ResolvedJob } from "./spec";

/**
 * 計画の計算の土台 (1 回の提案・最適化で 1 つ作る)
 * ------------------------------------------------------------
 * 予定 (schedule)・仮押さえ (schedule_holds)・計画中の仮の予定 (最適化の途中) を同じ形 (PlanItem) で持ち、
 * 担当者 × 日・店舗 × 日・車両 × 日・製造工程 × 日の索引を作る。最適化は add / remove で仮の予定を出し入れする
 */

export interface PlanItem {
  id: string;
  origin: "event" | "hold" | "plan";
  kind: ScheduleKind;
  storeId: StoreId;
  title: string;
  date: string;
  endDate?: string;
  startTime?: string;
  endTime?: string;
  slot?: "am" | "pm";
  assigneeIds: string[];
  resourceIds: string[];
  location?: string;
  customerId?: string;
  inquiryId?: string;
  quoteId?: string;
  orderId?: string;
  memo?: string;
  companyWide?: boolean;
  /** 作業時間 (分。分かっているとき) */
  minutes?: number;
  /** 現場の位置 (計画中の予定は先に決めて渡す) */
  geo?: GeoPoint;
  /** 引き取り・製造の数 (畳・襖など) */
  units?: number;
}

export interface ResourceUse {
  booking?: ResourceBooking;
  item?: PlanItem;
  date: string;
  startTime?: string;
  endTime?: string;
  slot?: "am" | "pm";
}

export interface PlanContext {
  db: Database;
  user: User;
  now: Date;
  today: string;
  m: Masters;
  stats: ScheduleStats;
  travel: TravelFn;
  from: string;
  to: string;
  items: Map<string, PlanItem>;
  byPersonDay: Map<string, PlanItem[]>;
  byStoreDay: Map<string, PlanItem[]>;
  /** 店舗 × 日の件数 (現場作業・営業の訪問・引き取る畳の枚数) */
  loads: Map<string, DayLoad>;
  resourceDay: Map<string, ResourceUse[]>;
  /** 製造工程 × 日の使った分 */
  production: Map<string, number>;
  /** 計画中の予定の製造 (remove で戻す) */
  productionByItem: Map<string, { processId: string; date: string; minutes: number }[]>;
  /** 数えない予定 (変更中の予定・全体の最適化で動かす予定) */
  excluded: Set<string>;
  capOf(storeId: StoreId): EffectiveCapacity;
  geoOf(item: PlanItem): GeoPoint | undefined;
  baseOf(storeId: StoreId): GeoPoint | undefined;
  isClosed(storeId: StoreId, day: string): boolean;
  profile(u: User): StaffProfile & { configured: boolean };
  processFor(storeId: StoreId, key: string): Process | undefined;
  processCapacity(p: Process, day: string): number;
  add(item: PlanItem): void;
  remove(id: string): void;
}

export interface ContextOptions {
  now?: Date;
  /** 索引の期間 (この期間の月の初めから終わりまで読む) */
  from: string;
  to: string;
  /** 数えない予定の ID */
  exclude?: Iterable<string>;
  /** 移動時間の関数 (テスト・事前取得のあと) */
  travel?: TravelFn;
  masters?: Masters;
}

const HOLD_ACTIVE: ScheduleHold["status"][] = ["held"];

export function holdItem(h: ScheduleHold): PlanItem {
  return {
    id: h.id,
    origin: "hold",
    kind: h.kind,
    storeId: h.storeId,
    title: `[仮] ${h.title}`,
    date: h.date,
    endDate: h.endDate,
    startTime: h.startTime,
    endTime: h.endTime,
    slot: h.slot,
    assigneeIds: h.assigneeIds,
    resourceIds: h.resourceIds,
    location: h.location,
    customerId: h.customerId,
    inquiryId: h.inquiryId,
    quoteId: h.quoteId,
    orderId: h.orderId,
    memo: h.memo,
  };
}

export function eventItem(e: ScheduleEvent): PlanItem {
  return {
    id: e.id,
    origin: "event",
    kind: e.kind,
    storeId: e.storeId,
    title: e.title,
    date: e.date,
    endDate: e.endDate,
    startTime: e.startTime,
    endTime: e.endTime,
    slot: e.slot,
    assigneeIds: e.assigneeIds,
    resourceIds: [],
    location: e.location,
    customerId: e.customerId,
    inquiryId: e.inquiryId,
    quoteId: e.quoteId,
    orderId: e.orderId,
    memo: e.memo,
    companyWide: e.companyWide,
  };
}

/** 有効な仮押さえ (期限切れは数えない) */
export function activeHolds(db: Pick<Database, "scheduleHolds">, now = new Date()): ScheduleHold[] {
  const iso = now.toISOString();
  return (db.scheduleHolds ?? []).filter((h) => HOLD_ACTIVE.includes(h.status) && h.expiresAt > iso);
}

const itemDays = (i: Pick<PlanItem, "date" | "endDate">) => eventDays(i);

export function createPlanContext(db: Database, user: User, opts: ContextOptions): PlanContext {
  const now = opts.now ?? new Date();
  const today = toDateKey(now);
  const m = opts.masters ?? loadMasters(db);
  const stats = scheduleStats(db, now);
  const from = monthStart(addDays(opts.from, -14));
  const to = monthEnd(opts.to);
  const excluded = new Set(opts.exclude ?? []);
  const capCache = new Map<StoreId, EffectiveCapacity>();
  const capOf = (s: StoreId) => capCache.get(s) ?? capCache.set(s, effectiveCapacity(db, s, now)).get(s)!;
  const travel = opts.travel ?? createTravel(m.routing, capOf(user.storeId).travelSpeedKmh);

  const items = new Map<string, PlanItem>();
  const byPersonDay = new Map<string, PlanItem[]>();
  const byStoreDay = new Map<string, PlanItem[]>();
  const loads = new Map<string, DayLoad>();
  const resourceDay = new Map<string, ResourceUse[]>();
  const production = new Map<string, number>();
  const productionByItem = new Map<string, { processId: string; date: string; minutes: number }[]>();

  const push = <T>(map: Map<string, T[]>, k: string, v: T) => {
    const list = map.get(k);
    if (list) list.push(v);
    else map.set(k, [v]);
  };
  const pull = <T>(map: Map<string, T[]>, k: string, pred: (v: T) => boolean) => {
    const list = map.get(k);
    if (!list) return;
    const next = list.filter((v) => !pred(v));
    if (next.length) map.set(k, next);
    else map.delete(k);
  };

  /* ---- 位置 ---- */
  const customers: Customer[] = db.customers;
  const customerById = new Map<string, Customer>();
  const orderById = new Map<string, Order>();
  const geoCache = new Map<string, GeoPoint | null>();
  const mapPoint = mapLocationPoints(db);
  const geoOf = (it: PlanItem): GeoPoint | undefined => {
    if (it.geo) return it.geo;
    if (geoCache.has(it.id)) return geoCache.get(it.id) ?? undefined;
    let p: GeoPoint | undefined = mapPoint.byRecord.get(`event:${it.id}`);
    if (!p && it.location) p = geocodePlace(it.location, { storeId: it.storeId, customers, title: it.title });
    if (!p && it.orderId) {
      if (!orderById.size) for (const o of db.orders) orderById.set(o.id, o);
      const o = orderById.get(it.orderId);
      p = mapPoint.byRecord.get(`order:${it.orderId}`) ?? (o?.siteAddress ? geocodePlace(o.siteAddress, { storeId: it.storeId, customers }) : undefined);
    }
    if (!p && it.customerId) {
      if (!customerById.size) for (const c of customers) customerById.set(c.id, c);
      const c = customerById.get(it.customerId);
      p = mapPoint.byRecord.get(`customer:${it.customerId}`) ?? (c?.address ? geocodeAddress(c.address) : undefined);
    }
    if (!p) p = geocodePlace("", { storeId: it.storeId, customers, title: it.title });
    geoCache.set(it.id, p ?? null);
    return p;
  };
  const baseCache = new Map<StoreId, GeoPoint | undefined>();
  const baseOf = (s: StoreId) => {
    if (!baseCache.has(s)) baseCache.set(s, geocodeAddress(db.stores.find((x) => x.id === s)?.address));
    return baseCache.get(s);
  };

  /* ---- 製造工程 ---- */
  const processFor = (storeId: StoreId, key: string) =>
    m.processes.find((p) => p.active && p.key === key && p.storeId === storeId) ?? m.processes.find((p) => p.active && p.key === key && p.servesStores.includes(storeId));
  const processCapacity = (p: Process, day: string): number => {
    if (p.workdays.length ? !p.workdays.includes(dayOfWeek(day)) : isClosedDay(db, day)) return 0;
    if (p.minutesPerDay !== undefined) return p.minutesPerDay;
    // 未設定: 畳は店舗の「畳の製造の枚数」× 1 枚 30 分、ほかは 1 日 4 時間 (暫定)
    return p.key === "tatami" ? capOf(p.storeId).tatamiPerDay * 30 : 240;
  };

  const profiles = new Map<string, StaffProfile & { configured: boolean }>();
  const profile = (u: User) => profiles.get(u.id) ?? profiles.set(u.id, profileOf(m, u)).get(u.id)!;

  /* ---- 索引への出し入れ ---- */
  const unitsOf = (it: PlanItem): number => {
    if (it.units !== undefined) return it.units;
    const w = workOf(it);
    return w.tatami;
  };
  const add = (it: PlanItem) => {
    items.set(it.id, it);
    const job = JOB_KINDS.includes(it.kind);
    const visit = VISIT_KINDS.includes(it.kind);
    for (const d of itemDays(it)) {
      for (const uid of new Set(it.assigneeIds)) push(byPersonDay, `${uid}|${d}`, it);
      push(byStoreDay, `${it.storeId}|${d}`, it);
      if (job || visit) {
        const k = `${it.storeId}|${d}`;
        const l = loads.get(k) ?? { jobs: 0, visits: 0, tatami: 0 };
        if (job) l.jobs++;
        if (visit) l.visits++;
        if (it.kind === "pickup" && d === it.date) l.tatami += unitsOf(it);
        loads.set(k, l);
      }
      for (const r of it.resourceIds) push(resourceDay, `${r}|${d}`, { item: it, date: d, startTime: it.startTime, endTime: it.endTime, slot: it.slot });
    }
  };
  const remove = (id: string) => {
    const it = items.get(id);
    if (!it) return;
    items.delete(id);
    const job = JOB_KINDS.includes(it.kind);
    const visit = VISIT_KINDS.includes(it.kind);
    for (const d of itemDays(it)) {
      for (const uid of new Set(it.assigneeIds)) pull(byPersonDay, `${uid}|${d}`, (x) => x.id === id);
      pull(byStoreDay, `${it.storeId}|${d}`, (x) => x.id === id);
      if (job || visit) {
        const l = loads.get(`${it.storeId}|${d}`);
        if (l) {
          if (job) l.jobs = Math.max(0, l.jobs - 1);
          if (visit) l.visits = Math.max(0, l.visits - 1);
          if (it.kind === "pickup" && d === it.date) l.tatami = Math.max(0, l.tatami - unitsOf(it));
        }
      }
      for (const r of it.resourceIds) pull(resourceDay, `${r}|${d}`, (x) => x.item?.id === id);
    }
    for (const s of productionByItem.get(id) ?? []) production.set(`${s.processId}|${s.date}`, Math.max(0, (production.get(`${s.processId}|${s.date}`) ?? 0) - s.minutes));
    productionByItem.delete(id);
  };

  const ctx: PlanContext = {
    db,
    user,
    now,
    today,
    m,
    stats,
    travel,
    from,
    to,
    items,
    byPersonDay,
    byStoreDay,
    loads,
    resourceDay,
    production,
    productionByItem,
    excluded,
    capOf,
    geoOf,
    baseOf,
    isClosed: (storeId, day) => isClosedDay(db, day) || (db.stores.find((s) => s.id === storeId)?.closedOn ?? "9999") <= day,
    profile,
    processFor,
    processCapacity,
    add,
    remove,
  };

  /* ---- 予定・仮押さえ・車両の予約・製造の予定を入れる ---- */
  const holdIdsWithEvent = new Set<string>();
  for (const e of db.schedule) {
    if (excluded.has(e.id) || e.date > to || lastDay(e) < from) continue;
    add(eventItem(e));
  }
  for (const h of activeHolds(db, now)) {
    if (excluded.has(h.id) || h.date > to || lastDay(h) < from) continue;
    if (h.eventId) holdIdsWithEvent.add(h.id);
    add(holdItem(h));
  }
  for (const b of db.resourceBookings ?? []) {
    if ((b.eventId && excluded.has(b.eventId)) || (b.holdId && excluded.has(b.holdId)) || b.date > to || (b.endDate ?? b.date) < from) continue;
    // 予定・仮押さえにひも付く予約は、その予定の時間で数える
    const it = b.eventId ? items.get(b.eventId) : b.holdId ? items.get(b.holdId) : undefined;
    if (it && !it.resourceIds.includes(b.resourceId)) {
      it.resourceIds = [...it.resourceIds, b.resourceId];
      for (const d of itemDays(it)) push(resourceDay, `${b.resourceId}|${d}`, { item: it, booking: b, date: d, startTime: it.startTime, endTime: it.endTime, slot: it.slot });
      continue;
    }
    if (it) continue;
    for (const d of eventDays({ date: b.date, endDate: b.endDate })) push(resourceDay, `${b.resourceId}|${d}`, { booking: b, date: d, startTime: b.startTime, endTime: b.endTime, slot: b.slot });
  }
  // 製造の予定 (登録済み)
  const planned = new Set<string>();
  for (const j of db.productionJobs ?? []) {
    if (j.status === "cancelled" || j.status === "done") continue;
    // 作り直す製造の予定 (引き取りの予定・仮押さえを除いたとき) は数えない
    if (excluded.has(j.id) || (j.pickupEventId && excluded.has(j.pickupEventId)) || (j.holdId && excluded.has(j.holdId))) continue;
    if (j.pickupEventId) planned.add(j.pickupEventId);
    if (j.holdId) planned.add(j.holdId);
    for (const s of j.steps) {
      if (s.status === "done" || s.date < from || s.date > to) continue;
      const proc = m.processes.find((p) => p.id === s.processId);
      if (!proc) continue;
      production.set(`${proc.id}|${s.date}`, (production.get(`${proc.id}|${s.date}`) ?? 0) + s.minutes);
    }
  }
  // 製造の予定がない引き取り (予定表の「畳 表替え6」) は、引き取りの翌日からの製造の見込みとして数える
  const pickups = [...items.values()].filter((it) => it.kind === "pickup" && !planned.has(it.id) && it.date >= addDays(today, -14)).sort((a, b) => a.date.localeCompare(b.date));
  for (const it of pickups) {
    const job = resolveJob(db, m, { eventId: it.origin === "event" ? it.id : undefined, orderId: it.orderId, text: `${it.title}\n${it.memo ?? ""}` });
    if (!job.production.size) continue;
    estimateProduction(ctx, it.storeId, job, it.date, it.id);
  }
  return ctx;
}

/**
 * 製造の見込みを工程 × 日に積む (引き取りの日 (翌日) から、工程の 1 日の能力の範囲で前から順に)。
 * 戻り値は工程ごとの予定と完成の日。apply = false なら積まずに計算だけ
 */
export function estimateProduction(
  ctx: PlanContext,
  storeId: StoreId,
  job: Pick<ResolvedJob, "items" | "production" | "leadDays">,
  pickupDay: string,
  itemId?: string,
  apply = true,
): { steps: { processId: string; processKey: string; date: string; minutes: number; qty: number }[]; readyDate: string; missing: string[]; spanDays: number } {
  const start = ctx.m.rules.productionStartsNextDay ? addDays(pickupDay, 1) : pickupDay;
  const steps: { processId: string; processKey: string; date: string; minutes: number; qty: number }[] = [];
  const missing: string[] = [];
  let ready = pickupDay;
  // 作業種別ごとの工程の順番 (別の種別は並行して作る)
  for (const item of job.items) {
    let day = start;
    for (const pr of item.workType.processes) {
      const proc = ctx.processFor(storeId, pr.processKey);
      if (!proc) {
        if (!missing.includes(pr.processKey)) missing.push(pr.processKey);
        continue;
      }
      let remaining = pr.minutesPerUnit * item.qty;
      const perUnit = pr.minutesPerUnit;
      let guard = 0;
      while (remaining > 0 && guard++ < 60) {
        const cap = ctx.processCapacity(proc, day);
        const used = ctx.production.get(`${proc.id}|${day}`) ?? 0;
        const take = Math.min(remaining, Math.max(0, cap - used));
        if (take > 0) {
          steps.push({ processId: proc.id, processKey: proc.key, date: day, minutes: take, qty: Math.round((take / perUnit) * 10) / 10 });
          if (apply) {
            ctx.production.set(`${proc.id}|${day}`, used + take);
            if (itemId) {
              const list = ctx.productionByItem.get(itemId) ?? [];
              list.push({ processId: proc.id, date: day, minutes: take });
              ctx.productionByItem.set(itemId, list);
            }
          }
          remaining -= take;
        }
        if (remaining > 0) day = addDays(day, 1);
      }
      if (day > ready) ready = day;
    }
  }
  const minReady = addDays(pickupDay, job.leadDays);
  if (minReady > ready) ready = minReady;
  return { steps, readyDate: ready, missing, spanDays: Math.max(0, Math.round((Date.parse(ready) - Date.parse(pickupDay)) / 86_400_000)) };
}

/** 地図で確かめた位置 (map_locations の確認済みの緯度経度) を記録ごとに引く */
function mapLocationPoints(db: Database): { byRecord: Map<string, GeoPoint> } {
  const byRecord = new Map<string, GeoPoint>();
  const locs = new Map((db.mapLocations ?? []).filter((l) => l.status === "active" && l.coordStatus === "verified" && typeof l.lat === "number" && typeof l.lng === "number").map((l) => [l.id, l]));
  if (!locs.size) return { byRecord };
  for (const r of db.mapLocationRefs ?? []) {
    const l = r.locationId ? locs.get(r.locationId) : undefined;
    if (!l) continue;
    const muni = geocodeAddress(l.address);
    byRecord.set(`${r.recordType}:${r.recordId}`, { lat: l.lat!, lng: l.lng!, label: muni?.label ?? l.address.slice(0, 20), precision: "locality" });
  }
  return { byRecord };
}

/** その時間帯の作業時間 (分) */
export function itemMinutes(it: PlanItem): number {
  if (it.minutes) return it.minutes;
  if (it.startTime && it.endTime) return Math.max(15, toMinutes(it.endTime) - toMinutes(it.startTime));
  return SCHEDULE_KIND[it.kind]?.minutes || 60;
}
