#!/usr/bin/env node
/**
 * Supabase のデータベースで SQL ファイルを実行する (psql がなくても ichijoya.sql を流せる)
 *
 *   node scripts/import/setup-database.mjs                       → supabase/ichijoya.sql (テーブル定義 + 全データ + 件数の確認)
 *   node scripts/import/setup-database.mjs supabase/migrations/20261112000000_initial_schema.sql   (テーブル定義だけ)
 *
 * 接続情報 (.env.local または環境変数):
 *   SUPABASE_DB_URL=postgresql://postgres.<ref>:<password>@<host>:5432/postgres   (Supabase の Connect → Session pooler)
 *   または SUPABASE_DB_PASSWORD=<データベースのパスワード>
 *     (NEXT_PUBLIC_SUPABASE_URL からプロジェクトを判定し、直接接続 → 接続プーラー (各リージョン) の順に試す)
 *   .env.local に書くときは値を '...' で囲む (# 以降がコメント扱いになるため)
 *
 * - データが入っているデータベースで、行を置き換える SQL (truncate を含む) を実行するときは --yes が必要
 * - 最後の結果が件数の確認 (ok 列) なら表示し、1 つでも false なら終了コード 1
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { loadEnv } from "./env.mjs";

const require = createRequire(import.meta.url);
const { Client } = require("pg");
loadEnv();

const args = process.argv.slice(2);
const SQL_FILE = path.resolve(args.find((a) => !a.startsWith("--")) ?? "supabase/ichijoya.sql");
const YES = args.includes("--yes");
const REGIONS = ["ap-northeast-1", "ap-northeast-2", "ap-southeast-1", "ap-southeast-2", "ap-south-1", "us-east-1", "us-east-2", "us-west-1", "us-west-2", "eu-west-1", "eu-west-2", "eu-west-3", "eu-central-1", "eu-central-2", "eu-north-1", "ca-central-1", "sa-east-1"];

if (!fs.existsSync(SQL_FILE)) {
  console.error(`SQL ファイルがありません: ${path.relative(process.cwd(), SQL_FILE)}`);
  if (/ichijoya\.sql$/.test(SQL_FILE)) console.error("先に node scripts/import/generate-data-sql.mjs で作成してください。");
  process.exit(1);
}

const mask = (s) => s.replace(/:\/\/([^:]+):[^@]+@/, "://$1:****@");
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

function candidates() {
  if (process.env.SUPABASE_DB_URL) return { direct: [process.env.SUPABASE_DB_URL], poolers: [] };
  const pw = process.env.SUPABASE_DB_PASSWORD;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!pw || !url) throw new Error("SUPABASE_DB_URL または SUPABASE_DB_PASSWORD (+ NEXT_PUBLIC_SUPABASE_URL) を設定してください。");
  const ref = new URL(url).hostname.split(".")[0];
  const enc = encodeURIComponent(pw);
  const poolers = [];
  for (const prefix of ["aws-0", "aws-1"]) for (const r of REGIONS) poolers.push(`postgresql://postgres.${ref}:${enc}@${prefix}-${r}.pooler.supabase.com:5432/postgres`);
  return { direct: [`postgresql://postgres:${enc}@db.${ref}.supabase.co:5432/postgres`], poolers };
}

async function tryConnect(conn) {
  const client = new Client({ connectionString: conn, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10000, keepAlive: true });
  try {
    await client.connect();
    return client;
  } catch (err) {
    await client.end().catch(() => {});
    const msg = String(err.message);
    // パスワード誤りは他の接続先を試しても同じなので中止
    if (/password authentication failed|28P01|SASL/.test(msg) || err.code === "28P01") throw Object.assign(new Error(`パスワードが正しくありません (${mask(conn)})`), { fatal: true });
    throw new Error(`${mask(conn)}: ${msg.slice(0, 80)}`);
  }
}

async function connect() {
  const { direct, poolers } = candidates();
  for (const conn of direct) {
    try {
      const client = await tryConnect(conn);
      return { client, conn };
    } catch (err) {
      if (err.fatal) throw err;
      log(`直接接続できないため接続プーラーを試します (${err.message})`);
    }
  }
  if (!poolers.length) throw new Error("データベースに接続できませんでした");
  // 接続プーラーはプロジェクトのリージョンでしか応答しないので、並列に試して最初につながったものを使う
  const attempts = poolers.map((conn) => tryConnect(conn).then((client) => ({ client, conn })));
  let winner;
  try {
    winner = await Promise.any(attempts);
  } catch (agg) {
    const fatal = agg.errors.find((e) => e.fatal);
    throw fatal ?? new Error("データベースに接続できませんでした (どのリージョンの接続プーラーにもつながりません)");
  }
  for (const a of attempts) a.then(({ client }) => client !== winner.client && client.end().catch(() => {})).catch(() => {});
  return winner;
}

const sql = fs.readFileSync(SQL_FILE, "utf8");
const { client, conn } = await connect();
log(`接続しました: ${mask(conn)}`);
client.on("notice", () => {}); // truncate ... cascade の通知は表示しない
try {
  await client.query("set statement_timeout = 0");
  if (/\btruncate\b/i.test(sql) && !YES) {
    const { rows } = await client.query("select to_regclass('public.users') is not null as has_table");
    const users = rows[0].has_table ? Number((await client.query("select count(*) from public.users")).rows[0].count) : 0;
    if (users > 0) {
      console.error(`このデータベースにはすでにデータがあります (users ${users} 行)。${path.basename(SQL_FILE)} を実行すると、アプリで登録したデータを含めて全行が置き換わります。よろしければ --yes を付けて実行してください。`);
      process.exitCode = 1;
      process.exit();
    }
  }
  log(`${path.relative(process.cwd(), SQL_FILE)} (${(Buffer.byteLength(sql) / 1024 / 1024).toFixed(1)} MB) を実行しています…`);
  const res = await client.query(sql);
  const results = Array.isArray(res) ? res : [res];
  log(`完了 (${results.length} 文)`);
  const last = results.at(-1);
  if (last?.fields?.some((f) => f.name === "ok")) {
    console.table(last.rows);
    const bad = last.rows.filter((r) => !r.ok);
    if (bad.length) {
      console.error(`件数が一致しないテーブルがあります: ${bad.map((r) => r.table_name ?? JSON.stringify(r)).join(", ")}`);
      process.exitCode = 1;
    } else console.log(`件数の確認: ${last.rows.length} テーブルすべて一致`);
  } else {
    const { rows } = await client.query("select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1");
    console.log(`public のテーブル (${rows.length}): ${rows.map((r) => r.table_name).join(", ")}`);
  }
  if (!process.env.SUPABASE_DB_URL) console.log(`\n次回からはこの接続文字列を SUPABASE_DB_URL に設定すると速く接続できます: ${mask(conn)}`);
} finally {
  await client.end();
}
