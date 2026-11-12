import "server-only";
import type { Database, Inquiry, Order, Quote, ScheduleEvent, StoreId, User } from "./types";
import { newId, nowIso } from "./store";
import { scopeByStore } from "@/lib/auth/permissions";
import { addDays, toDateKey } from "@/lib/format";

/**
 * 予定表と案件 (問い合わせ → 見積 → 受注) をつなぐサーバー側の処理
 * ------------------------------------------------------------
 * - 案件はどの段階から辿っても同じ 1 件として扱う (問い合わせ・見積・受注の ID をそろえる)
 * - 予定は案件の ID を持つので、案件に登録した予定は担当者とともに店舗のカレンダーへそのまま載る
 * - 受注の施工予定 (施工期間・施工担当・現場住所) は「施工」の予定 1 件 (source = "order") と双方向に連動する
 */

export type CaseType = "inquiry" | "quote" | "order";

export interface CaseRef {
  /** 案件の現在の段階 (最も進んだもの) */
  type: CaseType;
  id: string;
  number: string;
  title: string;
  stage: string;
  href: string;
  storeId: StoreId;
  customerId?: string;
  customerName: string;
  /** 予定の場所の初期値 (現場住所 / お客様の住所) */
  location?: string;
  /** 担当者の初期値 (施工担当 / 問い合わせ担当 / 見積作成者) */
  assigneeIds: string[];
  inquiryId?: string;
  quoteId?: string;
  orderId?: string;
  /** 進行中 (失注・期限切れ・キャンセル・入金済み以外) */
  open: boolean;
  /** 受注の契約承認待ち (施工予定は仮押さえ) */
  pending: boolean;
}

const STAGE: Record<CaseType, string> = { inquiry: "問い合わせ", quote: "見積", order: "受注・施工" };
const DONE_ORDER = ["completed", "invoiced", "paid", "cancelled"];

/** 受注の施工予定を変更できる状態か */
export function orderEditable(o: Pick<Order, "status">): boolean {
  return !DONE_ORDER.includes(o.status);
}

/** 案件の参照を作る関数一式 (一覧表示で何度も引くので索引を作ってから使う) */
export function createCaseResolver(db: Database) {
  const inquiries = new Map(db.inquiries.map((i) => [i.id, i]));
  const quotes = new Map(db.quotes.map((q) => [q.id, q]));
  const orders = new Map(db.orders.map((o) => [o.id, o]));
  const orderByQuote = new Map(db.orders.map((o) => [o.quoteId, o]));
  const customers = new Map(db.customers.map((c) => [c.id, c]));

  const orderOf = (q?: Quote): Order | undefined => (q ? ((q.orderId ? orders.get(q.orderId) : undefined) ?? orderByQuote.get(q.id)) : undefined);

  function build(inq?: Inquiry, q?: Quote, o?: Order): CaseRef | undefined {
    const head = o ?? q ?? inq;
    if (!head) return undefined;
    const type: CaseType = o ? "order" : q ? "quote" : "inquiry";
    const customerId = o?.customerId ?? q?.customerId ?? inq?.customerId;
    const customer = customerId ? customers.get(customerId) : undefined;
    const open = o
      ? o.status !== "cancelled" && o.status !== "paid"
      : q
        ? !["rejected", "expired"].includes(q.status)
        : !["lost", "closed"].includes(inq!.status);
    return {
      type,
      id: head.id,
      number: head.number,
      title: o?.title ?? q?.title ?? inq?.summary ?? "",
      stage: STAGE[type],
      href: `/${type === "order" ? "orders" : type === "quote" ? "quotes" : "inquiries"}/${head.id}`,
      storeId: head.storeId,
      customerId,
      customerName: customer?.name ?? inq?.contactName ?? "",
      location: o?.siteAddress || customer?.address || undefined,
      assigneeIds: o?.workerIds.length ? [...o.workerIds] : inq?.assignedUserId ? [inq.assignedUserId] : q ? [q.createdBy] : [],
      inquiryId: inq?.id ?? q?.inquiryId,
      quoteId: q?.id,
      orderId: o?.id,
      open,
      pending: o?.status === "pending_approval",
    };
  }

  function resolve(type: CaseType, id: string): CaseRef | undefined {
    if (type === "order") {
      const o = orders.get(id);
      if (!o) return undefined;
      const q = o.quoteId ? quotes.get(o.quoteId) : undefined;
      return build(q?.inquiryId ? inquiries.get(q.inquiryId) : undefined, q, o);
    }
    if (type === "quote") {
      const q = quotes.get(id);
      if (!q) return undefined;
      return build(q.inquiryId ? inquiries.get(q.inquiryId) : undefined, q, orderOf(q));
    }
    const inq = inquiries.get(id);
    if (!inq) return undefined;
    const q = inq.quoteId ? quotes.get(inq.quoteId) : undefined;
    return build(inq, q, orderOf(q));
  }

  /** 予定が紐づく案件 (最も進んだ段階で返す) */
  function ofEvent(e: Pick<ScheduleEvent, "orderId" | "quoteId" | "inquiryId">): CaseRef | undefined {
    if (e.orderId) return resolve("order", e.orderId);
    if (e.quoteId) return resolve("quote", e.quoteId);
    if (e.inquiryId) return resolve("inquiry", e.inquiryId);
    return undefined;
  }

  /** "order:o_123" 形式の値から案件を引く */
  function fromValue(value: string | undefined | null): CaseRef | undefined {
    if (!value) return undefined;
    const [type, id] = value.split(":");
    if ((type === "order" || type === "quote" || type === "inquiry") && id) return resolve(type, id);
    return undefined;
  }

  return { resolve, ofEvent, fromValue };
}

export function caseValue(ref: Pick<CaseRef, "type" | "id">): string {
  return `${ref.type}:${ref.id}`;
}

/** 案件のすべての予定 (問い合わせ段階の現地調査から受注後の納品・訪問まで) */
export function caseEvents(db: Database, ref: Pick<CaseRef, "inquiryId" | "quoteId" | "orderId">): ScheduleEvent[] {
  return db.schedule.filter(
    (e) => (ref.orderId && e.orderId === ref.orderId) || (ref.quoteId && e.quoteId === ref.quoteId) || (ref.inquiryId && e.inquiryId === ref.inquiryId),
  );
}

/** 予定を登録できる案件 (進行中の受注・見積・問い合わせ。完了直後の受注は納品・訪問のため 30 日間含める) */
export function selectableCases(db: Database, user: User): CaseRef[] {
  const resolver = createCaseResolver(db);
  const since = addDays(toDateKey(new Date()), -30);
  const out: CaseRef[] = [];
  for (const o of scopeByStore(user, db.orders)) {
    const active = ["pending_approval", "confirmed", "scheduled", "in_progress"].includes(o.status);
    const recent = ["completed", "invoiced", "paid"].includes(o.status) && (o.completedAt ?? "") >= since;
    if (active || recent) {
      const ref = resolver.resolve("order", o.id);
      if (ref) out.push(ref);
    }
  }
  for (const q of scopeByStore(user, db.quotes)) {
    if (q.orderId || !["draft", "pending_approval", "approved", "sent"].includes(q.status)) continue;
    const ref = resolver.resolve("quote", q.id);
    if (ref && ref.type === "quote") out.push(ref);
  }
  for (const i of scopeByStore(user, db.inquiries)) {
    if (i.quoteId || !["new", "in_progress"].includes(i.status)) continue;
    const ref = resolver.resolve("inquiry", i.id);
    if (ref) out.push(ref);
  }
  return out;
}

/**
 * 受注の施工予定 → 予定表 (施工の予定 1 件) へ反映する。
 * 施工開始日が未定になれば連動する予定を外す。時刻を渡さなければ既存の時刻 (新規は 9:00–15:00) を使う。
 */
export function syncOrderEvent(db: Database, o: Order, actorId: string, times?: { startTime?: string; endTime?: string }): ScheduleEvent | undefined {
  const idx = db.schedule.findIndex((e) => e.orderId === o.id && e.source === "order");
  const main = idx >= 0 ? db.schedule[idx] : undefined;
  if (!o.scheduledStart || o.status === "cancelled") {
    if (main) db.schedule.splice(idx, 1);
    return undefined;
  }
  const quote = db.quotes.find((q) => q.id === o.quoteId);
  const customer = db.customers.find((c) => c.id === o.customerId);
  const now = nowIso();
  const fields = {
    date: o.scheduledStart,
    endDate: o.scheduledEnd && o.scheduledEnd > o.scheduledStart ? o.scheduledEnd : undefined,
    storeId: o.storeId,
    assigneeIds: [...o.workerIds],
    customerId: o.customerId,
    orderId: o.id,
    quoteId: o.quoteId,
    inquiryId: quote?.inquiryId,
    location: o.siteAddress || customer?.address || undefined,
  };
  if (main) {
    Object.assign(main, fields);
    if (times) {
      main.startTime = times.startTime;
      main.endTime = times.startTime ? times.endTime : undefined;
    }
    main.updatedBy = actorId;
    main.updatedAt = now;
    return main;
  }
  const ev: ScheduleEvent = {
    id: newId("ev"),
    title: `${customer ? `${customer.name} 様 ` : ""}${o.title} 施工`,
    kind: "install",
    ...fields,
    startTime: times ? times.startTime : "09:00",
    endTime: times ? (times.startTime ? times.endTime : undefined) : "15:00",
    source: "order",
    createdBy: actorId,
    createdAt: now,
    updatedBy: actorId,
    updatedAt: now,
  };
  db.schedule.push(ev);
  return ev;
}

/** 受注のキャンセル・契約却下: これからの予定 (今日以降) を外し、過去の予定は履歴として残す */
export function removeUpcomingOrderEvents(db: Database, orderId: string): number {
  const today = toDateKey(new Date());
  const before = db.schedule.length;
  db.schedule = db.schedule.filter((e) => e.orderId !== orderId || e.date < today);
  return before - db.schedule.length;
}
