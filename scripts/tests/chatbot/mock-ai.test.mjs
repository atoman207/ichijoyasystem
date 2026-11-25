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
    // 文字を順に受け取る依頼 (stream: true) には、同じ返事を OpenAI の stream の形 (data: … の行) にして返す
    const choice = r.body?.choices?.[0];
    if (body.stream && (r.status ?? 200) === 200 && choice) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id: "c", model: r.body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      const m = choice.message ?? {};
      if (m.content) for (const piece of m.content.match(/[\s\S]{1,6}/g)) chunk({ content: piece });
      (m.tool_calls ?? []).forEach((tc, i) => {
        chunk({ tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.function.name, arguments: "" } }] });
        chunk({ tool_calls: [{ index: i, function: { arguments: tc.function.arguments } }] });
      });
      chunk({}, choice.finish_reason);
      res.write(`data: ${JSON.stringify({ id: "c", model: r.body.model, choices: [], usage: r.body.usage })}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }
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
// 閲覧の範囲の設定 (src/lib/access-policy.ts)。初期設定は経営の数字・顧客情報とも全社員。権限で断る・渡さないテストは「自店舗 / 進行中だけ」にして確かめる
const setPolicy = (value) => {
  for (const x of new Set([db, store.getDb()])) {
    x.settings = (x.settings ?? []).filter((r) => r.id !== "access_policy");
    if (value) x.settings.push({ id: "access_policy", value, updatedAt: new Date().toISOString() });
  }
};
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
  const READ_ONLY = ["search_records", "get_record", "list_schedule", "analyze", "management_accounting", "business_overview", "search_guides", "search_history", "suggest_schedule", "plan_schedule", "day_route", "schedule_holds", "schedule_setup", "describe_database", "query_database", "calculate", "forecast", "store_split",
    // propose_action は確認のカードを作るだけ (何も変えない。実行は利用者が「実行する」を押したとき: src/lib/assistant/actions.ts)
    "propose_action",
    // production_plan は製造の予定を読むだけ (schedule-tool.ts)
    "production_plan",
    // データ台帳 (src/lib/assistant/registry-tool.ts): 資料庫の検索・資料を読む・全データの一覧と社内の活動 (読み取りだけ)
    "search_materials", "read_material", "data_registry"];
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
  ok(r.answer.includes("確かめられなかった数字"), "確かめられない数字に注記");
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

section("実行の依頼: 確認のカードを出す (AI は実行しない。押すと画面と同じ処理で実行)");
{
  requests.length = 0;
  const staffUser = db.users.find((u) => u.active && u.role === "store_staff" && u.storeId === "koshi");
  const before = db.schedule.length;
  handler = (e) =>
    lastRole(e) === "tool"
      ? oaText("次の内容で予定を登録できます。よければ「登録する」を押してください。")
      : oaTools([{ name: "propose_action", args: { action: "create_schedule_event", event_kind: "pickup", title: "テスト 引取", date: "2031-05-12", start_time: "10:00", end_time: "11:00", assignees: [staffUser.name] } }]);
  const r = await askChatbot(db, staffUser, [], "5月12日の10時から引取の予定を入れておいて");
  ok(requests[0] && allText(requests[0]).includes("propose_action"), "データを変える依頼では propose_action を使うよう AI に伝える");
  ok(r.actions?.length === 1 && r.actions[0].kind === "create_schedule_event" && typeof r.actions[0].token === "string", "回答に確認のカードを付ける");
  ok(r.actions?.[0]?.fields.some((f) => f.label === "担当" && f.value.includes(staffUser.name)), "カードに担当者を表示する");
  ok(db.schedule.length === before, "AI の回答の時点では何も変えない");
  ok(!r.answer.startsWith("この依頼は AI アシスタントからは実行できません"), "カードを出したときは「実行できない」と書かない");
}

section("閲覧の権限: 店舗のロールがほかの店舗・全社の売上を聞いたら、AI を呼ばずに断る (閲覧の範囲 = 自店舗)");
{
  setPolicy({ figures: "store", customers: "open", grantDays: 7 });
  requests.length = 0;
  handler = () => oaText("合志店の今月の売上は 1,234,567円 です。");
  const chuoStaff = db.users.find((u) => u.active && u.role === "store_staff" && u.storeId === "chuo");
  const r1 = await askChatbot(db, chuoStaff, [], "合志店の今月の売上は？");
  ok(/権限の範囲外/.test(r1.answer) && !/1,234,567/.test(r1.answer), "ほかの店舗の売上は「権限の範囲外」と答える");
  const r2 = await askChatbot(db, chuoStaff, [], "全社の今年の粗利は？");
  ok(/権限の範囲外/.test(r2.answer), "全社の数字も断る");
  ok(requests.length === 0, "断るときは AI を呼ばない (数字を AI に渡さない)");
}

section("閲覧の範囲 = 経営の数字は全社員 (初期設定): 店舗のロールにもほかの店舗の売上を答える");
{
  setPolicy(null);
  resetBreaker();
  requests.length = 0;
  handler = (e) => (lastRole(e) === "tool" ? oaText("合志店の今月の売上をまとめました。") : oaTools([{ name: "analyze", args: { subject: "sales", metrics: ["sales"], stores: ["koshi"], from: `${today.slice(0, 7)}-01`, to: today } }]));
  const chuoStaff = db.users.find((u) => u.active && u.role === "store_staff" && u.storeId === "chuo");
  const r = await askChatbot(db, chuoStaff, [], "合志店の今月の売上は？");
  ok(!/権限の範囲外/.test(r.answer) && requests.length > 0, "断らずに AI がデータを調べる");
  const toolOut = requests.flatMap((x) => msgs(x).filter((m) => m.role === "tool").map((m) => String(m.content))).join("\n");
  const koshiMonth = db.orders.filter((o) => o.storeId === "koshi" && o.status !== "cancelled" && o.salesDate && o.salesDate >= `${today.slice(0, 7)}-01` && o.salesDate <= today).reduce((a, o) => a + o.total, 0);
  ok(!/範囲外/.test(toolOut) && toolOut.includes(`¥${koshiMonth.toLocaleString("ja-JP")}`), `集計の道具が合志店の売上 (¥${koshiMonth.toLocaleString("ja-JP")}) を集計する (範囲外のエラーにしない)`);
  setPolicy({ figures: "store", customers: "open", grantDays: 7 });
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
section("計算と予測の道具: 道具の結果の数字で計算する・推測した数字は断る・途中の知らせ");
{
  resetBreaker();
  requests.length = 0;
  const events = [];
  const ytdNum = Math.round(ytd);
  handler = (e) => {
    const toolMsgs = msgs(e).filter((m) => m.role === "tool");
    if (toolMsgs.length === 0) return oaTools([{ name: "analyze", args: analyzeArgs }]);
    if (toolMsgs.length === 1) return oaTools([{ name: "calculate", args: { expression: `${ytdNum} / 2`, label: "半分" } }, { name: "calculate", args: { expression: "98765432 - 1", label: "推測した数字" } }]);
    return oaText(`売上合計 ${ytdText} の半分は ${Math.round(ytdNum / 2).toLocaleString("ja-JP")}円 です。`);
  };
  const r = await askChatbot(db, admin, [], "今年の売上合計の半分はいくら？", { onProgress: (ev) => events.push(ev) });
  const toolOut = requests.flatMap((x) => msgs(x).filter((m) => m.role === "tool").map((m) => String(m.content)));
  ok(toolOut.some((t) => t.includes(`= ${Math.round(ytdNum / 2).toLocaleString("ja-JP")}`) || t.includes(`= ${(ytdNum / 2).toLocaleString("ja-JP", { maximumFractionDigits: 2 })}`)), "道具の結果の数字で計算する");
  ok(toolOut.some((t) => t.includes("98765432") && t.includes("道具の結果にありません")), "道具の結果にない数字の計算は断る");
  ok(r.answer.includes(Math.round(ytdNum / 2).toLocaleString("ja-JP")) && !(r.checks?.issues ?? []).some((i) => i.kind === "number"), "計算の結果は根拠のある数字として扱う (注記なし)");
  ok(events.some((e) => e.type === "phase" && e.phase === "thinking"), "途中の知らせ: 考えはじめ");
  const starts = events.filter((e) => e.type === "tool" && e.status === "start").map((e) => e.name);
  const dones = events.filter((e) => e.type === "tool" && e.status === "done");
  ok(starts.includes("analyze") && starts.filter((n) => n === "calculate").length === 2, "途中の知らせ: 道具ごとの開始");
  ok(dones.length === starts.length && dones.every((e) => e.label), "途中の知らせ: 道具ごとの完了 (表示名つき)");

  requests.length = 0;
  handler = (e) => {
    const t = msgs(e).filter((m) => m.role === "tool").map((m) => String(m.content));
    if (!t.length) return oaTools([{ name: "forecast", args: { subject: "sales", months: 2 } }]);
    const m = t[0].match(/\| ([^|]*今月[^|]*) \| (¥[\d,]+) \|/);
    return oaText(`今月の売上の予測 (中心) は ${m ? m[2].replace("¥", "") : "?"}円 です (前年同月の実績 × 伸びと今月のペースからの推定)。`);
  };
  const f = await askChatbot(db, admin, [], "今月の売上の着地の見込みは？");
  ok(f.tables?.some((t) => t.title.includes("予測")), "予測の表を出す");
  const fr = f.tables.find((t) => t.title.includes("予測"));
  ok(String(fr.rows[0].k0).includes("(今月)") && String(fr.rows[1].k0).includes("(来月)"), "予測の表の行に (今月)・(来月) を書く (AI が月を取り違えないように)");
  ok(/予測 \(中心\) は [\d,]+円/.test(f.answer) && !(f.checks?.issues ?? []).some((i) => i.kind === "number"), "予測の数字も根拠のある数字として扱う");
}

section("回答を書かれた順に送る (stream): 画面にすぐ出す");
{
  resetBreaker();
  requests.length = 0;
  const c0 = lastCallId();
  const events = [];
  handler = (e) => (lastRole(e) === "tool" ? oaText(`今年の売上合計は **${ytdText}** です。`) : oaTools([{ name: "analyze", args: analyzeArgs }]));
  const r = await askChatbot(db, admin, [], "今年の売上合計はいくらですか？", { onProgress: (ev) => events.push(ev) });
  ok(requests.length >= 2 && requests.every((x) => x.body.stream === true), "途中の知らせを受け取るときは、AI に stream で頼む");
  const text = events.filter((x) => x.type === "text").map((x) => x.delta).join("");
  eq(text, r.answer, "書かれた順に届いた文字をつなぐと、最後の回答と同じ");
  ok(events.filter((x) => x.type === "text").length >= 3, "回答は何回かに分けて届く (すぐに出しはじめられる)");
  ok(r.tables?.length === 1 && r.source === "agent", "stream でも道具の呼び出し (集計) は同じように動く");
  const calls = aiCallsSince(c0);
  ok(calls.length === 2 && calls.every((c) => c.input_tokens === 1200 && c.output_tokens === 150), "stream でも使ったトークン数を記録する");
  // 確かめ直しになったら、書きかけを消してから書き直す
  events.length = 0;
  handler = (e) => (allText(e).includes("回答の下書きを確かめたところ") ? oaText(`売上合計は ${ytdText} です。`) : lastRole(e) === "tool" ? oaText("売上合計は 99,999,999円 です。") : oaTools([{ name: "analyze", args: analyzeArgs }]));
  const r2 = await askChatbot(db, admin, [], "今年の売上合計はいくらですか？", { onProgress: (ev) => events.push(ev) });
  const iReset = events.findIndex((x) => x.type === "reset");
  ok(iReset > 0 && events.slice(0, iReset).some((x) => x.type === "text") && events.some((x) => x.type === "phase" && x.phase === "checking"), "確かめ直すときは、書きかけを消してから書き直す");
  ok(r2.answer.includes(ytdText), "最後の回答は確かめた数字");
}

section("店舗間の仕事の依頼の売上の配分: 先に計算して、AI の往復を 1 回にする");
{
  resetBreaker();
  requests.length = 0;
  handler = (e) => {
    const t = allText(e);
    const ok1 = t.includes("40,000") && t.includes("160,000");
    return oaText(ok1 ? "合志店に 40,000円、中央店に 160,000円 の売上が計上されます (合計 200,000円)。" : "分かりません");
  };
  const t0 = Date.now();
  const r = await askChatbot(db, admin, [], "合志店から中央店に20万円の通常工事を依頼した場合、それぞれの店舗にいくらの売上が計上されますか？");
  eq(requests.length, 1, "AI とのやりとりは 1 回 (計算は先に済ませて渡す)");
  ok(allText(requests[0]).includes("店舗ごとの売上の配分の計算") && !allText(requests[0]).includes("参考資料 (システムが自動で探した使い方"), "計算の結果を質問に添える (使い方の資料は添えない)");
  ok(r.answer.startsWith("合志店に 40,000円、中央店に 160,000円"), "最初の 1 文で各店舗の金額を答える");
  ok(r.tables?.some((x) => x.title.includes("売上の配分")), "配分の表を出す");
  eq(r.checks?.issues ?? [], [], "確かめで問題なし (注記を付けない)");
  ok(!r.answer.includes("※"), "分かりにくい注記を付けない");
  console.log(`    (${Date.now() - t0}ms)`);
  // 店舗スタッフ: 管理会計は見られないので、分かる言葉で断る (計算した金額は渡さない)
  requests.length = 0;
  handler = (e) => oaText(allText(e).includes("店長に確認してください") ? "店舗間の売上の配分は、店長・本部・管理者が確認できます。店長に確認してください。" : "40,000円です");
  const s = await askChatbot(db, staff, [], "合志店から中央店に20万円の通常工事を依頼した場合、それぞれの店舗にいくらの売上が計上されますか？");
  ok(!allText(requests[0]).includes("160,000") && s.answer.includes("店長に確認"), "店舗スタッフには配分の金額を渡さず、確認先を伝える");
}

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
  // データの回答の続きはデータの質問: 使い方の資料を先に添えない (操作の案内と取り違えない)・データモデルの要点を添える
  const lastQ = String(sent.at(-1)?.content ?? "");
  const sys0 = String(sent.find((m) => m.role === "system")?.content ?? "");
  ok(!lastQ.includes("参考資料 (システムが自動で探した使い方") && sys0.includes("## データモデルの要点 (システムが先に用意") && !lastQ.includes("データモデルの要点"), "続きの質問には使い方の資料ではなくデータモデルの要点を添える (AI への指示の最後: キャッシュに乗る)");
  ok(lastQ.includes("前の集計の続きです") && lastQ.startsWith("それを店舗別にして"), "集計の続きの質問には、前の条件を引き継いで調べ直すよう添える");
  // 調べずに数字を答えたら、確かめ直させる (データの質問として扱う)
  requests.length = 0;
  let n = 0;
  handler = (e) => (lastRole(e) === "tool" ? oaText("店舗別の売上を表にしました。") : n++ === 0 ? oaText("合志店は 4,287,000 円、中央店は 4,292,450 円です。") : oaTools([{ name: "analyze", args: { ...analyzeArgs, group_by: ["store"] } }]));
  const r2 = await askChatbot(db, admin, [{ role: "user", content: "今年の売上合計は？" }, { role: "assistant", content: `今年の売上合計は ${ytdText} です。`, specs: [spec] }], "それを店舗別にして");
  ok(r2.checks?.retried && !r2.answer.includes("4,287,000") && r2.tables?.length === 1, "続きの質問で調べずに作った数字は確かめ直させ、集計した結果で答える");
}

section("総合的な分析にする質問 (全体像を先に用意する) と、数字を 1 つ聞く質問");
{
  resetBreaker();
  requests.length = 0;
  handler = () => oaText("今年は昨年の同じ期間より 5.0% 増えました。");
  await askChatbot(db, admin, [], "今年 (1月1日〜今日) の売上は、昨年の同じ期間と比べて何%増減しましたか？");
  ok(!allText(requests[0]).includes("会社の全体像 (business_overview の結果"), "「比べて何%」は数字を 1 つ聞く質問: 全体像を先に用意しない (速く短く答える)");
  requests.length = 0;
  handler = () => oaText("合志店が一番です。");
  await askChatbot(db, admin, [], "店舗を比べて、今年の課題を教えて");
  ok(allText(requests[0]).includes("会社の全体像 (business_overview の結果"), "課題を聞く質問は総合的な分析 (全体像を先に用意する)");
  // 「今年」の質問で、前年と比べるときに期間の始まりを前の年にした: 道具が断って呼び直させる
  requests.length = 0;
  let step = 0;
  handler = (e) => {
    step++;
    if (step === 1) return oaTools([{ name: "analyze", args: { ...analyzeArgs, from: `${Number(year) - 1}-01-01`, compare: "previous_year" } }]);
    if (step === 2) return oaTools([{ name: "analyze", args: { ...analyzeArgs, compare: "previous_year" } }]);
    return oaText("今年は昨年の同じ期間と比べて増えました。");
  };
  const yoy = await askChatbot(db, admin, [], "今年 (1月1日〜今日) の売上は、昨年の同じ期間と比べて何%増減しましたか？");
  const firstTool = msgs(requests[1] ?? { body: {} }).filter((m) => m.role === "tool").map((m) => String(m.content)).join("\n");
  ok(firstTool.includes("期間が質問と合いません") && firstTool.includes(`${year}-01-01`) && yoy.tables?.[0]?.spec?.from === `${year}-01-01`, "「今年」の質問で期間を前の年からにしたら、道具が断って今年の期間で呼び直させる");
  for (const q of ["店舗を変更するにはどうしたら良いですか？", "問い合わせで登録した案件を施工予定に変更するにはどうしたらいいですか？"]) {
    requests.length = 0;
    handler = () => oaText("使い方の資料の手順です。");
    await askChatbot(db, admin, [], q);
    ok(requests[0] && !allText(requests[0]).includes("会社の全体像 (business_overview の結果"), `操作の質問は総合的な分析にしない: ${q}`);
  }
  requests.length = 0;
  handler = () => oaText("使い方の資料に書かれた手順です。");
  const h = await askChatbot(db, admin, [], "見積書はどの画面で作りますか？手順を教えて");
  const sentH = requests[0] ? allText(requests[0]) : "";
  ok(h.source === "database" || (!sentH.includes("データモデルの要点 (システムが先に用意") && sentH.includes("見積を作成")), `操作の質問には使い方の資料を添え、データモデルは添えない (${h.source})`);
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
setPolicy(null);

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
