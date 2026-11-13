#!/usr/bin/env node
/**
 * テーブル定義を Supabase に反映する (既存のデータは変えない。テーブル・列・索引の追加だけ)
 *
 *   npm run db:migrate                                 → schema.ts から SQL を作り直して反映 (手元で使う)
 *   node scripts/import/migrate.mjs --if-configured    → npm run build の前に自動で実行 (package.json の prebuild)
 *
 * - 反映する SQL は supabase/migrations/20261112000000_initial_schema.sql (generate-schema.mjs が schema.ts から作る)。
 *   何度実行しても同じ結果になる (create ... if not exists / add column if not exists)
 * - --if-configured: 接続情報 (SUPABASE_DB_PASSWORD または SUPABASE_DB_URL) がない、または DATA_BACKEND=json
 *   (ローカルのサンプルデータ) のときは何もせずに終わる。接続情報があって反映に失敗したときは終了コード 1 (ビルドを止める)
 * - テーブル・列が増えたときは、起動中のアプリ (Vercel を含む) が読み直すようにリビジョンを +1 する
 * - 列の削除・型の変更は行わない (必要なときは移行用の SQL を別に書く)
 */
import fs from "node:fs";
import path from "node:path";
import { loadEnv } from "./env.mjs";
import { connectDatabase, hasDbCredentials, mask } from "./db-connect.mjs";

loadEnv();
const IF_CONFIGURED = process.argv.includes("--if-configured");
const FILE = path.resolve("supabase/migrations/20261112000000_initial_schema.sql");
const t0 = Date.now();
const log = (m) => console.log(`[db:migrate ${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

const skip = process.env.DATA_BACKEND === "json" ? "DATA_BACKEND=json (ローカルのサンプルデータ)" : !hasDbCredentials() ? "接続情報 (SUPABASE_DB_PASSWORD / SUPABASE_DB_URL) が未設定" : "";
if (skip) {
  if (IF_CONFIGURED) {
    console.log(`[db:migrate] テーブル定義の反映をスキップしました: ${skip}`);
    process.exit(0);
  }
  console.error(`テーブル定義を反映できません: ${skip}`);
  process.exit(1);
}
if (!fs.existsSync(FILE)) {
  console.error(`テーブル定義の SQL がありません: ${path.relative(process.cwd(), FILE)} (node scripts/import/generate-schema.mjs で作成)`);
  process.exit(1);
}

const sql = fs.readFileSync(FILE, "utf8");
const columnsSql = "select table_name, column_name from information_schema.columns where table_schema = 'public' order by 1, 2";
let client;
try {
  const c = await connectDatabase(log);
  client = c.client;
  log(`接続しました: ${mask(c.conn)}`);
  client.on("notice", () => {});
  // 使用中のテーブルを長く止めないよう、ロックを待つのは 10 秒まで (待ち切れなければ失敗にして、再実行する)
  await client.query("set lock_timeout = '10s'; set statement_timeout = '120s'");
  const before = new Set((await client.query(columnsSql)).rows.map((r) => `${r.table_name}.${r.column_name}`));
  await client.query(sql);
  const after = (await client.query(columnsSql)).rows.map((r) => `${r.table_name}.${r.column_name}`);
  const added = after.filter((k) => !before.has(k));
  const beforeTables = new Set([...before].map((k) => k.split(".")[0]));
  const newTables = [...new Set(added.map((k) => k.split(".")[0]))].filter((t) => !beforeTables.has(t));
  const newColumns = added.filter((k) => !newTables.includes(k.split(".")[0]));
  if (added.length) {
    await client.query("select public.bump_revision()");
    log(`反映しました: ${[newTables.length ? `テーブル追加 ${newTables.join(", ")}` : "", newColumns.length ? `列追加 ${newColumns.join(", ")}` : ""].filter(Boolean).join(" / ")}`);
  } else {
    log(`変更はありません (テーブル定義はデータベースと一致。${new Set(after.map((k) => k.split(".")[0])).size} テーブル)`);
  }
} catch (err) {
  console.error(`[db:migrate] テーブル定義の反映に失敗しました: ${err.message}`);
  process.exitCode = 1;
} finally {
  await client?.end().catch(() => {});
}
