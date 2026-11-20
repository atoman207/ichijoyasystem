// 実行: node scripts/tests/chatbot/eval-live.mjs [--only=<分類>] [--match=<質問の一部>]
// AI アシスタントの精度の評価を、本物の AI (.env.local の OPENAI_API_KEY か ANTHROPIC_API_KEY) とサンプルデータで行う。
// データ・チャットボットの SQLite・VPS のデータベースの写しはすべて一時フォルダー (本番のデータは AI に送らない)。
// 正解付きの質問は始めの質問 (src/lib/chatbot/eval-seeds.ts)。AI の費用がかかる (1 問あたり AI の呼び出し 2〜6 回)
import fs from "node:fs";
import path from "node:path";
import { imp, root, startMirror, work } from "./harness.mjs";

// AI のキーだけを .env.local から読む (ほかの接続情報は読まない)
const envFile = path.join(root, ".env.local");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^(OPENAI_API_KEY|ANTHROPIC_API_KEY|OPENAI_MODEL|AI_PROVIDER)=(.*)$/);
    if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}
const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);

const store = await imp("lib/db/store.ts");
const { aiStatus } = await imp("lib/ai/provider.ts");
const { askChatbot } = await imp("lib/chatbot/answer.ts");
const { ensureChatbotData } = await imp("lib/chatbot/build.ts");
const E = await imp("lib/chatbot/eval.ts");
const M = await imp("lib/chatbot/monitor.ts");

const status = aiStatus();
if (!status.enabled) {
  console.error("AI のキーがありません (.env.local の OPENAI_API_KEY / ANTHROPIC_API_KEY)");
  process.exit(1);
}
console.log(`AI: ${status.label} ${status.model ?? ""} / 一時フォルダー: ${work}`);
await startMirror();
await new Promise((r) => setTimeout(r, 3000)); // 分析用の表・索引
M.installAiMonitor();
const db = store.getDb();
ensureChatbotData(db, true);
E.seedEvalCases(db, "eval-live");
const only = arg("only");
const match = arg("match");
const ids = E.listEvalCases({ activeOnly: true }).filter((c) => (!only || c.category === only) && (!match || c.question.includes(match))).map((c) => c.id);
const ask = async (d, user, history, question) => {
  const r = await askChatbot(d, user, history, question, { evaluation: true });
  return { answer: r.answer, tools: r.tools, sources: r.sources, source: r.source, checks: r.checks, tables: r.tables };
};
const t0 = Date.now();
const { runId, metrics: m } = await E.runEval(db, ask, { caseIds: ids, label: "eval-live", provider: `${status.label} ${status.model ?? ""}`, onProgress: (d, n) => process.stdout.write(`\r${d}/${n}`) });
console.log("\n");
const cases = new Map(E.listEvalCases().map((c) => [c.id, c]));
for (const r of E.evalResults(runId)) {
  const c = cases.get(r.caseId);
  console.log(`${r.ok ? "PASS" : "FAIL"} [${E.categoryLabel(c.category)}・${c.role}${c.storeId ? `・${c.storeId}` : ""}] ${c.history.length ? `(${c.history.join(" → ")}) → ` : ""}${r.question}  ${(r.ms / 1000).toFixed(1)}s`);
  if (!r.ok) console.log(`     理由: ${r.outcome.reasons.join(" / ")}`);
  if (r.outcome.issueDetails?.length) console.log(`     確かめ: ${r.outcome.issueDetails.join(" / ")}`);
  if (r.outcome.evidenceOk === false) console.log("     根拠の表示なし");
  if (r.expected) console.log(`     正解: ${r.expected.slice(0, 160)}`);
  console.log(`     回答: ${r.answer.replace(/\s+/g, " ").slice(0, 220)}`);
  console.log(`     道具: ${r.tools.join(", ")}`);
}
{
  const lens = E.evalResults(runId).map((r) => r.answer.length).sort((a, b) => a - b);
  console.log(`\n回答の長さ (文字): 中央 ${lens[Math.floor(lens.length / 2)]}・90% ${lens[Math.floor(lens.length * 0.9)]}・最大 ${lens[lens.length - 1]}`);
}
console.log(`\n正答率 ${(m.accuracy * 100).toFixed(1)}% (${m.passed}/${m.total}) / 数字の一致 ${m.numericRate === null ? "-" : `${(m.numericRate * 100).toFixed(1)}%`} / 道具 ${m.toolRate === null ? "-" : `${(m.toolRate * 100).toFixed(0)}%`} / 根拠 ${m.evidenceRate === null ? "-" : `${(m.evidenceRate * 100).toFixed(0)}%`}`);
console.log(`権限違反 ${m.violations} / 存在しない画面 ${m.badScreens} / 根拠のない数字 ${m.ungrounded} / 答えられない ${m.unknownRate ?? "-"} / 断る ${m.refuseRate ?? "-"}`);
console.log(`回答時間 平均 ${(m.avgMs / 1000).toFixed(1)}s・p95 ${(m.p95Ms / 1000).toFixed(1)}s / トークン ${m.tokens.toLocaleString()} / 費用の見込み ${Math.round(m.costJpy)} 円 (単価が分かるモデルだけ) / 全体 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
{
  const S = await imp("lib/chatbot/store.ts");
  const u = S.chatbotDb().prepare("select count(*) n, sum(input_tokens) i, sum(cached_tokens) c, avg(ms) ms from ai_calls where kind = 'eval' and ok = 1").get();
  console.log(`AI の呼び出し ${u.n} 回 (1 回の平均 ${(Number(u.ms) / 1000).toFixed(2)}s) / 入力のうちキャッシュから読んだ割合 ${u.i ? ((Number(u.c) / Number(u.i)) * 100).toFixed(0) : 0}%`);
}
for (const a of E.ACCEPTANCE) console.log(`  ${a.pass(m) ? "合格" : "未達"} ${a.label} (基準 ${a.target})`);
fs.rmSync(work, { recursive: true, force: true });
process.exit(0);
