import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { canAccessStore } from "@/lib/auth/permissions";
import { syncDb } from "@/lib/db/store";
import { invoicePdfData, pdfHeaders } from "@/lib/pdf/data";
import { renderInvoicePdf } from "@/lib/pdf/render";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** 請求書 PDF: /api/pdf/invoices/<請求書ID> (&download=1 で保存) */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) return new NextResponse("ログインが必要です。", { status: 401 });
  const db = await syncDb();
  const inv = db.invoices.find((x) => x.id === id);
  if (!inv) return new NextResponse("請求書が見つかりません。", { status: 404 });
  if (!canAccessStore(user, inv.storeId)) return new NextResponse("この請求書を表示する権限がありません。", { status: 403 });
  try {
    const bytes = await renderInvoicePdf(invoicePdfData(db, inv));
    const url = new URL(req.url);
    return new NextResponse(Buffer.from(bytes), { status: 200, headers: pdfHeaders(`請求書_${inv.number}.pdf`, url.searchParams.get("download") === "1") });
  } catch (err) {
    console.error("[pdf] invoice failed:", err);
    return new NextResponse("PDF を作成できませんでした。時間をおいて、もう一度お試しください。", { status: 500 });
  }
}
