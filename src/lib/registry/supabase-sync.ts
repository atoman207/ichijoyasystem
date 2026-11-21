import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { KnowledgeVisibility } from "@/lib/db/types";
import { snake } from "@/lib/db/schema";
import { FOLDER_LABEL, SOURCE_FOLDERS, storeFromPath } from "./classify";
import { kindOfExt } from "./extract";
import { allDocs, effAction, effCategory, effVisibility, getChunks, type MaterialDoc, type MaterialsSqlite } from "./materials-db";
import { INDEX_DIRNAME, isSystemPath, listSourceFiles } from "./source";

/**
 * クライアント資料 (source/) を Supabase にだけ置く表 (schema.ts の SUPABASE_ONLY_TABLES) の行にする
 * ------------------------------------------------------------
 * - source_items: source/ の全ファイル・全フォルダー 1 つ = 1 行。
 *   文書は資料庫 (VPS の SQLite。scan-materials.mjs が作る) の分類・見られる人・要約つき。画像・動画・フォルダー・システムのファイルは場所だけ
 *   (content = path_only)。個人の情報のファイルは場所だけで中身・シート名を持たない (content = excluded)
 * - source_texts: 文書の中身 (資料庫の節。ID・パスワードは伏せ字のまま・節ごとの見られる人。人が画面で変えた見られる人を優先)
 * ファイルの本体は Supabase に入れない (VPS のディスクの source/ にだけ置く)。書き込みは scripts/registry/sync-supabase.mjs
 */

export type SourceItemEntry = "file" | "folder" | "system";
export type SourceItemContent = "text" | "summary" | "path_only" | "excluded";

export interface SourceItemRow {
  id: string;
  entry: SourceItemEntry;
  path: string;
  parentPath: string;
  name: string;
  folder: string;
  folderLabel: string;
  ext: string;
  kind: string;
  content: SourceItemContent;
  bytes: number | null;
  sha1: string | null;
  modifiedOn: string | null;
  originalPath: string | null;
  sourceFileId: string | null;
  driveUrl: string | null;
  action: string | null;
  category: string | null;
  visibility: KnowledgeVisibility;
  storeId: string | null;
  recordDate: string | null;
  status: string;
  note: string | null;
  importedTo: string | null;
  duplicateOf: string | null;
  chars: number;
  sections: number;
  sheetNames: unknown;
  pii: unknown;
  summary: string | null;
  contentHash: string | null;
  /** 上の項目の指紋 (変わった行だけ書くため) */
  rowHash: string;
}

export interface SourceTextRow {
  id: string;
  itemId: string;
  seq: number;
  section: string;
  part: number;
  parts: number;
  visibility: KnowledgeVisibility;
  category: string | null;
  knowledge: boolean;
  recordDate: string | null;
  head: string;
  body: string;
  chars: number;
}

const sha1 = (s: string) => crypto.createHash("sha1").update(s).digest("hex");
const hash12 = (s: string) => sha1(s).slice(0, 12);
const toPosix = (p: string) => p.split(path.sep).join("/");
const parentOf = (rel: string) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");
const extOf = (name: string) => (/\.([^./]+)$/.exec(name)?.[1] ?? "").toLowerCase();
const day = (v: string | undefined) => (v && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);

/** 個人の情報のフォルダー (中身を読まない) */
const PERSONAL = /^15_人事・労務\/個人の情報/;

function topFolder(rel: string): string {
  return rel.includes("/") ? rel.slice(0, rel.indexOf("/")) : "";
}

function folderLabelOf(folder: string): string {
  return FOLDER_LABEL[folder] ?? (folder === INDEX_DIRNAME ? "システム (索引・取得の記録)" : folder.replace(/^\d+_/, ""));
}

/** フォルダー・システムのファイルの見られる人 (分野のフォルダーの設定。個人の情報・索引は管理者のみ) */
function placeVisibility(rel: string): KnowledgeVisibility {
  const n = rel.normalize("NFKC");
  if (n === INDEX_DIRNAME || n.startsWith(`${INDEX_DIRNAME}/`) || PERSONAL.test(n)) return "admin";
  return SOURCE_FOLDERS.find((f) => f.folder.normalize("NFKC") === topFolder(n) || f.folder.normalize("NFKC") === n)?.visibility ?? "hq";
}

/** 行の指紋 (rowHash を除いた項目) */
function withHash(row: Omit<SourceItemRow, "rowHash">): SourceItemRow {
  return { ...row, rowHash: sha1(JSON.stringify(row)) };
}

/** 中身の持ち方 */
export function contentOf(doc: MaterialDoc, texts: number): SourceItemContent {
  if (effAction(doc) === "exclude") return "excluded";
  if (!texts) return "path_only";
  return effAction(doc) === "structured" ? "summary" : "text";
}

function walkAll(dir: string): { dirs: string[]; files: { abs: string; rel: string }[] } {
  const dirs: string[] = [];
  const files: { abs: string; rel: string }[] = [];
  (function walk(d: string) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const rel = toPosix(path.relative(dir, p));
      if (e.isDirectory()) {
        dirs.push(rel);
        walk(p);
      } else if (e.isFile()) files.push({ abs: p, rel });
    }
  })(dir);
  return { dirs, files };
}

/**
 * source/ と資料庫から、Supabase に書く行を作る。
 * problems: 資料庫の読み取りが古い (読み取っていないファイル・読み取りの後になくなった・大きさが変わった)。あるときは書かない (先に npm run registry:scan)
 */
export function buildSourceRows(
  mdb: MaterialsSqlite,
  dir: string,
  opts: { sourceFileIds?: Set<string> } = {},
): { items: SourceItemRow[]; texts: SourceTextRow[]; problems: string[] } {
  const problems: string[] = [];
  const items: SourceItemRow[] = [];
  const texts: SourceTextRow[] = [];
  const onDisk = new Map(listSourceFiles(dir).map((f) => [f.rel.normalize("NFC"), f]));
  const seen = new Set<string>();

  // 資料 (資料庫の 1 件 = 1 ファイル)
  for (const doc of allDocs(mdb, "client")) {
    const rel = (doc.folder ? `${doc.folder}/${doc.path}` : doc.path).normalize("NFC");
    const file = onDisk.get(rel);
    if (!file) {
      problems.push(`資料庫にあって source/ にない: ${rel}`);
      continue;
    }
    seen.add(rel);
    const size = fs.statSync(file.abs).size;
    if (doc.bytes !== undefined && doc.bytes !== size) problems.push(`読み取りの後に変わった: ${rel} (${doc.bytes} → ${size} バイト)`);
    const excluded = effAction(doc) === "exclude";
    const chunks = excluded ? [] : getChunks(mdb, doc.id);
    const docTexts: SourceTextRow[] = chunks.map((c) => ({
      id: c.id,
      itemId: doc.id,
      seq: c.seq,
      section: c.section,
      part: c.part,
      parts: c.parts,
      visibility: doc.override?.visibility ?? c.visibility,
      category: doc.override?.category ?? c.category ?? null,
      knowledge: c.knowledge && effAction(doc) === "knowledge",
      recordDate: day(c.recordDate),
      head: c.head,
      body: c.body,
      chars: c.body.length,
    }));
    texts.push(...docTexts);
    const content = contentOf(doc, docTexts.length);
    items.push(
      withHash({
        id: doc.id,
        entry: "file",
        path: rel,
        parentPath: parentOf(rel),
        name: doc.name,
        folder: doc.folder,
        folderLabel: doc.folderLabel || folderLabelOf(doc.folder),
        ext: doc.ext,
        kind: doc.kind,
        content,
        bytes: size,
        sha1: doc.sha1 ?? null,
        modifiedOn: day(doc.mtime),
        originalPath: doc.originalPath ?? null,
        sourceFileId: opts.sourceFileIds?.has(doc.id) ? doc.id : null,
        driveUrl: doc.driveUrl ?? null,
        action: effAction(doc),
        category: effCategory(doc),
        visibility: effVisibility(doc),
        storeId: doc.storeId ?? null,
        recordDate: day(doc.recordDate),
        status: doc.status,
        note: doc.override?.note ?? doc.note ?? null,
        importedTo: doc.importedTo ?? null,
        duplicateOf: doc.duplicateOf ?? null,
        chars: docTexts.reduce((a, t) => a + t.chars, 0),
        sections: doc.sections,
        // 個人の情報はシート名も持たない (社員・ご家族の名前のことがあるため)
        sheetNames: excluded || content === "path_only" ? null : doc.sheetNames,
        pii: doc.pii ?? null,
        summary: excluded ? null : doc.summary ?? null,
        contentHash: docTexts.length ? sha1(docTexts.map((t) => [t.id, t.visibility, t.category, t.knowledge, t.recordDate, t.head, t.body].join("\u0001")).join("\u0002")) : null,
      }),
    );
  }
  for (const rel of onDisk.keys()) if (!seen.has(rel)) problems.push(`まだ読み取っていない: ${rel}`);

  // フォルダーとシステムのファイル (場所だけ)
  const { dirs, files } = walkAll(dir);
  for (const rel0 of dirs) {
    const rel = rel0.normalize("NFC");
    const folder = topFolder(rel) || rel;
    items.push(
      withHash({
        id: `sd_${hash12(rel)}`,
        entry: "folder",
        path: rel,
        parentPath: parentOf(rel),
        name: rel.split("/").pop() ?? rel,
        folder,
        folderLabel: folderLabelOf(folder),
        ext: "",
        kind: "folder",
        content: "path_only",
        bytes: null,
        sha1: null,
        modifiedOn: null,
        originalPath: null,
        sourceFileId: null,
        driveUrl: null,
        action: null,
        category: null,
        visibility: placeVisibility(rel),
        storeId: storeFromPath(rel) ?? null,
        recordDate: null,
        status: "ok",
        note: null,
        importedTo: null,
        duplicateOf: null,
        chars: 0,
        sections: 0,
        sheetNames: null,
        pii: null,
        summary: null,
        contentHash: null,
      }),
    );
  }
  for (const f of files) {
    const rel = f.rel.normalize("NFC");
    if (!isSystemPath(rel)) continue;
    const name = rel.split("/").pop() ?? rel;
    const folder = topFolder(rel);
    items.push(
      withHash({
        id: `sx_${hash12(rel)}`,
        entry: "system",
        path: rel,
        parentPath: parentOf(rel),
        name,
        folder,
        folderLabel: folder ? folderLabelOf(folder) : "source 直下",
        ext: extOf(name),
        kind: kindOfExt(extOf(name)),
        content: "path_only",
        bytes: fs.statSync(f.abs).size,
        sha1: null,
        modifiedOn: null,
        originalPath: null,
        sourceFileId: null,
        driveUrl: null,
        action: null,
        category: null,
        visibility: rel === "README.md" ? "all" : placeVisibility(rel),
        storeId: null,
        recordDate: null,
        status: "ok",
        note: rel === "README.md" ? "source/ の説明" : rel.startsWith(`${INDEX_DIRNAME}/`) ? "システム用 (索引・取得の記録・OS の管理ファイル)" : "OS・アプリの管理ファイル",
        importedTo: null,
        duplicateOf: null,
        chars: 0,
        sections: 0,
        sheetNames: null,
        pii: null,
        summary: null,
        contentHash: null,
      }),
    );
  }
  return { items, texts, problems };
}

/** 行の項目名を Supabase の列名 (snake_case) にする */
export function snakeRow<T extends object>(row: T, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries({ ...row, ...extra })) out[snake(k)] = v === undefined ? null : v;
  return out;
}

/** Supabase の今の行と比べる (追加・更新・削除。中身は指紋が変わった資料だけ書き直す) */
export function diffSourceRows(
  current: { id: string; rowHash: string | null; contentHash: string | null }[],
  items: SourceItemRow[],
): { insert: SourceItemRow[]; update: SourceItemRow[]; remove: string[]; textsFor: string[] } {
  const cur = new Map(current.map((r) => [r.id, r]));
  const next = new Set(items.map((i) => i.id));
  const insert: SourceItemRow[] = [];
  const update: SourceItemRow[] = [];
  const textsFor: string[] = [];
  for (const it of items) {
    const c = cur.get(it.id);
    if (!c) insert.push(it);
    else if (c.rowHash !== it.rowHash) update.push(it);
    if (it.contentHash && (!c || c.contentHash !== it.contentHash)) textsFor.push(it.id);
    // 中身がなくなった資料 (取り込まないに変えたなど) も、古い節を消す
    else if (!it.contentHash && c?.contentHash) textsFor.push(it.id);
  }
  return { insert, update, remove: current.map((r) => r.id).filter((id) => !next.has(id)), textsFor };
}
