import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { canManageUserAvatar, isDemoAccount, isReviewAccount } from "@/lib/auth/permissions";
import { findAvatarPhoto, validAvatarPhotoId } from "@/lib/avatar-photos";
import { syncDb } from "@/lib/db/store";
import { readObject } from "@/lib/storage";

export const dynamic = "force-dynamic";

/**
 * 社員の顔写真: /api/avatars/<ユーザー ID>?v=<更新日時>
 * - ログイン中: どの社員の顔写真も見られる (ヘッダー・担当者の表示)
 * - 未ログイン: 有効な本番社員 (デモ用・確認用以外) の顔写真だけ (公開の「権限と担当」ページ用)
 * - 「表示しない」にした顔写真は返さない (404 = 画面は名前の 1 文字の丸)
 * - ?photo=<写真の ID>: 非表示の写真・以前の写真の確認 (本人と管理者だけ。src/lib/avatar-photos.ts)
 * URL は写真を変えるたびに変わるため長めにキャッシュする
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await syncDb();
  const target = db.users.find((u) => u.id === id);
  if (!target) return new NextResponse("顔写真は登録されていません。", { status: 404 });
  const photoId = new URL(req.url).searchParams.get("photo");
  const viewer = await getSessionUser();

  let key: string | undefined;
  if (photoId) {
    if (!viewer) return new NextResponse("ログインが必要です。", { status: 401 });
    if (!canManageUserAvatar(viewer, target)) return new NextResponse("この写真を見る権限がありません。", { status: 403 });
    key = validAvatarPhotoId(photoId) ? findAvatarPhoto(target, photoId)?.key : undefined;
    if (!key) return new NextResponse("写真が見つかりません。", { status: 404 });
  } else {
    if (!target.avatarKey || target.avatarHidden) return new NextResponse("顔写真は登録されていません。", { status: 404 });
    if (!viewer && (!target.active || isDemoAccount(target) || isReviewAccount(target))) {
      return new NextResponse("ログインが必要です。", { status: 401 });
    }
    key = target.avatarKey;
  }

  const body = await readObject(key).catch((err) => {
    console.error("[avatars] read failed:", err);
    return null;
  });
  if (!body) return new NextResponse("顔写真が見つかりません。", { status: 404 });
  const type = key.endsWith(".png") ? "image/png" : key.endsWith(".webp") ? "image/webp" : "image/jpeg";
  return new NextResponse(new Uint8Array(body), {
    headers: {
      "Content-Type": type,
      "Content-Length": String(body.length),
      "Cache-Control": photoId ? "private, max-age=600" : viewer ? "private, max-age=86400" : "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
