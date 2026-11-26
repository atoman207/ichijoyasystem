import type { AttendanceDay, AttendanceRequest, Database, HolidayWork, LeaveRequest, LeaveSlot, LeaveType, User } from "@/lib/db/types";
import { isClosedDay } from "@/lib/schedule-capacity";
import { lawHolidayName } from "@/lib/calendar";
import { closingRange, compBalance, hrSettings, leaveEmployees, paidRemainingOn, shiftDays, type HrSettings } from "./leave";

/**
 * 打刻・勤務表の計算 (キャスタイムの代わり。お客様のご要望 2026-11-26「勤怠管理システムを業務システムに統合」)
 * ------------------------------------------------------------
 * 社内総合マニュアルの事務タブ (給与〆・キャスタイム) の決まりをそのまま計算にする:
 * - 締め: 毎月 20 日 (11 月分 = 10/21〜11/20。有給・休日出勤の hr_leave の closingDay)
 * - シフト (始業・終業・休憩 3 つまで)。休憩は「その時間に働いていた (出勤〜退勤の中にまるごと入る) ときだけ」引く
 *   (早退・遅刻で休憩をとっていない時間は労働。マニュアルの「早退は休憩時間を修正」を自動で)
 * - 遅刻・早退 = シフトの勤務時間のうち、出勤前・退勤後の時間 (休憩を除く)。半日の休暇の日はその半分を勤務時間から外す
 * - シフト外残業 = 終業より後に働いた時間 (始業より前は設定 countEarlyStart のときだけ)。
 *   労務士へ送る「残業」= 締めの期間のシフト外残業の合計 − 固定残業 (職人 30 時間・事務 20 時間)
 * - 深夜 = 22:00〜翌 5:00 に働いた時間 (固定残業に関係なく備考に「深夜残業」)
 * - 全日欠勤 = 出勤日 (会社の休業日でない日) に打刻も終日の休暇もない日 (打刻を使い始めた日 startDate から。パートは数えない)
 * - 休日 (会社の休業日) の打刻は休日出勤の申請の承認 (holiday_works) があるときだけ出勤に数える (キャスタイムと同じ)
 * - 法定休日 = 毎週の決まった曜日 (既定 日曜) の休業日、ほかの休業日は所定休日
 * import は型と純粋な関数だけ (画面・操作・テストで共通)
 */

export const ATTENDANCE_SETTINGS_ID = "attendance_settings";

/** 申請の種類の名前 */
export const KIND_LABEL = { correction: "打刻修正", holiday_work: "休日出勤" } as const;

/** officer = 役員 (労務士へ送る勤務表に出さない) / craft = 社員 (職人) / office = 社員 (事務) / part = パート */
export type StaffCategory = "officer" | "craft" | "office" | "part";
export const STAFF_CATEGORY: Record<StaffCategory, { label: string; short: string }> = {
  craft: { label: "社員 (職人)", short: "職人" },
  office: { label: "社員 (事務)", short: "事務" },
  part: { label: "パート", short: "パート" },
  officer: { label: "役員 (勤務表に出さない)", short: "役員" },
};
export const STAFF_CATEGORIES = Object.keys(STAFF_CATEGORY) as StaffCategory[];

export interface ShiftBreak {
  start: string;
  end: string;
}

export interface ShiftDef {
  id: string;
  name: string;
  start: string;
  end: string;
  breaks: ShiftBreak[];
}

export interface RateChange {
  /** この日から */
  from: string;
  yen: number;
}

export interface StaffProfile {
  category?: StaffCategory;
  /** 労務士の勤務表の No (社員番号) */
  employeeNo?: string;
  shiftId?: string;
  /** 固定残業 (時間/月)。空 = 職人・事務の既定 */
  fixedOvertimeHours?: number;
  /** パートの時給 (変更の履歴) */
  rates?: RateChange[];
}

export type IncentivePay = "cash" | "salary";
export type IncentivePeriod = "prev_month" | "closing";

export interface IncentiveRule {
  enabled: boolean;
  /** 1 件・1 点あたりの円 */
  yen: number;
  /** prev_month = 前月の 1 日〜末日 (口コミと同じ) / closing = 勤怠の締めの期間 (21 日〜20 日) */
  period: IncentivePeriod;
  /** cash = インセンティブ (現金) = 労務士側で控除 / salary = インセンティブ (成果給) */
  pay: IncentivePay;
}

export interface AllowanceRule {
  enabled: boolean;
  pay: IncentivePay;
  /** この月まで支給 (空 = 続ける)。事務の伝票件数の手当を廃止するとき */
  until?: string;
}

export interface AttendanceSettings {
  /** 打刻を使い始めた日 (この日より前は欠勤・打刻漏れを数えない。空 = まだ使っていない) */
  startDate: string;
  shifts: ShiftDef[];
  /** 既定のシフト (社員・パート) */
  defaultShift: { staff: string; part: string };
  /** 法定休日の曜日 (0 = 日曜) */
  legalHolidayWeekday: number;
  /** 固定残業 (時間/月) */
  fixedOvertime: { craft: number; office: number };
  /** 始業より前に働いた時間もシフト外残業に数える */
  countEarlyStart: boolean;
  nightStart: string;
  nightEnd: string;
  profiles: Record<string, StaffProfile>;
  sharoushi: { name: string; to: string; cc: string; subject: string; body: string };
  incentives: {
    /** Google 口コミ (星・コメント・写真 1 点 = 1,000 円) */
    review: IncentiveRule;
    /** 点検 (点検の電話をした人。お客様宅に行った件数 × 500 円) */
    inspection: IncentiveRule;
    /** 月間人日 (店舗。KPI の月次の手当) */
    manDay: AllowanceRule;
    /** 伝票件数 (事務。KPI の月次の手当) */
    slip: AllowanceRule;
  };
}

const SHIFT_STAFF: ShiftDef = { id: "staff", name: "社員", start: "08:00", end: "17:00", breaks: [{ start: "10:30", end: "10:45" }, { start: "12:00", end: "13:00" }, { start: "14:30", end: "14:45" }] };
const SHIFT_PART: ShiftDef = { id: "part", name: "パート", start: "08:00", end: "17:00", breaks: [{ start: "10:30", end: "10:40" }, { start: "12:00", end: "13:00" }, { start: "14:30", end: "14:40" }] };

export const ATTENDANCE_DEFAULTS: AttendanceSettings = {
  startDate: "",
  shifts: [SHIFT_STAFF, SHIFT_PART],
  defaultShift: { staff: "staff", part: "part" },
  legalHolidayWeekday: 0,
  fixedOvertime: { craft: 30, office: 20 },
  countEarlyStart: false,
  nightStart: "22:00",
  nightEnd: "05:00",
  profiles: {},
  sharoushi: {
    name: "",
    to: "",
    cc: "",
    subject: "{月}分 出勤簿 ({会社})",
    body: "{宛名}\n\nいつもお世話になっております。{会社}です。\n{月}分の出勤簿をお送りします (締め {期間})。\nご確認のほど、よろしくお願いいたします。",
  },
  incentives: {
    review: { enabled: true, yen: 1000, period: "prev_month", pay: "cash" },
    inspection: { enabled: true, yen: 500, period: "prev_month", pay: "cash" },
    manDay: { enabled: true, pay: "cash" },
    slip: { enabled: true, pay: "cash" },
  },
};

export const HM_RE = /^([01]?\d|2\d):([0-5]\d)$/;
const isHm = (v: unknown, max = 29 * 60 + 59): v is string => typeof v === "string" && HM_RE.test(v) && toMin(v) <= max;
const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const num = (v: unknown, min: number, max: number) => (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : undefined);

/** "08:30" → 510 (24:00 以降も読む = 翌日) */
export function toMin(hm: string): number {
  const [h, m] = hm.split(":").map(Number);
  return h * 60 + m;
}

/** 510 → "8:30" (勤務表の書き方。0 は "0:00") */
export function fmtHm(min: number): string {
  const m = Math.max(0, Math.round(min));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}

/** 510 → "08:30" (時刻の欄) */
export function clock(min: number): string {
  const m = Math.max(0, Math.round(min));
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

function cleanShift(v: unknown, fallback: ShiftDef): ShiftDef | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const id = str(o.id, 40).replace(/[^a-z0-9_-]/gi, "");
  if (!id) return null;
  const start = isHm(o.start, 24 * 60) ? o.start : fallback.start;
  const end = isHm(o.end) ? o.end : fallback.end;
  if (toMin(end) <= toMin(start)) return null;
  const breaks = (Array.isArray(o.breaks) ? o.breaks : [])
    .map((b) => (b && typeof b === "object" ? (b as Record<string, unknown>) : {}))
    .filter((b) => isHm(b.start) && isHm(b.end) && toMin(b.end as string) > toMin(b.start as string))
    .map((b) => ({ start: b.start as string, end: b.end as string }))
    .sort((a, b) => toMin(a.start) - toMin(b.start))
    .slice(0, 5);
  return { id, name: str(o.name, 40) || id, start, end, breaks };
}

function cleanRule(v: unknown, d: IncentiveRule): IncentiveRule {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return {
    enabled: typeof o.enabled === "boolean" ? o.enabled : d.enabled,
    yen: num(o.yen, 0, 1_000_000) ?? d.yen,
    period: o.period === "closing" || o.period === "prev_month" ? o.period : d.period,
    pay: o.pay === "salary" || o.pay === "cash" ? o.pay : d.pay,
  };
}

function cleanAllowance(v: unknown, d: AllowanceRule): AllowanceRule {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const until = typeof o.until === "string" && /^\d{4}-\d{2}$/.test(o.until) ? o.until : undefined;
  return { enabled: typeof o.enabled === "boolean" ? o.enabled : d.enabled, pay: o.pay === "salary" || o.pay === "cash" ? o.pay : d.pay, until };
}

/** 設定を読む (壊れた値は既定値) */
export function attendanceSettings(db: Pick<Database, "settings">): AttendanceSettings {
  const d = ATTENDANCE_DEFAULTS;
  const v = ((db.settings ?? []).find((s) => s.id === ATTENDANCE_SETTINGS_ID)?.value ?? {}) as Record<string, unknown>;
  const shifts = (Array.isArray(v.shifts) ? v.shifts : []).map((x) => cleanShift(x, SHIFT_STAFF)).filter((x): x is ShiftDef => Boolean(x));
  const ids = new Set<string>();
  const uniq = shifts.filter((s) => (ids.has(s.id) ? false : (ids.add(s.id), true)));
  const list = uniq.length ? uniq : d.shifts;
  const ds = (v.defaultShift ?? {}) as Record<string, unknown>;
  const pick = (x: unknown, fb: string) => (typeof x === "string" && list.some((s) => s.id === x) ? x : list.some((s) => s.id === fb) ? fb : list[0].id);
  const fo = (v.fixedOvertime ?? {}) as Record<string, unknown>;
  const sh = (v.sharoushi ?? {}) as Record<string, unknown>;
  const inc = (v.incentives ?? {}) as Record<string, unknown>;
  const profiles: Record<string, StaffProfile> = {};
  for (const [id, raw] of Object.entries((v.profiles ?? {}) as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const p = raw as Record<string, unknown>;
    const category = typeof p.category === "string" && p.category in STAFF_CATEGORY ? (p.category as StaffCategory) : undefined;
    const rates = (Array.isArray(p.rates) ? p.rates : [])
      .map((r) => (r && typeof r === "object" ? (r as Record<string, unknown>) : {}))
      .filter((r) => isDate(r.from) && num(r.yen, 1, 100_000) !== undefined)
      .map((r) => ({ from: r.from as string, yen: r.yen as number }))
      .sort((a, b) => a.from.localeCompare(b.from));
    const prof: StaffProfile = {
      category,
      employeeNo: str(p.employeeNo, 20) || undefined,
      shiftId: typeof p.shiftId === "string" && list.some((s) => s.id === p.shiftId) ? p.shiftId : undefined,
      fixedOvertimeHours: num(p.fixedOvertimeHours, 0, 200),
      rates: rates.length ? rates : undefined,
    };
    if (Object.values(prof).some((x) => x !== undefined)) profiles[id] = prof;
  }
  return {
    startDate: isDate(v.startDate) ? v.startDate : "",
    shifts: list,
    defaultShift: { staff: pick(ds.staff, d.defaultShift.staff), part: pick(ds.part, d.defaultShift.part) },
    legalHolidayWeekday: num(v.legalHolidayWeekday, 0, 6) ?? d.legalHolidayWeekday,
    fixedOvertime: { craft: num(fo.craft, 0, 200) ?? d.fixedOvertime.craft, office: num(fo.office, 0, 200) ?? d.fixedOvertime.office },
    countEarlyStart: typeof v.countEarlyStart === "boolean" ? v.countEarlyStart : d.countEarlyStart,
    nightStart: isHm(v.nightStart, 24 * 60) ? v.nightStart : d.nightStart,
    nightEnd: isHm(v.nightEnd, 12 * 60) ? v.nightEnd : d.nightEnd,
    profiles,
    sharoushi: {
      name: str(sh.name, 80),
      to: str(sh.to, 200),
      cc: str(sh.cc, 300),
      subject: str(sh.subject, 200) || d.sharoushi.subject,
      body: typeof sh.body === "string" && sh.body.trim() ? sh.body.slice(0, 4000) : d.sharoushi.body,
    },
    incentives: {
      review: cleanRule(inc.review, d.incentives.review),
      inspection: cleanRule(inc.inspection, d.incentives.inspection),
      manDay: cleanAllowance(inc.manDay, d.incentives.manDay),
      slip: cleanAllowance(inc.slip, d.incentives.slip),
    },
  };
}

/* ================================================================== */
/* 社員の区分・シフト                                                     */
/* ================================================================== */

type ProfileUser = Pick<User, "id" | "role">;

/** 社員の区分 (設定がなければ 管理者 = 役員・事務担当 = 事務・ほか = 職人) */
export function staffCategory(s: AttendanceSettings, user: ProfileUser, clerkIds: readonly string[] = []): StaffCategory {
  const c = s.profiles[user.id]?.category;
  if (c) return c;
  if (user.role === "admin") return "officer";
  if (clerkIds.includes(user.id)) return "office";
  return "craft";
}

export function shiftOf(s: AttendanceSettings, user: ProfileUser, clerkIds: readonly string[] = []): ShiftDef {
  const id = s.profiles[user.id]?.shiftId ?? (staffCategory(s, user, clerkIds) === "part" ? s.defaultShift.part : s.defaultShift.staff);
  return s.shifts.find((x) => x.id === id) ?? s.shifts[0];
}

/** 固定残業 (分/月)。パート・役員は 0 */
export function fixedOvertimeMin(s: AttendanceSettings, user: ProfileUser, clerkIds: readonly string[] = []): number {
  const c = staffCategory(s, user, clerkIds);
  if (c === "part" || c === "officer") return 0;
  const h = s.profiles[user.id]?.fixedOvertimeHours ?? (c === "office" ? s.fixedOvertime.office : s.fixedOvertime.craft);
  return Math.round(h * 60);
}

/** その日の時給 (パート) と、期間の中で変わったときの変更日 */
export function hourlyRateOn(s: AttendanceSettings, userId: string, date: string): RateChange | undefined {
  const rates = s.profiles[userId]?.rates ?? [];
  let cur: RateChange | undefined;
  for (const r of rates) if (r.from <= date) cur = r;
  return cur;
}

/* ================================================================== */
/* 日の種類                                                              */
/* ================================================================== */

/** work = 出勤日 / scheduled_off = 所定休日 / legal_off = 法定休日 */
export type DayType = "work" | "scheduled_off" | "legal_off";
export const DAY_TYPE: Record<DayType, string> = { work: "出勤日", scheduled_off: "所定休日", legal_off: "法定休日" };

export const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
export const WEEKDAY_JA = ["日", "月", "火", "水", "木", "金", "土"];

export function dayTypeOf(db: Pick<Database, "holidays">, s: AttendanceSettings, date: string): DayType {
  if (!isClosedDay(db, date)) return "work";
  return weekdayOf(date) === s.legalHolidayWeekday ? "legal_off" : "scheduled_off";
}

/* ================================================================== */
/* 1 日の計算                                                             */
/* ================================================================== */

/** ISO の時刻 → その勤務日の 0 時からの分 (翌日は 1440 以上)。サーバーは日本時間 */
export function minutesOnDay(iso: string | undefined, date: string): number | undefined {
  if (!iso) return undefined;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return undefined;
  const base = new Date(`${date}T00:00:00`);
  return Math.round((t.getTime() - base.getTime()) / 60000);
}

/** 勤務日の分 → ISO (日本時間の勤務日の 0 時から) */
export function isoOnDay(date: string, min: number): string {
  const base = new Date(`${date}T00:00:00`);
  return new Date(base.getTime() + min * 60000).toISOString();
}

const overlap = (a1: number, a2: number, b1: number, b2: number) => Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));

export interface DayLeave {
  type: LeaveType;
  slot: LeaveSlot;
  /** 理由 (特別休暇の「忌引き」など) */
  reason?: string;
  requestId: string;
}

export interface DayBreak {
  index: number;
  start: number;
  end: number;
  /** 引いた (出勤〜退勤の中にまるごと入っている) */
  counted: boolean;
  /** 外した (申請・承認で「休憩をとらなかった」) */
  skipped: boolean;
}

export interface DayCalc {
  date: string;
  dayType: DayType;
  holiday?: string;
  shift: ShiftDef;
  /** 勤務すべき時間 (半日の休暇・半日の休日出勤で狭くなる) */
  window?: { start: number; end: number };
  leaves: DayLeave[];
  /** 終日の休暇 (午前 + 午後を含む) */
  fullLeave: boolean;
  holidayWork?: Pick<HolidayWork, "id" | "slot" | "days">;
  inMin?: number;
  outMin?: number;
  breaks: DayBreak[];
  breakMin: number;
  workedMin: number;
  lateMin: number;
  earlyMin: number;
  outsideMin: number;
  nightMin: number;
  /** 出勤日数に数える */
  attended: boolean;
  /** 全日欠勤 */
  absent: boolean;
  /** 打刻漏れ (過ぎた日の出勤だけ・退勤だけ) */
  missing?: "in" | "out";
  /** 出勤中 (今日・退勤前) */
  working: boolean;
  pending: AttendanceRequest[];
  warnings: string[];
  record?: AttendanceDay;
}

export interface DayContext {
  db: Pick<Database, "holidays">;
  s: AttendanceSettings;
  hr: Pick<HrSettings, "amStart" | "amEnd" | "pmStart" | "pmEnd">;
  category: StaffCategory;
  shift: ShiftDef;
  today: string;
}

/** 1 日の勤怠を計算する (純粋な関数) */
export function calcDay(
  ctx: DayContext,
  date: string,
  input: { record?: AttendanceDay; leaves: DayLeave[]; holidayWork?: Pick<HolidayWork, "id" | "slot" | "days">; pending?: AttendanceRequest[] },
): DayCalc {
  const { s, hr, shift, today, category } = ctx;
  const dayType = dayTypeOf(ctx.db, s, date);
  const holiday = lawHolidayName(date);
  const leaves = input.leaves;
  const am = leaves.some((l) => l.slot === "am" || l.slot === "day");
  const pm = leaves.some((l) => l.slot === "pm" || l.slot === "day");
  const fullLeave = am && pm;
  const rec = input.record;
  const inMin = minutesOnDay(rec?.clockIn, date);
  const outMin = minutesOnDay(rec?.clockOut, date);
  const skip = new Set(rec?.skipBreaks ?? []);
  const warnings: string[] = [];
  const hw = input.holidayWork;
  const off = dayType !== "work";

  // 勤務すべき時間
  let window: { start: number; end: number } | undefined;
  if (!off && !fullLeave) {
    let ws = toMin(shift.start);
    let we = toMin(shift.end);
    if (am) ws = Math.max(ws, toMin(hr.pmStart));
    if (pm) we = Math.min(we, toMin(hr.amEnd));
    if (we > ws) window = { start: ws, end: we };
  } else if (off && hw) {
    let ws = toMin(shift.start);
    let we = toMin(shift.end);
    if (hw.slot === "am") we = Math.min(we, toMin(hr.amEnd));
    if (hw.slot === "pm") ws = Math.max(ws, toMin(hr.pmStart));
    if (we > ws) window = { start: ws, end: we };
  }

  const shiftBreaks = shift.breaks.map((b, index) => ({ index, start: toMin(b.start), end: toMin(b.end) }));
  // 勤務すべき時間の中の休憩 (遅刻・早退の計算に使う)
  const inWindow = window ? shiftBreaks.filter((b) => !skip.has(b.index) && b.start >= window!.start && b.end <= window!.end) : [];
  const sched = (a: number, b: number) => {
    if (!window || b <= a) return 0;
    const span = overlap(a, b, window.start, window.end);
    return Math.max(0, span - inWindow.reduce((t, br) => t + overlap(a, b, br.start, br.end), 0));
  };

  const hasIn = inMin !== undefined;
  const hasOut = outMin !== undefined && (!hasIn || outMin > inMin!);
  const past = date < today;
  const started = Boolean(s.startDate) && date >= s.startDate;
  const breaks: DayBreak[] = shiftBreaks.map((b) => ({
    ...b,
    skipped: skip.has(b.index),
    counted: hasIn && hasOut && !skip.has(b.index) && b.start >= inMin! && b.end <= outMin!,
  }));
  const breakMin = breaks.filter((b) => b.counted).reduce((t, b) => t + (b.end - b.start), 0);
  let workedMin = 0;
  let lateMin = 0;
  let earlyMin = 0;
  let outsideMin = 0;
  let nightMin = 0;
  let missing: DayCalc["missing"];
  let working = false;
  let attended = false;
  let absent = false;

  if (hasIn && hasOut) {
    workedMin = Math.max(0, outMin! - inMin! - breakMin);
    const ns = toMin(s.nightStart);
    const ne = toMin(s.nightEnd);
    nightMin = overlap(inMin!, outMin!, ns, 1440 + ne) + overlap(inMin!, outMin!, 0, ne) + overlap(inMin!, outMin!, 1440 + ns, 2880);
    if (window) {
      if (!off) {
        if (inMin! > window.start) lateMin = sched(window.start, Math.min(inMin!, window.end));
        if (outMin! < window.end) earlyMin = sched(Math.max(outMin!, window.start), window.end);
      }
      outsideMin = Math.max(0, outMin! - Math.max(window.end, inMin!));
      if (s.countEarlyStart) outsideMin += Math.max(0, Math.min(outMin!, window.start) - inMin!);
    } else if (off) {
      outsideMin = 0;
    }
  } else if (hasIn && !hasOut) {
    if (past) missing = "out";
    else working = true;
  } else if (!hasIn && outMin !== undefined) {
    missing = "in";
  }

  if (off) {
    attended = Boolean(hw) && (hasIn || hasOut);
    if ((hasIn || hasOut) && !hw) warnings.push(`${DAY_TYPE[dayType]}に打刻があります (休日出勤の申請がまだ承認されていません)`);
    if (hw && !hasIn && !hasOut && past) warnings.push("休日出勤の日の打刻がありません");
  } else {
    attended = hasIn || hasOut;
    if (!hasIn && !hasOut && past && started && category !== "part" && category !== "officer") {
      if (!am && !pm) absent = true;
      else if (window) earlyMin = sched(window.start, window.end); // 半日休暇で残りの半日に来ていない = 欠勤の時間
    }
    if (fullLeave && (hasIn || hasOut)) warnings.push("終日の休暇の日に打刻があります");
  }
  if (missing === "out") warnings.push("退勤の打刻がありません (打刻修正の申請をしてください)");
  if (missing === "in") warnings.push("出勤の打刻がありません (打刻修正の申請をしてください)");
  // 勤務時間の計算に使えない打刻漏れの日は、出勤日数には数えるが時間は 0 (直すまで勤務表の確認で止める)
  if (missing) {
    workedMin = 0;
    outsideMin = 0;
    nightMin = 0;
  }
  return {
    date,
    dayType,
    holiday,
    shift,
    window,
    leaves,
    fullLeave,
    holidayWork: hw,
    inMin,
    outMin,
    breaks,
    breakMin,
    workedMin,
    lateMin,
    earlyMin,
    outsideMin,
    nightMin,
    attended,
    absent,
    missing,
    working,
    pending: input.pending ?? [],
    warnings,
    record: rec,
  };
}

/* ================================================================== */
/* 期間 (締め)                                                            */
/* ================================================================== */

type PeriodDb = Pick<Database, "holidays" | "settings" | "leaveRequests" | "leaveGrants" | "holidayWorks" | "attendanceDays" | "attendanceRequests">;

export const dayRecordId = (userId: string, date: string) => `ad_${userId}_${date}`;

/** 期間の日付の一覧 */
export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 400; d = shiftDays(d, 1)) out.push(d);
  return out;
}

/** 承認済みの休暇を日ごとに (終日・午前・午後) */
export function leavesByDate(reqs: LeaveRequest[], userId: string, from: string, to: string): Map<string, DayLeave[]> {
  const out = new Map<string, DayLeave[]>();
  for (const r of reqs) {
    if (r.userId !== userId || r.status !== "approved") continue;
    for (const d of r.dates) {
      if (d < from || d > to) continue;
      out.set(d, [...(out.get(d) ?? []), { type: r.leaveType, slot: r.slot, reason: r.reason, requestId: r.id }]);
    }
  }
  return out;
}

export interface PeriodSummary {
  userId: string;
  from: string;
  to: string;
  category: StaffCategory;
  shift: ShiftDef;
  days: DayCalc[];
  attendDays: number;
  absentDays: number;
  lateMin: number;
  earlyMin: number;
  outsideMin: number;
  nightMin: number;
  workedMin: number;
  fixedMin: number;
  /** 労務士へ送る残業 (シフト外残業 − 固定残業) */
  overtimeMin: number;
  paidDays: number;
  compDays: number;
  specialDays: number;
  specialReasons: string[];
  holidayWorkDays: number;
  missing: number;
  pendingRequests: number;
  warnings: number;
  paidRemaining: number;
  compRemaining: number;
}

const half = (slot: LeaveSlot) => (slot === "day" ? 1 : 0.5);

/** 1 人の締めの期間をまとめて計算する */
export function periodSummary(db: PeriodDb, user: Pick<User, "id" | "role">, from: string, to: string, today: string, clerkIds: readonly string[] = []): PeriodSummary {
  const s = attendanceSettings(db);
  const hr = hrSettings(db);
  const category = staffCategory(s, user, clerkIds);
  const shift = shiftOf(s, user, clerkIds);
  const ctx: DayContext = { db, s, hr, category, shift, today };
  const records = new Map((db.attendanceDays ?? []).filter((r) => r.userId === user.id && r.date >= from && r.date <= to).map((r) => [r.date, r]));
  const leaves = leavesByDate(db.leaveRequests ?? [], user.id, from, to);
  const works = new Map((db.holidayWorks ?? []).filter((w) => w.userId === user.id && w.kind === "work" && w.date >= from && w.date <= to).map((w) => [w.date, w]));
  const pending = (db.attendanceRequests ?? []).filter((r) => r.userId === user.id && r.status === "pending" && r.date >= from && r.date <= to);
  const days = datesBetween(from, to).map((d) => calcDay(ctx, d, { record: records.get(d), leaves: leaves.get(d) ?? [], holidayWork: works.get(d), pending: pending.filter((p) => p.date === d) }));
  let paidDays = 0;
  let compDays = 0;
  let specialDays = 0;
  const specialReasons: string[] = [];
  for (const d of days) {
    for (const l of d.leaves) {
      if (l.type === "paid") paidDays += half(l.slot);
      else if (l.type === "comp") compDays += half(l.slot);
      else {
        specialDays += half(l.slot);
        if (l.reason && !specialReasons.includes(l.reason)) specialReasons.push(l.reason);
      }
    }
  }
  const sum = (f: (d: DayCalc) => number) => days.reduce((t, d) => t + f(d), 0);
  const fixedMin = fixedOvertimeMin(s, user, clerkIds);
  const outsideMin = sum((d) => d.outsideMin);
  const leaveDb = db as Database;
  return {
    userId: user.id,
    from,
    to,
    category,
    shift,
    days,
    attendDays: days.filter((d) => d.attended).length,
    absentDays: days.filter((d) => d.absent).length,
    lateMin: sum((d) => d.lateMin),
    earlyMin: sum((d) => d.earlyMin),
    outsideMin,
    nightMin: sum((d) => d.nightMin),
    workedMin: sum((d) => d.workedMin),
    fixedMin,
    overtimeMin: category === "part" || category === "officer" ? 0 : Math.max(0, outsideMin - fixedMin),
    paidDays,
    compDays,
    specialDays,
    specialReasons,
    holidayWorkDays: [...works.values()].reduce((t, w) => t + w.days, 0),
    missing: days.filter((d) => d.missing).length,
    pendingRequests: pending.length,
    warnings: days.reduce((t, d) => t + d.warnings.length, 0),
    paidRemaining: paidRemainingOn(leaveDb, user.id, to),
    compRemaining: compBalance(leaveDb, user.id).remaining,
  };
}

/** 勤怠の月 (YYYY-MM) の締めの期間 */
export function attendancePeriod(db: Pick<Database, "settings">, yearMonth: string): { from: string; to: string } {
  return closingRange(yearMonth, hrSettings(db).closingDay);
}

/** 今日が入っている勤怠の月 (20 日締め: 11/21 → 12 月分) */
export function attendanceMonthOf(db: Pick<Database, "settings">, date: string): string {
  const closing = hrSettings(db).closingDay;
  const ym = date.slice(0, 7);
  if (closing >= 28) return ym;
  if (Number(date.slice(8, 10)) <= closing) return ym;
  const [y, m] = ym.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

export function shiftMonth(ym: string, n: number): string {
  const [y, m] = ym.split("-").map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}

/** 給与の支給日 (月末。土日・祝日なら前の平日。マニュアル「月末が土日の場合は前の金曜日」) */
export function payDayOf(yearMonth: string): string {
  const [y, m] = yearMonth.split("-").map(Number);
  let d = `${yearMonth}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
  for (let i = 0; i < 7; i++) {
    const wd = weekdayOf(d);
    if (wd !== 0 && wd !== 6 && !lawHolidayName(d)) break;
    d = shiftDays(d, -1);
  }
  return d;
}

/** 「11/30支給」 */
export const payLabelOf = (yearMonth: string) => {
  const d = payDayOf(yearMonth);
  return `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}支給`;
};

/** 打刻漏れ・休日の打刻などの注意がある日 (本人の打刻の画面・ヘッダーの数) */
export function attentionDays(db: PeriodDb, user: Pick<User, "id" | "role">, today: string, clerkIds: readonly string[] = [], lookbackDays = 35): DayCalc[] {
  const s = attendanceSettings(db);
  if (!s.startDate) return [];
  const from = [shiftDays(today, -lookbackDays), s.startDate].sort().at(-1)!;
  const to = shiftDays(today, -1);
  if (to < from) return [];
  return periodSummary(db, user, from, to, today, clerkIds).days.filter((d) => (d.missing || d.warnings.length) && d.pending.length === 0);
}

/** 打刻の対象の社員 (有効なアカウント) */
export function attendanceEmployees(db: Pick<Database, "users" | "stores">): User[] {
  return leaveEmployees(db);
}
