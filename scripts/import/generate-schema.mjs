#!/usr/bin/env node
/**
 * src/lib/db/schema.ts (テーブル定義) → supabase/migrations/20261112000000_initial_schema.sql (PostgreSQL / Supabase)
 *   node scripts/import/generate-schema.mjs [出力=supabase/migrations/20261112000000_initial_schema.sql]
 *
 * - テーブル定義だけの SQL (データなし・コミットしてよい)。データまで含めた 1 ファイルは supabase/ichijoya.sql
 *   (node scripts/import/generate-data-sql.mjs。お客様の個人情報を含むためコミットしない)
 * - Supabase の SQL Editor に貼り付けて実行できる (手順は supabase/README.md)
 * - phase1/database/ があれば (ローカルの納品物)、同じ内容を schema.sql にも書く
 * - 中身は scripts/import/schema-sql.mjs (何度実行しても安全・RLS 有効・ポリシーなし)
 */
import fs from "node:fs";
import path from "node:path";
import { TABLE_COUNT, buildSchemaSql } from "./schema-sql.mjs";

const OUT = path.resolve(process.argv[2] ?? "supabase/migrations/20261112000000_initial_schema.sql");
const PHASE1_COPY = path.resolve("phase1/database/schema.sql");

const sql = buildSchemaSql();
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, sql, "utf8");
console.log(`wrote ${path.relative(process.cwd(), OUT)} (${TABLE_COUNT} tables)`);
if (!process.argv[2] && fs.existsSync(path.dirname(PHASE1_COPY))) {
  fs.writeFileSync(PHASE1_COPY, sql, "utf8");
  console.log(`wrote ${path.relative(process.cwd(), PHASE1_COPY)}`);
}
