import "server-only";
import fs from "node:fs";
import path from "node:path";
import type { AuditAction, AuditChange, Database, StoreId } from "./types";
import { createSeed } from "./seed";
import { migrateDb } from "./migrate";
import { TABLES } from "./schema";
import { bumpRevision, currentRevision, loadFromSupabase, supabaseConfigured, writeToSupabase, type Changes } from "./supabase";

/**
 * データストア
 * ------------------------------------------------------------
 * 画面と業務ロジックは同じインターフェイス (getDb / mutate) で読み書きし、保存先だけを差し替える。
 *
 * - supabase: 本番データ (NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SECRET_KEY が設定されている場合)。
 *   起動時に全テーブルをメモリに読み込み、mutate() の変更分だけを Supabase へ書き込む。
 *   他のインスタンスが書き込んだときは、syncDb() がリビジョンの変化を検知して読み直す
 * - json: ローカル検証用 (data/<DATA_FILE_NAME>)。ファイルがなければサンプルデータを生成する
 *
 * mutate() は 1 件ずつ順番に実行し、途中で失敗 (権限エラーなどの redirect を含む) したときは
 * メモリ上の変更を元に戻す。Supabase への書き込みが途中で失敗したときは、一部の行だけが書き込まれている
 * 可能性があるため、リビジョンを進めて全インスタンス (自分を含む) に読み直させる。
 * (複数テーブルをまとめたトランザクション化は次の段階で SQL 関数に移す)
 */

export type Backend = "supabase" | "json";
export const BACKEND: Backend = process.env.DATA_BACKEND === "json" ? "json" : supabaseConfigured() ? "supabase" : "json";

const DATA_FILE = path.join(process.cwd(), "data", process.env.DATA_FILE_NAME ?? "db.json");
/** 他インスタンスの書き込みを確かめる間隔 (ミリ秒) */
const CHECK_INTERVAL = 2000;

type Entity = { id: string } & Record<string, unknown>;
interface RowCache {
  ids: string[];
  json: Map<string, string>;
}

interface StoreState {
  db?: Database;
  cache?: Map<string, RowCache>;
  revision: number;
  checkedAt: number;
  loading?: Promise<void>;
  queue: Promise<unknown>;
}

const g = globalThis as typeof globalThis & { __ichijoyaStore?: StoreState };
const state: StoreState = (g.__ichijoyaStore ??= { revision: 0, checkedAt: 0, queue: Promise.resolve() });

const COLLECTIONS = TABLES.map((t) => t.collection);

function collection(db: Database, name: string): Entity[] {
  return (db as unknown as Record<string, Entity[]>)[name] ?? [];
}

function buildCache(db: Database): Map<string, RowCache> {
  const cache = new Map<string, RowCache>();
  for (const name of COLLECTIONS) {
    const rows = collection(db, name);
    cache.set(name, { ids: rows.map((r) => r.id), json: new Map(rows.map((r) => [r.id, JSON.stringify(r)])) });
  }
  return cache;
}

function install(db: Database, revision: number) {
  state.db = migrateDb(db);
  state.cache = buildCache(state.db);
  state.revision = revision;
  state.checkedAt = Date.now();
}

/* ---------------- json ---------------- */

function loadJson(): Database {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) as Database;
      if (parsed && parsed.meta && Array.isArray(parsed.customers)) {
        const before = parsed.meta.version;
        const db = migrateDb(parsed);
        if (db.meta.version !== before) persistJson(db);
        return db;
      }
    }
  } catch (err) {
    console.warn("[db] failed to read data file, reseeding:", err);
  }
  const db = createSeed(new Date());
  persistJson(db);
  return db;
}

function persistJson(db: Database) {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = `${DATA_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db), "utf8");
    fs.renameSync(tmp, DATA_FILE);
  } catch (err) {
    // 読み取り専用ファイルシステムなどではメモリ上のみで動作する
    console.warn("[db] persist skipped:", (err as Error).message);
  }
}

/* ---------------- 読み込み ---------------- */

async function loadSupabase() {
  const started = Date.now();
  const { db, revision } = await loadFromSupabase();
  install(db, revision);
  const rows = COLLECTIONS.reduce((a, c) => a + collection(state.db!, c).length, 0);
  console.info(`[db] loaded ${rows} rows from Supabase in ${Date.now() - started}ms (revision ${revision})`);
}

/**
 * データを最新にする。ページ・Server Action の先頭 (requireUser / requireActionUser) で呼ばれる。
 * Supabase の場合は初回に全件を読み込み、以降は他インスタンスの書き込みがあったときだけ読み直す。
 */
export function syncDb(): Promise<Database> {
  return sync(false);
}

/** inQueue: mutate() の中から呼ぶとき (自分自身の完了を待たないようにする) */
async function sync(inQueue: boolean): Promise<Database> {
  if (BACKEND === "json") return getDb();
  if (!state.db) {
    state.loading ??= loadSupabase().finally(() => (state.loading = undefined));
    await state.loading;
    return state.db!;
  }
  if (Date.now() - state.checkedAt > CHECK_INTERVAL) {
    state.checkedAt = Date.now();
    try {
      const rev = await currentRevision();
      if (rev !== state.revision) {
        if (!inQueue) await state.queue; // 書き込み中のものが終わるのを待ってから
        if (rev !== state.revision) {
          state.loading ??= loadSupabase().finally(() => (state.loading = undefined));
          await state.loading;
        }
      }
    } catch (err) {
      console.warn("[db] revision check failed:", (err as Error).message);
    }
  }
  return state.db;
}

export function getDb(): Database {
  if (!state.db) {
    if (BACKEND === "json") install(loadJson(), 0);
    else throw new Error("データベースを読み込んでいません。syncDb() を先に呼び出してください。");
  }
  return state.db!;
}

/* ---------------- 書き込み ---------------- */

function diff(db: Database): Changes & { next: Map<string, RowCache>; count: number } {
  const upserts = new Map<string, Entity[]>();
  const deletes = new Map<string, string[]>();
  const next = new Map<string, RowCache>();
  let count = 0;
  for (const name of COLLECTIONS) {
    const prev = state.cache!.get(name) ?? { ids: [], json: new Map() };
    const rows = collection(db, name);
    const json = new Map<string, string>();
    const changed: Entity[] = [];
    for (const r of rows) {
      const s = JSON.stringify(r);
      json.set(r.id, s);
      if (prev.json.get(r.id) !== s) changed.push(r);
    }
    const removed = prev.ids.filter((id) => !json.has(id));
    if (changed.length) upserts.set(name, changed);
    if (removed.length) deletes.set(name, removed);
    count += changed.length + removed.length;
    next.set(name, { ids: rows.map((r) => r.id), json });
  }
  return { upserts, deletes, next, count };
}

/** 前回保存した状態へ戻す (mutate の途中で失敗したとき) */
function rollback(db: Database) {
  const all = db as unknown as Record<string, Entity[]>;
  for (const name of COLLECTIONS) {
    const prev = state.cache!.get(name);
    if (prev) all[name] = prev.ids.map((id) => JSON.parse(prev.json.get(id)!) as Entity);
  }
}

/** 変更を適用して保存する (1 件ずつ順番に実行) */
export function mutate<T>(fn: (db: Database) => T): Promise<T> {
  const run = async (): Promise<T> => {
    const db = BACKEND === "json" ? getDb() : await sync(true);
    let result: T;
    try {
      result = fn(db);
    } catch (err) {
      rollback(db);
      throw err;
    }
    const changes = diff(db);
    if (changes.count === 0) return result;
    if (BACKEND === "json") {
      persistJson(db);
    } else {
      try {
        const before = state.revision;
        const rev = await writeToSupabase(changes);
        // 自分の書き込みの直前に他のインスタンスが書き込んでいた (リビジョンが 2 以上進んだ) ときは、
        // その変更を取りこぼさないよう次の syncDb() で読み直す
        state.revision = rev === before + 1 ? rev : -1;
        if (state.revision === -1) state.checkedAt = 0;
      } catch (err) {
        rollback(db);
        console.error("[db] write failed:", err);
        // 書き込めた行とメモリが食い違わないよう、次の syncDb() でデータベースから読み直す
        state.revision = -1;
        state.checkedAt = 0;
        await bumpRevision().catch(() => undefined);
        throw new Error("データベースへの保存に失敗しました。時間をおいて再度お試しください。");
      }
    }
    state.cache = changes.next;
    return result;
  };
  const p = state.queue.then(run, run);
  state.queue = p.catch(() => undefined);
  return p;
}

/** サンプルデータを再生成する (ローカル検証用の json のみ。本番データでは使えない) */
export function resetDb(): Database {
  if (BACKEND !== "json") throw new Error("本番データベースでは初期化できません。");
  const db = createSeed(new Date());
  install(db, 0);
  persistJson(db);
  return db;
}

let idCounter = 0;
export function newId(prefix: string): string {
  idCounter += 1;
  const rnd = Math.random().toString(36).slice(2, 6);
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${rnd}`;
}

/** 連番 (例: Q-2026-0071) */
export function nextNumber(db: Database, prefix: string, collection: { number: string }[], dateKey: string): string {
  const year = dateKey.slice(0, 4);
  const head = `${prefix}-${year}-`;
  const max = collection
    .filter((x) => x.number.startsWith(head))
    .reduce((m, x) => Math.max(m, Number(x.number.slice(head.length)) || 0), 0);
  return `${head}${String(max + 1).padStart(4, "0")}`;
}

/** 顧客コード (例: C-11591)。削除があっても重複しないよう、既存の最大値 + 1 にする */
export function nextCustomerCode(db: Database): string {
  const max = db.customers.reduce((m, c) => Math.max(m, Number(/^C-(\d+)$/.exec(c.code)?.[1] ?? 0)), 0);
  return `C-${String(max + 1).padStart(5, "0")}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function addAudit(
  db: Database,
  entry: {
    userId: string;
    action: AuditAction;
    entity: string;
    entityId: string;
    entityLabel: string;
    summary: string;
    storeId?: StoreId;
    changes?: AuditChange[];
  },
) {
  db.auditLogs.push({ id: newId("log"), at: nowIso(), ...entry });
}

/** 2 つのオブジェクトの差分 (監査ログ用) */
export function diffChanges<T extends object>(before: T, after: T, fields: (keyof T)[]): AuditChange[] {
  const changes: AuditChange[] = [];
  for (const f of fields) {
    const b = before[f];
    const a = after[f];
    if (JSON.stringify(b) !== JSON.stringify(a)) {
      changes.push({ field: String(f), before: b, after: a });
    }
  }
  return changes;
}
