#!/usr/bin/env node
/**
 * 本番環境の動作確認 (読み取りだけ。データは変更しない)
 *
 *   node scripts/ops/verify-production.mjs https://system.example.co.jp
 *   node scripts/ops/verify-production.mjs http://localhost:3000 --allow-http      (手元・サーバー内での確認)
 *
 * 確認すること: 死活監視 (/api/health: データベース・表・タイムゾーン)、HTTPS と証明書の期限、HTTP → HTTPS の転送、
 * セキュリティのヘッダー、ログイン画面、ログインしていない人の締め出し、外部からの受信口 (署名・共有鍵なしは拒否)、
 * 帳票の共有リンク (署名なしは拒否)、定期実行の口 (鍵なしは拒否)、応答時間
 */
import tls from "node:tls";

const args = process.argv.slice(2);
const base = (args.find((a) => /^https?:\/\//.test(a)) ?? "").replace(/\/+$/, "");
const allowHttp = args.includes("--allow-http");
if (!base) {
  console.error("使い方: node scripts/ops/verify-production.mjs https://<ドメイン> [--allow-http]");
  process.exit(2);
}
const u = new URL(base);
const results = [];
const check = (name, ok, detail = "", warnOnly = false) => results.push({ name, ok: Boolean(ok), detail: String(detail), warnOnly });
const req = async (p, init = {}) => {
  const t0 = Date.now();
  const res = await fetch(`${base}${p}`, { redirect: "manual", signal: AbortSignal.timeout(60000), ...init });
  return { res, ms: Date.now() - t0, text: await res.text().catch(() => "") };
};

// 1. 死活監視
try {
  const { res, ms, text } = await req("/api/health");
  let h = {};
  try {
    h = JSON.parse(text);
  } catch {
    /* 下で失敗にする */
  }
  check("/api/health が 200", res.status === 200, `HTTP ${res.status} (${ms} ms)`);
  check("データベース: Supabase に接続", h.backend === "supabase" && h.db === "ok", `backend=${h.backend} db=${h.db}`);
  check("データベース: 表がそろっている", h.schema === "ok", JSON.stringify(h.schema));
  check("タイムゾーン: Asia/Tokyo", h.timeZone === "Asia/Tokyo", h.timeZone);
  const again = await req("/api/health");
  check("応答時間 (2 回目) 2 秒以内", again.ms < 2000, `${again.ms} ms`, true);
} catch (err) {
  check("/api/health に接続", false, err.message);
}

// 2. HTTPS・証明書・転送
if (u.protocol === "https:") {
  try {
    const cert = await new Promise((resolve, reject) => {
      const s = tls.connect({ host: u.hostname, port: Number(u.port || 443), servername: u.hostname, timeout: 15000 }, () => {
        const c = s.getPeerCertificate();
        resolve({ authorized: s.authorized, err: s.authorizationError, validTo: c.valid_to, issuer: c.issuer?.O ?? c.issuer?.CN });
        s.end();
      });
      s.on("error", reject);
      s.on("timeout", () => reject(new Error("timeout")));
    });
    const days = Math.floor((Date.parse(cert.validTo) - Date.now()) / 86400000);
    check("SSL 証明書が有効", cert.authorized, cert.authorized ? `${cert.issuer} · 期限 ${cert.validTo}` : String(cert.err));
    check("SSL 証明書の残り日数 14 日以上", days >= 14, `${days} 日 (Let's Encrypt は自動更新)`);
  } catch (err) {
    check("SSL 証明書を確認", false, err.message);
  }
  try {
    const res = await fetch(`http://${u.host}/login`, { redirect: "manual", signal: AbortSignal.timeout(20000) });
    const loc = res.headers.get("location") ?? "";
    check("HTTP は HTTPS へ転送", [301, 302, 307, 308].includes(res.status) && loc.startsWith("https://"), `HTTP ${res.status} → ${loc}`);
  } catch (err) {
    check("HTTP は HTTPS へ転送", false, err.message);
  }
} else {
  check("HTTPS で公開している", allowHttp, allowHttp ? "--allow-http (手元の確認)" : "http:// です", allowHttp);
}

// 3. ログイン画面・セキュリティのヘッダー
try {
  const { res, text } = await req("/login");
  check("ログイン画面が表示される", res.status === 200 && /<form/i.test(text), `HTTP ${res.status}`);
  const h = (k) => res.headers.get(k) ?? "";
  check("ヘッダー X-Content-Type-Options", h("x-content-type-options") === "nosniff", h("x-content-type-options") || "なし", !base.startsWith("https"));
  check("ヘッダー X-Frame-Options", Boolean(h("x-frame-options")), h("x-frame-options") || "なし", !base.startsWith("https"));
  if (u.protocol === "https:") check("ヘッダー Strict-Transport-Security", Boolean(h("strict-transport-security")), h("strict-transport-security") || "なし", true);
  check("サーバーの版を出さない", !/nginx\/\d/.test(h("server")) && !h("x-powered-by"), `server=${h("server") || "-"} x-powered-by=${h("x-powered-by") || "-"}`, true);
} catch (err) {
  check("ログイン画面", false, err.message);
}

// 4. ログインしていない人の締め出し
for (const p of ["/customers", "/reports", "/settings", "/api/export?type=customers"]) {
  try {
    const { res } = await req(p);
    const loc = res.headers.get("location") ?? "";
    check(`ログインなしの ${p} は入れない`, (res.status >= 300 && res.status < 400 && loc.includes("/login")) || res.status === 401 || res.status === 403, `HTTP ${res.status} ${loc}`);
  } catch (err) {
    check(`ログインなしの ${p}`, false, err.message);
  }
}

// 5. 外部からの受信口・共有リンク・定期実行 (鍵なしは拒否。ログイン画面へ転送されないこと)
for (const [p, init] of [
  ["/api/integrations/line", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }],
  ["/api/integrations/chatwork", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }],
  ["/api/integrations/webform", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }],
  ["/api/integrations/ai-intake?source=phone", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }],
  ["/api/cron/knowledge-sync", { method: "POST" }],
  ["/api/doc/quote/x?exp=1&sig=bad", {}],
]) {
  try {
    const { res } = await req(p, init);
    check(`${p.split("?")[0]}: 鍵・署名なしは拒否`, [400, 401, 403, 404, 410, 503].includes(res.status), `HTTP ${res.status}${res.status === 503 ? " (設定前)" : ""}`);
  } catch (err) {
    check(p, false, err.message);
  }
}

const fails = results.filter((r) => !r.ok && !r.warnOnly);
const warns = results.filter((r) => !r.ok && r.warnOnly);
for (const r of results) console.log(`${r.ok ? "✓" : r.warnOnly ? "△" : "✕"} ${r.name}${r.detail ? `  — ${r.detail}` : ""}`);
console.log(`\n${base}: ${results.length - fails.length - warns.length}/${results.length} 合格${warns.length ? `・注意 ${warns.length}` : ""}${fails.length ? `・不合格 ${fails.length}` : ""}`);
process.exit(fails.length ? 1 : 0);
