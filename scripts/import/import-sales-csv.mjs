#!/usr/bin/env node
/**
 * 販売管理ソフトの「売上明細」CSV を取り込む (顧客・受注を登録・更新し、売上台帳から移行した受注・顧客とひも付ける)
 *
 *   node scripts/import/import-sales-csv.mjs <CSV>                 → Supabase の現在のデータで試算 (書き込まない)
 *   node scripts/import/import-sales-csv.mjs <CSV> --yes           → Supabase に書き込む (変更・追加された行だけ)
 *   node scripts/import/import-sales-csv.mjs <CSV> --json=<ファイル> → JSON のデータで試算 (ローカル確認用。書き込まない)
 *   node scripts/import/import-sales-csv.mjs <CSV> --base=data/backup/<ファイル> --yes
 *     → 書き込みが途中で止まったとき: --yes の実行時に保存した「書き込む前のデータ」から同じ変更を計算して書き直す
 *
 * - 取込の中身は src/lib/sales-ledger.ts (画面の「データ入出力 → 売上明細の取込」と同じ処理)。何度実行しても同じ状態になる
 * - 接続は NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SECRET_KEY (.env.local)。書き込み後にリビジョンを +1 するので、
 *   起動中のアプリ (Vercel を含む) は再起動なしで反映する
 * - CSV は Shift_JIS (販売管理ソフトの出力) と UTF-8 のどちらでもよい
 */
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { META_TABLE, TABLES, isTimestamp, loadOrder, snake } from "../../src/lib/db/schema.ts";
import { applySalesSlips, parseSalesCsv } from "../../src/lib/sales-ledger.ts";
import { loadEnv } from "./env.mjs";

loadEnv();
const args = process.argv.slice(2);
const FILE = args.find((a) => !a.startsWith("--"));
const YES = args.includes("--yes");
// --base=<バックアップ>: 書き込みが途中で止まったとき、書き込む前のデータから同じ変更を計算し直して書き込む
const BASE_FILE = args.find((a) => a.startsWith("--base="))?.slice(7);
const JSON_FILE = args.find((a) => a.startsWith("--json="))?.slice(7) ?? BASE_FILE;
if (!FILE || !fs.existsSync(FILE)) {
  console.error("使い方: node scripts/import/import-sales-csv.mjs <売上明細の CSV> [--yes | --json=<ファイル>]");
  process.exit(1);
}

const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

function decode(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return new TextDecoder("utf-8").decode(buf);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder("shift_jis").decode(buf);
  }
}

const parsed = parseSalesCsv(decode(fs.readFileSync(FILE)));
log(`CSV: ${parsed.rows} 行 → 伝票 ${parsed.slips.length} 枚 (列のずれを補正 ${parsed.repaired} 行、読めない行 ${parsed.skipped.length})`);
for (const s of parsed.skipped.slice(0, 10)) console.log(`  読めない行 ${s.line}: ${s.reason}`);

/* ---------------- データの読み込み ---------------- */

const toRow = (def, e) => Object.fromEntries(def.columns.map(([f]) => [snake(f), e[f] === undefined ? null : e[f]]));
const fromRow = (def, row) => {
  const e = {};
  for (const [field, spec] of def.columns) {
    const v = row[snake(field)];
    if (v === null || v === undefined) continue;
    if (isTimestamp(spec) && typeof v === "string") e[field] = new Date(v).toISOString();
    else if (typeof v === "string" && /^numeric|^bigint/.test(spec)) e[field] = Number(v);
    else e[field] = v;
  }
  return e;
};

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
let sb = null;
if (!JSON_FILE || BASE_FILE) {
  if (!url || !key) {
    console.error("NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SECRET_KEY を .env.local に設定してください (ローカルで試すときは --json=<ファイル>)。");
    process.exit(1);
  }
  sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
let db;
if (JSON_FILE) {
  db = JSON.parse(fs.readFileSync(JSON_FILE, "utf8"));
  for (const def of TABLES) db[def.collection] ??= [];
  log(`データ: ${path.relative(process.cwd(), JSON_FILE)}`);
} else {
  db = {};
  await Promise.all(
    TABLES.map(async (def) => {
      const out = [];
      for (let from = 0; ; from += 1000) {
        let q = sb.from(def.table).select("*");
        for (const col of loadOrder(def)) q = q.order(col, { ascending: true, nullsFirst: true });
        const { data, error } = await q.range(from, from + 999);
        if (error) {
          if (/Could not find the table|does not exist/i.test(error.message)) break;
          throw new Error(`${def.table}: ${error.message}`);
        }
        out.push(...data.map((r) => fromRow(def, r)));
        if (data.length < 1000) break;
      }
      db[def.collection] = out;
    }),
  );
  log(`データ: Supabase (顧客 ${db.customers.length} / 受注 ${db.orders.length})`);
}

/* ---------------- 取込 ---------------- */

const snapshot = new Map(TABLES.map((def) => [def.collection, new Map((db[def.collection] ?? []).map((r) => [r.id, JSON.stringify(r)]))]));
if (YES && !BASE_FILE && !JSON_FILE) {
  const dir = path.join(process.cwd(), "data", "backup");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `before-sales-import-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify(db));
  log(`書き込む前のデータを保存しました: ${path.relative(process.cwd(), file)} (戻すときは node scripts/import/load-to-supabase.mjs <このファイル> --yes)`);
}
const admin = db.users.find((u) => u.role === "admin" && u.active && !String(u.email).includes("@"))?.id ?? db.users.find((u) => u.role === "admin")?.id;
const now = new Date().toISOString();
const report = applySalesSlips(db, parsed.slips, { now, userId: admin });

const changes = [];
for (const def of TABLES) {
  const prev = snapshot.get(def.collection);
  const rows = db[def.collection] ?? [];
  const upserts = rows.filter((r) => prev.get(r.id) !== JSON.stringify(r));
  const ids = new Set(rows.map((r) => r.id));
  const deletes = [...prev.keys()].filter((id) => !ids.has(id));
  if (upserts.length || deletes.length) changes.push({ def, upserts, deletes });
}

console.log(`
伝票 ${report.slips} 枚 (前回から変わらない ${report.unchanged})
顧客: 新規 ${report.customersCreated} / 更新 ${report.customersUpdated} / 売上台帳の顧客を統合 ${report.customersMerged}
受注: 新規 ${report.ordersCreated} / 更新 ${report.ordersUpdated} / 売上台帳の受注にひも付け ${report.ordersLinked} / 店舗を判定できず本社扱い ${report.storeByDefault}
金額が税抜の伝票 (税込に換算): ${report.taxExcluded}
担当者コード → 社員: ${report.staffMatched.join("、") || "-"}
社員にいない担当者コード (経過メモに氏名を残す): ${report.staffUnmatched.join("、") || "-"}
書き込む行: ${changes.map((c) => `${c.def.table} +${c.upserts.length}${c.deletes.length ? ` -${c.deletes.length}` : ""}`).join(" / ") || "なし"}`);

if (!sb || !YES) {
  if (sb) console.log("\n試算のみです。書き込むときは --yes を付けて実行してください。");
  process.exit(0);
}
if (!changes.length) {
  log("変更はありません。");
  process.exit(0);
}

/* ---------------- 書き込み ---------------- */

const summary = `売上明細 (${path.basename(FILE)}) を取込: 伝票 ${report.slips} 枚 / 顧客 新規 ${report.customersCreated}・更新 ${report.customersUpdated}・統合 ${report.customersMerged} / 受注 新規 ${report.ordersCreated}・更新 ${report.ordersUpdated}・ひも付け ${report.ordersLinked}`;
const audit = { id: `log_sales_${Date.now().toString(36)}`, at: now, userId: admin, action: "import", entity: "data", entityId: "sales-ledger", entityLabel: "売上明細", summary };
const auditDef = TABLES.find((t) => t.collection === "auditLogs");
const auditChange = changes.find((c) => c.def === auditDef);
if (auditChange) auditChange.upserts.push(audit);
else changes.push({ def: auditDef, upserts: [audit], deletes: [] });

/** 時間切れ (statement timeout) のときは半分に分けて書き直す */
async function upsert(def, rows) {
  const { error } = await sb.from(def.table).upsert(rows.map((r) => toRow(def, r)), { onConflict: "id" });
  if (!error) return;
  if (rows.length > 1 && /timeout|canceling statement/i.test(error.message)) {
    const half = Math.ceil(rows.length / 2);
    await upsert(def, rows.slice(0, half));
    await upsert(def, rows.slice(half));
    return;
  }
  throw new Error(`${def.table} upsert: ${error.message}${error.details ? ` (${error.details})` : ""}`);
}
for (const { def, upserts } of changes) {
  for (let i = 0; i < upserts.length; i += 200) await upsert(def, upserts.slice(i, i + 200));
  if (upserts.length) log(`${def.table}: ${upserts.length} 行を書き込みました`);
}
for (const { def, deletes } of [...changes].reverse()) {
  for (let i = 0; i < deletes.length; i += 200) {
    const { error } = await sb.from(def.table).delete().in("id", deletes.slice(i, i + 200));
    if (error) throw new Error(`${def.table} delete: ${error.message}`);
  }
  if (deletes.length) log(`${def.table}: ${deletes.length} 行を削除しました`);
}
const { data: rev, error } = await sb.rpc("bump_revision");
if (error) throw new Error(`${META_TABLE} bump_revision: ${error.message}`);
log(`完了 (リビジョン ${rev})。起動中のアプリは数秒以内に反映します。`);
