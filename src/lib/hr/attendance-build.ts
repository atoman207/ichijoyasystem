import type { AttendanceLine, AttendanceLineCalc, AttendanceMonth, Database, User } from "@/lib/db/types";
import { kpiSettings } from "@/lib/kpi-settings";
import { documentSettings } from "@/lib/doc-settings";
import { fmtDays } from "./leave";
import { attendanceEmployees, attendancePeriod, attendanceSettings, fmtHm, hourlyRateOn, payLabelOf, periodSummary, staffCategory, type PeriodSummary } from "./timecard";
import { incentiveNote, monthIncentives, type MonthIncentives } from "./incentive-month";

/**
 * 労務士へ送る勤務表 (田仲労務士書式) を打刻・休暇・インセンティブから作る
 * ------------------------------------------------------------
 * 社内総合マニュアルの対応表 (キャスタイム → 労務士の書式) のとおり:
 * 出勤日数 = 出勤した日 (休日出勤を含む) / 欠勤 = 全日欠勤 / 遅刻・早退 = 遅刻 + 早退 (半日休暇の残りの半日に来ていない時間を含む) /
 * 残業 = シフト外残業 − 固定残業 (職人 30 時間・事務 20 時間) / 有給 = 有給の日数 / パートの出勤時間 = 勤務の時間 /
 * 備考 = 振休消化・休日出勤・独自休暇 (特別休暇の理由)・深夜残業 と インセンティブ (成果給)・インセンティブ (現金)
 * 役員は載せない。並びは前の月の表の順 (労務士が見慣れた順) → 新しい社員は後ろ
 */

export type BuiltLine = Omit<AttendanceLine, "id" | "monthId" | "createdAt" | "updatedAt"> & { calc: AttendanceLineCalc };

type BuildDb = Database;

const days = (n: number) => fmtDays(n).replace(" 日", "日");

/** 備考 (休暇・休日出勤・深夜 → 改行 → インセンティブ) */
export function noteFor(sum: Pick<PeriodSummary, "compDays" | "holidayWorkDays" | "specialDays" | "specialReasons" | "nightMin">, incentive: string[]): string | undefined {
  const a: string[] = [];
  if (sum.compDays > 0) a.push(`振休消化${days(sum.compDays)}`);
  if (sum.holidayWorkDays > 0) a.push(`休日出勤${days(sum.holidayWorkDays)}`);
  if (sum.specialDays > 0) a.push(sum.specialReasons.length ? `独自休暇${days(sum.specialDays)}（${sum.specialReasons.join("・")}）` : `独自休暇${days(sum.specialDays)}`);
  if (sum.nightMin > 0) a.push(`深夜残業${fmtHm(sum.nightMin)}`);
  const parts = [a.join(" "), incentive.join(" ")].filter(Boolean);
  return parts.length ? parts.join("\n") : undefined;
}

/** 前の月の表の並び (社員 ID → 順番・社員番号) */
function previousOrder(db: BuildDb, yearMonth: string): { order: Map<string, number>; numbers: Map<string, string> } {
  const months = [...(db.attendanceMonths ?? [])].filter((m) => m.yearMonth < yearMonth).sort((a, b) => b.yearMonth.localeCompare(a.yearMonth));
  const order = new Map<string, number>();
  const numbers = new Map<string, string>();
  for (const m of months) {
    const lines = (db.attendanceLines ?? []).filter((l) => l.monthId === m.id && l.userId).sort((a, b) => a.sort - b.sort);
    for (const l of lines) {
      if (!order.has(l.userId!)) order.set(l.userId!, order.size);
      if (l.employeeNo && !numbers.has(l.userId!)) numbers.set(l.userId!, l.employeeNo);
    }
    if (order.size) break;
  }
  // 社員番号はもっと前の表にもあれば使う
  for (const l of db.attendanceLines ?? []) if (l.userId && l.employeeNo && !numbers.has(l.userId)) numbers.set(l.userId, l.employeeNo);
  return { order, numbers };
}

export interface BuiltMonth {
  yearMonth: string;
  from: string;
  to: string;
  payLabel: string;
  lines: BuiltLine[];
  incentives: MonthIncentives;
  summaries: Map<string, PeriodSummary>;
  /** 送る前に確かめること (打刻漏れ・未承認の申請・設定) */
  warnings: string[];
}

/** 勤務表の月を作る (書き込まない) */
export function buildAttendanceMonth(db: BuildDb, yearMonth: string, today: string): BuiltMonth {
  const s = attendanceSettings(db);
  const clerks = kpiSettings(db).clerkUserIds;
  const { from, to } = attendancePeriod(db, yearMonth);
  const users = attendanceEmployees(db).filter((u) => staffCategory(s, u, clerks) !== "officer");
  const incentives = monthIncentives(db, yearMonth, users, today, s);
  const { order, numbers } = previousOrder(db, yearMonth);
  const sorted = [...users].sort((a, b) => {
    const ca = staffCategory(s, a, clerks) === "part" ? 1 : 0;
    const cb = staffCategory(s, b, clerks) === "part" ? 1 : 0;
    return ca - cb || (order.get(a.id) ?? 1000 + users.indexOf(a)) - (order.get(b.id) ?? 1000 + users.indexOf(b));
  });
  const warnings: string[] = [];
  if (!s.startDate) warnings.push("打刻を使い始めた日が設定されていません (設定 → 打刻を使い始めた日)。欠勤・打刻漏れは数えていません。");
  else if (s.startDate > from) warnings.push(`打刻を使い始めた日 (${s.startDate}) より前の日は、欠勤・打刻漏れを数えていません。`);
  if (to >= today) warnings.push(`締めの日 (${to}) がまだ来ていません。今日までの打刻で作っています。`);
  const summaries = new Map<string, PeriodSummary>();
  const lines: BuiltLine[] = sorted.map((u: User, i) => {
    const sum = periodSummary(db, u, from, to, today, clerks);
    summaries.set(u.id, sum);
    const inc = incentives.persons.get(u.id);
    const part = sum.category === "part";
    const w: string[] = [];
    if (sum.missing) w.push(`打刻漏れ ${sum.missing} 日`);
    if (sum.pendingRequests) w.push(`未承認の申請 ${sum.pendingRequests} 件`);
    const offPunch = sum.days.filter((d) => d.dayType !== "work" && !d.holidayWork && (d.inMin !== undefined || d.outMin !== undefined)).length;
    if (offPunch) w.push(`休日の打刻 (休日出勤の申請なし) ${offPunch} 日`);
    if (part && !hourlyRateOn(s, u.id, to)) w.push("時給が未設定");
    for (const x of w) warnings.push(`${u.name}: ${x}`);
    const rate = part ? hourlyRateOn(s, u.id, to) : undefined;
    const rateChanged = rate && rate.from > from && rate.from <= to;
    const baseNote = noteFor(sum, incentiveNote(inc));
    const note = [baseNote, rateChanged ? `時給変更${rate!.from.replace(/-/g, ".")}～＠${rate!.yen.toLocaleString("ja-JP")}` : ""].filter(Boolean).join("\n") || undefined;
    const calc: AttendanceLineCalc = {
      from,
      to,
      outsideMin: sum.outsideMin,
      fixedMin: sum.fixedMin,
      nightMin: sum.nightMin,
      lateMin: sum.lateMin,
      earlyMin: sum.earlyMin,
      workedMin: sum.workedMin,
      holidayWorkDays: sum.holidayWorkDays,
      compUsedDays: sum.compDays,
      specialDays: sum.specialDays,
      paidRemaining: sum.paidRemaining,
      compRemaining: sum.compRemaining,
      incentiveSalary: inc?.salary ?? 0,
      incentiveCash: inc?.cash ?? 0,
      incentiveItems: (inc?.items ?? []).map((x) => ({ label: x.label, yen: x.yen, pay: x.pay, detail: x.detail })),
      warnings: w,
    };
    const le = sum.lateMin + sum.earlyMin;
    return {
      kind: part ? ("part" as const) : ("staff" as const),
      sort: i,
      employeeNo: s.profiles[u.id]?.employeeNo ?? numbers.get(u.id),
      userId: u.id,
      name: u.name,
      workDays: sum.attendDays,
      absenceDays: part ? undefined : sum.absentDays || undefined,
      lateEarly: part || le <= 0 ? undefined : fmtHm(le),
      overtime: part || sum.overtimeMin <= 0 ? undefined : fmtHm(sum.overtimeMin),
      workHours: part ? fmtHm(sum.workedMin) : undefined,
      hourlyRate: rate?.yen,
      paidLeaveDays: sum.paidDays || undefined,
      note,
      source: "auto" as const,
      calc,
    };
  });
  for (const n of incentives.notes) warnings.push(n);
  return { yearMonth, from, to, payLabel: payLabelOf(yearMonth), lines, incentives, summaries, warnings };
}

/** 作った勤務表を書き込む (mutate の中)。確定済みは断る。手で足した行 (source = manual) は残す */
export function applyBuiltMonth(db: Database, built: BuiltMonth, opts: { userId: string; now: string; makeId: (p: string) => string }): { month: AttendanceMonth; lines: number } {
  let month = (db.attendanceMonths ?? []).find((m) => m.yearMonth === built.yearMonth);
  if (month?.status === "final") throw new Error(`${built.yearMonth} の勤務表は確定済みです。作り直すときは確定を取り消してください。`);
  if (!month) {
    month = { id: opts.makeId("attm"), yearMonth: built.yearMonth, payLabel: built.payLabel, status: "draft", sourceLabel: "打刻・休暇から作成", createdBy: opts.userId, createdAt: opts.now, updatedBy: opts.userId, updatedAt: opts.now };
    db.attendanceMonths.push(month);
  } else {
    month.payLabel = month.payLabel || built.payLabel;
    month.sourceLabel = "打刻・休暇から作成";
    month.updatedBy = opts.userId;
    month.updatedAt = opts.now;
  }
  const keep = (db.attendanceLines ?? []).filter((l) => l.monthId === month!.id && l.source === "manual");
  db.attendanceLines = (db.attendanceLines ?? []).filter((l) => l.monthId !== month!.id);
  const lines: AttendanceLine[] = built.lines.map((l) => ({ ...l, id: opts.makeId("attl"), monthId: month!.id, createdAt: opts.now, updatedAt: opts.now }));
  const base = lines.length;
  db.attendanceLines.push(...lines, ...keep.map((k, i) => ({ ...k, sort: base + i, updatedAt: opts.now })));
  return { month, lines: lines.length };
}

/** 送信の件名・本文の差し込み ({月}・{期間}・{会社}・{宛名}) */
export function fillTemplate(t: string, vars: { month: string; period: string; company: string; to: string }): string {
  return t.replace(/\{月\}/g, vars.month).replace(/\{期間\}/g, vars.period).replace(/\{会社\}/g, vars.company).replace(/\{宛名\}/g, vars.to);
}

/** 送信の文面の初期値 (設定の件名・本文に差し込む) */
export function mailDraft(db: Pick<Database, "settings" | "stores">, yearMonth: string): { subject: string; body: string; to: string } {
  const s = attendanceSettings(db);
  const company = documentSettings(db).companyName;
  const [y, m] = yearMonth.split("-").map(Number);
  const { from, to } = attendancePeriod(db, yearMonth);
  const vars = { month: `令和${y - 2018}年${m}月`, period: `${Number(from.slice(5, 7))}/${Number(from.slice(8))}〜${Number(to.slice(5, 7))}/${Number(to.slice(8))}`, company, to: `${s.sharoushi.name || "労務士事務所"} 御中` };
  return { subject: fillTemplate(s.sharoushi.subject, vars), body: fillTemplate(s.sharoushi.body, vars), to: s.sharoushi.to };
}
