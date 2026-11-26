"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, mutate, newId, nowIso } from "@/lib/db/store";
import type { AttendanceLine, AttendanceLineKind } from "@/lib/db/types";
import { canManageAttendance } from "@/lib/auth/permissions";
import { applyAttendanceSheet, draftLinesFromUsers, parseAttendanceWorkbook } from "@/lib/hr/attendance";
import { attendanceTablesMissing } from "@/lib/hr/tables";
import { fail, requireActionUser, safeReturn, str, withMsg } from "./guards";

/**
 * 勤怠月次の操作 (画面 /attendance)
 * ------------------------------------------------------------
 * 打刻・給与計算は対象外。労務士へ送る月次表の取込・手入力・確定・CSV
 */

const BACK = "/attendance";

async function ready(back: string) {
  const missing = await attendanceTablesMissing();
  if (missing) fail(back, missing);
}

function revalidate() {
  revalidatePath("/attendance");
  revalidatePath("/", "layout");
}

function num(v: string): number | undefined {
  if (!v.trim()) return undefined;
  const n = Number(v.replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

/** 令和○年度.xlsx の一括取込 */
export async function importAttendanceWorkbook(fd: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(fd, "back"), BACK);
  if (!canManageAttendance(user)) fail(back, "勤怠の月次表の取込は本部スタッフ・管理者が行います。");
  await ready(back);
  const file = fd.get("file");
  if (!(file instanceof File) || !file.size) fail(back, "勤怠の月次表 (.xlsx) を選んでください。");
  if (!/\.xlsx$/i.test(file.name)) fail(back, ".xlsx のファイルを選んでください。");
  let sheets;
  try {
    sheets = parseAttendanceWorkbook(Buffer.from(await file.arrayBuffer()));
  } catch (e) {
    fail(back, (e as Error).message || "ファイルを読めませんでした。");
  }
  if (!sheets.length) fail(back, "勤怠の月次シートが見つかりません (シート名「8.11」や「令和○年○月分」を確かめてください)。");
  const force = str(fd, "force") === "1";
  const results: string[] = [];
  await mutate((db) => {
    for (const sheet of sheets) {
      try {
        const r = applyAttendanceSheet(db, sheet, { userId: user.id, now: nowIso(), makeId: newId, sourceLabel: file.name.slice(0, 120), force });
        results.push(`${r.yearMonth} (${r.lines} 行)`);
      } catch (e) {
        fail(back, (e as Error).message);
      }
    }
    addAudit(db, { userId: user.id, action: "import", entity: "attendance_month", entityId: "workbook", entityLabel: file.name.slice(0, 80), summary: `勤怠月次を取込: ${results.join("・")}` });
  });
  revalidate();
  redirect(withMsg(back, `取り込みました: ${results.join("、")}`));
}

/** 空の月を作る (社員マスタ + 有給・休日出勤の候補) */
export async function createAttendanceMonth(fd: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(fd, "back"), BACK);
  if (!canManageAttendance(user)) fail(back, "勤怠の月次表の登録は本部スタッフ・管理者が行います。");
  await ready(back);
  const yearMonth = str(fd, "yearMonth");
  if (!/^\d{4}-\d{2}$/.test(yearMonth)) fail(back, "対象月を選んでください。");
  let id = "";
  await mutate((db) => {
    if (db.attendanceMonths.some((m) => m.yearMonth === yearMonth)) fail(back, `${yearMonth} の勤怠はもうあります。`);
    const now = nowIso();
    id = newId("attm");
    db.attendanceMonths.push({ id, yearMonth, status: "draft", payLabel: str(fd, "payLabel") || undefined, createdBy: user.id, createdAt: now, updatedBy: user.id, updatedAt: now });
    const drafts = draftLinesFromUsers(db, yearMonth);
    for (const row of drafts) {
      db.attendanceLines.push({ id: newId("attl"), monthId: id, ...row, createdAt: now, updatedAt: now });
    }
    addAudit(db, { userId: user.id, action: "create", entity: "attendance_month", entityId: id, entityLabel: yearMonth, summary: `勤怠月次 ${yearMonth} を作成 (${drafts.length} 行)` });
  });
  revalidate();
  redirect(withMsg(`/attendance?month=${yearMonth}`, `${yearMonth} の勤怠を作りました。出勤日数などを入れてください。`));
}

/** 行の保存 (下書きのみ) */
export async function saveAttendanceLines(fd: FormData) {
  const user = await requireActionUser();
  const monthId = str(fd, "monthId");
  const back = safeReturn(str(fd, "back"), `${BACK}?tab=monthly&id=${monthId}`);
  if (!canManageAttendance(user)) fail(back, "勤怠の月次表の変更は本部スタッフ・管理者が行います。");
  await ready(back);
  const ids = fd.getAll("lineId").map(String);
  await mutate((db) => {
    const month = db.attendanceMonths.find((m) => m.id === monthId);
    if (!month) fail(back, "勤怠の月が見つかりません。");
    if (month.status === "final") fail(back, "確定済みの月は変えられません。先に確定を取り消してください。");
    const now = nowIso();
    let n = 0;
    for (const id of ids) {
      const line = db.attendanceLines.find((l) => l.id === id && l.monthId === monthId);
      if (!line) continue;
      const kind = str(fd, `kind_${id}`) as AttendanceLineKind;
      if (kind === "staff" || kind === "part") line.kind = kind;
      line.employeeNo = str(fd, `no_${id}`) || undefined;
      line.name = str(fd, `name_${id}`) || line.name;
      line.workDays = num(str(fd, `work_${id}`));
      line.absenceDays = num(str(fd, `abs_${id}`));
      line.lateEarly = str(fd, `late_${id}`) || undefined;
      line.overtime = str(fd, `ot_${id}`) || undefined;
      line.workHours = str(fd, `hours_${id}`) || undefined;
      line.hourlyRate = num(str(fd, `rate_${id}`));
      line.paidLeaveDays = num(str(fd, `paid_${id}`));
      line.note = str(fd, `note_${id}`) || undefined;
      line.updatedAt = now;
      n++;
    }
    month.payLabel = str(fd, "payLabel") || undefined;
    month.note = str(fd, "monthNote") || undefined;
    month.updatedBy = user.id;
    month.updatedAt = now;
    addAudit(db, { userId: user.id, action: "update", entity: "attendance_month", entityId: month.id, entityLabel: month.yearMonth, summary: `勤怠月次 ${month.yearMonth} の行を保存 (${n} 行)` });
  });
  revalidate();
  redirect(withMsg(back, "保存しました。"));
}

/** 行を追加 */
export async function addAttendanceLine(fd: FormData) {
  const user = await requireActionUser();
  const monthId = str(fd, "monthId");
  const back = safeReturn(str(fd, "back"), `${BACK}?tab=monthly&id=${monthId}`);
  if (!canManageAttendance(user)) fail(back, "勤怠の月次表の変更は本部スタッフ・管理者が行います。");
  await ready(back);
  const kind = (str(fd, "kind") === "part" ? "part" : "staff") as AttendanceLineKind;
  const name = str(fd, "name");
  if (!name) fail(back, "氏名を入力してください。");
  await mutate((db) => {
    const month = db.attendanceMonths.find((m) => m.id === monthId);
    if (!month) fail(back, "勤怠の月が見つかりません。");
    if (month.status === "final") fail(back, "確定済みの月には行を足せません。");
    const now = nowIso();
    const sort = db.attendanceLines.filter((l) => l.monthId === monthId).reduce((a, l) => Math.max(a, l.sort), -1) + 1;
    const line: AttendanceLine = { id: newId("attl"), monthId, kind, sort, name, source: "manual", createdAt: now, updatedAt: now };
    db.attendanceLines.push(line);
    month.updatedBy = user.id;
    month.updatedAt = now;
    addAudit(db, { userId: user.id, action: "create", entity: "attendance_line", entityId: line.id, entityLabel: name, summary: `勤怠月次 ${month.yearMonth} に ${name} を追加` });
  });
  revalidate();
  redirect(withMsg(back, "行を追加しました。"));
}

/** 行を削除 */
export async function deleteAttendanceLine(fd: FormData) {
  const user = await requireActionUser();
  const monthId = str(fd, "monthId");
  const lineId = str(fd, "lineId");
  const back = safeReturn(str(fd, "back"), `${BACK}?tab=monthly&id=${monthId}`);
  if (!canManageAttendance(user)) fail(back, "勤怠の月次表の変更は本部スタッフ・管理者が行います。");
  await ready(back);
  await mutate((db) => {
    const month = db.attendanceMonths.find((m) => m.id === monthId);
    if (!month) fail(back, "勤怠の月が見つかりません。");
    if (month.status === "final") fail(back, "確定済みの月の行は消せません。");
    const line = db.attendanceLines.find((l) => l.id === lineId && l.monthId === monthId);
    if (!line) fail(back, "行が見つかりません。");
    db.attendanceLines = db.attendanceLines.filter((l) => l.id !== lineId);
    month.updatedBy = user.id;
    month.updatedAt = nowIso();
    addAudit(db, { userId: user.id, action: "delete", entity: "attendance_line", entityId: lineId, entityLabel: line.name, summary: `勤怠月次 ${month.yearMonth} から ${line.name} を削除` });
  });
  revalidate();
  redirect(withMsg(back, "行を削除しました。"));
}

/** 確定 / 確定取消 */
export async function setAttendanceFinal(fd: FormData) {
  const user = await requireActionUser();
  const monthId = str(fd, "monthId");
  const back = safeReturn(str(fd, "back"), `${BACK}?tab=monthly&id=${monthId}`);
  if (!canManageAttendance(user)) fail(back, "勤怠の確定は本部スタッフ・管理者が行います。");
  await ready(back);
  const final = str(fd, "final") === "1";
  await mutate((db) => {
    const month = db.attendanceMonths.find((m) => m.id === monthId);
    if (!month) fail(back, "勤怠の月が見つかりません。");
    const now = nowIso();
    if (final) {
      if (!db.attendanceLines.some((l) => l.monthId === monthId)) fail(back, "行がありません。");
      month.status = "final";
      month.finalizedBy = user.id;
      month.finalizedAt = now;
    } else {
      month.status = "draft";
      month.finalizedBy = undefined;
      month.finalizedAt = undefined;
    }
    month.updatedBy = user.id;
    month.updatedAt = now;
    addAudit(db, { userId: user.id, action: "update", entity: "attendance_month", entityId: month.id, entityLabel: month.yearMonth, summary: `勤怠月次 ${month.yearMonth} を${final ? "確定" : "下書きに戻し"}` });
  });
  revalidate();
  redirect(withMsg(back, final ? "確定しました。CSV を労務士へ送れます。" : "下書きに戻しました。"));
}

