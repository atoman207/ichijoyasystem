import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { addAudit, mutate, syncDb } from "@/lib/db/store";
import { canSeeAllStores, canViewAttendance } from "@/lib/auth/permissions";
import { attendanceCsv, attendanceLineStoreId } from "@/lib/hr/attendance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 勤怠月次の CSV (労務士へ送る一覧。BOM 付き UTF-8)
 * /api/attendance/export?id=<monthId>
 * 店長は自店舗の行だけ、本部・管理者は全員。書き出しは変更履歴に残す
 */
export async function GET(req: Request) {
  if (req.headers.get("next-router-prefetch") || req.headers.get("rsc")) return new NextResponse(null, { status: 204 });
  const user = await getSessionUser();
  if (!user || !canViewAttendance(user)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  const db = await syncDb();
  const month = (db.attendanceMonths ?? []).find((m) => m.id === id);
  if (!month) return NextResponse.json({ error: "not found" }, { status: 404 });

  let csv = attendanceCsv(db, month);
  if (!canSeeAllStores(user)) {
    // 店長: 自店舗の行だけに絞った CSV (労務士向けの全行は本部が書き出す)
    const lines = (db.attendanceLines ?? []).filter((l) => l.monthId === month.id && attendanceLineStoreId(db, l) === user.storeId);
    csv = attendanceCsv({ ...db, attendanceLines: lines }, month);
  }

  await mutate((d) => {
    addAudit(d, {
      userId: user.id,
      action: "export",
      entity: "attendance_month",
      entityId: month.id,
      entityLabel: month.yearMonth,
      summary: `勤怠月次 ${month.yearMonth} を CSV 書き出し`,
    });
  });
  const name = `勤怠月次_${month.yearMonth}.csv`;
  const body = "\uFEFF" + csv;
  return new NextResponse(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "Cache-Control": "no-store",
    },
  });
}
