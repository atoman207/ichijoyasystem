// 実行: npm run test:schedule (または node scripts/tests/schedule/schedule.test.mjs)
// 予定の候補日の提案・全体の最適化・巡回順・製造計画・仮押さえ・経路の回帰テスト。
// 2031 年の日付のテスト用の予定だけを使い、サンプルデータの予定に左右されないようにする。外部の経路サービスは呼ばない
import { imp, ok, eq, section, summary } from "./harness.mjs";

const store = await imp("lib/db/store.ts");
const S = await imp("lib/schedule-suggest.ts");
const C = await imp("lib/scheduling/context.ts");
const E = await imp("lib/scheduling/engine.ts");
const M = await imp("lib/scheduling/masters.ts");
const SP = await imp("lib/scheduling/spec.ts");
const O = await imp("lib/scheduling/optimize.ts");
const R = await imp("lib/scheduling/route.ts");
const RP = await imp("lib/scheduling/replan.ts");
const H = await imp("lib/scheduling/holds.ts");
const P = await imp("lib/scheduling/production.ts");
const IM = await imp("lib/scheduling/impact.ts");
const BT = await imp("lib/scheduling/backtest.ts");
const RD = await imp("lib/scheduling/readiness.ts");
const RT = await imp("lib/geo/routing.ts");
const G = await imp("lib/geo/kumamoto.ts");
const OL = await imp("lib/scheduling/offer-link.ts");
const ST = await imp("lib/speech-text.ts");
const TOOL = await imp("lib/assistant/schedule-tool.ts");
const CAP = await imp("lib/schedule-capacity.ts");

const db = store.getDb();
// サンプルの予定は使わない (2031 年はもともと空。念のため 2031 年以降を消す)
db.schedule = db.schedule.filter((e) => e.date < "2031-01-01");
db.holidays = [{ id: "h_t1", date: "2031-03-05", name: "テストの休業日" }];
db.jobSpecs = [];
db.productionJobs = [];
db.resourceBookings = [];
db.scheduleHolds = [];
db.settings = db.settings.filter((s) => !s.id.startsWith("scheduling_") && s.id !== "schedule_capacity");

const admin = db.users.find((u) => u.role === "admin");
const koshiStaff = db.users.filter((u) => u.active && u.storeId === "koshi" && (u.role === "store_staff" || u.role === "store_manager"));
const craft = koshiStaff.find((u) => /施工/.test(u.title)) ?? koshiStaff[0];
const sales = koshiStaff.find((u) => /営業/.test(u.title)) ?? koshiStaff[1];
const manager = koshiStaff.find((u) => u.role === "store_manager");
const chuoStaff = db.users.find((u) => u.active && u.storeId === "chuo" && u.role === "store_staff");
const chuoUser = chuoStaff;
const now = new Date("2031-03-03T09:00:00+09:00"); // 月曜
let seq = 0;
const nowIso = now.toISOString();
const ev = (x) => ({ id: `ev_t${++seq}`, title: "テスト", kind: "pickup", storeId: "koshi", assigneeIds: [], source: "manual", createdAt: nowIso, createdBy: admin.id, ...x });
const cust = { id: "cust_t1", code: "C-T1", name: "テスト 太郎", kana: "テスト", type: "individual", phone: "", postalCode: "", address: "熊本県合志市御代志1000", storeId: "koshi", preferredChannel: "phone", firstContactChannel: "phone", tags: [], notes: "", createdAt: nowIso, updatedAt: nowIso };
db.customers.push(cust);
const order = { id: "o_t1", number: "OR-2031-0001", customerId: cust.id, storeId: "koshi", title: "畳 表替え", category: "tatami", contractDate: "2031-03-01", total: 60000, status: "confirmed", workerIds: [], siteAddress: "合志市御代志1000", progressNotes: [{ id: "pn_t1", at: nowIso, userId: admin.id, kind: "note", body: "明細 (税込): 畳 きずな 6×¥10,000" }], createdBy: admin.id, createdAt: nowIso, updatedAt: nowIso };
db.orders.push(order);
const dow = (d) => new Date(`${d}T00:00:00+09:00`).getDay();
const suggest = (input, user = admin) => S.suggestScheduleDates(db, user, input, now);
const setSetting = (id, value) => {
  db.settings = db.settings.filter((s) => s.id !== id);
  db.settings.push({ id, value, updatedAt: nowIso });
};

/* ------------------------------------------------------------------ */
section("結果の項目 (AI アシスタントの道具が使う名前は変えない)");
{
  const r = suggest({ storeId: "koshi", kind: "survey", address: "合志市御代志" });
  ok(r.candidates.length > 0, "現地調査の候補が出る");
  const c = r.candidates[0];
  ok(Array.isArray(c.assigneeNames) && "startTime" in c && "travelMin" in c && Array.isArray(c.reasons) && Array.isArray(c.warnings) && Array.isArray(r.notes), "assigneeNames・startTime・travelMin・reasons・warnings・notes がある");
  ok(c.score >= 0 && c.score <= 100, "点数は 0〜100");
}

section("休業日を提案しない");
{
  const r = suggest({ storeId: "koshi", kind: "survey", address: "合志市御代志", from: "2031-03-04", to: "2031-03-20", limit: 10 });
  ok(r.candidates.length > 0, "候補がある");
  ok(r.candidates.every((c) => c.date !== "2031-03-05"), "休日カレンダーの日 (3/5) を提案しない");
  ok(r.candidates.every((c) => dow(c.date) !== 0), "日曜 (カレンダーの先) を提案しない");
  const multi = suggest({ storeId: "koshi", kind: "install", address: "合志市御代志", durationDays: 3, from: "2031-03-03", to: "2031-03-20", limit: 10 });
  ok(multi.candidates.length > 0 && multi.candidates.every((c) => c.endDate), "複数日の施工は終わりの日がある");
  ok(multi.candidates.every((c) => { const ds = []; for (let d = new Date(`${c.date}T00:00:00Z`); d <= new Date(`${c.endDate}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) ds.push(d.toISOString().slice(0, 10)); return ds.length === 3 && ds.every((x) => x !== "2031-03-05" && new Date(`${x}T00:00:00Z`).getUTCDay() !== 0); }), "複数日の施工の 3 日すべてに休業日を含まない");
}

section("担当者の重複を避ける");
{
  db.schedule.push(ev({ kind: "meeting", date: "2031-03-04", startTime: "08:30", endTime: "17:30", assigneeIds: [craft.id], title: "終日の研修" }));
  db.schedule.push(ev({ kind: "leave", date: "2031-03-06", assigneeIds: [craft.id], title: "休暇" }));
  const r = suggest({ storeId: "koshi", kind: "pickup", address: "合志市御代志", assigneeIds: [craft.id], from: "2031-03-04", to: "2031-03-08", limit: 10 });
  ok(r.candidates.every((c) => c.date !== "2031-03-04"), "一日中の予定がある日を提案しない");
  ok(r.candidates.every((c) => c.date !== "2031-03-06"), "休暇の日を提案しない");
  ok(r.candidates.every((c) => c.assigneeIds.includes(craft.id)), "決めた担当者で探す");
  db.schedule.push(ev({ kind: "visit", date: "2031-03-07", startTime: "09:00", endTime: "11:00", assigneeIds: [craft.id], location: "合志市御代志", title: "朝の訪問" }));
  const r2 = suggest({ storeId: "koshi", kind: "survey", address: "合志市御代志", assigneeIds: [craft.id], from: "2031-03-07", to: "2031-03-07", slot: "am" });
  ok(r2.candidates.every((c) => !c.startTime || c.startTime >= "11:00"), "時刻の決まった予定と重ならない時刻 (移動を含む) にする");
}

section("店舗の 1 日の上限を超えない");
{
  setSetting("schedule_capacity", { stores: { koshi: { jobsPerDay: 1, visitsPerDay: 3, tatamiPerDay: 30 } } });
  db.schedule.push(ev({ kind: "delivery", date: "2031-03-10", title: "既存の納品", location: "合志市御代志" }));
  const r = suggest({ storeId: "koshi", kind: "pickup", address: "合志市御代志", from: "2031-03-10", to: "2031-03-12", limit: 10 });
  ok(r.candidates.every((c) => c.date !== "2031-03-10"), "現場作業の上限 (1 件) に達した日 (3/10) を提案しない");
  ok(r.notes.some((n) => /上限に達している日 1 日/.test(n)), "除いた日の数を注記する");
  db.settings = db.settings.filter((s) => s.id !== "schedule_capacity");
}

section("納品を引き取りより前にしない (製造の完成の後)");
{
  db.schedule.push(ev({ kind: "pickup", date: "2031-03-11", orderId: order.id, customerId: cust.id, title: "引き取り 畳 表替え6", location: "合志市御代志" }));
  const r = suggest({ storeId: "koshi", kind: "delivery", orderId: order.id, limit: 10 });
  ok(r.candidates.length > 0, "納品の候補がある");
  ok(r.candidates.every((c) => c.date > "2031-03-11"), "納品は引き取り (3/11) の翌日以降");
  ok(r.notes.some((n) => /引き取り/.test(n)), "引き取りの後から探したことを注記する");
  const pickupJob = SP.resolveJob(db, M.loadMasters(db), { orderId: order.id, order });
  eq(pickupJob.units.tatami, 6, "受注の明細から畳 6 枚を読む");
}

section("製造: 工程の能力と期限");
{
  setSetting("scheduling_processes", { items: [{ id: "koshi_tatami", key: "tatami", name: "畳の製造", storeId: "koshi", minutesPerDay: 120, workdays: [], staffIds: [], servesStores: [], provisional: false, active: true }] });
  const r = suggest({ storeId: "koshi", kind: "pickup", address: "合志市御代志", tatamiCount: 10, from: "2031-03-17", to: "2031-03-17" });
  const c = r.candidates[0];
  ok(c && c.readyDate && c.readyDate > "2031-03-18", "1 日 120 分の工程で畳 10 枚 (300 分) は数日にまたがる");
  ok(c && c.productionSteps.length >= 3 && c.productionSteps.every((s) => s.minutes <= 120), "工程の 1 日の能力を超えない");
  db.jobSpecs.push({ id: "js_order_o_t2", recordType: "order", recordId: "o_t2", storeId: "koshi", items: [{ workTypeId: "tatami_omote", qty: 10 }], skills: [], resourceKinds: [], deadline: "2031-03-19", preferredDates: [], preferredWeekdays: [], avoidDates: [], preferenceStrength: "none", priority: "normal", updatedBy: admin.id, updatedAt: nowIso });
  db.orders.push({ ...order, id: "o_t2", number: "OR-2031-0002", progressNotes: [] });
  const r2 = suggest({ storeId: "koshi", kind: "pickup", orderId: "o_t2", from: "2031-03-17", to: "2031-03-18" });
  ok(r2.candidates.length === 0 && r2.notes.some((n) => /製造が期限に間に合わない/.test(n)), "期限 (3/19) までに完成しない引き取りは提案しない");
  db.settings = db.settings.filter((s) => s.id !== "scheduling_processes");
}

section("他店舗の応援");
{
  // 合志の現場の社員を全員休みにする
  for (const u of koshiStaff) db.schedule.push(ev({ kind: "leave", date: "2031-03-13", assigneeIds: [u.id], title: "休暇" }));
  setSetting("scheduling_staff", { profiles: { [chuoStaff.id]: { skills: { tatami_lay: 2, survey: 2 }, workDays: [1, 2, 3, 4, 5, 6], supportStores: ["koshi"], fieldWork: true, canDrive: true } } });
  const r = suggest({ storeId: "koshi", kind: "survey", address: "合志市御代志", from: "2031-03-13", to: "2031-03-13" });
  ok(r.candidates.length > 0, "自店舗が全員休みでも候補がある");
  ok(r.candidates.every((c) => c.helped && c.assigneeIds.includes(chuoStaff.id)), "応援できる店舗に合志がある中央店の社員を選ぶ");
  ok(r.candidates.every((c) => c.warnings.some((w) => /応援/.test(w))), "応援が必要と注意する");
}

section("社員の勤務・技能・同行");
{
  // 施工担当だけが畳の敷き込みの技能を持ち、火曜は休み
  setSetting("scheduling_staff", {
    profiles: {
      [craft.id]: { skills: { tatami_lay: 3, tatami_make: 3 }, workDays: [1, 3, 4, 5, 6], fieldWork: true, canDrive: true },
      [sales.id]: { skills: { survey: 2, tatami_lay: 1 }, workDays: [1, 2, 3, 4, 5, 6], fieldWork: true, canDrive: true, needsCompanion: true },
      ...(manager ? { [manager.id]: { skills: { survey: 2 }, workDays: [1, 2, 3, 4, 5, 6], fieldWork: true, canDrive: true } } : {}),
    },
  });
  const r = suggest({ storeId: "koshi", kind: "pickup", address: "合志市御代志", tatamiCount: 4, from: "2031-03-17", to: "2031-03-22", limit: 10 });
  ok(r.candidates.length > 0, "候補がある");
  ok(r.candidates.every((c) => c.assigneeIds.includes(craft.id)), "必要な技能 (畳の敷き込み) が一人前以上の人を選ぶ");
  ok(r.candidates.every((c) => dow(c.date) !== 2), "その人の勤務日でない火曜を提案しない");
  const r2 = suggest({ storeId: "koshi", kind: "survey", address: "合志市御代志", assigneeIds: [sales.id, craft.id], from: "2031-03-19", to: "2031-03-19" });
  ok(r2.candidates.length > 0, "決めた 2 人で探せる");
  // 同行が必要な人だけが空いている日: 熟練者を付ける
  const ctx = C.createPlanContext(db, admin, { now, from: "2031-03-17", to: "2031-03-22" });
  const built = (await imp("lib/scheduling/request.ts")).buildRequest(ctx, { storeId: "koshi", kind: "survey", address: "合志市御代志", staffCount: 1, from: "2031-03-19", to: "2031-03-19" });
  const res = E.evaluateJob(ctx, built.req);
  ok(res.candidates.every((c) => !c.assigneeIds.includes(sales.id) || c.assigneeIds.length >= 2), "同行が必要な人は一人で行かせない");
  db.settings = db.settings.filter((s) => s.id !== "scheduling_staff");
}

section("車両・設備の空き");
{
  setSetting("scheduling_resources", { items: [{ id: "truck1", name: "軽トラ 1 号", kind: "vehicle", type: "truck", storeId: "koshi", capacityUnits: 8, active: true }] });
  db.resourceBookings.push({ id: "rb_t1", resourceId: "truck1", storeId: "koshi", date: "2031-03-18", createdBy: admin.id, createdAt: nowIso });
  const r = suggest({ storeId: "koshi", kind: "pickup", address: "合志市御代志", tatamiCount: 4, from: "2031-03-17", to: "2031-03-19", limit: 10 });
  ok(r.candidates.length > 0 && r.candidates.every((c) => c.date !== "2031-03-18"), "車両が一日予約済みの日を提案しない");
  ok(r.candidates.every((c) => c.resourceIds.includes("truck1")), "空いている車両を割り当てる");
  const r2 = suggest({ storeId: "koshi", kind: "pickup", address: "合志市御代志", tatamiCount: 12, from: "2031-03-17", to: "2031-03-17" });
  ok(r2.candidates.every((c) => c.warnings.some((w) => /積めるのは 8 枚/.test(w))), "積める数を超えると注意する");
  db.settings = db.settings.filter((s) => s.id !== "scheduling_resources");
  db.resourceBookings = [];
}

section("お客様の希望・都合の悪い日・優先度");
{
  db.orders.push({ ...order, id: "o_t3", number: "OR-2031-0003" });
  db.jobSpecs.push({ id: "js_order_o_t3", recordType: "order", recordId: "o_t3", storeId: "koshi", items: [{ workTypeId: "tatami_omote", qty: 4 }], skills: [], resourceKinds: [], preferredDates: ["2031-03-20"], preferredWeekdays: [], avoidDates: ["2031-03-18"], preferenceStrength: "hard", priority: "urgent", updatedBy: admin.id, updatedAt: nowIso });
  const r = suggest({ storeId: "koshi", kind: "pickup", orderId: "o_t3", from: "2031-03-17", to: "2031-03-25", limit: 10 });
  ok(r.candidates.length > 0 && r.candidates.every((c) => c.date === "2031-03-20"), "希望 (必ず) の日だけを提案する");
  ok(r.candidates[0].preference === "match", "希望の日と示す");
  db.jobSpecs[db.jobSpecs.length - 1].preferenceStrength = "soft";
  const r2 = suggest({ storeId: "koshi", kind: "pickup", orderId: "o_t3", from: "2031-03-17", to: "2031-03-25", limit: 10 });
  ok(r2.candidates.every((c) => c.date !== "2031-03-18"), "都合の悪い日を提案しない");
  ok(r2.candidates[0].date === "2031-03-20" || r2.candidates[0].preference !== "off", "できればの希望は上位に来る");
}

section("距離による順位 (近くの現場とまとめて回る)");
{
  db.schedule.push(ev({ kind: "delivery", date: "2031-03-26", startTime: "13:00", endTime: "14:00", assigneeIds: [craft.id], location: "合志市御代志", title: "近所の納品" }));
  const ctx = C.createPlanContext(db, admin, { now, from: "2031-03-24", to: "2031-03-27" });
  const rq = (await imp("lib/scheduling/request.ts")).buildRequest(ctx, { storeId: "koshi", kind: "survey", address: "合志市御代志", assigneeIds: [craft.id], from: "2031-03-25", to: "2031-03-26" });
  const res = E.evaluateJob(ctx, rq.req);
  const a = res.candidates.find((c) => c.date === "2031-03-26");
  const b = res.candidates.find((c) => c.date === "2031-03-25");
  ok(a && b && a.breakdown.route > b.breakdown.route, "近くの現場がある日の移動の点が高い");
  ok(a && a.reasons.some((x) => /近くの現場/.test(x)), "理由に近くの現場を書く");
}

section("権限外の案件の情報は使わない");
{
  const r = suggest({ storeId: "koshi", kind: "pickup", orderId: order.id, from: "2031-03-17", to: "2031-03-22" }, chuoUser);
  ok(r.notes.some((n) => /閲覧の権限がない/.test(n)), "見られない受注は手がかりにしない旨を注記する");
  ok(!r.site, "見られない受注の現場住所を使わない");
  ok(!r.work, "見られない受注の明細 (作業の内容) を使わない");
}

section("仮押さえ: 枠を押さえる・確定・解除・影響");
{
  const r = suggest({ storeId: "koshi", kind: "pickup", orderId: "o_t3", from: "2031-03-17", to: "2031-03-25", limit: 3 });
  const holds = H.createHolds(db, admin, { storeId: "koshi", kind: "install", title: "仮の施工", orderId: order.id, customerId: cust.id }, [{ date: "2031-03-27", assigneeIds: [craft.id], score: 80, reasons: [], warnings: [], slot: "day" }], now);
  const r2 = suggest({ storeId: "koshi", kind: "survey", address: "合志市御代志", assigneeIds: [craft.id], from: "2031-03-27", to: "2031-03-27" });
  ok(r2.candidates.length === 0, "仮押さえ中の終日の枠には、ほかの予定を提案しない");
  const g = H.createHolds(db, admin, { storeId: "koshi", kind: "pickup", title: "引き取り テスト様", orderId: "o_t3", customerId: cust.id }, r.candidates.slice(0, 2).length ? r.candidates.slice(0, 2) : [{ date: "2031-03-20", assigneeIds: [craft.id], score: 70, reasons: [], warnings: [] }], now);
  const res = H.confirmHold(db, admin, g[0].id, now);
  ok(typeof res !== "string" && db.schedule.some((e) => e.id === res.event.id && e.orderId === "o_t3"), "確定すると予定ができる");
  ok(g.length < 2 || db.scheduleHolds.find((h) => h.id === g[1].id).status === "released", "同じ候補のほかの仮押さえは解除する");
  ok(typeof res !== "string" && res.productionJobId && db.productionJobs.some((j) => j.id === res.productionJobId && j.pickupEventId === res.event.id), "引き取りなら製造の予定を作る");
  const expired = H.createHolds(db, admin, { storeId: "koshi", kind: "survey", title: "期限切れ" }, [{ date: "2031-03-28", assigneeIds: [], score: 50, reasons: [], warnings: [] }], new Date(now.getTime() - 10 * 86400000));
  eq(H.expireHolds(db, now) >= 1, true, "期限を過ぎた仮押さえは解除される");
  ok(db.scheduleHolds.find((h) => h.id === expired[0].id).status === "expired", "状態は期限切れ");
  // 影響: 引き取りを納品より後にずらす
  db.schedule.push(ev({ kind: "delivery", date: "2031-03-24", orderId: "o_t3", title: "納品" }));
  const pick = db.schedule.find((e) => e.orderId === "o_t3" && e.kind === "pickup");
  const imps = IM.changeImpacts(db, { id: pick.id, kind: "pickup", date: "2031-03-25", storeId: "koshi", assigneeIds: pick.assigneeIds, orderId: "o_t3" }, now);
  ok(imps.some((m) => /納品/.test(m) && /前/.test(m)), "引き取りを納品より後にすると警告する");
  const pj = db.productionJobs.find((j) => j.pickupEventId === pick.id);
  pick.date = "2031-03-21";
  const notes = P.replanProductionForPickup(db, admin, pick, now);
  ok(notes.some((n) => /作り直しました/.test(n)) && pj.startDate >= "2031-03-21", "引き取りの日を変えると製造の予定を作り直す");
  H.releaseHold(db, admin, holds[0].id);
}

section("全体の最適化 (複数の案件・入れ替え)");
{
  const jobs = [
    { key: "j1", storeId: "koshi", kind: "survey", address: "合志市御代志", label: "現地調査 A" },
    { key: "j2", storeId: "koshi", kind: "survey", address: "合志市須屋", label: "現地調査 B" },
    { key: "j3", storeId: "koshi", kind: "pickup", address: "合志市御代志", tatamiCount: 4, label: "引き取り C" },
  ];
  const keep = O.optimizePlan(db, admin, { jobs, mode: "keep", from: "2031-04-01", to: "2031-04-15", now });
  ok(keep.placements.every((p) => p.candidate), "3 件すべて配置できる");
  const slots = keep.placements.map((p) => p.candidate).flatMap((c) => c.assigneeIds.map((u) => `${u}|${c.date}|${c.startTime ?? c.slot}`));
  eq(new Set(slots).size, slots.length, "同じ人を同じ時間に 2 件入れない");
  eq(keep.moves.length, 0, "変えない案は既存の予定を動かさない");
  for (let i = 0; i < 4; i++) db.schedule.push(ev({ kind: "survey", date: "2031-04-14", startTime: `${String(9 + i * 2).padStart(2, "0")}:00`, endTime: `${String(10 + i * 2).padStart(2, "0")}:00`, assigneeIds: [], location: "玉名市", title: `遠くの訪問 ${i}` }));
  const re = O.optimizePlan(db, admin, { jobs, mode: "rearrange", from: "2031-04-01", to: "2031-04-15", now, maxMoves: 2 });
  ok(re.moves.length <= 2, "動かす予定は上限 (2 件) まで");
  ok(re.moves.every((m) => m.gain >= 8 && m.to.date !== m.from.date), "動かすのは十分に良くなるものだけ");
  ok(typeof re.summary.avgScore === "number" && typeof re.keepSummary.travelMin === "number", "変えない案と動かす案の指標を返す");
  const w = O.waitingJobs(db, admin, { now });
  ok(w.some((x) => x.key.startsWith("o:o_t2")), "日程のない受注を最適化の対象に挙げる");
}

section("1 日の巡回順");
{
  const day = "2031-04-22";
  db.schedule.push(ev({ kind: "delivery", date: day, startTime: "13:00", endTime: "14:00", assigneeIds: [craft.id], location: "合志市御代志", title: "固定 13 時" }));
  db.schedule.push(ev({ kind: "pickup", date: day, slot: "am", assigneeIds: [craft.id], location: "熊本市北区植木町", title: "午前 植木" }));
  db.schedule.push(ev({ kind: "pickup", date: day, slot: "am", assigneeIds: [craft.id], location: "合志市須屋", title: "午前 須屋" }));
  const ctx = C.createPlanContext(db, admin, { now, from: day, to: day });
  const r = R.dayRoute(ctx, craft, day);
  ok(r && r.stops.length === 3, "3 か所を回る");
  const fixed = r.stops.find((s) => s.title === "固定 13 時");
  eq(fixed.start, "13:00", "時刻の決まった予定は動かさない");
  ok(r.stops.slice(0, 2).every((s) => s.title.startsWith("午前")), "午前の予定は午前に回る");
  ok(r.totalTravel <= r.currentTravel, "移動の合計は予定表の順以下");
}

section("取消しで空いた枠の再編成");
{
  db.schedule.push(ev({ kind: "survey", date: "2031-04-25", startTime: "10:00", endTime: "11:00", assigneeIds: [], location: "合志市御代志", title: "後の日の調査" }));
  db.auditLogs.push({ id: "al_t1", at: nowIso, userId: admin.id, action: "delete", entity: "schedule", entityId: "ev_deleted", entityLabel: "取消しの調査", summary: "予定を削除", storeId: "koshi", changes: [{ field: "date", before: "2031-04-16", after: null }, { field: "kind", before: "survey", after: null }, { field: "assigneeIds", before: [], after: null }] });
  const freed = RP.recentFreedSlots(db, admin, { now });
  ok(freed.some((f) => f.date === "2031-04-16" && f.reason === "deleted"), "削除で空いた枠を見つける");
  const opts = RP.pullForwardInto(db, admin, { storeId: "koshi", date: "2031-04-16" }, { now });
  ok(opts.some((o) => o.type === "advance" && o.title === "後の日の調査" && o.daysEarlier === 9), "後の日の予定の前倒しを提案する");
  ok(opts.every((o) => o.candidate.date === "2031-04-16"), "提案はその日の枠");
}

section("移動時間 (社内の計算と Google の切り替え)");
{
  const a = G.geocodeAddress("合志市御代志");
  const b = G.geocodeAddress("熊本市中央区水前寺");
  const t = RT.localTravel(a, b, 30, 1.25, 600);
  const peak = RT.localTravel(a, b, 30, 1.25, 480);
  ok(t.source === "local" && t.minutes > 10 && t.km > 5, "社内の計算で距離と時間を出す");
  ok(peak.minutes > t.minutes, "朝の混雑の時間帯は遅くなる");
  const s = { ...M.DEFAULT_ROUTING, provider: "google", policy: { approved: true } };
  ok(!RT.routingStatus(s).ready && /GOOGLE_MAPS_API_KEY/.test(RT.routingStatus(s).reason), "キーがなければ Google を使わない");
  ok(!RT.routingStatus({ ...s, policy: { approved: false } }).ready, "社内の承認がなければ Google を使わない");
  const fetched = await RT.prefetchTravel([[a, b]], s);
  eq(fetched.fetched, 0, "使えないときは外部に問い合わせない");
  RT.seedRouteForTest(a, b, 42, 18.5, s);
  const fn = RT.createTravel(s, 30);
  eq(fn(a, b).source, "google", "保存した経路があれば使う");
  eq(fn(a, b).minutes, 42, "保存した経路の時間");
  eq(fn(b, a).source, "local", "ない組は社内の計算");
  RT.resetRoutingForTest();
}

section("提案の検証 (過去の予定)");
{
  const later = new Date("2031-05-10T09:00:00+09:00");
  const r = BT.runBacktest(db, admin, { months: 3, now: later, maxSamples: 20, tune: true });
  ok(r.metrics.samples > 0, `過去の予定で比べる (${r.metrics.samples} 件)`);
  ok(r.metrics.top3 >= r.metrics.top1, "上位 3 件の一致は 1 位の一致以上");
  ok(!r.tuned || Object.keys(r.tuned.weights).length >= 6, "調整した重みを返す");
}

section("準備の状況・お客様への案内のリンク・音声の補助・AI の道具");
{
  const items = RD.readiness(db, now);
  ok(items.length >= 10 && items.every((i) => ["done", "provisional", "missing"].includes(i.status)), "一畳屋に用意していただく情報の状況を返す");
  const url = OL.offerLink("hg_test", 7, now.getTime());
  const u = new URL(url);
  eq(OL.verifyOfferLink("hg_test", u.searchParams.get("exp"), u.searchParams.get("sig"), now.getTime()), "ok", "案内のリンクの署名を確かめる");
  eq(OL.verifyOfferLink("hg_other", u.searchParams.get("exp"), u.searchParams.get("sig"), now.getTime()), "invalid", "書き換えたリンクは開けない");
  eq(OL.verifyOfferLink("hg_test", u.searchParams.get("exp"), u.searchParams.get("sig"), now.getTime() + 8 * 86400000), "expired", "期限切れのリンクは開けない");
  const chunks = ST.speechChunks("来週の合志店の予定は12件です。いちばん多いのは水曜日です。詳しくは下の表のとおりです。", { hasTable: true });
  ok(chunks.length >= 2 && chunks[0].length <= 90, "読み上げの最初のかたまりは短い (すぐに読み始める)");
  ok(chunks.join("").includes("こうし"), "読み (合志 → こうし) を直す");
  ok(ST.isStopPhrase("終わり") && ST.isStopPhrase("ありがとうございました。") && !ST.isStopPhrase("終わりの予定を教えて"), "会話モードを終える言葉だけを見分ける");
  const t = TOOL.scheduleTools.find((x) => x.def.name === "suggest_schedule").run(db, admin, { kind: "pickup", order: order.number }, now);
  ok(/\/schedule\/new\?/.test(t.text) && /orderId=o_t1/.test(t.text), "AI の道具の結果に予定の入力のリンクを付ける");
  const t2 = TOOL.scheduleTools.find((x) => x.def.name === "plan_schedule").run(db, admin, { store: "koshi", from: "2031-04-01" }, now);
  ok(/計画/.test(t2.text), "まとめて配置の道具");
  const t3 = TOOL.scheduleTools.find((x) => x.def.name === "day_route").run(db, admin, { date: "2031-04-22", staff: craft.name }, now);
  ok(/出発/.test(t3.text), "巡回順の道具");
  const t4 = TOOL.scheduleTools.find((x) => x.def.name === "schedule_setup").run(db, admin, {}, now);
  ok(/準備|○|△|×/.test(t4.text), "準備の状況の道具");
  ok(CAP.workOf({ title: "畳 表替え6 / 襖 張替3" }).fusuma === 3, "件名からの数量の読み取り (従来どおり)");
}

summary();
