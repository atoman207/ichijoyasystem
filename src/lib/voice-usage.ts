import "server-only";
import crypto from "node:crypto";

/**
 * 音声 (読み上げ・音声入力) の使いすぎの防止と、読み上げの音声の一時保存
 * - 1 人あたり 1 時間の回数の上限 (VOICE_TTS_PER_HOUR・VOICE_STT_PER_HOUR)。プロセスのメモリで数える
 * - 同じ文の読み上げは、作った音声を再利用する (同じ回答をもう一度聞くとき・よくある質問)。最大 60 件
 */

const g = globalThis as typeof globalThis & { __ichijoyaVoiceUse?: Map<string, number[]>; __ichijoyaTtsCache?: Map<string, { audio: ArrayBuffer; contentType: string }> };
const uses = (g.__ichijoyaVoiceUse ??= new Map());
const cache = (g.__ichijoyaTtsCache ??= new Map());

export const LIMITS = {
  tts: Number(process.env.VOICE_TTS_PER_HOUR) || 200,
  stt: Number(process.env.VOICE_STT_PER_HOUR) || 120,
};

/** 使ってよければ数えて true。上限を超えていれば false */
export function takeVoiceQuota(kind: "tts" | "stt", userId: string): boolean {
  const key = `${kind}:${userId}`;
  const since = Date.now() - 3_600_000;
  const list = (uses.get(key) ?? []).filter((t: number) => t > since);
  if (list.length >= LIMITS[kind]) {
    uses.set(key, list);
    return false;
  }
  list.push(Date.now());
  uses.set(key, list);
  return true;
}

export const ttsKey = (text: string) => crypto.createHash("sha1").update(`${process.env.OPENAI_TTS_VOICE ?? ""}|${text}`).digest("hex");

export function cachedSpeech(key: string): { audio: ArrayBuffer; contentType: string } | undefined {
  const hit = cache.get(key);
  if (hit) {
    // 最近使ったものを後ろへ
    cache.delete(key);
    cache.set(key, hit);
  }
  return hit;
}

export function saveSpeech(key: string, value: { audio: ArrayBuffer; contentType: string }): void {
  cache.set(key, value);
  while (cache.size > 60) cache.delete(cache.keys().next().value!);
}
