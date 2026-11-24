/**
 * KPI の分母・数え方 (スプレッドシートの集計基準) と支給前の照合のテスト
 *   node scripts/tests/kpi-import/basis.test.mjs   (npm run test:kpi-import)
 * 1. 設定の既定値 (シートの基準)・期間の月
 * 2. 全案件数の自動の値 (移行した売上台帳の行の数 + 新システムで完了した受注)・分母 (月ごとの値 → なければ自動)
 * 2b. リピートの調整 (同じお客様の約 1 か月以内の次の案件は個人件数で 1 件)・全案件数の数え方 (案件 / 作業日報の納品 / 受注)・
 *     クレーム・手直しのポイントの上限 (同じ案件は最大 3 点)・経営管理の指標 (件数と率)・LINE の文から区分の候補・集計表 (店舗の列)・販促 KPI
 * 3. はがきの数え方 (ハガキ№・担当の名前の未記入)・平均 (空欄 = 0 点 / 回答した数)・②③ の行 (2 人目以降の担当の行を含む)
 * 4. storeKpi・年間インセンティブが同じ分母と平均を使う (平均の計算で支給額が変わる例)
 * 5. 年間チラシ計画「個人件数売上」・アンケートハガキ（回答）の読み取りと取込 (手入力は上書きしない・2 回取り込んでも同じ・漏れた担当の行を足す)
 * 6. KPI のタブとの照合 (ポイント合計・分母の表を含む・年度の途中は値のある月まで)
 * 7. ⑤〜⑦ の読み替え (R = 以前頼んだことがある・DM・自由記述 = その他)・集計表
 * 8. 画面の操作 (Server Action の本物): 数え方の設定 (管理者のみ)・月の値の手入力・取込の確認と取込
 * データはすべて架空 (一時フォルダーの JSON)。外部への送信の設定は消す
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "../../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ichijoya-kpi-basis-test-"));
fs.mkdirSync(path.join(work, "data"), { recursive: true });
Object.assign(process.env, {
  DATA_BACKEND: "json",
  DATA_FILE_NAME: "kpi-basis-test-db.json",
  FILE_STORAGE_DIR: path.join(work, "uploads"),
  DB_SNAPSHOT: "off",
  ICHIJOYA_DATA_DB: "off",
  ICHIJOYA_DATA_DB_PATH: path.join(work, "mirror.sqlite"),
  CHATBOT_DB_PATH: path.join(work, "chatbot.sqlite"),
  ROUTING_DB_PATH: path.join(work, "routing.sqlite"),
  SESSION_SECRET: "test-secret-for-kpi-basis",
  APP_BASE_URL: "https://example.test",
  TZ: "Asia/Tokyo",
});
for (const k of Object.keys(process.env)) if (/^(SMTP_|RESEND_|SENDGRID_|LINE_|CHATWORK_|OPENAI_|ANTHROPIC_|GOOGLE_|NEXT_PUBLIC_SUPABASE_|SUPABASE_|AI_INTAKE_)/.test(k)) delete process.env[k];
process.chdir(work);
const stubs = path.join(root, "scripts/tests/ops-reports/stubs");
const jiti = createJiti(import.meta.url, {
  alias: {
    "next/navigation": path.join(stubs, "next-navigation.cjs"),
    "next/cache": path.join(stubs, "next-cache.cjs"),
    "@/lib/auth/session": path.join(stubs, "session.cjs"),
    "@": path.join(root, "src"),
    "server-only": path.join(root, "scripts/tests/maps/empty.cjs"),
  },
  moduleCache: true,
});
const imp = (p) => jiti.import(path.join(root, "src", p));

let pass = 0;
const fails = [];
const ok = (cond, msg) => {
  if (cond) {
    pass++;
    console.log("  ✓", msg);
  } else {
    fails.push(msg);
    console.log("  ✗", msg);
  }
};
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a) === JSON.stringify(b) ? msg : `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const near = (a, b, msg, d = 1e-6) => ok(a !== null && a !== undefined && Math.abs(a - b) < d, `${msg}${a !== null && a !== undefined && Math.abs(a - b) < d ? "" : ` (got ${a}, want ${b})`}`);
const section = (t) => console.log(`\n■ ${t}`);

const B = await imp("lib/kpi-basis.ts");
const BI = await imp("lib/kpi-basis-import.ts");
const KC = await imp("lib/kpi-core.ts");
const K = await imp("lib/kpi.ts");
const I = await imp("lib/incentive.ts");
const KS = await imp("lib/kpi-settings.ts");
const KSH = await imp("lib/survey-workbook/kpi-sheet.ts");
const ST = await imp("lib/survey-workbook/staff.ts");
const SV = await imp("lib/survey.ts");
const TL = await imp("lib/survey-tally.ts");
const FL = await imp("lib/field-labels.ts");

/* ------------------------------------------------------------------ */
/* 架空のデータ                                                          */
/* ------------------------------------------------------------------ */
const at = "2031-01-01T00:00:00.000Z";
const users = [
  { id: "u_a", name: "試験 一郎", storeId: "koshi", role: "store_staff", active: true, email: "a@example.test", title: "" },
  { id: "u_b", name: "見本 二郎", storeId: "koshi", role: "store_manager", active: true, email: "b@example.test", title: "" },
  { id: "u_c", name: "仮名 三郎", storeId: "chuo", role: "store_staff", active: true, email: "c@example.test", title: "" },
  { id: "u_d", name: "架空 花子", storeId: "hq", role: "hq_staff", active: true, email: "d@example.test", title: "事務" },
];
const stores = ["koshi", "chuo", "nishi", "tamana"].map((id) => ({ id, name: id, shortName: id, kind: "store" })).concat([{ id: "hq", name: "本部", shortName: "本部", kind: "hq" }]);
const customers = [
  { id: "c_i", type: "individual", name: "個人様" },
  { id: "c_c", type: "corporate", name: "業者様" },
  { id: "c_k", type: "individual", name: "中央様" },
];
const ledgerOrder = (id, storeId, date, rows, customerId = "c_i") => ({
  id, number: id, storeId, customerId, status: "paid", source: "import", contractDate: date, salesDate: date, total: 1000, workerIds: [],
  sourceRef: `03_売上/${storeId}　売上.xlsx#${date.slice(0, 4)}.${Number(date.slice(5, 7))}!${rows[0]}`,
  progressNotes: [{ id: `pn_${id}`, at, userId: "u_b", kind: "complete", body: `売上台帳より取込 (${rows.map((r) => `${storeId}　売上.xlsx#${date.slice(0, 4)}.${Number(date.slice(5, 7))}!${r}`).join(" / ")})` }],
});
const slipOrder = (id, storeId, date, customerId = "c_i") => ({ id, number: id, storeId, customerId, status: "paid", source: "import", contractDate: date, salesDate: date, total: 1000, workerIds: [], sourceRef: "02_販売管理/売上明細.csv#S-1", progressNotes: [] });
const orders = [
  // 合志 2031-01: 台帳 3 行 (追加工事の 2 行を 1 件にまとめた受注を含む) + 伝票だけの受注 2 件 (台帳と二重)
  ledgerOrder("o1", "koshi", "2031-01-10", [21, 22]),
  ledgerOrder("o2", "koshi", "2031-01-31", [23], "c_c"),
  slipOrder("o3", "koshi", "2031-01-12"),
  slipOrder("o4", "koshi", "2031-01-13"),
  // 合志 2031-02: 台帳 1 行 (2 月 5 日まで取込)
  ledgerOrder("o5", "koshi", "2031-02-05", [21]),
  // 中央 2031-01: 台帳なし・システムの受注 1 件
  { id: "o6", number: "O-1", storeId: "chuo", customerId: "c_k", status: "completed", contractDate: "2031-01-20", salesDate: "2031-01-20", total: 1000, workerIds: [], progressNotes: [] },
  { id: "o7", number: "O-2", storeId: "chuo", customerId: "c_i", status: "cancelled", contractDate: "2031-01-21", salesDate: "2031-01-21", total: 1000, workerIds: [], progressNotes: [] },
];
const card = (id, o) => ({ id, receivedAt: "2031-02-03T00:00:00.000Z", storeId: "koshi", source: "import", ...o });
const surveys = [
  // 合志 1 月分 (2 月の初めに入力。集計月 = 1 月)
  card("s1", { postcardNo: "101", countMonth: "2031-01", salesName: "試験", salesUserId: "u_a", craftsmanName: "見本", craftsmanUserId: "u_b", phoneScore: 5, salesScore: 5, craftsmanScore: 4, finishScore: 5, priorities: "価格, 評判", media: "R, チラシ", wouldUseAgain: "はい" }),
  card("s2", { postcardNo: "102", countMonth: "2031-01", salesName: "試験", salesUserId: "u_a", craftsmanName: "見本", craftsmanUserId: "u_b", salesScore: 3, craftsmanScore: 4, finishScore: 4, media: "DM, 近所の人が使っていた", wouldUseAgain: "はい" }),
  // 2 人目の職人の行 (ハガキ№ なし。②③ の個人評価にだけ使う)
  card("s3", { countMonth: "2031-01", storeId: "hq", craftsmanName: "仮名", craftsmanUserId: "u_c", craftsmanScore: 5, salesScore: 4 }),
  // 担当の名前がない (ノーカウント)
  card("s4", { postcardNo: "103", countMonth: "2031-01", craftsmanName: "見本", craftsmanUserId: "u_b", phoneScore: 1, finishScore: 1 }),
  // 写真から登録 (集計月なし → 回答日の月)
  { id: "s5", receivedAt: "2031-02-20T00:00:00.000Z", answeredOn: "2031-02-18", storeId: "koshi", source: "capture", salesUserId: "u_a", deliveryUserIds: ["u_a", "u_b"], phoneScore: 4, salesScore: 4, craftsmanScore: 5, finishScore: 5, mediaList: ["以前頼んだことがある"], wouldUseAgain: "わからない" },
];
const qualityIssues = [
  { id: "q1", number: "QC-1", storeId: "koshi", kind: "claim", points: 2, occurredOn: "2031-01-01", attribution: "store", counted: true, responsibleUserIds: [], status: "open", description: "", reportedBy: "u_b", createdAt: at, updatedAt: at },
  { id: "q2", number: "QC-2", storeId: "koshi", kind: "rework", points: 1, occurredOn: "2031-02-01", attribution: "store", counted: true, responsibleUserIds: [], status: "open", description: "", reportedBy: "u_b", createdAt: at, updatedAt: at },
];
const base = () => ({ users: structuredClone(users), stores: structuredClone(stores), customers: structuredClone(customers), orders: structuredClone(orders), surveys: structuredClone(surveys), qualityIssues: structuredClone(qualityIssues), reviews: [], settings: [], surveyHistory: [] });

/* ================================================================== */
section("1. 設定の既定値・期間の月");
{
  const b = B.kpiBasis({ settings: [] });
  eq([b.denominator, b.requireStaffNames, b.average, b.individualSource, b.repeatDays, b.casesSource], ["sheet", true, "sheet", "plan", 30, "cases"], "既定はシートの基準 (分母・担当の名前・平均・年間チラシ計画の個人件数・リピート 30 日・案件の件数)");
  eq(B.kpiBasis({ settings: [{ id: "kpi_basis", value: { autoSites: false } }] }).casesSource, "system", "以前の設定 (施工件数を台帳から出さない) は「期間内の受注」");
  eq(B.fiscalMonths(2031, 12), ["2030-12", "2031-01", "2031-02", "2031-03", "2031-04", "2031-05", "2031-06", "2031-07", "2031-08", "2031-09", "2031-10", "2031-11"], "年度の 12 か月 (12 月始まり)");
  eq(B.periodMonths({ from: "2031-01-15", to: "2031-03-31" }), [{ month: "2031-01", full: false }, { month: "2031-02", full: true }, { month: "2031-03", full: true }], "期間の月 (月の途中から始まる月は full = false)");
  eq(KC.surveyKpiDate({ countMonth: "2031-01", answeredOn: "2031-02-02", receivedAt: at }), "2031-01-01", "集計月があれば集計月");
  eq(KC.surveyKpiDate({ answeredOn: "2031-02-02", receivedAt: at }), "2031-02-02", "なければ回答日");
  eq([KC.isCard({ postcardNo: "1", source: "import" }), KC.isCard({ source: "import" }), KC.isCard({ source: "capture" })], [true, false, true], "移行データは ハガキ№ のある行だけがはがき");
}

/* ================================================================== */
section("2. 全案件数の自動の値・分母");
{
  const db = base();
  const lc = B.ledgerCounts(db.orders);
  eq([lc.sites.get("koshi|2031-01"), lc.sites.get("koshi|2031-02"), lc.sites.get("chuo|2031-01")], [3, 1, undefined], "台帳の行の数 (まとめた受注は経過メモの行の数。伝票の受注は数えない)");
  eq(lc.lastDate.get("koshi"), "2031-02-05", "取り込んだ台帳の最後の日");
  const p = { from: "2031-01-01", to: "2031-02-28" };
  // 値がないとき: 個人件数 = 自動 (個人のお客様の案件 − リピート)、全案件数 = 案件の件数 (台帳の行 + 新システムで完了した受注)
  let d = B.kpiDenominators(db, p, "koshi");
  eq([d.individual.value, d.sites.value], [1, 4], "合志: 個人件数は自動 (1 月 10 日の 2 行 = 同じ日の追加工事・2 月 5 日 = 26 日後 はリピート → 1)、全案件数は台帳の行 (3 + 1)。伝票の受注 (o3・o4) は数えない");
  eq([d.sites.parts.map((x) => x.source), d.individual.parts.map((x) => [x.source, x.raw, x.repeats])], [["cases", "cases"], [["auto", 2, 1], ["auto", 1, 1]]], "内訳: 全案件数は案件の件数・個人件数は自動 (まとめる前の件数とリピート)");
  eq(B.denomSummary(d.individual), "自動 (リピートを 1 件) 2 か月 (リピート 2 件を除く)", "分母の内訳の要約にリピートの件数");
  d = B.kpiDenominators(db, p, "chuo");
  eq([d.individual.value, d.sites.value, d.sites.parts[0].source], [1, 1, "cases"], "中央: 台帳のない店舗は新システムで完了した受注 (キャンセルを除く)");
  // 年間チラシ計画の値と手入力
  db.settings.push({ id: "kpi_basis", value: { months: { "koshi|2031-01": { individual: 10, individualSrc: "import" }, "koshi|2031-02": { individual: 6, individualSrc: "manual", sites: 9 } } }, updatedAt: at });
  d = B.kpiDenominators(db, p, "koshi");
  eq([d.individual.value, d.sites.value], [16, 12], "登録した個人件数 (10 + 6)・手入力の施工件数 (2 月 = 9) を使う");
  eq(B.denomSummary(d.individual), "年間チラシ計画 1 か月 + 手入力 1 か月", "分母の内訳の要約");
  d = B.kpiDenominators(db, { from: "2031-01-10", to: "2031-02-28" }, "koshi");
  eq([d.individual.parts[0].source, d.individual.parts[0].partial, d.individual.value], ["auto", true, 1 + 6], "月の途中から始まる期間: その月は期間内の案件で自動 (1/10 の 2 行 = 1 件。1/31 の業者は個人に入れない)");
  const all = B.kpiDenominators(db, p);
  eq([all.individual.value, all.sites.value], [17, 13], "全社 = 店舗の合計");
  db.settings[0].value.denominator = "system";
  d = B.kpiDenominators(db, p, "koshi");
  eq([d.mode, d.individual.value, d.sites.value], ["system", 4, 5], "システムの件数: 期間内の案件 (伝票の受注も数える = 従来の動き)");
}

/* ================================================================== */
section("2b. リピートの調整・全案件数の数え方・クレームのポイントの上限 (2026-11-24)");
{
  // 新システムで完了した受注 (合志)。A = 3/1・3/20 (19 日後 = リピート)・4/5 (35 日後 = はがきを渡す)・4/30 (4/5 から 25 日後 = リピート)
  // B = 3/10・5/1 (52 日後 = リピートではない)。C (業者) = 3/5・3/6 (個人件数に入れない・全案件数には入る)。D = 未完了 (数えない)
  const sys = (id, customerId, date, o = {}) => ({ id, number: id, storeId: "koshi", customerId, status: "completed", contractDate: date, salesDate: date, total: 10000, workerIds: [], progressNotes: [], ...o });
  const mk = () => ({
    ...base(),
    customers: [...structuredClone(customers), { id: "c_a", type: "individual", name: "A" }, { id: "c_b", type: "individual", name: "B" }],
    orders: [
      sys("a1", "c_a", "2031-03-01"), sys("a2", "c_a", "2031-03-20"), sys("a3", "c_a", "2031-04-05"), sys("a4", "c_a", "2031-04-30"),
      sys("b1", "c_b", "2031-03-10"), sys("b2", "c_b", "2031-05-01"),
      sys("c1", "c_c", "2031-03-05"), sys("c2", "c_c", "2031-03-06"),
      sys("d1", "c_b", "2031-03-12", { status: "in_progress", salesDate: undefined }),
      sys("x1", "c_a", "2031-03-02", { status: "cancelled" }),
    ],
    qualityIssues: [],
    schedule: [],
  });
  const P = (from, to) => ({ from, to });
  let db = mk();
  const units = B.caseUnits(db.orders, 30);
  eq(units.filter((u) => u.repeat).map((u) => u.orderId).sort(), ["a2", "a4", "c2"], "リピート: はがきを渡した案件から 30 日以内の次の案件 (a2 = 19 日・a4 = 4/5 から 25 日)。a3 (35 日) と b2 (52 日) はリピートではない (業者の c2 も印は付くが個人件数には元から入らない)");
  eq(units.map((u) => u.orderId).sort(), ["a1", "a2", "a3", "a4", "b1", "b2", "c1", "c2"], "案件 = 完了した受注 (未完了・キャンセルは数えない)");
  let d = B.kpiDenominators(db, P("2031-03-01", "2031-05-31"), "koshi");
  eq(d.individual.parts.map((x) => [x.month, x.value, x.raw, x.repeats ?? 0]), [["2031-03", 2, 3, 1], ["2031-04", 1, 2, 1], ["2031-05", 1, 1, 0]], "個人件数 (自動) = 個人のお客様の案件 − リピート (3 月 3 − 1・4 月 2 − 1・5 月 1)");
  eq(d.sites.parts.map((x) => [x.month, x.value, x.source]), [["2031-03", 5, "cases"], ["2031-04", 2, "cases"], ["2031-05", 1, "cases"]], "全案件数 = 案件の件数 (リピート・業者も 1 件ずつ。売上の件数と同じ)");
  eq([B.denomRepeats(d.individual), d.individual.value, d.sites.value], [2, 4, 8], "期間の合計: 個人件数 4 (リピート 2 件を除く)・全案件数 8");
  // 日数の設定
  db.settings.push({ id: "kpi_basis", value: { repeatDays: 15 } });
  eq(B.kpiDenominators(db, P("2031-03-01", "2031-05-31"), "koshi").individual.value, 6, "15 日にすると a2 (19 日)・a4 (25 日) はリピートではない (6)");
  db.settings[0].value.repeatDays = 0;
  eq(B.kpiDenominators(db, P("2031-03-01", "2031-05-31"), "koshi").individual.value, 6, "0 日 = まとめない");
  db.settings[0].value.repeatDays = 19;
  eq(B.kpiDenominators(db, P("2031-03-01", "2031-03-31"), "koshi").individual.value, 2, "ちょうど 19 日目もリピート (以内)");
  // 別の店舗のリピートはまとめない (別の店舗で施工したときはそれぞれはがきを渡す。お客様のご指示 2026-11-24)・30 日の境目
  db = mk();
  db.orders.push(
    sys("a5", "c_a", "2031-03-05", { storeId: "chuo" }), // A の合志の 3/1 から 4 日後でも中央店では 1 件目
    sys("a6", "c_a", "2031-03-15", { storeId: "chuo" }), // 中央店の 3/5 から 10 日後 = 中央店のリピート
    sys("b3", "c_b", "2031-05-31"), // 合志の B 5/1 から ちょうど 30 日後 = リピート
    sys("b4", "c_b", "2031-07-01"), // 5/1 から 61 日後 = リピートではない
  );
  const u3 = B.caseUnits(db.orders, 30);
  const rep3 = (id) => u3.find((u) => u.orderId === id).repeat;
  eq([rep3("a5"), rep3("a6"), rep3("b3"), rep3("b4")], [false, true, true, false], "同じお客様でも別の店舗の案件はリピートにしない (店舗ごとに 1 件目)・ちょうど 30 日はリピート");
  eq(B.caseUnits(db.orders, 30).filter((u) => u.repeat).map((u) => u.orderId).sort(), ["a2", "a4", "a6", "b3", "c2"], "リピートの一覧 (合志の a2・a4・b3、中央の a6)");
  d = B.kpiDenominators(db, P("2031-03-01", "2031-03-31"), "chuo");
  eq([d.individual.value, d.individual.parts[0].raw, d.individual.parts[0].repeats], [1, 2, 1], "中央店の 3 月: A の 2 件 → 1 件 (合志のはがきとは別)");
  db.orders.push(sys("b5", "c_b", "2031-08-01"), sys("b6", "c_b", "2031-08-31"), sys("b7", "c_b", "2031-10-01"));
  const u4 = B.caseUnits(db.orders, 30);
  eq(["b6", "b7"].map((id) => u4.find((u) => u.orderId === id).repeat), [true, false], "8/1 → 8/31 (30 日) はリピート・8/1 → 10/1 は別");
  // 年間チラシ計画の値 (手計算で調整済み) がある月はその値。いつも自動 の設定では取込の値は使わず、手入力は使う
  db = mk();
  db.settings.push({ id: "kpi_basis", value: { months: { "koshi|2031-03": { individual: 10, individualSrc: "import" }, "koshi|2031-04": { individual: 7, individualSrc: "manual" } } } });
  d = B.kpiDenominators(db, P("2031-03-01", "2031-05-31"), "koshi");
  eq(d.individual.parts.map((x) => [x.value, x.source]), [[10, "import"], [7, "manual"], [1, "auto"]], "既定 (年間チラシ計画): 取込・手入力の月はその値、ない月は自動");
  db.settings[0].value.individualSource = "auto";
  d = B.kpiDenominators(db, P("2031-03-01", "2031-05-31"), "koshi");
  eq(d.individual.parts.map((x) => [x.value, x.source]), [[2, "auto"], [7, "manual"], [1, "auto"]], "いつも自動: 取込の値は使わず自動、手入力した月は手入力");
  // 返信率もこの分母
  db = mk();
  db.surveys = [card("z1", { postcardNo: "9", countMonth: "2031-03", salesName: "試験", salesUserId: "u_a", craftsmanName: "見本", craftsmanUserId: "u_b", phoneScore: 5 })];
  const k = K.storeKpi(db, P("2031-03-01", "2031-03-31"), "koshi");
  eq([k.surveys, k.individualOrders, k.replyRate], [1, 2, 50], "返信率 = はがき 1 ÷ 個人件数 2 (3 月の個人 3 件 − リピート 1)");
  // 全案件数の数え方: 作業日報の納品件数 (予定表の納品の予定)・期間内の受注
  db = mk();
  db.schedule = [
    { id: "e1", kind: "delivery", storeId: "koshi", date: "2031-03-02", title: "納品" },
    { id: "e2", kind: "delivery", storeId: "koshi", date: "2031-03-03", title: "納品" },
    { id: "e3", kind: "delivery", storeId: "koshi", date: "2031-03-03", title: "手直しの納品" },
    { id: "e4", kind: "pickup", storeId: "koshi", date: "2031-03-03", title: "引き取り" },
    { id: "e5", kind: "delivery", storeId: "chuo", date: "2031-03-03", title: "納品" },
  ];
  db.settings.push({ id: "kpi_basis", value: { casesSource: "deliveries" } });
  d = B.kpiDenominators(db, P("2031-03-01", "2031-03-31"), "koshi");
  eq([d.sites.value, d.sites.parts[0].source], [3, "deliveries"], "作業日報の納品件数: 予定表の納品の予定 (引き取り・ほかの店舗は数えない)");
  db.settings[0].value.casesSource = "system";
  eq(B.kpiDenominators(db, P("2031-03-01", "2031-03-31"), "koshi").sites.value, 6, "期間内の受注: 未完了の受注も契約日で数える (従来の動き。a1・a2・b1・c1・c2・d1。キャンセルは除く)");
  db.settings[0].value.casesSource = "cases";
  db.settings[0].value.months = { "koshi|2031-03": { sites: 40 } };
  eq(B.kpiDenominators(db, P("2031-03-01", "2031-03-31"), "koshi").sites.parts[0].source, "manual", "手入力の全案件数はどの数え方でも優先");
  const mf = B.monthFacts(db, P("2031-03-01", "2031-03-31"), undefined, {});
  eq([mf.get("koshi|2031-03").cases, mf.get("koshi|2031-03").deliveries, mf.get("chuo|2031-03").deliveries], [5, 3, 1], "分母・照合の表の材料 (案件・納品)");
  // 売上台帳の取込の最後の日までの新システムの受注は台帳の行で数える (二重にしない)
  db = mk();
  db.orders.push(ledgerOrder("L1", "koshi", "2031-03-15", [30]));
  const u2 = B.caseUnits(db.orders, 30);
  eq(u2.filter((u) => u.origin === "system").map((u) => u.orderId).sort(), ["a2", "a3", "a4", "b2"], "台帳の最後の日 (3/15) までの新システムの受注は数えない (3/20 以降は数える)");
  // 受注を完了にすると (書き換え) すぐ数える
  db = mk();
  B.caseUnits(db.orders, 30);
  db.orders.find((o) => o.id === "d1").salesDate = "2031-03-12";
  db.orders.find((o) => o.id === "d1").status = "completed";
  ok(B.caseUnits(db.orders, 30).some((u) => u.orderId === "d1"), "受注を書き換えても案件の一覧を作り直す (件数だけで判定しない)");

  // クレーム・手直しのポイント: 同じ案件は最大 3 点
  const qi = (id, kind, points, o = {}) => ({ id, number: id, storeId: "koshi", kind, points, occurredOn: "2031-03-10", attribution: "store", counted: true, responsibleUserIds: ["u_a"], status: "open", description: "", reportedBy: "u_b", createdAt: at, updatedAt: at, ...o });
  const issues = [
    qi("q1", "claim", 2, { orderId: "a1" }), qi("q2", "rework", 1, { orderId: "a1" }), qi("q3", "rework", 1, { orderId: "a1" }),
    qi("q4", "claim_rework", 3, { orderId: "b1" }),
    qi("q5", "claim", 2, { siteName: "（滑石）坂西邸" }), qi("q6", "claim", 2, { siteName: "（滑石） 坂西邸" }),
    qi("q7", "rework", 1, { siteName: "（滑石）坂西邸", occurredOn: "2031-04-02" }),
    qi("q8", "rework", 1),
    qi("q9", "claim", 2, { orderId: "b2", counted: false }),
  ];
  const ip = KC.issuePoints(issues.filter(KC.countedIssue), 3);
  eq([ip.raw, ip.points, ip.cappedCases], [13, 11, 2], "a1 = 2 + 1 + 1 → 3・b1 = 3・坂西邸 3 月 = 2 + 2 (現場名の空白の違いは同じ) → 3・坂西邸 4 月 = 1・現場名なし = 1 (合計 11 / 上限の前 13。記録のみは数えない)");
  eq(KC.issuePoints(issues.filter(KC.countedIssue), 0).points, 13, "上限 0 = 上限なし");
  // 月締め: 同じ案件でも別の月の別の手直しはそれぞれ数える (KPI シートの手計算: 4 月のクレーム＋手直し 3 点 + 5 月の手直し 1 点 = 4 点)
  const monthly = [qi("m1", "claim_rework", 3, { orderId: "a3", occurredOn: "2031-04-01" }), qi("m2", "rework", 1, { orderId: "a3", occurredOn: "2031-05-01" }), qi("m3", "rework", 1, { orderId: "a3", occurredOn: "2031-05-20" })];
  eq(KC.issuePoints(monthly.slice(0, 2), 3).points, 4, "別の月 (4 月 3 点 + 5 月 1 点) は上限をまたがない = 4 点");
  eq(KC.issuePoints([monthly[0], qi("m4", "rework", 1, { orderId: "a3", occurredOn: "2031-04-20" })], 3).points, 3, "同じ月の クレーム＋手直し 3 点 + 手直し 1 点 = 3 点 (上限)");
  eq([KC.issuePoints(monthly, 3).points, KC.issueCounts(monthly).cases], [5, 1], "5 月の手直し 2 件 = 2 点 (上限の 3 点以内)・発生した案件は 1 件 (月をまたいでも同じ案件)");
  eq(KC.issueCounts(issues.filter(KC.countedIssue)), { claims: 4, reworks: 5, total: 9, cases: 5 }, "経営管理の指標: クレーム 4 (q1・q4・q5・q6)・手直し 5 (q2・q3・q4・q7・q8)・合計 9・発生した案件 5");
  db = mk();
  db.qualityIssues = issues;
  const sk = K.storeKpi(db, P("2031-03-01", "2031-04-30"), "koshi");
  eq([sk.qualityPoints, sk.qualityPointsRaw, sk.orders, sk.issues.claims, sk.issues.reworks], [11, 13, 7, 4, 5], "storeKpi: ポイントは上限のあと (11)・全案件数 7 (3 月 5 + 4 月 2)");
  near(sk.qualityRate, (11 / 7) * 100, "ポイント率 = 11 ÷ 7");
  near(sk.issueRates.claims, (4 / 7) * 100, "クレーム率 = 4 ÷ 7");
  near(sk.issueRates.total, (9 / 7) * 100, "合計の率 = 9 ÷ 7");
  const ks = KS.kpiSettings(db);
  eq(ks.qualityCaseMax, 3, "設定の既定は 3 点");
  const inc = I.computeIncentives(db, P("2031-03-01", "2031-04-30"), ks);
  const ku = inc.units.find((u) => u.unit === "koshi");
  eq([ku.qualityPoints, ku.qualityPointsRaw, ku.issues.total], [11, 13, 9], "インセンティブの店舗のポイントも同じ上限");
  ok(/同じ案件の上限 3 点で 13 点から/.test(inc.people.find((x) => x.userId === "u_a").lines.find((l) => l.key === "quality").note ?? ""), "支給の内訳に上限で減った点数を出す");
  const st = K.staffKpis(db, P("2031-03-01", "2031-04-30")).find((r) => r.userId === "u_a");
  eq([st.qualityPoints, st.qualityCount], [11, 8], "社員別のポイントも案件ごとに上限");
  db.settings.push({ id: "kpi", value: { qualityCaseMax: 0 } });
  eq(K.storeKpi(db, P("2031-03-01", "2031-04-30"), "koshi").qualityPoints, 13, "設定で上限なしにできる");

  // LINE の報告の文から区分の候補
  eq([KS.guessQualityKind("合志 田中様 クレームの連絡あり").kind, KS.guessQualityKind("襖の手直しに伺います").kind, KS.guessQualityKind("お客様からクレーム。畳の張り直しが必要").kind, KS.guessQualityKind("明日の予定の確認").kind], ["claim", "rework", "claim_rework", undefined], "区分の候補 (クレーム / 手直し / 両方 / なし)");
  eq([KS.guessQualityKind("点検DMを見て電話。襖の動きが硬い").recordOnly, KS.guessQualityKind("クレームではないが念のため").kind], [true, undefined], "点検 DM は記録のみの候補・「クレームではない」はクレームにしない");

  // 集計表 (店舗の列 = シートの合計の表)
  const db2 = base();
  const cards2 = B.kpiCards(db2.surveys, null, B.kpiBasis(db2));
  const ts = TL.surveyTallyByStore(cards2, [{ id: "koshi", label: "合志" }, { id: "chuo", label: "中央" }]);
  eq([ts.axis, ts.columns.map((c) => c.label), ts.cards, ts.totalCards], ["store", ["合志", "中央"], [3, 0], 3], "店舗の列: 店舗ごとの枚数");
  eq(ts.sections.map((x) => x.no), ["①", "②", "③", "④", "⑤", "⑥", "⑦"], "①〜⑦ の設問");
  eq(ts.sections.find((x) => x.no === "⑦").rows.map((r) => [r.answer, r.byCol[0]]), [["はい", 2], ["わからない", 1], ["いいえ", 0]], "⑦ 次回も依頼したいか");
  const csvRows = TL.tallyCsvRows(ts, [{ label: "返信率", values: ["50.0%", "-"], total: "50.0%" }]);
  eq([csvRows[0], csvRows[1], csvRows[2]], [["設問", "回答", "合志", "中央", "合計", "割合"], ["回答数 (はがき)", "", 3, 0, 3, ""], ["返信率", "", "50.0%", "-", "50.0%", ""]], "CSV の見出し・枚数・返信率の行");

  // 販促 KPI (経営分析用。個人件数はリピートも 1 件ずつ)
  const PA = await imp("lib/ops-reports/promo-analysis.ts");
  db = { ...mk(), inquiries: [], quotes: [], promotions: [], workReportDays: [], users: structuredClone(users).concat([{ id: "u_adm", name: "管理", storeId: "hq", role: "admin", active: true, email: "z@example.test" }]) };
  const rep = PA.promoReport(db, db.users.find((u) => u.id === "u_adm"), { from: "2031-03-01", to: "2031-03-31", store: "koshi" });
  const pk = rep.kpi.find((x) => x.storeId === "koshi");
  eq([pk.cases, pk.individualCases, pk.individualSales, pk.unitPrice], [5, 3, 30000, 10000], "販促 KPI: 個人件数 3 (リピートの a2 も 1 件)・個人の売上・客単価 (返信率の分母 2 とは別)");
  ok(PA.promoCsvRows(rep, "kpi", (id) => id)[0][0] === "店舗", "販促 KPI の CSV");
}

/* ================================================================== */
section("3. はがきの数え方・平均・②③ の行");
{
  const db = base();
  const rules = B.kpiBasis(db);
  const p = { from: "2030-12-01", to: "2031-11-30" };
  const cards = B.kpiCards(db.surveys, p, rules);
  eq(cards.map((s) => s.id), ["s1", "s2", "s5"], "数えるはがき: ハガキ№ のある行・写真の登録 (2 人目の担当の行・担当の名前がないはがきは除く)");
  eq([B.unnamedCard(db.surveys[3], rules), B.staffNamed(db.surveys[0])], [true, true], "担当の名前がないはがき");
  eq(B.kpiCards(db.surveys, p, { requireStaffNames: false }).length, 4, "設定で「数える」にすると担当の名前がなくても数える");
  const sheet = B.scoreAverage([5, undefined, 4], "sheet");
  const ans = B.scoreAverage([5, undefined, 4], "answered");
  eq([sheet.avg, sheet.n, sheet.blank, ans.avg, ans.n], [3, 3, 1, 4.5, 2], "平均: シート = 合計 ÷ 枚数 (空欄 0 点) / 回答した数で割る");
  const ps = B.personScores(db.surveys, p, rules);
  eq([ps.get("u_a").sales.sum, ps.get("u_a").sales.n], [12, 3], "② 営業担当の行 (s1・s2・s5)");
  eq([ps.get("u_b").craft.sum, ps.get("u_b").craft.n], [13, 3], "③ 担当職人の行 (s1・s2・s5。担当の名前のない s4 は除く)");
  eq([ps.get("u_c").craft.sum, ps.get("u_c").craft.n, ps.get("u_c").sales.n], [5, 1, 0], "2 人目の職人の行は ③ に入る (営業担当のない行は ② に入らない)");
}

/* ================================================================== */
section("4. storeKpi と年間インセンティブ (同じ分母・平均)");
{
  const db = base();
  db.settings.push({ id: "kpi_basis", value: { months: { "koshi|2031-01": { individual: 4, individualSrc: "import" }, "koshi|2031-02": { individual: 2, individualSrc: "import" } } }, updatedAt: at });
  const p = { from: "2030-12-01", to: "2031-11-30" };
  const k = K.storeKpi(db, p, "koshi");
  eq([k.surveys, k.individualOrders, k.orders, k.unnamedCards], [3, 6, 4, 1], "合志: はがき 3 枚・個人件数 6・施工件数 4・数えないはがき 1");
  near(k.replyRate, 50, "返信率 = 3 ÷ 6");
  near(k.qualityRate, 75, "ポイント率 = 3 点 ÷ 施工件数 4");
  near(k.scores.phoneScore, 3, "① の平均 = (5 + 0 + 4) ÷ 3 枚 (空欄は 0 点)");
  eq(k.scoreCounts.phoneScore, 3, "① の分母は枚数");
  const s = KS.kpiSettings(db);
  s.clerkUserIds = ["u_d"];
  const r = I.computeIncentives(db, p, s);
  const u = r.units.find((x) => x.unit === "koshi");
  eq([u.cards, u.individual, u.orders, u.qualityPoints], [k.surveys, k.individualOrders, k.orders, k.qualityPoints], "インセンティブの店舗の値は KPI の画面と同じ");
  near(r.companyPhoneAvg, 3, "① 全社の平均 (シートの基準)");
  // 平均の計算で支給額が変わる例: 回答した枚数で割ると 4.5 → 4.4 以上の金額
  const phoneSheet = r.people.find((x) => x.userId === "u_d").lines.find((l) => l.key === "phone").yen;
  db.settings[0].value.average = "answered";
  const r2 = I.computeIncentives(db, p, s);
  const phoneAns = r2.people.find((x) => x.userId === "u_d").lines.find((l) => l.key === "phone").yen;
  near(r2.companyPhoneAvg, 4.5, "回答した枚数で割ると ① は 4.5");
  ok(phoneSheet === 0 && phoneAns === 30000, `① の支給額が平均の計算で変わる (シート ${phoneSheet} 円 / 回答した数 ${phoneAns} 円)`);
  const qline = r.people.find((x) => x.userId === "u_a").lines.find((l) => l.key === "quality");
  ok(/全案件数 4 件/.test(qline.note ?? ""), "ポイント率の内訳に全案件数を出す");
}

/* ================================================================== */
section("5. 年間チラシ計画・アンケートハガキ（回答）の読み取りと取込");
const flyerRows = (() => {
  const rows = Array.from({ length: 45 }, () => Array(25).fill(""));
  rows[2][2] = "個人売上目標・実績（2030年度）※網戸祭り除く";
  rows[4][3] = "合志  （目標客単価：100,000円　前年：90,000円";
  rows[4][14] = "玉名（目標客単価：100,000円　前年：90,000円）";
  rows[5][7] = "本年度実績";
  rows[5][20] = "本年度実績";
  const months = [7, 8, 9, 10, 11, 12, 1, 2, 3, 4, 5, 6];
  months.forEach((m, i) => {
    rows[7 + i][2] = `${m}月`;
    rows[7 + i][7] = i < 8 ? String(10 + i) : "";
    rows[7 + i][20] = i < 7 ? String(20 + i) : "";
  });
  rows[19][2] = "累計";
  rows[19][7] = "999";
  rows[22][3] = "西（目標客単価：90,000円　前年：80,000円）";
  rows[23][7] = "本年度実績";
  months.forEach((m, i) => {
    rows[25 + i][2] = `${m}月`;
    rows[25 + i][7] = i === 0 ? "5" : "";
  });
  rows[37][2] = "累計";
  return rows;
})();
const formRows = [
  ["タイムスタンプ", "", "月", "店舗", "電話対応", "営業担当者", "営業対応", "担当職人", "職人対応", "工事の仕上り", "利用にあたり重視したこと", "情報媒体", "次回も依頼したいか", "年"],
  ["2/3/2031 10:00:00", "101", "１月", "合志", "5", "試験", "5", "見本", "4", "5", "", "", "はい", "2031年"],
  ["2/3/2031 10:01:00", "102.0", "１月", "合志", "", "試験", "3", "見本", "4", "4", "", "", "はい", ""],
  ["", "", "１月", "", "", "", "", "仮名", "5", "", "", "", "", ""],
  ["1/5/2031 9:00:00", "88", "１２月", "合志", "4", "試験", "4", "見本", "4", "4", "", "", "はい", ""],
];
{
  const ind = BI.parseIndividualSheet(flyerRows);
  eq(ind.problems, [], "個人件数売上: 問題なし");
  const koshi = ind.values.filter((v) => v.storeId === "koshi");
  eq([koshi.length, koshi[0].month, koshi[0].value, koshi.at(-1).month, koshi.at(-1).value], [8, "2030-07", 10, "2031-02", 17], "合志: 7 月〜2 月の 8 か月 (年度 = 7 月〜翌 6 月。空欄・累計は読まない)");
  eq(ind.values.filter((v) => v.storeId === "tamana").map((v) => v.month).at(-1), "2031-01", "右の表 (玉名) も読む");
  eq(ind.values.filter((v) => v.storeId === "nishi").map((v) => [v.month, v.value]), [["2030-07", 5]], "下の表 (西) も読む");
  eq(BI.detectBasisSheet(flyerRows), "individual", "中身で見分ける (個人件数売上)");
  const cm = BI.parseCardMonthSheet(formRows);
  eq(BI.detectBasisSheet(formRows), "cardMonths", "中身で見分ける (フォームの回答)");
  eq(cm.rows.map((r) => [r.row, r.month, r.postcardNo ?? "-"]), [[2, "2031-01", "101"], [3, "2031-01", "102"], [4, "2031-01", "-"], [5, "2030-12", "88"]], "集計月 (年が空欄 → 入力日。12 月分を 1 月に入力 → 前年)・№ の「.0」を除く・書き足した行は上の行の年");
  ok(cm.rows[2].attached?.craftsmanName === "仮名" && cm.rows[2].attached.craftsmanScore === 5 && cm.rows[2].attached.at === cm.rows[1].at, "書き足した行の内容と、上の行の入力日時");
  eq(BI.parseStamp("46000.5")?.slice(0, 10), "2025-12-09", ".xlsx の日付の数値");

  const db = base();
  // 移行したはがき (sourceRef の行番号で照合する。登録日時が 9 時間ずれていても同じ行)
  db.surveys = [
    { id: "m1", receivedAt: "2031-02-03T10:00:00.000Z", postcardNo: "101", storeId: "koshi", source: "import", salesName: "試験", salesUserId: "u_a", craftsmanName: "見本", craftsmanUserId: "u_b", sourceRef: "08_事務/アンケートハガキ（回答）.xlsx#フォームの回答 1!2" },
    { id: "m2", receivedAt: "2031-02-03T01:01:00.000Z", postcardNo: "102", storeId: "koshi", source: "import", salesName: "試験", salesUserId: "u_a", craftsmanName: "見本", craftsmanUserId: "u_b", sourceRef: "08_事務/アンケートハガキ（回答）.xlsx#フォームの回答 1!3" },
    { id: "m3", receivedAt: "2031-01-05T00:00:00.000Z", postcardNo: "999", storeId: "koshi", source: "import", sourceRef: "08_事務/アンケートハガキ（回答）.xlsx#フォームの回答 1!5" },
    { id: "m4", receivedAt: at, postcardNo: "7", storeId: "chuo", source: "import", craftsmanName: "仮名", craftsmanUserId: "u_c", sourceRef: "08_事務/アンケートハガキ（回答）.xlsx#フォームの回答 1!40" },
  ];
  db.settings.push({ id: "kpi_basis", value: { months: { "koshi|2030-08": { individual: 50, individualSrc: "manual" }, "koshi|2030-07": { individual: 3, individualSrc: "import" } } }, updatedAt: at });
  const read = BI.readBasisSheets([{ name: "個人件数売上", rows: flyerRows, source: "t" }, { name: "フォームの回答 1", rows: formRows, source: "t" }]);
  const plan = BI.planBasisImport(db, read);
  eq([plan.counts.individual.create, plan.counts.individual.update, plan.counts.individual.manual], [14, 1, 1], "個人件数: 新規 14・更新 1 (取込の値)・手入力は取り込まない 1");
  eq([plan.cards.changes.length, plan.cards.mismatch, plan.cards.adds.length, plan.cards.unresolved], [2, 1, 1, 0], "集計月: 2 行 (行の番号は合うが № が違う 1 行は書かない)・書き足した行を 1 行追加");
  eq(plan.cards.adds[0].craftsmanUserId, "u_c", "書き足した行の職人は、移行のときの名前の対応で社員にする");
  const r1 = BI.applyBasisImport(db, { ...read, label: "テスト" }, { userId: "u_d", now: at });
  B.writeKpiBasis(db, r1.basis, "u_d", at);
  const b = B.kpiBasis(db);
  eq([b.months["koshi|2030-08"].individual, b.months["koshi|2030-08"].individualSrc, b.months["koshi|2030-07"].individual], [50, "manual", 10], "手入力の値は残し、取込の値は更新");
  eq([db.surveys.find((s) => s.id === "m1").countMonth, db.surveys.find((s) => s.id === "m3").countMonth], ["2031-01", undefined], "集計月を入れる (行が合わないはがきは変えない)");
  const added = db.surveys.find((s) => s.sourceRef?.endsWith("!4"));
  ok(added && added.countMonth === "2031-01" && added.craftsmanUserId === "u_c" && !KC.isCard(added), "書き足した行を ②③ の評価の行として足す (はがきの枚数には入らない)");
  const n = db.surveys.length;
  const r2 = BI.applyBasisImport(db, { ...read, label: "テスト" }, { userId: "u_d", now: at });
  eq([r2.result.individual, r2.result.cardMonths, r2.result.added, db.surveys.length], [0, 0, 0, n], "2 回取り込んでも変わらない");
}
{
  // 移行 (10/16 の写し) のあとにフォームに入力したはがき → 新しいはがきとして登録 (2026-11-24 お客様のご依頼「共有のスプレッドシートで取込」)
  const db = base();
  db.surveys = [
    { id: "m1", receivedAt: "2031-02-03T10:00:00.000Z", postcardNo: "101", storeId: "koshi", source: "import", salesName: "試験", salesUserId: "u_a", craftsmanName: "見本", craftsmanUserId: "u_b", sourceRef: "08_事務/アンケートハガキ（回答）.xlsx#フォームの回答 1!2" },
    { id: "m2", receivedAt: "2031-02-03T01:01:00.000Z", postcardNo: "102", storeId: "koshi", source: "import", salesName: "試験", salesUserId: "u_a", craftsmanName: "見本", craftsmanUserId: "u_b", sourceRef: "08_事務/アンケートハガキ（回答）.xlsx#フォームの回答 1!3" },
    // 試験期間に写真で登録したはがき (同じ № はシートから登録しない)
    { id: "cap1", receivedAt: "2031-11-21T00:00:00.000Z", postcardNo: "204", storeId: "koshi", source: "capture", salesUserId: "u_a", deliveryUserIds: ["u_b"] },
  ];
  db.orders.push({ id: "o_pc", number: "O-PC", storeId: "nishi", customerId: "c_i", status: "paid", source: "import", contractDate: "2031-11-10", salesDate: "2031-11-10", total: 1000, workerIds: [], postcardNo: "201", progressNotes: [] });
  const rows = [
    ...formRows.slice(0, 3),
    ["11/20/2031 10:00:00", "201", "１１月", "西", "5", "試験", "4", "見本", "5", "5", "価格, 対応", "R, チラシ", "はい", "2031年"],
    ["11/21/2031 9:00:00", "102", "１１月", "合志", "5", "試験", "5", "見本", "5", "5", "", "", "はい", "2031年"],
    ["11/22/2031 9:00:00", "202", "", "玉名", "4", "未登録の人", "4", "見本", "4", "4", "", "", "わからない", ""],
    ["11/23/2031 9:00:00", "203", "１１月", "合志", "3", "仮名", "3", "見本", "3", "3", "", "", "いいえ", ""],
    ["11/24/2031 9:00:00", "204", "１１月", "合志", "5", "試験", "5", "見本", "5", "5", "", "", "はい", ""],
  ];
  const read = BI.readBasisSheets([{ name: "フォームの回答 1", rows, source: "t" }]);
  const plan = BI.planBasisImport(db, read);
  const nc = plan.cards.newCards;
  eq(nc.map((c) => [c.row, c.month, c.postcardNo, c.store]), [[4, "2031-11", "201", "nishi"], [6, "", "202", "tamana"], [7, "2031-11", "203", "koshi"]], "新しいはがき: システムにない行 (集計月・№・店舗。「月」が空欄の行も 1 枚)");
  eq([plan.cards.registered, plan.cards.mismatch], [2, 0], "同じ № がシステムにある行は登録しない (204 = 写真で登録済み・102 = 同じはがきの二重の入力)");
  eq([nc[0].salesUserId, nc[0].craftsmanUserId, nc[0].orderId, nc[0].customerId], ["u_a", "u_b", "o_pc", "c_i"], "担当者は移行の名前の対応・案件は売上台帳のハガキ欄の番号");
  eq([nc[2].salesUserId, nc[1].salesUserId, nc[1].unresolvedNames], ["u_c", undefined, ["未登録の人"]], "移行にない名前は社員の名前で決める (決まらない名前は文字のまま)");
  const r1 = BI.applyBasisImport(db, { ...read, label: "テスト" }, { userId: "u_d", now: at });
  const added = db.surveys.filter((x) => x.sourceRef?.match(/!(4|6|7)$/));
  eq(r1.result.newCards, 3, "3 枚を登録");
  const s4 = added.find((x) => x.sourceRef.endsWith("!4"));
  eq([s4.postcardNo, s4.storeId, s4.countMonth, s4.phoneScore, s4.salesScore, s4.craftsmanScore, s4.finishScore, s4.priorities, s4.media, s4.wouldUseAgain, s4.receivedAt.slice(0, 10), KC.isCard(s4)], ["201", "nishi", "2031-11", 5, 4, 5, 5, "価格, 対応", "R, チラシ", "はい", "2031-11-20", true], "登録したはがきの内容 (移行と同じ列・はがき 1 枚)");
  eq([added.find((x) => x.sourceRef.endsWith("!6")).countMonth, added.find((x) => x.sourceRef.endsWith("!6")).salesName], [undefined, "未登録の人"], "「月」が空欄 = 集計月なし (入力日の月)・担当の名前は文字のまま");
  ok(/新しいはがき 3 枚/.test(r1.result.summary) && /登録済みのため取り込まない 2 枚/.test(r1.result.summary), `取込の結果の文 (${r1.result.summary})`);
  const k = K.storeKpi(db, { from: "2031-11-01", to: "2031-11-30" }, "nishi");
  eq(k.surveys, 1, "新しいはがきは KPI の返信の枚数に入る");
  const n = db.surveys.length;
  const r2 = BI.applyBasisImport(db, { ...read, label: "テスト" }, { userId: "u_d", now: at });
  eq([r2.result.newCards, db.surveys.length], [0, n], "2 回取り込んでも二重にしない (行で照合)");
}

/* ================================================================== */
section("6. KPI のタブとの照合");
{
  const db = base();
  db.settings.push({ id: "kpi_basis", value: { months: { "koshi|2031-01": { individual: 4, individualSrc: "import" }, "koshi|2031-02": { individual: 2, individualSrc: "import" } } }, updatedAt: at });
  const head = ["", "項目", "対象", "累計", "12月", "1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月"];
  const blank = Array(12).fill("");
  const rows = [
    ["", "2031年", "集計期間：前年12/1～11/30"],
    head,
    ["", "ハガキ返信率", "合志", "50.0%", ...blank],
    ["", "電話対応", "事務", "3.00", ...blank],
    ["", "営業対応（見積り）", "試験", "4.00", ...blank],
    ["", "職人対応", "見本", "4.33", ...blank],
    ["", "工事仕上り", "合志", "4.67", ...blank],
    ["クレーム", "合志", "件数", "1", "0", "1", "0", ...Array(9).fill("0")],
    ["", "", "ポイント", "2", "0", "2", "0", ...Array(9).fill("0")],
    ["", "手直し件数（＝ポイント）", "合志", "1", "0", "0", "1", ...Array(9).fill("")],
    ["", "クレーム・手直しポイント率", "合志", "75.00%", ...blank],
    [...Array(28).fill(""), "クレーム手直しポイント率", "クレーム手直しポイント合計", "分母"],
    [...Array(28).fill(""), "合志", "3", "4", "75.00%"],
    [...Array(28).fill(""), "事務", "0", "5", "0.00%"],
  ];
  const years = KSH.parseKpiTab({ title: "KPI", rows, source: "t" }).years;
  eq(years[0].totals.filter((t) => t.metric === "qpoints" || t.metric === "sites").map((t) => [t.metric, t.target, t.value]), [["qpoints", "合志", 3], ["sites", "合志", 4], ["qpoints", "事務", 0], ["sites", "事務", 5]], "右側のポイント合計・分母の表を読む");
  eq(KSH.lastFilledMonth(years[0]), "2031-02", "手直しに値のある最後の月 (年度の途中のシート)");
  const match = ST.staffMatcher(db.users, {});
  const y = KSH.reconcileKpi(db, years, match)[0];
  eq([y.period.to, y.compared.to], ["2031-11-30", "2031-02-28"], "年度の期間と、比べた期間 (値のある月まで)");
  const row = (metric, target) => y.rows.find((r) => r.metric === metric && (!target || r.target === target));
  eq([row("reply").ok, row("reply").system, row("reply").detail?.startsWith("3 枚 ÷ 個人件数 6")], [true, 50, true], "返信率が一致 (内訳: 枚数 ÷ 個人件数)");
  eq([row("phone").ok, row("sales").ok, row("craft").ok, row("finish").ok], [true, true, true, true], "① ② ③ ④ が一致 (空欄は 0 点)");
  eq([row("qrate").ok, row("qpoints", "合志").ok, row("sites", "合志").ok, row("sites", "事務").ok], [true, true, true, true], "ポイント率・ポイント合計・全案件数 (事務は 4 店舗の合計 = 合志 4 + 中央 1) が一致");
  ok(y.differ === 0, `差なし (差 ${y.differ} 件)`);
}

/* ================================================================== */
section("7. ⑤〜⑦ の読み替え・集計表");
{
  eq(SV.tallyAnswers("R, チラシ", SV.MEDIA_OPTIONS).options, ["以前頼んだことがある", "チラシ"], "「R」= 以前頼んだことがある");
  eq(SV.tallyAnswers("DM, Googleマップ, HP", SV.MEDIA_OPTIONS).options, ["ダイレクトメール", "グーグルマップ", "ホームページ"], "DM・Googleマップ・HP を読み替え");
  const t = SV.tallyAnswers("CM, 近所の人が使っていた", SV.MEDIA_OPTIONS);
  eq([t.options, t.others], [["CM", "その他"], ["近所の人が使っていた"]], "自由記述は「その他」に数え、内容は残す");
  eq(SV.splitAnswers("R, 近所", SV.MEDIA_OPTIONS), ["以前頼んだことがある", "近所"], "入力の画面の読み替え (自由記述はそのまま)");
  const db = base();
  const cards = B.kpiCards(db.surveys, null, B.kpiBasis(db));
  const c = K.answerCounts(cards);
  eq(c.media.find(([o]) => o === "以前頼んだことがある")?.[1], 2, "⑥ 以前頼んだことがある (R + 選択)");
  eq([c.again.yes, c.again.unknown, c.again.no, c.respondents.again], [2, 1, 0, 3], "⑦ はい・わからない・いいえ");
  const tally = TL.surveyTally(cards, ["2031-01", "2031-02"]);
  eq([tally.cards, tally.totalCards], [[2, 1], 3], "集計表: 月ごとの枚数 (集計月)");
  const sec = tally.sections.find((s) => s.no === "⑥");
  const rep = sec.rows.find((r) => r.answer === "以前頼んだことがある");
  eq([rep.byCol, rep.total, sec.respondents], [[1, 1], 2, 3], "⑥ の行 (月ごと・合計・回答した枚数)");
  near(rep.share, 2 / 3, "割合 = 合計 ÷ 回答した枚数");
  eq(tally.sections.find((s) => s.no === "①").rows.map((r) => r.total), [0, 0, 0, 1, 1], "① の分布 (大変不満〜大変満足。空欄は数えない)");
  eq([FL.fieldLabel("kpi_basis", "individual.koshi.2031-01"), FL.fieldLabel("survey", "countMonth")], ["個人件数 (合志・2031年1月)", "集計月 (KPI)"], "変更履歴の項目名");
}

/* ================================================================== */
section("8. 画面の操作 (Server Action)");
{
  const store = await imp("lib/db/store.ts");
  await store.syncDb();
  const db = () => store.getDb();
  const actions = await imp("lib/actions/kpi-basis.ts");
  const admin = db().users.find((u) => u.role === "admin" && u.active);
  const hq = db().users.find((u) => u.role === "hq_staff" && u.active);
  const staff = db().users.find((u) => u.role === "store_staff" && u.active);
  async function act(user, fn) {
    globalThis.__testUser = user;
    try {
      await fn();
      return { msg: null, err: null };
    } catch (e) {
      if (e && typeof e.digest === "string" && e.digest.startsWith("NEXT_REDIRECT")) {
        const u = new URL(e.url, "http://test.local");
        return { path: u.pathname, search: u.search, msg: u.searchParams.get("msg"), err: u.searchParams.get("err") };
      }
      throw e;
    } finally {
      globalThis.__testUser = undefined;
    }
  }
  const form = (obj) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(obj)) if (v !== undefined) fd.set(k, v instanceof File ? v : String(v));
    return fd;
  };
  const rules = (o) => form({ denominator: "sheet", average: "sheet", requireStaffNames: "on", individualSource: "plan", repeatDays: "30", casesSource: "cases", ...o });
  let r = await act(hq, () => actions.saveKpiBasisRules(rules({ denominator: "system" })));
  ok(r.err && B.kpiBasis(db()).denominator === "sheet", "数え方の設定は管理者だけ (本部スタッフは断る)");
  r = await act(admin, () => actions.saveKpiBasisRules(rules({ average: "answered" })));
  ok(r.msg && B.kpiBasis(db()).average === "answered", "管理者は数え方を変えられる");
  r = await act(admin, () => actions.saveKpiBasisRules(rules({ average: "answered", individualSource: "auto", repeatDays: "15", casesSource: "deliveries" })));
  const kb = B.kpiBasis(db());
  ok(r.msg && kb.individualSource === "auto" && kb.repeatDays === 15 && kb.casesSource === "deliveries", "個人件数の決め方・リピートの日数・全案件数の数え方を保存できる");
  ok(db().auditLogs.some((l) => l.entity === "kpi_basis" && l.changes?.some((c) => c.field === "repeatDays" && c.before === 30 && c.after === 15)), "リピートの日数の変更も変更履歴に残る");
  r = await act(admin, () => actions.saveKpiBasisRules(rules({ repeatDays: "999" })));
  ok(r.err && /0〜120/.test(r.err), "リピートの日数は 0〜120 日 (それ以外は断る)");
  r = await act(admin, () => actions.saveKpiBasisRules(rules({ average: "answered" })));
  ok(r.msg && B.kpiBasis(db()).casesSource === "cases" && B.kpiBasis(db()).repeatDays === 30, "既定に戻せる");
  ok(db().auditLogs.some((l) => l.entity === "kpi_basis" && l.changes?.some((c) => c.field === "average")), "変更履歴に変更前・変更後");
  r = await act(staff, () => actions.saveKpiMonthValues(form({ fy: "2031", "ind_koshi_2031-01": "12" })));
  ok(r.err, "店舗スタッフは月の値を入れられない");
  r = await act(hq, () => actions.saveKpiMonthValues(form({ fy: "2031", "ind_koshi_2031-01": "12", "sites_koshi_2031-01": "30", "ind_chuo_2031-01": "" })));
  const v = B.kpiBasis(db()).months["koshi|2031-01"];
  ok(r.msg && v?.individual === 12 && v.individualSrc === "manual" && v.sites === 30, "本部スタッフは個人件数・全案件数を手入力できる (手入力の印)");
  r = await act(hq, () => actions.saveKpiMonthValues(form({ fy: "2031", "ind_koshi_2031-01": "x" })));
  ok(r.err && /数ではありません/.test(r.err), "数でない値は断る");
  r = await act(hq, () => actions.saveKpiMonthValues(form({ fy: "2031", "ind_koshi_2031-01": "", "sites_koshi_2031-01": "" })));
  ok(r.msg && !B.kpiBasis(db()).months["koshi|2031-01"], "空欄にすると値を消す (自動の値に戻る)");
  // 取込: 確認 → 取り込む
  const csv = (rows) => rows.map((x) => x.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : String(c))).join(",")).join("\n");
  const file = new File([csv(flyerRows)], "年間チラシ計画 - 個人件数売上.csv", { type: "text/csv" });
  r = await act(hq, () => actions.previewKpiBasisImport(form({ files: file })));
  const hash = new URLSearchParams(r.search).get("preview");
  ok(hash && /^[0-9a-f]{24}$/.test(hash), "読み取って確認する (まだ取り込まない)");
  r = await act(hq, () => actions.previewKpiBasisImport(form({ files: file })));
  ok(new URLSearchParams(r.search ?? "").get("preview") === hash, "同じファイルをもう一度読んでも確認できる (前の確認を置き換える)");
  ok(!B.kpiBasis(db()).months["koshi|2030-07"], "確認の時点では書き込まない");
  r = await act(hq, () => actions.applyKpiBasisImport(form({ hash })));
  ok(r.msg && B.kpiBasis(db()).months["koshi|2030-07"]?.individual === 10, `この内容で取り込む (${r.msg ?? r.err})`);
  ok(db().auditLogs.some((l) => l.entity === "kpi_basis" && l.action === "import"), "取込の変更履歴");
  r = await act(hq, () => actions.applyKpiBasisImport(form({ hash })));
  ok(r.err, "同じ確認を 2 回は取り込めない (確認の内容は取込で消える)");
  // 支給前の照合: KPI のタブを読み込む (2 回目は置き換え)
  const KCHK = await imp("lib/kpi-check.ts");
  const kpiCsv = (label) => new File([csv([["", "2031年", "集計期間"], ["", "項目", "対象", "累計", "12月", "1月"], ["", "ハガキ返信率", "合志", label]])], "お客様アンケート集計表 - KPI.csv", { type: "text/csv" });
  r = await act(hq, () => actions.loadKpiSheetForCheck(form({ files: kpiCsv("40.0%") })));
  ok(r.msg, "KPI のタブを読み込む");
  r = await act(hq, () => actions.loadKpiSheetForCheck(form({ files: kpiCsv("41.0%") })));
  const saved = await KCHK.readKpiSheet();
  ok(r.msg && saved?.tab.rows[2][3] === "41.0%", "もう一度読み込むと置き換える");
  const chk = KCHK.kpiCheck(db(), saved);
  ok(chk.years.length === 1 && chk.years[0].rows.some((x) => x.metric === "reply" && x.sheet === 41), "照合の行 (返信率)");
  r = await act(staff, () => actions.loadKpiSheetForCheck(form({ files: kpiCsv("1%") })));
  ok(r.err, "店舗スタッフは読み込めない");
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log("  ✗", f);
  process.exitCode = 1;
}
fs.rmSync(work, { recursive: true, force: true });
