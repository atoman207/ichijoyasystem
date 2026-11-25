import type { Database, Inquiry, ScheduleEvent, StoreId, Thread, User } from "@/lib/db/types";
import { SCHEDULE_KIND } from "@/lib/constants";

/**
 * 問い合わせ受付後の業務の流れ (お客様のご要望 2026-11-24「■ 問い合わせ受付後の業務フロー」①〜⑦)
 * ------------------------------------------------------------
 * 問い合わせを登録 → 担当店舗・担当者へ依頼 (期限つき) → 日程を登録 (見積・現見・現調・引取・納品…) → 見積 → 受注 → 施工 → 請求 → 入金
 * - 依頼は業務依頼 (threads。kind = request・relatedType = inquiry) で、期限の日時 dueAt・依頼先の店舗 assigneeStoreId・種類 purpose を持つ
 * - 対応状況 (担当者への依頼待ち・日程調整中・期限超過・お客様都合で日程未定・日程確定…) は記録から決める (人が選ぶのは「日程未定」だけ)
 * - 期限を過ぎて日程の登録・返答がない依頼は自動で再通知する (src/lib/inquiry-followup.ts)
 * import のない純粋関数 (画面・定期処理・テストで共通)
 */

/* ---------------- 依頼 ---------------- */

export type RequestPurpose = "schedule" | "contact" | "other";

export const REQUEST_PURPOSE: Record<RequestPurpose, { label: string; text: string }> = {
  schedule: { label: "訪問日程の打ち合わせ", text: "お客様と訪問日程の打ち合わせをお願いします。日程が決まったら、問い合わせの画面の「日程を登録」で予定に入れてください (予定表に自動で載ります)。" },
  contact: { label: "お客様へ連絡 (折返し・確認)", text: "お客様へ連絡 (折返し) をお願いします。対応したら「報告」で結果を書いてください。" },
  other: { label: "その他の連絡", text: "" },
};

export type DueChoice = "noon" | "today" | "tomorrow" | "custom" | "none";

export const DUE_CHOICES: { id: DueChoice; label: string }[] = [
  { id: "noon", label: "本日12時まで" },
  { id: "today", label: "本日中" },
  { id: "tomorrow", label: "明日中" },
  { id: "custom", label: "日時を指定" },
  { id: "none", label: "期限なし" },
];

/** 日本時間の日付 (YYYY-MM-DD) */
export function jstDate(d: Date): string {
  return new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
}
/** 日本時間の時 (0〜23) */
export function jstHour(d: Date): number {
  return new Date(d.getTime() + 9 * 3_600_000).getUTCHours();
}
const addDay = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const at = (date: string, hm: string) => new Date(`${date}T${hm}:00+09:00`).toISOString();

/** 期限の選び方 → 期限の日時 (ISO)。本日中・明日中はその日の 23:59。日時の指定は日本時間の「YYYY-MM-DDTHH:MM」。正しくなければ { error } */
export function dueAtFrom(choice: DueChoice, custom: string | undefined, now: Date): { dueAt?: string; error?: string } {
  const today = jstDate(now);
  if (choice === "none") return {};
  if (choice === "noon") {
    const v = at(today, "12:00");
    return Date.parse(v) <= now.getTime() ? { error: "本日 12 時を過ぎています。「本日中」か日時を指定してください。" } : { dueAt: v };
  }
  if (choice === "today") return { dueAt: at(today, "23:59") };
  if (choice === "tomorrow") return { dueAt: at(addDay(today, 1), "23:59") };
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(custom ?? "");
  if (!m) return { error: "期限の日時を入れてください。" };
  const v = at(m[1], m[2]);
  if (Number.isNaN(Date.parse(v))) return { error: "期限の日時を正しく入れてください。" };
  if (Date.parse(v) <= now.getTime()) return { error: "期限に過去の日時は指定できません。" };
  return { dueAt: v };
}

/** 期限の表示「11/24 12:00まで」「本日中」「明日中」 */
export function dueLabel(dueAt: string | undefined, now: Date): string {
  if (!dueAt) return "";
  const d = new Date(dueAt);
  const date = jstDate(d);
  const hm = new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(11, 16);
  const today = jstDate(now);
  const day = date === today ? "本日" : date === addDay(today, 1) ? "明日" : `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
  return hm === "23:59" ? `${day}中` : `${day} ${hm}まで`;
}

/** 業務依頼が問い合わせの依頼か (問い合わせの画面・定期処理で使う) */
export const isInquiryRequest = (t: Pick<Thread, "kind" | "relatedType">) => t.kind === "request" && t.relatedType === "inquiry";
/** まだ終わっていない依頼 (依頼中・対応中・報告あり) */
export const isOpenRequest = (t: Pick<Thread, "status" | "taskStatus">) => t.status === "open" && t.taskStatus !== "confirmed";
/** 返答がない依頼 (依頼中・対応中。報告があれば返答あり) */
export const awaitingReply = (t: Pick<Thread, "status" | "taskStatus">) => isOpenRequest(t) && (t.taskStatus === "requested" || t.taskStatus === "acknowledged");

/** 店舗への依頼の依頼先 (店舗の店長とスタッフ。いなければ店長だけ) */
export function storeMembers(db: Pick<Database, "users" | "stores">, storeId: StoreId): User[] {
  const store = db.stores.find((s) => s.id === storeId);
  const members = db.users.filter((u) => u.active && u.storeId === storeId && (u.role === "store_manager" || u.role === "store_staff"));
  const manager = store?.managerUserId ? db.users.find((u) => u.id === store.managerUserId && u.active) : undefined;
  if (manager && !members.some((u) => u.id === manager.id)) members.unshift(manager);
  return members;
}

/* ---------------- 対応状況 ---------------- */

export type FlowState = "request_waiting" | "adjusting" | "overdue" | "on_hold" | "scheduled" | "visited" | "quoted" | "ordered" | "closed";

export const FLOW_STATE: Record<FlowState, { label: string; tone: "neutral" | "info" | "accent" | "warn" | "good" | "critical" }> = {
  request_waiting: { label: "担当者への依頼待ち", tone: "warn" },
  adjusting: { label: "日程調整中", tone: "info" },
  overdue: { label: "期限超過", tone: "critical" },
  on_hold: { label: "お客様都合で日程未定", tone: "neutral" },
  scheduled: { label: "日程確定", tone: "good" },
  visited: { label: "訪問済み (見積の作成へ)", tone: "accent" },
  quoted: { label: "見積提出済", tone: "accent" },
  ordered: { label: "受注", tone: "good" },
  closed: { label: "完了・失注", tone: "neutral" },
};

/** 一覧のタブの並び */
export const FLOW_TABS: FlowState[] = ["request_waiting", "adjusting", "overdue", "on_hold", "scheduled", "visited", "quoted", "ordered", "closed"];

export interface InquiryFlow {
  state: FlowState;
  label: string;
  tone: (typeof FLOW_STATE)[FlowState]["tone"];
  /** いちばん新しい依頼 (終わっていない依頼があればそれ) */
  request?: Thread;
  /** 期限 (依頼の期限・日程未定の次回の連絡予定日) */
  dueAt?: string;
  overdue: boolean;
  /** これからの予定 (いちばん近いもの)・終わった予定 (いちばん新しいもの) */
  nextEvent?: ScheduleEvent;
  lastEvent?: ScheduleEvent;
  /** 次にやること・誰が */
  next: string;
  who: string[];
}

export interface FlowIndex {
  requests: Map<string, Thread[]>;
  events: Map<string, ScheduleEvent[]>;
  users: Map<string, User>;
  storeName: Map<string, string>;
  quoteStatus: Map<string, string>;
  orderOfQuote: Map<string, { id: string; status: string }>;
}

export function flowIndex(db: Pick<Database, "threads" | "schedule" | "users" | "stores" | "quotes" | "orders">): FlowIndex {
  const requests = new Map<string, Thread[]>();
  for (const t of db.threads) if (isInquiryRequest(t) && t.relatedId) requests.set(t.relatedId, [...(requests.get(t.relatedId) ?? []), t]);
  const events = new Map<string, ScheduleEvent[]>();
  for (const e of db.schedule) if (e.inquiryId && SCHEDULE_KIND[e.kind]?.group === "case") events.set(e.inquiryId, [...(events.get(e.inquiryId) ?? []), e]);
  // 見積・受注に進んだ案件の予定も問い合わせの予定として数える
  const inquiryOfQuote = new Map(db.quotes.filter((q) => q.inquiryId).map((q) => [q.id, q.inquiryId!]));
  for (const e of db.schedule) {
    if (e.inquiryId || !e.quoteId || SCHEDULE_KIND[e.kind]?.group !== "case") continue;
    const iid = inquiryOfQuote.get(e.quoteId);
    if (iid) events.set(iid, [...(events.get(iid) ?? []), e]);
  }
  return {
    requests,
    events,
    users: new Map(db.users.map((u) => [u.id, u])),
    storeName: new Map(db.stores.map((s) => [s.id, s.name])),
    quoteStatus: new Map(db.quotes.map((q) => [q.id, q.status])),
    orderOfQuote: new Map(db.orders.filter((o) => o.quoteId).map((o) => [o.quoteId!, { id: o.id, status: o.status }])),
  };
}

const ORDER_DONE = new Set(["completed", "invoiced", "paid"]);

/** 依頼の依頼先の表示 (担当者の名前、なければ店舗名) */
export function requestTargetLabel(t: Pick<Thread, "assigneeIds" | "assigneeStoreId">, ix: Pick<FlowIndex, "users" | "storeName">): string {
  if (t.assigneeStoreId) return `${ix.storeName.get(t.assigneeStoreId) ?? t.assigneeStoreId} (店舗)`;
  return (t.assigneeIds ?? []).map((id) => ix.users.get(id)?.name ?? "-").join("・");
}

/** 問い合わせの対応状況 */
export function inquiryFlow(inq: Inquiry, ix: FlowIndex, now: Date): InquiryFlow {
  const today = jstDate(now);
  const requests = (ix.requests.get(inq.id) ?? []).slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const open = requests.find(isOpenRequest);
  const request = open ?? requests[0];
  const events = (ix.events.get(inq.id) ?? []).slice().sort((a, b) => a.date.localeCompare(b.date) || (a.startTime ?? "").localeCompare(b.startTime ?? ""));
  const nextEvent = events.find((e) => (e.endDate ?? e.date) >= today);
  const lastEvent = [...events].reverse().find((e) => (e.endDate ?? e.date) < today);
  const name = (id?: string) => (id ? (ix.users.get(id)?.name ?? "") : "");
  const assignee = name(inq.assignedUserId);
  const requestWho = request ? (request.assigneeStoreId ? [requestTargetLabel(request, ix)] : (request.assigneeIds ?? []).map(name).filter(Boolean)) : [];
  const base = { request, nextEvent, lastEvent };
  const make = (state: FlowState, next: string, who: string[], extra: Partial<InquiryFlow> = {}): InquiryFlow => ({ state, label: FLOW_STATE[state].label, tone: FLOW_STATE[state].tone, overdue: state === "overdue", next, who: who.filter(Boolean), ...base, ...extra });
  const kindName = (e: ScheduleEvent) => SCHEDULE_KIND[e.kind]?.label ?? "予定";
  const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

  // 見積・受注に進んだ案件
  const order = inq.quoteId ? ix.orderOfQuote.get(inq.quoteId) : undefined;
  if (order && order.status !== "cancelled") return make("ordered", ORDER_DONE.has(order.status) ? "施工完了 → 請求・入金を確かめる" : "施工の日程を決めて施工する", []);
  if (inq.status === "lost" || inq.status === "closed" || order?.status === "cancelled") return make("closed", "", []);
  if (inq.status === "won") return make("ordered", "受注の画面で施工を進める", []);
  if (inq.quoteId && ix.quoteStatus.has(inq.quoteId)) {
    const qs = ix.quoteStatus.get(inq.quoteId);
    const next = qs === "draft" ? "見積を仕上げて提出する" : qs === "pending_approval" ? "見積の承認を待つ (店長・管理者)" : qs === "approved" ? "お客様へ見積を送る" : qs === "rejected" || qs === "expired" ? "失注か、見積を出し直すかを決める" : "お客様のお返事 → 受注登録";
    return make("quoted", next, nextEvent ? [] : [assignee]);
  }
  // 見積提出済 (見積の記録がない: 移行した TEL待ちリストの「見積済・TEL待ち」など)
  if (inq.status === "quoted") return make("quoted", "お客様のお返事 (TEL待ち) → 受注・失注", [assignee]);
  // 日程が決まった (これからの予定がある)
  if (nextEvent) return make("scheduled", `${md(nextEvent.date)} ${kindName(nextEvent)}${nextEvent.kind === "onsite_quote" ? " (現場で見積 → 工事)" : ""}`, nextEvent.assigneeIds.map(name));
  // お客様都合で日程未定
  const hold = inq.scheduleHold;
  if (hold) {
    const late = Boolean(hold.nextContact && hold.nextContact < today);
    return make(late ? "overdue" : "on_hold", hold.nextContact ? `${md(hold.nextContact)} にお客様へ日程の連絡${late ? " (予定日を過ぎています)" : ""}` : "お客様からの連絡を待つ (次回の連絡予定日を入れておくと知らせます)", [assignee], {
      dueAt: hold.nextContact ? new Date(`${hold.nextContact}T23:59:00+09:00`).toISOString() : undefined,
      label: late ? `${FLOW_STATE.overdue.label} (日程未定の連絡予定日)` : FLOW_STATE.on_hold.label,
    });
  }
  // 訪問済み (見積の前)
  if (lastEvent) return make("visited", lastEvent.kind === "onsite_quote" ? "現見の結果を見積・受注に登録する" : "見積を作成する", lastEvent.assigneeIds.map(name));
  // 依頼中
  if (open) {
    const late = Boolean(open.dueAt && Date.parse(open.dueAt) <= now.getTime() && awaitingReply(open));
    const purpose = open.purpose ?? "schedule";
    const reported = open.taskStatus === "reported";
    const next = reported ? "依頼の報告を確かめて、日程を登録するか次の対応を決める" : purpose === "schedule" ? "お客様と日程を打ち合わせて、日程を登録する" : purpose === "contact" ? "お客様へ連絡して報告する" : "依頼の対応";
    return make(late ? "overdue" : "adjusting", next, reported ? [name(open.createdBy)] : requestWho, { dueAt: open.dueAt });
  }
  // 依頼も日程もない
  const late = Boolean(inq.nextActionDue && inq.nextActionDue < today);
  return make(late ? "overdue" : "request_waiting", "担当店舗・担当者へ依頼するか、日程を登録する", [assignee], { label: late ? `${FLOW_STATE.overdue.label} (依頼・日程の登録がありません)` : FLOW_STATE.request_waiting.label });
}

/* ---------------- 期限を過ぎた依頼の再通知 ---------------- */

/** 再通知の間隔と回数 (1 回目 = 期限を過ぎたとき、2 回目 = その 3 時間後に店長・依頼者も。そのあとは一覧の「期限超過」で見る) */
export const REMIND_INTERVAL_MS = 3 * 3_600_000;
export const REMIND_MAX = 2;
/** 再通知を送る時間帯 (日本時間 8 時〜20 時。夜に期限を過ぎたものは翌朝に送る) */
export const REMIND_HOURS = { from: 8, to: 20 };

export interface Followup {
  kind: "request" | "hold";
  inquiry: Inquiry;
  thread?: Thread;
  /** 何回目の再通知か (1 から) */
  round: number;
}

/** いま送る再通知 */
export function dueFollowups(db: Pick<Database, "inquiries" | "threads" | "schedule" | "users" | "stores" | "quotes" | "orders">, now: Date): Followup[] {
  const h = jstHour(now);
  if (h < REMIND_HOURS.from || h >= REMIND_HOURS.to) return [];
  const ix = flowIndex(db);
  const today = jstDate(now);
  const out: Followup[] = [];
  const byId = new Map(db.inquiries.map((i) => [i.id, i]));
  for (const t of db.threads) {
    if (!isInquiryRequest(t) || !t.relatedId || !t.dueAt || !awaitingReply(t)) continue;
    if (Date.parse(t.dueAt) > now.getTime()) continue;
    const n = t.remindCount ?? 0;
    if (n >= REMIND_MAX) continue;
    if (t.remindedAt && now.getTime() - Date.parse(t.remindedAt) < REMIND_INTERVAL_MS) continue;
    const inq = byId.get(t.relatedId);
    if (!inq) continue;
    const flow = inquiryFlow(inq, ix, now);
    // 日程の依頼は、日程が決まった・日程未定にした・見積に進んだ・終わった案件には送らない
    if ((t.purpose ?? "schedule") === "schedule" && flow.state !== "overdue" && flow.state !== "adjusting") continue;
    if (flow.state === "closed") continue;
    out.push({ kind: "request", inquiry: inq, thread: t, round: n + 1 });
  }
  // 日程未定の次回の連絡予定日 (当日の朝に 1 回)
  for (const inq of db.inquiries) {
    // 削除した問い合わせ (src/lib/inquiry-delete.ts) には知らせない
    if (inq.deleted) continue;
    const hold = inq.scheduleHold;
    if (!hold?.nextContact || hold.nextContact > today || hold.remindedOn === today) continue;
    if (hold.remindedOn && hold.remindedOn >= hold.nextContact) continue;
    const flow = inquiryFlow(inq, ix, now);
    if (flow.state !== "on_hold" && flow.state !== "overdue") continue;
    out.push({ kind: "hold", inquiry: inq, round: 1 });
  }
  return out;
}
