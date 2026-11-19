import "server-only";
import { chatbotDb, getMeta, setMeta } from "./store";
import { onAiCall, type AiCallRecord } from "@/lib/ai/usage";

/**
 * AI の利用状況の監視 (利用回数・トークン数・費用の見込み・応答時間・失敗) と、使いすぎ・障害のときの止め方
 * ------------------------------------------------------------
 * - ai_calls: AI の API の呼び出し 1 回ごとの記録 (目的・利用者・モデル・トークン・時間・失敗の種類)。質問や回答の中身は残さない
 * - 費用: トークン数 × モデルの単価 (米ドル / 100 万トークン)。単価は「品質・費用」の画面で設定する (既定は下の DEFAULT_PRICES。
 *   OpenAI・Anthropic の料金表で確かめて直す)。円は 為替 (既定 150 円) で換算
 * - 月の予算 (円) とトークンの上限: 超えたら AI を使わない答え方 (蓄えた回答・集計・資料) に切り替える (onExceed = fallback)。
 *   環境変数 AI_MONTHLY_BUDGET_JPY・AI_MONTHLY_TOKEN_LIMIT・AI_USD_JPY でも決められる (画面の設定が優先)
 * - 障害の遮断: AI アシスタントの呼び出しが続けて失敗したら、しばらく AI を呼ばずにすぐ AI なしで答える
 *   (利用者が毎回 50 秒待たされないように)。時間がたてば、次の質問でまた試す
 */

export interface AiPrice {
  /** 入力 (米ドル / 100 万トークン) */
  in: number;
  /** キャッシュから読んだ入力 (省略 = 入力と同じ) */
  cachedIn?: number;
  /** 出力 (米ドル / 100 万トークン) */
  out: number;
}

/** 既定の単価 (確かな分だけ。ない・違うときは画面で設定する) */
export const DEFAULT_PRICES: Record<string, AiPrice> = {
  "gpt-4.1-mini": { in: 0.4, cachedIn: 0.1, out: 1.6 },
  "gpt-4.1-nano": { in: 0.1, cachedIn: 0.025, out: 0.4 },
  "gpt-4.1": { in: 2, cachedIn: 0.5, out: 8 },
  "gpt-4o-mini": { in: 0.15, cachedIn: 0.075, out: 0.6 },
  "gpt-4o": { in: 2.5, cachedIn: 1.25, out: 10 },
  // 音声 (読み上げの出力・文字起こしの入力は音声のトークン。provider.ts が目安のトークン数で記録する)
  "gpt-4o-mini-tts": { in: 0.6, out: 12 },
  "gpt-4o-mini-transcribe": { in: 1.25, out: 5 },
  "gpt-4o-transcribe": { in: 2.5, out: 10 },
};

export interface AiBudget {
  /** 月の予算 (円。0 = 決めない) */
  monthlyJpy: number;
  /** 月のトークンの上限 (入力 + 出力。0 = 決めない) */
  monthlyTokens: number;
  /** 1 米ドル = 何円 */
  usdJpy: number;
  /** 超えたとき: fallback = AI を止めて AI なしで答える / warn = 画面に警告だけ出す */
  onExceed: "fallback" | "warn";
}

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : d);

function ensureTables(): void {
  const g = globalThis as typeof globalThis & { __ichijoyaAiCallsReady?: boolean };
  if (g.__ichijoyaAiCallsReady) return;
  chatbotDb().exec(`
    create table if not exists ai_calls (
      id integer primary key,
      at text not null,
      kind text not null,
      user_id text not null default '',
      provider text not null,
      model text not null,
      input_tokens integer not null default 0,
      output_tokens integer not null default 0,
      cached_tokens integer not null default 0,
      ms integer not null default 0,
      ok integer not null default 1,
      error text not null default ''
    );
    create index if not exists ai_calls_at on ai_calls (at);
  `);
  g.__ichijoyaAiCallsReady = true;
}

export function recordAiCall(r: AiCallRecord, at = new Date()): void {
  ensureTables();
  chatbotDb()
    .prepare("insert into ai_calls (at, kind, user_id, provider, model, input_tokens, output_tokens, cached_tokens, ms, ok, error) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(at.toISOString(), r.kind.slice(0, 20), (r.userId ?? "").slice(0, 64), r.provider.slice(0, 20), r.model.slice(0, 60), Math.round(r.inputTokens), Math.round(r.outputTokens), Math.round(r.cachedTokens), Math.round(r.ms), r.ok ? 1 : 0, (r.error ?? "").slice(0, 30));
  if (r.kind === "assistant" || r.kind === "guest") breakerCache.at = 0;
}

/** AI の呼び出しの記録を始める (サーバーの起動時・テスト・評価の始めに 1 回) */
export function installAiMonitor(): void {
  onAiCall("chatbot-monitor", monitorListener);
  try {
    ensureTables();
  } catch (err) {
    console.warn("[ai-monitor] table setup failed:", (err as Error).message);
  }
}

function monitorListener(r: AiCallRecord): void {
  try {
    recordAiCall(r);
  } catch (err) {
    console.warn("[ai-monitor] record failed:", (err as Error).message);
  }
}

/* ---------------- 単価・予算の設定 ---------------- */

export function aiPrices(): Record<string, AiPrice> {
  try {
    const saved = JSON.parse(getMeta("ai_prices") ?? "{}") as Record<string, AiPrice>;
    return { ...DEFAULT_PRICES, ...saved };
  } catch {
    return { ...DEFAULT_PRICES };
  }
}

export function saveAiPrices(prices: Record<string, AiPrice>): void {
  setMeta("ai_prices", JSON.stringify(prices));
}

/** モデルの単価 (gpt-4.1-2025-04-14 → gpt-4.1 のように、いちばん長く一致する名前) */
export function priceOf(model: string, prices = aiPrices()): AiPrice | undefined {
  const m = model.toLowerCase();
  const key = Object.keys(prices)
    .filter((k) => m === k.toLowerCase() || m.startsWith(`${k.toLowerCase()}-`))
    .sort((a, b) => b.length - a.length)[0];
  return key ? prices[key] : undefined;
}

export function costUsd(r: { model: string; inputTokens: number; outputTokens: number; cachedTokens: number }, prices = aiPrices()): number | undefined {
  const p = priceOf(r.model, prices);
  if (!p) return undefined;
  const fresh = Math.max(0, r.inputTokens - r.cachedTokens);
  return (fresh * p.in + r.cachedTokens * (p.cachedIn ?? p.in) + r.outputTokens * p.out) / 1_000_000;
}

export function aiBudget(): AiBudget {
  let saved: Partial<AiBudget> = {};
  try {
    saved = JSON.parse(getMeta("ai_budget") ?? "{}") as Partial<AiBudget>;
  } catch {
    /* 壊れた設定は使わない */
  }
  return {
    monthlyJpy: num(saved.monthlyJpy, Number(process.env.AI_MONTHLY_BUDGET_JPY) || 0),
    monthlyTokens: num(saved.monthlyTokens, Number(process.env.AI_MONTHLY_TOKEN_LIMIT) || 0),
    usdJpy: num(saved.usdJpy, Number(process.env.AI_USD_JPY) || 150) || 150,
    onExceed: saved.onExceed === "warn" ? "warn" : "fallback",
  };
}

export function saveAiBudget(b: AiBudget): void {
  setMeta("ai_budget", JSON.stringify(b));
}

/* ---------------- 集計 ---------------- */

interface CallRow {
  at: string;
  kind: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  ms: number;
  ok: number;
  error: string;
}

function rowsSince(sinceIso: string): CallRow[] {
  ensureTables();
  return chatbotDb()
    .prepare("select at, kind, model, input_tokens, output_tokens, cached_tokens, ms, ok, error from ai_calls where at >= ? order by id")
    .all(sinceIso)
    .map((r) => ({ at: String(r.at), kind: String(r.kind), model: String(r.model), input_tokens: Number(r.input_tokens), output_tokens: Number(r.output_tokens), cached_tokens: Number(r.cached_tokens), ms: Number(r.ms), ok: Number(r.ok), error: String(r.error ?? "") }));
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
};

export interface UsageSummary {
  from: string;
  calls: number;
  failures: number;
  failuresByCode: Record<string, number>;
  byKind: Record<string, { calls: number; tokens: number; costJpy: number }>;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costJpy: number;
  /** 単価が分からないモデル (費用に入っていない) */
  unpricedModels: string[];
  avgMs: number;
  p95Ms: number;
  daily: { day: string; calls: number; costJpy: number; failures: number }[];
}

export function summarizeCalls(rows: CallRow[], from: string, prices = aiPrices(), usdJpy = aiBudget().usdJpy): UsageSummary {
  const s: UsageSummary = { from, calls: 0, failures: 0, failuresByCode: {}, byKind: {}, inputTokens: 0, outputTokens: 0, cachedTokens: 0, costJpy: 0, unpricedModels: [], avgMs: 0, p95Ms: 0, daily: [] };
  const unpriced = new Set<string>();
  const days = new Map<string, { calls: number; costJpy: number; failures: number }>();
  const ms: number[] = [];
  for (const r of rows) {
    s.calls++;
    const usd = costUsd({ model: r.model, inputTokens: r.input_tokens, outputTokens: r.output_tokens, cachedTokens: r.cached_tokens }, prices);
    if (usd === undefined && r.input_tokens + r.output_tokens > 0) unpriced.add(r.model);
    const jpy = (usd ?? 0) * usdJpy;
    s.costJpy += jpy;
    s.inputTokens += r.input_tokens;
    s.outputTokens += r.output_tokens;
    s.cachedTokens += r.cached_tokens;
    const k = (s.byKind[r.kind] ??= { calls: 0, tokens: 0, costJpy: 0 });
    k.calls++;
    k.tokens += r.input_tokens + r.output_tokens;
    k.costJpy += jpy;
    if (!r.ok) {
      s.failures++;
      s.failuresByCode[r.error || "api"] = (s.failuresByCode[r.error || "api"] ?? 0) + 1;
    } else ms.push(r.ms);
    const day = new Date(r.at).toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
    const d = days.get(day) ?? { calls: 0, costJpy: 0, failures: 0 };
    d.calls++;
    d.costJpy += jpy;
    if (!r.ok) d.failures++;
    days.set(day, d);
  }
  s.avgMs = ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : 0;
  s.p95Ms = pct(ms, 0.95);
  s.unpricedModels = [...unpriced];
  s.daily = [...days.entries()].map(([day, d]) => ({ day, ...d }));
  return s;
}

export function aiUsageSummary(days = 30, now = new Date()): UsageSummary {
  const from = new Date(now.getTime() - days * 86400_000).toISOString();
  return summarizeCalls(rowsSince(from), from);
}

/** 今月 (日本時間の暦の月) の利用 */
export function monthUsage(now = new Date()): UsageSummary {
  const ym = now.toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" }).slice(0, 7);
  const from = new Date(`${ym}-01T00:00:00+09:00`).toISOString();
  return summarizeCalls(rowsSince(from), from);
}

export interface BudgetState {
  budget: AiBudget;
  costJpy: number;
  tokens: number;
  /** 予算・上限に対する割合 (大きいほう。決めていなければ 0) */
  ratio: number;
  exceeded: boolean;
  /** 超えたので AI を止めている */
  blocked: boolean;
}

export function budgetState(now = new Date()): BudgetState {
  const budget = aiBudget();
  const m = monthUsage(now);
  const tokens = m.inputTokens + m.outputTokens;
  const ratio = Math.max(budget.monthlyJpy ? m.costJpy / budget.monthlyJpy : 0, budget.monthlyTokens ? tokens / budget.monthlyTokens : 0);
  const exceeded = ratio >= 1;
  return { budget, costJpy: m.costJpy, tokens, ratio, exceeded, blocked: exceeded && budget.onExceed === "fallback" };
}

/* ---------------- 障害の遮断 ---------------- */

const breakerCache: { at: number; value: BreakerState } = { at: 0, value: { open: false } };

export interface BreakerState {
  open: boolean;
  /** いつまで AI を呼ばないか (ISO) */
  until?: string;
  reason?: string;
}

/** 長く続く失敗 (キー・残高) は長めに止める。混雑・時間切れ・通信は短く */
const LONG = new Set(["auth", "quota"]);
const SLOW = new Set(["timeout"]);
const COUNTED = new Set(["auth", "quota", "rate_limit", "timeout", "api", "unsupported"]);

export function breakerState(now = new Date()): BreakerState {
  if (Date.now() - breakerCache.at < 5_000) return breakerCache.value;
  ensureTables();
  const recent = chatbotDb()
    .prepare("select at, ok, error from ai_calls where kind in ('assistant', 'guest') order by id desc limit 3")
    .all()
    .map((r) => ({ at: String(r.at), ok: Number(r.ok) === 1, error: String(r.error ?? "") }));
  let value: BreakerState = { open: false };
  const fails = recent.filter((r) => !r.ok && COUNTED.has(r.error));
  const last = recent[0];
  if (last && !last.ok && COUNTED.has(last.error)) {
    const lastAt = new Date(last.at).getTime();
    const long = LONG.has(last.error) && fails.length >= 2;
    const trip = long || (recent.length === 3 && fails.length === 3) || (SLOW.has(last.error) && recent.slice(0, 2).every((r) => !r.ok && SLOW.has(r.error)));
    if (trip) {
      const minutes = long ? 30 : 3;
      const until = lastAt + minutes * 60_000;
      if (until > now.getTime()) value = { open: true, until: new Date(until).toISOString(), reason: last.error };
    }
  }
  breakerCache.at = Date.now();
  breakerCache.value = value;
  return value;
}

/** いま AI アシスタントで答えてよいか。だめなら利用者に見せる理由 */
export function aiAvailability(now = new Date()): { ok: true } | { ok: false; reason: "budget" | "outage"; message: string } {
  try {
    const b = budgetState(now);
    if (b.blocked) return { ok: false, reason: "budget", message: "今月の AI の利用の上限に達したため、AI を使わずに (蓄えた回答・集計・資料から) お答えします。" };
    const br = breakerState(now);
    if (br.open) return { ok: false, reason: "outage", message: "AI に接続できない状態が続いているため、しばらく AI を使わずに (蓄えた回答・集計・資料から) お答えします。" };
  } catch (err) {
    console.warn("[ai-monitor] availability check failed:", (err as Error).message);
  }
  return { ok: true };
}

/* ---------------- 回答の品質 (相談の履歴から) ---------------- */

export interface AnswerQuality {
  days: number;
  answers: number;
  /** AI アシスタントが答えた数 */
  agent: number;
  /** 確かめ (guard.ts) で問題が見つかった回答 */
  flagged: number;
  /** 確かめ直しをさせた回答 */
  retried: number;
  /** 直しても残り、注記・置き換えをした回答 */
  fixed: number;
  byIssue: Record<string, number>;
  /** AI を使わずに答えた (予算・障害・失敗・回数の上限) */
  degraded: Record<string, number>;
  up: number;
  down: number;
  avgMs: number;
  p95Ms: number;
}

export function answerQuality(days = 30): AnswerQuality {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const rows = chatbotDb()
    .prepare("select source, payload, rating, ms from chat_log where at >= ?")
    .all(since)
    .map((r) => ({ source: String(r.source), payload: String(r.payload ?? "{}"), rating: Number(r.rating ?? 0), ms: Number(r.ms ?? 0) }));
  const q: AnswerQuality = { days, answers: rows.length, agent: 0, flagged: 0, retried: 0, fixed: 0, byIssue: {}, degraded: {}, up: 0, down: 0, avgMs: 0, p95Ms: 0 };
  const ms: number[] = [];
  for (const r of rows) {
    if (r.source === "agent" || r.source === "ai") q.agent++;
    if (r.rating > 0) q.up++;
    if (r.rating < 0) q.down++;
    ms.push(r.ms);
    let p: { checks?: { issues?: { kind: string }[]; retried?: boolean; fixed?: string[] }; degraded?: string } = {};
    try {
      p = JSON.parse(r.payload);
    } catch {
      continue;
    }
    const issues = p.checks?.issues ?? [];
    if (issues.length) q.flagged++;
    if (p.checks?.retried) q.retried++;
    if (p.checks?.fixed?.length) q.fixed++;
    for (const i of issues) q.byIssue[i.kind] = (q.byIssue[i.kind] ?? 0) + 1;
    if (p.degraded) q.degraded[p.degraded] = (q.degraded[p.degraded] ?? 0) + 1;
  }
  q.avgMs = ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : 0;
  q.p95Ms = pct(ms, 0.95);
  return q;
}

/** 低評価 (👎) の回答・確かめで問題が残った回答 (新しい順) */
export function reviewQueue(limit = 30): { id: number; at: string; userName: string; role: string; question: string; answer: string; rating: number; issues: string[] }[] {
  return chatbotDb()
    .prepare("select id, at, user_name, role, question, answer, rating, payload from chat_log where rating < 0 or payload like '%\"fixed\":[\"%' order by id desc limit ?")
    .all(limit)
    .map((r) => {
      let issues: string[] = [];
      try {
        const p = JSON.parse(String(r.payload ?? "{}")) as { checks?: { fixed?: string[] } };
        issues = p.checks?.fixed ?? [];
      } catch {
        /* 壊れた行 */
      }
      return { id: Number(r.id), at: String(r.at), userName: String(r.user_name ?? ""), role: String(r.role ?? ""), question: String(r.question), answer: String(r.answer), rating: Number(r.rating ?? 0), issues };
    });
}
