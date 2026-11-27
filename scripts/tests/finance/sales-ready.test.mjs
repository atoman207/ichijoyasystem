// 実行: node scripts/tests/finance/sales-ready.test.mjs (npm run test:finance に含む)
// 売上登録 (施工完了・請求書の発行) の前の作業の担当・ポスティング (お客様のご要望 2026-11-27「■3」。ポスティングは個人のお客様だけ) と作業日報への反映、担当者の選択肢 (「■2」)
import { imp, ok, eq, section, summary } from "../hr/harness.mjs";

const store = await imp("lib/db/store.ts");
const SR = await imp("lib/sales-ready.ts");
const IR = await imp("lib/invoice-rules.ts");
const WR = await imp("lib/ops-reports/work-report.ts");
const SC = await imp("lib/staff-choices.ts");
const db = store.getDb();
const staff = db.users.filter((u) => u.active && u.role === "store_staff");
const a = staff[0];
const b = staff.find((u) => u.id !== a.id);
const active = new Set(db.users.filter((u) => u.active).map((u) => u.id));
const now = "2031-05-10T01:00:00.000Z";
const fd = (o) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) for (const x of [v].flat()) f.append(k, x);
  return f;
};

section("ポスティングの入力");
{
  eq(SR.postingFromForm(fd({}), active, a.id, now), {}, "送っていなければ変えない");
  ok(/配れてない/.test(SR.postingFromForm(fd({ postingSent: "1" }), active, a.id, now).error ?? ""), "未入力は断る (枚数か「配れてない」)");
  eq(SR.postingFromForm(fd({ postingSent: "1", "posting.status": "none" }), active, a.id, now).posting?.status, "none", "配れてない");
  const two = SR.postingFromForm(fd({ postingSent: "1", "posting.status": "done", "posting.user": [a.id, b.id, a.id], "posting.count": ["50", "30", "1,0"], "posting.date": "2031-05-09", "posting.area": "合志市須屋" }), active, a.id, now).posting;
  eq(two?.entries, [{ userId: a.id, count: 60 }, { userId: b.id, count: 30 }], "複数人それぞれの枚数 (同じ人は合計)");
  eq([two?.date, two?.area], ["2031-05-09", "合志市須屋"], "配った日・地域");
  ok(/枚数/.test(SR.postingFromForm(fd({ postingSent: "1", "posting.status": "done", "posting.user": [a.id], "posting.count": ["0"] }), active, a.id, now).error ?? ""), "0 枚は断る");
  ok(/配った人/.test(SR.postingFromForm(fd({ postingSent: "1", "posting.status": "done", "posting.user": [""], "posting.count": ["10"] }), active, a.id, now).error ?? ""), "人を選んでいない行は断る");
  eq(SR.postingLabel(two, (id) => (id === a.id ? "A" : "B")), "A 60枚・B 30枚 (計 90枚)", "表示");
}

section("売上登録の条件 (作業の担当を確定 + ポスティング)");
{
  const ws = { survey: [a.id], pickup: [a.id], delivery: [], install: [], none: ["install"], confirmedAt: now };
  eq(SR.undecidedRoles(ws), ["delivery"], "担当者も「なし」もない作業");
  ok(!SR.staffDecided(ws), "決まっていない作業があれば確定していない");
  ok(SR.staffDecided({ ...ws, none: ["delivery", "install"] }), "作業ごとに担当者か「なし」");
  ok(SR.staffDecided({ survey: [], pickup: [], delivery: [a.id], install: [], confirmedAt: now }), "以前の確定 (「なし」の項目がない) は確定とみなす");
  ok(!SR.staffDecided({ survey: [a.id], pickup: [a.id], delivery: [a.id], install: [a.id], none: [] }), "確定していない保存は不可");
  const people = { invoices: [], customers: [{ id: "c_ind", type: "individual" }, { id: "c_corp", type: "corporate" }] };
  const o = { id: "o_x", status: "completed", invoiceId: undefined, customerId: "c_ind", workStaff: { ...ws, none: ["delivery", "install"] } };
  const r1 = IR.canIssueFor(people, o);
  ok(!r1.ok && r1.needsSetup && /ポスティング/.test(r1.reason), "ポスティングが未登録なら請求書を発行しない (個人のお客様)");
  const r2 = IR.canIssueFor(people, { ...o, posting: { status: "none", entries: [], updatedAt: now, updatedBy: a.id } });
  ok(r2.ok && !r2.pre, "そろえば発行できる");
  ok(!IR.canIssueFor(people, { ...o, workStaff: undefined, posting: { status: "none", entries: [], updatedAt: now, updatedBy: a.id } }).ok, "作業の担当が未確定なら発行しない");

  // ポスティングは個人のお客様だけ (お客様のご連絡 2026-11-27「ポスティングは個人のみです」)
  ok(SR.postingNeeded(people, { customerId: "c_ind" }) && !SR.postingNeeded(people, { customerId: "c_corp" }), "ポスティングを聞くのは個人のお客様の案件だけ");
  ok(SR.postingNeeded(people, { customerId: "c_none" }), "お客様が見つからないときは個人として扱う");
  const corp = { ...o, customerId: "c_corp" };
  const r3 = IR.canIssueFor(people, corp);
  ok(r3.ok, "法人の案件はポスティングなしで請求書を発行できる");
  const rc = SR.salesReadinessOf(people, corp);
  ok(rc.ok && rc.posting && !rc.postingNeeded, "法人の案件の売上登録の条件は作業の担当だけ");
  const rc2 = SR.salesReadinessOf(people, { ...corp, workStaff: undefined });
  ok(!rc2.ok && !/ポスティング/.test(rc2.reason ?? "") && /作業の担当/.test(rc2.reason ?? ""), "法人の案件で担当が未確定のとき、断りの文にポスティングを書かない");
}

section("作業日報に出す (確定した担当・ポスティングの枚数)");
{
  const o = db.orders.find((x) => x.status !== "cancelled" && x.source !== "import") ?? db.orders[0];
  db.schedule = db.schedule.filter((e) => !(e.date >= "2031-05-01" && e.date <= "2031-05-31"));
  db.schedule.push({ id: "ev_sr1", title: "テスト 引取", kind: "pickup", date: "2031-05-08", storeId: o.storeId, assigneeIds: [b.id], orderId: o.id, customerId: o.customerId, source: "manual", createdBy: a.id, createdAt: now, updatedAt: now });
  const before = WR.buildWorkReport(db, o.storeId, "2031-05");
  eq(before.days.find((d) => d.date === "2031-05-08")?.pickups[0]?.assigneeIds, [b.id], "確定前は予定の担当者");
  o.workStaff = { survey: [], pickup: [a.id], delivery: [], install: [], none: ["survey", "delivery", "install"], confirmedAt: now, confirmedBy: a.id };
  o.posting = { status: "done", entries: [{ userId: a.id, count: 120 }, { userId: b.id, count: 80 }], date: "2031-05-09", area: "テスト町", updatedAt: now, updatedBy: a.id };
  const r = WR.buildWorkReport(db, o.storeId, "2031-05");
  eq(r.days.find((d) => d.date === "2031-05-08")?.pickups[0]?.assigneeIds, [a.id], "確定した作業の担当 (引取) を出す");
  const fl = r.days.find((d) => d.date === "2031-05-09")?.flyers ?? [];
  eq(fl.map((f) => [f.userIds[0], f.copies, f.area, f.orderNumber]), [[a.id, 120, "テスト町", o.number], [b.id, 80, "テスト町", o.number]], "ポスティングの枚数を配った日のチラシの欄に (1 人 1 行)");
  ok(r.totals.flyerCopies >= 200, "チラシの枚数の合計にも入る");
  delete o.workStaff;
  delete o.posting;
}

section("担当者の選択肢 (施工店舗 → 本部 → ほかの店舗)");
{
  const s0 = db.stores.find((s) => s.kind !== "hq");
  const g = SC.staffChoiceGroups(db, s0.id);
  ok(g[0].primary && g[0].storeId === s0.id, "施工店舗が先頭");
  const hq = g.findIndex((x) => db.stores.find((s) => s.id === x.storeId)?.kind === "hq");
  ok(hq === -1 || hq === 1, "次に本部");
  ok(g.some((x) => x.storeId !== s0.id && db.stores.find((s) => s.id === x.storeId)?.kind !== "hq"), "ほかの店舗の社員も選べる");
}

summary();
