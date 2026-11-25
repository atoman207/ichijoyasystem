import "server-only";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import type { User } from "@/lib/db/types";

/** チャットの API (/api/chat/*) の共通: ログインした社員だけ。応答はキャッシュしない */
export const NO_STORE = { "Cache-Control": "private, no-store" };

export async function chatUser(): Promise<User | NextResponse> {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ ok: false, error: "ログインし直してください。" }, { status: 401, headers: NO_STORE });
  return user;
}

export function json<T>(data: T, status = 200) {
  return NextResponse.json(data, { status, headers: NO_STORE });
}

export function jsonError(status: number, error: string) {
  return NextResponse.json({ ok: false, error }, { status, headers: NO_STORE });
}

/** 同じサイトの画面からの送信だけを受け付ける (ほかのサイトからの書き込みを防ぐ) */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.get("host");
  } catch {
    return false;
  }
}
