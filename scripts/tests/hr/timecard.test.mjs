// 実行: npm run test:hr (または node scripts/tests/hr/timecard.test.mjs)
// 打刻・勤務表・申請と承認・労務士へ送る勤務表 (キャスタイムの代わり。お客様のご要望 2026-11-26)。
// 社内総合マニュアル (給与〆) の決まり: 休憩はとった時間だけ引く (早退・遅刻で休憩をとっていない時間は労働)・遅刻早退・シフト外残業 − 固定残業・深夜・
// 20 日締め・休日出勤は承認で振休・備考 (振休消化・休日出勤・独自休暇・インセンティブ (現金))・役員は載せない。2031 年の日付だけを使う
import { imp, ok, eq, throws, section, summary } from "./harness.mjs";

const store = await imp("lib/db/store.ts");
const T = await imp("lib/hr/timecard.ts");
const TA = await imp("lib/hr/timecard-apply.ts");
const B = await imp("lib/hr/attendance-build.ts");
const X = await imp("lib/hr/attendance-xlsx.ts");
const ATT = await imp("lib/hr/attendance.ts");
const INC = await imp("lib/hr/incentive-month.ts");
const L = await imp("lib/hr/leave.ts");
const LA = await imp("lib/hr/apply.ts");
const P = await imp("lib/auth/permissions.ts");
const SCHEMA = await imp("lib/db/schema.ts");
const MODEL = await imp("lib/datastore/model.ts");
const MIG = await imp("lib/db/migrate.ts");
const XR = await imp("lib/xlsx.ts");

const db = store.getDb();
for (const k of ["attendanceDays", "attendanceRequests", "attendanceMonths", "attendanceLines", "leaveRequests", "leaveGrants", "holidayWorks"]) db[k] = [];
db.schedule = db.schedule.filter((e) => e.date < "2031-01-01");
db.reviews = (db.reviews ?? []).filter((r) => r.postedOn < "2031-01-01");
db.holidays = []; // 登録がない = 日曜だけ休み
db.settings = db.settings.filter((s) => s.id !== T.ATTENDANCE_SETTINGS_ID && s.id !== L.HR_SETTINGS_ID && !s.id.startsWith("attendance_incentive_"));
const setAtt = (v) => {
  db.settings = db.settings.filter((s) => s.id !== T.ATTENDANCE_SETTINGS_ID);
  db.settings.push({ id: T.ATTENDANCE_SETTINGS_ID, value: v, updatedAt: new Date().toISOString() });
};
setAtt({ startDate: "2031-02-21" });

const pick = (f, msg) => {
  const u = db.users.find(f);
  if (!u) throw new Error(`サンプルデータに ${msg} がいません`);
  return u;
};
const admin = pick((u) => u.active && u.role === "admin", "管理者");
const hq = pick((u) => u.active && u.role === "hq_staff", "本部スタッフ");
const managerK = pick((u) => u.active && u.role === "store_manager" && u.storeId === "koshi", "合志店の店長");
const managerC = pick((u) => u.active && u.role === "store_manager" && u.storeId === "chuo", "中央店の店長");
const staff = pick((u) => u.active && u.role === "store_staff" && u.storeId === "koshi", "合志店の店舗スタッフ");
const chuo = pick((u) => u.active && u.role === "store_staff" && u.storeId === "chuo", "中央店の店舗スタッフ");

const s0 = T.attendanceSettings(db);
const hr = L.hrSettings(db);
const shift = s0.shifts[0];
const ctx = (category = "craft", today = "2031-03-25") => ({ db, s: T.attendanceSettings(db), hr, category, shift, today });
const rec = (date, i, o, extra = {}) => ({ id: T.dayRecordId("x", date), userId: "x", storeId: "koshi", date, clockIn: i ? T.isoOnDay(date, T.toMin(i)) : undefined, clockOut: o ? T.isoOnDay(date, T.toMin(o)) : undefined, log: [], createdAt: "", updatedAt: "", ...extra });
const day = (date, i, o, opts = {}) => T.calcDay(ctx(opts.category), date, { record: rec(date, i, o, opts.rec), leaves: opts.leaves ?? [], holidayWork: opts.hw });

section("シフトと設定の既定 (マニュアル: 社員の休憩は 10:30〜10:45・12:00〜13:00・14:30〜14:45 の計 1.5 時間)");
{
  eq(shift.breaks.map((b) => `${b.start}-${b.end}`), ["10:30-10:45", "12:00-13:00", "14:30-14:45"], "社員のシフトの休憩 3 つ");
  eq([s0.fixedOvertime.craft, s0.fixedOvertime.office], [30, 20], "固定残業: 職人 30 時間・事務 20 時間");
  eq([s0.incentives.review.yen, s0.incentives.inspection.yen], [1000, 500], "口コミ 1 点 1,000 円・点検 1 件 500 円");
  eq([s0.incentives.review.pay, s0.incentives.inspection.pay, s0.incentives.inspection.period], ["cash", "cash", "prev_month"], "点検も口コミと同じ運用 (前月 1 日〜末日・現金) が既定 (お客様 2026-11-26)");
  eq(T.staffCategory(s0, admin), "officer", "管理者は役員 (勤務表に出さない) が既定");
  eq(T.fmtHm(81), "1:21", "fmtHm");
  eq(T.clock(1530), "25:30", "翌日の朝は 24 時より後");
}

section("1 日の計算");
{
  const d = day("2031-03-03", "08:00", "17:00");
  eq([d.breakMin, d.workedMin, d.lateMin, d.earlyMin, d.outsideMin], [90, 450, 0, 0, 0], "定時: 休憩 1:30・勤務 7:30");
  const late = day("2031-03-04", "08:21", "17:00");
  eq([late.lateMin, late.workedMin], [21, 429], "遅刻 0:21");
  const lunch = day("2031-03-04", "12:30", "17:00");
  eq(lunch.lateMin, 225, "昼休みの途中 12:30 に出勤 = 遅刻は午前の勤務時間 3:45 (8:00〜12:00 − 10:30 の休憩 15 分。昼休みの 30 分は除く)");
  const early = day("2031-03-05", "08:00", "10:39");
  eq([early.breakMin, early.workedMin, early.earlyMin], [0, 159, 300], "10:39 に早退 = 休憩はとっていない (0) ・勤務 2:39・早退は残りの勤務時間 5:00 (マニュアルの例)");
  const early2 = day("2031-03-05", "08:00", "12:00");
  eq([early2.breakMin, early2.workedMin, early2.earlyMin], [15, 225, 225], "12:00 に早退 = 10:30 の休憩だけ引く");
  const ot = day("2031-03-06", "08:00", "18:30");
  eq([ot.outsideMin, ot.workedMin], [90, 540], "18:30 退勤 = シフト外残業 1:30");
  const night = day("2031-03-07", "08:00", "23:00");
  eq([night.nightMin, night.outsideMin], [60, 360], "23:00 退勤 = 深夜 1:00");
  const nextDay = day("2031-03-07", "08:00", "25:30");
  eq([nextDay.nightMin, nextDay.outsideMin], [210, 510], "翌 1:30 退勤 = 深夜 3:30");
  const amLeave = day("2031-03-10", "13:00", "17:00", { leaves: [{ type: "paid", slot: "am", requestId: "r" }] });
  eq([amLeave.lateMin, amLeave.earlyMin, amLeave.workedMin], [0, 0, 225], "午前休 → 13:00 出勤は遅刻ではない");
  const amOnly = day("2031-03-10", undefined, undefined, { leaves: [{ type: "paid", slot: "am", requestId: "r" }] });
  eq([amOnly.absent, amOnly.earlyMin], [false, 225], "午前休で午後に来なかった = 欠勤ではなく残りの半日 (欠勤の時間) を遅刻・早退に");
  const absent = day("2031-03-11");
  ok(absent.absent && !absent.attended, "打刻も休暇もない出勤日 = 全日欠勤");
  ok(!day("2031-02-18").absent, "打刻を使い始めた日より前は欠勤に数えない");
  ok(!day("2031-03-11", undefined, undefined, { category: "part" }).absent, "パートは欠勤を数えない");
  const miss = day("2031-03-12", "08:00");
  ok(miss.missing === "out" && miss.workedMin === 0 && miss.warnings.length > 0, "退勤の打刻漏れ");
  const today = T.calcDay(ctx("craft", "2031-03-12"), "2031-03-12", { record: rec("2031-03-12", "08:00"), leaves: [] });
  ok(today.working && !today.missing, "今日の退勤前は出勤中 (打刻漏れではない)");
  const sun = day("2031-03-09", "08:00", "12:00");
  ok(sun.dayType === "legal_off" && !sun.attended && sun.warnings.some((w) => w.includes("休日出勤の申請")), "日曜 (法定休日) の打刻は休日出勤の承認まで出勤に数えない");
  const sunOk = day("2031-03-09", "08:00", "12:00", { hw: { id: "hw", slot: "am", days: 0.5 } });
  ok(sunOk.attended && sunOk.lateMin === 0 && sunOk.workedMin === 225, "休日出勤 (午前) の承認があれば出勤 (遅刻早退は数えない)");
  const skip = day("2031-03-13", "08:00", "17:00", { rec: { skipBreaks: [0, 2] } });
  eq(skip.breakMin, 60, "外した休憩 (申請で「とらなかった」) は引かない");
  db.holidays = [{ id: "h1", date: "2031-03-15", label: "一斉休日" }];
  eq(T.dayTypeOf(db, T.attendanceSettings(db), "2031-03-15"), "scheduled_off", "日曜以外の休業日 = 所定休日");
  db.holidays = [];
}

section("締め・支給日");
{
  eq(T.attendancePeriod(db, "2031-03"), { from: "2031-02-21", to: "2031-03-20" }, "3 月分 = 2/21〜3/20 (20 日締め)");
  eq(T.attendanceMonthOf(db, "2026-11-20"), "2026-11", "11/20 は 11 月分");
  eq(T.attendanceMonthOf(db, "2026-11-21"), "2026-12", "11/21 は 12 月分");
  eq(T.attendanceMonthOf(db, "2026-12-25"), "2027-01", "12/25 は翌年 1 月分");
  eq(T.payLabelOf("2026-11"), "11/30支給", "11 月分は 11/30 支給");
  eq(T.payLabelOf("2026-10"), "10/30支給", "10/31 が土曜 → 10/30 (いまの勤務表と同じ)");
}

section("打刻 (本人)");
{
  const at = (iso) => new Date(iso);
  const r1 = TA.stamp(db, staff, "in", at("2031-03-03T08:02:00+09:00"));
  eq([r1.time, r1.record.date], ["08:02", "2031-03-03"], "出勤 8:02");
  throws(() => TA.stamp(db, staff, "in", at("2031-03-03T08:05:00+09:00")), "打刻済み", "二重の出勤は断る");
  const r2 = TA.stamp(db, staff, "out", at("2031-03-03T17:04:00+09:00"));
  eq(r2.time, "17:04", "退勤 17:04");
  TA.stamp(db, staff, "in", at("2031-03-04T08:00:00+09:00"));
  const r3 = TA.stamp(db, staff, "out", at("2031-03-05T01:30:00+09:00"));
  eq([r3.record.date, r3.time], ["2031-03-04", "25:30"], "翌朝 1:30 の退勤は前の日の退勤");
  ok(r2.record.log.length === 2 && r2.record.log.every((l) => l.via === "stamp"), "打刻の記録が残る");
  ok(P.canStampAttendance(staff) && P.canStampAttendance(admin), "打刻は全員");
}

section("打刻修正の申請と承認");
{
  // 3/6 は出勤だけ (退勤の打刻漏れ)
  TA.stamp(db, staff, "in", new Date("2031-03-06T07:58:00+09:00"));
  throws(() => TA.createAttendanceRequest(db, staff, { userId: staff.id, kind: "correction", date: "2031-03-06", clockOut: "17:10", reason: "" }, "2031-03-25"), "理由", "理由は必須");
  throws(() => TA.createAttendanceRequest(db, staff, { userId: chuo.id, kind: "correction", date: "2031-03-06", clockOut: "17:10", reason: "x" }, "2031-03-25"), "権限", "店舗スタッフはほかの社員の申請はできない");
  throws(() => TA.createAttendanceRequest(db, staff, { userId: staff.id, kind: "correction", date: "2031-03-30", clockOut: "17:10", reason: "x" }, "2031-03-25"), "今日まで", "先の日は打刻修正できない");
  const r = TA.createAttendanceRequest(db, staff, { userId: staff.id, kind: "correction", date: "2031-03-06", clockOut: "17:10", reason: "退勤の押し忘れ" }, "2031-03-25");
  ok(!r.approved && r.request.status === "pending" && r.request.previous?.clockIn === "07:58", "店舗スタッフの申請は承認待ち (申請の前の打刻を残す)");
  throws(() => TA.createAttendanceRequest(db, staff, { userId: staff.id, kind: "correction", date: "2031-03-06", clockOut: "17:20", reason: "x" }, "2031-03-25"), "申請中", "同じ日の申請中は二重にしない");
  ok(!P.canApproveAttendance(staff, r.request) && !P.canApproveAttendance(managerC, r.request) && !P.canApproveAttendance(hq, r.request), "店舗スタッフ・ほかの店長・本部スタッフは承認しない");
  ok(P.canApproveAttendance(managerK, r.request) && P.canApproveAttendance(admin, r.request), "自店舗の店長・管理者が承認");
  TA.decideAttendanceRequest(db, managerK, r.request.id, "approved", "");
  const recd = db.attendanceDays.find((x) => x.id === T.dayRecordId(staff.id, "2031-03-06"));
  eq(TA.hmOf(recd.clockOut, recd.date), "17:10", "承認で退勤 17:10 を反映");
  ok(recd.log.some((l) => l.kind === "fix" && l.requestId === r.request.id && l.note === "退勤の押し忘れ"), "打刻の記録に修正・理由・申請が残る");
  // 承認の取消し = 申請の前に戻す
  TA.cancelAttendanceRequest(db, managerK, r.request.id, "誤り");
  const after = db.attendanceDays.find((x) => x.id === T.dayRecordId(staff.id, "2031-03-06"));
  ok(after.clockOut === undefined && after.clockIn !== undefined && after.log.some((l) => l.kind === "clear"), "承認の取消しで退勤の打刻を元 (なし) に戻す");
  // 店長が自店舗の社員の分を申請 = そのまま承認
  const r2 = TA.createAttendanceRequest(db, managerK, { userId: staff.id, kind: "correction", date: "2031-03-06", clockOut: "17:00", reason: "店長が確認" }, "2031-03-25");
  ok(r2.approved && r2.request.decidedBy === managerK.id, "店長が申請するとそのまま承認");
  throws(() => TA.decideAttendanceRequest(db, managerK, TA.createAttendanceRequest(db, managerK, { userId: managerK.id, kind: "correction", date: "2031-03-07", clockIn: "08:00", clockOut: "17:00", reason: "自分" }, "2031-03-25").request.id, "approved", ""), "自分の申請", "店長は自分の申請を承認できない (管理者が承認)");
  // 休憩を外す
  const r3 = TA.createAttendanceRequest(db, admin, { userId: staff.id, kind: "correction", date: "2031-03-03", skipBreaks: [2], reason: "午後の休憩をとらなかった" }, "2031-03-25");
  ok(r3.approved && db.attendanceDays.find((x) => x.id === T.dayRecordId(staff.id, "2031-03-03")).skipBreaks?.[0] === 2, "休憩を外す申請 (管理者はそのまま承認)");
}

section("休日出勤の申請 (承認で振休・予定表)");
{
  throws(() => TA.createAttendanceRequest(db, staff, { userId: staff.id, kind: "holiday_work", date: "2031-03-10", slot: "day", reason: "x" }, "2031-03-25"), "出勤日", "出勤日は休日出勤にできない");
  const before = L.compBalance(db, staff.id).remaining;
  TA.stamp(db, staff, "in", new Date("2031-03-09T08:00:00+09:00"));
  TA.stamp(db, staff, "out", new Date("2031-03-09T12:00:00+09:00"));
  const r = TA.createAttendanceRequest(db, staff, { userId: staff.id, kind: "holiday_work", date: "2031-03-09", slot: "am", reason: "納品" }, "2031-03-25");
  ok(!r.approved, "休日出勤の申請は承認待ち");
  TA.decideAttendanceRequest(db, admin, r.request.id, "approved", "");
  const hw = db.holidayWorks.find((w) => w.id === r.request.holidayWorkId);
  ok(hw && hw.days === 0.5 && hw.date === "2031-03-09", "承認で休日出勤 (振休 0.5 日) を登録");
  eq(L.compBalance(db, staff.id).remaining, before + 0.5, "振休の残りが 0.5 日増える");
  const ev = db.schedule.find((e) => e.id === r.request.eventId);
  ok(ev && ev.assigneeIds.includes(staff.id) && ev.title.includes("休日出勤"), "予定表に「休日出勤」を登録 (お客様のご要望: 休日出勤を予定表に反映)");
  const sum = T.periodSummary(db, staff, "2031-03-09", "2031-03-09", "2031-03-25");
  ok(sum.attendDays === 1 && sum.holidayWorkDays === 0.5, "承認後は休日の打刻が出勤日数に入る");
  TA.cancelAttendanceRequest(db, admin, r.request.id, "");
  ok(!db.holidayWorks.some((w) => w.id === r.request.holidayWorkId) && !db.schedule.some((e) => e.id === r.request.eventId), "取消しで振休と予定も消す");
  TA.createAttendanceRequest(db, admin, { userId: staff.id, kind: "holiday_work", date: "2031-03-09", slot: "am", reason: "納品" }, "2031-03-25");
}

section("権限 (閲覧・残日数)");
{
  ok(P.canViewAttendanceOf(staff, staff) && !P.canViewAttendanceOf(staff, chuo), "店舗スタッフは自分の勤務表だけ");
  ok(P.canViewAttendanceOf(managerK, staff) && !P.canViewAttendanceOf(managerK, chuo), "店長は自店舗の社員の勤務表 (店長の責任で申請)");
  ok(P.canViewAttendanceOf(hq, chuo) && P.canViewAttendanceOf(admin, chuo), "本部・管理者は全員");
  ok(!P.canViewLeaveBalanceOf(managerK, staff) && P.canViewLeaveBalanceOf(hq, staff) && P.canViewLeaveBalanceOf(staff, staff), "ほかの社員の残日数は本部・管理者だけ (お客様のご要望)");
  ok(P.canManageAttendance(hq) && !P.canManageAttendance(managerK) && P.canManageAttendanceRules(admin) && !P.canManageAttendanceRules(hq), "勤務表の作成・送信は本部・管理者、決まりは管理者");
  const scope = MODEL.scopeStatements(staff).join("\n");
  ok(scope.includes("create temp view attendance_days") && scope.includes(`attendance_days where user_id = '${staff.id}'`), "AI の SQL: 店舗スタッフは自分の打刻だけ");
  ok(MODEL.scopeStatements(managerK).join("\n").includes("attendance_requests where user_id in (select id from main.users where store_id = 'koshi')"), "AI の SQL: 店長は自店舗の社員の申請");
  ok(!MODEL.scopeStatements(managerK).join("\n").includes("calc from main.attendance_lines"), "AI の SQL: 店長には勤務表の計算の内訳 (残日数を含む) を出さない");
}

section("労務士へ送る勤務表を作る (2031 年 3 月分 = 2/21〜3/20)");
{
  // staff2 (合志店の別の店舗スタッフ) を使う: 毎日 8:00〜17:00、1 日欠勤、1 日遅刻、残業は固定残業を超える分
  const u = pick((x) => x.active && x.role === "store_staff" && x.storeId === "koshi" && x.id !== staff.id, "合志店の店舗スタッフ (2 人目)");
  const days = T.datesBetween("2031-02-21", "2031-03-20").filter((d) => T.weekdayOf(d) !== 0);
  for (const d of days) {
    if (d === "2031-03-11") continue; // 欠勤
    if (d === "2031-03-12") continue; // 有給 (下で申請)
    const out = d <= "2031-03-08" ? "19:30" : "17:00"; // 前半 2 週間ほど毎日 2:30 のシフト外残業
    const i = d === "2031-03-04" ? "08:21" : "08:00";
    db.attendanceDays.push({ id: T.dayRecordId(u.id, d), userId: u.id, storeId: u.storeId, date: d, clockIn: T.isoOnDay(d, T.toMin(i)), clockOut: T.isoOnDay(d, T.toMin(out)), log: [], createdAt: "", updatedAt: "" });
  }
  db.leaveGrants.push({ id: "g1", userId: u.id, kind: "grant", grantDate: "2030-10-01", expiresOn: "2032-09-30", days: 10, createdBy: admin.id, createdAt: "" });
  LA.createLeave(db, admin, { userId: u.id, leaveType: "paid", date: "2031-03-12", slot: "day" });
  LA.createLeave(db, admin, { userId: u.id, leaveType: "special", date: "2031-03-13", slot: "day", reason: "忌引き" });
  db.attendanceDays = db.attendanceDays.filter((r) => !(r.userId === u.id && r.date === "2031-03-13"));
  db.reviews.push({ id: "rv1", postedOn: "2031-02-10", storeId: u.storeId, userId: u.id, points: 3, createdBy: admin.id, createdAt: "", updatedAt: "" });
  db.schedule.push({ id: "ev-insp", title: "点検", kind: "visit", date: "2031-02-15", storeId: u.storeId, assigneeIds: [], inspectionBy: u.id, source: "manual" });
  db.schedule.push({ id: "ev-insp2", title: "点検 (先)", kind: "visit", date: "2031-04-15", storeId: u.storeId, assigneeIds: [], inspectionBy: u.id, source: "manual" });
  TA.stamp(db, staff, "in", new Date("2031-03-17T08:00:00+09:00")); // 退勤の打刻漏れ (確かめることに出る)
  const built = B.buildAttendanceMonth(db, "2031-03", "2031-03-25");
  const line = built.lines.find((l) => l.userId === u.id);
  const sum = built.summaries.get(u.id);
  const workDays = days.length - 3; // 欠勤・有給・特別休暇
  eq(line.workDays, workDays, `出勤日数 ${workDays} 日`);
  eq(line.absenceDays, 1, "欠勤 1 日");
  eq(line.lateEarly, "0:21", "遅刻・早退 0:21");
  const outside = days.filter((d) => d <= "2031-03-08" && d !== "2031-03-04").length * 150 + 150; // 3/4 も 19:30 まで
  eq(sum.outsideMin, outside, "シフト外残業の合計");
  eq(line.overtime, outside > 1800 ? T.fmtHm(outside - 1800) : undefined, "残業 = シフト外残業 − 固定残業 30 時間");
  eq(line.paidLeaveDays, 1, "有給 1 日");
  ok(line.note.includes("独自休暇1日（忌引き）"), "備考: 独自休暇 (理由)");
  ok(line.note.includes("インセンティブ￥3,500（現金）"), `備考: 口コミ 3 点 + 点検 1 件 = ￥3,500 (現金) (got ${line.note})`);
  ok(!built.lines.some((l) => l.userId === admin.id), "役員 (管理者) は載せない");
  eq(built.payLabel, "3/31支給", "支給日");
  ok(line.calc.incentiveItems.some((x) => x.label === "点検" && x.yen === 500), "点検は予定の日が過ぎたものだけ (4 月の点検は数えない)");
  // 手入力の調整
  db.settings.push({ id: INC.incentiveAdjustId("2031-03"), value: { items: { [u.id]: { inspection: 4 } } }, updatedAt: "" });
  const built2 = B.buildAttendanceMonth(db, "2031-03", "2031-03-25");
  ok(built2.lines.find((l) => l.userId === u.id).note.includes("インセンティブ￥5,000（現金）"), "点検の件数を手入力 (4 件) → ￥5,000");
  // 点検を給与 (成果給) にする設定
  setAtt({ startDate: "2031-02-21", incentives: { inspection: { enabled: true, yen: 500, period: "prev_month", pay: "salary" } } });
  const built3 = B.buildAttendanceMonth(db, "2031-03", "2031-03-25");
  const n3 = built3.lines.find((l) => l.userId === u.id).note;
  ok(n3.includes("インセンティブ￥2,000") && n3.includes("インセンティブ￥3,000（現金）"), `点検を成果給にすると別の金額 (${n3})`);
  setAtt({ startDate: "2031-02-21" });
  ok(built.warnings.some((w) => w.includes(staff.name) && w.includes("打刻漏れ")), "確かめること: 打刻漏れの社員を挙げる (3/6 の退勤なし)");

  // 書き込み → .xlsx → 取り込み直し (いまの令和○年度.xlsx と同じ並び)
  const res = B.applyBuiltMonth(db, built, { userId: hq.id, now: new Date().toISOString(), makeId: store.newId });
  ok(res.lines === built.lines.length && db.attendanceLines.every((l) => l.monthId !== res.month.id || l.source === "auto"), "下書きとして書き込む (source = auto)");
  db.attendanceLines.push({ id: "manual1", monthId: res.month.id, kind: "part", sort: 99, name: "手入力の人", source: "manual", createdAt: "", updatedAt: "" });
  B.applyBuiltMonth(db, built, { userId: hq.id, now: new Date().toISOString(), makeId: store.newId });
  ok(db.attendanceLines.some((l) => l.id === "manual1"), "作り直しても手で足した行は残す");
  const buf = X.attendanceXlsx(db, res.month);
  const parsed = ATT.parseAttendanceWorkbook(buf);
  eq(parsed[0]?.yearMonth, "2031-03", ".xlsx を取り込み直すと同じ月 (シート名 13.3 = 令和 13 年 3 月)");
  const back = parsed[0].lines.find((l) => l.name === u.name);
  eq([back?.workDays, back?.absenceDays, back?.lateEarly, back?.paidLeaveDays], [workDays, 1, "0:21", 1], ".xlsx の値が取り込み直しで同じ");
  ok(String(back?.note).includes("インセンティブ"), ".xlsx の備考");
  const sheets = XR.readXlsx(buf);
  ok(sheets[0].rows.get(1).get("A").endsWith("御中"), "A1 = 宛名「○○ 御中」");
  res.month.status = "final";
  throws(() => B.applyBuiltMonth(db, built, { userId: hq.id, now: "", makeId: store.newId }), "確定済み", "確定した月は作り直さない");
}

section("備考の書き方 (いまの勤務表と同じ)");
{
  eq(B.noteFor({ compDays: 1, holidayWorkDays: 1, specialDays: 0, specialReasons: [], nightMin: 0 }, ["インセンティブ￥2,000（現金）"]), "振休消化1日 休日出勤1日\nインセンティブ￥2,000（現金）", "振休消化・休日出勤 → 改行 → インセンティブ");
  eq(B.noteFor({ compDays: 0.5, holidayWorkDays: 0, specialDays: 0, specialReasons: [], nightMin: 90 }, []), "振休消化0.5日 深夜残業1:30", "半日・深夜残業");
  eq(INC.incentiveNote({ cash: 11000, salary: 0 }), ["インセンティブ￥11,000（現金）"], "金額の書き方");
}

section("以前の表 (令和○年度.xlsx) の取込 → 設定 (社員番号・パート・時給・宛名・アカウントのない社員) → 次の月の勤務表 (お客様の表 2026-11-26)");
{
  const now = new Date().toISOString();
  db.attendanceMonths = [];
  db.attendanceLines = [];
  setAtt({ startDate: "2031-02-21", profiles: { [chuo.id]: { rates: [{ from: "2030-12-21", yen: 1040, changed: true }] } }, sharoushi: { name: "テスト労務士事務所", companyLine: "株式会社　　　テスト" } });
  eq(T.rateChangeNote(T.attendanceSettings(db), chuo.id, "2031-04-20"), "時給変更2030.12.21～＠1,040", "右の欄の書き方 (以前の表と同じ)");
  // 以前の表 (2031-04 = 令和 13 年 4 月分) を作って .xlsx にする (お預かりした表と同じ並び)
  const m4 = { id: "attm_old", yearMonth: "2031-04", payLabel: "4/30支給", status: "final", createdBy: admin.id, createdAt: now, updatedBy: admin.id, updatedAt: now };
  db.attendanceMonths.push(m4);
  const L4 = (o) => ({ id: store.newId("attl"), monthId: m4.id, source: "import", createdAt: now, updatedAt: now, ...o });
  db.attendanceLines.push(
    L4({ kind: "staff", sort: 0, employeeNo: "18", userId: staff.id, name: staff.name.replace(" ", "　"), workDays: 21, lateEarly: "0:21", paidLeaveDays: 4, note: "インセンティブ￥5,000（現金）" }),
    L4({ kind: "staff", sort: 1, employeeNo: "56", name: "架空　次郎", workDays: 8, absenceDays: 6, paidLeaveDays: 10.5, note: "振休消化0.5日" }),
    L4({ kind: "part", sort: 2, employeeNo: "53", userId: chuo.id, name: chuo.name, workDays: 16, workHours: "82:48", hourlyRate: 1040 }),
  );
  const buf = X.attendanceXlsx(db, m4);
  const files = (await imp("lib/xlsx.ts")).zipEntries(buf);
  const sheetXml = files.get("xl/worksheets/sheet1.xml").toString("utf8");
  const stylesXml = files.get("xl/styles.xml").toString("utf8");
  ok(stylesXml.includes("ＭＳ Ｐゴシック") && stylesXml.includes('<sz val="18"/>') && stylesXml.includes("<u/>"), "フォント ＭＳ Ｐゴシック・宛名 18pt・会社名は下線 (以前の表と同じ)");
  ok(sheetXml.includes('<mergeCell ref="A1:H1"/>') && sheetXml.includes('<mergeCell ref="A2:H2"/>') && sheetXml.includes('paperSize="9"') && sheetXml.includes('fitToPage="1"'), "宛名・会社名の結合、A4 縦で 1 ページ");
  ok(sheetXml.includes('<row r="8" ht="33.75" customHeight="1">') && sheetXml.includes('<col min="7" max="7" width="27.5" customWidth="1"/>'), "行の高さ・列の幅");
  const rows4 = XR.readXlsx(buf)[0].rows;
  eq(rows4.get(21)?.get("A"), "パート", "社員の枠は 12 行 (8〜19 行目) → 21 行目に「パート」(以前の表と同じ位置)");
  eq([rows4.get(2)?.get("A"), rows4.get(4)?.get("G"), rows4.get(8)?.get("A")], ["株式会社　　　テスト", "　　　　　令和　13年　4月分", "18"], "会社名の行・月の見出し・社員番号は数");
  eq(rows4.get(23)?.get("J"), "時給変更2030.12.21～＠1,040", "パートの右の欄に時給の変更");
  ok(!rows4.get(23)?.get("G"), "時給の変更は備考に書かない");

  // 取り込む (設定はまだ空 = お預かりした表を初めて入れるとき)
  setAtt({ startDate: "2031-02-21" });
  db.attendanceMonths = [];
  db.attendanceLines = [];
  const sheets = ATT.parseAttendanceWorkbook(buf);
  eq([sheets[0].addressee, sheets[0].companyLine], ["テスト労務士事務所", "株式会社　　　テスト"], "宛名 (御中の前) と会社名の行 (空白もそのまま)");
  eq(sheets[0].lines.find((l) => l.kind === "part")?.rateChange, { from: "2030-12-21", yen: 1040 }, "右の欄の「時給変更2030.12.21～＠1,040」");
  eq(ATT.parseRateChange("時給変更2025.12.21～＠1,040"), { from: "2025-12-21", yen: 1040 }, "時給の変更の読み取り");
  const r = ATT.applyAttendanceWorkbook(db, sheets, { userId: admin.id, now, today: "2031-06-01", makeId: store.newId, sourceLabel: "令和13年度.xlsx", finalizePast: true });
  eq([r.finalized, db.attendanceMonths.find((m) => m.yearMonth === "2031-04")?.status], [["2031-04"], "final"], "締めの過ぎた月は確定 (送付済み)");
  const s1 = T.attendanceSettings(db);
  eq([s1.profiles[staff.id]?.employeeNo, s1.profiles[chuo.id]?.employeeNo, s1.profiles[chuo.id]?.category], ["18", "53", "part"], "社員番号・パートを設定に入れる");
  eq(s1.profiles[chuo.id]?.rates, [{ from: "2030-12-21", yen: 1040, changed: true }], "時給と変更日");
  eq([s1.sharoushi.name, s1.sharoushi.companyLine], ["テスト労務士事務所", "株式会社　　　テスト"], "宛名・会社名の行");
  eq(s1.extraStaff.map((e) => [e.name, e.kind, e.employeeNo]), [["架空 次郎", "staff", "56"]], "アカウントに当たらない人は「勤務表にだけ載せる社員」");
  ok(r.extras.includes("架空 次郎") && ATT.workbookImportSummary(r).includes("アカウントのない社員"), "取込の知らせにアカウントのない社員");
  // 画面で直した値は取り込み直しで変えない
  const cur = db.settings.find((x) => x.id === T.ATTENDANCE_SETTINGS_ID).value;
  cur.profiles[staff.id].employeeNo = "99";
  ATT.applyAttendanceWorkbook(db, sheets, { userId: admin.id, now, today: "2031-06-01", makeId: store.newId, force: true, finalizePast: true });
  const s2 = T.attendanceSettings(db);
  eq([s2.profiles[staff.id]?.employeeNo, s2.extraStaff.length], ["99", 1], "取り込み直しても入れた値はそのまま・同じ人を二重にしない");
  cur.profiles[staff.id].employeeNo = "18";

  // 次の月 (2031-05) を打刻から作る: 並びは前の月の表のまま・アカウントのない人は空の行 (手で入れる)
  const built = B.buildAttendanceMonth(db, "2031-05", "2031-06-01");
  const order = built.lines.map((l) => l.name);
  ok(order.indexOf(staff.name) < order.indexOf("架空 次郎") && order.indexOf("架空 次郎") < order.indexOf(chuo.name), "前の月の表の並び (アカウントのない人も同じ位置)");
  const extra = built.lines.find((l) => l.name === "架空 次郎");
  eq([extra?.source, extra?.employeeNo, extra?.workDays, extra?.kind], ["manual", "56", undefined, "staff"], "アカウントのない人の行は数字を空に (手で入力)");
  ok(built.warnings.some((w) => w.startsWith("架空 次郎:")), "送る前の確かめにアカウントのない人");
  eq([built.lines.find((l) => l.userId === chuo.id)?.kind, built.lines.find((l) => l.userId === chuo.id)?.hourlyRate, built.lines.find((l) => l.userId === staff.id)?.employeeNo], ["part", 1040, "18"], "パートの行・時給・社員番号");
  ok(!/時給変更/.test(built.lines.find((l) => l.userId === chuo.id)?.note ?? ""), "時給の変更は備考に書かない (右の欄)");
  const res5 = B.applyBuiltMonth(db, built, { userId: hq.id, now, makeId: store.newId });
  const typed = db.attendanceLines.find((l) => l.monthId === res5.month.id && l.name === "架空 次郎");
  typed.workDays = 20;
  B.applyBuiltMonth(db, B.buildAttendanceMonth(db, "2031-05", "2031-06-01"), { userId: hq.id, now, makeId: store.newId });
  const again = db.attendanceLines.filter((l) => l.monthId === res5.month.id && l.name === "架空 次郎");
  eq([again.length, again[0]?.workDays, again[0]?.sort], [1, 20, typed.sort], "作り直しても手で入れた数字を同じ位置に残す (二重にしない)");
  const xr5 = XR.readXlsx(X.attendanceXlsx(db, res5.month))[0].rows;
  ok([...xr5.values()].some((row) => row.get("B") === "架空 次郎"), ".xlsx にアカウントのない人の行");
  // 最後の月を過ぎた人・アカウントができた人は載せない
  cur.extraStaff[0].until = "2031-04";
  ok(!B.buildAttendanceMonth(db, "2031-05", "2031-06-01").lines.some((l) => l.name === "架空 次郎"), "最後の月より後は載せない");
  cur.extraStaff[0].until = undefined;
  cur.extraStaff.push({ key: T.staffNameKey(staff.name), name: staff.name, kind: "staff" });
  eq(B.buildAttendanceMonth(db, "2031-05", "2031-06-01").lines.filter((l) => T.staffNameKey(l.name) === T.staffNameKey(staff.name)).length, 1, "アカウントのある人は打刻から (二重にしない)");
  cur.extraStaff.pop();
  db.attendanceMonths = [];
  db.attendanceLines = [];
  setAtt({ startDate: "2031-02-21" });
}

section("表・コレクション");
{
  for (const t of ["attendance_days", "attendance_requests"]) ok(SCHEMA.TABLES.some((x) => x.table === t), `schema に ${t}`);
  ok(SCHEMA.TABLES.find((x) => x.table === "schedule_events" || x.collection === "schedule").columns.some((c) => c[0] === "inspectionBy"), "予定に点検の電話をした人の列");
  ok(MIG.HR_COLLECTIONS.includes("attendanceDays") && MIG.HR_COLLECTIONS.includes("attendanceRequests"), "読み込みで空のコレクションを作る");
}

summary();
