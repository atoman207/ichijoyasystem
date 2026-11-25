/**
 * 今期の KPI・インセンティブの集計を仕上げる機能のテスト (お客様のご要望 ■7「アンケート・クレーム・インセンティブ・KPI集計」)
 *   node scripts/tests/kpi-import/final.test.mjs   (npm run test:kpi-import)
 * 1. アンケートハガキ（回答）のタブの CSV: 空の行を残す (行の番号 = 表計算の行)・「月」の空欄を同じ日の前後の行から決める・「年」の誤りを入力日で直す
 * 2. ピボットの「ハガキ個人件数」→ 個人件数 (年度ごとに一番新しいタブ・年間チラシ計画より優先・計画の取込で上書きしない)
 * 3. 支給前の照合: シート未集計の月・シート側の誤り (№ のない行の点数・担当の名前が空欄のはがき)
 * 4. 年間インセンティブ: 所属の月割り・アカウントのない対象者・年度の対象外
 * 5. 月次の手当 (月間人日・伝票件数)
 * 6. 販促の商品の KPI (単価・売上・枚数、畳表・襖紙の内訳、防虫加工、リフォーム、畳表の出数、Google ビジネスプロフィール)
 * 7. データ台帳の分類 (タブごとの CSV)
 * 8. 画面の操作 (Server Action の本物): 対象者・月割り・調整額・月次の手当 (管理者のみ)、商品の KPI の設定・取込 (本部・管理者)
 * データはすべて架空 (一時フォルダーの JSON)。外部への送信の設定は消す
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "../../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ichijoya-kpi-final-test-"));
fs.mkdirSync(path.join(work, "data"), { recursive: true });
Object.assign(process.env, {
  DATA_BACKEND: "json",
  DATA_FILE_NAME: "kpi-final-test-db.json",
  FILE_STORAGE_DIR: path.join(work, "uploads"),
  DB_SNAPSHOT: "off",
  ICHIJOYA_DATA_DB: "off",
  ICHIJOYA_DATA_DB_PATH: path.join(work, "mirror.sqlite"),
  CHATBOT_DB_PATH: path.join(work, "chatbot.sqlite"),
  ROUTING_DB_PATH: path.join(work, "routing.sqlite"),
  SESSION_SECRET: "test-secret-for-kpi-final",
  APP_BASE_URL: "https://example.test",
  TZ: "Asia/Tokyo",
});
for (const k of Object.keys(process.env)) if (/^(SMTP_|RESEND_|SENDGRID_|LINE_|CHATWORK_|OPENAI_|ANTHROPIC_|GOOGLE_|NEXT_PUBLIC_SUPABASE_|SUPABASE_|AI_INTAKE_|WEB_PUSH|VAPID)/.test(k)) delete process.env[k];
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
const section = (t) => console.log(`\n■ ${t}`);
const csvText = (rows) => rows.map((x) => x.map((c) => (/[",\n]/.test(String(c ?? "")) ? `"${String(c).replace(/"/g, '""')}"` : String(c ?? ""))).join(",")).join("\n");

const CSV = await imp("lib/csv.ts");
const BI = await imp("lib/kpi-basis-import.ts");
const B = await imp("lib/kpi-basis.ts");
const KSH = await imp("lib/survey-workbook/kpi-sheet.ts");
const ST = await imp("lib/survey-workbook/staff.ts");
const I = await imp("lib/incentive.ts");
const IY = await imp("lib/incentive-year.ts");
const KS = await imp("lib/kpi-settings.ts");
const KM = await imp("lib/kpi-monthly.ts");
const PP = await imp("lib/ops-reports/promo-products.ts");
const RC = await imp("lib/registry/classify.ts");

const stores = ["koshi", "chuo", "nishi", "tamana"].map((id) => ({ id, name: `${id}店`, shortName: id, kind: "store" })).concat([{ id: "hq", name: "本部", shortName: "本部", kind: "hq" }]);

/* ================================================================== */
section("1. アンケートハガキ（回答）のタブの CSV");
{
  const text = "a,b\n,,\nc,d\n";
  eq(CSV.parseCsv(text).length, 2, "既定は空の行を除く (今までどおり)");
  eq(CSV.parseCsv(text, { keepEmpty: true }).map((r) => r.join("|")), ["a|b", "||", "c|d"], "keepEmpty = 空の行も残す (最後の改行のあとは残さない)");
  const head = ["タイムスタンプ", "", "月", "店舗", "電話対応", "営業担当者", "営業対応", "担当職人", "職人対応", "工事の仕上り", "利用にあたり重視したこと", "情報媒体", "次回も依頼したいか", "年"];
  const rows = [
    head,
    ["2031/10/16 16:36:00", "901", "９月", "西", "5", "試験", "5", "試験", "5", "5", "", "", "はい", "2031年"],
    ["2031/10/16 16:37:00", "902", "", "西", "5", "試験", "5", "試験", "5", "5", "", "", "はい", "2031年"],
    ["2031/10/16 16:38:00", "903", "９月", "西", "4", "試験", "4", "試験", "4", "4", "", "", "はい", "2031年"],
    ["", "", "", "", "", "", "", "", "", "", "", "", "", ""],
    ["2031/10/17 9:00:00", "904", "", "西", "4", "試験", "4", "試験", "4", "4", "", "", "はい", "2031年"],
    ["2031/10/18 9:00:00", "905", "１０月", "西", "4", "試験", "4", "試験", "4", "4", "", "", "はい", "2031年"],
    ["2032/02/03 8:54:49", "", "１月", "", "", "", "", "見本", "5", "", "", "", "", "2031年"],
  ];
  const file = { name: "アンケートハガキ（回答） - フォームの回答 1.csv", bytes: new TextEncoder().encode(csvText(rows)) };
  const { sheets } = BI.basisSheetsFromFiles([file]);
  eq(sheets[0].rows.length, rows.length, "CSV の空の行も残す (行の番号を表計算の行に合わせる)");
  const p = BI.parseCardMonthSheet(sheets[0].rows);
  const byNo = Object.fromEntries(p.rows.filter((r) => r.postcardNo).map((r) => [r.postcardNo, r]));
  eq([byNo["902"].month, byNo["902"].inferred], ["2031-09", true], "「月」が空欄 → 同じ日に続けて入力した前後の行の月");
  eq(byNo["904"].month, "", "前後の行が別の日なら決めない (入力日の月のまま)");
  eq(byNo["905"].row, 7, "行の番号は表計算の行 (空の行を数える)");
  const attached = p.rows.find((r) => !r.postcardNo && r.row === 8);
  eq(attached?.month, "2032-01", "「年」が入力日と合わない行 (2032/02/03 の 1 月分が「2031年」) は入力日から年を決める");
  ok(p.problems.some((x) => /入力日と合わない行 1 行/.test(x)) && p.problems.some((x) => /同じ日に続けて入力した前後の行の月/.test(x)), "直した行は注意に出す");
}

/* ================================================================== */
section("2. ピボットの「ハガキ個人件数」");
{
  eq(BI.pivotSheetMonth("ピボット テーブル 2025.11"), { y: 2025, m: 11, key: "2025-11-00" }, "タブの名前の年月");
  eq(BI.pivotSheetMonth("ピボット テーブル 2024.12-2")?.key, "2024-12-02", "「2024.12-2」(同じ月の 2 枚目)");
  const pivot = (cells) => [
    ["店舗", "ハガキ№ の COUNTA", "", ""],
    ["合志", "10", "50%", ""],
    [],
    ["ハガキ個人件数"],
    ["月", "合志", "中央", "玉名", "西"],
    ...cells,
    ["", "1", "2", "3", "4"],
  ];
  const r = BI.parsePivotIndividual(pivot([["12", "5", "6", "7", "8"], ["1", "9", "", "10", "11"]]), "ピボット テーブル 2032.1");
  eq(r.fy, 2032, "12 月始まりの年度 (2032.1 → 2032 年度)");
  eq(r.values.map((v) => `${v.storeId}|${v.month}=${v.value}`), ["koshi|2031-12=5", "chuo|2031-12=6", "tamana|2031-12=7", "nishi|2031-12=8", "koshi|2032-01=9", "tamana|2032-01=10", "nishi|2032-01=11"], "月 × 店舗 (12 月は前年・空欄は読まない・合計の行で終わる)");
  ok(r.values.every((v) => v.src === "pivot"), "ピボットの値の印");
  const flyer = [["個人売上目標・実績（2031年度）"], ["合志（個人）"], ["", "本年度実績"], ["12月", "99"]];
  const read = BI.readBasisSheets([
    { name: "ピボット テーブル 2032.1", rows: pivot([["12", "5", "6", "7", "8"]]), source: "a" },
    { name: "ピボット テーブル 2032.3", rows: pivot([["12", "15", "6", "7", "8"], ["1", "1", "1", "1", "1"]]), source: "b" },
    { name: "個人件数売上", rows: flyer, source: "c" },
  ]);
  const v = Object.fromEntries(read.individual.map((x) => [`${x.storeId}|${x.month}`, x]));
  eq([v["koshi|2031-12"]?.value, v["koshi|2031-12"]?.src], [15, "pivot"], "年度ごとに一番新しいピボット (2032.3) を使い、年間チラシ計画より優先する");
  ok(read.problems.some((x) => /2032年度は「ピボット テーブル 2032.3」/.test(x)), "どのタブの値を使うかを出す");
  const noName = BI.parsePivotIndividual(pivot([["12", "1", "1", "1", "1"]]), "ピボット");
  ok(!noName.values.length && noName.problems.length === 1, "タブの名前に年月がなければ読まない (年度が決められない)");
  // 取込の計画: ピボットの値は年間チラシ計画の取込で上書きしない
  const db = { surveys: [], settings: [{ id: "kpi_basis", value: { months: { "koshi|2031-12": { individual: 15, individualSrc: "pivot" }, "chuo|2031-12": { individual: 6, individualSrc: "import" } } } }] };
  const plan = BI.planBasisImport(db, { individual: [{ storeId: "koshi", month: "2031-12", value: 99, ref: "x" }, { storeId: "chuo", month: "2031-12", value: 6, ref: "y", src: "pivot" }], cardMonths: [] });
  eq(plan.individual.map((i) => i.action), ["pivot", "update"], "計画の値はピボットの値を上書きしない / 同じ値でも 計画 → ピボット は更新 (どこの値か)");
  const applied = BI.applyBasisImport(structuredClone(db), { individual: [{ storeId: "chuo", month: "2031-12", value: 6, ref: "y", src: "pivot" }], cardMonths: [], label: "t" }, { userId: "u", now: "2031-01-01T00:00:00Z" });
  eq(applied.basis.months["chuo|2031-12"].individualSrc, "pivot", "取り込んだ値の印");
  eq(B.kpiBasis({ settings: [{ id: "kpi_basis", value: applied.basis }] }).months["chuo|2031-12"].individualSrc, "pivot", "設定を読み直しても印が残る");
  eq(B.DENOM_SOURCE_LABEL.pivot, "アンケート集計 (ピボット)", "分母の内訳の名前");
}

/* ================================================================== */
section("3. 支給前の照合 (シート未集計の月・シート側の誤り)");
{
  const users = [
    { id: "u_a", name: "試験 一郎", storeId: "koshi", role: "store_staff", active: true, title: "" },
    { id: "u_b", name: "見本 二郎", storeId: "koshi", role: "store_staff", active: true, title: "" },
  ];
  const card = (no, o) => ({ id: `s${no ?? Math.random()}`, receivedAt: "2031-02-03T00:00:00.000Z", storeId: "koshi", source: "import", countMonth: "2031-01", salesName: "試験", salesUserId: "u_a", craftsmanName: "見本", craftsmanUserId: "u_b", phoneScore: 4, salesScore: 4, craftsmanScore: 4, finishScore: 4, ...(no ? { postcardNo: no } : {}), ...o });
  const surveys = [
    card("1", {}),
    card("2", { finishScore: 5 }),
    // ハガキ№ のない行 (シートのピボットは合計点にだけ入れる)
    card(undefined, { id: "sx", finishScore: 5, phoneScore: 5 }),
    // 担当職人が空欄 (KPI の決まりでは数えない。シートのピボットは数えた)
    card("3", { craftsmanName: "", craftsmanUserId: undefined, finishScore: 2 }),
  ];
  const qualityIssues = [{ id: "q1", storeId: "koshi", kind: "claim", points: 2, occurredOn: "2031-02-01", attribution: "store", counted: true }];
  const db = { users, stores, customers: [], orders: [], surveys, qualityIssues, reviews: [], settings: [{ id: "kpi_basis", value: { months: { "koshi|2031-01": { individual: 10, individualSrc: "import" } } } }] };
  // シートの値: ④ = (4 + 5 + 5 + 2) ÷ 3 枚 (№ のない行の 5 点は合計だけ・空欄のはがきは両方) / 返信率 = 3 ÷ 10
  const year = { label: "2031年", months: ["2031-01", "2031-02"], period: { from: "2031-01-01", to: "2031-02-28" }, monthly: [{ metric: "claims", target: "合志", values: [0, 0] }, { metric: "rework", target: "合志", values: [0, undefined] }], totals: [{ metric: "finish", target: "合志", value: 5.33 }, { metric: "reply", target: "合志", value: 30 }] };
  // 1 月で止まったシート (rework の値は 1 月まで) → 2 月のクレームは「シート未集計」
  year.monthly[1].values = [0, undefined];
  const r = KSH.reconcileKpi(db, [year], ST.staffMatcher(users, {}))[0];
  const claimFeb = r.rows.find((x) => x.metric === "claims" && x.month === "2031-02");
  eq(claimFeb?.status, "pending", "シートの値のある最後の月より後の月は「シート未集計」(差に数えない)");
  const finish = r.rows.find((x) => x.metric === "finish");
  eq([finish?.status, finish?.system], ["sheet", 4.5], "№ のない行の点数を合計に入れたシートの平均 → シート側の誤り (システムは № のある行だけ)");
  ok(/ハガキ№ のない行 1 行/.test(finish?.cause ?? ""), "原因を書く");
  const reply = r.rows.find((x) => x.metric === "reply");
  eq([reply?.status, reply?.system], ["sheet", 20], "担当の名前が空欄のはがきも数えたシートの返信率 → シート側の誤り");
  ok(/担当の名前が空欄のはがき 1 枚 \(No\.3\)/.test(reply?.cause ?? ""), "名前が空欄のはがきの番号を書く");
  eq([r.matched, r.differ, r.sheetErrors, r.pending], [r.rows.filter((x) => x.status === "ok").length, 0, 2, 1], "件数 (一致・差・シートの誤り・未集計)");
}

/* ================================================================== */
section("4. 年間インセンティブ (所属の月割り・アカウントのない対象者・対象外)");
{
  eq(IY.parseAssign("合志 8, 中央 4", stores), [{ unit: "koshi", months: 8 }, { unit: "chuo", months: 4 }], "「合志 8, 中央 4」(店舗の名前・略称)");
  eq(IY.parseAssign("事務7か月", stores), [{ unit: "office", months: 7 }], "「事務7か月」");
  eq(IY.parseAssign("対象外", stores), [], "「対象外」= この年度は対象外");
  eq(IY.parseAssign("", stores), null, "空 = 設定しない");
  ok("error" in IY.parseAssign("合志 8, 中央 6", stores), "月数の合計が 12 を超えると断る");
  ok("error" in IY.parseAssign("本部 3", stores), "本部は所属にできない (店舗か事務)");
  eq(IY.formatAssign([{ unit: "koshi", months: 8 }, { unit: "office", months: 4 }], stores), "koshi 8, 事務 4", "入力欄の文字");
  eq(IY.formatAssign([], stores), "対象外", "対象外の表示");
  eq(IY.extraKey("架 空"), "name:架空", "アカウントのない対象者のキー");

  // 架空のデータ: 合志 (返信率 30 → 0 円・④ 4.5 → 1.5 万) と 中央 (返信率 60 → 7 万・④ 5 → 3 万・1 位)
  const users = [
    { id: "u_a", name: "試験 一郎", storeId: "chuo", role: "store_staff", active: true, title: "" },
    { id: "u_b", name: "見本 二郎", storeId: "koshi", role: "store_staff", active: true, title: "" },
    { id: "u_n", name: "新人 三郎", storeId: "koshi", role: "store_staff", active: true, title: "" },
    { id: "u_o", name: "社長", storeId: "koshi", role: "admin", active: true, title: "" },
  ];
  const card = (i, storeId, finish, o = {}) => ({ id: `c${storeId}${i}`, postcardNo: `${storeId}${i}`, receivedAt: "2031-02-03T00:00:00.000Z", storeId, source: "import", countMonth: "2031-01", salesName: "試験", salesUserId: "u_a", craftsmanName: "見本", craftsmanUserId: "u_b", phoneScore: 5, salesScore: 5, craftsmanScore: 5, finishScore: finish, ...o });
  const surveys = [...[1, 2, 3].map((i) => card(i, "koshi", i === 3 ? 4 : 5 - (i === 2 ? 0.5 : 0))), ...[1, 2, 3, 4, 5, 6].map((i) => card(i, "chuo", 5))];
  const months = { "koshi|2031-01": { individual: 10, individualSrc: "import", sites: 100 }, "chuo|2031-01": { individual: 10, individualSrc: "import", sites: 100 } };
  const db = { users, stores, customers: [], orders: [], surveys, qualityIssues: [], reviews: [], settings: [{ id: "kpi_basis", value: { months } }] };
  const s = { ...KS.kpiSettings({ settings: [] }), excludedUserIds: ["u_o"] };
  const p = { from: "2030-12-01", to: "2031-11-30" };
  const year = { assign: { u_b: [{ unit: "koshi", months: 8 }, { unit: "chuo", months: 4 }], u_n: [], "name:見本": [{ unit: "office", months: 7 }] }, extra: [{ key: "name:架空", name: "架空", unit: "office" }, { key: "name:見本", name: "見本", unit: "office" }] };
  const res = I.computeIncentives(db, p, s, {}, undefined, year);
  const person = (k) => res.people.find((x) => x.userId === k);
  const line = (k, key) => person(k)?.lines.find((l) => l.key === key)?.yen;
  const koshi = res.units.find((u) => u.unit === "koshi");
  const chuo = res.units.find((u) => u.unit === "chuo");
  eq([koshi.replyRate, chuo.replyRate], [30, 60], "返信率 (合志 30%・中央 60%)");
  eq(line("u_a", "reply"), 70000, "月割りなし: 今の所属 (中央) で 12 か月");
  eq(line("u_b", "reply"), Math.round((0 * 8 + 70000 * 4) / 12), "月割り: 合志 8 か月 + 中央 4 か月 (所属ごとの金額 × 月数 ÷ 12、四捨五入)");
  eq(line("u_b", "replyMvp"), Math.round((30000 * 4) / 12), "返信率 MVP も月割り");
  eq(line("u_b", "craft"), 30000, "③ 職人対応は本人の値なので月割りしない");
  ok(/月割り \(koshi 8 か月 \+ chuo 4 か月\)/.test(person("u_b").lines.find((l) => l.key === "reply").note), "月割りの内訳を書く");
  eq([person("u_b").prorated, person("u_b").months, person("u_b").storeId], [true, 12, "koshi"], "月割りの印・月数・主な所属");
  ok(!person("u_n"), "年度の対象外 (所属の月割りが空) の社員は入れない");
  ok(!person("u_o"), "支給の対象外の社員は入れない");
  eq([person("name:架空")?.role, person("name:架空")?.name, line("name:架空", "phone")], ["clerk", "架空", 50000], "アカウントのない事務 (① 電話対応 5.0 → 5 万)");
  eq(line("name:見本", "phone"), Math.round((50000 * 7) / 12), "アカウントのない事務の月割り (事務 7 か月)");
  eq(line("name:見本", "quality"), Math.round((50000 * 7) / 12), "事務のクレーム率 (0% → 5 万) も月割り");
  // 調整額 (アカウントのない対象者のキー)・合計
  const res2 = I.computeIncentives(db, p, s, { "name:架空": { amount: -1000, note: "試験" } }, undefined, year);
  eq(res2.people.find((x) => x.userId === "name:架空").total, res.people.find((x) => x.userId === "name:架空").total - 1000, "アカウントのない対象者の調整額");
  // 年度の設定なし = 今までどおり
  const plain = I.computeIncentives(db, p, s);
  eq(plain.people.find((x) => x.userId === "u_b").lines.find((l) => l.key === "reply").yen, 0, "年度の設定なし = 今の所属で 12 か月 (合志)");
  // 読み書き (ほかの項目を消さない)
  const sdb = { settings: [{ id: "incentive_2031", value: { adjust: { u_a: { amount: 5 } } } }], stores };
  IY.writeIncentiveYearPart(sdb, 2031, "assign", { u_a: [{ unit: "chuo", months: 6 }], u_x: [] }, "u", "t");
  const y = IY.readIncentiveYear(sdb, 2031);
  eq([y.adjust.u_a.amount, y.assign.u_a, y.assign.u_x], [5, [{ unit: "chuo", months: 6 }], []], "年度の設定の 1 項目だけを書き換える (調整額は残る・空の配列 = 対象外も残る)");
}

/* ================================================================== */
section("5. 月次の手当 (月間人日・伝票件数)");
{
  const s = KS.kpiSettings({ settings: [] });
  eq(s.incentive.monthly, { manDayMin: 11, manDayYen: 25000, slipPerClerk: 110, slipYen: 10000 }, "既定 (人日 11・2.5 万円 / 伝票 110 件 × 事務の人数・1 万円)");
  const db = {
    users: [{ id: "u1", name: "a", storeId: "koshi", role: "store_staff", active: true }, { id: "u2", name: "b", storeId: "koshi", role: "store_staff", active: true }],
    stores, schedule: [], orders: Array.from({ length: 230 }, (_, i) => ({ id: `o${i}`, status: "paid", contractDate: "2031-01-15", storeId: "koshi" })), quotes: [], customers: [], jobSpecs: [], products: [], holidays: [], workReportDays: [],
    settings: [{ id: "incentive_2031", value: { monthly: { "koshi|2031-01": { value: 12, overtime: 10000 }, "chuo|2031-01": { cleared: true, people: 3, overtime: 0 }, "office|2031-02": { value: 300 } } } }],
  };
  const rows = KM.monthlyAllowances(db, 2031, s, { today: "2031-02-10", officePeople: 2 });
  const row = (u, m) => rows.find((x) => x.unit === u && x.month === m);
  eq([row("koshi", "2031-01").cleared, row("koshi", "2031-01").perPerson], [true, (25000 * 2 - 10000) / 2], "実績 12 ≥ 11 → (2.5 万 × 2 人 − 残業代 1 万) ÷ 2 人");
  eq([row("chuo", "2031-01").clearedBy, row("chuo", "2031-01").perPerson], ["manual", 25000], "クリアの印 (シートの 1) と人数の手入力");
  eq([row("office", "2031-01").auto, row("office", "2031-01").autoClears, row("office", "2031-01").cleared], [230, true, false], "目安 (受注 230 件) が基準以上でも、実績を入れるまでは支給しない");
  eq([row("office", "2031-02").threshold, row("office", "2031-02").cleared, row("office", "2031-02").perPerson], [220, true, 10000], "伝票件数: 110 件 × 事務 2 人 = 220 件以上でクリア");
  ok(!rows.some((x) => x.month > "2031-02"), "今日より後の月は出さない");
  eq(KM.readMonthlyEntries({ settings: [{ id: "incentive_2031", value: { monthly: { "bad key": { value: 1 }, "koshi|2031-03": { value: -5, note: "x" } } } }] }, 2031), { "koshi|2031-03": { note: "x" } }, "読み込み: 正しくないキー・値は捨てる");
}

/* ================================================================== */
section("6. 販促の商品の KPI");
{
  const s = PP.promoKpiSettings({ settings: [] });
  eq(PP.promoFyMonths(2031, 7).slice(0, 2).concat(PP.promoFyMonths(2031, 7).slice(-1)), ["2031-07", "2031-08", "2032-06"], "販促の年度 = 7 月〜翌 6 月");
  eq([PP.promoFyOf("2031-06-30", 7), PP.promoFyOf("2031-07-01", 7)], [2030, 2031], "日付の属する年度");
  const item = (cat, product, qty, amount) => ({ cat, product, qty, unitPrice: qty ? amount / qty : 0, amount });
  const fact = (id, storeId, salesDate, customerId, items) => ({ id, storeId, salesDate, customerId, status: "paid", items });
  const facts = [
    fact("f1", "koshi", "2031-07-10", "c_i", [item("tatami", "畳 きずな", 6, 66000), item("tatami", "畳 畳縁", 6, 6600), item("tatami", "畳 防虫加工", 6, 13200), item("fusuma", "襖 しずか 片面", 2, 11000), item("fusuma", "襖 引き手交換", 4, 4400)]),
    fact("f2", "koshi", "2031-07-20", "c_i", [item("tatami", "畳 ヘリ無し新調", 4, 88000), item("cloth", "クロス 張替", 1, 120000), item("misc", "諸経費 諸経費", 1, 3300)]),
    fact("f3", "koshi", "2031-07-21", "c_c", [item("tatami", "畳 きずな", 20, 200000)]),
    fact("f4", "koshi", "2031-08-01", "c_i", [item("tatami", "畳 めぐみ(中国産中級品)", 3, 21000), item("shoji", "障子 エコノミー 大", 4, 13200), item("amido", "網戸 18メッシュ 大", 2, 6600)]),
    fact("f5", "chuo", "2031-07-05", "c_i", [item("tatami", "畳 やすらぎ", 2, 30800)]),
  ];
  const customers = new Map([["c_i", { type: "individual" }], ["c_c", { type: "corporate" }]]);
  const k = PP.productKpis(facts, customers, ["koshi", "chuo"], PP.promoFyMonths(2031, 7), s);
  const koshi = k.find((x) => x.storeId === "koshi");
  const jul = koshi.months[0];
  eq([jul.cats.tatami.sales, jul.cats.tatami.qty, jul.cats.tatami.unitPrice], [66000 + 6600 + 13200 + 88000, 10, Math.round((66000 + 6600 + 13200 + 88000) / 10 / 1.1)], "畳: 売上 = 付属を含む明細の合計、枚数 = 本体の数量、平均単価 (税抜) = 売上 ÷ 枚数 ÷ 1.1");
  eq([jul.cats.fusuma.sales, jul.cats.fusuma.qty], [15400, 2], "襖: 引手交換は売上に入れて枚数に数えない");
  eq(jul.omote, { きずな: 1, 全ヘリ無し: 1 }, "畳表の内訳 (件数ベース): 受注ごとに 1 件・全部ヘリ無しの受注は「全ヘリ無し」");
  eq(jul.fusuma, { しずか系: 1 }, "襖紙の内訳 (〇〇系)");
  eq(jul.mite, { orders: 1, qty: 6 }, "マイトスタット (防虫加工): 件数と枚数");
  eq(jul.reform, { orders: 1, sales: 120000 }, "10 万円以上のリフォーム (クロス・雑工事。諸経費は除く)");
  eq(jul.orders, 2, "法人のお客様の受注は数えない");
  eq(koshi.months[1].omote, { めぐみ以下: 1 }, "「めぐみ(中国産中級品)」はめぐみ (中国産は国産より先に照合)");
  const all = k.find((x) => x.storeId === "all");
  eq([all.total.cats.tatami.qty, all.months[0].orders], [15, 3], "全店 = 店舗の合計");
  const counts = PP.omoteCounts(facts, "2031-07-01", "2031-08-31", s);
  eq(Object.fromEntries(counts.filter((x) => x.qty).map((x) => [x.label, x.qty])), { やすらぎ: 2, きずな: 26, めぐみ: 3, その他: 4 }, "畳表の出数 (全てのお客様・本体の枚数。種類のないヘリ無しはその他)");
  const rules = PP.parseRules("極み: 極み\nめぐみ: めぐみ, 格安 → めぐみ以下");
  eq(rules, [{ label: "極み", keywords: ["極み"], group: undefined }, { label: "めぐみ", keywords: ["めぐみ", "格安"], group: "めぐみ以下" }], "種類の設定の入力 (名前: 言葉 → 列)");
  eq(PP.parseRules(PP.formatRules(s.omote)), s.omote.map((r) => ({ ...r, group: r.group === r.label ? undefined : r.group })), "設定の入力欄 ⇔ 種類 (往復)");
  ok("error" in PP.parseRules("言葉なし"), "形の正しくない行は断る");
  const custom = PP.promoKpiSettings({ settings: [{ id: "promo_kpi", value: { fyStartMonth: 4, reformMin: 50000, mite: ["防虫"] } }] });
  eq([custom.fyStartMonth, custom.reformMin, custom.mite, custom.omote.length], [4, 50000, ["防虫"], s.omote.length], "設定 (ない項目は既定)");
  // Google ビジネスプロフィール (1 月の列のない年・SR = 本部)
  const g = [
    ["2032年"], ["通話", "", "", "", "ウェブサイトへのアクセス"], ["", "1月", "2月", "", "", "1月", "2月"],
    ["合志", "3", "4", "", "合志", "5", "6"], ["SR", "1", "", "", "SR", "2", ""], ["小計", "4", "4"],
    ["2031年"], ["通話"], ["", "", "2月"], ["玉名", "", "7"],
  ];
  const gp = PP.parseGbpSheet(g, (l) => (/^SR/.test(l) ? "hq" : l === "合志" ? "koshi" : l === "玉名" ? "tamana" : undefined));
  eq(gp.values.map((v) => `${v.storeId}|${v.month}|${v.metric}=${v.value}`), ["koshi|2032-01|calls=3", "koshi|2032-02|calls=4", "koshi|2032-01|web=5", "koshi|2032-02|web=6", "hq|2032-01|calls=1", "hq|2032-01|web=2", "tamana|2031-02|calls=7"], "年ごと・表ごと (通話・ウェブサイト) の店舗 × 月 (小計の行は読まない・1 月の列のない年も店舗の列で読む)");
  eq(PP.readGbp({ settings: [{ id: "promo_gbp", value: { months: { "koshi|2032-01": { calls: 3, web: "x" }, bad: { calls: 1 } } } }] }), { "koshi|2032-01": { calls: 3 } }, "読み込み (正しくない値・キーは捨てる)");
}

/* ================================================================== */
section("7. データ台帳の分類 (タブごとの CSV)");
{
  const c = (p) => RC.classifyPath(p, "spreadsheet");
  const a = "02_お客様対応・アンケート/アンケート/アンケートハガキ（回答）（タブ別CSV 2031-01-01）/";
  const b = "05_販促・広告/計画・分析/販促（タブ別CSV 2031-01-01）/";
  eq([c(`${a}アンケートハガキ（回答） - ピボット テーブル 2031.1.csv`).action, c(`${a}アンケートハガキ（回答） - ピボット テーブル 2031.1.csv`).visibility], ["structured", "hq"], "ピボット = 取込済みのデータ (本部以上)");
  eq(c(`${a}アンケートハガキ（回答） - フォームの回答 1.csv`).action, "structured", "フォームの回答 = 取込済みのデータ");
  eq([c(`${b}販促 - 2025年度2026年度販促計画.csv`).action, c(`${b}販促 - 2025年度2026年度販促計画.csv`).visibility], ["knowledge", "hq"], "販促計画 = 社内資料 (本部以上)");
  eq(c(`${b}販促 - グーグルアクセス   のコピー.csv`).action, "structured", "グーグルアクセス = 取込済みのデータ");
  eq(c(`${b}販促 - ユニフォーム.csv`).visibility, "hq", "ユニフォーム (社員のサイズ) = 本部以上");
  eq(c(`${b}販促 - のぼり .csv`).visibility, "manager", "のぼり = 店長以上");
}

/* ================================================================== */
section("8. 画面の操作 (Server Action)");
{
  const store = await imp("lib/db/store.ts");
  await store.syncDb();
  const db = () => store.getDb();
  const kpiActions = await imp("lib/actions/kpi.ts");
  const promoActions = await imp("lib/actions/promo-kpi.ts");
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
  const form = (obj, multi = {}) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(obj)) if (v !== undefined) fd.set(k, v instanceof File ? v : String(v));
    for (const [k, list] of Object.entries(multi)) for (const v of list) fd.append(k, String(v));
    return fd;
  };
  const year = () => IY.readIncentiveYear(db(), 2031);
  let r = await act(hq, () => kpiActions.saveIncentiveMembers(2031, form({ extra: "架空: 事務" })));
  ok(r.err && !year().extra.length, "対象者・所属の設定は管理者だけ (本部スタッフは断る)");
  r = await act(admin, () => kpiActions.saveIncentiveMembers(2031, form({ extra: "架空: 事務\n見本: 事務" })));
  eq([r.msg ? "ok" : r.err, year().extra.map((e) => e.key)], ["ok", ["name:架空", "name:見本"]], "アカウントのない対象者 (名前: 所属) を保存");
  r = await act(admin, () => kpiActions.saveIncentiveMembers(2031, form({ extra: "架空: 事務\n見本: 事務", [`as_${staff.id}`]: "合志 8, 中央 4", "as_name:見本": "事務 7" }, { keys: [staff.id, "name:見本"] })));
  eq([r.msg ? "ok" : r.err, year().assign[staff.id], year().assign["name:見本"]], ["ok", [{ unit: "koshi", months: 8 }, { unit: "chuo", months: 4 }], [{ unit: "office", months: 7 }]], "所属の月割りを保存 (社員・アカウントのない対象者)");
  r = await act(admin, () => kpiActions.saveIncentiveMembers(2031, form({ extra: "架空: 事務\n見本: 事務", [`as_${staff.id}`]: "合志 13" }, { keys: [staff.id] })));
  ok(r.err && /1〜12/.test(r.err) && year().assign[staff.id]?.length === 2, "正しくない月数は断る (保存しない)");
  r = await act(admin, () => kpiActions.saveIncentiveMembers(2031, form({ extra: `${staff.name.split(/\s+/)[0]}: 事務` })));
  ok(r.err && /アカウントのある社員/.test(r.err), "アカウントのある社員はアカウントのない対象者にできない");
  r = await act(admin, () => kpiActions.saveIncentiveAdjustments(2031, form({ "adj_name:架空": "▲2,000", "note_name:架空": "試験" }, { keys: ["name:架空"] })));
  eq([r.msg ? "ok" : r.err, year().adjust["name:架空"], year().assign[staff.id]?.length], ["ok", { amount: -2000, note: "試験" }, 2], "調整額 (アカウントのない対象者・▲ はマイナス)。ほかの項目 (月割り) は残る");
  r = await act(admin, () => kpiActions.saveMonthlyAllowances(2031, form({ "mv_koshi|2031-01": "12.5", "mo_koshi|2031-01": "10,000円", "mc_office|2031-01": "1" }, { mkeys: ["koshi|2031-01", "office|2031-01"] })));
  const entries = KM.readMonthlyEntries(db(), 2031);
  eq([r.msg ? "ok" : r.err, entries["koshi|2031-01"], entries["office|2031-01"]?.cleared, year().extra.length], ["ok", { value: 12.5, overtime: 10000 }, true, 2], "月次の手当の実績・残業代・クリアの印を保存 (ほかの項目は残る)");
  r = await act(admin, () => kpiActions.saveMonthlyAllowances(2031, form({ "mv_koshi|2031-01": "" }, { mkeys: ["koshi|2031-01"] })));
  ok(!KM.readMonthlyEntries(db(), 2031)["koshi|2031-01"], "空欄にすると消す");
  r = await act(hq, () => kpiActions.saveMonthlyAllowances(2031, form({ "mv_koshi|2031-01": "1" }, { mkeys: ["koshi|2031-01"] })));
  ok(r.err, "月次の手当は管理者だけ");
  ok(db().auditLogs.some((l) => l.entityId === "incentive_2031" && /対象者・所属の月割り/.test(l.summary)), "変更履歴");
  // 商品の KPI の設定・Google ビジネスプロフィール (本部・管理者)
  const settingsForm = (o = {}) => form({ omote: "極み: 極み\nきずな: きずな", fusuma: "しずか系: しずか", accessory: "縁, 防虫", heriNashi: "ヘリ無", mite: "防虫", reformMin: "100,000", fyStartMonth: "7", domestic: "極み, きずな", ...o });
  r = await act(staff, () => promoActions.savePromoKpiSettings(settingsForm()));
  ok(r.err, "店舗スタッフは商品の KPI の設定を変えられない");
  r = await act(hq, () => promoActions.savePromoKpiSettings(settingsForm()));
  const ps = PP.promoKpiSettings(db());
  eq([r.msg ? "ok" : r.err, ps.omote.map((x) => x.label), ps.reformMin, ps.domestic], ["ok", ["極み", "きずな"], 100000, ["極み", "きずな"]], "本部スタッフは種類・下限・国産の種類を保存できる");
  r = await act(hq, () => promoActions.savePromoKpiSettings(settingsForm({ omote: "言葉なし" })));
  ok(r.err && /畳表の種類/.test(r.err), "形の正しくない種類は断る");
  r = await act(hq, () => promoActions.resetPromoKpiSettings(form({})));
  eq(PP.promoKpiSettings(db()).omote.length, PP.DEFAULT_PROMO_KPI.omote.length, "既定に戻す");
  const gbpCsv = new File([csvText([["2032年"], ["通話"], ["", "1月", "2月"], ["合志", "3", "4"], ["SR", "1", "2"]])], "販促 - グーグルアクセス.csv", { type: "text/csv" });
  r = await act(hq, () => promoActions.importGbpSheet(form({ file: gbpCsv })));
  const gbp = PP.readGbp(db());
  const hqId = db().stores.find((s) => s.kind === "hq").id;
  eq([r.msg ? "ok" : r.err, gbp["koshi|2032-02"], gbp[`${hqId}|2032-01`]], ["ok", { calls: 4 }, { calls: 1 }], "グーグルアクセスのタブを取り込む (SR = 本部・ショールーム)");
  r = await act(hq, () => promoActions.saveGbpMonth(form({ month: "2032-02", "calls_koshi": "9", "web_koshi": "8" })));
  eq([r.msg ? "ok" : r.err, PP.readGbp(db())["koshi|2032-02"]], ["ok", { calls: 9, web: 8 }], "1 か月分の手入力 (上書き)");
  r = await act(hq, () => promoActions.saveGbpMonth(form({ month: "2032-02", "calls_koshi": "-1" })));
  ok(r.err, "負の数は断る");
  r = await act(staff, () => promoActions.saveGbpMonth(form({ month: "2032-02", "calls_koshi": "1" })));
  ok(r.err, "店舗スタッフは入力できない");
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log("  ✗", f);
  process.exitCode = 1;
}
fs.rmSync(work, { recursive: true, force: true });
