import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { syncDb } from "@/lib/db/store";
import { readObject } from "@/lib/storage";

export const dynamic = "force-dynamic";

/**
 * 社員の顔写真: /api/avatars/<ユーザー ID>?v=<更新日時>
 * ログインしている社員なら誰でも見られる (ヘッダー・担当者の表示に使う)。URL は写真を変えるたびに変わるため長めにキャッシュする
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await getSessionUser();
  if (!viewer) return new NextResponse("ログインが必要です。", { status: 401 });
  const db = await syncDb();
  const key = db.users.find((u) => u.id === id)?.avatarKey;
  if (!key) return new NextResponse("顔写真は登録されていません。", { status: 404 });
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
      "Cache-Control": "private, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
