import type { Database, ScheduleEvent, ScheduleKind, StoreId } from "@/lib/db/types";
import { addDays, toDateKey } from "@/lib/format";
import { dayOfWeek, eventDays, isDateKey, normTime, toMinutes } from "@/lib/calendar";

/**
 * 店舗の 1 日の仕事量の上限 (予定の候補日の提案に使う)
 * ------------------------------------------------------------
 * - 現場作業 (引き取り・納品・施工・採寸) の件数、営業 (現地調査・顧客訪問) の件数、畳の製造 (引き取った畳の枚数) の 3 つ
 * - 設定 (settings の id = schedule_capacity) があればその値、なければ過去 1 年の予定表から自動で決める
 *   (予定のあった日の多い方から 10% の日の件数 = 混んでいる日の目安。少なすぎる値にならないよう下限あり)
 * - 畳の枚数は予定の件名・メモの「畳 表替え6」「畳 新調12」のような書き方から読む (予定表の書き方)
 * - 休業日は「休日カレンダー」(holidays)。カレンダーの登録がない先の日付は日曜を休みとみなす
 */

export const SCHEDULE_CAPACITY_ID = "schedule_capacity";

/** 現場作業 (店舗の作業の手を使う予定) */
export const JOB_KINDS: ScheduleKind[] = ["pickup", "delivery", "install", "measure"];
/** 営業の訪問 */
export const VISIT_KINDS: ScheduleKind[] = ["survey", "site_survey", "onsite_quote", "visit"];
/** 候補日を提案できる種別 (案件の予定) */
export const SUGGEST_KINDS: ScheduleKind[] = [...VISIT_KINDS, ...JOB_KINDS];

export type CapacityKey = "jobsPerDay" | "visitsPerDay" | "tatamiPerDay";

export const CAPACITY_LABEL: Record<CapacityKey, string> = {
  jobsPerDay: "現場作業 (引き取り・納品・施工・採寸) の件数",
  visitsPerDay: "営業の訪問 (現地調査・顧客訪問) の件数",
  tatamiPerDay: "畳の製造 (その日に引き取る畳の枚数)",
};

export interface StoreCapacitySetting {
  jobsPerDay?: number;
  visitsPerDay?: number;
  tatamiPerDay?: number;
}

export interface CapacitySettings {
  stores: Partial<Record<StoreId, StoreCapacitySetting>>;
  /** 1 人が 1 日に担当できる案件の予定の件数 */
  staffEventsPerDay?: number;
  /** 作業の時間帯 (HH:MM) */
  workStart?: string;
  workEnd?: string;
  /** 移動の速さ (km/h。道路距離の目安から移動時間を出す) */
  travelSpeedKmh?: number;
  /** 今日から何日後から提案するか (0 = 今日から) */
  leadDays?: number;
  /** 何日先まで探すか */
  horizonDays?: number;
}

export const DEFAULTS = { workStart: "08:30", workEnd: "17:30", travelSpeedKmh: 30, leadDays: 1, horizonDays: 21 } as const;
/** 自動で決めるときの下限 (データが少ない店舗でも提案できるように) と、データがないときの値 */
const FLOOR: Record<CapacityKey, number> = { jobsPerDay: 3, visitsPerDay: 2, tatamiPerDay: 10 };
const FALLBACK: Record<CapacityKey, number> = { jobsPerDay: 5, visitsPerDay: 3, tatamiPerDay: 30 };
const STAFF_FLOOR = 3;
const STAFF_FALLBACK = 5;

const clampInt = (v: unknown, min: number, max: number): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : undefined;
};

/** 設定の読み込み (壊れた値は使わない) */
export function readCapacitySettings(db: Pick<Database, "settings" | "stores">): CapacitySettings {
  const v = (db.settings ?? []).find((s) => s.id === SCHEDULE_CAPACITY_ID)?.value ?? {};
  const raw = (v.stores ?? {}) as Record<string, Record<string, unknown>>;
  const stores: CapacitySettings["stores"] = {};
  for (const s of db.stores) {
    const r = raw[s.id];
    if (!r) continue;
    stores[s.id] = { jobsPerDay: clampInt(r.jobsPerDay, 1, 99), visitsPerDay: clampInt(r.visitsPerDay, 1, 99), tatamiPerDay: clampInt(r.tatamiPerDay, 1, 999) };
  }
  const time = (t: unknown) => (typeof t === "string" ? normTime(t) : undefined);
  return {
    stores,
    staffEventsPerDay: clampInt(v.staffEventsPerDay, 1, 20),
    workStart: time(v.workStart),
    workEnd: time(v.workEnd),
    travelSpeedKmh: clampInt(v.travelSpeedKmh, 10, 80),
    leadDays: clampInt(v.leadDays, 0, 30),
    horizonDays: clampInt(v.horizonDays, 7, 62),
  };
}

/* ---------------- 予定の仕事量 ---------------- */

export interface Work {
  tatami: number;
  fusuma: number;
  shoji: number;
  amido: number;
}

const WORK_KEY: Record<string, keyof Work> = { 畳: "tatami", 襖: "fusuma", 障子: "shoji", 網戸: "amido" };

/** 予定の件名・メモから仕事量を読む (例:「畳 表替え6 / 襖 張替3」→ 畳 6 枚・襖 3 枚) */
export function workOf(e: Pick<ScheduleEvent, "title" | "memo">): Work {
  const w: Work = { tatami: 0, fusuma: 0, shoji: 0, amido: 0 };
  const text = `${e.title ?? ""}\n${e.memo ?? ""}`.normalize("NFKC");
  for (const m of text.matchAll(/(畳|襖|障子|網戸)[ \t]*([^\d\s/、,()]{0,6}?)[ \t]*(\d{1,3})(?![\d:/])/g)) {
    // 「畳縁」「畳表」のような品名の一部や、「6畳」のような部屋の広さは数えない (「畳」の直後が品名の文字のとき)
    if (m[1] === "畳" && /^(縁|表[^替]|床|寄せ)/.test(m[2])) continue;
    const n = Number(m[3]);
    if (n > 0 && n <= 200) w[WORK_KEY[m[1]]] += n;
  }
  return w;
}

/* ---------------- 休業日 ---------------- */

/**
 * 休業日の索引は配列ごとに持つ。休日カレンダーの変更 (src/lib/holiday-calendar.ts)・他のインスタンスの変更の取り込み・
 * 書き込みの失敗の巻き戻しは、どれも db.holidays を新しい配列にする。念のため件数が変わったときも作り直す
 */
const closedCache = new WeakMap<object, { n: number; set: Set<string>; max: string }>();
const NO_HOLIDAYS: never[] = [];

/** 休業日か (休日カレンダー。カレンダーの登録より先の日付は日曜を休みとみなす) */
export function isClosedDay(db: Pick<Database, "holidays">, date: string): boolean {
  const hs = db.holidays ?? NO_HOLIDAYS;
  let c = closedCache.get(hs);
  if (!c || c.n !== hs.length) {
    c = { n: hs.length, set: new Set(hs.map((h) => h.date)), max: hs.reduce((m, h) => (h.date > m ? h.date : m), "") };
    closedCache.set(hs, c);
  }
  if (c.set.has(date)) return true;
  return date > c.max && dayOfWeek(date) === 0;
}

/* ---------------- 過去の実績 (自動の上限・担当の経験) ---------------- */

export interface StoreStats {
  jobsPerDay: number;
  visitsPerDay: number;
  tatamiPerDay: number;
  /** 集計に使った日数 (現場作業のあった日) */
  days: number;
  /** 実績から決めた値か (false はデータが少ないため既定値) */
  learned: Record<CapacityKey, boolean>;
  /** 種別ごとの担当者の人数 (中央値) */
  teamSize: Partial<Record<ScheduleKind, number>>;
}

export interface ScheduleStats {
  key: string;
  stores: Partial<Record<StoreId, StoreStats>>;
  staffEventsPerDay: number;
  /** 社員ごとの過去 1 年の担当件数 (現場作業・営業) */
  experience: Map<string, { job: number; visit: number }>;
}

const g = globalThis as typeof globalThis & { __ichijoyaScheduleStats?: ScheduleStats };

function quantile(xs: number[], q: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
}

const median = (xs: number[]) => quantile(xs, 0.5);

/** 過去 1 年の予定表の実績 (同じ日のうちは作り直さない。予定の件数が変わったら作り直す) */
export function scheduleStats(db: Pick<Database, "schedule" | "stores">, now = new Date()): ScheduleStats {
  const today = toDateKey(now);
  const key = `${today}|${db.schedule.length}`;
  if (g.__ichijoyaScheduleStats?.key === key) return g.__ichijoyaScheduleStats;
  const since = addDays(today, -365);
  const perDay = new Map<string, { jobs: number; visits: number; tatami: number }>();
  const team = new Map<string, number[]>();
  const perStaffDay = new Map<string, number>();
  const experience = new Map<string, { job: number; visit: number }>();
  for (const e of db.schedule) {
    if (e.date < since || e.date >= today) continue;
    const job = JOB_KINDS.includes(e.kind);
    const visit = VISIT_KINDS.includes(e.kind);
    if (!job && !visit) continue;
    const k = `${e.storeId}|${e.date}`;
    const d = perDay.get(k) ?? { jobs: 0, visits: 0, tatami: 0 };
    if (job) d.jobs++;
    if (visit) d.visits++;
    if (e.kind === "pickup") d.tatami += workOf(e).tatami;
    perDay.set(k, d);
    if (e.assigneeIds.length) {
      const tk = `${e.storeId}|${e.kind}`;
      const xs = team.get(tk);
      if (xs) xs.push(e.assigneeIds.length);
      else team.set(tk, [e.assigneeIds.length]);
    }
    for (const uid of new Set(e.assigneeIds)) {
      perStaffDay.set(`${uid}|${e.date}`, (perStaffDay.get(`${uid}|${e.date}`) ?? 0) + 1);
      const x = experience.get(uid) ?? { job: 0, visit: 0 };
      if (job) x.job++;
      else x.visit++;
      experience.set(uid, x);
    }
  }
  const stores: ScheduleStats["stores"] = {};
  for (const s of db.stores) {
    const days = [...perDay.entries()].filter(([k]) => k.startsWith(`${s.id}|`)).map(([, v]) => v);
    const jobDays = days.filter((d) => d.jobs > 0);
    const visitDays = days.filter((d) => d.visits > 0);
    const tatamiDays = days.filter((d) => d.tatami > 0);
    const teamSize: StoreStats["teamSize"] = {};
    for (const kind of SUGGEST_KINDS) {
      const xs = team.get(`${s.id}|${kind}`) ?? [];
      if (xs.length >= 5) teamSize[kind] = Math.max(1, Math.min(4, median(xs)));
    }
    const learned: Record<CapacityKey, boolean> = { jobsPerDay: jobDays.length >= 20, visitsPerDay: visitDays.length >= 10, tatamiPerDay: tatamiDays.length >= 20 };
    stores[s.id] = {
      jobsPerDay: learned.jobsPerDay ? Math.max(FLOOR.jobsPerDay, quantile(jobDays.map((d) => d.jobs), 0.9)) : FALLBACK.jobsPerDay,
      visitsPerDay: learned.visitsPerDay ? Math.max(FLOOR.visitsPerDay, quantile(visitDays.map((d) => d.visits), 0.9)) : FALLBACK.visitsPerDay,
      tatamiPerDay: learned.tatamiPerDay ? Math.max(FLOOR.tatamiPerDay, quantile(tatamiDays.map((d) => d.tatami), 0.9)) : FALLBACK.tatamiPerDay,
      days: jobDays.length,
      learned,
      teamSize,
    };
  }
  const staffDays = [...perStaffDay.values()];
  const stats: ScheduleStats = { key, stores, staffEventsPerDay: staffDays.length >= 50 ? Math.max(STAFF_FLOOR, quantile(staffDays, 0.9)) : STAFF_FALLBACK, experience };
  g.__ichijoyaScheduleStats = stats;
  return stats;
}

/* ---------------- 実際に使う上限 ---------------- */

export type CapacitySource = "setting" | "auto" | "default";

export interface EffectiveCapacity {
  jobsPerDay: number;
  visitsPerDay: number;
  tatamiPerDay: number;
  source: Record<CapacityKey, CapacitySource>;
  staffEventsPerDay: number;
  staffSource: CapacitySource;
  workStart: string;
  workEnd: string;
  travelSpeedKmh: number;
  leadDays: number;
  horizonDays: number;
}

export function effectiveCapacity(db: Pick<Database, "settings" | "stores" | "schedule">, storeId: StoreId, now = new Date()): EffectiveCapacity {
  const set = readCapacitySettings(db);
  const stats = scheduleStats(db, now);
  const st = stats.stores[storeId];
  const own = set.stores[storeId] ?? {};
  const pick = (k: CapacityKey): [number, CapacitySource] => {
    if (own[k]) return [own[k]!, "setting"];
    if (st?.learned[k]) return [st[k], "auto"];
    return [FALLBACK[k], "default"];
  };
  const [jobsPerDay, js] = pick("jobsPerDay");
  const [visitsPerDay, vs] = pick("visitsPerDay");
  const [tatamiPerDay, ts] = pick("tatamiPerDay");
  let workStart = set.workStart ?? DEFAULTS.workStart;
  let workEnd = set.workEnd ?? DEFAULTS.workEnd;
  if (toMinutes(workEnd) - toMinutes(workStart) < 180) {
    workStart = DEFAULTS.workStart;
    workEnd = DEFAULTS.workEnd;
  }
  return {
    jobsPerDay,
    visitsPerDay,
    tatamiPerDay,
    source: { jobsPerDay: js, visitsPerDay: vs, tatamiPerDay: ts },
    staffEventsPerDay: set.staffEventsPerDay ?? stats.staffEventsPerDay,
    staffSource: set.staffEventsPerDay ? "setting" : "auto",
    workStart,
    workEnd,
    travelSpeedKmh: set.travelSpeedKmh ?? DEFAULTS.travelSpeedKmh,
    leadDays: set.leadDays ?? DEFAULTS.leadDays,
    horizonDays: set.horizonDays ?? DEFAULTS.horizonDays,
  };
}

/* ---------------- 日ごとの店舗の仕事量 ---------------- */

export interface DayLoad {
  jobs: number;
  visits: number;
  /** 引き取る畳の枚数 (畳の製造) */
  tatami: number;
}

/** 店舗の日ごとの仕事量 (from〜to。excludeId の予定は数えない = 変更中の予定) */
export function storeDayLoads(db: Pick<Database, "schedule">, storeId: StoreId, from: string, to: string, excludeId?: string): Map<string, DayLoad> {
  const out = new Map<string, DayLoad>();
  if (!isDateKey(from) || !isDateKey(to)) return out;
  for (const e of db.schedule) {
    if (e.storeId !== storeId || e.id === excludeId || e.date > to) continue;
    const job = JOB_KINDS.includes(e.kind);
    const visit = VISIT_KINDS.includes(e.kind);
    if (!job && !visit) continue;
    for (const d of eventDays(e)) {
      if (d < from || d > to) continue;
      const l = out.get(d) ?? { jobs: 0, visits: 0, tatami: 0 };
      if (job) l.jobs++;
      if (visit) l.visits++;
      if (e.kind === "pickup" && d === e.date) l.tatami += workOf(e).tatami;
      out.set(d, l);
    }
  }
  return out;
}
