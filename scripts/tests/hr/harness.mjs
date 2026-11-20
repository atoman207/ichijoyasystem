/**
 * 有給・休日出勤のテストの共通部品 (jiti で TypeScript のモジュールをそのまま読む)
 * データは一時フォルダーの JSON (サンプルデータ) だけを使う (本番・リポジトリの data/ に書かない)。
 * ファイル・チャットボット・VPS のデータベースの写しも一時フォルダー (または無効) にする
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";
const here = path.dirname(new URL(import.meta.url).pathname);
export const root = path.resolve(here, "../../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ichijoya-hr-test-"));
fs.mkdirSync(path.join(work, "data"), { recursive: true });
process.env.DATA_BACKEND = "json";
process.env.DATA_FILE_NAME = "hr-test-db.json";
process.env.FILE_STORAGE_DIR = path.join(work, "uploads");
process.env.DB_SNAPSHOT = "off";
process.env.ICHIJOYA_DATA_DB = "off";
process.env.ICHIJOYA_DATA_DB_PATH = path.join(work, "ichijoya-data.sqlite");
process.env.CHATBOT_DB_PATH = path.join(work, "chatbot.sqlite");
process.env.ROUTING_DB_PATH = path.join(work, "routing.sqlite");
process.env.TZ = "Asia/Tokyo";
// 外部への送信はしない (設定がなければ skipped。念のため消す)
for (const k of ["SMTP_HOST", "RESEND_API_KEY", "SENDGRID_API_KEY", "CHATWORK_API_TOKEN", "CHATWORK_ROOM_ID", "LINE_CHANNEL_ACCESS_TOKEN"]) delete process.env[k];
process.chdir(work);
export const jiti = createJiti(import.meta.url, { alias: { "@": path.join(root, "src"), "server-only": path.join(root, "scripts/tests/maps/empty.cjs") }, moduleCache: true });
export const imp = (p) => jiti.import(path.join(root, "src", p));
let pass = 0, failn = 0; const fails = [];
export function ok(cond, msg) { if (cond) { pass++; console.log("  ✓", msg); } else { failn++; fails.push(msg); console.log("  ✗", msg); } }
export function eq(a, b, msg) { const c = JSON.stringify(a) === JSON.stringify(b); ok(c, c ? msg : `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
/** 例外 (LeaveError) を投げるか。message に want を含むか */
export function throws(f, want, msg) {
  try { f(); ok(false, `${msg} (例外が出なかった)`); } catch (e) { ok(!want || String(e?.message).includes(want), want && !String(e?.message).includes(want) ? `${msg} (got: ${e?.message})` : msg); }
}
export function section(t) { console.log("\n■ " + t); }
export function summary() { console.log(`\n${pass} passed, ${failn} failed`); if (failn) { console.log("FAILED:\n - " + fails.join("\n - ")); process.exitCode = 1; } fs.rmSync(work, { recursive: true, force: true }); }
