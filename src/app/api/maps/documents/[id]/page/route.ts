import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { addAudit, mutate, syncDb } from "@/lib/db/store";
import { canViewMapDocument } from "@/lib/maps/access";
import { docLabel, mapTablesReady, shouldLogView } from "@/lib/maps/store";
import { pageNumber, renderMapPage, type RenderSize } from "@/lib/maps/render";

export const dynamic = "force-dynamic";

/**
 * 住宅地図の 1 ページの画像 (PNG): /api/maps/documents/<ID>/page?p=1&size=view|preview
 * 権限は PDF (/api/maps/documents/<ID>) と同じ。画面の中で地図を見るため (src/lib/maps/render.ts)。
 * 1 ページ目を出したときに、PDF と同じく変更履歴に「表示」を残す (同じ人・同じ地図は 10 分に 1 回)
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) return new NextResponse("ログインが必要です。", { status: 401 });
  const db = await syncDb();
  const doc = db.mapDocuments.find((d) => d.id === id);
  if (!doc) return new NextResponse("住宅地図が見つかりません。", { status: 404 });
  if (!canViewMapDocument(user, db, doc)) return new NextResponse("この住宅地図を表示する権限がありません。", { status: 403 });
  if (doc.status === "removed" || !doc.storageKey) return new NextResponse("この住宅地図は取り消されています。", { status: 410 });
  const sp = new URL(req.url).searchParams;
  const page = pageNumber(sp.get("p"), doc);
  if (!page) return new NextResponse("ページの番号が正しくありません。", { status: 400 });
  const size: RenderSize = sp.get("size") === "preview" ? "preview" : "view";
  const etag = `"${(doc.sha256 || doc.id).slice(0, 24)}-${page}-${size}"`;
  if (req.headers.get("if-none-match") === etag) return new NextResponse(null, { status: 304, headers: { ETag: etag, "Cache-Control": "private, no-cache" } });
  let png: Buffer | null;
  try {
    png = await renderMapPage(doc, page, size);
  } catch (err) {
    console.error("[maps] render failed:", doc.id, (err as Error).message);
    return new NextResponse("地図を画像にできませんでした。", { status: 503 });
  }
  if (!png) return new NextResponse("ファイルの本体が見つかりません。", { status: 404 });
  if (page === 1 && mapTablesReady() && shouldLogView(user.id, doc.id)) {
    await mutate((d) => {
      addAudit(d, { userId: user.id, action: "view", entity: "map_document", entityId: doc.id, entityLabel: docLabel(doc), summary: `住宅地図を表示 (「${docLabel(doc)}」${doc.status === "replaced" ? " / 差し替え前の版" : ""})`, storeId: doc.storeId });
    }).catch((err) => console.warn("[maps] view log failed:", (err as Error).message));
  }
  return new NextResponse(new Uint8Array(png), {
    headers: {
      // 取り消し・権限の変更がすぐ効くよう、毎回確かめる (変わっていなければ 304)
      "Cache-Control": "private, no-cache",
      ETag: etag,
      "X-Content-Type-Options": "nosniff",
      "Content-Type": "image/png",
      "Content-Length": String(png.length),
    },
  });
}
