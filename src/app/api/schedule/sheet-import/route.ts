import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { syncDb } from "@/lib/db/store";
import { canImportScheduleSheet } from "@/lib/auth/permissions";
import { MAX_SHEET_FILE_BYTES, readScheduleWorkbook } from "@/lib/schedule-sheet/read";
import { BATCH_RE, addMonthToBatch, newBatchId } from "@/lib/schedule-sheet/batch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 予定表の月のファイル (.xlsx) を 1 つ読み込んで、取込 (batch) に足す (画面 予定表 →「スプレッドシートの取込」)。
 * POST (multipart) file=<.xlsx> batch=<取込の番号 (2 つ目から)>。応答: { batch, month, days, events, problems }
 * 1 回に 1 ファイル (サーバーの受け取りの上限 10 MB のため)。書き込みはしない (取り込むのは画面の「この内容で取り込む」)
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "ログインが必要です。" }, { status: 401 });
  if (!canImportScheduleSheet(user)) return NextResponse.json({ error: "予定表の取込は本部スタッフ・管理者が行えます。" }, { status: 403 });
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File) || file.size === 0) return NextResponse.json({ error: "予定表のファイル (.xlsx) を選んでください。" }, { status: 400 });
  if (file.size > MAX_SHEET_FILE_BYTES) return NextResponse.json({ error: `「${file.name}」が大きすぎます (${(file.size / 1048576).toFixed(1)} MB。9.5 MB まで)。` }, { status: 413 });
  const given = String(form?.get("batch") ?? "");
  const batch = BATCH_RE.test(given) ? given : newBatchId();
  const db = await syncDb();
  const stores = db.stores.map((s) => ({ id: s.id, name: s.name, shortName: s.shortName }));
  try {
    const month = readScheduleWorkbook(file.name, new Uint8Array(await file.arrayBuffer()), stores);
    if (!month.days.length) return NextResponse.json({ error: `「${file.name}」に日別のシート (「1」〜「31」) がありません。予定表の月のファイルを選んでください。` }, { status: 422 });
    await addMonthToBatch(batch, user.id, file.name, month);
    return NextResponse.json({ batch, month: `${month.year}-${String(month.month).padStart(2, "0")}`, label: month.label, days: month.days.length, events: month.events.length, problems: month.problems });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message || "ファイルを読み取れませんでした。" }, { status: 422 });
  }
}
