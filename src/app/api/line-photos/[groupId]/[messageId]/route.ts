import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { syncDb } from "@/lib/db/store";
import { canUseLineGroupPhotos } from "@/lib/auth/permissions";
import { lineGroups } from "@/lib/line-groups";
import { readObject } from "@/lib/storage";

export const dynamic = "force-dynamic";

/**
 * LINE の「施工事例写真」「整理整頓の確認」グループに届いた写真 (案件・チェックに付ける前。src/lib/line-photos.ts) の表示
 * ログインとグループの店舗のメンバーか (店舗のないグループは全社員) を確かめてから、このサーバーに保存した写真を返す
 */
export async function GET(_req: Request, { params }: { params: Promise<{ groupId: string; messageId: string }> }) {
  const { groupId, messageId } = await params;
  const user = await getSessionUser();
  if (!user) return new NextResponse("ログインが必要です。", { status: 401 });
  const db = await syncDb();
  const g = lineGroups(db).find((x) => x.id === groupId);
  const m = g?.pending.find((x) => x.id === messageId);
  if (!g || !m || m.type !== "image" || (g.purpose !== "photos" && g.purpose !== "tidy")) return new NextResponse("写真が見つかりません。", { status: 404 });
  if (!canUseLineGroupPhotos(user, g.storeId)) return new NextResponse("この写真を表示する権限がありません。", { status: 403 });
  const body = m.fileKey ? await readObject(m.fileKey) : null;
  if (!body) return new NextResponse("写真はまだこのサーバーに保存されていません (付けるときに LINE から取得します)。", { status: 404 });
  const type = (m.contentType ?? "").startsWith("image/") && m.contentType !== "image/svg+xml" ? m.contentType! : "image/jpeg";
  return new NextResponse(new Uint8Array(body), {
    headers: { "Cache-Control": "private, max-age=600", "X-Content-Type-Options": "nosniff", "Content-Type": type, "Content-Length": String(body.length), "Content-Disposition": `inline; filename="LINE_${messageId}.jpg"` },
  });
}
