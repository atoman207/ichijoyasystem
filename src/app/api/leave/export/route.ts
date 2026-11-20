import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { addAudit, mutate, syncDb } from "@/lib/db/store";
import { canViewLeaveOf, canViewLeaveReport } from "@/lib/auth/permissions";
import { toCsv } from "@/lib/csv";
import { toDateKey } from "@/lib/format";
import { LEAVE_SLOT, LEAVE_TYPE, closingRange, compBalance, dayList, fiscalLabel, fiscalRange, hrSettings, leaveEmployees, paidRemainingOn, periodRows } from "@/lib/hr/leave";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 有給・休日出勤の取得状況の CSV (勤怠システム・給与の締めへの受け渡し用。BOM 付き UTF-8)
 * /api/leave/export?fy=2026&format=summary|detail   年度 (7 月〜翌 6 月)
 * /api/leave/export?month=2026-11&format=summary|detail   勤怠の締め (20 日締め: 10/21〜11/20)
 * 店長は自店舗の社員、本部スタッフ・管理者は全員。書き出しは変更履歴に残す
 */
export async function GET(req: Request) {
  if (req.headers.get("next-router-prefetch") || req.headers.get("rsc")) return new NextResponse(null, { status: 204 });
  const user = await getSessionUser();
  if (!user || !canViewLeaveReport(user)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const p = new URL(req.url).searchParams;
  const db = await syncDb();
  const settings = hrSettings(db);
  const fy = p.get("fy");
  const month = p.get("month");
  let range: { from: string; to: string };
  let label: string;
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    range = closingRange(month, settings.closingDay);
    label = `${month} 締め`;
  } else if (fy && /^\d{4}$/.test(fy)) {
    range = fiscalRange(Number(fy), settings.fiscalStartMonth);
    label = fiscalLabel(Number(fy));
  } else return NextResponse.json({ error: "fy (YYYY) or month (YYYY-MM) is required" }, { status: 400 });
  const format = p.get("format") === "detail" ? "detail" : "summary";
  const today = toDateKey(new Date());
  const asOf = range.to < today ? range.to : today;
  const users = leaveEmployees(db).filter((u) => canViewLeaveOf(user, u));
  const rows = periodRows(db, users, range.from, range.to);
  const storeName = (id: string) => db.stores.find((s) => s.id === id)?.name ?? id;
  const userName = (id?: string) => db.users.find((u) => u.id === id)?.name ?? "";
  const period = `${range.from}〜${range.to}`;

  let csv: string;
  if (format === "summary") {
    const out: (string | number)[][] = [["社員ID", "氏名", "所属店舗", "期間", "有給の取得日数", "振休の取得日数", "特別休暇の日数", "休日出勤の日数", `有給の残日数 (${asOf})`, "振休の残り (今日)", "有給の取得日", "振休の取得日", "特別休暇の日", "休日出勤の日"]];
    for (const r of rows) {
      out.push([r.user.id, r.user.name, storeName(r.storeId), period, r.paid, r.comp, r.special, r.worked, paidRemainingOn(db, r.user.id, asOf), compBalance(db, r.user.id).remaining, dayList(r.days, "paid"), dayList(r.days, "comp"), dayList(r.days, "special"), dayList(r.days, "work")]);
    }
    csv = toCsv(out);
  } else {
    const out: (string | number)[][] = [["社員ID", "氏名", "所属店舗", "日付", "種類", "区分", "日数", "申請番号", "承認者", "承認日時", "理由・メモ"]];
    for (const r of rows) {
      for (const d of r.days) {
        out.push([r.user.id, r.user.name, storeName(r.storeId), d.date, d.kind === "work" ? "休日出勤" : LEAVE_TYPE[d.kind].label, LEAVE_SLOT[d.slot], d.days, d.number ?? "", userName(d.decidedBy), d.decidedAt ? new Date(d.decidedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }) : "", d.note ?? ""]);
      }
    }
    csv = toCsv(out);
  }

  await mutate((d) => {
    addAudit(d, { userId: user.id, action: "export", entity: "leave", entityId: `${format}:${range.from}`, entityLabel: `有給・休日出勤 ${label} (${format === "summary" ? "社員ごとの集計" : "日ごとの明細"})`, summary: `有給・休日出勤の取得状況を書き出し: ${label} ${period} (${users.length} 人)` });
  });
  const name = `有給・休日出勤_${format === "summary" ? "集計" : "明細"}_${range.from.replace(/-/g, "")}-${range.to.replace(/-/g, "")}.csv`;
  return new NextResponse(csv, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`, "Cache-Control": "no-store" },
  });
}
