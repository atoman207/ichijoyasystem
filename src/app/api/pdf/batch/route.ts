import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { syncDb } from "@/lib/db/store";
import { pdfHeaders } from "@/lib/pdf/data";
import { mergePdfs, recordOutputs, renderTarget, type PrintTarget } from "@/lib/doc-print";
import type { DocOutputKind } from "@/lib/db/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const KIND: Record<string, DocOutputKind> = { q: "quote", i: "invoice", r: "receipt" };
const MAX_DOCS = 60;

/**
 * まとめて印刷: /api/pdf/batch?docs=q:<見積ID>,i:<請求書ID>,r:<領収書ID>,… (予定表の「帳票をまとめて印刷」。お客様のご要望 2026-11-25「⑦」)
 * 1 枚ずつ権限を確かめて PDF を作り、1 つの PDF にまとめる。出力の記録は 1 枚ずつ (via = batch。2 回目からは再発行)。
 * 見られない帳票は外し、PDF の名前に枚数を書く
 */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return new NextResponse("ログインが必要です。", { status: 401 });
  const url = new URL(req.url);
  const targets: PrintTarget[] = (url.searchParams.get("docs") ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, MAX_DOCS)
    .map((x) => {
      const [k, id] = x.split(":");
      return KIND[k] && id ? { kind: KIND[k], id } : undefined;
    })
    .filter((x): x is PrintTarget => Boolean(x));
  if (!targets.length) return new NextResponse("印刷する帳票がありません。", { status: 400 });
  const db = await syncDb();
  try {
    const parts: Uint8Array[] = [];
    const inputs = [];
    const skipped: string[] = [];
    for (const t of targets) {
      const r = await renderTarget(db, user, t, "batch");
      if (!r.ok) {
        skipped.push(r.error);
        continue;
      }
      parts.push(r.bytes);
      inputs.push(r.input);
    }
    if (!parts.length) return new NextResponse(`印刷できる帳票がありません (${skipped.slice(0, 3).join(" / ")})。`, { status: 403 });
    const merged = await mergePdfs(parts);
    await recordOutputs(user, inputs);
    const date = url.searchParams.get("date") ?? "";
    return new NextResponse(Buffer.from(merged), { status: 200, headers: { ...pdfHeaders(`帳票_${date || "まとめて"}_${parts.length}枚.pdf`, url.searchParams.get("download") === "1"), ...(skipped.length ? { "X-Skipped": String(skipped.length) } : {}) } });
  } catch (err) {
    console.error("[pdf] batch failed:", err);
    return new NextResponse("PDF を作成できませんでした。時間をおいて、もう一度お試しください。", { status: 500 });
  }
}
