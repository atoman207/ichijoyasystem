/**
 * 手書き見積書の明細の行を省かない・行と行の間に入れる のテスト (お客様のご要望 2026-11-26「■1」)
 *   node scripts/tests/capture/quote-rows.test.mjs   (npm run test:capture)
 * 1. 読み取った行の整え (src/lib/ai/ocr-rows.ts): 空欄の行だけを除く・並べ替えない・数えた行より少なければ空の行で埋める
 * 2. 読取結果の整形 (ocr.ts の normalizeExtracted): 品名が読めない行も手書き見積書では残す (要確認・商品マスタに当てない)
 * 3. 明細の行の挿入・移動 (src/components/features/line-order.ts)
 * 4. 送る写真の大きさ (src/components/attachments/image-prep.ts の fitSize)
 * 5. AI の読取 (extractDocument): 数えた行より少なければ 1 回だけ読み直す (モックの OpenAI のサーバー。本物の AI は呼ばない)
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "../../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ichijoya-quote-rows-"));
for (const k of Object.keys(process.env)) if (/^(OPENAI_|ANTHROPIC_|AI_)/.test(k)) delete process.env[k];
Object.assign(process.env, {
  DATA_BACKEND: "json",
  DATA_FILE_NAME: "quote-rows-test-db.json",
  DB_SNAPSHOT: "off",
  ICHIJOYA_DATA_DB: "off",
  CHATBOT_DB_PATH: path.join(work, "chatbot.sqlite"),
  TZ: "Asia/Tokyo",
});
process.chdir(work);
const jiti = createJiti(import.meta.url, { alias: { "@": path.join(root, "src"), "server-only": path.join(root, "scripts/tests/maps/empty.cjs") }, moduleCache: true });
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

const R = await imp("lib/ai/ocr-rows.ts");
const O = await imp("lib/ai/ocr.ts");
const L = await imp("components/features/line-order.ts");
const P = await imp("components/attachments/image-prep.ts");

/* ================================================================== */
section("1. 読み取った行の整え (ocr-rows.ts)");
ok(R.hasRowContent({ name: "畳表替え" }) && R.hasRowContent({ name: "", qty: 6 }) && R.hasRowContent({ name: "", unitPrice: "15,000" }), "品名か数字のある行は書き込みのある行");
ok(R.hasRowContent({ name: "", uncertain: true }) && R.hasRowContent({ name: "", corrected: true }), "何も読めなくても、AI が「読みにくい」「書き直した」とした行は残す");
ok(!R.hasRowContent({ name: "", spec: "", qty: null, unit: "畳", unitPrice: null, amount: null, uncertain: false }) && !R.hasRowContent(null) && !R.hasRowContent("x"), "何も書かれていない行 (用紙の空欄の行) は除く (単位だけの行も)");

const a = [
  { line: 1, name: "畳表替え", qty: 6, unitPrice: 15000 },
  { line: 2, name: "〃", qty: 2 },
  { line: 4, name: "諸経費", amount: 3300 },
];
const r1 = R.reconcileRows(a, 4);
eq(r1.rows.map((r) => r.name), ["畳表替え", "〃", "", "諸経費"], "数えた 4 行のうち 3 行目が抜けていれば、3 行目に空の行を入れる (順番はそのまま)");
ok(r1.rows[2].uncertain === true && r1.padded === 1 && r1.positions.join() === "3", "入れた行は要確認・位置を記録");
ok(r1.rows.every((r) => !("line" in r)), "行の番号 (line) は保存しない");
ok(r1.warnings[0]?.includes("4 行") && r1.warnings[0]?.includes("3 行") && r1.warnings[0]?.includes("3 行目"), "注意: 用紙の行数・読めた行数・入れた位置");

const r2 = R.reconcileRows([{ name: "畳", qty: 6 }, { name: "襖", qty: 2 }], 4);
eq(r2.rows.map((r) => r.name), ["畳", "襖", "", ""], "行の番号がないときは足りない行を最後に入れる");
ok(r2.warnings[0]?.includes("最後") && r2.warnings[0]?.includes("上へ"), "位置が分からないときは「上へ」「下へ」で動かせると知らせる");

const r3 = R.reconcileRows([{ line: 3, name: "C" }, { line: 1, name: "A" }], 4);
eq(r3.rows.map((r) => r.name), ["C", "A", "", ""], "行の番号の順がおかしくても並べ替えない (AI が返した順 = 用紙の上から)");

const r4 = R.reconcileRows([{ line: 1, name: "A" }, { line: 3, name: "B" }, { line: 5, name: "C" }], 4);
eq(r4.rows.map((r) => r.name), ["A", "B", "C", ""], "番号の抜けが足りない数と合わないときは最後に入れる (番号を信じすぎない)");

const r5 = R.reconcileRows([{ name: "A" }, { name: "", qty: null, unitPrice: null }, { name: "B" }], undefined);
eq(r5.rows.map((r) => r.name), ["A", "B"], "行数を数えていないときは空欄の行を除くだけ");
eq(R.reconcileRows([{ name: "A" }], 0).rows.length, 1, "0 行・数でない行数は使わない");
eq(R.reconcileRows([{ name: "A" }], 500).padded, 0, "上限より大きい行数は数え間違いとして使わない");
eq(R.checkRows([{ name: "A" }, { name: "" }, { name: "", qty: 2 }], 5), { read: 2, counted: 5, missing: 3 }, "読み直しの判定: 書き込みのある行の数と足りない数");
ok(R.retryInstruction({ read: 3, counted: 5, missing: 2 }).includes("5 行") && R.retryInstruction({ read: 3, counted: 5, missing: 2 }).includes("3 行"), "読み直しの依頼に数えた行数と返ってきた行数を書く");

/* ================================================================== */
section("2. 読取結果の整形 (品名が読めない行も残す)");
const products = [{ id: "p1", name: "畳表替え さくら", category: "tatami", unit: "畳", unitPrice: 15000, active: true, grade: "さくら" }];
const n1 = O.normalizeExtracted("handwritten_quote", { items: [{ name: "畳表替え", spec: "さくら", qty: 6, unitPrice: 15000 }, { name: "", spec: "さくら", qty: 2, unitPrice: null }, { name: "", uncertain: true }, { name: "", qty: null, unitPrice: null, amount: null }, { name: "諸経費", amount: 3300 }] }, products);
eq(n1.extracted.items.map((i) => i.name), ["畳表替え", "", "", "諸経費"], "品名が読めない行 (数字・規格・要確認の印あり) は残し、空欄の行だけ除く");
ok(n1.extracted.items[1].uncertain === true && n1.extracted.items[2].uncertain === true, "品名が読めない行は要確認 (黄色)");
ok(!n1.extracted.items[1].productId && n1.extracted.items[0].productId === "p1", "品名が読めない行は商品マスタに当てない (規格だけで別の商品の単価が入らない)");
ok(n1.warnings.some((w) => w.includes("品名を読み取れなかった明細が 2 行")), "品名が読めない行の数を知らせる");
const n2 = O.normalizeExtracted("supplier_invoice", { items: [{ name: "", qty: 2, amount: 1000 }, { name: "畳床", qty: 1, amount: 5000 }] }, products);
eq(n2.extracted.items.map((i) => i.name), ["畳床"], "ほかの書類 (仕入請求書など) は今までどおり品名のない行を除く");
ok(!O.FIELD_KEYS.handwritten_quote.includes("lineCount") && O.FIELD_KEYS.handwritten_quote.includes("items"), "数えた行数 (lineCount) は確認画面の項目にしない");

/* ================================================================== */
section("3. 明細の行の挿入・移動 (line-order.ts)");
const rows = ["A", "B", "C"];
eq(L.insertRow(rows, 1, "X"), ["A", "X", "B", "C"], "1 行目の下 (= 2 行目の上) に入れる");
eq(L.insertRow(rows, 0, "X"), ["X", "A", "B", "C"], "先頭に入れる");
eq(L.insertRow(rows, 3, "X"), ["A", "B", "C", "X"], "最後に入れる");
eq(L.insertRow(rows, 99, "X"), ["A", "B", "C", "X"], "範囲の外は最後");
eq(L.insertRow(rows, -5, "X"), ["X", "A", "B", "C"], "マイナスは先頭");
eq(rows, ["A", "B", "C"], "元の配列は変えない");
eq(L.moveRow(rows, 1, -1), ["B", "A", "C"], "上へ移動");
eq(L.moveRow(rows, 1, 1), ["A", "C", "B"], "下へ移動");
eq(L.moveRow(rows, 0, -1), ["A", "B", "C"], "先頭の行は上へ動かない");
eq(L.moveRow(rows, 2, 1), ["A", "B", "C"], "最後の行は下へ動かない");
eq(L.removeRowAt(rows, 1), ["A", "C"], "行を消す");

/* ================================================================== */
section("4. 送る写真の大きさ (image-prep.ts)");
const s1 = P.fitSize(4032, 3024);
ok(s1.width * s1.height <= P.MAX_PIXELS && s1.width >= 2200 && Math.abs(s1.width / s1.height - 4 / 3) < 0.01, `スマートフォンの 1,200 万画素の写真は 375 万画素まで (${s1.width}×${s1.height}・以前は 2048×1536)`);
const s2 = P.fitSize(6000, 1500);
ok(s2.width === P.MAX_EDGE && s2.height <= 645, `横長の写真は長い辺 ${P.MAX_EDGE}px まで (${s2.width}×${s2.height})`);
eq(P.fitSize(1600, 1200).scale, 1, "小さい写真は大きくしない");
const s3 = P.fitSize(3000, 4000, 480, Infinity);
ok(s3.height === 480 && s3.width === 360, "一覧用の縮小画像は長い辺 480px");
ok(P.MAX_OUT_BYTES < 4 * 1024 * 1024, "縮小した写真は送信の上限 (4 MB) より小さく");

/* ================================================================== */
section("5. AI の読取: 数えた行より少なければ 1 回だけ読み直す (モックの OpenAI)");
const requests = [];
let replies = [];
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw || "{}");
    requests.push(body);
    const data = replies.shift() ?? { items: [], lineCount: 0 };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "c", model: "gpt-4.1", choices: [{ message: { role: "assistant", content: JSON.stringify({ confidence: 0.9, warnings: [], ...data }) }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 50 } }));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
Object.assign(process.env, { OPENAI_API_KEY: "sk-test-mock", OPENAI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, OPENAI_MODEL: "gpt-4.1" });
const img = { kind: "handwritten_quote", fileName: "見本.jpg", mimeType: "image/jpeg", base64: Buffer.from("fake").toString("base64"), products, storeId: "koshi" };
const userText = (b) => (b.messages?.[1]?.content ?? []).filter((p) => p.type === "text").map((p) => p.text).join("\n");

try {
  // 1 回目: 4 行と数えて 3 行 (3 行目が抜け) → 読み直しも 3 行 → 1 回目を使い、3 行目に空の行
  replies = [
    { lineCount: 4, items: [{ line: 1, name: "畳表替え", spec: "さくら", qty: 6, unit: "畳", unitPrice: 15000, amount: 90000 }, { line: 2, name: "襖張替え", qty: 4, unitPrice: 5000, amount: 20000 }, { line: 4, name: "諸経費", qty: null, unitPrice: null, amount: 3300 }], customerName: "見本 太郎" },
    { lineCount: 4, items: [{ line: 1, name: "畳表替え", qty: 6, unitPrice: 15000, amount: 90000 }, { line: 2, name: "襖張替え", qty: 4, unitPrice: 5000, amount: 20000 }] },
  ];
  requests.length = 0;
  const x1 = await O.extractDocument(img);
  eq(requests.length, 2, "数えた行より少ないので 1 回だけ読み直す");
  ok(userText(requests[1]).includes("4 行") && userText(requests[1]).includes("3 行しかありませんでした"), "読み直しの依頼に行数を書く");
  ok(requests[0].response_format?.json_schema?.schema?.properties?.lineCount?.type === "integer" && requests[0].response_format.json_schema.schema.properties.items.items.properties.line?.type === "integer", "AI に行数 (lineCount) と各行の何行目か (line) を聞く");
  eq(x1.extracted.items.map((i) => i.name), ["畳表替え", "襖張替え", "", "諸経費"], "読み直しで増えなければ 1 回目の結果 + 3 行目に空の行");
  ok(x1.extracted.items[2].uncertain === true && x1.warnings.some((w) => w.includes("3 行目")), "空の行は要確認・位置を知らせる");
  ok(!("lineCount" in x1.extracted), "数えた行数は読取結果に残さない");

  // 読み直しで全部の行が返ってきたら、読み直しの結果を使う
  replies = [
    { lineCount: 3, items: [{ line: 1, name: "畳表替え", qty: 6, unitPrice: 15000, amount: 90000 }] },
    { lineCount: 3, items: [{ line: 1, name: "畳表替え", qty: 6, unitPrice: 15000, amount: 90000 }, { line: 2, name: "", qty: 2, unitPrice: null, amount: 8000, uncertain: true }, { line: 3, name: "諸経費", amount: 3300 }] },
  ];
  requests.length = 0;
  const x2 = await O.extractDocument(img);
  eq([requests.length, x2.extracted.items.length], [2, 3], "読み直しで行が増えたら読み直しの結果を使う");
  ok(x2.extracted.items[1].name === "" && x2.extracted.items[1].uncertain === true && x2.extracted.items[1].amount === 8000, "品名が読めない行も読めた数字 (金額) は残す");
  ok(!x2.warnings.some((w) => w.startsWith("用紙の明細は")), "そろったら空の行は足さない");

  // 数えた行と同じなら読み直さない
  replies = [{ lineCount: 2, items: [{ line: 1, name: "網戸張替え", qty: 2, unitPrice: 3300, amount: 6600 }, { line: 2, name: "諸経費", amount: 1100 }] }];
  requests.length = 0;
  const x3 = await O.extractDocument(img);
  eq([requests.length, x3.extracted.items.length], [1, 2], "行がそろっていれば 1 回だけ");

  // 読み直しが失敗しても 1 回目の結果を使う
  replies = [{ lineCount: 2, items: [{ line: 1, name: "畳", qty: 6, unitPrice: 10000, amount: 60000 }] }];
  const realReplies = replies;
  let n = 0;
  server.removeAllListeners("request");
  server.on("request", (req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      n++;
      if (n === 1) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "c", model: "gpt-4.1", choices: [{ message: { role: "assistant", content: JSON.stringify({ confidence: 0.9, warnings: [], ...realReplies[0] }) }, finish_reason: "stop" }] }));
      } else {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "bad request" } }));
      }
    });
  });
  const x4 = await O.extractDocument(img);
  ok(x4.provider === "openai" && x4.extracted.items.length === 2 && x4.extracted.items[1].uncertain === true, "読み直しに失敗しても読み取りは失敗にしない (1 回目 + 空の行)");

  // ほかの書類は読み直さない
  n = 0;
  replies = [];
  server.removeAllListeners("request");
  server.on("request", (req, res) => {
    req.resume();
    req.on("end", () => {
      n++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "c", model: "gpt-4.1", choices: [{ message: { role: "assistant", content: JSON.stringify({ confidence: 0.9, warnings: [], vendor: "店", items: [{ name: "品", qty: 1, amount: 100 }] }) }, finish_reason: "stop" }] }));
    });
  });
  await O.extractDocument({ ...img, kind: "receipt" });
  eq(n, 1, "レシートなどほかの書類は 1 回だけ (行の数え直しは手書き見積書だけ)");
} finally {
  server.close();
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log("FAILED:\n - " + fails.join("\n - "));
  process.exitCode = 1;
}
fs.rmSync(work, { recursive: true, force: true });
