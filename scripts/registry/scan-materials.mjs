#!/usr/bin/env node
/**
 * データ台帳: クライアント資料 (source/ の分野ごとのフォルダー) を読み、資料庫 (VPS のデータフォルダーの SQLite) に入れる
 * ------------------------------------------------------------
 *   node scripts/registry/scan-materials.mjs                 → 変わったファイルだけ読み直す (保存先は src/lib/registry/materials-db.ts の materialsPath)
 *   node scripts/registry/scan-materials.mjs --force         → 全部読み直す
 *   node scripts/registry/scan-materials.mjs --db <file>     → 保存先を指定 (サンプルデータ: data/database/ichijoya-materials.sqlite)
 *   node scripts/registry/scan-materials.mjs --dir <folder>  → 資料のフォルダー (既定 source/。ICHIJOYA_SOURCE_DIR でも指定できる)
 *   node scripts/registry/scan-materials.mjs --report <dir>  → 報告の保存先 (既定 data/registry)
 *   node scripts/registry/scan-materials.mjs --no-index      → 索引 (source/_index/manifest.json) を書き直さない
 *
 * - フォルダーの決まりは source/README.md。分野のフォルダーに置けば、名前の規則に当たらない資料もそのフォルダーの扱いになる (classify.ts の SOURCE_FOLDERS)
 * - 資料の ID は索引 (src/lib/registry/source.ts) から決める (整理の前後で同じ)。人がファイルを動かしても、中身 (sha1) が同じなら ID を引き継ぎ、索引も新しくする
 * - _index/ (索引・取得の記録・OS の管理ファイル) と README.md は資料として読まない
 * - 表計算は SheetJS (.xlsx・.xlsm・.xls・.ods)、PDF は pdftotext、古い Word (.doc) は LibreOffice で文字にする (なければ「読めない」として記録)
 * - 分類と見られる人は src/lib/registry/classify.ts の規則。個人の情報 (健康・ご家族・給与・就労証明) は内容を取り込まない
 * - 同じ中身のファイル (sha1 が同じ) は、最初の 1 件だけに中身を持つ
 * - 人が画面で変えた扱いと、社内資料に登録した ID は残す
 * - 報告: data/registry/scan-report.md と .csv (個人情報を含みうるため data/ に置く。コミットしない)
 * 社内資料 (Supabase の knowledge) への登録は別のスクリプト: scripts/registry/promote-knowledge.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { loadEnv } from "../import/env.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const require = createRequire(path.join(root, "package.json"));
const XLSX = require("xlsx");
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { alias: { "@": path.join(root, "src"), "server-only": path.join(root, "scripts/tests/maps/empty.cjs") } });
const imp = (p) => jiti.import(path.join(root, "src", p));

loadEnv(root);
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};

const E = await imp("lib/registry/extract.ts");
const C = await imp("lib/registry/classify.ts");
const B = await imp("lib/registry/build.ts");
const M = await imp("lib/registry/materials-db.ts");
const SRC = await imp("lib/registry/source.ts");

const DIR = opt("--dir") ? path.resolve(root, opt("--dir")) : SRC.sourceDir(root);
if (!fs.existsSync(DIR)) {
  console.error(`資料のフォルダーがありません: ${DIR}\n(クライアント資料は source/ に置きます。source/README.md)`);
  process.exit(1);
}
const dbFile = opt("--db") ? path.resolve(root, opt("--db")) : M.materialsPath();
if (!dbFile) {
  console.error("資料庫が止められています (ICHIJOYA_MATERIALS_DB_PATH=off)。");
  process.exit(1);
}
const FORCE = flag("--force");
const REPORT_DIR = opt("--report") ? path.resolve(opt("--report")) : path.join(root, "data", "registry");

const db = M.openMaterials(dbFile);
if (!db) {
  console.error(`資料庫を開けません: ${dbFile}`);
  process.exit(1);
}
const rulesVersion = db.prepare("select value from _meta where key = 'rules_version'").get()?.value;
const rescanAll = FORCE || rulesVersion !== B.RULES_VERSION;
console.log(`資料: ${DIR}\n資料庫: ${dbFile}\n${rescanAll ? `全部読み直します (${FORCE ? "--force" : `規則 ${rulesVersion ?? "なし"} → ${B.RULES_VERSION}`})` : "変わったファイルだけ読み直します"}`);

/* ------------------------------------------------------------------ */
/* ファイルの一覧                                                        */
/* ------------------------------------------------------------------ */

const files = SRC.listSourceFiles(DIR);

// 資料台帳 (source_files) の ID とドライブのリンク (移行のときの data/import/client-data.json。整理する前の場所で引く)
const known = new Map();
const clientData = path.join(root, "data/import/client-data.json");
if (fs.existsSync(clientData)) {
  for (const f of JSON.parse(fs.readFileSync(clientData, "utf8")).sourceFiles ?? []) known.set(`${f.folder}/${f.path}`.normalize("NFC"), f);
}
const legacyKey = (from) => {
  const parts = from.split("/");
  return (parts.length > 1 ? `${parts[0]}/${parts.slice(1).join("/")}` : `/${from}`).normalize("NFC");
};

// 中身の指紋 (大きな動画も少しずつ読む)
function sha1Of(abs) {
  const h = crypto.createHash("sha1");
  const fd = fs.openSync(abs, "r");
  const buf = Buffer.alloc(8 * 1024 * 1024);
  try {
    for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0; ) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}
for (const f of files) {
  f.bytes = fs.statSync(f.abs).size;
  f.sha1 = sha1Of(f.abs);
}

// 索引と突き合わせて ID を決める (動かしたファイルは ID を引き継ぐ)
const manifest = SRC.readManifest(DIR);
const resolved = SRC.resolveSourceFiles(manifest, files, known);
const byRel = new Map(resolved.files.map((r) => [r.rel, r]));

/* ------------------------------------------------------------------ */
/* 読み取り                                                              */
/* ------------------------------------------------------------------ */

const LO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "registry-lo-"));
let soffice;
try {
  execFileSync("which", ["soffice"], { stdio: "ignore" });
  soffice = "soffice";
} catch {
  soffice = undefined;
}
let pdftotext = true;
try {
  execFileSync("which", ["pdftotext"], { stdio: "ignore" });
} catch {
  pdftotext = false;
}

function spreadsheet(abs) {
  const wb = XLSX.readFile(abs, { cellDates: true, cellStyles: false, cellHTML: false });
  const sheetRows = {};
  const sections = wb.SheetNames.map((n) => {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: "", blankrows: false });
    sheetRows[n] = rows.filter((r) => r.some((c) => String(c).trim())).length;
    return { title: n, text: E.rowsToText(rows) };
  });
  return { sections, sheetRows };
}

function pdf(abs, title) {
  if (!pdftotext) throw new Error("pdftotext がありません");
  const text = execFileSync("pdftotext", ["-enc", "UTF-8", "-layout", abs, "-"], { maxBuffer: 128 * 1024 * 1024, timeout: 120_000 }).toString("utf8");
  // 列をそろえる空白 (3 つ以上) は区切りにする
  const clean = text.replace(/[ 　]{3,}/g, " | ").replace(/^ \| /gm, "");
  return { sections: E.textSections(title, clean, { pages: true }) };
}

function legacyDoc(abs, title) {
  if (!soffice) throw new Error("LibreOffice がないため .doc を読めません");
  const out = fs.mkdtempSync(path.join(LO_HOME, "out-"));
  execFileSync(soffice, [`-env:UserInstallation=file://${LO_HOME}/profile`, "--headless", "--norestore", "--convert-to", "txt:Text (encoded):UTF8", "--outdir", out, abs], { stdio: "ignore", timeout: 120_000 });
  const txt = fs.readdirSync(out).find((f) => f.endsWith(".txt"));
  if (!txt) throw new Error("LibreOffice で文字にできませんでした");
  return { sections: E.textSections(title, E.decodeText(fs.readFileSync(path.join(out, txt)))) };
}

function read(file, ext, kind) {
  const title = path.basename(file.abs).replace(/\.[^.]+$/, "");
  if (kind === "spreadsheet") return spreadsheet(file.abs);
  if (kind === "pdf") return pdf(file.abs, title);
  if (["doc", "rtf", "odt", "ppt"].includes(ext)) return legacyDoc(file.abs, title);
  if (ext === "csv" || ext === "tsv" || kind === "text") {
    // 大きな CSV (売上明細など) は先頭だけ読む (取込済みのデータは要約だけ持つため)
    const fd = fs.openSync(file.abs, "r");
    const buf = Buffer.alloc(Math.min(fs.statSync(file.abs).size, 2 * 1024 * 1024));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const text = E.decodeText(buf);
    const lines = text.split(/\r?\n/).length;
    return { sections: E.textSections(title, text), sheetRows: { [title]: lines } };
  }
  const builtin = E.extractBuiltin(path.basename(file.abs), fs.readFileSync(file.abs));
  return builtin ? { sections: builtin } : { sections: null };
}

/* ------------------------------------------------------------------ */
/* 実行                                                                  */
/* ------------------------------------------------------------------ */

const started = Date.now();
const firstBySha = new Map();
const stats = { files: files.length, read: 0, unchanged: 0, errors: 0, byAction: {}, chars: 0, chunks: 0 };
const report = [];
let i = 0;
for (const file of files) {
  i++;
  const ext = (/\.([^./]+)$/.exec(file.rel)?.[1] ?? "").toLowerCase();
  const kind = E.kindOfExt(ext);
  const parts = file.rel.split("/");
  const folder = parts.length > 1 ? parts[0] : "";
  const relInFolder = parts.length > 1 ? parts.slice(1).join("/") : file.rel;
  const r = byRel.get(file.rel);
  const id = r.id;
  const from = r.entry.from;
  const knownRow = from ? known.get(legacyKey(from)) : undefined;
  const st = fs.statSync(file.abs);
  const sha1 = file.sha1;
  const cls = C.classifyPath(file.rel, kind);
  stats.byAction[cls.action] = (stats.byAction[cls.action] ?? 0) + 1;

  const dupOf = firstBySha.get(sha1);
  if (!dupOf) firstBySha.set(sha1, { id, path: file.rel });

  const prev = M.getDoc(db, id);
  const samePlace = prev && prev.folder === folder && prev.path === relInFolder && (prev.originalPath ?? null) === (from ?? null);
  if (!rescanAll && prev && samePlace && prev.sha1 === sha1 && prev.ruleKey === `${B.RULES_VERSION}|${C.classificationKey(cls)}` && (prev.duplicateOf ?? null) === (dupOf?.id ?? null)) {
    stats.unchanged++;
    report.push({ ...prev, rel: file.rel });
    continue;
  }

  let sections = null;
  let sheetRows;
  let error;
  if (!["ledger", "exclude"].includes(cls.action) && !dupOf && !["image", "media", "other"].includes(kind)) {
    try {
      const r = read(file, ext, kind);
      sections = r.sections;
      sheetRows = r.sheetRows;
    } catch (err) {
      error = String(err.message ?? err).slice(0, 200);
      stats.errors++;
    }
  } else if (cls.action === "exclude" && kind === "spreadsheet") {
    // 除外する表計算は、シートの名前だけ記録する (中身は読まない)
    try {
      sections = XLSX.readFile(file.abs, { bookSheets: true }).SheetNames.map((n) => ({ title: n, text: "" }));
    } catch {
      sections = [];
    }
  }
  const { doc, chunks } = B.buildDoc(
    {
      id,
      origin: "client",
      folder,
      folderLabel: C.FOLDER_LABEL[folder] ?? folder.replace(/^\d+_/, ""),
      path: relInFolder,
      name: path.basename(file.abs),
      ext,
      kind,
      bytes: st.size,
      mtime: (r.entry.modifiedOn ?? knownRow?.modifiedOn ?? st.mtime.toISOString()).slice(0, 10),
      sha1,
      driveUrl: r.entry.driveUrl ?? knownRow?.driveUrl,
      originalPath: from,
      sections,
      error,
      sheetRows,
      duplicateOf: dupOf,
    },
    cls,
  );
  M.upsertDoc(db, doc, chunks);
  stats.read++;
  stats.chars += doc.chars;
  stats.chunks += chunks.length;
  report.push({ ...doc, rel: file.rel, knowledgeSections: chunks.filter((c) => c.knowledge).length, visibilities: [...new Set(chunks.map((c) => c.visibility))] });
  if (i % 100 === 0) console.log(`  ${i}/${files.length} …`);
}

// 資料のフォルダーからなくなったファイル (クライアント資料のもの) は台帳から外す
const present = new Set(report.map((r) => r.id));
const gone = db.prepare("select id from docs where origin = 'client'").all().map((r) => String(r.id)).filter((x) => !present.has(x));
for (const id of gone) M.deleteDoc(db, id);

db.prepare("insert into _meta (key, value) values ('rules_version', ?) on conflict (key) do update set value = excluded.value").run(B.RULES_VERSION);
// 索引を新しくする (あとから追加した・動かした・なくなった資料)
const added = resolved.files.filter((x) => x.change === "added");
const moved = resolved.files.filter((x) => x.change === "moved");
if ((resolved.changed || !fs.existsSync(path.join(DIR, "_index", "manifest.csv"))) && !flag("--no-index")) SRC.writeManifest(DIR, resolved.manifest);
M.addRun(db, { kind: "scan", by: "script", summary: { ...stats, removed: gone.length, added: added.length, moved: moved.length, ms: Date.now() - started, dir: path.relative(root, DIR) || ".", dirAbs: DIR } });
// 書き直しが多かったときは空き領域を詰める (ファイルが大きくならないように)
db.exec("pragma wal_checkpoint(truncate)");
if (stats.read > 200 || gone.length > 50) {
  db.exec("vacuum");
  db.exec("pragma wal_checkpoint(truncate)");
}
const totals = M.materialsStats(db, dbFile);
fs.rmSync(LO_HOME, { recursive: true, force: true });

/* ------------------------------------------------------------------ */
/* 報告                                                                  */
/* ------------------------------------------------------------------ */

fs.mkdirSync(REPORT_DIR, { recursive: true });
const csvCell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
fs.writeFileSync(
  path.join(REPORT_DIR, "scan-report.csv"),
  "﻿" +
    [
      ["ID", "フォルダ", "パス", "整理する前の場所", "種類", "扱い", "分類", "見られる人", "状態", "文字数", "社内資料の節", "取込先", "説明", "個人情報の判定", "同じ内容"].map(csvCell).join(","),
      ...report.map((r) =>
        [r.id, r.folder, r.path, r.originalPath ?? "", r.kind, C.ACTION_LABEL[r.action] ?? r.action, r.category, r.visibility, r.status, r.chars, r.knowledgeSections ?? "", r.importedTo ?? "", r.note ?? "", r.pii?.reason ?? "", r.duplicateOf ?? ""].map(csvCell).join(","),
      ),
    ].join("\n"),
);
const byFolder = new Map();
for (const r of report) {
  const f = byFolder.get(r.folder) ?? { n: 0, chars: 0, actions: {} };
  f.n++;
  f.chars += r.chars ?? 0;
  f.actions[r.action] = (f.actions[r.action] ?? 0) + 1;
  byFolder.set(r.folder, f);
}
const md = [
  `# データ台帳: クライアント資料の読み取り (${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC)`,
  "",
  `- 資料のフォルダー: ${path.relative(root, DIR) || DIR}`,
  `- ファイル ${files.length} 件 (読み直し ${stats.read}・変わらず ${stats.unchanged}・読めない ${stats.errors}・なくなった ${gone.length})`,
  `- 索引: あとから追加 ${added.length}・場所が変わった ${moved.length}・索引から外した ${resolved.removed.length}`,
  `- 資料庫: ${totals.docs} 件・節 ${totals.chunks}・文字 ${totals.chars.toLocaleString()}・社内資料に登録する節 ${totals.knowledgeSections}・同じ内容 ${totals.duplicates}`,
  "",
  "## フォルダごと",
  "| フォルダ | ファイル | 文字 | 扱い |",
  "|---|---:|---:|---|",
  ...[...byFolder.entries()].map(([f, v]) => `| ${f || "(source 直下)"} | ${v.n} | ${v.chars.toLocaleString()} | ${Object.entries(v.actions).map(([a, n]) => `${C.ACTION_LABEL[a]} ${n}`).join("・")} |`),
  "",
  "## 社内資料に登録する資料",
  ...report.filter((r) => r.action === "knowledge" && !r.duplicateOf).map((r) => `- ${r.rel} — ${r.category} / 節 ${r.knowledgeSections ?? "?"} / 見られる人 ${(r.visibilities ?? [r.visibility]).join("・")}`),
  "",
  "## 取り込まない資料 (個人の情報)",
  ...report.filter((r) => r.action === "exclude").map((r) => `- ${r.rel} — ${r.note}`),
  "",
  "## 個人情報らしいものが多く、見られる人を上げた資料",
  ...report.filter((r) => r.pii?.reason).map((r) => `- ${r.rel} — ${r.pii.reason}`),
  "",
  "## 読めなかったファイル",
  ...report.filter((r) => r.status === "error").map((r) => `- ${r.rel} — ${r.error}`),
].join("\n");
fs.writeFileSync(path.join(REPORT_DIR, "scan-report.md"), md);

console.log(`\n完了 (${Math.round((Date.now() - started) / 1000)} 秒)`);
console.log(`  読み直し ${stats.read}・変わらず ${stats.unchanged}・読めない ${stats.errors}・なくなった ${gone.length}`);
console.log(`  索引: あとから追加 ${added.length}・場所が変わった ${moved.length}${moved.length ? ` (${moved.slice(0, 5).map((x) => `${x.movedFrom} → ${x.rel}`).join("、")}${moved.length > 5 ? " …" : ""})` : ""}・索引から外した ${resolved.removed.length}`);
for (const f of added.slice(0, 20)) console.log(`    追加: ${f.rel} (${C.classifyPath(f.rel, E.kindOfExt((/\.([^./]+)$/.exec(f.rel)?.[1] ?? "").toLowerCase())).note})`);
console.log(`  扱い: ${Object.entries(stats.byAction).map(([a, n]) => `${C.ACTION_LABEL[a]} ${n}`).join(" / ")}`);
console.log(`  資料庫: ${totals.docs} 件・節 ${totals.chunks}・文字 ${totals.chars.toLocaleString()}・社内資料に登録する節 ${totals.knowledgeSections}・${((totals.fileBytes ?? 0) / 1024 / 1024).toFixed(1)} MB`);
console.log(`  報告: ${path.relative(root, path.join(REPORT_DIR, "scan-report.md"))}`);
M.closeMaterials();
