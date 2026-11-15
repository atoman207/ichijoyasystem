import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { canAccessStore } from "@/lib/auth/permissions";
import { syncDb } from "@/lib/db/store";
import { pdfHeaders, receiptPdfData } from "@/lib/pdf/data";
import { renderReceiptPdf } from "@/lib/pdf/render";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** 領収書 PDF: /api/pdf/receipts/<請求書ID> (入金済みの金額。&download=1 で保存) */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) return new NextResponse("ログインが必要です。", { status: 401 });
  const db = await syncDb();
  const inv = db.invoices.find((x) => x.id === id);
  if (!inv) return new NextResponse("請求書が見つかりません。", { status: 404 });
  if (!canAccessStore(user, inv.storeId)) return new NextResponse("この請求書を表示する権限がありません。", { status: 403 });
  const data = receiptPdfData(db, inv);
  if (!data) return new NextResponse("入金の記録がないため、領収書は出力できません。", { status: 409 });
  try {
    const bytes = await renderReceiptPdf(data);
    const url = new URL(req.url);
    return new NextResponse(Buffer.from(bytes), { status: 200, headers: pdfHeaders(`領収書_${inv.number}.pdf`, url.searchParams.get("download") === "1") });
  } catch (err) {
    console.error("[pdf] receipt failed:", err);
    return new NextResponse("PDF を作成できませんでした。時間をおいて、もう一度お試しください。", { status: 500 });
  }
}
