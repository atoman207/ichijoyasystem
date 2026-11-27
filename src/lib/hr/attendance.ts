import type { AppSetting, AttendanceLine, AttendanceLineKind, AttendanceMonth, Database, LeaveRequest, User } from "@/lib/db/types";
import { readXlsx } from "@/lib/xlsx";
import { xlsxRows } from "@/lib/survey-workbook/read";
import { leaveEmployees } from "./leave";
import { closingRange, fmtDays, hrSettings } from "./leave";
import { ATTENDANCE_SETTINGS_ID, attendanceSettings, staffNameKey, type AttendanceSettings, type ExtraStaff, type StaffProfile } from "./timecard";

/**
 * 勤怠の月次表 (労務士へ送る一覧)
 * ------------------------------------------------------------
 * - 打刻・給与計算は対象外。出勤日数・欠勤・遅刻早退・残業・有給・備考 (休日出勤・振休・インセンティブ) を月ごとに残す
 * - 売上台帳と同じく、既存の「令和○年度.xlsx」(シート 8.11 = 令和 8 年 11 月分) を取り込む
 * - 有給・休日出勤の記録から候補の備考・有給日数を自動で埋める (出勤日数は手入力または取込)
 */

const N = (s: string) => s.normalize("NFKC").replace(/[\s　]+/g, " ").trim();
const nameKey = (s: string) => N(s).replace(/[\s　]/g, "");

/** 令和 y 年 m 月 → YYYY-MM (令和 1 = 2019) */
export function reiwaMonthToYm(reiwaYear: number, month: number): string {
  const y = 2018 + reiwaYear;
  return `${y}-${String(month).padStart(2, "0")}`;
}

/** シート名「8.11」→ 2026-11 */
export function sheetNameToYm(name: string): string | undefined {
  const m = N(name).match(/^(\d{1,2})\.(\d{1,2})$/);
  if (!m) return undefined;
  return reiwaMonthToYm(Number(m[1]), Number(m[2]));
}

/** セル「令和　8年　11月分」→ 2026-11 */
export function labelToYm(text: string): string | undefined {
  const t = N(text);
  const r = t.match(/令和\s*(\d{1,2})\s*年\s*(\d{1,2})\s*月/);
  if (r) return reiwaMonthToYm(Number(r[1]), Number(r[2]));
  const w = t.match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
  if (w) return `${w[1]}-${String(Number(w[2])).padStart(2, "0")}`;
  return undefined;
}

function parseNum(raw: unknown): number | undefined {
  if (raw === null || raw === undefined || raw === "") return undefined;
  const s = String(raw).replace(/[,，]/g, "").replace(/日/g, "").trim();
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function parseRate(raw: unknown): number | undefined {
  const s = N(String(raw ?? "")).replace(/^@|＠/, "").replace(/,/g, "");
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** 遅刻・残業・出勤時間を文字の HH:MM にそろえる (Excel の時刻シリアル・「33.53」「65.16ｈ」も読む) */
export function cleanTime(raw: unknown): string | undefined {
  const s = N(String(raw ?? "")).replace(/：/g, ":").replace(/ｈ|h/gi, "").trim();
  if (!s) return undefined;
  if (/^\d{1,3}:\d{2}$/.test(s)) return s;
  const n = Number(s);
  if (Number.isFinite(n)) {
    // Excel の時刻 (1 日 = 1.0)。0.0666… → 1:36
    if (n > 0 && n < 1) {
      const total = Math.round(n * 24 * 60);
      return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
    }
    // 「33.53」= 33:53 (分が 0〜59)
    const m = /^(\d{1,3})\.(\d{1,2})$/.exec(s);
    if (m && Number(m[2]) < 60) return `${Number(m[1])}:${m[2].padStart(2, "0")}`;
  }
  return s;
}

/** 表の右の欄 (J 列) の「時給変更2025.12.21～＠1,040」→ 変更日・時給 */
export function parseRateChange(text: string): { from: string; yen: number } | undefined {
  const m = N(text).match(/時給変更\s*(\d{4})[./年-](\d{1,2})[./月-](\d{1,2})日?\s*[~～〜-]\s*@?\s*([\d,]+)/);
  if (!m) return undefined;
  const yen = Number(m[4].replace(/,/g, ""));
  const from = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  return yen > 0 && yen <= 100_000 && !Number.isNaN(Date.parse(from)) ? { from, yen } : undefined;
}

export type ParsedAttendanceLine = Omit<AttendanceLine, "id" | "monthId" | "createdAt" | "updatedAt"> & {
  /** 表の右の欄 (J 列) の時給の変更 (パート) */
  rateChange?: { from: string; yen: number };
};

export interface ParsedAttendanceSheet {
  yearMonth: string;
  payLabel?: string;
  sheetName: string;
  /** 1 行目の宛名 (「○○ 御中」の ○○) */
  addressee?: string;
  /** 2 行目の会社名 (書かれたまま。空白も残す) */
  companyLine?: string;
  lines: ParsedAttendanceLine[];
}

/** 1 シート (月) を読む */
export function parseAttendanceSheet(sheetName: string, rows: string[][]): ParsedAttendanceSheet | null {
  let yearMonth = sheetNameToYm(sheetName);
  let payLabel: string | undefined;
  for (const row of rows.slice(0, 8)) {
    for (const cell of row) {
      const ym = labelToYm(cell);
      if (ym) yearMonth = ym;
      const pay = N(cell).match(/(\d{1,2})\s*[/／]\s*(\d{1,2})\s*支給/);
      if (pay) payLabel = `${pay[1]}/${pay[2]}支給`;
    }
  }
  if (!yearMonth) return null;
  let addressee: string | undefined;
  let companyLine: string | undefined;
  for (const row of rows.slice(0, 3)) {
    const raw = String(row[0] ?? "").trim();
    if (!raw) continue;
    const to = N(raw).match(/^(.+?)\s*御中$/);
    if (to && !addressee) addressee = to[1].trim().slice(0, 80);
    else if (addressee && !companyLine && !/御中/.test(raw)) companyLine = raw.slice(0, 80);
  }

  let mode: AttendanceLineKind | null = null;
  const lines: ParsedAttendanceSheet["lines"] = [];
  let sort = 0;
  for (const row of rows) {
    const c0 = N(row[0] ?? "");
    const c1 = N(row[1] ?? "");
    if (c0 === "社員" || (c0 === "" && c1 === "社員")) {
      mode = "staff";
      continue;
    }
    if (c0 === "パート" || (c0 === "" && c1 === "パート")) {
      mode = "part";
      continue;
    }
    if (!mode) continue;
    if (c0 === "No" || c1 === "氏名") continue;
    const key = c1 || (c0 && !/^\d+$/.test(c0) ? c0 : "");
    if (!key || key === "氏名") continue;
    // 氏名・備考は書かれたまま (全角の空白・「￥」「（現金）」・改行を残す。以前の表と同じ見た目で出し直すため)
    const name = String((c1 ? row[1] : row[0]) ?? "").trim().replace(/[ \t]+/g, " ") || key;
    const employeeNo = /^\d+$/.test(c0) ? c0 : undefined;
    const note = String(row[6] ?? "").replace(/\r\n?/g, "\n").replace(/^\s+|\s+$/g, "") || undefined;
    const rateChange = parseRateChange(String(row[9] ?? ""));
    if (mode === "staff") {
      lines.push({
        kind: "staff",
        sort: sort++,
        employeeNo,
        name,
        workDays: parseNum(row[2]),
        absenceDays: parseNum(row[3]),
        lateEarly: cleanTime(row[4]),
        overtime: cleanTime(row[5]),
        note,
        paidLeaveDays: parseNum(row[7]),
      });
    } else {
      lines.push({
        kind: "part",
        sort: sort++,
        employeeNo,
        name,
        workDays: parseNum(row[2]),
        workHours: cleanTime(row[3]),
        hourlyRate: parseRate(row[4]),
        note,
        paidLeaveDays: parseNum(row[7]),
        ...(rateChange ? { rateChange } : {}),
      });
    }
  }
  return { yearMonth, payLabel, sheetName, addressee, companyLine, lines };
}

/** .xlsx (令和○年度の勤怠月次) の全シートを読む */
export function parseAttendanceWorkbook(buf: Buffer): ParsedAttendanceSheet[] {
  const out: ParsedAttendanceSheet[] = [];
  for (const sh of readXlsx(buf)) {
    const parsed = parseAttendanceSheet(sh.name, xlsxRows(sh.rows));
    if (parsed?.lines.length) out.push(parsed);
  }
  return out.sort((a, b) => a.yearMonth.localeCompare(b.yearMonth));
}

/** 氏名 → 社員 (スペース・旧字体の差を緩く見る) */
export function matchAttendanceUser(db: Pick<Database, "users" | "stores">, name: string): User | undefined {
  const key = nameKey(name);
  const users = leaveEmployees(db);
  return users.find((u) => nameKey(u.name) === key) ?? users.find((u) => nameKey(u.name).includes(key) || key.includes(nameKey(u.name)));
}

/** 対象月の暦日の範囲 */
export function monthRange(yearMonth: string): { from: string; to: string } {
  const [y, m] = yearMonth.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${yearMonth}-01`, to: `${yearMonth}-${String(last).padStart(2, "0")}` };
}

function leavesInMonth(db: Pick<Database, "leaveRequests">, userId: string, from: string, to: string): LeaveRequest[] {
  return (db.leaveRequests ?? []).filter((r) => r.userId === userId && r.status === "approved" && r.dates.some((d) => d >= from && d <= to));
}

/** 有給・休日出勤から、備考と有給日数の候補を作る */
export function suggestFromLeave(db: Database, userId: string, yearMonth: string): { paidLeaveDays: number; noteParts: string[] } {
  // 勤怠の月は 20 日締め (11 月分 = 10/21〜11/20。有給・休日出勤の締め日の設定)
  const { from, to } = closingRange(yearMonth, hrSettings(db).closingDay);
  const leaves = leavesInMonth(db, userId, from, to);
  let paid = 0;
  let comp = 0;
  let special = 0;
  for (const r of leaves) {
    const inMonth = r.dates.filter((d) => d >= from && d <= to);
    const d = inMonth.length === 0 ? 0 : r.slot === "day" ? inMonth.length : inMonth.length * 0.5;
    if (r.leaveType === "paid") paid += d;
    else if (r.leaveType === "comp") comp += d;
    else special += d;
  }
  const works = (db.holidayWorks ?? []).filter((h) => h.userId === userId && h.kind === "work" && h.date >= from && h.date <= to);
  const workDays = works.reduce((a, h) => a + h.days, 0);
  const noteParts: string[] = [];
  if (workDays > 0) noteParts.push(`休日出勤${fmtDays(workDays).replace(" 日", "日")}`);
  if (comp > 0) noteParts.push(`振休消化${fmtDays(comp).replace(" 日", "日")}`);
  if (special > 0) {
    const reasons = leaves.filter((r) => r.leaveType === "special").map((r) => r.reason).filter(Boolean);
    noteParts.push(reasons.length ? `独自休暇${fmtDays(special).replace(" 日", "日")}（${reasons[0]}）` : `特別休暇${fmtDays(special).replace(" 日", "日")}`);
  }
  return { paidLeaveDays: paid, noteParts };
}

/** 空の下書き行 (社員マスタから。出勤日数は空) */
export function draftLinesFromUsers(db: Database, yearMonth: string): Omit<AttendanceLine, "id" | "monthId" | "createdAt" | "updatedAt">[] {
  const users = leaveEmployees(db);
  return users.map((u, i) => {
    const sug = suggestFromLeave(db, u.id, yearMonth);
    return {
      kind: "staff" as const,
      sort: i,
      userId: u.id,
      name: u.name,
      paidLeaveDays: sug.paidLeaveDays || undefined,
      note: sug.noteParts.length ? sug.noteParts.join("　") : undefined,
    };
  });
}

export interface ApplyAttendanceResult {
  monthId: string;
  yearMonth: string;
  added: boolean;
  lines: number;
}

/** 1 か月分を書き込む (mutate の中)。既存の下書きは行を置き換え。確定済みは断る */
export function applyAttendanceSheet(
  db: Database,
  sheet: ParsedAttendanceSheet,
  opts: { userId: string; now: string; makeId: (p: string) => string; sourceLabel?: string; force?: boolean; finalize?: boolean },
): ApplyAttendanceResult {
  let month = (db.attendanceMonths ?? []).find((m) => m.yearMonth === sheet.yearMonth);
  if (month?.status === "final" && !opts.force) throw new Error(`${sheet.yearMonth} は確定済みです。取り込むときは確定を取り消してください。`);
  if (!month) {
    month = {
      id: opts.makeId("attm"),
      yearMonth: sheet.yearMonth,
      payLabel: sheet.payLabel,
      status: "draft",
      sourceLabel: opts.sourceLabel,
      createdBy: opts.userId,
      createdAt: opts.now,
      updatedBy: opts.userId,
      updatedAt: opts.now,
    };
    db.attendanceMonths.push(month);
  } else {
    month.payLabel = sheet.payLabel ?? month.payLabel;
    month.sourceLabel = opts.sourceLabel ?? month.sourceLabel;
    month.status = "draft";
    month.updatedBy = opts.userId;
    month.updatedAt = opts.now;
    month.finalizedBy = undefined;
    month.finalizedAt = undefined;
    db.attendanceLines = (db.attendanceLines ?? []).filter((l) => l.monthId !== month!.id);
  }
  const lines: AttendanceLine[] = sheet.lines.map((row, i) => {
    const user = matchAttendanceUser(db, row.name);
    const sug = user ? suggestFromLeave(db, user.id, sheet.yearMonth) : undefined;
    const note = row.note || (sug?.noteParts.length ? sug.noteParts.join("　") : undefined);
    return {
      id: opts.makeId("attl"),
      monthId: month!.id,
      kind: row.kind,
      sort: row.sort ?? i,
      employeeNo: row.employeeNo,
      userId: user?.id,
      name: row.name,
      workDays: row.workDays,
      absenceDays: row.absenceDays,
      lateEarly: row.lateEarly,
      overtime: row.overtime,
      workHours: row.workHours,
      hourlyRate: row.hourlyRate,
      paidLeaveDays: row.paidLeaveDays ?? (sug?.paidLeaveDays || undefined),
      note,
      source: "import",
      createdAt: opts.now,
      updatedAt: opts.now,
    };
  });
  db.attendanceLines.push(...lines);
  if (opts.finalize) {
    // 労務士へ送り終えた月 (締めの過ぎた月): 確定にして、打刻からの作り直しで置き換わらないようにする
    month.status = "final";
    month.finalizedBy = opts.userId;
    month.finalizedAt = opts.now;
  }
  return { monthId: month.id, yearMonth: sheet.yearMonth, added: true, lines: lines.length };
}

/* ------------------------------------------------------------------ */
/* 取り込んだ表から勤怠の設定へ (社員番号・パート・時給・宛名・アカウントのない社員)                   */
/* ------------------------------------------------------------------ */

export interface WorkbookSetupPlan {
  /** 一番新しい表の月 */
  latest: string;
  addressee?: string;
  companyLine?: string;
  /** アカウントに当たった人 (設定に入れる値。入っている値は変えない) */
  people: { userId: string; name: string; employeeNo?: string; part?: boolean; rate?: { from: string; yen: number; changed?: boolean } }[];
  /** アカウントのない人 (勤務表にだけ載せる) */
  extras: ExtraStaff[];
}

/**
 * 一番新しい表 (今の社員) から、勤怠の設定に入れる値を決める。設定にもう入っている値は変えない (画面で直した値を残す)。
 * 時給の変更日は右の欄の「時給変更…」、なければその時給が最初に出た月の締めの期間の始まり
 */
export function planWorkbookSetup(db: Database, sheets: ParsedAttendanceSheet[]): WorkbookSetupPlan | undefined {
  const latest = [...sheets].sort((a, b) => b.yearMonth.localeCompare(a.yearMonth))[0];
  if (!latest) return undefined;
  const s = attendanceSettings(db);
  const closing = hrSettings(db).closingDay;
  const people: WorkbookSetupPlan["people"] = [];
  const extras: ExtraStaff[] = [];
  const seen = new Set<string>();
  for (const l of latest.lines) {
    const key = staffNameKey(l.name);
    if (seen.has(key)) continue;
    seen.add(key);
    const user = matchAttendanceUser(db, l.name);
    if (!user) {
      if (s.extraStaff.some((e) => e.key === key)) continue;
      extras.push({ key, name: l.name.replace(/[\s　]+/g, " ").trim(), kind: l.kind, employeeNo: l.employeeNo, hourlyRate: l.kind === "part" ? l.hourlyRate : undefined });
      continue;
    }
    const prof = s.profiles[user.id] ?? {};
    const row: WorkbookSetupPlan["people"][number] = { userId: user.id, name: user.name };
    if (l.employeeNo && !prof.employeeNo) row.employeeNo = l.employeeNo;
    if (l.kind === "part" && !prof.category) row.part = true;
    if (l.kind === "part" && !prof.rates?.length && (l.rateChange || l.hourlyRate)) {
      if (l.rateChange && (!l.hourlyRate || l.rateChange.yen === l.hourlyRate)) row.rate = { ...l.rateChange, changed: true };
      else if (l.hourlyRate) {
        // その時給が続いている一番前の月から
        const months = [...sheets].sort((a, b) => b.yearMonth.localeCompare(a.yearMonth));
        let first = latest.yearMonth;
        for (const m of months) {
          const same = m.lines.find((x) => staffNameKey(x.name) === key);
          if (!same || same.hourlyRate !== l.hourlyRate) break;
          first = m.yearMonth;
        }
        row.rate = { from: closingRange(first, closing).from, yen: l.hourlyRate };
      }
    }
    if (row.employeeNo || row.part || row.rate) people.push(row);
  }
  return {
    latest: latest.yearMonth,
    addressee: !s.sharoushi.name && latest.addressee ? latest.addressee : undefined,
    companyLine: !s.sharoushi.companyLine && latest.companyLine ? latest.companyLine : undefined,
    people,
    extras,
  };
}

/** 設定に書く (mutate の中)。変えた内容の文を返す */
export function applyWorkbookSetup(db: Database, plan: WorkbookSetupPlan, opts: { userId: string; now: string }): string[] {
  const cur: AttendanceSettings = attendanceSettings(db);
  const profiles: Record<string, StaffProfile> = { ...cur.profiles };
  const done: string[] = [];
  let nos = 0;
  let parts = 0;
  let rates = 0;
  for (const p of plan.people) {
    const prof: StaffProfile = { ...(profiles[p.userId] ?? {}) };
    if (p.employeeNo && !prof.employeeNo) {
      prof.employeeNo = p.employeeNo;
      nos++;
    }
    if (p.part && !prof.category) {
      prof.category = "part";
      parts++;
    }
    if (p.rate && !prof.rates?.length) {
      prof.rates = [p.rate];
      rates++;
    }
    profiles[p.userId] = prof;
  }
  const extraStaff = [...cur.extraStaff, ...plan.extras.filter((e) => !cur.extraStaff.some((x) => x.key === e.key))].slice(0, 50);
  const sharoushi = { ...cur.sharoushi, name: cur.sharoushi.name || plan.addressee || "", companyLine: cur.sharoushi.companyLine || plan.companyLine || "" };
  if (nos) done.push(`社員番号 ${nos} 人`);
  if (parts) done.push(`パート ${parts} 人`);
  if (rates) done.push(`時給 ${rates} 人`);
  if (plan.addressee && !cur.sharoushi.name) done.push(`宛名「${plan.addressee} 御中」`);
  if (plan.companyLine && !cur.sharoushi.companyLine) done.push("会社名の行");
  if (extraStaff.length > cur.extraStaff.length) done.push(`アカウントのない社員 ${extraStaff.length - cur.extraStaff.length} 人`);
  if (!done.length) return [];
  let row: AppSetting | undefined = db.settings.find((x) => x.id === ATTENDANCE_SETTINGS_ID);
  if (!row) {
    row = { id: ATTENDANCE_SETTINGS_ID, value: {}, updatedBy: opts.userId, updatedAt: opts.now };
    db.settings.push(row);
  }
  row.value = { ...cur, profiles, extraStaff, sharoushi } as unknown as Record<string, unknown>;
  row.updatedBy = opts.userId;
  row.updatedAt = opts.now;
  return done;
}

export interface WorkbookImportResult {
  months: string[];
  finalized: string[];
  setup: string[];
  extras: string[];
}

/** 取込の結果の文 (画面の知らせ・変更履歴) */
export function workbookImportSummary(r: WorkbookImportResult): string {
  const a = [`勤怠月次を取り込みました: ${r.months.join("、")}`];
  if (r.finalized.length) a.push(`締めの過ぎた ${r.finalized.length} か月は確定 (送付済み) にしました`);
  if (r.setup.length) a.push(`設定に入れたもの: ${r.setup.join("・")}`);
  if (r.extras.length) a.push(`アカウントのない社員 (勤務表にだけ載せる): ${r.extras.join("・")}`);
  return a.join("。") + "。";
}

/**
 * 令和○年度.xlsx の取込 (画面の「以前の表の取込」と運用の手直しで共通。mutate の中)。
 * 締めの過ぎた月は確定にする (finalizePast)。一番新しい表から設定 (社員番号・パート・時給・宛名・アカウントのない社員) も入れる
 */
export function applyAttendanceWorkbook(
  db: Database,
  sheets: ParsedAttendanceSheet[],
  opts: { userId: string; now: string; today: string; makeId: (p: string) => string; sourceLabel?: string; force?: boolean; finalizePast?: boolean },
): WorkbookImportResult {
  const closing = hrSettings(db).closingDay;
  const out: WorkbookImportResult = { months: [], finalized: [], setup: [], extras: [] };
  for (const sheet of sheets) {
    const finalize = Boolean(opts.finalizePast) && closingRange(sheet.yearMonth, closing).to < opts.today;
    const r = applyAttendanceSheet(db, sheet, { userId: opts.userId, now: opts.now, makeId: opts.makeId, sourceLabel: opts.sourceLabel, force: opts.force, finalize });
    out.months.push(`${r.yearMonth} (${r.lines} 行)`);
    if (finalize) out.finalized.push(r.yearMonth);
  }
  const plan = planWorkbookSetup(db, sheets);
  if (plan) {
    out.setup = applyWorkbookSetup(db, plan, { userId: opts.userId, now: opts.now });
    out.extras = plan.extras.map((e) => e.name);
  }
  return out;
}

/** 労務士向け CSV (社員ブロック + パートブロック) */
export function attendanceCsv(db: Database, month: AttendanceMonth): string {
  const lines = (db.attendanceLines ?? []).filter((l) => l.monthId === month.id).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, "ja"));
  const staff = lines.filter((l) => l.kind === "staff");
  const part = lines.filter((l) => l.kind === "part");
  const out: string[] = [];
  out.push(`勤怠月次,${month.yearMonth},${month.payLabel ?? ""}`);
  out.push("区分,No,氏名,出勤日数,欠勤,遅刻・早退,残業,出勤時間,時給,有給,備考");
  for (const l of staff) {
    out.push(["社員", l.employeeNo ?? "", l.name, l.workDays ?? "", l.absenceDays ?? "", l.lateEarly ?? "", l.overtime ?? "", "", "", l.paidLeaveDays ?? "", (l.note ?? "").replace(/\n/g, " ")].join(","));
  }
  for (const l of part) {
    out.push(["パート", l.employeeNo ?? "", l.name, l.workDays ?? "", "", "", "", l.workHours ?? "", l.hourlyRate ?? "", l.paidLeaveDays ?? "", (l.note ?? "").replace(/\n/g, " ")].join(","));
  }
  return out.join("\n") + "\n";
}

export function attendanceStatusLabel(s: AttendanceMonth["status"]): string {
  return s === "final" ? "確定" : "下書き";
}

/** 表示用の年月ラベル (2026-11 → 2026年11月 / 令和8年11月) */
export function attendanceMonthLabel(yearMonth: string): string {
  const [y, m] = yearMonth.split("-").map(Number);
  if (!y || !m) return yearMonth;
  const reiwa = y - 2018;
  return `${y}年${m}月 (令和${reiwa}年${m}月)`;
}

/** 行が指定店舗の社員か (userId または氏名で照合。パートなどマスタにない人は false) */
export function attendanceLineStoreId(db: Pick<Database, "users" | "stores">, line: AttendanceLine): string | undefined {
  const u = line.userId ? db.users.find((x) => x.id === line.userId) : matchAttendanceUser(db, line.name);
  return u?.storeId;
}
