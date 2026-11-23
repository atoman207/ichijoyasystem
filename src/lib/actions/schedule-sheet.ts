"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getDb, mutate } from "@/lib/db/store";
import { canImportScheduleSheet } from "@/lib/auth/permissions";
import { isDateKey } from "@/lib/calendar";
import { toDateKey } from "@/lib/format";
import { BATCH_RE, readBatchMonths, removeBatch, removeMonthFromBatch } from "@/lib/schedule-sheet/batch";
import { applySheetImport, planSheetImport, sheetSettings, writeSheetSettings } from "@/lib/schedule-sheet/plan";
import { fail, requireActionUser, str, withMsg } from "./guards";

/**
 * 予定表 →「スプレッドシートの取込」(予定表のスプレッドシートの明日以降の予定を新システムへ移行。src/lib/schedule-sheet/)
 * 読み込み (/api/schedule/sheet-import) → 画面で照合を確かめる →「この内容で取り込む」。本部スタッフ・管理者
 */

const BACK = "/schedule/import";

async function start() {
  const user = await requireActionUser();
  if (!canImportScheduleSheet(user)) fail("/schedule", "予定表の取込は本部スタッフ・管理者が行えます。");
  return user;
}

const backOf = (batch: string, from?: string) => `${BACK}?batch=${batch}${from ? `&from=${from}` : ""}`;

export async function applyScheduleSheet(fd: FormData) {
  const user = await start();
  const batch = str(fd, "batch");
  if (!BATCH_RE.test(batch)) fail(BACK, "読み込んだファイルが見つかりません。もう一度ファイルを選んでください。");
  const today = toDateKey(new Date());
  const from = str(fd, "from");
  const back = backOf(batch, from);
  if (!isDateKey(from)) fail(back, "取り込む最初の日を入れてください。");
  if (from < today) fail(back, "過ぎた日の予定は取り込みません。取り込む最初の日は今日以降にしてください。");
  if (str(fd, "confirm") !== "1") fail(back, "「内容を確かめました」にチェックしてから取り込んでください。");
  const loaded = await readBatchMonths(batch);
  if (!loaded?.months.length) fail(BACK, "読み込んだファイルが見つかりません。もう一度ファイルを選んでください。");
  const picks: Record<string, string> = {};
  for (const [k, v] of fd.entries()) if (k.startsWith("pick:") && typeof v === "string" && v) picks[k.slice(5)] = v;
  const label = loaded.months.map((m) => m.label).join("・");
  let summary = "";
  await mutate((db) => {
    const plan = planSheetImport(db, loaded.months, { from, picks });
    summary = applySheetImport(db, plan, user, label).summary;
  });
  await removeBatch(batch);
  for (const p of ["/schedule", "/schedule/production", "/customers", "/inquiries", BACK]) revalidatePath(p);
  redirect(withMsg(`${BACK}?done=1`, `取り込みました: ${summary}`));
}

/** 担当者の名前の対応 (シートの名前 → 社員 / 担当にしない)。右上の予定の「光子」などもここで決める */
export async function saveScheduleSheetAliases(fd: FormData) {
  const user = await start();
  const batch = str(fd, "batch");
  const from = str(fd, "from");
  const back = BATCH_RE.test(batch) ? backOf(batch, isDateKey(from) ? from : undefined) : BACK;
  const ids = new Set(getDb().users.map((u) => u.id));
  const updates: Record<string, string> = {};
  for (const [k, v] of fd.entries()) {
    if (!k.startsWith("alias:") || typeof v !== "string") continue;
    const name = k.slice(6).trim().slice(0, 30);
    if (!name) continue;
    if (v === "" || v === "-" || ids.has(v)) updates[name] = v;
  }
  await mutate((db) => {
    const s = sheetSettings(db);
    for (const [name, v] of Object.entries(updates)) {
      if (v) s.aliases[name] = v;
      else delete s.aliases[name];
    }
    writeSheetSettings(db, s, user.id);
  });
  redirect(withMsg(back, "担当者の名前の対応を保存しました。照合を作り直しました。"));
}

export async function removeScheduleSheetMonth(fd: FormData) {
  await start();
  const batch = str(fd, "batch");
  if (!BATCH_RE.test(batch)) fail(BACK, "読み込んだファイルが見つかりません。");
  await removeMonthFromBatch(batch, str(fd, "month"));
  redirect(withMsg(backOf(batch), "その月のファイルを外しました。"));
}

export async function discardScheduleSheet(fd: FormData) {
  await start();
  const batch = str(fd, "batch");
  if (BATCH_RE.test(batch)) await removeBatch(batch);
  redirect(withMsg(BACK, "読み込んだ内容を破棄しました (何も取り込んでいません)。"));
}
