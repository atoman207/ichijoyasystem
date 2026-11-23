import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { addAudit, mutate, syncDb } from "@/lib/db/store";
import { canReviewCarryover } from "@/lib/auth/permissions";
import { carryoverView, isTestWeekDb } from "@/lib/carryover-server";
import { carryoverCsv } from "@/lib/carryover";
import { TABLES } from "@/lib/db/schema";

export const maxDuration = 60;

/** 本番への引き継ぎ (/data/carryover) の一覧の CSV (管理者・本部スタッフ。試験期間のテスト用のサーバーだけ)。UTF-8 (BOM 付き) */
export async function GET(req: Request) {
  if (req.headers.get("next-router-prefetch") || req.headers.get("rsc")) return new NextResponse(null, { status: 204 });
  const user = await getSessionUser();
  if (!user || !canReviewCarryover(user)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const db = await syncDb();
  if (!isTestWeekDb(db)) return NextResponse.json({ error: "not in the test week" }, { status: 404 });
  const v = await carryoverView(db);
  if ("error" in v) return NextResponse.json({ error: v.error }, { status: 500 });
  await mutate((d) => {
    addAudit(d, { userId: user.id, action: "export", entity: "data", entityId: "carryover_list", entityLabel: "本番への引き継ぎの一覧", summary: "データを書き出し: 本番への引き継ぎの一覧" });
  });
  const name = `carryover-list_${new Date().toISOString().slice(0, 10)}.csv`;
  return new NextResponse("﻿" + carryoverCsv(TABLES, v.plan), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}` },
  });
}
