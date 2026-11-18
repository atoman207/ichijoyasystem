import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { canViewPurchaseOrder } from "@/lib/auth/permissions";
import { syncDb } from "@/lib/db/store";
import { pdfHeaders } from "@/lib/pdf/data";
import { renderPurchaseOrderPdf } from "@/lib/pdf/render";
import { poFileName, purchaseOrderPdfData } from "@/lib/purchase-orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** 発注書 PDF (いまの内容): /api/pdf/purchase-orders/<発注書ID> (&download=1 で保存)。送信した PDF は FAX の記録 (/api/fax/<ID>) */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) return new NextResponse("ログインが必要です。", { status: 401 });
  const db = await syncDb();
  const po = db.purchaseOrders.find((x) => x.id === id);
  if (!po) return new NextResponse("発注書が見つかりません。", { status: 404 });
  if (!canViewPurchaseOrder(user, po)) return new NextResponse("この発注書を表示する権限がありません。", { status: 403 });
  try {
    const bytes = await renderPurchaseOrderPdf(purchaseOrderPdfData(db, po));
    return new NextResponse(Buffer.from(bytes), { status: 200, headers: pdfHeaders(poFileName(po), new URL(req.url).searchParams.get("download") === "1") });
  } catch (err) {
    console.error("[pdf] purchase order failed:", err);
    return new NextResponse("PDF を作成できませんでした。時間をおいて、もう一度お試しください。", { status: 500 });
  }
}
