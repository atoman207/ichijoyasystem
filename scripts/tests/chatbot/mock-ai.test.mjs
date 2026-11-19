// 実行: npm run test:chatbot (または node scripts/tests/chatbot/mock-ai.test.mjs)
// AI アシスタントのテスト (AI はモックのサーバー。本物の OpenAI・Claude には接続しない):
// 道具の呼び出しの流れ・回答の確かめと確かめ直し・実行の依頼・API の障害と上限超過のときの答え方・障害の遮断・予算・
// 会話の続き・AI に渡すデータの閲覧範囲 (店舗のロールのほかの店舗のデータを AI に渡さない)・ログイン前・Claude
import http from "node:http";
import { imp, ok, eq, section, summary, startMirror } from "./harness.mjs";

/* ---------------- モックの AI (OpenAI chat completions / Anthropic messages) ---------------- */
let handler = () => ({ status: 500, body: { error: { message: "no handler" } } });
const requests = [];
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    let body = {};
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      /* */
    }
    const entry = { path: req.url, body, raw };
    requests.push(entry);
    const r = await handler(entry);
    res.writeHead(r.status ?? 200, { "content-type": "application/json", ...(r.headers ?? {}) });
    res.end(JSON.stringify(r.body));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const usage = { prompt_tokens: 1200, completion_tokens: 150, prompt_tokens_details: { cached_tokens: 200 } };
const oaText = (text) => ({ body: { id: "c", model: "gpt-4.1", choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }], usage } });
let tcSeq = 0;
const oaTools = (calls) => ({ body: { id: "c", model: "gpt-4.1", choices: [{ message: { role: "assistant", content: null, tool_calls: calls.map((c) => ({ id: `call_${++tcSeq}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) }, finish_reason: "tool_calls" }], usage } });
const msgs = (e) => e.body.messages ?? [];
const lastRole = (e) => msgs(e).at(-1)?.role;
const allText = (e) => JSON.stringify(e.body);

function switchToOpenAi() {
  for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"]) delete process.env[k];
  Object.assign(process.env, { OPENAI_API_KEY: "sk-test-mock", OPENAI_BASE_URL: `${base}/v1`, OPENAI_MODEL: "gpt-4.1" });
}
function switchToClaude() {
  for (const k of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"]) delete process.env[k];
  Object.assign(process.env, { ANTHROPIC_API_KEY: "sk-ant-test-mock", ANTHROPIC_BASE_URL: base });
}
switchToOpenAi();

const store = await imp("lib/db/store.ts");
const { askChatbot } = await imp("lib/chatbot/answer.ts");
const S = await imp("lib/chatbot/store.ts");
const M = await imp("lib/chatbot/monitor.ts");
const G = await imp("lib/assistant/guard.ts");
await startMirror();
M.installAiMonitor();

const db = store.getDb();
const admin = db.users.find((u) => u.role === "admin" && u.active);
const staff = db.users.find((u) => u.role === "store_staff" && u.active && u.storeId === "koshi");
const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
const year = today.slice(0, 4);
const live = db.orders.filter((o) => o.status !== "cancelled");
const ytd = live.filter((o) => o.salesDate && o.salesDate >= `${year}-01-01` && o.salesDate <= today).reduce((a, o) => a + o.total, 0);
const ytdText = `${Math.round(ytd).toLocaleString("ja-JP")}円`;
const resetBreaker = () => M.recordAiCall({ kind: "assistant", provider: "openai", model: "gpt-4.1", inputTokens: 0, outputTokens: 0, cachedTokens: 0, ms: 1, ok: true });
const aiCallsSince = (id) => S.chatbotDb().prepare("select * from ai_calls where id > ? order by id").all(id);
const lastCallId = () => Number(S.chatbotDb().prepare("select coalesce(max(id), 0) n from ai_calls").get().n);
const analyzeArgs = { subject: "sales", metrics: ["sales"], from: `${year}-01-01`, to: today };

/* ================================================================== */
section("道具の呼び出し (OpenAI): 集計してから答える");
{
  requests.length = 0;
  const c0 = lastCallId();
  handler = (e) => (lastRole(e) === "tool" ? oaText(`${year}年 1 月 1 日〜今日の売上合計は **${ytdText}** です。`) : oaTools([{ name: "analyze", args: analyzeArgs }]));
  const r = await askChatbot(db, admin, [], "今年の売上合計はいくらですか？");
  eq(requests.length, 2, "AI とのやりとりは 2 回 (道具 → 回答)");
  ok(r.answer.includes(ytdText), `回答に集計の金額 (${ytdText})`);
  eq(r.source, "agent", "データの回答 (agent)");
  ok(r.tables?.length === 1 && r.sources?.length >= 1, "表と根拠を画面に出す");
  eq(r.checks?.issues ?? [], [], "確かめで問題なし");
  const tools = requests[0].body.tools.map((t) => t.function.name);
  const READ_ONLY = ["search_records", "get_record", "list_schedule", "analyze", "management_accounting", "business_overview", "search_guides", "search_history", "suggest_schedule", "plan_schedule", "day_route", "schedule_holds", "schedule_setup", "describe_database", "query_database"];
  ok(tools.every((t) => READ_ONLY.includes(t)) && !tools.some((t) => /create|update|delete|approve|send|write|insert|register|pay/i.test(t)), `AI に渡す道具は読み取りだけ (${tools.length} 個)`);
  const calls = aiCallsSince(c0);
  ok(calls.length === 2 && calls.every((c) => c.kind === "assistant" && c.ok === 1 && c.input_tokens === 1200 && c.cached_tokens === 200), "AI の呼び出しをトークン数つきで記録 (目的 = AI アシスタント)");
  const log = S.listChatLogs({ scope: "self", userId: admin.id, limit: 1 }).rows[0];
  ok(log && log.question === "今年の売上合計はいくらですか？" && log.payload.provider?.startsWith("openai"), "相談の履歴に残す (接続先つき)");
}

section("回答の確かめ: 根拠のない数字は AI に確かめ直させる");
{
  requests.length = 0;
  handler = (e) => {
    if (allText(e).includes("回答の下書きを確かめたところ")) return oaText(`売上合計は ${ytdText} です。`);
    return lastRole(e) === "tool" ? oaText("売上合計は 99,999,999円 です。") : oaTools([{ name: "analyze", args: analyzeArgs }]);
  };
  const r = await askChatbot(db, admin, [], "今年の売上合計はいくらですか？");
  ok(r.checks?.retried === true, "確かめ直しをさせた");
  ok(r.answer.includes(ytdText) && !r.answer.includes("99,999,999"), "直した回答 (集計の金額) を使う");
  ok(requests.some((x) => allText(x).includes("99,999,999") && allText(x).includes("道具の結果のどこにもありません")), "どの数字に根拠がないかを AI に伝える");
}

section("回答の確かめ: 直らない数字には注記を付ける");
{
  handler = (e) => (lastRole(e) === "tool" || allText(e).includes("回答の下書き") ? oaText("売上合計は 99,999,999円 です。") : oaTools([{ name: "analyze", args: analyzeArgs }]));
  const r = await askChatbot(db, admin, [], "今年の売上合計はいくらですか？");
  ok(r.answer.includes("確かめられませんでした"), "確かめられない数字に注記");
  ok(r.checks?.issues.some((i) => i.kind === "number") && r.checks?.fixed.length >= 1, "問題と直したことを残す (履歴・品質の画面)");
}

section("実行の依頼: 実行したように答えさせない");
{
  requests.length = 0;
  handler = () => oaText("承知しました。未入金の請求をすべて入金済みに更新しました。");
  const r = await askChatbot(db, admin, [], "未入金の請求を全部入金済みにしておいて");
  ok(requests[0] && allText(requests[0]).includes("これはデータを変える依頼です"), "AI に実行できないことを先に伝える");
  eq(r.answer, G.ACTION_REFUSAL, "それでも実行したように答えたら、実行できないことの案内に置き換える");
  ok(!r.answer.includes("更新しました"), "「更新しました」を出さない");
}

section("回答の確かめ: 存在しない画面・道具の結果にない記録へのリンクを外す");
{
  handler = () => oaText("[受注](/orders/o_fake_999) か [管理の画面](/secret-admin-page) を開いてください。");
  const r = await askChatbot(db, admin, [], "見積の画面で印刷の余白を変えるには？ (テスト 7f)", { evaluation: true });
  ok(!r.answer.includes("](/orders/o_fake_999)") && !r.answer.includes("](/secret-admin-page)"), "根拠のないリンクを外す");
  ok(r.answer.includes("受注") && r.answer.includes("管理の画面"), "リンクの文字は残す");
}

/* ================================================================== */
section("API の障害: AI なしで答える (集計・検索・資料) と、障害の遮断");
{
  resetBreaker();
  requests.length = 0;
  const c0 = lastCallId();
  handler = () => ({ status: 500, body: { error: { message: "server error" } } });
  const r1 = await askChatbot(db, admin, [], "今年の店舗別の売上を教えて");
  ok(r1.answer.includes("AI の応答が得られなかった") && r1.degraded === "error", "失敗したことを伝え、AI なしで答える");
  ok(r1.tables?.length === 1 && r1.source === "analysis", "集計は言葉の決まりで表にする (AI がなくても数字は出る)");
  ok(aiCallsSince(c0).some((c) => c.ok === 0 && c.error === "api"), "失敗を記録 (種類 = api)");
  await askChatbot(db, admin, [], "今月の売上を教えて");
  await askChatbot(db, admin, [], "先月の売上を教えて");
  ok(M.breakerState().open, "3 回続けて失敗したら遮断する");
  const before = requests.length;
  const t0 = Date.now();
  const r4 = await askChatbot(db, admin, [], "今年の売上を店舗別に教えて");
  eq(requests.length, before, "遮断中は AI を呼ばない");
  ok(r4.answer.includes("AI に接続できない状態が続いている") && r4.degraded === "outage", "遮断中であることを伝える");
  ok(Date.now() - t0 < 5000, `遮断中はすぐに答える (${Date.now() - t0}ms)`);
  const doc = await askChatbot(db, admin, [], "経費の申請のしかたを教えて");
  ok(doc.answer.length > 20 && doc.source !== "agent", `操作の案内も AI なしで答える (${doc.source})`);
  resetBreaker();
  ok(!M.breakerState().open, "成功の記録で遮断をやめる");
}

section("API の上限超過 (残高・利用枠) とキーの誤り");
{
  resetBreaker();
  const c0 = lastCallId();
  handler = () => ({ status: 429, body: { error: { message: "You exceeded your current quota", code: "insufficient_quota", type: "insufficient_quota" } } });
  const r = await askChatbot(db, admin, [], "今年の売上を店舗別に教えて");
  ok(r.tables?.length === 1 && r.degraded === "error", "上限超過でも集計は表で答える");
  ok(aiCallsSince(c0).some((c) => c.error === "quota"), "失敗の種類 = quota");
  await askChatbot(db, admin, [], "今月の売上を教えて");
  const b = M.breakerState();
  ok(b.open && new Date(b.until).getTime() - Date.now() > 20 * 60_000, "残高・上限の失敗が続いたら長め (30 分) に遮断");
  resetBreaker();
  handler = () => ({ status: 401, body: { error: { message: "Incorrect API key" } } });
  const c1 = lastCallId();
  await askChatbot(db, admin, [], "今年の売上を店舗別に教えて");
  ok(aiCallsSince(c1).some((c) => c.error === "auth"), "キーの誤りを記録 (種類 = auth)");
  resetBreaker();
}

section("今月の予算を超えたら AI を呼ばない");
{
  M.recordAiCall({ kind: "assistant", provider: "openai", model: "gpt-4.1", inputTokens: 5_000_000, outputTokens: 0, cachedTokens: 0, ms: 1, ok: true });
  M.saveAiBudget({ monthlyJpy: 100, monthlyTokens: 0, usdJpy: 150, onExceed: "fallback" });
  const before = requests.length;
  const r = await askChatbot(db, admin, [], "今年の売上を店舗別に教えて");
  eq(requests.length, before, "予算超過中は AI を呼ばない");
  ok(r.answer.includes("今月の AI の利用の上限") && r.degraded === "budget" && r.tables?.length === 1, "上限に達したことを伝え、集計は表で答える");
  M.saveAiBudget({ monthlyJpy: 0, monthlyTokens: 0, usdJpy: 150, onExceed: "fallback" });
}

/* ================================================================== */
section("会話の続き: 前の集計の条件を AI に渡す");
{
  resetBreaker();
  requests.length = 0;
  handler = (e) => (lastRole(e) === "tool" ? oaText("店舗別の売上を表にしました。") : oaTools([{ name: "analyze", args: { ...analyzeArgs, group_by: ["store"] } }]));
  const spec = { subject: "sales", metrics: ["sales"], from: `${year}-01-01`, to: today };
  const r = await askChatbot(db, admin, [{ role: "user", content: "今年の売上合計は？" }, { role: "assistant", content: `今年の売上合計は ${ytdText} です。`, specs: [spec] }], "それを店舗別にして");
  const sent = msgs(requests[0]);
  ok(sent.some((m) => m.role === "user" && m.content === "今年の売上合計は？") && sent.some((m) => m.role === "assistant" && String(m.content).includes("[分析条件:")), "前の質問と集計の条件を渡す");
  ok(r.tables?.length === 1 && r.tables[0].rows.length >= 2, "店舗別の表を出す");
}

/* ================================================================== */
section("閲覧範囲: 店舗スタッフの質問で、ほかの店舗のデータ・公開範囲の外の資料を AI に渡さない");
{
  const now = new Date().toISOString();
  await store.mutate((d) => {
    d.knowledge.push({ id: "kn_secret_mock", title: "役員会議 議事録 テスト用", body: "社外秘の決定事項 ミネルヴァ計画", category: "議事録", tags: [], source: "manual", active: true, createdBy: admin.id, createdAt: now, updatedAt: now, visibility: "admin" });
  });
  const d = store.getDb();
  const ownNames = new Set(d.customers.filter((c) => c.storeId === "koshi").map((c) => c.name));
  // 予定表は全社で共有する (permissions.ts の canViewCompanySchedule)。予定の件名・場所にある名前は画面でも全員に見えるので除く
  const sharedText = d.schedule.map((e) => `${e.title} ${e.memo ?? ""} ${e.location ?? ""}`).join("\n");
  const otherOnly = d.customers.filter((c) => c.storeId !== "koshi" && !ownNames.has(c.name) && !sharedText.includes(c.name)).map((c) => c.name);
  const otherCust = otherOnly[0];
  const otherOrder = d.orders.find((o) => o.storeId !== "koshi");
  requests.length = 0;
  handler = (e) =>
    lastRole(e) === "tool"
      ? oaText("確認しました。")
      : oaTools([
          { name: "search_records", args: { query: otherCust } },
          { name: "search_records", args: { query: "", types: ["customer", "order", "invoice"], limit: 40 } },
          { name: "get_record", args: { type: "order", ref: otherOrder.number } },
          { name: "analyze", args: { subject: "sales", metrics: ["sales"], group_by: ["store", "customer"], from: "2000-01-01", to: today, limit: 200 } },
          { name: "query_database", args: { sql: "select name, store_id from customers", title: "顧客" } },
          { name: "query_database", args: { sql: "select title, body from knowledge", title: "資料" } },
          { name: "query_database", args: { sql: "select customer_name, store_id from v_invoices", title: "請求" } },
          { name: "business_overview", args: {} },
          { name: "search_guides", args: { query: "役員会議 議事録 ミネルヴァ" } },
        ]);
  await askChatbot(d, staff, [], "お客様と請求と社内資料をいろいろ調べて");
  const toolMsgs = requests.flatMap((x) => msgs(x).filter((m) => m.role === "tool").map((m) => String(m.content)));
  ok(toolMsgs.length >= 9, `道具の結果 ${toolMsgs.length} 件を確かめた`);
  // システムが AI に渡したもの (道具の結果・指示・質問)。AI 自身が書いた道具の引数 (検索した名前など) は除く
  const sentAll = requests.flatMap((x) => msgs(x).filter((m) => m.role !== "assistant").map((m) => JSON.stringify(m.content))).join("\n");
  const leaked = otherOnly.filter((n) => sentAll.includes(n));
  if (leaked.length) for (const x of requests) for (const m of msgs(x)) if (m.role !== "assistant" && JSON.stringify(m.content).includes(leaked[0])) { const t = JSON.stringify(m.content); const i = t.indexOf(leaked[0]); console.log("   漏えい:", m.role, t.slice(Math.max(0, i - 200), i + 60)); }
  eq(leaked.slice(0, 5), [], `ほかの店舗だけの顧客 ${otherOnly.length} 人の名前を AI に渡さない`);
  ok(!sentAll.includes(otherOrder.number), "ほかの店舗の受注番号を AI に渡さない");
  ok(!sentAll.includes("ミネルヴァ計画"), "公開範囲の外の社内資料の本文を AI に渡さない");
  ok(toolMsgs.some((t) => [...ownNames].some((n) => t.includes(n))), "自店舗の顧客は渡す (確かめが空振りでないこと)");
}

/* ================================================================== */
section("ログイン前: データ・社内資料を答えない");
{
  resetBreaker();
  requests.length = 0;
  const c0 = lastCallId();
  handler = () => oaText("画面右上のメニューから変更できます。");
  const r0 = await askChatbot(db, null, [], "今月の売上を教えて");
  ok(r0.answer.includes("ログイン後") && requests.length === 0, "データの質問は AI を使わずにログインを案内");
  await askChatbot(db, null, [], "このシステムで文字の大きさを変えることはできますか？ (テスト 7f)");
  if (requests.length) {
    ok(!requests[0].body.tools && allText(requests[0]).includes("ログイン前の訪問者"), "道具を渡さず、使い方の案内だけ");
    ok(aiCallsSince(c0).some((c) => c.kind === "guest"), "AI の呼び出しを「ログイン前の案内」として記録");
  } else ok(true, "蓄えた回答で答えた (AI を使わない)");
}

/* ================================================================== */
section("Claude (Anthropic) のモック");
{
  switchToClaude();
  resetBreaker();
  requests.length = 0;
  const c0 = lastCallId();
  const msg = (content, stop) => ({ body: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 900, output_tokens: 80, cache_read_input_tokens: 300, cache_creation_input_tokens: 0 } } });
  handler = (e) => {
    const last = e.body.messages?.at(-1);
    const hasResult = Array.isArray(last?.content) && last.content.some((b) => b.type === "tool_result");
    return hasResult ? msg([{ type: "text", text: `今年の売上合計は ${ytdText} です。` }], "end_turn") : msg([{ type: "tool_use", id: "toolu_1", name: "analyze", input: analyzeArgs }], "tool_use");
  };
  const r = await askChatbot(db, admin, [], "今年の売上合計はいくらですか？");
  ok(requests.length === 2 && requests.every((x) => x.path.startsWith("/v1/messages")), "Claude の messages API に送る");
  ok(r.answer.includes(ytdText) && r.source === "agent", "Claude でも集計してから答える");
  ok(r.provider?.startsWith("claude"), `接続先 = ${r.provider}`);
  const calls = aiCallsSince(c0);
  ok(calls.length === 2 && calls.every((c) => c.provider === "claude" && c.input_tokens === 1200 && c.cached_tokens === 300), "トークン (キャッシュを含む) を記録");
  handler = () => ({ status: 529, body: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } });
  const f = await askChatbot(db, admin, [], "今年の店舗別の売上を教えて");
  ok(f.tables?.length === 1 && f.degraded === "error", "Claude の混雑でも集計は表で答える");
  switchToOpenAi();
  resetBreaker();
}

server.close();
summary();
process.exit(process.exitCode ?? 0);
