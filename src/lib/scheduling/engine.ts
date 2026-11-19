import "server-only";
import type { ScheduleKind, StoreId, User } from "@/lib/db/types";
import { SCHEDULE_KIND } from "@/lib/constants";
import { addDays, daysBetween } from "@/lib/format";
import { dateRange, dayOfWeek, fromMinutes, monthEnd, monthStart, shortDate, toMinutes } from "@/lib/calendar";
import { roadKm, type GeoPoint } from "@/lib/geo/kumamoto";
import { JOB_KINDS, VISIT_KINDS, type DayLoad } from "@/lib/schedule-capacity";
import type { Resource, StaffProfile } from "./masters";
import { estimateProduction, itemMinutes, type PlanContext, type PlanItem } from "./context";
import type { ResolvedJob } from "./spec";

/**
 * 1 件の予定の候補を、日 × 時間帯ごとに評価する (候補日の提案と全体の最適化で共通)
 * ------------------------------------------------------------
 * 守ること (満たさない日は候補にしない):
 *  休業日・店舗の 1 日の上限・担当者の空き (休暇・終日の予定・件数・時間の隙間・移動)・
 *  社員の勤務 (勤務日・時間・1 日の最大作業時間・連続勤務・月の残業の上限。設定した社員のみ)・
 *  技能 (必要な技能を一人前以上が持つ。見習いは熟練者と一緒)・同行が必要な人・運転・
 *  車両と設備の空き (登録した店舗のみ)・製造 (期限までに完成するか)・お客様の都合の悪い日・希望 (必ず のとき)・期限
 * 比べること (0〜100 点。重みは 設定 → 最適化の重み):
 *  移動・店舗の空き・製造の空き・担当者の負担・早さ・経験と熟練度・お客様の希望・期限と優先度 − 応援・残業
 */

export type SuggestSlot = "am" | "pm" | "day";

export interface JobRequest {
  key: string;
  storeId: StoreId;
  kind: ScheduleKind;
  title: string;
  durationDays: number;
  slots: SuggestSlot[];
  minutes: number;
  staffCount: number;
  /** 担当者を決めている */
  fixed: User[];
  site?: GeoPoint;
  job: ResolvedJob;
  earliest: string;
  latest: string;
  /** 納品: 引き取りの日 (早い日を強く優先) */
  afterPickup?: string;
  /** 引き取りで製造があるか */
  production: boolean;
  orderId?: string;
  quoteId?: string;
  inquiryId?: string;
  customerId?: string;
  location?: string;
  /** 再配置: 元の日 (動かすと減点) */
  movedFrom?: string;
}

export interface Candidate {
  date: string;
  slot?: SuggestSlot;
  assigneeIds: string[];
  score: number;
  reasons: string[];
  warnings: string[];
  endDate?: string;
  startTime?: string;
  endTime?: string;
  assigneeNames?: string[];
  travelMin?: number;
  distanceKm?: number;
  nearby?: { title: string; place: string; km: number; mine: boolean }[];
  load?: { jobs: number; jobsCap: number; visits: number; visitsCap: number; tatami: number; tatamiCap: number };
  breakdown?: Record<"route" | "capacity" | "production" | "staff" | "earliness" | "experience", number>;
  /** 以下は計画で追加した項目 */
  resourceIds?: string[];
  resourceNames?: string[];
  /** 製造が終わる日 (引き取りのとき) */
  readyDate?: string;
  productionSteps?: { processId: string; processKey: string; date: string; minutes: number; qty: number }[];
  /** 移動時間の求め方 */
  travelSource?: "local" | "google";
  overtimeMin?: number;
  helped?: boolean;
  preference?: "match" | "near" | "off" | "none";
  lateDays?: number;
}

export interface EvalResult {
  candidates: Candidate[];
  rejected: Record<"closed" | "full" | "noStaff" | "noResource" | "production" | "preference" | "deadline", number>;
  /** 担当者が入れなかった主な理由 (人ごと) */
  staffReasons: Map<string, string>;
  missingProcesses: string[];
  unregisteredResources: string[];
  skillsEnforced: boolean;
}

const STEP = 15;
const UNKNOWN_TRAVEL = 20;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const roundUp = (m: number) => Math.ceil(m / STEP) * STEP;

interface Busy {
  timed: [number, number][];
  flex: number;
  flexCount: number;
  blocked?: string;
  count: number;
  /** その日の作業時間 (移動を含む目安) */
  minutes: number;
  sites: { it: PlanItem; geo: GeoPoint }[];
}

interface PersonEval {
  u: User;
  p: StaffProfile & { configured: boolean };
  ok: boolean;
  why?: string;
  start: number | null;
  timedOnly: boolean;
  busy: Busy;
  near?: { s: { it: PlanItem; geo: GeoPoint }; t: number };
  count: number;
  overtime: number;
}

const isCase = (k: ScheduleKind) => SCHEDULE_KIND[k]?.group === "case";

/** その人のその日の予定 (時刻の決まったもの・時刻未定・終日) */
function busyOf(ctx: PlanContext, uid: string, day: string, win: [number, number], travelTo: (p?: GeoPoint) => number): Busy {
  const items = ctx.byPersonDay.get(`${uid}|${day}`) ?? [];
  const b: Busy = { timed: [], flex: 0, flexCount: 0, count: 0, minutes: 0, sites: [] };
  for (const it of items) {
    const caseKind = isCase(it.kind);
    if (caseKind || it.kind === "meeting" || it.kind === "other" || it.kind === "gathering") b.count++;
    const geo = caseKind ? ctx.geoOf(it) : undefined;
    if (geo) b.sites.push({ it, geo });
    const buffer = caseKind ? travelTo(geo) : 15;
    if (it.kind === "leave" && !it.startTime) {
      b.blocked = "休暇・不在";
      continue;
    }
    if (it.startTime) {
      const s = toMinutes(it.startTime);
      const end = it.endTime ? toMinutes(it.endTime) : s + (SCHEDULE_KIND[it.kind]?.minutes || 60);
      if (it.kind !== "leave") b.minutes += end - s + (caseKind ? buffer : 0);
      if (end + buffer > win[0] && s - buffer < win[1]) b.timed.push([s - buffer, end + buffer]);
      continue;
    }
    if (it.slot) {
      const half: [number, number] = it.slot === "am" ? [0, 720] : [720, 1440];
      const mins = itemMinutes(it) + buffer;
      b.minutes += mins;
      if (half[1] > win[0] && half[0] < win[1]) {
        b.flex += mins;
        b.flexCount++;
      }
      continue;
    }
    if (caseKind && it.kind !== "install") {
      const mins = itemMinutes(it) + buffer;
      b.minutes += mins;
      b.flex += mins;
      b.flexCount++;
    } else {
      b.minutes += 480;
      b.blocked = `終日の予定 (${SCHEDULE_KIND[it.kind]?.label ?? "予定"})`;
    }
  }
  return b;
}

/** 連続して勤務する日数 (その日を入れたとき) */
function streakWith(ctx: PlanContext, uid: string, day: string, limit: number): number {
  const worked = (d: string) => (ctx.byPersonDay.get(`${uid}|${d}`) ?? []).some((it) => it.kind !== "leave");
  let n = 1;
  for (let i = 1; i <= limit && worked(addDays(day, -i)); i++) n++;
  for (let i = 1; i <= limit && worked(addDays(day, i)); i++) n++;
  return n;
}

/** その月の残業の見込み (分。所定の時間を超えた分の合計) */
function monthOvertime(ctx: PlanContext, uid: string, day: string, standard: number, cache: Map<string, number>): number {
  const key = `${uid}|${day.slice(0, 7)}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let total = 0;
  for (const d of dateRange(monthStart(day), monthEnd(day), 31)) {
    const items = ctx.byPersonDay.get(`${uid}|${d}`) ?? [];
    if (!items.length) continue;
    let mins = 0;
    for (const it of items) if (it.kind !== "leave") mins += itemMinutes(it) + (isCase(it.kind) ? UNKNOWN_TRAVEL : 0);
    total += Math.max(0, mins - standard);
  }
  cache.set(key, total);
  return total;
}

/** 車両・設備がその時間帯に空いているか */
function resourceFree(ctx: PlanContext, r: Resource, days: string[], slot: SuggestSlot, startMin: number | null, minutes: number): boolean {
  for (const d of days) {
    for (const u of ctx.resourceDay.get(`${r.id}|${d}`) ?? []) {
      if (u.item && ctx.excluded.has(u.item.id)) continue;
      if (u.startTime && startMin !== null) {
        const s = toMinutes(u.startTime);
        const e = u.endTime ? toMinutes(u.endTime) : s + 60;
        if (startMin < e + 15 && startMin + minutes + 15 > s) return false;
        continue;
      }
      if (u.slot && slot !== "day" && u.slot !== slot) continue;
      return false;
    }
  }
  return true;
}

export function evaluateJob(ctx: PlanContext, req: JobRequest): EvalResult {
  const { db, m } = ctx;
  const cap = ctx.capOf(req.storeId);
  const isJob = JOB_KINDS.includes(req.kind);
  const isVisit = VISIT_KINDS.includes(req.kind);
  const store = db.stores.find((s) => s.id === req.storeId)!;
  const base = ctx.baseOf(req.storeId);
  const site = req.site;
  const w = m.weights;
  const rules = m.rules;
  const job = req.job;
  const result: EvalResult = {
    candidates: [],
    rejected: { closed: 0, full: 0, noStaff: 0, noResource: 0, production: 0, preference: 0, deadline: 0 },
    staffReasons: new Map(),
    missingProcesses: [],
    unregisteredResources: [],
    skillsEnforced: false,
  };

  const travelOf = (p: GeoPoint | undefined, departMin?: number) => (site && p ? ctx.travel(p, site, departMin) : undefined);
  const travelTo = (p?: GeoPoint) => travelOf(p)?.minutes ?? UNKNOWN_TRAVEL;
  const baseT = travelOf(base, toMinutes(cap.workStart));
  const baseTravel = baseT?.minutes ?? UNKNOWN_TRAVEL;
  const baseKm = baseT?.km;

  /* ---- 担当者の候補 ---- */
  const exp = (uid: string) => {
    const x = ctx.stats.experience.get(uid);
    return x ? (isVisit ? x.visit : x.job) : 0;
  };
  const anyConfigured = m.profiles.size > 0;
  const field = (u: User) => {
    const p = ctx.profile(u);
    if (p.configured) return p.fieldWork;
    return u.role === "store_staff" || u.role === "store_manager" || exp(u.id) > 0;
  };
  const own = req.fixed.length ? req.fixed : db.users.filter((u) => u.active && u.storeId === req.storeId && field(u));
  const helpers = req.fixed.length
    ? []
    : db.users.filter((u) => {
        if (!u.active || u.storeId === req.storeId || u.storeId === "hq") return false;
        const p = ctx.profile(u);
        if (p.configured) return p.fieldWork && p.supportStores.includes(req.storeId);
        return (u.role === "store_staff" || u.role === "store_manager") && exp(u.id) > 0;
      });
  const maxExp = Math.max(1, ...[...own, ...helpers].map((u) => exp(u.id)));
  const required = isVisit ? (m.skills.some((s) => s.id === "survey") ? ["survey"] : []) : job.skills;
  result.skillsEnforced = anyConfigured && required.length > 0;
  const levelOf = (pe: PersonEval, skill: string) => pe.p.skills[skill] ?? 0;
  const skillFit = (pe: PersonEval) => (required.length ? required.reduce((a, s) => a + levelOf(pe, s), 0) / (3 * required.length) : 0.5);
  const roleFit = (u: User): number => {
    if (isJob) return /施工|職人/.test(u.title) ? 1 : u.role === "store_staff" ? 0.8 : u.role === "store_manager" ? 0.6 : 0.3;
    return /営業|店長/.test(u.title) || u.role === "store_manager" ? 1 : u.role === "admin" ? 0.8 : 0.5;
  };
  const kindLabel = isJob ? "現場作業" : "営業の訪問";
  const storeShort = (id: StoreId) => db.stores.find((s) => s.id === id)?.shortName ?? id;
  const userName = (id: string) => db.users.find((u) => u.id === id)?.name ?? id;

  /* ---- 車両・設備 ---- */
  const needTypes = job.resourceKinds.filter((t) => m.resources.some((r) => r.active && r.type === t));
  for (const t of job.resourceKinds) if (!m.resources.some((r) => r.active && r.type === t && r.storeId === req.storeId)) result.unregisteredResources.push(t);
  const ownTypes = needTypes.filter((t) => m.resources.some((r) => r.active && r.type === t && r.storeId === req.storeId));
  const needsVehicle = ownTypes.some((t) => m.resources.some((r) => r.type === t && r.kind === "vehicle"));

  /* ---- 製造の工程がない ---- */
  if (req.production) for (const it of job.items) for (const p of it.workType.processes) if (!ctx.processFor(req.storeId, p.processKey) && !result.missingProcesses.includes(p.processKey)) result.missingProcesses.push(p.processKey);

  const ws = toMinutes(cap.workStart);
  const we = toMinutes(cap.workEnd);
  const windowOf = (slot: SuggestSlot): [number, number] => (slot === "am" ? [ws, Math.max(ws + 60, 720)] : slot === "pm" ? [Math.min(780, we - 60), we] : [ws, we]);
  const otCache = new Map<string, number>();
  const capJobs = isJob ? cap.jobsPerDay : cap.visitsPerDay;
  const zero: DayLoad = { jobs: 0, visits: 0, tatami: 0 };
  const allDays = dateRange(req.earliest, req.latest, 62);
  const span = Math.max(1, allDays.length);
  const prioMult = job.priority === "urgent" ? 2 : job.priority === "high" ? 1.4 : job.priority === "low" ? 0.6 : 1;
  const prefActive = job.strength !== "none" && (job.preferredDates.length > 0 || job.preferredWeekdays.length > 0 || Boolean(job.preferredSlot));
  const preferredTime = job.preferredTime ? toMinutes(job.preferredTime) : undefined;

  for (const [i, day] of allDays.entries()) {
    const days = dateRange(day, addDays(day, req.durationDays - 1), 10);
    if (days.some((d) => ctx.isClosed(req.storeId, d))) {
      result.rejected.closed++;
      continue;
    }
    // お客様の都合の悪い日・希望 (必ず)
    if (days.some((d) => job.avoidDates.includes(d))) {
      result.rejected.preference++;
      continue;
    }
    const dateHit = job.preferredDates.includes(day);
    const wdHit = job.preferredWeekdays.includes(dayOfWeek(day));
    if (job.strength === "hard" && ((job.preferredDates.length && !dateHit) || (!job.preferredDates.length && job.preferredWeekdays.length && !wdHit))) {
      result.rejected.preference++;
      continue;
    }
    const dayLoads = days.map((d) => ctx.loads.get(`${req.storeId}|${d}`) ?? zero);
    const used = Math.max(...dayLoads.map((l) => (isJob ? l.jobs : l.visits)));
    const pickupUnits = dayLoads[0].tatami;
    const units = job.units.tatami;
    const overPickup = req.production && units > 0 && pickupUnits + units > cap.tatamiPerDay && !(pickupUnits === 0 && units > cap.tatamiPerDay);
    if (used + 1 > capJobs || overPickup) {
      result.rejected.full++;
      continue;
    }
    // 製造 (引き取りのとき): 完成の日と期限
    let prod: ReturnType<typeof estimateProduction> | undefined;
    if (req.production && job.production.size) {
      prod = estimateProduction(ctx, req.storeId, job, day, undefined, false);
      const deliverable = addDays(prod.readyDate, rules.deliveryGapDays);
      if (job.deadline && deliverable > job.deadline) {
        result.rejected.production++;
        continue;
      }
    }
    // 期限 (納品・施工・そのほか)
    const lastWorkDay = days[days.length - 1];
    if (!req.production && job.deadline && lastWorkDay > job.deadline && (req.kind === "delivery" || req.kind === "install")) {
      result.rejected.deadline++;
      continue;
    }

    let best: Candidate | undefined;
    for (const slot of req.slots) {
      if (job.strength === "hard" && job.preferredSlot && job.preferredSlot !== "day" && slot !== "day" && slot !== job.preferredSlot) continue;
      const win = windowOf(slot);
      const startMin = slot === "pm" ? win[0] : win[0] + Math.min(baseTravel, 60);

      const evalPerson = (u: User): PersonEval => {
        const p = ctx.profile(u);
        let pwin: [number, number] = win;
        if (p.configured && (p.workStart || p.workEnd)) pwin = [Math.max(win[0], p.workStart ? toMinutes(p.workStart) : win[0]), Math.min(win[1], p.workEnd ? toMinutes(p.workEnd) : win[1])];
        const busies = days.map((d) => busyOf(ctx, u.id, d, pwin, travelTo));
        const first = busies[0];
        const near = first.sites.map((s) => ({ s, t: travelTo(s.geo) })).sort((a, b) => a.t - b.t)[0];
        const pe: PersonEval = { u, p, ok: true, start: null, timedOnly: true, busy: first, near, count: Math.max(...busies.map((b) => b.count)), overtime: 0 };
        const fail = (why: string) => {
          pe.ok = false;
          pe.why = why;
          return pe;
        };
        const standard = (p.workEnd && p.workStart ? toMinutes(p.workEnd) - toMinutes(p.workStart) : we - ws) - p.breakMinutes;
        for (const [di, d] of days.entries()) {
          const b = busies[di];
          if (p.configured && !p.workDays.includes(dayOfWeek(d))) return fail("勤務日ではありません");
          if (b.blocked) return fail(b.blocked);
          const maxEvents = (p.configured ? p.maxEventsPerDay : undefined) ?? cap.staffEventsPerDay;
          if (b.count >= maxEvents) return fail(`予定が ${b.count} 件 (1 日の上限)`);
          if (slot === "day" && b.flexCount) return fail("時刻未定の予定あり");
          const busyMin = b.timed.reduce((a, [s, e]) => a + Math.max(0, Math.min(e, pwin[1]) - Math.max(s, pwin[0])), 0);
          if (pwin[1] - pwin[0] - busyMin - b.flex < req.minutes) return fail("時間の空きなし");
          let found: number | null = null;
          const tryAt = (t: number) => t + req.minutes <= pwin[1] && b.timed.every(([s, e]) => t + req.minutes <= s || t >= e);
          if (preferredTime !== undefined && preferredTime >= pwin[0] && tryAt(roundUp(preferredTime))) found = roundUp(preferredTime);
          for (let t = roundUp(Math.max(startMin, pwin[0])); found === null && t + req.minutes <= pwin[1]; t += STEP) if (tryAt(t)) found = t;
          if (found === null) return fail("時間の空きなし");
          if (di === 0) pe.start = b.flexCount ? null : found;
          if (b.flexCount) pe.timedOnly = false;
          const dayTotal = b.minutes + req.minutes + travelTo(near?.s.geo ?? base);
          if (p.configured) {
            if (dayTotal > p.maxMinutesPerDay) return fail(`1 日の作業時間の上限 (${Math.round(p.maxMinutesPerDay / 60)} 時間) を超えます`);
            const ot = Math.max(0, dayTotal - standard);
            if (ot > 0 && monthOvertime(ctx, u.id, d, standard, otCache) + ot > p.overtimeCapMonthly) return fail("今月の残業の上限に達します");
            pe.overtime = Math.max(pe.overtime, ot);
            if (streakWith(ctx, u.id, d, p.maxConsecutiveDays + 1) > p.maxConsecutiveDays) return fail(`連続勤務が ${p.maxConsecutiveDays} 日を超えます`);
          } else pe.overtime = Math.max(pe.overtime, Math.max(0, dayTotal - standard));
        }
        return pe;
      };
      const personScore = (pe: PersonEval) =>
        0.3 * (1 - pe.count / cap.staffEventsPerDay) + 0.25 * (site ? clamp01(1 - ((pe.near?.t ?? baseTravel) - 5) / 45) : 0.5) + 0.15 * (exp(pe.u.id) / maxExp) + 0.15 * roleFit(pe.u) + 0.15 * skillFit(pe);

      /* ---- 担当の組み合わせ ---- */
      let team: PersonEval[] = [];
      let helped = false;
      const skillWarnings: string[] = [];
      if (req.fixed.length) {
        team = req.fixed.map(evalPerson);
        const bad = team.find((x) => !x.ok);
        if (bad) {
          result.staffReasons.set(bad.u.id, bad.why ?? "");
          continue;
        }
      } else {
        const ownPool = own.map(evalPerson);
        for (const x of ownPool) if (!x.ok && x.why) result.staffReasons.set(x.u.id, x.why);
        let pool = ownPool.filter((x) => x.ok).sort((a, b) => personScore(b) - personScore(a));
        const helperPool = () => helpers.map(evalPerson).filter((x) => x.ok).sort((a, b) => personScore(b) - personScore(a));
        const build = (cands: PersonEval[]): PersonEval[] | undefined => {
          const t: PersonEval[] = [];
          const has = (x: PersonEval) => t.some((y) => y.u.id === x.u.id);
          // ① 技能 (設定があるとき): 一人前以上がいるか、見習い + 熟練
          if (result.skillsEnforced) {
            for (const s of required) {
              if (t.some((x) => levelOf(x, s) >= 2)) continue;
              const pick = cands.find((x) => !has(x) && levelOf(x, s) >= 2);
              if (pick) t.push(pick);
              else return undefined;
            }
          }
          // ② 人数
          for (const x of cands) {
            if (t.length >= req.staffCount) break;
            if (!has(x)) t.push(x);
          }
          if (t.length < req.staffCount) return undefined;
          // ③ 同行が必要な人
          for (const x of [...t]) {
            if (!x.p.configured || !x.p.needsCompanion) continue;
            const mentorOk = (y: PersonEval) => y.u.id !== x.u.id && (x.p.mentorIds.length ? x.p.mentorIds.includes(y.u.id) : Object.values(y.p.skills).some((lv) => lv >= 3));
            if (t.some(mentorOk)) continue;
            const mentor = cands.find((y) => !has(y) && mentorOk(y));
            if (!mentor) return undefined;
            t.push(mentor);
          }
          // ④ 運転 (車両が必要で、運転の設定があるとき)
          if (needsVehicle && anyConfigured && !t.some((x) => x.p.canDrive)) {
            const driver = cands.find((x) => !has(x) && x.p.canDrive);
            if (!driver) return undefined;
            t.push(driver);
          }
          return t.slice(0, 6);
        };
        let built = build(pool);
        if (!built) {
          const extra = helperPool();
          pool = [...pool, ...extra];
          built = build(pool);
          helped = Boolean(built?.some((x) => x.u.storeId !== req.storeId));
        }
        if (!built) continue;
        team = built;
      }
      if (result.skillsEnforced) for (const s of required) if (!team.some((x) => levelOf(x, s) >= 2)) skillWarnings.push(`「${m.skills.find((k) => k.id === s)?.name ?? s}」が一人前の担当者がいません`);

      /* ---- 時刻 ---- */
      let startTime: string | undefined;
      let endTime: string | undefined;
      let startAt: number | null = null;
      if (team.every((x) => x.timedOnly)) {
        const firstTry = preferredTime !== undefined && team.every((x) => x.start === roundUp(preferredTime)) ? roundUp(preferredTime) : roundUp(Math.max(startMin, ...team.map((x) => x.start ?? startMin)));
        let t = firstTry;
        for (; t + req.minutes <= win[1]; t += STEP) if (team.every((x) => days.every((d) => busyOf(ctx, x.u.id, d, win, travelTo).timed.every(([s, e]) => t + req.minutes <= s || t >= e)))) break;
        if (t + req.minutes <= win[1]) {
          startAt = t;
          startTime = fromMinutes(t);
          endTime = fromMinutes(t + req.minutes);
        } else if (slot === "day") continue;
      }

      /* ---- 車両・設備 ---- */
      const resourceIds: string[] = [];
      const resourceWarnings: string[] = [];
      let resourceOk = true;
      for (const t of ownTypes) {
        const list = m.resources.filter((r) => r.active && r.type === t && r.storeId === req.storeId).sort((a, b) => (b.capacityUnits ?? 9999) - (a.capacityUnits ?? 9999));
        const free = list.filter((r) => resourceFree(ctx, r, days, slot, startAt, req.minutes));
        if (!free.length) {
          resourceOk = false;
          break;
        }
        const fit = free.find((r) => !r.capacityUnits || r.capacityUnits >= job.totalUnits) ?? free[0];
        if (fit.capacityUnits && job.totalUnits > fit.capacityUnits) resourceWarnings.push(`${fit.name} に積めるのは ${fit.capacityUnits} 枚までです (${job.totalUnits} 枚。2 回に分けるか、ほかの車両を使ってください)`);
        resourceIds.push(fit.id);
      }
      if (!resourceOk) {
        result.rejected.noResource++;
        continue;
      }

      /* ---- 点数 ---- */
      const nearest = team.map((x) => x.near).filter(Boolean).sort((a, b) => a!.t - b!.t)[0];
      const travel = Math.min(nearest?.t ?? Infinity, baseTravel);
      const nearbyStore = (ctx.byStoreDay.get(`${req.storeId}|${day}`) ?? [])
        .filter((it) => isCase(it.kind) && it.id !== req.key)
        .map((it) => ({ it, geo: ctx.geoOf(it) }))
        .filter((x): x is { it: PlanItem; geo: GeoPoint } => Boolean(x.geo && site))
        .map((x) => ({ title: x.it.title, place: x.geo.label, km: Math.round(roadKm(x.geo, site!) * 10) / 10, mine: team.some((p) => x.it.assigneeIds.includes(p.u.id)) }))
        .filter((x) => x.km <= 12)
        .sort((a, b) => a.km - b.km)
        .slice(0, 3);
      const storeNear = nearbyStore.find((x) => !x.mine);
      const storeTravel = storeNear && site ? Math.round((storeNear.km / Math.max(10, cap.travelSpeedKmh)) * 60 + 5) : Infinity;
      const route = site ? Math.max(clamp01(1 - (travel - 5) / 45), 0.6 * clamp01(1 - (storeTravel - 5) / 45)) : 0.5;
      const capacityScore = clamp01(1 - used / capJobs);
      const productionScore = prod ? clamp01(1 - Math.max(0, prod.spanDays - Math.max(1, job.leadDays)) / 5) * 0.6 + 0.4 * clamp01(1 - pickupUnits / cap.tatamiPerDay) : 1;
      const staffScore = clamp01(1 - team.reduce((a, x) => a + x.count, 0) / team.length / cap.staffEventsPerDay);
      const earliness = clamp01(1 - i / Math.max(span, 7));
      const experience = clamp01(team.reduce((a, x) => a + 0.6 * (exp(x.u.id) / maxExp) + 0.4 * skillFit(x), 0) / team.length);
      let preference = 0.5;
      let prefKind: Candidate["preference"] = "none";
      if (prefActive) {
        const dist = job.preferredDates.length ? Math.min(...job.preferredDates.map((d) => Math.abs(daysBetween(d, day)))) : Infinity;
        const slotOk = !job.preferredSlot || job.preferredSlot === "day" || slot === "day" || slot === job.preferredSlot;
        if (dateHit || (!job.preferredDates.length && wdHit)) preference = slotOk ? 1 : 0.7;
        else if (dist <= rules.preferenceToleranceDays) preference = 0.6 * (1 - dist / (rules.preferenceToleranceDays + 1)) + (wdHit ? 0.2 : 0);
        else preference = wdHit ? 0.4 : 0;
        prefKind = preference >= 0.7 ? "match" : preference > 0.2 ? "near" : "off";
      }
      const deadlineDay = prod ? addDays(prod.readyDate, rules.deliveryGapDays) : lastWorkDay;
      const deadlineScore = job.deadline ? clamp01(daysBetween(deadlineDay, job.deadline) / 7) : 1;
      const overtime = Math.max(...team.map((x) => x.overtime));
      const wt = {
        route: w.route,
        capacity: w.capacity,
        production: prod ? w.production : 0,
        staff: w.staff,
        earliness: w.earliness * prioMult * (req.afterPickup ? 2.5 : 1),
        experience: w.experience,
        preference: prefActive ? w.preference : 0,
        deadline: job.deadline ? w.deadline * prioMult : 0,
      };
      const sumW = Object.values(wt).reduce((a, b) => a + b, 0) || 1;
      let score = (wt.route * route + wt.capacity * capacityScore + wt.production * productionScore + wt.staff * staffScore + wt.earliness * earliness + wt.experience * experience + wt.preference * preference + wt.deadline * deadlineScore) / sumW;
      if (helped) score -= w.help;
      if (overtime > 0) score -= Math.min(0.15, (overtime / 120) * w.overtime);
      if (startTime === undefined && slot !== "day") score -= 0.02;
      if (req.movedFrom && req.movedFrom !== day) score -= w.move;

      /* ---- 理由と注意 ---- */
      const reasons: string[] = [];
      const warnings: string[] = [...skillWarnings, ...resourceWarnings];
      const near = nearest && nearest.t <= baseTravel ? nearest : undefined;
      const tSource = site ? (near ? ctx.travel(near.s.geo, site).source : baseT?.source) : undefined;
      const how = tSource === "google" ? "道路の経路" : "目安";
      if (site && near && near.t <= 25) reasons.push(`同じ日に担当者が近くの現場「${near.s.it.title}」(${near.s.geo.label}) を回ります (約 ${Math.round(roadKm(near.s.geo, site) * 10) / 10} km・移動 ${near.t} 分の${how})`);
      else if (site && storeNear && (baseKm === undefined || storeNear.km < baseKm - 1)) reasons.push(`同じ日に${store.shortName}の別の予定「${storeNear.title}」が近く (${storeNear.place}・約 ${storeNear.km} km) にあります (担当を合わせると移動が減ります)`);
      else if (site && baseKm !== undefined) reasons.push(`${store.shortName}から約 ${baseKm} km (移動 ${baseTravel} 分の${how})`);
      reasons.push(`${storeShort(req.storeId)}のこの日の${kindLabel}: ${used} 件 → ${used + 1} 件 (上限 ${capJobs} 件)`);
      if (req.production && units > 0) reasons.push(`引き取る畳: ${pickupUnits} 枚 → ${pickupUnits + units} 枚 (上限 ${cap.tatamiPerDay} 枚)`);
      if (prod) reasons.push(`製造: ${shortDate(prod.readyDate)} に完成の見込み (${prod.steps.length ? [...new Set(prod.steps.map((s) => shortDate(s.date)))].join("・") + " に製造" : "製造なし"})`);
      reasons.push(`担当: ${team.map((x) => `${x.u.name} (この日の予定 ${x.count} 件)`).join("・")}`);
      if (resourceIds.length) reasons.push(`車両・設備: ${resourceIds.map((id) => m.resources.find((r) => r.id === id)?.name ?? id).join("・")}`);
      if (req.afterPickup) reasons.push(`引き取り (${shortDate(req.afterPickup)}) から ${daysBetween(req.afterPickup, day)} 日後の納品${daysBetween(req.afterPickup, day) <= 1 ? " (翌日)" : ""}`);
      else if (i === 0) reasons.push("探した期間で最も早い日です");
      if (prefKind === "match") reasons.push("お客様の希望の日時です");
      else if (prefKind === "near") reasons.push("お客様の希望の日に近い日です");
      if (job.deadline) reasons.push(`期限 ${shortDate(job.deadline)} まで ${daysBetween(deadlineDay, job.deadline)} 日の余裕`);
      const expert = team.filter((x) => exp(x.u.id) >= 20);
      if (expert.length) reasons.push(`${expert.map((x) => `${x.u.name} は過去 1 年に${kindLabel}を ${exp(x.u.id)} 件担当`).join("・")}`);

      if (helped) warnings.push(`${team.filter((x) => x.u.storeId !== req.storeId).map((x) => `${x.u.name} (${storeShort(x.u.storeId)})`).join("・")} の応援が必要です`);
      for (const x of team) if (x.count + 1 >= cap.staffEventsPerDay) warnings.push(`${x.u.name}はこの日の予定が多め (${x.count + 1} 件。1 日の目安 ${cap.staffEventsPerDay} 件)`);
      if (overtime > 0) warnings.push(`残業の見込み 約 ${Math.round(overtime / 15) * 15} 分 (${team.filter((x) => x.overtime > 0).map((x) => x.u.name).join("・")})`);
      if (used + 1 >= capJobs) warnings.push("この日の店舗の予定は上限に達します");
      if (req.production && units > 0 && pickupUnits + units > cap.tatamiPerDay * 0.85) warnings.push(pickupUnits === 0 && units > cap.tatamiPerDay ? `畳 ${units} 枚は 1 日の上限 (${cap.tatamiPerDay} 枚) を超えます。分けて引き取るか、製造の日程を確認してください` : "引き取る畳が上限に近くなります");
      if (prod && prod.spanDays > Math.max(1, job.leadDays) + 1) warnings.push(`製造が混んでいるため、完成は引き取りの ${prod.spanDays} 日後の見込みです`);
      if (startTime === undefined && slot !== "day") warnings.push("担当者に時刻未定の予定があるため、時刻は担当者と決めてください");
      if (!site) warnings.push("場所が分からないため、移動の距離は比べていません");
      if (prefActive && prefKind === "off") warnings.push("お客様の希望の日から離れています");
      if (req.movedFrom && req.movedFrom !== day) warnings.push(`元の日 (${shortDate(req.movedFrom)}) から動かします。お客様・担当者への連絡が必要です`);

      const cand: Candidate = {
        date: day,
        endDate: req.durationDays > 1 ? days[days.length - 1] : undefined,
        slot,
        startTime,
        endTime,
        assigneeIds: team.map((x) => x.u.id),
        assigneeNames: team.map((x) => x.u.name),
        score: Math.max(0, Math.min(100, Math.round(score * 100))),
        reasons,
        warnings,
        travelMin: site ? travel : undefined,
        distanceKm: site && near ? Math.round(roadKm(near.s.geo, site) * 10) / 10 : baseKm,
        nearby: nearbyStore,
        load: { jobs: dayLoads[0].jobs, jobsCap: cap.jobsPerDay, visits: dayLoads[0].visits, visitsCap: cap.visitsPerDay, tatami: pickupUnits, tatamiCap: cap.tatamiPerDay },
        breakdown: { route, capacity: capacityScore, production: productionScore, staff: staffScore, earliness, experience },
        resourceIds,
        resourceNames: resourceIds.map((id) => m.resources.find((r) => r.id === id)?.name ?? id),
        readyDate: prod?.readyDate,
        productionSteps: prod?.steps,
        travelSource: tSource,
        overtimeMin: overtime || undefined,
        helped: helped || undefined,
        preference: prefKind,
        lateDays: job.deadline ? Math.max(0, daysBetween(job.deadline, deadlineDay)) : undefined,
      };
      result.candidates.push(cand);
      if (!best || cand.score > best.score) best = cand;
    }
    if (!best) result.rejected.noStaff++;
  }
  for (const [uid, why] of result.staffReasons) result.staffReasons.set(uid, `${userName(uid)}: ${why}`);
  return result;
}

/** 候補を選ぶ: 点数の高い順。まず違う日を 1 件ずつ、日が足りないときだけ同じ日の別の時間帯 */
export function pickDiverse<T extends { date: string; score: number }>(all: T[], limit: number): T[] {
  const sorted = [...all].sort((a, b) => b.score - a.score || a.date.localeCompare(b.date));
  const out: T[] = [];
  const days = new Set<string>();
  for (const c of sorted) {
    if (out.length >= limit) break;
    if (days.has(c.date)) continue;
    days.add(c.date);
    out.push(c);
  }
  for (const c of sorted) {
    if (out.length >= limit) break;
    if (!out.includes(c)) out.push(c);
  }
  return out.sort((a, b) => b.score - a.score || a.date.localeCompare(b.date));
}

/** 候補を計画中の予定として索引に入れる (全体の最適化で使う) */
export function placeCandidate(ctx: PlanContext, req: JobRequest, c: Candidate): PlanItem {
  const it: PlanItem = {
    id: req.key,
    origin: "plan",
    kind: req.kind,
    storeId: req.storeId,
    title: req.title,
    date: c.date,
    endDate: c.endDate,
    startTime: c.startTime,
    endTime: c.endTime,
    slot: c.slot === "am" || c.slot === "pm" ? c.slot : undefined,
    assigneeIds: c.assigneeIds,
    resourceIds: c.resourceIds ?? [],
    location: req.location,
    orderId: req.orderId,
    quoteId: req.quoteId,
    inquiryId: req.inquiryId,
    customerId: req.customerId,
    minutes: req.minutes,
    geo: req.site,
    units: req.job.units.tatami,
  };
  ctx.add(it);
  if (req.production && req.job.production.size) estimateProduction(ctx, req.storeId, req.job, c.date, it.id, true);
  return it;
}
