import "server-only";
import Anthropic from "@anthropic-ai/sdk";

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
 * - OpenAI: chat completions の JSON schema (strict)。モデルは OPENAI_MODEL、なければ利用できるものを順に試す
 * - Vercel の 1 回の処理は 60 秒まで (画面側で maxDuration = 60)。AI の呼び出しは全体で 50 秒までに収め、
 *   混雑・一時的な障害は時間が残っていれば 1 回だけやり直す。間に合わないときは利用者に「もう一度」を案内する
 */

export type AiProviderName = "claude" | "openai";

export const CLAUDE_MODEL = "claude-opus-5-5";
/** OpenAI のモデル (先頭から順に試し、使えたものを覚える。OPENAI_MODEL があれば最優先) */
const OPENAI_MODELS = ["gpt-4.1", "gpt-5-mini", "gpt-4o", "gpt-5"];
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
  });
  return { data: text, provider: "openai", model, ms: Date.now() - t0 };
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
  opts: { system: string; cacheSystem?: boolean; content?: ClaudeBlock[]; messages?: { role: "user" | "assistant"; content: string }[]; maxTokens: number; effort: AiEffort; schema?: Record<string, unknown> },
): Promise<{ text: string; model: string }> {
  // ANTHROPIC_BASE_URL があればそこへ送る (SDK の既定の動き。検証用)
  const client = new Anthropic({ apiKey: c.apiKey, maxRetries: 0, timeout: DEADLINE_MS });
  const messages: Anthropic.Beta.BetaMessageParam[] = opts.messages ?? [{ role: "user", content: opts.content ?? [] }];
  const deadline = Date.now() + DEADLINE_MS;
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
          messages,
        },
        { timeout: Math.max(5_000, deadline - Date.now()) },
      );
      if (res.stop_reason === "refusal") throw new AiError("refusal", MSG.refusal, res.stop_details?.category ?? undefined);
      if (res.stop_reason === "max_tokens") throw new AiError("truncated", MSG.truncated);
      const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      return { text, model: res.model ?? CLAUDE_MODEL };
    } catch (err) {
      const retryable = err instanceof Anthropic.InternalServerError || err instanceof Anthropic.RateLimitError || (err instanceof Anthropic.APIConnectionError && !(err instanceof Anthropic.APIConnectionTimeoutError));
      if (attempt === 0 && retryable && deadline - Date.now() > 20_000) {
        await sleep(1_500);
        continue;
      }
      throw claudeError(err);
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

type OpenAiBody = { choices?: { message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }[]; model?: string; error?: { message?: string; code?: string; type?: string } } | null;

async function openAiCall(
  c: AiConfig,
  opts: { messages: { role: "system" | "user" | "assistant"; content: OpenAiContent }[]; maxTokens: number; responseFormat?: Record<string, unknown> },
): Promise<{ text: string; model: string }> {
  const base = (process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/$/, "");
  const preferred = process.env.OPENAI_MODEL?.trim();
  const models = [...new Set([preferred, workingOpenAiModel, ...OPENAI_MODELS].filter(Boolean) as string[])];
  const deadline = Date.now() + DEADLINE_MS;
  let lastError: AiError | undefined;
  let retried = false;
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const remaining = deadline - Date.now();
    if (remaining < 5_000) throw lastError ?? new AiError("timeout", MSG.timeout);
    const reasoning = /^(gpt-5|o\d)/.test(model);
    let res: Response;
    try {
      res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${c.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: opts.messages,
          max_completion_tokens: opts.maxTokens,
          ...(opts.responseFormat ? { response_format: opts.responseFormat } : {}),
          ...(reasoning ? { reasoning_effort: "low" } : {}),
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
    return { text: choice?.message?.content ?? "", model: body?.model ?? model };
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
