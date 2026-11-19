/**
 * AI アシスタント (チャットボット) のテストの共通部品 (jiti で TypeScript のモジュールをそのまま読む)
 * ------------------------------------------------------------
 * データはすべて一時フォルダー (サンプルデータの JSON・チャットボットの SQLite・VPS のデータベースの写し) に作る。
 * 本番のファイル (/srv/ichijoya/data/...) とリポジトリの data/ には書かない。AI のキーは消し、AI はモックのサーバーだけを使う
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const here = path.dirname(new URL(import.meta.url).pathname);
export const root = path.resolve(here, "../../..");
export const work = fs.mkdtempSync(path.join(os.tmpdir(), "ichijoya-chatbot-test-"));
fs.mkdirSync(path.join(work, "data"), { recursive: true });

// 本物の AI のキー・接続先を使わない (テストの中でモックのサーバーに向ける)
for (const k of Object.keys(process.env)) {
  if (/^(NEXT_PUBLIC_)?(OPEN_?AI|OPEN_?API|ANTHROPIC|CLAUDE|AI_API)[A-Z0-9_]*(KEY|BASE_URL)$/i.test(k) || k === "AI_PROVIDER" || k === "OPENAI_MODEL") delete process.env[k];
}
for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY", "AI_MONTHLY_BUDGET_JPY", "AI_MONTHLY_TOKEN_LIMIT"]) delete process.env[k];
Object.assign(process.env, {
  DATA_BACKEND: "json",
  DATA_FILE_NAME: "chatbot-test-db.json",
  FILE_STORAGE_DIR: path.join(work, "uploads"),
  DB_SNAPSHOT: "off",
  DB_CACHE_DIR: path.join(work, "cache"),
  CHATBOT_DB_PATH: path.join(work, "chatbot.sqlite"),
  ICHIJOYA_DATA_DB_PATH: path.join(work, "database", "ichijoya-data.sqlite"),
  BACKUP_DIR: path.join(work, "backups"),
  BACKUP_STATUS_FILE: path.join(work, "backup-status.json"),
  MAP_IMPORT_DIR: path.join(work, "maps"),
  AI_VOICE: "off",
  TZ: "Asia/Tokyo",
});
process.chdir(work);

export const jiti = createJiti(import.meta.url, { alias: { "@": path.join(root, "src"), "server-only": path.join(root, "scripts/tests/maps/empty.cjs") }, moduleCache: true });
export const imp = (p) => jiti.import(path.join(root, "src", p));

/** VPS のデータベースの写しを作って、使えるようになるまで待つ */
export async function startMirror() {
  const mirror = await imp("lib/datastore/mirror.ts");
  mirror.startMirror();
  const t0 = Date.now();
  while (!mirror.mirrorReady()) {
    if (Date.now() - t0 > 120_000) throw new Error("mirror not ready");
    await new Promise((r) => setTimeout(r, 200));
  }
  return mirror;
}

let pass = 0;
let failn = 0;
const fails = [];
export function ok(cond, msg) {
  if (cond) {
    pass++;
    console.log("  ✓", msg);
  } else {
    failn++;
    fails.push(msg);
    console.log("  ✗", msg);
  }
}
export function eq(a, b, msg) {
  const c = JSON.stringify(a) === JSON.stringify(b);
  ok(c, c ? msg : `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
}
export function section(t) {
  console.log("\n■ " + t);
}
export function summary() {
  console.log(`\n${pass} passed, ${failn} failed`);
  if (failn) {
    console.log("FAILED:\n - " + fails.join("\n - "));
    process.exitCode = 1;
  }
  fs.rmSync(work, { recursive: true, force: true });
}
