#!/usr/bin/env node
/**
 * デモ用アカウント (架空の 15 名・パスワード demo1234) を Supabase に登録する
 *
 *   node scripts/import/seed-demo-accounts.mjs          → 登録 (既にあれば更新し、パスワードを demo1234 に戻して有効にする)
 *   node scripts/import/seed-demo-accounts.mjs --off    → 無効にする (ログインできなくなる。登録した案件・履歴は残る)
 *   node scripts/import/seed-demo-accounts.mjs --sql    → 同じ内容の SQL を supabase/demo-accounts.sql に書き出す (SQL Editor 用)
 *                                                         (--off --sql で無効化の SQL)
 *
 * - 接続は NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SECRET_KEY (.env.local)。users テーブルの 15 行だけを書き換え、ほかのデータには触れない
 * - アカウントの中身は scripts/import/demo-accounts.mjs (元: src/lib/db/master.ts の USERS)
 * - 実行後にリビジョンを +1 するので、起動中のアプリ (Vercel を含む) は再起動なしで次の画面表示から反映する
 */
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { TABLES, snake } from "../../src/lib/db/schema.ts";
import { DEMO_PASSWORD, demoAccounts, verifyHash } from "./demo-accounts.mjs";
import { loadEnv } from "./env.mjs";

loadEnv();
const args = process.argv.slice(2);
const OFF = args.includes("--off");
const SQL = args.includes("--sql");
const SQL_FILE = path.resolve("supabase/demo-accounts.sql");

const def = TABLES.find((t) => t.collection === "users");
const accounts = demoAccounts();
const ids = accounts.map((u) => u.id);
const toRow = (e) => Object.fromEntries(def.columns.map(([f]) => [snake(f), e[f] === undefined ? null : e[f]]));
const STORE_NAME = { koshi: "合志店", chuo: "中央店", nishi: "西店", tamana: "玉名店", hq: "本社" };
const ROLE_NAME = { admin: "管理者", store_manager: "店長", store_staff: "店舗スタッフ", hq_staff: "本部スタッフ" };

/* ---------------- SQL ファイル (SQL Editor 用) ---------------- */

if (SQL) {
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const idList = ids.map(q).join(", ");
  const cols = def.columns.map(([f]) => snake(f)).filter((c) => c !== "id");
  const body = OFF
    ? `update users set active = false where id in (${idList});\n`
    : "insert into users\n" +
      `select * from jsonb_populate_recordset(null::users, $json$${JSON.stringify(accounts.map(toRow))}$json$::jsonb)\n` +
      `on conflict (id) do update set ${cols.map((c) => `${c} = excluded.${c}`).join(", ")};\n`;
  const sql =
    [
      "-- ============================================================",
      `-- デモ用アカウント (架空の 15 名) の${OFF ? "無効化" : "登録"}`,
      "-- 生成: node scripts/import/seed-demo-accounts.mjs --sql" + (OFF ? " --off" : ""),
      OFF
        ? "-- ログインできなくなります。登録した案件・履歴は残ります。元に戻すには --sql (--off なし) の SQL を実行します"
        : `-- ログイン ID は <名前>@ichijoya.example、パスワードは ${DEMO_PASSWORD} (保存するのはハッシュだけ)`,
      "-- users テーブルのデモ用アカウント 15 行だけを書き換えます。何度実行しても同じ状態になります",
      "-- Supabase ダッシュボード → SQL Editor に貼り付けて Run",
      "-- ============================================================",
      "",
    ].join("\n") +
    "begin;\n" +
    body +
    "-- 起動中のアプリにデータの更新を知らせる\nselect public.bump_revision();\ncommit;\n\n" +
    `select id, email, role, store_id, title, active from users where id in (${idList}) order by id;\n`;
  fs.writeFileSync(SQL_FILE, sql, "utf8");
  console.log(`wrote ${path.relative(process.cwd(), SQL_FILE)} (${(Buffer.byteLength(sql) / 1024).toFixed(1)} KB)`);
  process.exit(0);
}

/* ---------------- Supabase に直接登録 ---------------- */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) {
  console.error("NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SECRET_KEY を .env.local に設定してください (SQL Editor で行う場合は --sql)。");
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

if (OFF) {
  const { error, count } = await sb.from("users").update({ active: false }, { count: "exact" }).in("id", ids);
  if (error) fail(`無効化に失敗: ${error.message}`);
  const r = await sb.rpc("bump_revision");
  if (r.error) fail(`bump_revision: ${r.error.message}`);
  console.log(`デモ用アカウントを無効にしました (${count ?? 0} 件)。再び使うときは --off を付けずに実行してください。`);
  process.exit(0);
}

// ログイン ID が、デモ用以外のユーザーと重なっていないか
const emails = accounts.map((u) => u.email);
const dup = await sb.from("users").select("id, email").in("email", emails);
if (dup.error) fail(`users の読み込みに失敗: ${dup.error.message}`);
const clash = (dup.data ?? []).filter((r) => !ids.includes(r.id));
if (clash.length) fail(`ログイン ID がほかのユーザーと重なっています: ${clash.map((r) => r.email).join(", ")}`);

const { error } = await sb.from("users").upsert(accounts.map(toRow), { onConflict: "id" });
if (error) fail(`登録に失敗: ${error.message}${error.details ? ` (${error.details})` : ""}`);
const r = await sb.rpc("bump_revision");
if (r.error) fail(`bump_revision: ${r.error.message}`);

// 登録内容を読み直して、パスワード demo1234 で照合できることを確かめる
const back = await sb.from("users").select("id, email, role, store_id, active, password_hash").in("id", ids).order("id");
if (back.error) fail(`確認の読み込みに失敗: ${back.error.message}`);
let ok = back.data.length === accounts.length;
for (const row of back.data) {
  const pass = row.active && verifyHash(row.password_hash, DEMO_PASSWORD);
  ok &&= pass;
  console.log(`${pass ? "✓" : "✗"} ${ROLE_NAME[row.role].padEnd(6, "　")} ${STORE_NAME[row.store_id].padEnd(3, "　")} ${row.email}`);
}
console.log(ok ? `\n完了: ${back.data.length} 件。パスワード ${DEMO_PASSWORD} でログインできます。` : "\n確認できないアカウントがあります。");
process.exit(ok ? 0 : 1);
