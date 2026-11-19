import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { addAudit, mutate, syncDb } from "@/lib/db/store";
import { canManageMaps } from "@/lib/auth/permissions";
import { importReportCsv, normalizeReportCsv, readBatchState } from "@/lib/maps/batch";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 一括処理の報告 (CSV・UTF-8 BOM 付き。Excel で開ける): /api/maps/batch/report?job=<ID>
 * 正規化は記録ごと (元の住所・正規化した住所・状態・同じ番地の記録の数)、一括取込はファイルごと (登録・共用・重複・登録先なし・エラー)
 * お客様の住所を含むため、本部スタッフ・管理者だけ。書き出しは変更履歴に記録する
 */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return new NextResponse("ログインが必要です。", { status: 401 });
  if (!canManageMaps(user)) return new NextResponse("地図の一括処理の報告は本部スタッフ・管理者が見られます。", { status: 403 });
  const db = await syncDb();
  const jobId = new URL(req.url).searchParams.get("job") ?? "";
  const job = readBatchState(db).history.find((h) => h.id === jobId);
  if (!job) return new NextResponse("一括処理が見つかりません。", { status: 404 });
  const csv = job.kind === "normalize" ? normalizeReportCsv(db, Boolean(job.includeOrders)) : await importReportCsv(db, job);
  await mutate((d) => addAudit(d, { userId: user.id, action: "export", entity: "map_batch", entityId: job.id, entityLabel: job.kind === "normalize" ? "住所の正規化" : `住宅地図の一括取込 (${job.folder})`, summary: "報告 (CSV) を書き出し" })).catch(() => undefined);
  const name = `${job.kind === "normalize" ? "address-normalize" : "map-import"}-${job.id}.csv`;
  return new NextResponse("﻿" + csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "private, no-store" } });
}
