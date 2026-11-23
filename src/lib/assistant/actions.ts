import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Channel, Database, InquiryStatus, ProgressKind, ScheduleEvent, ScheduleKind, ServiceCategory, StoreId, ThreadKind, User } from "@/lib/db/types";
import { APPROVAL_TYPE_LABEL, CATEGORY_LABEL, CHANNEL_LABEL, INQUIRY_STATUS, PROGRESS_KIND_LABEL, SCHEDULE_KIND, THREAD_KIND_LABEL } from "@/lib/constants";
import { canAccessStore, canApprove, canEditCaseStore, canEditEvent, canManageCompanyEvents, canSeeAllStores } from "@/lib/auth/permissions";
import { findConflicts, isDateKey, normTime, periodLabel, shortDate, timeLabel, toMinutes } from "@/lib/calendar";
import { caseValue, createCaseResolver, orderEditable, type CaseRef } from "@/lib/db/schedule";
import { currentEventMode } from "@/lib/maps/store";
import { linkSecret } from "@/lib/notify/config";
import { MEDIA_LABEL, isMediaKey, mapMediaText, readMediaRules } from "@/lib/media";

/**
 * AI アシスタントから「頼んだら実行される」操作 (確認つき)
 * ------------------------------------------------------------
 * 1. AI は道具 propose_action で操作の内容を渡す → ここで名前・番号を記録に読み替え、権限と入力を確かめ、
 *    「何をどう変えるか」の確認のカード (ProposedAction) を作る。AI 自身は何も変えない
 * 2. 画面のカードの「実行する」を押すと /api/assistant/action が署名を確かめ、画面のボタンと同じ Server Action
 *    (src/lib/actions/*) を同じ入力で呼ぶ (action-run.ts)。権限・入力の確かめ・変更履歴・通知は画面の操作と同じ
 * - カードは署名つき (押した人 = 頼んだ人・期限 30 分・中身を書き換えると無効)。1 枚につき 1 回だけ実行できる
 * - できる操作: 予定の登録・変更・削除 / 問い合わせの登録・状態の変更 / 受注の進捗の記録 / 社内連絡・業務依頼 / 承認・差戻し・却下
 */

export type ActionKind =
  | "create_schedule_event"
  | "update_schedule_event"
  | "delete_schedule_event"
  | "create_inquiry"
  | "set_inquiry_status"
  | "add_order_progress"
  | "create_message"
  | "decide_approval";

export const ACTION_LABEL: Record<ActionKind, string> = {
  create_schedule_event: "予定の登録",
  update_schedule_event: "予定の変更",
  delete_schedule_event: "予定の削除",
  create_inquiry: "問い合わせの登録",
  set_inquiry_status: "問い合わせの状態の変更",
  add_order_progress: "受注の進捗の記録",
  create_message: "社内連絡・業務依頼",
  decide_approval: "承認の判断",
};

/** 画面に出す確認のカード */
export interface ProposedAction {
  id: string;
  kind: ActionKind;
  title: string;
  fields: { label: string; value: string }[];
  warnings: string[];
  /** 実行のボタンの文字 */
  confirmLabel: string;
  /** 削除・却下など、取り消しにくい操作 */
  danger?: boolean;
  token: string;
  expiresAt: string;
}

/** 署名する中身 (実行のときに Server Action へ渡す入力そのもの) */
export interface ActionPayload {
  v: 1;
  /** 1 回だけ実行するための番号 */
  n: string;
  /** 頼んだ人 */
  u: string;
  k: ActionKind;
  /** 対象の記録の ID (予定・問い合わせ・受注・承認) */
  t?: string;
  /** 状態・判断 (問い合わせの状態・承認の判断) */
  d?: string;
  /** フォームの入力 (名前と値) */
  f: [string, string][];
  /** 一覧・履歴に出す 1 行 */
  s: string;
  /** 期限 (UNIX 秒) */
  exp: number;
}

const TTL_SEC = 30 * 60;
const sign = (body: string) => createHmac("sha256", linkSecret()).update(`assistant-action:${body}`).digest("base64url");

export function signPayload(p: ActionPayload): string {
  const body = Buffer.from(JSON.stringify(p), "utf8").toString("base64url");
  return `${body}.${sign(body)}`;
}

export function verifyPayload(token: string, userId: string, now = Date.now()): { ok: true; payload: ActionPayload } | { ok: false; error: string } {
  const [body, sig] = String(token ?? "").split(".");
  if (!body || !sig) return { ok: false, error: "確認のカードが正しくありません。もう一度 AI アシスタントに頼んでください。" };
  const a = Buffer.from(sign(body));
  const b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, error: "確認のカードが書き換えられています。もう一度 AI アシスタントに頼んでください。" };
  let p: ActionPayload;
  try {
    p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, error: "確認のカードを読めませんでした。" };
  }
  if (p.v !== 1 || !(p.k in ACTION_LABEL)) return { ok: false, error: "確認のカードの形式が古いため実行できません。もう一度頼んでください。" };
  if (p.u !== userId) return { ok: false, error: "この確認のカードは、頼んだ本人だけが実行できます。" };
  if (p.exp * 1000 < now) return { ok: false, error: "確認のカードの期限 (30 分) が過ぎました。もう一度 AI アシスタントに頼んでください。" };
  return { ok: true, payload: p };
}

/* ================================================================== */
/* 名前・番号 → 記録                                                    */
/* ================================================================== */

const norm = (s: string) => s.normalize("NFKC").replace(/[\s　]+/g, "").toLowerCase();
const text = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : typeof v === "number" ? String(v) : "");
const list = (v: unknown, max = 10): string[] => (Array.isArray(v) ? v.map((x) => text(x, 60)).filter(Boolean).slice(0, max) : typeof v === "string" && v.trim() ? v.split(/[、,・\s]+/).map((x) => x.trim()).filter(Boolean).slice(0, max) : []);
const yes = (v: unknown) => v === true || v === "true" || v === 1 || v === "1";

type Found<T> = { ok: true; value: T } | { ok: false; error: string };

/** 社員: ID・名前 (完全一致 → 一部一致で 1 人に決まるとき) */
export function findUser(db: Database, raw: string): Found<User> {
  const active = db.users.filter((u) => u.active);
  const byId = active.find((u) => u.id === raw);
  if (byId) return { ok: true, value: byId };
  const k = norm(raw.replace(/(さん|様|君|くん)$/, ""));
  if (!k) return { ok: false, error: "社員の名前が空です。" };
  const exact = active.filter((u) => norm(u.name) === k);
  if (exact.length === 1) return { ok: true, value: exact[0] };
  const part = active.filter((u) => norm(u.name).includes(k) || k.includes(norm(u.name)));
  if (part.length === 1) return { ok: true, value: part[0] };
  if (part.length > 1) return { ok: false, error: `「${raw}」に当てはまる社員が ${part.length} 人います (${part.slice(0, 5).map((u) => u.name).join("・")})。フルネームで指定してください。` };
  return { ok: false, error: `「${raw}」という社員が見つかりません。` };
}

function findByNumber<T extends { id: string; number: string }>(rows: readonly T[], raw: string, label: string): Found<T> {
  const k = norm(raw);
  const hit = rows.find((r) => r.id === raw) ?? rows.find((r) => norm(r.number) === k);
  return hit ? { ok: true, value: hit } : { ok: false, error: `${label}「${raw}」が見つかりません。番号 (例: 画面の右上の番号) を確かめてください。` };
}

/** 案件: 受注・見積・問い合わせの番号か ID (「order:ID」の形も可) */
function findCase(db: Database, raw: string): Found<CaseRef> {
  const resolver = createCaseResolver(db);
  const direct = resolver.fromValue(raw);
  if (direct) return { ok: true, value: direct };
  for (const [type, rows] of [
    ["order", db.orders],
    ["quote", db.quotes],
    ["inquiry", db.inquiries],
  ] as const) {
    const k = norm(raw);
    const hit = (rows as readonly { id: string; number: string }[]).find((r) => r.id === raw || norm(r.number) === k);
    if (hit) {
      const ref = resolver.resolve(type, hit.id);
      if (ref) return { ok: true, value: ref };
    }
  }
  return { ok: false, error: `案件「${raw}」が見つかりません (受注・見積・問い合わせの番号を指定してください)。` };
}

/**
 * お客様: ID・顧客コード・名前 (自分が扱える店舗で 1 人に決まるとき)。
 * 扱える店舗は、予定は自店舗 (canAccessStore)、問い合わせは顧客・案件を変更できる店舗 (canEditCaseStore: 店長は全店舗)
 */
function findCustomer(db: Database, user: User, raw: string, canUse: (storeId: StoreId) => boolean = (s) => canAccessStore(user, s)): Found<Database["customers"][number]> {
  const rows = db.customers.filter((c) => canUse(c.storeId));
  const k = norm(raw.replace(/(様|さん)$/, ""));
  const byId = rows.find((c) => c.id === raw || norm(c.code) === k);
  if (byId) return { ok: true, value: byId };
  const exact = rows.filter((c) => norm(c.name) === k);
  if (exact.length === 1) return { ok: true, value: exact[0] };
  if (exact.length > 1) return { ok: false, error: `「${raw}」様が ${exact.length} 人います。顧客コードで指定してください (${exact.slice(0, 4).map((c) => c.code).join("・")})。` };
  return { ok: false, error: `お客様「${raw}」が見つかりません (扱える店舗のお客様だけを探しました)。` };
}

function storeOf(db: Database, user: User, raw: string): StoreId | undefined {
  if (!raw) return undefined;
  const k = norm(raw);
  const s = db.stores.find((x) => x.id === raw || norm(x.name) === k || norm(x.shortName) === k || norm(x.name).includes(k));
  return s?.id;
}

const storeName = (db: Database, id?: string) => db.stores.find((s) => s.id === id)?.name ?? id ?? "";
const userNames = (db: Database, ids: string[]) => ids.map((id) => db.users.find((u) => u.id === id)?.name ?? id).join("・");
const keyOf = <T extends string>(labels: Record<T, string>, raw: string): T | undefined => {
  if (!raw) return undefined;
  if (Object.hasOwn(labels, raw)) return raw as T;
  const k = norm(raw);
  return (Object.keys(labels) as T[]).find((x) => norm(labels[x]) === k || norm(labels[x]).includes(k));
};
const KIND_LABELS = Object.fromEntries(Object.entries(SCHEDULE_KIND).map(([k, v]) => [k, v.label])) as Record<ScheduleKind, string>;
const STATUS_LABELS = Object.fromEntries(Object.entries(INQUIRY_STATUS).map(([k, v]) => [k, v.label])) as Record<InquiryStatus, string>;

/* ================================================================== */
/* 確認のカードを作る                                                    */
/* ================================================================== */

export type ProposeResult = { ok: true; action: ProposedAction; payload: ActionPayload } | { ok: false; error: string };

function make(user: User, kind: ActionKind, p: { t?: string; d?: string; f: [string, string][]; s: string }, card: Omit<ProposedAction, "id" | "kind" | "token" | "expiresAt">, now: Date): ProposeResult {
  const exp = Math.floor(now.getTime() / 1000) + TTL_SEC;
  const payload: ActionPayload = { v: 1, n: randomBytes(9).toString("base64url"), u: user.id, k: kind, t: p.t, d: p.d, f: p.f, s: p.s.slice(0, 200), exp };
  return { ok: true, payload, action: { ...card, id: payload.n, kind, token: signPayload(payload), expiresAt: new Date(exp * 1000).toISOString() } };
}

const bad = (error: string): ProposeResult => ({ ok: false, error });

/** 予定の日時の入力 (登録と変更で共通) */
function timing(a: Record<string, unknown>, base?: Partial<ScheduleEvent>): Found<{ date: string; endDate?: string; startTime?: string; endTime?: string; slot?: "am" | "pm"; allDay: boolean }> {
  const date = text(a.date, 10) || base?.date || "";
  if (!isDateKey(date)) return { ok: false, error: "日付は YYYY-MM-DD の形で指定してください。" };
  let endDate = a.end_date === null ? undefined : text(a.end_date, 10) || (a.date ? undefined : base?.endDate);
  if (endDate && !isDateKey(endDate)) return { ok: false, error: "終了日は YYYY-MM-DD の形で指定してください。" };
  if (endDate && endDate < date) return { ok: false, error: "終了日は開始日以降にしてください。" };
  if (endDate === date) endDate = undefined;
  const allDay = yes(a.all_day);
  const timeGiven = "start_time" in a || "slot" in a || "all_day" in a;
  const startRaw = allDay ? "" : text(a.start_time, 5);
  const startTime = allDay ? undefined : startRaw ? normTime(startRaw) : timeGiven ? undefined : base?.startTime;
  if (startRaw && !startTime) return { ok: false, error: "開始時刻は HH:MM の形で指定してください。" };
  const endRaw = text(a.end_time, 5);
  const endTime = startTime ? (endRaw ? normTime(endRaw) : timeGiven ? undefined : base?.endTime) : undefined;
  if (startTime && endTime && toMinutes(endTime) <= toMinutes(startTime)) return { ok: false, error: "終了時刻は開始時刻より後にしてください。" };
  const slotRaw = text(a.slot, 3);
  const slot = !allDay && !startTime ? (slotRaw === "am" || slotRaw === "pm" ? slotRaw : timeGiven ? undefined : base?.slot) : undefined;
  return { ok: true, value: { date, endDate, startTime, endTime, slot, allDay } };
}

function eventForm(e: { title: string; kind: ScheduleKind; date: string; endDate?: string; startTime?: string; endTime?: string; slot?: "am" | "pm"; allDay: boolean; storeId: StoreId; assigneeIds: string[]; customerId?: string; caseRef?: string; location?: string; locationMode: "follow" | "custom"; memo?: string; companyWide?: boolean; allowOverlap: boolean }): [string, string][] {
  const f: [string, string][] = [
    ["title", e.title],
    ["kind", e.kind],
    ["date", e.date],
    ["endDate", e.endDate ?? ""],
    ["allDay", e.allDay ? "1" : ""],
    ["startTime", e.startTime ?? ""],
    ["endTime", e.endTime ?? ""],
    ["slot", e.slot ?? ""],
    ["storeId", e.storeId],
    ["customerId", e.customerId ?? ""],
    ["caseRef", e.caseRef ?? ""],
    ["location", e.location ?? ""],
    ["locationMode", e.locationMode],
    ["memo", e.memo ?? ""],
    ["companyWide", e.companyWide ? "1" : ""],
    ["allowOverlap", e.allowOverlap ? "1" : ""],
  ];
  for (const id of e.assigneeIds) f.push(["assigneeIds", id]);
  return f;
}

function conflictWarnings(db: Database, slot: { date: string; endDate?: string; startTime?: string; endTime?: string; slot?: "am" | "pm"; assigneeIds: string[] }, excludeId?: string): string[] {
  const hits = findConflicts(slot, db.schedule.filter((e) => e.id !== excludeId));
  return hits.slice(0, 4).map((h) => `担当者の予定と重なります: ${userNames(db, [h.userId])} さん ${shortDate(h.day)} ${timeLabel(h.event)}「${h.event.title}」`);
}

function proposeCreateEvent(db: Database, user: User, a: Record<string, unknown>, now: Date): ProposeResult {
  const kind = keyOf(KIND_LABELS, text(a.event_kind ?? a.kind, 20)) ?? "other";
  const t = timing(a);
  if (!t.ok) return bad(t.error);
  let caseRef: CaseRef | undefined;
  if (text(a.case)) {
    const c = findCase(db, text(a.case));
    if (!c.ok) return bad(c.error);
    if (!canAccessStore(user, c.value.storeId)) return bad("この案件の店舗の予定を登録する権限がありません。");
    caseRef = c.value;
  }
  let customerId = caseRef?.customerId;
  if (!caseRef && text(a.customer)) {
    const c = findCustomer(db, user, text(a.customer));
    if (!c.ok) return bad(c.error);
    customerId = c.value.id;
  }
  const companyWide = !caseRef && yes(a.company_wide);
  if (companyWide && !canManageCompanyEvents(user)) return bad("全社共通の予定は店長・本部スタッフ・管理者が登録できます。");
  const requested = storeOf(db, user, text(a.store, 40));
  const storeId: StoreId = caseRef?.storeId ?? (requested && canSeeAllStores(user) ? requested : user.storeId);
  if (!caseRef && !canAccessStore(user, storeId)) return bad("この店舗の予定を登録する権限がありません。");
  const names = list(a.assignees);
  const assigneeIds: string[] = [];
  for (const n of names) {
    const u = findUser(db, n);
    if (!u.ok) return bad(u.error);
    if (!assigneeIds.includes(u.value.id)) assigneeIds.push(u.value.id);
  }
  const assumedSelf = !assigneeIds.length && !companyWide;
  if (assumedSelf) assigneeIds.push(user.id);
  const title = text(a.title, 120) || (caseRef ? `${caseRef.customerName ? `${caseRef.customerName} 様 ` : ""}${SCHEDULE_KIND[kind].label}` : "");
  if (!title) return bad("予定の件名を指定してください。");
  const location = text(a.location, 200);
  const locationMode: "follow" | "custom" = location ? "custom" : caseRef || customerId ? "follow" : "custom";
  const memo = text(a.memo, 2000);
  const warnings = conflictWarnings(db, { ...t.value, assigneeIds });
  if (assumedSelf) warnings.push("担当者の指定がないため、頼んだ本人 (あなた) を担当者にしています。");
  const label = periodLabel(t.value);
  const f = eventForm({ title, kind, ...t.value, storeId, assigneeIds, customerId, caseRef: caseRef ? caseValue(caseRef) : undefined, location, locationMode, memo, companyWide, allowOverlap: warnings.some((w) => w.startsWith("担当者の予定と重なります")) });
  return make(
    user,
    "create_schedule_event",
    { f, s: `予定を登録: ${label} ${SCHEDULE_KIND[kind].label}「${title}」` },
    {
      title: "予定を登録します",
      fields: [
        { label: "件名", value: title },
        { label: "種類", value: SCHEDULE_KIND[kind].label },
        { label: "日時", value: label },
        { label: "店舗", value: companyWide ? "全社共通" : storeName(db, storeId) },
        { label: "担当", value: userNames(db, assigneeIds) || "(なし)" },
        ...(caseRef ? [{ label: "案件", value: `${caseRef.number}${caseRef.customerName ? ` (${caseRef.customerName} 様)` : ""}` }] : customerId ? [{ label: "お客様", value: `${db.customers.find((c) => c.id === customerId)?.name ?? ""} 様` }] : []),
        ...(location ? [{ label: "場所", value: location }] : caseRef || customerId ? [{ label: "場所", value: "案件・お客様の住所" }] : []),
        ...(memo ? [{ label: "メモ", value: memo.slice(0, 200) }] : []),
      ],
      warnings,
      confirmLabel: warnings.some((w) => w.startsWith("担当者の予定と重なります")) ? "重複を承知で登録する" : "登録する",
    },
    now,
  );
}

function proposeUpdateEvent(db: Database, user: User, a: Record<string, unknown>, now: Date): ProposeResult {
  const id = text(a.event_id ?? a.id, 60);
  const e = db.schedule.find((x) => x.id === id);
  if (!e) return bad(`予定「${id}」が見つかりません (list_schedule などで予定の ID を確かめてください)。`);
  if (!canEditEvent(user, e)) return bad("この予定を変更する権限がありません (登録者・担当者・店舗のメンバーが変更できます)。");
  if (e.source === "order" && e.orderId) {
    const o = db.orders.find((x) => x.id === e.orderId);
    if (!o || !orderEditable(o)) return bad("施工完了・キャンセル済みの受注の施工予定は変更できません。");
  }
  const t = timing(a, e);
  if (!t.ok) return bad(t.error);
  let assigneeIds = e.assigneeIds;
  if (a.assignees !== undefined) {
    assigneeIds = [];
    for (const n of list(a.assignees)) {
      const u = findUser(db, n);
      if (!u.ok) return bad(u.error);
      if (!assigneeIds.includes(u.value.id)) assigneeIds.push(u.value.id);
    }
    if (!assigneeIds.length && !e.companyWide) return bad("担当者を 1 人以上指定してください。");
  }
  const title = text(a.title, 120) || e.title;
  const location = a.location !== undefined ? text(a.location, 200) : e.location;
  const mode = a.location !== undefined ? "custom" : currentEventMode(db, e);
  const memo = a.memo !== undefined ? text(a.memo, 2000) : e.memo;
  const resolver = createCaseResolver(db);
  const ref = resolver.ofEvent(e);
  const before = periodLabel(e);
  const after = periodLabel(t.value);
  const changes: { label: string; value: string }[] = [];
  if (before !== after) changes.push({ label: "日時", value: `${before} → ${after}` });
  if (assigneeIds.join() !== e.assigneeIds.join()) changes.push({ label: "担当", value: `${userNames(db, e.assigneeIds) || "(なし)"} → ${userNames(db, assigneeIds) || "(なし)"}` });
  if (title !== e.title) changes.push({ label: "件名", value: `${e.title} → ${title}` });
  if ((location ?? "") !== (e.location ?? "")) changes.push({ label: "場所", value: `${e.location || "(なし)"} → ${location || "(なし)"}` });
  if ((memo ?? "") !== (e.memo ?? "")) changes.push({ label: "メモ", value: (memo || "(なし)").slice(0, 200) });
  if (!changes.length) return bad("変える内容がありません (日時・担当者・件名・場所・メモのどれを変えるか指定してください)。");
  const warnings = conflictWarnings(db, { ...t.value, assigneeIds }, e.id);
  if (e.source === "order") warnings.push("受注の施工予定と連動している予定です。受注の施工期間・担当も変わります。");
  if (e.seriesId) warnings.push("繰り返しの予定のうち、この 1 件だけを変えます。");
  const f = eventForm({ title, kind: e.kind, ...t.value, storeId: e.storeId, assigneeIds, customerId: e.customerId, caseRef: ref ? caseValue(ref) : undefined, location, locationMode: mode, memo, companyWide: e.companyWide, allowOverlap: warnings.some((w) => w.startsWith("担当者の予定と重なります")) });
  return make(user, "update_schedule_event", { t: e.id, f, s: `予定を変更: 「${e.title}」 ${changes.map((c) => `${c.label} ${c.value}`).join(" / ")}` }, {
    title: "予定を変更します",
    fields: [{ label: "予定", value: `${e.title} (${SCHEDULE_KIND[e.kind].label})` }, ...changes],
    warnings,
    confirmLabel: warnings.some((w) => w.startsWith("担当者の予定と重なります")) ? "重複を承知で変更する" : "変更する",
  }, now);
}

function proposeDeleteEvent(db: Database, user: User, a: Record<string, unknown>, now: Date): ProposeResult {
  const id = text(a.event_id ?? a.id, 60);
  const e = db.schedule.find((x) => x.id === id);
  if (!e) return bad(`予定「${id}」が見つかりません。`);
  if (!canEditEvent(user, e)) return bad("この予定を削除する権限がありません (登録者・担当者・店舗のメンバーが削除できます)。");
  if (e.source === "order") return bad("受注の施工予定と連動している予定は、ここでは削除できません。受注・施工の画面で施工予定を変更してください。");
  return make(user, "delete_schedule_event", { t: e.id, f: [["scope", "one"]], s: `予定を削除: ${periodLabel(e)}「${e.title}」` }, {
    title: "予定を削除します",
    fields: [
      { label: "予定", value: e.title },
      { label: "種類", value: SCHEDULE_KIND[e.kind].label },
      { label: "日時", value: periodLabel(e) },
      { label: "担当", value: userNames(db, e.assigneeIds) || "(なし)" },
    ],
    warnings: [...(e.seriesId ? ["繰り返しの予定のうち、この 1 件だけを削除します。"] : []), "削除した予定は元に戻せません (変更履歴には残ります)。"],
    confirmLabel: "削除する",
    danger: true,
  }, now);
}

function proposeCreateInquiry(db: Database, user: User, a: Record<string, unknown>, now: Date): ProposeResult {
  const summary = text(a.summary, 200);
  if (!summary) return bad("問い合わせの内容 (要約) を指定してください。");
  let customer: Database["customers"][number] | undefined;
  if (text(a.customer)) {
    const c = findCustomer(db, user, text(a.customer), (s) => canEditCaseStore(user, s));
    if (!c.ok) return bad(c.error);
    customer = c.value;
  }
  const contactName = customer?.name ?? text(a.contact_name, 80);
  if (!contactName) return bad("お客様の名前 (既存のお客様なら顧客コード・名前) を指定してください。");
  const requested = storeOf(db, user, text(a.store, 40));
  // 受付店舗: 全店舗ロールはお客様の店舗 (指定があればその店舗)、店舗のロールは自店舗 (問い合わせの画面と同じ。店長がほかの店舗のお客様の問い合わせを受けても自店舗)
  const storeId: StoreId = canSeeAllStores(user) ? (customer?.storeId ?? requested ?? user.storeId) : user.storeId;
  if (!canAccessStore(user, storeId)) return bad("この店舗の問い合わせを登録する権限がありません。");
  const channel = keyOf<Channel>(CHANNEL_LABEL, text(a.channel, 20)) ?? "phone";
  const category = keyOf<ServiceCategory>(CATEGORY_LABEL, text(a.category, 20)) ?? "tatami";
  let assignee = user;
  if (text(a.assignee)) {
    const u = findUser(db, text(a.assignee));
    if (!u.ok) return bad(u.error);
    assignee = u.value;
  }
  const detail = text(a.detail, 2000);
  const phone = customer?.phone ?? text(a.contact_phone, 20);
  const nextAction = text(a.next_action, 120);
  const nextDue = text(a.next_action_due, 10);
  if (nextDue && !isDateKey(nextDue)) return bad("次の対応の期限は YYYY-MM-DD の形で指定してください。");
  // 媒体 (当社を知ったきっかけ) は必須 (問い合わせの画面と同じ。言葉は画面と同じ対応表で分類に読み替える)
  const mediaRaw = text(a.media, 40);
  const media = isMediaKey(mediaRaw) ? mediaRaw : mediaRaw ? mapMediaText(readMediaRules(db).rules, mediaRaw) : null;
  if (!media) return bad(`お客様が当社を知ったきっかけ (情報媒体) が${mediaRaw ? `「${mediaRaw}」では分かりません` : "ありません"}。利用者に聞いて、次のどれかで指定してください (聞けなかったときは「不明」): ${Object.values(MEDIA_LABEL).join("・")}`);
  const f: [string, string][] = [
    ["summary", summary],
    ["detail", detail],
    ["customerId", customer?.id ?? ""],
    ["contactName", customer ? "" : contactName],
    ["contactPhone", customer ? "" : phone],
    ["storeId", storeId],
    ["channel", channel],
    ["category", category],
    ["assignedUserId", assignee.id],
    ["nextAction", nextAction],
    ["nextActionDue", nextDue],
    ["media", media],
  ];
  return make(user, "create_inquiry", { f, s: `問い合わせを登録: ${contactName} / ${summary}` }, {
    title: "問い合わせを登録します",
    fields: [
      { label: "お客様", value: `${contactName} 様${customer ? ` (${customer.code})` : " (新規)"}` },
      ...(phone ? [{ label: "電話", value: phone }] : []),
      { label: "内容", value: summary },
      ...(detail ? [{ label: "詳細", value: detail.slice(0, 200) }] : []),
      { label: "受付経路", value: CHANNEL_LABEL[channel] },
      { label: "種別", value: CATEGORY_LABEL[category] },
      { label: "店舗", value: storeName(db, storeId) },
      { label: "担当", value: assignee.name },
      { label: "知ったきっかけ", value: MEDIA_LABEL[media] },
      ...(nextAction ? [{ label: "次の対応", value: `${nextAction}${nextDue ? ` (${shortDate(nextDue)} まで)` : ""}` }] : []),
    ],
    warnings: customer ? [] : ["新しいお客様として登録します (顧客の登録は問い合わせの画面から行えます)。"],
    confirmLabel: "登録する",
  }, now);
}

function proposeInquiryStatus(db: Database, user: User, a: Record<string, unknown>, now: Date): ProposeResult {
  const f = findByNumber(db.inquiries, text(a.inquiry ?? a.id, 60), "問い合わせ");
  if (!f.ok) return bad(f.error);
  const inq = f.value;
  if (!canEditCaseStore(user, inq.storeId)) return bad("この問い合わせの店舗を操作する権限がありません。");
  const status = keyOf(STATUS_LABELS, text(a.status, 20));
  if (!status) return bad(`状態は ${Object.values(STATUS_LABELS).join("・")} のどれかで指定してください。`);
  if (status === inq.status) return bad(`問い合わせ ${inq.number} はすでに「${STATUS_LABELS[status]}」です。`);
  return make(user, "set_inquiry_status", { t: inq.id, d: status, f: [], s: `問い合わせ ${inq.number} を「${STATUS_LABELS[status]}」に変更` }, {
    title: "問い合わせの状態を変えます",
    fields: [
      { label: "問い合わせ", value: `${inq.number} ${inq.contactName} 様 / ${inq.summary.slice(0, 60)}` },
      { label: "状態", value: `${STATUS_LABELS[inq.status]} → ${STATUS_LABELS[status]}` },
    ],
    warnings: [],
    confirmLabel: "変更する",
  }, now);
}

function proposeOrderProgress(db: Database, user: User, a: Record<string, unknown>, now: Date): ProposeResult {
  const f = findByNumber(db.orders, text(a.order ?? a.id, 60), "受注");
  if (!f.ok) return bad(f.error);
  const o = f.value;
  if (!canEditCaseStore(user, o.storeId)) return bad("この受注の店舗を操作する権限がありません。");
  const body = text(a.body, 1000);
  if (!body) return bad("記録する内容を指定してください。");
  const kind = keyOf<ProgressKind>(PROGRESS_KIND_LABEL, text(a.progress_kind ?? a.kind, 20)) ?? "note";
  const warnings = kind === "install" && (o.status === "scheduled" || o.status === "confirmed") ? ["受注の状態が「施工中」に変わります。"] : [];
  return make(user, "add_order_progress", { t: o.id, f: [["body", body], ["kind", kind]], s: `受注 ${o.number} に進捗を記録 (${PROGRESS_KIND_LABEL[kind]})` }, {
    title: "受注に進捗を記録します",
    fields: [
      { label: "受注", value: `${o.number} ${o.title}` },
      { label: "種類", value: PROGRESS_KIND_LABEL[kind] },
      { label: "内容", value: body.slice(0, 300) },
    ],
    warnings,
    confirmLabel: "記録する",
  }, now);
}

function proposeMessage(db: Database, user: User, a: Record<string, unknown>, now: Date): ProposeResult {
  const kind = keyOf<ThreadKind>(THREAD_KIND_LABEL, text(a.message_kind ?? a.kind, 20)) ?? "notice";
  const title = text(a.title, 120);
  const body = text(a.body, 4000);
  if (!title || !body) return bad("件名と本文を指定してください。");
  const to: User[] = [];
  for (const n of list(a.to)) {
    const u = findUser(db, n);
    if (!u.ok) return bad(u.error);
    if (u.value.id !== user.id && !to.some((x) => x.id === u.value.id)) to.push(u.value);
  }
  if (kind === "request" && !to.length) return bad("業務依頼は依頼先 (担当者) を 1 人以上指定してください。");
  const due = text(a.due_date, 10);
  if (due && !isDateKey(due)) return bad("期限は YYYY-MM-DD の形で指定してください。");
  const f: [string, string][] = [
    ["title", title],
    ["body", body],
    ["kind", kind],
    ["dueDate", due],
  ];
  for (const u of to) f.push([kind === "request" ? "assigneeIds" : "mentions", u.id]);
  let related = "";
  if (text(a.related)) {
    const c = findCase(db, text(a.related));
    if (!c.ok) return bad(c.error);
    f.push(["relatedType", c.value.type], ["relatedId", c.value.id]);
    related = c.value.number;
  }
  return make(user, "create_message", { f, s: `${THREAD_KIND_LABEL[kind]}を送る: ${title} → ${to.map((u) => u.name).join("・") || "全員"}` }, {
    title: kind === "request" ? "業務依頼を送ります" : "社内連絡を送ります",
    fields: [
      { label: "種類", value: THREAD_KIND_LABEL[kind] },
      { label: kind === "request" ? "依頼先" : "宛先", value: to.map((u) => u.name).join("・") || "(指定なし: 社内連絡の一覧に表示)" },
      { label: "件名", value: title },
      { label: "本文", value: body.slice(0, 400) },
      ...(due ? [{ label: "期限", value: shortDate(due) }] : []),
      ...(related ? [{ label: "関係する案件", value: related }] : []),
    ],
    warnings: to.length ? ["宛先の人に通知が届きます。"] : [],
    confirmLabel: "送る",
  }, now);
}

function proposeApproval(db: Database, user: User, a: Record<string, unknown>, now: Date): ProposeResult {
  const raw = text(a.approval ?? a.id, 120);
  const pending = db.approvals.filter((x) => x.status === "pending");
  const k = norm(raw);
  const ap = pending.find((x) => x.id === raw) ?? (k ? pending.filter((x) => norm(x.title).includes(k)) : []).find((_, i, arr) => arr.length === 1);
  if (!ap) return bad(`承認待ちの依頼「${raw}」が見つかりません (承認待ちの一覧の件名か ID を指定してください)。`);
  if (ap.requestedBy === user.id) return bad("自分が申請した依頼は承認・差戻し・却下できません。");
  if (!canApprove(user, ap)) return bad(`この依頼は${ap.requiredRole === "admin" ? "管理者" : "店長"}のみ判断できます。`);
  const decisions = { approved: "承認", returned: "差戻し", rejected: "却下" } as const;
  const d = keyOf(decisions, text(a.decision, 10));
  if (!d) return bad("判断は 承認・差戻し・却下 のどれかで指定してください。");
  const comment = text(a.comment, 500);
  if (d !== "approved" && !comment) return bad(`${decisions[d]}の理由 (申請者に伝わるコメント) を指定してください。`);
  return make(user, "decide_approval", { t: ap.id, d, f: [["comment", comment], ["returnTo", "/approvals"]], s: `${APPROVAL_TYPE_LABEL[ap.type]}「${ap.title}」を${decisions[d]}` }, {
    title: `承認の依頼を${decisions[d]}します`,
    fields: [
      { label: "依頼", value: `${APPROVAL_TYPE_LABEL[ap.type]}: ${ap.title}` },
      ...(ap.amount ? [{ label: "金額", value: `${ap.amount.toLocaleString("ja-JP")} 円` }] : []),
      { label: "申請者", value: userNames(db, [ap.requestedBy]) },
      { label: "判断", value: decisions[d] },
      ...(comment ? [{ label: "コメント", value: comment }] : []),
    ],
    warnings: d === "approved" ? ["承認すると、関係する記録 (金額・契約など) に反映され、申請者に通知されます。"] : ["申請者に通知されます。"],
    confirmLabel: `${decisions[d]}する`,
    danger: d === "rejected",
  }, now);
}

const BUILDERS: Record<ActionKind, (db: Database, user: User, a: Record<string, unknown>, now: Date) => ProposeResult> = {
  create_schedule_event: proposeCreateEvent,
  update_schedule_event: proposeUpdateEvent,
  delete_schedule_event: proposeDeleteEvent,
  create_inquiry: proposeCreateInquiry,
  set_inquiry_status: proposeInquiryStatus,
  add_order_progress: proposeOrderProgress,
  create_message: proposeMessage,
  decide_approval: proposeApproval,
};

/** AI の道具の入力から確認のカードを作る (何も変えない) */
export function proposeAction(db: Database, user: User, kindRaw: string, args: Record<string, unknown>, now = new Date()): ProposeResult {
  const kind = (Object.keys(ACTION_LABEL) as ActionKind[]).find((k) => k === kindRaw);
  if (!kind) return bad(`この操作はできません: ${kindRaw}。できる操作: ${Object.values(ACTION_LABEL).join("・")}`);
  if (user.active === false) return bad("無効なアカウントです。");
  try {
    return BUILDERS[kind](db, user, args ?? {}, now);
  } catch (err) {
    return bad(`確認のカードを作れませんでした: ${(err as Error).message}`);
  }
}

/** AI の道具の結果 (AI に返す文) */
export function proposalText(r: ProposeResult): string {
  if (!r.ok) return `確認のカードを作れませんでした: ${r.error}\n(入力を直して propose_action を呼び直すか、できない理由を利用者に伝える)`;
  const a = r.action;
  return [
    `確認のカードを画面に出しました (まだ実行していません)。利用者が内容を確かめて「${a.confirmLabel}」を押すと実行されます。期限は 30 分。`,
    `${a.title}`,
    ...a.fields.map((f) => `- ${f.label}: ${f.value}`),
    ...a.warnings.map((w) => `- 注意: ${w}`),
    "回答では、実行したと書かない。カードの内容を短く伝え、「よければ『${confirm}』を押してください」と書く。".replace("${confirm}", a.confirmLabel),
  ].join("\n");
}
