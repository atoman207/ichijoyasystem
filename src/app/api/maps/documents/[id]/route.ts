import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { addAudit, mutate, syncDb } from "@/lib/db/store";
import { readObject } from "@/lib/storage";
import { canViewMapDocument } from "@/lib/maps/access";
import { docLabel, mapTablesReady, shouldLogView } from "@/lib/maps/store";

export const dynamic = "force-dynamic";

/**
 * 住宅地図の PDF の表示・ダウンロード: /api/maps/documents/<ID>?download=1
 * ログインと閲覧権限 (PDF が結び付いた場所を参照する記録を見られるか) を確かめてから、VPS に保存したファイルを返す。
 * 公開の URL はない。閲覧・ダウンロードは変更履歴に記録する (同じ人・同じ PDF は 10 分に 1 回)
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) return new NextResponse("ログインが必要です。", { status: 401 });
  const db = await syncDb();
  const doc = db.mapDocuments.find((d) => d.id === id);
  if (!doc) return new NextResponse("住宅地図が見つかりません。", { status: 404 });
  if (!canViewMapDocument(user, db, doc)) return new NextResponse("この住宅地図を表示する権限がありません。", { status: 403 });
  if (doc.status === "removed" || !doc.storageKey) return new NextResponse("この住宅地図は取り消されています (ファイルの本体は削除済みです)。", { status: 410 });
  const body = await readObject(doc.storageKey);
  if (!body) {
    console.error("[maps] file missing on disk:", doc.id, doc.storageKey);
    return new NextResponse("ファイルの本体が見つかりません。", { status: 404 });
  }
  const download = new URL(req.url).searchParams.get("download") === "1";
  if (mapTablesReady() && shouldLogView(user.id, doc.id)) {
    await mutate((d) => {
      addAudit(d, { userId: user.id, action: download ? "export" : "view", entity: "map_document", entityId: doc.id, entityLabel: docLabel(doc), summary: `住宅地図を${download ? "ダウンロード" : "表示"} (「${docLabel(doc)}」${doc.status === "replaced" ? " / 差し替え前の版" : ""})`, storeId: doc.storeId });
    }).catch((err) => console.warn("[maps] view log failed:", (err as Error).message));
  }
  return new NextResponse(new Uint8Array(body), {
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Type": "application/pdf",
      "Content-Length": String(body.length),
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(doc.fileName)}`,
    },
  });
}
