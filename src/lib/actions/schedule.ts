"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, diffChanges, getDb, mutate, newId, nowIso } from "@/lib/db/store";
import type { Approval, ChangeNoticeLine, Database, ScheduleEvent, ScheduleKind, StoreId, User } from "@/lib/db/types";
import { parseDuplicateChoice, sameCaseSameDay, type DuplicateCandidate } from "@/lib/case-duplicates";
import type { CaseDuplicateItem } from "@/lib/calendar";
import { QUICK_MAX_ASSIGNEES, SCHEDULE_KIND, SCHEDULE_KINDS, SCHEDULE_REPEAT, type ScheduleRepeat } from "@/lib/constants";
import { approverRole, canAccessStore, canEditCaseStore, canEditEvent, canManageCompanyEvents, canManageSettings } from "@/lib/auth/permissions";
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
import { caseValue, createCaseResolver, orderEditable, type CaseRef } from "@/lib/db/schedule";
import { suggestScheduleDates, type SuggestResult, type SuggestSlot } from "@/lib/schedule-suggest";
import { readCapacitySettings, SCHEDULE_CAPACITY_ID, SUGGEST_KINDS, type CapacitySettings } from "@/lib/schedule-capacity";
import { basePlaceOfEvent } from "@/lib/maps/resolve";
import { currentEventMode, mapTablesReady, propagateOrderSite, saveEventLocationMode } from "@/lib/maps/store";
import { changeImpacts, moveBookingsWithEvent } from "@/lib/scheduling/impact";
import { replanProductionForPickup } from "@/lib/scheduling/production";
import { prefetchForStore } from "@/lib/scheduling/prefetch";
import { planTablesReady } from "@/lib/scheduling/tables";
import { applyEventMove, applyEventRemoval, parseHandoverRef } from "@/lib/handover";
import { pendingHandoverChange, savePlan } from "@/lib/handover-save";
import { notifyNewApprovals } from "@/lib/notify/approvals";
import { AUTO_APPROVAL_NOTE, settleOwnApproval } from "@/lib/approval-decide";
import { caseChainOf, pendingStoreChange, storeChangeBlocker, type CaseChain } from "@/lib/case-store";
import { closeScheduleRequests } from "@/lib/inquiry-requests";
import { taskNotices } from "@/lib/notify/events";
import { PAIR_PREFIX, eventPair } from "@/lib/schedule-pair";
import { isCountsOnlyText, stripKindWords } from "@/lib/work-summary";
import { sendAndRecord } from "@/lib/notify/send";
import { addChangeNotice, eventTarget } from "@/lib/change-notices";
import { fail, requireActionUser, resolveStoreId, str, withMsg } from "./guards";
import { scheduleCheckLink } from "@/lib/msg-link";

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

const AUTO_START_KINDS: ScheduleKind[] = ["survey", "site_survey", "onsite_quote", "measure", "visit"];

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
  // 担当者なし (「なし」= 未定) も登録できる (お客様のご要望 2026-11-27「■2」。予定表では「担当未定」の行に出る)

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
      // 作業内容 (予定表に表示。数量「タ6 タ新4」か自由な文「養生、廃材撤去」)。欄のある画面だけ変える (ない画面の保存では今の値のまま)
      ...(fd.has("work") ? { work: normWork(str(fd, "work")) || undefined } : {}),
      // 点検の電話をした人 (欄のある画面だけ変える。有効な社員だけ)
      ...(fd.has("inspectionBy") ? { inspectionBy: getDb().users.some((u) => u.id === str(fd, "inspectionBy") && u.active) ? str(fd, "inspectionBy") : undefined } : {}),
    },
    locationMode,
    dates: repeatDates(date, repeat, until),
    repeat,
    allowOverlap: str(fd, "allowOverlap") === "1",
    caseRef,
  };
}

/** 作業内容の文 (空白をそろえて 200 文字まで) */
const normWork = (v: string) => v.replace(/\s+/g, " ").trim().slice(0, 200);

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
  // 同じ案件・同じ日の予定の二重登録を防ぐ (お客様のご連絡 2026-11-26。src/lib/case-duplicates.ts):
  // 既存の予定があれば「既存の予定をこの内容に直す」(replace) か「別の予定として追加する」(add) を選ぶまで登録しない
  const dupCand = { date: p.fields.date, kind: p.fields.kind, inquiryId: p.fields.inquiryId, quoteId: p.fields.quoteId, orderId: p.fields.orderId, customerId: p.fields.customerId };
  const dups = p.dates.length === 1 ? sameCaseSameDay(db, dupCand) : [];
  const dupChoice = parseDuplicateChoice(str(formData, "caseDuplicate"));
  if (dups.length && !dupChoice) {
    fail(back, `同じ案件の同じ日に予定がすでにあります (${dups.map((e) => `${SCHEDULE_KIND[e.kind].label} ${periodLabel(e)}`).join("・")})。二重に登録しないよう、「既存の予定をこの内容に直す」か「別の予定として追加する」を選んでください。`);
  }
  const replaceId = dupChoice?.mode === "replace" ? dupChoice.id : undefined;
  if (replaceId) {
    const target = dups.find((e) => e.id === replaceId);
    if (!target) fail(back, "直す予定が見つかりません (すでに変わっています)。画面を読み込み直してください。");
    if (target.source === "order") fail(back, "受注の日程と連動する予定は、受注の画面の「引取・納品の日程」で直してください。");
  }
  let replaced: ScheduleEvent | undefined;
  let firstId = "";
  let autoStarted = false;
  let closedRequests: string[] = [];
  let holdCleared = false;
  await mutate((db) => {
    const now = nowIso();
    // 「既存の予定をこの内容に直す」: 既存の予定を外して、この内容の予定にする (担当者・時間・メモは入れた内容)
    if (replaceId) {
      const old = db.schedule.find((e) => e.id === replaceId);
      if (old && old.source !== "order") {
        replaced = { ...old };
        db.schedule = db.schedule.filter((e) => e.id !== replaceId);
        addAudit(db, { userId: user.id, action: "delete", entity: "schedule", entityId: old.id, entityLabel: old.title, summary: `同じ案件・同じ日の予定を、新しく入れた内容に置き換えました (${periodLabel(old)} ${SCHEDULE_KIND[old.kind].label} → 二重に登録しないため)`, storeId: old.storeId });
      }
    }
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
    // 問い合わせ (案件) の日程が決まった: 日程未定を外し、日程の打ち合わせの依頼を完了にする (お客様のご要望 2026-11-24「業務フロー ②⑤」)
    if (p.fields.inquiryId && SCHEDULE_KIND[p.fields.kind].group === "case") {
      const inq = db.inquiries.find((x) => x.id === p.fields.inquiryId);
      if (inq?.scheduleHold) {
        addAudit(db, { userId: user.id, action: "update", entity: "inquiry", entityId: inq.id, entityLabel: inq.number, summary: `${kindLabel}の予定の登録により日程未定を外しました`, storeId: inq.storeId, changes: [{ field: "scheduleHold", before: inq.scheduleHold, after: null }] });
        inq.scheduleHold = undefined;
        inq.updatedAt = now;
        holdCleared = true;
      }
      closedRequests = closeScheduleRequests(db, p.fields.inquiryId, user.id, `日程を登録: ${periodLabel(p.fields)} ${kindLabel}`).map((t) => t.id);
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
    // 案件・お客様の予定の追加は担当店舗・本部・管理者に知らせる (お客様のご要望 2026-11-25「⑥」)
    const first = db.schedule.find((x) => x.id === firstId);
    if (first) addChangeNotice(db, user.id, eventTarget(db, first), "予定の追加", [{ label: `${kindLabel}の予定`, before: "(なし)", after: `${periodLabel(first)}${p.dates.length > 1 ? ` ほか ${p.dates.length - 1} 回` : ""} (担当: ${names(db, first.assigneeIds)})` }]);
  });
  revalidateSchedule(p.fields);
  if (closedRequests.length) {
    const db1 = getDb();
    const out = closedRequests.flatMap((tid) => {
      const t = db1.threads.find((x) => x.id === tid);
      return t ? taskNotices(db1, t, user.id, "report", `日程を登録しました: ${periodLabel(p.fields)} ${SCHEDULE_KIND[p.fields.kind].label}`) : [];
    });
    await sendAndRecord(out, user.id).catch((err) => console.warn("[schedule] request notice failed:", (err as Error).message));
    revalidatePath("/messages");
  }
  const msg = [
    p.dates.length > 1 ? `予定を ${p.dates.length} 件 (${SCHEDULE_REPEAT[p.repeat]}) 登録しました。` : replaced ? `${periodLabel(replaced)} の${SCHEDULE_KIND[replaced.kind].label}の予定を、この内容に直しました (二重には登録していません)。` : "予定を登録しました。",
    closedRequests.length ? "日程の打ち合わせの依頼を完了にしました (依頼した人に知らせました)。" : "",
    holdCleared ? "日程未定を外しました。" : "",
    p.caseRef ? `案件 ${p.caseRef.number} と${p.fields.companyWide ? "全店舗" : "店舗"}のカレンダーに反映されています。` : "",
    autoStarted ? "問い合わせを「対応中」にしました。" : "",
    hits.length ? "担当者の予定と重複しているため、予定表で調整してください。" : "",
  ].join("");
  // 登録した日程を含む週の予定表 (施工店舗だけ・引き取りの日を基準。お客様のご要望 2026-11-26「■8」)
  redirect(withMsg(returnTo ?? `/schedule/${firstId}`, msg, scheduleCheckLink([{ date: p.fields.date, pickup: p.fields.kind === "pickup" }], p.fields.companyWide ? undefined : p.fields.storeId)));
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

/** 予定の変更のお知らせの行 (日時はまとめて 1 行。担当者は名前、種類・店舗は名前) */
function eventNoticeLines(db: Database, before: ScheduleEvent, after: ScheduleEvent, changes: { field: string; before: unknown; after: unknown }[], prefix = ""): ChangeNoticeLine[] {
  const out: ChangeNoticeLine[] = [];
  const what = `${prefix}${SCHEDULE_KIND[after.kind].label}`;
  if (changes.some((c) => ["date", "endDate", "startTime", "endTime", "slot"].includes(c.field))) out.push({ label: `${what}の日時`, before: periodLabel(before), after: periodLabel(after) });
  const storeName = (sid: unknown) => db.stores.find((x) => x.id === sid)?.name ?? String(sid ?? "");
  for (const c of changes) {
    if (c.field === "assigneeIds") out.push({ label: `${what}の担当`, before: names(db, (c.before as string[]) ?? []), after: names(db, (c.after as string[]) ?? []) });
    else if (c.field === "kind") out.push({ label: `${prefix}予定の種類`, before: SCHEDULE_KIND[c.before as ScheduleKind]?.label ?? String(c.before ?? ""), after: SCHEDULE_KIND[c.after as ScheduleKind]?.label ?? String(c.after ?? "") });
    else if (c.field === "title") out.push({ label: `${what}の件名`, before: String(c.before ?? ""), after: String(c.after ?? "") });
    else if (c.field === "memo") out.push({ label: `${what}のメモ`, before: String(c.before ?? "").slice(0, 120) || "(なし)", after: String(c.after ?? "").slice(0, 120) || "(なし)" });
    else if (c.field === "location") out.push({ label: `${what}の場所`, before: String(c.before ?? "") || "(案件・お客様の場所)", after: String(c.after ?? "") || "(案件・お客様の場所)" });
    else if (c.field === "storeId") out.push({ label: `${what}の店舗`, before: storeName(c.before), after: storeName(c.after) });
  }
  return out;
}

type HvRef = NonNullable<ReturnType<typeof parseHandoverRef>>;

function pairMsg(pair: PairMove, applied: boolean, approvalId?: string): string {
  const what = `関連する${SCHEDULE_KIND[pair.ev.kind].label}の予定`;
  const when = periodLabel({ date: pair.when.date, startTime: pair.when.start, endTime: pair.when.end, slot: pair.when.slot });
  if (approvalId) return ` ${what}の変更 (${when}) は店長へ申請しました。`;
  return applied ? ` ${what}も ${when} に変更しました。` : ` ${what}は変わりませんでした。`;
}

/** 引取 ⇄ 納品 の関連する予定もあわせて動かす (お客様のご要望 2026-11-25「② 引取・納品予定の変更」) */
interface PairMove {
  ev: ScheduleEvent;
  hv?: HvRef;
  when: { date: string; start?: string; end?: string; slot?: "am" | "pm" };
  assigneeIds?: string[];
}

/** フォームの関連する予定の日時 (pairId・pairDate・pairTimeMode・pairStartTime・pairEndTime・pairAssigneeIds)。なければ undefined */
function parsePairMove(db: Database, user: User, current: ScheduleEvent, fd: FormData, back: string): PairMove | undefined {
  const pid = str(fd, "pairId");
  if (!pid) return undefined;
  const ev = eventPair(db, current)?.events.find((x) => x.id === pid);
  if (!ev) fail(back, "関連する予定が見つかりません (ほかの人が変更・削除した可能性があります)。画面を読み込み直してください。");
  if (!canEditEvent(user, ev)) fail(back, `関連する予定「${ev.title}」を変更する権限がありません。`);
  const hv = ev.source === "order" ? parseHandoverRef(ev.sourceRef) : undefined;
  if (ev.source === "order" && !hv) fail(back, "関連する予定は受注の施工予定と連動しています。受注の画面の「施工予定・担当」で変更してください。");
  if (hv) {
    const o = db.orders.find((x) => x.id === ev.orderId);
    if (!o || !orderEditable(o)) fail(back, "施工完了・キャンセル済みの受注の予定は変更できません。");
  }
  const date = str(fd, "pairDate");
  if (!isDateKey(date)) fail(back, "関連する予定 (納品・引取) の日付を入れてください。");
  const mode = str(fd, "pairTimeMode");
  const start = mode === "time" ? normTime(str(fd, "pairStartTime")) : undefined;
  if (mode === "time" && !start) fail(back, "関連する予定の時刻を正しく入れてください。");
  const end = start ? normTime(str(fd, "pairEndTime")) : undefined;
  if (start && end && toMinutes(end) <= toMinutes(start)) fail(back, "関連する予定の終了時刻は開始時刻より後にしてください。");
  const slot: "am" | "pm" | undefined = !start && (mode === "am" || mode === "pm") ? mode : undefined;
  let assigneeIds: string[] | undefined;
  if (str(fd, "pairAssigneesSent") === "1") {
    const active = new Set(db.users.filter((u) => u.active).map((u) => u.id));
    assigneeIds = [...new Set(fd.getAll("pairAssigneeIds").map(String))].filter((a) => active.has(a)).slice(0, QUICK_MAX_ASSIGNEES);
  }
  return { ev, hv, when: { date, start, end, slot }, assigneeIds };
}

/** 受注の日程から作り直した予定の担当者を、選んだ人にする (引取・納品の行の役割と行 ID で探す) */
function setHandoverAssignees(db: Database, user: User, orderId: string, ref: HvRef, assigneeIds: string[]) {
  for (const ev of db.schedule) {
    const r = parseHandoverRef(ev.sourceRef);
    if (ev.orderId !== orderId || r?.role !== ref.role || !r.rowIds.some((x) => ref.rowIds.includes(x))) continue;
    const before = [...ev.assigneeIds];
    if (before.join() === assigneeIds.join()) continue;
    ev.assigneeIds = [...assigneeIds];
    ev.updatedBy = user.id;
    ev.updatedAt = nowIso();
    addAudit(db, { userId: user.id, action: "update", entity: "schedule", entityId: ev.id, entityLabel: ev.title, summary: "関連する予定 (引取・納品) とあわせて担当者を変更", storeId: ev.storeId, changes: [{ field: "assigneeIds", before, after: ev.assigneeIds }] });
  }
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
  // 関連する予定 (引取 ⇄ 納品) もあわせて動かす (予定表の小さな画面の「関連する納品予定も変更しますか？」)
  const pair = parsePairMove(db, user, current, formData, back);
  if (pair?.hv) {
    const po = db.orders.find((x) => x.id === pair.ev.orderId);
    if (po && pendingHandoverChange(db, po.id)) fail(back, "関連する予定の案件に承認待ちの引取・納品日の変更があります。承認・差戻しのあとに変更してください。");
  }
  // 受注の引取・納品の日程と連動する予定: 日時の変更は受注の日程の変更 (既定は承認なしで反映。設定で承認を必要にしたときは申請)。担当・メモなどはそのまま保存
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
  const pairHits = pair
    ? findConflicts({ id: pair.ev.id, date: pair.when.date, startTime: pair.when.start, endTime: pair.when.end, slot: pair.when.slot, assigneeIds: pair.assigneeIds ?? pair.ev.assigneeIds, orderId: pair.ev.orderId, quoteId: pair.ev.quoteId, inquiryId: pair.ev.inquiryId }, db.schedule.filter((x) => x.id !== id))
    : [];
  if (pairHits.length && !p.allowOverlap) fail(back, `関連する予定 (${SCHEDULE_KIND[pair!.ev.kind].label}) の担当者の予定が重複しています: ${describeConflicts(db, pairHits)}。日時・担当者を見直すか、「重複を承知で保存する」にチェックしてください。`);
  let changed = 0;
  const followUps: string[] = [];
  let pairDone = false;
  let pairApplied = false;
  let pairApproval: string | undefined;
  let pairLines: ChangeNoticeLine[] = [];
  let hvRequest: { approvalId?: string; auto: boolean; role?: string; applied: boolean } | undefined;
  const impacts = changeImpacts(db, { id, kind: p.fields.kind, date: p.fields.date, endDate: p.fields.endDate, storeId: p.fields.storeId, assigneeIds: p.fields.assigneeIds, orderId: p.fields.orderId, quoteId: p.fields.quoteId, inquiryId: p.fields.inquiryId }).filter((x) => !/予約 .* も .* に移します|保存すると製造の予定を作り直します/.test(x));
  await mutate((db) => {
    const found = db.schedule.find((e) => e.id === id);
    if (!found) return;
    let ev: ScheduleEvent = found;
    const before = { ...ev, assigneeIds: [...ev.assigneeIds] };
    if (hvRef) {
      const when = { date: p.fields.date, endDate: p.fields.endDate, start: p.fields.startTime, end: p.fields.startTime ? p.fields.endTime : undefined, slot: p.fields.startTime ? undefined : p.fields.slot };
      const moved = when.date !== ev.date || (when.endDate ?? "") !== (ev.endDate ?? "") || (when.start ?? "") !== (ev.startTime ?? "") || (when.end ?? "") !== (ev.endTime ?? "") || (when.slot ?? "") !== (ev.slot ?? "");
      // 日時は受注の日程で決める (ここでは変えない)。種別・店舗・案件は連動のまま。担当・件名・メモ・場所はこの予定だけ
      Object.assign(p.fields, { date: ev.date, endDate: ev.endDate, startTime: ev.startTime, endTime: ev.endTime, slot: ev.slot });
      if (moved) {
        const o = db.orders.find((x) => x.id === ev.orderId);
        if (o) {
          let rows = applyEventMove(o.handovers, hvRef, when);
          // 関連する予定が同じ受注の引取・納品の日程なら、1 回の保存でまとめて動かす
          const same = Boolean(pair?.hv && pair.ev.orderId === o.id);
          if (same) rows = applyEventMove(rows, pair!.hv!, pair!.when);
          const r = savePlan(db, user, o, rows, { back, reason: `予定表で「${ev.title}」${same ? "と関連する予定" : ""}の日時を変更`, via: "schedule", noticeTopic: "予定の変更" });
          hvRequest = { approvalId: r.approval?.id, auto: r.auto, role: r.approval?.requiredRole, applied: r.applied };
          followUps.push(...r.followUps);
          if (same) {
            pairDone = true;
            pairApplied = r.applied || r.auto;
            if (pair!.assigneeIds && (r.applied || r.auto)) setHandoverAssignees(db, user, o.id, pair!.hv!, pair!.assigneeIds);
          }
          // 受注の日程から予定を作り直したあとの日時を使う (承認なし・承認の省略で日程が変わったとき、前の日時で上書きしない)
          const fresh = db.schedule.find((e) => e.id === id);
          if (fresh) {
            ev = fresh;
            Object.assign(p.fields, { date: fresh.date, endDate: fresh.endDate, startTime: fresh.startTime, endTime: fresh.endTime, slot: fresh.slot });
          }
        }
      }
    }
    Object.assign(ev, p.fields);
    if (mapTablesReady() && !synced && (ev.customerId || ev.orderId || ev.quoteId || ev.inquiryId)) saveEventLocationMode(db, user, ev, p.locationMode);
    const now = nowIso();
    ev.updatedBy = user.id;
    ev.updatedAt = now;
    const changes = diffChanges(before, ev, ["title", "kind", "date", "endDate", "startTime", "endTime", "slot", "storeId", "companyWide", "assigneeIds", "customerId", "orderId", "inquiryId", "location", "memo"]);
    // 受注の日程と連動する予定の日時は受注の日程 (savePlan) が変え、そちらのお知らせに書く。ここでは担当・メモなどの変更だけを数える
    const DATE_FIELDS = ["date", "endDate", "startTime", "endTime", "slot"];
    const ownChanges = hvRef ? changes.filter((c) => !DATE_FIELDS.includes(c.field)) : changes;
    changed = ownChanges.length;
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
    // 関連する予定 (引取 ⇄ 納品) もあわせて動かす (同じ受注の日程は上でまとめて保存済み)
    if (pair && !pairDone) {
      const pe = db.schedule.find((x) => x.id === pair.ev.id);
      if (pe && pair.hv) {
        const o = db.orders.find((x) => x.id === pe.orderId);
        if (o) {
          const r = savePlan(db, user, o, applyEventMove(o.handovers, pair.hv, pair.when), { back, reason: `予定表で「${ev.title}」とあわせて「${pe.title}」の日時を変更`, via: "schedule", noticeTopic: "予定の変更" });
          followUps.push(...r.followUps);
          pairApplied = r.applied || r.auto;
          if (r.approval && !r.auto) pairApproval = r.approval.id;
          if (pair.assigneeIds && pairApplied) setHandoverAssignees(db, user, o.id, pair.hv, pair.assigneeIds);
        }
      } else if (pe) {
        const pb = { ...pe, assigneeIds: [...pe.assigneeIds] };
        pe.date = pair.when.date;
        pe.endDate = undefined;
        pe.startTime = pair.when.start;
        pe.endTime = pair.when.start ? pair.when.end : undefined;
        pe.slot = pair.when.start ? undefined : pair.when.slot;
        if (pair.assigneeIds) pe.assigneeIds = [...pair.assigneeIds];
        const pc = diffChanges(pb, pe, ["date", "endDate", "startTime", "endTime", "slot", "assigneeIds"]);
        if (pc.length) {
          pe.updatedBy = user.id;
          pe.updatedAt = now;
          pairApplied = true;
          if (planTablesReady() && pc.some((c) => c.field !== "assigneeIds")) {
            if (moveBookingsWithEvent(db, pe)) followUps.push("関連する予定の車両・設備の予約も移しました。");
            if (pe.kind === "pickup") followUps.push(...replanProductionForPickup(db, user, pe));
          }
          if (pe.orderId) {
            const o = db.orders.find((x) => x.id === pe.orderId);
            if (o) {
              o.progressNotes.push({ id: newId("pn"), at: now, userId: user.id, kind: "change", body: `予定を変更: ${periodLabel(pe)} ${SCHEDULE_KIND[pe.kind].label} (担当: ${names(db, pe.assigneeIds)}・${SCHEDULE_KIND[ev.kind].label}とあわせて)` });
              o.updatedAt = now;
            }
          }
          addAudit(db, { userId: user.id, action: "update", entity: "schedule", entityId: pe.id, entityLabel: pe.title, summary: `関連する予定 (${SCHEDULE_KIND[ev.kind].label} ${shortDate(ev.date)}) とあわせて変更 (${[...new Set(pc.map((c) => FIELD_LABEL[c.field] ?? c.field))].join("・")})`, storeId: pe.storeId, changes: pc });
          pairLines = eventNoticeLines(db, pb, pe, pc, "関連する");
        }
      }
    }
    // 担当店舗・本部・管理者へのお知らせ (引取・納品の日程の変更は savePlan が同じ「予定の変更」のお知らせに書く)
    addChangeNotice(db, user.id, eventTarget(db, ev), "予定の変更", [...eventNoticeLines(db, before, ev, ownChanges), ...pairLines]);
  });
  if (pairApproval) await notifyNewApprovals([pairApproval], user.id);
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
    redirect(withMsg(returnTo ?? `/schedule/${id}`, `${hvMsg}${changed ? " 担当・メモなどの変更は保存しました。" : ""}${pair ? pairMsg(pair, pairApplied, pairApproval) : ""}${followUps.join("")}`, scheduleCheckLink([{ date: p.fields.date, pickup: p.fields.kind === "pickup" }], p.fields.storeId)));
  }
  const freed = changed && p.fields.date > current.date && SUGGEST_KINDS.includes(current.kind) ? ` 空いた ${shortDate(current.date)} に入れられる予定は 予定表 →「計画」で確かめられます。` : "";
  const msg = `${changed ? "予定を更新しました。" : pairApplied ? "" : "変更はありませんでした。"}${pair ? pairMsg(pair, pairApplied, pairApproval) : ""}${synced && changed ? "受注の施工予定にも反映しました。" : ""}${hits.length ? "担当者の予定と重複しているため、予定表で調整してください。" : ""}${followUps.join("")}${changed && impacts.length ? ` 注意: ${impacts.join(" / ")}。` : ""}${freed}`;
  redirect(withMsg(returnTo ?? `/schedule/${id}`, msg, changed || pairApplied ? scheduleCheckLink([{ date: p.fields.date, pickup: p.fields.kind === "pickup" }], p.fields.companyWide ? undefined : p.fields.storeId) : undefined));
}

/**
 * 予定表の上での変更 (予定を押したときの小さな画面。お客様のご要望 2026-11-24「■4」: 別の画面に移らずに日時・内容・種類を変える)。
 * 画面に出していない項目 (担当者・店舗・案件・場所) は今の値のまま、updateScheduleEvent と同じ処理で保存する
 * (権限・重複の確認・受注との連動・引取・納品の日程の変更の申請・変更履歴は「変更」の画面と同じ)
 */
export async function quickUpdateScheduleEvent(id: string, formData: FormData) {
  const user = await requireActionUser();
  const returnTo = safePath(str(formData, "returnTo")) ?? "/schedule";
  const db = getDb();
  const e = db.schedule.find((x) => x.id === id);
  if (!e) fail(returnTo, "予定が見つかりません (削除された可能性があります)。");
  if (!canEditEvent(user, e)) fail(returnTo, "この予定を変更する権限がありません (登録者・担当者・店舗のメンバーが変更できます)。");
  const ref = createCaseResolver(db).ofEvent(e);
  const fd = new FormData();
  const pick = (k: string, fallback: string | undefined) => (formData.has(k) ? str(formData, k) : (fallback ?? ""));
  fd.set("title", pick("title", e.title));
  fd.set("kind", e.source === "order" ? e.kind : pick("kind", e.kind));
  fd.set("date", pick("date", e.date));
  fd.set("endDate", pick("endDate", e.endDate));
  const mode = pick("timeMode", e.startTime ? "time" : e.slot ?? "allday");
  if (mode === "time") {
    fd.set("startTime", pick("startTime", e.startTime));
    fd.set("endTime", pick("endTime", e.endTime));
  } else if (mode === "am" || mode === "pm") {
    fd.set("slot", mode);
  } else {
    fd.set("allDay", "1");
  }
  fd.set("storeId", e.storeId);
  if (e.companyWide) fd.set("companyWide", "1");
  // 担当者: 小さな画面の「担当者」で選んだとき (assigneesSent) はその人たち。それ以外は今のまま (お客様のご要望 2026-11-24「⑥」)
  const assignees = str(formData, "assigneesSent") === "1" ? [...new Set(formData.getAll("assigneeIds").map(String))] : e.assigneeIds;
  for (const a of assignees) fd.append("assigneeIds", a);
  if (ref) fd.set("caseRef", caseValue(ref));
  if (e.customerId) fd.set("customerId", e.customerId);
  fd.set("locationMode", currentEventMode(db, e));
  fd.set("location", e.location ?? "");
  fd.set("memo", pick("memo", e.memo));
  if (str(formData, "allowOverlap") === "1") fd.set("allowOverlap", "1");
  // 関連する予定 (引取 ⇄ 納品) もあわせて変える (お客様のご要望 2026-11-25「②」)
  if (str(formData, "pairId")) {
    for (const k of ["pairId", "pairDate", "pairTimeMode", "pairStartTime", "pairEndTime", "pairAssigneesSent"]) if (formData.has(k)) fd.set(k, str(formData, k));
    for (const a of formData.getAll("pairAssigneeIds")) fd.append("pairAssigneeIds", String(a));
  }
  fd.set("back", returnTo);
  fd.set("returnTo", returnTo);
  return updateScheduleEvent(id, fd);
}

/**
 * 引取・現見の予定から「納品予定を追加」(お客様のご要望 2026-11-24「⑦」。src/lib/schedule-pair.ts)
 * - 受注の引取・納品の日程と連動する引取で、納品日の決まっていない品目がある: 受注の日程にその品目の納品日を入れる (はじめて入れる日程は承認なし)。
 *   納品の予定は受注の日程から作り、担当は選んだ人
 * - それ以外: 同じ案件・お客様の納品の予定を登録する (sourceRef = "pair:<引取・現見の予定 ID>" で組にする)。
 *   あとで受注の日程を保存すると、この納品の予定を使い回す (handover-events.ts の adoptable。二重にしない)
 */
export async function addPairedDelivery(id: string, formData: FormData) {
  const user = await requireActionUser();
  const returnTo = safePath(str(formData, "returnTo")) ?? "/schedule";
  const db = getDb();
  const origin = db.schedule.find((x) => x.id === id);
  if (!origin) fail(returnTo, "予定が見つかりません (削除された可能性があります)。");
  if (!canEditEvent(user, origin)) fail(returnTo, "この予定から納品予定を追加する権限がありません (登録者・担当者・店舗のメンバーが追加できます)。");
  const info = eventPair(db, origin);
  if (!info || info.want !== "delivery") fail(returnTo, "納品予定を追加できるのは、引き取り・現場見積 (現見) の予定です。");
  const date = str(formData, "date");
  if (!isDateKey(date)) fail(returnTo, "納品日を入れてください。");
  const mode = str(formData, "timeMode");
  const startTime = mode === "time" ? normTime(str(formData, "startTime")) : undefined;
  if (mode === "time" && !startTime) fail(returnTo, "納品の時刻を正しく入れてください。");
  const endTime = startTime ? normTime(str(formData, "endTime")) : undefined;
  if (startTime && endTime && toMinutes(endTime) <= toMinutes(startTime)) fail(returnTo, "終了時刻は開始時刻より後にしてください。");
  const slot: "am" | "pm" | undefined = !startTime && (mode === "am" || mode === "pm") ? mode : undefined;
  const active = new Set(db.users.filter((u) => u.active).map((u) => u.id));
  const assigneeIds = [...new Set(formData.getAll("assigneeIds").map(String))].filter((a) => active.has(a)).slice(0, QUICK_MAX_ASSIGNEES);
  const allowOverlap = str(formData, "allowOverlap") === "1";
  const memo = str(formData, "memo").slice(0, 2000) || undefined;
  const when = periodLabel({ date, startTime, endTime, slot });

  // 受注の日程の品目に納品日を入れる
  if (info.order && info.undatedRows.length && orderEditable(info.order)) {
    const o0 = info.order;
    const hits = findConflicts({ date, startTime, endTime, slot, assigneeIds, orderId: o0.id, quoteId: o0.quoteId, inquiryId: origin.inquiryId }, db.schedule);
    if (hits.length && !allowOverlap) fail(returnTo, `担当者の予定が重複しています: ${describeConflicts(db, hits)}。日時・担当者を見直すか、「重複を承知で登録する」にチェックしてください。`);
    let followUps: string[] = [];
    await mutate((db) => {
      const o = db.orders.find((x) => x.id === o0.id);
      if (!o) fail(returnTo, "受注が見つかりません。");
      const rowIds = info.undatedRows;
      const r = savePlan(db, user, o, applyEventMove(o.handovers, { role: "delivery", rowIds }, { date, start: startTime, end: endTime, slot }), { back: returnTo, reason: "予定表から納品予定を追加", via: "schedule" });
      followUps = r.followUps;
      // 受注の日程から作った納品の予定の担当を、選んだ人にする
      for (const ev of db.schedule) {
        const ref = parseHandoverRef(ev.sourceRef);
        if (ev.orderId === o.id && ref?.role === "delivery" && ref.rowIds.some((x) => rowIds.includes(x))) {
          const before = [...ev.assigneeIds];
          ev.assigneeIds = [...assigneeIds];
          if (memo && !ev.memo?.includes(memo)) ev.memo = [ev.memo, memo].filter(Boolean).join("\n").slice(0, 2000);
          ev.updatedBy = user.id;
          ev.updatedAt = nowIso();
          if (before.join() !== ev.assigneeIds.join()) addAudit(db, { userId: user.id, action: "update", entity: "schedule", entityId: ev.id, entityLabel: ev.title, summary: "予定表から納品予定を追加 (担当者)", storeId: ev.storeId, changes: [{ field: "assigneeIds", before, after: ev.assigneeIds }] });
        }
      }
    });
    revalidateSchedule(o0);
    redirect(withMsg(returnTo, `受注の引取・納品の日程に納品日 (${when}) を入れ、予定表に納品の予定を登録しました (担当: ${names(getDb(), assigneeIds)})。${followUps.join("")}`, scheduleCheckLink([{ date: origin.date, pickup: true }, { date }], origin.storeId)));
  }

  if (info.events.length > 0) fail(returnTo, "この案件にはもう納品の予定があります。納品の予定を開いて日時・担当者を変えてください。");
  // 案件・お客様の納品の予定 (案件があれば案件の店舗・お客様・場所)
  const resolver = createCaseResolver(db);
  const ref = resolver.ofEvent(origin);
  const fd = new FormData();
  fd.set("kind", "delivery");
  fd.set("date", date);
  if (startTime) {
    fd.set("startTime", startTime);
    if (endTime) fd.set("endTime", endTime);
  } else if (slot) fd.set("slot", slot);
  else fd.set("allDay", "1");
  fd.set("storeId", origin.storeId);
  for (const a of assigneeIds) fd.append("assigneeIds", a);
  if (ref) fd.set("caseRef", caseValue(ref));
  if (origin.customerId) fd.set("customerId", origin.customerId);
  fd.set("locationMode", currentEventMode(db, origin));
  fd.set("location", origin.location ?? "");
  fd.set("title", ref ? "" : `${stripKindWords(origin.title, origin.kind)} 納品`.trim());
  if (memo) fd.set("memo", memo);
  const p = parseEventForm(db, user, fd, returnTo, { allowRepeat: false });
  // 案件の店舗が自店舗でない担当者の予定 (canEditEvent で開けた予定) も、元の予定と同じ店舗に登録する
  p.fields.storeId = ref?.storeId ?? origin.storeId;
  const hits = conflictsOf(db, p.fields, [date]);
  if (hits.length && !allowOverlap) fail(returnTo, `担当者の予定が重複しています: ${describeConflicts(db, hits)}。日時・担当者を見直すか、「重複を承知で登録する」にチェックしてください。`);
  const newEventId = newId("ev");
  await mutate((db) => {
    const now = nowIso();
    const ev: ScheduleEvent = { id: newEventId, ...p.fields, source: "manual", sourceRef: `${PAIR_PREFIX}${origin.id}`, createdBy: user.id, createdAt: now, updatedBy: user.id, updatedAt: now };
    db.schedule.push(ev);
    if (mapTablesReady() && (ev.customerId || p.caseRef)) saveEventLocationMode(db, user, ev, p.locationMode);
    if (ev.orderId) {
      const o = db.orders.find((x) => x.id === ev.orderId);
      if (o) {
        o.progressNotes.push({ id: newId("pn"), at: now, userId: user.id, kind: "note", body: `予定を登録: ${periodLabel(ev)} 納品 (担当: ${names(db, ev.assigneeIds)}・${SCHEDULE_KIND[origin.kind].label} ${shortDate(origin.date)} から)` });
        o.updatedAt = now;
      }
    }
    addAudit(db, { userId: user.id, action: "create", entity: "schedule", entityId: newEventId, entityLabel: ev.title, summary: `予定表から納品予定を追加 (${periodLabel(ev)} / ${SCHEDULE_KIND[origin.kind].label} ${shortDate(origin.date)} の納品${p.caseRef ? ` / 案件 ${p.caseRef.number}` : ""}${hits.length ? " / 重複を承知で登録" : ""})`, storeId: ev.storeId });
    addChangeNotice(db, user.id, eventTarget(db, ev), "予定の追加", [{ label: "納品の予定", before: "(なし)", after: `${periodLabel(ev)} (担当: ${names(db, ev.assigneeIds)})` }]);
  });
  revalidateSchedule(p.fields);
  redirect(withMsg(returnTo, `納品の予定 (${when}) を登録しました (担当: ${names(getDb(), assigneeIds)})。${hits.length ? "担当者の予定と重複しているため、予定表で調整してください。" : ""}`, scheduleCheckLink([{ date: origin.date, pickup: true }, { date }], origin.storeId)));
}

/** 予定の削除のお知らせの行 (種類・日時・担当) */
function removedLine(db: Database, e: ScheduleEvent) {
  return { label: `${SCHEDULE_KIND[e.kind].label}の予定`, before: `${periodLabel(e)} (担当: ${names(db, e.assigneeIds)})`, after: "(削除)" };
}

/**
 * 予定の削除 (予定の画面・予定表の小さな画面)。予定だけを消し、お客様・問い合わせ・見積・受注などの案件の情報は残す。
 * - 受注の引取・納品の日程と連動する予定: 受注の日程からその品目の日時を外す (品目と案件は残す。src/lib/handover.ts の applyEventRemoval)
 * - withPair = 1 と pairIds: 関連する予定 (引取 ⇄ 納品。src/lib/schedule-pair.ts) もあわせて削除する (お客様のご要望 2026-11-25「① 引取・納品予定の削除」)
 * 予定の変更・削除は承認なし (設定 → 承認ルールで承認を必要にしたときだけ、連動する予定の削除は店長の承認のあとに消える)。担当店舗・本部・管理者に知らせる
 */
export async function deleteScheduleEvent(id: string, formData: FormData) {
  const user = await requireActionUser();
  const returnTo = safePath(str(formData, "returnTo"));
  const scope = str(formData, "scope") === "series" ? "series" : "one";
  const back = `/schedule/${id}`;
  const db = getDb();
  const e = db.schedule.find((x) => x.id === id);
  if (!e) fail("/schedule", "予定が見つかりません。");
  if (!canEditEvent(user, e)) fail(back, "この予定を削除する権限がありません (登録者・担当者・店舗のメンバーが削除できます)。");
  const done = returnTo ?? `/schedule?date=${e.date}`;
  // 関連する予定 (引取 ⇄ 納品) もあわせて削除
  const pairIds = str(formData, "withPair") === "1" ? [...new Set(formData.getAll("pairIds").map(String))].filter((x) => x && x !== id) : [];
  const info = pairIds.length ? eventPair(db, e) : undefined;
  const pairs = pairIds.map((pid) => info?.events.find((x) => x.id === pid)).filter((x): x is ScheduleEvent => Boolean(x));
  if (pairs.length !== pairIds.length) fail(returnTo ?? back, "関連する予定が見つかりません (ほかの人が変更・削除した可能性があります)。画面を読み込み直してから、もう一度削除してください。");
  for (const p of pairs) if (!canEditEvent(user, p)) fail(returnTo ?? back, `関連する予定「${p.title}」(${periodLabel(p)}) を削除する権限がありません。この予定だけを削除するか、店舗のメンバーに依頼してください。`);
  const targets = [e, ...pairs];
  // 連動する予定の確かめ (受注の施工予定は受注の画面で。施工完了の受注・承認待ちの日程の変更がある受注は消さない)
  for (const t of targets) {
    if (t.source !== "order") continue;
    const ref = parseHandoverRef(t.sourceRef);
    if (!ref) fail(returnTo ?? back, `「${t.title}」は受注の施工予定と連動している予定です。受注の画面の「施工予定・担当」で施工予定を変更してください。`);
    const o = db.orders.find((x) => x.id === t.orderId);
    if (!o || !orderEditable(o)) fail(returnTo ?? back, "施工完了・キャンセル済みの受注の予定は削除できません。");
    if (pendingHandoverChange(db, o.id)) fail(returnTo ?? back, "この案件には承認待ちの引取・納品日の変更があります。承認・差戻しのあとに削除してください (急ぐときは受注の画面で申請を取り下げてから)。");
  }
  let removed = 0;
  const plans: { r: ReturnType<typeof savePlan>; title: string }[] = [];
  await mutate((db) => {
    const now = nowIso();
    // 受注の引取・納品の日程と連動する予定: 受注ごとにまとめて日程から外す (引取と納品を一緒に消すときも 1 回の保存)
    const byOrder = new Map<string, { refs: NonNullable<ReturnType<typeof parseHandoverRef>>[]; events: ScheduleEvent[] }>();
    const plain: ScheduleEvent[] = [];
    for (const t0 of targets) {
      const t = db.schedule.find((x) => x.id === t0.id);
      if (!t) continue;
      const ref = t.source === "order" ? parseHandoverRef(t.sourceRef) : undefined;
      if (ref && t.orderId) {
        const g = byOrder.get(t.orderId) ?? { refs: [], events: [] };
        g.refs.push(ref);
        g.events.push(t);
        byOrder.set(t.orderId, g);
      } else plain.push(t);
    }
    for (const [orderId, g] of byOrder) {
      const o = db.orders.find((x) => x.id === orderId);
      if (!o) continue;
      let rows = o.handovers;
      for (const ref of g.refs) rows = applyEventRemoval(rows, ref);
      const r = savePlan(db, user, o, rows ?? [], { back: done, reason: `予定表で${g.events.map((t) => `「${t.title}」(${periodLabel(t)})`).join("・")}を削除`, via: "schedule", noticeTopic: "予定の削除" });
      plans.push({ r, title: g.events.map((t) => SCHEDULE_KIND[t.kind].label).join("・") });
    }
    // 連動していない予定 (繰り返しは、いま開いている予定だけ以降を消せる)
    const ids = new Set<string>();
    for (const t of plain) {
      const list = t.id === id && scope === "series" && t.seriesId ? db.schedule.filter((x) => x.seriesId === t.seriesId && x.date >= t.date && canEditEvent(user, x)) : [t];
      for (const x of list) ids.add(x.id);
    }
    if (!ids.size) return;
    const gone = db.schedule.filter((x) => ids.has(x.id));
    db.schedule = db.schedule.filter((x) => !ids.has(x.id));
    removed = ids.size;
    for (const t of plain) {
      if (t.orderId) {
        const o = db.orders.find((x) => x.id === t.orderId);
        if (o) {
          o.progressNotes.push({ id: newId("pn"), at: now, userId: user.id, kind: "change", body: `予定を削除: ${periodLabel(t)} ${SCHEDULE_KIND[t.kind].label}` });
          o.updatedAt = now;
        }
      }
    }
    if (planTablesReady()) {
      // ひも付く車両の予約を外し、引き取りの製造の予定は取りやめにする
      db.resourceBookings = (db.resourceBookings ?? []).filter((b) => !b.eventId || !ids.has(b.eventId));
      for (const j of db.productionJobs ?? []) if (j.pickupEventId && ids.has(j.pickupEventId) && j.status === "planned") Object.assign(j, { status: "cancelled", updatedBy: user.id, updatedAt: now, note: [j.note, "引き取りの予定の削除により取りやめ"].filter(Boolean).join(" / ") });
    }
    for (const t of plain) {
      const series = t.id === id ? gone.filter((x) => x.seriesId && x.seriesId === t.seriesId && x.id !== t.id).length : 0;
      addAudit(db, {
        userId: user.id,
        action: "delete",
        entity: "schedule",
        entityId: t.id,
        entityLabel: t.title,
        summary: `予定を削除 (${periodLabel(t)} ${SCHEDULE_KIND[t.kind].label}${series ? ` / 以降の繰り返し ${series} 件を含む` : ""}${t.id !== id ? " / 関連する予定としてあわせて削除" : ""})`,
        storeId: t.storeId,
        // 空いた枠の提案 (src/lib/scheduling/replan.ts) に使う
        changes: [
          { field: "date", before: t.date, after: null },
          { field: "kind", before: t.kind, after: null },
          { field: "assigneeIds", before: t.assigneeIds, after: null },
        ],
      });
    }
    // お知らせ (案件ごとに 1 件)
    const byTarget = new Map<string, { target: ReturnType<typeof eventTarget>; lines: ReturnType<typeof removedLine>[] }>();
    for (const t of plain) {
      const target = eventTarget(db, t);
      if (!target) continue;
      const g = byTarget.get(target.targetId) ?? { target, lines: [] };
      g.lines.push(removedLine(db, t));
      byTarget.set(target.targetId, g);
    }
    for (const g of byTarget.values()) addChangeNotice(db, user.id, g.target, "予定の削除", g.lines, { href: g.target!.href });
  });
  for (const p of plans) if (p.r.approval?.id && !p.r.auto) await notifyNewApprovals([p.r.approval.id], user.id);
  for (const t of targets) revalidateSchedule(t);
  const parts: string[] = [];
  const requested = plans.filter((p) => p.r.approval && !p.r.auto);
  const appliedPlans = plans.filter((p) => !p.r.approval || p.r.auto);
  if (removed) parts.push(removed > 1 ? `予定を ${removed} 件削除しました。` : "予定を削除しました。");
  for (const p of appliedPlans) {
    if (p.r.applied || p.r.auto) parts.push(`${p.r.auto ? `${AUTO_APPROVAL_NOTE}し、` : ""}受注の引取・納品の日程から${p.title}の日時を外し、予定を削除しました。`);
    else parts.push(`${p.title}の予定は削除できませんでした (受注の日程にこの予定の品目が見つかりません。受注の画面の「引取・納品の日程」で確かめてください)。`);
  }
  for (const p of requested) parts.push(`受注の引取・納品の日程と連動する${p.title}の予定は、削除を${p.r.approval?.requiredRole === "admin" ? "管理者" : "店長"}へ申請しました。承認されると予定表から消えます。`);
  parts.push("案件の情報は残っています。");
  if (plans.some((p) => p.r.applied || p.r.auto) || removed) parts.push("担当店舗に変更をお知らせしました。");
  const freed = targets.some((t) => SUGGEST_KINDS.includes(t.kind) && t.date >= new Date().toISOString().slice(0, 10)) && removed ? ` 空いた枠 (${shortDate(e.date)}) に入れられる予定・案件は 予定表 →「計画」の「空いた枠」で確かめられます。` : "";
  redirect(withMsg(done, `${parts.join("")}${freed}`));
}

/**
 * 予定の仕事内容 (お客様のご要望 2026-11-24「予定表から仕事内容の編集」): 予定表のチップの「タ12 フ6 シ4 ア2」を手で決める (ScheduleEvent.work)。
 * 空にすると自動 (見積の明細・件名・メモから。src/lib/schedule-work.ts) に戻す。表示のためだけの値で、見積・受注の明細は変えない
 */
export async function updateEventWork(id: string, formData: FormData) {
  const user = await requireActionUser();
  const returnTo = safePath(str(formData, "returnTo")) ?? `/schedule/${id}`;
  const e = getDb().schedule.find((x) => x.id === id);
  if (!e) fail(returnTo, "予定が見つかりません (削除された可能性があります)。");
  if (!canEditEvent(user, e)) fail(returnTo, "この予定を変更する権限がありません (登録者・担当者・店舗のメンバーが変更できます)。");
  // 数量 (「タ6 タ新4 フ2」= 作業量にも数える) か、自由な作業内容 (「養生、廃材撤去」「クロス工事、畳下床板2間」= そのまま表示)。お客様のご要望 2026-11-26
  const text = normWork(str(formData, "work"));
  const countsOnly = isCountsOnlyText(text);
  let changed = false;
  await mutate((db) => {
    const ev = db.schedule.find((x) => x.id === id);
    if (!ev) return;
    const before = ev.work;
    const after = text || undefined;
    if ((before ?? "") === (after ?? "")) return;
    ev.work = after;
    ev.updatedBy = user.id;
    ev.updatedAt = nowIso();
    changed = true;
    addAudit(db, { userId: user.id, action: "update", entity: "schedule", entityId: id, entityLabel: ev.title, summary: after ? `仕事内容を「${after}」に変更` : "仕事内容を自動 (見積の明細・件名・メモから) に戻す", storeId: ev.storeId, changes: [{ field: "work", before: before ?? null, after: after ?? null }] });
    addChangeNotice(db, user.id, eventTarget(db, ev), "仕事内容の変更", [{ label: `${SCHEDULE_KIND[ev.kind].label} ${shortDate(ev.date)} の仕事内容`, before: before ?? "(自動)", after: after ?? "(自動)" }]);
  });
  revalidateSchedule(e);
  redirect(withMsg(returnTo, changed ? (text ? (countsOnly ? `仕事内容を「${text}」にしました。` : `作業内容を「${text}」にしました (予定表にこのまま表示します)。`) : "仕事内容を自動に戻しました。") : "変更はありませんでした。"));
}

/**
 * 予定表から施工店舗を変える (お客様のご要望 2026-11-24): 案件の予定なら案件の施工店舗 (= 売上の店舗) の変更を申請する (承認の type = store_change。
 * 今の施工店舗の店長が承認。店長・管理者の申請は承認を省略。src/lib/case-store.ts)。案件のない予定は予定の店舗だけをすぐに変える
 */
export async function changeEventStore(id: string, formData: FormData) {
  const user = await requireActionUser();
  const returnTo = safePath(str(formData, "returnTo")) ?? `/schedule/${id}`;
  const to = str(formData, "storeId");
  const reason = str(formData, "reason").slice(0, 200);
  const db0 = getDb();
  const e = db0.schedule.find((x) => x.id === id);
  if (!e) fail(returnTo, "予定が見つかりません (削除された可能性があります)。");
  if (!canEditEvent(user, e)) fail(returnTo, "この予定を変更する権限がありません (登録者・担当者・店舗のメンバーが変更できます)。");
  const storeName = (sid: string) => db0.stores.find((s) => s.id === sid)?.name ?? sid;
  if (!db0.stores.some((s) => s.id === to)) fail(returnTo, "店舗を選んでください。");
  const ref = createCaseResolver(db0).ofEvent(e);
  const chain0 = ref ? caseChainOf(db0, ref.id) : undefined;
  if (!chain0) {
    if (e.source === "order") fail(returnTo, "受注と連動する予定です。受注の画面で変更してください。");
    if (to === e.storeId) fail(returnTo, "今と同じ店舗です。");
    await mutate((db) => {
      const ev = db.schedule.find((x) => x.id === id);
      if (!ev) return;
      const before = ev.storeId;
      ev.storeId = to;
      ev.updatedBy = user.id;
      ev.updatedAt = nowIso();
      addAudit(db, { userId: user.id, action: "update", entity: "schedule", entityId: id, entityLabel: ev.title, summary: `予定の店舗を変更 (${storeName(before)} → ${storeName(to)})`, storeId: to, changes: [{ field: "storeId", before, after: to }] });
      addChangeNotice(db, user.id, eventTarget(db, ev), "予定の店舗の変更", [{ label: `${SCHEDULE_KIND[ev.kind].label} ${shortDate(ev.date)} の店舗`, before: storeName(before), after: storeName(to) }], { alsoStores: [before] });
    });
    revalidateSchedule(e);
    redirect(withMsg(returnTo, `予定の店舗を${storeName(to)}にしました。`));
  }
  await requestCaseStoreChange(user, chain0, to, reason, returnTo);
}

/**
 * 見積・受注の画面から施工店舗 (売上を計上する店舗) を変える (予定表の予定から変えるのと同じ申請 store_change。
 * 店長・管理者は承認を省略、確定した売上の受注は管理者の承認。判定は case-store-view.ts の caseStoreChangeInfo と同じ)
 */
export async function changeCaseStore(recordId: string, formData: FormData) {
  const user = await requireActionUser();
  const to = str(formData, "storeId");
  const reason = str(formData, "reason").slice(0, 200);
  const db0 = getDb();
  const chain0 = caseChainOf(db0, recordId);
  const returnTo = safePath(str(formData, "returnTo")) ?? (chain0 ? `/${chain0.head.type === "order" ? "orders" : chain0.head.type === "quote" ? "quotes" : "inquiries"}/${recordId}` : "/cases");
  if (!chain0) fail(returnTo, "案件が見つかりません (削除された可能性があります)。");
  if (!db0.stores.some((s) => s.id === to)) fail(returnTo, "店舗を選んでください。");
  if (to === chain0.head.storeId) fail(returnTo, "今と同じ店舗です。");
  await requestCaseStoreChange(user, chain0, to, reason, returnTo);
}

/** 案件の施工店舗の変更の申請 (店長・管理者は承認を省略してすぐ反映)。予定から・見積・受注の画面からの共通の処理 */
async function requestCaseStoreChange(user: User, chain0: CaseChain, to: string, reason: string, returnTo: string) {
  const db0 = getDb();
  const storeName = (sid: string) => db0.stores.find((s) => s.id === sid)?.name ?? sid;
  if (!canEditCaseStore(user, chain0.head.storeId)) fail(returnTo, `${storeName(chain0.head.storeId)}の案件の施工店舗を変える権限がありません (その店舗のメンバー・店長・本部・管理者が申請できます)。`);
  const blocker = storeChangeBlocker(db0, chain0, to);
  if (blocker) fail(returnTo, blocker);
  if (pendingStoreChange(db0, chain0)) fail(returnTo, "この案件には承認待ちの施工店舗の変更があります。承認・差戻しのあとにもう一度変更してください。");
  let approvalId = "";
  let auto = false;
  let role = "store_manager" as "store_manager" | "admin";
  const from = chain0.head.storeId;
  await mutate((db) => {
    const c = caseChainOf(db, chain0.head.id);
    if (!c) fail(returnTo, "案件が見つかりません。");
    const again = storeChangeBlocker(db, c, to);
    if (again) fail(returnTo, again);
    if (pendingStoreChange(db, c)) fail(returnTo, "この案件には承認待ちの施工店舗の変更があります。");
    role = approverRole(db.users, c.head.storeId, false, user.id);
    const a: Approval = {
      id: newId("ap"),
      type: "store_change",
      targetId: c.head.id,
      title: `${c.head.number} ${c.head.title}`.trim(),
      amount: 0,
      storeId: c.head.storeId,
      requestedBy: user.id,
      requiredRole: role,
      status: "pending",
      requestComment: reason || undefined,
      changes: [{ field: "storeId", before: c.head.storeId, after: to }],
      createdAt: nowIso(),
    };
    db.approvals.push(a);
    approvalId = a.id;
    addAudit(db, { userId: user.id, action: "submit", entity: c.head.type, entityId: c.head.id, entityLabel: c.head.number, summary: `施工店舗の変更を申請 (${storeName(c.head.storeId)} → ${storeName(to)}${reason ? ` / 理由: ${reason}` : ""} / ${role === "admin" ? "管理者" : "店長"}承認)`, storeId: c.head.storeId, changes: a.changes });
    auto = settleOwnApproval(db, a, user, returnTo);
  });
  if (!auto) await notifyNewApprovals([approvalId], user.id);
  revalidatePath("/", "layout");
  redirect(
    withMsg(
      returnTo,
      auto
        ? `${AUTO_APPROVAL_NOTE}し、施工店舗を${storeName(from)}から${storeName(to)}に変更しました (案件の記録と予定)。売上は${storeName(to)}に計上します。`
        : `施工店舗の変更 (${storeName(from)} → ${storeName(to)}) を${role === "admin" ? "管理者" : `${storeName(from)}の店長`}へ申請しました。承認されると案件と予定表に反映され、売上は${storeName(to)}に計上します (それまでは今の店舗のままです)。`,
    ),
  );
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
  // 同じ案件・同じ日の予定 (二重登録の確かめ。src/lib/case-duplicates.ts)。繰り返しの登録では確かめない
  const caseDuplicates = kind && dates.length === 1 ? caseDuplicateItems(db, { date: q.date, kind, inquiryId: ref?.inquiryId, quoteId: ref?.quoteId, orderId: ref?.orderId, customerId: (typeof q.customerId === "string" && q.customerId) || ref?.customerId }, q.eventId) : [];
  return { conflicts, agenda, busy, day: q.date, occurrences: dates.length, impacts, caseDuplicates };
}

/** 同じ案件・同じ日の予定 (画面に出す形。src/lib/case-duplicates.ts) */
function caseDuplicateItems(db: Database, c: DuplicateCandidate, excludeId?: string): CaseDuplicateItem[] {
  return sameCaseSameDay(db, c, excludeId)
    .slice(0, 5)
    .map((e) => {
      const who = e.assigneeIds.map((id) => db.users.find((u) => u.id === id)?.name.split(/[\s　]/)[0] ?? "-").join("・");
      const fromMemo = Boolean(e.memo?.startsWith("メモの日程"));
      return {
        eventId: e.id,
        label: `${SCHEDULE_KIND[e.kind].label} ${periodLabel(e)}${who ? ` (${who})` : ""}`,
        replaceable: e.source !== "order",
        note: e.source === "order" ? "受注の日程と連動する予定です (受注の画面で直します)" : fromMemo ? "問合せ登録のメモの日程から自動で登録した予定です" : undefined,
      };
    });
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
