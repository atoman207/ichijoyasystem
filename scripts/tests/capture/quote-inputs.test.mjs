/**
 * 見積の明細の数字の欄が、手書き見積書の金額で保存を止めないことのテスト
 *   node scripts/tests/capture/quote-inputs.test.mjs   (npm run test:capture)
 * 2026-11-23: 値引きの欄が 1,000 円単位 (step=1000・min=0)、単価の欄が 100 円単位 (step=100) で、
 * 値引き 20 円・5,300 円や、読取の単価を 100 円単位でない額に直した見積を、ブラウザーが
 * 「有効な値を入力してください」として保存させなかった (見積が 1 件も作られず、承認の画面にも何も出なかった)。
 * 金額・数量の欄は step="any" にする (刻みはサーバーで確かめない。円未満はサーバーが丸める)。
 */
import fs from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "../../..");

let pass = 0;
const fails = [];
const ok = (cond, msg) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fails.push(msg);
    console.log(`  ✗ ${msg}`);
  }
};

/** type="number" の <input> / <Input> のタグ (複数行も。onChange の => で切れないよう、閉じの /> まで) */
function numberInputs(src) {
  const tags = src.match(/<(?:input|Input)\b[\s\S]*?\/>/g) ?? [];
  return tags.filter((t) => t.includes('type="number"')).map((t) => t.replace(/\s+/g, " "));
}

console.log("\n見積の明細 (QuoteEditor)");
const editor = fs.readFileSync(path.join(root, "src/components/features/QuoteEditor.tsx"), "utf8");
const inputs = numberInputs(editor);
ok(inputs.length >= 3, `数字の欄 (数量・単価・値引き) がある (${inputs.length} 個)`);
for (const t of inputs) {
  const label = t.match(/aria-label="([^"]+)"/)?.[1] ?? (t.includes("discount") ? "値引き" : t.slice(0, 60));
  ok(/step="any"/.test(t), `「${label}」は step="any" (10,560 円・値引き 5,300 円で保存を止めない)`);
}
const price = inputs.find((t) => t.includes('aria-label="単価"'));
ok(Boolean(price) && !/inputMode=/.test(price), "単価は数字だけのキーボードにしない (iPhone で値引きの行のマイナスを入力できるように)");

console.log("\n見積・請求の画面の金額の欄");
// 金額の欄に 100 円・1,000 円単位の刻みを付けない (設定の基準額などは除く)
const MONEY = /単価|値引|金額|unitPrice|discount|amount/;
const files = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (p.endsWith(".tsx")) files.push(p);
  }
};
walk(path.join(root, "src"));
const coarse = [];
for (const f of files) {
  for (const t of numberInputs(fs.readFileSync(f, "utf8"))) {
    const step = t.match(/step=(?:"([^"]+)"|\{(\d+)\})/);
    const n = step ? Number(step[1] ?? step[2]) : NaN;
    if (MONEY.test(t) && n >= 10) coarse.push(`${path.relative(root, f)}: ${t.slice(0, 120)}`);
  }
}
ok(coarse.length === 0, `明細の金額の欄に 10 円以上の刻みがない${coarse.length ? `\n      ${coarse.join("\n      ")}` : ""}`);

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
