import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { syncDb } from "@/lib/db/store";
import { canViewAttachment } from "@/lib/attachments";
import { readObject } from "@/lib/storage";

export const dynamic = "force-dynamic";

/**
 * 添付ファイルの表示・ダウンロード: /api/attachments/<ID>?size=thumb (縮小画像) &download=1 (保存)
 * ログインと閲覧権限 (登録先の記録の店舗・ロール) を確かめてから、このサーバー (VPS) に保存したファイルを返す
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) return new NextResponse("ログインが必要です。", { status: 401 });
  const db = await syncDb();
  const a = db.attachments.find((x) => x.id === id);
  if (!a) return new NextResponse("ファイルが見つかりません。", { status: 404 });
  if (!canViewAttachment(user, db, a)) return new NextResponse("このファイルを表示する権限がありません。", { status: 403 });

  const url = new URL(req.url);
  const thumb = url.searchParams.get("size") === "thumb" && a.thumbKey;
  const download = url.searchParams.get("download") === "1";
  const key = thumb ? a.thumbKey! : a.storageKey;
  const body = await readObject(key);
  if (!body) {
    console.error("[attachments] file missing on disk:", a.id, key);
    return new NextResponse("ファイルの本体が見つかりません。", { status: 404 });
  }
  const type = thumb ? "image/jpeg" : a.contentType;
  // 画像と PDF 以外はブラウザで開かず保存させる (HTML などを同じドメインで表示させない)
  const inline = !download && (type.startsWith("image/") || type === "application/pdf") && type !== "image/svg+xml";
  return new NextResponse(new Uint8Array(body), {
    headers: {
      // ファイルの中身は変わらない (キーは ID ごと)。権限の変更をすぐ反映できるよう、ブラウザでの保持は 10 分まで
      "Cache-Control": "private, max-age=600",
      "X-Content-Type-Options": "nosniff",
      "Content-Type": type,
      "Content-Length": String(body.length),
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(a.fileName)}`,
    },
  });
}
