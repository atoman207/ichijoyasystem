import type { Customer, Database, Inquiry, Invoice, Order, Payment, Quote, StoreId } from "@/lib/db/types";
import { siteInfoText } from "@/lib/site-info";

/**
 * 案件の状態 (進捗・見積と仕様・工事日程・請求・入金・事務処理を分けて持つ)
 * ------------------------------------------------------------
 * 1 つの状態にまとめると選択肢が増えすぎるため、管理項目を分ける。
 * 多くは登録済みの記録 (問い合わせ・見積・受注・予定・請求書・入金) から自動で決まり、
 * 記録から分からないもの (一部の仕様が未確定・日程調整中・請求書の要否・入金の予定方法・全処理完了) だけを人が設定する
 */

export type Stage = "inquiry" | "visit_planned" | "quoted" | "ordered" | "in_progress" | "completed" | "lost" | "cancelled";
export type SpecState = "none" | "waiting" | "discussing" | "fixed" | "pending";
export type ScheduleState = "undecided" | "adjusting" | "fixed";
export type BillingState = "na" | "unbilled" | "billed" | "not_required";
export type PaymentState = "na" | "unpaid" | "partial" | "settlement_pending" | "paid";

export const STAGE_LABEL: Record<Stage, string> = {
  inquiry: "問い合わせ",
  visit_planned: "見積予定",
  quoted: "見積済",
  ordered: "受注",
  in_progress: "施工中",
  completed: "完了",
  lost: "失注",
  cancelled: "キャンセル",
};
export const SPEC_LABEL: Record<SpecState, string> = { none: "未提出", waiting: "提出済・TEL待ち", discussing: "打合せ中", fixed: "決定", pending: "一部の仕様が未確定" };
export const SCHEDULE_LABEL: Record<ScheduleState, string> = { undecided: "未定", adjusting: "調整中", fixed: "確定" };
export const BILLING_LABEL: Record<BillingState, string> = { na: "-", unbilled: "未請求", billed: "請求済", not_required: "請求不要" };
export const PAYMENT_STATE_LABEL: Record<PaymentState, string> = { na: "-", unpaid: "未入金", partial: "一部入金", settlement_pending: "決済入金待ち", paid: "入金済" };
export const PLANNED_PAYMENT_LABEL: Record<string, string> = { cash: "現金", transfer: "振込", visit: "訪問集金", card: "クレジットカード", epay: "電子決済 (PayPay など)", trade: "業者取引 (請求書)" };

export const STAGE_TONE: Record<Stage, "neutral" | "info" | "accent" | "warn" | "good" | "critical"> = {
  inquiry: "neutral",
  visit_planned: "info",
  quoted: "accent",
  ordered: "warn",
  in_progress: "warn",
  completed: "good",
  lost: "neutral",
  cancelled: "neutral",
};

export interface CaseRow {
  key: string;
  kind: "inquiry" | "quote" | "order";
  id: string;
  number: string;
  href: string;
  customerId?: string;
  customerName: string;
  storeId: StoreId;
  title: string;
  /** 並べ替え用の日付 (受付・見積・施工・完了など、いちばん新しい動き) */
  date: string;
  stage: Stage;
  /** 細かな状態 (例: 完了・後日入金予定 (振込)) */
  detail: string;
  spec: SpecState;
  schedule: ScheduleState;
  scheduleDate?: string;
  billing: BillingState;
  payment: PaymentState;
  paymentMethod?: string;
  amount?: number;
  paid?: number;
  closed: boolean;
  /** 残っている事務処理 */
  tasks: string[];
  hasSiteInfo: boolean;
  /** 検索用 (お客様名・件名・番号・現場情報・施工内容) */
  text: string;
}

const PAYMENT_METHOD_NAME: Record<Payment["method"], string> = { cash: "現金", transfer: "振込", card: "クレジットカード", paypay: "PayPay", other: "その他" };
const isDeferredMethod = (m: Payment["method"]) => m === "card" || m === "paypay";

/** 請求書 (書類) の発行が必要か。未設定なら 法人のお客様・後日の振込・業者取引・訪問集金 は必要 */
export function billingRequired(o: Order, customer?: Customer): boolean {
  if (o.billing === "required") return true;
  if (o.billing === "not_required") return false;
  if (customer?.type === "corporate") return true;
  return ["transfer", "trade", "visit"].includes(o.plannedPayment ?? "");
}

/** 手書き見積書の「支払い方法」→ 入金の予定方法 */
export function plannedFromSiteInfo(method?: string): string | undefined {
  switch (method) {
    case "現金":
      return "cash";
    case "振込":
      return "transfer";
    case "訪問集金":
      return "visit";
    case "カード":
      return "card";
    case "PayPay":
      return "epay";
    default:
      return undefined;
  }
}

export interface CaseIndex {
  customers: Map<string, Customer>;
  quotesById: Map<string, Quote>;
  invoicesByOrder: Map<string, Invoice[]>;
  paymentsByInvoice: Map<string, Payment[]>;
  visitsByInquiry: Map<string, string[]>;
}

export function caseIndex(db: Pick<Database, "customers" | "quotes" | "invoices" | "payments" | "schedule">): CaseIndex {
  const invoicesByOrder = new Map<string, Invoice[]>();
  for (const i of db.invoices) if (i.status !== "void") invoicesByOrder.set(i.orderId, [...(invoicesByOrder.get(i.orderId) ?? []), i]);
  const paymentsByInvoice = new Map<string, Payment[]>();
  for (const p of db.payments) paymentsByInvoice.set(p.invoiceId, [...(paymentsByInvoice.get(p.invoiceId) ?? []), p]);
  const visitsByInquiry = new Map<string, string[]>();
  for (const e of db.schedule) if (e.inquiryId && ["visit", "measure", "survey"].includes(e.kind)) visitsByInquiry.set(e.inquiryId, [...(visitsByInquiry.get(e.inquiryId) ?? []), e.date]);
  return { customers: new Map(db.customers.map((c) => [c.id, c])), quotesById: new Map(db.quotes.map((q) => [q.id, q])), invoicesByOrder, paymentsByInvoice, visitsByInquiry };
}

const md = (d?: string) => (d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : "");

export function orderCase(o: Order, ix: CaseIndex, today: string): CaseRow {
  const customer = ix.customers.get(o.customerId);
  const quote = o.quoteId ? ix.quotesById.get(o.quoteId) : undefined;
  const invoices = ix.invoicesByOrder.get(o.id) ?? [];
  const payments = invoices.flatMap((i) => ix.paymentsByInvoice.get(i.id) ?? []);
  const paid = payments.reduce((a, p) => a + p.amount, 0);
  const pendingSettle = payments.some((p) => isDeferredMethod(p.method) && !p.settledOn);
  const required = billingRequired(o, customer);
  const imported = o.source === "import";
  const stage: Stage = o.status === "cancelled" ? "cancelled" : o.status === "in_progress" ? "in_progress" : ["completed", "invoiced", "paid"].includes(o.status) ? "completed" : "ordered";
  const done = stage === "completed";
  const schedule: ScheduleState = o.scheduledStart ? "fixed" : o.scheduleStatus === "adjusting" ? "adjusting" : "undecided";
  const spec: SpecState = o.specStatus === "pending" ? "pending" : "fixed";
  const billing: BillingState = !required ? "not_required" : invoices.length ? "billed" : done ? "unbilled" : "na";
  const fullyPaid = paid >= o.total && o.total > 0;
  const payment: PaymentState = fullyPaid ? (pendingSettle ? "settlement_pending" : "paid") : paid > 0 ? "partial" : done || invoices.length ? "unpaid" : "na";
  const methods = [...new Set(payments.map((p) => PAYMENT_METHOD_NAME[p.method]))];
  const paymentMethod = methods.join("・") || (o.plannedPayment ? PLANNED_PAYMENT_LABEL[o.plannedPayment] : undefined) || o.siteInfo?.paymentMethod || quote?.siteInfo?.paymentMethod;
  const closed = Boolean(o.closedAt) || stage === "cancelled" || (imported && done);
  const tasks: string[] = [];
  if (!closed) {
    if (stage === "ordered" && o.status === "pending_approval") tasks.push("契約承認待ち");
    if (stage === "ordered" && o.status === "returned") tasks.push("契約の再申請 (差戻し)");
    if (!done && spec === "pending") tasks.push("仕様の確定");
    if (!done && schedule !== "fixed") tasks.push(schedule === "adjusting" ? "工事日程の調整" : "工事日程の決定");
    if (done && !o.salesDate) tasks.push("売上計上");
    if (billing === "unbilled") tasks.push("請求書の発行");
    if (done && (payment === "unpaid" || payment === "partial")) tasks.push(payment === "partial" ? "残金の入金確認" : "入金確認");
    if (payment === "settlement_pending") tasks.push("カード・電子決済の入金確認");
    if (done && payment === "paid" && billing !== "unbilled") tasks.push("全処理完了の登録");
  }
  let detail = "";
  if (stage === "cancelled") detail = "キャンセル";
  else if (stage === "ordered") detail = `${o.status === "pending_approval" ? "受注 (契約承認待ち)" : o.status === "returned" ? "受注 (契約差戻し・再申請待ち)" : "受注・着工前"} · 日程${SCHEDULE_LABEL[schedule]}${o.scheduledStart ? ` (${md(o.scheduledStart)})` : ""}${spec === "pending" ? " · 一部仕様未確定" : ""}`;
  else if (stage === "in_progress") detail = "着工中";
  else if (closed) detail = imported ? "完了 (移行データ)" : "完了・全処理完了";
  else if (payment === "paid") detail = `完了・入金済${billing === "unbilled" ? " (請求書未発行)" : " (事務処理あり)"}`;
  else if (payment === "settlement_pending") detail = `完了・${paymentMethod ?? "カード・電子決済"}の入金待ち`;
  else if (payment === "partial") detail = "完了・一部入金";
  else if (billing === "unbilled") detail = "完了・請求書発行待ち";
  else if (billing === "billed") detail = "完了・請求済・入金待ち";
  else detail = `完了・後日入金予定${paymentMethod ? ` (${paymentMethod})` : ""}`;
  const date = (o.completedAt ?? o.salesDate ?? o.scheduledStart ?? o.contractDate).slice(0, 10);
  return {
    key: `o:${o.id}`,
    kind: "order",
    id: o.id,
    number: o.number,
    href: `/orders/${o.id}`,
    customerId: o.customerId,
    customerName: customer?.name ?? "-",
    storeId: o.storeId,
    title: o.title,
    date,
    stage,
    detail,
    spec,
    schedule,
    scheduleDate: o.scheduledStart,
    billing,
    payment,
    paymentMethod,
    amount: o.total,
    paid,
    closed,
    tasks,
    hasSiteInfo: Boolean(o.siteInfo && Object.keys(o.siteInfo).length),
    text: [o.number, o.title, customer?.name, customer?.kana, customer?.phone, o.siteAddress, o.workDetails, siteInfoText(o.siteInfo), quote?.number].filter(Boolean).join(" "),
  };
}

export function quoteCase(q: Quote, ix: CaseIndex): CaseRow {
  const customer = ix.customers.get(q.customerId);
  const lost = q.status === "rejected" || q.status === "expired";
  const spec: SpecState = q.status === "accepted" ? "fixed" : q.specStatus === "discussing" ? "discussing" : q.status === "sent" || q.handedOver ? "waiting" : "none";
  const stage: Stage = lost ? "lost" : "quoted";
  const detail = lost ? "失注" : q.status === "draft" ? `見積作成中${q.handedOver ? " (手書き見積書をお渡し済み・TEL待ち)" : ""}` : q.status === "pending_approval" ? "見積の承認待ち" : spec === "waiting" ? "見積済・TEL待ち (検討中)" : spec === "discussing" ? "見積済・打合せ中" : "見積承認済・未提出";
  return {
    key: `q:${q.id}`,
    kind: "quote",
    id: q.id,
    number: q.number,
    href: `/quotes/${q.id}`,
    customerId: q.customerId,
    customerName: customer?.name ?? "-",
    storeId: q.storeId,
    title: q.title,
    date: (q.issuedAt ?? q.updatedAt ?? q.createdAt).slice(0, 10),
    stage,
    detail,
    spec,
    schedule: "undecided",
    billing: "na",
    payment: "na",
    paymentMethod: q.siteInfo?.paymentMethod,
    amount: q.total,
    closed: lost,
    tasks: lost ? [] : q.status === "draft" ? ["見積の承認申請"] : q.status === "pending_approval" ? ["見積の承認"] : spec === "none" ? ["お客様への提出"] : ["お客様の回答確認"],
    hasSiteInfo: Boolean(q.siteInfo && Object.keys(q.siteInfo).length),
    text: [q.number, q.title, customer?.name, customer?.kana, customer?.phone, q.workDetails, q.notes, siteInfoText(q.siteInfo)].filter(Boolean).join(" "),
  };
}

export function inquiryCase(i: Inquiry, ix: CaseIndex, today: string): CaseRow {
  const customer = i.customerId ? ix.customers.get(i.customerId) : undefined;
  const lost = i.status === "lost" || i.status === "closed";
  const visits = (ix.visitsByInquiry.get(i.id) ?? []).sort();
  const next = visits.find((d) => d >= today);
  const stage: Stage = lost ? "lost" : visits.length ? "visit_planned" : "inquiry";
  const detail = lost ? "失注・対応終了" : next ? `見積日程決定・訪問前 (${md(next)})` : visits.length ? "訪問済・見積作成待ち" : customer ? "基本情報あり・見積日程未定" : "顧客情報未登録 (やり取りのみ)";
  return {
    key: `i:${i.id}`,
    kind: "inquiry",
    id: i.id,
    number: i.number,
    href: `/inquiries/${i.id}`,
    customerId: i.customerId,
    customerName: customer?.name ?? (i.contactName || "(名前不明)"),
    storeId: i.storeId,
    title: i.summary,
    date: i.receivedAt.slice(0, 10),
    stage,
    detail,
    spec: "none",
    schedule: next ? "fixed" : "undecided",
    scheduleDate: next,
    billing: "na",
    payment: "na",
    closed: lost || i.status === "won" || (i.source === "import" && i.status !== "new" && i.status !== "in_progress"),
    tasks: lost ? [] : [customer ? "" : "顧客の登録・紐づけ", visits.length ? "見積の作成" : "見積日程の決定"].filter(Boolean),
    hasSiteInfo: false,
    text: [i.number, i.summary, i.detail, i.contactName, i.contactPhone, customer?.name, customer?.kana].filter(Boolean).join(" "),
  };
}

/** 案件の一覧 (受注 → 受注になっていない見積 → 見積のない問い合わせ) */
export function buildCases(db: Pick<Database, "orders" | "quotes" | "inquiries" | "customers" | "invoices" | "payments" | "schedule">, inScope: (storeId: StoreId) => boolean, today: string): CaseRow[] {
  const ix = caseIndex(db);
  const rows: CaseRow[] = [];
  const orderedQuotes = new Set<string>();
  for (const o of db.orders) {
    if (!inScope(o.storeId)) continue;
    if (o.quoteId) orderedQuotes.add(o.quoteId);
    rows.push(orderCase(o, ix, today));
  }
  const quotedInquiries = new Set<string>();
  for (const q of db.quotes) {
    if (q.inquiryId) quotedInquiries.add(q.inquiryId);
    if (q.orderId || orderedQuotes.has(q.id) || !inScope(q.storeId)) continue;
    rows.push(quoteCase(q, ix));
  }
  for (const i of db.inquiries) {
    if (i.quoteId || quotedInquiries.has(i.id) || !inScope(i.storeId)) continue;
    rows.push(inquiryCase(i, ix, today));
  }
  return rows;
}

/** よく使う絞り込み */
export const CASE_PRESETS: { key: string; label: string; test: (r: CaseRow) => boolean }[] = [
  { key: "no_customer", label: "顧客情報が未登録の問い合わせ", test: (r) => r.kind === "inquiry" && !r.customerId && !r.closed },
  { key: "visit", label: "見積日程が未定・訪問前", test: (r) => (r.stage === "inquiry" || r.stage === "visit_planned") && !r.closed },
  { key: "waiting", label: "見積済で回答待ち (TEL待ち)", test: (r) => r.spec === "waiting" && !r.closed },
  { key: "spec", label: "一部の仕様が未確定", test: (r) => r.spec === "pending" && !r.closed },
  { key: "schedule", label: "受注・工事日程が未定/調整中", test: (r) => r.stage === "ordered" && r.schedule !== "fixed" && !r.closed },
  { key: "unbilled", label: "工事完了・請求書未発行", test: (r) => r.billing === "unbilled" && !r.closed },
  { key: "unpaid", label: "工事完了・未入金", test: (r) => r.stage === "completed" && (r.payment === "unpaid" || r.payment === "partial") && !r.closed },
  { key: "settle", label: "カード・電子決済の入金待ち", test: (r) => r.payment === "settlement_pending" && !r.closed },
  { key: "office", label: "入金済・事務処理あり", test: (r) => r.payment === "paid" && !r.closed },
];
