import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { addAudit, mutate, syncDb } from "@/lib/db/store";
import { canImportData } from "@/lib/auth/permissions";
import { toCsv } from "@/lib/csv";
import { computeIncentives } from "@/lib/incentive";
import { formatAssign, readIncentiveYear } from "@/lib/incentive-year";
import { monthlyAllowances } from "@/lib/kpi-monthly";
import { fiscalRange, fiscalYearOf, kpiSettings } from "@/lib/kpi-settings";
import { toDateKey } from "@/lib/format";

export const maxDuration = 60;

/**
 * KPI → インセンティブの「集計表」CSV (スプレッドシートの KPI のタブの右下の集計表と同じ列 + 店舗の評価値 + 月次の手当)。
 * /api/kpi/incentives?fy=2026。本部スタッフ・管理者 (社員ごとの支給額のため)
 */
export async function GET(req: Request) {
  if (req.headers.get("next-router-prefetch") || req.headers.get("rsc")) return new NextResponse(null, { status: 204 });
  const user = await getSessionUser();
  if (!user || !canImportData(user)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const db = await syncDb();
  const settings = kpiSettings(db);
  const today = toDateKey(new Date());
  const fyParam = Number(new URL(req.url).searchParams.get("fy"));
  const fy = Number.isInteger(fyParam) && fyParam >= 2000 && fyParam <= 2100 ? fyParam : fiscalYearOf(today, settings.fiscalStartMonth);
  const period = fiscalRange(fy, settings.fiscalStartMonth);
  const year = readIncentiveYear(db, fy);
  const r = computeIncentives(db, period, settings, year.adjust, undefined, year);
  const nameOf = (id: string, name?: string) => name ?? (id.startsWith("name:") ? id.slice(5) : (db.users.find((u) => u.id === id)?.name ?? id));
  const storeName = (id: string) => db.stores.find((s) => s.id === id)?.name ?? id;
  const rows: (string | number | null)[][] = [];
  rows.push([`${fy}年度 インセンティブ 集計表 (集計期間 ${period.from}〜${period.to}${today <= period.to ? ` · ${today} 時点の見込み` : ""})`]);
  rows.push([]);
  rows.push(["氏名", "所属 (月割り)", "返信率", "返信率MVP", "電話対応", "営業", "営業MVP", "職人", "職人MVP", "工事仕上り", "工事仕上りMVP", "クチコミMVP", "クレーム手直し率（加点）", "クレーム手直し率（減点）", "クレーム手直し件数（MVP）", "クレーム手直し率（MVP）", "調整", "調整の理由", "計", "合計 (マイナスは 0)"]);
  const people = [...r.people].sort((a, b) => (a.role === "clerk" ? 1 : 0) - (b.role === "clerk" ? 1 : 0) || a.storeId.localeCompare(b.storeId));
  for (const p of people) {
    const y = (k: string) => p.lines.find((l) => l.key === k)?.yen ?? null;
    const q = y("quality");
    rows.push([
      nameOf(p.userId, p.name),
      p.segments.length ? `${formatAssign(p.segments, db.stores)} か月` : "",
      y("reply"),
      y("replyMvp"),
      y("phone"),
      y("sales"),
      y("salesMvp"),
      y("craft"),
      y("craftMvp"),
      y("finish"),
      y("finishMvp"),
      y("reviewMvp"),
      q !== null && q >= 0 ? q : null,
      q !== null && q < 0 ? q : null,
      y("fewestMvp"),
      y("rateMvp"),
      p.adjust || null,
      p.adjustNote ?? "",
      p.subtotal + p.adjust,
      p.total,
    ]);
  }
  rows.push(["合計", "", ...Array(16).fill(""), "", r.total]);
  rows.push([]);
  rows.push(["店舗・事務の評価値"]);
  rows.push(["単位", "返信率 (%)", "はがき (枚)", "個人件数", "④ 工事仕上り", "全案件数", "クレーム・手直し (件)", "ポイント", "ポイント率 (%)"]);
  for (const u of r.units) rows.push([storeName(u.unit), u.replyRate === null ? "" : u.replyRate.toFixed(1), u.cards, u.individual, u.finishAvg === null ? "" : u.finishAvg.toFixed(2), u.orders, u.qualityCount, u.qualityPoints, u.qualityRate === null ? "" : u.qualityRate.toFixed(2)]);
  rows.push(["事務", "", "", "", r.companyPhoneAvg === null ? "" : `① ${r.companyPhoneAvg.toFixed(2)}`, r.office.orders, r.office.qualityCount, r.office.qualityPoints, r.office.qualityRate === null ? "" : r.office.qualityRate.toFixed(2)]);
  const monthly = monthlyAllowances(db, fy, settings, { today, officePeople: r.people.filter((p) => p.role === "clerk").length });
  if (monthly.length) {
    rows.push([]);
    rows.push(["月次の手当 (月間人日・伝票件数)"]);
    rows.push(["月", "単位", "目安", "実績", "基準", "クリア", "人数", "総残業代", "1 人あたり"]);
    for (const m of monthly) rows.push([m.month, m.unit === "office" ? "事務 (伝票件数)" : `${storeName(m.unit)} (人日)`, m.auto ?? "", m.value ?? "", m.threshold, m.cleared ? 1 : 0, m.people, m.overtime, m.cleared ? m.perPerson : 0]);
  }
  const label = `${fy}年度 インセンティブ 集計表`;
  await mutate((d) => {
    addAudit(d, { userId: user.id, action: "export", entity: "data", entityId: `incentives_${fy}`, entityLabel: label, summary: `データを書き出し: ${label}` });
  });
  const name = `incentives_${fy}.csv`;
  return new NextResponse(toCsv(rows), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}` } });
}
