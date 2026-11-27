import { NextResponse } from "next/server";
import { PDFDocument } from "pdf-lib";
import { getSessionUser } from "@/lib/auth/session";
import { syncDb } from "@/lib/db/store";
import { canViewAttachment } from "@/lib/attachments";
import { readObject } from "@/lib/storage";
import { pdfPageToPng } from "@/lib/maps/render";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** 印刷用に画像にする PDF のページ数の上限と幅 */
const MAX_PAGES = 20;
const WIDTH = 1600;

/**
 * PDF の資料 (現場図面・採寸図など) のページの画像: /api/attachments/<ID>/page?p=<ページ> (PNG) / ?info=1 (ページ数の JSON)。
 * 材料発注の画面の「印刷」で、図面を見積の内容と一緒に 1 回で印刷するために使う (お客様のご要望 2026-11-27)。
 * 閲覧の権限は /api/attachments/<ID> と同じ (登録先の記録)
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) return new NextResponse("ログインが必要です。", { status: 401 });
  const db = await syncDb();
  const a = db.attachments.find((x) => x.id === id);
  if (!a) return new NextResponse("ファイルが見つかりません。", { status: 404 });
  if (!canViewAttachment(user, db, a)) return new NextResponse("このファイルを表示する権限がありません。", { status: 403 });
  if (a.contentType !== "application/pdf") return new NextResponse("PDF ではありません。", { status: 400 });
  const body = await readObject(a.storageKey);
  if (!body) return new NextResponse("ファイルの本体が見つかりません。", { status: 404 });
  const url = new URL(req.url);
  let pages = 0;
  try {
    pages = (await PDFDocument.load(body, { ignoreEncryption: true })).getPageCount();
  } catch {
    return new NextResponse("PDF を読めませんでした。", { status: 422 });
  }
  if (url.searchParams.get("info") === "1") {
    return NextResponse.json({ pages: Math.min(pages, MAX_PAGES), total: pages }, { headers: { "Cache-Control": "private, max-age=300" } });
  }
  const p = Math.floor(Number(url.searchParams.get("p") ?? "1"));
  if (!Number.isFinite(p) || p < 1 || p > Math.min(pages, MAX_PAGES)) return new NextResponse("ページがありません。", { status: 404 });
  try {
    const png = await pdfPageToPng(body, p, WIDTH);
    return new NextResponse(new Uint8Array(png), { headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=600", "X-Content-Type-Options": "nosniff" } });
  } catch (err) {
    console.error("[attachments/page] render failed:", a.id, (err as Error).message);
    return new NextResponse("ページを画像にできませんでした。", { status: 500 });
  }
}
