import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { addAudit, mutate, syncDb } from "@/lib/db/store";
import { canManageMaps } from "@/lib/auth/permissions";
import { toDateKey } from "@/lib/format";
import { missingMapCsv, missingMapRows } from "@/lib/maps/missing";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 住宅地図が未登録の一覧 (CSV・UTF-8 BOM 付き): /api/maps/missing?scope=priority|all
 * priority = 今後の予定・進行中の案件があるものだけ (既定) / all = すべて。ゼンリン GIS で出力する順番と、一括取込のファイル名 (src/lib/maps/missing.ts)。
 * お客様のお名前・住所を含むため、本部スタッフ・管理者だけ。書き出しは変更履歴に記録する
 */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return new NextResponse("ログインが必要です。", { status: 401 });
  if (!canManageMaps(user)) return new NextResponse("住宅地図の未登録の一覧は本部スタッフ・管理者が見られます。", { status: 403 });
  const db = await syncDb();
  const scope = new URL(req.url).searchParams.get("scope") === "all" ? "all" : "priority";
  const today = toDateKey(new Date());
  const rows = missingMapRows(db, today, { scope });
  await mutate((d) => addAudit(d, { userId: user.id, action: "export", entity: "map_batch", entityId: "missing", entityLabel: "住宅地図の未登録の一覧", summary: `CSV を書き出し (${scope === "all" ? "すべて" : "今後の予定・進行中の案件"} ${rows.length} 件)` })).catch(() => undefined);
  return new NextResponse("﻿" + missingMapCsv(db, rows), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="map-missing-${scope}-${today}.csv"`, "Cache-Control": "private, no-store" },
  });
}
