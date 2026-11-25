import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { syncDb } from "@/lib/db/store";
import { pdfHeaders } from "@/lib/pdf/data";
import { recordOutputs, renderTarget } from "@/lib/doc-print";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * 見積書 PDF: /api/pdf/quotes/<見積ID> (?version=2 で改訂前の版、&download=1 で保存)。
 * 見積を見られる社員なら出力でき、出力の記録を残す (お客様のご要望 2026-11-25「⑥」。src/lib/doc-print.ts)
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) return new NextResponse("ログインが必要です。", { status: 401 });
  const db = await syncDb();
  const url = new URL(req.url);
  const v = url.searchParams.get("version");
  const download = url.searchParams.get("download") === "1";
  try {
    const r = await renderTarget(db, user, { kind: "quote", id, version: v && /^\d+$/.test(v) ? Number(v) : undefined }, download ? "download" : "view");
    if (!r.ok) return new NextResponse(r.error, { status: r.status });
    await recordOutputs(user, [r.input]);
    return new NextResponse(Buffer.from(r.bytes), { status: 200, headers: pdfHeaders(r.fileName, download) });
  } catch (err) {
    console.error("[pdf] quote failed:", err);
    return new NextResponse("PDF を作成できませんでした。時間をおいて、もう一度お試しください。", { status: 500 });
  }
}
