import type { Database, HolidayWork, LeaveGrant, LeaveRequest, LeaveSlot, LeaveStatus, LeaveType, ScheduleEvent, StoreId, User } from "@/lib/db/types";
import type { Tone } from "@/lib/constants";
import { isClosedDay } from "@/lib/schedule-capacity";
import { findConflicts, shortDate, timeLabel } from "@/lib/calendar";
import { isReviewAccount } from "@/lib/auth/permissions";

/**
 * 有給・休日出勤の管理 (F-16) の計算
 * ------------------------------------------------------------
 * - 日数は 0.5 日 (半日 = 午前・午後) 単位。計算の中では「半日の数」(整数) で数え、浮動小数点の誤差を出さない
 * - 有給: 付与 (leaveGrants) ごとに、付与日〜有効期限 (付与から 2 年) の間の休暇に使える。
 *   承認済みの休暇を日付の順に、使える付与のうち期限の早いもの (= 古いもの) から消化する (設定で「新しいものから」にもできる)。
 *   承認した時点で残日数を減らす (先の日付の休暇も含む)。付与より前の取得 (前取り) はできない
 * - 振休: 休日出勤 (holidayWorks) 1 件ごとに発生し、振休の取得 (leaveType = comp) を古い休日出勤から順に充てる
 *   (申請で休日出勤を選んだときはその休日出勤から)。振休は年度をまたいでも消えない。
 *   社内規定「振休ため込みは 3 日まで」: 未取得が上限 (設定。初期値 3 日) を超えると警告する
 * - 年度は 7 月〜翌 6 月 (設定で変えられる)。勤怠の締めは 20 日 (前月 21 日〜当月 20 日)
 * 画面・CSV・操作 (src/lib/actions/leave.ts)・テスト (scripts/tests/hr) は同じ関数を使う
 */

/* ================================================================== */
/* 表示                                                                */
/* ================================================================== */

export const LEAVE_TYPE: Record<LeaveType, { label: string; short: string; tone: Tone }> = {
  paid: { label: "有給休暇", short: "有給", tone: "accent" },
  comp: { label: "振休", short: "振休", tone: "info" },
  special: { label: "特別休暇", short: "特別休暇", tone: "neutral" },
};

export const LEAVE_STATUS: Record<LeaveStatus, { label: string; tone: Tone }> = {
  pending: { label: "申請中", tone: "warn" },
  approved: { label: "承認済み", tone: "good" },
  rejected: { label: "却下", tone: "critical" },
  cancelled: { label: "取消", tone: "neutral" },
};

export const LEAVE_SLOT: Record<LeaveSlot, string> = { day: "終日", am: "午前", pm: "午後" };

export const LEAVE_TYPES = Object.keys(LEAVE_TYPE) as LeaveType[];
export const LEAVE_SLOTS = Object.keys(LEAVE_SLOT) as LeaveSlot[];

/** 日数の表示 (1 / 0.5 / 12.5) */
export function fmtDays(days: number): string {
  return `${Number.isInteger(days) ? days : days.toFixed(1)} 日`;
}

/* ================================================================== */
/* 設定 (settings の id = hr_leave)                                     */
/* ================================================================== */

export const HR_SETTINGS_ID = "hr_leave";

/** 社員ごとの有給の情報 (雇い入れ日・基準日・週の所定労働日数) */
export interface LeaveProfile {
  /** 雇い入れ年月日 (空 = アカウントの入社日) */
  hiredOn?: string;
  /** 基準日 (毎年この月日に付与。空 = 雇い入れ日の 6 か月後) */
  baseDate?: string;
  /** 週の所定労働日数 (5 = 通常。4 以下は比例付与の表) */
  weeklyDays?: number;
}

export interface HrSettings {
  /** 振休のため込みの上限 (日)。社内規定「振休ため込みは 3 日まで」 */
  compLimit: number;
  /** 有給の消化の順番: oldest = 期限の早い (古い) 付与から / newest = 当年度分 (新しい付与) から */
  consumeOrder: "oldest" | "newest";
  /** 年度の始まりの月 (7 = 7 月〜翌 6 月) */
  fiscalStartMonth: number;
  /** 勤怠の締め日 (20 = 前月 21 日〜当月 20 日。31 = 月末) */
  closingDay: number;
  /** 半日の休暇の時間帯 (予定表の重複の確認に使う) */
  amStart: string;
  amEnd: string;
  pmStart: string;
  pmEnd: string;
  profiles: Record<string, LeaveProfile>;
}

export const HR_DEFAULTS: HrSettings = {
  compLimit: 3,
  // お客様の決定 (2026-11-20): 有給は今年度分 (新しい付与) から使う
  consumeOrder: "newest",
  fiscalStartMonth: 7,
  closingDay: 20,
  amStart: "08:00",
  amEnd: "12:00",
  pmStart: "13:00",
  pmEnd: "17:00",
  profiles: {},
};

const isTime = (v: unknown): v is string => typeof v === "string" && /^\d{2}:\d{2}$/.test(v);
const isKey = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

export function hrSettings(db: Pick<Database, "settings">): HrSettings {
  const v = ((db.settings ?? []).find((s) => s.id === HR_SETTINGS_ID)?.value ?? {}) as Record<string, unknown>;
  const n = (x: unknown, min: number, max: number, def: number) => (typeof x === "number" && Number.isFinite(x) && x >= min && x <= max ? x : def);
  const profiles: Record<string, LeaveProfile> = {};
  const raw = v.profiles && typeof v.profiles === "object" ? (v.profiles as Record<string, Record<string, unknown>>) : {};
  for (const [id, p] of Object.entries(raw)) {
    if (!p || typeof p !== "object") continue;
    profiles[id] = {
      hiredOn: isKey(p.hiredOn) ? p.hiredOn : undefined,
      baseDate: isKey(p.baseDate) ? p.baseDate : undefined,
      weeklyDays: typeof p.weeklyDays === "number" && p.weeklyDays >= 1 && p.weeklyDays <= 5 ? Math.round(p.weeklyDays) : undefined,
    };
  }
  return {
    compLimit: n(v.compLimit, 0, 60, HR_DEFAULTS.compLimit),
    consumeOrder: v.consumeOrder === "oldest" ? "oldest" : v.consumeOrder === "newest" ? "newest" : HR_DEFAULTS.consumeOrder,
    fiscalStartMonth: Math.round(n(v.fiscalStartMonth, 1, 12, HR_DEFAULTS.fiscalStartMonth)),
    closingDay: Math.round(n(v.closingDay, 1, 31, HR_DEFAULTS.closingDay)),
    amStart: isTime(v.amStart) ? v.amStart : HR_DEFAULTS.amStart,
    amEnd: isTime(v.amEnd) ? v.amEnd : HR_DEFAULTS.amEnd,
    pmStart: isTime(v.pmStart) ? v.pmStart : HR_DEFAULTS.pmStart,
    pmEnd: isTime(v.pmEnd) ? v.pmEnd : HR_DEFAULTS.pmEnd,
    profiles,
  };
}

/* ================================================================== */
/* 日付                                                                */
/* ================================================================== */

const DAY_MS = 86400000;
const toUtc = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
const fromUtc = (t: number) => new Date(t).toISOString().slice(0, 10);

export function isDateKey(v: unknown): v is string {
  return isKey(v) && !Number.isNaN(toUtc(v)) && fromUtc(toUtc(v)) === v;
}

export function shiftDays(d: string, n: number): string {
  return fromUtc(toUtc(d) + n * DAY_MS);
}

/** a から b までの日数 (b が後なら正) */
export function daysBetweenKeys(a: string, b: string): number {
  return Math.round((toUtc(b) - toUtc(a)) / DAY_MS);
}

/** n か月後の同じ日 (ない日は月末) */
export function addMonthsKey(d: string, n: number): string {
  const y = Number(d.slice(0, 4));
  const m = Number(d.slice(5, 7)) - 1 + n;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  const last = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
  return `${String(yy).padStart(4, "0")}-${String(mm + 1).padStart(2, "0")}-${String(Math.min(Number(d.slice(8, 10)), last)).padStart(2, "0")}`;
}

export function addYearsKey(d: string, n: number): string {
  return addMonthsKey(d, n * 12);
}

/** 有給の有効期限 (付与日から 2 年。この日まで使える。労働基準法 115 条の時効) */
export function grantExpiry(grantDate: string): string {
  return shiftDays(addYearsKey(grantDate, 2), -1);
}

/** 勤続の月数 (雇い入れ日からその日まで。満の月数) */
export function serviceMonths(hiredOn: string, on: string): number {
  const months = (Number(on.slice(0, 4)) - Number(hiredOn.slice(0, 4))) * 12 + (Number(on.slice(5, 7)) - Number(hiredOn.slice(5, 7)));
  return Number(on.slice(8, 10)) < Number(hiredOn.slice(8, 10)) ? months - 1 : months;
}

/** 勤続 0.5 年・1.5 年・… 6.5 年以上 (月数) */
const SERVICE_STEPS = [6, 18, 30, 42, 54, 66, 78];
/** 法定の付与日数 (週の所定労働日数ごと。5 = 通常の労働者、4〜1 = 比例付与。労働基準法 39 条) */
const STATUTORY: Record<number, number[]> = {
  5: [10, 11, 12, 14, 16, 18, 20],
  4: [7, 8, 9, 10, 12, 13, 15],
  3: [5, 6, 6, 8, 9, 10, 11],
  2: [3, 4, 4, 5, 6, 6, 7],
  1: [1, 2, 2, 2, 3, 3, 3],
};

/** 法定の付与日数の目安 (勤続 6 か月未満は 0)。管理者は別の日数でも登録できる */
export function statutoryGrantDays(months: number, weeklyDays = 5): number {
  const table = STATUTORY[Math.min(5, Math.max(1, Math.round(weeklyDays)))];
  let idx = -1;
  for (let i = 0; i < SERVICE_STEPS.length; i++) if (months >= SERVICE_STEPS[i]) idx = i;
  return idx < 0 ? 0 : table[idx];
}

/** 年度 (7 月始まりなら 2026-07-01〜2027-06-30 が 2026 年度) */
export function fiscalYearOf(date: string, startMonth = 7): number {
  const y = Number(date.slice(0, 4));
  return Number(date.slice(5, 7)) >= startMonth ? y : y - 1;
}

export function fiscalRange(fy: number, startMonth = 7): { from: string; to: string } {
  const from = `${fy}-${String(startMonth).padStart(2, "0")}-01`;
  return { from, to: shiftDays(addYearsKey(from, 1), -1) };
}

/** 2026 年度 (令和 8 年度) */
export function fiscalLabel(fy: number): string {
  return fy > 2018 ? `${fy}年度 (令和${fy - 2018}年度)` : `${fy}年度`;
}

/** 勤怠の締めの期間 (締め日 20 日の 2026-11 → 2026-10-21〜2026-11-20。締め日 28 日以上は月末締め) */
export function closingRange(month: string, closingDay = 20): { from: string; to: string } {
  const first = `${month}-01`;
  if (closingDay >= 28) return { from: first, to: shiftDays(addMonthsKey(first, 1), -1) };
  const to = `${month}-${String(closingDay).padStart(2, "0")}`;
  return { from: shiftDays(addMonthsKey(to, -1), 1), to };
}

/** 7/3 (月日の短い表示) */
export function md(d: string): string {
  return `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
}

/* ================================================================== */
/* 社員                                                                */
/* ================================================================== */

/** 有給・休日出勤を管理する社員 (有効なアカウント。確認用・新規登録の申請中は除く) */
export function leaveEmployees(db: Pick<Database, "users" | "stores">): User[] {
  const order = new Map(db.stores.map((s, i) => [s.id, i]));
  return db.users
    .filter((u) => u.active && !u.signupStatus && !isReviewAccount(u))
    .sort((a, b) => (order.get(a.storeId) ?? 9) - (order.get(b.storeId) ?? 9) || (a.kana || a.name).localeCompare(b.kana || b.name, "ja"));
}

export interface ResolvedProfile {
  hiredOn?: string;
  baseDate?: string;
  weeklyDays: number;
}

/** 社員の有給の情報 (設定 → なければアカウントの入社日から) */
export function leaveProfile(db: Pick<Database, "settings">, user: Pick<User, "id" | "hiredOn">): ResolvedProfile {
  const p = hrSettings(db).profiles[user.id] ?? {};
  const hiredOn = p.hiredOn ?? (isDateKey(user.hiredOn) ? user.hiredOn : undefined);
  return { hiredOn, baseDate: p.baseDate ?? (hiredOn ? addMonthsKey(hiredOn, 6) : undefined), weeklyDays: p.weeklyDays ?? 5 };
}

/** 基準日の記念日 (anchor + k 年) のうち after より後の最初の日 */
function anniversaryAfter(anchor: string, after: string): string {
  let k = Math.max(0, Number(after.slice(0, 4)) - Number(anchor.slice(0, 4)) - 1);
  while (addYearsKey(anchor, k) <= after) k++;
  return addYearsKey(anchor, k);
}

export interface GrantSuggestion {
  date: string;
  /** 法定の付与日数の目安 (雇い入れ日が分からないときは undefined) */
  days?: number;
  months?: number;
  /** 付与日を過ぎている (登録が必要) */
  due: boolean;
}

/** 次の付与の目安 (基準日と勤続年数から)。基準日が分からないときは undefined */
export function suggestGrant(db: Pick<Database, "settings" | "leaveGrants">, user: Pick<User, "id" | "hiredOn">, today: string): GrantSuggestion | undefined {
  const prof = leaveProfile(db, user);
  if (!prof.baseDate) return undefined;
  const last = db.leaveGrants
    .filter((g) => g.userId === user.id)
    .map((g) => (g.kind === "grant" ? g.grantDate : (g.baseDate ?? g.grantDate)))
    .sort()
    .at(-1);
  let date: string;
  if (last) date = anniversaryAfter(prof.baseDate, last < prof.baseDate ? shiftDays(prof.baseDate, -1) : last);
  else if (prof.baseDate > today) date = prof.baseDate;
  else {
    // 付与の登録がまだない: 今の期間の付与日 (今日以前の最後の記念日)
    const next = anniversaryAfter(prof.baseDate, today);
    date = addYearsKey(next, -1) >= prof.baseDate ? addYearsKey(next, -1) : prof.baseDate;
  }
  const months = prof.hiredOn ? serviceMonths(prof.hiredOn, date) : undefined;
  return { date, months, days: months === undefined ? undefined : statutoryGrantDays(months, prof.weeklyDays), due: date <= today };
}

/* ================================================================== */
/* 休暇の日数                                                          */
/* ================================================================== */

export const toHalves = (days: number) => Math.round(days * 2);
export const fromHalves = (halves: number) => halves / 2;

/**
 * 日数に数える日。1 日だけ・半日の申請はその日 (本人の勤務日として扱う)、
 * 複数日 (終日) は休業日 (休日カレンダー。登録がない先の日付は日曜) を除く
 */
export function leaveDates(db: Pick<Database, "holidays">, date: string, endDate: string | undefined, slot: LeaveSlot): string[] {
  if (slot !== "day" || !endDate || endDate <= date) return [date];
  const out: string[] = [];
  for (let d = date; d <= endDate && out.length < 62; d = shiftDays(d, 1)) if (!isClosedDay(db, d)) out.push(d);
  return out;
}

export function leaveDays(dates: string[], slot: LeaveSlot): number {
  return dates.length * (slot === "day" ? 1 : 0.5);
}

/** 1 日分の取得 (消化の計算の単位) */
export interface LeaveUnit {
  requestId: string;
  date: string;
  halves: number;
  /** 同じ日の順番 (申請日時) */
  seq: string;
  holidayWorkId?: string;
}

export function requestUnits(r: Pick<LeaveRequest, "id" | "dates" | "slot" | "requestedAt" | "holidayWorkId">): LeaveUnit[] {
  const halves = r.slot === "day" ? 2 : 1;
  return r.dates.map((date) => ({ requestId: r.id, date, halves, seq: r.requestedAt, holidayWorkId: r.holidayWorkId }));
}

const byDate = (a: LeaveUnit, b: LeaveUnit) => a.date.localeCompare(b.date) || a.seq.localeCompare(b.seq) || a.requestId.localeCompare(b.requestId);

/** 同じ社員の同じ日に重なる休暇 (申請中・承認済み)。終日どうし・終日と半日・同じ半日は重なる */
export function overlappingLeave(db: Pick<Database, "leaveRequests">, userId: string, dates: string[], slot: LeaveSlot, ignoreId?: string): LeaveRequest | undefined {
  const set = new Set(dates);
  return db.leaveRequests.find(
    (r) => r.userId === userId && r.id !== ignoreId && (r.status === "pending" || r.status === "approved") && r.dates.some((d) => set.has(d)) && (r.slot === "day" || slot === "day" || r.slot === slot),
  );
}

/* ================================================================== */
/* 有給の残日数 (付与ごとの消化)                                         */
/* ================================================================== */

export interface GrantUse {
  requestId: string;
  date: string;
  halves: number;
}

export interface GrantState {
  grant: LeaveGrant;
  halves: number;
  usedHalves: number;
  remainingHalves: number;
  /** future = まだ付与日前 / active = 使える / expired = 期限切れ */
  state: "future" | "active" | "expired";
  uses: GrantUse[];
}

export interface LedgerOptions {
  /** 申請中の休暇も消化に含める (申請のときの残日数の確認) */
  includePending?: boolean;
  /** 追加で消化する分 (申請・承認しようとしている休暇) */
  extra?: LeaveUnit[];
}

export interface PaidLedger {
  grants: GrantState[];
  /** 付与が足りない分 (申請 ID → 半日の数) */
  shortages: Map<string, number>;
  shortHalves: number;
}

type LedgerDb = Pick<Database, "leaveGrants" | "leaveRequests" | "settings">;

/** 有給の消化の計算: 休暇を日付の順に、その日に使える付与 (付与日〜期限) へ充てる */
export function paidLedger(db: LedgerDb, userId: string, asOf: string, opts: LedgerOptions = {}): PaidLedger {
  const order = hrSettings(db).consumeOrder;
  const grants: GrantState[] = db.leaveGrants
    .filter((g) => g.userId === userId)
    .map((g) => ({ grant: g, halves: toHalves(g.days), usedHalves: 0, remainingHalves: toHalves(g.days), state: asOf < g.grantDate ? "future" : asOf > g.expiresOn ? "expired" : "active", uses: [] }));
  const cmp = (a: GrantState, b: GrantState) => a.grant.expiresOn.localeCompare(b.grant.expiresOn) || a.grant.grantDate.localeCompare(b.grant.grantDate) || a.grant.id.localeCompare(b.grant.id);
  const units = [
    ...db.leaveRequests.filter((r) => r.userId === userId && r.leaveType === "paid" && (r.status === "approved" || (opts.includePending && r.status === "pending"))).flatMap(requestUnits),
    ...(opts.extra ?? []),
  ].sort(byDate);
  const shortages = new Map<string, number>();
  let shortHalves = 0;
  for (const u of units) {
    let need = u.halves;
    const usable = grants.filter((g) => g.grant.grantDate <= u.date && u.date <= g.grant.expiresOn && g.remainingHalves > 0).sort((a, b) => (order === "oldest" ? cmp(a, b) : cmp(b, a)));
    for (const g of usable) {
      const take = Math.min(need, g.remainingHalves);
      g.remainingHalves -= take;
      g.usedHalves += take;
      g.uses.push({ requestId: u.requestId, date: u.date, halves: take });
      need -= take;
      if (need === 0) break;
    }
    if (need > 0) {
      shortages.set(u.requestId, (shortages.get(u.requestId) ?? 0) + need);
      shortHalves += need;
    }
  }
  grants.sort((a, b) => a.grant.grantDate.localeCompare(b.grant.grantDate) || a.grant.expiresOn.localeCompare(b.grant.expiresOn));
  return { grants, shortages, shortHalves };
}

export interface PaidBalance {
  /** 今使える残日数 (承認済みの休暇は先の日付の分も差し引く) */
  remaining: number;
  /** 使える付与の合計 */
  granted: number;
  /** 使える付与から消化した日数 */
  used: number;
  /** 申請中の日数 */
  pending: number;
  /** 登録済みで、まだ付与日前の日数 */
  future: number;
  /** 期限切れで消えた日数 */
  lapsed: number;
  /** 付与が足りない承認済みの休暇の日数 */
  shortage: number;
  /** 90 日以内に期限が来る残 */
  expiring: { expiresOn: string; days: number }[];
  grants: GrantState[];
}

export function paidBalance(db: LedgerDb, userId: string, asOf: string): PaidBalance {
  const l = paidLedger(db, userId, asOf);
  const sum = (xs: GrantState[], f: (g: GrantState) => number) => fromHalves(xs.reduce((s, g) => s + f(g), 0));
  const active = l.grants.filter((g) => g.state === "active");
  const soon = shiftDays(asOf, 90);
  return {
    remaining: sum(active, (g) => g.remainingHalves),
    granted: sum(active, (g) => g.halves),
    used: sum(active, (g) => g.usedHalves),
    pending: db.leaveRequests.filter((r) => r.userId === userId && r.leaveType === "paid" && r.status === "pending").reduce((s, r) => s + r.days, 0),
    future: sum(l.grants.filter((g) => g.state === "future"), (g) => g.halves),
    lapsed: sum(l.grants.filter((g) => g.state === "expired"), (g) => g.remainingHalves),
    shortage: fromHalves(l.shortHalves),
    expiring: active.filter((g) => g.remainingHalves > 0 && g.grant.expiresOn <= soon).map((g) => ({ expiresOn: g.grant.expiresOn, days: fromHalves(g.remainingHalves) })),
    grants: l.grants,
  };
}

/** その日に使える有給の残 (付与日前・期限切れの付与を除く。承認済みの休暇をすべて差し引いた後) */
export function paidRemainingOn(db: LedgerDb, userId: string, date: string): number {
  const l = paidLedger(db, userId, date);
  return fromHalves(l.grants.filter((g) => g.grant.grantDate <= date && date <= g.grant.expiresOn).reduce((s, g) => s + g.remainingHalves, 0));
}

/**
 * 有給が足りるか (足りなければ理由の文)。申請のときは申請中も含めて確かめ、承認のときは承認済みだけで確かめる。
 * 追加の休暇で、ほかの休暇 (後の日付) が足りなくなる場合も断る
 */
export function paidShortageMessage(db: LedgerDb, r: Pick<LeaveRequest, "id" | "userId" | "dates" | "slot" | "requestedAt">, includePending: boolean): string | null {
  const before = paidLedger(db, r.userId, r.dates[0], { includePending });
  const after = paidLedger(db, r.userId, r.dates[0], { includePending, extra: requestUnits({ ...r, holidayWorkId: undefined }) });
  if (after.shortHalves <= before.shortHalves) return null;
  const left = paidRemainingOn(db, r.userId, r.dates[0]);
  const pending = includePending ? db.leaveRequests.filter((x) => x.userId === r.userId && x.leaveType === "paid" && x.status === "pending" && x.id !== r.id).reduce((s, x) => s + x.days, 0) : 0;
  return `有給の残日数が足りません (${md(r.dates[0])} の時点の残 ${fmtDays(Math.max(0, left - pending))}${pending ? ` ※申請中の ${fmtDays(pending)} を差し引き` : ""}、不足 ${fmtDays(fromHalves(after.shortHalves - before.shortHalves))})。有給は付与されてから取得できます (前取りはできません)。付与の登録が済んでいるか、事務・管理者に確認してください。`;
}

/** 年 5 日の取得義務 (10 日以上を付与した社員。付与日から 1 年以内に 5 日。労働基準法 39 条 7 項) */
export interface Obligation {
  grantDate: string;
  deadline: string;
  taken: number;
  required: number;
  met: boolean;
}

export function annualObligation(db: Pick<Database, "leaveGrants" | "leaveRequests">, userId: string, today: string): Obligation | undefined {
  const g = db.leaveGrants
    .filter((x) => x.userId === userId && x.kind === "grant" && x.days >= 10 && x.grantDate <= today && today <= shiftDays(addYearsKey(x.grantDate, 1), -1))
    .sort((a, b) => b.grantDate.localeCompare(a.grantDate))[0];
  if (!g) return undefined;
  const deadline = shiftDays(addYearsKey(g.grantDate, 1), -1);
  const halves = db.leaveRequests
    .filter((r) => r.userId === userId && r.leaveType === "paid" && r.status === "approved")
    .flatMap(requestUnits)
    .filter((u) => u.date >= g.grantDate && u.date <= deadline)
    .reduce((s, u) => s + u.halves, 0);
  const taken = fromHalves(halves);
  return { grantDate: g.grantDate, deadline, taken, required: 5, met: taken >= 5 };
}

/* ================================================================== */
/* 振休 (休日出勤との対応)                                               */
/* ================================================================== */

export interface WorkState {
  work: HolidayWork;
  halves: number;
  usedHalves: number;
  remainingHalves: number;
  uses: GrantUse[];
}

export interface CompLedger {
  works: WorkState[];
  shortages: Map<string, number>;
  shortHalves: number;
  takenHalves: number;
}

type CompDb = Pick<Database, "holidayWorks" | "leaveRequests">;

/** 振休の計算: 振休を日付の順に、指定の休日出勤 → 古い休日出勤から順に充てる */
export function compLedger(db: CompDb, userId: string, opts: LedgerOptions = {}): CompLedger {
  const works: WorkState[] = db.holidayWorks
    .filter((w) => w.userId === userId)
    .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map((w) => ({ work: w, halves: toHalves(w.days), usedHalves: 0, remainingHalves: toHalves(w.days), uses: [] }));
  const units = [
    ...db.leaveRequests.filter((r) => r.userId === userId && r.leaveType === "comp" && (r.status === "approved" || (opts.includePending && r.status === "pending"))).flatMap(requestUnits),
    ...(opts.extra ?? []),
  ].sort(byDate);
  const shortages = new Map<string, number>();
  let shortHalves = 0;
  let takenHalves = 0;
  const take = (w: WorkState, u: LeaveUnit, need: number) => {
    const n = Math.min(need, w.remainingHalves);
    if (n <= 0) return 0;
    w.remainingHalves -= n;
    w.usedHalves += n;
    w.uses.push({ requestId: u.requestId, date: u.date, halves: n });
    return n;
  };
  for (const u of units) {
    takenHalves += u.halves;
    let need = u.halves;
    const linked = u.holidayWorkId ? works.find((w) => w.work.id === u.holidayWorkId) : undefined;
    if (linked) need -= take(linked, u, need);
    for (const w of works) {
      if (need === 0) break;
      need -= take(w, u, need);
    }
    if (need > 0) {
      shortages.set(u.requestId, (shortages.get(u.requestId) ?? 0) + need);
      shortHalves += need;
    }
  }
  return { works, shortages, shortHalves, takenHalves };
}

export interface CompBalance {
  /** 未取得の振休 (日) */
  remaining: number;
  /** 休日出勤の合計 (日) */
  earned: number;
  /** 振休の取得 (承認済み。先の日付を含む) */
  taken: number;
  pending: number;
  /** 休日出勤のない振休 (先取り) */
  shortage: number;
  /** 振休がまだ残っている休日出勤 (古い順) */
  open: WorkState[];
  limit: number;
  /** ため込みの上限を超えている */
  overLimit: boolean;
}

export function compBalance(db: CompDb & Pick<Database, "settings">, userId: string): CompBalance {
  const l = compLedger(db, userId);
  const limit = hrSettings(db).compLimit;
  const remaining = fromHalves(l.works.reduce((s, w) => s + w.remainingHalves, 0));
  return {
    remaining,
    earned: fromHalves(l.works.reduce((s, w) => s + w.halves, 0)),
    taken: fromHalves(l.takenHalves),
    pending: db.leaveRequests.filter((r) => r.userId === userId && r.leaveType === "comp" && r.status === "pending").reduce((s, r) => s + r.days, 0),
    shortage: fromHalves(l.shortHalves),
    open: l.works.filter((w) => w.remainingHalves > 0),
    limit,
    overLimit: remaining > limit,
  };
}

/** 振休が足りるか (足りなければ理由の文) */
export function compShortageMessage(db: CompDb, r: Pick<LeaveRequest, "id" | "userId" | "dates" | "slot" | "requestedAt" | "holidayWorkId">, includePending: boolean): string | null {
  const before = compLedger(db, r.userId, { includePending });
  const after = compLedger(db, r.userId, { includePending, extra: requestUnits(r) });
  if (after.shortHalves <= before.shortHalves) return null;
  const left = fromHalves(before.works.reduce((s, w) => s + w.remainingHalves, 0));
  return `振休の残りが足りません (未取得 ${fmtDays(left)}${includePending ? "・申請中を差し引き" : ""}、不足 ${fmtDays(fromHalves(after.shortHalves - before.shortHalves))})。先に休日出勤を登録してください (振休は休日出勤の分だけ取れます)。`;
}

/** 休日出勤を消したときに振休が足りなくなるか */
export function compBreaksWithout(db: CompDb, userId: string, workId: string): boolean {
  const before = compLedger(db, userId).shortHalves;
  const after = compLedger({ ...db, holidayWorks: db.holidayWorks.filter((w) => w.id !== workId) }, userId).shortHalves;
  return after > before;
}

/** 付与を消したとき・日数を減らしたときに承認済みの有給が足りなくなるか */
export function paidBreaksWith(db: LedgerDb, userId: string, grants: LeaveGrant[], today: string): boolean {
  const before = paidLedger(db, userId, today).shortHalves;
  const after = paidLedger({ ...db, leaveGrants: grants }, userId, today).shortHalves;
  return after > before;
}

/* ================================================================== */
/* 期間の取得状況 (年度・締め) と CSV                                    */
/* ================================================================== */

export interface PeriodDay {
  date: string;
  kind: LeaveType | "work";
  slot: LeaveSlot;
  days: number;
  requestId?: string;
  number?: string;
  decidedBy?: string;
  decidedAt?: string;
  note?: string;
}

export interface PeriodRow {
  user: User;
  storeId: StoreId;
  paid: number;
  comp: number;
  special: number;
  worked: number;
  days: PeriodDay[];
  /** 月 (YYYY-MM) ごとの日数 */
  byMonth: Record<string, { paid: number; comp: number; special: number; worked: number }>;
}

/** 期間の取得状況 (承認済みの休暇と休日出勤。切り替え時点の残は含めない) */
export function periodRows(db: Pick<Database, "leaveRequests" | "holidayWorks">, users: User[], from: string, to: string): PeriodRow[] {
  const rows = new Map<string, PeriodRow>(users.map((u) => [u.id, { user: u, storeId: u.storeId, paid: 0, comp: 0, special: 0, worked: 0, days: [], byMonth: {} }]));
  const add = (row: PeriodRow, d: PeriodDay) => {
    row.days.push(d);
    const key = d.kind === "work" ? "worked" : d.kind;
    row[key] += d.days;
    const m = (row.byMonth[d.date.slice(0, 7)] ??= { paid: 0, comp: 0, special: 0, worked: 0 });
    m[key] += d.days;
  };
  for (const r of db.leaveRequests) {
    if (r.status !== "approved") continue;
    const row = rows.get(r.userId);
    if (!row) continue;
    for (const date of r.dates) {
      if (date < from || date > to) continue;
      add(row, { date, kind: r.leaveType, slot: r.slot, days: r.slot === "day" ? 1 : 0.5, requestId: r.id, number: r.number, decidedBy: r.decidedBy, decidedAt: r.decidedAt, note: r.reason });
    }
  }
  for (const w of db.holidayWorks) {
    if (w.kind !== "work" || w.date < from || w.date > to) continue;
    const row = rows.get(w.userId);
    if (row) add(row, { date: w.date, kind: "work", slot: w.slot, days: w.days, note: w.note });
  }
  for (const row of rows.values()) row.days.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));
  return [...rows.values()];
}

/** 7/3・7/10(午前) の並び */
export function dayList(days: PeriodDay[], kind: PeriodDay["kind"]): string {
  return days
    .filter((d) => d.kind === kind)
    .map((d) => `${d.date.replace(/-/g, "/")}${d.slot === "day" ? "" : `(${LEAVE_SLOT[d.slot]})`}`)
    .join(" ");
}

/** 期間の月 (YYYY-MM) の一覧 */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = from.slice(0, 7); m <= to.slice(0, 7) && out.length < 24; m = addMonthsKey(`${m}-01`, 1).slice(0, 7)) out.push(m);
  return out;
}

/* ================================================================== */
/* 切り替え時点の残日数の取込                                             */
/* ================================================================== */

/** 2026-08-16 / 2026/8/16 / 2026年8月16日 / R8.8.16 / 令和8年8月16日 → YYYY-MM-DD */
export function parseDateLoose(raw: string): string | undefined {
  const s = raw.normalize("NFKC").trim().replace(/\s/g, "");
  if (!s) return undefined;
  let m = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/.exec(s);
  let y: number | undefined;
  if (m) y = Number(m[1]);
  else {
    m = /^(?:R|令和)(\d{1,2})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/i.exec(s);
    if (m) y = 2018 + Number(m[1]);
  }
  if (!m || y === undefined) return undefined;
  const key = `${y}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  return isDateKey(key) ? key : undefined;
}

/** 日数 (0.5 単位・0 以上)。空は 0。読めないときは undefined */
export function parseDaysLoose(raw: string): number | undefined {
  const s = raw.normalize("NFKC").trim().replace(/日$/, "");
  if (!s) return 0;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0 || n > 400 || !Number.isInteger(n * 2)) return undefined;
  return n;
}

const normName = (s: string) => s.normalize("NFKC").replace(/[\s　]/g, "").replace(/髙/g, "高").replace(/﨑/g, "崎").toLowerCase();

/** 社員を ID・ログイン ID・氏名 (空白は無視)・名字だけ (同じ名字がいなければ) で探す */
export function matchEmployee(users: User[], raw: string): { user?: User; error?: string } {
  const key = normName(raw);
  if (!key) return { error: "社員が空です" };
  const exact = users.filter((u) => u.id.toLowerCase() === key || u.email.toLowerCase() === key || normName(u.name) === key);
  if (exact.length === 1) return { user: exact[0] };
  if (exact.length > 1) return { error: `「${raw}」に当てはまる社員が ${exact.length} 人います (ログイン ID で指定してください)` };
  const prefix = users.filter((u) => normName(u.name).startsWith(key));
  if (prefix.length === 1) return { user: prefix[0] };
  if (prefix.length > 1) return { error: `「${raw}」に当てはまる社員が ${prefix.length} 人います (フルネームかログイン ID で指定してください)` };
  return { error: `「${raw}」に当てはまる社員がいません` };
}

export interface OpeningRow {
  line: number;
  raw: string;
  user?: User;
  /** 本年基準日 (当年度分の付与日) */
  baseDate?: string;
  /** 当年度分の残 */
  current: number;
  /** 繰越分の残 (前年の付与の残) */
  carry: number;
  /** 残日数の時点 (この日から使う) */
  asOf: string;
  /** 振休の残 (空 = 取り込まない) */
  comp?: number;
  errors: string[];
  warnings: string[];
}

/** 取込の列: 社員, 本年基準日, 当年度分の残, 繰越分の残, 時点, 振休の残 (タブ区切り・カンマ区切り。見出しの行は読み飛ばす) */
export const OPENING_COLUMNS = ["社員 (氏名・ログイン ID)", "本年基準日", "当年度分の残日数", "繰越分の残日数", "時点 (空 = 今日)", "振休の残日数 (任意)"];

function splitRows(text: string): string[][] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim());
  if (lines.some((l) => l.includes("\t"))) return lines.map((l) => l.split("\t"));
  return lines.map((l) => {
    const out: string[] = [];
    let cur = "";
    let q = false;
    for (let i = 0; i < l.length; i++) {
      const ch = l[i];
      if (q) {
        if (ch === '"' && l[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') q = false;
        else cur += ch;
      } else if (ch === '"' && !cur) q = true;
      else if (ch === ",") {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
    out.push(cur);
    return out;
  });
}

/** 切り替え時点の残日数 (有給管理表・休日出勤管理表) の読み取り。保存はしない */
export function parseOpeningImport(db: Pick<Database, "settings" | "users" | "stores">, text: string, today: string): OpeningRow[] {
  const users = leaveEmployees(db);
  const rows: OpeningRow[] = [];
  splitRows(text).forEach((cols, i) => {
    const c = (n: number) => (cols[n] ?? "").trim();
    // 見出しの行 (日数の列が数字でない) は読み飛ばす
    if (i === 0 && parseDaysLoose(c(2)) === undefined && !parseDateLoose(c(1))) return;
    const row: OpeningRow = { line: i + 1, raw: cols.join(" | "), current: 0, carry: 0, asOf: today, errors: [], warnings: [] };
    const who = matchEmployee(users, c(0));
    if (who.error) row.errors.push(who.error);
    row.user = who.user;
    const current = parseDaysLoose(c(2));
    const carry = parseDaysLoose(c(3));
    if (current === undefined) row.errors.push(`当年度分の残「${c(2)}」が読めません (0.5 日単位の数字)`);
    else row.current = current;
    if (carry === undefined) row.errors.push(`繰越分の残「${c(3)}」が読めません (0.5 日単位の数字)`);
    else row.carry = carry;
    if (c(4)) {
      const asOf = parseDateLoose(c(4));
      if (!asOf) row.errors.push(`時点「${c(4)}」が日付として読めません`);
      else row.asOf = asOf;
    }
    if (c(1)) {
      const b = parseDateLoose(c(1));
      if (!b) row.errors.push(`本年基準日「${c(1)}」が日付として読めません`);
      else row.baseDate = b;
    } else if (row.user) {
      // 基準日の列が空: 社員の設定 (基準日) から時点以前の最後の基準日
      const prof = leaveProfile(db, row.user);
      if (prof.baseDate) {
        const next = anniversaryAfter(prof.baseDate, row.asOf);
        const last = addYearsKey(next, -1);
        row.baseDate = last >= prof.baseDate ? last : prof.baseDate <= row.asOf ? prof.baseDate : undefined;
        if (row.baseDate) row.warnings.push(`本年基準日は社員の設定から ${row.baseDate.replace(/-/g, "/")} としました`);
      }
    }
    if (!row.baseDate && (row.current > 0 || row.carry > 0)) row.errors.push("本年基準日を入れてください (有給管理表の「本年基準日」。有効期限の計算に使います)");
    if (row.baseDate && row.baseDate > row.asOf) row.errors.push("本年基準日が時点より後になっています");
    if (row.baseDate && row.carry > 0 && grantExpiry(addYearsKey(row.baseDate, -1)) < row.asOf) row.warnings.push("繰越分は時点ですでに期限切れのため取り込みません");
    if (row.baseDate && row.current > 0 && grantExpiry(row.baseDate) < row.asOf) row.errors.push("本年基準日から 2 年を過ぎています (基準日を確かめてください)");
    if (c(5)) {
      const comp = parseDaysLoose(c(5));
      if (comp === undefined) row.errors.push(`振休の残「${c(5)}」が読めません (0.5 日単位の数字)`);
      else row.comp = comp;
    }
    rows.push(row);
  });
  const seen = new Map<string, number>();
  for (const r of rows) {
    if (!r.user) continue;
    if (seen.has(r.user.id)) r.errors.push(`${seen.get(r.user.id)} 行目と同じ社員です`);
    else seen.set(r.user.id, r.line);
  }
  return rows;
}

/** 取込の行から作る付与 (当年度分・繰越分。時点で期限切れのものは作らない) */
export function openingGrantParts(row: Pick<OpeningRow, "baseDate" | "current" | "carry" | "asOf">): { baseDate: string; days: number; expiresOn: string; note: string }[] {
  if (!row.baseDate) return [];
  const prev = addYearsKey(row.baseDate, -1);
  return [
    { baseDate: row.baseDate, days: row.current, expiresOn: grantExpiry(row.baseDate), note: "切り替え時点の残 (当年度分)" },
    { baseDate: prev, days: row.carry, expiresOn: grantExpiry(prev), note: "切り替え時点の残 (繰越分)" },
  ].filter((p) => p.days > 0 && p.expiresOn >= row.asOf);
}

/* ================================================================== */
/* 社員ごとの一覧 (残日数・振休・年 5 日・次の付与)                         */
/* ================================================================== */

export interface StaffLeaveRow {
  user: User;
  paid: PaidBalance;
  comp: CompBalance;
  obligation?: Obligation;
  next?: GrantSuggestion;
  pendingCount: number;
  /** 切り替え時点の残 (取込) の合計と時点 */
  opening?: { asOf: string; days: number };
}

export function staffLeaveRows(db: Database, users: User[], today: string): StaffLeaveRow[] {
  return users.map((u) => {
    const openings = db.leaveGrants.filter((g) => g.userId === u.id && g.kind === "opening");
    return {
      user: u,
      paid: paidBalance(db, u.id, today),
      comp: compBalance(db, u.id),
      obligation: annualObligation(db, u.id, today),
      next: suggestGrant(db, u, today),
      pendingCount: db.leaveRequests.filter((r) => r.userId === u.id && r.status === "pending").length,
      opening: openings.length ? { asOf: openings[0].grantDate, days: openings.reduce((s, g) => s + g.days, 0) } : undefined,
    };
  });
}

/* ================================================================== */
/* 予定表の「休暇」                                                      */
/* ================================================================== */

/** 承認した休暇の予定 (予定表の kind = leave。担当 = 本人、店舗 = 本人の所属。半日は時間帯つきで重複の確認に入る) */
export function leaveEventShape(db: Pick<Database, "settings" | "users">, req: Pick<LeaveRequest, "userId" | "storeId" | "leaveType" | "date" | "endDate" | "slot" | "number">): Omit<ScheduleEvent, "id" | "createdBy" | "createdAt"> {
  const s = hrSettings(db);
  const name = db.users.find((u) => u.id === req.userId)?.name ?? "";
  const half = req.slot !== "day";
  return {
    title: `${name} ${LEAVE_TYPE[req.leaveType].short}${half ? ` (${LEAVE_SLOT[req.slot]})` : ""}`,
    kind: "leave",
    date: req.date,
    endDate: !half && req.endDate && req.endDate > req.date ? req.endDate : undefined,
    startTime: half ? (req.slot === "am" ? s.amStart : s.pmStart) : undefined,
    endTime: half ? (req.slot === "am" ? s.amEnd : s.pmEnd) : undefined,
    slot: half ? (req.slot as "am" | "pm") : undefined,
    storeId: req.storeId,
    assigneeIds: [req.userId],
    source: "manual",
    memo: `休暇の申請 ${req.number} から登録 (有給・休日出勤の画面で取り消すと、この予定も消えます)`,
  };
}

/** 休暇の期間に入っている本人の予定 (承認の前の確認・承認後の重複の警告) */
export function leaveConflicts(db: Pick<Database, "settings" | "users" | "schedule">, req: Pick<LeaveRequest, "userId" | "storeId" | "leaveType" | "date" | "endDate" | "slot" | "number" | "eventId">): { event: ScheduleEvent; day: string; label: string }[] {
  const shape = leaveEventShape(db, req);
  const others = db.schedule.filter((e) => e.id !== req.eventId && e.kind !== "leave");
  return findConflicts(shape, others)
    .filter((h, i, all) => all.findIndex((x) => x.event.id === h.event.id) === i)
    .map((h) => ({ event: h.event, day: h.day, label: `${shortDate(h.day)} ${timeLabel(h.event)} ${h.event.title}` }));
}
