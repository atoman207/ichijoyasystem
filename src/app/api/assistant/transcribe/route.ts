import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { syncDb } from "@/lib/db/store";
import { AiError, transcribeAudio, voiceEnabled } from "@/lib/ai/provider";
import { TRANSCRIBE_HINT, fixTranscript } from "@/lib/speech-text";
import { takeVoiceQuota } from "@/lib/voice-usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 1 回の録音の上限 (画面は 60 秒で自動的に止める) */
const MAX_BYTES = 8 * 1024 * 1024;
const TYPES = /^audio\/(webm|ogg|mp4|mpeg|mp3|wav|x-wav|m4a|x-m4a|aac)\b/;

/**
 * 「質問する」の音声入力: POST (multipart) audio=<録音> → { text }。日本語で文字にし、社名・店舗名の聞き違いを直す。
 * ログインした社員だけ (ログイン前の画面はブラウザーの音声認識)
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "ログインが必要です。" }, { status: 401 });
  if (!voiceEnabled()) return NextResponse.json({ error: "音声入力は設定されていません。" }, { status: 503 });
  const form = await req.formData().catch(() => null);
  const audio = form?.get("audio");
  if (!(audio instanceof Blob) || audio.size === 0) return NextResponse.json({ error: "録音がありません。" }, { status: 400 });
  if (audio.size > MAX_BYTES) return NextResponse.json({ error: "録音が長すぎます (1 分以内でお話しください)。" }, { status: 413 });
  const type = (audio.type || "audio/webm").toLowerCase();
  if (!TYPES.test(type)) return NextResponse.json({ error: "この形式の録音は使えません。" }, { status: 415 });
  if (!takeVoiceQuota("stt", user.id)) return NextResponse.json({ error: "音声入力の回数が 1 時間の上限に達しました。しばらくしてからお試しください。" }, { status: 429 });
  const ext = type.includes("mp4") || type.includes("m4a") || type.includes("aac") ? "m4a" : type.includes("ogg") ? "ogg" : type.includes("wav") ? "wav" : type.includes("mpeg") || type.includes("mp3") ? "mp3" : "webm";
  // 聞き取りの手がかり: 社名・店舗名・よく使う言葉と、社員の名前
  const db = await syncDb();
  const staff = db.users.filter((u) => u.active).map((u) => u.name.replace(/\s+/g, "")).join("、");
  try {
    const r = await transcribeAudio(audio, `voice.${ext}`, `${TRANSCRIBE_HINT}、${staff}`);
    return NextResponse.json({ text: fixTranscript(r.text) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    const message = err instanceof AiError ? err.message : "音声を文字にできませんでした。";
    console.warn("[voice] stt failed:", err instanceof AiError ? `${err.code} ${err.detail ?? ""}` : (err as Error).message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
