import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { canOutputDocument } from "@/lib/auth/permissions";
import { invoiceAccessInfo } from "@/lib/case-access";
import { syncDb } from "@/lib/db/store";
import { pdfHeaders, receiptPdfData } from "@/lib/pdf/data";
import { renderReceiptPdf } from "@/lib/pdf/render";
import { recordOutputs, renderTarget } from "@/lib/doc-print";
import { activeReceipts } from "@/lib/receipts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * 領収書 PDF: /api/pdf/receipts/<領収書ID> (領収書の台帳の 1 枚。2 回目の出力から「再発行」と印字。&download=1 で保存)。
 * 請求書の ID のとき: 発行した領収書が 1 枚ならその領収書、台帳がなければ今までどおり入金の記録から作る (出力の記録は請求書の ID)
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) return new NextResponse("ログインが必要です。", { status: 401 });
  const db = await syncDb();
  const download = new URL(req.url).searchParams.get("download") === "1";
  const via = download ? "download" : "view";
  try {
    const inv = db.invoices.find((x) => x.id === id);
    const receiptId = inv ? (activeReceipts(db, inv.id).length === 1 ? activeReceipts(db, inv.id)[0].id : undefined) : id;
    if (inv && !receiptId) {
      if (activeReceipts(db, inv.id).length > 1) return new NextResponse("この請求書には領収書が複数あります。請求書の画面の「領収書」から 1 枚ずつ開いてください。", { status: 409 });
      if (!canOutputDocument(user, invoiceAccessInfo(db, user, inv).access)) return new NextResponse("この請求書を表示する権限がありません。", { status: 403 });
      const data = receiptPdfData(db, inv);
      if (!data) return new NextResponse("入金の記録がないため、領収書は出力できません (請求書の画面の「領収書を発行」から、支払方法の内訳をつけて発行できます)。", { status: 409 });
      const bytes = await renderReceiptPdf(data);
      await recordOutputs(user, [{ kind: "receipt", refId: inv.id, number: data.number, storeId: inv.storeId, customerId: inv.customerId, orderId: inv.orderId, via }]);
      return new NextResponse(Buffer.from(bytes), { status: 200, headers: pdfHeaders(`領収書_${inv.number}.pdf`, download) });
    }
    const r = await renderTarget(db, user, { kind: "receipt", id: receiptId! }, via);
    if (!r.ok) return new NextResponse(r.error, { status: r.status });
    await recordOutputs(user, [r.input]);
    return new NextResponse(Buffer.from(r.bytes), { status: 200, headers: pdfHeaders(r.fileName, download) });
  } catch (err) {
    console.error("[pdf] receipt failed:", err);
    return new NextResponse("PDF を作成できませんでした。時間をおいて、もう一度お試しください。", { status: 500 });
  }
}
