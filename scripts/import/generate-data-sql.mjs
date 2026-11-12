#!/usr/bin/env node
/**
 * 移行データ (data/import/client-data.json) → Supabase で実行する SQL
 *
 *   node scripts/import/generate-data-sql.mjs                 → supabase/ichijoya.sql (1 ファイル。psql 用)
 *   node scripts/import/generate-data-sql.mjs --split         → supabase/data/*.sql   (分割版。SQL Editor 用)
 *
 * オプション: [データ=data/import/client-data.json] [--out=出力先] [--max-kb=900 (分割版の 1 ファイルの大きさ)]
 *             [--no-demo (デモ用アカウント 15 名を含めない)]
 *
 * 移行データに加えて、デモ用アカウント (架空の 15 名・パスワード demo1234。scripts/import/demo-accounts.mjs) を users に登録する。
 *
 * SQL Editor は 1 回に約 1 MB までしか実行できない (Supabase Studio の上限 0.98 MB。超えると
 * "Query is too large to be run via the SQL Editor")。ichijoya.sql (約 31 MB) は psql で実行し、
 * SQL Editor では分割版 (1 ファイル 900 KB 以下) を使う。
 *
 * supabase/ichijoya.sql の中身 (上から順に実行され、何度実行しても同じ状態になる):
 *   1. テーブル定義 (scripts/import/schema-sql.mjs。既存のテーブルは消さない)
 *   2. データの入れ替え (1 つのトランザクション: 全テーブルの行を削除 → 移行データを登録 → メタ情報の更新)
 *   3. 件数の確認 (結果の ok がすべて true なら完了)
 *
 * 分割版 (supabase/data/) は 00_start.sql (テーブル定義 + 既存データの削除) → 01_data.sql … → 99_finish.sql の順に実行する。
 * 各ファイルは 1 つのトランザクションで、失敗したファイルは何も登録されないので、同じファイルから再実行できる。
 *
 * - 出力にはお客様の個人情報が含まれるため .gitignore で除外している。コミット・共有しないこと
 * - 行の変換はアプリ (src/lib/db/supabase.ts) と同じ: 列名は snake_case、値がない項目は null
 */
import fs from "node:fs";
import path from "node:path";
import { META_TABLE, TABLES, snake } from "../../src/lib/db/schema.ts";
import { buildSchemaSql } from "./schema-sql.mjs";
import { withDemoAccounts } from "./demo-accounts.mjs";

const args = process.argv.slice(2);
const opt = (name, def) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? def;
const SPLIT = args.includes("--split");
const FILE = path.resolve(args.find((a) => !a.startsWith("--")) ?? "data/import/client-data.json");
const OUT = path.resolve(opt("out", SPLIT ? "supabase/data" : "supabase/ichijoya.sql"));
const MAX_BYTES = Number(opt("max-kb", "900")) * 1024;
const TAG = "$json$";
// Supabase Studio の SQL Editor が実行できる SQL の上限 (UTF-8 のバイト数。apps/studio/data/sql/execute-sql-mutation.ts の 0.98 * MB)
const EDITOR_LIMIT = Math.floor(0.98 * 1024 * 1024);
// ファイルの見出し・コメントの分
const HEADER_ROOM = 8 * 1024;

if (SPLIT && !(MAX_BYTES > HEADER_ROOM * 4 && MAX_BYTES <= EDITOR_LIMIT)) {
  console.error(`--max-kb は ${(HEADER_ROOM * 4) / 1024 + 1}〜${Math.floor(EDITOR_LIMIT / 1024)} で指定してください (SQL Editor は 1 回に約 1 MB までしか実行できません)`);
  process.exit(1);
}

if (!fs.existsSync(FILE)) {
  console.error(`移行データがありません: ${path.relative(process.cwd(), FILE)}\n先に node scripts/import/extract-client-data.mjs を実行してください。`);
  process.exit(1);
}
const DEMO = !args.includes("--no-demo");
const source = JSON.parse(fs.readFileSync(FILE, "utf8"));
const db = DEMO ? withDemoAccounts(source) : source;
const demoNote = DEMO ? "デモ用アカウント 15 名 (パスワード demo1234) を含む" : "デモ用アカウントは含まない";
const stamp = new Date().toISOString();
const total = TABLES.reduce((a, t) => a + (db[t.collection] ?? []).length, 0);

/* ---------------- SQL の部品 ---------------- */

const banner = (lines) => ["-- ============================================================", ...lines.map((l) => (l ? `-- ${l}` : "--")), "-- ============================================================", ""].join("\n");

// 値のない項目は書かない (jsonb_populate_recordset は無い項目を null にするので、アプリの書き込みと同じ結果になる)
const toRow = (def, e) => Object.fromEntries(def.columns.filter(([f]) => e[f] !== undefined && e[f] !== null).map(([f]) => [snake(f), e[f]]));
const insert = (def, rows) => {
  const json = JSON.stringify(rows.map((r) => toRow(def, r)));
  if (json.includes(TAG)) throw new Error(`${def.table}: データに ${TAG} が含まれるため出力できません`);
  return `insert into ${def.table}\nselect * from jsonb_populate_recordset(null::${def.table}, ${TAG}${json}${TAG}::jsonb);\n`;
};

/** テーブルごとに、1 文が limit バイト以内になるよう行を分けた insert 文 */
function insertStatements(limit) {
  const out = [];
  for (const def of TABLES) {
    const rows = db[def.collection] ?? [];
    let i = 0;
    let perRow = 0; // 直前の文の 1 行あたりのバイト数 (次の文の行数の見積もりに使う)
    while (i < rows.length) {
      let n = Math.min(rows.length - i, perRow ? Math.max(1, Math.floor((limit * 0.95) / perRow)) : 5000);
      let sql = insert(def, rows.slice(i, i + n));
      while (Buffer.byteLength(sql) > limit && n > 1) {
        n = Math.max(1, Math.floor(n * (perRow ? 0.9 : 0.6)));
        sql = insert(def, rows.slice(i, i + n));
      }
      perRow = Buffer.byteLength(sql) / n;
      out.push({ table: def.table, from: i + 1, to: i + n, sql });
      i += n;
    }
  }
  return out;
}

const resetSql = () =>
  `truncate table ${[...TABLES].reverse().map((t) => t.table).join(", ")} cascade;\n` +
  `update ${META_TABLE} set source = null, imported_at = null where id = 1;\n`;

const q = (s) => (s == null ? "null" : `'${String(s).replace(/'/g, "''")}'`);
const meta = db.meta ?? {};
const metaSql = () =>
  `update ${META_TABLE} set version = ${Number(meta.version ?? 3)}, seeded_at = ${q(meta.seededAt)}, source = ${q(meta.source ?? "client-materials")}, imported_at = ${q(meta.importedAt ?? stamp)} where id = 1;\n` +
  "-- 起動中のアプリ (他のサーバー) にデータの更新を知らせる\n" +
  "select public.bump_revision();\n";

const checkSql = () =>
  "select name as table_name, expected, actual, expected = actual as ok\nfrom (values\n" +
  TABLES.map((t) => `  ('${t.table}', ${(db[t.collection] ?? []).length}, (select count(*) from ${t.table}))`).join(",\n") +
  "\n) as t(name, expected, actual)\norder by ok, name;\n";

const kb = (s) => `${(Buffer.byteLength(s) / 1024).toFixed(0)} KB`;

/* ---------------- 1 ファイル: supabase/ichijoya.sql ---------------- */

if (!SPLIT) {
  const statements = insertStatements(512 * 1024);
  const sql =
    banner([
      "一畳屋 統合業務システム データベース (テーブル定義 + 移行データ) — 1 ファイルで起動",
      `生成: node scripts/import/generate-data-sql.mjs (${stamp})`,
      `内容: ${TABLES.length + 1} テーブル / ${total.toLocaleString("en-US")} 行 (共有資料から移行したデータ。サンプルデータは含まない。${demoNote})`,
      "",
      "実行方法 (どちらか):",
      "  node scripts/import/setup-database.mjs   (SUPABASE_DB_PASSWORD または SUPABASE_DB_URL を設定。psql 不要)",
      "  psql \"<Supabase の接続文字列>\" -v ON_ERROR_STOP=1 -f supabase/ichijoya.sql",
      "最後に表示される件数の確認で ok がすべて true なら完了です。",
      "",
      "SQL Editor では実行できません (1 回に約 1 MB まで。このファイルは約 31 MB)。",
      "SQL Editor を使うときは node scripts/import/generate-data-sql.mjs --split で作る",
      "supabase/data/ のファイル (1 ファイル 900 KB 以下) を順に実行してください。",
      "",
      "何度実行しても同じ状態になります (テーブルは作り直さず、データだけを入れ替えます)。",
      "注意: 実行すると、データベースの既存の行 (アプリで登録したデータを含む) はすべて削除されます。",
      "お客様の個人情報を含みます。コミット・共有しないでください (.gitignore で除外済み)。",
    ]) +
    "\n" +
    banner(["1. テーブル定義"]) +
    buildSchemaSql({ header: false }) +
    "\n" +
    banner(["2. データの入れ替え (すべて成功したときだけ反映されます)"]) +
    "begin;\nset local statement_timeout = 0;\n\n" +
    "-- 既存の行をすべて削除 (サンプルデータを含む)\n" +
    resetSql() +
    "\n" +
    statements.map((s) => `-- ${s.table} ${s.from}〜${s.to}\n${s.sql}`).join("\n") +
    "\n-- メタ情報\n" +
    metaSql() +
    "commit;\n\n" +
    banner(["3. 件数の確認 (ok がすべて true なら完了)"]) +
    checkSql();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, sql, "utf8");
  console.log(`wrote ${path.relative(process.cwd(), OUT)} (${(Buffer.byteLength(sql) / 1048576).toFixed(1)} MB, ${total} rows, ${TABLES.length} tables + ${META_TABLE})`);
  if (Buffer.byteLength(sql) > EDITOR_LIMIT)
    console.log("psql で実行してください。SQL Editor は 1 回に約 1 MB までなので、SQL Editor を使うときは --split で分割版を作ってください。");
  process.exit(0);
}

/* ---------------- 分割版: supabase/data/*.sql ---------------- */

fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) if (f.endsWith(".sql")) fs.rmSync(path.join(OUT, f));

const header = (title, note = []) =>
  banner([
    `一畳屋 統合業務システム 移行データ: ${title}`,
    `生成: node scripts/import/generate-data-sql.mjs --split (${stamp})`,
    "お客様の個人情報を含みます。コミット・共有しないでください",
    ...note,
  ]);

const files = [];
const write = (name, body) => {
  fs.writeFileSync(path.join(OUT, name), body, "utf8");
  files.push({ name, body });
};

write(
  "00_start.sql",
  header("00 テーブル定義 + 既存データの削除", [
    "最初に実行してください。テーブルを作成し (既存のテーブルはそのまま)、すべてのテーブルの行を削除します",
    "このあと 01_data.sql から順に実行し、最後に 99_finish.sql を実行します",
  ]) +
    "\n" +
    buildSchemaSql({ header: false }) +
    "\n-- 既存の行をすべて削除 (サンプルデータを含む)\n" +
    "begin;\n" +
    resetSql() +
    "commit;\n",
);

let part = [];
let size = 0;
let no = 1;
const flush = () => {
  if (!part.length) return;
  const name = `${String(no).padStart(2, "0")}_data.sql`;
  write(
    name,
    header(`${String(no).padStart(2, "0")} データ登録`, ["内容: " + part.map((s) => `${s.table} ${s.from}〜${s.to}`).join(" / ")]) +
      "begin;\nset local statement_timeout = '5min';\n\n" +
      part.map((s) => `-- ${s.table} ${s.from}〜${s.to}\n${s.sql}`).join("\n") +
      "\ncommit;\n",
  );
  no += 1;
  part = [];
  size = 0;
};
// 1 文はファイルの 1/4 まで (ファイルに隙間なく詰めるため)。見出し・コメントの分を空けておく
const budget = MAX_BYTES - HEADER_ROOM;
for (const s of insertStatements(budget / 4)) {
  const b = Buffer.byteLength(s.sql);
  if (size + b > budget) flush();
  part.push(s);
  size += b;
}
flush();
if (no > 98) throw new Error("ファイル数が多すぎます。--max-kb を大きくしてください");

write(
  "99_finish.sql",
  header("99 仕上げと件数の確認", ["最後に実行してください。結果の ok がすべて true なら移行は完了です"]) + "begin;\n" + metaSql() + "commit;\n\n" + checkSql(),
);

// SQL Editor で実行できる大きさか確認 (超えると "Query is too large to be run via the SQL Editor")
const tooLarge = files.filter((f) => Buffer.byteLength(f.body) > MAX_BYTES);
if (tooLarge.length) throw new Error(`${tooLarge.map((f) => `${f.name} (${kb(f.body)})`).join(", ")} が ${MAX_BYTES / 1024} KB を超えています`);

for (const f of files) console.log(`${f.name.padEnd(16)} ${kb(f.body).padStart(9)}`);
console.log(`\n${path.relative(process.cwd(), OUT)}: ${files.length} files, ${total} rows (${TABLES.length} tables)`);
console.log("SQL Editor で 00_start.sql → 01_data.sql … → 99_finish.sql の順に実行してください (各ファイルの内容を貼り付けて Run)");
