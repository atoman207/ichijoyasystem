"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, diffChanges, getDb, mutate, newId, nowIso } from "@/lib/db/store";
import type { Database, ScheduleEvent, ScheduleKind, StoreId, User } from "@/lib/db/types";
import { SCHEDULE_KIND, SCHEDULE_KINDS, SCHEDULE_REPEAT, type ScheduleRepeat } from "@/lib/constants";
import { canAccessStore, canEditEvent, canManageCompanyEvents, canManageSettings } from "@/lib/auth/permissions";
import {
  addMonths,
  dateRange,
  findConflicts,
  isConflict,
  isDateKey,
  lastDay,
  normTime,
  occursOn,
  compareInDay,
  periodLabel,
  repeatDates,
  shortDate,
  timeLabel,
  toMinutes,
  type BusyInfo,
  type ConflictItem,
  type ConflictQuery,
  type ConflictReport,
  type RepeatRule,
  type Slot,
} from "@/lib/calendar";
import { addDays, daysBetween } from "@/lib/format";
import { createCaseResolver, orderEditable, type CaseRef } from "@/lib/db/schedule";
import { suggestScheduleDates, type SuggestResult, type SuggestSlot } from "@/lib/schedule-suggest";
import { readCapacitySettings, SCHEDULE_CAPACITY_ID, SUGGEST_KINDS, type CapacitySettings } from "@/lib/schedule-capacity";
import { basePlaceOfEvent } from "@/lib/maps/resolve";
import { mapTablesReady, propagateOrderSite, saveEventLocationMode } from "@/lib/maps/store";
import { changeImpacts, moveBookingsWithEvent } from "@/lib/scheduling/impact";
import { replanProductionForPickup } from "@/lib/scheduling/production";
import { prefetchForStore } from "@/lib/scheduling/prefetch";
import { planTablesReady } from "@/lib/scheduling/tables";
import { applyEventMove, parseHandoverRef } from "@/lib/handover";
import { pendingHandoverChange, savePlan } from "@/lib/handover-save";
import { notifyNewApprovals } from "@/lib/notify/approvals";
import { AUTO_APPROVAL_NOTE } from "@/lib/approval-decide";
import { fail, requireActionUser, resolveStoreId, str, withMsg } from "./guards";

/**
 * 予定表 (全社カレンダー) の業務ロジック
 * ------------------------------------------------------------
 * - 予定の登録・変更・削除。案件 (問い合わせ・見積・受注) に紐づけた予定は案件の店舗のカレンダーに載る
 * - 担当者の予定が重なる場合は、利用者が「重複を承知で登録する」を選ばない限り保存しない
 * - 受注の施工予定と連動する予定 (source = "order") を変更すると、受注の施工期間・担当・現場住所も更新する
 */

type EventFields = Omit<ScheduleEvent, "id" | "source" | "seriesId" | "createdBy" | "createdAt" | "updatedBy" | "updatedAt">;

interface ParsedEvent {
  fields: EventFields;
  /** 場所の指定: follow = 案件・お客様の場所に合わせる / custom = この予定だけの場所 (お客様の住所を変えても変わらない) */
  locationMode: "follow" | "custom";
  /** 繰り返しを展開した開始日 */
  dates: string[];
  repeat: ScheduleRepeat;
  allowOverlap: boolean;
  caseRef?: CaseRef;
}

const AUTO_START_KINDS: ScheduleKind[] = ["survey", "measure", "visit"];

const FIELD_LABEL: Record<string, string> = {
  title: "件名",
  kind: "種別",
  date: "日付",
  endDate: "終了日",
  startTime: "開始時刻",
  endTime: "終了時刻",
  slot: "午前・午後",
  storeId: "店舗",
  companyWide: "全社共通",
  assigneeIds: "担当者",
  customerId: "お客様",
  orderId: "案件",
  quoteId: "案件",
  inquiryId: "案件",
  location: "場所",
  memo: "メモ",
};

/** 自サイト内のパスだけを戻り先に使う */
function safePath(p: string): string | undefined {
  return p.startsWith("/") && !p.startsWith("//") && !p.includes("\\") ? p : undefined;
}

function names(db: Database, ids: string[]): string {
  return ids.map((id) => db.users.find((u) => u.id === id)?.name ?? "-").join("・") || "なし";
}

function parseEventForm(
  db: Database,
  user: User,
  fd: FormData,
  back: string,
  opts: { allowRepeat: boolean; current?: ScheduleEvent },
): ParsedEvent {
  const current = opts.current;
  // 受注の施工予定と連動する予定は、種別・店舗・案件を変えられない
  const fixed = current?.source === "order" ? current : undefined;
  const rawKind = str(fd, "kind");
  const kind: ScheduleKind = fixed ? fixed.kind : SCHEDULE_KINDS.includes(rawKind as ScheduleKind) ? (rawKind as ScheduleKind) : "other";

  const date = str(fd, "date");
  if (!isDateKey(date)) fail(back, "日付を正しく入力してください。");
  let endDate: string | undefined = str(fd, "endDate") || undefined;
  if (endDate && !isDateKey(endDate)) fail(back, "終了日を正しく入力してください。");
  if (endDate && endDate < date) fail(back, "終了日は開始日以降の日付にしてください。");
  if (endDate === date) endDate = undefined;
  if (endDate && dateRange(date, endDate, 40).length > 31) fail(back, "1 つの予定は 31 日以内にしてください。");

  const allDay = str(fd, "allDay") === "1";
  const rawStart = str(fd, "startTime");
  const startTime = allDay ? undefined : normTime(rawStart);
  if (!allDay && rawStart && !startTime) fail(back, "開始時刻を正しく入力してください。");
  const endTime = startTime ? normTime(str(fd, "endTime")) : undefined;
  if (startTime && endTime && toMinutes(endTime) <= toMinutes(startTime)) fail(back, "終了時刻は開始時刻より後にしてください。");
  const rawSlot = str(fd, "slot");
  const slot = !allDay && !startTime && (rawSlot === "am" || rawSlot === "pm") ? rawSlot : undefined;

  // 案件 (変更前と同じ案件はそのまま。新しく紐づける案件は自分が扱える店舗のもの)
  const resolver = createCaseResolver(db);
  const currentCase = current ? resolver.ofEvent(current) : undefined;
  let caseRef: CaseRef | undefined;
  if (fixed) {
    caseRef = currentCase;
  } else {
    const raw = str(fd, "caseRef");
    if (raw) {
      caseRef = resolver.fromValue(raw);
      if (!caseRef) fail(back, "紐づける案件が見つかりません。");
      const unchanged = currentCase && currentCase.type === caseRef.type && currentCase.id === caseRef.id;
      if (!unchanged && !canAccessStore(user, caseRef.storeId)) fail(back, "この案件の店舗の予定を登録する権限がありません。");
    }
  }

  // 店舗: 案件があれば案件の店舗。担当者として他店舗の予定を変更する場合は店舗を変えない
  let storeId: StoreId;
  if (fixed) storeId = fixed.storeId;
  else if (caseRef) storeId = caseRef.storeId;
  else if (current && !canAccessStore(user, current.storeId)) storeId = current.storeId;
  else storeId = resolveStoreId(user, str(fd, "storeId"), current?.storeId);
  if (storeId !== current?.storeId && !caseRef && !canAccessStore(user, storeId)) fail(back, "この店舗の予定を登録する権限がありません。");

  const companyWide = !caseRef && !fixed && str(fd, "companyWide") === "1";
  if (companyWide && !canManageCompanyEvents(user)) fail(back, "全社共通の予定は店長・本部スタッフ・管理者が登録できます。");

  const active = new Set(db.users.filter((u) => u.active).map((u) => u.id));
  const assigneeIds = [...new Set(fd.getAll("assigneeIds").map(String))].filter((id) => active.has(id));
  if (assigneeIds.length === 0 && !companyWide) fail(back, "担当者を 1 人以上選んでください (全社共通の予定は省略できます)。");

  let customerId = caseRef?.customerId ?? (fixed ? fixed.customerId : str(fd, "customerId") || undefined);
  if (!caseRef && !fixed && customerId && customerId !== current?.customerId) {
    const c = db.customers.find((x) => x.id === customerId);
    if (!c) customerId = undefined;
    else if (!canAccessStore(user, c.storeId)) fail(back, "このお客様の情報を扱う権限がありません。");
  }

  let title = str(fd, "title").slice(0, 120);
  if (!title) {
    if (caseRef) title = `${caseRef.customerName ? `${caseRef.customerName} 様 ` : ""}${SCHEDULE_KIND[kind].label}`;
    else fail(back, "件名を入力してください。");
  }

  const rawRepeat = str(fd, "repeat");
  const repeat: ScheduleRepeat = opts.allowRepeat && rawRepeat in SCHEDULE_REPEAT && Object.hasOwn(SCHEDULE_REPEAT, rawRepeat) ? (rawRepeat as ScheduleRepeat) : "none";
  const until = str(fd, "repeatUntil");
  if (repeat !== "none") {
    if (!isDateKey(until) || until <= date) fail(back, "繰り返しの終了日を、開始日より後の日付で入力してください。");
    if (until > addMonths(date, 12)) fail(back, "繰り返しは 1 年以内で設定してください。");
  }

  // 場所: 案件・お客様の場所に合わせる (follow) ときは、案件・お客様の住所を入れる (関係のない住所は選ばない)
  const base = basePlaceOfEvent(db, { orderId: caseRef?.orderId, quoteId: caseRef?.quoteId, inquiryId: caseRef?.inquiryId, customerId });
  const wantFollow = fixed ? true : str(fd, "locationMode") === "follow";
  const locationMode: "follow" | "custom" = wantFollow && base?.addressText ? "follow" : "custom";
  const location = fixed ? str(fd, "location").slice(0, 200) || undefined : locationMode === "follow" ? base!.addressText.slice(0, 200) : str(fd, "location").slice(0, 200) || undefined;

  return {
    fields: {
      title,
      kind,
      date,
      endDate,
      startTime,
      endTime,
      slot,
      storeId,
      companyWide: companyWide || undefined,
      assigneeIds,
      customerId,
      inquiryId: caseRef?.inquiryId,
      quoteId: caseRef?.quoteId,
      orderId: caseRef?.orderId,
      location,
      memo: str(fd, "memo").slice(0, 2000) || undefined,
    },
    locationMode,
    dates: repeatDates(date, repeat, until),
    repeat,
    allowOverlap: str(fd, "allowOverlap") === "1",
    caseRef,
  };
}

/** 開始日を d に移した予定 (複数日の長さは保つ) */
function shiftTo<T extends { date: string; endDate?: string }>(e: T, d: string): T {
  const span = e.endDate ? daysBetween(e.date, e.endDate) : 0;
  return { ...e, date: d, endDate: span > 0 ? addDays(d, span) : undefined };
}

function conflictsOf(db: Database, fields: EventFields, dates: string[], excludeId?: string) {
  const others = db.schedule.filter((e) => e.id !== excludeId);
  return dates.flatMap((d) => findConflicts(shiftTo(fields, d), others));
}

function describeConflicts(db: Database, hits: ReturnType<typeof conflictsOf>): string {
  const head = hits.slice(0, 3).map((h) => `${names(db, [h.userId])} さん ${shortDate(h.day)} ${timeLabel(h.event)}「${h.event.title}」`);
  return `${head.join("、")}${hits.length > 3 ? ` ほか ${hits.length - 3} 件` : ""}`;
}

function revalidateSchedule(e: Pick<ScheduleEvent, "orderId" | "quoteId" | "inquiryId" | "customerId">) {
  revalidatePath("/schedule");
  revalidatePath("/");
  if (e.orderId) revalidatePath(`/orders/${e.orderId}`);
  if (e.quoteId) revalidatePath(`/quotes/${e.quoteId}`);
  if (e.inquiryId) revalidatePath(`/inquiries/${e.inquiryId}`);
  if (e.customerId) revalidatePath(`/customers/${e.customerId}`);
}

/* ------------------------------------------------------------------ */

export async function createScheduleEvent(formData: FormData) {
  const user = await requireActionUser();
  const back = safePath(str(formData, "back")) ?? "/schedule/new";
  const returnTo = safePath(str(formData, "returnTo"));
  const db = getDb();
  const p = parseEventForm(db, user, formData, back, { allowRepeat: true });
  const hits = conflictsOf(db, p.fields, p.dates);
  if (hits.length > 0 && !p.allowOverlap) {
    fail(back, `担当者の予定が重複しています: ${describeConflicts(db, hits)}。日時・担当者を見直すか、「重複を承知で登録する」にチェックしてください。`);
  }
  let firstId = "";
  let autoStarted = false;
  await mutate((db) => {
    const now = nowIso();
    const seriesId = p.dates.length > 1 ? newId("ser") : undefined;
    for (const d of p.dates) {
      const id = newId("ev");
      if (!firstId) firstId = id;
      db.schedule.push({ id, ...shiftTo(p.fields, d), source: "manual", seriesId, createdBy: user.id, createdAt: now, updatedBy: user.id, updatedAt: now });
      // 場所の指定 (案件・お客様に合わせる / この予定だけの場所) を残す。地図の表がまだないときは省く (表示は場所の文字から判断)
      if (mapTablesReady() && (p.fields.customerId || p.caseRef)) saveEventLocationMode(db, user, db.schedule[db.schedule.length - 1], p.locationMode);
    }
    const kindLabel = SCHEDULE_KIND[p.fields.kind].label;
    if (p.fields.orderId) {
      const o = db.orders.find((x) => x.id === p.fields.orderId);
      if (o) {
        o.progressNotes.push({ id: newId("pn"), at: now, userId: user.id, kind: "note", body: `予定を登録: ${periodLabel(p.fields)} ${kindLabel} (担当: ${names(db, p.fields.assigneeIds)})` });
        o.updatedAt = now;
      }
    }
    // 問い合わせ段階の案件で現地調査・採寸・訪問を予定したら、未対応 → 対応中 にする
    if (p.fields.inquiryId && !p.fields.quoteId && AUTO_START_KINDS.includes(p.fields.kind)) {
      const inq = db.inquiries.find((x) => x.id === p.fields.inquiryId);
      if (inq && inq.status === "new") {
        inq.status = "in_progress";
        inq.updatedAt = now;
        autoStarted = true;
        addAudit(db, { userId: user.id, action: "status", entity: "inquiry", entityId: inq.id, entityLabel: inq.number, summary: `${kindLabel}の予定登録により「対応中」に変更`, storeId: inq.storeId, changes: [{ field: "status", before: "new", after: "in_progress" }] });
      }
    }
    addAudit(db, {
      userId: user.id,
      action: "create",
      entity: "schedule",
      entityId: firstId,
      entityLabel: p.fields.title,
      summary: `予定を登録 (${periodLabel(p.fields)} ${kindLabel}${p.dates.length > 1 ? ` / ${SCHEDULE_REPEAT[p.repeat]} ${p.dates.length} 回` : ""}${p.caseRef ? ` / 案件 ${p.caseRef.number}` : ""}${hits.length ? " / 重複を承知で登録" : ""})`,
      storeId: p.fields.storeId,
    });
  });
  revalidateSchedule(p.fields);
  const msg = [
    p.dates.length > 1 ? `予定を ${p.dates.length} 件 (${SCHEDULE_REPEAT[p.repeat]}) 登録しました。` : "予定を登録しました。",
    p.caseRef ? `案件 ${p.caseRef.number} と${p.fields.companyWide ? "全店舗" : "店舗"}のカレンダーに反映されています。` : "",
    autoStarted ? "問い合わせを「対応中」にしました。" : "",
    hits.length ? "担当者の予定と重複しているため、予定表で調整してください。" : "",
  ].join("");
  redirect(withMsg(returnTo ?? `/schedule/${firstId}`, msg));
}

/** 受注の施工予定と連動する予定の変更を、受注 (施工期間・担当・現場住所) へ反映 */
function applyToOrder(db: Database, ev: ScheduleEvent, user: User) {
  const o = db.orders.find((x) => x.id === ev.orderId);
  if (!o) return;
  const before = { start: o.scheduledStart, end: o.scheduledEnd, workers: [...o.workerIds], site: o.siteAddress };
  o.scheduledStart = ev.date;
  o.scheduledEnd = lastDay(ev);
  o.workerIds = [...ev.assigneeIds];
  if (ev.location) o.siteAddress = ev.location;
  const changed = before.start !== o.scheduledStart || before.end !== o.scheduledEnd || before.workers.join() !== o.workerIds.join() || before.site !== o.siteAddress;
  if (!changed) return;
  // 予定表から施工場所を変えたときは、案件の場所に合わせているほかの今後の予定 (納品・訪問など) も合わせる
  if (before.site !== o.siteAddress) propagateOrderSite(db, user, o, before.site);
  if (o.status === "confirmed") o.status = "scheduled";
  const now = nowIso();
  o.updatedAt = now;
  o.progressNotes.push({ id: newId("pn"), at: now, userId: user.id, kind: "production", body: `予定表から施工予定を変更: ${periodLabel(ev)} (担当: ${names(db, o.workerIds)})` });
  addAudit(db, {
    userId: user.id,
    action: "update",
    entity: "order",
    entityId: o.id,
    entityLabel: o.number,
    summary: `施工予定を更新 (予定表から ${ev.date}${lastDay(ev) !== ev.date ? `〜${lastDay(ev)}` : ""})`,
    storeId: o.storeId,
    changes: [
      { field: "scheduledStart", before: before.start, after: o.scheduledStart },
      { field: "scheduledEnd", before: before.end, after: o.scheduledEnd },
      { field: "workerIds", before: before.workers, after: o.workerIds },
    ],
  });
}

export async function updateScheduleEvent(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = safePath(str(formData, "back")) ?? `/schedule/${id}/edit`;
  const returnTo = safePath(str(formData, "returnTo"));
  const db = getDb();
  const current = db.schedule.find((e) => e.id === id);
  if (!current) fail("/schedule", "予定が見つかりません。");
  if (!canEditEvent(user, current)) fail(`/schedule/${id}`, "この予定を変更する権限がありません (登録者・担当者・店舗のメンバーが変更できます)。");
  const synced = current.source === "order";
  if (synced) {
    const o = db.orders.find((x) => x.id === current.orderId);
    if (!o || !orderEditable(o)) fail(`/schedule/${id}`, "施工完了・キャンセル済みの受注の施工予定は変更できません。");
  }
  const p = parseEventForm(db, user, formData, back, { allowRepeat: false, current });
  // 受注の引取・納品の日程と連動する予定: 日時の変更は受注の日程の変更の申請 (承認のあとに予定表へ反映)。担当・メモなどはそのまま保存
  const hvRef = synced ? parseHandoverRef(current.sourceRef) : undefined;
  if (hvRef) {
    if (hvRef.role !== "install") p.fields.endDate = undefined;
    const moved = p.fields.date !== current.date || (p.fields.endDate ?? "") !== (current.endDate ?? "") || (p.fields.startTime ?? "") !== (current.startTime ?? "") || (p.fields.endTime ?? "") !== (current.endTime ?? "") || (p.fields.slot ?? "") !== (current.slot ?? "");
    if (moved) {
      const o0 = db.orders.find((x) => x.id === current.orderId);
      if (o0 && pendingHandoverChange(db, o0.id)) fail(back, "この案件には承認待ちの引取・納品日の変更があります。承認・差戻しのあとに変更してください (急ぐときは受注の画面で申請を取り下げてから)。");
    }
  }
  const hits = conflictsOf(db, p.fields, [p.fields.date], id);
  if (hits.length > 0 && !p.allowOverlap) {
    fail(back, `担当者の予定が重複しています: ${describeConflicts(db, hits)}。日時・担当者を見直すか、「重複を承知で保存する」にチェックしてください。`);
  }
  let changed = 0;
  const followUps: string[] = [];
  let hvRequest: { approvalId?: string; auto: boolean; role?: string; applied: boolean } | undefined;
  const impacts = changeImpacts(db, { id, kind: p.fields.kind, date: p.fields.date, endDate: p.fields.endDate, storeId: p.fields.storeId, assigneeIds: p.fields.assigneeIds, orderId: p.fields.orderId, quoteId: p.fields.quoteId, inquiryId: p.fields.inquiryId }).filter((x) => !/予約 .* も .* に移します|保存すると製造の予定を作り直します/.test(x));
  await mutate((db) => {
    const ev = db.schedule.find((e) => e.id === id);
    if (!ev) return;
    const before = { ...ev, assigneeIds: [...ev.assigneeIds] };
    if (hvRef) {
      const when = { date: p.fields.date, endDate: p.fields.endDate, start: p.fields.startTime, end: p.fields.startTime ? p.fields.endTime : undefined, slot: p.fields.startTime ? undefined : p.fields.slot };
      const moved = when.date !== ev.date || (when.endDate ?? "") !== (ev.endDate ?? "") || (when.start ?? "") !== (ev.startTime ?? "") || (when.end ?? "") !== (ev.endTime ?? "") || (when.slot ?? "") !== (ev.slot ?? "");
      // 日時は受注の日程で決める (ここでは変えない)。種別・店舗・案件は連動のまま。担当・件名・メモ・場所はこの予定だけ
      Object.assign(p.fields, { date: ev.date, endDate: ev.endDate, startTime: ev.startTime, endTime: ev.endTime, slot: ev.slot });
      if (moved) {
        const o = db.orders.find((x) => x.id === ev.orderId);
        if (o) {
          const r = savePlan(db, user, o, applyEventMove(o.handovers, hvRef, when), { back, reason: `予定表で「${ev.title}」の日時を変更`, via: "schedule" });
          hvRequest = { approvalId: r.approval?.id, auto: r.auto, role: r.approval?.requiredRole, applied: r.applied };
          followUps.push(...r.followUps);
        }
      }
    }
    Object.assign(ev, p.fields);
    if (mapTablesReady() && !synced && (ev.customerId || ev.orderId || ev.quoteId || ev.inquiryId)) saveEventLocationMode(db, user, ev, p.locationMode);
    const now = nowIso();
    ev.updatedBy = user.id;
    ev.updatedAt = now;
    const changes = diffChanges(before, ev, ["title", "kind", "date", "endDate", "startTime", "endTime", "slot", "storeId", "companyWide", "assigneeIds", "customerId", "orderId", "inquiryId", "location", "memo"]);
    changed = changes.length;
    if (planTablesReady() && changes.some((c) => ["date", "endDate", "startTime", "endTime", "slot"].includes(c.field))) {
      if (moveBookingsWithEvent(db, ev)) followUps.push("車両・設備の予約も移しました。");
      if (ev.kind === "pickup") followUps.push(...replanProductionForPickup(db, user, ev));
    }
    if (synced && !hvRef) {
      applyToOrder(db, ev, user);
    } else if (hvRef) {
      // 担当・メモなどの変更だけ (日時は上の申請)
    } else if (ev.orderId && changes.some((c) => ["date", "endDate", "startTime", "endTime", "assigneeIds"].includes(c.field))) {
      const o = db.orders.find((x) => x.id === ev.orderId);
      if (o) {
        o.progressNotes.push({ id: newId("pn"), at: now, userId: user.id, kind: "change", body: `予定を変更: ${periodLabel(ev)} ${SCHEDULE_KIND[ev.kind].label} (担当: ${names(db, ev.assigneeIds)})` });
        o.updatedAt = now;
      }
    }
    const labels = [...new Set(changes.map((c) => FIELD_LABEL[c.field] ?? c.field))];
    addAudit(db, {
      userId: user.id,
      action: "update",
      entity: "schedule",
      entityId: id,
      entityLabel: ev.title,
      summary: `予定を変更 (${labels.join("・") || "変更なし"}${hits.length ? " / 重複を承知で保存" : ""})`,
      storeId: ev.storeId,
      changes,
    });
  });
  if (hvRequest?.approvalId && !hvRequest.auto) await notifyNewApprovals([hvRequest.approvalId], user.id);
  revalidateSchedule(current);
  revalidateSchedule(p.fields);
  if (hvRequest) {
    const hvMsg = hvRequest.approvalId
      ? hvRequest.auto
        ? `${AUTO_APPROVAL_NOTE}し、受注の引取・納品の日程と予定表を変更しました。`
        : `日時の変更を${hvRequest.role === "admin" ? "管理者" : "店長"}へ申請しました。承認されると予定表と受注の日程に反映されます (それまでは前の日時のままです)。`
      : hvRequest.applied
        ? "受注の引取・納品の日程に反映しました。"
        : "日時は変わりませんでした (受注の日程にこの予定の品目が見つかりません。受注の画面の「引取・納品の日程」で確かめてください)。";
    redirect(withMsg(returnTo ?? `/schedule/${id}`, `${hvMsg}${changed ? " 担当・メモなどの変更は保存しました。" : ""}${followUps.join("")}`));
  }
  const freed = changed && p.fields.date > current.date && SUGGEST_KINDS.includes(current.kind) ? ` 空いた ${shortDate(current.date)} に入れられる予定は 予定表 →「計画」で確かめられます。` : "";
  const msg = `${changed ? "予定を更新しました。" : "変更はありませんでした。"}${synced && changed ? "受注の施工予定にも反映しました。" : ""}${hits.length ? "担当者の予定と重複しているため、予定表で調整してください。" : ""}${followUps.join("")}${changed && impacts.length ? ` 注意: ${impacts.join(" / ")}。` : ""}${freed}`;
  redirect(withMsg(returnTo ?? `/schedule/${id}`, msg));
}

export async function deleteScheduleEvent(id: string, formData: FormData) {
  const user = await requireActionUser();
  const returnTo = safePath(str(formData, "returnTo"));
  const scope = str(formData, "scope") === "series" ? "series" : "one";
  const back = `/schedule/${id}`;
  const db = getDb();
  const e = db.schedule.find((x) => x.id === id);
  if (!e) fail("/schedule", "予定が見つかりません。");
  if (!canEditEvent(user, e)) fail(back, "この予定を削除する権限がありません (登録者・担当者・店舗のメンバーが削除できます)。");
  if (e.source === "order") {
    fail(
      back,
      parseHandoverRef(e.sourceRef)
        ? "受注の引取・納品の日程と連動している予定です。受注の画面の「引取・納品の日程」で品目の日程を変更・削除してください (登録済みの日程の変更は承認のあとに反映されます)。"
        : "受注の施工予定と連動している予定です。受注・施工画面で施工予定を変更してください。",
    );
  }
  let removed = 0;
  await mutate((db) => {
    const targets = scope === "series" && e.seriesId ? db.schedule.filter((x) => x.seriesId === e.seriesId && x.date >= e.date && canEditEvent(user, x)) : [e];
    const ids = new Set(targets.map((t) => t.id));
    db.schedule = db.schedule.filter((x) => !ids.has(x.id));
    removed = ids.size;
    const now = nowIso();
    if (e.orderId) {
      const o = db.orders.find((x) => x.id === e.orderId);
      if (o) {
        o.progressNotes.push({ id: newId("pn"), at: now, userId: user.id, kind: "change", body: `予定を削除: ${periodLabel(e)} ${SCHEDULE_KIND[e.kind].label}` });
        o.updatedAt = now;
      }
    }
    if (planTablesReady()) {
      // ひも付く車両の予約を外し、引き取りの製造の予定は取りやめにする
      db.resourceBookings = (db.resourceBookings ?? []).filter((b) => !b.eventId || !ids.has(b.eventId));
      for (const j of db.productionJobs ?? []) if (j.pickupEventId && ids.has(j.pickupEventId) && j.status === "planned") Object.assign(j, { status: "cancelled", updatedBy: user.id, updatedAt: now, note: [j.note, "引き取りの予定の削除により取りやめ"].filter(Boolean).join(" / ") });
    }
    addAudit(db, {
      userId: user.id,
      action: "delete",
      entity: "schedule",
      entityId: id,
      entityLabel: e.title,
      summary: `予定を削除 (${periodLabel(e)} ${SCHEDULE_KIND[e.kind].label}${removed > 1 ? ` / 以降の繰り返し ${removed - 1} 件を含む` : ""})`,
      storeId: e.storeId,
      // 空いた枠の提案 (src/lib/scheduling/replan.ts) に使う
      changes: [
        { field: "date", before: e.date, after: null },
        { field: "kind", before: e.kind, after: null },
        { field: "assigneeIds", before: e.assigneeIds, after: null },
      ],
    });
  });
  revalidateSchedule(e);
  const freed = SUGGEST_KINDS.includes(e.kind) && e.date >= new Date().toISOString().slice(0, 10) ? ` 空いた枠 (${shortDate(e.date)}) に入れられる予定・案件は 予定表 →「計画」の「空いた枠」で確かめられます。` : "";
  redirect(withMsg(returnTo ?? `/schedule?date=${e.date}`, `${removed > 1 ? `予定を ${removed} 件削除しました。` : "予定を削除しました。"}${freed}`));
}

/**
 * 入力中の予定と担当者の既存予定の重複を調べる (予定の入力フォームから呼ぶ)。
 * 予定表は全社共有なので、他店舗の予定も対象にする。
 */
export async function checkScheduleConflicts(q: ConflictQuery): Promise<ConflictReport> {
  await requireActionUser();
  const empty: ConflictReport = { conflicts: [], agenda: [], busy: {}, day: q?.date ?? "", occurrences: 0 };
  if (!q || !isDateKey(q.date)) return empty;
  const db = getDb();
  const users = new Map(db.users.filter((u) => u.active).map((u) => [u.id, u]));
  const stores = new Map(db.stores.map((s) => [s.id, s.shortName]));
  const assigneeIds = [...new Set(Array.isArray(q.assigneeIds) ? q.assigneeIds : [])].filter((id) => users.has(id)).slice(0, 100);
  const endDate = q.endDate && isDateKey(q.endDate) && q.endDate > q.date && daysBetween(q.date, q.endDate) <= 31 ? q.endDate : undefined;
  const startTime = normTime(q.startTime);
  const endTime = startTime ? normTime(q.endTime) : undefined;
  const slot = !startTime && (q.slot === "am" || q.slot === "pm") ? q.slot : undefined;
  const ref = createCaseResolver(db).fromValue(q.caseRef);
  const rule: RepeatRule = q.repeat && q.repeat in SCHEDULE_REPEAT && Object.hasOwn(SCHEDULE_REPEAT, q.repeat) ? q.repeat : "none";
  const until = rule !== "none" && isDateKey(q.repeatUntil) && q.repeatUntil <= addMonths(q.date, 12) ? q.repeatUntil : undefined;
  const dates = repeatDates(q.date, until ? rule : "none", until);
  const candidate: Slot = { date: q.date, endDate, startTime, endTime, slot, assigneeIds, inquiryId: ref?.inquiryId, quoteId: ref?.quoteId, orderId: ref?.orderId };
  const others = db.schedule.filter((e) => e.id !== q.eventId);

  const hits = dates.flatMap((d) => findConflicts(shiftTo(candidate, d), others));
  const conflicts: ConflictItem[] = hits.slice(0, 50).map((h) => ({
    userId: h.userId,
    userName: users.get(h.userId)?.name ?? "-",
    eventId: h.event.id,
    title: h.event.title,
    kindLabel: SCHEDULE_KIND[h.event.kind]?.label ?? "",
    day: h.day,
    when: `${shortDate(h.day)} ${timeLabel(h.event)}`,
    store: stores.get(h.event.storeId) ?? "",
  }));
  const conflictIds = new Set(hits.filter((h) => occursOn(h.event, q.date)).map((h) => `${h.userId}|${h.event.id}`));
  const agenda = assigneeIds.map((uid) => {
    const u = users.get(uid)!;
    return {
      userId: uid,
      userName: u.name,
      title: u.title,
      store: stores.get(u.storeId) ?? "",
      items: others
        .filter((e) => e.assigneeIds.includes(uid) && occursOn(e, q.date))
        .sort(compareInDay)
        .map((e) => ({ eventId: e.id, title: e.title, kindLabel: SCHEDULE_KIND[e.kind]?.label ?? "", time: timeLabel(e), store: stores.get(e.storeId) ?? "", conflict: conflictIds.has(`${uid}|${e.id}`) })),
    };
  });
  // 全社員の開始日の空き状況 (担当者を選ぶ前に、誰が空いているかを見られるように)
  const busy: Record<string, BusyInfo> = {};
  for (const id of users.keys()) busy[id] = { count: 0, overlap: false, leave: false };
  for (const e of others) {
    if (!occursOn(e, q.date)) continue;
    const clash = isConflict(candidate, e);
    for (const uid of new Set(e.assigneeIds)) {
      const b = busy[uid];
      if (!b) continue;
      b.count++;
      if (e.kind === "leave") b.leave = true;
      if (clash) b.overlap = true;
    }
  }
  const kind = q.kind && SCHEDULE_KINDS.includes(q.kind) ? q.kind : undefined;
  const impactStore = q.storeId && db.stores.some((s) => s.id === q.storeId) ? q.storeId : ref?.storeId;
  const impacts = kind && impactStore ? changeImpacts(db, { id: q.eventId, kind, date: q.date, endDate, storeId: impactStore, assigneeIds, orderId: ref?.orderId, quoteId: ref?.quoteId, inquiryId: ref?.inquiryId }) : [];
  return { conflicts, agenda, busy, day: q.date, occurrences: dates.length, impacts };
}

/* ---------------- AI 予定候補日の提案 ---------------- */

/** 予定の入力フォームからの候補日の問い合わせ (案件は "order:o_1" の形) */
export interface SuggestQuery {
  kind: ScheduleKind;
  storeId: StoreId;
  caseRef?: string;
  customerId?: string;
  location?: string;
  tatamiCount?: number;
  staffCount?: number;
  assigneeIds?: string[];
  slot?: SuggestSlot;
  from?: string;
  days?: number;
  durationDays?: number;
  eventId?: string;
  /** 予定の件名・メモ (保存前の入力。作業の内容の推定に使う) */
  title?: string;
  memo?: string;
}

/**
 * 候補日を提案する (データは変えない)。案件・お客様は閲覧できる範囲だけを手がかりにする (suggestScheduleDates の中で確かめる)。
 * 予定表は全社共有のため、担当者の予定は店舗をまたいで使う
 */
export async function suggestScheduleSlots(q: SuggestQuery): Promise<SuggestResult> {
  const user = await requireActionUser();
  const db = getDb();
  if (!q || !SUGGEST_KINDS.includes(q.kind)) return { candidates: [], notes: ["候補日の提案は、現地調査・顧客訪問・採寸・引き取り・納品・施工の予定で使えます。"] };
  const ref = createCaseResolver(db).fromValue(typeof q.caseRef === "string" ? q.caseRef : undefined);
  const storeId = ref?.storeId ?? (db.stores.some((s) => s.id === q.storeId) ? q.storeId : user.storeId);
  const int = (v: unknown, min: number, max: number) => (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? Math.round(v) : undefined);
  const assigneeIds = (Array.isArray(q.assigneeIds) ? q.assigneeIds : []).filter((id) => typeof id === "string" && db.users.some((u) => u.id === id && u.active)).slice(0, 6);
  const from = isDateKey(q.from) ? q.from : undefined;
  const days = int(q.days, 7, 62);
  // Google の経路を使う設定なら、使いそうな経路を先に取りに行く (失敗しても社内の目安で続く)
  await prefetchForStore(db, user, { storeId, address: typeof q.location === "string" ? q.location.slice(0, 200) : ref?.location, from, days: days ?? 21 }).catch(() => {});
  return suggestScheduleDates(db, user, {
    title: typeof q.title === "string" ? q.title.slice(0, 200) : undefined,
    memo: typeof q.memo === "string" ? q.memo.slice(0, 2000) : undefined,
    storeId,
    kind: q.kind,
    orderId: ref?.orderId,
    quoteId: ref?.quoteId,
    inquiryId: ref?.inquiryId,
    customerId: ref?.customerId ?? (typeof q.customerId === "string" && q.customerId ? q.customerId : undefined),
    address: typeof q.location === "string" ? q.location.slice(0, 200) : undefined,
    tatamiCount: int(q.tatamiCount, 0, 200),
    staffCount: assigneeIds.length ? undefined : int(q.staffCount, 1, 4),
    assigneeIds,
    slot: q.slot === "am" || q.slot === "pm" || q.slot === "day" ? q.slot : undefined,
    from,
    to: from && days ? addDays(from, days - 1) : undefined,
    durationDays: int(q.durationDays, 1, 10),
    eventId: typeof q.eventId === "string" ? q.eventId : undefined,
  });
}

/** 候補日の提案の設定 (店舗の 1 日の上限など)。空欄は「過去 1 年の実績から自動」に戻す。管理者のみ */
export async function updateScheduleCapacity(formData: FormData) {
  const back = "/schedule/capacity";
  const user = await requireActionUser();
  if (!canManageSettings(user)) fail(back, "候補日の提案の設定は管理者のみ変更できます。");
  const db0 = getDb();
  const num = (key: string, label: string, min: number, max: number): number | undefined => {
    const raw = str(formData, key);
    if (!raw) return undefined;
    const n = Number(raw.normalize("NFKC"));
    if (!Number.isFinite(n) || n < min || n > max) fail(back, `「${label}」は ${min}〜${max} の数で入力してください (空欄は自動)。`);
    return Math.round(n);
  };
  const time = (key: string) => {
    const raw = str(formData, key);
    if (!raw) return undefined;
    const t = normTime(raw);
    if (!t) fail(back, "作業の時間帯は 08:30 の形で入力してください。");
    return t;
  };
  const stores: CapacitySettings["stores"] = {};
  for (const s of db0.stores) {
    const v = {
      jobsPerDay: num(`${s.id}.jobsPerDay`, `${s.shortName}の現場作業の件数`, 1, 99),
      visitsPerDay: num(`${s.id}.visitsPerDay`, `${s.shortName}の営業の訪問の件数`, 1, 99),
      tatamiPerDay: num(`${s.id}.tatamiPerDay`, `${s.shortName}の畳の製造の枚数`, 1, 999),
    };
    if (v.jobsPerDay || v.visitsPerDay || v.tatamiPerDay) stores[s.id] = v;
  }
  const workStart = time("workStart");
  const workEnd = time("workEnd");
  if (workStart && workEnd && toMinutes(workEnd) - toMinutes(workStart) < 180) fail(back, "作業の時間帯は 3 時間以上にしてください。");
  const next: CapacitySettings = {
    stores,
    staffEventsPerDay: num("staffEventsPerDay", "1 人の 1 日の件数", 1, 20),
    workStart,
    workEnd,
    travelSpeedKmh: num("travelSpeedKmh", "移動の速さ", 10, 80),
    leadDays: num("leadDays", "何日後から提案するか", 0, 30),
    horizonDays: num("horizonDays", "探す日数", 7, 62),
  };
  const value = JSON.parse(JSON.stringify(next)) as Record<string, unknown>;
  await mutate((db) => {
    const now = nowIso();
    const before = readCapacitySettings(db);
    const row = db.settings.find((s) => s.id === SCHEDULE_CAPACITY_ID);
    if (row) Object.assign(row, { value, updatedBy: user.id, updatedAt: now });
    else db.settings.push({ id: SCHEDULE_CAPACITY_ID, value, updatedBy: user.id, updatedAt: now });
    const flatten = (c: CapacitySettings): Record<string, unknown> => {
      const out: Record<string, unknown> = { staffEventsPerDay: c.staffEventsPerDay, workStart: c.workStart, workEnd: c.workEnd, travelSpeedKmh: c.travelSpeedKmh, leadDays: c.leadDays, horizonDays: c.horizonDays };
      for (const s of db.stores) for (const k of ["jobsPerDay", "visitsPerDay", "tatamiPerDay"] as const) out[`${s.shortName}.${k}`] = c.stores[s.id]?.[k];
      return out;
    };
    const b = flatten(before);
    const a = flatten(next);
    const changes = Object.keys(a)
      .filter((k) => (b[k] ?? null) !== (a[k] ?? null))
      .map((field) => ({ field, before: b[field] ?? "自動", after: a[field] ?? "自動" }));
    addAudit(db, {
      userId: user.id,
      action: "update",
      entity: "settings",
      entityId: SCHEDULE_CAPACITY_ID,
      entityLabel: "候補日の提案の設定",
      summary: changes.length ? `候補日の提案の設定を変更 (${changes.length} 項目)` : "候補日の提案の設定を保存 (変更なし)",
      changes,
    });
  });
  revalidatePath("/schedule/capacity");
  redirect(withMsg(back, "候補日の提案の設定を保存しました。次の提案から使われます。"));
}
