/**
 * 予定表 (全社カレンダー) の共通ロジック
 * ------------------------------------------------------------
 * サーバーとブラウザ (予定の入力フォーム) の両方から使う純粋関数。DB・Cookie には触れない。
 * - 日付・時刻の正規化と表示
 * - 複数日・終日の予定の扱い (複数日の時刻は「各日の時間帯」)
 * - 担当者ごとの重複 (ダブルブッキング) の判定。同じ案件の予定どうしは重複とみなさない
 * - 繰り返し予定の展開、日本の祝日
 */
import type { ScheduleEvent } from "@/lib/db/types";
import { addDays, parseDate, toDateKey } from "@/lib/format";

export const WEEKDAY = ["日", "月", "火", "水", "木", "金", "土"] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/* ---------------- 日付・時刻 ---------------- */

/** 実在する日付 (YYYY-MM-DD) か */
export function isDateKey(s: unknown): s is string {
  return typeof s === "string" && DATE_RE.test(s) && toDateKey(parseDate(s)) === s;
}

/** "9:00" → "09:00"。不正な値は undefined */
export function normTime(t?: string | null): string | undefined {
  if (!t) return undefined;
  const m = TIME_RE.exec(t.trim());
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : undefined;
}

export function toMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

/** 分 → "HH:MM" (23:59 で頭打ち) */
export function fromMinutes(min: number): string {
  const v = Math.max(0, Math.min(24 * 60 - 1, Math.round(min)));
  return `${String(Math.floor(v / 60)).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`;
}

/** 月曜始まりの週の初日 */
export function weekStart(d: string): string {
  return addDays(d, -((parseDate(d).getDay() + 6) % 7));
}

export function monthStart(d: string): string {
  return `${d.slice(0, 7)}-01`;
}

export function monthEnd(d: string): string {
  const dt = parseDate(monthStart(d));
  return toDateKey(new Date(dt.getFullYear(), dt.getMonth() + 1, 0));
}

/** n か月後の同じ日。存在しない日 (31 日など) は月末に丸める */
export function addMonths(d: string, n: number): string {
  const dt = parseDate(d);
  const last = new Date(dt.getFullYear(), dt.getMonth() + n + 1, 0).getDate();
  return toDateKey(new Date(dt.getFullYear(), dt.getMonth() + n, Math.min(dt.getDate(), last)));
}

/** from〜to の日付一覧 (両端を含む) */
export function dateRange(from: string, to: string, max = 400): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < max; d = addDays(d, 1)) out.push(d);
  return out;
}

export function dayOfWeek(d: string): number {
  return parseDate(d).getDay();
}

/** 11/12(木) */
export function shortDate(d: string): string {
  const dt = parseDate(d);
  return `${dt.getMonth() + 1}/${dt.getDate()}(${WEEKDAY[dt.getDay()]})`;
}

/** 2026年11月12日(木) */
export function longDate(d: string): string {
  const dt = parseDate(d);
  return `${dt.getFullYear()}年${dt.getMonth() + 1}月${dt.getDate()}日(${WEEKDAY[dt.getDay()]})`;
}

/* ---------------- 予定の期間 ---------------- */

type Timed = Pick<ScheduleEvent, "date" | "endDate" | "startTime" | "endTime" | "slot">;
type Linked = Pick<ScheduleEvent, "inquiryId" | "quoteId" | "orderId">;
/** 重複判定に必要な項目 (登録前の候補は id なし) */
export type Slot = Timed & Linked & Pick<ScheduleEvent, "assigneeIds"> & { id?: string };

/** 予定の最終日 */
export function lastDay(e: Timed): string {
  return e.endDate && e.endDate > e.date ? e.endDate : e.date;
}

export function isAllDay(e: Timed): boolean {
  return !e.startTime && !e.slot;
}

/** 時刻の種類: 時刻指定 / 午前・午後だけ決まっている / 終日 */
function timing(e: Timed): "timed" | "slot" | "allday" {
  return e.startTime ? "timed" : e.slot ? "slot" : "allday";
}

/** 並べ替え用の開始時刻 (終日は先頭、午前は 9 時、午後は 13 時の位置) */
function sortTime(e: Timed): string {
  return e.startTime ?? (e.slot === "am" ? "09:00" : e.slot === "pm" ? "13:00" : "");
}

/** セルに出す短い時刻 (10:00 / 午前 / 午後 / 終日) */
export function shortTime(e: Timed): string {
  return e.startTime ?? (e.slot === "am" ? "午前" : e.slot === "pm" ? "午後" : "終日");
}

export function isMultiDay(e: Timed): boolean {
  return lastDay(e) !== e.date;
}

/** 予定が含まれる日の一覧 (長すぎる予定は max 日で打ち切り) */
export function eventDays(e: Timed, max = 62): string[] {
  return dateRange(e.date, lastDay(e), max);
}

export function occursOn(e: Timed, day: string): boolean {
  return e.date <= day && day <= lastDay(e);
}

export function overlapsRange(e: Timed, from: string, to: string): boolean {
  return e.date <= to && lastDay(e) >= from;
}

/** 1 日のうち予定が占める時間帯 (分)。終日は 0〜1440、終了時刻なしは開始から 60 分 */
export function dayInterval(e: Timed): [number, number] {
  if (!e.startTime) return e.slot === "am" ? [0, 720] : e.slot === "pm" ? [720, 1440] : [0, 1440];
  const s = toMinutes(e.startTime);
  const end = e.endTime ? toMinutes(e.endTime) : s + 60;
  return [s, Math.max(end, s + 15)];
}

/** 終日 / 10:00–11:00 / 10:00〜 */
export function timeLabel(e: Timed): string {
  if (!e.startTime) return e.slot === "am" ? "午前" : e.slot === "pm" ? "午後" : "終日";
  return e.endTime ? `${e.startTime}–${e.endTime}` : `${e.startTime}〜`;
}

/** 11/12(木) 10:00–11:00 / 11/12(木)〜11/14(土) 終日 */
export function periodLabel(e: Timed): string {
  const days = isMultiDay(e) ? `${shortDate(e.date)}〜${shortDate(lastDay(e))}` : shortDate(e.date);
  return `${days} ${timeLabel(e)}`;
}

/** 表示順: 日付 → 終日 (複数日を先) → 開始時刻 */
export function compareEvents(a: Timed & { title?: string }, b: Timed & { title?: string }): number {
  return (
    a.date.localeCompare(b.date) ||
    (isAllDay(a) ? 0 : 1) - (isAllDay(b) ? 0 : 1) ||
    lastDay(b).localeCompare(lastDay(a)) ||
    sortTime(a).localeCompare(sortTime(b)) ||
    (a.title ?? "").localeCompare(b.title ?? "", "ja")
  );
}

/** 同じ日の中での表示順 (開始日は問わない) */
export function compareInDay(a: Timed & { title?: string }, b: Timed & { title?: string }): number {
  return (
    (isAllDay(a) ? 0 : 1) - (isAllDay(b) ? 0 : 1) ||
    sortTime(a).localeCompare(sortTime(b)) ||
    a.date.localeCompare(b.date) ||
    (a.title ?? "").localeCompare(b.title ?? "", "ja")
  );
}

/* ---------------- 重複 (ダブルブッキング) ---------------- */

/** 同じ案件 (問い合わせ → 見積 → 受注) の予定か */
export function sameCase(a: Linked, b: Linked): boolean {
  return Boolean((a.orderId && a.orderId === b.orderId) || (a.quoteId && a.quoteId === b.quoteId) || (a.inquiryId && a.inquiryId === b.inquiryId));
}

/** 日付と時間帯の両方が重なるか */
export function timeOverlap(a: Timed, b: Timed): boolean {
  if (a.date > lastDay(b) || b.date > lastDay(a)) return false;
  // 午前・午後だけ決まっている訪問どうし (順に回る) や時刻指定の予定とは重複とみなさない。終日 (休暇など) とは重複
  const ta = timing(a);
  const tb = timing(b);
  if (ta === "slot" || tb === "slot") return ta === "allday" || tb === "allday";
  const [as, ae] = dayInterval(a);
  const [bs, be] = dayInterval(b);
  return as < be && bs < ae;
}

/** 2 つの予定が担当者の重複になりうるか (同じ予定・同じ案件の予定どうしは対象外) */
export function isConflict(a: Slot, b: Slot): boolean {
  if (a.id && a.id === b.id) return false;
  if (sameCase(a, b)) return false;
  return timeOverlap(a, b);
}

export interface ConflictHit<T> {
  userId: string;
  event: T;
  /** 重なる最初の日 */
  day: string;
}

/** 登録・変更しようとしている予定と、既存の予定の重複を担当者ごとに列挙 */
export function findConflicts<T extends Slot & { id: string }>(candidate: Slot, events: readonly T[]): ConflictHit<T>[] {
  const people = new Set(candidate.assigneeIds);
  if (people.size === 0) return [];
  const hits: ConflictHit<T>[] = [];
  for (const e of events) {
    if (!e.assigneeIds.some((u) => people.has(u))) continue;
    if (!isConflict(candidate, e)) continue;
    const day = candidate.date > e.date ? candidate.date : e.date;
    for (const u of new Set(e.assigneeIds)) if (people.has(u)) hits.push({ userId: u, event: e, day });
  }
  return hits.sort((a, b) => a.day.localeCompare(b.day) || compareInDay(a.event, b.event) || a.userId.localeCompare(b.userId));
}

export interface ConflictLink {
  userId: string;
  otherId: string;
  day: string;
}

export interface ConflictPair {
  userId: string;
  aId: string;
  bId: string;
  day: string;
}

/** 予定の一覧から重複を集計 (予定 ID ごとの相手、担当者ごとの組み合わせ) */
export function analyzeConflicts<T extends Slot & { id: string }>(events: readonly T[]): { byEvent: Map<string, ConflictLink[]>; pairs: ConflictPair[] } {
  const byUser = new Map<string, T[]>();
  for (const e of events) {
    for (const u of new Set(e.assigneeIds)) {
      const list = byUser.get(u);
      if (list) list.push(e);
      else byUser.set(u, [e]);
    }
  }
  const byEvent = new Map<string, ConflictLink[]>();
  const pairs: ConflictPair[] = [];
  const add = (id: string, link: ConflictLink) => {
    const list = byEvent.get(id);
    if (list) list.push(link);
    else byEvent.set(id, [link]);
  };
  for (const [userId, list] of byUser) {
    const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date));
    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i];
      const aEnd = lastDay(a);
      for (let j = i + 1; j < sorted.length; j++) {
        const b = sorted[j];
        if (b.date > aEnd) break;
        if (!isConflict(a, b)) continue;
        const day = b.date > a.date ? b.date : a.date;
        add(a.id, { userId, otherId: b.id, day });
        add(b.id, { userId, otherId: a.id, day });
        pairs.push({ userId, aId: a.id, bId: b.id, day });
      }
    }
  }
  pairs.sort((x, y) => x.day.localeCompare(y.day) || x.userId.localeCompare(y.userId));
  return { byEvent, pairs };
}

/* ---------------- 繰り返し ---------------- */

export type RepeatRule = "none" | "weekly" | "biweekly" | "monthly";

/** 繰り返しの開始日一覧 (最大 max 回)。毎月は同じ日がない月 (31 日など) を飛ばす */
export function repeatDates(start: string, rule: RepeatRule, until?: string, max = 52): string[] {
  if (rule === "none" || !until || until <= start) return [start];
  const out: string[] = [];
  const base = parseDate(start);
  for (let i = 0; out.length < max && i < max * 2; i++) {
    let d: string | undefined;
    if (rule === "monthly") {
      const dt = new Date(base.getFullYear(), base.getMonth() + i, base.getDate());
      d = dt.getDate() === base.getDate() ? toDateKey(dt) : undefined;
    } else {
      d = addDays(start, i * (rule === "weekly" ? 7 : 14));
    }
    if (!d) continue;
    if (d > until) break;
    out.push(d);
  }
  return out;
}

/* ---------------- 祝日 (「国民の祝日に関する法律」の規則で計算) ---------------- */

const holidayCache = new Map<number, Map<string, string>>();

function ymd(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function nthMonday(y: number, m: number, n: number): string {
  const first = new Date(y, m - 1, 1).getDay();
  const day = 1 + ((8 - first) % 7) + (n - 1) * 7;
  return ymd(y, m, day);
}

function buildHolidays(y: number): Map<string, string> {
  const h = new Map<string, string>();
  const leap = Math.floor((y - 1980) / 4);
  const vernal = Math.floor(20.8431 + 0.242194 * (y - 1980) - leap);
  const autumnal = Math.floor(23.2488 + 0.242194 * (y - 1980) - leap);
  h.set(ymd(y, 1, 1), "元日");
  h.set(nthMonday(y, 1, 2), "成人の日");
  h.set(ymd(y, 2, 11), "建国記念の日");
  h.set(ymd(y, 2, 23), "天皇誕生日");
  h.set(ymd(y, 3, vernal), "春分の日");
  h.set(ymd(y, 4, 29), "昭和の日");
  h.set(ymd(y, 5, 3), "憲法記念日");
  h.set(ymd(y, 5, 4), "みどりの日");
  h.set(ymd(y, 5, 5), "こどもの日");
  h.set(nthMonday(y, 7, 3), "海の日");
  h.set(ymd(y, 8, 11), "山の日");
  h.set(nthMonday(y, 9, 3), "敬老の日");
  h.set(ymd(y, 9, autumnal), "秋分の日");
  h.set(nthMonday(y, 10, 2), "スポーツの日");
  h.set(ymd(y, 11, 3), "文化の日");
  h.set(ymd(y, 11, 23), "勤労感謝の日");
  // 国民の休日: 祝日に挟まれた平日
  for (const d of [...h.keys()].sort()) {
    const mid = addDays(d, 1);
    if (!h.has(mid) && h.has(addDays(d, 2)) && dayOfWeek(mid) !== 0) h.set(mid, "国民の休日");
  }
  // 振替休日: 日曜の祝日の後の最初の平日
  for (const d of [...h.keys()].sort()) {
    if (dayOfWeek(d) !== 0) continue;
    let next = addDays(d, 1);
    while (h.has(next)) next = addDays(next, 1);
    h.set(next, "振替休日");
  }
  return h;
}

/** 祝日名 (祝日でなければ undefined) */
export function holidayName(d: string): string | undefined {
  const y = Number(d.slice(0, 4));
  if (!Number.isFinite(y) || y < 2000 || y > 2099) return undefined;
  let map = holidayCache.get(y);
  if (!map) {
    map = buildHolidays(y);
    holidayCache.set(y, map);
  }
  return map.get(d);
}

/** 日曜・祝日 */
export function isOffDay(d: string): boolean {
  return dayOfWeek(d) === 0 || holidayName(d) !== undefined;
}

/* ---------------- 重複チェック (入力フォーム ⇄ サーバー) の受け渡し ---------------- */

export interface ConflictQuery {
  /** 変更中の予定の ID (自分自身は重複の対象外) */
  eventId?: string;
  date: string;
  endDate?: string;
  startTime?: string;
  endTime?: string;
  slot?: "am" | "pm";
  assigneeIds: string[];
  /** 案件 ("order:o_1" など)。同じ案件の予定は重複とみなさない */
  caseRef?: string;
  repeat?: RepeatRule;
  repeatUntil?: string;
}

export interface ConflictItem {
  userId: string;
  userName: string;
  eventId: string;
  title: string;
  kindLabel: string;
  day: string;
  /** 11/12(木) 10:00–11:00 */
  when: string;
  store: string;
}

export interface AgendaItem {
  eventId: string;
  title: string;
  kindLabel: string;
  time: string;
  store: string;
  conflict: boolean;
}

export interface AgendaRow {
  userId: string;
  userName: string;
  title: string;
  store: string;
  items: AgendaItem[];
}

/** 開始日の各社員の予定の入り具合 (担当者を選ぶときの空き状況) */
export interface BusyInfo {
  count: number;
  /** 入力中の時間帯と重なる予定がある */
  overlap: boolean;
  /** 休暇・不在 */
  leave: boolean;
}

export interface ConflictReport {
  conflicts: ConflictItem[];
  /** 選択中の担当者の開始日の予定 (空き状況の確認用) */
  agenda: AgendaRow[];
  /** 全社員の開始日の予定の入り具合 (ユーザー ID → 件数など) */
  busy: Record<string, BusyInfo>;
  day: string;
  /** 繰り返しを含めた登録件数 */
  occurrences: number;
}
