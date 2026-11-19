import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * AI の呼び出しの記録 (利用回数・トークン数・応答時間・失敗)
 * ------------------------------------------------------------
 * provider.ts が 1 回の API 呼び出しごとに reportAiCall を呼ぶ。記録先 (チャットボットの SQLite の ai_calls) は
 * src/lib/chatbot/monitor.ts が onAiCall で受け取る (AI の境界から保存先を切り離すため)。
 * 誰の・何のための呼び出しか (AI アシスタント・書類の読取・評価など) は withAiContext で包んだ処理の中から自動で付く。
 * 記録するのは数 (トークン・時間・失敗の種類) だけで、質問や回答の中身は記録しない
 */

export interface AiCallRecord {
  /** 呼び出しの目的: assistant (AI アシスタント) / guest (ログイン前の案内) / eval (精度の評価) / ocr / summary / draft / train / other */
  kind: string;
  userId?: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** 入力のうちキャッシュから読んだ分 (料金が安い) */
  cachedTokens: number;
  ms: number;
  ok: boolean;
  /** 失敗の種類 (AiError の code: timeout・rate_limit・quota・auth・api…) */
  error?: string;
}

export interface AiContext {
  kind: string;
  userId?: string;
}

type Listener = (r: AiCallRecord) => void;

// 画面・API・instrumentation が別々に読み込んでも同じものを使う
const g = globalThis as typeof globalThis & { __ichijoyaAiCtx?: AsyncLocalStorage<AiContext>; __ichijoyaAiListeners?: Map<string, Listener> };
const store = (g.__ichijoyaAiCtx ??= new AsyncLocalStorage<AiContext>());
const listeners = (g.__ichijoyaAiListeners ??= new Map<string, Listener>());

/** この中の AI の呼び出しに、目的と利用者を付ける */
export function withAiContext<T>(ctx: AiContext, fn: () => Promise<T>): Promise<T> {
  return store.run(ctx, fn);
}

export function currentAiContext(): AiContext | undefined {
  return store.getStore();
}

/** 記録を受け取る。同じ名前は 1 つだけ (画面ごとに読み込まれても二重に記録しない) */
export function onAiCall(name: string, fn: Listener): void {
  listeners.set(name, fn);
}

export function reportAiCall(r: Omit<AiCallRecord, "kind" | "userId"> & Partial<Pick<AiCallRecord, "kind" | "userId">>): void {
  const ctx = store.getStore();
  const rec: AiCallRecord = { ...r, kind: r.kind ?? ctx?.kind ?? "other", userId: r.userId ?? ctx?.userId };
  for (const l of listeners.values()) {
    try {
      l(rec);
    } catch (err) {
      console.warn("[ai-usage] listener failed:", (err as Error).message);
    }
  }
}
