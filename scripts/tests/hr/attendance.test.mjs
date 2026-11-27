// 実行: npm run test:hr (または node scripts/tests/hr/attendance.test.mjs)
// 勤怠月次 (労務士へ送る一覧。打刻・給与計算は対象外): シート名→年月、Excel 時刻、取込、権限
import fs from "node:fs";
import path from "node:path";
import { imp, ok, eq, throws, section, summary, root } from "./harness.mjs";

const store = await imp("lib/db/store.ts");
const A = await imp("lib/hr/attendance.ts");
const P = await imp("lib/auth/permissions.ts");
const SCHEMA = await imp("lib/db/schema.ts");
const MIG = await imp("lib/db/migrate.ts");

const db = store.getDb();
db.attendanceMonths = [];
db.attendanceLines = [];

const pick = (f, msg) => {
  const u = db.users.find(f);
  if (!u) throw new Error(`サンプルデータに ${msg} がいません`);
  return u;
};
const admin = pick((u) => u.active && u.role === "admin", "管理者");
const hq = pick((u) => u.active && u.role === "hq_staff", "本部スタッフ");
const managerK = pick((u) => u.active && u.role === "store_manager" && u.storeId === "koshi", "合志店の店長");
const staff = pick((u) => u.active && u.role === "store_staff" && u.storeId === "koshi", "合志店の店舗スタッフ");

section("シート名・ラベル → 年月");
{
  eq(A.sheetNameToYm("8.11"), "2026-11", "8.11 → 2026-11");
  eq(A.sheetNameToYm("8.7"), "2026-07", "8.7 → 2026-07");
  eq(A.labelToYm("令和　8年　11月分"), "2026-11", "令和ラベル");
  eq(A.reiwaMonthToYm(8, 11), "2026-11", "reiwaMonthToYm");
  eq(A.attendanceMonthLabel("2026-11").includes("令和8年11月"), true, "表示ラベルに令和");
}

section("時刻の正規化 (Excel シリアル・HH.MM)");
{
  eq(A.cleanTime("0:21"), "0:21", "そのまま");
  eq(A.cleanTime("0：32"), "0:32", "全角コロン");
  eq(A.cleanTime("6.6666666666666666E-2"), "1:36", "Excel シリアル → 1:36");
  eq(A.cleanTime("33.53"), "33:53", "HH.MM");
  eq(A.cleanTime("65.16ｈ"), "65:16", "パート出勤時間");
  eq(A.cleanTime(""), undefined, "空");
}

section("権限");
{
  ok(P.canViewAttendance(admin) && P.canViewAttendance(hq) && P.canViewAttendance(managerK), "店長以上は閲覧可");
  ok(!P.canViewAttendance(staff), "店舗スタッフは閲覧不可");
  ok(P.canManageAttendance(admin) && P.canManageAttendance(hq) && !P.canManageAttendance(managerK), "取込・確定は本部・管理者");
}

section("スキーマ・migrate");
{
  ok(SCHEMA.TABLES.some((t) => t.table === "attendance_months"), "attendance_months が schema にある");
  ok(SCHEMA.TABLES.some((t) => t.table === "attendance_lines"), "attendance_lines が schema にある");
  ok(MIG.HR_COLLECTIONS.includes("attendanceMonths") && MIG.HR_COLLECTIONS.includes("attendanceLines"), "migrate の HR_COLLECTIONS");
}

section("令和8年度.xlsx の取込 (お預かりした表。リポジトリにないので、ある環境でだけ確かめる。社員の名前はテストに書かない)");
{
  const file = path.join(root, "source", "15_人事・労務", "勤怠", "令和8年度_勤怠月次.xlsx");
  if (!fs.existsSync(file)) {
    ok(true, "お預かりした表がない環境なので省く (source/ はコミットしない)");
  } else {
    const sheets = A.parseAttendanceWorkbook(fs.readFileSync(file));
    eq(sheets.map((s) => s.yearMonth), ["2026-07", "2026-08", "2026-09", "2026-10", "2026-11"], "5 か月分");
    const nov = sheets.find((s) => s.yearMonth === "2026-11");
    ok(nov && nov.payLabel === "11/30支給", "11 月の支給ラベル");
    ok(Boolean(nov.addressee) && !nov.addressee.includes("御中"), "1 行目の宛名 (御中の前)");
    ok(Boolean(nov.companyLine), "2 行目の会社名");
    const staffLines = nov.lines.filter((l) => l.kind === "staff");
    ok(staffLines.length >= 5 && staffLines.every((l) => typeof l.workDays === "number"), "社員の行に出勤日数");
    ok(staffLines.every((l) => !l.lateEarly || /^\d{1,3}:\d{2}$/.test(l.lateEarly)), "遅刻・早退は Excel の時刻シリアル・全角のコロンも H:MM にそろえる");
    ok(staffLines.some((l) => l.lateEarly === "1:36"), "Excel の時刻シリアル (0.0666…) = 1:36");
    const part = nov.lines.find((l) => l.kind === "part");
    ok(part && /^\d+:\d{2}$/.test(part.workHours ?? "") && part.hourlyRate > 0, "パートの出勤時間・時給");
    ok(Boolean(part?.rateChange?.from), "パートの右の欄の「時給変更…」を読む");

    const now = "2026-11-26T00:00:00.000Z";
    const r = A.applyAttendanceSheet(db, nov, { userId: admin.id, now, makeId: store.newId, sourceLabel: "令和8年度_勤怠月次.xlsx" });
    eq(r.yearMonth, "2026-11", "apply の年月");
    ok(db.attendanceMonths.some((m) => m.yearMonth === "2026-11" && m.status === "draft"), "下書きの月が残る");
    ok(db.attendanceLines.filter((l) => l.monthId === r.monthId).length === nov.lines.length, "行数が一致");
    const csv = A.attendanceCsv(db, db.attendanceMonths.find((m) => m.id === r.monthId));
    ok(csv.includes(staffLines[0].name) && csv.includes(part.name) && csv.startsWith("勤怠月次,2026-11"), "CSV に社員・パート");

    throws(
      () => {
        db.attendanceMonths.find((m) => m.id === r.monthId).status = "final";
        A.applyAttendanceSheet(db, nov, { userId: admin.id, now, makeId: store.newId });
      },
      "確定済み",
      "確定済みは force なしで断る",
    );
    A.applyAttendanceSheet(db, nov, { userId: admin.id, now, makeId: store.newId, force: true });
    ok(db.attendanceMonths.find((m) => m.yearMonth === "2026-11").status === "draft", "force で下書きに戻る");
  }
}

section("有給・休日出勤からの候補");
{
  const u = db.users.find((x) => x.active && x.role === "store_staff");
  const now = new Date().toISOString();
  db.leaveRequests = [
    { id: "lr1", number: "L-1", userId: u.id, storeId: u.storeId, leaveType: "paid", slot: "day", date: "2026-11-10", dates: ["2026-11-10"], days: 1, status: "approved", requestedBy: u.id, requestedAt: now, updatedAt: now },
  ];
  db.holidayWorks = [
    { id: "hw1", userId: u.id, storeId: u.storeId, kind: "work", date: "2026-11-03", slot: "day", days: 1, createdBy: admin.id, createdAt: now },
  ];
  const sug = A.suggestFromLeave(db, u.id, "2026-11");
  eq(sug.paidLeaveDays, 1, "有給 1 日");
  ok(sug.noteParts.some((p) => p.includes("休日出勤")), "備考に休日出勤");
}

summary();
