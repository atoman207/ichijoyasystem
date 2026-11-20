/**
 * 作業日報・販促と媒体の分析のテストの共通部品 (jiti で TypeScript のモジュールをそのまま読む)
 * データは一時フォルダーの JSON (サンプルデータ) だけを使う (本番・リポジトリの data/ に書かない)。
 * Server Action はログインの Cookie・Next の実行環境が要るため、next/navigation・next/cache・ログインを代役に差し替えて本物を呼ぶ
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";
const here = path.dirname(new URL(import.meta.url).pathname);
export const root = path.resolve(here, "../../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ichijoya-ops-reports-test-"));
fs.mkdirSync(path.join(work, "data"), { recursive: true });
Object.assign(process.env, {
  DATA_BACKEND: "json",
  DATA_FILE_NAME: "ops-reports-test-db.json",
  FILE_STORAGE_DIR: path.join(work, "uploads"),
  DB_SNAPSHOT: "off",
  ICHIJOYA_DATA_DB: "off",
  ICHIJOYA_DATA_DB_PATH: path.join(work, "mirror.sqlite"),
  CHATBOT_DB_PATH: path.join(work, "chatbot.sqlite"),
  ROUTING_DB_PATH: path.join(work, "routing.sqlite"),
  SESSION_SECRET: "test-secret-for-ops-reports",
  TZ: "Asia/Tokyo",
});
// 送信の設定は使わない (外部へ送らない)
for (const k of Object.keys(process.env)) if (/^(SMTP_|RESEND_|SENDGRID_|LINE_|CHATWORK_|OPENAI_|ANTHROPIC_|GOOGLE_MAPS_|NEXT_PUBLIC_SUPABASE_|SUPABASE_)/.test(k)) delete process.env[k];
process.chdir(work);
const stub = (f) => path.join(here, "stubs", f);
export const jiti = createJiti(import.meta.url, {
  alias: {
    "next/navigation": stub("next-navigation.cjs"),
    "next/cache": stub("next-cache.cjs"),
    "@/lib/auth/session": stub("session.cjs"),
    "@": path.join(root, "src"),
    "server-only": path.join(root, "scripts/tests/maps/empty.cjs"),
  },
  moduleCache: true,
});
export const imp = (p) => jiti.import(path.join(root, "src", p));

/** 社員 user として Server Action を呼ぶ。redirect の URL と msg / err を返す */
export async function act(user, fn) {
  globalThis.__testUser = user;
  try {
    await fn();
    return { url: null, msg: null, err: null };
  } catch (e) {
    if (e && typeof e.digest === "string" && e.digest.startsWith("NEXT_REDIRECT")) {
      const u = new URL(e.url, "http://test.local");
      return { url: e.url, path: u.pathname, msg: u.searchParams.get("msg"), err: u.searchParams.get("err") };
    }
    throw e;
  } finally {
    globalThis.__testUser = undefined;
  }
}

/** フォームの値 (FormData) */
export function form(obj) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) for (const x of v) fd.append(k, String(x));
    else if (v !== undefined && v !== null) fd.set(k, String(v));
  }
  return fd;
}

let pass = 0, failn = 0; const fails = [];
export function ok(cond, msg) { if (cond) { pass++; console.log("  ✓", msg); } else { failn++; fails.push(msg); console.log("  ✗", msg); } }
export function eq(a, b, msg) { const c = JSON.stringify(a) === JSON.stringify(b); ok(c, c ? msg : `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
export function section(t) { console.log("\n■ " + t); }
export function summary() { console.log(`\n${pass} passed, ${failn} failed`); if (failn) { console.log("FAILED:\n - " + fails.join("\n - ")); process.exitCode = 1; } fs.rmSync(work, { recursive: true, force: true }); }
