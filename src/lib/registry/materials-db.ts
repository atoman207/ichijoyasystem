import fs from "node:fs";
import path from "node:path";
import type { KnowledgeVisibility, StoreId } from "@/lib/db/types";
import type { RegistryAction } from "./classify";

/**
 * データ台帳の資料庫 (VPS のデータフォルダーの SQLite)
 * ------------------------------------------------------------
 * クライアント資料・画面から追加した資料の「中身の文字」を、ファイル 1 件 = docs の 1 行、節 (シート・ページ・見出し) の一部 = chunks の 1 行で持つ。
 * chunks は全文検索の索引 (FTS5 trigram) つき。AI アシスタントの search_materials・read_material とデータ台帳の画面が読む。
 * - 保存先: ICHIJOYA_MATERIALS_DB_PATH (off で止める)。なければ本番サーバー (/srv/ichijoya があり Supabase を使う) は
 *   /srv/ichijoya/data/database/ichijoya-materials.sqlite、それ以外 (サンプルデータ・手元) は data/database/ichijoya-materials.sqlite。
 *   3000 番と 3001 番で同じファイルを使う
 * - 元のファイルから作り直せる (scripts/registry/scan-materials.mjs)。人が画面で変えた扱い (o_* の列) と社内資料への登録 (knowledge_ids) は、
 *   読み直しても残す
 * - Supabase には入れない (文字が大きく、アプリはデータをメモリに持つため)。社内資料に登録した節だけが Supabase の knowledge に入る
 * - クライアント資料は source/ (分野ごとのフォルダー。source.ts)。folder = source/ の先頭の階層・path = その中の場所・orig_path = 整理する前の場所
 */

const VERSION = "1";

interface Statement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}
export interface MaterialsSqlite {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}
type SqliteModule = { DatabaseSync: new (file: string, opts?: { readOnly?: boolean }) => MaterialsSqlite };
const sqlite = (): SqliteModule => (process as unknown as { getBuiltinModule(id: string): SqliteModule }).getBuiltinModule("node:sqlite");

export function materialsPath(): string | null {
  const env = process.env.ICHIJOYA_MATERIALS_DB_PATH?.trim();
  if (env === "off") return null;
  if (env) return env;
  const supabase = process.env.DATA_BACKEND !== "json" && Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY));
  if (supabase && fs.existsSync("/srv/ichijoya")) return "/srv/ichijoya/data/database/ichijoya-materials.sqlite";
  return path.join(process.cwd(), "data", "database", "ichijoya-materials.sqlite");
}

const SCHEMA = `
create table if not exists _meta (key text primary key, value text);
create table if not exists docs (
  id text primary key,
  origin text not null,
  folder text, folder_label text,
  path text not null, name text not null, ext text, kind text,
  bytes integer, mtime text, sha1 text, duplicate_of text,
  rule_id text, rule_key text, action text not null, category text, visibility text not null, note text, imported_to text,
  store_id text, record_date text,
  status text not null, error text,
  chars integer not null default 0, sections integer not null default 0,
  sheet_names text, pii text, summary text,
  o_action text, o_visibility text, o_category text, o_note text, o_by text, o_at text,
  knowledge_ids text, storage_key text, drive_url text, orig_path text,
  scanned_at text, updated_at text
);
create index if not exists docs_folder on docs (folder);
create index if not exists docs_sha1 on docs (sha1);
create table if not exists chunks (
  id text primary key,
  doc_id text not null,
  seq integer not null,
  section text,
  part integer not null default 1,
  parts integer not null default 1,
  visibility text not null,
  category text,
  knowledge integer not null default 0,
  record_date text,
  head text not null,
  body text not null,
  chars integer not null
);
create index if not exists chunks_doc on chunks (doc_id, seq);
create virtual table if not exists chunks_fts using fts5 (head, body, content = 'chunks', content_rowid = 'rowid', tokenize = 'trigram');
create trigger if not exists chunks_ai after insert on chunks begin insert into chunks_fts (rowid, head, body) values (new.rowid, new.head, new.body); end;
create trigger if not exists chunks_ad after delete on chunks begin insert into chunks_fts (chunks_fts, rowid, head, body) values ('delete', old.rowid, old.head, old.body); end;
create table if not exists runs (id text primary key, at text not null, by text, kind text not null, summary text);
`;

const g = globalThis as typeof globalThis & { __ichijoyaMaterials?: { file: string; db: MaterialsSqlite } };

/** 資料庫を開く (なければ作る)。止めているとき・開けないときは null */
export function openMaterials(file = materialsPath()): MaterialsSqlite | null {
  if (!file) return null;
  if (g.__ichijoyaMaterials?.file === file) return g.__ichijoyaMaterials.db;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new (sqlite().DatabaseSync)(file);
    db.exec("pragma journal_mode = wal; pragma synchronous = normal; pragma busy_timeout = 5000;");
    db.exec(SCHEMA);
    // 列を足したとき (古いファイル) の追加
    const cols = new Set(db.prepare("pragma table_info(docs)").all().map((r) => String(r.name)));
    if (!cols.has("rule_key")) db.exec("alter table docs add column rule_key text");
    if (!cols.has("orig_path")) db.exec("alter table docs add column orig_path text");
    db.prepare("insert into _meta (key, value) values ('version', ?) on conflict (key) do update set value = excluded.value").run(VERSION);
    g.__ichijoyaMaterials?.db.close();
    g.__ichijoyaMaterials = { file, db };
    return db;
  } catch (err) {
    console.warn("[materials] cannot open:", (err as Error).message);
    return null;
  }
}

/** 閉じる (スクリプト・テストの終わり) */
export function closeMaterials(): void {
  g.__ichijoyaMaterials?.db.close();
  g.__ichijoyaMaterials = undefined;
}

/* ================================================================== */
/* 型                                                                   */
/* ================================================================== */

export interface MaterialDoc {
  id: string;
  /** client = クライアント資料 (source/) / upload = 画面から追加 */
  origin: "client" | "upload";
  folder: string;
  folderLabel: string;
  path: string;
  name: string;
  ext: string;
  kind: string;
  bytes?: number;
  mtime?: string;
  sha1?: string;
  /** 同じ中身のファイルが先に登録されているとき、その ID (中身は先のほうにだけ持つ) */
  duplicateOf?: string;
  ruleId?: string;
  /** 分類の指紋 (classify.ts の classificationKey。規則を変えたら読み直す) */
  ruleKey?: string;
  action: RegistryAction;
  category: string;
  visibility: KnowledgeVisibility;
  note?: string;
  importedTo?: string;
  storeId?: StoreId;
  recordDate?: string;
  /** ok = 文字あり / empty = 文字なし (写真・画像の PDF) / error = 読めない / skipped = 取り込まない */
  status: "ok" | "empty" | "error" | "skipped";
  error?: string;
  chars: number;
  sections: number;
  sheetNames: { name: string; kept: boolean; rows?: number }[];
  pii?: { phones: number; emails: number; postal: number; markers: string[]; reason?: string; /** 伏せた ID・パスワードなどの数 */ secrets?: number };
  summary?: string;
  /** 人が画面で変えた扱い (読み直しても残す) */
  override?: { action?: RegistryAction; visibility?: KnowledgeVisibility; category?: string; note?: string; by?: string; at?: string };
  knowledgeIds: string[];
  storageKey?: string;
  driveUrl?: string;
  /** 整理する前の場所 (other/client-materials からの相対。../ は other 直下)。あとから追加した資料・画面から追加した資料はなし */
  originalPath?: string;
  scannedAt?: string;
  updatedAt?: string;
}

export interface MaterialChunk {
  id: string;
  docId: string;
  seq: number;
  section: string;
  part: number;
  parts: number;
  visibility: KnowledgeVisibility;
  category: string;
  /** 社内資料に登録する節 */
  knowledge: boolean;
  recordDate?: string;
  head: string;
  body: string;
}

/** 実際の扱い (人が変えたものを優先) */
export const effAction = (d: Pick<MaterialDoc, "action" | "override">): RegistryAction => d.override?.action ?? d.action;
export const effVisibility = (d: Pick<MaterialDoc, "visibility" | "override">): KnowledgeVisibility => d.override?.visibility ?? d.visibility;
export const effCategory = (d: Pick<MaterialDoc, "category" | "override">): string => d.override?.category ?? d.category;

const j = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));
const pj = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== "string" || !v) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};
const s = (v: unknown) => (v === null || v === undefined ? undefined : String(v));
const escapeLike = (t: string) => t.replace(/[\\%_]/g, (c) => `\\${c}`);

function rowToDoc(r: Record<string, unknown>): MaterialDoc {
  const override = r.o_action || r.o_visibility || r.o_category || r.o_note ? { action: s(r.o_action) as RegistryAction | undefined, visibility: s(r.o_visibility) as KnowledgeVisibility | undefined, category: s(r.o_category), note: s(r.o_note), by: s(r.o_by), at: s(r.o_at) } : undefined;
  return {
    id: String(r.id),
    origin: String(r.origin) as MaterialDoc["origin"],
    folder: String(r.folder ?? ""),
    folderLabel: String(r.folder_label ?? ""),
    path: String(r.path),
    name: String(r.name),
    ext: String(r.ext ?? ""),
    kind: String(r.kind ?? ""),
    bytes: r.bytes === null || r.bytes === undefined ? undefined : Number(r.bytes),
    mtime: s(r.mtime),
    sha1: s(r.sha1),
    duplicateOf: s(r.duplicate_of),
    ruleId: s(r.rule_id),
    ruleKey: s(r.rule_key),
    action: String(r.action) as RegistryAction,
    category: String(r.category ?? "その他"),
    visibility: String(r.visibility) as KnowledgeVisibility,
    note: s(r.note),
    importedTo: s(r.imported_to),
    storeId: s(r.store_id) as StoreId | undefined,
    recordDate: s(r.record_date),
    status: String(r.status) as MaterialDoc["status"],
    error: s(r.error),
    chars: Number(r.chars ?? 0),
    sections: Number(r.sections ?? 0),
    sheetNames: pj(r.sheet_names, []),
    pii: pj(r.pii, undefined),
    summary: s(r.summary),
    override,
    knowledgeIds: pj(r.knowledge_ids, []),
    storageKey: s(r.storage_key),
    driveUrl: s(r.drive_url),
    originalPath: s(r.orig_path),
    scannedAt: s(r.scanned_at),
    updatedAt: s(r.updated_at),
  };
}

function rowToChunk(r: Record<string, unknown>): MaterialChunk {
  return {
    id: String(r.id),
    docId: String(r.doc_id),
    seq: Number(r.seq),
    section: String(r.section ?? ""),
    part: Number(r.part ?? 1),
    parts: Number(r.parts ?? 1),
    visibility: String(r.visibility) as KnowledgeVisibility,
    category: String(r.category ?? ""),
    knowledge: Number(r.knowledge) === 1,
    recordDate: s(r.record_date),
    head: String(r.head),
    body: String(r.body),
  };
}

/* ================================================================== */
/* 書き込み                                                              */
/* ================================================================== */

/**
 * 1 件の資料を入れ替える (中身・分類)。人が画面で変えた扱い・社内資料の ID・保存先は残す。
 * 中身が同じ (sha1・規則が同じ) で読み直す必要がないときは呼び出し側で省く
 */
export function upsertDoc(db: MaterialsSqlite, doc: Omit<MaterialDoc, "override" | "knowledgeIds"> & { knowledgeIds?: string[] }, chunks: Omit<MaterialChunk, "docId">[]): void {
  const prev = db.prepare("select knowledge_ids, storage_key from docs where id = ?").get(doc.id);
  const now = new Date().toISOString();
  db.exec("begin");
  try {
    db.prepare(
      `insert into docs (id, origin, folder, folder_label, path, name, ext, kind, bytes, mtime, sha1, duplicate_of, rule_id, rule_key, action, category, visibility, note, imported_to,
        store_id, record_date, status, error, chars, sections, sheet_names, pii, summary, knowledge_ids, storage_key, drive_url, orig_path, scanned_at, updated_at)
       values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       on conflict (id) do update set origin = excluded.origin, folder = excluded.folder, folder_label = excluded.folder_label, path = excluded.path, name = excluded.name,
        ext = excluded.ext, kind = excluded.kind, bytes = excluded.bytes, mtime = excluded.mtime, sha1 = excluded.sha1, duplicate_of = excluded.duplicate_of,
        rule_id = excluded.rule_id, rule_key = excluded.rule_key, action = excluded.action, category = excluded.category, visibility = excluded.visibility, note = excluded.note, imported_to = excluded.imported_to,
        store_id = excluded.store_id, record_date = excluded.record_date, status = excluded.status, error = excluded.error, chars = excluded.chars, sections = excluded.sections,
        sheet_names = excluded.sheet_names, pii = excluded.pii, summary = excluded.summary, drive_url = coalesce(excluded.drive_url, docs.drive_url),
        storage_key = coalesce(excluded.storage_key, docs.storage_key), orig_path = excluded.orig_path, scanned_at = excluded.scanned_at, updated_at = excluded.updated_at`,
    ).run(
      doc.id,
      doc.origin,
      doc.folder,
      doc.folderLabel,
      doc.path,
      doc.name,
      doc.ext,
      doc.kind,
      doc.bytes ?? null,
      doc.mtime ?? null,
      doc.sha1 ?? null,
      doc.duplicateOf ?? null,
      doc.ruleId ?? null,
      doc.ruleKey ?? null,
      doc.action,
      doc.category,
      doc.visibility,
      doc.note ?? null,
      doc.importedTo ?? null,
      doc.storeId ?? null,
      doc.recordDate ?? null,
      doc.status,
      doc.error ?? null,
      doc.chars,
      doc.sections,
      j(doc.sheetNames),
      j(doc.pii),
      doc.summary ?? null,
      prev ? (prev.knowledge_ids as string | null) : j(doc.knowledgeIds ?? []),
      doc.storageKey ?? (prev?.storage_key as string | null) ?? null,
      doc.driveUrl ?? null,
      doc.originalPath ?? null,
      doc.scannedAt ?? now,
      now,
    );
    db.prepare("delete from chunks where doc_id = ?").run(doc.id);
    const ins = db.prepare("insert into chunks (id, doc_id, seq, section, part, parts, visibility, category, knowledge, record_date, head, body, chars) values (?,?,?,?,?,?,?,?,?,?,?,?,?)");
    for (const c of chunks) ins.run(c.id, doc.id, c.seq, c.section, c.part, c.parts, c.visibility, c.category, c.knowledge ? 1 : 0, c.recordDate ?? null, c.head, c.body, c.body.length);
    db.exec("commit");
  } catch (err) {
    db.exec("rollback");
    throw err;
  }
}

/** 人が画面で変える扱い (null で元に戻す)。exclude にしたときは中身を消す */
export function setOverride(db: MaterialsSqlite, id: string, o: { action?: RegistryAction | null; visibility?: KnowledgeVisibility | null; category?: string | null; note?: string | null }, by: string): void {
  const cur = db.prepare("select * from docs where id = ?").get(id);
  if (!cur) throw new Error("資料が見つかりません。");
  const pick = (k: keyof typeof o, col: string) => (o[k] === undefined ? (cur[col] as string | null) : o[k]);
  db.prepare("update docs set o_action = ?, o_visibility = ?, o_category = ?, o_note = ?, o_by = ?, o_at = ?, updated_at = ? where id = ?").run(
    pick("action", "o_action"),
    pick("visibility", "o_visibility"),
    pick("category", "o_category"),
    pick("note", "o_note"),
    by,
    new Date().toISOString(),
    new Date().toISOString(),
    id,
  );
  if (o.action === "exclude") db.prepare("delete from chunks where doc_id = ?").run(id);
}

export function setKnowledgeIds(db: MaterialsSqlite, id: string, ids: string[]): void {
  db.prepare("update docs set knowledge_ids = ?, updated_at = ? where id = ?").run(JSON.stringify(ids), new Date().toISOString(), id);
}

export function deleteDoc(db: MaterialsSqlite, id: string): void {
  db.exec("begin");
  try {
    db.prepare("delete from chunks where doc_id = ?").run(id);
    db.prepare("delete from docs where id = ?").run(id);
    db.exec("commit");
  } catch (err) {
    db.exec("rollback");
    throw err;
  }
}

export function addRun(db: MaterialsSqlite, run: { kind: string; by?: string; summary: Record<string, unknown> }): void {
  db.prepare("insert into runs (id, at, by, kind, summary) values (?,?,?,?,?)").run(`run_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, new Date().toISOString(), run.by ?? null, run.kind, JSON.stringify(run.summary));
}

/* ================================================================== */
/* 読み取り                                                              */
/* ================================================================== */

export function getDoc(db: MaterialsSqlite, id: string): MaterialDoc | undefined {
  const r = db.prepare("select * from docs where id = ?").get(id);
  return r ? rowToDoc(r) : undefined;
}

export function docBySha1(db: MaterialsSqlite, sha1: string, exceptId?: string): MaterialDoc | undefined {
  const r = db.prepare("select * from docs where sha1 = ? and id != ? and duplicate_of is null order by id limit 1").get(sha1, exceptId ?? "");
  return r ? rowToDoc(r) : undefined;
}

export function getChunks(db: MaterialsSqlite, docId: string): MaterialChunk[] {
  return db.prepare("select * from chunks where doc_id = ? order by seq").all(docId).map(rowToChunk);
}

export function getChunk(db: MaterialsSqlite, id: string): MaterialChunk | undefined {
  const r = db.prepare("select * from chunks where id = ?").get(id);
  return r ? rowToChunk(r) : undefined;
}

export interface DocFilter {
  folder?: string;
  action?: RegistryAction;
  category?: string;
  status?: MaterialDoc["status"];
  visibility?: KnowledgeVisibility;
  origin?: MaterialDoc["origin"];
  q?: string;
  /** 見られる人の範囲 (この中の見られる人の資料だけ) */
  visibilities?: KnowledgeVisibility[];
  limit?: number;
  offset?: number;
}

export function listDocs(db: MaterialsSqlite, f: DocFilter = {}): { rows: MaterialDoc[]; total: number } {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.folder) {
    where.push("folder = ?");
    args.push(f.folder);
  }
  if (f.action) {
    where.push("coalesce(o_action, action) = ?");
    args.push(f.action);
  }
  if (f.category) {
    where.push("coalesce(o_category, category) = ?");
    args.push(f.category);
  }
  if (f.status) {
    where.push("status = ?");
    args.push(f.status);
  }
  if (f.visibility) {
    where.push("coalesce(o_visibility, visibility) = ?");
    args.push(f.visibility);
  }
  if (f.origin) {
    where.push("origin = ?");
    args.push(f.origin);
  }
  if (f.visibilities) {
    where.push(`coalesce(o_visibility, visibility) in (${f.visibilities.map(() => "?").join(",") || "''"})`);
    args.push(...f.visibilities);
  }
  if (f.q?.trim()) {
    // 場所は source/ の先頭の階層 + その中の場所と、整理する前の場所 (古い場所の名前でも探せる)
    where.push("((folder || '/' || path) like ? escape '\\' or orig_path like ? escape '\\' or summary like ? escape '\\' or note like ? escape '\\' or category like ? escape '\\')");
    const like = `%${escapeLike(f.q.trim())}%`;
    args.push(like, like, like, like, like);
  }
  const w = where.length ? `where ${where.join(" and ")}` : "";
  const total = Number(db.prepare(`select count(*) n from docs ${w}`).get(...args)?.n ?? 0);
  const rows = db
    .prepare(`select * from docs ${w} order by folder, path limit ${Math.max(1, Math.min(1000, f.limit ?? 100))} offset ${Math.max(0, f.offset ?? 0)}`)
    .all(...args)
    .map(rowToDoc);
  return { rows, total };
}

export interface MaterialsStats {
  docs: number;
  chunks: number;
  chars: number;
  bytes: number;
  byAction: Record<string, number>;
  byStatus: Record<string, number>;
  byCategory: { category: string; docs: number; chars: number }[];
  byFolder: { folder: string; label: string; docs: number; ok: number; chars: number }[];
  knowledgeSections: number;
  duplicates: number;
  lastScan?: { at: string; kind: string; summary: Record<string, unknown> };
  fileBytes?: number;
}

export function materialsStats(db: MaterialsSqlite, file = materialsPath()): MaterialsStats {
  const one = (sql: string) => db.prepare(sql).get() ?? {};
  const totals = one("select count(*) docs, coalesce(sum(chars),0) chars, coalesce(sum(bytes),0) bytes, sum(duplicate_of is not null) dups from docs");
  const byAction = Object.fromEntries(db.prepare("select coalesce(o_action, action) a, count(*) n from docs group by 1").all().map((r) => [String(r.a), Number(r.n)]));
  const byStatus = Object.fromEntries(db.prepare("select status s, count(*) n from docs group by 1").all().map((r) => [String(r.s), Number(r.n)]));
  const byCategory = db
    .prepare("select coalesce(o_category, category) c, count(*) n, coalesce(sum(chars),0) ch from docs group by 1 order by n desc")
    .all()
    .map((r) => ({ category: String(r.c), docs: Number(r.n), chars: Number(r.ch) }));
  const byFolder = db
    .prepare("select folder f, max(folder_label) l, count(*) n, sum(status = 'ok') ok, coalesce(sum(chars),0) ch from docs group by 1 order by 1")
    .all()
    .map((r) => ({ folder: String(r.f), label: String(r.l ?? ""), docs: Number(r.n), ok: Number(r.ok ?? 0), chars: Number(r.ch) }));
  const run = db.prepare("select * from runs order by at desc limit 1").get();
  let fileBytes: number | undefined;
  try {
    if (file) fileBytes = fs.statSync(file).size + (fs.existsSync(`${file}-wal`) ? fs.statSync(`${file}-wal`).size : 0);
  } catch {
    /* なし */
  }
  return {
    docs: Number(totals.docs ?? 0),
    chunks: Number(one("select count(*) n from chunks").n ?? 0),
    chars: Number(totals.chars ?? 0),
    bytes: Number(totals.bytes ?? 0),
    byAction,
    byStatus,
    byCategory,
    byFolder,
    knowledgeSections: Number(one("select count(*) n from chunks where knowledge = 1").n ?? 0),
    duplicates: Number(totals.dups ?? 0),
    lastScan: run ? { at: String(run.at), kind: String(run.kind), summary: pj(run.summary, {}) } : undefined,
    fileBytes,
  };
}

export function recentRuns(db: MaterialsSqlite, limit = 20): { id: string; at: string; by?: string; kind: string; summary: Record<string, unknown> }[] {
  return db
    .prepare("select * from runs order by at desc limit ?")
    .all(limit)
    .map((r) => ({ id: String(r.id), at: String(r.at), by: s(r.by), kind: String(r.kind), summary: pj(r.summary, {}) }));
}

/* ================================================================== */
/* 検索                                                                  */
/* ================================================================== */

const PARTICLES = /(?:について|に関して|とは|ですか|ますか|ください|教えて|知りたい|どこ|どう|なに|何|いつ|だれ|誰|[のをはがにでとやもへ、。,.?？!！「」『』()（）\s　])+/;

/** 検索の言葉に分ける (空白・助詞・記号で区切る。1 文字の言葉は落とす。ただし漢字 1 文字は残す) */
export function searchTerms(query: string): string[] {
  const parts = query.normalize("NFKC").split(PARTICLES).map((t) => t.trim()).filter(Boolean);
  const out = new Set<string>();
  for (const p of parts) {
    if ([...p].length >= 2 || /^[一-鿿]$/.test(p)) out.add(p.toLowerCase());
  }
  return [...out].slice(0, 12);
}

export interface MaterialHit {
  chunk: MaterialChunk;
  doc: MaterialDoc;
  score: number;
  matched: string[];
  snippet: string;
}

function snippetAround(body: string, terms: string[], size = 300): string {
  const flat = body.replace(/\s*\n\s*/g, " / ");
  const low = flat.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = low.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0 || flat.length <= size) return flat.slice(0, size);
  const start = Math.max(0, at - 60);
  return `${start > 0 ? "…" : ""}${flat.slice(start, start + size)}${start + size < flat.length ? "…" : ""}`;
}

/**
 * 資料の全文検索。3 文字以上の言葉は全文索引、2 文字以下は部分一致で候補を取り、
 * 当たった言葉の数・見出しに当たったか・社内資料に登録した節か で並べる
 */
export function searchMaterials(
  db: MaterialsSqlite,
  query: string,
  opts: { visibilities: KnowledgeVisibility[]; limit?: number; category?: string; folder?: string; storeId?: StoreId; docId?: string },
): MaterialHit[] {
  const terms = searchTerms(query);
  if (!terms.length) return [];
  const long = terms.filter((t) => [...t].length >= 3);
  const short = terms.filter((t) => [...t].length < 3);
  // 候補: 全文索引は関連の強い順 (bm25。言葉が多く当たるものが上) に、部分一致は見出しに当たるものを先に、それぞれ上限まで
  const filters: string[] = ["coalesce(d.o_action, d.action) != 'exclude'"];
  const fargs: unknown[] = [];
  filters.push(`(case when d.o_visibility is not null then d.o_visibility else c.visibility end) in (${opts.visibilities.map(() => "?").join(",") || "''"})`);
  fargs.push(...opts.visibilities);
  if (opts.category) {
    filters.push("coalesce(d.o_category, c.category, d.category) = ?");
    fargs.push(opts.category);
  }
  if (opts.folder) {
    filters.push("d.folder = ?");
    fargs.push(opts.folder);
  }
  if (opts.storeId) {
    filters.push("(d.store_id = ? or d.store_id is null)");
    fargs.push(opts.storeId);
  }
  if (opts.docId) {
    filters.push("d.id = ?");
    fargs.push(opts.docId);
  }
  const where = filters.join(" and ");
  const seenRow = new Set<number>();
  const rows: Record<string, unknown>[] = [];
  const take = (list: Record<string, unknown>[]) => {
    for (const r of list) {
      const id = Number(r.rid);
      if (seenRow.has(id)) continue;
      seenRow.add(id);
      rows.push(r);
    }
  };
  if (long.length) {
    const match = long.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
    take(db.prepare(`select c.rowid rid, c.* from chunks_fts f join chunks c on c.rowid = f.rowid join docs d on d.id = c.doc_id where chunks_fts match ? and ${where} order by bm25(chunks_fts, 4.0, 1.0) limit 300`).all(match, ...fargs));
  }
  for (const t of short) {
    const like = `%${escapeLike(t)}%`;
    take(db.prepare(`select c.rowid rid, c.* from chunks c join docs d on d.id = c.doc_id where (c.head like ? escape '\\' or c.body like ? escape '\\') and ${where} order by (c.head like ? escape '\\') desc limit 200`).all(like, like, ...fargs, like));
  }
  const docCache = new Map<string, MaterialDoc | undefined>();
  const hits: MaterialHit[] = [];
  for (const r of rows) {
    const chunk = rowToChunk(r);
    const headL = chunk.head.toLowerCase();
    const bodyL = chunk.body.toLowerCase();
    let score = 0;
    const matched: string[] = [];
    for (const t of terms) {
      const inHead = headL.includes(t);
      let n = 0;
      for (let i = bodyL.indexOf(t); i >= 0 && n < 6; i = bodyL.indexOf(t, i + t.length)) n++;
      if (!inHead && !n) continue;
      matched.push(t);
      const w = Math.min(4, [...t].length);
      score += w * ((inHead ? 3 : 0) + Math.log2(1 + n));
    }
    if (!matched.length) continue;
    // 言葉が多く当たるほど上 (1 つしか当たらないものは下げる)
    score *= matched.length / terms.length + 0.25;
    if (chunk.knowledge) score *= 1.2;
    if (!docCache.has(chunk.docId)) docCache.set(chunk.docId, getDoc(db, chunk.docId));
    const doc = docCache.get(chunk.docId);
    if (!doc) continue;
    hits.push({ chunk, doc, score, matched, snippet: snippetAround(chunk.body, matched) });
  }
  hits.sort((a, b) => b.score - a.score);
  // 同じ資料の節ばかりにならないように、1 つの資料から最大 3 節
  const per = new Map<string, number>();
  const out: MaterialHit[] = [];
  for (const h of hits) {
    const n = per.get(h.doc.id) ?? 0;
    if (n >= 3) continue;
    per.set(h.doc.id, n + 1);
    out.push(h);
    if (out.length >= (opts.limit ?? 8)) break;
  }
  return out;
}

/** 見られる人の範囲 (permissions.ts の canViewKnowledge と同じ) */
export function visibilitiesFor(role: string): KnowledgeVisibility[] {
  switch (role) {
    case "admin":
      return ["all", "manager", "hq", "admin"];
    case "hq_staff":
      return ["all", "manager", "hq"];
    case "store_manager":
      return ["all", "manager"];
    default:
      return ["all"];
  }
}
