// AI アシスタントの画面のテスト (PC とスマートフォン)。サンプルデータのサーバー (DATA_BACKEND=json) とモックの AI で動かす。
// 1. モックの AI を起動する: このスクリプトが MOCK_AI_PORT (既定 3199) で起動する
// 2. 確かめるサーバーは OPENAI_API_KEY=sk-test-mock OPENAI_BASE_URL=http://127.0.0.1:3199/v1 OPENAI_MODEL=gpt-4.1 で起動しておく
//    (本番・開発のサーバーには使わない。スクラッチの手順は deploy/README.md と CLAUDE.md)
// 実行: BASE_URL=http://127.0.0.1:3102 node scripts/tests/chatbot/ui.e2e.mjs
import http from "node:http";
import fs from "node:fs";
import { chromium } from "playwright";

const BASE = (process.env.BASE_URL ?? "http://127.0.0.1:3102").replace(/\/$/, "");
const MOCK_PORT = Number(process.env.MOCK_AI_PORT) || 3199;
const SHOTS = process.env.SHOTS_DIR;
const chromePath = ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => fs.existsSync(p));

/* ---------------- モックの AI: 売上の質問は analyze を呼んでから、結果の合計を答える ---------------- */
const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
const year = today.slice(0, 4);
let seq = 0;
const mock = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw || "{}");
    const msgs = body.messages ?? [];
    const last = msgs.at(-1);
    let message;
    if (!body.tools) message = { role: "assistant", content: "画面右上のメニューからご確認ください。" };
    else if (last?.role === "tool") {
      const m = String(last.content).match(/¥[\d,]+/g);
      const total = m ? m[m.length - 1].replace("¥", "") : "0";
      message = { role: "assistant", content: `${year}年 1 月 1 日〜今日の売上合計は **${total}円** です。店舗別の表は下に表示しています。` };
    } else message = { role: "assistant", content: null, tool_calls: [{ id: `call_${++seq}`, type: "function", function: { name: "analyze", arguments: JSON.stringify({ subject: "sales", metrics: ["sales"], group_by: ["store"], from: `${year}-01-01`, to: today }) } }] };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "c", model: "gpt-4.1", choices: [{ message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1000, completion_tokens: 100 } }));
  });
});
await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));

const results = [];
const check = (ok, msg) => {
  results.push({ ok, msg });
  console.log(ok ? "  ✓" : "  ✗", msg);
};

const browser = await chromium.launch(chromePath ? { executablePath: chromePath } : {});
async function session(viewport, account) {
  const ctx = await browser.newContext({ viewport, locale: "ja-JP", timezoneId: "Asia/Tokyo", isMobile: viewport.width < 600, hasTouch: viewport.width < 600 });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  const form = page.locator('form:has(input[name="password"])');
  await form.locator('input[name="email"]').fill(account);
  await form.locator('input[name="password"]').fill("demo1234");
  await form.locator('button[type="submit"]').click();
  await page.waitForURL(`${BASE}/`, { timeout: 90_000 });
  return { ctx, page };
}
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

for (const [label, viewport] of [
  ["PC", { width: 1280, height: 800 }],
  ["スマートフォン", { width: 390, height: 844 }],
]) {
  console.log(`\n■ ${label} (${viewport.width}px)`);
  const { ctx, page } = await session(viewport, "yamada@ichijoya.example");
  // 画面左下の「質問する」
  await page.getByRole("button", { name: "チャットボットに質問する" }).click();
  const box = page.getByLabel("質問").last();
  await box.fill("今年の売上合計はいくらですか？");
  await page.getByRole("button", { name: "送信" }).last().click();
  const answer = page.getByText(/売上合計は/).last();
  check(await answer.waitFor({ timeout: 90_000 }).then(() => true).catch(() => false), "質問すると回答が出る");
  check(await page.getByText(/回答の根拠/).last().isVisible().catch(() => false), "回答の根拠を表示する");
  check(await page.locator("table").last().isVisible().catch(() => false), "集計の表を表示する");
  check(await noHScroll(page), "横にはみ出さない (チャットを開いた状態)");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/chat-${viewport.width}.png` });
  await page.keyboard.press("Escape");
  // AI アシスタントの画面・品質と費用 (管理者)
  for (const url of ["/ai", "/ai?tab=quality", "/ai?tab=history"]) {
    const r = await page.goto(`${BASE}${url}`, { waitUntil: "networkidle" });
    check(r?.status() === 200, `${url} を開ける`);
    check(await noHScroll(page), `${url} が横にはみ出さない`);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/${url.replace(/[/?=]/g, "_")}-${viewport.width}.png`, fullPage: true });
  }
  await page.goto(`${BASE}/ai?tab=quality`, { waitUntil: "networkidle" });
  check(await page.getByText("受入基準と精度の評価").isVisible(), "品質・費用: 受入基準");
  check(await page.getByText("正解付きの質問", { exact: false }).first().isVisible(), "品質・費用: 正解付きの質問");
  check(await page.getByText("データの品質 (AI の回答に影響するもの)").isVisible(), "品質・費用: データの品質");
  // 履歴に「回答の確かめ」が出る
  await page.goto(`${BASE}/ai?tab=history`, { waitUntil: "networkidle" });
  const first = page.locator('a[href*="tab=history&id="]').first();
  if (await first.count()) {
    await first.click();
    await page.waitForLoadState("networkidle");
    check(await page.getByText("回答の確かめ").isVisible().catch(() => false), "相談の履歴に回答の確かめを出す");
  }
  await ctx.close();
}

console.log("\n■ 店舗スタッフには「品質・費用」がない");
{
  const { ctx, page } = await session({ width: 1280, height: 800 }, "nakamura@ichijoya.example");
  await page.goto(`${BASE}/ai?tab=quality`, { waitUntil: "networkidle" });
  check(!(await page.getByText("受入基準と精度の評価").isVisible().catch(() => false)), "店舗スタッフは品質・費用を見られない");
  check(!(await page.getByRole("link", { name: "品質・費用" }).isVisible().catch(() => false)), "タブも出ない");
  const csv = await page.request.get(`${BASE}/api/assistant/eval-cases`);
  check(csv.status() === 403, "評価の質問の CSV も保存できない");
  await ctx.close();
}

await browser.close();
mock.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
