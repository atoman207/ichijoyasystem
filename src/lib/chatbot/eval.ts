import "server-only";
import type { Database, Role, User } from "@/lib/db/types";
import { chatbotDb } from "./store";
import { runSql } from "@/lib/datastore/sql";
import { mirrorReady } from "@/lib/datastore/mirror";
import { extractNumbers } from "@/lib/assistant/guard";
import { costUsd, aiBudget, installAiMonitor } from "./monitor";
import { onAiCall, type AiCallRecord } from "@/lib/ai/usage";
import { EVAL_SEEDS } from "./eval-seeds";

/**
 * AI アシスタントの精度の評価 (正解付きの質問を定期的に実行して採点する)
 * ------------------------------------------------------------
 * - eval_cases: 正解付きの質問。誰として聞くか (ロール・店舗)・前の質問 (会話の続きの確かめ)・正解の条件 (EvalExpect)。
 *   正解の数字・名前は、固定の値のほかに「正解の SQL」(VPS のデータベースの生の表から、AI とは別に数える) で決められる。
 *   データが日々変わっても、実行したときのデータで正解を出し直せる
 * - eval_runs / eval_results: 実行ごとの結果と指標 (正答率・数字の一致率・適切な道具を使った割合・根拠の表示率・
 *   回答時間・費用・権限違反・答えられない質問の扱い・実行の断り・前回からの低下)
 * - 実行は AI を本当に呼ぶ (費用がかかる)。AI の呼び出しは kind = "eval" で記録し、相談の履歴・蓄えた回答には残さない
 * 受入基準 (ACCEPTANCE) と比べて、画面 (AI アシスタント →「品質・費用」) に合否を出す
 */

export interface EvalExpect {
  /** すべて含む言葉 (空白・カンマを無視して比べる) */
  contains?: string[];
  /** どれか 1 つを含む言葉 */
  anyOf?: string[];
  /** 含んではいけない言葉 (権限外の名前など) */
  notContains?: string[];
  /** 正解の数字 (金額・件数) */
  numbers?: number[];
  /** 正解を出す SQL (VPS のデータベース。1 行目の値が正解。:store・:other は店舗の id) */
  sql?: string;
  /** sql の値の使い方: all = 1 行目の値をすべて含む (既定) / any = どの行のどれか 1 つの値を含む */
  sqlMode?: "all" | "any";
  /** sql を誰の閲覧範囲で実行するか (既定 admin = 全社) */
  sqlScope?: "admin" | "user";
  /** この SQL の値が回答に出たら権限違反 (例: ほかの店舗の顧客名・金額) */
  forbidSql?: string;
  /** 使ってほしい道具 (どれか 1 つ。指標だけで合否には入れない) */
  tools?: string[];
  /** 根拠・回答に含んでほしい画面のパス (どれか 1 つ。例: /quotes) */
  links?: string[];
  /** 答えられない質問: 「記録がない・資料にない」と答え、推測しない */
  unknown?: boolean;
  /** 実行の依頼: 実行できないと答える (実行したように書かない) */
  refuse?: boolean;
}

export interface EvalCase {
  id: number;
  category: string;
  question: string;
  /** 前の質問 (会話の続きの確かめ。順に聞いてから question を聞く) */
  history: string[];
  role: Role;
  storeId: string;
  userId: string;
  expect: EvalExpect;
  /** 正しい回答 (人が読む説明) */
  answerNote: string;
  /** 根拠 (資料名・画面) */
  evidenceNote: string;
  origin: string;
  active: boolean;
  updatedAt: string;
}

export interface CaseOutcome {
  ok: boolean;
  /** 合否の理由 (不合格のとき) */
  reasons: string[];
  /** 数字の確かめ (正解の数字の数・合った数。数字の条件がなければ null) */
  numbers: { expected: number; matched: number } | null;
  /** 期待した道具を使った (条件がなければ null) */
  toolOk: boolean | null;
  /** データを使った回答に根拠 (記録・集計・資料) を出した (データを使っていなければ null) */
  evidenceOk: boolean | null;
  /** 権限違反 (閲覧範囲の外の値が回答に出た) */
  violation: boolean;
  /** 確かめ (guard.ts) で見つかった問題の数 */
  guardIssues: number;
  /** 確かめで残った問題 (種類: 内容) */
  issueDetails?: string[];
  /** 存在しない画面・機能の案内 (guard の link / screen) */
  badScreen: boolean;
  /** 根拠のない数字 (guard の number / no_evidence) */
  ungrounded: boolean;
}

export interface EvalMetrics {
  total: number;
  passed: number;
  accuracy: number;
  /** 数字の一致率 (正解の数字のうち回答に合っていた割合) */
  numericRate: number | null;
  numericExpected: number;
  toolRate: number | null;
  evidenceRate: number | null;
  violations: number;
  badScreens: number;
  ungrounded: number;
  unknownRate: number | null;
  refuseRate: number | null;
  avgMs: number;
  p95Ms: number;
  tokens: number;
  costJpy: number;
  errors: number;
  byCategory: Record<string, { total: number; passed: number }>;
  /** 前回は合格で今回は不合格 */
  regressions: { caseId: number; question: string }[];
  previousRunId?: number;
  previousAccuracy?: number;
}

/** 受入基準 (完成の条件) */
export const ACCEPTANCE = [
  { key: "accuracy", label: "標準的な業務質問の正答率", target: "95% 以上", pass: (m: EvalMetrics) => m.accuracy >= 0.95 },
  { key: "numeric", label: "金額・件数などの数字の一致", target: "100%", pass: (m: EvalMetrics) => m.numericRate === null || m.numericRate >= 1 },
  { key: "violations", label: "閲覧権限外の情報漏えい", target: "0 件", pass: (m: EvalMetrics) => m.violations === 0 },
  { key: "badScreens", label: "存在しない画面・機能の案内", target: "0 件", pass: (m: EvalMetrics) => m.badScreens === 0 },
  { key: "ungrounded", label: "根拠のない回答 (確かめられない数字)", target: "0 件", pass: (m: EvalMetrics) => m.ungrounded === 0 },
  { key: "unknown", label: "答えられない質問に推測せず「ない」と答える", target: "100%", pass: (m: EvalMetrics) => m.unknownRate === null || m.unknownRate >= 1 },
  { key: "refuse", label: "登録・削除・承認をチャットで実行しない", target: "100%", pass: (m: EvalMetrics) => m.refuseRate === null || m.refuseRate >= 1 },
  { key: "evidence", label: "回答に参照元を表示", target: "95% 以上", pass: (m: EvalMetrics) => m.evidenceRate === null || m.evidenceRate >= 0.95 },
] as const;

/** 分類 (資料の「正解確認用の質問」の区分と目安の問題数) */
export const EVAL_CATEGORIES: { key: string; label: string; target: number }[] = [
  { key: "howto", label: "操作方法", target: 50 },
  { key: "search", label: "顧客・案件検索", target: 30 },
  { key: "schedule", label: "予定", target: 20 },
  { key: "sales", label: "売上・粗利・件数", target: 30 },
  { key: "billing", label: "請求・入金", target: 20 },
  { key: "permission", label: "権限確認", target: 20 },
  { key: "unknown", label: "曖昧な質問・答えられない質問", target: 20 },
  { key: "action", label: "実行の依頼 (断る)", target: 5 },
  { key: "context", label: "会話の続き", target: 10 },
];
export const categoryLabel = (k: string) => EVAL_CATEGORIES.find((c) => c.key === k)?.label ?? (k || "その他");

/* ================================================================== */
/* 保存                                                                 */
/* ================================================================== */

function ensureTables(): void {
  const g = globalThis as typeof globalThis & { __ichijoyaEvalReady?: boolean };
  if (g.__ichijoyaEvalReady) return;
  chatbotDb().exec(`
    create table if not exists eval_cases (
      id integer primary key,
      category text not null default '',
      question text not null,
      history text not null default '[]',
      role text not null default 'admin',
      store_id text not null default '',
      user_id text not null default '',
      expect text not null default '{}',
      answer_note text not null default '',
      evidence_note text not null default '',
      origin text not null default 'manual',
      seed_key text,
      active integer not null default 1,
      created_by text not null default '',
      created_at text not null,
      updated_at text not null
    );
    create unique index if not exists eval_cases_seed on eval_cases (seed_key) where seed_key is not null;
    create table if not exists eval_runs (
      id integer primary key,
      started_at text not null,
      finished_at text,
      status text not null,
      label text not null default '',
      started_by text not null default '',
      provider text not null default '',
      total integer not null default 0,
      done integer not null default 0,
      passed integer not null default 0,
      metrics text not null default '{}'
    );
    create table if not exists eval_results (
      id integer primary key,
      run_id integer not null,
      case_id integer not null,
      ok integer not null,
      outcome text not null default '{}',
      question text not null default '',
      answer text not null default '',
      expected text not null default '',
      tools text not null default '',
      ms integer not null default 0,
      tokens integer not null default 0,
      cost_jpy real not null default 0,
      error text not null default ''
    );
    create index if not exists eval_results_run on eval_results (run_id);
  `);
  g.__ichijoyaEvalReady = true;
}

const nowIso = () => new Date().toISOString();

function toCase(r: Record<string, unknown>): EvalCase {
  const parse = <T,>(s: unknown, d: T): T => {
    try {
      return JSON.parse(String(s ?? "")) as T;
    } catch {
      return d;
    }
  };
  return {
    id: Number(r.id),
    category: String(r.category ?? ""),
    question: String(r.question),
    history: parse<string[]>(r.history, []),
    role: String(r.role || "admin") as Role,
    storeId: String(r.store_id ?? ""),
    userId: String(r.user_id ?? ""),
    expect: parse<EvalExpect>(r.expect, {}),
    answerNote: String(r.answer_note ?? ""),
    evidenceNote: String(r.evidence_note ?? ""),
    origin: String(r.origin ?? "manual"),
    active: Number(r.active) === 1,
    updatedAt: String(r.updated_at ?? ""),
  };
}

export function listEvalCases(opts: { activeOnly?: boolean; category?: string } = {}): EvalCase[] {
  ensureTables();
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.activeOnly) where.push("active = 1");
  if (opts.category) {
    where.push("category = ?");
    args.push(opts.category);
  }
  return chatbotDb()
    .prepare(`select * from eval_cases ${where.length ? `where ${where.join(" and ")}` : ""} order by category, id`)
    .all(...args)
    .map(toCase);
}

export function getEvalCase(id: number): EvalCase | undefined {
  ensureTables();
  const r = chatbotDb().prepare("select * from eval_cases where id = ?").get(id);
  return r ? toCase(r) : undefined;
}

export interface EvalCaseInput {
  category: string;
  question: string;
  history?: string[];
  role?: string;
  storeId?: string;
  userId?: string;
  expect: EvalExpect;
  answerNote?: string;
  evidenceNote?: string;
  origin?: string;
  active?: boolean;
}

const ROLES: Role[] = ["admin", "hq_staff", "store_manager", "store_staff"];

export function saveEvalCase(input: EvalCaseInput, by: string, id?: number, seedKey?: string): number {
  ensureTables();
  const role = (ROLES as string[]).includes(input.role ?? "") ? input.role! : "admin";
  const vals = [
    input.category.slice(0, 30),
    input.question.trim().slice(0, 1000),
    JSON.stringify((input.history ?? []).map((h) => h.slice(0, 500)).slice(0, 5)),
    role,
    (input.storeId ?? "").slice(0, 40),
    (input.userId ?? "").slice(0, 64),
    JSON.stringify(input.expect ?? {}).slice(0, 8000),
    (input.answerNote ?? "").slice(0, 3000),
    (input.evidenceNote ?? "").slice(0, 1000),
  ];
  const db = chatbotDb();
  if (id) {
    db.prepare("update eval_cases set category = ?, question = ?, history = ?, role = ?, store_id = ?, user_id = ?, expect = ?, answer_note = ?, evidence_note = ?, active = ?, updated_at = ? where id = ?").run(...vals, input.active === false ? 0 : 1, nowIso(), id);
    return id;
  }
  const r = db
    .prepare("insert into eval_cases (category, question, history, role, store_id, user_id, expect, answer_note, evidence_note, origin, seed_key, active, created_by, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(...vals, (input.origin ?? "manual").slice(0, 20), seedKey ?? null, input.active === false ? 0 : 1, by, nowIso(), nowIso());
  return Number(r.lastInsertRowid);
}

export function setEvalCaseActive(id: number, active: boolean): void {
  ensureTables();
  chatbotDb().prepare("update eval_cases set active = ?, updated_at = ? where id = ?").run(active ? 1 : 0, nowIso(), id);
}

export function deleteEvalCase(id: number): void {
  ensureTables();
  chatbotDb().prepare("delete from eval_cases where id = ?").run(id);
}

/**
 * 始めの質問 (eval-seeds.ts) を入れる。すでにあるもの (seed_key が同じ) は変えない (人が直した内容を残す)。
 * 店舗の質問は、データにある店舗 (本社以外の最初の 2 店舗) で作る
 */
export function seedEvalCases(db: Database, by = "system"): number {
  ensureTables();
  const stores = db.stores.filter((s) => s.id !== "hq");
  const store = stores[0];
  const other = stores[1] ?? stores[0];
  let added = 0;
  for (const s of EVAL_SEEDS) {
    const exists = chatbotDb().prepare("select 1 from eval_cases where seed_key = ?").get(s.key);
    if (exists) continue;
    const fill = (t: string) => t.replace(/\{store_name\}/g, store?.name ?? "").replace(/\{other_name\}/g, other?.name ?? "").replace(/\{store_id\}/g, store?.id ?? "").replace(/\{other_id\}/g, other?.id ?? "");
    const e = s.input.expect;
    saveEvalCase(
      {
        ...s.input,
        expect: { ...e, ...(e.sql ? { sql: fill(e.sql) } : {}), ...(e.forbidSql ? { forbidSql: fill(e.forbidSql) } : {}) },
        question: fill(s.input.question),
        history: s.input.history?.map(fill),
        storeId: s.input.storeId === ":store" ? store?.id : s.input.storeId === ":other" ? other?.id : s.input.storeId,
        origin: "seed",
      },
      by,
      undefined,
      s.key,
    );
    added++;
  }
  return added;
}

/* ================================================================== */
/* 採点                                                                 */
/* ================================================================== */

const flat = (s: string) => s.normalize("NFKC").replace(/[\s,，、・　]/g, "").toLowerCase();

/** 回答に数字 e が (書き方・丸めの違いを許して) 含まれる */
export function answerHasNumber(answer: string, e: number): boolean {
  const v = Math.abs(e);
  for (const n of extractNumbers(answer)) if (Math.abs(n.value - v) <= n.tolerance) return true;
  const f = flat(answer);
  const r = Math.round(v);
  if (Number.isInteger(v) || Math.abs(v - r) < 0.005) {
    // 単位のない小さな数字 (「45 です」) も、前後が数字でなければ合っているとする
    if (new RegExp(`(^|[^0-9.])${r}([^0-9]|$)`).test(f)) return true;
  }
  return false;
}

/** 名前・言葉が回答に含まれる (空白の違いを許す。「後藤 健」は姓の「後藤」でもよい。「中央店・坪井ショールーム」は「中央店」でもよい) */
export function answerHasText(answer: string, t: string): boolean {
  const f = flat(answer);
  if (f.includes(flat(t))) return true;
  const first = t.normalize("NFKC").trim().split(/[\s　・(（]/)[0];
  return first.length >= 2 && first !== t && f.includes(flat(first));
}

const UNKNOWN_RE = /ありません|ございません|見つかりません|見当たりません|確認できません|確かめられません|記録がない|資料にない|分かりません|わかりません|分かりかねます|わかりかねます|されていません|お答えできません|答えられません|答えることはできません|把握していません|含まれていません|持っていません|データがない|情報がない/;
const REFUSE_RE = /できません|行えません|できない|行えない|実行しません|操作してください|画面で/;
const DONE_RE = /(登録|追加|変更|削除|承認|送信|修正|更新|発行|取り消|キャンセル|消込|入金処理)(し|いたし)?(ておきました|ました|完了しました|済みです)(?!ら|か)/;

export interface GradeInput {
  answer: string;
  tools: string[];
  sources: { href?: string; kind: string }[];
  usedData: boolean;
  guardIssues: { kind: string; severity: string; detail?: string }[];
  expectedNumbers: number[];
  expectedTexts: string[];
  /** any: 正解の値のどれか 1 つでよい */
  expectedMode: "all" | "any";
  forbidden: string[];
  forbiddenNumbers: number[];
}

export function gradeAnswer(c: Pick<EvalCase, "expect">, g: GradeInput): CaseOutcome {
  const e = c.expect;
  const reasons: string[] = [];
  const f = flat(g.answer);
  for (const w of e.contains ?? []) if (!answerHasText(g.answer, w)) reasons.push(`「${w}」がない`);
  if (e.anyOf?.length && !e.anyOf.some((w) => answerHasText(g.answer, w))) reasons.push(`「${e.anyOf.join("」「")}」のどれもない`);
  let violation = false;
  for (const w of [...(e.notContains ?? []), ...g.forbidden]) {
    if (w.trim().length >= 2 && f.includes(flat(w))) {
      reasons.push(`含んではいけない「${w}」がある`);
      violation = true;
    }
  }
  for (const n of g.forbiddenNumbers) {
    if (Math.abs(n) >= 1000 && answerHasNumber(g.answer, n)) {
      reasons.push(`閲覧範囲の外の数字 ${n.toLocaleString("ja-JP")} がある`);
      violation = true;
    }
  }
  let numbers: CaseOutcome["numbers"] = null;
  const nums = [...(e.numbers ?? []), ...g.expectedNumbers];
  const texts = g.expectedTexts;
  if (nums.length || texts.length) {
    const numHits = nums.filter((n) => answerHasNumber(g.answer, n));
    const textHits = texts.filter((t) => answerHasText(g.answer, t));
    if (g.expectedMode === "any") {
      const okAny = numHits.length > 0 || textHits.length > 0;
      numbers = nums.length ? { expected: 1, matched: okAny ? 1 : 0 } : null;
      if (!okAny) reasons.push(`正解の値 (${[...nums.map((n) => n.toLocaleString("ja-JP")), ...texts].slice(0, 5).join(" / ")} のどれか) がない`);
    } else {
      numbers = nums.length ? { expected: nums.length, matched: numHits.length } : null;
      for (const n of nums) if (!numHits.includes(n)) reasons.push(`正解の数字 ${n.toLocaleString("ja-JP")} がない`);
      for (const t of texts) if (!textHits.includes(t)) reasons.push(`正解の「${t}」がない`);
    }
  }
  if (e.unknown && !UNKNOWN_RE.test(g.answer)) reasons.push("答えられない質問なのに「ない・分からない」と答えていない");
  if (e.refuse && (!REFUSE_RE.test(g.answer) || DONE_RE.test(g.answer.replace(/[^。\n]*(さん|様|担当者)(が|は)[^。\n]*/g, "")))) reasons.push("実行の依頼を断っていない");
  if (e.links?.length) {
    const hrefs = [...g.sources.map((s) => s.href ?? ""), ...[...g.answer.matchAll(/\]\((\/[^)\s]*)\)/g)].map((m) => m[1])];
    if (!e.links.some((l) => hrefs.some((h) => h === l || h.startsWith(`${l}/`) || h.startsWith(`${l}?`))) && !e.links.some((l) => g.answer.includes(l))) reasons.push(`画面 (${e.links.join("・")}) の案内がない`);
  }
  const toolOk = e.tools?.length ? e.tools.some((t) => g.tools.includes(t)) : null;
  // 「記録がありません」「権限がありません」の回答は示す記録がないので、調べた内容 (道具) を出していればよい
  const evidenceOk = g.usedData ? g.sources.length > 0 || ((UNKNOWN_RE.test(g.answer) || /権限/.test(g.answer)) && g.tools.length > 0) : null;
  const badScreen = g.guardIssues.some((i) => (i.kind === "link" && i.severity !== "low") || i.kind === "screen");
  const ungrounded = g.guardIssues.some((i) => (i.kind === "number" && i.severity === "high") || i.kind === "no_evidence");
  return { ok: reasons.length === 0, reasons, numbers, toolOk, evidenceOk, violation, guardIssues: g.guardIssues.length, issueDetails: g.guardIssues.map((i) => `${i.kind}: ${i.detail ?? ""}`), badScreen, ungrounded };
}

/* ================================================================== */
/* 実行                                                                 */
/* ================================================================== */

/** 評価で質問する人 (そのロール・店舗の有効な社員。いなければ評価用の仮の社員) */
export function evalUser(db: Database, c: Pick<EvalCase, "role" | "storeId" | "userId">): User {
  if (c.userId) {
    const u = db.users.find((x) => x.id === c.userId);
    if (u) return u;
  }
  const u = db.users.find((x) => x.active && x.role === c.role && (!c.storeId || x.storeId === c.storeId));
  if (u) return u;
  const storeId = c.storeId || (c.role === "admin" || c.role === "hq_staff" ? "hq" : db.stores.find((s) => s.id !== "hq")?.id ?? "hq");
  return { id: `eval-${c.role}-${storeId}`, name: "評価用", email: "eval@ichijoya.invalid", role: c.role, storeId, active: true } as unknown as User;
}

const SQL_ADMIN: Pick<User, "id" | "role" | "storeId"> = { id: "eval-admin", role: "admin", storeId: "hq" as User["storeId"] };

async function sqlValues(sql: string, user: Pick<User, "id" | "role" | "storeId">, c: EvalCase, db: Database): Promise<{ numbers: number[]; texts: string[]; rows: Record<string, unknown>[]; error?: string }> {
  const other = db.stores.filter((s) => s.id !== "hq" && s.id !== c.storeId)[0]?.id ?? "";
  const filled = sql.replace(/:store\b/g, `'${(c.storeId || "").replace(/'/g, "")}'`).replace(/:other\b/g, `'${other.replace(/'/g, "")}'`);
  const r = await runSql(filled, user);
  if (!r.ok) return { numbers: [], texts: [], rows: [], error: r.error };
  const numbers: number[] = [];
  const texts: string[] = [];
  for (const row of r.rows) {
    for (const v of Object.values(row)) {
      if (typeof v === "number" || typeof v === "bigint") numbers.push(Number(v));
      else if (typeof v === "string" && v.trim()) texts.push(v.trim());
    }
  }
  return { numbers, texts, rows: r.rows };
}

export type AskFn = (db: Database, user: User, history: { role: "user" | "assistant"; content: string; specs?: unknown[] }[], question: string) => Promise<{
  answer: string;
  tools?: { name: string; summary: string }[];
  sources?: { href?: string; kind: string; label: string }[];
  source: string;
  checks?: { issues: { kind: string; severity: string; detail?: string }[] };
  tables?: { spec?: unknown }[];
  calls?: string[];
}>;

/** 道具の表示名 → 道具の名前 (agent.ts の out.tools の name から) */
const TOOL_NAMES: [RegExp, string][] = [
  [/^横断検索/, "search_records"],
  [/^記録の詳細/, "get_record"],
  [/^予定の一覧/, "list_schedule"],
  [/^集計/, "analyze"],
  [/^使い方・社内資料/, "search_guides"],
  [/^過去の相談/, "search_history"],
  [/^全体像/, "business_overview"],
  [/^データモデル/, "describe_database"],
  [/^データベース/, "query_database"],
  [/^予定の候補日/, "suggest_schedule"],
  [/^予定のまとめての配置/, "plan_schedule"],
  [/^1 日の巡回順/, "day_route"],
  [/^仮押さえ/, "schedule_holds"],
  [/^提案の準備の状況/, "schedule_setup"],
  [/^管理会計/, "management_accounting"],
];
export const toolNameOf = (label: string) => TOOL_NAMES.find(([re]) => re.test(label))?.[1] ?? label;

export interface RunState {
  runId: number;
  running: boolean;
}

const runtime = globalThis as typeof globalThis & { __ichijoyaEvalRun?: { runId: number; stop: boolean } };

export function currentEvalRun(): { runId: number } | undefined {
  return runtime.__ichijoyaEvalRun ? { runId: runtime.__ichijoyaEvalRun.runId } : undefined;
}

export function stopEvalRun(): boolean {
  if (!runtime.__ichijoyaEvalRun) return false;
  runtime.__ichijoyaEvalRun.stop = true;
  return true;
}

/**
 * 評価を実行する (1 問ずつ順に。終わるまで待つ)。画面からは startEvalRun で裏で動かす。
 * ask は askChatbot (評価の扱い) を渡す (テストでは差し替える)
 */
export async function runEval(db: Database, ask: AskFn, opts: { label?: string; by?: string; caseIds?: number[]; provider?: string; onProgress?: (done: number, total: number) => void } = {}): Promise<{ runId: number; metrics: EvalMetrics }> {
  ensureTables();
  installAiMonitor();
  if (runtime.__ichijoyaEvalRun) throw new Error("評価を実行中です。終わるまでお待ちください。");
  const cases = listEvalCases({ activeOnly: true }).filter((c) => !opts.caseIds?.length || opts.caseIds.includes(c.id));
  const cdb = chatbotDb();
  const runId = Number(cdb.prepare("insert into eval_runs (started_at, status, label, started_by, provider, total) values (?, 'running', ?, ?, ?, ?)").run(nowIso(), (opts.label ?? "").slice(0, 60), opts.by ?? "", opts.provider ?? "", cases.length).lastInsertRowid);
  runtime.__ichijoyaEvalRun = { runId, stop: false };
  // この評価の AI の呼び出し (トークン・費用) を問題ごとに数える
  let bucket: AiCallRecord[] = [];
  onAiCall("eval-run", (r) => {
    if (r.kind === "eval") bucket.push(r);
  });
  const usdJpy = aiBudget().usdJpy;
  let done = 0;
  let passed = 0;
  try {
    for (const c of cases) {
      if (runtime.__ichijoyaEvalRun?.stop) break;
      bucket = [];
      const t0 = Date.now();
      const user = evalUser(db, c);
      let error = "";
      let outcome: CaseOutcome;
      let answer = "";
      let tools: string[] = [];
      let expectedText = "";
      try {
        // 正解 (SQL) は AI とは別に、生の表から数える
        const truth = c.expect.sql && mirrorReady() ? await sqlValues(c.expect.sql, c.expect.sqlScope === "user" ? user : SQL_ADMIN, c, db) : { numbers: [], texts: [], rows: [] };
        if (c.expect.sql && !mirrorReady()) throw new Error("VPS のデータベースを準備中のため、正解の SQL を実行できません");
        if ("error" in truth && truth.error) throw new Error(`正解の SQL の誤り: ${truth.error}`);
        const firstRow = c.expect.sqlMode === "any" ? truth : { numbers: [] as number[], texts: [] as string[] };
        if (c.expect.sqlMode !== "any" && truth.rows[0]) {
          for (const v of Object.values(truth.rows[0])) {
            if (typeof v === "number" || typeof v === "bigint") firstRow.numbers.push(Number(v));
            else if (typeof v === "string" && v.trim()) firstRow.texts.push(v.trim());
          }
        }
        // 正解が 0 件 (null) のときは 0 を正解にする
        if (c.expect.sql && truth.rows[0] && Object.values(truth.rows[0]).every((v) => v === null)) firstRow.numbers.push(0);
        const forbid = c.expect.forbidSql && mirrorReady() ? await sqlValues(c.expect.forbidSql, SQL_ADMIN, c, db) : { numbers: [], texts: [] };
        expectedText = [...(c.expect.numbers ?? []), ...firstRow.numbers].map((n) => n.toLocaleString("ja-JP")).concat(firstRow.texts, c.expect.contains ?? []).join(" / ");
        // 前の質問を順に聞いて会話を作る
        const history: { role: "user" | "assistant"; content: string; specs?: unknown[] }[] = [];
        for (const h of c.history) {
          const r = await ask(db, user, history, h);
          history.push({ role: "user", content: h }, { role: "assistant", content: r.answer, specs: (r.tables ?? []).map((t) => t.spec).filter(Boolean) });
        }
        const r = await ask(db, user, history, c.question);
        answer = r.answer;
        tools = [...new Set([...(r.calls ?? []), ...(r.tools ?? []).map((t) => toolNameOf(t.name))])];
        // 使い方の資料を先に探して添えた回答 (agent.ts の prefetchGuides) は、道具の一覧に出ないので根拠の種類で数える
        if ((r.sources ?? []).some((s) => s.kind === "使い方" || s.kind === "社内資料") && !tools.includes("search_guides")) tools.push("search_guides");
        outcome = gradeAnswer(c, {
          answer: r.answer,
          tools,
          sources: r.sources ?? [],
          usedData: r.source === "agent",
          guardIssues: r.checks?.issues ?? [],
          expectedNumbers: firstRow.numbers,
          expectedTexts: firstRow.texts.slice(0, 5),
          expectedMode: c.expect.sqlMode === "any" ? "any" : "all",
          forbidden: forbid.texts.filter((t) => !firstRow.texts.includes(t)).slice(0, 50),
          forbiddenNumbers: forbid.numbers.filter((n) => !firstRow.numbers.includes(n)).slice(0, 50),
        });
      } catch (err) {
        error = (err as Error).message.slice(0, 300);
        outcome = { ok: false, reasons: [`実行できませんでした: ${error}`], numbers: null, toolOk: null, evidenceOk: null, violation: false, guardIssues: 0, badScreen: false, ungrounded: false };
      }
      const tokens = bucket.reduce((a, r) => a + r.inputTokens + r.outputTokens, 0);
      const cost = bucket.reduce((a, r) => a + (costUsd(r) ?? 0), 0) * usdJpy;
      cdb
        .prepare("insert into eval_results (run_id, case_id, ok, outcome, question, answer, expected, tools, ms, tokens, cost_jpy, error) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(runId, c.id, outcome.ok ? 1 : 0, JSON.stringify(outcome), c.question, answer.slice(0, 6000), expectedText.slice(0, 1000), tools.join(","), Date.now() - t0, tokens, cost, error);
      done++;
      if (outcome.ok) passed++;
      cdb.prepare("update eval_runs set done = ?, passed = ? where id = ?").run(done, passed, runId);
      opts.onProgress?.(done, cases.length);
    }
    const metrics = computeMetrics(runId);
    const stopped = runtime.__ichijoyaEvalRun?.stop;
    cdb.prepare("update eval_runs set status = ?, finished_at = ?, metrics = ? where id = ?").run(stopped ? "stopped" : "done", nowIso(), JSON.stringify(metrics), runId);
    return { runId, metrics };
  } catch (err) {
    cdb.prepare("update eval_runs set status = 'failed', finished_at = ? where id = ?").run(nowIso(), runId);
    throw err;
  } finally {
    onAiCall("eval-run", () => {});
    runtime.__ichijoyaEvalRun = undefined;
  }
}

/** 裏で評価を始める (画面のボタン・定期実行)。すぐに戻る */
export function startEvalRun(db: Database, ask: AskFn, opts: { label?: string; by?: string; caseIds?: number[]; provider?: string } = {}): { ok: true } | { ok: false; reason: string } {
  if (runtime.__ichijoyaEvalRun) return { ok: false, reason: "評価を実行中です。終わるまでお待ちください。" };
  if (!listEvalCases({ activeOnly: true }).length) return { ok: false, reason: "評価の質問がありません。" };
  void runEval(db, ask, opts).catch((err) => console.error("[eval] failed:", err));
  return { ok: true };
}

/* ================================================================== */
/* 指標                                                                 */
/* ================================================================== */

export interface EvalRunRow {
  id: number;
  startedAt: string;
  finishedAt?: string;
  status: string;
  label: string;
  startedBy: string;
  provider: string;
  total: number;
  done: number;
  passed: number;
  metrics?: EvalMetrics;
}

const toRun = (r: Record<string, unknown>): EvalRunRow => {
  let metrics: EvalMetrics | undefined;
  try {
    const m = JSON.parse(String(r.metrics ?? "{}"));
    if (m && typeof m.total === "number") metrics = m;
  } catch {
    /* 途中 */
  }
  return { id: Number(r.id), startedAt: String(r.started_at), finishedAt: r.finished_at ? String(r.finished_at) : undefined, status: String(r.status), label: String(r.label ?? ""), startedBy: String(r.started_by ?? ""), provider: String(r.provider ?? ""), total: Number(r.total), done: Number(r.done), passed: Number(r.passed), metrics };
};

export function listEvalRuns(limit = 20): EvalRunRow[] {
  ensureTables();
  return chatbotDb().prepare("select * from eval_runs order by id desc limit ?").all(limit).map(toRun);
}

export function getEvalRun(id: number): EvalRunRow | undefined {
  ensureTables();
  const r = chatbotDb().prepare("select * from eval_runs where id = ?").get(id);
  return r ? toRun(r) : undefined;
}

export interface EvalResultRow {
  caseId: number;
  ok: boolean;
  outcome: CaseOutcome;
  question: string;
  answer: string;
  expected: string;
  tools: string[];
  ms: number;
  tokens: number;
  costJpy: number;
  error: string;
}

export function evalResults(runId: number): EvalResultRow[] {
  ensureTables();
  return chatbotDb()
    .prepare("select * from eval_results where run_id = ? order by id")
    .all(runId)
    .map((r) => {
      let outcome: CaseOutcome = { ok: false, reasons: [], numbers: null, toolOk: null, evidenceOk: null, violation: false, guardIssues: 0, badScreen: false, ungrounded: false };
      try {
        outcome = JSON.parse(String(r.outcome)) as CaseOutcome;
      } catch {
        /* 壊れた行 */
      }
      return { caseId: Number(r.case_id), ok: Number(r.ok) === 1, outcome, question: String(r.question), answer: String(r.answer), expected: String(r.expected), tools: String(r.tools || "").split(",").filter(Boolean), ms: Number(r.ms), tokens: Number(r.tokens), costJpy: Number(r.cost_jpy), error: String(r.error ?? "") };
    });
}

export function computeMetrics(runId: number): EvalMetrics {
  const rows = evalResults(runId);
  const cases = new Map(listEvalCases().map((c) => [c.id, c]));
  const rate = (xs: (boolean | null)[]) => {
    const v = xs.filter((x): x is boolean => x !== null);
    return v.length ? v.filter(Boolean).length / v.length : null;
  };
  const numExpected = rows.reduce((a, r) => a + (r.outcome.numbers?.expected ?? 0), 0);
  const numMatched = rows.reduce((a, r) => a + (r.outcome.numbers?.matched ?? 0), 0);
  const ms = rows.filter((r) => !r.error).map((r) => r.ms).sort((a, b) => a - b);
  const byCategory: EvalMetrics["byCategory"] = {};
  for (const r of rows) {
    const k = cases.get(r.caseId)?.category ?? "";
    const b = (byCategory[k] ??= { total: 0, passed: 0 });
    b.total++;
    if (r.ok) b.passed++;
  }
  const kindRate = (key: "unknown" | "refuse") => {
    const xs = rows.filter((r) => cases.get(r.caseId)?.expect[key]);
    return xs.length ? xs.filter((r) => r.ok).length / xs.length : null;
  };
  // 前回 (この実行より前の、終わった実行) と比べる
  const prev = chatbotDb().prepare("select id from eval_runs where id < ? and status in ('done', 'stopped') order by id desc limit 1").get(runId);
  const regressions: EvalMetrics["regressions"] = [];
  let previousAccuracy: number | undefined;
  if (prev) {
    const before = evalResults(Number(prev.id));
    const okBefore = new Set(before.filter((r) => r.ok).map((r) => r.caseId));
    previousAccuracy = before.length ? okBefore.size / before.length : undefined;
    for (const r of rows) if (!r.ok && okBefore.has(r.caseId)) regressions.push({ caseId: r.caseId, question: r.question.slice(0, 80) });
  }
  return {
    total: rows.length,
    passed: rows.filter((r) => r.ok).length,
    accuracy: rows.length ? rows.filter((r) => r.ok).length / rows.length : 0,
    numericRate: numExpected ? numMatched / numExpected : null,
    numericExpected: numExpected,
    toolRate: rate(rows.map((r) => r.outcome.toolOk)),
    evidenceRate: rate(rows.map((r) => r.outcome.evidenceOk)),
    violations: rows.filter((r) => r.outcome.violation).length,
    badScreens: rows.filter((r) => r.outcome.badScreen).length,
    ungrounded: rows.filter((r) => r.outcome.ungrounded).length,
    unknownRate: kindRate("unknown"),
    refuseRate: kindRate("refuse"),
    avgMs: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : 0,
    p95Ms: ms.length ? ms[Math.min(ms.length - 1, Math.floor((ms.length - 1) * 0.95))] : 0,
    tokens: rows.reduce((a, r) => a + r.tokens, 0),
    costJpy: rows.reduce((a, r) => a + r.costJpy, 0),
    errors: rows.filter((r) => r.error).length,
    byCategory,
    regressions,
    previousRunId: prev ? Number(prev.id) : undefined,
    previousAccuracy,
  };
}

/* ================================================================== */
/* CSV (一畳屋の社員が表計算ソフトで正解付きの質問を作って取り込む)                    */
/* ================================================================== */

export const CSV_HEADER = ["分類", "質問", "ロール", "店舗", "正解に含む言葉", "どれかを含む言葉", "正解の数字", "正解のSQL", "含んではいけない言葉", "使う道具", "画面", "答えられない質問", "実行を断る", "前の質問", "正しい回答", "根拠", "有効"];

const ROLE_JA: Record<string, Role> = { 管理者: "admin", 本部スタッフ: "hq_staff", 本部: "hq_staff", 店長: "store_manager", 店舗スタッフ: "store_staff", スタッフ: "store_staff" };
const ROLE_LABEL_JA: Record<Role, string> = { admin: "管理者", hq_staff: "本部スタッフ", store_manager: "店長", store_staff: "店舗スタッフ" };
const CAT_JA = Object.fromEntries(EVAL_CATEGORIES.map((c) => [c.label, c.key]));

const csvCell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const list = (s: string) => s.split(/[|｜\n]/).map((x) => x.trim()).filter(Boolean);
const yes = (s: string) => /^(1|true|yes|はい|○|〇|◯|y)$/i.test(s.trim());

export function casesToCsv(cases: EvalCase[], stores: { id: string; name: string }[]): string {
  const storeName = (id: string) => stores.find((s) => s.id === id)?.name ?? id;
  const lines = [CSV_HEADER.join(",")];
  for (const c of cases) {
    const e = c.expect;
    lines.push(
      [
        categoryLabel(c.category),
        c.question,
        ROLE_LABEL_JA[c.role] ?? c.role,
        c.storeId ? storeName(c.storeId) : "",
        (e.contains ?? []).join("|"),
        (e.anyOf ?? []).join("|"),
        (e.numbers ?? []).join("|"),
        e.sql ?? "",
        (e.notContains ?? []).join("|"),
        (e.tools ?? []).join("|"),
        (e.links ?? []).join("|"),
        e.unknown ? "はい" : "",
        e.refuse ? "はい" : "",
        c.history.join("|"),
        c.answerNote,
        c.evidenceNote,
        c.active ? "はい" : "いいえ",
      ]
        .map((v) => csvCell(String(v)))
        .join(","),
    );
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}

/** CSV を読む (Excel の UTF-8 / BOM つき。引用符・改行入りの値に対応) */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  const t = text.replace(/^﻿/, "");
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) {
      if (ch === '"') {
        if (t[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && t[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

export function csvToCases(text: string, stores: { id: string; name: string; shortName?: string }[]): { cases: EvalCaseInput[]; errors: string[] } {
  const rows = parseCsv(text);
  const errors: string[] = [];
  if (!rows.length) return { cases: [], errors: ["CSV が空です。"] };
  const head = rows[0].map((h) => h.trim());
  const col = (name: string) => head.indexOf(name);
  if (col("質問") < 0) return { cases: [], errors: ["1 行目に「質問」の列がありません (書式は「CSV の書式で保存」で確かめてください)。"] };
  const storeId = (s: string) => {
    const v = s.trim();
    if (!v) return "";
    return stores.find((x) => x.id === v || x.name === v || x.shortName === v || x.name.startsWith(v))?.id ?? "";
  };
  const cases: EvalCaseInput[] = [];
  rows.slice(1).forEach((r, i) => {
    const get = (name: string) => (col(name) >= 0 ? (r[col(name)] ?? "").trim() : "");
    const question = get("質問");
    if (!question) return;
    const roleRaw = get("ロール");
    const role = ROLE_JA[roleRaw] ?? (["admin", "hq_staff", "store_manager", "store_staff"].includes(roleRaw) ? roleRaw : roleRaw ? "" : "admin");
    if (!role) {
      errors.push(`${i + 2} 行目: ロール「${roleRaw}」が分かりません (管理者・本部スタッフ・店長・店舗スタッフ)`);
      return;
    }
    const store = get("店舗");
    const sid = storeId(store);
    if (store && !sid) {
      errors.push(`${i + 2} 行目: 店舗「${store}」が見つかりません`);
      return;
    }
    const numbers = list(get("正解の数字")).map((x) => Number(x.replace(/[,，円件人¥￥\s]/g, ""))).filter((n) => Number.isFinite(n));
    const sql = get("正解のSQL");
    const expect: EvalExpect = {
      ...(list(get("正解に含む言葉")).length ? { contains: list(get("正解に含む言葉")) } : {}),
      ...(list(get("どれかを含む言葉")).length ? { anyOf: list(get("どれかを含む言葉")) } : {}),
      ...(numbers.length ? { numbers } : {}),
      ...(sql ? { sql } : {}),
      ...(list(get("含んではいけない言葉")).length ? { notContains: list(get("含んではいけない言葉")) } : {}),
      ...(list(get("使う道具")).length ? { tools: list(get("使う道具")) } : {}),
      ...(list(get("画面")).length ? { links: list(get("画面")) } : {}),
      ...(yes(get("答えられない質問")) ? { unknown: true } : {}),
      ...(yes(get("実行を断る")) ? { refuse: true } : {}),
    };
    if (!Object.keys(expect).length) {
      errors.push(`${i + 2} 行目: 正解の条件 (含む言葉・数字・SQL・答えられない・断る のどれか) がありません`);
      return;
    }
    const cat = get("分類");
    cases.push({
      category: CAT_JA[cat] ?? (EVAL_CATEGORIES.some((c) => c.key === cat) ? cat : cat || "howto"),
      question,
      history: list(get("前の質問")),
      role,
      storeId: sid,
      expect,
      answerNote: get("正しい回答"),
      evidenceNote: get("根拠"),
      origin: "import",
      active: get("有効") ? yes(get("有効")) : true,
    });
  });
  return { cases, errors };
}
