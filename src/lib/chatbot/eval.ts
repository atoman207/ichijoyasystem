import "server-only";
import type { Database, Role, User } from "@/lib/db/types";
import { chatbotDb } from "./store";
import { runSql } from "@/lib/datastore/sql";
import { mirrorReady } from "@/lib/datastore/mirror";
import { extractNumbers } from "@/lib/assistant/guard";
import { costUsd, aiBudget, installAiMonitor } from "./monitor";
import { onAiCall, type AiCallRecord } from "@/lib/ai/usage";
import { EVAL_SEEDS } from "./eval-seeds";
import { forecast, type ForecastSubject } from "@/lib/assistant/forecast";
import { withAiContext } from "@/lib/ai/usage";
import { answerLinks, forbiddenSources, missingSources, scopeViolations } from "./eval-scope";
import { assistantReadUser, outOfScopeRefusal } from "@/lib/assistant/scope";
import fs from "node:fs";
import path from "node:path";

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
 * 2026-11 の追加:
 * - 対象 (expect.target): ask = 「質問する」(既定) / summary = 記録の要約 (summary.ts) / draft = 文書の作成 (draft.ts)
 * - 対象の記録を選ぶ SQL (expect.pick): 実行したときのデータから記録を 1 件選び、その列の値を {列名} で質問・正解・根拠に入れる (実際のデータの質問)
 * - 必要な根拠 (expect.sources) と出してはいけない根拠 (expect.forbidSources): 根拠のリンク (href の前方一致)
 * - どの質問でも、根拠のリンクが聞いた人の閲覧範囲の中かを確かめる (eval-scope.ts。外なら権限違反)
 * - ロールと店舗の組み合わせ (expect.matrix): 1 つの質問を、ロール × 店舗ごとの社員として聞く (全ロール・全店舗の確かめ)
 * - 代表シナリオ (representative) と、お客様の承認 (eval_signoffs: 評価の結果を見て承認した人・日時・版。版が変わる・代表シナリオが不合格になると再確認)
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
  /** 予測の質問: 予測の道具 (forecast.ts) で、今月から offset か月先 (0 = 今月・1 = 来月) の予測 (中心) を正解の数字にする */
  forecast?: { subject?: ForecastSubject; offset: number };
  /** 何を確かめるか: ask = 「質問する」(既定) / summary = 記録の要約 / draft = 文書の作成 */
  target?: EvalTarget;
  /** 要約の確かめ: 記録の種類・記録の ID ({列名} 可)・期間 (直近 days 日)・内容の区分 */
  summary?: { kind: string; id: string; days?: number; sections?: string[] };
  /** 文書の作成の確かめ: ひな形・形式・記録の番号 ({列名} 可)・要点 */
  draft?: { template: string; format: string; ref?: string; notes?: string };
  /** 対象の記録を選ぶ SQL (1 行目の列を {列名} で質問・正解・根拠に入れる。行がなければこの質問は「対象なし」で数えない) */
  pick?: string;
  /** pick を誰の閲覧範囲で実行するか (既定 admin = 全社。user = 聞く人の範囲) */
  pickScope?: "admin" | "user";
  /** pick の列のうち、値 (数字) を正解の数字にするもの */
  pickNumbers?: string[];
  /** 必要な根拠のリンク (すべて。href の前方一致。例: /knowledge/{id}・/orders/) */
  sources?: string[];
  /** 出してはいけない根拠のリンク (あれば権限違反) */
  forbidSources?: string[];
  /** ロールと店舗の組み合わせ (stores: own = 1 店舗 (既定) / all = 全店舗。管理者・本部は店舗なし) */
  matrix?: { roles: Role[]; stores?: "own" | "all" };
}

export type EvalTarget = "ask" | "summary" | "draft";
export const EVAL_TARGET_LABEL: Record<EvalTarget, string> = { ask: "質問する", summary: "要約", draft: "文書の作成" };

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
  /** 代表シナリオ (お客様が評価の結果を見て承認するもの) */
  representative: boolean;
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
  /** 必要な根拠のリンクがそろった (条件がなければ null) */
  sourcesOk?: boolean | null;
  /** 対象の記録がない (pick の行がない) ため数えない */
  skipped?: boolean;
  /** 出してはいけない値 (forbidSql) を、閲覧の範囲の設定でこの人も見られるため、正しい値を答えるかで確かめた */
  policyOpen?: boolean;
  /** 閲覧範囲の外の記録へのリンク */
  scopeViolations?: string[];
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
  /** 必要な根拠のリンクがそろった割合 */
  sourceRate?: number | null;
  /** ロール・店舗ごと (聞いた人) */
  byRole?: Record<string, { total: number; passed: number; violations: number }>;
  /** 対象ごと (質問する・要約・文書の作成) */
  byTarget?: Record<string, { total: number; passed: number }>;
  /** 対象の記録がなく数えなかった問題 */
  skipped?: number;
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
  { key: "sources", label: "必要な根拠のリンク (元の記録・資料)", target: "100%", pass: (m: EvalMetrics) => m.sourceRate === null || m.sourceRate === undefined || m.sourceRate >= 1 },
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
  { key: "knowledge", label: "社内資料 (マニュアル・議事録)", target: 20 },
  { key: "summary", label: "記録の要約", target: 10 },
  { key: "draft", label: "文書の作成", target: 10 },
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
    create table if not exists eval_signoffs (
      id integer primary key,
      run_id integer not null,
      signed_by text not null,
      signer_name text not null default '',
      signer_org text not null default '',
      comment text not null default '',
      scenarios text not null default '[]',
      metrics text not null default '{}',
      revision text not null default '',
      created_at text not null,
      revoked_at text,
      revoked_by text,
      revoke_reason text
    );
  `);
  // 列の追加 (2026-11: 代表シナリオ・聞いた人の組み合わせ・版)
  const cols = (t: string) => new Set(chatbotDb().prepare(`pragma table_info(${t})`).all().map((r) => String(r.name)));
  if (!cols("eval_cases").has("representative")) chatbotDb().exec("alter table eval_cases add column representative integer not null default 0");
  if (!cols("eval_results").has("variant")) chatbotDb().exec("alter table eval_results add column variant text not null default ''");
  if (!cols("eval_runs").has("revision")) chatbotDb().exec("alter table eval_runs add column revision text not null default ''");
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
    representative: Number(r.representative ?? 0) === 1,
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
  representative?: boolean;
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
    // 直した時刻は登録した時刻と必ず違える (seedEvalCases が「人が直していない」= 同じ時刻で見分ける)
    const row = db.prepare("select created_at from eval_cases where id = ?").get(id) as { created_at?: string } | undefined;
    let at = nowIso();
    if (row?.created_at === at) at = new Date(Date.parse(at) + 1).toISOString();
    db.prepare("update eval_cases set category = ?, question = ?, history = ?, role = ?, store_id = ?, user_id = ?, expect = ?, answer_note = ?, evidence_note = ?, active = ?, updated_at = ? where id = ?").run(...vals, input.active === false ? 0 : 1, at, id);
    if (input.representative !== undefined) setEvalCaseRepresentative(id, input.representative);
    return id;
  }
  const at = nowIso();
  const r = db
    .prepare("insert into eval_cases (category, question, history, role, store_id, user_id, expect, answer_note, evidence_note, origin, seed_key, active, created_by, created_at, updated_at, representative) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(...vals, (input.origin ?? "manual").slice(0, 20), seedKey ?? null, input.active === false ? 0 : 1, by, at, at, input.representative ? 1 : 0);
  return Number(r.lastInsertRowid);
}

export function setEvalCaseActive(id: number, active: boolean): void {
  ensureTables();
  chatbotDb().prepare("update eval_cases set active = ?, updated_at = ? where id = ?").run(active ? 1 : 0, nowIso(), id);
}

/** 代表シナリオ (お客様が承認するもの) にする・外す */
export function setEvalCaseRepresentative(id: number, on: boolean): void {
  ensureTables();
  chatbotDb().prepare("update eval_cases set representative = ?, updated_at = ? where id = ?").run(on ? 1 : 0, nowIso(), id);
}

export function deleteEvalCase(id: number): void {
  ensureTables();
  chatbotDb().prepare("delete from eval_cases where id = ?").run(id);
}

/**
 * 始めの質問 (eval-seeds.ts) を入れる。すでにあるもの (seed_key が同じ) は変えない (人が直した内容を残す)。
 * 店舗の質問は、データにある店舗 (本部以外の最初の 2 店舗) で作る
 */
export function seedEvalCases(db: Database, by = "system"): number {
  ensureTables();
  const stores = db.stores.filter((s) => s.id !== "hq");
  const store = stores[0];
  const other = stores[1] ?? stores[0];
  let added = 0;
  const fill = (t: string) => t.replace(/\{store_name\}/g, store?.name ?? "").replace(/\{other_name\}/g, other?.name ?? "").replace(/\{store_id\}/g, store?.id ?? "").replace(/\{other_id\}/g, other?.id ?? "");
  for (const s of EVAL_SEEDS) {
    const e = s.input.expect;
    const input: EvalCaseInput = {
      ...s.input,
      expect: { ...e, ...(e.sql ? { sql: fill(e.sql) } : {}), ...(e.forbidSql ? { forbidSql: fill(e.forbidSql) } : {}), ...(e.pick ? { pick: fill(e.pick) } : {}) },
      question: fill(s.input.question),
      history: s.input.history?.map(fill),
      storeId: s.input.storeId === ":store" ? store?.id : s.input.storeId === ":other" ? other?.id : s.input.storeId,
      origin: "seed",
    };
    const exists = chatbotDb().prepare("select id, question, history, expect, answer_note, evidence_note, created_at, updated_at from eval_cases where seed_key = ?").get(s.key) as
      | { id: number; question: string; history: string; expect: string; answer_note: string; evidence_note: string; created_at: string; updated_at: string }
      | undefined;
    if (exists) {
      // 人が直していない質問 (登録したときのまま = 直した時刻と登録の時刻が同じ) は、始めの質問の新しい定義 (質問・前の質問・正解の条件・説明) にそろえる。
      // 人が直した質問は変えない。時刻は変えない (人が直していない印を残す)
      if (exists.updated_at !== exists.created_at) continue;
      const next = { question: input.question.trim().slice(0, 1000), history: JSON.stringify((input.history ?? []).map((h) => h.slice(0, 500)).slice(0, 5)), expect: JSON.stringify(input.expect ?? {}).slice(0, 8000), answer_note: (input.answerNote ?? "").slice(0, 3000), evidence_note: (input.evidenceNote ?? "").slice(0, 1000) };
      if (next.question !== exists.question || next.history !== exists.history || next.expect !== exists.expect || next.answer_note !== exists.answer_note || next.evidence_note !== exists.evidence_note) {
        chatbotDb().prepare("update eval_cases set question = ?, history = ?, expect = ?, answer_note = ?, evidence_note = ? where id = ?").run(next.question, next.history, next.expect, next.answer_note, next.evidence_note, exists.id);
      }
      continue;
    }
    saveEvalCase(input, by, undefined, s.key);
    added++;
  }
  return added;
}

/* ================================================================== */
/* 採点                                                                 */
/* ================================================================== */

// 会社の種類の書き方の違い (「(株)」「㈱」「株式会社」) は同じとみなす
const flat = (s: string) => s.normalize("NFKC").replace(/\(株\)|株式会社/g, "株").replace(/\(有\)|有限会社/g, "有").replace(/[\s,，、・　]/g, "").toLowerCase();

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
// 実行の確認のカード (actions.ts。利用者が「実行する」を押したときだけ実行される) を出した回答も、チャットでは実行していない
const REFUSE_RE = /できません|行えません|できない|行えない|実行しません|操作してください|画面で|確認のカード|確認カード|「実行する」/;
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
  /** 実行の確認のカードを出した (利用者が「実行する」を押すまで何も変わらない = チャットでは実行していない) */
  proposed?: boolean;
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
  if (e.refuse && ((!REFUSE_RE.test(g.answer) && !g.proposed) || DONE_RE.test(g.answer.replace(/[^。\n]*(さん|様|担当者)(が|は)[^。\n]*/g, "")))) reasons.push("実行の依頼を断っていない");
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

async function sqlValues(sql: string, user: Pick<User, "id" | "role" | "storeId">, storeId: string, db: Database): Promise<{ numbers: number[]; texts: string[]; rows: Record<string, unknown>[]; error?: string }> {
  const other = db.stores.filter((s) => s.id !== "hq" && s.id !== storeId)[0]?.id ?? "";
  const filled = sql.replace(/:store\b/g, `'${(storeId || "").replace(/'/g, "")}'`).replace(/:other\b/g, `'${other.replace(/'/g, "")}'`);
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

/**
 * 出してはいけない値 (forbidSql の値) を、聞いた人の閲覧範囲で決める。閲覧の範囲の設定 (access-policy.ts) は管理者が変えられるので、
 * 質問の作りを変えずに、そのときの設定どおりに確かめる:
 * - AI が「閲覧の権限の範囲外」と断る質問 (scope.ts の outOfScopeRefusal: 経営の数字が自店舗だけの設定) → 全社の値をすべて出してはいけない
 * - 同じ SQL を聞いた人の範囲 (reader = AI と同じ範囲) で実行して、全部の値が出る → 設定で見られる値。open = true (その値を正しく答えるかを確かめる)
 * - 一部だけ出る → 出ない値だけを出してはいけない
 */
export async function forbiddenValues(db: Database, user: User, reader: User, question: string, forbidSql: string | undefined, storeId: string): Promise<{ numbers: number[]; texts: string[]; open: boolean }> {
  if (!forbidSql || !mirrorReady()) return { numbers: [], texts: [], open: false };
  const all = await sqlValues(forbidSql, SQL_ADMIN, storeId, db);
  if (all.error) throw new Error(`出してはいけない値の SQL の誤り: ${all.error}`);
  if (!all.numbers.length && !all.texts.length) return { numbers: [], texts: [], open: false };
  if (outOfScopeRefusal(db, user, question)) return { numbers: all.numbers, texts: all.texts, open: false };
  const seen = await sqlValues(forbidSql, reader, storeId, db);
  if (seen.error) return { numbers: all.numbers, texts: all.texts, open: false };
  const nums = new Set(seen.numbers);
  const txt = new Set(seen.texts);
  const numbers = all.numbers.filter((n) => !nums.has(n));
  const texts = all.texts.filter((t) => !txt.has(t));
  if (!numbers.length && !texts.length) return { numbers: [...new Set(all.numbers)], texts: [...new Set(all.texts)], open: true };
  return { numbers, texts, open: false };
}

export type AskFn = (db: Database, user: User, history: { role: "user" | "assistant"; content: string; specs?: unknown[] }[], question: string) => Promise<{
  answer: string;
  tools?: { name: string; summary: string }[];
  sources?: { href?: string; kind: string; label: string }[];
  source: string;
  checks?: { issues: { kind: string; severity: string; detail?: string }[] };
  tables?: { spec?: unknown }[];
  calls?: string[];
  /** 実行の確認のカード (actions.ts) を出した数 */
  actions?: unknown[];
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
  [/^計算/, "calculate"],
  [/^予測/, "forecast"],
  [/^店舗間の売上の配分/, "store_split"],
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

/** 要約の確かめ (target = summary)。summary.ts の recordDigest → summarizeDigest を呼ぶ (eval-runners.ts) */
export type SummarizeFn = (db: Database, user: User, input: { kind: string; id: string; from?: string; to?: string; sections?: string[] }) => Promise<{ ok: boolean; text: string; sources: { href?: string; label: string }[]; record?: { href: string; label: string }; message?: string; provider?: string }>;
/** 文書の作成の確かめ (target = draft)。draft.ts の draftDocument を呼ぶ */
export type DraftFn = (db: Database, user: User, input: { template: string; format: string; ref?: string; notes?: string }) => Promise<{ ok: boolean; text: string; used?: { href: string; label: string }; message?: string; provider?: string }>;

export interface EvalRunners {
  summarize?: SummarizeFn;
  draft?: DraftFn;
}

/** 評価で聞く人 (ロール × 店舗の組み合わせ。組み合わせがなければ質問のロール・店舗の 1 人) */
export interface EvalVariant {
  label: string;
  user: User;
  storeId: string;
}

export function caseVariants(db: Database, c: Pick<EvalCase, "role" | "storeId" | "userId" | "expect">): EvalVariant[] {
  const storeLabel = (id: string) => db.stores.find((s) => s.id === id)?.shortName ?? id;
  const m = c.expect.matrix;
  if (!m?.roles?.length) {
    const u = evalUser(db, c);
    const sid = c.storeId || u.storeId;
    return [{ label: `${ROLE_LABEL_JA[u.role] ?? u.role}${u.role === "store_manager" || u.role === "store_staff" ? `・${storeLabel(sid)}` : ""}`, user: u, storeId: sid }];
  }
  const stores = db.stores.filter((s) => s.id !== "hq" && !s.closedOn && !s.mergedInto);
  const out: EvalVariant[] = [];
  for (const role of [...new Set(m.roles)].filter((r) => ROLES.includes(r))) {
    const storeRole = role === "store_manager" || role === "store_staff";
    const targets = !storeRole ? [""] : m.stores === "all" ? stores.map((s) => s.id) : [c.storeId || stores[0]?.id || ""];
    for (const sid of targets) {
      const u = evalUser(db, { role, storeId: sid, userId: "" });
      // 管理者・本部の :store は、質問の店舗 (なければ最初の店舗。対象の記録を選ぶ SQL の店舗をそろえる)
      out.push({ label: `${ROLE_LABEL_JA[role]}${storeRole ? `・${storeLabel(sid)}` : ""}`, user: u, storeId: storeRole ? sid : c.storeId || stores[0]?.id || u.storeId });
    }
  }
  return out;
}

/** {列名} を pick の行の値に置き換える (行にない名前はそのまま) */
export function fillPick(text: string, row: Record<string, unknown> | undefined): string {
  if (!row) return text;
  return text.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (m, k: string) => (k in row && row[k] !== null && row[k] !== undefined ? String(row[k]) : m));
}

/** 質問・正解・根拠の {列名} を埋めた質問 */
export function fillCase(c: EvalCase, row: Record<string, unknown> | undefined): EvalCase {
  if (!row) return c;
  const f = (t: string) => fillPick(t, row);
  const fl = (xs?: string[]) => xs?.map(f);
  const e = c.expect;
  return {
    ...c,
    question: f(c.question),
    history: c.history.map(f),
    expect: {
      ...e,
      contains: fl(e.contains),
      anyOf: fl(e.anyOf),
      notContains: fl(e.notContains),
      sources: fl(e.sources),
      forbidSources: fl(e.forbidSources),
      links: fl(e.links),
      sql: e.sql ? f(e.sql) : e.sql,
      forbidSql: e.forbidSql ? f(e.forbidSql) : e.forbidSql,
      numbers: [...(e.numbers ?? []), ...(e.pickNumbers ?? []).map((k) => Number(row[k])).filter((n) => Number.isFinite(n))],
      summary: e.summary ? { ...e.summary, id: f(e.summary.id) } : undefined,
      draft: e.draft ? { ...e.draft, ref: e.draft.ref ? f(e.draft.ref) : undefined, notes: e.draft.notes ? f(e.draft.notes) : undefined } : undefined,
    },
  };
}

const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** いま動いているアプリの版 (本番は /srv/ichijoya/current/REVISION。なければ ICHIJOYA_REVISION か "dev") */
export function currentRevision(): string {
  const env = process.env.ICHIJOYA_REVISION?.trim();
  if (env) return env.slice(0, 40);
  try {
    return fs.readFileSync(path.join(process.cwd(), "REVISION"), "utf8").trim().slice(0, 40) || "dev";
  } catch {
    return "dev";
  }
}

interface Reply {
  answer: string;
  tools: string[];
  sources: { href?: string; kind: string; label?: string }[];
  usedData: boolean;
  guardIssues: { kind: string; severity: string; detail?: string }[];
  proposed?: boolean;
}

/** 1 問 (1 人分) を実行して採点する */
async function runOne(db: Database, ask: AskFn, runners: EvalRunners, c0: EvalCase, v: EvalVariant): Promise<{ outcome: CaseOutcome; answer: string; tools: string[]; expectedText: string; question: string }> {
  const user = v.user;
  // 聞いた人の読み取りの範囲 (AI アシスタントと同じ: 閲覧の範囲の設定 access-policy.ts・AI の閲覧範囲 scope.ts)
  const reader = assistantReadUser(db, user);
  // 対象の記録を選ぶ (実行したときのデータから)
  let row: Record<string, unknown> | undefined;
  if (c0.expect.pick) {
    if (!mirrorReady()) throw new Error("VPS のデータベースを準備中のため、対象の記録を選べません");
    const p = await sqlValues(c0.expect.pick, c0.expect.pickScope === "user" ? reader : SQL_ADMIN, v.storeId, db);
    if (p.error) throw new Error(`対象を選ぶ SQL の誤り: ${p.error}`);
    row = p.rows[0];
    if (!row) return { outcome: { ok: false, skipped: true, reasons: ["対象の記録がないため数えません (データが増えたら確かめます)"], numbers: null, toolOk: null, evidenceOk: null, violation: false, guardIssues: 0, badScreen: false, ungrounded: false }, answer: "", tools: [], expectedText: "", question: c0.question };
  }
  const c = fillCase(c0, row);
  const e = c.expect;
  // 出してはいけない値 (forbidSql) は、閲覧の範囲の設定どおりに決める (設定は管理者が変えられる。既定は経営の数字・顧客情報とも全社員)
  const forbid = await forbiddenValues(db, user, reader, c.question, e.forbidSql, v.storeId);
  // 正解 (SQL) は AI とは別に、生の表から数える。設定でこの人も見られる値の質問は、その値が正解 (権限どおりに答えるか)
  const truth = forbid.open
    ? { numbers: forbid.numbers.slice(0, 10), texts: forbid.texts.slice(0, 5), rows: [] as Record<string, unknown>[] }
    : e.sql && mirrorReady()
      ? await sqlValues(e.sql, e.sqlScope === "user" ? reader : SQL_ADMIN, v.storeId, db)
      : { numbers: [], texts: [], rows: [] };
  if (e.sql && !mirrorReady()) throw new Error("VPS のデータベースを準備中のため、正解の SQL を実行できません");
  if ("error" in truth && truth.error) throw new Error(`正解の SQL の誤り: ${truth.error}`);
  // 設定で見られる値の質問: 数字はすべて (店舗別の一覧など)、名前だけのときはどれか 1 つ
  const mode: "all" | "any" = forbid.open ? (truth.numbers.length ? "all" : "any") : e.sqlMode === "any" ? "any" : "all";
  const firstRow = forbid.open ? { numbers: truth.numbers, texts: truth.numbers.length ? [] : truth.texts } : e.sqlMode === "any" ? truth : { numbers: [] as number[], texts: [] as string[] };
  if (!forbid.open && e.sqlMode !== "any" && truth.rows[0]) {
    for (const val of Object.values(truth.rows[0])) {
      if (typeof val === "number" || typeof val === "bigint") firstRow.numbers.push(Number(val));
      else if (typeof val === "string" && val.trim()) firstRow.texts.push(val.trim());
    }
  }
  // 正解が 0 件 (null) のときは 0 を正解にする
  if (e.sql && truth.rows[0] && Object.values(truth.rows[0]).every((x) => x === null)) firstRow.numbers.push(0);
  // 予測の質問: 予測の道具と同じ計算の、その月の予測 (中心) を正解にする
  if (e.forecast) {
    const off = Math.min(11, Math.max(0, Math.round(e.forecast.offset)));
    const f = forecast(db, user, { subject: e.forecast.subject, months: off + 1 });
    const fv = f.ok ? f.rows[off]?.forecast : null;
    if (typeof fv === "number") firstRow.numbers.push(fv);
    else throw new Error(`予測を計算できません: ${f.ok ? "行がありません" : f.error}`);
  }
  const expectedText = `${forbid.open ? "(閲覧の範囲の設定でこの人も見られる値) " : ""}${[...(e.numbers ?? []), ...firstRow.numbers].map((n) => n.toLocaleString("ja-JP")).concat(firstRow.texts, e.contains ?? [], (e.sources ?? []).map((x) => `根拠 ${x}`)).join(" / ")}`;
  const target: EvalTarget = e.target ?? "ask";
  let r: Reply;
  if (target === "summary") {
    if (!runners.summarize || !e.summary) throw new Error("要約の確かめの設定 (記録の種類と ID) がありません");
    const s = e.summary;
    const from = s.days ? dayKey(new Date(Date.now() - s.days * 86400000)) : undefined;
    const res = await withAiContext({ kind: "eval", userId: user.id }, () => runners.summarize!(db, user, { kind: s.kind, id: s.id, from, to: from ? dayKey(new Date()) : undefined, sections: s.sections }));
    r = { answer: res.ok ? res.text : (res.message ?? "要約できませんでした"), tools: ["summary"], sources: [...(res.ok && res.record ? [{ href: res.record.href, kind: "記録", label: res.record.label }] : []), ...res.sources.map((x) => ({ href: x.href, kind: "記録", label: x.label }))], usedData: res.ok, guardIssues: [] };
  } else if (target === "draft") {
    if (!runners.draft || !e.draft) throw new Error("文書の作成の確かめの設定 (ひな形と形式) がありません");
    const d = e.draft;
    const res = await withAiContext({ kind: "eval", userId: user.id }, () => runners.draft!(db, user, { template: d.template, format: d.format, ref: d.ref, notes: d.notes }));
    r = { answer: res.ok ? res.text : (res.message ?? "作成できませんでした"), tools: ["draft"], sources: res.ok && res.used ? [{ href: res.used.href, kind: "記録", label: res.used.label }] : [], usedData: Boolean(res.ok && d.ref), guardIssues: [] };
  } else {
    // 前の質問を順に聞いて会話を作る
    const history: { role: "user" | "assistant"; content: string; specs?: unknown[] }[] = [];
    for (const h of c.history) {
      const hr = await ask(db, user, history, h);
      history.push({ role: "user", content: h }, { role: "assistant", content: hr.answer, specs: (hr.tables ?? []).map((t) => t.spec).filter(Boolean) });
    }
    const ar = await ask(db, user, history, c.question);
    const tools = [...new Set([...(ar.calls ?? []), ...(ar.tools ?? []).map((t) => toolNameOf(t.name))])];
    // 使い方の資料を先に探して添えた回答 (agent.ts の prefetchGuides) は、道具の一覧に出ないので根拠の種類で数える
    if ((ar.sources ?? []).some((x) => x.kind === "使い方" || x.kind === "社内資料") && !tools.includes("search_guides")) tools.push("search_guides");
    r = { answer: ar.answer, tools, sources: ar.sources ?? [], usedData: ar.source === "agent", guardIssues: ar.checks?.issues ?? [], proposed: (ar.actions?.length ?? 0) > 0 };
  }
  const outcome = gradeAnswer(c, {
    answer: r.answer,
    tools: r.tools,
    sources: r.sources,
    usedData: r.usedData,
    guardIssues: r.guardIssues,
    expectedNumbers: firstRow.numbers,
    expectedTexts: firstRow.texts.slice(0, 5),
    expectedMode: mode,
    forbidden: forbid.open ? [] : forbid.texts.filter((t) => !firstRow.texts.includes(t)).slice(0, 50),
    forbiddenNumbers: forbid.open ? [] : forbid.numbers.filter((n) => !firstRow.numbers.includes(n)).slice(0, 50),
    proposed: r.proposed,
  });
  if (forbid.open) outcome.policyOpen = true;
  // 根拠のリンク: 閲覧範囲の中か・必要な根拠があるか・出してはいけない根拠がないか
  const hrefs = [...r.sources.map((x) => x.href), ...answerLinks(r.answer)];
  const outside = scopeViolations(db, user, hrefs);
  if (outside.length) {
    outcome.violation = true;
    outcome.scopeViolations = outside;
    outcome.reasons.push(`閲覧範囲の外の記録へのリンク: ${outside.slice(0, 3).join("・")}`);
  }
  const bad = forbiddenSources(e.forbidSources ?? [], hrefs);
  if (bad.length) {
    outcome.violation = true;
    outcome.reasons.push(`出してはいけない根拠がある: ${bad.join("・")}`);
  }
  if (e.sources?.length) {
    const missing = missingSources(e.sources, hrefs);
    outcome.sourcesOk = missing.length === 0;
    if (missing.length) outcome.reasons.push(`必要な根拠のリンクがない: ${missing.join("・")}`);
  } else outcome.sourcesOk = null;
  outcome.ok = outcome.reasons.length === 0;
  return { outcome, answer: r.answer, tools: r.tools, expectedText, question: c.question };
}

/**
 * 評価を実行する (1 問 × 聞く人ごとに順に。終わるまで待つ)。画面からは startEvalRun で裏で動かす。
 * ask は askChatbot (評価の扱い) を渡す (テストでは差し替える)。要約・文書の作成の確かめは runners (eval-runners.ts)
 */
export async function runEval(db: Database, ask: AskFn, opts: { label?: string; by?: string; caseIds?: number[]; provider?: string; runners?: EvalRunners; onProgress?: (done: number, total: number) => void } = {}): Promise<{ runId: number; metrics: EvalMetrics }> {
  ensureTables();
  installAiMonitor();
  if (runtime.__ichijoyaEvalRun) throw new Error("評価を実行中です。終わるまでお待ちください。");
  const cases = listEvalCases({ activeOnly: true }).filter((c) => !opts.caseIds?.length || opts.caseIds.includes(c.id));
  const jobs = cases.flatMap((c) => caseVariants(db, c).map((v) => ({ c, v })));
  const runners = opts.runners ?? {};
  const cdb = chatbotDb();
  // 途中で止まった評価 (デプロイ・再起動でアプリが止まった) は「実行中」のまま残るので、2 時間を過ぎたものは途中までの結果で「中断」にする
  for (const r of cdb.prepare("select id from eval_runs where status = 'running' and started_at < ?").all(new Date(Date.now() - 2 * 3600_000).toISOString()) as { id: number }[]) {
    cdb.prepare("update eval_runs set status = 'stopped', finished_at = ?, metrics = ? where id = ?").run(nowIso(), JSON.stringify(computeMetrics(r.id)), r.id);
  }
  const runId = Number(cdb.prepare("insert into eval_runs (started_at, status, label, started_by, provider, total, revision) values (?, 'running', ?, ?, ?, ?, ?)").run(nowIso(), (opts.label ?? "").slice(0, 60), opts.by ?? "", opts.provider ?? "", jobs.length, currentRevision()).lastInsertRowid);
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
    for (const { c, v } of jobs) {
      if (runtime.__ichijoyaEvalRun?.stop) break;
      bucket = [];
      const t0 = Date.now();
      let error = "";
      let outcome: CaseOutcome;
      let answer = "";
      let tools: string[] = [];
      let expectedText = "";
      let question = c.question;
      try {
        const r = await runOne(db, ask, runners, c, v);
        ({ outcome, answer, tools, expectedText, question } = r);
      } catch (err) {
        error = (err as Error).message.slice(0, 300);
        outcome = { ok: false, reasons: [`実行できませんでした: ${error}`], numbers: null, toolOk: null, evidenceOk: null, violation: false, guardIssues: 0, badScreen: false, ungrounded: false };
      }
      const tokens = bucket.reduce((a, r) => a + r.inputTokens + r.outputTokens, 0);
      const cost = bucket.reduce((a, r) => a + (costUsd(r) ?? 0), 0) * usdJpy;
      cdb
        .prepare("insert into eval_results (run_id, case_id, ok, outcome, question, answer, expected, tools, ms, tokens, cost_jpy, error, variant) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(runId, c.id, outcome.ok ? 1 : 0, JSON.stringify(outcome), question, answer.slice(0, 6000), expectedText.slice(0, 1000), tools.join(","), Date.now() - t0, tokens, cost, error, v.label);
      done++;
      if (outcome.ok) passed++;
      cdb.prepare("update eval_runs set done = ?, passed = ? where id = ?").run(done, passed, runId);
      opts.onProgress?.(done, jobs.length);
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

/** 裏で評価を始める (画面のボタン・定期実行・デプロイのあと)。すぐに戻る */
export function startEvalRun(db: Database, ask: AskFn, opts: { label?: string; by?: string; caseIds?: number[]; provider?: string; runners?: EvalRunners } = {}): { ok: true } | { ok: false; reason: string } {
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
  /** 評価したときのアプリの版 */
  revision: string;
}

const toRun = (r: Record<string, unknown>): EvalRunRow => {
  let metrics: EvalMetrics | undefined;
  try {
    const m = JSON.parse(String(r.metrics ?? "{}"));
    if (m && typeof m.total === "number") metrics = m;
  } catch {
    /* 途中 */
  }
  return { id: Number(r.id), startedAt: String(r.started_at), finishedAt: r.finished_at ? String(r.finished_at) : undefined, status: String(r.status), label: String(r.label ?? ""), startedBy: String(r.started_by ?? ""), provider: String(r.provider ?? ""), total: Number(r.total), done: Number(r.done), passed: Number(r.passed), metrics, revision: String(r.revision ?? "") };
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
  /** 聞いた人 (ロール・店舗) */
  variant: string;
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
      return { caseId: Number(r.case_id), variant: String(r.variant ?? ""), ok: Number(r.ok) === 1, outcome, question: String(r.question), answer: String(r.answer), expected: String(r.expected), tools: String(r.tools || "").split(",").filter(Boolean), ms: Number(r.ms), tokens: Number(r.tokens), costJpy: Number(r.cost_jpy), error: String(r.error ?? "") };
    });
}

export function computeMetrics(runId: number): EvalMetrics {
  const all = evalResults(runId);
  // 対象の記録がなく数えなかった問題は、指標に入れない
  const rows = all.filter((r) => !r.outcome.skipped);
  const cases = new Map(listEvalCases().map((c) => [c.id, c]));
  const rate = (xs: (boolean | null | undefined)[]) => {
    const v = xs.filter((x): x is boolean => x !== null && x !== undefined);
    return v.length ? v.filter(Boolean).length / v.length : null;
  };
  const numExpected = rows.reduce((a, r) => a + (r.outcome.numbers?.expected ?? 0), 0);
  const numMatched = rows.reduce((a, r) => a + (r.outcome.numbers?.matched ?? 0), 0);
  const ms = rows.filter((r) => !r.error).map((r) => r.ms).sort((a, b) => a - b);
  const byCategory: EvalMetrics["byCategory"] = {};
  const byRole: NonNullable<EvalMetrics["byRole"]> = {};
  const byTarget: NonNullable<EvalMetrics["byTarget"]> = {};
  for (const r of rows) {
    const c = cases.get(r.caseId);
    const k = c?.category ?? "";
    const b = (byCategory[k] ??= { total: 0, passed: 0 });
    b.total++;
    if (r.ok) b.passed++;
    const who = (byRole[r.variant || "-"] ??= { total: 0, passed: 0, violations: 0 });
    who.total++;
    if (r.ok) who.passed++;
    if (r.outcome.violation) who.violations++;
    const t = (byTarget[c?.expect.target ?? "ask"] ??= { total: 0, passed: 0 });
    t.total++;
    if (r.ok) t.passed++;
  }
  const kindRate = (key: "unknown" | "refuse") => {
    const xs = rows.filter((r) => cases.get(r.caseId)?.expect[key]);
    return xs.length ? xs.filter((r) => r.ok).length / xs.length : null;
  };
  // 前回 (この実行より前の、終わった実行) と比べる (同じ質問・同じ聞く人)
  const prev = chatbotDb().prepare("select id from eval_runs where id < ? and status in ('done', 'stopped') order by id desc limit 1").get(runId);
  const regressions: EvalMetrics["regressions"] = [];
  let previousAccuracy: number | undefined;
  if (prev) {
    const before = evalResults(Number(prev.id)).filter((r) => !r.outcome.skipped);
    const okBefore = new Set(before.filter((r) => r.ok).map((r) => `${r.caseId}|${r.variant}`));
    previousAccuracy = before.length ? okBefore.size / before.length : undefined;
    for (const r of rows) if (!r.ok && okBefore.has(`${r.caseId}|${r.variant}`)) regressions.push({ caseId: r.caseId, question: `${r.question.slice(0, 80)}${r.variant ? ` (${r.variant})` : ""}` });
  }
  return {
    total: rows.length,
    passed: rows.filter((r) => r.ok).length,
    accuracy: rows.length ? rows.filter((r) => r.ok).length / rows.length : 0,
    numericRate: numExpected ? numMatched / numExpected : null,
    numericExpected: numExpected,
    toolRate: rate(rows.map((r) => r.outcome.toolOk)),
    evidenceRate: rate(rows.map((r) => r.outcome.evidenceOk)),
    sourceRate: rate(rows.map((r) => r.outcome.sourcesOk)),
    violations: rows.filter((r) => r.outcome.violation).length,
    badScreens: rows.filter((r) => r.outcome.badScreen).length,
    ungrounded: rows.filter((r) => r.outcome.ungrounded).length,
    unknownRate: kindRate("unknown"),
    refuseRate: kindRate("refuse"),
    avgMs: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : 0,
    p95Ms: ms.length ? ms[Math.min(ms.length - 1, Math.floor((ms.length - 1) * 0.95))] : 0,
    tokens: all.reduce((a, r) => a + r.tokens, 0),
    costJpy: all.reduce((a, r) => a + r.costJpy, 0),
    errors: rows.filter((r) => r.error).length,
    byCategory,
    byRole,
    byTarget,
    skipped: all.length - rows.length,
    regressions,
    previousRunId: prev ? Number(prev.id) : undefined,
    previousAccuracy,
  };
}

/* ================================================================== */
/* お客様の承認 (代表シナリオ)                                              */
/* ================================================================== */

export interface SignoffScenario {
  caseId: number;
  variant: string;
  category: string;
  question: string;
  ok: boolean;
  answer: string;
  expected: string;
  answerNote: string;
}

export interface EvalSignoff {
  id: number;
  runId: number;
  signedBy: string;
  signerName: string;
  signerOrg: string;
  comment: string;
  scenarios: SignoffScenario[];
  metrics?: EvalMetrics;
  revision: string;
  createdAt: string;
  revokedAt?: string;
  revokedBy?: string;
  revokeReason?: string;
}

/** 評価の結果のうち、代表シナリオのもの */
export function representativeScenarios(runId: number): SignoffScenario[] {
  const cases = new Map(listEvalCases().map((c) => [c.id, c]));
  return evalResults(runId)
    .filter((r) => cases.get(r.caseId)?.representative)
    .map((r) => {
      const c = cases.get(r.caseId)!;
      return { caseId: r.caseId, variant: r.variant, category: c.category, question: r.question, ok: r.ok && !r.outcome.skipped, answer: r.answer, expected: r.expected, answerNote: c.answerNote };
    });
}

/** 承認できるか (評価が終わっている・代表シナリオがある・すべて合格・権限違反なし・今の代表シナリオがすべて評価に入っている) */
export function signoffReadiness(runId: number): { ok: boolean; reasons: string[]; scenarios: SignoffScenario[] } {
  const run = getEvalRun(runId);
  const reasons: string[] = [];
  if (!run) return { ok: false, reasons: ["評価が見つかりません。"], scenarios: [] };
  if (run.status !== "done") reasons.push("最後まで終わった評価だけ承認できます。");
  const scenarios = representativeScenarios(runId);
  if (!scenarios.length) reasons.push("この評価に代表シナリオがありません (正解付きの質問で「代表シナリオ」に印を付けてから評価してください)。");
  const failed = scenarios.filter((x) => !x.ok);
  if (failed.length) reasons.push(`代表シナリオのうち ${failed.length} 件が不合格です (合格してから承認してください)。`);
  const want = listEvalCases({ activeOnly: true }).filter((c) => c.representative).map((c) => c.id);
  const got = new Set(scenarios.map((x) => x.caseId));
  const missing = want.filter((id) => !got.has(id));
  if (missing.length) reasons.push(`代表シナリオ ${missing.length} 件がこの評価に入っていません (すべての分類で評価してください)。`);
  if (run.metrics?.violations) reasons.push(`この評価で権限違反が ${run.metrics.violations} 件あります。`);
  return { ok: reasons.length === 0, reasons, scenarios };
}

const toSignoff = (r: Record<string, unknown>): EvalSignoff => {
  const parse = <T,>(v: unknown, d: T): T => {
    try {
      return JSON.parse(String(v ?? "")) as T;
    } catch {
      return d;
    }
  };
  return {
    id: Number(r.id),
    runId: Number(r.run_id),
    signedBy: String(r.signed_by),
    signerName: String(r.signer_name ?? ""),
    signerOrg: String(r.signer_org ?? ""),
    comment: String(r.comment ?? ""),
    scenarios: parse<SignoffScenario[]>(r.scenarios, []),
    metrics: parse<EvalMetrics | undefined>(r.metrics, undefined),
    revision: String(r.revision ?? ""),
    createdAt: String(r.created_at),
    revokedAt: r.revoked_at ? String(r.revoked_at) : undefined,
    revokedBy: r.revoked_by ? String(r.revoked_by) : undefined,
    revokeReason: r.revoke_reason ? String(r.revoke_reason) : undefined,
  };
};

/** お客様の承認を記録する (承認できないときは理由の例外) */
export function createSignoff(runId: number, by: string, p: { signerName: string; signerOrg?: string; comment?: string }): number {
  ensureTables();
  const ready = signoffReadiness(runId);
  if (!ready.ok) throw new Error(ready.reasons.join(" "));
  if (!p.signerName.trim()) throw new Error("承認した方のお名前を入力してください。");
  const run = getEvalRun(runId)!;
  const r = chatbotDb()
    .prepare("insert into eval_signoffs (run_id, signed_by, signer_name, signer_org, comment, scenarios, metrics, revision, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(runId, by, p.signerName.trim().slice(0, 60), (p.signerOrg ?? "").trim().slice(0, 60), (p.comment ?? "").trim().slice(0, 2000), JSON.stringify(ready.scenarios.map((x) => ({ ...x, answer: x.answer.slice(0, 2000) }))), JSON.stringify(run.metrics ?? {}), run.revision || currentRevision(), nowIso());
  return Number(r.lastInsertRowid);
}

export function revokeSignoff(id: number, by: string, reason: string): void {
  ensureTables();
  chatbotDb().prepare("update eval_signoffs set revoked_at = ?, revoked_by = ?, revoke_reason = ? where id = ? and revoked_at is null").run(nowIso(), by, reason.slice(0, 500), id);
}

export function listSignoffs(limit = 10): EvalSignoff[] {
  ensureTables();
  return chatbotDb().prepare("select * from eval_signoffs order by id desc limit ?").all(limit).map(toSignoff);
}

export function getSignoff(id: number): EvalSignoff | undefined {
  ensureTables();
  const r = chatbotDb().prepare("select * from eval_signoffs where id = ?").get(id);
  return r ? toSignoff(r) : undefined;
}

/**
 * いまの承認の状態: 有効 / 要再確認 (承認のあとの評価で代表シナリオが不合格・代表シナリオが増えた・アプリの版が変わってまだ評価していない) / 未承認
 */
export function signoffStatus(): { state: "valid" | "recheck" | "none"; signoff?: EvalSignoff; reasons: string[] } {
  const s = listSignoffs(20).find((x) => !x.revokedAt);
  if (!s) return { state: "none", reasons: ["代表シナリオの承認はまだありません。"] };
  const reasons: string[] = [];
  const later = listEvalRuns(50).filter((r) => r.id > s.runId && r.status === "done");
  for (const r of later) {
    const bad = representativeScenarios(r.id).filter((x) => !x.ok);
    if (bad.length) {
      reasons.push(`承認のあとの評価 #${r.id} で、代表シナリオ ${bad.length} 件が不合格です。`);
      break;
    }
  }
  const signed = new Set(s.scenarios.map((x) => x.caseId));
  const added = listEvalCases({ activeOnly: true }).filter((c) => c.representative && !signed.has(c.id));
  if (added.length) reasons.push(`承認のあとに代表シナリオが ${added.length} 件増えました。`);
  const rev = currentRevision();
  if (rev !== "dev" && s.revision && rev !== s.revision && !later.some((r) => r.revision === rev)) reasons.push(`アプリの版が変わりました (承認 ${s.revision.slice(0, 7)} → いま ${rev.slice(0, 7)})。評価を実行して代表シナリオを確かめてください。`);
  return { state: reasons.length ? "recheck" : "valid", signoff: s, reasons };
}

/* ================================================================== */
/* CSV (一畳屋の社員が表計算ソフトで正解付きの質問を作って取り込む)                    */
/* ================================================================== */

export const CSV_HEADER = ["分類", "質問", "ロール", "店舗", "正解に含む言葉", "どれかを含む言葉", "正解の数字", "正解のSQL", "含んではいけない言葉", "使う道具", "画面", "答えられない質問", "実行を断る", "前の質問", "正しい回答", "根拠", "有効", "対象", "対象を選ぶSQL", "必要な根拠", "出してはいけない根拠", "ロールの組み合わせ", "要約・文書の設定", "代表シナリオ"];
const TARGET_JA: Record<string, EvalTarget> = { 質問する: "ask", 質問: "ask", 要約: "summary", 文書の作成: "draft", 文書: "draft" };

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
        EVAL_TARGET_LABEL[e.target ?? "ask"],
        e.pick ?? "",
        (e.sources ?? []).join("|"),
        (e.forbidSources ?? []).join("|"),
        e.matrix ? [...e.matrix.roles.map((r) => ROLE_LABEL_JA[r]), ...(e.matrix.stores === "all" ? ["全店舗"] : [])].join("|") : "",
        e.summary ? JSON.stringify(e.summary) : e.draft ? JSON.stringify(e.draft) : "",
        c.representative ? "はい" : "",
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
    const targetRaw = get("対象");
    const target = TARGET_JA[targetRaw] ?? (["ask", "summary", "draft"].includes(targetRaw) ? (targetRaw as EvalTarget) : targetRaw ? undefined : "ask");
    if (!target) {
      errors.push(`${i + 2} 行目: 対象「${targetRaw}」が分かりません (質問する・要約・文書の作成)`);
      return;
    }
    let setup: Record<string, unknown> | undefined;
    if (get("要約・文書の設定")) {
      try {
        setup = JSON.parse(get("要約・文書の設定"));
      } catch {
        errors.push(`${i + 2} 行目: 要約・文書の設定を JSON として読めません (例: {"kind":"order","id":"{id}"})`);
        return;
      }
    }
    if (target === "summary" && !(setup && typeof setup.kind === "string" && typeof setup.id === "string")) {
      errors.push(`${i + 2} 行目: 要約の確かめには「要約・文書の設定」に kind と id が必要です`);
      return;
    }
    if (target === "draft" && !(setup && typeof setup.template === "string" && typeof setup.format === "string")) {
      errors.push(`${i + 2} 行目: 文書の作成の確かめには「要約・文書の設定」に template と format が必要です`);
      return;
    }
    const mx = list(get("ロールの組み合わせ"));
    const mroles = mx.map((x) => ROLE_JA[x] ?? (ROLES.includes(x as Role) ? (x as Role) : undefined)).filter(Boolean) as Role[];
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
      ...(list(get("必要な根拠")).length ? { sources: list(get("必要な根拠")) } : {}),
      ...(list(get("出してはいけない根拠")).length ? { forbidSources: list(get("出してはいけない根拠")) } : {}),
    };
    const extra: EvalExpect = {
      ...(target !== "ask" ? { target } : {}),
      ...(target === "summary" ? { summary: setup as EvalExpect["summary"] } : {}),
      ...(target === "draft" ? { draft: setup as EvalExpect["draft"] } : {}),
      ...(get("対象を選ぶSQL") ? { pick: get("対象を選ぶSQL") } : {}),
      ...(mroles.length ? { matrix: { roles: mroles, stores: mx.includes("全店舗") ? ("all" as const) : ("own" as const) } } : {}),
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
      answerNote: get("正しい回答"),
      evidenceNote: get("根拠"),
      expect: { ...expect, ...extra },
      origin: "import",
      active: get("有効") ? yes(get("有効")) : true,
      representative: yes(get("代表シナリオ")),
    });
  });
  return { cases, errors };
}
