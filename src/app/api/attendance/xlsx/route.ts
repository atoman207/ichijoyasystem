import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { addAudit, mutate, syncDb } from "@/lib/db/store";
import { canManageAttendance } from "@/lib/auth/permissions";
import { attendanceFileName, attendanceXlsx } from "@/lib/hr/attendance-xlsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 労務士へ送る勤務表の .xlsx (いまの「令和○年度.xlsx」と同じ並び。全員の行なので本部・管理者だけ)
 * /api/attendance/xlsx?id=<monthId>。書き出しは変更履歴に残す
 */
export async function GET(req: Request) {
  if (req.headers.get("next-router-prefetch") || req.headers.get("rsc")) return new NextResponse(null, { status: 204 });
  const user = await getSessionUser();
  if (!user || !canManageAttendance(user)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  const db = await syncDb();
  const month = (db.attendanceMonths ?? []).find((m) => m.id === id);
  if (!month) return NextResponse.json({ error: "not found" }, { status: 404 });
  const file = attendanceXlsx(db, month);
  await mutate((d) => {
    addAudit(d, { userId: user.id, action: "export", entity: "attendance_month", entityId: month.id, entityLabel: month.yearMonth, summary: `勤務表 ${month.yearMonth} を .xlsx で書き出し` });
  });
  const name = attendanceFileName(month);
  return new NextResponse(new Uint8Array(file), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "Cache-Control": "no-store",
    },
  });
}
