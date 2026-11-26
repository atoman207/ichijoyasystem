"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, getDb, mutate, newId, nowIso } from "@/lib/db/store";
import type { AppSetting, Database, LeaveSlot, User } from "@/lib/db/types";
import { canApproveAttendance, canManageAttendance, canManageAttendanceRules, canStampAttendance } from "@/lib/auth/permissions";
import { toDateKey } from "@/lib/format";
import { LeaveError, decideLeave } from "@/lib/hr/apply";
import { LEAVE_SLOT } from "@/lib/hr/leave";
import { attendanceTablesMissing } from "@/lib/hr/tables";
import { ATTENDANCE_SETTINGS_ID, ATTENDANCE_DEFAULTS, HM_RE, STAFF_CATEGORY, attendanceSettings, shiftOf, toMin, type AttendanceSettings, type IncentivePay, type IncentivePeriod, type ShiftDef, type StaffCategory, type StaffProfile } from "@/lib/hr/timecard";
import { cancelAttendanceRequest, createAttendanceRequest, decideAttendanceRequest, requestSummary, stamp, type RequestResult } from "@/lib/hr/timecard-apply";
import { applyBuiltMonth, buildAttendanceMonth } from "@/lib/hr/attendance-build";
import { attendanceFileName, attendanceXlsx } from "@/lib/hr/attendance-xlsx";
import { incentiveAdjustId, readIncentiveAdjust, type IncentiveAdjust } from "@/lib/hr/incentive-month";
import { attendanceMonthLabel } from "@/lib/hr/attendance";
import { kpiSettings } from "@/lib/kpi-settings";
import { attendanceRequestNotices, attendanceResultNotices, leaveResultNotices } from "@/lib/notify/events";
import { sendAndRecord } from "@/lib/notify/send";
import { fail, requireActionUser, safeReturn, str, withMsg } from "./guards";

/**
 * 打刻・勤務表の操作 (画面 /attendance。キャスタイムの代わり)
 * ------------------------------------------------------------
 * 順番: requireActionUser → 権限 (permissions.ts) → mutate (src/lib/hr/timecard-apply.ts) → 変更履歴 → revalidatePath → redirect(withMsg)
 * 本番のデータベースに表がない間 (デプロイ前) は書き込みを断る (src/lib/hr/tables.ts)
 */

const BACK = "/attendance";

function run<T>(back: string, f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof LeaveError) fail(back, e.message);
    if (e instanceof Error && /確定済み/.test(e.message)) fail(back, e.message);
    throw e;
  }
}

async function ready(back: string) {
  const missing = await attendanceTablesMissing();
  if (missing) fail(back, missing);
}

function revalidate() {
  revalidatePath("/attendance");
  revalidatePath("/leave");
  revalidatePath("/schedule");
  revalidatePath("/", "layout");
}

/* ---------------- 打刻 ---------------- */

export async function stampAttendance(formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), BACK);
  if (!canStampAttendance(user)) fail(back, "打刻できないアカウントです。");
  await ready(back);
  const kind = str(formData, "kind") === "out" ? "out" : "in";
  const r = await mutate((db) => run(back, () => stamp(db, user, kind)));
  revalidate();
  redirect(withMsg(back, r.message));
}

/* ---------------- 申請 ---------------- */

function parseHm(raw: string, back: string, label: string): string | undefined {
  const v = raw.trim().replace(/：/g, ":");
  if (!v) return undefined;
  const m = /^(\d{1,2}):?(\d{2})$/.exec(v);
  if (!m) fail(back, `${label}は 8:00 の形で入力してください。`);
  const hm = `${m![1].padStart(2, "0")}:${m![2]}`;
  if (!HM_RE.test(hm)) fail(back, `${label}の時刻が正しくありません。`);
  return hm;
}

function resultText(db: Database, r: RequestResult): string {
  const name = db.users.find((u) => u.id === r.request.userId)?.name ?? "";
  const what = r.request.kind === "holiday_work" ? "休日出勤" : "打刻修正";
  if (!r.approved) return `${name} さんの${what}を申請しました (${r.request.number})。承認されると勤務表に反映されます。`;
  return `${name} さんの${what}を承認し、勤務表に反映しました${r.request.kind === "holiday_work" ? " (振休を付与し、予定表に「休日出勤」を登録)" : ""}。${r.warning ? ` ※${r.warning}` : ""}`;
}

export async function requestAttendance(formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), `${BACK}?tab=sheet`);
  await ready(back);
  const kind = str(formData, "kind") === "holiday_work" ? "holiday_work" : "correction";
  const date = str(formData, "date");
  const userId = str(formData, "userId") || user.id;
  const target = getDb().users.find((u) => u.id === userId);
  const shift = target ? shiftOf(attendanceSettings(getDb()), target, kpiSettings(getDb()).clerkUserIds) : undefined;
  const changeBreaks = formData.get("changeBreaks") === "1";
  const skipBreaks = changeBreaks && shift ? shift.breaks.map((_, i) => i).filter((i) => formData.get(`skip_${i}`) === "1") : undefined;
  const slotRaw = str(formData, "slot");
  const input = {
    userId,
    kind: kind as "correction" | "holiday_work",
    date,
    clockIn: parseHm(str(formData, "clockIn"), back, "出勤"),
    clockOut: parseHm(str(formData, "clockOut"), back, "退勤"),
    skipBreaks,
    slot: (slotRaw in LEAVE_SLOT ? slotRaw : "day") as LeaveSlot,
    reason: str(formData, "reason"),
  };
  const today = toDateKey(new Date());
  const r = await mutate((db) => run(back, () => createAttendanceRequest(db, user, input, today)));
  const db = getDb();
  const names = shift?.breaks.map((b) => `${b.start}〜${b.end}`);
  await sendAndRecord(r.approved ? attendanceResultNotices(db, r.request) : attendanceRequestNotices(db, r.request, requestSummary(r.request, names)), user.id);
  revalidate();
  redirect(withMsg(back, resultText(db, r)));
}

export async function decideAttendance(formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), `${BACK}?tab=requests`);
  await ready(back);
  const id = str(formData, "id");
  const decision = str(formData, "decision") === "rejected" ? "rejected" : "approved";
  const r = await mutate((db) => run(back, () => decideAttendanceRequest(db, user, id, decision, str(formData, "comment"))));
  const db = getDb();
  await sendAndRecord(attendanceResultNotices(db, r.request), user.id);
  revalidate();
  redirect(withMsg(back, decision === "approved" ? resultText(db, r) : `${r.request.number} を却下しました。`));
}

/** まとめて承認 (キャスタイムの「一括承認」。打刻修正・休日出勤 = at:<ID>、休暇 = lv:<ID>) */
export async function bulkApproveAttendance(formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), `${BACK}?tab=requests`);
  await ready(back);
  const ids = formData.getAll("pick").map(String).filter(Boolean).slice(0, 200);
  if (!ids.length) fail(back, "承認する申請を選んでください。");
  const out = await mutate((db) => {
    const done: { kind: "at" | "lv"; id: string }[] = [];
    const errors: string[] = [];
    for (const raw of ids) {
      const [kind, id] = raw.split(":");
      try {
        if (kind === "at") {
          const req = db.attendanceRequests.find((r) => r.id === id);
          if (!req || req.status !== "pending" || !canApproveAttendance(user, req)) continue;
          decideAttendanceRequest(db, user, id, "approved", "まとめて承認");
          done.push({ kind: "at", id });
        } else if (kind === "lv") {
          const req = db.leaveRequests.find((r) => r.id === id);
          if (!req || req.status !== "pending") continue;
          decideLeave(db, user, id, "approved", "まとめて承認");
          done.push({ kind: "lv", id });
        }
      } catch (e) {
        if (e instanceof LeaveError) errors.push(e.message);
        else throw e;
      }
    }
    return { done, errors };
  });
  const db = getDb();
  const notices = out.done.flatMap((d) => {
    if (d.kind === "at") {
      const r = db.attendanceRequests.find((x) => x.id === d.id);
      return r ? attendanceResultNotices(db, r) : [];
    }
    const r = db.leaveRequests.find((x) => x.id === d.id);
    return r ? leaveResultNotices(db, { ...r }) : [];
  });
  await sendAndRecord(notices, user.id);
  revalidate();
  redirect(withMsg(back, `${out.done.length} 件を承認しました。${out.errors.length ? ` 承認できなかった申請: ${out.errors.slice(0, 3).join(" / ")}` : ""}`));
}

export async function cancelAttendance(formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), `${BACK}?tab=requests`);
  await ready(back);
  const req = await mutate((db) => run(back, () => cancelAttendanceRequest(db, user, str(formData, "id"), str(formData, "reason"))));
  revalidate();
  redirect(withMsg(back, `${req.number} を取り消しました。`));
}

/* ---------------- 労務士へ送る勤務表 ---------------- */

export async function buildAttendanceMonthFromTimecards(formData: FormData) {
  const user = await requireActionUser();
  const yearMonth = str(formData, "yearMonth");
  const back = safeReturn(str(formData, "returnTo"), `${BACK}?tab=monthly&month=${yearMonth}`);
  if (!canManageAttendance(user)) fail(back, "勤務表の作成は本部スタッフ・管理者が行います。");
  if (!/^\d{4}-\d{2}$/.test(yearMonth)) fail(back, "対象月を選んでください。");
  await ready(back);
  const today = toDateKey(new Date());
  const r = await mutate((db) =>
    run(back, () => {
      const built = buildAttendanceMonth(db, yearMonth, today);
      const res = applyBuiltMonth(db, built, { userId: user.id, now: nowIso(), makeId: newId });
      addAudit(db, { userId: user.id, action: "update", entity: "attendance_month", entityId: res.month.id, entityLabel: yearMonth, summary: `勤務表 ${yearMonth} を打刻・休暇・インセンティブから作成 (${res.lines} 行)` });
      return { ...res, warnings: built.warnings.length };
    }),
  );
  revalidate();
  redirect(withMsg(`${BACK}?tab=monthly&month=${yearMonth}`, `${attendanceMonthLabel(yearMonth)} の勤務表を作りました (${r.lines} 人)。${r.warnings ? `確かめること ${r.warnings} 件を見てから確定してください。` : "内容を確かめて確定してください。"}`));
}

/** 勤務表を労務士へメールで送る (.xlsx を添付。確定した月だけ) */
export async function sendAttendanceMonth(formData: FormData) {
  const user = await requireActionUser();
  const monthId = str(formData, "monthId");
  const db0 = getDb();
  const month = db0.attendanceMonths.find((m) => m.id === monthId);
  const back = safeReturn(str(formData, "returnTo"), `${BACK}?tab=monthly${month ? `&month=${month.yearMonth}` : ""}`);
  if (!canManageAttendance(user)) fail(back, "労務士への送信は本部スタッフ・管理者が行います。");
  if (!month) fail(back, "勤務表が見つかりません。");
  if (month!.status !== "final") fail(back, "確定してから送ってください (送ったあとに変えないため)。");
  const to = str(formData, "to")
    .split(/[,、\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (!to.length || to.some((x) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x))) fail(back, "送り先のメールアドレスを正しく入力してください (複数はカンマ区切り)。");
  const subject = str(formData, "subject").slice(0, 200);
  const body = String(formData.get("body") ?? "").slice(0, 4000);
  if (!subject || !body.trim()) fail(back, "件名と本文を入力してください。");
  const file = attendanceXlsx(db0, month!);
  const attachments = [{ filename: attendanceFileName(month!), contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", base64: file.toString("base64") }];
  const deliveries = await sendAndRecord(
    to.map((addr) => ({ channel: "email" as const, to: addr, toLabel: attendanceSettings(db0).sharoushi.name || addr, subject, body, attachments, purpose: "document" as const })),
    user.id,
  );
  const sent = deliveries.filter((d) => d.status === "sent");
  const now = nowIso();
  await mutate((db) => {
    const m = db.attendanceMonths.find((x) => x.id === monthId);
    if (!m) return;
    if (sent.length) {
      m.sentAt = now;
      m.sentBy = user.id;
      m.sentTo = to.join(", ");
    }
    m.deliveryIds = [...(m.deliveryIds ?? []), ...deliveries.map((d) => d.id)].slice(-20);
    m.updatedAt = now;
    addAudit(db, { userId: user.id, action: "update", entity: "attendance_month", entityId: m.id, entityLabel: m.yearMonth, summary: sent.length ? `勤務表 ${m.yearMonth} を労務士へ送信 (${to.join(", ")})` : `勤務表 ${m.yearMonth} の送信に失敗 (${deliveries.map((d) => d.status).join("・")})` });
  });
  revalidate();
  if (!sent.length) {
    const why = deliveries[0]?.status === "skipped" ? "メールの送信の設定がありません (外部連携の設定)。" : (deliveries[0]?.error ?? "送れませんでした。");
    fail(back, `送信できませんでした: ${why} .xlsx をダウンロードして送ってください。`);
  }
  redirect(withMsg(back, `${to.join(", ")} へ送りました (${attendanceFileName(month!)})。`));
}

/* ---------------- 設定 ---------------- */

function settingsRow(db: Database, actor: User): AppSetting {
  let row = db.settings.find((s) => s.id === ATTENDANCE_SETTINGS_ID);
  if (!row) {
    row = { id: ATTENDANCE_SETTINGS_ID, value: {}, updatedBy: actor.id, updatedAt: nowIso() };
    db.settings.push(row);
  }
  return row;
}

function writeSettings(db: Database, actor: User, label: string, patch: (cur: AttendanceSettings) => Partial<AttendanceSettings>) {
  const before = attendanceSettings(db);
  const row = settingsRow(db, actor);
  const next = { ...before, ...patch(before) };
  row.value = next as unknown as Record<string, unknown>;
  row.updatedBy = actor.id;
  row.updatedAt = nowIso();
  addAudit(db, { userId: actor.id, action: "update", entity: "settings", entityId: ATTENDANCE_SETTINGS_ID, entityLabel: "勤怠の設定", summary: label });
}

/** 決まり (シフト・法定休日・固定残業・深夜・インセンティブの単価と期間): 管理者 */
export async function saveAttendanceRules(formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), `${BACK}?tab=setup`);
  if (!canManageAttendanceRules(user)) fail(back, "勤怠の決まりは管理者が変更します。");
  const shifts: ShiftDef[] = [];
  for (let i = 0; i < 6; i++) {
    const id = str(formData, `shift_${i}_id`).replace(/[^a-z0-9_-]/gi, "");
    if (!id) continue;
    if (formData.get(`shift_${i}_remove`) === "1") continue;
    const start = parseHm(str(formData, `shift_${i}_start`), back, "始業") ?? "08:00";
    const end = parseHm(str(formData, `shift_${i}_end`), back, "終業") ?? "17:00";
    if (toMin(end) <= toMin(start)) fail(back, "終業は始業より後の時刻にしてください。");
    const breaks = [0, 1, 2, 3].flatMap((j) => {
      const bs = parseHm(str(formData, `shift_${i}_b${j}_start`), back, "休憩の始まり");
      const be = parseHm(str(formData, `shift_${i}_b${j}_end`), back, "休憩の終わり");
      if (!bs && !be) return [];
      if (!bs || !be || toMin(be) <= toMin(bs)) fail(back, "休憩は始まりと終わりの両方を、終わりを後にして入力してください。");
      return [{ start: bs!, end: be! }];
    });
    shifts.push({ id, name: str(formData, `shift_${i}_name`) || id, start, end, breaks });
  }
  if (!shifts.length) fail(back, "シフトを 1 つ以上残してください。");
  const startDate = str(formData, "startDate");
  if (startDate && !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) fail(back, "打刻を使い始めた日を正しく入力してください。");
  const n = (k: string, min: number, max: number, d: number) => {
    const v = Number(str(formData, k));
    return Number.isFinite(v) && str(formData, k) !== "" && v >= min && v <= max ? v : d;
  };
  const pay = (k: string): IncentivePay => (str(formData, k) === "salary" ? "salary" : "cash");
  const period = (k: string): IncentivePeriod => (str(formData, k) === "closing" ? "closing" : "prev_month");
  const until = str(formData, "slip_until");
  await mutate((db) =>
    writeSettings(db, user, "勤怠の決まり (シフト・休日・残業・インセンティブ) を変更", (cur) => ({
      startDate,
      shifts,
      defaultShift: { staff: shifts.some((s) => s.id === str(formData, "default_staff")) ? str(formData, "default_staff") : shifts[0].id, part: shifts.some((s) => s.id === str(formData, "default_part")) ? str(formData, "default_part") : shifts[0].id },
      legalHolidayWeekday: n("legalHolidayWeekday", 0, 6, cur.legalHolidayWeekday),
      fixedOvertime: { craft: n("fixed_craft", 0, 200, ATTENDANCE_DEFAULTS.fixedOvertime.craft), office: n("fixed_office", 0, 200, ATTENDANCE_DEFAULTS.fixedOvertime.office) },
      countEarlyStart: formData.get("countEarlyStart") === "1",
      incentives: {
        review: { enabled: formData.get("review_enabled") === "1", yen: n("review_yen", 0, 1_000_000, 1000), period: period("review_period"), pay: pay("review_pay") },
        inspection: { enabled: formData.get("inspection_enabled") === "1", yen: n("inspection_yen", 0, 1_000_000, 500), period: period("inspection_period"), pay: pay("inspection_pay") },
        manDay: { enabled: formData.get("manday_enabled") === "1", pay: pay("manday_pay") },
        slip: { enabled: formData.get("slip_enabled") === "1", pay: pay("slip_pay"), until: /^\d{4}-\d{2}$/.test(until) ? until : undefined },
      },
    })),
  );
  revalidate();
  redirect(withMsg(back, "勤怠の決まりを保存しました。"));
}

/** 社員ごとの区分・社員番号・シフト・固定残業・時給 (本部・管理者) */
export async function saveAttendanceProfiles(formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), `${BACK}?tab=setup`);
  if (!canManageAttendance(user)) fail(back, "社員の勤怠の設定は本部スタッフ・管理者が行います。");
  const db0 = getDb();
  const ids = formData.getAll("uid").map(String).filter((id) => db0.users.some((u) => u.id === id));
  await mutate((db) =>
    writeSettings(db, user, `社員の勤怠の設定を変更 (${ids.length} 人)`, (cur) => {
      const profiles: Record<string, StaffProfile> = { ...cur.profiles };
      for (const id of ids) {
        const cat = str(formData, `cat_${id}`);
        const rateYen = Number(str(formData, `rate_${id}`));
        const rateFrom = str(formData, `ratefrom_${id}`);
        const fo = str(formData, `fixed_${id}`);
        const prev = cur.profiles[id] ?? {};
        let rates = prev.rates ?? [];
        if (Number.isFinite(rateYen) && rateYen > 0 && rateYen <= 100_000) {
          const from = /^\d{4}-\d{2}-\d{2}$/.test(rateFrom) ? rateFrom : (rates.at(-1)?.from ?? toDateKey(new Date()));
          rates = [...rates.filter((r) => r.from !== from), { from, yen: rateYen }].sort((a, b) => a.from.localeCompare(b.from));
        }
        const p: StaffProfile = {
          category: cat in STAFF_CATEGORY ? (cat as StaffCategory) : undefined,
          employeeNo: str(formData, `no_${id}`).slice(0, 20) || undefined,
          shiftId: cur.shifts.some((s) => s.id === str(formData, `shift_${id}`)) ? str(formData, `shift_${id}`) : undefined,
          fixedOvertimeHours: fo !== "" && Number.isFinite(Number(fo)) && Number(fo) >= 0 && Number(fo) <= 200 ? Number(fo) : undefined,
          rates: rates.length ? rates : undefined,
        };
        if (Object.values(p).some((x) => x !== undefined)) profiles[id] = p;
        else delete profiles[id];
      }
      return { profiles };
    }),
  );
  revalidate();
  redirect(withMsg(back, "社員の勤怠の設定を保存しました。"));
}

/** 労務士の宛先・件名・本文 (本部・管理者) */
export async function saveSharoushi(formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), `${BACK}?tab=setup`);
  if (!canManageAttendance(user)) fail(back, "労務士の宛先は本部スタッフ・管理者が設定します。");
  const to = str(formData, "to");
  if (to && to.split(/[,、\s]+/).filter(Boolean).some((x) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x))) fail(back, "メールアドレスを正しく入力してください (複数はカンマ区切り)。");
  await mutate((db) =>
    writeSettings(db, user, "労務士の宛先・文面を変更", (cur) => ({
      sharoushi: { name: str(formData, "name").slice(0, 80), to: to.slice(0, 200), cc: "", subject: str(formData, "subject").slice(0, 200) || cur.sharoushi.subject, body: String(formData.get("body") ?? "").slice(0, 4000) || cur.sharoushi.body },
    })),
  );
  revalidate();
  redirect(withMsg(back, "労務士の宛先・文面を保存しました。"));
}

/** インセンティブの手入力 (点検の件数・口コミの点の置き換え、調整額) */
export async function saveIncentiveAdjust(formData: FormData) {
  const user = await requireActionUser();
  const yearMonth = str(formData, "yearMonth");
  const back = safeReturn(str(formData, "returnTo"), `${BACK}?tab=incentive&month=${yearMonth}`);
  if (!canManageAttendance(user)) fail(back, "インセンティブの調整は本部スタッフ・管理者が行います。");
  if (!/^\d{4}-\d{2}$/.test(yearMonth)) fail(back, "対象月が正しくありません。");
  const db0 = getDb();
  const ids = formData.getAll("uid").map(String).filter((id) => db0.users.some((u) => u.id === id));
  const num = (k: string, min: number, max: number) => {
    const raw = str(formData, k).replace(/[,，円]/g, "");
    if (raw === "") return undefined;
    const v = Number(raw);
    if (!Number.isFinite(v) || v < min || v > max) fail(back, "数を正しく入力してください。");
    return v;
  };
  await mutate((db) => {
    const id = incentiveAdjustId(yearMonth);
    const items: Record<string, IncentiveAdjust> = { ...readIncentiveAdjust(db, yearMonth) };
    for (const uid of ids) {
      const a: IncentiveAdjust = { inspection: num(`insp_${uid}`, 0, 1000), review: num(`rev_${uid}`, 0, 10000), cash: num(`cash_${uid}`, -10_000_000, 10_000_000), salary: num(`sal_${uid}`, -10_000_000, 10_000_000), note: str(formData, `note_${uid}`).slice(0, 200) || undefined };
      if (Object.values(a).some((x) => x !== undefined)) items[uid] = a;
      else delete items[uid];
    }
    let row = db.settings.find((s) => s.id === id);
    if (!row) {
      row = { id, value: {}, updatedAt: nowIso() };
      db.settings.push(row);
    }
    row.value = { items };
    row.updatedBy = user.id;
    row.updatedAt = nowIso();
    addAudit(db, { userId: user.id, action: "update", entity: "settings", entityId: id, entityLabel: `インセンティブの調整 ${yearMonth}`, summary: `インセンティブの手入力を保存 (${Object.keys(items).length} 人)` });
  });
  revalidate();
  redirect(withMsg(back, "インセンティブの手入力を保存しました。勤務表は「打刻・休暇から作り直す」で反映します。"));
}
