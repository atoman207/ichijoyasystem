import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

/**
 * クライアント資料のフォルダー source/ (リポジトリ直下。コミットしない) と、その索引 source/_index/manifest.json
 * ------------------------------------------------------------
 * クライアントから受け取った資料 (Google ドライブの共有フォルダー・参考の PDF) を、分野ごとのフォルダー (01_社内ルール・マニュアル 〜 99_その他) に
 * 整理して置く。データ台帳の読み取り (scripts/registry/scan-materials.mjs) がここを読み、資料庫 (materials-db.ts) に入れる。
 * - 索引は 1 ファイル 1 行: path (source/ からの場所)・from (整理する前の場所 = other/client-materials からの相対。../ は other 直下)・
 *   id (資料庫の ID。整理の前後で変えない)・sha1・Google ドライブのリンク。人がファイルを動かしても、sha1 で同じファイルと分かれば ID を引き継ぐ
 * - _index/ はシステム用 (索引・取得の記録 download-logs・OS の管理ファイル os-files)。資料としては読まない
 * - 古い置き場所 (other/client-materials の 9 フォルダ) を前提にした取込スクリプトは legacyView で元の並びを再現して読む
 * このファイルは Node だけで動く (@/ の別名を使わない。node --experimental-strip-types / jiti のどちらでも読める)
 */

export const SOURCE_DIRNAME = "source";
export const INDEX_DIRNAME = "_index";
export const MANIFEST_FILE = "manifest.json";

export type SourceRole = "material" | "download-log" | "os-file";

export interface SourceEntry {
  /** source/ からの場所 (区切りは /) */
  path: string;
  /** 整理する前の場所 (other/client-materials からの相対。../ は other 直下)。あとから追加したファイルはなし */
  from?: string;
  role: SourceRole;
  /** 資料庫 (データ台帳) の ID。material のときだけ */
  id?: string;
  bytes?: number;
  sha1?: string;
  driveUrl?: string;
  modifiedOn?: string;
  /** あとから追加したファイルを索引に入れた日時 */
  addedAt?: string;
}

export interface SourceManifest {
  version: 1;
  description?: string;
  organizedAt?: string;
  updatedAt?: string;
  /** 整理する前のフォルダー (from の基準) */
  from?: string;
  entries: SourceEntry[];
}

/** source/ の場所: ICHIJOYA_SOURCE_DIR、なければ <root>/source */
export function sourceDir(root = process.cwd()): string {
  const env = process.env.ICHIJOYA_SOURCE_DIR?.trim();
  return env ? path.resolve(root, env) : path.join(root, SOURCE_DIRNAME);
}

const nfc = (s: string) => s.normalize("NFC");
const toPosix = (p: string) => p.split(path.sep).join("/");
const hash12 = (s: string) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 12);

/** OS・アプリが作る管理ファイル (資料ではない) */
export const OS_FILE = /(^|\/)(Thumbs\.db|\.DS_Store|desktop\.ini|debug\.log|_download-log\.(md|json)|_download-summary\.(md|json))$|(^|\/)\._[^/]*$|(^|\/)__MACOSX\/|\.lnk$/i;

/** 資料として読まない場所 (索引・説明・OS の管理ファイル) */
export function isSystemPath(rel: string): boolean {
  const r = nfc(rel);
  return r === "README.md" || r.startsWith(`${INDEX_DIRNAME}/`) || OS_FILE.test(r);
}

/**
 * 資料庫の ID。整理する前の場所 (from) があれば、整理する前と同じ計算 (移行の資料台帳の ID → mf_ / mo_ + 場所の hash)。
 * あとから追加したファイルは ms_ + source/ からの場所の hash
 */
export function materialId(entry: { from?: string; path: string }, known?: Map<string, { id: string }>): string {
  if (entry.from) {
    const parts = entry.from.split("/");
    const folder = parts.length > 1 ? parts[0] : "";
    const inFolder = parts.length > 1 ? parts.slice(1).join("/") : entry.from;
    const k = known?.get(nfc(`${folder}/${inFolder}`));
    return k?.id ?? `${folder === ".." ? "mo" : "mf"}_${hash12(entry.from)}`;
  }
  return `ms_${hash12(nfc(entry.path))}`;
}

export function manifestPath(dir: string): string {
  return path.join(dir, INDEX_DIRNAME, MANIFEST_FILE);
}

export function readManifest(dir: string): SourceManifest | null {
  const file = manifestPath(dir);
  if (!fs.existsSync(file)) return null;
  const m = JSON.parse(fs.readFileSync(file, "utf8")) as SourceManifest;
  if (!Array.isArray(m.entries)) throw new Error(`索引の形が違います: ${file}`);
  return m;
}

const csvCell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
const ROLE_LABEL: Record<SourceRole, string> = { material: "資料", "download-log": "取得の記録", "os-file": "OS の管理ファイル" };

/** 索引を書く (manifest.json と、表計算で開く manifest.csv) */
export function writeManifest(dir: string, m: SourceManifest): void {
  const sorted = { ...m, entries: [...m.entries].sort((a, b) => a.path.localeCompare(b.path, "ja")) };
  fs.mkdirSync(path.join(dir, INDEX_DIRNAME), { recursive: true });
  fs.writeFileSync(manifestPath(dir), `${JSON.stringify(sorted, null, 1)}\n`);
  const rows = [
    ["場所 (source/ から)", "整理する前の場所", "種類", "資料庫の ID", "大きさ (バイト)", "sha1", "Google ドライブ"],
    ...sorted.entries.map((e) => [e.path, e.from ? (e.from.startsWith("../") ? `other/${e.from.slice(3)}` : `other/client-materials/${e.from}`) : "(あとから追加)", ROLE_LABEL[e.role], e.id ?? "", e.bytes ?? "", e.sha1 ?? "", e.driveUrl ?? ""]),
  ];
  fs.writeFileSync(path.join(dir, INDEX_DIRNAME, "manifest.csv"), `﻿${rows.map((r) => r.map(csvCell).join(",")).join("\n")}\n`);
}

/** source/ の資料のファイル (_index・README・OS の管理ファイルを除く)。rel は source/ からの場所 */
export function listSourceFiles(dir: string): { abs: string; rel: string }[] {
  const out: { abs: string; rel: string }[] = [];
  if (!fs.existsSync(dir)) return out;
  (function walk(d: string) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const rel = toPosix(path.relative(dir, p));
      if (e.isDirectory()) {
        if (rel !== INDEX_DIRNAME) walk(p);
      } else if (e.isFile() && !isSystemPath(rel)) out.push({ abs: p, rel });
    }
  })(dir);
  return out.sort((a, b) => a.rel.localeCompare(b.rel, "ja"));
}

export interface ResolvedFile {
  rel: string;
  id: string;
  entry: SourceEntry;
  /** 索引になかった (あとから追加した) / 場所が変わった (sha1 で同じファイルと分かった) */
  change?: "added" | "moved";
  movedFrom?: string;
}

/**
 * いまのファイルを索引と突き合わせ、ID を決める (索引も新しくする)
 * - 索引と同じ場所 → 索引の ID
 * - 索引にない場所で、sha1 が「索引にあって今はないファイル」と同じ → 動かしたとみなして ID・元の場所を引き継ぐ
 * - それ以外 → あとから追加したファイル (ms_ の ID)
 * 索引にあってファイルがなくなったもの (資料) は索引から外す (removed に返す)
 */
export function resolveSourceFiles(
  manifest: SourceManifest | null,
  files: { rel: string; sha1: string; bytes?: number }[],
  known?: Map<string, { id: string; driveUrl?: string; modifiedOn?: string }>,
  now = new Date().toISOString(),
): { files: ResolvedFile[]; manifest: SourceManifest; removed: SourceEntry[]; changed: boolean } {
  const entries = manifest?.entries ?? [];
  const byPath = new Map(entries.map((e) => [nfc(e.path), e]));
  const present = new Set(files.map((f) => nfc(f.rel)));
  // 索引にあって今はない資料 (動かした・消した)。sha1 ごと
  const missing = new Map<string, SourceEntry[]>();
  for (const e of entries) {
    if (e.role !== "material" || present.has(nfc(e.path)) || !e.sha1) continue;
    missing.set(e.sha1, [...(missing.get(e.sha1) ?? []), e]);
  }
  const used = new Set<SourceEntry>();
  const out: ResolvedFile[] = [];
  let changed = false;
  for (const f of files) {
    const at = byPath.get(nfc(f.rel));
    if (at && at.role === "material") {
      used.add(at);
      const id = at.id ?? materialId(at, known);
      if (at.sha1 !== f.sha1 || at.id !== id) {
        changed = true;
        at.sha1 = f.sha1;
        at.bytes = f.bytes ?? at.bytes;
        at.id = id;
      }
      out.push({ rel: f.rel, id, entry: at });
      continue;
    }
    const cand = missing.get(f.sha1)?.find((e) => !used.has(e));
    if (cand) {
      used.add(cand);
      changed = true;
      const movedFrom = cand.path;
      const entry: SourceEntry = { ...cand, path: f.rel, bytes: f.bytes ?? cand.bytes };
      entry.id = cand.id ?? materialId(cand, known);
      out.push({ rel: f.rel, id: entry.id, entry, change: "moved", movedFrom });
      continue;
    }
    changed = true;
    const entry: SourceEntry = { path: f.rel, role: "material", bytes: f.bytes, sha1: f.sha1, addedAt: now };
    entry.id = materialId(entry, known);
    out.push({ rel: f.rel, id: entry.id, entry, change: "added" });
  }
  const removed = entries.filter((e) => e.role === "material" && !used.has(e));
  if (removed.length) changed = true;
  const keepSystem = entries.filter((e) => e.role !== "material");
  const next: SourceManifest = {
    version: 1,
    description: manifest?.description ?? "source/ の索引。path = source/ からの場所 / from = 整理する前の場所 (other/client-materials から。../ は other 直下) / id = 資料庫 (データ台帳) の ID",
    organizedAt: manifest?.organizedAt,
    from: manifest?.from,
    updatedAt: changed ? now : manifest?.updatedAt,
    entries: [...keepSystem, ...out.map((f) => f.entry)],
  };
  return { files: out, manifest: next, removed, changed };
}

/**
 * 整理する前の並び (other/client-materials の 9 フォルダ・取得の記録) を、source/ のファイルへのリンクで一時フォルダーに作る。
 * 古い並びを前提にした取込スクリプト (scripts/import/extract-client-data.mjs など) に渡す。戻り値はそのフォルダー
 */
export function legacyView(dir: string, into = fs.mkdtempSync(path.join(os.tmpdir(), "ichijoya-legacy-"))): string {
  const m = readManifest(dir);
  if (!m) throw new Error(`索引がありません: ${manifestPath(dir)}`);
  for (const e of m.entries) {
    if (!e.from || e.from.startsWith("../")) continue;
    const target = path.join(dir, ...e.path.split("/"));
    if (!fs.existsSync(target)) continue;
    const link = path.join(into, ...e.from.split("/"));
    fs.mkdirSync(path.dirname(link), { recursive: true });
    if (!fs.existsSync(link)) fs.symlinkSync(target, link);
  }
  return into;
}

/** source/ から、場所または名前が test に当たる資料を探す (NFKC で比べる)。新しい順ではなく場所の順 */
export function findSourceFiles(dir: string, test: RegExp): string[] {
  return listSourceFiles(dir)
    .filter((f) => test.test(f.rel.normalize("NFKC")))
    .map((f) => f.abs);
}

/** 整理する前の場所 (from) から、いまの場所を返す (なければ undefined) */
export function locateByOrigin(dir: string, from: string): string | undefined {
  const e = readManifest(dir)?.entries.find((x) => x.from && nfc(x.from) === nfc(from));
  if (!e) return undefined;
  const abs = path.join(dir, ...e.path.split("/"));
  return fs.existsSync(abs) ? abs : undefined;
}
