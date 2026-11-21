#!/usr/bin/env node
/**
 * クライアント資料 (source/) を Supabase に登録する (Supabase にだけ置く表 source_items・source_texts。アプリはメモリに読み込まない)
 * ------------------------------------------------------------
 *   node scripts/registry/sync-supabase.mjs              → 確認だけ (Supabase の今の行と比べて、追加・更新・削除の件数)
 *   node scripts/registry/sync-supabase.mjs --apply      → 書く (1 つのトランザクション。表がなければこの 2 つの表だけ作る)
 *   node scripts/registry/sync-supabase.mjs --offline    → Supabase に接続せず、登録する行の件数だけ (テスト・確認用)
 *   --db <file>   資料庫 (既定は materials-db.ts の materialsPath)
 *   --dir <dir>   資料のフォルダー (既定 source/)
 *
 * - 行は src/lib/registry/supabase-sync.ts が作る: 全ファイル・全フォルダー (画像・動画・フォルダー・システムのファイルは場所だけ) と文書の中身 (資料庫の節)
 * - 先に npm run registry:scan で資料庫を新しくしておく (読み取りが古いと止める)
 * - 変わった行だけ書く (行の指紋 row_hash・中身の指紋 content_hash)。source/ からなくなったものは消す
 * - 変更履歴 (audit_logs) に 1 行残し、その行だけを変更の記録に書く (起動中のアプリは全件を読み直さない)
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { loadEnv } from "../import/env.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const require = createRequire(path.join(root, "package.json"));
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { alias: { "@": path.join(root, "src"), "server-only": path.join(root, "scripts/tests/maps/empty.cjs") } });
const imp = (p) => jiti.import(path.join(root, "src", p));

loadEnv(root);
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const APPLY = flag("--apply");
const OFFLINE = flag("--offline");

const M = await imp("lib/registry/materials-db.ts");
const SRC = await imp("lib/registry/source.ts");
const SS = await imp("lib/registry/supabase-sync.ts");
const SCHEMA = await imp("lib/db/schema.ts");

const DIR = opt("--dir") ? path.resolve(root, opt("--dir")) : SRC.sourceDir(root);
const dbFile = opt("--db") ? path.resolve(root, opt("--db")) : M.materialsPath();
if (!fs.existsSync(DIR)) {
  console.error(`資料のフォルダーがありません: ${DIR}`);
  process.exit(1);
}
const mdb = dbFile ? M.openMaterials(dbFile) : null;
if (!mdb) {
  console.error(`資料庫を開けません: ${dbFile ?? "(止めています)"}。先に npm run registry:scan`);
  process.exit(1);
}

const fmt = (n) => Number(n).toLocaleString("en-US");
function summarize(items, texts) {
  const by = (k) => items.reduce((a, i) => ((a[i[k]] = (a[i[k]] ?? 0) + 1), a), {});
  const files = items.filter((i) => i.entry === "file");
  const content = files.reduce((a, i) => ((a[i.content] = (a[i.content] ?? 0) + 1), a), {});
  console.log(`資料のフォルダー: ${path.relative(root, DIR) || DIR}\n資料庫: ${dbFile}`);
  console.log(`登録する行: ${fmt(items.length)} (ファイル ${fmt(files.length)}・フォルダー ${fmt(by("entry").folder ?? 0)}・システムのファイル ${fmt(by("entry").system ?? 0)})`);
  console.log(`  ファイルの中身: 文字 ${fmt(content.text ?? 0)}・取込済みの要約 ${fmt(content.summary ?? 0)}・場所だけ ${fmt(content.path_only ?? 0)} (画像・動画など)・取り込まない ${fmt(content.excluded ?? 0)} (個人の情報)`);
  console.log(`  文書の節: ${fmt(texts.length)} (${fmt(texts.reduce((a, t) => a + t.chars, 0))} 文字)`);
}

const SYSTEM = "system";
let client;
const done = async (code) => {
  await client?.end().catch(() => {});
  M.closeMaterials();
  process.exit(code);
};

if (OFFLINE) {
  const r = SS.buildSourceRows(mdb, DIR, {});
  summarize(r.items, r.texts);
  if (r.problems.length) {
    console.log(`資料庫の読み取りが古い: ${r.problems.length} 件\n${r.problems.slice(0, 20).map((p) => `  ${p}`).join("\n")}`);
    await done(2);
  }
  await done(0);
}

const { connectDatabase } = await import("../import/db-connect.mjs");
const { buildTablesSql } = await import("../import/schema-sql.mjs");
client = (await connectDatabase(() => {})).client;
const q = (sql, params) => client.query(sql, params);
await q("set statement_timeout = '600s'");

const exists = Boolean((await q("select to_regclass('public.source_items') is not null and to_regclass('public.source_texts') is not null as ok")).rows[0]?.ok);
const sourceFileIds = new Set((await q("select id from source_files")).rows.map((r) => r.id));
const r = SS.buildSourceRows(mdb, DIR, { sourceFileIds });
summarize(r.items, r.texts);
if (r.problems.length) {
  console.error(`\n資料庫の読み取りが古いため止めます (${r.problems.length} 件)。先に npm run registry:scan を実行してください。\n${r.problems.slice(0, 20).map((p) => `  ${p}`).join("\n")}`);
  await done(1);
}
console.log(`資料台帳 (source_files) とつながる行: ${fmt(r.items.filter((i) => i.sourceFileId).length)}`);

const current = exists ? (await q("select id, row_hash, content_hash from source_items")).rows.map((x) => ({ id: x.id, rowHash: x.row_hash, contentHash: x.content_hash })) : [];
const d = SS.diffSourceRows(current, r.items);
const textsFor = new Set(d.textsFor);
const textRows = r.texts.filter((t) => textsFor.has(t.itemId));
console.log(`\nSupabase と比べた結果${exists ? "" : " (表がまだありません。--apply で source_items・source_texts を作ります)"}:`);
console.log(`  行: 追加 ${fmt(d.insert.length)}・更新 ${fmt(d.update.length)}・削除 ${fmt(d.remove.length)} / 中身を書き直す資料 ${fmt(d.textsFor.length)} (節 ${fmt(textRows.length)})`);
if (!APPLY) {
  console.log("\n確認だけです。--apply を付けると Supabase に書き込みます。");
  await done(0);
}

/* ------------------------------------------------------------------ */
/* 書く                                                                  */
/* ------------------------------------------------------------------ */
const now = new Date().toISOString();
const t0 = Date.now();
try {
  if (!exists) {
    // この 2 つの表だけを作る (ほかの表の定義の反映は npm run db:migrate)
    await q("set lock_timeout = '10s'");
    await q(buildTablesSql(SCHEMA.SUPABASE_ONLY_TABLES));
    console.log("表を作りました: source_items・source_texts (RLS 有効・secret キーだけが読み書き)");
  }
  const cols = SCHEMA.SUPABASE_ONLY_TABLES.find((t) => t.table === "source_items").columns.map(([f]) => SCHEMA.snake(f));
  const upd = cols.filter((c) => c !== "id" && c !== "registered_at").map((c) => `${c} = excluded.${c}`).join(", ");
  const batches = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));
  await q("begin");
  // 消えた行 → 中身の書き直し → 行の追加・更新 → 中身 (行の後。参照のため)
  if (d.remove.length) await q("delete from source_items where id = any($1::text[])", [d.remove]);
  if (d.textsFor.length) for (const ids of batches(d.textsFor, 1000)) await q("delete from source_texts where item_id = any($1::text[])", [ids]);
  for (const list of batches([...d.insert, ...d.update], 500)) {
    const rows = list.map((it) => SS.snakeRow(it, { registeredAt: now, updatedAt: now }));
    await q(`insert into source_items select * from jsonb_populate_recordset(null::source_items, $1::jsonb) on conflict (id) do update set ${upd}`, [JSON.stringify(rows)]);
  }
  let written = 0;
  for (const list of batches(textRows, 300)) {
    await q("insert into source_texts select * from jsonb_populate_recordset(null::source_texts, $1::jsonb)", [JSON.stringify(list.map((t) => SS.snakeRow(t)))]);
    written += list.length;
  }
  const counts = (await q("select (select count(*) from source_items)::int items, (select count(*) from source_texts)::int texts, (select coalesce(sum(chars), 0) from source_texts)::bigint chars")).rows[0];
  const summary = `クライアント資料 (source/) を Supabase に登録 (行 追加 ${d.insert.length}・更新 ${d.update.length}・削除 ${d.remove.length}・中身を書き直した資料 ${d.textsFor.length}。登録済み ${counts.items} 行・節 ${counts.texts})`;
  const logId = `log_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  await q("insert into audit_logs (id, at, user_id, action, entity, entity_id, entity_label, summary) values ($1, $2, $3, 'import', 'registry', 'supabase', 'クライアント資料 (source/)', $4)", [logId, now, SYSTEM, summary]);
  // 変更履歴の 1 行だけを変更の記録に書く (アプリが読み込む表で変わったのはこの行だけ)
  await q("select record_changes($1::jsonb)", [JSON.stringify({ audit_logs: { u: [logId] } })]);
  await q("commit");
  M.addRun(mdb, { kind: "supabase", by: "script", summary: { items: counts.items, texts: counts.texts, chars: Number(counts.chars), files: r.items.filter((i) => i.entry === "file").length, folders: r.items.filter((i) => i.entry === "folder").length, added: d.insert.length, updated: d.update.length, removed: d.remove.length, textsRewritten: d.textsFor.length, ms: Date.now() - t0 } });
  console.log(`\n書き込みました (Supabase): ${summary}・${Math.round((Date.now() - t0) / 1000)} 秒`);
  await done(0);
} catch (err) {
  await q("rollback").catch(() => {});
  console.error(`失敗したため元に戻しました: ${err.message}`);
  await done(1);
}
