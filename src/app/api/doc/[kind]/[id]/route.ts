import { NextResponse } from "next/server";
import { syncDb } from "@/lib/db/store";
import { invoicePdfData, pdfHeaders, quotePdfData, receiptPdfData } from "@/lib/pdf/data";
import { renderInvoicePdf, renderQuotePdf, renderReceiptPdf } from "@/lib/pdf/render";
import { DOC_KINDS, verifyDocLink, type DocKind } from "@/lib/notify/doc-link";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * お客様に送った見積書・請求書・領収書の PDF (ログインなし・期限つきの署名リンク)
 * /api/doc/<quote|invoice|receipt>/<ID>?exp=<期限>&sig=<署名>
 * 署名が合わない・期限切れ・無効化した請求書は開けない。検索エンジンに載らないよう noindex を付ける
 */
export async function GET(req: Request, { params }: { params: Promise<{ kind: string; id: string }> }) {
  const { kind, id } = await params;
  const url = new URL(req.url);
  const text = (msg: string, status: number) => new NextResponse(msg, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "X-Robots-Tag": "noindex", "Cache-Control": "no-store" } });
  if (!DOC_KINDS.includes(kind as DocKind)) return text("リンクが正しくありません。", 404);
  const check = verifyDocLink(kind as DocKind, id, url.searchParams.get("exp"), url.searchParams.get("sig"));
  if (check === "invalid") return text("リンクが正しくありません。", 403);
  if (check === "expired") return text("リンクの有効期限が切れています。お手数ですが、株式会社一畳屋までご連絡ください。", 410);
  const db = await syncDb();
  try {
    let bytes: Uint8Array;
    let name: string;
    if (kind === "quote") {
      const q = db.quotes.find((x) => x.id === id);
      const data = q ? quotePdfData(db, q) : null;
      if (!q || !data) return text("見積書が見つかりません。", 404);
      bytes = await renderQuotePdf(data);
      name = `御見積書_${q.number}.pdf`;
    } else {
      const inv = db.invoices.find((x) => x.id === id);
      if (!inv || inv.status === "void") return text("請求書が見つかりません。", 404);
      if (kind === "invoice") {
        bytes = await renderInvoicePdf(invoicePdfData(db, inv));
        name = `御請求書_${inv.number}.pdf`;
      } else {
        const data = receiptPdfData(db, inv);
        if (!data) return text("領収書はまだ発行できません。", 404);
        bytes = await renderReceiptPdf(data);
        name = `領収書_${inv.number}.pdf`;
      }
    }
    return new NextResponse(Buffer.from(bytes), { status: 200, headers: { ...pdfHeaders(name, false), "X-Robots-Tag": "noindex" } });
  } catch (err) {
    console.error("[doc] pdf failed:", err);
    return text("PDF を作成できませんでした。時間をおいて、もう一度お試しください。", 500);
  }
}
