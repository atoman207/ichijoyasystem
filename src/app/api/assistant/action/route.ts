import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { runAction } from "@/lib/assistant/action-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * AI アシスタントの確認のカードの「実行する」: POST { token } → { ok, message, href? }
 * ログインした本人だけ。カードの署名・期限・1 回だけの実行は src/lib/assistant/action-run.ts、
 * 権限・入力の確かめ・変更履歴・通知は画面のボタンと同じ Server Action が行う
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ ok: false, message: "ログインが必要です。" }, { status: 401 });
  // 別のサイトからの送信は断る (ログインの Cookie は SameSite=Lax。念のため Origin も確かめる)
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) return NextResponse.json({ ok: false, message: "この画面からは実行できません。" }, { status: 403 });
    } catch {
      return NextResponse.json({ ok: false, message: "この画面からは実行できません。" }, { status: 403 });
    }
  }
  const body = (await req.json().catch(() => null)) as { token?: unknown } | null;
  const token = typeof body?.token === "string" ? body.token.slice(0, 20000) : "";
  if (!token) return NextResponse.json({ ok: false, message: "確認のカードがありません。" }, { status: 400 });
  const r = await runAction(token, user);
  return NextResponse.json(r, { status: r.ok ? 200 : 422, headers: { "Cache-Control": "no-store" } });
}
