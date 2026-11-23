import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { syncDb } from "@/lib/db/store";
import { canViewTidyCheck } from "@/lib/auth/permissions";
import { readObject } from "@/lib/storage";

export const dynamic = "force-dynamic";

/** 整理整頓チェックの写真: /api/tidy/photos/<チェックの ID>/<写真の ID>?size=thumb (縮小画像) &download=1 (保存)。チェックを見られる人だけ */
export async function GET(req: Request, { params }: { params: Promise<{ checkId: string; photoId: string }> }) {
  const { checkId, photoId } = await params;
  const user = await getSessionUser();
  if (!user) return new NextResponse("ログインが必要です。", { status: 401 });
  const db = await syncDb();
  const c = (db.tidyChecks ?? []).find((x) => x.id === checkId);
  const p = c?.photos.find((x) => x.id === photoId);
  if (!c || !p) return new NextResponse("写真が見つかりません。", { status: 404 });
  if (!canViewTidyCheck(user, c)) return new NextResponse("この写真を表示する権限がありません。", { status: 403 });
  const url = new URL(req.url);
  const thumb = url.searchParams.get("size") === "thumb" && p.thumbKey;
  const download = url.searchParams.get("download") === "1";
  const body = await readObject(thumb ? p.thumbKey! : p.key);
  if (!body) return new NextResponse("写真の本体が見つかりません。", { status: 404 });
  const type = thumb ? "image/jpeg" : p.contentType.startsWith("image/") && p.contentType !== "image/svg+xml" ? p.contentType : "application/octet-stream";
  return new NextResponse(new Uint8Array(body), {
    headers: {
      "Cache-Control": "private, max-age=600",
      "X-Content-Type-Options": "nosniff",
      "Content-Type": type,
      "Content-Length": String(body.length),
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(p.fileName)}`,
    },
  });
}
