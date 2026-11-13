import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./types";
import { META_TABLE, TABLES, isTimestamp, loadOrder, snake, type TableDef } from "./schema";

/**
 * Supabase (PostgreSQL) との境界
 * ------------------------------------------------------------
 * - サーバー側だけで secret キーを使う (ブラウザへは渡さない)。テーブルは RLS 有効・ポリシーなしで
 *   publishable キーからは読めないようにしている (supabase/migrations/20261112000000_initial_schema.sql)
 * - 読み込み: 全テーブルを 1,000 行ずつ並列に取得してアプリのコレクション (camelCase) に変換
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

/** secret キーのクライアント (サーバー側のみ。ファイルの保存 src/lib/storage.ts でも使う) */
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

async function fetchTable(def: TableDef): Promise<Entity[]> {
  const head = await sb().from(def.table).select("id", { count: "exact", head: true });
  let error = head.error;
  // テーブルがないとき、HEAD の問い合わせはエラーにならず件数が空 (204) で返る。GET で確かめる
  if (!error && head.count == null) error = (await sb().from(def.table).select("id").limit(1)).error;
  if (error && isMissingTable(error)) {
    if (!missing.has(def.table)) console.warn(`[supabase] table "${def.table}" is missing. Run supabase/migrations/20261112000000_initial_schema.sql`);
    missing.add(def.table);
    return [];
  }
  missing.delete(def.table);
  if (error) throw failure(def.table, "count", error);
  const total = head.count ?? 0;
  const pages = Math.ceil(total / PAGE);
  const out: Entity[][] = new Array(pages);
  let next = 0;
  async function worker() {
    while (next < pages) {
      const p = next++;
      let q = sb().from(def.table).select("*");
      // 並び順は索引 (schema-sql.mjs の *_load_order_idx。昇順・空の値は最後) と同じにする。nullsFirst: true だと索引が使われず、
      // 行の多い表 (受注 4 万行など) で並べ替えが Supabase の時間制限 (8 秒) を超えて読み込みが失敗する (2026-11-13 に発生)
      for (const col of loadOrder(def)) q = q.order(col, { ascending: true, nullsFirst: false });
      const { data, error } = await q.range(p * PAGE, p * PAGE + PAGE - 1);
      if (error) throw failure(def.table, "select", error);
      out[p] = (data ?? []).map((r) => fromRow(def, r as Row));
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, pages) }, worker));
  return out.flat();
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
  return bumpRevision();
}

/** リビジョンを +1 して、他のインスタンスに読み直しを知らせる */
export async function bumpRevision(): Promise<number> {
  const { data, error } = await sb().rpc("bump_revision");
  if (error) throw failure(META_TABLE, "bump_revision", error);
  return Number(data ?? 0);
}
