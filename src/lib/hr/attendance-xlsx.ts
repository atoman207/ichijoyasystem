import type { AttendanceLine, AttendanceMonth, Database } from "@/lib/db/types";
import { documentSettings } from "@/lib/doc-settings";
import { writeXlsx, type XCell, type XSheet } from "@/lib/xlsx-write";
import { attendanceSettings } from "./timecard";

/**
 * 労務士へ送る勤務表の .xlsx (いまの「令和○年度.xlsx」と同じ並び。取り込み直せる = src/lib/hr/attendance.ts の parseAttendanceSheet)
 * ------------------------------------------------------------
 * A1 宛名「○○ 御中」/ A2 会社名 / G4「令和 8年 11月分」/ G5「11/30支給」/
 * 社員: No・氏名・出勤日数・欠勤・遅刻・早退・残業・備考・有給 / パート: No・氏名・出勤日数・出勤時間・計 (時給)・備考・有休取得
 */

const reiwa = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return `令和　${y - 2018}年　${m}月分`;
};

/** シート名 (令和 8 年 11 月分 = 「8.11」。いまのブックと同じ) */
export const sheetNameOf = (ym: string) => `${Number(ym.slice(0, 4)) - 2018}.${Number(ym.slice(5, 7))}`;

const b = (v: XCell, extra: { bold?: boolean; wrap?: boolean; align?: "center" | "right" } = {}): XCell => ({ v: v as string | number | null | undefined, border: true, ...extra });

export function attendanceSheet(db: Pick<Database, "settings" | "stores" | "attendanceLines">, month: AttendanceMonth): XSheet {
  const s = attendanceSettings(db);
  const company = documentSettings(db).companyName;
  const lines = (db.attendanceLines ?? []).filter((l) => l.monthId === month.id).sort((a, c) => a.sort - c.sort || a.name.localeCompare(c.name, "ja"));
  const staff = lines.filter((l) => l.kind === "staff");
  const part = lines.filter((l) => l.kind === "part");
  const rows: XCell[][] = [];
  rows.push([{ v: `${s.sharoushi.name || "労務士事務所"} 御中`, bold: true }]);
  rows.push([company]);
  rows.push([]);
  rows.push(["", "", "", "", "", "", { v: reiwa(month.yearMonth), bold: true }]);
  rows.push(["", "", "", "", "", "", month.payLabel ?? ""]);
  rows.push([{ v: "社員", bold: true }]);
  rows.push(["No", "氏名", "出勤日数", "欠勤", "遅刻・早退", "残業", "備考", "有給"].map((h) => b(h, { bold: true })));
  const num = (n?: number) => (n === undefined || n === null ? "" : n);
  for (const l of staff) rows.push([b(l.employeeNo ?? ""), b(l.name), b(num(l.workDays), { align: "right" }), b(num(l.absenceDays), { align: "right" }), b(l.lateEarly ?? "", { align: "right" }), b(l.overtime ?? "", { align: "right" }), b(l.note ?? "", { wrap: true }), b(num(l.paidLeaveDays), { align: "right" })]);
  if (part.length) {
    rows.push([]);
    rows.push([{ v: "パート", bold: true }]);
    rows.push(["No", "氏名", "出勤日数", "出勤時間", "計", "", "備考", "有休取得"].map((h) => b(h, { bold: true })));
    for (const l of part as AttendanceLine[]) rows.push([b(l.employeeNo ?? ""), b(l.name), b(num(l.workDays), { align: "right" }), b(l.workHours ?? "", { align: "right" }), b(l.hourlyRate ? `＠${l.hourlyRate.toLocaleString("ja-JP")}` : "", { align: "right" }), b(""), b(l.note ?? "", { wrap: true }), b(num(l.paidLeaveDays), { align: "right" })]);
  }
  return { name: sheetNameOf(month.yearMonth), rows, widths: [6, 14, 9, 9, 11, 9, 46, 8] };
}

export function attendanceXlsx(db: Pick<Database, "settings" | "stores" | "attendanceLines">, month: AttendanceMonth): Buffer {
  return writeXlsx([attendanceSheet(db, month)]);
}

/** ファイル名「出勤簿_令和8年11月分.xlsx」 */
export function attendanceFileName(month: Pick<AttendanceMonth, "yearMonth">): string {
  const [y, m] = month.yearMonth.split("-").map(Number);
  return `出勤簿_令和${y - 2018}年${m}月分.xlsx`;
}
