import "server-only";
import type { Database, ProductionJob, ScheduleEvent, ScheduleHold, StoreId, User } from "@/lib/db/types";
import { newId, nowIso } from "@/lib/db/store";
import { addDays, toDateKey } from "@/lib/format";
import { dateRange } from "@/lib/calendar";
import { stockBalances } from "@/lib/mgmt/stock";
import { createPlanContext, estimateProduction } from "./context";
import { loadMasters, PROCESS_KEYS, type Masters } from "./masters";
import { resolveJob, type ResolvedJob } from "./spec";

/**
 * 製造の予定 (引き取り → 工程ごとの製造 → 納品)
 * ------------------------------------------------------------
 * - 引き取りの予定 (または仮押さえ) から、作業種別の工程と 1 枚あたりの時間で、作業場の工程の 1 日の能力の範囲に前から積む
 *   (数日にまたがることもある)。完成の日 = 最後の工程の日 (と作業種別の製造日数の大きい方)
 * - 材料: 作業種別の 1 単位あたりの材料 × 数量を、管理会計の在庫 (店舗の在庫) と比べる
 * - 納品の予定がある案件は、納品の日が完成の日より前ならその旨を返す
 * 予定の候補日の提案は、この表 (production_jobs) と、製造の予定がない引き取りの見込みの両方で工程の空きを数える
 */

export function materialCheck(db: Pick<Database, "stockMoves" | "materials">, m: Masters, storeId: StoreId, job: Pick<ResolvedJob, "items">): NonNullable<ProductionJob["materialCheck"]> {
  const need = new Map<string, number>();
  for (const i of job.items) for (const mt of i.workType.materials) need.set(mt.materialId, (need.get(mt.materialId) ?? 0) + mt.qtyPerUnit * i.qty);
  if (!need.size) return { ok: true, checkedAt: nowIso(), lines: [] };
  const bal = stockBalances(db);
  const lines = [...need].map(([materialId, n]) => {
    const mat = (db.materials ?? []).find((x) => x.id === materialId);
    const stock = bal.filter((b) => b.materialId === materialId && b.storeId === storeId).reduce((a, b) => a + b.qty, 0);
    return { materialId, name: mat?.name ?? materialId, need: Math.round(n * 100) / 100, stock: Math.round(stock * 100) / 100, unit: mat?.unit };
  });
  return { ok: lines.every((l) => l.stock >= l.need), checkedAt: nowIso(), lines };
}

/** 引き取りの予定・仮押さえから製造の予定を作る (db は mutate の中のもの)。製造のない作業なら undefined */
export function buildProductionJob(db: Database, user: User, src: { event?: ScheduleEvent; hold?: ScheduleHold }, now = new Date()): ProductionJob | undefined {
  const it = src.event ?? src.hold;
  if (!it || it.kind !== "pickup") return undefined;
  const m = loadMasters(db);
  const job = resolveJob(db, m, { eventId: src.event?.id, orderId: it.orderId, quoteId: it.quoteId, inquiryId: it.inquiryId, order: it.orderId ? db.orders.find((o) => o.id === it.orderId) : undefined, text: `${it.title}\n${it.memo ?? ""}` });
  if (!job.production.size) return undefined;
  const exclude = [src.event?.id, src.hold?.id].filter((x): x is string => Boolean(x));
  const ctx = createPlanContext(db, user, { now, from: it.date, to: addDays(it.date, 45), exclude, masters: m });
  const est = estimateProduction(ctx, it.storeId, job, it.date, undefined, false);
  const deliveries = db.schedule.filter((e) => e.kind === "delivery" && ((it.orderId && e.orderId === it.orderId) || (it.quoteId && e.quoteId === it.quoteId)) && e.date >= it.date).sort((a, b) => a.date.localeCompare(b.date));
  const t = nowIso();
  return {
    id: newId("pj"),
    storeId: it.storeId,
    orderId: it.orderId,
    quoteId: it.quoteId,
    customerId: it.customerId,
    title: it.title.replace(/^\[仮\]\s*/, ""),
    items: job.items.map((i) => ({ workTypeId: i.workType.id, qty: i.qty })),
    pickupEventId: src.event?.id,
    holdId: src.event ? undefined : src.hold?.id,
    deliveryEventId: deliveries[0]?.id,
    steps: est.steps.map((s) => ({ processId: s.processId, date: s.date, minutes: s.minutes, qty: s.qty, status: "planned" as const })),
    startDate: est.steps[0]?.date ?? it.date,
    endDate: est.readyDate,
    dueDate: deliveries[0]?.date ?? job.deadline,
    status: "planned",
    materialCheck: materialCheck(db, m, it.storeId, job),
    note: est.missing.length ? `作業場に工程がありません: ${est.missing.map((k) => PROCESS_KEYS.find((p) => p.key === k)?.name ?? k).join("・")}` : undefined,
    createdBy: user.id,
    createdAt: t,
    updatedBy: user.id,
    updatedAt: t,
  };
}

/** 引き取りの日が変わったときに製造の予定を作り直す (予定のままのものだけ)。戻り値は注意の文 */
export function replanProductionForPickup(db: Database, user: User, ev: ScheduleEvent, now = new Date()): string[] {
  const out: string[] = [];
  for (const j of db.productionJobs ?? []) {
    if (j.pickupEventId !== ev.id || j.status !== "planned") continue;
    const next = buildProductionJob(db, user, { event: ev }, now);
    if (!next) continue;
    const before = `${j.startDate}〜${j.endDate}`;
    Object.assign(j, { steps: next.steps, startDate: next.startDate, endDate: next.endDate, materialCheck: next.materialCheck, updatedBy: user.id, updatedAt: nowIso() });
    out.push(`製造の予定を作り直しました (${before} → ${j.startDate}〜${j.endDate})`);
    const delivery = j.deliveryEventId ? db.schedule.find((e) => e.id === j.deliveryEventId) : undefined;
    if (delivery && delivery.date <= j.endDate) out.push(`納品 (${delivery.date}) が製造の完成 (${j.endDate}) より前・同じ日です。納品の日を見直してください`);
  }
  return out;
}

/** 工程 × 日の負荷 (製造計画の画面) */
export interface ProcessLoadRow {
  processId: string;
  name: string;
  storeId: StoreId;
  days: { date: string; used: number; cap: number; estimated: number }[];
}

export function processLoads(db: Database, user: User, from: string, days = 14, now = new Date()): ProcessLoadRow[] {
  const m = loadMasters(db);
  const to = addDays(from, days - 1);
  const ctx = createPlanContext(db, user, { now, from, to, masters: m });
  // 登録済みの製造の予定だけの分 (見込みとの差を出すため)
  const registered = new Map<string, number>();
  for (const j of db.productionJobs ?? []) {
    if (j.status === "cancelled" || j.status === "done") continue;
    for (const s of j.steps) if (s.status !== "done") registered.set(`${s.processId}|${s.date}`, (registered.get(`${s.processId}|${s.date}`) ?? 0) + s.minutes);
  }
  const dates = dateRange(from, to, 62);
  return m.processes
    .filter((p) => p.active)
    .map((p) => ({
      processId: p.id,
      name: p.name,
      storeId: p.storeId,
      days: dates.map((d) => {
        const used = ctx.production.get(`${p.id}|${d}`) ?? 0;
        return { date: d, used, cap: ctx.processCapacity(p, d), estimated: Math.max(0, used - (registered.get(`${p.id}|${d}`) ?? 0)) };
      }),
    }));
}

export const todayKey = (now = new Date()) => toDateKey(now);
