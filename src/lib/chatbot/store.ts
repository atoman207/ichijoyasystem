import "server-only";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * チャットボットのデータベース (VPS 上の SQLite)
 * ------------------------------------------------------------
 * - 保存先: CHATBOT_DB_PATH。なければ本番サーバー (/srv/ichijoya がある) は /srv/ichijoya/data/chatbot.sqlite、
 *   それ以外は data/chatbot.sqlite。リリースのフォルダーの外に置くので、デプロイしても消えない。3000 番と 3001 番で同じファイルを使う
 * - qa: 質問と回答の組 (学習データ)。origin = seed (システムの説明から自動で作る) / generated (AI で言い換えを作った) /
 *   ai (実際の質問に AI が答えたもの) / manual (管理者が登録・修正)
 * - docs: 回答の根拠にするシステムの説明 (使い方・権限・画面・社内資料)。sources.ts から作り直す
 * - asks: 質問の記録 (どの方法で答えたか。AI の呼び出しをどれだけ減らせたかの集計に使う)
 * - chat_log: 相談の履歴 (ログインした社員の質問と回答・表・根拠。誰が・いつ・何を聞き、どう答えたか)。
 *   本人は自分の履歴を、管理者・本部は全員の履歴を検索できる (permissions.ts の canViewChatLog)。社内資料への登録 (knowledge_id) もここに残す
 * 日本語の検索は FTS5 の trigram (3 文字ずつの組) で候補を出し、2 文字の組の重なりで似ている度合いを測る
 * 個人情報: asks (利用状況の集計用) の質問は電話番号・メールアドレスを伏せて残す。相談の履歴は CHATBOT_LOG_RETENTION_DAYS 日
 * (既定 730 日) で消し、集計の表 (お客様の名前などを含む) は CHATBOT_LOG_TABLE_DAYS 日 (既定 90 日) で消す (purgeOldLogs。1 日 1 回)
 */

interface Statement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}
type SqliteModule = { DatabaseSync: new (file: string) => SqliteDb };

export type QaOrigin = "seed" | "generated" | "ai" | "manual";
export interface QaLink {
  label: string;
  href: string;
}
export interface QaRow {
  id: number;
  question: string;
  norm: string;
  answer: string;
  links: QaLink[];
  origin: QaOrigin;
  sourceKeys: string[];
  role: string;
  hits: number;
  up: number;
  down: number;
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface DocRow {
  key: string;
  title: string;
  body: string;
  href: string;
  kind: string;
  hash: string;
  trainedHash: string;
}

export function chatbotDbPath(): string {
  const env = process.env.CHATBOT_DB_PATH?.trim();
  if (env) return env;
  if (fs.existsSync("/srv/ichijoya")) return "/srv/ichijoya/data/chatbot.sqlite";
  return path.join(process.cwd(), "data", "chatbot.sqlite");
}

const g = globalThis as typeof globalThis & { __ichijoyaChatbotDb?: SqliteDb };

export function chatbotDb(): SqliteDb {
  if (g.__ichijoyaChatbotDb) return g.__ichijoyaChatbotDb;
  const file = chatbotDbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // バンドラーに node:sqlite を解決させない (Node の組み込みモジュールとして実行時に読む)
  const { DatabaseSync } = (process as unknown as { getBuiltinModule(id: string): SqliteModule }).getBuiltinModule("node:sqlite");
  const db = new DatabaseSync(file);
  db.exec(`
    pragma journal_mode = wal;
    pragma busy_timeout = 5000;
    pragma synchronous = normal;
    create table if not exists qa (
      id integer primary key,
      question text not null,
      norm text not null,
      answer text not null,
      links text not null default '[]',
      origin text not null,
      source_keys text not null default '',
      role text not null default '',
      hits integer not null default 0,
      up integer not null default 0,
      down integer not null default 0,
      disabled integer not null default 0,
      created_at text not null,
      updated_at text not null,
      unique (norm, role)
    );
    create index if not exists qa_origin on qa (origin);
    create virtual table if not exists qa_fts using fts5 (norm, content = 'qa', content_rowid = 'id', tokenize = 'trigram');
    create trigger if not exists qa_ai after insert on qa begin insert into qa_fts (rowid, norm) values (new.id, new.norm); end;
    create trigger if not exists qa_ad after delete on qa begin insert into qa_fts (qa_fts, rowid, norm) values ('delete', old.id, old.norm); end;
    create trigger if not exists qa_au after update of norm on qa begin
      insert into qa_fts (qa_fts, rowid, norm) values ('delete', old.id, old.norm);
      insert into qa_fts (rowid, norm) values (new.id, new.norm);
    end;
    create table if not exists docs (
      key text primary key,
      title text not null,
      body text not null,
      href text not null default '',
      kind text not null default '',
      hash text not null,
      trained_hash text not null default '',
      updated_at text not null
    );
    create virtual table if not exists docs_fts using fts5 (title, body, content = 'docs', content_rowid = 'rowid', tokenize = 'trigram');
    create trigger if not exists docs_ai after insert on docs begin insert into docs_fts (rowid, title, body) values (new.rowid, new.title, new.body); end;
    create trigger if not exists docs_ad after delete on docs begin insert into docs_fts (docs_fts, rowid, title, body) values ('delete', old.rowid, old.title, old.body); end;
    create trigger if not exists docs_au after update on docs begin
      insert into docs_fts (docs_fts, rowid, title, body) values ('delete', old.rowid, old.title, old.body);
      insert into docs_fts (rowid, title, body) values (new.rowid, new.title, new.body);
    end;
    create table if not exists asks (
      id integer primary key,
      at text not null,
      user_id text not null,
      role text not null,
      question text not null,
      source text not null,
      qa_id integer,
      ms integer not null default 0
    );
    create index if not exists asks_at on asks (at);
    create table if not exists meta (key text primary key, value text not null);
    create table if not exists chat_log (
      id integer primary key,
      conv_id text not null default '',
      at text not null,
      user_id text not null,
      user_name text not null default '',
      role text not null default '',
      store_id text not null default '',
      question text not null,
      answer text not null,
      source text not null,
      payload text not null default '{}',
      ms integer not null default 0,
      rating integer not null default 0,
      knowledge_id text
    );
    create index if not exists chat_log_user on chat_log (user_id, id);
    create index if not exists chat_log_at on chat_log (at);
    create virtual table if not exists chat_log_fts using fts5 (question, answer, content = 'chat_log', content_rowid = 'id', tokenize = 'trigram');
    create trigger if not exists chat_log_ai after insert on chat_log begin insert into chat_log_fts (rowid, question, answer) values (new.id, new.question, new.answer); end;
    create trigger if not exists chat_log_ad after delete on chat_log begin insert into chat_log_fts (chat_log_fts, rowid, question, answer) values ('delete', old.id, old.question, old.answer); end;
    create trigger if not exists chat_log_au after update of question, answer on chat_log begin
      insert into chat_log_fts (chat_log_fts, rowid, question, answer) values ('delete', old.id, old.question, old.answer);
      insert into chat_log_fts (rowid, question, answer) values (new.id, new.question, new.answer);
    end;
  `);
  g.__ichijoyaChatbotDb = db;
  return db;
}

/* ---------------- 文字列の正規化と似ている度合い ---------------- */

const PUNCT = /[\s、。，．,.!！?？・「」『』（）()［］[\]【】〈〉《》"'“”‘’…〜~:：;；\-ー―]+/g;
const TAIL = /(を|って|は|が|に|の)?(教えて(ください|下さい|くれ|ほしい|欲しい)?|知りたい(です)?|ください|下さい|でしょうか|ですか|ますか|ですかね|かな|か|ね|よ|です)$/;

/** 比べるための形: 全角半角・大文字小文字・記号・語尾 (教えてください・ですか など) の違いをなくす */
export function normalizeQuestion(q: string): string {
  let s = q.normalize("NFKC").toLowerCase().replace(PUNCT, "");
  for (let i = 0; i < 3; i++) {
    const t = s.replace(TAIL, "");
    if (t === s || t.length < 2) break;
    s = t;
  }
  return s;
}

function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  if (s.length === 1) out.add(s);
  for (let i = 0; i + 1 < s.length; i++) out.add(s.slice(i, i + 2));
  return out;
}

/** 2 文字の組の重なり (Dice 係数)。1 = 同じ */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const x = bigrams(a);
  const y = bigrams(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const t of x) if (y.has(t)) both++;
  return (2 * both) / (x.size + y.size);
}

/** FTS5 の MATCH に渡す式 (trigram の OR)。3 文字未満は undefined */
function trigramQuery(text: string, max = 40): string | undefined {
  const s = text.normalize("NFKC").toLowerCase().replace(PUNCT, " ");
  const grams = new Set<string>();
  for (const run of s.split(" ")) for (let i = 0; i + 3 <= run.length; i++) grams.add(run.slice(i, i + 3));
  if (!grams.size) return undefined;
  return [...grams].slice(0, max).map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

export const hashText = (s: string) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);
const now = () => new Date().toISOString();

/* ---------------- 質問と回答 ---------------- */

function toQa(r: Record<string, unknown>): QaRow {
  return {
    id: Number(r.id),
    question: String(r.question),
    norm: String(r.norm),
    answer: String(r.answer),
    links: (() => {
      try {
        return JSON.parse(String(r.links ?? "[]")) as QaLink[];
      } catch {
        return [];
      }
    })(),
    origin: String(r.origin) as QaOrigin,
    sourceKeys: String(r.source_keys ?? "").split(",").filter(Boolean),
    role: String(r.role ?? ""),
    hits: Number(r.hits ?? 0),
    up: Number(r.up ?? 0),
    down: Number(r.down ?? 0),
    disabled: Number(r.disabled ?? 0) === 1,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export interface QaMatch {
  qa: QaRow;
  score: number;
}

/** 似ている質問を探す (無効・評価の低いもの・ほかのロール向けの回答は除く) */
export function findSimilarQa(question: string, role: string, limit = 5): QaMatch[] {
  const db = chatbotDb();
  const norm = normalizeQuestion(question);
  if (!norm) return [];
  const usable = "disabled = 0 and (role = '' or role = ?) and down - up < 2";
  // 同じ質問 (正規化した形) は索引で直接引く (「の権限」のように多くの質問に出てくる言葉だと、候補の上限から漏れるため)
  const exact = db.prepare(`select * from qa where norm = ? and ${usable} order by role desc limit 1`).all(norm, role);
  const match = trigramQuery(norm);
  const rows = match
    ? db.prepare(`select qa.* from qa_fts join qa on qa.id = qa_fts.rowid where qa_fts match ? and ${usable.replace(/\b(disabled|role|down|up)\b/g, "qa.$1")} order by rank limit 200`).all(match, role)
    : db.prepare(`select * from qa where ${usable} and norm like ? limit 200`).all(role, `%${norm}%`);
  const seen = new Set<number>();
  return [...exact, ...rows]
    .map((r) => toQa(r))
    .filter((qa) => !seen.has(qa.id) && seen.add(qa.id))
    .map((qa) => ({ qa, score: similarity(norm, qa.norm) + (qa.origin === "manual" ? 0.03 : 0) + Math.min(qa.up, 5) * 0.005 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export interface NewQa {
  question: string;
  answer: string;
  links?: QaLink[];
  origin: QaOrigin;
  sourceKeys?: string[];
  role?: string;
}

/** 追加する。同じ質問 (正規化した形・ロール) があれば、manual は上書き、それ以外は追加しない。追加・更新した ID を返す */
export function insertQa(q: NewQa): number | undefined {
  const db = chatbotDb();
  const norm = normalizeQuestion(q.question);
  if (norm.length < 2 || !q.answer.trim()) return undefined;
  const role = q.role ?? "";
  const existing = db.prepare("select id, origin from qa where norm = ? and role = ?").get(norm, role);
  const t = now();
  if (existing) {
    // 人が登録・修正した回答は自動の回答で上書きしない
    if (q.origin === "manual" || (existing.origin !== "manual" && q.origin === "ai" && existing.origin !== "ai")) {
      db.prepare("update qa set question = ?, answer = ?, links = ?, origin = ?, source_keys = ?, disabled = 0, down = 0, updated_at = ? where id = ?").run(q.question, q.answer, JSON.stringify(q.links ?? []), q.origin, (q.sourceKeys ?? []).join(","), t, existing.id);
      return Number(existing.id);
    }
    return undefined;
  }
  const r = db.prepare("insert into qa (question, norm, answer, links, origin, source_keys, role, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(q.question, norm, q.answer, JSON.stringify(q.links ?? []), q.origin, (q.sourceKeys ?? []).join(","), role, t, t);
  return Number(r.lastInsertRowid);
}

export function insertManyQa(rows: NewQa[]): number {
  const db = chatbotDb();
  let n = 0;
  db.exec("begin");
  try {
    for (const r of rows) if (insertQa(r) !== undefined) n++;
    db.exec("commit");
  } catch (err) {
    db.exec("rollback");
    throw err;
  }
  return n;
}

export function getQa(id: number): QaRow | undefined {
  const r = chatbotDb().prepare("select * from qa where id = ?").get(id);
  return r ? toQa(r) : undefined;
}

export function updateQa(id: number, patch: { question?: string; answer?: string; disabled?: boolean }): void {
  const cur = getQa(id);
  if (!cur) return;
  const question = patch.question ?? cur.question;
  chatbotDb()
    .prepare("update qa set question = ?, norm = ?, answer = ?, disabled = ?, origin = 'manual', down = 0, updated_at = ? where id = ?")
    .run(question, normalizeQuestion(question), patch.answer ?? cur.answer, (patch.disabled ?? cur.disabled) ? 1 : 0, now(), id);
}

export function deleteQa(id: number): void {
  chatbotDb().prepare("delete from qa where id = ?").run(id);
}

export function countHit(id: number): void {
  chatbotDb().prepare("update qa set hits = hits + 1 where id = ?").run(id);
}

export function rateQa(id: number, good: boolean): void {
  chatbotDb().prepare(good ? "update qa set up = up + 1 where id = ?" : "update qa set down = down + 1 where id = ?").run(id);
}

export function listQa(opts: { q?: string; origin?: string; flagged?: boolean; limit?: number; offset?: number }): { rows: QaRow[]; total: number } {
  const db = chatbotDb();
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.q?.trim()) {
    where.push("(question like ? or answer like ?)");
    params.push(`%${opts.q.trim()}%`, `%${opts.q.trim()}%`);
  }
  if (opts.origin) {
    where.push("origin = ?");
    params.push(opts.origin);
  }
  if (opts.flagged) where.push("(down > 0 or disabled = 1)");
  const w = where.length ? `where ${where.join(" and ")}` : "";
  const total = Number(db.prepare(`select count(*) n from qa ${w}`).get(...params)?.n ?? 0);
  const rows = db.prepare(`select * from qa ${w} order by ${opts.flagged ? "down desc," : ""} hits desc, id desc limit ? offset ?`).all(...params, opts.limit ?? 50, opts.offset ?? 0).map(toQa);
  return { rows, total };
}

/* ---------------- 回答の根拠 (システムの説明) ---------------- */

export interface NewDoc {
  key: string;
  title: string;
  body: string;
  href?: string;
  kind: string;
}

/**
 * 根拠の資料を入れ替える。内容が変わった資料から作った AI の回答・言い換えは消す (古い説明で答えないように)。
 * 変わった資料の数を返す
 */
export function replaceDocs(docs: NewDoc[]): { changed: number; removed: number } {
  const db = chatbotDb();
  const current = new Map(db.prepare("select key, hash from docs").all().map((r) => [String(r.key), String(r.hash)]));
  const keep = new Set<string>();
  let changed = 0;
  let removed = 0;
  const t = now();
  db.exec("begin");
  try {
    for (const d of docs) {
      keep.add(d.key);
      const hash = hashText(`${d.title}\n${d.body}\n${d.href ?? ""}`);
      if (current.get(d.key) === hash) continue;
      changed++;
      if (current.has(d.key)) {
        db.prepare("update docs set title = ?, body = ?, href = ?, kind = ?, hash = ?, trained_hash = '', updated_at = ? where key = ?").run(d.title, d.body, d.href ?? "", d.kind, hash, t, d.key);
        forgetDerived(db, d.key);
      } else {
        db.prepare("insert into docs (key, title, body, href, kind, hash, updated_at) values (?, ?, ?, ?, ?, ?, ?)").run(d.key, d.title, d.body, d.href ?? "", d.kind, hash, t);
      }
    }
    for (const key of current.keys()) {
      if (keep.has(key)) continue;
      db.prepare("delete from docs where key = ?").run(key);
      forgetDerived(db, key);
      removed++;
    }
    db.exec("commit");
  } catch (err) {
    db.exec("rollback");
    throw err;
  }
  return { changed, removed };
}

function forgetDerived(db: SqliteDb, key: string) {
  db.prepare("delete from qa where origin in ('generated', 'ai') and (',' || source_keys || ',') like ?").run(`%,${key},%`);
}

function toDoc(r: Record<string, unknown>): DocRow {
  return { key: String(r.key), title: String(r.title), body: String(r.body), href: String(r.href ?? ""), kind: String(r.kind ?? ""), hash: String(r.hash), trainedHash: String(r.trained_hash ?? "") };
}

export function searchDocs(text: string, limit = 6): DocRow[] {
  const match = trigramQuery(text, 60);
  if (!match) return [];
  return chatbotDb()
    .prepare("select docs.* from docs_fts join docs on docs.rowid = docs_fts.rowid where docs_fts match ? order by bm25(docs_fts, 3.0, 1.0) limit ?")
    .all(match, limit)
    .map(toDoc);
}

export function allDocs(): DocRow[] {
  return chatbotDb().prepare("select * from docs order by kind, key").all().map(toDoc);
}

export function markTrained(key: string, hash: string): void {
  chatbotDb().prepare("update docs set trained_hash = ? where key = ?").run(hash, key);
}

/** seed (自動で作る質問) を作り直す */
export function replaceSeedQa(rows: NewQa[]): number {
  const db = chatbotDb();
  db.prepare("delete from qa where origin = 'seed'").run();
  return insertManyQa(rows.map((r) => ({ ...r, origin: "seed" as const })));
}

/* ---------------- 質問の記録・集計 ---------------- */

/** agent = AI アシスタントがデータを調べて回答 (検索・集計の道具を使う) / analysis = AI なしで集計の表を作った */
export type AskSource = "database" | "data" | "smalltalk" | "ai" | "agent" | "analysis" | "docs" | "none";

/** 電話番号・メールアドレスを伏せる (利用状況の記録に個人情報を残さない) */
export function maskPii(text: string): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[メール]")
    .replace(/(?<![\d-])(?:\+81[-\s]?|0)\d{1,4}[-‐－ー−\s]?\d{1,4}[-‐－ー−\s]?\d{3,4}(?![\d-])/g, (m) => (m.replace(/\D/g, "").length >= 10 ? "[電話番号]" : m))
    .replace(/[０-９]{2,4}[-‐－ー−][０-９]{2,4}[-‐－ー−][０-９]{3,4}/g, "[電話番号]");
}

export function logAsk(a: { userId: string; role: string; question: string; source: AskSource; qaId?: number; ms: number }): void {
  chatbotDb().prepare("insert into asks (at, user_id, role, question, source, qa_id, ms) values (?, ?, ?, ?, ?, ?, ?)").run(now(), a.userId, a.role, maskPii(a.question).slice(0, 500), a.source, a.qaId ?? null, a.ms);
}

/**
 * 古い記録を消す (1 日 1 回まで。insertChatLog から呼ぶ):
 * 相談の履歴は retentionDays 日、履歴の集計の表 (お客様の名前・金額の行) は tableDays 日、利用状況 (asks) は 400 日、
 * AI の呼び出しの記録 (ai_calls) は AI_CALLS_RETENTION_DAYS 日 (既定 400 日)
 */
export function purgeOldLogs(opts: { force?: boolean; retentionDays?: number; tableDays?: number } = {}): { logs: number; tables: number; asks: number } {
  const today = now().slice(0, 10);
  if (!opts.force && getMeta("purged_on") === today) return { logs: 0, tables: 0, asks: 0 };
  setMeta("purged_on", today);
  const db = chatbotDb();
  const days = (n: number) => new Date(Date.now() - n * 86400_000).toISOString();
  const retention = opts.retentionDays ?? (Number(process.env.CHATBOT_LOG_RETENTION_DAYS) || 730);
  const tableDays = opts.tableDays ?? (Number(process.env.CHATBOT_LOG_TABLE_DAYS) || 90);
  // 社内資料に登録した相談は、元の履歴として残す
  const logs = Number(db.prepare("delete from chat_log where at < ? and knowledge_id is null").run(days(retention)).changes);
  let tables = 0;
  for (const r of db.prepare("select id, payload from chat_log where at < ? and payload like '%\"tables\":[{%'").all(days(tableDays))) {
    try {
      const p = JSON.parse(String(r.payload)) as ChatLogPayload;
      if (!p.tables?.length) continue;
      p.tables = [];
      db.prepare("update chat_log set payload = ? where id = ?").run(JSON.stringify(p), r.id);
      tables++;
    } catch {
      /* 壊れた行 */
    }
  }
  const asks = Number(db.prepare("delete from asks where at < ?").run(days(400)).changes);
  // AI の呼び出しの記録 (monitor.ts。数だけで中身はない)
  try {
    db.prepare("delete from ai_calls where at < ?").run(days(Number(process.env.AI_CALLS_RETENTION_DAYS) || 400));
  } catch {
    /* まだ表がない */
  }
  return { logs, tables, asks };
}

/** その利用者が直近 minutes 分に AI で答えた回数 (使いすぎの防止) */
export function recentAiAsks(userId: string, minutes = 60): number {
  const since = new Date(Date.now() - minutes * 60_000).toISOString();
  return Number(chatbotDb().prepare("select count(*) n from asks where user_id = ? and source in ('ai', 'agent') and at >= ?").get(userId, since)?.n ?? 0);
}

export function getMeta(key: string): string | undefined {
  const r = chatbotDb().prepare("select value from meta where key = ?").get(key);
  return r ? String(r.value) : undefined;
}

export function setMeta(key: string, value: string): void {
  chatbotDb().prepare("insert into meta (key, value) values (?, ?) on conflict (key) do update set value = excluded.value").run(key, value);
}

export interface ChatbotStats {
  path: string;
  sizeBytes: number;
  qa: Record<QaOrigin, number> & { total: number; disabled: number };
  docs: { total: number; trained: number };
  asks: { days: number; total: number; bySource: Record<string, number>; aiRate: number };
  recentAi: { at: string; question: string }[];
  recentNone: { at: string; question: string }[];
}

export function chatbotStats(days = 30): ChatbotStats {
  const db = chatbotDb();
  const qa = { seed: 0, generated: 0, ai: 0, manual: 0, total: 0, disabled: 0 } as ChatbotStats["qa"];
  for (const r of db.prepare("select origin, count(*) n from qa group by origin").all()) qa[String(r.origin) as QaOrigin] = Number(r.n);
  qa.total = qa.seed + qa.generated + qa.ai + qa.manual;
  qa.disabled = Number(db.prepare("select count(*) n from qa where disabled = 1 or down - up >= 2").get()?.n ?? 0);
  const docsTotal = Number(db.prepare("select count(*) n from docs").get()?.n ?? 0);
  const trained = Number(db.prepare("select count(*) n from docs where trained_hash = hash").get()?.n ?? 0);
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const bySource: Record<string, number> = {};
  let total = 0;
  for (const r of db.prepare("select source, count(*) n from asks where at >= ? group by source").all(since)) {
    bySource[String(r.source)] = Number(r.n);
    total += Number(r.n);
  }
  const file = chatbotDbPath();
  let sizeBytes = 0;
  for (const f of [file, `${file}-wal`]) {
    try {
      sizeBytes += fs.statSync(f).size;
    } catch {
      /* まだない */
    }
  }
  const recent = (source: string) => db.prepare("select at, question from asks where source = ? order by id desc limit 15").all(source).map((r) => ({ at: String(r.at), question: String(r.question) }));
  return { path: file, sizeBytes, qa, docs: { total: docsTotal, trained }, asks: { days, total, bySource, aiRate: total ? (bySource.ai ?? 0) / total : 0 }, recentAi: recent("ai"), recentNone: recent("none") };
}

/* ---------------- 相談の履歴 ---------------- */

export interface ChatLogPayload {
  links?: QaLink[];
  /** 回答の根拠 (記録・資料・集計) */
  sources?: { label: string; href?: string; kind: string }[];
  /** 集計の表 (src/lib/assistant/analyze.ts の AnalysisResult) */
  tables?: unknown[];
  /** 使った道具 (名前と条件の要約) */
  tools?: { name: string; summary: string }[];
  provider?: string;
  /** 声で聞いた質問 (音声入力) */
  voice?: boolean;
  /** 回答の確かめの結果 (src/lib/assistant/guard.ts) */
  checks?: { issues: { kind: string; detail: string; severity: string }[]; retried: boolean; fixed: string[] };
  /** AI を使わなかった理由 (budget = 予算の上限 / outage = 障害 / error = 失敗 / limit = 1 時間の回数) */
  degraded?: string;
}

export interface ChatLogRow {
  id: number;
  convId: string;
  at: string;
  userId: string;
  userName: string;
  role: string;
  storeId: string;
  question: string;
  answer: string;
  source: string;
  payload: ChatLogPayload;
  ms: number;
  rating: number;
  knowledgeId?: string;
}

function toLog(r: Record<string, unknown>): ChatLogRow {
  let payload: ChatLogPayload = {};
  try {
    payload = JSON.parse(String(r.payload ?? "{}")) as ChatLogPayload;
  } catch {
    /* 壊れた行 */
  }
  return {
    id: Number(r.id),
    convId: String(r.conv_id ?? ""),
    at: String(r.at),
    userId: String(r.user_id),
    userName: String(r.user_name ?? ""),
    role: String(r.role ?? ""),
    storeId: String(r.store_id ?? ""),
    question: String(r.question),
    answer: String(r.answer),
    source: String(r.source),
    payload,
    ms: Number(r.ms ?? 0),
    rating: Number(r.rating ?? 0),
    knowledgeId: r.knowledge_id ? String(r.knowledge_id) : undefined,
  };
}

export function insertChatLog(x: { convId?: string; userId: string; userName: string; role: string; storeId: string; question: string; answer: string; source: string; payload: ChatLogPayload; ms: number }): number {
  try {
    purgeOldLogs();
  } catch (err) {
    console.warn("[chatbot] purge failed:", (err as Error).message);
  }
  const r = chatbotDb()
    .prepare("insert into chat_log (conv_id, at, user_id, user_name, role, store_id, question, answer, source, payload, ms) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run((x.convId ?? "").slice(0, 64), now(), x.userId, x.userName, x.role, x.storeId, x.question.slice(0, 2000), x.answer.slice(0, 20000), x.source, JSON.stringify(x.payload).slice(0, 400_000), x.ms);
  return Number(r.lastInsertRowid);
}

export function getChatLog(id: number): ChatLogRow | undefined {
  const r = chatbotDb().prepare("select * from chat_log where id = ?").get(id);
  return r ? toLog(r) : undefined;
}

export function rateChatLog(id: number, good: boolean): void {
  chatbotDb().prepare("update chat_log set rating = ? where id = ?").run(good ? 1 : -1, id);
}

export function markChatShared(id: number, knowledgeId: string): void {
  chatbotDb().prepare("update chat_log set knowledge_id = ? where id = ?").run(knowledgeId, id);
}

/**
 * 履歴の一覧・検索。scope で見られる範囲を絞る (all = 全員 / store = その店舗の社員 / self = 本人だけ)。
 * q は質問と回答の文字で探す (3 文字以上は全文検索、短いときは部分一致)
 */
export function listChatLogs(opts: { scope: "all" | "store" | "self"; userId: string; storeId?: string; filterUserId?: string; q?: string; limit?: number; offset?: number; onlyRated?: boolean }): { rows: ChatLogRow[]; total: number } {
  const db = chatbotDb();
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.scope === "self") {
    where.push("l.user_id = ?");
    args.push(opts.userId);
  } else if (opts.scope === "store") {
    where.push("(l.user_id = ? or l.store_id = ?)");
    args.push(opts.userId, opts.storeId ?? "");
  }
  if (opts.filterUserId) {
    where.push("l.user_id = ?");
    args.push(opts.filterUserId);
  }
  if (opts.onlyRated) where.push("l.rating > 0");
  const q = (opts.q ?? "").trim();
  let from = "chat_log l";
  if (q) {
    const match = trigramQuery(q);
    if (match && q.normalize("NFKC").replace(PUNCT, "").length >= 3) {
      from = "chat_log_fts f join chat_log l on l.id = f.rowid";
      where.push("chat_log_fts match ?");
      args.push(match.replace(/ OR /g, " AND "));
    } else {
      where.push("(l.question like ? or l.answer like ?)");
      args.push(`%${q}%`, `%${q}%`);
    }
  }
  const w = where.length ? `where ${where.join(" and ")}` : "";
  const total = Number(db.prepare(`select count(*) n from ${from} ${w}`).get(...args)?.n ?? 0);
  const rows = db.prepare(`select l.* from ${from} ${w} order by l.id desc limit ? offset ?`).all(...args, opts.limit ?? 50, opts.offset ?? 0).map(toLog);
  return { rows, total };
}
