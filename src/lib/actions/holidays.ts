"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, mutate, nowIso } from "@/lib/db/store";
import type { Database, User } from "@/lib/db/types";
import { canManageHolidays } from "@/lib/auth/permissions";
import { holidayName, isDateKey, lawHolidayName, shortDate } from "@/lib/calendar";
import {
  HOLIDAY_SETTINGS_ID,
  LABEL_MAX,
  applyClosedDayPlan,
  cleanLabel,
  describeRule,
  planClosedDays,
  readClosedDayRule,
  readHolidayOverrides,
  setClosedDay,
} from "@/lib/holiday-calendar";
import { fail, requireActionUser, safeReturn, str, withMsg } from "./guards";

/**
 * 休日カレンダーの変更 (管理者): 1 日の休業日・祝日の変更と、条件での休業日のまとめて登録・解除。
 * 計算は src/lib/holiday-calendar.ts。休業日は db.holidays を作り直す (isClosedDay のキャッシュは配列ごと)
 */

const BASE = "/schedule/holidays";

function back(fd: FormData, date?: string): string {
  const fallback = date ? `${BASE}?year=${date.slice(0, 4)}&date=${date}` : BASE;
  return safeReturn(str(fd, "back"), fallback);
}

function done(to: string, msg: string): never {
  revalidatePath("/schedule", "layout");
  redirect(withMsg(to, msg));
}

async function requireManager(to: string): Promise<User> {
  const user = await requireActionUser();
  if (!canManageHolidays(user)) fail(to, "休日カレンダーを変更できるのは管理者だけです。");
  return user;
}

function validDate(v: string): boolean {
  return isDateKey(v) && v >= "2000-01-01" && v <= "2099-12-31";
}

/** 1 日の休業日: closed = 1 で休業日にする (名前の変更も)、0 で休業日から外す */
export async function saveClosedDay(fd: FormData) {
  const date = str(fd, "date");
  const to = back(fd, validDate(date) ? date : undefined);
  const user = await requireManager(to);
  if (!validDate(date)) fail(to, "日付が正しくありません。");
  const closed = str(fd, "closed") === "1";
  const label = cleanLabel(str(fd, "label"));
  let msg = "";
  await mutate((db) => {
    const r = setClosedDay(db, date, closed, label);
    const day = `${date.slice(0, 4)}/${shortDate(date)}`;
    if (r.action === "none") {
      msg = closed ? `${day} はすでに休業日です。` : `${day} は休業日ではありません。`;
      return;
    }
    const entityId = (r.after ?? r.before)!.id;
    if (r.action === "create") {
      msg = `${day} を休業日にしました (${label})。`;
      addAudit(db, { userId: user.id, action: "create", entity: "holiday", entityId, entityLabel: `${date} 休業日`, summary: msg });
    } else if (r.action === "delete") {
      msg = `${day} を休業日から外しました。`;
      addAudit(db, { userId: user.id, action: "delete", entity: "holiday", entityId, entityLabel: `${date} 休業日`, summary: msg, changes: [{ field: "closed", before: r.before?.label ?? "休業日", after: "(営業日)" }] });
    } else {
      msg = `${day} の休業日の名前を「${label}」にしました。`;
      addAudit(db, { userId: user.id, action: "update", entity: "holiday", entityId, entityLabel: `${date} 休業日`, summary: msg, changes: [{ field: "label", before: r.before?.label ?? "", after: label }] });
    }
  });
  done(to, msg);
}

/** 祝日の変更: op = set (祝日にする・名前を変える) / remove (祝日から外す) / reset (規則どおりに戻す) */
export async function saveNationalHoliday(fd: FormData) {
  const date = str(fd, "date");
  const to = back(fd, validDate(date) ? date : undefined);
  const user = await requireManager(to);
  if (!validDate(date)) fail(to, "日付が正しくありません。");
  const op = str(fd, "op");
  const name = str(fd, "name").normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, LABEL_MAX);
  if (op === "set" && !name) fail(to, "祝日の名前を入力してください。");
  if (!["set", "remove", "reset"].includes(op)) fail(to, "操作が正しくありません。");
  let msg = "";
  await mutate((db) => {
    const national = readHolidayOverrides(db);
    const beforeJson = JSON.stringify(national);
    const lawName = lawHolidayName(date);
    const before = holidayName(date, national);
    if (op === "reset") delete national[date];
    else {
      const next = op === "remove" ? null : name;
      // 規則と同じ内容は変更として持たない (規則どおり)
      if ((next === null && !lawName) || next === lawName) delete national[date];
      else national[date] = next;
    }
    const after = holidayName(date, national);
    const day = `${date.slice(0, 4)}/${shortDate(date)}`;
    if (JSON.stringify(national) === beforeJson) {
      msg = `${day} の祝日は変わりません。`;
      return;
    }
    saveOverrides(db, user, national);
    msg = after ? `${day} を祝日「${after}」にしました。` : `${day} を祝日から外しました。`;
    if (op === "reset") msg = `${day} の祝日を規則どおり${lawName ? `「${lawName}」` : " (祝日ではない)"}に戻しました。`;
    addAudit(db, {
      userId: user.id,
      action: "update",
      entity: "holiday",
      entityId: `national:${date}`,
      entityLabel: `${date} 祝日`,
      summary: msg,
      changes: [{ field: "holiday", before: before ?? "(祝日ではない)", after: after ?? "(祝日ではない)" }],
    });
  });
  done(to, msg);
}

function saveOverrides(db: Database, user: User, national: Record<string, string | null>) {
  const sorted = Object.fromEntries(Object.entries(national).sort(([a], [b]) => (a < b ? -1 : 1)));
  const value = { national: sorted };
  const row = db.settings.find((s) => s.id === HOLIDAY_SETTINGS_ID);
  const now = nowIso();
  if (row) Object.assign(row, { value, updatedBy: user.id, updatedAt: now });
  else db.settings.push({ id: HOLIDAY_SETTINGS_ID, value, updatedBy: user.id, updatedAt: now });
}

/** 条件で休業日をまとめて登録・解除 (確認の画面で見た日数と同じときだけ反映する) */
export async function applyClosedDays(fd: FormData) {
  const to = back(fd);
  const user = await requireManager(to);
  const rule = readClosedDayRule(
    (k) => (fd.get(k) === null ? null : String(fd.get(k))),
    (k) => fd.getAll(k).map(String),
  );
  if ("error" in rule) fail(to, rule.error);
  const expect = Number(str(fd, "expect"));
  let msg = "";
  await mutate((db) => {
    const plan = planClosedDays(db, rule);
    const count = rule.mode === "add" ? plan.add.length : plan.remove.length;
    if (!Number.isInteger(expect) || expect !== count) fail(to, "確認のあとに休日カレンダーが変わりました。もう一度「確認する」を押してください。");
    if (!count) {
      msg = rule.mode === "add" ? "休業日にする日はありませんでした (すでに休業日です)。" : "休業日から外す日はありませんでした。";
      return;
    }
    const n = applyClosedDayPlan(db, plan);
    const dates = rule.mode === "add" ? plan.add.map((a) => a.date) : plan.remove.map((h) => h.date);
    msg = rule.mode === "add" ? `${n} 日を休業日にしました (${describeRule(rule)})。` : `${n} 日を休業日から外しました (${describeRule(rule)})。`;
    addAudit(db, {
      userId: user.id,
      action: rule.mode === "add" ? "create" : "delete",
      entity: "holiday",
      entityId: `bulk:${rule.from}_${rule.to}`,
      entityLabel: `休業日のまとめて${rule.mode === "add" ? "登録" : "解除"} ${rule.from}〜${rule.to}`,
      summary: msg,
      changes: [{ field: "dates", before: rule.mode === "add" ? "" : dates.join(", "), after: rule.mode === "add" ? `${dates.join(", ")} (${rule.label})` : "" }],
    });
  });
  done(to, msg);
}
