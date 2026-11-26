import "server-only";
import { addAudit, newId, nextNumber, nowIso } from "@/lib/db/store";
import type { AttendanceDay, AttendanceRequest, Database, LeaveSlot, ScheduleEvent, User } from "@/lib/db/types";
import { canApproveAttendance, canCancelAttendanceRequest, canRequestAttendanceFor, canStampAttendance } from "@/lib/auth/permissions";
import { toDateKey } from "@/lib/format";
import { addHolidayWork, LeaveError, removeHolidayWork } from "./apply";
import { LEAVE_SLOT, hrSettings, md } from "./leave";
import { HM_RE, KIND_LABEL, attendanceSettings, clock, dayRecordId, dayTypeOf, isoOnDay, minutesOnDay, shiftOf, toMin, DAY_TYPE } from "./timecard";
import { kpiSettings } from "@/lib/kpi-settings";

/**
 * 打刻・勤務表の記録の変更 (打刻・打刻修正・休日出勤の申請・承認・却下・取下げ)
 * ------------------------------------------------------------
 * mutate() の中で呼ぶ。断るときは LeaveError (操作 src/lib/actions/timecard.ts が画面のメッセージにする)。
 * 打刻の時刻は消さずに attendance_days.log に残す (労働時間の記録。直した人・理由・申請)。
 * 承認できる人 (店長・管理者) が申請したときは、申請と同時に承認する (休暇と同じ)
 */

const err = (msg: string): never => {
  throw new LeaveError(msg);
};

const nameOf = (db: Database, id?: string) => db.users.find((u) => u.id === id)?.name ?? "-";
export const requestLabel = (db: Database, r: Pick<AttendanceRequest, "number" | "userId" | "kind" | "date">) => `${r.number} ${nameOf(db, r.userId)} ${KIND_LABEL[r.kind]} ${md(r.date)}`;

/** 「8:05」(ISO → その勤務日の時刻。翌日は 24:00 以降) */
export function hmOf(iso: string | undefined, date: string): string | undefined {
  const m = minutesOnDay(iso, date);
  return m === undefined ? undefined : clock(m);
}

function dayRecord(db: Database, user: Pick<User, "id" | "storeId">, date: string, now: string): AttendanceDay {
  const id = dayRecordId(user.id, date);
  let rec = db.attendanceDays.find((r) => r.id === id);
  if (!rec) {
    rec = { id, userId: user.id, storeId: user.storeId, date, log: [], createdAt: now, updatedAt: now };
    db.attendanceDays.push(rec);
  }
  return rec;
}

/* ---------------- 打刻 ---------------- */

export interface StampResult {
  record: AttendanceDay;
  kind: "in" | "out";
  time: string;
  message: string;
}

/**
 * 出勤・退勤の打刻 (本人)。退勤は今日の出勤に付ける (今日の出勤がなく、前の日の退勤がまだで朝 5 時までなら前の日の退勤)。
 * 二重の打刻は断る (直すときは打刻修正の申請)
 */
export function stamp(db: Database, actor: User, kind: "in" | "out", at: Date = new Date()): StampResult {
  if (!canStampAttendance(actor)) err("打刻できないアカウントです。");
  const now = at.toISOString();
  let date = toDateKey(at);
  const yesterday = toDateKey(new Date(at.getTime() - 86_400_000));
  if (kind === "out") {
    const today = db.attendanceDays.find((r) => r.id === dayRecordId(actor.id, date));
    const prev = db.attendanceDays.find((r) => r.id === dayRecordId(actor.id, yesterday));
    if (!today?.clockIn && prev?.clockIn && !prev.clockOut && at.getHours() < 5) date = yesterday;
  }
  const rec = dayRecord(db, actor, date, now);
  const t = hmOf(now, date)!;
  if (kind === "in") {
    if (rec.clockIn) err(`今日の出勤は ${hmOf(rec.clockIn, date)} に打刻済みです。時刻を直すときは打刻修正の申請をしてください。`);
    rec.clockIn = now;
  } else {
    if (rec.clockOut) err(`今日の退勤は ${hmOf(rec.clockOut, date)} に打刻済みです。時刻を直すときは打刻修正の申請をしてください。`);
    rec.clockOut = now;
  }
  rec.storeId = actor.storeId;
  rec.log.push({ at: now, kind, value: t, by: actor.id, via: "stamp" });
  rec.updatedAt = now;
  const label = kind === "in" ? "出勤" : "退勤";
  addAudit(db, { userId: actor.id, action: "create", entity: "attendance", entityId: rec.id, entityLabel: `${actor.name} ${md(date)} ${label}`, summary: `${label}を打刻 (${t})`, storeId: actor.storeId });
  const s = attendanceSettings(db);
  const typ = dayTypeOf(db, s, date);
  const hw = db.holidayWorks.some((w) => w.userId === actor.id && w.kind === "work" && w.date === date);
  const note = kind === "in" && !rec.clockOut && typ !== "work" && !hw ? ` 今日は${DAY_TYPE[typ]}です。休日出勤のときは「休日出勤の申請」をしてください。` : kind === "out" && !rec.clockIn ? " 出勤の打刻がありません。打刻修正の申請をしてください。" : "";
  return { record: rec, kind, time: t, message: `${label}を打刻しました (${t})。${note}` };
}

/* ---------------- 申請 ---------------- */

export interface RequestInput {
  userId: string;
  kind: AttendanceRequest["kind"];
  date: string;
  clockIn?: string;
  clockOut?: string;
  skipBreaks?: number[];
  slot?: LeaveSlot;
  reason: string;
}

const validHm = (v: string | undefined) => !v || (HM_RE.test(v) && toMin(v) <= 29 * 60 + 59);

export interface RequestResult {
  request: AttendanceRequest;
  approved: boolean;
  warning?: string;
}

export function createAttendanceRequest(db: Database, actor: User, input: RequestInput, today: string): RequestResult {
  const target = db.users.find((u) => u.id === input.userId);
  if (!target || !target.active) err("社員が見つかりません。");
  if (!canRequestAttendanceFor(actor, target!)) err("この社員の申請をする権限がありません (店長は自店舗の社員、本部・管理者は全員の分を申請できます)。");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) err("日付を正しく入力してください。");
  if (input.date > today) err(input.kind === "correction" ? "打刻修正は今日までの日にしてください。" : "休日出勤の申請は、出勤した日 (今日まで) にしてください。予定は予定表に入れてください。");
  if (!input.reason.trim()) err("理由を入力してください (キャスタイムと同じく理由は必ず残します)。");
  if (!validHm(input.clockIn) || !validHm(input.clockOut)) err("時刻は 8:00・17:30 の形で入力してください (翌日の朝は 25:30 のように 24 時より後で)。");
  if (input.clockIn && input.clockOut && toMin(input.clockOut) <= toMin(input.clockIn)) err("退勤は出勤より後の時刻にしてください。");
  const s = attendanceSettings(db);
  const typ = dayTypeOf(db, s, input.date);
  if (input.kind === "holiday_work") {
    if (typ === "work") err(`${md(input.date)} は出勤日です。休日出勤の申請は会社の休業日にしてください (休業日は休日カレンダー)。`);
    if (!input.slot || !LEAVE_SLOT[input.slot]) err("終日・午前・午後を選んでください。");
    if (db.holidayWorks.some((w) => w.userId === target!.id && w.kind === "work" && w.date === input.date)) err(`${md(input.date)} の休日出勤はすでに登録されています。`);
  }
  const rec = db.attendanceDays.find((r) => r.id === dayRecordId(target!.id, input.date));
  if (input.kind === "correction" && !input.clockIn && !input.clockOut && !input.skipBreaks) err("直す出勤・退勤の時刻か、外す休憩を入れてください。");
  const dup = db.attendanceRequests.find((r) => r.userId === target!.id && r.date === input.date && r.kind === input.kind && r.status === "pending");
  if (dup) err(`${md(input.date)} の${KIND_LABEL[input.kind]}はすでに申請中です (${dup.number})。取り下げてから申請し直してください。`);
  const now = nowIso();
  const req: AttendanceRequest = {
    id: newId("atr"),
    number: nextNumber(db, "AT", db.attendanceRequests, now.slice(0, 10)),
    userId: target!.id,
    storeId: target!.storeId,
    kind: input.kind,
    date: input.date,
    clockIn: input.clockIn || undefined,
    clockOut: input.clockOut || undefined,
    skipBreaks: input.skipBreaks,
    slot: input.kind === "holiday_work" ? input.slot : undefined,
    reason: input.reason.trim().slice(0, 300),
    status: "pending",
    requestedBy: actor.id,
    requestedAt: now,
    previous: rec ? { clockIn: hmOf(rec.clockIn, rec.date), clockOut: hmOf(rec.clockOut, rec.date), skipBreaks: rec.skipBreaks } : undefined,
    updatedAt: now,
  };
  db.attendanceRequests.push(req);
  addAudit(db, { userId: actor.id, action: "create", entity: "attendance_request", entityId: req.id, entityLabel: requestLabel(db, req), summary: `${KIND_LABEL[req.kind]}を申請${req.userId !== actor.id ? ` (${actor.name} が代わりに)` : ""} (${req.reason})`, storeId: req.storeId });
  if (canApproveAttendance(actor, req)) {
    const r = approveIn(db, actor, req, "申請者が承認");
    return { request: req, approved: true, warning: r.warning };
  }
  return { request: req, approved: false };
}

/** 承認の反映: 打刻を直す・休日出勤 (振休が付く・予定表に「休日出勤」) */
function approveIn(db: Database, actor: User, req: AttendanceRequest, comment: string): { warning?: string } {
  const now = nowIso();
  const target = db.users.find((u) => u.id === req.userId) ?? ({ id: req.userId, storeId: req.storeId } as User);
  const rec = dayRecord(db, target, req.date, now);
  let warning: string | undefined;
  const fix = (field: "clockIn" | "clockOut", hm?: string) => {
    if (!hm) return;
    const before = hmOf(rec[field], rec.date);
    rec[field] = isoOnDay(req.date, toMin(hm));
    rec.log.push({ at: now, kind: "fix", value: `${field === "clockIn" ? "出勤" : "退勤"} ${hm}`, before: before ? `${field === "clockIn" ? "出勤" : "退勤"} ${before}` : undefined, by: actor.id, via: "request", requestId: req.id, note: req.reason });
  };
  fix("clockIn", req.clockIn);
  fix("clockOut", req.clockOut);
  if (req.skipBreaks) {
    const before = (rec.skipBreaks ?? []).join(",");
    rec.skipBreaks = req.skipBreaks.length ? [...req.skipBreaks].sort() : undefined;
    rec.log.push({ at: now, kind: "breaks", value: (rec.skipBreaks ?? []).join(",") || "なし", before: before || "なし", by: actor.id, via: "request", requestId: req.id, note: req.reason });
  }
  rec.updatedAt = now;
  if (req.kind === "holiday_work") {
    const r = addHolidayWork(db, actor, { userId: req.userId, date: req.date, slot: req.slot ?? "day", note: `休日出勤の申請 ${req.number}: ${req.reason}` });
    req.holidayWorkId = r.work.id;
    warning = r.warning;
    const s = attendanceSettings(db);
    const hr = hrSettings(db);
    const shift = shiftOf(s, target, kpiSettings(db).clerkUserIds);
    const slot = req.slot ?? "day";
    const ev: ScheduleEvent = {
      id: newId("ev"),
      title: `${target.name ?? ""} 休日出勤${slot === "day" ? "" : ` (${LEAVE_SLOT[slot]})`}`,
      kind: "other",
      date: req.date,
      startTime: req.clockIn ?? (slot === "pm" ? hr.pmStart : shift.start),
      endTime: req.clockOut && toMin(req.clockOut) < 24 * 60 ? req.clockOut : slot === "am" ? hr.amEnd : shift.end,
      storeId: req.storeId,
      assigneeIds: [req.userId],
      source: "manual",
      memo: `休日出勤の申請 ${req.number} から登録 (勤怠の画面で取り消すと、この予定も消えます)。${req.reason}`,
      createdBy: actor.id,
      createdAt: now,
    };
    db.schedule.push(ev);
    req.eventId = ev.id;
    addAudit(db, { userId: actor.id, action: "create", entity: "schedule", entityId: ev.id, entityLabel: ev.title, summary: `休日出勤の承認で予定を登録 (${req.number})`, storeId: ev.storeId });
  }
  req.status = "approved";
  req.decidedBy = actor.id;
  req.decidedAt = now;
  req.decisionComment = comment.trim() || undefined;
  req.updatedAt = now;
  addAudit(db, { userId: actor.id, action: "approve", entity: "attendance_request", entityId: req.id, entityLabel: requestLabel(db, req), summary: `${KIND_LABEL[req.kind]}を承認${req.kind === "holiday_work" ? " (振休を付与・予定表に登録)" : " (打刻を修正)"}`, storeId: req.storeId, changes: [{ field: "status", before: "pending", after: "approved" }] });
  return { warning };
}

export function decideAttendanceRequest(db: Database, actor: User, id: string, decision: "approved" | "rejected", comment: string): RequestResult {
  const req = db.attendanceRequests.find((r) => r.id === id);
  if (!req) err("申請が見つかりません。");
  if (req!.status !== "pending") err(`${req!.number} はすでに処理済みです。`);
  if (!canApproveAttendance(actor, req!)) err(req!.userId === actor.id ? "自分の申請は承認できません (管理者が承認します)。" : "この申請は所属店舗の店長か管理者が判断します。");
  if (decision === "approved") {
    const r = approveIn(db, actor, req!, comment);
    return { request: req!, approved: true, warning: r.warning };
  }
  if (!comment.trim()) err("却下の理由を入力してください (申請者に伝わります)。");
  const now = nowIso();
  req!.status = "rejected";
  req!.decidedBy = actor.id;
  req!.decidedAt = now;
  req!.decisionComment = comment.trim();
  req!.updatedAt = now;
  addAudit(db, { userId: actor.id, action: "reject", entity: "attendance_request", entityId: req!.id, entityLabel: requestLabel(db, req!), summary: `${KIND_LABEL[req!.kind]}を却下 (${comment.trim()})`, storeId: req!.storeId, changes: [{ field: "status", before: "pending", after: "rejected" }] });
  return { request: req!, approved: false };
}

/** 取下げ・承認の取消し (承認済みの打刻修正は申請の前の打刻に戻す・休日出勤は振休と予定も消す) */
export function cancelAttendanceRequest(db: Database, actor: User, id: string, reason: string): AttendanceRequest {
  const req = db.attendanceRequests.find((r) => r.id === id);
  if (!req) err("申請が見つかりません。");
  if (!canCancelAttendanceRequest(actor, req!)) err(req!.status === "approved" ? "承認済みの申請の取消しは、承認できる人 (店長・管理者) ができます。" : "この申請は取り下げられません。");
  const now = nowIso();
  const before = req!.status;
  if (before === "approved") {
    const rec = db.attendanceDays.find((r) => r.id === dayRecordId(req!.userId, req!.date));
    if (rec) {
      const later = db.attendanceRequests.some((r) => r.id !== req!.id && r.userId === req!.userId && r.date === req!.date && r.status === "approved" && (r.decidedAt ?? "") > (req!.decidedAt ?? ""));
      if (later) err(`${md(req!.date)} はこの申請のあとにも打刻を直しています。新しい申請から取り消してください。`);
      const restore = (field: "clockIn" | "clockOut", prev?: string, changed?: string) => {
        if (!changed) return;
        rec[field] = prev ? isoOnDay(rec.date, toMin(prev)) : undefined;
        rec.log.push({ at: now, kind: prev ? "fix" : "clear", value: prev ? `${field === "clockIn" ? "出勤" : "退勤"} ${prev}` : `${field === "clockIn" ? "出勤" : "退勤"} なし`, by: actor.id, via: "admin", requestId: req!.id, note: `申請 ${req!.number} の取消し${reason ? `: ${reason}` : ""}` });
      };
      restore("clockIn", req!.previous?.clockIn, req!.clockIn);
      restore("clockOut", req!.previous?.clockOut, req!.clockOut);
      if (req!.skipBreaks) rec.skipBreaks = req!.previous?.skipBreaks;
      rec.updatedAt = now;
    }
    if (req!.holidayWorkId && db.holidayWorks.some((w) => w.id === req!.holidayWorkId)) removeHolidayWork(db, actor, req!.holidayWorkId);
    if (req!.eventId) {
      const ev = db.schedule.find((e) => e.id === req!.eventId);
      if (ev) {
        db.schedule = db.schedule.filter((e) => e.id !== ev.id);
        addAudit(db, { userId: actor.id, action: "delete", entity: "schedule", entityId: ev.id, entityLabel: ev.title, summary: `休日出勤の取消しで予定を削除 (${req!.number})`, storeId: ev.storeId, changes: [{ field: "date", before: ev.date, after: undefined }, { field: "kind", before: ev.kind, after: undefined }] });
      }
    }
  }
  req!.status = "cancelled";
  req!.cancelledBy = actor.id;
  req!.cancelledAt = now;
  req!.updatedAt = now;
  addAudit(db, { userId: actor.id, action: "status", entity: "attendance_request", entityId: req!.id, entityLabel: requestLabel(db, req!), summary: `${KIND_LABEL[req!.kind]}を${before === "approved" ? "取消し (打刻を申請の前に戻す)" : "取下げ"}${reason ? ` (${reason})` : ""}`, storeId: req!.storeId, changes: [{ field: "status", before, after: "cancelled" }] });
  return req!;
}

/** 1 日の予定のラベル (申請の一覧) */
export function requestSummary(r: Pick<AttendanceRequest, "kind" | "clockIn" | "clockOut" | "skipBreaks" | "slot">, breakNames?: string[]): string {
  const parts: string[] = [];
  if (r.kind === "holiday_work") parts.push(LEAVE_SLOT[r.slot ?? "day"]);
  if (r.clockIn) parts.push(`出勤 ${r.clockIn}`);
  if (r.clockOut) parts.push(`退勤 ${r.clockOut}`);
  if (r.skipBreaks?.length) parts.push(`休憩を外す: ${r.skipBreaks.map((i) => breakNames?.[i] ?? `休憩${i + 1}`).join("・")}`);
  return parts.join(" / ");
}
