#!/usr/bin/env node
/**
 * 取込データ (data/import/client-data.json) を Supabase に書き込む
 *   node scripts/import/load-to-supabase.mjs [データ=data/import/client-data.json] [--yes] [--no-demo]
 *
 * - 既存の行 (サンプルデータを含む) をすべて削除してから、取込データだけを入れ直す
 * - デモ用アカウント (架空の 15 名・パスワード demo1234。scripts/import/demo-accounts.mjs) も users に登録する (--no-demo で含めない)
 * - 接続は NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SECRET_KEY (.env.local)
 * - 実行には --yes が必要 (誤って本番データを消さないため)
 */
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { META_TABLE, TABLES, snake } from "../../src/lib/db/schema.ts";
import { loadEnv } from "./env.mjs";
import { withDemoAccounts } from "./demo-accounts.mjs";

loadEnv();
const args = process.argv.slice(2);
const FILE = path.resolve(args.find((a) => !a.startsWith("--")) ?? "data/import/client-data.json");
if (!args.includes("--yes")) {
  console.error("Supabase の既存データをすべて削除して取込データで置き換えます。よろしければ --yes を付けて実行してください。");
  process.exit(1);
}
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SECRET_KEY を .env.local に設定してください。");
const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const source = JSON.parse(fs.readFileSync(FILE, "utf8"));
const db = args.includes("--no-demo") ? source : withDemoAccounts(source);
const toRow = (def, e) => Object.fromEntries(def.columns.map(([f]) => [snake(f), e[f] === undefined ? null : e[f]]));
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

for (const def of [...TABLES].reverse()) {
  const { error, count } = await sb.from(def.table).delete({ count: "exact" }).neq("id", "");
  if (error) throw new Error(`${def.table} の削除に失敗: ${error.message}`);
  log(`削除 ${def.table}: ${count ?? 0} 行`);
}

for (const def of TABLES) {
  const rows = db[def.collection] ?? [];
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500).map((r) => toRow(def, r));
    let attempt = 0;
    for (;;) {
      const { error } = await sb.from(def.table).insert(chunk);
      if (!error) break;
      if (++attempt >= 3) throw new Error(`${def.table} の登録に失敗 (${i}〜): ${error.message}${error.details ? ` / ${error.details}` : ""}`);
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  log(`登録 ${def.table}: ${rows.length} 行`);
}

const meta = { id: 1, version: db.meta.version, seeded_at: db.meta.seededAt, source: db.meta.source ?? null, imported_at: db.meta.importedAt ?? null };
const m = await sb.from(META_TABLE).upsert(meta, { onConflict: "id" });
if (m.error) throw new Error(`${META_TABLE}: ${m.error.message}`);
const r = await sb.rpc("bump_revision");
if (r.error) throw new Error(`bump_revision: ${r.error.message}`);

// 件数の確認
let ok = true;
for (const def of TABLES) {
  const { count, error } = await sb.from(def.table).select("id", { count: "exact", head: true });
  const expected = (db[def.collection] ?? []).length;
  if (error || count !== expected) {
    ok = false;
    console.log(`  ✗ ${def.table}: ${count ?? "?"} / ${expected}${error ? ` (${error.message})` : ""}`);
  }
}
log(ok ? "完了: すべてのテーブルの件数が取込データと一致しました" : "完了 (件数が一致しないテーブルがあります)");
process.exit(ok ? 0 : 1);
