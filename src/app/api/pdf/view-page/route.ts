import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { syncDb } from "@/lib/db/store";
import { docPagePng } from "@/lib/doc-view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** 帳票のページの画像: /api/pdf/view-page?src=<帳票の PDF の場所>&p=<ページ> (画面の中で見る /docs/view。src/lib/doc-view.ts) */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return new NextResponse("ログインが必要です。", { status: 401 });
  const url = new URL(req.url);
  const src = url.searchParams.get("src") ?? "";
  const page = Number(url.searchParams.get("p") ?? "1");
  const db = await syncDb();
  try {
    const r = await docPagePng(db, user, src, page);
    if (!r.ok) return new NextResponse(r.error, { status: r.status });
    return new NextResponse(new Uint8Array(r.png), { status: 200, headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff" } });
  } catch (err) {
    console.error("[doc-view] page failed:", err);
    return new NextResponse("ページを画像にできませんでした。", { status: 500 });
  }
}
