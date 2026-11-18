import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { canViewFax } from "@/lib/auth/permissions";
import { syncDb } from "@/lib/db/store";
import { readObject } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * FAX の PDF (送った内容・届いた内容): /api/fax/<FAX の ID> (&download=1 で保存)
 * ログインと閲覧権限 (permissions.ts の canViewFax) を確かめてから、このサーバー (VPS) に保存したファイルを返す
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) return new NextResponse("ログインが必要です。", { status: 401 });
  const db = await syncDb();
  const f = db.faxMessages.find((x) => x.id === id);
  if (!f || !f.fileKey) return new NextResponse("FAX が見つかりません。", { status: 404 });
  if (!canViewFax(user, f)) return new NextResponse("この FAX を表示する権限がありません。", { status: 403 });
  const body = await readObject(f.fileKey);
  if (!body) {
    console.error("[fax] file missing on disk:", f.id);
    return new NextResponse("FAX のファイルが見つかりません。", { status: 404 });
  }
  const download = new URL(req.url).searchParams.get("download") === "1";
  const ascii = f.fileName.replace(/[^\x20-\x7e]/g, "_");
  return new NextResponse(new Uint8Array(body), {
    headers: {
      "Content-Type": f.contentType,
      "Content-Length": String(body.length),
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.fileName)}`,
      "Cache-Control": "private, max-age=600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
