import type { Customer, Database, Inquiry, Order, Quote, ScheduleEvent } from "@/lib/db/types";
import { normalizeAddress, sameAddressText } from "@/lib/maps/address";
import { stripKindWords } from "@/lib/work-summary";

/**
 * 予定表に出す件名「（町名）お客様」(お客様のご要望 2026-11-24「■1. 予定表の表示」「■3. 予定表からの顧客情報の確認」)
 * ------------------------------------------------------------
 * - 町名は現場 (施工場所) の町名。業者 (法人・施設) の案件は、お客様 (業者) の住所ではなく現場の住所から取る
 *   決め方: この予定だけの場所 → 受注・見積の施工場所 → 問い合わせで聞いた住所・地区 → お客様の住所・地区 (個人のお客様だけ)
 * - 予定表から移行した予定は件名の頭に地区がある (「(清水万石) 田中」)。その地区をそのまま使う
 * - 問い合わせのお名前 (カタカナの「ヤマダ」など) で登録した予定は、あとで既存の顧客にひも付けたら顧客のお名前 (「山田 太郎」) で出す
 * 件名 (ScheduleEvent.title) は書き換えない (表示だけ)。import なしの純粋関数 (画面・テストで共通)
 */

/** 住所 → 予定表に出す町名 (市・区を外す。町・村はそのまま): 熊本市中央区坪井5丁目 → 坪井 / 合志市須屋1234 → 須屋 / 菊池郡菊陽町曲手 → 菊陽町曲手 */
export function shortTown(address: string | undefined | null): string {
  const raw = (address ?? "").trim();
  if (!raw) return "";
  const n = normalizeAddress(raw);
  // 番地のない住所 (建物名だけ・地区だけ) は空白の前まで
  let t = n.houseNumber ? n.town : normalizeAddress(raw.split(/[\s　]+/)[0]).town;
  if (!t) return "";
  const m = /^(.+?市)(.+?区)?(.*)$/.exec(t);
  if (m) {
    const rest = m[3];
    t = rest.length >= 2 ? rest : `${m[1]}${rest}`;
  }
  return t.slice(0, 14);
}

const AREA_HEAD = /^[(（]([^()（）]{1,20})[)）]\s*/;
const HOLD_HEAD = /^(\[仮[^\]]*\]\s*)/;

/** 件名の頭の地区「(清水万石) 田中」→ { area: 清水万石, rest: 田中 } */
export function splitAreaTitle(title: string): { area?: string; rest: string } {
  const m = AREA_HEAD.exec(title);
  if (!m) return { rest: title };
  return { area: m[1].trim(), rest: title.slice(m[0].length).trim() };
}

export interface EventPlaceSource {
  /** 予定の場所 (ScheduleEvent.location) */
  location?: string;
  /** 受注・見積の施工場所 */
  siteAddress?: string;
  /** 問い合わせで聞いた住所 (受付・AI 受付の intake.address)・地区 */
  inquiryAddress?: string;
  inquiryArea?: string;
  customer?: Pick<Customer, "address" | "area" | "type">;
}

/** 予定の現場の町名。分からなければ "" */
export function eventTown(s: EventPlaceSource): string {
  const corporate = s.customer?.type === "corporate";
  const own = s.customer?.address ?? "";
  // お客様 (業者) 自身の住所は現場ではない
  const notOwn = (a?: string) => Boolean(a?.trim()) && !(own && sameAddressText(a, own));
  const candidates: (string | undefined)[] = [
    notOwn(s.location) ? s.location : undefined,
    s.siteAddress,
    !corporate ? s.location : undefined,
    corporate ? (notOwn(s.inquiryAddress) ? s.inquiryAddress : undefined) : s.inquiryAddress,
    s.inquiryArea,
    !corporate ? own : undefined,
    !corporate ? s.customer?.area : undefined,
  ];
  for (const c of candidates) {
    const t = shortTown(c);
    if (t) return t;
  }
  return "";
}

/** お名前の置き換え: 件名がほかの名前 (問い合わせのお名前・以前の顧客) で始まるときだけ、ひも付いている顧客のお名前にする */
export function withCustomerName(text: string, customerName: string | undefined, oldNames: (string | undefined)[]): string {
  if (!customerName) return text;
  const compact = (x: string) => x.replace(/[\s　]+/g, "");
  if (compact(text).startsWith(compact(customerName))) return text;
  for (const old of oldNames) {
    const o = old?.trim();
    if (!o || compact(o) === compact(customerName)) continue;
    if (text.startsWith(o)) return `${customerName}${text.slice(o.length)}`;
  }
  return text;
}

export interface EventLabel {
  /** 現場の町名 (なければ undefined) */
  area?: string;
  /** 予定表に出す文字「（築地）村田」 */
  text: string;
  /** 案件・予定にひも付いているお客様 (問い合わせ → 顧客にひも付けたあとは顧客) */
  customerId?: string;
}

/** 予定表の件名を作る関数 (一覧で何度も引くので索引を作ってから使う) */
export function eventLabeler(db: Pick<Database, "inquiries" | "quotes" | "orders" | "customers">) {
  const inquiries = new Map(db.inquiries.map((i) => [i.id, i]));
  const quotes = new Map(db.quotes.map((q) => [q.id, q]));
  const orders = new Map(db.orders.map((o) => [o.id, o]));
  const orderByQuote = new Map(db.orders.filter((o) => o.quoteId).map((o) => [o.quoteId, o]));
  const customers = new Map(db.customers.map((c) => [c.id, c]));

  function chain(e: Pick<ScheduleEvent, "orderId" | "quoteId" | "inquiryId">): { inq?: Inquiry; q?: Quote; o?: Order } {
    let o = e.orderId ? orders.get(e.orderId) : undefined;
    let q = e.quoteId ? quotes.get(e.quoteId) : o?.quoteId ? quotes.get(o.quoteId) : undefined;
    let inq = e.inquiryId ? inquiries.get(e.inquiryId) : q?.inquiryId ? inquiries.get(q.inquiryId) : undefined;
    if (!q && inq?.quoteId) q = quotes.get(inq.quoteId);
    if (!o && q) o = (q.orderId ? orders.get(q.orderId) : undefined) ?? orderByQuote.get(q.id);
    if (!inq && q?.inquiryId) inq = inquiries.get(q.inquiryId);
    return { inq, q, o };
  }

  /** 予定のお客様 (受注 → 見積 → 問い合わせ → 予定の順。問い合わせを顧客にひも付けたあとは、その顧客) */
  function customerOf(e: Pick<ScheduleEvent, "orderId" | "quoteId" | "inquiryId" | "customerId">): Customer | undefined {
    const { inq, q, o } = chain(e);
    const id = o?.customerId ?? q?.customerId ?? inq?.customerId ?? e.customerId;
    return id ? customers.get(id) : undefined;
  }

  function label(e: Pick<ScheduleEvent, "title" | "kind" | "location" | "orderId" | "quoteId" | "inquiryId" | "customerId">): EventLabel {
    const hold = HOLD_HEAD.exec(e.title)?.[1] ?? "";
    const body = stripKindWords(e.title.slice(hold.length), e.kind);
    const { area: sheetArea, rest } = splitAreaTitle(body);
    const { inq, q, o } = chain(e);
    const customer = customerOf(e);
    const stale = e.customerId && e.customerId !== customer?.id ? customers.get(e.customerId) : undefined;
    const name = withCustomerName(rest, customer?.name, [inq?.contactName, inq?.intake?.name, stale?.name]);
    const area =
      sheetArea ||
      eventTown({ location: e.location, siteAddress: o?.siteAddress || q?.siteAddress || inq?.siteAddress, inquiryAddress: inq?.intake?.address, inquiryArea: inq?.area, customer }) ||
      undefined;
    return { area, text: `${hold}${area ? `（${area}）` : ""}${name || rest || e.title}`, customerId: customer?.id };
  }

  return { label, customerOf, chain };
}
