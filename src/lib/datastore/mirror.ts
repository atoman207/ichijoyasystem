import "server-only";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Database } from "@/lib/db/types";
import { TABLES, snake, type TableDef } from "@/lib/db/schema";
import { BACKEND, getDb, onDataChange, syncDb, type DataChange } from "@/lib/db/store";
import { AMOUNT_KEYS, AMOUNT_LABEL, salesFacts, type OrderFact } from "@/lib/assistant/facts";
import { searchEntries, setSearchProvider, type Entry, type SearchProvider } from "@/lib/assistant/search";
import { LABELS_SQL, labelRows } from "./model";

/**
 * VPS のデータベース (システムの全データの写し。AI アシスタント「質問する」が検索・集計に使う)
 * ------------------------------------------------------------
 * - 保存先: ICHIJOYA_DATA_DB_PATH。なければ本番サーバー (/srv/ichijoya があり、Supabase を使う) は
 *   /srv/ichijoya/data/database/ichijoya-data.sqlite、それ以外 (サンプルデータ・手元) は data/database/ichijoya-data.sqlite。
 *   リリースのフォルダーの外に置くので、デプロイしても消えない。3000 番と 3001 番で同じファイルを使う
 * - 中身:
 *   1) システムの全テーブル (Supabase と同じ表名・列名。配列・入れ子は JSON の文字列。パスワードのハッシュは入れない)
 *   2) 分析用の表: sales_orders (受注ごとの売上・種別の内訳・原価・担当者)・sales_items (明細 1 行ずつ)・order_staff (担当者)
 *   3) 横断検索の索引: search_docs + search_fts (FTS5 trigram)
 *   4) コードの日本語名: _labels (統合データモデル model.ts のビューが使う)
 * - 正本は Supabase。システムでの書き込み・他のインスタンスの変更・全件の読み込みのたびに通知を受けて (store.ts の onDataChange)、
 *   変わった行だけを書き込む。起動時と通知の取りこぼしのあとは、行ごとのハッシュ (_rowhash) で全体を突き合わせる (reconcile)
 * - 写しなので、消えても Supabase から作り直せる (AI アシスタント → チャットボットの管理 →「作り直す」)
 */

const VERSION = "1";

/** 写しに入れない列 (パスワード) */
const EXCLUDE: Record<string, string[]> = { users: ["password", "passwordHash"] };

export function mirrorPath(): string {
  const env = process.env.ICHIJOYA_DATA_DB_PATH?.trim();
  if (env) return env;
  // サンプルデータ (DATA_BACKEND=json) のサーバーは、本番の写しに書かない
  if (BACKEND === "supabase" && fs.existsSync("/srv/ichijoya")) return "/srv/ichijoya/data/database/ichijoya-data.sqlite";
  return path.join(process.cwd(), "data", "database", "ichijoya-data.sqlite");
}

/* ================================================================== */
/* SQLite                                                               */
/* ================================================================== */

interface Statement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}
export interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}
type SqliteModule = { DatabaseSync: new (file: string, opts?: { readOnly?: boolean }) => SqliteDb };
export const sqlite = (): SqliteModule => (process as unknown as { getBuiltinModule(id: string): SqliteModule }).getBuiltinModule("node:sqlite");

interface MirrorState {
  db?: SqliteDb;
  queue: Promise<unknown>;
  started?: boolean;
  status: "idle" | "building" | "ready" | "error";
  error?: string;
  syncedAt?: string;
  lastFull?: { at: string; ms: number; written: number };
  deriveTimer?: ReturnType<typeof setTimeout>;
  dirty: Set<string>;
}
const g = globalThis as typeof globalThis & { __ichijoyaMirror?: MirrorState };
const st: MirrorState = (g.__ichijoyaMirror ??= { queue: Promise.resolve(), status: "idle", dirty: new Set() });

/** 写しの処理は 1 件ずつ順番に (途中の書き込みが混ざらないように) */
function enqueue<T>(fn: () => Promise<T> | T): Promise<T> {
  const p = st.queue.then(fn, fn) as Promise<T>;
  st.queue = p.catch(() => undefined);
  return p;
}

const yieldNow = () => new Promise<void>((r) => setImmediate(r));

function colType(spec: string): string {
  if (/^(numeric|bigint|integer|int|real|double)/.test(spec)) return "NUMERIC";
  if (/^boolean/.test(spec)) return "INTEGER";
  return "TEXT";
}

function mirrorColumns(def: TableDef): [string, string][] {
  const skip = new Set(EXCLUDE[def.collection] ?? []);
  return def.columns.filter(([f]) => !skip.has(f)).map(([f, spec]) => [f, spec]);
}

/** 分析用の表 */
const DERIVED_SQL = `
create table if not exists sales_orders (
  order_id text primary key, number text, sales_date text, contract_date text, status text,
  store_id text, store_name text, customer_id text, customer_code text, customer_name text, customer_type text, area text,
  title text, total numeric,
  ${AMOUNT_KEYS.map((k) => `amt_${k} numeric`).join(", ")},
  tatami_cost numeric, purchase_cost numeric, staff_names text, worker_names text, item_source text
);
create index if not exists sales_orders_date on sales_orders (sales_date);
create index if not exists sales_orders_store on sales_orders (store_id, sales_date);
create index if not exists sales_orders_customer on sales_orders (customer_id);
create table if not exists sales_items (
  order_id text not null, line_no integer not null, sales_date text, store_id text, customer_id text,
  category text, product text, qty numeric, unit_price numeric, amount numeric,
  primary key (order_id, line_no)
);
create index if not exists sales_items_date on sales_items (sales_date);
create index if not exists sales_items_product on sales_items (product);
create table if not exists order_staff (order_id text not null, staff_name text not null, primary key (order_id, staff_name));
create index if not exists order_staff_name on order_staff (staff_name);
create table if not exists search_docs (
  rowid integer primary key, key text not null unique, type text not null, ref_id text not null,
  store_id text, date text, head text not null, body text not null
);
create virtual table if not exists search_fts using fts5 (head, body, content = 'search_docs', content_rowid = 'rowid', tokenize = 'trigram');
create trigger if not exists search_docs_ai after insert on search_docs begin insert into search_fts (rowid, head, body) values (new.rowid, new.head, new.body); end;
create trigger if not exists search_docs_ad after delete on search_docs begin insert into search_fts (search_fts, rowid, head, body) values ('delete', old.rowid, old.head, old.body); end;
${LABELS_SQL}
`;

function schemaHash(): string {
  return crypto
    .createHash("sha1")
    .update(VERSION + JSON.stringify(TABLES.map((t) => [t.table, mirrorColumns(t)])) + DERIVED_SQL)
    .digest("hex")
    .slice(0, 16);
}

function createSchema(db: SqliteDb) {
  const parts: string[] = [];
  for (const def of TABLES) {
    const cols = mirrorColumns(def).map(([f, spec]) => `${snake(f)} ${f === "id" ? "TEXT PRIMARY KEY" : colType(spec)}`);
    parts.push(`create table if not exists ${def.table} (${cols.join(", ")});`);
    for (const [f] of mirrorColumns(def)) {
      const c = snake(f);
      if (c !== "id" && (/_id$/.test(c) || /^(date|sales_date|contract_date|received_at|issue_date|invoice_date|issued_on|occurred_on|created_at|at)$/.test(c))) parts.push(`create index if not exists ${def.table}__${c} on ${def.table} (${c});`);
    }
  }
  db.exec(`
    pragma journal_mode = wal;
    pragma busy_timeout = 10000;
    pragma synchronous = normal;
    create table if not exists _meta (key text primary key, value text not null);
    create table if not exists _rowhash (collection text not null, id text not null, hash text not null, primary key (collection, id));
    ${parts.join("\n")}
    ${DERIVED_SQL}
  `);
}

/** コードの日本語名 (画面と同じ。constants.ts を変えたら次の起動で入れ直す) */
function writeLabels(db: SqliteDb) {
  inTx(db, () => {
    db.exec("delete from _labels");
    const ins = db.prepare("insert or replace into _labels (kind, code, label) values (?, ?, ?)");
    for (const r of labelRows()) ins.run(...r);
  });
}

function open(): SqliteDb {
  if (st.db) return st.db;
  const file = mirrorPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const { DatabaseSync } = sqlite();
  let db = new DatabaseSync(file);
  db.exec("pragma busy_timeout = 10000;");
  const want = schemaHash();
  let have: string | undefined;
  try {
    have = String(db.prepare("select value from _meta where key = 'schema'").get()?.value ?? "");
  } catch {
    have = undefined;
  }
  if (have !== want) {
    // 表の作りが変わった (新しい列・表) → 作り直す (写しなので Supabase の内容から全部入れ直す)
    if (have) console.info(`[mirror] schema changed (${have} → ${want}); rebuilding ${file}`);
    db.close();
    for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
    db = new DatabaseSync(file);
    createSchema(db);
    db.prepare("insert into _meta (key, value) values ('schema', ?) on conflict (key) do update set value = excluded.value").run(want);
  } else {
    createSchema(db);
  }
  writeLabels(db);
  st.db = db;
  return db;
}

function setMeta(db: SqliteDb, key: string, value: string) {
  db.prepare("insert into _meta (key, value) values (?, ?) on conflict (key) do update set value = excluded.value").run(key, value);
}

/* ================================================================== */
/* 行の書き込み                                                          */
/* ================================================================== */

const hashOf = (s: string) => crypto.createHash("sha1").update(s).digest("base64").slice(0, 22);

function toValue(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" || typeof v === "string" || typeof v === "bigint") return v;
  return JSON.stringify(v);
}

interface TableWriter {
  upsert: (row: Record<string, unknown>, hash: string) => void;
  remove: (id: string) => void;
}

function writerFor(db: SqliteDb, def: TableDef): TableWriter {
  const cols = mirrorColumns(def);
  const ins = db.prepare(`insert or replace into ${def.table} (${cols.map(([f]) => snake(f)).join(", ")}) values (${cols.map(() => "?").join(", ")})`);
  const del = db.prepare(`delete from ${def.table} where id = ?`);
  const hIns = db.prepare("insert or replace into _rowhash (collection, id, hash) values (?, ?, ?)");
  const hDel = db.prepare("delete from _rowhash where collection = ? and id = ?");
  return {
    upsert: (row, hash) => {
      ins.run(...cols.map(([f]) => toValue(row[f])));
      hIns.run(def.collection, String(row.id), hash);
    },
    remove: (id) => {
      del.run(id);
      hDel.run(def.collection, id);
    },
  };
}

function inTx(db: SqliteDb, fn: () => void) {
  db.exec("begin");
  try {
    fn();
    db.exec("commit");
  } catch (err) {
    db.exec("rollback");
    throw err;
  }
}

/** 表全体を突き合わせて、違う行だけを書く (起動時・取りこぼしのあと・表全体の読み直しのあと) */
async function reconcileTable(db: SqliteDb, def: TableDef, rows: Record<string, unknown>[]): Promise<number> {
  const stored = new Map<string, string>();
  for (const r of db.prepare("select id, hash from _rowhash where collection = ?").all(def.collection)) stored.set(String(r.id), String(r.hash));
  const w = writerFor(db, def);
  const live = new Set<string>();
  let written = 0;
  const CHUNK = 1500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    inTx(db, () => {
      for (const r of part) {
        const id = String(r.id);
        live.add(id);
        const h = hashOf(JSON.stringify(r));
        if (stored.get(id) === h) continue;
        w.upsert(r, h);
        written++;
      }
    });
    await yieldNow();
  }
  const gone = [...stored.keys()].filter((id) => !live.has(id));
  if (gone.length) inTx(db, () => gone.forEach((id) => w.remove(id)));
  return written + gone.length;
}

/* ================================================================== */
/* 分析用の表と検索の索引                                                 */
/* ================================================================== */

function factRow(f: OrderFact, names: { store: Map<string, string>; cust: Map<string, { code: string; name: string; type: string }>; user: Map<string, string> }) {
  const c = names.cust.get(f.customerId);
  return [
    f.id,
    f.number,
    f.salesDate ?? null,
    f.contractDate,
    f.status,
    f.storeId,
    names.store.get(f.storeId) ?? f.storeId,
    f.customerId,
    c?.code ?? null,
    c?.name ?? null,
    c?.type === "corporate" ? "法人" : "個人",
    f.area || null,
    f.title,
    f.total,
    ...AMOUNT_KEYS.map((k) => f.amounts[k] ?? 0),
    f.tatamiCost,
    f.purchaseCost,
    f.staff.join("・"),
    f.workerNames.join("・"),
    f.itemSource,
  ];
}

async function reconcileDerived(db: SqliteDb, data: Database): Promise<number> {
  const { facts } = salesFacts(data);
  const names = {
    store: new Map(data.stores.map((s) => [s.id as string, s.name])),
    cust: new Map(data.customers.map((c) => [c.id, { code: c.code, name: c.name, type: c.type }])),
    user: new Map(data.users.map((u) => [u.id, u.name])),
  };
  const stored = new Map<string, string>();
  for (const r of db.prepare("select id, hash from _rowhash where collection = 'sales_orders'").all()) stored.set(String(r.id), String(r.hash));
  const cols = 14 + AMOUNT_KEYS.length + 5;
  const insO = db.prepare(`insert or replace into sales_orders values (${new Array(cols).fill("?").join(", ")})`);
  const delO = db.prepare("delete from sales_orders where order_id = ?");
  const delI = db.prepare("delete from sales_items where order_id = ?");
  const insI = db.prepare("insert into sales_items values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const delS = db.prepare("delete from order_staff where order_id = ?");
  const insS = db.prepare("insert or ignore into order_staff values (?, ?)");
  const hIns = db.prepare("insert or replace into _rowhash (collection, id, hash) values ('sales_orders', ?, ?)");
  const hDel = db.prepare("delete from _rowhash where collection = 'sales_orders' and id = ?");
  const live = new Set<string>();
  let written = 0;
  const CHUNK = 1000;
  for (let i = 0; i < facts.length; i += CHUNK) {
    const part = facts.slice(i, i + CHUNK);
    inTx(db, () => {
      for (const f of part) {
        live.add(f.id);
        const row = factRow(f, names);
        const h = hashOf(JSON.stringify([row, f.items]));
        if (stored.get(f.id) === h) continue;
        insO.run(...row);
        delI.run(f.id);
        f.items.forEach((it, n) => insI.run(f.id, n + 1, f.salesDate ?? f.contractDate, f.storeId, f.customerId, AMOUNT_LABEL[it.cat], it.product, it.qty, it.unitPrice, it.amount));
        delS.run(f.id);
        for (const s of f.staff) insS.run(f.id, s);
        hIns.run(f.id, h);
        written++;
      }
    });
    await yieldNow();
  }
  const gone = [...stored.keys()].filter((id) => !live.has(id));
  if (gone.length)
    inTx(db, () => {
      for (const id of gone) {
        delO.run(id);
        delI.run(id);
        delS.run(id);
        hDel.run(id);
      }
    });
  return written + gone.length;
}

async function reconcileSearch(db: SqliteDb, data: Database): Promise<number> {
  const entries: Entry[] = searchEntries(data);
  const stored = new Map<string, string>();
  for (const r of db.prepare("select id, hash from _rowhash where collection = 'search_docs'").all()) stored.set(String(r.id), String(r.hash));
  const del = db.prepare("delete from search_docs where key = ?");
  const ins = db.prepare("insert into search_docs (key, type, ref_id, store_id, date, head, body) values (?, ?, ?, ?, ?, ?, ?)");
  const hIns = db.prepare("insert or replace into _rowhash (collection, id, hash) values ('search_docs', ?, ?)");
  const hDel = db.prepare("delete from _rowhash where collection = 'search_docs' and id = ?");
  const live = new Set<string>();
  let written = 0;
  const CHUNK = 2000;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const part = entries.slice(i, i + CHUNK);
    inTx(db, () => {
      for (const e of part) {
        const key = `${e.type}:${e.id}`;
        live.add(key);
        const h = hashOf(`${e.head}\u0001${e.text}\u0001${e.date}\u0001${e.storeId ?? ""}`);
        if (stored.get(key) === h) continue;
        del.run(key);
        ins.run(key, e.type, e.id, e.storeId ?? null, e.date || null, e.head, e.text.slice(0, 4000));
        hIns.run(key, h);
        written++;
      }
    });
    await yieldNow();
  }
  const gone = [...stored.keys()].filter((k) => !live.has(k));
  if (gone.length)
    inTx(db, () => {
      for (const k of gone) {
        del.run(k);
        hDel.run(k);
      }
    });
  return written + gone.length;
}

/** 分析用の表と検索の索引を、少し待ってから (続けて書き込まれたときはまとめて) 作り直す */
function scheduleDerive(delay = 4000) {
  if (st.deriveTimer) clearTimeout(st.deriveTimer);
  st.deriveTimer = setTimeout(() => {
    st.deriveTimer = undefined;
    void enqueue(async () => {
      const db = open();
      const data = getDb();
      const t0 = Date.now();
      const a = await reconcileDerived(db, data);
      const b = await reconcileSearch(db, data);
      setMeta(db, "derived_at", new Date().toISOString());
      st.syncedAt = new Date().toISOString();
      if (a + b) console.info(`[mirror] derived tables updated (${a} orders, ${b} search docs) in ${Date.now() - t0}ms`);
    }).catch((err) => {
      st.status = "error";
      st.error = (err as Error).message;
      console.warn("[mirror] derive failed:", st.error);
    });
  }, delay);
  st.deriveTimer.unref?.();
}

/* ================================================================== */
/* 同期                                                                 */
/* ================================================================== */

const DERIVED_SOURCES = new Set(["orders", "quotes", "invoices", "purchases", "customers", "users", "stores", "products"]);

/** システムの全データと突き合わせる (起動時・作り直し・取りこぼしのあと) */
export function fullSync(reason: string): Promise<{ written: number; ms: number }> {
  return enqueue(async () => {
    const t0 = Date.now();
    // 一度できあがった写しは、突き合わせのあいだも使える (少し古いだけ)。初めてのときだけ「作成中」
    if (st.status !== "ready") st.status = "building";
    st.error = undefined;
    try {
      const data = BACKEND === "json" ? getDb() : await syncDb();
      const db = open();
      let written = 0;
      for (const def of TABLES) written += await reconcileTable(db, def, ((data as unknown as Record<string, Record<string, unknown>[]>)[def.collection] ?? []).slice());
      written += await reconcileDerived(db, data);
      written += await reconcileSearch(db, data);
      const now = new Date().toISOString();
      setMeta(db, "synced_at", now);
      setMeta(db, "derived_at", now);
      st.syncedAt = now;
      st.status = "ready";
      st.dirty.clear();
      const ms = Date.now() - t0;
      st.lastFull = { at: now, ms, written };
      console.info(`[mirror] full sync (${reason}): ${written} rows written in ${ms}ms → ${mirrorPath()}`);
      return { written, ms };
    } catch (err) {
      st.status = "error";
      st.error = (err as Error).message;
      console.warn("[mirror] full sync failed:", st.error);
      throw err;
    }
  });
}

/** 変更の通知を受けて、変わった行だけを書く */
function onChanges(changes: DataChange[]) {
  if (!st.started) return;
  if (changes.some((c) => c.kind === "reload" && !c.collection)) {
    void fullSync("reload").catch(() => undefined);
    return;
  }
  void enqueue(async () => {
    const db = open();
    let derive = false;
    for (const c of changes) {
      const def = TABLES.find((t) => t.collection === c.collection);
      if (!def) continue;
      if (DERIVED_SOURCES.has(def.collection)) derive = true;
      if (c.kind === "reload") {
        // 表全体を読み直した → 表ごと突き合わせる
        const rows = ((getDb() as unknown as Record<string, Record<string, unknown>[]>)[def.collection] ?? []).slice();
        await reconcileTable(db, def, rows);
        continue;
      }
      const w = writerFor(db, def);
      inTx(db, () => {
        for (const r of c.upserts) w.upsert(r as Record<string, unknown>, hashOf(JSON.stringify(r)));
        for (const id of c.deletes) w.remove(id);
      });
    }
    setMeta(db, "synced_at", new Date().toISOString());
    st.syncedAt = new Date().toISOString();
    // 検索の索引はどの表の変更でも変わる。分析用の表は受注などの変更のとき
    scheduleDerive(derive ? 3000 : 6000);
  }).catch((err) => {
    st.status = "error";
    st.error = (err as Error).message;
    console.warn("[mirror] apply failed; will reconcile:", st.error);
    setTimeout(() => void fullSync("recover").catch(() => undefined), 10_000).unref?.();
  });
}

/* ================================================================== */
/* 検索 (横断検索の候補をデータベースから取る)                               */
/* ================================================================== */

const escapeLike = (t: string) => t.replace(/[\\%_]/g, (c) => `\\${c}`);

const searchProvider: SearchProvider = (q) => {
  const db = mirrorDb();
  if (!db) return undefined;
  const where: string[] = [];
  const args: unknown[] = [];
  if (q.terms.length) {
    const conds: string[] = [];
    // 3 文字以上の言葉は全文検索 (trigram)、2 文字以下は部分一致
    const long = q.terms.filter((t) => [...t].length >= 3);
    const short = q.terms.filter((t) => [...t].length < 3);
    if (long.length) {
      conds.push("d.rowid in (select rowid from search_fts where search_fts match ?)");
      args.push(long.map((t) => `"${t.replace(/"/g, '""')}"`).join(q.mode === "and" ? " AND " : " OR "));
    }
    for (const t of short) {
      conds.push("(d.head like ? escape '\\' or d.body like ? escape '\\')");
      args.push(`%${escapeLike(t)}%`, `%${escapeLike(t)}%`);
    }
    where.push(`(${conds.join(q.mode === "and" ? " and " : " or ")})`);
  }
  if (q.types.length) {
    where.push(`d.type in (${q.types.map(() => "?").join(", ")})`);
    args.push(...q.types);
  }
  if (q.storeId) {
    where.push("d.store_id = ?");
    args.push(q.storeId);
  }
  if (q.from) {
    where.push("d.date >= ?");
    args.push(q.from);
  }
  if (q.to) {
    where.push("d.date is not null and d.date <= ?");
    args.push(q.to);
  }
  const sql = `select d.type, d.ref_id, d.store_id, d.date, d.head, d.body from search_docs d ${where.length ? `where ${where.join(" and ")}` : ""} order by d.date desc limit ${Math.max(1, Math.min(10000, q.limit))}`;
  return db
    .prepare(sql)
    .all(...args)
    .map((r) => ({ type: String(r.type) as Entry["type"], id: String(r.ref_id), head: String(r.head), text: String(r.body), date: r.date ? String(r.date) : "", storeId: r.store_id ? (String(r.store_id) as Entry["storeId"]) : undefined }));
};

/** サーバーの起動時に呼ぶ: 通知を受け取り、全体を突き合わせる */
export function startMirror(): void {
  if (st.started || process.env.ICHIJOYA_DATA_DB === "off") return;
  st.started = true;
  onDataChange(onChanges);
  setSearchProvider(searchProvider);
  void fullSync("startup").catch(() => undefined);
  // 念のため 1 時間ごとに全体を突き合わせる (通知の取りこぼし・別のインスタンスの書き込みの抜けを直す)
  setInterval(() => void fullSync("hourly").catch(() => undefined), 3_600_000).unref?.();
}

/** 作り直す (管理者の操作): ファイルを消して全部入れ直す */
export async function rebuildMirror(): Promise<{ written: number; ms: number }> {
  await enqueue(() => {
    st.db?.close();
    st.db = undefined;
    const file = mirrorPath();
    for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
  });
  st.started = true;
  return fullSync("rebuild");
}

export function mirrorReady(): boolean {
  return st.status === "ready" && Boolean(st.db);
}

/** 写しの書き込み用の接続 (検索に使う。読み込みだけ) */
export function mirrorDb(): SqliteDb | undefined {
  return st.status === "ready" ? st.db : undefined;
}

export interface MirrorStatus {
  path: string;
  exists: boolean;
  sizeBytes: number;
  status: MirrorState["status"];
  error?: string;
  syncedAt?: string;
  lastFull?: MirrorState["lastFull"];
  tables: { table: string; label: string; rows: number }[];
}

export function mirrorStatus(): MirrorStatus {
  const file = mirrorPath();
  let sizeBytes = 0;
  for (const f of [file, `${file}-wal`]) {
    try {
      sizeBytes += fs.statSync(f).size;
    } catch {
      /* まだない */
    }
  }
  const tables: MirrorStatus["tables"] = [];
  const db = st.db;
  if (db) {
    const count = (t: string) => {
      try {
        return Number(db.prepare(`select count(*) n from ${t}`).get()?.n ?? 0);
      } catch {
        return 0;
      }
    };
    for (const t of TABLES) tables.push({ table: t.table, label: t.label, rows: count(t.table) });
    tables.push({ table: "sales_orders", label: "分析用: 受注ごとの売上・種別の内訳・原価・担当者", rows: count("sales_orders") });
    tables.push({ table: "sales_items", label: "分析用: 明細 (商品・数量・単価・金額)", rows: count("sales_items") });
    tables.push({ table: "order_staff", label: "分析用: 受注と担当者", rows: count("order_staff") });
    tables.push({ table: "search_docs", label: "横断検索の索引", rows: count("search_docs") });
  }
  return { path: file, exists: fs.existsSync(file), sizeBytes, status: st.status, error: st.error, syncedAt: st.syncedAt, lastFull: st.lastFull, tables };
}
