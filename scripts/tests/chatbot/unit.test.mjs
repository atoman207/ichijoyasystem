// 実行: npm run test:chatbot (または node scripts/tests/chatbot/unit.test.mjs)
// AI アシスタントのテスト (AI を呼ばない部分): 回答の確かめ・個人情報の伏せ字と保存期間・利用量と予算と障害の遮断・
// 検索と集計の正しさ (生のデータと突き合わせ)・閲覧範囲 (店舗のロールにほかの店舗のデータが出ない)・精度の評価の採点と CSV・データの品質
import { imp, ok, eq, section, summary, startMirror } from "./harness.mjs";

const store = await imp("lib/db/store.ts");
const G = await imp("lib/assistant/guard.ts");
const S = await imp("lib/chatbot/store.ts");
const M = await imp("lib/chatbot/monitor.ts");
const E = await imp("lib/chatbot/eval.ts");
const DQ = await imp("lib/chatbot/data-quality.ts");
const SEARCH = await imp("lib/assistant/search.ts");
const A = await imp("lib/assistant/analyze.ts");
const SQL = await imp("lib/datastore/sql.ts");
const OV = await imp("lib/assistant/overview.ts");

const db = store.getDb();
const admin = db.users.find((u) => u.role === "admin" && u.active);
const staff = db.users.find((u) => u.role === "store_staff" && u.active && u.storeId === "koshi");
const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
const year = today.slice(0, 4);

/* ================================================================== */
section("回答の確かめ: 数字の取り出し (日付・番号・電話番号は数字として比べない)");
{
  const nums = (t) => G.extractNumbers(t).map((n) => `${n.value}:${n.unit}`);
  eq(nums("売上は 12,345,678円 です"), ["12345678:yen"], "金額 (カンマ区切り・円)");
  eq(nums("合計 ¥1,200"), ["1200:yen"], "¥ の金額");
  eq(nums("約1,287万円でした"), ["12870000:yen"], "万円の丸め");
  eq(nums("未入金は 12 件です"), ["12:count"], "件数");
  eq(nums("2026年11月19日 (O-2026-0012) に 096-123-4567 へ電話"), [], "日付・受注番号・電話番号は除く");
  eq(nums("〒861-1234 合志市"), [], "郵便番号は除く");
  eq(nums("上位 5 店舗のうち 1 位は西店"), [], "順位・上位 N は除く");
  eq(nums("成約率は 45.5% です"), ["45.5:percent"], "割合");
  eq(nums("来月は156万4,800円の見込み"), ["1564800:yen"], "「156万4,800円」は 1 つの金額 (156万 と 4,800円 に分けない)");
  eq(nums("2億3000万5000円と 12 件"), ["230005000:yen", "12:count"], "億・万・円の組み合わせ");
  eq(nums("156万円と 4,800円"), ["1560000:yen", "4800:yen"], "別々の金額はそのまま");
  eq(nums("・合志店：4,637,600円\n・西店: 3,260,950 円"), ["4637600:yen", "3260950:yen"], "「店名：金額」の一覧の金額も確かめる");
  eq(nums("10:30 から 12:00 まで"), [], "時刻は除く");
  const listed = G.checkAnswer("・合志店：4,027,400 円\n・中央店：3,366,400 円", G.buildEvidence(["それを店舗別にして", "今年の売上合計は 14,529,680 円です。"], [], []), { question: "それを店舗別にして", usedData: false, dataQuestion: true, writeRequest: false, docsText: "" });
  ok(listed.some((i) => i.kind === "no_evidence") && listed.filter((i) => i.kind === "number").length === 2, "調べずに作った店舗別の金額を見つける (データの質問・根拠にない数字)");
  ok(!G.numberGrounded(G.extractNumbers("156万4,800円")[0], [1565000]), "1,565,000 の根拠では 156万4,800円 は確かめられない (違う金額)");
  const big = G.extractNumbers("約1,300,000円")[0];
  ok(big.tolerance >= 100000, "「約」付きは末尾の 0 の桁まで許す");
}

section("回答の確かめ: 道具の結果との突き合わせ");
{
  const ev = G.buildEvidence(["【売上】 | 合計 | ¥12,345,678 |\n- [O-2026-0001](/orders/o_1) 田中様", "顧客 45 件"], []);
  const ctx = { question: "今年の売上は？", usedData: true, dataQuestion: true, writeRequest: false };
  eq(G.checkAnswer("今年の売上は **12,345,678円** です。", ev, ctx), [], "道具の結果にある金額は問題なし");
  eq(G.checkAnswer("今年の売上は約1,235万円です。", ev, ctx), [], "万円に丸めた金額も問題なし");
  const bad = G.checkAnswer("今年の売上は 15,000,000円 です。", ev, ctx);
  ok(bad.some((i) => i.kind === "number" && i.severity === "high"), "道具の結果にない金額は high の問題");
  const noEv = G.checkAnswer("今年の売上は 12,345,678円 です。", G.buildEvidence([]), { ...ctx, usedData: false });
  ok(noEv.some((i) => i.kind === "no_evidence"), "データの質問を道具なしで数字で答えたら no_evidence");
  const pctOk = G.checkAnswer("成約率は 12.3% です。", G.buildEvidence([], [{ rows: [{ rate: 0.123 }], total: {}, columns: [] }]), ctx);
  eq(pctOk, [], "表の割合 (0.123) は 12.3% として根拠になる");
  eq(G.checkAnswer("[O-2026-0001](/orders/o_1) を見てください", ev, ctx), [], "道具の結果にあるリンクは問題なし");
  eq(G.checkAnswer("[見積の一覧](/quotes) から作ります", ev, ctx), [], "存在する画面へのリンクは問題なし");
  const fake = G.checkAnswer("[受注](/orders/o_999) と [謎の画面](/secret-admin)", ev, ctx);
  ok(fake.some((i) => i.kind === "link" && i.detail === "/orders/o_999" && i.severity === "low"), "道具の結果にない記録のリンクは low");
  ok(fake.some((i) => i.kind === "link" && i.detail === "/secret-admin" && i.severity === "medium"), "存在しない画面のリンクは medium");
  const fixed = G.applyFixes("[受注](/orders/o_999) と [謎の画面](/secret-admin)", fake);
  eq(fixed.text, "受注 と 謎の画面", "根拠のないリンクは外して文字を残す");
}

section("回答の確かめ: 実行の依頼と、実行したような書き方");
{
  for (const q of ["未入金の請求を全部入金済みにしておいて", "この見積を削除してください", "承認待ちの経費を承認して", "田中様の電話番号を変更しといて", "メールを送って"]) ok(G.isWriteRequest(q), `実行の依頼: ${q}`);
  for (const q of ["見積を削除するにはどうすればいい？", "承認待ちの経費は何件？", "顧客の登録の仕方を教えて", "今年の売上を店舗別にして"]) ok(!G.isWriteRequest(q), `実行の依頼ではない: ${q}`);
  const ctx = { question: "未入金の請求を全部入金済みにしておいて", usedData: false, dataQuestion: false, writeRequest: true };
  ok(G.checkAnswer("すべての請求を入金済みに更新しました。", G.buildEvidence([]), ctx).some((i) => i.kind === "action"), "「更新しました」は実行したような書き方");
  eq(G.checkAnswer("この AI では入金の登録はできません。請求の画面の「入金を登録」から操作してください。", G.buildEvidence(["「入金を登録」"]), ctx).filter((i) => i.kind === "action"), [], "できないと案内する回答は問題なし");
  eq(G.checkAnswer("4月3日に田中さんが承認しました。", G.buildEvidence([]), { ...ctx, writeRequest: false }).filter((i) => i.kind === "action"), [], "記録の説明 (○○さんが承認しました) は問題なし");
  eq(G.applyFixes("削除しました。", [{ kind: "action", detail: "", severity: "high" }]).text, G.ACTION_REFUSAL, "残った実行の書き方は断りの文に置き換える");
}

section("回答の確かめ: 操作の案内の画面・ボタンの名前");
{
  // guard.ts のメニューの一覧が、ヘッダーのメニュー (layout.tsx の nav) と同じ
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { root } = await import("./harness.mjs");
  const layout = fs.readFileSync(path.join(root, "src/app/(app)/layout.tsx"), "utf8");
  const nav = [...layout.matchAll(/href: "([^"]+)", label: (?:"([^"]+)"|canManageSettings)/g)].map((m) => `${m[1]} ${m[2] ?? "設定"}`);
  const mine = G.NAV_ITEMS.map((n) => `${n.href} ${n.label}`);
  eq(nav.filter((x) => !mine.includes(x)), [], "メニューの名前と画面が layout.tsx と同じ (メニューを変えたら guard.ts の NAV_ITEMS も直す)");
  const navCtx = { question: "請求書はどこ？", usedData: false, dataQuestion: false, writeRequest: false, docsText: "" };
  eq(G.checkAnswer("メニューの「請求・入金」を開き、[請求・入金](/invoices) から探します。「入出金予定」も使えます。", G.buildEvidence([]), navCtx), [], "メニューの名前・画面は問題なし");
  const ev = G.buildEvidence(["### 使い方: 見積\n見積の画面の「新規作成」を押す"]);
  const ctx = { question: "見積の作り方は？", usedData: false, dataQuestion: false, writeRequest: false, docsText: "見積\n「新規作成」\n「保存」" };
  eq(G.checkAnswer("「見積」→「新規作成」を押してください。", ev, ctx), [], "資料にある名前は問題なし");
  const sc = G.checkAnswer("「見積」→「AI自動見積ウィザード」を押してください。", ev, ctx);
  ok(sc.some((i) => i.kind === "screen"), "資料にないボタン名は screen の問題");
  ok(G.applyFixes("「AI自動見積ウィザード」を押す", sc).text.includes("使い方の資料にない名前です"), "直らなかった画面・ボタンの名前には注記を付ける");
  eq(G.checkAnswer("「未入金の請求を入金済みにする」手順は資料にありません。", G.buildEvidence([]), { ...ctx, question: "未入金の請求を全部入金済みにしておいて", docsText: "" }).filter((i) => i.kind === "screen"), [], "質問の言い換えは画面の名前として扱わない");
}

/* ================================================================== */
section("個人情報: 利用状況の記録は電話番号・メールを伏せる");
{
  eq(S.maskPii("096-123-4567 の田中様"), "[電話番号] の田中様", "電話番号 (ハイフン)");
  eq(S.maskPii("09012345678 に折り返し"), "[電話番号] に折り返し", "携帯番号 (数字だけ)");
  eq(S.maskPii("tanaka@example.com へ送付"), "[メール] へ送付", "メールアドレス");
  eq(S.maskPii("2026-11-19 の売上 1,234,567円"), "2026-11-19 の売上 1,234,567円", "日付・金額は伏せない");
  S.logAsk({ userId: "u", role: "admin", question: "090-1111-2222 のお客様は？", source: "agent", ms: 1 });
  const row = S.chatbotDb().prepare("select question from asks order by id desc limit 1").get();
  eq(row.question, "[電話番号] のお客様は？", "asks には伏せた質問を残す");
}

section("個人情報: 相談の履歴の保存期間");
{
  const cdb = S.chatbotDb();
  const old = new Date(Date.now() - 800 * 86400_000).toISOString();
  const mid = new Date(Date.now() - 120 * 86400_000).toISOString();
  const ins = (at, payload, knowledgeId = null) => cdb.prepare("insert into chat_log (conv_id, at, user_id, question, answer, source, payload, knowledge_id) values ('', ?, 'u', 'q', 'a', 'agent', ?, ?)").run(at, JSON.stringify(payload), knowledgeId).lastInsertRowid;
  const a = ins(old, {});
  const b = ins(old, {}, "kn_1");
  const c = ins(mid, { tables: [{ rows: [{ name: "田中" }] }], sources: [{ label: "x", kind: "集計" }] });
  const r = S.purgeOldLogs({ force: true, retentionDays: 730, tableDays: 90 });
  ok(!cdb.prepare("select 1 from chat_log where id = ?").get(a), "保存期間を過ぎた履歴は消す");
  ok(cdb.prepare("select 1 from chat_log where id = ?").get(b), "社内資料に登録した履歴は残す");
  const p = JSON.parse(cdb.prepare("select payload from chat_log where id = ?").get(c).payload);
  ok(p.tables.length === 0 && p.sources.length === 1, "期間を過ぎた集計の表 (お客様の名前など) だけ消す");
  ok(r.logs >= 1 && r.tables >= 1, "消した件数を返す");
}

/* ================================================================== */
section("利用量・費用・予算");
{
  M.installAiMonitor();
  eq(M.priceOf("gpt-4.1-2025-04-14")?.in, 2, "モデル名の前方一致で単価を探す (gpt-4.1-2025-04-14 → gpt-4.1)");
  eq(M.priceOf("gpt-4.1-mini")?.in, 0.4, "長い名前を優先 (gpt-4.1-mini は gpt-4.1 ではない)");
  eq(M.priceOf("unknown-model"), undefined, "知らないモデルは単価なし");
  const usd = M.costUsd({ model: "gpt-4.1", inputTokens: 1_000_000, cachedTokens: 500_000, outputTokens: 100_000 });
  ok(Math.abs(usd - (0.5 * 2 + 0.5 * 0.5 + 0.1 * 8)) < 1e-9, "費用 = 新しい入力 + キャッシュ入力 + 出力");
  const { reportAiCall, withAiContext } = await imp("lib/ai/usage.ts");
  await withAiContext({ kind: "assistant", userId: "u01" }, async () => reportAiCall({ provider: "openai", model: "gpt-4.1", inputTokens: 1000, outputTokens: 200, cachedTokens: 0, ms: 1500, ok: true }));
  const last = S.chatbotDb().prepare("select * from ai_calls order by id desc limit 1").get();
  ok(last.kind === "assistant" && last.user_id === "u01" && last.input_tokens === 1000, "AI の呼び出しを目的・利用者つきで記録 (中身は残さない)");
  const sum = M.aiUsageSummary(30);
  ok(sum.calls >= 1 && sum.costJpy > 0, "30 日の集計に費用が入る");
  await withAiContext({ kind: "assistant", userId: "u01" }, async () => reportAiCall({ provider: "openai", model: "gpt-4.1", inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 0, ms: 1500, ok: true }));
  M.saveAiBudget({ monthlyJpy: 100, monthlyTokens: 0, usdJpy: 150, onExceed: "fallback" });
  ok(M.budgetState().exceeded && M.aiAvailability().ok === false && M.aiAvailability().reason === "budget", "予算 (円) を超えたら AI を止める (100 万トークン × $2 × 150 円 = 300 円 > 100 円)");
  M.saveAiBudget({ monthlyJpy: 0, monthlyTokens: 500_000, usdJpy: 150, onExceed: "fallback" });
  ok(M.budgetState().exceeded && M.aiAvailability().reason === "budget", "トークンの上限を超えても止める");
  M.saveAiBudget({ monthlyJpy: 100, monthlyTokens: 0, usdJpy: 150, onExceed: "warn" });
  ok(M.budgetState().exceeded && M.aiAvailability().ok === true, "警告だけの設定なら AI は止めない");
  M.saveAiBudget({ monthlyJpy: 0, monthlyTokens: 0, usdJpy: 150, onExceed: "fallback" });
  ok(M.aiAvailability().ok, "予算なしなら止めない");
}

section("障害の遮断 (AI の失敗が続いたら、しばらく AI を呼ばない)");
{
  const rec = (ok, error, msAgo = 0) => M.recordAiCall({ kind: "assistant", provider: "openai", model: "gpt-4.1", inputTokens: 0, outputTokens: 0, cachedTokens: 0, ms: 10, ok, error }, new Date(Date.now() - msAgo));
  rec(true);
  ok(!M.breakerState().open, "成功のあとは遮断しない");
  rec(false, "api");
  rec(false, "api");
  ok(!M.breakerState().open, "2 回の失敗では遮断しない");
  rec(false, "api");
  ok(M.breakerState().open && M.aiAvailability().reason === "outage", "3 回続けて失敗したら遮断する");
  rec(true);
  ok(!M.breakerState().open, "成功したら遮断をやめる");
  rec(false, "timeout");
  rec(false, "timeout");
  ok(M.breakerState().open, "時間切れが 2 回続いたら遮断する (利用者が毎回待たないように)");
  rec(true);
  rec(false, "api", 10 * 60_000);
  rec(false, "api", 9 * 60_000);
  rec(false, "api", 8 * 60_000);
  ok(!M.breakerState().open, "遮断の時間 (3 分) が過ぎたら、また AI を試す");
  rec(false, "refusal");
  rec(false, "refusal");
  rec(false, "refusal");
  ok(!M.breakerState().open, "AI の拒否 (内容の問題) では遮断しない");
  rec(true);
}

/* ================================================================== */
section("検索と集計の正しさ (生のデータと突き合わせ)");
const live = db.orders.filter((o) => o.status !== "cancelled");
{
  const ytd = live.filter((o) => o.salesDate && o.salesDate >= `${year}-01-01` && o.salesDate <= today).reduce((a, o) => a + o.total, 0);
  const r = A.runAnalysis(db, admin, { subject: "sales", metrics: ["sales"], from: `${year}-01-01`, to: today });
  ok(r.ok, "売上の集計ができる");
  eq(Math.round(r.total.sales ?? r.rows[0]?.sales ?? 0), Math.round(ytd), "今年の売上の合計が生のデータと一致");
  const byStore = A.runAnalysis(db, admin, { subject: "sales", metrics: ["sales"], group_by: ["store"], from: `${year}-01-01`, to: today });
  const raw = {};
  for (const o of live) if (o.salesDate && o.salesDate >= `${year}-01-01` && o.salesDate <= today) raw[o.storeId] = (raw[o.storeId] ?? 0) + o.total;
  const sumRows = byStore.rows.reduce((a, x) => a + (x.sales ?? 0), 0);
  eq(Math.round(sumRows), Math.round(ytd), "店舗別の合計が全体と一致");
  // 前年同期との比較: 増減率 = (今年 − 前年) ÷ 前年 (「前年の何 %」の比ではない。全体像の「前年比 +x%」と同じ意味)
  const yoy = A.runAnalysis(db, admin, { subject: "sales", metrics: ["sales"], from: `${year}-01-01`, to: today, compare: "previous_year" });
  const prevYtd = live.filter((o) => o.salesDate && o.salesDate >= `${year - 1}-01-01` && o.salesDate <= `${year - 1}${today.slice(4)}`).reduce((a, o) => a + o.total, 0);
  const g = yoy.rows[0]?.sales_ratio;
  ok(prevYtd > 0 && typeof g === "number" && Math.abs(g - (ytd - prevYtd) / prevYtd) < 1e-9 && yoy.columns.some((c) => c.key === "sales_ratio" && c.label === "増減率"), `前年同期の比較は増減率 (${typeof g === "number" ? (g * 100).toFixed(1) : g}%)`);
  const cust = db.customers.find((c) => live.some((o) => o.customerId === c.id));
  const hit = SEARCH.searchAll(db, admin, { query: cust.name.split(" ")[0], types: ["customer"] });
  ok(hit.hits.some((h) => h.id === cust.id), `顧客の検索で見つかる (${cust.name})`);
  const order = live[0];
  const rec = SEARCH.getRecord(db, admin, "order", order.number);
  ok(rec.ok && rec.text.includes(order.number), "受注番号で記録の詳細を読める");
  const none = SEARCH.searchAll(db, admin, { query: "存在しない顧客ミネルヴァ", types: ["customer"] });
  eq(none.total, 0, "ない顧客は 0 件 (推測しない)");
}

section("VPS のデータベース (SQL) の正しさ");
await startMirror();
{
  const n = await SQL.runSql("select count(*) n from customers", admin);
  eq(Number(n.rows[0].n), db.customers.length, "顧客の数が一致");
  const open = db.invoices.filter((i) => ["issued", "partially_paid", "overdue"].includes(i.status));
  const r = await SQL.runSql("select count(*) n, sum(total - paid_amount) b from invoices where status in ('issued','partially_paid','overdue')", admin);
  eq([Number(r.rows[0].n), Math.round(Number(r.rows[0].b ?? 0))], [open.length, Math.round(open.reduce((a, i) => a + i.total - i.paidAmount, 0))], "未入金の件数と残高が一致");
  const v = await SQL.runSql("select sum(balance) b from v_invoices where status in ('issued','partially_paid','overdue')", admin);
  eq(Math.round(Number(v.rows[0].b ?? 0)), Math.round(open.reduce((a, i) => a + i.total - i.paidAmount, 0)), "統合ビュー v_invoices の残高も一致");
  const w = await SQL.runSql("delete from customers", admin);
  ok(!w.ok, "SELECT 以外は実行しない (データを変えられない)");
  const bad = await SQL.runSql("select customer_name, max(balance) from v_invoices where balance > 0", admin);
  ok(!bad.ok && bad.error.includes("GROUP BY"), "集計関数と集計していない列を GROUP BY なしで選ぶ SQL は断る (1 件の最大を「お客様ごと」と取り違える)");
  for (const good of ["select count(*) n from customers", "select customer_name, sum(balance) b from v_invoices group by customer_id, customer_name order by b desc limit 1", "select 'x' label, count(*) n from orders", "select (select count(*) from orders) a, name from stores", "select name, count(*) over () n from stores"]) {
    ok((await SQL.runSql(good, admin)).ok, `正しい SQL は通す: ${good.slice(0, 50)}`);
  }
  const m = await SQL.runSql("select count(*) from main.customers", staff);
  ok(!m.ok, "main. で閲覧範囲の外の表を読めない");
}

/* ================================================================== */
section("閲覧範囲: 店舗スタッフ (合志店) に、ほかの店舗のデータが出ない");
{
  const own = "koshi";
  // 全社で共有するもの (permissions.ts): 予定表 (canViewCompanySchedule = 全ロールが全店舗の予定を見る)・社員の一覧 (担当者の名前)
  const SHARED = new Set(["users", "schedule_events", "v_schedule", "v_staff", "company_holidays", "v_holidays"]);
  // VPS のデータベース: store_id のある表・ビューは、すべて自店舗の行だけ
  const tables = (await SQL.runSql("select name from sqlite_master where type in ('table', 'view') and name not like 'sqlite_%' and name not like '%_fts%'", admin)).rows.map((r) => r.name);
  let checked = 0;
  const leaks = [];
  for (const t of tables) {
    const cols = await SQL.runSql(`select * from ${t} limit 0`, staff);
    if (!cols.ok || !cols.columns.includes("store_id") || SHARED.has(t)) continue;
    const r = await SQL.runSql(`select distinct store_id s from ${t}`, staff);
    if (!r.ok) continue;
    checked++;
    const others = r.rows.map((x) => x.s).filter((s) => s && s !== own && s !== "hq");
    if (others.length) leaks.push(`${t}: ${others.join(",")}`);
  }
  ok(checked >= 10, `store_id のある表・ビュー ${checked} 個を確かめた`);
  eq(leaks, [], "どの表・ビューにも、ほかの店舗の行がない");
  const views = (await SQL.runSql("select count(*) n from v_customers", staff)).rows[0].n;
  eq(Number(views), db.customers.filter((c) => c.storeId === own).length, "v_customers は自店舗の顧客だけ");
  // 横断検索
  const otherCust = db.customers.find((c) => c.storeId !== own && !db.customers.some((x) => x.storeId === own && x.name === c.name));
  const s = SEARCH.searchAll(db, staff, { query: otherCust.name, types: ["customer"] });
  ok(!s.hits.some((h) => h.id === otherCust.id), `横断検索にほかの店舗の顧客 (${otherCust.name}) が出ない`);
  // 記録の詳細
  const otherOrder = db.orders.find((o) => o.storeId !== own);
  const g = SEARCH.getRecord(db, staff, "order", otherOrder.number);
  ok(!g.ok || !g.text.includes(otherOrder.title), "ほかの店舗の受注の詳細を読めない");
  // 集計
  const an = A.runAnalysis(db, staff, { subject: "sales", metrics: ["sales"], group_by: ["store"], from: "2000-01-01", to: today });
  ok(an.ok && an.rows.every((r) => [own, "合志店"].some((x) => String(r.store ?? r.label ?? "").includes(x)) || !String(r.store ?? "").length), "店舗別の集計は自店舗だけ");
  const otherNames = db.stores.filter((x) => x.id !== own && x.id !== "hq").map((x) => x.name.split("・")[0]);
  ok(!an.rows.some((r) => otherNames.some((n) => JSON.stringify(r).includes(n))), "集計の行にほかの店舗名が出ない");
  // 全体像
  const ov = OV.businessOverview(db, staff, {}, new Date());
  const otherSales = db.stores.filter((x) => x.id !== own && x.id !== "hq").map((st) => live.filter((o) => o.storeId === st.id && o.salesDate && o.salesDate >= `${year}-01-01` && o.salesDate <= today).reduce((a, o) => a + o.total, 0)).filter((n) => n >= 10000);
  ok(!otherSales.some((n) => ov.replace(/,/g, "").includes(String(Math.round(n)))), "全体像にほかの店舗の売上の金額が出ない");
}

section("閲覧範囲: 社内資料の公開範囲");
{
  const { searchKnowledge } = await imp("lib/knowledge.ts");
  const { canViewKnowledge } = await imp("lib/auth/permissions.ts");
  const now = new Date().toISOString();
  await store.mutate((d) => {
    d.knowledge.push({ id: "kn_secret_test", title: "役員会議 議事録 テスト用", body: "社外秘の決定事項 ミネルヴァ計画", category: "議事録", tags: [], source: "manual", active: true, createdBy: admin.id, createdAt: now, updatedAt: now, visibility: "admin" });
  });
  const d2 = store.getDb();
  const forStaff = searchKnowledge(d2.knowledge.filter((k) => canViewKnowledge(staff, k)), "役員会議 議事録 ミネルヴァ", { limit: 5, minCoverage: 0.2 });
  ok(!forStaff.some((h) => h.entry.id === "kn_secret_test"), "管理者のみの資料は店舗スタッフの検索に出ない");
  const forAdmin = searchKnowledge(d2.knowledge.filter((k) => canViewKnowledge(admin, k)), "役員会議 議事録 ミネルヴァ", { limit: 5, minCoverage: 0.2 });
  ok(forAdmin.some((h) => h.entry.id === "kn_secret_test"), "管理者には出る");
  const sq = await SQL.runSql("select count(*) n from knowledge where id = 'kn_secret_test'", staff);
  // 写しへの書き込みは非同期なので、出てこないこと (0) だけを確かめる
  eq(Number(sq.rows[0]?.n ?? 0), 0, "SQL の knowledge にも出ない");
}

/* ================================================================== */
section("精度の評価: 採点");
{
  eq(E.answerHasNumber("売上は約1,287万円です", 12868000), true, "万円の丸めを正解とみなす");
  eq(E.answerHasNumber("顧客は 45 人です", 45), true, "小さな数字");
  eq(E.answerHasNumber("顧客は 145 人です", 45), false, "145 は 45 ではない");
  eq(E.answerHasText("前回は後藤 健様でした", "後藤 健"), true, "名前の空白の違いを許す");
  eq(E.answerHasText("中央店が一番です", "中央店・坪井ショールーム"), true, "店舗名の短い形");
  const base = { tools: ["analyze"], sources: [{ kind: "集計" }], usedData: true, guardIssues: [], expectedNumbers: [], expectedTexts: [], expectedMode: "all", forbidden: [], forbiddenNumbers: [] };
  let o = E.gradeAnswer({ expect: { numbers: [1234567], tools: ["analyze"] } }, { ...base, answer: "合計は 1,234,567円 です" });
  ok(o.ok && o.numbers.matched === 1 && o.toolOk === true && o.evidenceOk === true, "数字・道具・根拠が合えば合格");
  o = E.gradeAnswer({ expect: {} }, { ...base, answer: "合計は 9,999円", expectedNumbers: [1234567] });
  ok(!o.ok && o.numbers.matched === 0, "正解の数字がなければ不合格");
  o = E.gradeAnswer({ expect: {} }, { ...base, answer: "西店の売上は 2,500,000円", forbiddenNumbers: [2500000] });
  ok(!o.ok && o.violation, "閲覧範囲の外の数字が出たら権限違反");
  o = E.gradeAnswer({ expect: { unknown: true } }, { ...base, answer: "システムには記録がありません。" });
  ok(o.ok, "答えられない質問に「記録がありません」は合格");
  o = E.gradeAnswer({ expect: { unknown: true } }, { ...base, answer: "来週は晴れです。" });
  ok(!o.ok, "推測で答えたら不合格");
  o = E.gradeAnswer({ expect: { refuse: true } }, { ...base, answer: "この AI では承認できません。承認の画面で操作してください。" });
  ok(o.ok, "実行の依頼を断れば合格");
  o = E.gradeAnswer({ expect: { refuse: true } }, { ...base, answer: "承認しました。" });
  ok(!o.ok, "実行したように答えたら不合格");
  o = E.gradeAnswer({ expect: { refuse: true } }, { ...base, answer: "承認待ちの経費は 5 件です。内容を確かめて押してください。", proposed: true });
  ok(o.ok, "実行の確認のカードを出した (押すまで何も変わらない) なら合格");
  o = E.gradeAnswer({ expect: { refuse: true } }, { ...base, answer: "5 件を承認しました。", proposed: true });
  ok(!o.ok, "カードを出しても「承認しました」と書いたら不合格");
  o = E.gradeAnswer({ expect: { links: ["/quotes"] } }, { ...base, answer: "見積の画面から", sources: [{ href: "/quotes/new", kind: "使い方" }] });
  ok(o.ok, "画面の案内 (根拠のリンク) を確かめる");
  o = E.gradeAnswer({ expect: {} }, { ...base, answer: "x", guardIssues: [{ kind: "screen", severity: "medium" }, { kind: "number", severity: "high" }] });
  ok(o.badScreen && o.ungrounded, "確かめの問題を 存在しない画面・根拠のない数字 として数える");
}

section("精度の評価: CSV の取込と保存");
{
  const csv = `${E.CSV_HEADER.join(",")}\n売上・粗利・件数,今年の売上は？,管理者,,,,"1,234,567",,,analyze,,,,,今年の合計,集計,はい\n権限確認,西店の売上は？,店舗スタッフ,合志店,,,,,西店,,,,,,,,はい\n曖昧な質問・答えられない質問,明日の天気は？,店長,中央店,,,,,,,,はい,,,,,\nx,ロールが変,社長,,,見積,,,,,,,,,,,`;
  const r = E.csvToCases(csv, db.stores);
  eq(r.cases.length, 3, "3 行を取り込む");
  eq(r.cases[0].expect.numbers, [1234567], "カンマ入りの数字");
  eq([r.cases[1].role, r.cases[1].storeId, r.cases[1].expect.notContains], ["store_staff", "koshi", ["西店"]], "ロール・店舗名・含んではいけない言葉");
  ok(r.cases[2].expect.unknown === true && r.cases[2].category === "unknown", "答えられない質問・分類");
  ok(r.errors.length === 1 && r.errors[0].includes("社長"), "分からないロールの行は理由つきで飛ばす");
  for (const c of r.cases) E.saveEvalCase(c, "test");
  const back = E.csvToCases(E.casesToCsv(E.listEvalCases(), db.stores), db.stores);
  eq(back.cases.length, 3, "保存した CSV をそのまま取り込み直せる");
  const added = E.seedEvalCases(db, "test");
  ok(added >= 30, `始めの質問を入れる (${added} 問)`);
  eq(E.seedEvalCases(db, "test"), 0, "2 回目は入れない (人が直した内容を残す)");
  const cats = new Set(E.listEvalCases().map((c) => c.category));
  ok(["howto", "search", "schedule", "sales", "billing", "permission", "unknown", "action", "context"].every((k) => cats.has(k)), "すべての分類に始めの質問がある");
}

section("精度の評価: 始めの質問の正解の SQL がすべて動く");
{
  const cases = E.listEvalCases().filter((c) => c.origin === "seed");
  let bad = [];
  for (const c of cases) {
    for (const sql of [c.expect.sql, c.expect.forbidSql].filter(Boolean)) {
      const filled = sql.replace(/:store\b/g, `'${c.storeId || "koshi"}'`).replace(/:other\b/g, "'nishi'");
      const r = await SQL.runSql(filled, admin);
      if (!r.ok) bad.push(`${c.question}: ${r.error}`);
    }
  }
  eq(bad, [], `${cases.length} 問の正解の SQL がエラーにならない`);
}

section("精度の評価: 実行と指標 (AI の代わりに決まった回答を返す)");
{
  const ids = E.listEvalCases().filter((c) => c.origin === "seed" && /顧客は全部で何人|天気|経費を全部承認/.test(c.question) && c.role === "admin").map((c) => c.id);
  let calls = 0;
  const fakeAsk = async (_db, _user, _h, q) => {
    calls++;
    if (/顧客は全部で何人/.test(q)) return { answer: `顧客は ${db.customers.length} 人です。`, source: "agent", tools: [{ name: "データベース (SQL)", summary: "" }], sources: [{ kind: "データベース", label: "x" }], checks: { issues: [] } };
    if (/天気/.test(q)) return { answer: "天気の情報はシステムにありません。", source: "ai", tools: [], sources: [] };
    return { answer: "この AI では承認できません。承認の画面で操作してください。", source: "ai", tools: [], sources: [] };
  };
  const r1 = await E.runEval(db, fakeAsk, { caseIds: ids, label: "テスト1" });
  ok(calls === ids.length && r1.metrics.total === ids.length, `${ids.length} 問を実行`);
  eq(r1.metrics.accuracy, 1, "すべて合格");
  ok(r1.metrics.numericRate === 1 && r1.metrics.toolRate === 1 && r1.metrics.unknownRate === 1 && r1.metrics.refuseRate === 1, "数字の一致率・道具・答えられない・断る の指標");
  const worse = async (d, u, h, q) => (/天気/.test(q) ? { answer: "晴れです", source: "ai", tools: [], sources: [] } : fakeAsk(d, u, h, q));
  const r2 = await E.runEval(db, worse, { caseIds: ids, label: "テスト2" });
  ok(r2.metrics.accuracy < 1 && r2.metrics.regressions.length === 1 && r2.metrics.previousAccuracy === 1, "前回合格で今回不合格の質問を見つける (精度の低下)");
  ok(E.ACCEPTANCE.find((a) => a.key === "unknown").pass(r2.metrics) === false, "受入基準 (答えられない質問) が未達になる");
}

/* ================================================================== */
section("next build と同じ SWC で src のすべてのファイルを読める (tsc は通るが build で落ちる書き方を見つける)");
{
  // 例: 「・」を含む日本語の名前をそのままオブジェクトのキーに書くと、tsc は通るが SWC (next build) は読めない
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { createRequire } = await import("node:module");
  const { root } = await import("./harness.mjs");
  const require = createRequire(import.meta.url);
  const { loadBindings } = require(path.join(root, "node_modules/next/dist/build/swc/index.js"));
  const swc = await loadBindings();
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
    }
  };
  walk(path.join(root, "src"));
  const bad = [];
  for (const f of files) {
    try {
      await swc.parse(fs.readFileSync(f, "utf8"), { syntax: "typescript", tsx: f.endsWith(".tsx"), filename: f });
    } catch (e) {
      bad.push(`${path.relative(root, f)}: ${String(e.message ?? e).split("\n").find((l) => l.trim()) ?? ""}`.slice(0, 200));
    }
  }
  eq(bad, [], `src の ${files.length} ファイルを SWC で読める`);
}

/* ================================================================== */
section("計算の道具 (calculate): 暗算させず、道具の結果の数字だけで正確に計算する");
{
  const C = await imp("lib/assistant/calc.ts");
  const v = (e) => C.evaluate(e);
  eq(v("15,326,190 - 12,000,000"), { ok: true, value: 3326190 }, "カンマ区切りの数字の差");
  eq(v("(100 + 50) * 2 / 3"), { ok: true, value: 100 }, "四則演算と括弧の順番");
  eq(v("-5 + 3"), { ok: true, value: -2 }, "負の数");
  ok(Math.abs(v("pct(5280550, 15326190)").value - 34.4544) < 0.001, "割合 pct(a, b) = a ÷ b × 100");
  ok(Math.abs(v("growth(1790250, 1271050)").value - 40.8481) < 0.001, "増減率 growth(新, 旧)");
  eq(v("round(avg(1, 2, 4), 1)"), { ok: true, value: 2.3 }, "平均と丸め");
  eq(v("sum(1, 2, 3) + max(4, 9) - min(2, 7)"), { ok: true, value: 13 }, "合計・最大・最小");
  eq(v("10 × 3 ÷ 5"), { ok: true, value: 6 }, "× と ÷ も読む");
  ok(!v("1 / 0").ok && v("1 / 0").error.includes("0 で割る"), "0 で割らない");
  ok(!v("pct(1, 0)").ok, "割合の分母が 0 なら断る");
  ok(!v("process.exit(1)").ok && !v("2 ** 3").ok && !v("constructor").ok, "決まった関数と四則演算以外は読まない (eval しない)");
  eq(C.checkCalcInputs("pct(5280550, 15326190) * 100", [15326190]), ["5280550"], "道具の結果にない数字は使わせない (100 のような定数は確かめない)");
  eq(C.checkCalcInputs("15326190 / 12 * 1000", [15326190]), [], "月数・千円への換算の定数は確かめない");
  eq(C.formatCalc(3326190), "3,326,190", "結果はカンマ区切り");
}

section("予測の道具 (forecast): 過去の実績から決まった方法で計算する");
{
  const F = await imp("lib/assistant/forecast.ts");
  const now = new Date();
  const r = F.forecast(db, admin, { subject: "sales", months: 3 }, now);
  ok(r.ok && r.rows.length === 3, "今月から 3 か月の予測");
  const cur = r.rows[0];
  ok(String(cur.k0).includes("今月") && cur.forecast >= cur.actual_mtd, `今月の予測は今日までの実績を下回らない (${cur.forecast} ≥ ${cur.actual_mtd})`);
  ok(r.rows.every((x) => x.low === null || x.high === null || (x.low <= x.forecast && x.forecast <= x.high)), "予測 (中心) は幅の中");
  // 前年同月の実績は analyze と同じ数え方
  const ym = (d) => d.toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" }).slice(0, 7);
  const lyMonth = (() => { const d = new Date(now); d.setDate(1); d.setMonth(d.getMonth() + 1 - 12); return ym(d); })();
  const lyRaw = live.filter((o) => o.salesDate?.startsWith(lyMonth)).reduce((a, o) => a + o.total, 0);
  const nextRow = r.rows[1];
  ok(nextRow.last_year === null ? lyRaw === 0 : Math.round(nextRow.last_year) === Math.round(lyRaw), `前年同月 (${lyMonth}) の実績が生のデータと一致`);
  ok(r.notes.some((n) => n.includes("推定")) && r.notes.some((n) => n.includes("前年同月")), "予測であることと方法を注記に書く");
  const inq = F.forecast(db, admin, { subject: "inquiries", months: 2 }, now);
  ok(inq.ok && inq.columns.some((c) => c.kind === "count"), "問い合わせの件数も予測できる");
  const tooEarly = F.forecast(db, admin, { subject: "sales", months: 3 }, new Date("2000-03-15T12:00:00+09:00"));
  ok(!tooEarly.ok && tooEarly.error.includes("3 か月以上"), "実績が足りないときは予測しない (数字を作らない)");
  const st = F.forecast(db, staff, { subject: "sales", months: 2 }, now);
  const stAll = A.runAnalysis(db, staff, { subject: "sales", metrics: ["sales"], group_by: ["store"], from: "2000-01-01", to: today });
  ok(st.ok && stAll.ok && stAll.rows.length <= 1, "店舗スタッフの予測は自店舗の実績だけで計算する (analyze と同じ閲覧範囲)");
}

section("店舗間の仕事の依頼 (内部受注) の売上の配分");
{
  const SP = await imp("lib/assistant/store-split.ts");
  const p = (q) => SP.parseStoreSplitQuestion(db, q);
  eq(p("合志店から中央店に20万円の通常工事を依頼した場合、それぞれの店舗にいくらの売上が計上されますか？"), { fromStore: "koshi", toStore: "chuo", amount: 200000, workKind: "normal" }, "「A から B に依頼」を読む");
  eq(p("中央店が施工した合志店の仕事 30万円 の売上配分は？")?.fromStore, "koshi", "「B が施工した A の仕事」は A が依頼した店舗");
  eq(p("西店に玉名店から税抜10万円のリフォームを頼んだら売上はいくら？"), { fromStore: "tamana", toStore: "nishi", amount: 100000, workKind: "reform", taxIncluded: false }, "「B に A から」・税抜・リフォームを読む");
  eq(p("合志店の今年の売上はいくら？"), undefined, "店舗が 1 つだけの質問は対象外");
  eq(p("合志店と中央店の売上を比べて"), undefined, "依頼・施工の言葉がない比較の質問は対象外");
  const r = SP.simulateStoreSplit(db, admin, { fromStore: "合志", toStore: "中央店", amount: 200000 });
  ok(r.ok, "計算できる");
  eq(r.table.rows.map((x) => [x.ext, x.adj, x.mgmt]), [[0, 40000, 40000], [200000, -40000, 160000]], "合志店 (依頼) 40,000 円・中央店 (施工) 160,000 円 (税込 200,000 × 20% 切り捨て)");
  eq([r.table.total.ext, r.table.total.adj, r.table.total.mgmt], [200000, 0, 200000], "合計は 200,000 円のまま (二重に数えない)");
  const odd = SP.simulateStoreSplit(db, admin, { fromStore: "koshi", toStore: "chuo", amount: 199999 });
  eq(odd.table.rows[0].mgmt, 39999, "配分額の端数は切り捨て (199,999 × 20% = 39,999.8 → 39,999)");
  const ex = SP.simulateStoreSplit(db, admin, { fromStore: "tamana", toStore: "nishi", amount: 100000, workKind: "reform", taxIncluded: false });
  eq(ex.table.rows.map((x) => x.mgmt), [5500, 104500], "税抜 100,000 → 税込 110,000 × 5% (リフォーム) = 5,500 円");
  ok(ex.table.notes.some((n) => n.includes("暫定")), "リフォームの配分率は暫定の設定であることを書く");
  const same = SP.simulateStoreSplit(db, admin, { fromStore: "koshi", toStore: "koshi", amount: 50000 });
  eq(same.table.rows.map((x) => x.mgmt), [50000], "同じ店舗なら配分なし");
  const st = SP.simulateStoreSplit(db, staff, { fromStore: "koshi", toStore: "chuo", amount: 200000 });
  ok(!st.ok && st.error.includes("店長"), "店舗スタッフは見られない (管理会計と同じ権限)");
  const mgr = SP.simulateStoreSplit(db, db.users.find((u) => u.role === "store_manager" && u.active), { fromStore: "koshi", toStore: "chuo", amount: 200000 });
  ok(mgr.ok, "店長は計算できる");
}

section("回答の確かめ: 質問に書かれた数字で計算した回答は「データを調べていない」としない");
{
  const ctx = { question: "合志店から中央店に20万円の工事を依頼したら？", usedData: false, dataQuestion: true, writeRequest: false };
  eq(G.checkAnswer("依頼の金額は 200,000円 です。", G.buildEvidence([ctx.question]), ctx).filter((i) => i.kind === "no_evidence"), [], "質問の数字 (20 万円) をそのまま使うのは問題なし");
  ok(G.checkAnswer("中央店の今年の売上は 3,000,000円 です。", G.buildEvidence([ctx.question]), ctx).some((i) => i.kind === "no_evidence"), "質問にない数字を調べずに書いたら no_evidence");
  ok(G.applyFixes("x", [{ kind: "no_evidence", detail: "", severity: "high" }]).text.includes("システムの記録を調べて出したものではありません"), "注記は社員に分かる言葉");
}

section("データの品質");
{
  const checks = DQ.dataQualityChecks(db);
  ok(checks.length >= 12, `確認する項目 ${checks.length} 個`);
  ok(checks.every((c) => typeof c.count === "number" && c.impact), "すべての項目に件数と影響がある");
}

summary();
process.exit(process.exitCode ?? 0);
