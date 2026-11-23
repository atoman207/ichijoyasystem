import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { canEditCaseStore } from "@/lib/auth/permissions";
import { syncDb } from "@/lib/db/store";
import { pdfHeaders, quotePdfData } from "@/lib/pdf/data";
import { renderQuotePdf } from "@/lib/pdf/render";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** 見積書 PDF: /api/pdf/quotes/<見積ID> (?version=2 で改訂前の版、&download=1 で保存) */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) return new NextResponse("ログインが必要です。", { status: 401 });
  const db = await syncDb();
  const q = db.quotes.find((x) => x.id === id);
  if (!q) return new NextResponse("見積が見つかりません。", { status: 404 });
  // 見積を扱える店舗 (店長は全店舗。permissions.ts の canEditCaseStore)
  if (!canEditCaseStore(user, q.storeId)) return new NextResponse("この見積を表示する権限がありません。", { status: 403 });
  const url = new URL(req.url);
  const v = url.searchParams.get("version");
  const version = v && /^\d+$/.test(v) ? Number(v) : undefined;
  const data = quotePdfData(db, q, version);
  if (!data) return new NextResponse("指定した版が見つかりません。", { status: 404 });
  try {
    const bytes = await renderQuotePdf(data);
    const name = `御見積書_${q.number}${data.version > 1 ? `_第${data.version}版` : ""}.pdf`;
    return new NextResponse(Buffer.from(bytes), { status: 200, headers: pdfHeaders(name, url.searchParams.get("download") === "1") });
  } catch (err) {
    console.error("[pdf] quote failed:", err);
    return new NextResponse("PDF を作成できませんでした。時間をおいて、もう一度お試しください。", { status: 500 });
  }
}
