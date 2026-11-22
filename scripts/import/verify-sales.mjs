#!/usr/bin/env node
/**
 * 売上の移行の検証 (読み取りだけ。データベースには書かない)
 *
 *   node scripts/import/verify-sales.mjs [--json=<データの JSON>] [--out=<出力の CSV>] [--after]
 *
 * 突き合わせるもの (月ごと):
 *   ① 販売管理ソフトの売上明細 (source/03_売上・実績/販売管理ソフトの売上明細/*.CSV): 明細の金額の合計 (そのまま) と、取込と同じ規則で税込にした額
 *   ② 店舗別の売上台帳 (source/03_売上・実績/店舗別の売上台帳/*.xlsx): 各シートの上の集計の「全 店」(税別) × 1.1
 *   ③ システムの受注 (売上日の月の合計): 既定は本番の控え (/srv/ichijoya/data/cache/db-production.ndjson.gz)、--json=<ファイル> で JSON のデータ
 *   --after: ③ に「二重計上をまとめたあと」(src/lib/sales-reconcile.ts。メモリの中だけで計算) の列を足す
 * あわせて、伝票がすべてシステムにあるか・伝票から作った受注の金額が伝票と一致するか・台帳の受注と伝票の金額の差を数える。
 * 出力の CSV (お客様の売上の数字) はコミットしない場所 (other/ など) に置く
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { createJiti } from "jiti";

process.env.TZ = "Asia/Tokyo";
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const require = createRequire(import.meta.url);
const XLSX = require("xlsx");
const jiti = createJiti(import.meta.url, { alias: { "@": path.join(root, "src"), "server-only": path.join(root, "scripts/tests/maps/empty.cjs") } });
const L = await jiti.import(path.join(root, "src/lib/sales-ledger.ts"));
const R = await jiti.import(path.join(root, "src/lib/sales-reconcile.ts"));

const args = process.argv.slice(2);
const opt = (k) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const AFTER = args.includes("--after");
const OUT = opt("out");
const SALES_DIR = path.join(root, "source/03_売上・実績");

/* ---------- ① 売上明細 ---------- */
const csvDir = path.join(SALES_DIR, "販売管理ソフトの売上明細");
const csvFile = fs.readdirSync(csvDir).filter((f) => /\.csv$/i.test(f)).sort().at(-1);
if (!csvFile) throw new Error(`売上明細の CSV がありません: ${csvDir}`);
const buf = fs.readFileSync(path.join(csvDir, csvFile));
let text;
try {
  text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
} catch {
  text = new TextDecoder("shift_jis").decode(buf);
}
const parsed = L.parseSalesCsv(text);

/* ---------- ③ システム ---------- */
const db = {};
const jsonFile = opt("json");
if (jsonFile) Object.assign(db, JSON.parse(fs.readFileSync(jsonFile, "utf8")));
else {
  const snap = "/srv/ichijoya/data/cache/db-production.ndjson.gz";
  for (const line of zlib.gunzipSync(fs.readFileSync(snap)).toString("utf8").split("\n")) {
    const t = line.indexOf("\t");
    if (t > 0) (db[line.slice(0, t)] ??= []).push(JSON.parse(line.slice(t + 1)));
  }
}
for (const k of ["orders", "customers"]) db[k] ??= [];

const month = new Map();
const M = (m) => month.get(m) ?? month.set(m, { raw: 0, conv: 0, ledgerSummary: null, system: 0, after: null }).get(m);
for (const s of parsed.slips) M(s.date.slice(0, 7)).raw += s.lines.reduce((a, l) => a + (Number.isFinite(l.amount) ? l.amount : 0), 0);

// 伝票 → 受注 (経過メモ pn_s<伝票№>_)
const slipNo = new Map(parsed.slips.map((s) => [String(s.no), s]));
const found = new Set();
const check = { csvOrders: 0, csvExact: 0, linkedOrders: 0, linkedExact: 0, linkedWithin3: 0, linkedOver3: 0 };
for (const o of db.orders) {
  if (o.status !== "cancelled" && o.salesDate) M(o.salesDate.slice(0, 7)).system += o.total;
  const notes = (o.progressNotes ?? []).filter((n) => /^pn_s\d+_/.test(n.id));
  if (!notes.length) continue;
  let conv = 0;
  for (const n of notes) {
    const s = slipNo.get(/^pn_s(\d+)_/.exec(n.id)[1]);
    if (!s) continue;
    found.add(String(s.no));
    const f = n.body.includes("明細 (税込)") ? 1 : 1 + L.taxRate(s.date);
    const by = {};
    for (const l of s.lines) by[L.ITEM_KEY[l.item] ?? "misc"] = (by[L.ITEM_KEY[l.item] ?? "misc"] ?? 0) + l.amount;
    const c = Object.values(by).reduce((a, v) => a + Math.round(v * f), 0);
    conv += c;
    M(s.date.slice(0, 7)).conv += c;
  }
  if ((o.sourceRef ?? "").startsWith("売上明細")) {
    check.csvOrders++;
    if (o.total === conv) check.csvExact++;
  } else {
    check.linkedOrders++;
    const g = Math.abs(o.total - conv) / Math.max(1, Math.abs(o.total));
    if (o.total === conv) check.linkedExact++;
    else if (g <= 0.03 || Math.abs(o.total - conv) <= 100) check.linkedWithin3++;
    else check.linkedOver3++;
  }
}
// 取り込んでいない伝票 (経過メモにない) も税込換算の列に入れる (既定の規則: 2021-03 から個人は税込)
const missing = parsed.slips.filter((s) => !found.has(String(s.no)));

/* ---------- ② 売上台帳の集計 ---------- */
const nk = (s) => String(s ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
const ledgerDir = path.join(SALES_DIR, "店舗別の売上台帳");
for (const f of fs.readdirSync(ledgerDir).filter((x) => /売上\.xlsx$/.test(nk(x)))) {
  const wb = XLSX.readFile(path.join(ledgerDir, f));
  for (const sh of wb.SheetNames) {
    const m = nk(sh).match(/^(\d{4})[.](\d{1,2})$/);
    if (!m) continue;
    const mo = `${m[1]}-${m[2].padStart(2, "0")}`;
    for (const row of XLSX.utils.sheet_to_json(wb.Sheets[sh], { header: 1, defval: "" }).slice(0, 25))
      for (let j = 0; j < row.length; j++)
        if (nk(row[j]) === "全 店" && typeof row[j + 1] === "number") {
          const r = M(mo);
          r.ledgerSummary = Math.max(r.ledgerSummary ?? 0, Math.round(row[j + 1] * 1.1));
        }
  }
}

/* ---------- まとめたあと ---------- */
let rec = null;
if (AFTER) {
  rec = R.applyReconcile(db, R.planReconcile(db), { now: new Date().toISOString() });
  for (const r of month.values()) r.after = 0;
  for (const o of db.orders) if (o.status !== "cancelled" && o.salesDate) M(o.salesDate.slice(0, 7)).after += o.total;
}

/* ---------- 出力 ---------- */
const rows = [...month].sort(([a], [b]) => a.localeCompare(b));
const head = ["月", "売上明細 (そのまま)", "売上明細 (税込に換算)", "売上台帳の全店 (税別×1.1)", "システム", ...(AFTER ? ["システム (二重計上をまとめたあと)"] : []), "差 (システム − 売上台帳)", ...(AFTER ? ["差 (まとめたあと − 売上台帳)"] : [])];
const lines = [head];
for (const [m, r] of rows) {
  const sys = r.system;
  lines.push([m, r.raw, r.conv, r.ledgerSummary ?? "", sys, ...(AFTER ? [r.after] : []), r.ledgerSummary != null ? sys - r.ledgerSummary : "", ...(AFTER ? [r.ledgerSummary != null ? r.after - r.ledgerSummary : ""] : [])]);
}
const years = new Map();
for (const [m, r] of rows) {
  const y = years.get(m.slice(0, 4)) ?? years.set(m.slice(0, 4), { raw: 0, conv: 0, ledger: 0, ledgerMonths: 0, system: 0, after: 0 }).get(m.slice(0, 4));
  y.raw += r.raw;
  y.conv += r.conv;
  y.system += r.system;
  y.after += r.after ?? 0;
  if (r.ledgerSummary != null) (y.ledger += r.ledgerSummary), y.ledgerMonths++;
}
const yen = (n) => `${Math.round(n).toLocaleString("ja-JP")}`;
console.log(`売上明細: ${csvFile} (${parsed.rows} 行 → 伝票 ${parsed.slips.length} 枚。読めない行 ${parsed.skipped.length})`);
console.log(`伝票がシステムにある: ${parsed.slips.length - missing.length} / ${parsed.slips.length} 枚${missing.length ? ` (ない伝票の例: ${missing.slice(0, 5).map((s) => s.no).join("、")})` : ""}`);
console.log(`伝票から作った受注 ${check.csvOrders} 件: 伝票の金額 (税込に換算) と一致 ${check.csvExact} 件`);
console.log(`売上台帳の受注にひも付けた伝票の受注 ${check.linkedOrders} 件: 金額が同じ ${check.linkedExact}・3% 以内 ${check.linkedWithin3}・3% を超える ${check.linkedOver3} (台帳の金額を残す)`);
if (rec) console.log(`二重計上をまとめる: ${rec.pairs.length} 組・伝票の受注 ${rec.ordersRemoved} 件 (残った台帳だけの受注 ${rec.remaining.ledgerOnly.n} 件 ${yen(rec.remaining.ledgerOnly.total)} 円)`);
console.log("\n年       売上明細(そのまま)  売上明細(税込換算)  売上台帳の全店(月数)        システム" + (AFTER ? "      まとめたあと" : ""));
for (const [y, a] of years) console.log(`${y}  ${yen(a.raw).padStart(16)}  ${yen(a.conv).padStart(16)}  ${a.ledgerMonths ? `${yen(a.ledger).padStart(14)} (${String(a.ledgerMonths).padStart(2)})` : "".padStart(19)}  ${yen(a.system).padStart(16)}${AFTER ? `  ${yen(a.after).padStart(16)}` : ""}`);
if (OUT) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, "﻿" + lines.map((l) => l.map((v) => (typeof v === "string" && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(",")).join("\r\n") + "\r\n");
  console.log(`\n月ごとの表: ${OUT}`);
}
