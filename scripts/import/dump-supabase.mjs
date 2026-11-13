#!/usr/bin/env node
/**
 * 現在の Supabase のデータを JSON に書き出す (読み取りだけ。データベースは変更しない)
 *
 *   node scripts/import/dump-supabase.mjs                       → data/import/supabase-current.json
 *   node scripts/import/dump-supabase.mjs --out=<出力先>
 *
 * 出力は移行データ (client-data.json) と同じ形 (アプリのコレクション名・項目名)。そのまま SQL の生成に使える:
 *   node scripts/import/generate-data-sql.mjs data/import/supabase-current.json --no-demo
 *   (デモ用アカウントは現在のデータに含まれているので --no-demo。含めると demo1234 に戻して上書きする)
 *
 * - 接続は NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SECRET_KEY (.env.local)
 * - 行の変換はアプリ (src/lib/db/supabase.ts の fromRow) と同じ: 列名は camelCase、null の項目は書かない、
 *   timestamptz は ISO 形式、numeric / bigint は数値
 * - まだデータベースにないテーブル (アプリに後から追加したもの) は空として書き出す
 * - お客様の個人情報を含むため data/ (.gitignore 済み) に書き出す。コミット・共有しないこと
 */
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { META_TABLE, TABLES, isTimestamp, snake } from "../../src/lib/db/schema.ts";
import { loadEnv } from "./env.mjs";

loadEnv();
const args = process.argv.slice(2);
const OUT = path.resolve(args.find((a) => a.startsWith("--out="))?.split("=")[1] ?? "data/import/supabase-current.json");
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) {
  console.error("NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SECRET_KEY を .env.local に設定してください。");
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const PAGE = 1000;
const t0 = Date.now();

function fromRow(def, row) {
  const e = {};
  for (const [field, spec] of def.columns) {
    const v = row[snake(field)];
    if (v === null || v === undefined) continue;
    if (isTimestamp(spec) && typeof v === "string") e[field] = new Date(v).toISOString();
    else if (typeof v === "string" && /^numeric|^bigint/.test(spec)) e[field] = Number(v);
    else e[field] = v;
  }
  return e;
}

const meta = await sb.from(META_TABLE).select("*").eq("id", 1).maybeSingle();
if (meta.error) throw new Error(`${META_TABLE}: ${meta.error.message}`);
const out = {
  meta: {
    version: Number(meta.data?.version ?? 3),
    seededAt: meta.data?.seeded_at ? new Date(meta.data.seeded_at).toISOString() : undefined,
    source: meta.data?.source ?? undefined,
    importedAt: meta.data?.imported_at ? new Date(meta.data.imported_at).toISOString() : undefined,
    dumpedAt: new Date().toISOString(),
    revision: Number(meta.data?.revision ?? 0),
  },
};
const missing = [];
let total = 0;
for (const def of TABLES) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    let q = sb.from(def.table).select("*");
    for (const col of def.orderBy) q = q.order(col, { ascending: true, nullsFirst: true });
    // 同じ値の並びが毎回同じになるよう、最後に id でも並べる
    if (!def.orderBy.includes("id")) q = q.order("id", { ascending: true });
    const { data, error } = await q.range(from, from + PAGE - 1);
    if (error) {
      if (error.code === "PGRST205" || /Could not find the table/i.test(error.message)) {
        missing.push(def.table);
        break;
      }
      throw new Error(`${def.table}: ${error.message}`);
    }
    rows.push(...data.map((r) => fromRow(def, r)));
    if (data.length < PAGE) break;
  }
  out[def.collection] = rows;
  total += rows.length;
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out), "utf8");
console.log(`wrote ${path.relative(process.cwd(), OUT)}: ${total} rows, ${TABLES.length - missing.length} tables (revision ${out.meta.revision}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (missing.length) console.log(`データベースにまだないテーブル (空として書き出し): ${missing.join(", ")}`);
