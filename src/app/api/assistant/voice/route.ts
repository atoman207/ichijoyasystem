import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { voiceEnabled } from "@/lib/ai/provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 「質問する」の音声の状態: サーバーの読み上げ・音声入力 (OpenAI) が使えるか。使えないときは画面がブラウザーの音声機能を使う */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ tts: false, stt: false }, { status: 401 });
  const on = voiceEnabled();
  return NextResponse.json({ tts: on, stt: on }, { headers: { "Cache-Control": "private, no-store" } });
}
