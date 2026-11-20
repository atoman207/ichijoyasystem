"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getDb, mutate } from "@/lib/db/store";
import type { LeaveRequest, LeaveSlot, LeaveType, User } from "@/lib/db/types";
import { canManageLeaveGrants, canManageLeaveSettings, canRegisterHolidayWork, canRequestLeaveFor } from "@/lib/auth/permissions";
import { toDateKey } from "@/lib/format";
import { LEAVE_SLOT, LEAVE_TYPE, fmtDays, parseOpeningImport } from "@/lib/hr/leave";
import { LeaveError, addGrant, addHolidayWork, applyOpeningImport, cancelLeave, createLeave, decideLeave, removeGrant, removeHolidayWork, saveProfile, saveRules, updateGrant, type LeaveResult } from "@/lib/hr/apply";
import { hrTablesMissing } from "@/lib/hr/tables";
import { leaveRequestNotices, leaveResultNotices } from "@/lib/notify/events";
import { sendAndRecord } from "@/lib/notify/send";
import { choice, fail, numField, requireActionUser, safeReturn, str, withMsg } from "./guards";

/**
 * 有給・休日出勤の操作 (画面 /leave)
 * ------------------------------------------------------------
 * 順番: requireActionUser → 権限 (permissions.ts。社員の店舗の範囲) → mutate (src/lib/hr/apply.ts) → 変更履歴 → revalidatePath → redirect(withMsg)
 * 本番のデータベースに表がない間 (デプロイ前) は書き込みを断る (src/lib/hr/tables.ts)
 */

const BACK = "/leave";

/** mutate の中の LeaveError を画面のメッセージにする (mutate はメモリの変更を元に戻す) */
function run<T>(back: string, f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof LeaveError) fail(back, e.message);
    throw e;
  }
}

async function ready(back: string) {
  const missing = await hrTablesMissing();
  if (missing) fail(back, missing);
}

function revalidate() {
  revalidatePath("/leave");
  revalidatePath("/schedule");
  revalidatePath("/", "layout");
}

/** 社員の店舗の範囲を先に確かめる (assertStore の代わり。社員ごとの権限) */
function assertTarget(user: User, userId: string, back: string, check: (u: User, t: User) => boolean, message: string): User {
  const target = getDb().users.find((u) => u.id === userId);
  if (!target) fail(back, "社員が見つかりません。");
  if (!check(user, target!)) fail(back, message);
  return target!;
}

function resultMessage(r: LeaveResult, name: string): string {
  const what = `${name} さんの${LEAVE_TYPE[r.request.leaveType].label} (${fmtDays(r.request.days)})`;
  if (!r.approved) return `${what}を申請しました。承認されると予定表に「休暇」として登録されます。`;
  const warn = r.conflicts.length ? ` ※この期間に ${name} さんの予定が ${r.conflicts.length} 件あります (${r.conflicts.slice(0, 3).join("・")}${r.conflicts.length > 3 ? " ほか" : ""})。予定表で担当を調整してください。` : "";
  return `${what}を承認し、予定表に登録しました。${warn}`;
}

const notice = (r: LeaveRequest) => ({ ...r });

/* ---------------- 休暇の申請・承認・取消し ---------------- */

export async function requestLeave(formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), BACK);
  const userId = str(formData, "userId") || user.id;
  const target = assertTarget(user, userId, back, canRequestLeaveFor, "この社員の休暇を申請する権限がありません。");
  await ready(back);
  const input = {
    userId,
    leaveType: choice<LeaveType>(formData, "leaveType", LEAVE_TYPE, "paid"),
    date: str(formData, "date"),
    endDate: str(formData, "endDate") || undefined,
    slot: choice<LeaveSlot>(formData, "slot", LEAVE_SLOT, "day"),
    reason: str(formData, "reason") || undefined,
    holidayWorkId: str(formData, "holidayWorkId") || undefined,
  };
  const result = await mutate((db) => run(back, () => createLeave(db, user, input)));
  const db = getDb();
  await sendAndRecord(result.approved ? leaveResultNotices(db, notice(result.request)) : leaveRequestNotices(db, notice(result.request)), user.id);
  revalidate();
  redirect(withMsg(back, resultMessage(result, target.name)));
}

export async function decideLeaveRequest(id: string, decision: "approved" | "rejected", formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), `${BACK}?tab=approve`);
  if (decision !== "approved" && decision !== "rejected") fail(back, "判断の種類が正しくありません。");
  await ready(back);
  const comment = str(formData, "comment");
  const result = await mutate((db) => run(back, () => decideLeave(db, user, id, decision, comment)));
  const db = getDb();
  await sendAndRecord(leaveResultNotices(db, notice(result.request)), user.id);
  revalidate();
  const name = db.users.find((u) => u.id === result.request.userId)?.name ?? "";
  redirect(withMsg(back, decision === "approved" ? resultMessage(result, name) : `${name} さんの休暇の申請を却下しました。`));
}

export async function cancelLeaveRequest(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), BACK);
  await ready(back);
  const today = toDateKey(new Date());
  const req = await mutate((db) => run(back, () => cancelLeave(db, user, id, str(formData, "reason"), today)));
  revalidate();
  redirect(withMsg(back, `${req.number} を取り消しました。${req.eventId ? "予定表の「休暇」も削除しました。" : ""}`));
}

/* ---------------- 休日出勤 ---------------- */

export async function registerHolidayWork(formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), `${BACK}?tab=comp`);
  const userId = str(formData, "userId");
  const target = assertTarget(user, userId, back, canRegisterHolidayWork, "この社員の休日出勤を登録する権限がありません (店長は自店舗の社員、本部・管理者は全員)。");
  await ready(back);
  const res = await mutate((db) => run(back, () => addHolidayWork(db, user, { userId, date: str(formData, "date"), slot: choice<LeaveSlot>(formData, "slot", LEAVE_SLOT, "day"), note: str(formData, "note") })));
  revalidate();
  redirect(withMsg(back, `${target.name} さんの休日出勤 (${res.work.date.replace(/-/g, "/")}) を登録しました。振休の未取得一覧に入りました。${res.warning ? ` ※${res.warning}` : ""}`));
}

export async function deleteHolidayWork(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), `${BACK}?tab=comp`);
  await ready(back);
  const w = await mutate((db) => run(back, () => removeHolidayWork(db, user, id)));
  revalidate();
  redirect(withMsg(back, `休日出勤 (${w.date.replace(/-/g, "/")}) を削除しました。`));
}

/* ---------------- 有給の付与・取込・設定 ---------------- */

export async function createLeaveGrant(formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), `${BACK}?tab=staff`);
  if (!canManageLeaveGrants(user)) fail(back, "有給の付与は本部スタッフ (事務)・管理者が登録します。");
  await ready(back);
  const g = await mutate((db) => run(back, () => addGrant(db, user, { userId: str(formData, "userId"), grantDate: str(formData, "grantDate"), days: numField(formData, "days"), expiresOn: str(formData, "expiresOn") || undefined, note: str(formData, "note") })));
  revalidate();
  redirect(withMsg(back, `有給を ${fmtDays(g.days)} 付与しました (有効期限 ${g.expiresOn.replace(/-/g, "/")})。`));
}

export async function updateLeaveGrant(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), `${BACK}?tab=staff`);
  if (!canManageLeaveGrants(user)) fail(back, "有給の付与は本部スタッフ (事務)・管理者が修正します。");
  await ready(back);
  const today = toDateKey(new Date());
  await mutate((db) => run(back, () => updateGrant(db, user, id, { days: numField(formData, "days"), expiresOn: str(formData, "expiresOn"), note: str(formData, "note") }, today)));
  revalidate();
  redirect(withMsg(back, "有給の付与を修正しました。"));
}

export async function deleteLeaveGrant(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), `${BACK}?tab=staff`);
  if (!canManageLeaveGrants(user)) fail(back, "有給の付与は本部スタッフ (事務)・管理者が削除します。");
  await ready(back);
  const today = toDateKey(new Date());
  await mutate((db) => run(back, () => removeGrant(db, user, id, today)));
  revalidate();
  redirect(withMsg(back, "有給の付与を削除しました。"));
}

/** 切り替え時点の残日数の取込 (貼り付け・CSV)。「確認だけ」は保存せずに結果を表示する */
export async function importLeaveBalances(formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), `${BACK}?tab=setup`);
  if (!canManageLeaveGrants(user)) fail(back, "切り替え時点の残日数の取込は本部スタッフ (事務)・管理者が行います。");
  let text = str(formData, "text");
  const file = formData.get("file");
  if (!text && file && typeof file === "object" && "arrayBuffer" in file && (file as File).size > 0) {
    if ((file as File).size > 1024 * 1024) fail(back, "ファイルは 1 MB までにしてください。");
    const { decodeCsv } = await import("@/lib/csv");
    text = decodeCsv(new Uint8Array(await (file as File).arrayBuffer())).text;
  }
  if (!text.trim()) fail(back, "取り込む内容を貼り付けるか、CSV ファイルを選んでください。");
  const today = toDateKey(new Date());
  const rows = parseOpeningImport(getDb(), text, today);
  if (str(formData, "dryRun") === "1") {
    const bad = rows.filter((r) => r.errors.length);
    const lines = rows.map((r) => `${r.line} 行目 ${r.user?.name ?? "?"}: ${r.errors.length ? `× ${r.errors.join("・")}` : `当年度 ${fmtDays(r.current)} + 繰越 ${fmtDays(r.carry)} (基準日 ${r.baseDate ?? "-"}・時点 ${r.asOf})${r.comp !== undefined ? `・振休 ${fmtDays(r.comp)}` : ""}${r.warnings.length ? ` ※${r.warnings.join("・")}` : ""}`}`);
    const head = bad.length ? `確認の結果: ${rows.length} 行のうち ${bad.length} 行は取り込めません。` : `確認の結果: ${rows.length} 行とも取り込めます (まだ保存していません)。`;
    redirect(withMsg(back, `${head} ${lines.slice(0, 12).join(" / ")}${lines.length > 12 ? ` ほか ${lines.length - 12} 行` : ""}`));
  }
  await ready(back);
  const res = await mutate((db) => run(back, () => applyOpeningImport(db, user, parseOpeningImport(db, text, today))));
  revalidate();
  redirect(withMsg(back, `切り替え時点の残日数を ${res.users} 人分取り込みました (${res.lines.slice(0, 8).join("・")}${res.lines.length > 8 ? " ほか" : ""})。社員ごとの一覧で、有給管理表の残日数と一致しているか確かめてください。`));
}

export async function saveLeaveProfile(formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), `${BACK}?tab=staff`);
  const userId = str(formData, "userId");
  assertTarget(user, userId, back, (u) => canManageLeaveGrants(u), "社員の基準日・雇い入れ日は本部スタッフ (事務)・管理者が設定します。");
  await ready(back);
  const weekly = numField(formData, "weeklyDays");
  await mutate((db) => run(back, () => saveProfile(db, user, userId, { hiredOn: str(formData, "hiredOn") || undefined, baseDate: str(formData, "baseDate") || undefined, weeklyDays: weekly || undefined })));
  revalidate();
  redirect(withMsg(back, "社員の有給の設定 (雇い入れ日・基準日・週の所定労働日数) を保存しました。"));
}

export async function saveLeaveRules(formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), `${BACK}?tab=setup`);
  if (!canManageLeaveSettings(user)) fail(back, "有給・振休のルールは管理者が変更します。");
  await ready(back);
  await mutate((db) =>
    run(back, () =>
      saveRules(db, user, {
        compLimit: numField(formData, "compLimit"),
        consumeOrder: str(formData, "consumeOrder") === "newest" ? "newest" : "oldest",
        fiscalStartMonth: numField(formData, "fiscalStartMonth"),
        closingDay: numField(formData, "closingDay"),
        amStart: str(formData, "amStart"),
        amEnd: str(formData, "amEnd"),
        pmStart: str(formData, "pmStart"),
        pmEnd: str(formData, "pmEnd"),
      }),
    ),
  );
  revalidate();
  redirect(withMsg(back, "有給・振休のルールを保存しました。"));
}
