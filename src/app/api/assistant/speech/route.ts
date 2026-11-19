import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { AiError, synthesizeSpeech, voiceEnabled } from "@/lib/ai/provider";
import { forSpeech } from "@/lib/speech-text";
import { cachedSpeech, saveSpeech, takeVoiceQuota, ttsKey } from "@/lib/voice-usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 「質問する」の回答の読み上げ: POST { text, hasTable? } → 音声 (mp3)。
 * 声は 20 代の日本人女性 (src/lib/ai/provider.ts の synthesizeSpeech)。ログインした社員だけ (ログイン前の画面はブラウザーの読み上げ)
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "ログインが必要です。" }, { status: 401 });
  if (!voiceEnabled()) return NextResponse.json({ error: "音声の読み上げは設定されていません。" }, { status: 503 });
  const body = (await req.json().catch(() => null)) as { text?: unknown; hasTable?: unknown } | null;
  const raw = typeof body?.text === "string" ? body.text.slice(0, 6000) : "";
  const text = forSpeech(raw, { hasTable: body?.hasTable === true });
  if (!text) return NextResponse.json({ error: "読み上げる文がありません。" }, { status: 400 });
  const key = ttsKey(text);
  let speech = cachedSpeech(key);
  if (!speech) {
    if (!takeVoiceQuota("tts", user.id)) return NextResponse.json({ error: "読み上げの回数が 1 時間の上限に達しました。しばらくしてからお試しください。" }, { status: 429 });
    try {
      const r = await synthesizeSpeech(text);
      speech = { audio: r.audio, contentType: r.contentType };
      saveSpeech(key, speech);
    } catch (err) {
      const message = err instanceof AiError ? err.message : "読み上げの音声を作れませんでした。";
      console.warn("[voice] tts failed:", err instanceof AiError ? `${err.code} ${err.detail ?? ""}` : (err as Error).message);
      return NextResponse.json({ error: message }, { status: 502 });
    }
  }
  return new NextResponse(speech.audio, { status: 200, headers: { "Content-Type": speech.contentType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
}
