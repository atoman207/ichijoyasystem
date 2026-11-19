import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { getSessionUser } from "@/lib/auth/session";
import { syncDb } from "@/lib/db/store";
import { canManageMaps } from "@/lib/auth/permissions";
import { cancelBatch, readBatchState, startBatch, stepBatch } from "@/lib/maps/batch";
import { mapTablesMissing } from "@/lib/maps/store";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 地図の一括処理 (本部スタッフ・管理者)。画面が「1 回分ずつ」繰り返し呼ぶ (途中で閉じても続きから再開できる)
 * JSON: { action: "start", kind: "normalize" | "pdf_import", dryRun, folder?, includeOrders?, shareable?, provider?, copyrightNotice?, licenseRef?, licenseConfirmed? }
 *       { action: "step" | "cancel", jobId }
 */
export async function POST(req: Request) {
  const origin = req.headers.get("origin");
  if (origin && new URL(origin).host !== req.headers.get("host")) return json(403, "この操作は受け付けられません。");
  const user = await getSessionUser();
  if (!user) return json(401, "ログインし直してください。");
  if (!canManageMaps(user)) return json(403, "地図の一括処理は本部スタッフ・管理者が行います。");
  await syncDb();
  const missing = await mapTablesMissing();
  if (missing) return json(503, missing);
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json(400, "内容を読み取れません。");
  }
  try {
    if (body.action === "start") {
      const kind = body.kind === "pdf_import" ? "pdf_import" : "normalize";
      const job = await startBatch(user, {
        kind,
        dryRun: body.dryRun !== false,
        folder: typeof body.folder === "string" ? body.folder : undefined,
        includeOrders: body.includeOrders === true,
        shareable: body.shareable === true,
        provider: body.provider === "other" ? "other" : "zenrin",
        copyrightNotice: typeof body.copyrightNotice === "string" ? body.copyrightNotice : undefined,
        licenseRef: typeof body.licenseRef === "string" ? body.licenseRef : undefined,
        licenseConfirmed: body.licenseConfirmed === true,
      });
      return NextResponse.json({ ok: true, job });
    }
    const jobId = String(body.jobId ?? "");
    if (body.action === "step") {
      const job = await stepBatch(user, jobId);
      if (job.status !== "running") revalidatePath("/maps");
      return NextResponse.json({ ok: true, job });
    }
    if (body.action === "cancel") {
      await cancelBatch(user, jobId);
      return NextResponse.json({ ok: true, job: readBatchState(await syncDb()).current });
    }
    return json(400, "操作が正しくありません。");
  } catch (err) {
    console.error("[maps] batch failed:", err);
    return json(400, (err as Error).message || "一括処理に失敗しました。");
  }
}

function json(status: number, error: string) {
  return NextResponse.json({ ok: false, error }, { status });
}
