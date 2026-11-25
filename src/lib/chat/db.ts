import "server-only";
import fs from "node:fs";
import path from "node:path";

/**
 * チャット (チャンネル・DM) のデータベース (VPS 上の SQLite)
 * ------------------------------------------------------------
 * - 保存先: CHAT_DB_PATH。なければ CHATBOT_DB_PATH と同じフォルダーの chat.sqlite (試験期間のテスト用のサーバー・
 *   試しのサーバーは自分のフォルダーを使う)、それもなければ本番サーバーは /srv/ichijoya/data/chat.sqlite、手元は data/chat.sqlite。
 *   3000 番と 3001 番で同じファイルを使う (変わった内容はファイルから直接読むので、別のサーバーの書き込みもすぐに見える)
 * - Supabase (業務のデータ) には入れない: メッセージの書き込み・既読の記録が多く、業務のデータの保存 (mutate は全データを比べて書く) を
 *   重くしないため。DM を AI の写し・引き継ぎの画面・データ台帳に出さないため (お客様の決定「管理者も DM を見られない」)
 * - 業務依頼は従来どおり threads (Supabase)。チャットのメッセージから作った業務依頼は task_links で結ぶ
 * - バックアップ: deploy/backup.sh が VACUUM INTO で毎日控える
 *
 * 表:
 *   meta (rev = 変更の通し番号。画面は rev より新しい行だけを読み直す)
 *   channels (追加したチャンネルと DM。全社・店舗・店長のチャンネルは店舗・社員から作るので行を持たない)
 *   messages (メッセージ。parent_id = スレッドの最初のメッセージ。important = 重要 (確認のお願い)、recipients = 確認する人)
 *   mentions (メンションの宛先を展開したもの: @名前・@店舗・@全員)、reactions、acks (重要メッセージの確認)
 *   reads (既読: key = チャンネルの ID / t:<スレッドの最初のメッセージ> / thread:<社内連絡のスレッド>)
 *   channel_prefs (チャンネルごとの通知)、prefs (通知音・プッシュ通知を使うか)
 *   (プッシュ通知の端末の登録は src/lib/notify/push.ts の push.sqlite。試験期間と本番で同じものを使う)
 *   uploads (送る前に預かった資料・写真)、task_links (業務依頼 → メッセージ)
 *   pins (チャンネルのピン留め)、saves (自分の「後で見る」)、stars (スター付きのチャンネル)、presence (最後に画面を開いていた時刻 = オンライン)、
 *   typing (入力中。数秒で消える)
 */

export interface Statement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}
export interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}
type SqliteModule = { DatabaseSync: new (file: string) => SqliteDb };

/**
 * 本番サーバーのデータのフォルダー (/srv/ichijoya/data)。画面のサーバー (next start = production / next dev = development) のときだけ。
 * テスト・道具のスクリプト (NODE_ENV なし) は本番のフォルダーを使わない (本物の端末に通知を送ったり、本番のチャットに書いたりしないように)
 */
export function serverDataDir(): string | null {
  const mode = process.env.NODE_ENV;
  if (mode !== "production" && mode !== "development") return null;
  return fs.existsSync("/srv/ichijoya/data") ? "/srv/ichijoya/data" : null;
}

export function chatDbPath(): string {
  const env = process.env.CHAT_DB_PATH?.trim();
  if (env) return env;
  const bot = process.env.CHATBOT_DB_PATH?.trim();
  if (bot) return path.join(path.dirname(bot), "chat.sqlite");
  const dir = serverDataDir();
  if (dir) return path.join(dir, "chat.sqlite");
  return path.join(process.cwd(), "data", "chat.sqlite");
}

const g = globalThis as typeof globalThis & { __ichijoyaChatDb?: { file: string; db: SqliteDb } };

const SCHEMA = `
  pragma journal_mode = wal;
  pragma busy_timeout = 5000;
  pragma synchronous = normal;
  create table if not exists meta (k text primary key, v text not null);
  insert or ignore into meta (k, v) values ('rev', '0');
  create table if not exists channels (
    id text primary key,
    kind text not null check (kind in ('custom', 'dm')),
    name text not null default '',
    topic text not null default '',
    members text not null default '[]',
    created_by text not null,
    created_at text not null,
    updated_at text not null,
    archived_at text,
    rev integer not null default 0
  );
  create table if not exists messages (
    id text primary key,
    channel_id text not null,
    parent_id text,
    user_id text not null,
    body text not null default '',
    at text not null,
    edited_at text,
    deleted_at text,
    deleted_by text,
    important integer not null default 0,
    recipients text not null default '[]',
    mention_all integer not null default 0,
    files text not null default '[]',
    links text not null default '[]',
    task_thread_id text,
    reply_count integer not null default 0,
    last_reply_at text,
    reply_users text not null default '[]',
    reminded_at text,
    rev integer not null
  );
  create index if not exists messages_channel on messages (channel_id, parent_id, at);
  create index if not exists messages_parent on messages (parent_id, at);
  create index if not exists messages_rev on messages (channel_id, rev);
  create index if not exists messages_important on messages (important, at);
  create table if not exists mentions (
    message_id text not null,
    user_id text not null,
    channel_id text not null,
    at text not null,
    primary key (message_id, user_id)
  );
  create index if not exists mentions_user on mentions (user_id, at);
  create table if not exists reactions (
    message_id text not null,
    user_id text not null,
    emoji text not null,
    at text not null,
    primary key (message_id, user_id, emoji)
  );
  create table if not exists acks (
    message_id text not null,
    user_id text not null,
    at text not null,
    primary key (message_id, user_id)
  );
  create table if not exists reads (
    user_id text not null,
    key text not null,
    at text not null,
    primary key (user_id, key)
  );
  create table if not exists channel_prefs (
    user_id text not null,
    channel_id text not null,
    notify text not null,
    primary key (user_id, channel_id)
  );
  create table if not exists prefs (
    user_id text primary key,
    sound integer not null default 1,
    push integer not null default 1,
    updated_at text not null
  );
  create table if not exists uploads (
    id text primary key,
    user_id text not null,
    channel_id text not null,
    meta text not null,
    key text not null,
    thumb_key text,
    created_at text not null,
    message_id text
  );
  create table if not exists task_links (
    thread_id text primary key,
    message_id text not null,
    channel_id text not null
  );
  create table if not exists pins (
    channel_id text not null,
    message_id text not null,
    user_id text not null,
    at text not null,
    primary key (channel_id, message_id)
  );
  create table if not exists saves (
    user_id text not null,
    message_id text not null,
    at text not null,
    primary key (user_id, message_id)
  );
  create table if not exists stars (
    user_id text not null,
    channel_id text not null,
    at text not null,
    primary key (user_id, channel_id)
  );
  create table if not exists presence (
    user_id text primary key,
    at text not null
  );
  create table if not exists typing (
    user_id text not null,
    key text not null,
    at text not null,
    primary key (user_id, key)
  );
`;

/** あとから足した列 (古い chat.sqlite にも足す) */
const COLUMNS: [table: string, column: string, ddl: string][] = [
  // 追加したチャンネルの公開範囲: public = 社員なら誰でも探して参加できる / private = メンバーだけ
  ["channels", "visibility", "text not null default 'private'"],
  // スレッドの返信を「チャンネルにも送信」した
  ["messages", "also_channel", "integer not null default 0"],
  // 共有 (転送) したメッセージの写し { channelId, messageId, userId, body, at, files }
  ["messages", "shared", "text"],
];

function ensureColumns(db: SqliteDb) {
  for (const [table, column, ddl] of COLUMNS) {
    const has = db.prepare(`pragma table_info(${table})`).all().some((r) => r.name === column);
    if (!has) db.exec(`alter table ${table} add column ${column} ${ddl}`);
  }
}

export function chatDb(): SqliteDb {
  const file = chatDbPath();
  if (g.__ichijoyaChatDb?.file === file) return g.__ichijoyaChatDb.db;
  g.__ichijoyaChatDb?.db.close();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // バンドラーに node:sqlite を解決させない (Node の組み込みモジュールとして実行時に読む)
  const { DatabaseSync } = (process as unknown as { getBuiltinModule(id: string): SqliteModule }).getBuiltinModule("node:sqlite");
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  ensureColumns(db);
  g.__ichijoyaChatDb = { file, db };
  return db;
}

/** 書き込みをまとめて 1 つの取引にする (ほかのサーバーと同時に書いても通し番号が重ならない) */
export function tx<T>(fn: (db: SqliteDb) => T): T {
  const db = chatDb();
  db.exec("begin immediate");
  try {
    const out = fn(db);
    db.exec("commit");
    return out;
  } catch (err) {
    try {
      db.exec("rollback");
    } catch {
      // すでに取り消されている
    }
    throw err;
  }
}

/** 変更の通し番号を 1 つ進める (tx の中で呼ぶ) */
export function nextRev(db: SqliteDb): number {
  const row = db.prepare("update meta set v = cast(v as integer) + 1 where k = 'rev' returning v").get();
  return Number(row?.v ?? 0);
}

export function currentRev(): number {
  return Number(chatDb().prepare("select v from meta where k = 'rev'").get()?.v ?? 0);
}

export function jsonArr<T = string>(v: unknown): T[] {
  if (typeof v !== "string" || !v) return [];
  try {
    const x = JSON.parse(v);
    return Array.isArray(x) ? (x as T[]) : [];
  } catch {
    return [];
  }
}

export const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** テスト用: 接続を閉じる (一時フォルダーを消す前に) */
export function closeChatDb() {
  g.__ichijoyaChatDb?.db.close();
  g.__ichijoyaChatDb = undefined;
}
