import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { mutate, newId, syncDb } from "@/lib/db/store";
import { canAccessStore, canEditCaseStore, canSeeAllStores } from "@/lib/auth/permissions";
import { AiError, transcribeAudio, voiceEnabled } from "@/lib/ai/provider";
import { readReception } from "@/lib/ai/reception";
import { withAiContext } from "@/lib/ai/usage";
import { TRANSCRIBE_HINT, fixTranscript } from "@/lib/speech-text";
import { takeVoiceQuota } from "@/lib/voice-usage";
import { CHANNEL_LABEL } from "@/lib/constants";
import { toDateKey } from "@/lib/format";
import type { Channel, StoreId } from "@/lib/db/types";
import { receptionHref } from "@/lib/reception";
import { newReceptionDoc, pushReceptionDoc } from "@/lib/reception-docs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** 録音の大きさの上限 (nginx の 1 回の送信の上限 10 MB に収める。8 kHz の電話の録音なら WAV で約 10 分) */
const MAX_BYTES = 9.5 * 1024 * 1024;
const TYPES = /^audio\/(webm|ogg|mp4|mpeg|mp3|wav|x-wav|wave|m4a|x-m4a|aac|flac|x-flac)\b/;
const EXTS = /\.(webm|ogg|oga|mp4|m4a|mp3|mpeg|mpga|wav|aac|flac)$/i;

/**
 * 通話の録音のファイル (会社の電話の録音装置・スマートフォンの通話録音) → 文字起こし → 受付の読み取り → 確認待ちの受付
 * POST (multipart) file=<録音> storeId=<店舗> channel=<入口>。ログインした社員だけ。応答: { href } (受付の確認画面)
 * 録音の本体は保存しない (文字起こしだけを受付に残す)
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "ログインが必要です。" }, { status: 401 });
  if (!voiceEnabled()) return NextResponse.json({ error: "録音の文字起こしには OpenAI の API キーが必要です (設定 → 外部連携・AI)。" }, { status: 503 });
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File) || file.size === 0) return NextResponse.json({ error: "録音のファイルを選んでください。" }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: `録音のファイルが大きすぎます (${(file.size / 1048576).toFixed(1)} MB)。9.5 MB 以下 (電話の録音で約 10 分) にしてください。` }, { status: 413 });
  const type = (file.type || "").toLowerCase();
  if (!TYPES.test(type) && !EXTS.test(file.name)) return NextResponse.json({ error: "この形式の録音は使えません (MP3・WAV・M4A・WebM・OGG)。" }, { status: 415 });
  if (!takeVoiceQuota("stt", user.id)) return NextResponse.json({ error: "文字起こしの回数が 1 時間の上限に達しました。しばらくしてからお試しください。" }, { status: 429 });
  const db = await syncDb();
  const requested = String(form?.get("storeId") ?? "") as StoreId;
  const storeId: StoreId = requested && canSeeAllStores(user) && db.stores.some((s) => s.id === requested) ? requested : user.storeId;
  if (!canAccessStore(user, storeId)) return NextResponse.json({ error: "この店舗の受付は登録できません。" }, { status: 403 });
  const ch = String(form?.get("channel") ?? "phone");
  const channel: Channel = ch in CHANNEL_LABEL ? (ch as Channel) : "phone";
  const staff = db.users.filter((u) => u.active).map((u) => u.name.replace(/\s+/g, "")).join("、");
  let text: string;
  try {
    const r = await withAiContext({ kind: "reception", userId: user.id }, () => transcribeAudio(file, file.name || "call.wav", `${TRANSCRIBE_HINT}、${staff}、お電話ありがとうございます、表替え、新調、張替え、引き取り、納品、見積もり、現地調査`, { timeoutMs: 110_000 }));
    text = fixTranscript(r.text);
  } catch (err) {
    const message = err instanceof AiError ? err.message : "録音を文字にできませんでした。";
    console.warn("[reception] stt failed:", err instanceof AiError ? `${err.code} ${err.detail ?? ""}` : (err as Error).message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
  if (text.length < 4) return NextResponse.json({ error: "録音から言葉を聞き取れませんでした (無音・雑音だけの録音の可能性があります)。" }, { status: 422 });
  const read = await withAiContext({ kind: "reception", userId: user.id }, () => readReception(db, { text, today: toDateKey(new Date()) }));
  const id = newId("doc");
  const presetId = String(form?.get("customerId") ?? "");
  const preset = presetId ? db.customers.find((c) => c.id === presetId && canEditCaseStore(user, c.storeId)) : undefined;
  const doc = newReceptionDoc({ id, uploadedBy: user.id, storeId, source: "audio", channel, fileName: file.name, text, read, customerId: preset?.id });
  await mutate((d) => pushReceptionDoc(d, doc, user.id));
  return NextResponse.json({ href: receptionHref(id) }, { headers: { "Cache-Control": "private, no-store" } });
}
