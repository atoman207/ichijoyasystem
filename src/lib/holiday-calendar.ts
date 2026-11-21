import type { CompanyHoliday, Database } from "@/lib/db/types";
import { daysBetween } from "@/lib/format";
import { dateRange, dayOfWeek, holidayName, isDateKey, lawHolidays, type HolidayOverrides } from "@/lib/calendar";

/**
 * 休日カレンダー (会社の休業日 + 祝日)
 * ------------------------------------------------------------
 * - 休業日: company_holidays (db.holidays)。1 日 = 1 行 (日付は一意)。予定表・予定の候補日の提案・全体の最適化・
 *   有給の日数・作業日報が使う (schedule-capacity.ts の isClosedDay。登録より先の日付は日曜だけを休みとみなす)
 * - 祝日: 「国民の祝日に関する法律」の規則で計算する (calendar.ts の lawHolidayName。2000〜2099 年)。
 *   法改正・官報で決まった春分/秋分の日などと違うときは、管理者が日付ごとに直す
 *   (settings の id = holiday_calendar の national: 日付 → 祝日名 / null = 祝日から外す)
 * - 祝日は休業日とは別。一畳屋は祝日の多くが営業日なので、祝日を休業日にするかは休業日の側で決める (まとめて登録の「祝日」)
 * - 画面は /schedule/holidays、印刷は /print/holidays、操作は src/lib/actions/holidays.ts (管理者 = canManageHolidays)
 * このファイルは画面・操作・テストで共通に使う (サーバー専用の import をしない)
 */

export const HOLIDAY_SETTINGS_ID = "holiday_calendar";
/** 画面で選べる年の既定の範囲 (祝日の一覧を用意する範囲)。休業日・祝日の変更があればその年まで広げる */
export const HOLIDAY_FIRST_YEAR = 2020;
export const HOLIDAY_LAST_YEAR = 2030;
export const DEFAULT_CLOSED_LABEL = "休業日";
/** まとめて登録の期間の上限 (3 年) */
export const MAX_BULK_DAYS = 1096;
export const LABEL_MAX = 30;

/* ---------------- 祝日 ---------------- */

/** 管理者が直した祝日 (日付 → 祝日名 / null = 祝日から外す) */
export function readHolidayOverrides(db: Pick<Database, "settings">): Record<string, string | null> {
  const v = (db.settings ?? []).find((s) => s.id === HOLIDAY_SETTINGS_ID)?.value?.national;
  const out: Record<string, string | null> = {};
  if (!v || typeof v !== "object") return out;
  for (const [d, n] of Object.entries(v as Record<string, unknown>)) {
    if (!isDateKey(d)) continue;
    if (n === null) out[d] = null;
    else if (typeof n === "string" && n.trim()) out[d] = n.trim().slice(0, LABEL_MAX);
  }
  return out;
}

/** 祝日名を引く関数 (管理者の変更を反映)。予定表・印刷・候補日の画面で使う */
export function holidayResolver(db: Pick<Database, "settings">): (d: string) => string | undefined {
  const o: HolidayOverrides = readHolidayOverrides(db);
  return (d) => holidayName(d, o);
}

/** law = 規則どおり / renamed = 名前を変更 / added = 規則にない祝日を追加 / removed = 規則の祝日を外した */
export type HolidaySource = "law" | "renamed" | "added" | "removed";
export const HOLIDAY_SOURCE_LABEL: Record<HolidaySource, string> = { law: "規則どおり", renamed: "名前を変更", added: "追加", removed: "祝日から外した" };

export interface YearHoliday {
  date: string;
  /** 表示する名前 (外した祝日は規則の名前) */
  name: string;
  /** 規則で計算した名前 (規則にない日は undefined) */
  lawName?: string;
  source: HolidaySource;
  /** 会社の休業日か */
  closed: boolean;
}

const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** 1 年の祝日 (外した祝日も source = removed で含める。日付の順) */
export function yearHolidays(db: Pick<Database, "settings" | "holidays">, year: number): YearHoliday[] {
  const o = readHolidayOverrides(db);
  const closed = closedDayMap(db);
  const out = new Map<string, YearHoliday>();
  for (const [date, lawName] of lawHolidays(year)) {
    if (!hasOwn(o, date)) {
      out.set(date, { date, name: lawName, lawName, source: "law", closed: closed.has(date) });
      continue;
    }
    const v = o[date];
    out.set(date, { date, name: v ?? lawName, lawName, source: v === null ? "removed" : v === lawName ? "law" : "renamed", closed: closed.has(date) });
  }
  for (const [date, name] of Object.entries(o)) {
    if (name === null || !date.startsWith(`${year}-`) || out.has(date)) continue;
    out.set(date, { date, name, source: "added", closed: closed.has(date) });
  }
  return [...out.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

/* ---------------- 休業日 ---------------- */

export function closedDayMap(db: Pick<Database, "holidays">): Map<string, CompanyHoliday> {
  return new Map((db.holidays ?? []).map((h) => [h.date, h]));
}

/** 画面で選べる年 (既定の 2020〜2030 年・来年まで + 休業日・祝日の変更がある年) */
export function holidayYears(db: Pick<Database, "settings" | "holidays">, now: Date = new Date()): number[] {
  let first = HOLIDAY_FIRST_YEAR;
  let last = Math.max(HOLIDAY_LAST_YEAR, now.getFullYear() + 1);
  const years = [...(db.holidays ?? []).map((h) => h.date), ...Object.keys(readHolidayOverrides(db))].map((d) => Number(d.slice(0, 4))).filter((y) => y >= 2000 && y <= 2099);
  for (const y of years) {
    if (y < first) first = y;
    if (y > last) last = y;
  }
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}

export interface MonthSummary {
  month: number;
  days: number;
  closed: number;
  workdays: number;
}

export interface YearSummary {
  year: number;
  closed: number;
  sundays: number;
  saturdays: number;
  /** 休業日のうち祝日 (日曜・土曜を除く) */
  holidays: number;
  /** 休業日のうち平日 (祝日・土日を除く。年末年始・お盆など) */
  others: number;
  workdays: number;
  months: MonthSummary[];
  /** 休業日が 1 日もない月 (登録がない可能性) */
  emptyMonths: number[];
}

/** 1 年の休業日の数 (登録した休業日だけで数える) */
export function yearSummary(db: Pick<Database, "settings" | "holidays">, year: number): YearSummary {
  const closed = closedDayMap(db);
  const holidayOf = holidayResolver(db);
  const s: YearSummary = { year, closed: 0, sundays: 0, saturdays: 0, holidays: 0, others: 0, workdays: 0, months: [], emptyMonths: [] };
  for (let m = 1; m <= 12; m++) {
    const ym = `${year}-${String(m).padStart(2, "0")}`;
    const days = dateRange(`${ym}-01`, `${ym}-31`).filter((d) => d.startsWith(ym));
    const ms: MonthSummary = { month: m, days: days.length, closed: 0, workdays: 0 };
    for (const d of days) {
      if (!closed.has(d)) {
        ms.workdays++;
        continue;
      }
      ms.closed++;
      const w = dayOfWeek(d);
      if (w === 0) s.sundays++;
      else if (w === 6) s.saturdays++;
      else if (holidayOf(d)) s.holidays++;
      else s.others++;
    }
    s.closed += ms.closed;
    s.workdays += ms.workdays;
    if (!ms.closed) s.emptyMonths.push(m);
    s.months.push(ms);
  }
  return s;
}

/** 1 日の休業日の登録・変更・解除。変えたら db.holidays を作り直す (isClosedDay のキャッシュは配列ごと) */
export function setClosedDay(
  db: Pick<Database, "holidays">,
  date: string,
  closed: boolean,
  label: string,
): { action: "create" | "update" | "delete" | "none"; before?: CompanyHoliday; after?: CompanyHoliday } {
  const name = cleanLabel(label);
  const before = db.holidays.find((h) => h.date === date);
  if (!closed) {
    if (!before) return { action: "none" };
    db.holidays = db.holidays.filter((h) => h.date !== date);
    return { action: "delete", before };
  }
  if (before) {
    if (before.label === name) return { action: "none", before, after: before };
    const after = { ...before, label: name };
    db.holidays = db.holidays.map((h) => (h.date === date ? after : h));
    return { action: "update", before, after };
  }
  const after: CompanyHoliday = { id: newHolidayId(db, date), date, label: name };
  db.holidays = [...db.holidays, after].sort((a, b) => (a.date < b.date ? -1 : 1));
  return { action: "create", after };
}

export function cleanLabel(v: string | undefined): string {
  return (v ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, LABEL_MAX) || DEFAULT_CLOSED_LABEL;
}

function newHolidayId(db: Pick<Database, "holidays">, date: string): string {
  const ids = new Set(db.holidays.map((h) => h.id));
  let id = `hol_${date}`;
  for (let i = 2; ids.has(id); i++) id = `hol_${date}_${i}`;
  return id;
}

/* ---------------- まとめて登録 ---------------- */

export interface ClosedDayRule {
  from: string;
  to: string;
  /** 毎週休む曜日 (0 = 日 … 6 = 土) */
  weekdays: number[];
  /** 隔週の土曜の基準日 (この土曜と、2 週ごとの土曜)。毎週の土曜を選んだときは使わない */
  altSaturday?: string;
  /** 祝日 (管理者の変更を反映した祝日) */
  holidays: boolean;
  /** 期間のすべての日 (年末年始・お盆・夏季休業など) */
  allDays: boolean;
  label: string;
  mode: "add" | "remove";
}

export interface ClosedDayPlan {
  rule: ClosedDayRule;
  /** 条件に合う日 */
  matched: string[];
  /** 休業日にする日 (mode = add) */
  add: { date: string; label: string; reason: string }[];
  /** 休業日から外す日 (mode = remove) */
  remove: CompanyHoliday[];
  /** 条件に合うが、すでにその状態の日 */
  unchanged: number;
}

/** フォーム・検索パラメーターから条件を読む。誤りは文で返す */
export function readClosedDayRule(get: (k: string) => string | null, getAll: (k: string) => string[]): ClosedDayRule | { error: string } {
  const from = (get("from") ?? "").trim();
  const to = (get("to") ?? "").trim();
  if (!isDateKey(from) || !isDateKey(to)) return { error: "期間の開始日と終了日を入力してください。" };
  if (from > to) return { error: "期間の終了日は開始日以降にしてください。" };
  if (daysBetween(from, to) + 1 > MAX_BULK_DAYS) return { error: "期間は 3 年以内にしてください。" };
  const weekdays = [...new Set(getAll("weekday").map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort();
  const alt = (get("altSaturday") ?? "").trim();
  if (alt && (!isDateKey(alt) || dayOfWeek(alt) !== 6)) return { error: "隔週の土曜の基準日には土曜の日付を入力してください。" };
  const holidays = get("holidays") === "on" || get("holidays") === "1";
  const allDays = get("allDays") === "on" || get("allDays") === "1";
  if (!weekdays.length && !alt && !holidays && !allDays) return { error: "曜日・隔週の土曜・祝日・期間のすべての日のどれかを選んでください。" };
  return { from, to, weekdays, altSaturday: alt || undefined, holidays, allDays, label: cleanLabel(get("label") ?? ""), mode: get("mode") === "remove" ? "remove" : "add" };
}

const WEEKDAY_NAME = ["日", "月", "火", "水", "木", "金", "土"];

/** 条件に合う理由 (合わなければ undefined) */
function matchReason(rule: ClosedDayRule, d: string, holidayOf: (d: string) => string | undefined): string | undefined {
  if (rule.allDays) return "期間";
  const w = dayOfWeek(d);
  if (rule.weekdays.includes(w)) return `毎週${WEEKDAY_NAME[w]}曜`;
  if (rule.altSaturday && w === 6 && !rule.weekdays.includes(6) && Math.abs(daysBetween(rule.altSaturday, d) / 7) % 2 === 0) return "隔週の土曜";
  if (rule.holidays) {
    const h = holidayOf(d);
    if (h) return h;
  }
  return undefined;
}

/** 条件で休業日の追加・解除を計算する (書き込まない) */
export function planClosedDays(db: Pick<Database, "settings" | "holidays">, rule: ClosedDayRule): ClosedDayPlan {
  const closed = closedDayMap(db);
  const holidayOf = holidayResolver(db);
  const plan: ClosedDayPlan = { rule, matched: [], add: [], remove: [], unchanged: 0 };
  for (const d of dateRange(rule.from, rule.to, MAX_BULK_DAYS)) {
    const reason = matchReason(rule, d, holidayOf);
    if (!reason) continue;
    plan.matched.push(d);
    const row = closed.get(d);
    if (rule.mode === "add") {
      if (row) plan.unchanged++;
      else plan.add.push({ date: d, label: rule.label, reason });
    } else if (row) plan.remove.push(row);
    else plan.unchanged++;
  }
  return plan;
}

/** 計算した追加・解除を反映する (db.holidays を作り直す)。反映した日数 */
export function applyClosedDayPlan(db: Pick<Database, "holidays">, plan: ClosedDayPlan): number {
  if (plan.rule.mode === "remove") {
    const drop = new Set(plan.remove.map((h) => h.id));
    const before = db.holidays.length;
    db.holidays = db.holidays.filter((h) => !drop.has(h.id));
    return before - db.holidays.length;
  }
  const have = new Set(db.holidays.map((h) => h.date));
  const rows: CompanyHoliday[] = [];
  const ids = new Set(db.holidays.map((h) => h.id));
  for (const a of plan.add) {
    if (have.has(a.date)) continue;
    let id = `hol_${a.date}`;
    for (let i = 2; ids.has(id); i++) id = `hol_${a.date}_${i}`;
    ids.add(id);
    have.add(a.date);
    rows.push({ id, date: a.date, label: a.label });
  }
  db.holidays = [...db.holidays, ...rows].sort((a, b) => (a.date < b.date ? -1 : 1));
  return rows.length;
}

/** 条件の説明 (確認の画面・変更履歴) */
export function describeRule(rule: ClosedDayRule): string {
  const parts: string[] = [];
  if (rule.allDays) parts.push("期間のすべての日");
  else {
    if (rule.weekdays.length) parts.push(`毎週 ${rule.weekdays.map((w) => WEEKDAY_NAME[w]).join("・")}曜`);
    if (rule.altSaturday && !rule.weekdays.includes(6)) parts.push(`隔週の土曜 (${rule.altSaturday} から)`);
    if (rule.holidays) parts.push("祝日");
  }
  return `${rule.from}〜${rule.to} の ${parts.join("・")}`;
}

/** 条件を検索パラメーター・隠しフィールドにする (確認 → 登録で同じ条件を送る) */
export function ruleParams(rule: ClosedDayRule): [string, string][] {
  const p: [string, string][] = [["from", rule.from], ["to", rule.to]];
  for (const w of rule.weekdays) p.push(["weekday", String(w)]);
  if (rule.altSaturday) p.push(["altSaturday", rule.altSaturday]);
  if (rule.holidays) p.push(["holidays", "1"]);
  if (rule.allDays) p.push(["allDays", "1"]);
  p.push(["label", rule.label], ["mode", rule.mode]);
  return p;
}
