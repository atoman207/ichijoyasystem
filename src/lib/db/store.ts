import "server-only";
import fs from "node:fs";
import path from "node:path";
import type { AuditAction, AuditChange, Database, StoreId } from "./types";
import { createSeed } from "./seed";
import { migrateDb } from "./migrate";
import { TABLES } from "./schema";
import { readSnapshot, schemaHash, snapshotEnabled, writeSnapshot } from "./snapshot";
import {
  bumpRevision,
  changeLoggedAt,
  collectionOfTable,
  currentRevision,
  fetchChanges,
  fetchCollection,
  fetchRowsByIds,
  loadFromSupabase,
  recordChanges,
  supabaseConfigured,
  writeToSupabase,
  type Changes,
} from "./supabase";

/**
 * データストア
 * ------------------------------------------------------------
 * 画面と業務ロジックは同じインターフェイス (getDb / mutate) で読み書きし、保存先だけを差し替える。
 *
 * - supabase: 本番データ (NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SECRET_KEY が設定されている場合)。
 *   データはメモリに持ち、mutate() の変更分だけを Supabase へ書き込む (変わった行の ID を app_changes に記録)。
 *   Supabase の負荷を減らすため、全件 (約 10 万行) を読むのはできるだけ避ける:
 *   - 他のインスタンス (3000 番と 3001 番など) が書き込んだときは、syncDb() がリビジョンの変化を検知し、
 *     変更の記録から「変わった行だけ」を取り直す (catchUp)。記録に抜けがあるときだけ全件を読み直す
 *   - 起動時は、このサーバーに保存した控え (snapshot.ts) から読み、そのあとの変更だけを取り直す
 * - json: ローカル検証用 (data/<DATA_FILE_NAME>)。ファイルがなければサンプルデータを生成する
 *
 * mutate() と取り直し (catchUp・全件の読み直し) は 1 件ずつ順番に実行する (state.queue)。
 * mutate() が途中で失敗 (権限エラーなどの redirect を含む) したときはメモリ上の変更を元に戻す。
 * Supabase への書き込みが途中で失敗したときは、一部の行だけが書き込まれている可能性があるため、
 * 書き込もうとした行を変更の記録に残し、全インスタンス (自分を含む) にその行を取り直させる。
 */

export type Backend = "supabase" | "json";
export const BACKEND: Backend = process.env.DATA_BACKEND === "json" ? "json" : supabaseConfigured() ? "supabase" : "json";

const DATA_FILE = path.join(process.cwd(), "data", process.env.DATA_FILE_NAME ?? "db.json");
/** 他インスタンスの書き込みを確かめる間隔 (ミリ秒。画面の表示のとき。書き込みの前は毎回確かめる) */
const CHECK_INTERVAL = 5000;
/** 1 つの表で変わった行がこれより多いときは、その表だけを全件読み直す (ID を指定して読むより速い) */
const BULK_REFETCH = 1500;
/** 控えを保存する間隔 (変更があったときだけ) */
const SNAPSHOT_INTERVAL = 10 * 60 * 1000;

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
  refreshing?: Promise<void>;
  queue: Promise<unknown>;
  snapshotRevision?: number;
  snapshotTimer?: ReturnType<typeof setInterval>;
  snapshotSaving?: boolean;
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

/** mutate と取り直しを 1 件ずつ順番に実行する */
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const p = state.queue.then(fn, fn);
  state.queue = p.catch(() => undefined);
  return p;
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

const rowCount = () => COLLECTIONS.reduce((a, c) => a + collection(state.db!, c).length, 0);

/** Supabase から全件を読む (控えがない・変更の記録に抜けがあるときだけ) */
async function loadSupabase() {
  const started = Date.now();
  const { db, revision } = await loadFromSupabase();
  install(db, revision);
  console.info(`[db] loaded ${rowCount()} rows from Supabase in ${Date.now() - started}ms (revision ${revision})`);
  void saveSnapshot();
}

/**
 * 変更の記録から、リビジョン from より後 (to まで) に変わった行だけを取り直す (取り直しの順番待ちの中で呼ぶ)。
 * 記録に抜けがあるときは false (呼び出し側が全件を読み直す)
 */
async function catchUp(from: number, to: number): Promise<boolean> {
  const started = Date.now();
  const log = await fetchChanges(from, to);
  if (!log) return false;
  // 表ごとに、行 → 最後の操作 (u: 追加・変更 / d: 削除)
  const ops = new Map<string, Map<string, "u" | "d">>();
  for (const entry of log) {
    for (const [table, c] of Object.entries(entry.changes)) {
      const name = collectionOfTable(table);
      if (!name) return false; // このアプリが知らない表 (新しい版のアプリが書いた) → 全件を読み直す
      let m = ops.get(name);
      if (!m) ops.set(name, (m = new Map()));
      for (const id of c.u ?? []) m.set(id, "u");
      for (const id of c.d ?? []) m.set(id, "d");
    }
  }
  // 先に全部を取得してから、まとめて反映する (反映の途中の状態を画面に見せない)
  const fetched = new Map<string, { rows: Entity[]; full: boolean }>();
  let fetchedRows = 0;
  for (const [name, m] of ops) {
    const ids = [...m].filter(([, op]) => op === "u").map(([id]) => id);
    if (ids.length > BULK_REFETCH) {
      const all = await fetchCollection(name);
      if (!all) return false;
      fetched.set(name, { rows: all, full: true });
    } else {
      fetched.set(name, { rows: await fetchRowsByIds(name, ids), full: false });
    }
    fetchedRows += fetched.get(name)!.rows.length;
  }
  const db = state.db!;
  const all = db as unknown as Record<string, Entity[]>;
  for (const [name, m] of ops) {
    const f = fetched.get(name)!;
    // 配列は作り直す (ID の索引 queries.ts の byId は配列ごとにキャッシュしているため)
    if (f.full) {
      all[name] = f.rows;
      state.cache!.set(name, { ids: f.rows.map((r) => r.id), json: new Map(f.rows.map((r) => [r.id, JSON.stringify(r)])) });
      continue;
    }
    const got = new Map(f.rows.map((r) => [r.id, r]));
    const prev = collection(db, name);
    const cache = state.cache!.get(name) ?? { ids: [], json: new Map<string, string>() };
    const seen = new Set<string>();
    const next: Entity[] = [];
    for (const r of prev) {
      if (!m.has(r.id)) {
        next.push(r);
        continue;
      }
      seen.add(r.id);
      const row = got.get(r.id);
      // 削除された行・取り直したら無かった行 (そのあとに削除された) は外す
      if (row) next.push(row);
    }
    for (const [id, op] of m) {
      if (op === "u" && !seen.has(id) && got.has(id)) next.push(got.get(id)!);
    }
    for (const [id] of m) {
      const row = got.get(id);
      if (row) cache.json.set(id, JSON.stringify(row));
      else cache.json.delete(id);
    }
    cache.ids = next.map((r) => r.id);
    state.cache!.set(name, cache);
    all[name] = next;
  }
  state.revision = to;
  state.checkedAt = Date.now();
  const changed = [...ops.values()].reduce((a, m) => a + m.size, 0);
  console.info(`[db] caught up revision ${from} → ${to}: ${changed} changed rows (${fetchedRows} read from Supabase) in ${Date.now() - started}ms`);
  return true;
}

/** リビジョン rev に合わせる (取り直しの順番待ちの中で呼ぶ) */
async function refreshTo(rev: number) {
  if (rev === state.revision) return;
  if (state.revision >= 0 && rev > state.revision) {
    try {
      if (await catchUp(state.revision, rev)) return;
    } catch (err) {
      console.warn("[db] catch-up failed, reloading everything:", (err as Error).message);
    }
  }
  await loadSupabase();
}

/** 起動時: このサーバーの控えから読み、そのあとの変更だけを取り直す。使えないときは false */
async function loadFromSnapshot(): Promise<boolean> {
  if (!snapshotEnabled()) return false;
  const started = Date.now();
  const snap = await readSnapshot();
  if (!snap) return false;
  const { header } = snap;
  const [rev, loggedAt] = await Promise.all([currentRevision(), changeLoggedAt(header.revision)]);
  if (rev < header.revision || !loggedAt || new Date(loggedAt).getTime() !== new Date(header.loggedAt).getTime()) {
    console.info(`[db] local snapshot (revision ${header.revision}) does not match the database (revision ${rev}); loading from Supabase`);
    return false;
  }
  const db: Record<string, unknown> = { meta: header.meta };
  const cache = new Map<string, RowCache>();
  for (const name of COLLECTIONS) {
    const lines = snap.rows.get(name) ?? [];
    const rows = lines.map((s) => JSON.parse(s) as Entity);
    db[name] = rows;
    cache.set(name, { ids: rows.map((r) => r.id), json: new Map(rows.map((r, i) => [r.id, lines[i]])) });
  }
  state.db = migrateDb(db as unknown as Database);
  state.cache = cache;
  state.revision = header.revision;
  state.checkedAt = Date.now();
  state.snapshotRevision = header.revision;
  if (rev > header.revision && !(await catchUp(header.revision, rev))) return false;
  console.info(`[db] loaded ${rowCount()} rows from the local snapshot (revision ${header.revision}${rev > header.revision ? ` → ${rev}` : ""}) in ${Date.now() - started}ms`);
  return true;
}

async function initialLoad() {
  try {
    if (await loadFromSnapshot()) return;
  } catch (err) {
    console.warn("[db] snapshot load failed:", (err as Error).message);
  }
  await loadSupabase();
}

/**
 * いまのデータをこのサーバーに控えとして保存する。順番待ちの中で行の文字列だけを集め (すぐ終わる)、
 * 圧縮と書き込みは順番待ちの外で行う (そのあいだも書き込みを止めない)
 */
async function saveSnapshot(): Promise<void> {
  if (BACKEND !== "supabase" || !snapshotEnabled() || state.snapshotSaving) return;
  state.snapshotSaving = true;
  try {
    const taken = await enqueue(async () => {
      if (!state.db || !state.cache || state.revision <= 0 || state.revision === state.snapshotRevision) return null;
      return {
        revision: state.revision,
        meta: { ...state.db.meta },
        rows: COLLECTIONS.map((name): [string, string[]] => {
          const c = state.cache!.get(name);
          return [name, c ? c.ids.map((id) => c.json.get(id)!).filter(Boolean) : []];
        }),
      };
    });
    if (!taken) return;
    // そのリビジョンの変更の記録がない (全件の読み直しの合図のリビジョン) ときは、起動時に確かめられないので保存しない
    const loggedAt = await changeLoggedAt(taken.revision);
    if (!loggedAt) return;
    const started = Date.now();
    const bytes = await writeSnapshot({ v: 1, revision: taken.revision, loggedAt, savedAt: new Date().toISOString(), schema: schemaHash(), meta: taken.meta }, taken.rows);
    state.snapshotRevision = taken.revision;
    console.info(`[db] saved local snapshot (revision ${taken.revision}, ${(bytes / 1048576).toFixed(1)} MB) in ${Date.now() - started}ms`);
  } catch (err) {
    console.warn("[db] snapshot save failed:", (err as Error).message);
  } finally {
    state.snapshotSaving = false;
  }
}

/** いまのデータの控えをすぐ保存する (運用・確認用。通常は 10 分ごとに自動) */
export function saveLocalSnapshot(): Promise<void> {
  state.snapshotRevision = undefined;
  return saveSnapshot();
}

function startSnapshotTimer() {
  if (state.snapshotTimer || BACKEND !== "supabase" || !snapshotEnabled()) return;
  state.snapshotTimer = setInterval(() => void saveSnapshot(), SNAPSHOT_INTERVAL);
  state.snapshotTimer.unref?.();
}

/**
 * データを最新にする。ページ・Server Action の先頭 (requireUser / requireActionUser) で呼ばれる。
 * Supabase の場合は初回に読み込み (控え → 変わった行だけ取り直す。控えがなければ全件)、
 * 以降は他インスタンスの書き込みがあったときだけ、変わった行を取り直す。
 */
export function syncDb(): Promise<Database> {
  return sync(false);
}

/** inQueue: mutate() の中から呼ぶとき (自分自身の完了を待たないようにする)。force: 間隔に関係なく確かめる */
async function sync(inQueue: boolean, force = false): Promise<Database> {
  if (BACKEND === "json") return getDb();
  if (!state.db) {
    state.loading ??= initialLoad()
      .then(() => startSnapshotTimer())
      .finally(() => (state.loading = undefined));
    await state.loading;
    return state.db!;
  }
  if (force || Date.now() - state.checkedAt > CHECK_INTERVAL) {
    state.checkedAt = Date.now();
    try {
      if (inQueue) {
        const rev = await currentRevision();
        if (rev !== state.revision) await refreshTo(rev);
      } else if (state.refreshing) {
        await state.refreshing;
      } else {
        const rev = await currentRevision();
        if (rev !== state.revision) {
          // 書き込み中のものが終わるのを待ってから (順番待ちの中で、もう一度リビジョンを確かめる)
          state.refreshing ??= enqueue(async () => refreshTo(await currentRevision())).finally(() => (state.refreshing = undefined));
          await state.refreshing;
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
  return enqueue(async (): Promise<T> => {
    // 書き込みの前は毎回、他のインスタンスの変更を取り込む (古い内容で上書きしないように)
    const db = BACKEND === "json" ? getDb() : await sync(true, true);
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
      const before = state.revision;
      try {
        const rev = await writeToSupabase(changes);
        // 自分の書き込みの直前に他のインスタンスが書き込んでいた (リビジョンが 2 以上進んだ) ときは、
        // リビジョンを進めずにおき、次の syncDb() で間の変更 (自分の行を含む) を取り直す
        if (rev === before + 1) state.revision = rev;
        else state.checkedAt = 0;
      } catch (err) {
        rollback(db);
        console.error("[db] write failed:", err);
        // 書き込めた行とメモリが食い違わないよう、書き込もうとした行を変更の記録に残し、
        // 全インスタンス (自分を含む) に取り直させる。記録もできないときは全件を読み直す
        state.checkedAt = 0;
        await recordChanges(changes).catch(async () => {
          state.revision = -1;
          await bumpRevision().catch(() => undefined);
        });
        throw new Error("データベースへの保存に失敗しました。時間をおいて再度お試しください。");
      }
    }
    state.cache = changes.next;
    return result;
  });
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
