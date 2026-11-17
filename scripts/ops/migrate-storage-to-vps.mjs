#!/usr/bin/env node
/**
 * 添付ファイル・写真を Supabase Storage (バケット "attachments") から、このサーバー (VPS) の保存先へ移す
 *
 *   node scripts/ops/migrate-storage-to-vps.mjs                 → コピーして、台帳 (データベース) の参照がすべて VPS にあるか確かめる
 *   node scripts/ops/migrate-storage-to-vps.mjs --dry-run       → 件数だけ (何も書かない)
 *   node scripts/ops/migrate-storage-to-vps.mjs --delete-remote → コピーと確認のあと、中身が一致したものを Supabase Storage から削除する
 *
 * - 保存先はアプリと同じ: FILE_STORAGE_DIR、なければ /srv/ichijoya/data/uploads (本番サーバー) / data/uploads
 * - 何度実行してもよい (同じ大きさのファイルは取り直さない)
 * - --delete-remote は、Supabase の各ファイルを取り直して VPS のファイルと SHA-256 で比べ、一致したものだけを削除する。
 *   台帳が参照しているファイルが 1 件でも VPS にないときは何も削除しない
 * - 接続は NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SECRET_KEY (環境変数、または .env.local)
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { loadEnv } from "../import/env.mjs";

loadEnv();
const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry-run");
const DELETE_REMOTE = args.has("--delete-remote");
const BUCKET = "attachments";
const URL_BASE = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/+$/, "");
const KEY = process.env.SUPABASE_SECRET_KEY ?? "";
if (!URL_BASE || !KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SECRET_KEY を設定してください。");
  process.exit(1);
}
const DEST = process.env.FILE_STORAGE_DIR?.trim() ? path.resolve(process.env.FILE_STORAGE_DIR.trim()) : fs.existsSync("/srv/ichijoya") ? "/srv/ichijoya/data/uploads" : path.resolve("data/uploads");
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const encodeKey = (k) => k.split("/").map(encodeURIComponent).join("/");

function localPath(key) {
  const p = path.resolve(DEST, key);
  if (!p.startsWith(DEST + path.sep)) throw new Error(`不正なキー: ${key}`);
  return p;
}

async function api(method, p, body) {
  const res = await fetch(`${URL_BASE}${p}`, { method, headers: { ...H, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60_000) });
  return res;
}

/** バケットの全ファイル (キー・大きさ) */
async function listAll(prefix = "") {
  const files = [];
  for (let offset = 0; ; offset += 1000) {
    const res = await api("POST", `/storage/v1/object/list/${BUCKET}`, { prefix, limit: 1000, offset, sortBy: { column: "name", order: "asc" } });
    if (res.status === 400 || res.status === 404) {
      const t = await res.text();
      if (/not found/i.test(t)) return files;
      throw new Error(`一覧を取得できません (${prefix || "/"}): ${res.status} ${t}`);
    }
    if (!res.ok) throw new Error(`一覧を取得できません (${prefix || "/"}): ${res.status} ${await res.text()}`);
    const data = await res.json();
    for (const it of data) {
      const k = prefix ? `${prefix}/${it.name}` : it.name;
      if (it.id === null || !it.metadata) files.push(...(await listAll(k)));
      else files.push({ key: k, size: Number(it.metadata.size ?? 0) });
    }
    if (data.length < 1000) break;
  }
  return files;
}

async function download(key) {
  const res = await api("GET", `/storage/v1/object/${BUCKET}/${encodeKey(key)}`);
  if (!res.ok) throw new Error(`取得できません: ${key} (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

function writeAtomic(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o750 });
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o640);
  try {
    fs.writeSync(fd, buf);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

/** 台帳 (データベース) が参照しているファイルのキー */
async function referencedKeys() {
  const keys = new Set();
  for (const [table, cols] of [["attachments", ["storage_key", "thumb_key"]], ["users", ["avatar_key"]]]) {
    for (let from = 0; ; from += 1000) {
      const res = await fetch(`${URL_BASE}/rest/v1/${table}?select=${cols.join(",")}&order=id`, { headers: { ...H, Range: `${from}-${from + 999}` } });
      if (!res.ok) throw new Error(`${table} を読めません: ${res.status} ${await res.text()}`);
      const rows = await res.json();
      for (const r of rows) for (const c of cols) if (r[c]) keys.add(r[c]);
      if (rows.length < 1000) break;
    }
  }
  return keys;
}

const t0 = Date.now();
console.log(`保存先 (VPS): ${DEST}`);
const remote = await listAll();
const total = remote.reduce((a, f) => a + f.size, 0);
console.log(`Supabase Storage: ${remote.length} 件 (${(total / 1048576).toFixed(1)} MB)`);

let copied = 0;
let existed = 0;
for (const f of remote) {
  const out = localPath(f.key);
  if (fs.existsSync(out) && fs.statSync(out).size === f.size) {
    existed++;
    continue;
  }
  if (DRY) {
    copied++;
    continue;
  }
  const buf = await download(f.key);
  if (buf.length !== f.size) throw new Error(`大きさが一致しません: ${f.key} (${buf.length} / ${f.size})`);
  writeAtomic(out, buf);
  copied++;
}
console.log(`${DRY ? "コピー対象" : "コピー"}: ${copied} 件・VPS に既にある: ${existed} 件`);

const refs = await referencedKeys();
const missing = [...refs].filter((k) => !fs.existsSync(localPath(k)));
console.log(`台帳の参照: ${refs.size} 件・VPS にないもの: ${missing.length} 件`);
for (const k of missing) console.log(`  ない: ${k}`);

if (DELETE_REMOTE && !DRY) {
  if (missing.length) {
    console.error("台帳が参照しているファイルが VPS にないため、Supabase Storage からは削除しません。");
    process.exit(1);
  }
  const same = [];
  for (const f of remote) {
    const local = fs.readFileSync(localPath(f.key));
    const r = await download(f.key);
    if (sha(local) === sha(r)) same.push(f.key);
    else console.error(`  中身が一致しないため残します: ${f.key}`);
  }
  for (let i = 0; i < same.length; i += 100) {
    const res = await api("DELETE", `/storage/v1/object/${BUCKET}`, { prefixes: same.slice(i, i + 100) });
    if (!res.ok) throw new Error(`削除できません: ${res.status} ${await res.text()}`);
  }
  const left = await listAll();
  console.log(`Supabase Storage から削除: ${same.length} 件 (SHA-256 で一致を確認)・残り: ${left.length} 件`);
  if (!left.length) {
    const res = await api("DELETE", `/storage/v1/bucket/${BUCKET}`);
    console.log(res.ok ? `空になったバケット ${BUCKET} を削除しました` : `バケット ${BUCKET} は残しました (${res.status})`);
  }
}
console.log(`完了 (${((Date.now() - t0) / 1000).toFixed(1)} 秒)`);
process.exit(missing.length ? 1 : 0);
