import type { CaseRequestKind, Database, ScheduleKind, StoreId, Thread, User } from "@/lib/db/types";
import { SCHEDULE_KIND } from "@/lib/constants";
import { canEditCaseStore, canEditEvent, canReadStoreRecords } from "@/lib/auth/permissions";
import { policyReader } from "@/lib/access-policy";
import { caseChainOf } from "@/lib/case-store";
import { periodLabel } from "@/lib/calendar";
import { caseValue, orderEditable } from "@/lib/db/schedule";
import { mapsDirectionsUrl, mapsSearchUrl } from "@/lib/maps/google";
import { mapSearchAddress } from "@/lib/maps/query";
import { mapIndex, placeOfCustomer, placeOfOrder, placeOfQuote } from "@/lib/maps/resolve";
import { parseHandoverRef } from "@/lib/handover";

/**
 * 依頼 (メンション) の画面に出す案件の情報 (お客様のご要望 2026-11-25「メンションからの日程調整・予定登録」)
 * ------------------------------------------------------------
 * 依頼を受けた現場の担当者が、画面を移らずに お客様に電話 → 日程を決める → 予定を登録 まで終えられるように、
 * お客様の電話番号 (押すと電話)・訪問先の住所 (地図)・問い合わせの内容・この案件の予定と、日程の登録の初期値を返す。
 * 案件にひも付いた業務依頼 (予定表・案件の画面からの依頼、問い合わせの「担当へ依頼」) のときだけ
 */

export interface RequestContext {
  caseNumber?: string;
  caseHref?: string;
  customer?: { name: string; href?: string; corporate: boolean };
  /** 電話 (押すと電話をかける) */
  phones: { label: string; number: string }[];
  /** 訪問先 (施工現場。なければお客様の住所) */
  visit?: { heading: string; address: string; searchUrl?: string; directionsUrl?: string };
  /** 依頼主の住所 (施工現場と違うとき) */
  requesterAddress?: string;
  /** 問い合わせ・見積・受注の内容 */
  content: { label: string; title: string; text?: string; href: string }[];
  /** この案件の今日以降の予定 */
  events: { id: string; period: string; kind: string; assignees: string }[];
  /** 日程の登録 (この画面から) */
  schedule?: {
    caseRef: string;
    storeId: StoreId;
    kind: ScheduleKind;
    /** 依頼を送った予定 (日時を変えられるとき。日程変更依頼の既定は「この予定の日時を変更」) */
    move?: { id: string; period: string; kind: ScheduleKind; date: string; startTime?: string; endTime?: string; slot?: "am" | "pm"; assigneeIds: string[] };
    preferMove: boolean;
  };
}

const CASE_TYPES = new Set(["inquiry", "quote", "order"]);

export function isCaseThread(t: Pick<Thread, "relatedType" | "relatedId" | "taskStatus">): boolean {
  return Boolean(t.taskStatus && t.relatedId && CASE_TYPES.has(t.relatedType ?? ""));
}

/** 依頼の種類と案件の段階から、登録する予定の種類の初期値 */
function defaultKind(kind: CaseRequestKind | undefined, stage: "inquiry" | "quote" | "order", eventKind?: ScheduleKind): ScheduleKind {
  if (eventKind && SCHEDULE_KIND[eventKind].group === "case") return eventKind;
  if (kind === "claim") return "visit";
  return stage === "order" ? "visit" : "survey";
}

export function requestContext(db: Database, user: User, t: Thread, today: string): RequestContext | undefined {
  if (!isCaseThread(t)) return undefined;
  const chain = caseChainOf(db, t.relatedId);
  if (!chain) return undefined;
  const customerId = chain.order?.customerId ?? chain.quote?.customerId ?? chain.inquiry?.customerId;
  const customer = customerId ? db.customers.find((c) => c.id === customerId) : undefined;
  const reader = policyReader(db, user);
  const canSee = customer ? canReadStoreRecords(reader, customer.storeId) || canEditCaseStore(user, customer.storeId) : true;
  const inq = chain.inquiry;
  const ctx: RequestContext = { caseNumber: chain.head.number, phones: [], content: [], events: [] };
  ctx.caseHref = chain.head.type === "order" ? `/orders/${chain.head.id}` : chain.head.type === "quote" ? `/quotes/${chain.head.id}` : `/inquiries/${chain.head.id}`;
  if (customer) ctx.customer = { name: customer.name, href: canSee ? `/customers/${customer.id}` : undefined, corporate: customer.type === "corporate" };
  else if (inq) ctx.customer = { name: inq.contactName, corporate: false };
  // 電話: お客様の主な番号 → ほかの電話番号 (続柄) → 問い合わせで聞いた番号 (登録にないもの)
  if (canSee) {
    const seen = new Set<string>();
    const add = (label: string, n?: string) => {
      const d = (n ?? "").replace(/[^0-9]/g, "");
      if (d.length < 9 || seen.has(d)) return;
      seen.add(d);
      ctx.phones.push({ label, number: n!.trim() });
    };
    add("電話", customer?.phone);
    for (const c of customer?.contacts ?? []) add(c.relation || "ほかの電話", c.phone);
    add("問い合わせで聞いた番号", inq?.contactPhone);
    add("問い合わせで聞いた番号", inq?.intake?.phone);
    add("折返し先", inq?.intake?.callbackPhone);
    ctx.phones = ctx.phones.slice(0, 5);
  }
  // 訪問先: 施工現場 (受注 → 見積 → 問い合わせ) → お客様の住所。地図は予定表と同じ場所の決め方
  if (canSee) {
    const idx = mapIndex(db);
    const place = chain.order ? placeOfOrder(db, chain.order, idx) : chain.quote ? placeOfQuote(db, chain.quote, idx) : undefined;
    const site = chain.order?.siteAddress || chain.quote?.siteAddress || inq?.siteAddress || "";
    const requester = customer?.address || inq?.intake?.address || "";
    if (place?.addressText) ctx.visit = { heading: place.heading, address: place.addressText, searchUrl: place.searchUrl, directionsUrl: place.directionsUrl };
    else if (site) ctx.visit = { heading: "施工現場", address: site, searchUrl: mapsSearchUrl({ address: mapSearchAddress(site) }), directionsUrl: mapsDirectionsUrl({ address: mapSearchAddress(site) }) };
    else if (customer) {
      const cp = placeOfCustomer(db, customer, idx);
      if (cp.addressText) ctx.visit = { heading: customer.type === "corporate" ? "依頼主 (業者) の住所 (施工現場は未登録)" : "お客様の住所", address: cp.addressText, searchUrl: cp.searchUrl, directionsUrl: cp.directionsUrl };
    } else if (requester) ctx.visit = { heading: "問い合わせで聞いた住所", address: requester, searchUrl: mapsSearchUrl({ address: mapSearchAddress(requester) }), directionsUrl: mapsDirectionsUrl({ address: mapSearchAddress(requester) }) };
    if (requester && ctx.visit && ctx.visit.address !== requester) ctx.requesterAddress = requester;
  }
  // 内容: 問い合わせ (要件・詳細) → 見積 (件名・施工内容) → 受注 (件名・施工内容)
  if (inq) ctx.content.push({ label: `問い合わせ ${inq.number}`, title: inq.summary, text: inq.detail?.trim() || undefined, href: `/inquiries/${inq.id}` });
  if (chain.quote) ctx.content.push({ label: `見積 ${chain.quote.number}`, title: `${chain.quote.title} (¥${chain.quote.total.toLocaleString("ja-JP")})`, text: chain.quote.workDetails?.trim() || chain.quote.items.slice(0, 6).map((i) => `${i.name}${i.spec ? ` (${i.spec})` : ""} ${i.qty}${i.unit}`).join(" / "), href: `/quotes/${chain.quote.id}` });
  if (chain.order) ctx.content.push({ label: `受注 ${chain.order.number}`, title: chain.order.title, text: chain.order.workDetails?.trim() || undefined, href: `/orders/${chain.order.id}` });
  // この案件の予定 (今日以降)
  // 予定を登録する案件 (いちばん進んだ記録。予定の入力と同じ「order:o_1」の形)
  const key = caseValue({ type: chain.head.type, id: chain.head.id });
  const names = (ids: string[]) => ids.map((id) => db.users.find((u) => u.id === id)?.name ?? "-").join("・") || "未定";
  ctx.events = db.schedule
    .filter((e) => (e.date >= today || (e.endDate ?? "") >= today) && ((chain.order && e.orderId === chain.order.id) || (chain.quote && e.quoteId === chain.quote.id) || (inq && e.inquiryId === inq.id)))
    .sort((a, b) => a.date.localeCompare(b.date) || (a.startTime ?? "").localeCompare(b.startTime ?? ""))
    .slice(0, 6)
    .map((e) => ({ id: e.id, period: periodLabel(e), kind: SCHEDULE_KIND[e.kind].label, assignees: names(e.assigneeIds) }));
  // 日程の登録 (完了・キャンセルの受注は登録しない)
  const done = chain.order && !orderEditable(chain.order);
  if (!done && t.taskStatus !== "confirmed") {
    const ev = t.eventId ? db.schedule.find((e) => e.id === t.eventId) : undefined;
    const movable = ev && canEditEvent(user, ev) && (ev.source !== "order" || Boolean(parseHandoverRef(ev.sourceRef)));
    ctx.schedule = {
      caseRef: key,
      storeId: chain.head.storeId,
      kind: defaultKind(t.caseRequest, chain.head.type, ev?.kind),
      move: movable && ev ? { id: ev.id, period: periodLabel(ev), kind: ev.kind, date: ev.date, startTime: ev.startTime, endTime: ev.endTime, slot: ev.slot, assigneeIds: ev.assigneeIds } : undefined,
      preferMove: Boolean(movable && t.caseRequest === "schedule_change"),
    };
  }
  return ctx;
}
