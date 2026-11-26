// 実行: npm run test:hr (または node scripts/tests/hr/leave.test.mjs)
// 有給・休日出勤の管理 (F-16) の回帰テスト: 受け入れ条件 (承認した有給が予定表に載り残日数が減る・休日出勤と振休の未取得一覧・
// 切り替え時点の残日数の取込)、半日、有効期限、古い付与からの消化、年度 (7 月〜翌 6 月)、権限、振休のため込みの警告。
// 2031 年の日付だけを使い、サンプルデータの予定に左右されないようにする
import fs from "node:fs";
import path from "node:path";
import { imp, ok, eq, throws, section, summary, root } from "./harness.mjs";

const store = await imp("lib/db/store.ts");
const L = await imp("lib/hr/leave.ts");
const A = await imp("lib/hr/apply.ts");
const P = await imp("lib/auth/permissions.ts");
const CAL = await imp("lib/calendar.ts");
const SCHEMA = await imp("lib/db/schema.ts");
const MODEL = await imp("lib/datastore/model.ts");
const MIG = await imp("lib/db/migrate.ts");

const db = store.getDb();
db.leaveRequests = [];
db.leaveGrants = [];
db.holidayWorks = [];
db.schedule = db.schedule.filter((e) => e.date < "2031-01-01");
db.settings = db.settings.filter((s) => s.id !== L.HR_SETTINGS_ID);
// 既定はお客様の決定で「当年度分 (新しい付与) から」(2026-11-20)。消化の順番を確かめるテストは「古い付与から」の設定で行い、既定は別に確かめる
const OLDEST = () => { db.settings = db.settings.filter((s) => s.id !== L.HR_SETTINGS_ID); db.settings.push({ id: L.HR_SETTINGS_ID, value: { consumeOrder: "oldest" }, updatedAt: new Date().toISOString() }); };
if (L.hrSettings(db).consumeOrder !== "newest") throw new Error("既定の消化の順番が「当年度分から」ではありません");
OLDEST();
db.holidays = [];

const pick = (f, msg) => {
  const u = db.users.find(f);
  if (!u) throw new Error(`サンプルデータに ${msg} がいません`);
  return u;
};
const admin = pick((u) => u.active && u.role === "admin", "管理者");
const hq = pick((u) => u.active && u.role === "hq_staff", "本部スタッフ");
const managerK = pick((u) => u.active && u.role === "store_manager" && u.storeId === "koshi", "合志店の店長");
const managerC = pick((u) => u.active && u.role === "store_manager" && u.storeId === "chuo", "中央店の店長");
const koshiStaff = db.users.filter((u) => u.active && u.role === "store_staff" && u.storeId === "koshi");
const chuoStaff = db.users.filter((u) => u.active && u.role === "store_staff" && u.storeId === "chuo");
const staff = koshiStaff[0];
const staff2 = koshiStaff[1];
const chuo = chuoStaff[0];
const chuo2 = chuoStaff[1];
const leave = (actor, input) => A.createLeave(db, actor, { slot: "day", leaveType: "paid", ...input });
const grant = (userId, grantDate, days) => A.addGrant(db, hq, { userId, grantDate, days });
const bal = (u, asOf = "2031-05-01") => L.paidBalance(db, u.id, asOf);

/* ------------------------------------------------------------------ */
section("日付・法定の付与日数・年度・締め");
{
  eq([5, 6, 18, 30, 42, 54, 66, 78, 200].map((m) => L.statutoryGrantDays(m)), [0, 10, 11, 12, 14, 16, 18, 20, 20], "勤続 0.5 年 10 日〜6.5 年以上 20 日 (法定)");
  eq(L.statutoryGrantDays(6, 4), 7, "週 4 日は比例付与 (6 か月 7 日)");
  eq(L.serviceMonths("2020-04-01", "2020-10-01"), 6, "勤続の月数 (満)");
  eq(L.serviceMonths("2020-04-15", "2020-10-14"), 5, "勤続の月数 (日が足りない月は数えない)");
  eq(L.grantExpiry("2026-08-16"), "2028-08-15", "有効期限は付与から 2 年 (の前日まで)");
  eq([L.fiscalYearOf("2026-07-01"), L.fiscalYearOf("2026-06-30"), L.fiscalYearOf("2027-06-30")], [2026, 2025, 2026], "年度は 7 月始まり");
  eq(L.fiscalRange(2026), { from: "2026-07-01", to: "2027-06-30" }, "2026 年度 = 2026/7/1〜2027/6/30");
  ok(L.fiscalLabel(2026).includes("令和8年度"), "2026 年度 = 令和 8 年度 (休日出勤管理表の R8)");
  eq(L.closingRange("2026-11", 20), { from: "2026-10-21", to: "2026-11-20" }, "20 日締め: 前月 21 日〜当月 20 日");
  eq(L.closingRange("2027-03", 20), { from: "2027-02-21", to: "2027-03-20" }, "20 日締め (2 月をまたぐ)");
  eq(L.closingRange("2027-02", 31), { from: "2027-02-01", to: "2027-02-28" }, "月末締め");
  eq(L.parseDateLoose("R8.8.16"), "2026-08-16", "令和の日付を読む");
  eq(L.parseDateLoose("2026/3/2"), "2026-03-02", "スラッシュの日付を読む");
  eq([L.parseDaysLoose("15.5"), L.parseDaysLoose("0.3"), L.parseDaysLoose("")], [15.5, undefined, 0], "日数は 0.5 日単位");
}

section("権限 (permissions.ts)");
{
  ok(P.canViewLeaveOf(staff, staff) && !P.canViewLeaveOf(staff, staff2), "店舗スタッフは自分の分だけ見られる");
  ok(P.canViewLeaveOf(managerK, staff) && !P.canViewLeaveOf(managerK, chuo), "店長は自店舗の社員だけ");
  ok(P.canViewLeaveOf(hq, chuo) && P.canViewLeaveOf(admin, chuo), "本部・管理者は全員");
  ok(P.canApproveLeave(managerK, { userId: staff.id, storeId: "koshi" }) && !P.canApproveLeave(managerK, { userId: chuo.id, storeId: "chuo" }), "店長は自店舗の社員の申請を承認できる (他店舗は不可)");
  ok(!P.canApproveLeave(managerK, { userId: managerK.id, storeId: "koshi" }), "店長は自分の申請を承認できない");
  ok(!P.canApproveLeave(hq, { userId: staff.id, storeId: "koshi" }) && !P.canApproveLeave(staff, { userId: staff.id, storeId: "koshi" }), "本部スタッフ・店舗スタッフは承認しない");
  ok(P.canApproveLeave(admin, { userId: chuo.id, storeId: "chuo" }), "管理者は全件を承認できる");
  ok(P.canRegisterHolidayWork(hq, chuo) && P.canRegisterHolidayWork(managerK, staff) && !P.canRegisterHolidayWork(managerK, chuo) && !P.canRegisterHolidayWork(staff, staff), "休日出勤の登録: 本部・管理者は全員、店長は自店舗、スタッフは不可");
  ok(P.canManageLeaveGrants(hq) && P.canManageLeaveGrants(admin) && !P.canManageLeaveGrants(managerK), "有給の付与・取込は本部 (事務)・管理者");
  ok(P.canManageLeaveSettings(admin) && !P.canManageLeaveSettings(hq), "ルールの変更は管理者");
  // お客様のご要望 2026-11-26「他の社員の残日数については、本部・管理者のみ確認可能」: 一覧・CSV は本部・管理者だけ
  ok(!P.canViewLeaveReport(managerK) && P.canViewLeaveReport(hq) && P.canViewLeaveReport(admin) && !P.canViewLeaveReport(staff), "残日数の一覧・CSV は本部・管理者だけ (店長は見ない)");
  ok(P.canViewLeaveBalanceOf(staff, staff) && !P.canViewLeaveBalanceOf(managerK, staff) && P.canViewLeaveBalanceOf(hq, staff) && P.canViewLeaveBalanceOf(admin, staff), "残日数: 本人と本部・管理者だけ");
  ok(P.canRequestLeaveFor(managerK, staff) && P.canApproveLeave(managerK, { userId: staff.id, storeId: staff.storeId }), "店長は自店舗の社員の休暇の申請・承認はそのまま");
  throws(() => A.addGrant(db, managerK, { userId: staff.id, grantDate: "2031-04-01", days: 10 }), "本部スタッフ", "店長は付与を登録できない");
  throws(() => A.addHolidayWork(db, staff, { userId: staff.id, date: "2031-06-07", slot: "day" }), "権限", "店舗スタッフは休日出勤を登録できない");
  throws(() => leave(staff, { userId: staff2.id, date: "2031-05-12" }), "権限", "店舗スタッフはほかの社員の休暇を申請できない");
  const scope = MODEL.scopeStatements(staff).join("\n");
  ok(scope.includes("create temp view leave_requests") && scope.includes(`user_id = '${staff.id}'`), "AI の SQL でも店舗スタッフは自分の休暇だけ (scopeStatements)");
  ok(MODEL.scopeStatements(managerK).join("\n").includes("create temp view leave_requests as select * from main.leave_requests where user_id in (select id from main.users where store_id = 'koshi')"), "AI の SQL でも店長は自店舗の社員の休暇の申請だけ");
  ok(MODEL.scopeStatements(managerK).join("\n").includes(`create temp view holiday_works as select * from main.holiday_works where user_id = '${managerK.id}'`) && MODEL.scopeStatements(managerK).join("\n").includes(`create temp view leave_grants as select * from main.leave_grants where user_id = '${managerK.id}'`), "AI の SQL でも店長は残日数の分かる表 (付与・休日出勤) は自分の分だけ");
}

section("受け入れ条件: 承認した有給が予定表に表示され、残日数が減る");
{
  grant(staff.id, "2031-04-01", 10);
  eq(bal(staff).remaining, 10, "付与 10 日");
  // 承認の前から入っている予定 (重複の警告の確認用)
  db.schedule.push({ id: "ev_hr_t1", title: "現地調査 テスト様", kind: "survey", date: "2031-05-12", startTime: "10:00", endTime: "11:00", storeId: "koshi", assigneeIds: [staff.id], source: "manual" });
  const r = leave(staff, { userId: staff.id, date: "2031-05-12", reason: "家の用事" });
  ok(!r.approved && r.request.status === "pending", "本人の申請は申請中になる");
  ok(r.request.storeId === staff.storeId && /^LV-\d{4}-\d{4}$/.test(r.request.number), "社員の店舗・申請番号");
  eq([bal(staff).remaining, bal(staff).pending], [10, 1], "申請中は残日数を減らさない (申請中 1 日)");
  ok(!db.schedule.some((e) => e.kind === "leave" && e.assigneeIds.includes(staff.id)), "申請中は予定表に載らない");
  throws(() => A.decideLeave(db, managerC, r.request.id, "approved", ""), "店長か管理者", "他店舗の店長は承認できない");
  const d = A.decideLeave(db, managerK, r.request.id, "approved", "");
  const ev = db.schedule.find((e) => e.id === d.request.eventId);
  ok(d.request.status === "approved" && ev, "店長が承認すると予定表に登録");
  ok(ev && ev.kind === "leave" && ev.date === "2031-05-12" && !ev.startTime && ev.assigneeIds.join() === staff.id && ev.storeId === staff.storeId, "予定は kind = leave・終日・担当 = 本人・店舗 = 本人の所属");
  eq(bal(staff).remaining, 9, "承認で残日数が 10 → 9 日に減る");
  ok(d.conflicts.length === 1 && d.conflicts[0].includes("現地調査"), "承認のとき、期間に入っている予定を知らせる");
  const hits = CAL.findConflicts({ ...ev, id: undefined }, db.schedule.filter((e) => e.id !== ev.id));
  ok(hits.some((h) => h.event.id === "ev_hr_t1"), "予定の重複の確認 (calendar.findConflicts) に休暇が入る");
  ok(CAL.analyzeConflicts(db.schedule.filter((e) => e.date >= "2031-01-01")).byEvent.get("ev_hr_t1")?.some((l) => l.otherId === ev.id), "予定表の重複の一覧 (analyzeConflicts) にも出る");
  ok(db.auditLogs.some((l) => l.entity === "leave" && l.action === "approve" && l.entityId === r.request.id && l.changes?.[0]?.after === "approved"), "承認は変更履歴に残る (changes つき)");
}

section("半日 (午前・午後 = 0.5 日)");
{
  const am = leave(managerK, { userId: staff.id, date: "2031-05-13", slot: "am" });
  ok(am.approved, "店長が自店舗の社員の休暇を登録すると、そのまま承認済み");
  eq(am.request.days, 0.5, "午前休は 0.5 日");
  eq(bal(staff).remaining, 8.5, "残日数 9 → 8.5 日");
  const ev = db.schedule.find((e) => e.id === am.request.eventId);
  ok(ev && ev.slot === "am" && ev.startTime === "08:00" && ev.endTime === "12:00", "午前休の予定は 08:00〜12:00 (重複の確認に入る)");
  const at10 = { title: "x", kind: "visit", date: "2031-05-13", startTime: "10:00", endTime: "11:00", storeId: "koshi", assigneeIds: [staff.id] };
  const at14 = { ...at10, startTime: "14:00", endTime: "15:00" };
  ok(CAL.findConflicts(at10, [ev]).length === 1 && CAL.findConflicts(at14, [ev]).length === 0, "午前休は 10 時の予定と重複、14 時の予定とは重複しない");
  throws(() => leave(staff, { userId: staff.id, date: "2031-05-13", slot: "am" }), "同じ日に休暇", "同じ日の同じ半日は重ねて申請できない");
  throws(() => leave(staff, { userId: staff.id, date: "2031-05-13" }), "同じ日に休暇", "半日の日に終日は申請できない");
  const pm = leave(managerK, { userId: staff.id, date: "2031-05-13", slot: "pm" });
  ok(pm.approved && bal(staff).remaining === 8, "同じ日の午後休は登録できる (8 日)");
  throws(() => leave(staff, { userId: staff.id, date: "2031-05-20", endDate: "2031-05-21", slot: "am" }), "半日", "半日は複数日にできない");
}

section("複数日 (休業日を数えない)");
{
  // 2031-05-16 (金)〜05-19 (月): 日曜 (05-18) は休業日 (休日カレンダーの登録がない先の日付は日曜を休み)
  const r = leave(managerK, { userId: staff.id, date: "2031-05-16", endDate: "2031-05-19" });
  eq(r.request.dates, ["2031-05-16", "2031-05-17", "2031-05-19"], "日曜を除いた 3 日");
  eq(bal(staff).remaining, 5, "残日数 8 → 5 日");
  const ev = db.schedule.find((e) => e.id === r.request.eventId);
  ok(ev && ev.endDate === "2031-05-19", "予定は期間 (終了日つき) で登録");
  db.holidays = [{ id: "h_hr", date: "2031-05-26", label: "休業日" }];
  eq(L.leaveDates(db, "2031-05-26", "2031-05-27", "day"), ["2031-05-27"], "休日カレンダーの休業日も除く");
  eq(L.leaveDates(db, "2031-05-26", undefined, "day"), ["2031-05-26"], "1 日だけの申請はその日を数える (本人の勤務日)");
  db.holidays = [];
}

section("取消し (予定表の休暇も消え、残日数が戻る)");
{
  const r = db.leaveRequests.find((x) => x.date === "2031-05-16");
  throws(() => A.cancelLeave(db, staff2, r.id, "", "2031-05-01"), "取消し", "ほかの社員は取り消せない");
  A.cancelLeave(db, staff, r.id, "予定が変わった", "2031-05-01");
  ok(r.status === "cancelled" && !db.schedule.some((e) => e.id === r.eventId), "まだ始まっていない自分の休暇は本人が取り消せる (予定も削除)");
  eq(bal(staff).remaining, 8, "取消しで残日数が 5 → 8 日に戻る");
  const past = db.leaveRequests.find((x) => x.date === "2031-05-12");
  throws(() => A.cancelLeave(db, staff, past.id, "", "2031-06-01"), "承認済み", "始まった (過ぎた) 休暇は本人は取り消せない");
}

section("却下・自分の申請・代理の申請");
{
  grant(managerK.id, "2031-04-01", 12);
  const own = leave(managerK, { userId: managerK.id, date: "2031-05-14" });
  ok(!own.approved, "店長の自分の休暇は申請中 (管理者が承認)");
  throws(() => A.decideLeave(db, managerK, own.request.id, "approved", ""), "自分の休暇", "店長は自分の申請を承認できない");
  throws(() => A.decideLeave(db, admin, own.request.id, "rejected", ""), "理由", "却下は理由が必要");
  A.decideLeave(db, admin, own.request.id, "rejected", "繁忙のため別の日に");
  ok(own.request.status === "rejected" && !own.request.eventId, "却下は予定表に載らない");
  eq(bal(managerK).remaining, 12, "却下は残日数を変えない");
  grant(admin.id, "2031-04-01", 20);
  ok(leave(admin, { userId: admin.id, date: "2031-05-14" }).approved, "管理者の自分の申請は承認を省略 (そのまま承認済み)");
  const byHq = leave(hq, { userId: staff2.id, leaveType: "special", date: "2031-05-15", reason: "慶弔 (祖母の葬儀)" });
  ok(!byHq.approved && byHq.request.requestedBy === hq.id, "本部 (事務) の代理の登録は店長の承認を待つ");
  throws(() => leave(hq, { userId: staff2.id, leaveType: "special", date: "2031-05-22" }), "理由", "特別休暇は理由が必要");
  A.decideLeave(db, managerK, byHq.request.id, "approved", "");
  ok(db.schedule.some((e) => e.id === byHq.request.eventId && e.title.includes("特別休暇")), "特別休暇も予定表に載る (残日数は持たない)");
}

section("有給の前取りはできない・有効期限 (2 年)・古い付与から消化");
{
  const u = staff2;
  throws(() => leave(managerK, { userId: u.id, date: "2031-05-12" }), "有給の残日数が足りません", "付与がない社員は有給を取れない (前取り不可)");
  grant(u.id, "2030-04-01", 5); // 期限 2032-03-31
  grant(u.id, "2031-04-01", 11); // 期限 2033-03-31
  throws(() => leave(managerK, { userId: u.id, date: "2030-03-20" }), "足りません", "付与日より前の日には使えない");
  const a = leave(managerK, { userId: u.id, date: "2031-05-12" });
  const l1 = L.paidLedger(db, u.id, "2031-05-12");
  const g2030 = l1.grants.find((g) => g.grant.grantDate === "2030-04-01");
  const g2031 = l1.grants.find((g) => g.grant.grantDate === "2031-04-01");
  ok(a.approved && g2030.usedHalves === 2 && g2031.usedHalves === 0, "期限の早い (古い) 付与から消化する");
  eq(bal(u, "2031-05-13").remaining, 15, "残 16 → 15 日");
  // 古い付与の残 4 日は 2032-03-31 で期限切れ
  const after = bal(u, "2032-04-01");
  eq([after.remaining, after.lapsed], [11, 4], "期限切れの日数は消え (4 日)、新しい付与の 11 日が残る");
  ok(bal(u, "2032-01-15").expiring.some((e) => e.expiresOn === "2032-03-31" && e.days === 4), "90 日以内に期限が来る残を知らせる");
  // 期限の後の休暇は新しい付与から
  leave(managerK, { userId: u.id, date: "2032-05-10" });
  eq(L.paidLedger(db, u.id, "2032-05-10").grants.find((g) => g.grant.grantDate === "2031-04-01").usedHalves, 2, "期限切れの付与は使わず、新しい付与から消化");
  // 設定で「当年度分 (新しい付与) から」
  db.settings = db.settings.filter((s) => s.id !== L.HR_SETTINGS_ID);
  db.settings.push({ id: L.HR_SETTINGS_ID, value: { consumeOrder: "newest" }, updatedAt: new Date().toISOString() });
  const l2 = L.paidLedger(db, u.id, "2031-05-12");
  ok(l2.grants.find((g) => g.grant.grantDate === "2031-04-01").usedHalves === 4 && l2.grants.find((g) => g.grant.grantDate === "2030-04-01").usedHalves === 0, "設定が「当年度分から」なら新しい付与から消化");
  OLDEST();
  // 付与を消すと承認済みの休暇が足りなくなる → 断る
  const g = db.leaveGrants.find((x) => x.userId === u.id && x.grantDate === "2030-04-01");
  A.removeGrant(db, hq, g.id, "2031-06-01");
  ok(!db.leaveGrants.includes(g), "使った付与でも、ほかの付与で足りれば削除できる");
  const g31 = db.leaveGrants.find((x) => x.userId === u.id && x.grantDate === "2031-04-01");
  throws(() => A.updateGrant(db, hq, g31.id, { days: 1, expiresOn: g31.expiresOn }, "2031-06-01"), "足りなく", "日数を減らして承認済みの休暇が足りなくなる修正は断る");
  A.updateGrant(db, hq, g31.id, { days: 12, expiresOn: g31.expiresOn, note: "修正" }, "2031-06-01");
  ok(db.auditLogs.some((l) => l.entity === "leave_grant" && l.action === "update" && l.changes?.some((c) => c.field === "days" && c.before === 11 && c.after === 12)), "付与の修正は変更履歴に changes (変更前・変更後) が残る");
  // 申請中も含めて足りるか確かめる
  const v = chuo2;
  grant(v.id, "2031-04-01", 1);
  leave(v, { userId: v.id, date: "2031-05-12" });
  throws(() => leave(v, { userId: v.id, date: "2031-05-13" }), "申請中", "申請中の分も差し引いて確かめる");
  throws(() => leave(v, { userId: v.id, date: "2031-05-12", slot: "pm" }), "同じ日に休暇", "終日の申請中の日に半日は重ねられない");
}

section("受け入れ条件: 休日出勤 → 振休の未取得一覧、振休の登録 → 一覧から除外");
{
  const u = chuo;
  throws(() => A.createLeave(db, managerC, { userId: u.id, leaveType: "comp", date: "2031-06-20", slot: "day" }), "振休の残りが足りません", "休日出勤がないと振休は取れない");
  const w1 = A.addHolidayWork(db, hq, { userId: u.id, date: "2031-06-07", slot: "day", note: "施工" }).work;
  const w2 = A.addHolidayWork(db, managerC, { userId: u.id, date: "2031-06-08", slot: "am" }).work;
  throws(() => A.addHolidayWork(db, hq, { userId: u.id, date: "2031-06-07", slot: "am" }), "すでに登録", "同じ日の休日出勤は重ねて登録できない");
  let c = L.compBalance(db, u.id);
  eq([c.remaining, c.open.map((w) => w.work.id)], [1.5, [w1.id, w2.id]], "休日出勤 (終日 1 + 午前 0.5) が未取得一覧に入る");
  const r1 = A.createLeave(db, managerC, { userId: u.id, leaveType: "comp", date: "2031-06-20", slot: "day" });
  ok(r1.approved && db.schedule.some((e) => e.id === r1.request.eventId && e.title.includes("振休")), "店長が振休を登録 → 承認済み・予定表に「振休」");
  c = L.compBalance(db, u.id);
  eq([c.remaining, c.open.map((w) => w.work.id)], [0.5, [w2.id]], "振休は古い休日出勤から充て、充て終わった休日出勤は一覧から外れる");
  throws(() => A.removeHolidayWork(db, hq, w1.id), "振休", "振休を充てた休日出勤は消せない");
  const r2 = A.createLeave(db, managerC, { userId: u.id, leaveType: "comp", date: "2031-06-21", slot: "pm" });
  c = L.compBalance(db, u.id);
  eq([c.remaining, c.open.length, c.taken], [0, 0, 1.5], "半日の振休で残り 0 (一覧から除外)");
  ok(r2.request.days === 0.5, "半日の振休は 0.5 日");
  // 指定の休日出勤に充てる
  const w3 = A.addHolidayWork(db, hq, { userId: u.id, date: "2031-06-28", slot: "day" }).work;
  const w4 = A.addHolidayWork(db, hq, { userId: u.id, date: "2031-07-05", slot: "day" }).work;
  A.createLeave(db, managerC, { userId: u.id, leaveType: "comp", date: "2031-07-10", slot: "day", holidayWorkId: w4.id });
  eq(L.compBalance(db, u.id).open.map((w) => w.work.id), [w3.id], "申請で選んだ休日出勤に充てる");
  // 振休を取り消すと一覧に戻る
  A.cancelLeave(db, managerC, r2.request.id, "", "2031-06-01");
  eq(L.compBalance(db, u.id).remaining, 1.5, "振休の取消しで未取得に戻る");
  ok(db.auditLogs.some((l) => l.entity === "holiday_work" && l.action === "create"), "休日出勤の登録は変更履歴に残る");
}

section("振休のため込みの上限 (社内規定: 3 日まで) の警告");
{
  const u = chuo2;
  const r = ["2031-08-02", "2031-08-03", "2031-08-09"].map((d) => A.addHolidayWork(db, hq, { userId: u.id, date: d, slot: "day" }));
  ok(r.every((x) => !x.warning) && !L.compBalance(db, u.id).overLimit, "3 日までは警告しない");
  const fourth = A.addHolidayWork(db, hq, { userId: u.id, date: "2031-08-10", slot: "am" });
  ok(fourth.warning?.includes("上限") && L.compBalance(db, u.id).overLimit, "3.5 日で上限超えの警告");
  throws(() => A.saveRules(db, hq, { ...L.HR_DEFAULTS, compLimit: 5 }), "管理者", "ルールの変更は管理者だけ");
  const { profiles, ...rules } = L.HR_DEFAULTS;
  A.saveRules(db, admin, { ...rules, compLimit: 5 });
  ok(!L.compBalance(db, u.id).overLimit && L.hrSettings(db).compLimit === 5, "上限は設定で変えられる (5 日)");
  ok(db.auditLogs.some((l) => l.entity === "settings" && l.changes?.some((c) => c.field === "compLimit" && c.before === 3 && c.after === 5)), "ルールの変更は変更履歴に changes つきで残る");
  A.saveRules(db, admin, { ...rules });
  ok(profiles && L.hrSettings(db).compLimit === 3, "初期値 3 日に戻す");
  OLDEST(); // 既定 (当年度分から) に戻ったので、以降の消化の順番のテストは「古い付与から」に戻す
}

section("年度 (7 月〜翌 6 月) の取得状況");
{
  const users = [staff, chuo];
  const fy2030 = L.fiscalRange(2030);
  const rows = L.periodRows(db, users, fy2030.from, fy2030.to);
  const s = rows.find((r) => r.user.id === staff.id);
  eq([s.paid, s.comp, s.worked], [2, 0, 0], "2030 年度 (〜2031/6/30) の有給 2 日 (5/12 終日・5/13 午前 + 午後。取消しの 5/16〜は数えない)");
  ok(s.byMonth["2031-05"]?.paid === 2, "月ごとの集計 (2031 年 5 月 2 日)");
  const c = rows.find((r) => r.user.id === chuo.id);
  eq([c.comp, c.worked], [1, 2.5], "振休 1 日 (取消しは数えない)、休日出勤 2.5 日 (6/7・6/8 午前・6/28)");
  const fy2031 = L.fiscalRange(2031);
  const c2 = L.periodRows(db, users, fy2031.from, fy2031.to).find((r) => r.user.id === chuo.id);
  eq([c2.comp, c2.worked], [1, 1], "7/5 の休日出勤と 7/10 の振休は 2031 年度に入る");
  ok(L.dayList(s.days, "paid").includes("2031/05/13(午前)"), "CSV の取得日の並び (半日は (午前))");
  const m = L.closingRange("2031-06", 20);
  const cm = L.periodRows(db, [chuo], m.from, m.to)[0];
  eq([cm.comp, cm.worked], [1, 1.5], "20 日締め (5/21〜6/20) の振休・休日出勤");
}

section("受け入れ条件: 切り替え時点の残日数を取り込み、有給管理表と一致");
{
  const u = koshiStaff[0];
  const v = db.users.find((x) => x.active && x.role === "store_staff" && x.storeId === "nishi");
  const w = db.users.find((x) => x.active && x.role === "store_staff" && x.storeId === "tamana");
  const spaced = v.name.length > 1 ? `${v.name.slice(0, 1)}　${v.name.slice(1)}` : v.name;
  const text = [
    "社員\t本年基準日\t当年度分の残\t繰越分の残\t時点\t振休の残",
    `${spaced}\t2031/3/12\t16\t15\t2031/4/20\t1.5`,
    `${w.email}\tR13.1.10\t10.5\t0\t2031-04-20\t`,
    "存在しない人\t2031/3/12\t1\t0\t2031/4/20\t",
  ].join("\n");
  let rows = L.parseOpeningImport(db, text, "2031-04-20");
  eq(rows.length, 3, "見出しの行を読み飛ばす");
  ok(rows[0].user?.id === v.id && rows[0].errors.length === 0, "氏名 (全角の空白は無視) で社員を探す");
  ok(rows[1].user?.id === w.id && rows[1].baseDate === "2031-01-10" && rows[1].current === 10.5, "ログイン ID・令和の日付・0.5 日");
  ok(rows[2].errors.length > 0, "いない社員はエラー");
  throws(() => A.applyOpeningImport(db, hq, rows), "取り込めない行", "エラーの行があれば何も取り込まない");
  ok(!db.leaveGrants.some((g) => g.kind === "opening"), "(まだ何も保存していない)");
  throws(() => A.applyOpeningImport(db, managerK, rows.slice(0, 2)), "本部スタッフ", "取込は本部・管理者");
  rows = rows.slice(0, 2);
  const res = A.applyOpeningImport(db, hq, rows);
  eq([res.users, res.grants, res.works], [2, 3, 1], "2 人・付与 3 行 (当年度 + 繰越、当年度のみ)・振休の残 1");
  eq(bal(v, "2031-04-20").remaining, 31, "取込の時点の残日数 = 当年度 16 + 繰越 15 (有給管理表と一致)");
  eq(bal(w, "2031-04-20").remaining, 10.5, "0.5 日単位の残も一致");
  eq(L.compBalance(db, v.id).remaining, 1.5, "振休の残も取り込む");
  const parts = L.paidLedger(db, v.id, "2031-04-20").grants;
  eq(parts.map((g) => g.grant.expiresOn).sort(), ["2032-03-11", "2033-03-11"], "有効期限: 繰越分 = 前年の基準日から 2 年、当年度分 = 本年基準日から 2 年");
  ok(parts.every((g) => g.grant.grantDate === "2031-04-20"), "取込の残は時点から使う (時点より前の休暇には充てない)");
  // 時点より後の休暇 → 繰越分 (期限の早い方) から
  A.createLeave(db, managerK.storeId === v.storeId ? managerK : admin, { userId: v.id, leaveType: "paid", date: "2031-05-12", slot: "day" });
  ok(L.paidLedger(db, v.id, "2031-05-12").grants.find((g) => g.grant.expiresOn === "2032-03-11").usedHalves === 2, "繰越分から消化");
  eq(bal(v, "2032-03-12").remaining, 16, "繰越分の残 (14 日) は 2032/3/11 で期限切れ");
  // もう一度取り込むと置き換える (二重にならない)
  A.applyOpeningImport(db, hq, L.parseOpeningImport(db, `${v.name},2031/3/12,16,14,2031/4/20,`, "2031-04-20"));
  eq(bal(v, "2031-04-20").remaining, 29, "同じ社員の取込は前回分を置き換える (承認済みの 5/12 の 1 日を差し引いて 30 → 29)");
  eq(L.compBalance(db, v.id).remaining, 1.5, "振休の列が空なら振休の残は変えない");
  ok(L.hrSettings(db).profiles[v.id]?.baseDate === "2031-03-12", "本年基準日を社員の基準日として覚える");
  const expired = L.parseOpeningImport(db, `${u.name},2031/3/12,5,3,2032/6/1,`, "2032-06-01")[0];
  ok(expired.warnings.some((x) => x.includes("期限切れ")) && L.openingGrantParts(expired).length === 1, "時点で期限切れの繰越分は取り込まない");
  const noBase = L.parseOpeningImport(db, `${staff2.name},,5,0,2031/4/20,`, "2031-04-20")[0];
  ok(noBase.errors.some((x) => x.includes("本年基準日")), "基準日が分からないときはエラー (有効期限が決まらないため)");
  ok(db.auditLogs.some((l) => l.entity === "leave_grant" && l.action === "import"), "取込は変更履歴に残る");
}

section("次の付与の目安 (基準日・勤続年数) と年 5 日の取得義務");
{
  const u = db.users.find((x) => x.active && x.role === "store_staff" && x.storeId === "tamana" && !db.leaveGrants.some((g) => g.userId === x.id)) ?? db.users.find((x) => x.role === "hq_staff" && x.id !== hq.id);
  A.saveProfile(db, hq, u.id, { hiredOn: "2025-10-01" });
  eq(L.leaveProfile(db, u).baseDate, "2026-04-01", "基準日の初期値は雇い入れの 6 か月後");
  const s1 = L.suggestGrant(db, u, "2031-05-01");
  eq([s1.date, s1.days, s1.due], ["2031-04-01", 18, true], "付与がまだなら今の期間の付与日 (勤続 5 年 6 か月 → 18 日)");
  A.addGrant(db, hq, { userId: u.id, grantDate: s1.date, days: s1.days });
  const s2 = L.suggestGrant(db, u, "2031-05-01");
  eq([s2.date, s2.days, s2.due], ["2032-04-01", 20, false], "次は 2032/4/1 に 20 日 (6 年 6 か月以上)");
  throws(() => A.saveProfile(db, managerK, u.id, { hiredOn: "2025-10-01" }), "本部スタッフ", "基準日の設定は本部・管理者");
  ok(db.auditLogs.some((l) => l.entity === "settings" && l.changes?.some((c) => c.field === "hiredOn")), "社員の設定の変更は変更履歴に残る");
  let ob = L.annualObligation(db, u.id, "2031-05-01");
  ok(ob && ob.taken === 0 && !ob.met && ob.deadline === "2032-03-31", "10 日以上の付与で、年 5 日の取得義務 (期限は付与から 1 年)");
  for (const d of ["2031-06-02", "2031-06-03", "2031-06-04", "2031-06-05"]) A.createLeave(db, admin, { userId: u.id, leaveType: "paid", date: d, slot: "day" });
  A.createLeave(db, admin, { userId: u.id, leaveType: "paid", date: "2031-06-06", slot: "am" });
  ob = L.annualObligation(db, u.id, "2031-07-01");
  eq([ob.taken, ob.met], [4.5, false], "4.5 日ではまだ");
  A.createLeave(db, admin, { userId: u.id, leaveType: "paid", date: "2031-06-06", slot: "pm" });
  ok(L.annualObligation(db, u.id, "2031-07-01").met, "5 日で達成");
}

section("データベースの定義 (schema.ts) と画面のメニュー");
{
  for (const [col, sample] of [["leaveRequests", db.leaveRequests], ["leaveGrants", db.leaveGrants], ["holidayWorks", db.holidayWorks]]) {
    const def = SCHEMA.TABLES.find((t) => t.collection === col);
    const cols = new Set(def?.columns.map(([f]) => f));
    const missing = [...new Set(sample.flatMap((r) => Object.keys(r)))].filter((k) => !cols.has(k));
    eq(missing, [], `${col} の項目はすべて schema.ts の列にある`);
  }
  const migrated = MIG.migrateDb({ meta: { version: 3, seededAt: "" } });
  ok(["leaveRequests", "leaveGrants", "holidayWorks"].every((k) => Array.isArray(migrated[k]) && migrated[k].length === 0), "migrate.ts: 古いデータに空のコレクションを作る");
  const layout = fs.readFileSync(path.join(root, "src/app/(app)/layout.tsx"), "utf8");
  const guard = fs.readFileSync(path.join(root, "src/lib/assistant/guard.ts"), "utf8");
  const label = /href: "\/leave", label: "([^"]+)"/.exec(layout)?.[1];
  ok(label && guard.includes(`{ href: "/leave", label: "${label}"`), "メニュー (layout.tsx) と guard.ts の NAV_ITEMS が同じ");
}

summary();
