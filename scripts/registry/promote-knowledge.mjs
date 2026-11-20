#!/usr/bin/env node
/**
 * データ台帳: 資料庫の「社内資料に登録」の節を、社内資料 (knowledge) にそろえる
 * ------------------------------------------------------------
 *   node scripts/registry/promote-knowledge.mjs                       → 確認だけ (Supabase の今の社内資料と比べて、追加・更新・削除の件数と題名)
 *   node scripts/registry/promote-knowledge.mjs --apply               → Supabase に書く (1 つのトランザクション・変更履歴・リビジョン +1)
 *   node scripts/registry/promote-knowledge.mjs --json [--apply]      → サンプルデータ (DATA_BACKEND=json の data/<DATA_FILE_NAME>) に書く (アプリと同じ mutate)
 *   --db <file>  資料庫の場所 (既定は materialsPath)
 *
 * 取込元は sourceRef = material:<資料の ID>#<節>。この印のない社内資料 (画面で登録したもの・スプレッドシートの同期) には触らない。
 * 戻すとき: 画面のデータ台帳で資料の扱いを変えるか、SQL で delete from knowledge where source_ref like 'material:%' (+ select bump_revision())
 */
import path from "node:path";
import { createRequire } from "node:module";
import { loadEnv } from "../import/env.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const require = createRequire(path.join(root, "package.json"));
const { createJiti } = require("jiti");
loadEnv(root);
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const JSON_MODE = args.includes("--json");
const opt = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
if (JSON_MODE) {
  process.env.DATA_BACKEND = "json";
  process.env.DB_SNAPSHOT = "off";
  process.env.ICHIJOYA_DATA_DB = "off";
}
const jiti = createJiti(import.meta.url, { alias: { "@": path.join(root, "src"), "server-only": path.join(root, "scripts/tests/maps/empty.cjs") } });
const imp = (p) => jiti.import(path.join(root, "src", p));
const M = await imp("lib/registry/materials-db.ts");
const P = await imp("lib/registry/promote.ts");

const dbFile = opt("--db") ? path.resolve(root, opt("--db")) : M.materialsPath();
const mdb = M.openMaterials(dbFile);
if (!mdb) {
  console.error(`資料庫を開けません: ${dbFile}`);
  process.exit(1);
}
console.log(`資料庫: ${dbFile}`);

let idn = 0;
const newId = () => `kn_${Date.now().toString(36)}${(++idn).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const now = new Date().toISOString();

function describe(before, after, r) {
  const beforeMap = new Map(before.map((k) => [k.id, k]));
  const afterMap = new Map(after.map((k) => [k.id, k]));
  const added = after.filter((k) => !beforeMap.has(k.id));
  const removed = before.filter((k) => !afterMap.has(k.id));
  const updated = after.filter((k) => beforeMap.has(k.id) && JSON.stringify(beforeMap.get(k.id)) !== JSON.stringify(k));
  const chars = after.reduce((a, k) => a + k.body.length, 0);
  const byVis = {};
  for (const k of after) byVis[k.visibility ?? "all"] = (byVis[k.visibility ?? "all"] ?? 0) + 1;
  console.log(`\n対象の資料 ${r.docs} 件 → 社内資料 ${after.length} 件 (本文 ${chars.toLocaleString()} 文字)`);
  console.log(`  追加 ${added.length}・更新 ${updated.length}・削除 ${removed.length}`);
  console.log(`  見られる人: ${Object.entries(byVis).map(([v, n]) => `${v} ${n}`).join("・")}`);
  for (const k of added.slice(0, 15)) console.log(`  + [${k.visibility}] ${k.category} / ${k.title}`);
  if (added.length > 15) console.log(`  … ほか ${added.length - 15} 件`);
  for (const k of removed.slice(0, 10)) console.log(`  - ${k.title}`);
  return { added, updated, removed };
}

if (JSON_MODE) {
  const store = await imp("lib/db/store.ts");
  const db = store.getDb();
  const before = db.knowledge.filter((k) => k.sourceRef?.startsWith(P.MATERIAL_REF_PREFIX)).map((k) => ({ ...k }));
  const copy = { knowledge: db.knowledge.map((k) => ({ ...k })) };
  const r = P.promoteFromMaterials(copy, mdb, { userId: "system", now, newId });
  describe(before, copy.knowledge.filter((k) => k.sourceRef?.startsWith(P.MATERIAL_REF_PREFIX)), r);
  if (!APPLY) {
    console.log("\n--apply を付けると書き込みます。");
    process.exit(0);
  }
  const res = await store.mutate((d) => {
    const x = P.promoteFromMaterials(d, mdb, { userId: "system", now, newId });
    store.addAudit(d, { userId: "system", action: "import", entity: "knowledge", entityId: "registry", entityLabel: "データ台帳", summary: `クライアント資料から社内資料を登録 (追加 ${x.added}・更新 ${x.updated}・削除 ${x.removed})` });
    return x;
  });
  for (const [id, ids] of res.perDoc) M.setKnowledgeIds(mdb, id, ids);
  M.addRun(mdb, { kind: "promote", by: "script", summary: { target: "json", added: res.added, updated: res.updated, removed: res.removed } });
  console.log(`\n書き込みました (サンプルデータ): 追加 ${res.added}・更新 ${res.updated}・削除 ${res.removed}`);
  process.exit(0);
}

/* ---------------- Supabase ---------------- */
const { connectDatabase } = await import("../import/db-connect.mjs");
const { client } = await connectDatabase();
const q = (sql, params) => client.query(sql, params);
const toEntry = (r) => ({
  id: r.id,
  title: r.title,
  body: r.body,
  category: r.category,
  tags: r.tags ?? [],
  source: r.source,
  sourceRef: r.source_ref ?? undefined,
  active: r.active,
  createdBy: r.created_by,
  createdAt: new Date(r.created_at).toISOString(),
  updatedBy: r.updated_by ?? undefined,
  updatedAt: new Date(r.updated_at).toISOString(),
  visibility: r.visibility ?? undefined,
  recordDate: r.record_date ? (r.record_date instanceof Date ? `${r.record_date.getFullYear()}-${String(r.record_date.getMonth() + 1).padStart(2, "0")}-${String(r.record_date.getDate()).padStart(2, "0")}` : String(r.record_date).slice(0, 10)) : undefined,
});
const before = (await q("select * from knowledge where source_ref like 'material:%'")).rows.map(toEntry);
const work = { knowledge: before.map((k) => ({ ...k, tags: [...k.tags] })) };
const r = P.promoteFromMaterials(work, mdb, { userId: "system", now, newId });
const diff = describe(before, work.knowledge, r);
if (!APPLY) {
  console.log("\n確認だけです。--apply を付けると Supabase に書き込みます。");
  await client.end();
  process.exit(0);
}
const cols = ["id", "title", "body", "category", "tags", "source", "source_ref", "active", "created_by", "created_at", "updated_by", "updated_at", "visibility", "record_date"];
const vals = (k) => [k.id, k.title, k.body, k.category, k.tags, k.source, k.sourceRef ?? null, k.active, k.createdBy, k.createdAt, k.updatedBy ?? null, k.updatedAt, k.visibility ?? null, k.recordDate ?? null];
try {
  await q("begin");
  for (const k of diff.removed) await q("delete from knowledge where id = $1", [k.id]);
  for (const k of diff.added) await q(`insert into knowledge (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")})`, vals(k));
  for (const k of diff.updated) await q(`update knowledge set ${cols.slice(1).map((c, i) => `${c} = $${i + 2}`).join(", ")} where id = $1`, vals(k));
  const logId = `log_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  await q("insert into audit_logs (id, at, user_id, action, entity, entity_id, entity_label, summary) values ($1,$2,'system','import','knowledge','registry','データ台帳',$3)", [
    logId,
    now,
    `クライアント資料から社内資料を登録 (追加 ${diff.added.length}・更新 ${diff.updated.length}・削除 ${diff.removed.length})`,
  ]);
  await q("select bump_revision()");
  await q("commit");
} catch (err) {
  await q("rollback").catch(() => {});
  console.error("失敗したため元に戻しました:", err.message);
  await client.end();
  process.exit(1);
}
for (const [id, ids] of r.perDoc) M.setKnowledgeIds(mdb, id, ids);
M.addRun(mdb, { kind: "promote", by: "script", summary: { target: "supabase", added: diff.added.length, updated: diff.updated.length, removed: diff.removed.length } });
console.log(`\n書き込みました (Supabase): 追加 ${diff.added.length}・更新 ${diff.updated.length}・削除 ${diff.removed.length}。起動中のアプリは全件を読み直します。`);
await client.end();
