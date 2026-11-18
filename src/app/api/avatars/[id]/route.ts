import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { isDemoAccount, isReviewAccount } from "@/lib/auth/permissions";
import { syncDb } from "@/lib/db/store";
import { readObject } from "@/lib/storage";

export const dynamic = "force-dynamic";

/**
 * 社員の顔写真: /api/avatars/<ユーザー ID>?v=<更新日時>
 * - ログイン中: どの社員の顔写真も見られる (ヘッダー・担当者の表示)
 * - 未ログイン: 有効な本番社員 (デモ用・確認用以外) の顔写真だけ (公開の「権限と担当」ページ用)
 * URL は写真を変えるたびに変わるため長めにキャッシュする
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await syncDb();
  const target = db.users.find((u) => u.id === id);
  if (!target?.avatarKey) return new NextResponse("顔写真は登録されていません。", { status: 404 });

  const viewer = await getSessionUser();
  if (!viewer) {
    if (!target.active || isDemoAccount(target) || isReviewAccount(target)) {
      return new NextResponse("ログインが必要です。", { status: 401 });
    }
  }

  const body = await readObject(target.avatarKey).catch((err) => {
    console.error("[avatars] read failed:", err);
    return null;
  });
  if (!body) return new NextResponse("顔写真が見つかりません。", { status: 404 });
  const type = target.avatarKey.endsWith(".png") ? "image/png" : target.avatarKey.endsWith(".webp") ? "image/webp" : "image/jpeg";
  return new NextResponse(new Uint8Array(body), {
    headers: {
      "Content-Type": type,
      "Content-Length": String(body.length),
      "Cache-Control": viewer ? "private, max-age=86400" : "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
