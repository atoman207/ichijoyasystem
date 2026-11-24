#!/usr/bin/env node
/**
 * 郵便番号のデータ (九州 7 県) を作る: src/lib/postal/kyushu.json
 *   node scripts/import/build-postal.mjs            (日本郵便の KEN_ALL (UTF-8 版) → 使えないときは ken-all.numb86.net の写し)
 *   node scripts/import/build-postal.mjs --mirror   (写しだけを使う)
 * お客様のご要望 2026-11-24「① 郵便番号の自動設定」: 住所 → 郵便番号 (src/lib/postal/lookup.ts)。
 * 日本郵便の郵便番号データは公開のデータ (再配布可)。毎月更新されるので、ときどき作り直す。
 * 形式: { source, fetchedAt, prefs: { 県: { 市区町村: { 町域: "8611102" | ["8612118", "8610918"] (町域が丁目などで分かれる) } } } }
 *   町域 "" = 「以下に掲載がない場合」(使わない。町名が分からないときは郵便番号を決めない)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const out = path.join(root, "src/lib/postal/kyushu.json");
const PREFS = new Set(["福岡県", "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県"]);
const UA = { "User-Agent": "Mozilla/5.0 (compatible; ichijoya-ims postal builder)" };

/** 町域の注記を外す (「（次のビルを除く）」「以下に掲載がない場合」など) */
function cleanTown(t) {
  if (/以下に掲載がない場合|の次に番地がくる場合|一円$/.test(t)) return /一円$/.test(t) ? t.replace(/一円$/, "") : "";
  return t.replace(/（.*$/, "").replace(/\(.*$/, "").trim();
}

async function official() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kenall-"));
  const res = await fetch("https://www.post.japanpost.jp/zipcode/dl/utf/zip/utf_ken_all.zip", { headers: UA });
  if (!res.ok || !(res.headers.get("content-type") ?? "").includes("zip")) throw new Error(`日本郵便のデータを取得できません (${res.status})`);
  fs.writeFileSync(path.join(tmp, "k.zip"), Buffer.from(await res.arrayBuffer()));
  execFileSync("unzip", ["-o", "-q", path.join(tmp, "k.zip"), "-d", tmp]);
  const csv = fs.readFileSync(path.join(tmp, "utf_ken_all.csv"), "utf8");
  // 列: 全国地方公共団体コード, 旧郵便番号, 郵便番号, 県カナ, 市カナ, 町カナ, 県, 市区町村, 町域, ...
  const rows = [];
  let carry = null;
  for (const line of csv.split(/\r?\n/)) {
    const f = [...line.matchAll(/"([^"]*)"|([^,]+)/g)].map((m) => m[1] ?? m[2]);
    if (f.length < 9) continue;
    let town = f[8];
    // 町域が長いと複数の行に分かれる (「（」で始まり「）」で閉じるまで)
    if (carry && carry.zip === f[2]) {
      carry.town += town;
      if (!/（[^）]*$/.test(carry.town)) {
        rows.push(carry);
        carry = null;
      }
      continue;
    }
    const r = { zip: f[2], pref: f[6], city: f[7], town };
    if (/（[^）]*$/.test(town)) carry = r;
    else rows.push(r);
  }
  return { source: "日本郵便 郵便番号データ (KEN_ALL・UTF-8 版)", rows };
}

async function mirror() {
  const rows = [];
  for (let p = 800; p <= 899; p++) {
    const res = await fetch(`https://ken-all.numb86.net/csv/${p}.csv`, { headers: UA });
    if (!res.ok) throw new Error(`写しを取得できません (${p}: ${res.status})`);
    for (const line of (await res.text()).split(/\r?\n/)) {
      const f = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
      if (f.length < 4) continue;
      rows.push({ zip: `${p}${f[0]}`, pref: f[1], city: f[2], town: f[3] });
    }
  }
  return { source: "日本郵便 郵便番号データ (KEN_ALL) の写し: ken-all.numb86.net (日本郵便のダウンロードが使えなかったため)", rows };
}

const useMirror = process.argv.includes("--mirror");
let data;
try {
  data = useMirror ? await mirror() : await official();
} catch (e) {
  console.warn(`[postal] ${e.message} → 写しを使います`);
  data = await mirror();
}
const prefs = {};
let n = 0;
for (const r of data.rows) {
  if (!PREFS.has(r.pref) || !/^\d{7}$/.test(r.zip)) continue;
  const town = cleanTown(r.town);
  const city = ((prefs[r.pref] ??= {})[r.city] ??= {});
  const cur = city[town];
  if (cur === undefined) city[town] = r.zip;
  else if (Array.isArray(cur)) {
    if (!cur.includes(r.zip)) cur.push(r.zip);
  } else if (cur !== r.zip) city[town] = [cur, r.zip];
  n++;
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ source: data.source, fetchedAt: new Date().toISOString().slice(0, 10), prefs }));
const towns = Object.values(prefs).reduce((s, c) => s + Object.values(c).reduce((t, m) => t + Object.keys(m).length, 0), 0);
console.log(`[postal] ${n} 行 → ${towns} 町域 (${Object.keys(prefs).join("・")}) → ${path.relative(root, out)} (${Math.round(fs.statSync(out).size / 1024)} KB)`);
