"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, diffChanges, getDb, mutate, newId, nowIso } from "@/lib/db/store";
import type { Database, ScheduleEvent, ScheduleKind, StoreId, User } from "@/lib/db/types";
import { SCHEDULE_KIND, SCHEDULE_KINDS, SCHEDULE_REPEAT, type ScheduleRepeat } from "@/lib/constants";
import { canAccessStore, canEditEvent, canManageCompanyEvents } from "@/lib/auth/permissions";
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
      location: str(fd, "location").slice(0, 200) || undefined,
      memo: str(fd, "memo").slice(0, 2000) || undefined,
    },
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
  const hits = conflictsOf(db, p.fields, [p.fields.date], id);
  if (hits.length > 0 && !p.allowOverlap) {
    fail(back, `担当者の予定が重複しています: ${describeConflicts(db, hits)}。日時・担当者を見直すか、「重複を承知で保存する」にチェックしてください。`);
  }
  let changed = 0;
  await mutate((db) => {
    const ev = db.schedule.find((e) => e.id === id);
    if (!ev) return;
    const before = { ...ev, assigneeIds: [...ev.assigneeIds] };
    Object.assign(ev, p.fields);
    const now = nowIso();
    ev.updatedBy = user.id;
    ev.updatedAt = now;
    const changes = diffChanges(before, ev, ["title", "kind", "date", "endDate", "startTime", "endTime", "slot", "storeId", "companyWide", "assigneeIds", "customerId", "orderId", "inquiryId", "location", "memo"]);
    changed = changes.length;
    if (synced) {
      applyToOrder(db, ev, user);
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
  revalidateSchedule(current);
  revalidateSchedule(p.fields);
  const msg = `${changed ? "予定を更新しました。" : "変更はありませんでした。"}${synced && changed ? "受注の施工予定にも反映しました。" : ""}${hits.length ? "担当者の予定と重複しているため、予定表で調整してください。" : ""}`;
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
  if (e.source === "order") fail(back, "受注の施工予定と連動している予定です。受注・施工画面で施工予定を変更してください。");
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
    addAudit(db, {
      userId: user.id,
      action: "delete",
      entity: "schedule",
      entityId: id,
      entityLabel: e.title,
      summary: `予定を削除 (${periodLabel(e)} ${SCHEDULE_KIND[e.kind].label}${removed > 1 ? ` / 以降の繰り返し ${removed - 1} 件を含む` : ""})`,
      storeId: e.storeId,
    });
  });
  revalidateSchedule(e);
  redirect(withMsg(returnTo ?? `/schedule?date=${e.date}`, removed > 1 ? `予定を ${removed} 件削除しました。` : "予定を削除しました。"));
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
  return { conflicts, agenda, busy, day: q.date, occurrences: dates.length };
}
