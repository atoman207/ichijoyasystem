/**
 * 地図・住宅地図のテストの共通部品 (jiti で TypeScript のモジュールをそのまま読む)
 * データは一時フォルダーの JSON (サンプルデータ) と一時フォルダーの添付ファイルだけを使う (本番・リポジトリの data/ に書かない)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";
const here = path.dirname(new URL(import.meta.url).pathname);
export const root = path.resolve(here, "../../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ichijoya-maps-test-"));
fs.mkdirSync(path.join(work, "data"), { recursive: true });
process.env.DATA_BACKEND = "json";
process.env.DATA_FILE_NAME = "maps-test-db.json";
process.env.FILE_STORAGE_DIR = path.join(work, "uploads");
process.env.MAP_IMPORT_DIR = path.join(work, "map-import");
process.env.DB_SNAPSHOT = "off";
delete process.env.GOOGLE_MAPS_API_KEY;
delete process.env.ZENRIN_API_ENDPOINT; delete process.env.ZENRIN_API_KEY; delete process.env.ZENRIN_LICENSE_CONFIRMED;
process.chdir(work);
export const jiti = createJiti(import.meta.url, { alias: { "@": path.join(root, "src"), "server-only": path.join(here, "empty.cjs") }, moduleCache: true });
export const imp = (p) => jiti.import(path.join(root, "src", p));
let pass = 0, failn = 0; const fails = [];
export function ok(cond, msg) { if (cond) { pass++; console.log("  ✓", msg); } else { failn++; fails.push(msg); console.log("  ✗", msg); } }
export function eq(a, b, msg) { const c = JSON.stringify(a) === JSON.stringify(b); ok(c, c ? msg : `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
export function section(t) { console.log("\n■ " + t); }
export function summary() { console.log(`\n${pass} passed, ${failn} failed`); if (failn) { console.log("FAILED:\n - " + fails.join("\n - ")); process.exitCode = 1; } fs.rmSync(work, { recursive: true, force: true }); }
