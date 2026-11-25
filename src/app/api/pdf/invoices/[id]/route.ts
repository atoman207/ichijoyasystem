import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { syncDb } from "@/lib/db/store";
import { pdfHeaders } from "@/lib/pdf/data";
import { recordOutputs, renderTarget } from "@/lib/doc-print";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * 請求書 PDF: /api/pdf/invoices/<請求書ID> (&download=1 で保存)。
 * 請求書を見られる社員なら出力でき、出力の記録を残す (お客様のご要望 2026-11-25「⑥」。金額・入金を変える権限とは別)
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) return new NextResponse("ログインが必要です。", { status: 401 });
  const db = await syncDb();
  const download = new URL(req.url).searchParams.get("download") === "1";
  try {
    const r = await renderTarget(db, user, { kind: "invoice", id }, download ? "download" : "view");
    if (!r.ok) return new NextResponse(r.error, { status: r.status });
    await recordOutputs(user, [r.input]);
    return new NextResponse(Buffer.from(r.bytes), { status: 200, headers: pdfHeaders(r.fileName, download) });
  } catch (err) {
    console.error("[pdf] invoice failed:", err);
    return new NextResponse("PDF を作成できませんでした。時間をおいて、もう一度お試しください。", { status: 500 });
  }
}
