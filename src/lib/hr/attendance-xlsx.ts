import type { AttendanceLine, AttendanceMonth, Database } from "@/lib/db/types";
import { documentSettings } from "@/lib/doc-settings";
import { writeXlsx, type XCell, type XSheet, type XStyle } from "@/lib/xlsx-write";
import { attendancePeriod, attendanceSettings, rateChangeNote } from "./timecard";

/**
 * 労務士へ送る勤務表の .xlsx (いまお使いの「令和○年度.xlsx」と同じ並び・見た目。取り込み直せる = src/lib/hr/attendance.ts の parseAttendanceSheet)
 * ------------------------------------------------------------
 * A1 宛名「○○ 御中」(A1:H1 を結合・18pt) / A2 会社名 (A2:H2 を結合・16pt 太字 下線・中央) / G4「令和　8年　11月分」/ G5「11/30支給」/
 * 6 行目「社員」→ 7 行目の見出し (No・氏名・出勤日数・欠勤・遅刻・早退・残業・備考・有給) → 8 行目から社員 (12 行の枠。多ければ足す) /
 * 「パート」→ 見出し (No・氏名・出勤日数・出勤時間・計 (E:F を結合)・備考・有休取得) → パート (右の欄 J に「時給変更…」)。
 * フォントは ＭＳ Ｐゴシック、列の幅・行の高さ・A4 縦で 1 ページに収める・余白は以前の表のまま
 */

const reiwa = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return `　　　　　令和　${y - 2018}年　${m}月分`;
};

/** シート名 (令和 8 年 11 月分 = 「8.11」。いまのブックと同じ) */
export const sheetNameOf = (ym: string) => `${Number(ym.slice(0, 4)) - 2018}.${Number(ym.slice(5, 7))}`;

/** 社員の行の枠の数 (以前の表は 8〜19 行目の 12 行) */
const STAFF_SLOTS = 12;

const cell = (v: XCell, st: XStyle = {}): XCell => ({ v: v as string | number | null | undefined, ...st });
const box = (v: XCell, st: XStyle = {}): XCell => cell(v, { border: true, ...st });
const num = (n?: number) => (n === undefined || n === null ? "" : n);
/** 社員番号は数で (以前の表と同じ) */
const no = (s?: string) => (s && /^\d+$/.test(s) ? Number(s) : (s ?? ""));

export function attendanceSheet(db: Pick<Database, "settings" | "stores" | "attendanceLines">, month: AttendanceMonth): XSheet {
  const s = attendanceSettings(db);
  const company = s.sharoushi.companyLine || documentSettings(db).companyName;
  const lines = (db.attendanceLines ?? []).filter((l) => l.monthId === month.id).sort((a, c) => a.sort - c.sort || a.name.localeCompare(c.name, "ja"));
  const staff = lines.filter((l) => l.kind === "staff");
  const part = lines.filter((l) => l.kind === "part");
  const rows: XCell[][] = [];
  const heights: (number | undefined)[] = [];
  const push = (row: XCell[], h?: number) => {
    rows.push(row);
    heights.push(h);
  };
  const merges = ["A1:H1", "A2:H2"];
  const periodEnd = attendancePeriod(db, month.yearMonth).to;
  const head = { size: 11, align: "center" as const };

  push([cell(`${s.sharoushi.name || "労務士事務所"} 御中`, { size: 18, align: "left" })], 30);
  push([cell(company, { size: 16, bold: true, underline: true, align: "center" })], 19.5);
  push([], 19.5);
  push(["", "", "", "", "", "", cell(reiwa(month.yearMonth), { size: 14 })], 19.5);
  push(["", "", "", "", "", "", cell(month.payLabel ?? "", { size: 14, align: "right" })], 19.5);
  push([cell("社員", { size: 16, bold: true })], 21.75);
  push([...["No", "氏名", "出勤日数", "欠勤", "遅刻・早退", "残業", "備考"].map((h) => box(h, head)), box("有給", { size: 10, align: "center" })], 30.75);
  const slots = Math.max(STAFF_SLOTS, staff.length);
  for (let i = 0; i < slots; i++) {
    const l: AttendanceLine | undefined = staff[i];
    push(
      [
        box(no(l?.employeeNo), { size: 12, align: "center" }),
        box(l?.name ?? "", { size: 16 }),
        box(num(l?.workDays), { size: 12, align: "center" }),
        box(num(l?.absenceDays), { size: 12, align: "center" }),
        box(l?.lateEarly ?? "", { size: 12, align: "center", text: true }),
        box(l?.overtime ?? "", { size: 12, align: "center", text: true }),
        box(l?.note ?? "", { size: 11, align: "left", wrap: true }),
        box(num(l?.paidLeaveDays), { size: 12, align: "center" }),
      ],
      33.75,
    );
  }
  push([], 55.5);
  push([cell("パート", { size: 16, bold: true })], 22.5);
  const partHead = rows.length + 1;
  push([box("No", head), box("氏名", head), box("出勤日数", head), box("出勤時間", head), box("計", head), box("", head), box("備考", head), box("有休取得", head)], 22.5);
  merges.push(`E${partHead}:F${partHead}`);
  for (const l of part.length ? part : [undefined]) {
    const r = rows.length + 1;
    const side = l?.userId ? rateChangeNote(s, l.userId, periodEnd) : undefined;
    push(
      [
        box(no(l?.employeeNo), { size: 11, align: "center" }),
        box(l?.name ?? "", { size: 16 }),
        box(num(l?.workDays), { size: 12, align: "center" }),
        box(l?.workHours ?? "", { size: 12, align: "center", text: true }),
        box(l?.hourlyRate ? `＠${l.hourlyRate.toLocaleString("ja-JP")}` : "", { size: 14, align: "center", text: true }),
        box("", { size: 14 }),
        box(l?.note ?? "", { size: 11, align: "left", wrap: true }),
        box(num(l?.paidLeaveDays), { size: 14, align: "center" }),
        "",
        side ? cell(side, { size: 11 }) : "",
      ],
      30,
    );
    merges.push(`E${r}:F${r}`);
  }
  return {
    name: sheetNameOf(month.yearMonth),
    rows,
    heights,
    merges,
    widths: [4.5, 17.25, 8.25, 8.25, 8.5, 8.25, 27.5, 10, 14.25, 15.5],
    page: { paper: 9, orientation: "portrait", fitToPage: true, margins: { left: 0.315, right: 0.197, top: 0.551, bottom: 0.512, header: 0.512, footer: 0.512 } },
  };
}

export function attendanceXlsx(db: Pick<Database, "settings" | "stores" | "attendanceLines">, month: AttendanceMonth): Buffer {
  return writeXlsx([attendanceSheet(db, month)], { font: "ＭＳ Ｐゴシック" });
}

/** ファイル名「出勤簿_令和8年11月分.xlsx」 */
export function attendanceFileName(month: Pick<AttendanceMonth, "yearMonth">): string {
  const [y, m] = month.yearMonth.split("-").map(Number);
  return `出勤簿_令和${y - 2018}年${m}月分.xlsx`;
}
