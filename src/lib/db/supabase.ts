import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./types";
import { CHANGES_TABLE, META_TABLE, TABLES, isTimestamp, loadOrder, snake, type TableDef } from "./schema";

/**
 * Supabase (PostgreSQL) との境界
 * ------------------------------------------------------------
 * - サーバー側だけで secret キーを使う (ブラウザへは渡さない)。テーブルは RLS 有効・ポリシーなしで
 *   publishable キーからは読めないようにしている (supabase/migrations/20261112000000_initial_schema.sql)
 * - 読み込み: 全テーブルを 1,000 行ずつ (ID の範囲で区切って) 取得してアプリのコレクション (camelCase) に変換。
 *   同時に送る問い合わせは全体で LOAD_CONCURRENCY まで (fetchTable)
 * - 書き込み: 変更・追加された行を upsert、消えた行を delete。最後にリビジョンを +1 して他のインスタンスへ知らせる
 */

const PAGE = 1000;

type Row = Record<string, unknown>;
type Entity = { id: string } & Record<string, unknown>;

let client: SupabaseClient | null = null;

export function supabaseConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SECRET_KEY);
}

function sb(): SupabaseClient {
  if (!client) {
    client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { "x-application-name": "ichijoya-ims" } },
    });
  }
  return client;
}

/** secret キーのクライアント (サーバー側のみ。ファイルの本体は Supabase ではなく VPS に保存する: src/lib/storage.ts) */
export function supabaseAdmin(): SupabaseClient {
  return sb();
}

function toRow(def: TableDef, e: Entity): Row {
  const row: Row = {};
  for (const [field] of def.columns) {
    const v = e[field];
    row[snake(field)] = v === undefined ? null : v;
  }
  return row;
}

function fromRow(def: TableDef, row: Row): Entity {
  const e: Record<string, unknown> = {};
  for (const [field, spec] of def.columns) {
    const v = row[snake(field)];
    if (v === null || v === undefined) continue;
    if (isTimestamp(spec) && typeof v === "string") e[field] = new Date(v).toISOString();
    else if (typeof v === "string" && /^numeric|^bigint/.test(spec)) e[field] = Number(v);
    else e[field] = v;
  }
  return e as Entity;
}

function failure(table: string, op: string, error: { message: string; details?: string | null; hint?: string | null } | null): Error {
  return new Error(`[supabase] ${table} ${op}: ${error?.message ?? "unknown error"}${error?.details ? ` (${error.details})` : ""}`);
}

/**
 * まだデータベースに作られていないテーブル (アプリに後から追加したテーブル)。
 * テーブル定義の SQL (supabase/migrations/...) を実行するまでは空として扱い、ほかの画面は動かし続ける
 */
// 起動時の読み込み (instrumentation.ts) と各画面・API は別のモジュールとして動くことがあるため、
// データ本体 (store.ts) と同じく globalThis に置いて共有する
const gm = globalThis as typeof globalThis & { __ichijoyaMissingTables?: Set<string> };
const missing: Set<string> = (gm.__ichijoyaMissingTables ??= new Set<string>());
export function missingTables(): string[] {
  return [...missing];
}

/**
 * 「ない」と記録したテーブルを確かめ直す (テーブル定義の SQL を実行した直後でも、再起動を待たずに使えるように)。
 * 作られていれば記録から外す (中身は作成直後で空のため、読み直しは不要)。まだないテーブルの一覧を返す
 */
export async function recheckMissingTables(): Promise<string[]> {
  for (const table of [...missing]) {
    const { error } = await sb().from(table).select("id").limit(1);
    if (!error) missing.delete(table);
  }
  return [...missing];
}

/** テーブルが存在しないときのエラー (PostgREST の schema cache にない / PostgreSQL の undefined_table) */
function isMissingTable(error: { code?: string; message?: string } | null): boolean {
  return Boolean(error && (error.code === "PGRST205" || error.code === "42P01" || /Could not find the table|does not exist/i.test(error.message ?? "")));
}

/**
 * 全件の読み込みで同時に送る問い合わせの数 (全テーブルで合わせて)。
 * 多すぎると Supabase の時間制限 (1 回 8 秒) に引っかかる (2026-11-19: 全テーブル × 6 並列の OFFSET 読みで、受注・予定・問い合わせが失敗し続けた)
 */
const LOAD_CONCURRENCY = Math.max(1, Number(process.env.SUPABASE_LOAD_CONCURRENCY) || 6);
let active = 0;
const waiting: (() => void)[] = [];
async function limited<T>(fn: () => PromiseLike<T>): Promise<T> {
  if (active >= LOAD_CONCURRENCY) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

/** 並び順 (loadOrder の列。昇順・空の値は最後) で比べる。PostgreSQL の order by と同じ並びにする */
function compareRows(cols: string[]) {
  return (a: Row, b: Row): number => {
    for (const c of cols) {
      const x = a[c];
      const y = b[c];
      if (x === y) continue;
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      if (typeof x === "number" && typeof y === "number") return x - y;
      const xs = String(x);
      const ys = String(y);
      if (xs !== ys) return xs < ys ? -1 : 1;
    }
    return 0;
  };
}

/**
 * 1 つのテーブルを全件読む。
 * - 1,000 行以下: 1 回で読む
 * - それより多い: ID (主キー) の順に「この ID より後の 1,000 件」で ID だけを読み (索引だけで済む軽い問い合わせ)、
 *   その区切りごとに「ID がこの範囲」の行を並列に読む。OFFSET (先頭から数えて何件目から) は深いページほど遅くなり、
 *   行の多い表 (受注 4 万行・予定 2 万行) で時間制限を超えるため使わない
 * - 最後に、これまでと同じ並び (loadOrder) にそろえる
 */
async function fetchTable(def: TableDef): Promise<Entity[]> {
  const head = await limited(() => sb().from(def.table).select("id", { count: "exact", head: true }));
  let error = head.error;
  // テーブルがないとき、HEAD の問い合わせはエラーにならず件数が空 (204) で返る。GET で確かめる
  if (!error && head.count == null) error = (await limited(() => sb().from(def.table).select("id").limit(1))).error;
  if (error && isMissingTable(error)) {
    if (!missing.has(def.table)) console.warn(`[supabase] table "${def.table}" is missing. Run supabase/migrations/20261112000000_initial_schema.sql`);
    missing.add(def.table);
    return [];
  }
  missing.delete(def.table);
  if (error) throw failure(def.table, "count", error);
  const total = head.count ?? 0;
  const order = loadOrder(def);
  const sortRows = (rows: Row[]) => rows.sort(compareRows(order));

  if (total <= PAGE) {
    // 少ない表は 1 回で読む (件数を数えた直後に増えていても取りこぼさないよう、上限は少し多めに)
    const { data, error } = await limited(() => sb().from(def.table).select("*").order("id", { ascending: true }).limit(PAGE));
    if (error) throw failure(def.table, "select", error);
    const rows = (data ?? []) as Row[];
    if (rows.length < PAGE) return sortRows(rows).map((r) => fromRow(def, r));
  }

  // 1) ID の区切り (1,000 件ごとの最初と最後の ID)
  const ranges: [string, string][] = [];
  let after: string | undefined;
  for (;;) {
    const { data, error } = await limited(() => {
      let q = sb().from(def.table).select("id").order("id", { ascending: true }).limit(PAGE);
      if (after !== undefined) q = q.gt("id", after);
      return q;
    });
    if (error) throw failure(def.table, "select", error);
    const ids = ((data ?? []) as { id: string }[]).map((r) => String(r.id));
    if (!ids.length) break;
    ranges.push([ids[0], ids[ids.length - 1]]);
    if (ids.length < PAGE) break;
    after = ids[ids.length - 1];
  }
  // 2) 区切りごとに行を読む (並列。数は LOAD_CONCURRENCY で全体を制限)
  const parts = await Promise.all(
    ranges.map(async ([from, to]) => {
      const { data, error } = await limited(() => sb().from(def.table).select("*").gte("id", from).lte("id", to).order("id", { ascending: true }).limit(PAGE + 500));
      if (error) throw failure(def.table, "select", error);
      return (data ?? []) as Row[];
    }),
  );
  // 区切りを作った後に増えた行が、隣の区切りと重ならないようにする (同じ ID は 1 つ)
  const seen = new Set<string>();
  const rows: Row[] = [];
  for (const part of parts)
    for (const r of part) {
      const id = String(r.id);
      if (seen.has(id)) continue;
      seen.add(id);
      rows.push(r);
    }
  return sortRows(rows).map((r) => fromRow(def, r));
}

/** 全テーブルを読み込む */
export async function loadFromSupabase(): Promise<{ db: Database; revision: number }> {
  const meta = await sb().from(META_TABLE).select("*").eq("id", 1).maybeSingle();
  if (meta.error) throw failure(META_TABLE, "select", meta.error);
  const db: Record<string, unknown> = {
    meta: {
      version: Number(meta.data?.version ?? 3),
      seededAt: String(meta.data?.seeded_at ?? new Date().toISOString()),
      source: meta.data?.source ?? undefined,
      importedAt: meta.data?.imported_at ?? undefined,
    },
  };
  const results = await Promise.all(TABLES.map((def) => fetchTable(def)));
  TABLES.forEach((def, i) => (db[def.collection] = results[i]));
  return { db: db as unknown as Database, revision: Number(meta.data?.revision ?? 0) };
}

/** 他のインスタンスが書き込んだかを確かめるための現在のリビジョン */
export async function currentRevision(): Promise<number> {
  const { data, error } = await sb().from(META_TABLE).select("revision").eq("id", 1).maybeSingle();
  if (error) throw failure(META_TABLE, "select", error);
  return Number(data?.revision ?? 0);
}

export interface Changes {
  upserts: Map<string, Entity[]>;
  deletes: Map<string, string[]>;
}

/** 変更分を書き込み、新しいリビジョンを返す */
export async function writeToSupabase(changes: Changes): Promise<number> {
  for (const def of TABLES) {
    if (missing.has(def.table) && (changes.upserts.get(def.collection)?.length || changes.deletes.get(def.collection)?.length)) {
      throw new Error(`[supabase] table "${def.table}" is missing. Run supabase/migrations/20261112000000_initial_schema.sql`);
    }
  }
  for (const def of TABLES) {
    const rows = changes.upserts.get(def.collection);
    if (!rows?.length) continue;
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await sb()
        .from(def.table)
        .upsert(rows.slice(i, i + 500).map((r) => toRow(def, r)), { onConflict: "id" });
      if (error) throw failure(def.table, "upsert", error);
    }
  }
  for (const def of [...TABLES].reverse()) {
    const ids = changes.deletes.get(def.collection);
    if (!ids?.length) continue;
    for (let i = 0; i < ids.length; i += 200) {
      const { error } = await sb().from(def.table).delete().in("id", ids.slice(i, i + 200));
      if (error) throw failure(def.table, "delete", error);
    }
  }
  return recordChanges(changes);
}

/** 変更の記録の形 ({ 表: { u: 追加・変更した行の ID, d: 削除した行の ID } }) */
export type ChangeLog = Record<string, { u?: string[]; d?: string[] }>;

let recordFnMissing = false;

/**
 * 書き込んだ行の ID を記録してリビジョンを +1 する (record_changes)。
 * 関数がまだデータベースにないとき (テーブル定義の反映前) は、記録なしで +1 する (他のインスタンスは全件を読み直す)
 */
export async function recordChanges(changes: Changes): Promise<number> {
  if (recordFnMissing) return bumpRevision();
  const log: ChangeLog = {};
  for (const def of TABLES) {
    const u = changes.upserts.get(def.collection)?.map((r) => r.id);
    const d = changes.deletes.get(def.collection);
    if (u?.length || d?.length) log[def.table] = { ...(u?.length ? { u } : {}), ...(d?.length ? { d } : {}) };
  }
  const { data, error } = await sb().rpc("record_changes", { p_changes: log });
  if (error) {
    if (error.code === "PGRST202" || /Could not find the function/i.test(error.message)) {
      recordFnMissing = true;
      console.warn("[supabase] function record_changes is missing (npm run db:migrate). Falling back to bump_revision");
      return bumpRevision();
    }
    throw failure(META_TABLE, "record_changes", error);
  }
  return Number(data ?? 0);
}

/**
 * リビジョン since より後 (until まで) の変更の記録。抜けがある (記録のないリビジョンがある・古くて消えた・
 * 表がない) ときは null (= 全件を読み直す)
 */
export async function fetchChanges(since: number, until: number): Promise<{ revision: number; changes: ChangeLog; at: string }[] | null> {
  if (until <= since) return [];
  if (until - since > 500) return null;
  const { data, error } = await sb().from(CHANGES_TABLE).select("revision, changes, at").gt("revision", since).lte("revision", until).order("revision", { ascending: true });
  if (error) {
    if (isMissingTable(error)) return null;
    throw failure(CHANGES_TABLE, "select", error);
  }
  const rows = (data ?? []).map((r) => ({ revision: Number(r.revision), changes: (r.changes ?? {}) as ChangeLog, at: String(r.at) }));
  if (rows.length !== until - since || rows.some((r, i) => r.revision !== since + 1 + i)) return null;
  return rows;
}

/** あるリビジョンの変更の記録が書かれた時刻 (保存しておいたデータが、いまのデータベースと同じ流れのものかを確かめる) */
export async function changeLoggedAt(revision: number): Promise<string | null> {
  const { data, error } = await sb().from(CHANGES_TABLE).select("at").eq("revision", revision).maybeSingle();
  if (error) {
    if (isMissingTable(error)) return null;
    throw failure(CHANGES_TABLE, "select", error);
  }
  return data?.at ? String(data.at) : null;
}

/** 指定した ID の行だけを読む (なくなった行は返らない) */
export async function fetchRowsByIds(collection: string, ids: string[]): Promise<Entity[]> {
  const def = TABLES.find((t) => t.collection === collection);
  if (!def || !ids.length) return [];
  const out: Entity[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await sb().from(def.table).select("*").in("id", ids.slice(i, i + 100));
    if (error) throw failure(def.table, "select", error);
    for (const r of data ?? []) out.push(fromRow(def, r as Row));
  }
  return out;
}

/** 1 つの表を全件読む (変わった行が多いとき) */
export async function fetchCollection(collection: string): Promise<Entity[] | null> {
  const def = TABLES.find((t) => t.collection === collection);
  return def ? fetchTable(def) : null;
}

/** 表の名前 → コレクションの名前 */
export function collectionOfTable(table: string): string | undefined {
  return TABLES.find((t) => t.table === table)?.collection;
}

/** リビジョンを +1 して、他のインスタンスに読み直しを知らせる */
export async function bumpRevision(): Promise<number> {
  const { data, error } = await sb().rpc("bump_revision");
  if (error) throw failure(META_TABLE, "bump_revision", error);
  return Number(data ?? 0);
}
