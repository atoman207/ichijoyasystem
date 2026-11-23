// 実行: npm run test:reports (または node scripts/tests/reports/reports.test.mjs)
// 経営ダッシュボード (src/lib/management.ts) と受注の担当の判定 (src/lib/order-staff.ts) のテスト。
// データはこのファイルの中の架空の記録だけ (2030〜2031 年。名前・金額はすべてテスト用)。データベース・ファイルには触れない
import path from "node:path";
import { createJiti } from "jiti";

process.env.TZ = "Asia/Tokyo";
const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "../../..");
const jiti = createJiti(import.meta.url, { alias: { "@": path.join(root, "src"), "server-only": path.join(root, "scripts/tests/maps/empty.cjs") }, moduleCache: true });
const imp = (p) => jiti.import(path.join(root, "src", p));

let pass = 0;
const fails = [];
const ok = (cond, msg) => (cond ? (pass++, console.log("  ✓", msg)) : (fails.push(msg), console.log("  ✗", msg)));
const eq = (a, b, msg) => {
  const c = JSON.stringify(a) === JSON.stringify(b);
  ok(c, c ? msg : `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
};
const section = (t) => console.log("\n■ " + t);

const { TABLES } = await imp("lib/db/schema.ts");
const M = await imp("lib/management.ts");
const S = await imp("lib/order-staff.ts");
const K = await imp("lib/kpi.ts");
const F = await imp("lib/assistant/facts.ts");
const AN = await imp("lib/assistant/analyze.ts");

/* ------------------------------------------------------------------ */
/* 架空のデータ                                                         */
/* ------------------------------------------------------------------ */
const NOW = new Date("2031-06-15T12:00:00+09:00");
const at = "2031-01-01T00:00:00.000Z";
const db = Object.fromEntries(TABLES.map((t) => [t.collection, []]));
db.stores = [
  { id: "koshi", code: "KS", name: "テスト合志店", shortName: "合志", kind: "store", color: "#3340b8", address: "", phone: "" },
  { id: "chuo", code: "CH", name: "テスト中央店", shortName: "中央", kind: "store", color: "#14a39a", address: "", phone: "" },
];
const user = (id, name, role, storeId, active = true) => ({ id, name, kana: name, role, storeId, active, email: `${id}@example.test`, createdAt: at, updatedAt: at });
db.users = [
  user("u_admin", "試験 管理", "admin", "koshi"),
  user("u_mgr_k", "合志 店長", "store_manager", "koshi"),
  user("u_mgr_c", "中央 店長", "store_manager", "chuo"),
  user("u_staff_k", "職人 一郎", "store_staff", "koshi"),
  user("u_staff_old", "職人 一郎", "store_staff", "koshi", false), // 同じ名前の無効なアカウント (有効なほうに結び付ける)
  user("u_dup1", "同名 次郎", "store_staff", "chuo"),
  user("u_dup2", "同名 次郎", "store_staff", "chuo"), // 同じ名前が 2 人 → 担当者欄の名前は結び付けない
  user("u_clerk", "事務 花子", "store_staff", "koshi"),
];
db.customers = [{ id: "c1", code: "T-1", name: "テスト 顧客", kana: "テスト", type: "individual", phone: "", postalCode: "", address: "", storeId: "koshi", preferredChannel: "phone", firstContactChannel: "phone", tags: [], notes: "", createdAt: at, updatedAt: at }];
const note = (body) => [{ id: `n_${Math.random()}`, at, userId: "u_clerk", kind: "complete", body: `販売管理ソフトの売上明細より取込 (伝票№1)\n${body}` }];
const order = (id, extra) => ({ id, number: id.toUpperCase(), customerId: "c1", storeId: "koshi", title: "テスト工事", category: "tatami", total: 0, status: "paid", workerIds: [], siteAddress: "", progressNotes: [], createdBy: "u_admin", createdAt: at, updatedAt: at, ...extra });
const imported = (id, date, total, staffLine, extra = {}) => order(id, { source: "import", contractDate: date, salesDate: date, completedAt: `${date}T18:00:00.000Z`, total, progressNotes: note(staffLine), ...extra });
db.orders = [
  // 移行データ: 担当者欄の 1 番目 = 担当、2 番目 = 施工担当、3 番目 = 入力者 (数えない)。取込のときの施工担当の ID が消えている
  imported("o1", "2031-05-10", 110000, "担当者欄: 5 職人一郎、7 退職三郎、51 事務花子", { tatamiCost: 30000, workerIds: ["u_gone"], createdBy: "u_clerk" }),
  // 名前が 2 つ = 担当 + 入力者
  imported("o2", "2031-05-20", 55000, "担当者欄: 9 退職三郎、51 事務花子", { createdBy: "u_mgr_k" }),
  // 同じ名前の社員が 2 人いる名前は、アカウントのない人として数える
  imported("o3", "2031-04-02", 220000, "担当者欄: 3 同名次郎、3 同名次郎、52 事務花子", { storeId: "chuo" }),
  // 前年同期 (2030-04-01〜2030-06-15) に入る / 入らない (今日の 1 年前より後)
  imported("o4", "2030-05-15", 100000, "担当者欄: 5 職人一郎、5 職人一郎、51 事務花子"),
  imported("o5", "2030-06-20", 999999, "担当者欄: 5 職人一郎、5 職人一郎、51 事務花子"),
  // システムで登録した受注: 担当 = 見積の担当者 (受注の作成者ではない)
  order("o6", { quoteId: "q1", contractDate: "2031-05-03", status: "scheduled", total: 88000, createdBy: "u_admin" }),
  order("o7", { contractDate: "2031-05-05", salesDate: "2031-05-06", status: "cancelled", total: 50000, createdBy: "u_mgr_k" }),
  order("o8", { storeId: "chuo", contractDate: "2031-06-01", salesDate: "2031-06-10", completedAt: "2031-06-10T18:00:00.000Z", status: "completed", total: 33000, createdBy: "u_mgr_c", workerIds: ["u_mgr_c"] }),
];
db.quotes = [{ id: "q1", number: "Q1", customerId: "c1", storeId: "koshi", category: "tatami", title: "テスト見積", items: [], subtotal: 80000, discount: 0, tax: 8000, total: 88000, status: "accepted", estimatorId: "u_mgr_k", createdBy: "u_admin", createdAt: "2031-05-01T09:00:00.000Z", updatedAt: at }];
db.inquiries = [{ id: "i1", storeId: "koshi", channel: "phone", category: "tatami", status: "won", receivedAt: "2031-05-01T09:00:00.000Z", assignedUserId: "u_mgr_k", createdBy: "u_admin", customerId: "c1", contactName: "テスト", createdAt: at, updatedAt: at }];
db.purchases = [
  { id: "p1", storeId: "koshi", invoiceDate: "2031-05-12", amount: 10000, status: "received", registeredBy: "u_mgr_k", createdAt: at, updatedAt: at },
  { id: "p2", storeId: "koshi", invoiceDate: "2031-05-12", amount: 70000, status: "rejected", registeredBy: "u_mgr_k", createdAt: at, updatedAt: at },
];
db.expenses = [
  { id: "e1", storeId: "koshi", date: "2031-05-13", amount: 5000, status: "approved", submittedBy: "u_staff_k", account: "消耗品費", vendor: "テスト", paymentMethod: "cash", createdAt: at, updatedAt: at },
  { id: "e2", storeId: "koshi", date: "2031-05-14", amount: 2000, status: "pending_approval", submittedBy: "u_staff_k", account: "消耗品費", vendor: "テスト", paymentMethod: "cash", createdAt: at, updatedAt: at },
];
db.surveys = [{ id: "s1", storeId: "koshi", orderId: "o1", postcardNo: "1", source: "manual", salesUserId: "u_mgr_k", deliveryUserIds: ["u_staff_k"], phoneScore: 5, salesScore: 4, craftsmanScore: 5, finishScore: 4, wouldUseAgain: "はい", answeredOn: "2031-05-15", receivedAt: "2031-05-16T00:00:00.000Z", createdAt: at, updatedAt: at }];

const admin = db.users.find((u) => u.id === "u_admin");
const mgrK = db.users.find((u) => u.id === "u_mgr_k");
const FILTER = { from: "2031-04-01", to: "2031-06-30" };
const r = M.managementReport(db, admin, FILTER, NOW);
const t = r.totals;

/* ------------------------------------------------------------------ */
section("1. 担当者欄の読み取り (1 番目 = 担当・2 番目 = 施工担当・3 番目 = 入力者)");
eq(S.ledgerStaffOf({ progressNotes: note("担当者欄: 5 山田 太郎、7 鈴木　次郎、51 佐藤花子") }), { sales: "山田太郎", worker: "鈴木次郎", input: "佐藤花子" }, "名前が 3 つ: 担当・施工担当・入力者 (番号と空白を除く)");
eq(S.ledgerStaffOf({ progressNotes: note("担当者欄: 9 山田太郎、51 佐藤花子") }), { sales: "山田太郎", input: "佐藤花子" }, "名前が 2 つ: 担当 + 入力者");
eq(S.ledgerStaffOf({ progressNotes: note("担当者欄: 9 山田太郎") }), { sales: "山田太郎" }, "名前が 1 つ: 担当");
eq(S.ledgerStaffOf({ progressNotes: [] }), null, "担当者欄がない受注は null");

section("2. 担当・施工担当の判定 (order-staff.ts)");
const idx = S.orderStaffIndex(db);
eq(idx.byOrder.get("o1"), { sales: ["u_staff_k"], workers: ["name:退職三郎"] }, "移行データ: 担当は有効なアカウントに結び付け、消えた施工担当の ID は担当者欄の名前に置き換える");
eq(idx.byOrder.get("o2"), { sales: ["name:退職三郎"], workers: [] }, "名前が 2 つの移行データ: 2 番目 (入力者) は施工担当にしない");
eq(idx.byOrder.get("o3").sales, ["name:同名次郎"], "同じ名前の社員が 2 人いる名前は結び付けない");
eq(idx.byOrder.get("o6").sales, ["u_mgr_k"], "システムの受注: 担当 = 見積の担当者 (受注の作成者ではない)");
eq(idx.byOrder.get("o8").sales, ["u_mgr_c"], "見積のない受注: 担当 = 受注の作成者");
ok(![...idx.byOrder.values()].some((x) => x.sales.includes("u_clerk") || x.workers.includes("u_clerk")), "伝票の入力者 (3 番目) は担当にも施工担当にもならない");
eq(idx.label("name:退職三郎"), "退職三郎", "アカウントのない人の表示名は担当者欄の名前");

section("3. 期間・前年同期");
eq(M.shiftYears("2032-02-29", -1), "2031-02-28", "2/29 はない年なら 2/28");
eq(M.previousYearRange("2031-04-01", "2031-06-30", "2031-06-15"), { from: "2030-04-01", to: "2030-06-15" }, "今日をまたぐ期間は今日までにそろえて 1 年前へ");
eq(M.previousYearRange("2030-01-01", "2030-12-31", "2031-06-15"), { from: "2029-01-01", to: "2029-12-31" }, "過去の期間はそのまま 1 年前へ");
eq(r.previous.totals.sales, 100000, "前年同期の売上 (今日の 1 年前より後の受注は入れない)");
eq(r.previous.base.sales, 418000, "比べる今期は今日まで");
eq(Math.round(M.growth(r.previous.base.sales, r.previous.totals.sales) * 1000) / 10, 318, "前年比 +318%");
eq(r.months.find((m) => m.month === "2031-05").prevSales, 100000, "月次: 前年同月の売上");

section("4. 合計 (売上・受注・簡易粗利)");
eq(t.sales, 418000, "売上 = 売上計上日が期間内 (キャンセルを除く)");
eq([t.salesCount, t.importedSales, t.importedSalesCount], [4, 385000, 3], "うち移行データの売上");
eq([t.orderCount, t.orderAmount, t.funnelOrders, t.importedOrderCount], [5, 506000, 2, 3], "受注 (契約日)・システムで登録した受注・移行データの受注");
eq([t.inquiries, t.quotes], [1, 1], "問い合わせ・見積");
eq([t.tatamiCost, t.purchases, t.purchaseCount, t.expenses, t.expensesPending, t.expenseCount], [30000, 10000, 1, 5000, 2000, 2], "畳原価・仕入 (却下を除く)・経費");
eq(t.gross, 418000 - 30000 - 10000 - 5000, "簡易粗利 = 売上 − 畳原価 − 仕入 − 経費");

section("5. 受注の進み具合 (移行データは別に数える)");
const pipe = Object.fromEntries(r.pipeline.map((p) => [p.key, p.count]));
eq([pipe.scheduled, pipe.completed, pipe.cancelled, pipe.paid], [1, 1, 1, 0], "システムで登録した受注だけを状態で分ける (移行データの「入金済」を入れない)");
eq(r.migrated, { count: 3, amount: 385000 }, "移行データの件数・金額");

section("6. 担当者別");
const row = (key) => r.staffRows.find((s) => s.key === key);
eq(r.staffRows.reduce((a, s) => a + s.sales, 0), t.sales, "担当者別の売上の合計 = 売上 (1 件を 1 人に数える)");
eq([row("u_staff_k").sales, row("u_staff_k").orderCount, row("u_staff_k").expenses], [110000, 1, 5000], "担当者欄の 1 番目の社員に売上");
eq([row("name:退職三郎").sales, row("name:退職三郎").jobsCompleted, row("name:退職三郎").role, row("name:退職三郎").hasAccount], [55000, 1, "アカウントなし", false], "アカウントのない人も名前で 1 行 (施工完了は 2 番目)");
eq([row("u_mgr_k").orderCount, row("u_mgr_k").orderAmount, row("u_mgr_k").quotes, row("u_mgr_k").inquiries], [1, 88000, 1, 1], "見積の担当者に受注・見積、担当者に問い合わせ");
ok(!row("u_clerk") && !row("u_admin"), "入力者・受注の作成者だけの人は行にならない");
eq(row("name:同名次郎").storeId, "chuo", "アカウントのない人の所属は受注の多い店舗");

section("7. 担当者・店舗の絞り込みと閲覧範囲");
const rf = M.managementReport(db, admin, { ...FILTER, staffId: "name:退職三郎" }, NOW);
eq(rf.staffRows.map((s) => s.key), ["name:退職三郎"], "名前のキーで絞り込める");
eq(rf.totals.sales, 110000 + 55000, "絞り込むと、その人が担当・施工担当の受注を数える");
const rm = M.managementReport(db, mgrK, FILTER, NOW);
eq(rm.stores.map((s) => s.id), ["koshi"], "店長は自店舗だけ");
eq(rm.totals.sales, 165000, "店長の売上は自店舗だけ");
const opts = M.staffOptions(db, mgrK);
ok(opts.some((o) => o.key === "name:退職三郎") && !opts.some((o) => o.key === "name:同名次郎") && !opts.some((o) => o.storeId === "chuo"), "店長の担当者の候補は自店舗の社員と、自店舗の受注にだけ名前のある人");

section("8. 店舗別・アンケート");
const koshi = r.storeRows.find((s) => s.storeId === "koshi");
eq([koshi.sales, koshi.tatamiCost, koshi.gross, koshi.prevSales], [165000, 30000, 165000 - 30000 - 10000 - 5000, 100000], "店舗別の売上・畳原価・簡易粗利・前年同期");
eq(Math.round(koshi.salesGrowth * 100), 65, "店舗別の前年比");
const k = K.storeKpi(db, FILTER, "koshi");
const sv = r.surveys.find((x) => x.storeId === "koshi");
eq([sv.n, sv.replyRate, sv.scores.phoneScore, sv.againRate], [k.surveys, k.replyRate / 100, k.scores.phoneScore, k.againYes / k.againAnswered], "アンケートは KPI の画面 (storeKpi) と同じ値");

section("9. CSV");
const summaryCsv = M.mgmtCsvRows(r, "summary", "テスト期間");
eq(summaryCsv[0], ["項目", "値", "前年同期"], "概要に前年同期の列");
eq(summaryCsv.find((x) => x[0] === "簡易粗利 (売上−畳原価−仕入−経費)")?.slice(1), [t.gross, r.previous.totals.gross], "概要の簡易粗利");
eq(summaryCsv.find((x) => x[0] === "未入金残高 (今日時点)")?.[2], "", "今日時点の値は前年同期と比べない");
eq(M.mgmtCsvRows(r, "pipeline", "").at(-1), ["移行データ (販売管理ソフトの売上・入金済として移行)", 3, 385000], "進み具合の CSV に移行データの行");
eq(M.mgmtCsvRows(r, "staff", "")[0][3], "アカウント", "担当者別の CSV にアカウントの列");
eq(M.mgmtCsvRows(r, "surveys", "").length, r.surveys.length + 1, "アンケートの CSV");
const monthly = M.mgmtCsvRows(r, "monthly", "");
const may = monthly.find((x) => x[0] === "2031年5月") ?? monthly[2];
ok(monthly[0].includes("前年同月の売上") && monthly[0].includes("畳原価"), "月次の CSV に前年同月の売上・畳原価");
ok(typeof may.at(-1) === "number", "月次の簡易粗利は数字");

section("10. AI アシスタントと同じ数字");
const facts = F.salesFacts(db).byId;
eq([facts.get("o1").staff, facts.get("o1").workerNames], [["職人一郎"], ["退職三郎"]], "分析用データの担当・施工担当");
const an = AN.runAnalysis(db, admin, { subject: "sales", metrics: ["sales"], group_by: ["staff"], ...FILTER }, NOW);
ok(an.ok, "担当者別の売上の分析が動く");
const aiStaff = Object.fromEntries((an.rows ?? []).map((x) => [x.k0, x.sales]));
eq(Object.fromEntries(r.staffRows.filter((s) => s.sales).map((s) => [S.compactName(s.name), s.sales])), aiStaff, "AI の担当者別の売上 = 経営ダッシュボードの担当者別");
const g = AN.runAnalysis(db, admin, { subject: "sales", metrics: ["simple_gross"], group_by: [], ...FILTER }, NOW);
eq(g.rows?.[0]?.simple_gross, t.gross, "AI の簡易粗利 = 経営ダッシュボードの簡易粗利");

section("内部受注などの店舗間の配分 (お客様のご要望 2026-11-23 ■3)");
{
  const d2 = structuredClone(db);
  // o8 (中央店が施工・6/10 完了) を合志店が依頼した内部受注: 税込 6,600 円を合志店へ。税抜で計算した本部の特殊配分 1,000 円 (5/20) は 1,100 円。原価のみ計上は売上を動かさない
  d2.salesAdjustments = [
    { id: "adj1", number: "SA-2031-0001", kind: "internal_order", orderId: "o8", fromStoreId: "koshi", toStoreId: "chuo", base: "tax_included", amount: 6600, provisional: false, status: "active", createdBy: "u_admin", createdAt: at },
    { id: "adj2", number: "SA-2031-0002", kind: "hq_special", date: "2031-05-20", fromStoreId: "chuo", toStoreId: "hq", base: "tax_excluded", amount: 1000, treatment: "sales_transfer", provisional: false, status: "active", createdBy: "u_admin", createdAt: at },
    { id: "adj3", number: "SA-2031-0003", kind: "hq_special", date: "2031-05-21", fromStoreId: "koshi", toStoreId: "hq", base: "tax_included", amount: 9999, treatment: "cost_only", provisional: false, status: "active", createdBy: "u_admin", createdAt: at },
    { id: "adj4", number: "SA-2031-0004", kind: "manual", date: "2031-07-05", fromStoreId: "koshi", toStoreId: "chuo", base: "tax_included", amount: 5000, provisional: false, status: "active", createdBy: "u_admin", createdAt: at },
  ];
  const ra = M.managementReport(d2, admin, FILTER, NOW);
  const row = (sid) => ra.storeRows.find((x) => x.storeId === sid);
  eq(row("koshi").allocation, 6600, "依頼元 (合志店) に +6,600 (受注の売上計上日に計上)");
  eq(row("chuo").allocation, -6600 + 1100, "施工店舗 (中央店) は −6,600、本部へ渡した側として税抜 1,000 → 税込 +1,100");
  eq(row("koshi").salesAllocated, row("koshi").sales + 6600, "配分後の売上 = 売上 + 配分");
  eq(ra.totals.allocation, ra.storeRows.reduce((a, x) => a + x.allocation, 0), "全店の配分 = 店舗の配分の合計");
  eq(ra.totals.sales, r.totals.sales, "外部の売上 (全店) は配分で変わらない");
  ok(!ra.storeRows.some((x) => x.allocation === 9999 || x.allocation === -9999), "本部の特殊配分の「原価のみ計上」は売上を動かさない");
  eq(ra.months.reduce((a, m) => a + (m.allocByStore.koshi ?? 0), 0), 6600, "月次の店舗別の配分 (期間外の 7/5 の行は入らない)");
  const rs = M.managementReport(d2, admin, { ...FILTER, staffId: "u_mgr_c" }, NOW);
  eq(rs.totals.allocation, 0, "担当者で絞ったときは配分を数えない");
  const rk = M.managementReport(d2, mgrK, FILTER, NOW);
  eq(rk.totals.allocation, rk.storeRows.find((x) => x.storeId === "koshi")?.allocation ?? 6600, "店舗のロールは自店舗の配分だけ");
  const csvRows = M.mgmtCsvRows(ra, "stores", "期間");
  ok(csvRows[0].includes("内部受注などの配分") && csvRows[0].includes("配分後の売上"), "CSV にも配分と配分後の売上");
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log("FAILED:\n - " + fails.join("\n - "));
  process.exitCode = 1;
}
