import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { BACKEND, syncDb } from "@/lib/db/store";
import { canViewAttachment } from "@/lib/attachments";
import { readLocalObject, signedUrl } from "@/lib/storage";

export const dynamic = "force-dynamic";

/**
 * 添付ファイルの表示・ダウンロード: /api/attachments/<ID>?size=thumb (縮小画像) &download=1 (保存)
 * ログインと閲覧権限 (登録先の記録の店舗・ロール) を確かめてから、
 * 本番は Supabase Storage の期限つき URL (2 分) へ転送、ローカルはファイルをそのまま返す
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
  const headers = { "Cache-Control": "private, max-age=60", "X-Content-Type-Options": "nosniff" };

  if (BACKEND === "supabase") {
    try {
      return NextResponse.redirect(await signedUrl(key, download ? a.fileName : undefined), { status: 302, headers });
    } catch (err) {
      console.error("[attachments] signed url failed:", err);
      return new NextResponse("ファイルを開けませんでした。時間をおいて再度お試しください。", { status: 502 });
    }
  }
  const body = await readLocalObject(key);
  if (!body) return new NextResponse("ファイルの本体が見つかりません。", { status: 404 });
  const type = thumb ? "image/jpeg" : a.contentType;
  // 画像と PDF 以外はブラウザで開かず保存させる (HTML などを同じドメインで表示させない)
  const inline = !download && (type.startsWith("image/") || type === "application/pdf") && type !== "image/svg+xml";
  return new NextResponse(new Uint8Array(body), {
    headers: {
      ...headers,
      "Content-Type": type,
      "Content-Length": String(body.length),
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(a.fileName)}`,
    },
  });
}
