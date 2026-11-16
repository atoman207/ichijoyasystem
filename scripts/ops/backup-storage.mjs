#!/usr/bin/env node
/**
 * 添付ファイル (Supabase Storage のバケット "attachments") を手元のディレクトリへ追加でコピーする (読み取りだけ)
 *
 *   node scripts/ops/backup-storage.mjs --dest=/var/backups/ichijoya/storage
 *   node scripts/ops/backup-storage.mjs --dry-run           (一覧と件数だけ。ダウンロードしない)
 *
 * - 既にある同じ大きさのファイルは取り直さない (毎日の実行は増えた分だけ)
 * - 接続は NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SECRET_KEY (環境変数、または .env.local)
 * - 最後の行に結果の要約を出す (deploy/backup.sh が記録する)
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { loadEnv } from "../import/env.mjs";

const require = createRequire(import.meta.url);
const { createClient } = require("@supabase/supabase-js");

loadEnv();
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")).map(([k, v]) => [k, v ?? true]));
const BUCKET = String(args.bucket ?? "attachments");
const DEST = path.resolve(String(args.dest ?? "data/backup-storage"));
const DRY = Boolean(args["dry-run"]);
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) {
  console.error("NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SECRET_KEY を設定してください。");
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

/** フォルダーをたどって、すべてのファイル (キー・大きさ) を集める */
async function listAll(prefix = "") {
  const files = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await sb.storage.from(BUCKET).list(prefix, { limit: 1000, offset, sortBy: { column: "name", order: "asc" } });
    if (error) throw new Error(`一覧を取得できません (${prefix || "/"}): ${error.message}`);
    for (const it of data ?? []) {
      const keyPath = prefix ? `${prefix}/${it.name}` : it.name;
      if (it.id === null || !it.metadata) files.push(...(await listAll(keyPath)));
      else files.push({ key: keyPath, size: Number(it.metadata.size ?? 0) });
    }
    if (!data || data.length < 1000) break;
  }
  return files;
}

const t0 = Date.now();
const { data: bucket, error: bErr } = await sb.storage.getBucket(BUCKET);
if (bErr || !bucket) {
  console.log(`添付ファイル: バケット ${BUCKET} はまだありません (0 件)`);
  process.exit(0);
}
const files = await listAll();
const total = files.reduce((a, f) => a + f.size, 0);
let copied = 0;
let skipped = 0;
let failed = 0;
for (const f of files) {
  const out = path.join(DEST, f.key);
  if (!out.startsWith(DEST + path.sep)) {
    failed++;
    continue;
  }
  if (fs.existsSync(out) && fs.statSync(out).size === f.size) {
    skipped++;
    continue;
  }
  if (DRY) {
    copied++;
    continue;
  }
  const { data, error } = await sb.storage.from(BUCKET).download(f.key);
  if (error || !data) {
    failed++;
    console.error(`取得できません: ${f.key} ${error?.message ?? ""}`);
    continue;
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(await data.arrayBuffer()), { mode: 0o600 });
  copied++;
}
const mb = (n) => (n / 1024 / 1024).toFixed(1);
console.log(`添付ファイル: ${files.length} 件 (${mb(total)} MB)・${DRY ? "コピー対象" : "新しくコピー"} ${copied} 件・既存 ${skipped} 件${failed ? `・失敗 ${failed} 件` : ""} (${((Date.now() - t0) / 1000).toFixed(1)} 秒)`);
process.exit(failed ? 1 : 0);
