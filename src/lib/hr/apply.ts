import "server-only";
import { addAudit, diffChanges, newId, nextNumber, nowIso } from "@/lib/db/store";
import type { AppSetting, Database, HolidayWork, LeaveGrant, LeaveRequest, LeaveSlot, LeaveType, ScheduleEvent, User } from "@/lib/db/types";
import { canApproveLeave, canCancelLeave, canManageLeaveGrants, canManageLeaveSettings, canRegisterHolidayWork, canRequestLeaveFor } from "@/lib/auth/permissions";
import {
  HR_SETTINGS_ID,
  LEAVE_SLOT,
  LEAVE_TYPE,
  compBalance,
  compBreaksWithout,
  compShortageMessage,
  fmtDays,
  grantExpiry,
  hrSettings,
  isDateKey,
  leaveConflicts,
  leaveDates,
  leaveDays,
  leaveEventShape,
  md,
  openingGrantParts,
  overlappingLeave,
  paidBreaksWith,
  paidLedger,
  paidShortageMessage,
  shiftDays,
  type HrSettings,
  type LeaveProfile,
  type OpeningRow,
} from "./leave";

/**
 * 有給・休日出勤の記録の変更 (申請・承認・却下・取消し・休日出勤・付与・取込・設定)
 * ------------------------------------------------------------
 * mutate() の中で呼ぶ (db はその時点の最新)。断るときは LeaveError を投げる (操作 src/lib/actions/leave.ts が画面のメッセージにする)。
 * 権限は src/lib/auth/permissions.ts の関数だけで判定する。変更履歴の entity は leave / holiday_work / leave_grant / settings
 */

export class LeaveError extends Error {}

const err = (msg: string): never => {
  throw new LeaveError(msg);
};

const userOf = (db: Database, id: string) => db.users.find((u) => u.id === id);
const nameOf = (db: Database, id?: string) => db.users.find((u) => u.id === id)?.name ?? "-";
const when = (r: Pick<LeaveRequest, "date" | "endDate" | "slot">) => `${md(r.date)}${r.endDate && r.endDate > r.date ? `〜${md(r.endDate)}` : ""}${r.slot === "day" ? "" : ` ${LEAVE_SLOT[r.slot]}`}`;
export const leaveLabel = (db: Database, r: Pick<LeaveRequest, "userId" | "leaveType" | "date" | "endDate" | "slot" | "number">) => `${r.number} ${nameOf(db, r.userId)} ${LEAVE_TYPE[r.leaveType].label} ${when(r)}`;

/* ---------------- 休暇の申請 ---------------- */

export interface LeaveInput {
  userId: string;
  leaveType: LeaveType;
  date: string;
  endDate?: string;
  slot: LeaveSlot;
  reason?: string;
  holidayWorkId?: string;
}

export interface LeaveResult {
  request: LeaveRequest;
  /** 承認済みになった (承認できる人の登録・管理者の自分の申請) */
  approved: boolean;
  /** 期間に入っている本人の予定 (承認したときの重複の警告) */
  conflicts: string[];
}

/** 休暇の申請 (本人・代理)。承認できる人が登録したときはそのまま承認する */
export function createLeave(db: Database, actor: User, input: LeaveInput): LeaveResult {
  const target = userOf(db, input.userId);
  if (!target || !target.active) err("社員が見つかりません。");
  if (!canRequestLeaveFor(actor, target!)) err("この社員の休暇を申請する権限がありません (店長は自店舗の社員、本部・管理者は全員の分を登録できます)。");
  if (!LEAVE_TYPE[input.leaveType]) err("休暇の種類を選んでください。");
  if (!isDateKey(input.date)) err("日付を正しく入力してください。");
  let endDate = input.endDate || undefined;
  if (endDate && !isDateKey(endDate)) err("終了日を正しく入力してください。");
  if (endDate && endDate < input.date) err("終了日は開始日以降の日付にしてください。");
  if (endDate === input.date) endDate = undefined;
  if (endDate && input.slot !== "day") err("半日 (午前・午後) の休暇は 1 日ずつ申請してください。");
  if (endDate && endDate > shiftDays(input.date, 30)) err("1 回の申請は 31 日以内にしてください。");
  const reason = input.reason?.trim() || undefined;
  if (input.leaveType === "special" && !reason) err("特別休暇は理由 (慶弔など) を入力してください。");
  const dates = leaveDates(db, input.date, endDate, input.slot);
  if (!dates.length) err("期間がすべて休業日のため、休暇の日数が 0 日です。");
  const dup = overlappingLeave(db, target!.id, dates, input.slot);
  if (dup) err(`同じ日に休暇があります (${dup.number} ${LEAVE_TYPE[dup.leaveType].label} ${when(dup)}・${dup.status === "pending" ? "申請中" : "承認済み"})。`);
  let holidayWorkId: string | undefined;
  if (input.leaveType === "comp" && input.holidayWorkId) {
    const w = db.holidayWorks.find((x) => x.id === input.holidayWorkId && x.userId === target!.id);
    if (!w) err("充てる休日出勤が見つかりません。");
    holidayWorkId = w!.id;
  }
  const now = nowIso();
  const request: LeaveRequest = {
    id: newId("lv"),
    number: nextNumber(db, "LV", db.leaveRequests, now.slice(0, 10)),
    userId: target!.id,
    storeId: target!.storeId,
    leaveType: input.leaveType,
    date: input.date,
    endDate,
    slot: input.slot,
    dates,
    days: leaveDays(dates, input.slot),
    reason,
    holidayWorkId,
    status: "pending",
    requestedBy: actor.id,
    requestedAt: now,
    updatedAt: now,
  };
  // 残日数の確認 (申請中の分も差し引く)
  if (request.leaveType === "paid") {
    const m = paidShortageMessage(db, request, true);
    if (m) err(m);
  } else if (request.leaveType === "comp") {
    const m = compShortageMessage(db, request, true);
    if (m) err(m);
  }
  db.leaveRequests.push(request);
  const proxy = actor.id !== target!.id;
  addAudit(db, {
    userId: actor.id,
    action: "create",
    entity: "leave",
    entityId: request.id,
    entityLabel: leaveLabel(db, request),
    summary: `${LEAVE_TYPE[request.leaveType].label}を申請 (${fmtDays(request.days)}${proxy ? `・${actor.name} が代理で登録` : ""})`,
    storeId: request.storeId,
  });
  if (canApproveLeave(actor, request)) {
    const conflicts = approveIn(db, actor, request, proxy ? "承認できる人の登録のため、そのまま承認" : "管理者の申請のため承認を省略");
    return { request, approved: true, conflicts };
  }
  return { request, approved: false, conflicts: [] };
}

/** 承認の反映: 残日数を確かめ、予定表に「休暇」を登録する */
function approveIn(db: Database, actor: User, req: LeaveRequest, comment?: string): string[] {
  if (req.leaveType === "paid") {
    const m = paidShortageMessage(db, req, false);
    if (m) err(m);
  } else if (req.leaveType === "comp") {
    const m = compShortageMessage(db, req, false);
    if (m) err(m);
  }
  const now = nowIso();
  const event: ScheduleEvent = { id: newId("ev"), ...leaveEventShape(db, req), createdBy: actor.id, createdAt: now };
  db.schedule.push(event);
  const before = req.status;
  req.status = "approved";
  req.decidedBy = actor.id;
  req.decidedAt = now;
  req.decisionComment = comment || undefined;
  req.eventId = event.id;
  req.updatedAt = now;
  const label = leaveLabel(db, req);
  addAudit(db, { userId: actor.id, action: "approve", entity: "leave", entityId: req.id, entityLabel: label, summary: `${LEAVE_TYPE[req.leaveType].label}を承認 (予定表に登録)${comment ? ` (${comment})` : ""}`, storeId: req.storeId, changes: [{ field: "status", before, after: "approved" }] });
  addAudit(db, { userId: actor.id, action: "create", entity: "schedule", entityId: event.id, entityLabel: event.title, summary: `休暇の承認で予定を登録 (${req.number})`, storeId: event.storeId });
  return leaveConflicts(db, req).map((c) => c.label);
}

/** 承認・却下 */
export function decideLeave(db: Database, actor: User, id: string, decision: "approved" | "rejected", comment: string): LeaveResult {
  const req = db.leaveRequests.find((r) => r.id === id);
  if (!req) err("休暇の申請が見つかりません。");
  if (req!.status !== "pending") err("この申請はすでに処理済みです。");
  if (!canApproveLeave(actor, req!)) err(req!.userId === actor.id ? "自分の休暇は承認できません (管理者が承認します)。" : "この申請は所属店舗の店長か管理者が判断します。");
  if (decision === "approved") {
    const conflicts = approveIn(db, actor, req!, comment);
    return { request: req!, approved: true, conflicts };
  }
  if (!comment.trim()) err("却下の理由をコメントに入力してください (申請者に伝わります)。");
  const now = nowIso();
  req!.status = "rejected";
  req!.decidedBy = actor.id;
  req!.decidedAt = now;
  req!.decisionComment = comment.trim();
  req!.updatedAt = now;
  addAudit(db, { userId: actor.id, action: "reject", entity: "leave", entityId: req!.id, entityLabel: leaveLabel(db, req!), summary: `${LEAVE_TYPE[req!.leaveType].label}を却下 (${comment.trim()})`, storeId: req!.storeId, changes: [{ field: "status", before: "pending", after: "rejected" }] });
  return { request: req!, approved: false, conflicts: [] };
}

/** 取消し (承認済みは予定表の「休暇」も消し、残日数を戻す) */
export function cancelLeave(db: Database, actor: User, id: string, reason: string, today: string): LeaveRequest {
  const req = db.leaveRequests.find((r) => r.id === id);
  if (!req) err("休暇の申請が見つかりません。");
  if (req!.status !== "pending" && req!.status !== "approved") err("この申請はすでに却下・取消しされています。");
  if (!canCancelLeave(actor, req!, today)) err(req!.status === "approved" ? "承認済みの休暇の取消しは、承認できる人 (店長・管理者) と、まだ始まっていない休暇の本人ができます。" : "申請者・本人・承認できる人が取り下げられます。");
  const before = req!.status;
  const now = nowIso();
  if (req!.eventId) {
    const ev = db.schedule.find((e) => e.id === req!.eventId);
    if (ev) {
      db.schedule = db.schedule.filter((e) => e.id !== ev.id);
      addAudit(db, { userId: actor.id, action: "delete", entity: "schedule", entityId: ev.id, entityLabel: ev.title, summary: `休暇の取消しで予定を削除 (${req!.number})`, storeId: ev.storeId, changes: [{ field: "date", before: ev.date, after: undefined }, { field: "kind", before: ev.kind, after: undefined }] });
    }
  }
  req!.status = "cancelled";
  req!.cancelledBy = actor.id;
  req!.cancelledAt = now;
  req!.cancelReason = reason.trim() || undefined;
  req!.updatedAt = now;
  addAudit(db, { userId: actor.id, action: "status", entity: "leave", entityId: req!.id, entityLabel: leaveLabel(db, req!), summary: `${LEAVE_TYPE[req!.leaveType].label}を取消し${before === "approved" ? " (予定表の休暇も削除)" : " (申請の取下げ)"}${reason.trim() ? ` (${reason.trim()})` : ""}`, storeId: req!.storeId, changes: [{ field: "status", before, after: "cancelled" }] });
  return req!;
}

/* ---------------- 休日出勤 ---------------- */

export function addHolidayWork(db: Database, actor: User, input: { userId: string; date: string; slot: LeaveSlot; note?: string }): { work: HolidayWork; warning?: string } {
  const target = userOf(db, input.userId);
  if (!target || !target.active) err("社員が見つかりません。");
  if (!canRegisterHolidayWork(actor, target!)) err("この社員の休日出勤を登録する権限がありません (店長は自店舗の社員、本部・管理者は全員)。");
  if (!isDateKey(input.date)) err("休日出勤の日付を正しく入力してください。");
  if (!LEAVE_SLOT[input.slot]) err("終日・午前・午後を選んでください。");
  const dup = db.holidayWorks.find((w) => w.userId === target!.id && w.kind === "work" && w.date === input.date && (w.slot === "day" || input.slot === "day" || w.slot === input.slot));
  if (dup) err(`${md(input.date)} の休日出勤はすでに登録されています。`);
  const now = nowIso();
  const work: HolidayWork = { id: newId("hw"), userId: target!.id, storeId: target!.storeId, kind: "work", date: input.date, slot: input.slot, days: input.slot === "day" ? 1 : 0.5, note: input.note?.trim() || undefined, createdBy: actor.id, createdAt: now };
  db.holidayWorks.push(work);
  addAudit(db, { userId: actor.id, action: "create", entity: "holiday_work", entityId: work.id, entityLabel: `${target!.name} 休日出勤 ${md(work.date)}${work.slot === "day" ? "" : ` ${LEAVE_SLOT[work.slot]}`}`, summary: `休日出勤を登録 (振休 ${fmtDays(work.days)} が発生)`, storeId: work.storeId });
  const bal = compBalance(db, target!.id);
  return { work, warning: bal.overLimit ? `${target!.name} さんの振休の未取得が ${fmtDays(bal.remaining)} になりました (社内規定の上限 ${fmtDays(bal.limit)})。早めに振休の日を決めてください。` : undefined };
}

export function removeHolidayWork(db: Database, actor: User, id: string): HolidayWork {
  const w = db.holidayWorks.find((x) => x.id === id);
  if (!w) err("休日出勤が見つかりません。");
  const target = userOf(db, w!.userId);
  if (!canRegisterHolidayWork(actor, target ?? { storeId: w!.storeId })) err("この休日出勤を削除する権限がありません。");
  if (w!.kind === "opening" && !canManageLeaveGrants(actor)) err("切り替え時点の振休の残は、本部・管理者が取込で直します。");
  if (compBreaksWithout(db, w!.userId, w!.id)) err("この休日出勤に充てた振休があり、消すと振休が足りなくなります。先に振休 (休暇の申請) を取り消してください。");
  db.holidayWorks = db.holidayWorks.filter((x) => x.id !== w!.id);
  addAudit(db, { userId: actor.id, action: "delete", entity: "holiday_work", entityId: w!.id, entityLabel: `${nameOf(db, w!.userId)} 休日出勤 ${md(w!.date)}`, summary: "休日出勤を削除", storeId: w!.storeId, changes: [{ field: "date", before: w!.date, after: undefined }, { field: "days", before: w!.days, after: undefined }] });
  return w!;
}

/* ---------------- 有給の付与 ---------------- */

const validDays = (d: number) => Number.isFinite(d) && d > 0 && d <= 40 && Number.isInteger(d * 2);

export function addGrant(db: Database, actor: User, input: { userId: string; grantDate: string; days: number; expiresOn?: string; note?: string }): LeaveGrant {
  if (!canManageLeaveGrants(actor)) err("有給の付与は本部スタッフ (事務)・管理者が登録します。");
  const target = userOf(db, input.userId);
  if (!target) err("社員が見つかりません。");
  if (!isDateKey(input.grantDate)) err("付与日を正しく入力してください。");
  if (!validDays(input.days)) err("付与日数は 0.5 日単位で 0.5〜40 日にしてください。");
  const expiresOn = input.expiresOn || grantExpiry(input.grantDate);
  if (!isDateKey(expiresOn) || expiresOn < input.grantDate) err("有効期限は付与日より後の日付にしてください。");
  if (db.leaveGrants.some((g) => g.userId === target!.id && g.kind === "grant" && g.grantDate === input.grantDate)) err(`${md(input.grantDate)} の付与はすでに登録されています (修正してください)。`);
  const now = nowIso();
  const g: LeaveGrant = { id: newId("lg"), userId: target!.id, kind: "grant", grantDate: input.grantDate, expiresOn, days: input.days, note: input.note?.trim() || undefined, createdBy: actor.id, createdAt: now };
  db.leaveGrants.push(g);
  addAudit(db, { userId: actor.id, action: "create", entity: "leave_grant", entityId: g.id, entityLabel: `${target!.name} 有給の付与 ${g.grantDate}`, summary: `有給を ${fmtDays(g.days)} 付与 (期限 ${g.expiresOn})`, storeId: target!.storeId });
  return g;
}

export function updateGrant(db: Database, actor: User, id: string, input: { days: number; expiresOn: string; note?: string }, today: string): LeaveGrant {
  if (!canManageLeaveGrants(actor)) err("有給の付与は本部スタッフ (事務)・管理者が修正します。");
  const g = db.leaveGrants.find((x) => x.id === id);
  if (!g) err("付与が見つかりません。");
  if (!validDays(input.days)) err("日数は 0.5 日単位で 0.5〜40 日にしてください。");
  if (!isDateKey(input.expiresOn) || input.expiresOn < g!.grantDate) err("有効期限は付与日より後の日付にしてください。");
  const next: LeaveGrant = { ...g!, days: input.days, expiresOn: input.expiresOn, note: input.note?.trim() || undefined, updatedBy: actor.id, updatedAt: nowIso() };
  if (paidBreaksWith(db, g!.userId, db.leaveGrants.map((x) => (x.id === id ? next : x)), today)) err("この変更をすると、承認済みの有給が足りなくなります (先に休暇を取り消すか、日数・期限を見直してください)。");
  const changes = diffChanges(g!, next, ["days", "expiresOn", "note"]);
  Object.assign(g!, next);
  if (changes.length) addAudit(db, { userId: actor.id, action: "update", entity: "leave_grant", entityId: g!.id, entityLabel: `${nameOf(db, g!.userId)} 有給の付与 ${g!.grantDate}`, summary: "有給の付与を修正", storeId: userOf(db, g!.userId)?.storeId, changes });
  return g!;
}

export function removeGrant(db: Database, actor: User, id: string, today: string): LeaveGrant {
  if (!canManageLeaveGrants(actor)) err("有給の付与は本部スタッフ (事務)・管理者が削除します。");
  const g = db.leaveGrants.find((x) => x.id === id);
  if (!g) err("付与が見つかりません。");
  const rest = db.leaveGrants.filter((x) => x.id !== id);
  if (paidBreaksWith(db, g!.userId, rest, today)) err("この付与を消すと、承認済みの有給が足りなくなります (先に休暇を取り消してください)。");
  db.leaveGrants = rest;
  addAudit(db, { userId: actor.id, action: "delete", entity: "leave_grant", entityId: g!.id, entityLabel: `${nameOf(db, g!.userId)} 有給の付与 ${g!.grantDate}`, summary: `有給の付与 (${fmtDays(g!.days)}) を削除`, storeId: userOf(db, g!.userId)?.storeId, changes: [{ field: "days", before: g!.days, after: undefined }, { field: "expiresOn", before: g!.expiresOn, after: undefined }] });
  return g!;
}

/* ---------------- 切り替え時点の残日数の取込 ---------------- */

export interface ImportResult {
  users: number;
  grants: number;
  works: number;
  /** 社員ごとの結果 (画面のメッセージ) */
  lines: string[];
}

/** 取り込む (同じ社員の前回の取込分は置き換える)。エラーのある行が 1 つでもあれば何もしない */
export function applyOpeningImport(db: Database, actor: User, rows: OpeningRow[]): ImportResult {
  if (!canManageLeaveGrants(actor)) err("切り替え時点の残日数の取込は本部スタッフ (事務)・管理者が行います。");
  const bad = rows.filter((r) => r.errors.length);
  if (bad.length) err(`取り込めない行があります: ${bad.slice(0, 3).map((r) => `${r.line} 行目 ${r.errors[0]}`).join(" / ")}${bad.length > 3 ? ` ほか ${bad.length - 3} 行` : ""}`);
  if (!rows.length) err("取り込む行がありません。");
  const now = nowIso();
  const res: ImportResult = { users: 0, grants: 0, works: 0, lines: [] };
  for (const row of rows) {
    const u = row.user!;
    const before = paidLedger(db, u.id, row.asOf).shortHalves;
    const oldGrants = db.leaveGrants.filter((g) => g.userId === u.id && g.kind === "opening");
    const parts = openingGrantParts(row);
    const fresh: LeaveGrant[] = parts.map((p) => ({ id: newId("lg"), userId: u.id, kind: "opening", grantDate: row.asOf, baseDate: p.baseDate, expiresOn: p.expiresOn, days: p.days, note: p.note, createdBy: actor.id, createdAt: now }));
    const nextGrants = [...db.leaveGrants.filter((g) => !oldGrants.includes(g)), ...fresh];
    if (paidLedger({ ...db, leaveGrants: nextGrants }, u.id, row.asOf).shortHalves > before) err(`${u.name} さん: この残日数にすると承認済みの有給が足りなくなります (時点より後の休暇を確かめてください)。`);
    db.leaveGrants = nextGrants;
    res.grants += fresh.length;
    let compNote = "";
    if (row.comp !== undefined) {
      const oldWorks = db.holidayWorks.filter((w) => w.userId === u.id && w.kind === "opening");
      const work: HolidayWork | undefined = row.comp > 0 ? { id: newId("hw"), userId: u.id, storeId: u.storeId, kind: "opening", date: row.asOf, slot: "day", days: row.comp, note: "切り替え時点の振休の残 (休日出勤管理表の未取得分)", createdBy: actor.id, createdAt: now } : undefined;
      const nextWorks = [...db.holidayWorks.filter((w) => !oldWorks.includes(w)), ...(work ? [work] : [])];
      const compBefore = compBalance(db, u.id).shortage;
      if (compBalance({ ...db, holidayWorks: nextWorks }, u.id).shortage > compBefore) err(`${u.name} さん: この振休の残にすると承認済みの振休が足りなくなります。`);
      db.holidayWorks = nextWorks;
      if (work) res.works += 1;
      compNote = ` / 振休 ${fmtDays(row.comp)}`;
    }
    // 基準日の設定がなければ、本年基準日を社員の基準日にする (次の付与の目安に使う)
    if (row.baseDate && !hrSettings(db).profiles[u.id]?.baseDate) writeProfile(db, actor, u.id, (p) => ({ ...p, baseDate: row.baseDate }), false);
    const total = fresh.reduce((s, g) => s + g.days, 0);
    res.users += 1;
    res.lines.push(`${u.name} 有給 ${fmtDays(total)}${compNote}`);
    addAudit(db, {
      userId: actor.id,
      action: "import",
      entity: "leave_grant",
      entityId: u.id,
      entityLabel: `${u.name} 切り替え時点の残日数 (${row.asOf})`,
      summary: `切り替え時点の残日数を取込: 当年度分 ${fmtDays(row.current)}・繰越分 ${fmtDays(row.carry)} (本年基準日 ${row.baseDate ?? "-"})${compNote}${oldGrants.length ? " (前回の取込を置き換え)" : ""}`,
      storeId: u.storeId,
      changes: [{ field: "days", before: oldGrants.reduce((s, g) => s + g.days, 0) || undefined, after: total }],
    });
  }
  return res;
}

/* ---------------- 設定 (社員の基準日・ルール) ---------------- */

function settingsRow(db: Database, actor: User): AppSetting {
  let row = db.settings.find((s) => s.id === HR_SETTINGS_ID);
  if (!row) {
    row = { id: HR_SETTINGS_ID, value: {}, updatedBy: actor.id, updatedAt: nowIso() };
    db.settings.push(row);
  }
  return row;
}

function writeProfile(db: Database, actor: User, userId: string, f: (p: LeaveProfile) => LeaveProfile, audit = true): void {
  const row = settingsRow(db, actor);
  const profiles = { ...((row.value.profiles as Record<string, LeaveProfile> | undefined) ?? {}) };
  const before = profiles[userId] ?? {};
  const after = Object.fromEntries(Object.entries(f(before)).filter(([, v]) => v !== undefined && v !== "")) as LeaveProfile;
  profiles[userId] = after;
  row.value = { ...row.value, profiles };
  row.updatedBy = actor.id;
  row.updatedAt = nowIso();
  const changes = diffChanges(before, after, ["hiredOn", "baseDate", "weeklyDays"]);
  if (audit && changes.length) addAudit(db, { userId: actor.id, action: "update", entity: "settings", entityId: HR_SETTINGS_ID, entityLabel: `${nameOf(db, userId)} の有給の基準日・雇い入れ日`, summary: "社員の有給の設定を変更", storeId: userOf(db, userId)?.storeId, changes });
}

export function saveProfile(db: Database, actor: User, userId: string, input: LeaveProfile): void {
  if (!canManageLeaveGrants(actor)) err("社員の基準日・雇い入れ日は本部スタッフ (事務)・管理者が設定します。");
  if (!userOf(db, userId)) err("社員が見つかりません。");
  if (input.hiredOn && !isDateKey(input.hiredOn)) err("雇い入れ日を正しく入力してください。");
  if (input.baseDate && !isDateKey(input.baseDate)) err("基準日を正しく入力してください。");
  if (input.weeklyDays !== undefined && !(input.weeklyDays >= 1 && input.weeklyDays <= 5)) err("週の所定労働日数は 1〜5 日にしてください (5 = 通常)。");
  writeProfile(db, actor, userId, () => ({ hiredOn: input.hiredOn || undefined, baseDate: input.baseDate || undefined, weeklyDays: input.weeklyDays === 5 ? undefined : input.weeklyDays }));
}

export type RuleInput = Omit<HrSettings, "profiles">;

export function saveRules(db: Database, actor: User, input: RuleInput): void {
  if (!canManageLeaveSettings(actor)) err("有給・振休のルールは管理者が変更します。");
  if (!(input.compLimit >= 0 && input.compLimit <= 60 && Number.isInteger(input.compLimit * 2))) err("振休のため込みの上限は 0〜60 日 (0.5 日単位) にしてください。");
  if (!(input.fiscalStartMonth >= 1 && input.fiscalStartMonth <= 12)) err("年度の始まりの月は 1〜12 にしてください。");
  if (!(input.closingDay >= 1 && input.closingDay <= 31)) err("締め日は 1〜31 にしてください (31 = 月末)。");
  for (const t of [input.amStart, input.amEnd, input.pmStart, input.pmEnd]) if (!/^\d{2}:\d{2}$/.test(t)) err("半日の時間帯は HH:MM で入力してください。");
  if (input.amStart >= input.amEnd || input.pmStart >= input.pmEnd) err("半日の時間帯は、終わりを始まりより後にしてください。");
  const before = hrSettings(db);
  const row = settingsRow(db, actor);
  row.value = { ...row.value, ...input };
  row.updatedBy = actor.id;
  row.updatedAt = nowIso();
  const changes = diffChanges(before as unknown as Record<string, unknown>, { ...before, ...input } as unknown as Record<string, unknown>, ["compLimit", "consumeOrder", "fiscalStartMonth", "closingDay", "amStart", "amEnd", "pmStart", "pmEnd"]);
  if (changes.length) addAudit(db, { userId: actor.id, action: "update", entity: "settings", entityId: HR_SETTINGS_ID, entityLabel: "有給・振休のルール", summary: "有給・振休のルールを変更", changes });
}
