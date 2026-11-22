import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { reportAiCall } from "./usage";

/**
 * AI の接続 (書類の読取・AI アシスタントで共通)
 * ------------------------------------------------------------
 * API キーは .env.local (Vercel では Environment Variables) に 1 つ設定する。キーの形から接続先を自動で判定する:
 *   - OpenAI:             sk-…     → OPENAI_API_KEY (OPEN_API_KEY・OPENAI_KEY・AI_API_KEY でも可)
 *   - Anthropic (Claude): sk-ant-… → ANTHROPIC_API_KEY (CLAUDE_API_KEY・AI_API_KEY でも可)
 *   両方あるときは Claude を使う (AI_PROVIDER=openai で OpenAI に固定)。キーがないときはサンプル応答 (デモ)
 *
 * - Claude: claude-opus-5-5。安全上の理由で応答が止まったときは、サーバー側で別のモデルに切り替える
 *   (server-side-fallback, fallbacks: "default")。JSON は structured outputs (output_config.format) で受け取る
 * - OpenAI: chat completions の JSON schema (strict)。モデルは OPENAI_MODEL、なければ OPENAI_MODELS を先頭から順に試す
 *   (最新の gpt-6.1-terra。使えないキーでは gpt-4.1)。推論モデルには reasoning_effort (AI_EFFORT、既定 low) を付ける
 * - Vercel の 1 回の処理は 60 秒まで (画面側で maxDuration = 60)。AI の呼び出しは全体で 50 秒までに収め、
 *   混雑・一時的な障害は時間が残っていれば 1 回だけやり直す。間に合わないときは利用者に「もう一度」を案内する
 */

export type AiProviderName = "claude" | "openai";

export const CLAUDE_MODEL = "claude-opus-5-5";
/**
 * OpenAI のモデル (先頭から順に試し、使えたものを覚える。OPENAI_MODEL があれば最優先)
 * - gpt-6.1-terra: 最新 (2026 年 10 月)。画像の読み取りに強く、画像を高い解像度のまま読む (patch 方式)。料金も gpt-4.1 より安い
 * - gpt-4.1: 予備 (最新のモデルが使えないキー・組織のとき)。画像は短い辺 768px に縮小して読むため、細かい ○ 囲みの読み取りは弱い
 */
const OPENAI_MODELS = ["gpt-6.1-terra", "gpt-4.1"];
/** 推論 (reasoning) に対応するモデル: gpt-5 以降・o シリーズ。reasoning_effort を付け、推論の分だけ出力の上限を足す */
const isReasoningModel = (model: string) => /^(gpt-([5-9]|\d{2,})|o\d)/.test(model);
const REASONING_HEADROOM = 8000;
/** AI の呼び出し全体の上限 (Vercel の 60 秒に、保存などの時間を残す) */
const DEADLINE_MS = 50_000;

interface AiConfig {
  provider: AiProviderName;
  apiKey: string;
  /** キーを読んだ環境変数の名前 (画面の表示用。値は出さない) */
  source: string;
}

/** よく使われる名前 (この順に探す) */
const KEY_VARS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPEN_API_KEY", "OPENAI_KEY", "CLAUDE_API_KEY", "AI_API_KEY"] as const;
/** そのほかの綴り (OPEN_AI_KEY・OPENAI_APIKEY・ANTHROPIC_KEY など) */
const KEY_PATTERN = /^(NEXT_PUBLIC_)?(OPEN_?AI|OPEN_?API|ANTHROPIC|CLAUDE)[A-Z0-9_]*KEY$/i;

function providerOfKey(name: string, key: string): AiProviderName | null {
  if (key.startsWith("sk-ant-")) return "claude";
  if (key.startsWith("sk-")) return "openai";
  // 形で判定できないキーは、環境変数の名前で判断する
  if (/ANTHROPIC|CLAUDE/i.test(name)) return "claude";
  if (/OPEN/i.test(name)) return "openai";
  return null;
}

function cleanKey(raw: string | undefined): string {
  return (raw ?? "").trim().replace(/^["']|["']$/g, "").trim();
}

export function aiConfig(): AiConfig | null {
  const names = [...KEY_VARS, ...Object.keys(process.env).filter((n) => KEY_PATTERN.test(n) && !(KEY_VARS as readonly string[]).includes(n)).sort()];
  const found: AiConfig[] = [];
  for (const name of names) {
    const key = cleanKey(process.env[name]);
    if (!key || /^(your|xxx|sk-\.\.\.|<)/i.test(key)) continue;
    const provider = providerOfKey(name, key);
    if (provider) found.push({ provider, apiKey: key, source: name });
  }
  if (!found.length) return null;
  const forced = process.env.AI_PROVIDER?.trim().toLowerCase();
  if (forced === "openai" || forced === "claude") return found.find((c) => c.provider === forced) ?? found[0];
  return found.find((c) => c.provider === "claude") ?? found[0];
}

export function aiEnabled(): boolean {
  return aiConfig() !== null;
}

/** 画面に表示する接続状態 (キーの値は出さない) */
export function aiStatus(): { enabled: boolean; provider: AiProviderName | null; label: string; model: string | null; source: string | null; note?: string } {
  const c = aiConfig();
  if (!c) return { enabled: false, provider: null, label: "未設定 (サンプルモード)", model: null, source: null };
  const model = c.provider === "claude" ? CLAUDE_MODEL : (process.env.OPENAI_MODEL?.trim() || workingOpenAiModel || OPENAI_MODELS[0]);
  const note = c.source.startsWith("NEXT_PUBLIC_") ? `環境変数の名前を ${c.source.replace(/^NEXT_PUBLIC_/, "")} に変えてください (NEXT_PUBLIC_ で始まる名前は画面側に公開される設定です)` : undefined;
  return { enabled: true, provider: c.provider, label: c.provider === "claude" ? "Claude (Anthropic)" : "OpenAI", model, source: c.source, note };
}

/** AI の呼び出しの失敗。message は利用者に見せる日本語 */
export class AiError extends Error {
  constructor(
    public code: "config" | "auth" | "quota" | "rate_limit" | "timeout" | "refusal" | "truncated" | "bad_output" | "unsupported" | "api",
    message: string,
    public detail?: string,
  ) {
    super(message);
  }
}

const MSG = {
  auth: "AI の API キーが正しくないか、使えない状態です。キーを確認してください。",
  busy: "AI の利用が混み合っています。少し待ってから、もう一度お試しください。",
  timeout: "AI の応答に時間がかかりすぎたため中断しました。もう一度お試しください。",
  refusal: "AI がこの内容の処理を断りました。内容を確認して手入力してください。",
  truncated: "読み取る内容が多すぎて途中で止まりました。書類を分けて取り込むか、手入力してください。",
  network: "AI に接続できませんでした。通信状況を確認して、もう一度お試しください。",
};

export type AiPart = { type: "text"; text: string } | { type: "image"; mediaType: string; base64: string } | { type: "pdf"; base64: string; fileName: string };

export type AiEffort = "low" | "medium" | "high";

function effortFromEnv(fallback: AiEffort): AiEffort {
  const v = process.env.AI_EFFORT?.trim().toLowerCase();
  return v === "low" || v === "medium" || v === "high" ? v : fallback;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ================================================================== */
/* JSON の生成 (書類の読取)                                              */
/* ================================================================== */

export interface JsonRequest {
  system: string;
  parts: AiPart[];
  /** JSON Schema (すべての object に additionalProperties: false、すべての項目を required。省略可の項目は anyOf [型, null]) */
  schema: Record<string, unknown>;
  /** OpenAI の json_schema.name (英数字と _ のみ) */
  schemaName: string;
  maxTokens?: number;
  effort?: AiEffort;
}

export interface AiResult<T> {
  data: T;
  provider: AiProviderName;
  model: string;
  ms: number;
}

export async function generateJson<T>(req: JsonRequest): Promise<AiResult<T>> {
  const c = aiConfig();
  if (!c) throw new AiError("config", "AI の API キーが設定されていません。");
  const t0 = Date.now();
  if (c.provider === "claude") {
    const { text, model } = await claudeCall(c, {
      system: req.system,
      content: req.parts.map(toClaudeBlock),
      maxTokens: req.maxTokens ?? 8000,
      effort: effortFromEnv(req.effort ?? "low"),
      schema: req.schema,
    });
    return { data: parseJson<T>(text), provider: "claude", model, ms: Date.now() - t0 };
  }
  const { text, model } = await openAiCall(c, {
    messages: [
      { role: "system", content: req.system },
      { role: "user", content: req.parts.map(toOpenAiPart) },
    ],
    maxTokens: req.maxTokens ?? 8000,
    effort: effortFromEnv(req.effort ?? "low"),
    responseFormat: { type: "json_schema", json_schema: { name: req.schemaName, strict: true, schema: req.schema } },
  });
  return { data: parseJson<T>(text), provider: "openai", model, ms: Date.now() - t0 };
}

/* ================================================================== */
/* 文章の生成 (AI アシスタント)                                          */
/* ================================================================== */

export interface TextRequest {
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  maxTokens?: number;
}

export async function generateText(req: TextRequest): Promise<AiResult<string>> {
  const c = aiConfig();
  if (!c) throw new AiError("config", "AI の API キーが設定されていません。");
  const t0 = Date.now();
  if (c.provider === "claude") {
    const { text, model } = await claudeCall(c, {
      system: req.system,
      cacheSystem: true,
      messages: req.messages,
      maxTokens: req.maxTokens ?? 4000,
      effort: effortFromEnv("low"),
    });
    return { data: text, provider: "claude", model, ms: Date.now() - t0 };
  }
  const { text, model } = await openAiCall(c, {
    messages: [{ role: "system", content: req.system }, ...req.messages],
    maxTokens: req.maxTokens ?? 4000,
    effort: effortFromEnv("low"),
  });
  return { data: text, provider: "openai", model, ms: Date.now() - t0 };
}

/* ================================================================== */
/* 道具を使う会話 (AI アシスタント: 検索・集計などの道具を AI が選んで呼ぶ)                    */
/* ================================================================== */

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema (object)。省略可の項目は required に入れない */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolLoopRequest {
  /**
   * 回答の文字を書かれた順に受け取る (OpenAI のとき。画面に回答をすぐ出す)。その回で道具を呼んだら reset
   * (道具の前の書きかけの文は回答ではないため)。Claude は今は順には受け取らず、最後にまとめて返す
   */
  onText?: (e: { type: "delta"; text: string } | { type: "reset" }) => void;
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  tools: ToolDef[];
  /** 道具の実行 (結果は AI に返す文字) */
  execute: (call: ToolCall) => Promise<string>;
  /** AI とのやりとりの最大回数 (道具の呼び出しを含む) */
  maxRounds?: number;
  maxTokens?: number;
  /** 全体の制限時間 */
  deadlineMs?: number;
  effort?: AiEffort;
}

export interface ToolLoopResult {
  text: string;
  provider: AiProviderName;
  model: string;
  rounds: number;
  calls: ToolCall[];
  ms: number;
}

const parseArgs = (s: string | undefined): Record<string, unknown> => {
  try {
    const v = JSON.parse(s || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/**
 * AI に道具 (関数) を渡し、AI が呼んだ道具を実行して結果を返す、を最終の回答が出るまで繰り返す。
 * OpenAI (function calling) と Claude (tool use) の両方に対応。最後の回数では道具を渡さず、答えを出させる
 */
export async function runToolLoop(req: ToolLoopRequest): Promise<ToolLoopResult> {
  const c = aiConfig();
  if (!c) throw new AiError("config", "AI の API キーが設定されていません。");
  const t0 = Date.now();
  const total = req.deadlineMs ?? 110_000;
  const maxRounds = Math.max(1, req.maxRounds ?? 6);
  const effort = effortFromEnv(req.effort ?? "low");
  const calls: ToolCall[] = [];
  const left = () => total - (Date.now() - t0);
  const FINAL = "\n\n(道具の呼び出しの上限に達しました。ここまでに得た情報だけで回答してください。足りない点は、足りないと書いてください。)";

  if (c.provider === "claude") {
    const tools: Anthropic.Beta.BetaToolUnion[] = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as Anthropic.Beta.BetaTool.InputSchema }));
    const messages: Anthropic.Beta.BetaMessageParam[] = req.messages.map((m) => ({ role: m.role, content: m.content }));
    let model = CLAUDE_MODEL;
    for (let round = 1; ; round++) {
      const last = round >= maxRounds || left() < 25_000;
      if (last && round > 1) messages.push({ role: "user", content: FINAL.trim() });
      const res = await claudeCall(c, { system: req.system, cacheSystem: true, messages, maxTokens: req.maxTokens ?? 3000, effort, tools, noToolUse: last, deadlineMs: Math.max(8_000, left() - 2_000) });
      model = res.model;
      const uses = res.blocks.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (!uses.length || last) return { text: res.text, provider: "claude", model, rounds: round, calls, ms: Date.now() - t0 };
      messages.push({ role: "assistant", content: res.blocks as Anthropic.Beta.BetaContentBlockParam[] });
      // 同じ回の道具は並べて実行する (SQL は別スレッドなので待ち時間が重ならない)。結果の順番は呼ばれた順のまま
      const batch = uses.map((u) => ({ id: u.id, name: u.name, args: (u.input && typeof u.input === "object" ? u.input : {}) as Record<string, unknown> }));
      calls.push(...batch);
      const outs = await Promise.all(batch.map((call) => req.execute(call).catch((e: Error) => `エラー: ${e.message}`)));
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = batch.map((call, i) => ({ type: "tool_result", tool_use_id: call.id, content: outs[i].slice(0, 24_000) }));
      messages.push({ role: "user", content: results });
    }
  }

  const tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  const messages: OpenAiMessage[] = [{ role: "system", content: req.system }, ...req.messages.map((m) => ({ role: m.role, content: m.content }) as OpenAiMessage)];
  for (let round = 1; ; round++) {
    const last = round >= maxRounds || left() < 25_000;
    if (last && round > 1) messages.push({ role: "user", content: FINAL.trim() });
    let streamed = false;
    const res = await openAiCall(c, {
      messages,
      maxTokens: req.maxTokens ?? 3000,
      effort,
      tools,
      noToolUse: last,
      deadlineMs: Math.max(8_000, left() - 2_000),
      onDelta: req.onText
        ? (text) => {
            streamed = true;
            req.onText?.({ type: "delta", text });
          }
        : undefined,
    });
    if (!res.toolCalls?.length || last) return { text: res.text, provider: "openai", model: res.model, rounds: round, calls, ms: Date.now() - t0 };
    // 道具を呼ぶ回の書きかけの文は回答ではないので、画面から消してもらう
    if (streamed) req.onText?.({ type: "reset" });
    messages.push({ role: "assistant", content: res.text || null, tool_calls: res.toolCalls });
    // 同じ回の道具は並べて実行する (結果の順番は呼ばれた順のまま)
    const batch = res.toolCalls.map((tc) => ({ id: tc.id, name: tc.function.name, args: parseArgs(tc.function.arguments) }));
    calls.push(...batch);
    const outs = await Promise.all(batch.map((call) => req.execute(call).catch((e: Error) => `エラー: ${e.message}`)));
    batch.forEach((call, i) => messages.push({ role: "tool", tool_call_id: call.id, content: outs[i].slice(0, 24_000) }));
  }
}

/** 接続の確認 (設定画面の「接続を確認」)。読取と同じ形 (JSON Schema) で短い依頼を 1 回送る */
export async function testConnection(): Promise<{ ok: true; provider: AiProviderName; model: string; ms: number; reply: string } | { ok: false; message: string; detail?: string }> {
  try {
    const r = await generateJson<{ answer: string }>({
      system: "あなたは接続確認用のアシスタントです。指定の JSON だけを返してください。",
      parts: [{ type: "text", text: "「接続できました」という文字列を answer に入れて返してください。" }],
      schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
      schemaName: "connection_check",
      maxTokens: 1000,
      effort: "low",
    });
    return { ok: true, provider: r.provider, model: r.model, ms: r.ms, reply: r.data.answer };
  } catch (err) {
    if (err instanceof AiError) return { ok: false, message: err.message, detail: err.detail?.slice(0, 300) };
    return { ok: false, message: "接続できませんでした。", detail: (err as Error).message };
  }
}

/* ================================================================== */
/* Claude (Anthropic)                                                   */
/* ================================================================== */

type ClaudeBlock = Anthropic.Beta.BetaContentBlockParam;

function toClaudeBlock(p: AiPart): ClaudeBlock {
  if (p.type === "text") return { type: "text", text: p.text };
  if (p.type === "pdf") return { type: "document", source: { type: "base64", media_type: "application/pdf", data: p.base64 } };
  const media = (["image/jpeg", "image/png", "image/gif", "image/webp"].includes(p.mediaType) ? p.mediaType : "image/jpeg") as "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  return { type: "image", source: { type: "base64", media_type: media, data: p.base64 } };
}

async function claudeCall(
  c: AiConfig,
  opts: {
    system: string;
    cacheSystem?: boolean;
    content?: ClaudeBlock[];
    messages?: Anthropic.Beta.BetaMessageParam[];
    maxTokens: number;
    effort: AiEffort;
    schema?: Record<string, unknown>;
    tools?: Anthropic.Beta.BetaToolUnion[];
    /** 道具を渡したうえで、呼ばせない (会話に道具の呼び出しが含まれる最後の回答) */
    noToolUse?: boolean;
    deadlineMs?: number;
  },
): Promise<{ text: string; model: string; blocks: Anthropic.Beta.BetaContentBlock[] }> {
  // ANTHROPIC_BASE_URL があればそこへ送る (SDK の既定の動き。検証用)
  const limit = opts.deadlineMs ?? DEADLINE_MS;
  const client = new Anthropic({ apiKey: c.apiKey, maxRetries: 0, timeout: limit });
  const messages: Anthropic.Beta.BetaMessageParam[] = opts.messages ?? [{ role: "user", content: opts.content ?? [] }];
  const deadline = Date.now() + limit;
  const t0 = Date.now();
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await client.beta.messages.create(
        {
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          model: CLAUDE_MODEL,
          max_tokens: opts.maxTokens,
          system: opts.cacheSystem ? [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }] : opts.system,
          output_config: opts.schema ? { effort: opts.effort, format: { type: "json_schema", schema: opts.schema } } : { effort: opts.effort },
          ...(opts.tools?.length ? { tools: opts.tools, ...(opts.noToolUse ? { tool_choice: { type: "none" as const } } : {}) } : {}),
          messages,
        },
        { timeout: Math.max(5_000, deadline - Date.now()) },
      );
      if (res.stop_reason === "refusal") throw new AiError("refusal", MSG.refusal, res.stop_details?.category ?? undefined);
      if (res.stop_reason === "max_tokens") throw new AiError("truncated", MSG.truncated);
      const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      const u = res.usage;
      const cached = u?.cache_read_input_tokens ?? 0;
      reportAiCall({ provider: "claude", model: res.model ?? CLAUDE_MODEL, inputTokens: (u?.input_tokens ?? 0) + cached + (u?.cache_creation_input_tokens ?? 0), outputTokens: u?.output_tokens ?? 0, cachedTokens: cached, ms: Date.now() - t0, ok: true });
      return { text, model: res.model ?? CLAUDE_MODEL, blocks: res.content };
    } catch (err) {
      const retryable = err instanceof Anthropic.InternalServerError || err instanceof Anthropic.RateLimitError || (err instanceof Anthropic.APIConnectionError && !(err instanceof Anthropic.APIConnectionTimeoutError));
      if (attempt === 0 && retryable && deadline - Date.now() > 20_000) {
        await sleep(1_500);
        continue;
      }
      const e = claudeError(err);
      reportAiCall({ provider: "claude", model: CLAUDE_MODEL, inputTokens: 0, outputTokens: 0, cachedTokens: 0, ms: Date.now() - t0, ok: false, error: e.code });
      throw e;
    }
  }
}

function claudeError(err: unknown): AiError {
  if (err instanceof AiError) return err;
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return new AiError("auth", MSG.auth, err.message);
  if (err instanceof Anthropic.RateLimitError) return new AiError("rate_limit", MSG.busy, err.message);
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new AiError("timeout", MSG.timeout);
  if (err instanceof Anthropic.BadRequestError) {
    if (/credit balance|billing/i.test(err.message)) return new AiError("quota", "AI の利用残高が不足しています。Anthropic の請求設定を確認してください。", err.message);
    if (/image|document|pdf|media/i.test(err.message)) return new AiError("unsupported", "このファイルは AI で読み取れません (写真か PDF を使ってください)。", err.message);
    return new AiError("api", "AI への依頼に失敗しました。", err.message);
  }
  if (err instanceof Anthropic.InternalServerError && (err.status === 529 || err.status === 503)) return new AiError("rate_limit", MSG.busy, err.message);
  if (err instanceof Anthropic.APIConnectionError) return new AiError("api", MSG.network, err.message);
  if (err instanceof Anthropic.APIError) return new AiError("api", `AI の処理に失敗しました (エラー ${err.status ?? "-"})。時間をおいて、もう一度お試しください。`, err.message);
  return new AiError("api", "AI の処理に失敗しました。", (err as Error)?.message);
}

/* ================================================================== */
/* OpenAI                                                               */
/* ================================================================== */

type OpenAiContent = string | ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail: "high" } } | { type: "file"; file: { filename: string; file_data: string } })[];

function toOpenAiPart(p: AiPart) {
  if (p.type === "text") return { type: "text" as const, text: p.text };
  if (p.type === "pdf") return { type: "file" as const, file: { filename: p.fileName || "document.pdf", file_data: `data:application/pdf;base64,${p.base64}` } };
  return { type: "image_url" as const, image_url: { url: `data:${p.mediaType || "image/jpeg"};base64,${p.base64}`, detail: "high" as const } };
}

/** 使えたモデルを覚えておく (次回から最初に使う) */
let workingOpenAiModel: string | undefined;

type OpenAiUsage = { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
type OpenAiBody = { choices?: { message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }[]; model?: string; usage?: OpenAiUsage; error?: { message?: string; code?: string; type?: string } } | null;

type OpenAiToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type OpenAiMessage = { role: "system" | "user" | "assistant" | "tool"; content: OpenAiContent | null; tool_calls?: OpenAiToolCall[]; tool_call_id?: string };

type OpenAiCallOpts = {
  messages: OpenAiMessage[];
  maxTokens: number;
  effort: AiEffort;
  responseFormat?: Record<string, unknown>;
  tools?: Record<string, unknown>[];
  noToolUse?: boolean;
  deadlineMs?: number;
  /** 回答の文字を書かれた順に受け取る (stream。画面に回答をすぐ出すため) */
  onDelta?: (text: string) => void;
};

/** OpenAI の 1 回の呼び出し (使ったトークン数・時間・失敗を usage.ts に知らせる) */
async function openAiCall(c: AiConfig, opts: OpenAiCallOpts): Promise<{ text: string; model: string; toolCalls?: OpenAiToolCall[] }> {
  const t0 = Date.now();
  try {
    const r = await openAiCallRaw(c, opts);
    const cached = r.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    reportAiCall({ provider: "openai", model: r.model, inputTokens: r.usage?.prompt_tokens ?? 0, outputTokens: r.usage?.completion_tokens ?? 0, cachedTokens: cached, ms: Date.now() - t0, ok: true });
    return { text: r.text, model: r.model, toolCalls: r.toolCalls };
  } catch (err) {
    const model = process.env.OPENAI_MODEL?.trim() || workingOpenAiModel || OPENAI_MODELS[0];
    reportAiCall({ provider: "openai", model, inputTokens: 0, outputTokens: 0, cachedTokens: 0, ms: Date.now() - t0, ok: false, error: err instanceof AiError ? err.code : "api" });
    throw err;
  }
}

/** OpenAI の stream (data: {...} の行) を読み、文字は onDelta に渡しながら、道具の呼び出し・使ったトークン数を組み立てる */
async function readOpenAiStream(stream: ReadableStream<Uint8Array>, onDelta: (text: string) => void): Promise<{ text: string; model: string; toolCalls?: OpenAiToolCall[]; usage?: OpenAiUsage }> {
  type Chunk = { model?: string; usage?: OpenAiUsage; choices?: { delta?: { content?: string | null; refusal?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[] };
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let text = "";
  let model = "";
  let finish = "";
  let usage: OpenAiUsage | undefined;
  const calls: OpenAiToolCall[] = [];
  const handle = (line: string) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    let j: Chunk;
    try {
      j = JSON.parse(data) as Chunk;
    } catch {
      return;
    }
    if (j.model) model = j.model;
    if (j.usage) usage = j.usage;
    const ch = j.choices?.[0];
    if (!ch) return;
    const d = ch.delta ?? {};
    if (d.refusal) throw new AiError("refusal", MSG.refusal, d.refusal);
    if (typeof d.content === "string" && d.content) {
      text += d.content;
      onDelta(d.content);
    }
    for (const tc of d.tool_calls ?? []) {
      const k = tc.index ?? 0;
      const cur = (calls[k] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.function.name += tc.function.name;
      if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
    }
    if (ch.finish_reason) finish = ch.finish_reason;
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      handle(buf.slice(0, i).trim());
      buf = buf.slice(i + 1);
    }
    if (done) break;
  }
  if (buf.trim()) handle(buf.trim());
  if (finish === "length") throw new AiError("truncated", MSG.truncated);
  if (finish === "content_filter") throw new AiError("refusal", MSG.refusal, "content_filter");
  const toolCalls = calls.filter((x) => x && x.function.name);
  return { text, model, toolCalls: toolCalls.length ? toolCalls : undefined, usage };
}

async function openAiCallRaw(c: AiConfig, opts: OpenAiCallOpts): Promise<{ text: string; model: string; toolCalls?: OpenAiToolCall[]; usage?: OpenAiUsage }> {
  const base = (process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/$/, "");
  const preferred = process.env.OPENAI_MODEL?.trim();
  const models = [...new Set([preferred, workingOpenAiModel, ...OPENAI_MODELS].filter(Boolean) as string[])];
  const deadline = Date.now() + (opts.deadlineMs ?? DEADLINE_MS);
  let lastError: AiError | undefined;
  let retried = false;
  /** reasoning_effort を受け付けなかったモデル (同じモデルで付けずにやり直す) */
  const noEffort = new Set<string>();
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const remaining = deadline - Date.now();
    if (remaining < 5_000) throw lastError ?? new AiError("timeout", MSG.timeout);
    const reasoning = isReasoningModel(model);
    const withEffort = reasoning && !noEffort.has(model);
    let res: Response;
    try {
      res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${c.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: opts.messages,
          // 推論モデルは推論の分も出力に数えるため、上限に余裕を足す (使った分だけの料金)
          max_completion_tokens: reasoning ? opts.maxTokens + REASONING_HEADROOM : opts.maxTokens,
          ...(opts.responseFormat ? { response_format: opts.responseFormat } : {}),
          ...(opts.tools?.length ? { tools: opts.tools, tool_choice: opts.noToolUse ? "none" : "auto", ...(opts.noToolUse ? {} : { parallel_tool_calls: true }) } : {}),
          ...(withEffort ? { reasoning_effort: opts.effort } : {}),
          ...(opts.onDelta ? { stream: true, stream_options: { include_usage: true } } : {}),
        }),
        signal: AbortSignal.timeout(remaining),
      });
    } catch (err) {
      if ((err as Error).name === "TimeoutError" || (err as Error).name === "AbortError") throw new AiError("timeout", MSG.timeout);
      if (!retried && deadline - Date.now() > 20_000) {
        retried = true;
        await sleep(1_500);
        i--;
        continue;
      }
      throw new AiError("api", MSG.network, (err as Error).message);
    }
    // 文字を順に受け取る (stream)。誤りのときは下の JSON の処理 (モデルの切り替え・やり直し) に進む
    if (res.ok && opts.onDelta && res.body) {
      try {
        const r = await readOpenAiStream(res.body, opts.onDelta);
        workingOpenAiModel = model;
        return { ...r, model: r.model || model };
      } catch (err) {
        if (err instanceof AiError) throw err;
        if ((err as Error).name === "TimeoutError" || (err as Error).name === "AbortError") throw new AiError("timeout", MSG.timeout);
        throw new AiError("api", MSG.network, (err as Error).message);
      }
    }
    const body = (await res.json().catch(() => null)) as OpenAiBody;
    if (!res.ok) {
      const msg = body?.error?.message ?? `HTTP ${res.status}`;
      const code = `${body?.error?.code ?? ""} ${body?.error?.type ?? ""}`;
      if (res.status === 401) throw new AiError("auth", MSG.auth, msg);
      if (res.status === 403) {
        // 組織・プロジェクトでこのモデルが使えないときは次のモデルへ
        if (/model/i.test(msg)) {
          lastError = new AiError("unsupported", `モデル ${model} を利用できません。`, msg);
          continue;
        }
        throw new AiError("auth", MSG.auth, msg);
      }
      if (res.status === 429) {
        if (/quota|billing|insufficient/i.test(msg + code)) throw new AiError("quota", "AI の利用枠 (残高・上限) を超えています。OpenAI の請求設定 (Billing) を確認してください。", msg);
        if (!retried && deadline - Date.now() > 20_000) {
          retried = true;
          await sleep(2_000);
          i--;
          continue;
        }
        throw new AiError("rate_limit", MSG.busy, msg);
      }
      // reasoning_effort (の値) に対応していない → 同じモデルで付けずにもう一度
      if (res.status === 400 && withEffort && /reasoning/i.test(msg)) {
        noEffort.add(model);
        i--;
        continue;
      }
      // モデルがない・この使い方に対応していない → 次のモデルを試す
      if (res.status === 404 || /model_not_found/.test(code) || (res.status === 400 && /model|not supported|unsupported|does not support|response_format|json_schema|reasoning_effort|max_completion_tokens/i.test(msg))) {
        lastError = new AiError("unsupported", `モデル ${model} を利用できません。`, msg);
        continue;
      }
      if (res.status === 400 && /image|file|pdf|media/i.test(msg)) throw new AiError("unsupported", "このファイルは AI で読み取れません (写真か PDF を使ってください)。", msg);
      if (res.status >= 500 && !retried && deadline - Date.now() > 20_000) {
        retried = true;
        await sleep(1_500);
        i--;
        continue;
      }
      throw new AiError("api", `AI の処理に失敗しました (エラー ${res.status})。時間をおいて、もう一度お試しください。`, msg);
    }
    const choice = body?.choices?.[0];
    if (choice?.message?.refusal) throw new AiError("refusal", MSG.refusal, choice.message.refusal);
    if (choice?.finish_reason === "length") throw new AiError("truncated", MSG.truncated);
    if (choice?.finish_reason === "content_filter") throw new AiError("refusal", MSG.refusal, "content_filter");
    workingOpenAiModel = model;
    const raw = choice?.message as { content?: string | null; tool_calls?: OpenAiToolCall[] } | undefined;
    return { text: raw?.content ?? "", model: body?.model ?? model, toolCalls: raw?.tool_calls?.length ? raw.tool_calls : undefined, usage: body?.usage };
  }
  throw lastError ?? new AiError("unsupported", "利用できる OpenAI のモデルが見つかりませんでした。OPENAI_MODEL を設定してください。");
}

/* ================================================================== */

function parseJson<T>(text: string): T {
  const t = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  try {
    return JSON.parse(t) as T;
  } catch {
    // 前後に文章が付いた場合に備えて、最初の { から最後の } までを読む
    const s = t.indexOf("{");
    const e = t.lastIndexOf("}");
    if (s >= 0 && e > s) {
      try {
        return JSON.parse(t.slice(s, e + 1)) as T;
      } catch {
        /* 下で失敗にする */
      }
    }
    throw new AiError("bad_output", "AI の応答を読み取れませんでした。もう一度お試しください。", t.slice(0, 200));
  }
}

/* ================================================================== */
/* 音声 (「質問する」の読み上げと音声入力)。OpenAI の音声 API を使う                         */
/* ================================================================== */

/**
 * 音声に使う OpenAI のキー。Claude には音声の API がないため、Claude を使う設定でも OpenAI のキーがあれば音声に使う。
 * OpenAI のキーがないときは、画面がブラウザーの音声機能 (読み上げ・音声認識) に切り替える
 */
function openAiVoiceKey(): string | null {
  const names = [...KEY_VARS, ...Object.keys(process.env).filter((n) => KEY_PATTERN.test(n) && !(KEY_VARS as readonly string[]).includes(n)).sort()];
  for (const name of names) {
    const key = cleanKey(process.env[name]);
    if (!key || /^(your|xxx|sk-\.\.\.|<)/i.test(key)) continue;
    if (providerOfKey(name, key) === "openai") return key;
  }
  return null;
}

export function voiceEnabled(): boolean {
  return openAiVoiceKey() !== null && process.env.AI_VOICE?.trim().toLowerCase() !== "off";
}

/** 読み上げの声: 20 代の日本人女性 (明るく・やわらかく・聞き取りやすく) */
const TTS_INSTRUCTIONS =
  "20代の日本人女性の声で読み上げてください。明るくやわらかい声で、ていねいで親しみのある話し方にします。自然な標準語のイントネーションで、聞き取りやすい少しゆっくりめの速さにしてください。数字・金額・日付・固有名詞は正確に、はっきり読んでください。";
const TTS_MODELS = () => [...new Set([process.env.OPENAI_TTS_MODEL?.trim(), "gpt-4o-mini-tts", "tts-1"].filter(Boolean) as string[])];
const STT_MODELS = () => [...new Set([process.env.OPENAI_STT_MODEL?.trim(), "gpt-4o-mini-transcribe", "gpt-4o-transcribe", "whisper-1"].filter(Boolean) as string[])];
let workingTtsModel: string | undefined;
let workingSttModel: string | undefined;

async function voiceFetch(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const base = (process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/$/, "");
  try {
    return await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if ((err as Error).name === "TimeoutError" || (err as Error).name === "AbortError") throw new AiError("timeout", "音声の処理に時間がかかりすぎました。もう一度お試しください。");
    throw new AiError("api", MSG.network, (err as Error).message);
  }
}

async function voiceError(res: Response): Promise<AiError> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  const msg = body?.error?.message ?? `HTTP ${res.status}`;
  if (res.status === 401 || res.status === 403) return new AiError("auth", MSG.auth, msg);
  if (res.status === 429) return /quota|billing|insufficient/i.test(msg) ? new AiError("quota", "AI の利用枠を超えています。OpenAI の請求設定を確認してください。", msg) : new AiError("rate_limit", MSG.busy, msg);
  if (res.status === 404 || (res.status === 400 && /model/i.test(msg))) return new AiError("unsupported", "音声のモデルを利用できません。", msg);
  return new AiError("api", "音声の処理に失敗しました。時間をおいて、もう一度お試しください。", msg);
}

/** 文字 → 音声 (mp3)。text は読み上げ用に整えたもの (src/lib/speech-text.ts の forSpeech) */
export async function synthesizeSpeech(text: string): Promise<{ audio: ArrayBuffer; contentType: string; model: string }> {
  const key = openAiVoiceKey();
  if (!key) throw new AiError("config", "音声の読み上げには OpenAI の API キーが必要です。");
  const voice = process.env.OPENAI_TTS_VOICE?.trim() || "nova";
  const models = [...new Set([workingTtsModel, ...TTS_MODELS()].filter(Boolean) as string[])];
  let last: AiError | undefined;
  const t0 = Date.now();
  for (const model of models) {
    const res = await voiceFetch(
      "/audio/speech",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        // tts-1 は instructions に対応しないため、付けるのは gpt-4o 系だけ
        body: JSON.stringify({ model, voice, input: text, response_format: "mp3", ...(/^gpt-/.test(model) ? { instructions: TTS_INSTRUCTIONS } : {}) }),
      },
      30_000,
    );
    if (res.ok) {
      workingTtsModel = model;
      const audio = await res.arrayBuffer();
      // 費用の記録 (読み上げの API はトークン数を返さないため目安: 入力 = 文字数、音声の出力 = mp3 の長さ (約 48kbps) × 毎秒 21 トークン)
      reportAiCall({ kind: "voice", provider: "openai", model, inputTokens: text.length, outputTokens: Math.round((audio.byteLength / 6000) * 21), cachedTokens: 0, ms: Date.now() - t0, ok: true });
      return { audio, contentType: res.headers.get("content-type") || "audio/mpeg", model };
    }
    last = await voiceError(res);
    if (last.code !== "unsupported") {
      reportAiCall({ kind: "voice", provider: "openai", model, inputTokens: 0, outputTokens: 0, cachedTokens: 0, ms: Date.now() - t0, ok: false, error: last.code });
      throw last;
    }
  }
  throw last ?? new AiError("unsupported", "音声のモデルを利用できません。");
}

/** 音声 → 文字 (日本語)。hint は聞き取りの手がかりの言葉 (社名・店舗名・社員名など)。timeoutMs は長い録音 (通話の録音) 用 */
export async function transcribeAudio(audio: Blob, fileName: string, hint: string, opts: { timeoutMs?: number } = {}): Promise<{ text: string; model: string }> {
  const key = openAiVoiceKey();
  if (!key) throw new AiError("config", "音声入力には OpenAI の API キーが必要です。");
  const models = [...new Set([workingSttModel, ...STT_MODELS()].filter(Boolean) as string[])];
  let last: AiError | undefined;
  const t0 = Date.now();
  for (const model of models) {
    const form = new FormData();
    form.append("model", model);
    form.append("language", "ja");
    form.append("prompt", hint.slice(0, 800));
    form.append("file", audio, fileName);
    const res = await voiceFetch("/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form }, opts.timeoutMs ?? 45_000);
    if (res.ok) {
      workingSttModel = model;
      const body = (await res.json().catch(() => null)) as { text?: string; usage?: { input_tokens?: number; output_tokens?: number } } | null;
      // 費用の記録 (gpt-4o 系の文字起こしはトークン数を返す。返さないモデルは音声の大きさからの目安)
      reportAiCall({ kind: "voice", provider: "openai", model, inputTokens: body?.usage?.input_tokens ?? Math.round((audio.size / 4000) * 10), outputTokens: body?.usage?.output_tokens ?? (body?.text ?? "").length, cachedTokens: 0, ms: Date.now() - t0, ok: true });
      return { text: (body?.text ?? "").trim(), model };
    }
    last = await voiceError(res);
    if (last.code !== "unsupported") {
      reportAiCall({ kind: "voice", provider: "openai", model, inputTokens: 0, outputTokens: 0, cachedTokens: 0, ms: Date.now() - t0, ok: false, error: last.code });
      throw last;
    }
  }
  throw last ?? new AiError("unsupported", "音声認識のモデルを利用できません。");
}
