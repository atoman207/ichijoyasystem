import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { addAudit, mutate, syncDb } from "@/lib/db/store";
import { policyReader } from "@/lib/access-policy";

import { toCsv } from "@/lib/csv";
import { kpiSettings } from "@/lib/kpi-settings";
import { resolvePeriod } from "@/lib/kpi-period";
import { toDateKey } from "@/lib/format";
import { tallyCsvRows } from "@/lib/survey-tally";
import { surveyTallyView, surveyView } from "@/lib/survey-tally-view";

export const maxDuration = 60;

/**
 * KPI → アンケートの集計表 ①〜⑦ の CSV (画面 /kpi/surveys と同じ絞り込み・同じ集計。src/lib/survey-tally-view.ts)
 * /api/kpi/survey-tally?p=fy:2026 (または from=…&to=…) &store=koshi &link=linked|unlinked &q=… &tcol=store (列 = 店舗。省くと月)
 * はがきの閲覧の範囲は画面と同じ (顧客情報の閲覧の範囲 canReadStoreRecords)
 */
export async function GET(req: Request) {
  if (req.headers.get("next-router-prefetch") || req.headers.get("rsc")) return new NextResponse(null, { status: 204 });
  const sessionUser = await getSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const db = await syncDb();
  const reader = policyReader(db, sessionUser);
  const sp = Object.fromEntries(new URL(req.url).searchParams.entries());
  const rp = resolvePeriod(sp, kpiSettings(db).fiscalStartMonth, toDateKey(new Date()));
  const view = surveyView(db, reader, rp.period, { store: sp.store, link: sp.link, q: sp.q });
  const axis = sp.tcol === "store" ? "store" : "month";
  const tv = surveyTallyView(db, reader, view, rp.period, axis);
  if (!tv) return NextResponse.json({ error: "月の列の集計表は期間が 24 か月までです。店舗の列 (tcol=store) にしてください。" }, { status: 400 });
  const scope = view.store ? (db.stores.find((s) => s.id === view.store)?.name ?? view.store) : "全店舗";
  const label = `アンケート集計表 (${axis === "store" ? "店舗別" : "月別"} · ${rp.label} · ${scope})`;
  await mutate((d) => {
    addAudit(d, { userId: sessionUser.id, action: "export", entity: "data", entityId: `survey_tally_${axis}`, entityLabel: label, summary: `データを書き出し: ${label}`, storeId: view.store ? (view.store as never) : undefined });
  });
  const period = rp.period ?? { from: "all", to: toDateKey(new Date()) };
  const name = `survey_tally_${axis}_${period.from}_${period.to}${view.store ? `_${view.store}` : ""}.csv`;
  return new NextResponse(toCsv(tallyCsvRows(tv.tally, tv.extraRows)), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}` },
  });
}
