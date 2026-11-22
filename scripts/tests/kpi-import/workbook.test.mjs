/**
 * スプレッドシート「お客様アンケート集計表」の取込と、社内の LINE グループのつなぎ込みのテスト
 *   node scripts/tests/kpi-import/workbook.test.mjs   (npm run test:kpi-import)
 * 1. タブの見分け方・担当者の照合 (姓・名・肩書き・旧字体・対応表)
 * 2. クレーム手直し内容 (同上・クレーム＋手直しの組・数えない印・区分の空欄・期間の重なるタブ・二重の記入・案件のひも付け)
 * 3. Google口コミ集計 (年の決め方・支払日・再記入の 1 件化)
 * 4. アンケートの集計表 (平成の全社の表・令和の店舗の表・年度ごとの比較)
 * 5. KPI のタブとの照合
 * 6. 取込 (planWorkbook → applyWorkbook。2 回取り込んでも二重にならない・シートの変更だけ更新・システムで変えた項目は残す)
 * 7. 画面の操作 (Server Action の本物): 取込の確認と取込・権限、案件を選ばずに登録・案件へのひも付け・LINE の報告
 * 8. LINE グループの用途 (店舗別グループへの問い合わせの知らせ・クレーム報告・残す件数)
 * データは一時フォルダーの JSON (サンプルデータ)。名前・現場名はすべて架空。外部への送信の設定は消す (送らない)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "../../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ichijoya-kpi-import-test-"));
fs.mkdirSync(path.join(work, "data"), { recursive: true });
Object.assign(process.env, {
  DATA_BACKEND: "json",
  DATA_FILE_NAME: "kpi-import-test-db.json",
  FILE_STORAGE_DIR: path.join(work, "uploads"),
  DB_SNAPSHOT: "off",
  ICHIJOYA_DATA_DB: "off",
  ICHIJOYA_DATA_DB_PATH: path.join(work, "mirror.sqlite"),
  CHATBOT_DB_PATH: path.join(work, "chatbot.sqlite"),
  ROUTING_DB_PATH: path.join(work, "routing.sqlite"),
  SESSION_SECRET: "test-secret-for-kpi-import",
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
const section = (t) => console.log(`\n■ ${t}`);

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
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) for (const x of v) fd.append(k, x);
    else fd.set(k, v instanceof File ? v : String(v));
  }
  return fd;
};
const csv = (rows) => rows.map((r) => r.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : String(c))).join(",")).join("\n");

const store = await imp("lib/db/store.ts");
const T = await imp("lib/survey-workbook/tabs.ts");
const S = await imp("lib/survey-workbook/staff.ts");
const C = await imp("lib/survey-workbook/claims.ts");
const RV = await imp("lib/survey-workbook/reviews.ts");
const H = await imp("lib/survey-workbook/history.ts");
const K = await imp("lib/survey-workbook/kpi-sheet.ts");
const PL = await imp("lib/survey-workbook/plan.ts");
const RD = await imp("lib/survey-workbook/read.ts");
const CMP = await imp("lib/survey-workbook/compare.ts");
const LG = await imp("lib/line-groups.ts");
const SL = await imp("lib/notify/store-line.ts");
const KPI = await imp("lib/kpi.ts");
const Q = await imp("lib/db/queries.ts");
const kpiActions = await imp("lib/actions/kpi.ts");
const wbActions = await imp("lib/actions/survey-workbook.ts");
const lineActions = await imp("lib/actions/line-groups.ts");
const inquiryActions = await imp("lib/actions/inquiries.ts");
await store.syncDb();
const db = () => store.getDb();

const nowIso = new Date().toISOString();
const admin = db().users.find((u) => u.role === "admin" && u.active);
const hqStaff = db().users.find((u) => u.role === "hq_staff" && u.active);
const koshi = db().stores.find((s) => s.id === "koshi");
const koshiManager = db().users.find((u) => u.id === koshi.managerUserId && u.active);
const koshiStaff = db().users.find((u) => u.active && u.storeId === "koshi" && u.role === "store_staff");
ok(admin && hqStaff && koshiManager && koshiStaff, "サンプルデータ: 管理者・本部・合志店の店長と社員がいる");

// 架空の社員・お客様・受注 (照合用)
await store.mutate((d) => {
  const u = (id, name, storeId, role = "store_staff") => ({ id, name, email: `${id}@example.test`, role, storeId, active: true, title: "" });
  d.users.push(u("u_wb_a", "試験 太郎", "koshi"), u("u_wb_b", "髙試 次郎", "chuo"), u("u_wb_c", "試北 三郎", "nishi", "store_manager"), u("u_wb_d", "見本 光江", "hq", "hq_staff"));
  const base = { kana: "", type: "individual", postalCode: "", preferredChannel: "phone", firstContactChannel: "phone", tags: [], notes: "", createdAt: nowIso, updatedAt: nowIso };
  d.customers.push({ ...base, id: "cust_wb1", code: "C-WB1", name: "試田 一郎", phone: "090-8801-0001", address: "玉名市試験町1-1", storeId: "tamana" });
  d.customers.push({ ...base, id: "cust_wb2", code: "C-WB2", name: "試野 二郎", phone: "090-8801-0002", address: "熊本市北区試西町2-2", storeId: "koshi" });
  d.customers.push({ ...base, id: "cust_wb3a", code: "C-WB3A", name: "試川 四郎", phone: "090-8801-0003", address: "熊本市中央区試北3-1", storeId: "nishi" });
  d.customers.push({ ...base, id: "cust_wb3b", code: "C-WB3B", name: "試川 五郎", phone: "090-8801-0004", address: "熊本市中央区試北3-9", storeId: "nishi" });
  const o = (id, number, customerId, storeId, salesDate) => ({ id, number, customerId, storeId, title: "畳", category: "tatami", contractDate: salesDate, salesDate, total: 10000, status: "completed", workerIds: [], progressNotes: [], createdBy: "system", createdAt: nowIso, updatedAt: nowIso });
  d.orders.push(o("ord_wb1", "O-2024-9901", "cust_wb1", "tamana", "2024-01-20"));
  d.orders.push(o("ord_wb2", "O-2024-9902", "cust_wb2", "koshi", "2024-02-15"));
  d.orders.push(o("ord_wb3a", "O-2024-9903", "cust_wb3a", "nishi", "2024-03-02"));
  d.orders.push(o("ord_wb3b", "O-2024-9904", "cust_wb3b", "nishi", "2024-03-10"));
  d.orders.push(o("ord_wb4", "O-2026-9905", "cust_wb2", "koshi", "2026-09-01"));
});
const testUsers = db().users;

/* ---------------- 架空のタブ (実際のシートと同じ並び) ---------------- */
const HEAD = ["", "年", "月", "店舗", "カテゴリー", "クレームor手直し", "内容", "原因", "対策（具体的に：気を付けますはNG）", "現場名", "発生由来"];
const oldClaims = csv([
  ["", "クレーム・手直し削減会議に活かす"],
  ["", "件数", "", "件数"],
  HEAD,
  ["", "2024年", "１月", "玉名", "精度", "手直し", "表が緩かった", "糸の締まりが緩い", "週 1 回テンションを確かめる", "（試験町）試田邸", ""],
  ["", "2024年", "１月", "玉名", "確認不足", "手直し", "襖の引手の付け忘れ", "確認を怠った", "積み込むときに確かめる", "（試験町）試田邸", ""],
  ["", "2024年", "３月", "合志", "確認不足", "クレーム", "音鳴り", "床板が平らでない", "敷き合わせで確かめる", "（試西）試野邸", ""],
  ["", "2024年", "３月", "合志", "確認不足", "手直し", "同上", "同上", "同上", "（試西）試野邸", ""],
  ["", "2024年", "３月", "西", "精度", "クレーム", "障子のめくれ", "張り方", "張り方を変える", "（試北）試川", "点検電話"],
  ["", "2024年", "8月", "中央", "説明不足", "クレーム", "ガラスの汚れ", "説明の不足", "詳しく説明する", "（試南）試梅", "クレームにはカウントしない"],
  ["クレームとしてはカウントしない", "2025年", "5月", "合志", "説明不足", "クレーム", "新品の畳の目割れ", "表が薄い", "可能性を伝える", "（試植）試沢", ""],
  ["", "2025年", "5月", "合志", "説明不足", "手直し", "同上", "同上", "同上", "（試植）試沢", ""],
  ["", "2025年", "２月", "合志", "確認不足", "", "ヘリの付け間違え", "思い込み", "製造前に伝票を確かめる", "【試坪】試坪幼稚園", ""],
  ["", "2025年", "10月", "事務", "その他", "クレーム", "キャンセルの伝達漏れ", "伝わっていない", "LINE とメモで重ねて伝える", "（試菊）試林", ""],
  ["", "2025年", "12月", "合志", "確認不足", "手直し", "畳新調の採寸の誤り", "読み違い", "四方を見る", "（試龍）試本", ""],
  ["", "2026年", "１月", "玉名", "", "手直し", "", "", "", "（試名）試北本", ""],
  ["", "2026年", "6月", "玉名", "", "", "", "", "", "（試滑）試上", ""],
]);
const newClaims = csv([
  ["", "クレーム・手直し削減会議に活かす"],
  HEAD,
  ["", "2025年", "12月", "合志", "確認不足", "手直し", "畳新調の採寸の誤り", "読み違い", "四方を見る", "（試龍）試本", ""],
  ["", "2026年", "１月", "玉名", "精度", "手直し", "畳の丈がきつい", "縮みを入れすぎた", "厚みを考える", "（試名）試北本", ""],
  ["", "2026年", "7月", "合志", "確認不足", "手直し", "虫の汚れがついていた", "隙間から入った", "面合わせで確かめる", "（試須）試田", ""],
  ["", "2026年", "9月", "合志", "精度", "クレーム", "角ジワ", "確認不足", "注文し直す", "（試西）試野邸", ""],
  ["", "", "", "", "", "", "", "", "", "", ""],
  ["", "2026年", "7月", "合志", "確認不足", "手直し", "虫の汚れが付いていた", "隙間から入った可能性", "ダブルチェック", "（試須）試田", ""],
  ["", "2026年", "10月", "合志", "", "クレーム", "", "", "", "（試弓）試遠", ""],
  ["", "2026年", "10月", "合志", "", "手直し", "", "", "", "", ""],
]);
const reviewsTab = csv([
  ["Google集計表"],
  ["下記の表にその都度事務が入力"],
  ["ひと月ごとに集計"],
  ["インセンティブの支払いは、末締め、翌月末支給（現金）"],
  ["事務入力日", "担当者", "ポイント", "お客様ニックネーム", "支払日", "確認者チェック", ""],
  ["1/30", "試験", "3", "ニック一", "2/29", "済", ""],
  ["2/7", "髙試", "2", "ニック二", "3/29", "済", ""],
  ["9/1", "試験", "2", "ニック三", "未払", "済", ""],
  ["11/15", "試北店長", "2", "ニック四", "12/27", "済", ""],
  ["11/17", "知らない人", "2", "ニック五", "ー", "済", ""],
  ["9/1", "試験", "2", "ニック三", "12/27", "済", "カウント済"],
  ["12/22", "光江", "1", "ニック六", "", "済", ""],
  ["1/10", "試験", "2", "ニック七", "2/27", "済", ""],
  ["3/5", "高試", "3", "ニック八", "－", "済", ""],
]);
const hTab = csv([
  ["アンケート集計\nＨ２６", "", "１３００台", "１４００台", "合計", ""],
  ["", "", "25/12～26/1", "26/2～3", "", ""],
  ["", "", "41", "46", "87", "47.1%"],
  ["電話応対", "大変不満", "0", "0", "0", ""],
  ["", "普通", "7", "8", "15", ""],
  ["", "満足", "16", "25", "41", ""],
  ["", "大変満足", "18", "13", "31", ""],
  ["", "", "", "", "87", ""],
  ["情報媒体", "リピーター", "8", "15", "23", "25%"],
  ["", "チラシ", "30", "26", "56", "69%"],
  ["", "ＨＰ", "2", "3", "5", "6%"],
  ["次回", "はい", "39", "45", "84", "99%"],
  ["", "いいえ", "1", "0", "1", ""],
]);
const rTab = csv([
  ["", "", "", "", "", "", "", "", "", "", "", "", ""],
  ["", "アンケート集計\nR２～３　工場", "", "7月", "8月", "合計", "", "", "アンケート集計\nR２～３　中央店", "", "7月", "8月", "合計"],
  ["", "", "", "31", "53", "84", "", "", "", "", "21", "14", "35"],
  ["", "電話応対", "満足", "27", "19", "46", "", "", "電話応対", "満足", "9", "5", "14"],
  ["", "", "大変満足", "4", "34", "38", "", "", "", "大変満足", "12", "9", "21"],
  ["", "情報媒体", "チラシ", "14", "30", "44", "", "", "情報媒体", "チラシ", "10", "5", "15"],
  ["", "", "", "", "", "", "", "", "", "", "", "", ""],
  ["", "アンケート集計\nR２～３　合計", "", "工場", "中央店", "西店", "玉名店", "合計"],
  ["", "", "", "84", "35", "0", "0", "119"],
]);
const kpiTab = csv([
  ["", "2025年", "集計期間：前年12/1～11/30", "", "※ハガキの項目については月ごとの入力必要なし"],
  ["", "項目", "対象", "累計", "12月", "1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "", "評価方法"],
  ["", "ハガキ返信率", "合志", "40.0%"],
  ["グーグル\nクチコミ", "試験", "件数", "2", "0", "1", "0", "0"],
  ["", "", "ポイント", "4", "0", "2", "0", "0"],
  ["クレーム", "合志", "件数", "1", "0", "0", "1", "0", "0", "0"],
  ["", "", "ポイント", "2", "0", "0", "2", "0", "0", "0"],
  ["", "手直し件数\n（＝ポイント）", "合志", "2", "1", "0", "0", "0", "0", "2"],
]);
const files = [
  { name: "お客様アンケート集計表 - クレーム手直し内容2024.1～.csv", text: oldClaims },
  { name: "お客様アンケート集計表 - クレーム手直し内容 2025.12～.csv", text: newClaims },
  { name: "お客様アンケート集計表 - Google口コミ集計.csv", text: reviewsTab },
  { name: "お客様アンケート集計表 - Ｈ26集計.csv", text: hTab },
  { name: "お客様アンケート集計表 - R2集計.csv", text: rTab },
  { name: "お客様アンケート集計表 - KPI.csv", text: kpiTab },
  { name: "お客様アンケート集計表 - H26コメント.csv", text: csv([["電話応対良い", "16", ""]]) },
];
const enc = new TextEncoder();
const { tabs, problems: readProblems } = RD.tabsFromFiles(files.map((f) => ({ name: f.name, bytes: enc.encode(f.text) })));

/* ================================================================== */
section("1. タブの見分け方・担当者の照合");
eq(tabs.map((t) => T.detectTab(t.title, t.rows)), ["claims", "claims", "reviews", "history", "history", "kpi", "comments"], "ファイル名のタブの名前で見分ける");
eq(T.tabTitleFromFileName("お客様アンケート集計表 - H29集計 .csv"), "H29集計", "ファイル名 → タブの名前 (後ろの空白を除く)");
eq(T.detectTab("", T.tabTitleFromFileName("x") && tabs[0].rows), "claims", "名前が分からないタブ (共有リンク) は中身で見分ける: クレーム");
eq(T.detectTab("", tabs[2].rows), "reviews", "中身で見分ける: 口コミ");
eq(T.detectTab("", tabs[3].rows), "history", "中身で見分ける: 集計表");
eq(readProblems, [], "CSV を読めた");
const match = S.staffMatcher(testUsers, {});
eq(match("試験").key, "u_wb_a", "姓だけで社員 1 人に決まる");
eq(match("高試").key, "u_wb_b", "旧字体 (髙) をそろえる");
eq(match("試北店長").key, "u_wb_c", "肩書き (店長) を除く");
eq(match("光江").key, "u_wb_d", "名だけでも 1 人に決まれば照合");
eq(match("知らない人").key, "name:知らない人", "当たらない名前はアカウントなし (name:)");
const m2 = S.staffMatcher(testUsers, { 知らない人: "u_wb_a", 光江: "-" });
eq([m2("知らない人").key, m2("光江").key], ["u_wb_a", ""], "対応表: 社員を選ぶ・数えない");
{
  const { aliases, errors } = S.parseAliasLines("知らない人 = 試験 太郎\n古い名前 = アカウントなし\n家族 = 数えない\nだれか = 存在しない 社員", testUsers);
  eq(aliases, { 知らない人: "u_wb_a", 古い名前: "name:古い名前", 家族: "-" }, "対応表の入力を読む");
  eq(errors.length, 1, "存在しない社員はエラー");
}
eq(Q.userName("name:知らない人"), "知らない人 (アカウントなし)", "アカウントのない人の名前の表示");
{
  // データ台帳 (source/) の扱い: タブごとの CSV はタブで扱いを分ける
  const REG = await imp("lib/registry/classify.ts");
  const dir = "02_お客様対応・アンケート/アンケート/お客様アンケート集計表（タブ別CSV 2026-11-21）/".normalize("NFKC");
  const c = (name) => REG.classifyPath(`${dir}お客様アンケート集計表 - ${name}`.normalize("NFKC"), "text");
  eq([c("クレーム手直し内容2024.1～.csv").action, c("クレーム手直し内容2024.1～.csv").importedTo], ["structured", "quality_issues (クレーム・手直し)"], "台帳: クレーム手直し内容 = 取込済みのデータ");
  eq(c("Google口コミ集計.csv").action, "structured", "台帳: Google口コミ集計 = 取込済みのデータ");
  eq([c("H29集計 .csv").action, c("4年比較.csv").action], ["structured", "structured"], "台帳: 集計表・4年比較 = 取込済みのデータ");
  eq([c("KPI.csv").action, c("KPI.csv").visibility], ["knowledge", "hq"], "台帳: KPI = 社内資料 (本部以上)");
  eq([c("クレーム手直し処理オペレーション .csv").action, c("クレーム手直し処理オペレーション .csv").visibility], ["knowledge", "manager"], "台帳: オペレーション = 社内資料 (店長以上)");
  eq([c("R4コメント .csv").action, c("R4コメント .csv").visibility], ["materials", "hq"], "台帳: コメント = 資料庫 (本部以上)");
  eq(REG.classifyPath("02_お客様対応・アンケート/アンケート/お客様アンケート集計表.xlsx", "spreadsheet").action, "materials", "台帳: .xlsx (全タブ) は資料庫だけ (社内資料に二重に入れない)");
}

/* ================================================================== */
section("2. クレーム手直し内容");
const p1 = C.parseClaimTab(tabs[0]);
const p2 = C.parseClaimTab(tabs[1]);
eq([p1.start, p2.start], ["2024-01", "2025-12"], "タブの期間の始まり (名前の 2024.1～ / 2025.12～)");
eq(p1.empty, 1, "区分も内容もない行は読まない");
const third = p1.rows.find((r) => r.kind === "rework" && r.year === 2024 && r.month === 3);
eq([third.description, third.cause, third.site], ["音鳴り", "床板が平らでない", "（試西）試野邸".normalize("NFKC")], "「同上」は上の行と同じ");
const { records, overlapSkipped } = C.buildClaimRecords([{ title: tabs[0].title, ...p1 }, { title: tabs[1].title, ...p2 }]);
eq(overlapSkipped, 2, "新しいタブの期間 (2025-12 から) の古いタブの行は読まない");
const rec = (ym, store, pick) => records.filter((r) => r.occurredOn.startsWith(ym) && r.storeId === store && (!pick || pick(r)));
eq(records.length, 13, "記録の件数 (組・重なり・二重の記入をまとめたあと)");
eq(rec("2024-01", "tamana").map((r) => r.kind), ["rework", "rework"], "同じ現場の別の手直しは 2 件");
eq(new Set(rec("2024-01", "tamana").map((r) => r.key)).size, 2, "同じ現場の 2 件は別の印");
const pair = rec("2024-03", "koshi")[0];
eq([pair.kind, pair.counted, pair.rows.length], ["claim_rework", true, 2], "クレームの次の「同上」の手直し → クレーム＋手直し 1 件");
const inspect = rec("2024-03", "nishi")[0];
eq([inspect.kind, inspect.counted, inspect.origin], ["claim", false, "点検電話"], "発生由来が点検電話 → 記録のみ (発生のきっかけは残す)");
const noCount = rec("2024-08", "chuo")[0];
eq([noCount.counted, noCount.origin], [false, undefined], "発生由来「クレームにはカウントしない」→ 記録のみ");
const flagged = rec("2025-05", "koshi")[0];
eq([flagged.kind, flagged.counted], ["rework", true], "「クレームとしてはカウントしない」の組 → 手直しとして数える");
const kindless = rec("2025-02", "koshi")[0];
eq([kindless.kind, kindless.counted, Boolean(kindless.review)], ["claim", true, true], "区分が空欄 → KPI のシートに合わせてクレームとして数え、要確認");
const office = records.find((r) => r.attribution === "office");
eq([office?.storeId, office?.kind], ["hq", "claim"], "事務の行 → 事務のポイント (店舗は本部)");
eq(rec("2026-01", "tamana")[0].description, "畳の丈がきつい", "重なる月は新しいタブの (書き足された) 行を使う");
const twin = rec("2026-07", "koshi")[0];
eq([rec("2026-07", "koshi").length, twin.rows.length], [1, 2], "同じ現場・ほぼ同じ内容の二重の記入は 1 件");
const blank = rec("2026-10", "koshi")[0];
eq([blank.kind, blank.description], ["claim_rework", "(内容はシートに未記入)"], "内容が未記入の組も数える");
eq(records.every((r) => r.sourceRef.startsWith("sheet:claims:")), true, "取込の印 (sourceRef)");
{
  const idx = C.orderIndex(db());
  eq(C.matchOrder(idx, rec("2024-01", "tamana")[0]).order?.number, "O-2024-9901", "現場名「（地区）名前邸」と店舗・月から案件を決める");
  eq(C.matchOrder(idx, pair).order?.number, "O-2024-9902", "4 か月前までの受注にひも付ける");
  eq(C.matchOrder(idx, inspect), { candidates: 2 }, "お客様が 2 人当たるときはひも付けない");
  eq(C.parseSiteName("（坪井）試工務店　試村様邸").names, ["試工務店", "試村"], "工務店とお客様の名前の両方を候補にする");
}

/* ================================================================== */
section("3. Google口コミ集計");
const rp = RV.parseReviewTab(tabs[2]);
eq(rp.rows.length, 9, "日付のある行を読む");
eq(RV.inferYears(rp.rows, "2025-06-01").startYear, 2024, "最後の行が今日から 1 年以内 → 最初の行は 2024 年");
eq(RV.inferYears(rp.rows, "2025-06-01", 2023).startYear, 2023, "最初の行の年を指定できる");
const built = RV.buildReviewRecords(rp.rows, match, { today: "2025-06-01" });
eq(built.records.length, 8, "再記入 (カウント済) を 1 件にまとめる");
const r9 = built.records.find((r) => r.reviewerName === "ニック三");
eq([r9.postedOn, r9.rows.length, /支払日: 2024-12-27/.test(r9.note), /未払/.test(r9.note)], ["2024-09-01", 2, true, false], "再記入は支払日のある方を残す");
eq(built.records.find((r) => r.reviewerName === "ニック一").note, "支払日: 2024-02-29 / 確認: 済", "うるう年の支払日 (2/29) が正しい日付になる");
eq(built.records.find((r) => r.reviewerName === "ニック七").postedOn, "2025-01-10", "12 月の次の 1 月は次の年");
eq(built.records.find((r) => r.reviewerName === "ニック七").note.startsWith("支払日: 2025-02-27"), true, "支払日の年");
eq(built.records.find((r) => r.reviewerName === "ニック八").note.startsWith("支給なし"), true, "支払日「－」= 支給なし");
eq(built.records.find((r) => r.reviewerName === "ニック五").staff.key, "name:知らない人", "アカウントのない担当者");
eq(built.records.find((r) => r.reviewerName === "ニック六").storeId, "hq", "担当者の店舗 (本部)");

/* ================================================================== */
section("4. アンケートの集計表");
const hp = H.parseHistoryTab(tabs[3], nowIso);
const hRow = (q, a) => hp.rows.find((r) => r.question === q && r.answer === a);
eq([hp.rows[0].question, hp.rows[0].count, hp.rows[0].fiscalLabel, hp.rows[0].startYear, hp.rows[0].storeId], ["回答数", 87, "H26", 2014, undefined], "平成の全社の表: 回答数 (はがきの枚数)");
eq(hRow("電話応対", "満足").count, 41, "期間の合計の列を読む");
ok(!hp.rows.some((r) => r.answer === ""  && r.question !== "回答数"), "小計の行 (回答が空欄) は読まない");
eq(hRow("情報媒体", "ＨＰ".normalize("NFKC")).count, 5, "情報媒体");
const col = H.historyColumn("H26", hp.rows);
eq([col.cards, col.scores["電話応対"].toFixed(3)], [87, (364 / 87).toFixed(3)], "評価の平均 (大変不満 1 〜 大変満足 5)");
const rp2 = H.parseHistoryTab(tabs[4], nowIso);
eq(rp2.blocks.map((b) => `${b.fiscalLabel}/${b.storeId}`), ["R2/koshi", "R2/chuo"], "令和の店舗の表 (工場 = 合志店)。合計の表は読まない");
eq(rp2.rows.find((r) => r.storeId === "chuo" && r.answer === "大変満足").count, 21, "右の表 (中央店) も読む");
eq(rp2.rows.find((r) => r.storeId === "koshi" && r.question === "回答数").count, 84, "店舗の表の回答数");
eq(H.parseHistoryTitle("R４～５　玉名店"), { fiscalLabel: "R4", startYear: 2022, store: "tamana" }, "見出しの年度と店舗");

/* ================================================================== */
section("5. 取込の計画 (確認) と KPI のタブとの照合");
const plan = PL.planWorkbook(db(), tabs, { today: "2026-11-21", startYear: 2024 });
eq(plan.problems, [], "問題なし");
eq([plan.claims.items.length, plan.claims.create, plan.claims.linked], [13, 13, 4], "クレーム・手直し: 13 件すべて新規・案件にひも付け 4 件");
eq([plan.reviews.items.length, plan.reviews.create, plan.reviews.startYear], [8, 8, 2024], "口コミ: 8 件すべて新規 (最初の行は 2024 年)");
ok(plan.warnings.some((w) => /知らない人/.test(w)), "アカウントのない名前を注意に出す");
ok(plan.warnings.some((w) => /2 人以上/.test(w)), "案件が決まらない行を注意に出す");
eq(plan.history.rows.length, hp.rows.length + rp2.rows.length, "集計表の行");
const ky = plan.kpi[0];
eq([ky.label, ky.period.from, ky.period.to], ["2025年", "2024-12-01", "2025-11-30"], "KPI の年度 (前年 12/1〜11/30)");
const kr = (metric, month) => ky.rows.find((r) => r.metric === metric && r.month === month);
eq([kr("claims", "2025-02")?.sheet, kr("claims", "2025-02")?.system, kr("claims", "2025-02")?.ok], [1, 1, true], "クレーム件数 (区分が空欄の行をクレームとして数えた) がシートと一致");
eq([kr("reviews", "2025-01")?.ok, kr("reviewPoints", "2025-01")?.ok], [true, true], "口コミの件数・ポイントがシートと一致");
eq([kr("rework", "2025-05")?.sheet, kr("rework", "2025-05")?.system, kr("rework", "2025-05")?.ok], [2, 1, false], "手直し件数の差を出す");
{
  const m = K.parseKpiTab(tabs[5]).years[0].months;
  eq([m[0], m[1], m.at(-1)], ["2024-12", "2025-01", "2025-11"], "12 月 = 前年の 12 月");
}

/* ================================================================== */
section("6. 取込 (2 回取り込んでも二重にならない・システムで変えた項目は残す)");
let res;
await store.mutate((d) => {
  res = PL.applyWorkbook(d, tabs, { today: "2026-11-21", startYear: 2024, userId: "system", label: "テスト" });
});
eq([res.claims.created, res.claims.linked, res.reviews.created], [13, 4, 8], "1 回目: 新規に登録");
const imported = db().qualityIssues.filter((q) => q.sourceRef?.startsWith("sheet:claims:"));
eq(imported.length, 13, "クレーム・手直しが増えた");
const cr = imported.find((q) => q.kind === "claim_rework" && q.siteName?.includes("試野"));
eq([cr.points, cr.status, cr.orderId, cr.occurredOn], [3, "resolved", "ord_wb2", "2024-03-01"], "クレーム＋手直し 3 点・原因と対策があれば解決済み・案件・月の 1 日");
ok(/^QC-2024-\d{4}$/.test(cr.number), "番号 (QC-年-連番)");
eq(db().reviews.filter((r) => r.sourceRef).length, 8, "口コミが増えた");
eq((db().surveyHistory ?? []).length, plan.history.rows.length, "集計表の行が増えた");
eq(PL.workbookSettings(db()).lastImport?.summary.includes("新規 13 件"), true, "前回の取込を残す");
await store.mutate((d) => {
  res = PL.applyWorkbook(d, tabs, { today: "2026-11-21", startYear: 2024, userId: "system", label: "テスト 2 回目" });
});
eq([res.claims.created, res.claims.updated, res.reviews.created, res.reviews.updated], [0, 0, 0, 0], "2 回目: 同じ内容は何も変わらない");
eq(db().qualityIssues.filter((q) => q.sourceRef?.startsWith("sheet:claims:")).length, 13, "二重にならない");
// システムで担当者と案件を付けたあと、シートの原因が変わった
const unlinked = db().qualityIssues.find((q) => q.sourceRef && q.siteName?.includes("試須"));
await store.mutate((d) => {
  const q = d.qualityIssues.find((x) => x.id === unlinked.id);
  q.responsibleUserIds = ["u_wb_a"];
  q.orderId = "ord_wb4";
});
const changedTabs = tabs.map((t) => (t.title.includes("2025.12") ? { ...t, rows: t.rows.map((r) => r.map((c) => (c === "面合わせで確かめる" ? "面合わせと積み込みの前に確かめる" : c))) } : t));
const plan2 = PL.planWorkbook(db(), changedTabs, { today: "2026-11-21", startYear: 2024 });
eq([plan2.claims.update, plan2.claims.create, plan2.claims.unchanged], [1, 0, 12], "シートで変わった行だけ更新");
await store.mutate((d) => {
  res = PL.applyWorkbook(d, changedTabs, { today: "2026-11-21", startYear: 2024, userId: "system", label: "テスト 3 回目" });
});
const after = db().qualityIssues.find((q) => q.id === unlinked.id);
eq([after.countermeasure.includes("積み込みの前"), after.responsibleUserIds, after.orderId], [true, ["u_wb_a"], "ord_wb4"], "シートの項目は更新・担当者と案件はシステムの値のまま");
{
  const k = KPI.storeKpi(db(), { from: "2024-03-01", to: "2024-03-31" }, "koshi");
  eq([k.claimReworkCount, k.qualityPoints], [1, 3], "取り込んだ記録が KPI (店舗のクレーム・手直し) に入る");
  const kn = KPI.storeKpi(db(), { from: "2024-03-01", to: "2024-03-31" }, "nishi");
  eq(kn.qualityPoints, 0, "記録のみ (点検電話) は KPI に入れない");
  const k2 = KPI.storeKpi(db(), { from: "2024-01-01", to: "2024-01-31" }, "tamana");
  eq(k2.claimCases, 0, "手直しだけはクレーム発生の件数に入れない");
  const k3 = KPI.storeKpi(db(), { from: "2026-10-01", to: "2026-10-31" }, "koshi");
  eq(k3.claimCases, 1, "案件のない記録もクレーム発生の件数に 1 件ずつ入る");
}
{
  const cols = CMP.surveyYearComparison(db(), { fiscalStartMonth: 12 });
  ok(cols.some((c) => c.label === "H26" && c.cards === 87) && cols.some((c) => c.label === "R2" && c.cards === 119), "年度ごとの比較: 平成の全社の表・令和は店舗の合計");
  const chuo = CMP.surveyYearComparison(db(), { storeId: "chuo", fiscalStartMonth: 12 });
  eq(chuo.filter((c) => c.source === "sheet").map((c) => `${c.label}:${c.cards}`), ["R2:35"], "店舗を選ぶとその店舗の表だけ (平成の全社の表は出さない)");
  ok(cols.find((c) => c.label === "H26").answers["情報媒体"]["以前頼んだことがある"] === 23 && cols.find((c) => c.label === "H26").answers["情報媒体"]["ホームページ"] === 5, "リピーター・ＨＰをシステムの選択肢の書き方にそろえる");
}

/* ================================================================== */
section("7. 画面の操作 (取込・案件を選ばずに登録・案件へのひも付け・LINE の報告)");
{
  const fileObjs = files.slice(0, 3).map((f) => new File([enc.encode(f.text)], f.name, { type: "text/csv" }));
  const denied = await act(koshiManager, () => wbActions.previewSurveyWorkbook(form({ source: "files", files: fileObjs })));
  ok(Boolean(denied.err) && /本部スタッフ・管理者/.test(denied.err), "取込は本部スタッフ・管理者だけ");
  const pv = await act(hqStaff, () => wbActions.previewSurveyWorkbook(form({ source: "files", files: fileObjs })));
  eq(pv.path, "/kpi/import", "確認 → 取込の画面に戻る");
  const hash = new URLSearchParams(pv.search).get("preview");
  ok(/^[0-9a-f]{24}$/.test(hash ?? ""), "確認の印 (hash)");
  ok(PL.workbookSettings(db()).preview?.hash === hash, "確認の内容を覚える");
  const ap = await act(hqStaff, () => wbActions.applySurveyWorkbook(form({ hash, startYear: "2024" })));
  ok(/取り込みました/.test(ap.msg ?? "") && /口コミ 新規 0 件/.test(ap.msg ?? ""), `取り込む (取り込み済みなので口コミは新規 0 件。古いタブの 2025-12 からは新しいタブがないので重なりなし): ${ap.msg ?? ap.err}`);
  eq(PL.workbookSettings(db()).startYear, 2024, "取込のときの最初の行の年を設定に残す");
  const again = await act(hqStaff, () => wbActions.applySurveyWorkbook(form({ hash })));
  ok(/見つかりません/.test(again.err ?? ""), "取り込んだ確認の内容は消える (同じ確認で 2 回取り込まない)");
  const bad = await act(admin, () => wbActions.saveSurveyWorkbookSettings(form({ sheetUrl: "https://example.com/x" })));
  ok(/docs.google.com/.test(bad.err ?? ""), "Google スプレッドシート以外の URL は受け付けない");
  const saved = await act(admin, () => wbActions.saveSurveyWorkbookSettings(form({ sheetUrl: "https://docs.google.com/spreadsheets/d/abcdefghijklmnopqrstuvwxyz012345/edit#gid=0", aliases: "知らない人 = 試験 太郎", autoSync: "on", startYear: "2024" })));
  ok(/保存しました/.test(saved.msg ?? ""), "つなぎ方の設定を保存");
  const s = PL.workbookSettings(db());
  eq([s.autoSync, s.staffAliases["知らない人"]], [true, "u_wb_a"], "定期の同期・担当者の名前の対応");
  const plan3 = PL.planWorkbook(db(), tabs, { today: "2026-11-21" });
  eq([plan3.reviews.update, plan3.reviews.create], [1, 0], "対応表を変えると、その名前の口コミだけ更新 (社員に付け替え。二重にしない)");
}
{
  const r1 = await act(koshiStaff, () => kpiActions.registerQualityIssue(form({ kind: "claim", occurredOn: "2026-11-10", description: "テストのクレーム" })));
  ok(/受注番号か現場名/.test(r1.err ?? ""), "受注番号も現場名もないときは登録しない");
  const r2 = await act(koshiStaff, () => kpiActions.registerQualityIssue(form({ kind: "claim", occurredOn: "2026-11-10", description: "テストのクレーム", siteName: "（試町）試客", storeId: "chuo" })));
  ok(Boolean(r2.err), "店舗のロールはほかの店舗の記録を登録できない");
  const r3 = await act(koshiStaff, () => kpiActions.registerQualityIssue(form({ kind: "claim", occurredOn: "2026-11-10", description: "テストのクレーム", siteName: "（試町）試客", storeId: "koshi", origin: "電話" })));
  ok(/登録しました/.test(r3.msg ?? ""), "現場名で登録 (案件なし)");
  const q = db().qualityIssues.find((x) => x.description === "テストのクレーム");
  eq([q.orderId, q.siteName, q.storeId, q.points, q.origin], [undefined, "（試町）試客", "koshi", 2, "電話"], "案件のない記録");
  const r4 = await act(koshiStaff, () => kpiActions.updateQualityIssue(q.id, form({ description: q.description, orderRef: "O-2099-0000" })));
  ok(/見つかりません/.test(r4.err ?? ""), "存在しない受注番号はひも付けない");
  const r5 = await act(koshiStaff, () => kpiActions.updateQualityIssue(q.id, form({ description: q.description, orderRef: "O-2026-9905" })));
  ok(/更新しました/.test(r5.msg ?? ""), "あとから受注番号でひも付ける");
  const q2 = db().qualityIssues.find((x) => x.id === q.id);
  eq([q2.orderId, q2.customerId], ["ord_wb4", "cust_wb2"], "案件とお客様が決まる");
  ok(db().orders.find((o) => o.id === "ord_wb4").progressNotes.some((n) => n.body.includes(q.number)), "案件の経過メモに残る");
  const log = db().auditLogs.filter((l) => l.entity === "quality" && l.entityId === q.id).at(-1);
  ok(log?.changes?.some((c) => c.field === "order" && c.after === "O-2026-9905"), "変更履歴に案件の変更 (受注番号)");
}

/* ================================================================== */
section("8. LINE グループの用途 (店舗別グループ・クレーム・手直し報告)");
const G_STORE = "C" + "a".repeat(32);
const G_QUAL = "C" + "b".repeat(32);
await store.mutate((d) => {
  const at = nowIso;
  const gs = LG.ensureLineGroup(d, G_STORE, "group", at);
  gs.name = "合志店グループ";
  const gq = LG.ensureLineGroup(d, G_QUAL, "group", at);
  gq.name = "クレーム手直し報告";
  for (let i = 0; i < 60; i++) gq.pending.push({ id: `m${i}`, at: new Date(Date.parse(at) + i * 1000).toISOString(), type: "text", text: i === 59 ? "（試町）試客 様 襖の引手が外れたと電話あり O-2026-9905" : `報告 ${i}` });
});
{
  const deny = await act(koshiManager, () => lineActions.setLineGroupPurpose(form({ groupId: G_STORE, purpose: "store", storeId: "koshi" })));
  ok(Boolean(deny.err), "用途の変更は管理者だけ");
  const need = await act(admin, () => lineActions.setLineGroupPurpose(form({ groupId: G_STORE, purpose: "store" })));
  ok(/店舗を選んで/.test(need.err ?? ""), "店舗別グループは店舗が必要");
  await act(admin, () => lineActions.setLineGroupPurpose(form({ groupId: G_STORE, purpose: "store", storeId: "koshi", notifyInquiries: "on" })));
  await act(admin, () => lineActions.setLineGroupPurpose(form({ groupId: G_QUAL, purpose: "quality" })));
  const gs = LG.findLineGroup(db(), G_STORE);
  const gq = LG.findLineGroup(db(), G_QUAL);
  eq([gs.purpose, gs.storeId, gs.notifyInquiries, gq.purpose, gq.storeId], ["store", "koshi", true, "quality", undefined], "用途と店舗を保存");
  eq(LG.pendingLimit(gq), 300, "用途のあるグループは 300 件まで残す");
  eq(gq.pending.length, 60, "残したメッセージ (50 件を超えても消さない)");
}
{
  const inq = { id: "inq_t", number: "INQ-2026-9999", storeId: "koshi", contactName: "試客 一", contactPhone: "090-0000-1111", category: "tatami", summary: "6 畳の表替え", detail: "", channel: "phone", receivedAt: nowIso };
  const out = SL.storeInquiryNotices(db(), inq);
  eq(out.map((o) => [o.channel, o.to]), [["line", G_STORE]], "店舗の問い合わせ → その店舗のグループに LINE");
  ok(out[0].body.includes("INQ-2026-9999") && out[0].body.includes("https://example.test/inquiries/inq_t") && out[0].body.includes("090-0000-1111"), "番号・電話・問い合わせへのリンク");
  eq(SL.storeInquiryNotices(db(), { ...inq, storeId: "chuo" }), [], "ほかの店舗の問い合わせは送らない");
  const before = db().deliveries.length;
  const r = await act(koshiStaff, () => inquiryActions.createInquiry(form({ summary: "LINE 通知のテスト", contactName: "試客 二", storeId: "koshi", channel: "phone", category: "tatami", media: "flyer" })));
  ok(r.path?.startsWith("/inquiries/"), `問い合わせを登録: ${r.msg ?? r.err}`);
  const d = db().deliveries.slice(before);
  ok(d.some((x) => x.channel === "line" && x.recipient === G_STORE && x.status === "skipped"), "登録すると店舗のグループへの送信を記録 (LINE の設定がないので送らずに記録のみ)");
}
{
  const visible = LG.pendingLineReports(db(), () => true);
  eq(visible.length, 60, "記録にしていない報告");
  eq(LG.pendingLineReports(db(), () => false).length, 0, "見られない人には出さない");
  const ref = LG.lineMessageRef(G_QUAL, "m59");
  const r1 = await act(koshiStaff, () => kpiActions.registerQualityIssue(form({ kind: "claim", occurredOn: "2026-11-12", description: "引手が外れた", orderRef: "O-2026-9905", lineRef: ref })));
  ok(/LINE の報告が見つかりません/.test(r1.err ?? ""), "店舗のないグループの報告は店長以上が記録にする");
  const r2 = await act(koshiManager, () => kpiActions.registerQualityIssue(form({ kind: "claim", occurredOn: "2026-11-12", description: "引手が外れた", orderRef: "O-2026-9905", lineRef: ref })));
  ok(/登録しました/.test(r2.msg ?? ""), "LINE の報告から記録にする");
  const qi = db().qualityIssues.find((x) => x.description === "引手が外れた");
  eq([qi.orderId, qi.origin, qi.storeId], ["ord_wb4", "LINE", "koshi"], "受注番号で案件にひも付き、発生のきっかけは LINE");
  const msg = LG.findLineGroup(db(), G_QUAL).pending.find((m) => m.id === "m59");
  eq([Boolean(msg.handledAt), msg.recordRef], [true, `quality:${qi.id}`], "報告は対応済み (作った記録を残す)");
  eq(LG.pendingLineReports(db(), () => true).length, 59, "対応済みの報告は一覧から消える");
  const d1 = await act(koshiManager, () => kpiActions.dismissLineReport(form({ lineRef: LG.lineMessageRef(G_QUAL, "m0"), reason: "重複" })));
  ok(/対応済み/.test(d1.msg ?? ""), "対応不要にする");
  eq(LG.findLineGroup(db(), G_QUAL).pending.find((m) => m.id === "m0").recordRef, "dismissed:重複", "対応不要の理由を残す");
  await store.mutate((dd) => {
    const g = LG.findLineGroup(dd, G_QUAL);
    for (let i = 60; i < 320; i++) g.pending.push({ id: `m${i}`, at: nowIso, type: "text", text: `報告 ${i}` });
    LG.trimPending(g);
  });
  const g = LG.findLineGroup(db(), G_QUAL);
  ok(g.pending.length === 300 && !g.pending.some((m) => m.id === "m0" || m.id === "m59"), "件数を超えたら対応済みのものから消す");
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log("  ✗", f);
  process.exitCode = 1;
}
fs.rmSync(work, { recursive: true, force: true });
