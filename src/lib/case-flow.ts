import type { Database, Inquiry, Invoice, Order, Quote } from "@/lib/db/types";
import { SCHEDULE_KIND } from "@/lib/constants";
import { caseIndex, orderCase } from "@/lib/case-status";
import { buildCaseMap, caseHref } from "@/lib/case-group";
import { invoiceOrderIds } from "@/lib/billing";
import { flowIndex, inquiryFlow, requestTargetLabel, dueLabel, jstDate, type InquiryFlow } from "@/lib/inquiry-flow";

/**
 * 案件の流れ (問い合わせ → 依頼 → 日程 → 見積 → 受注 → 施工 → 請求 → 入金) と「次にやること」
 * (お客様のご要望 2026-11-24「■ 問い合わせ受付後の業務フロー ④⑦」: 案件を探し直さずに、いまの画面から次の操作へ進める。
 * 各段階の進み具合と、次に誰が何をするかが一目で分かる)。問い合わせ・見積・受注のどの画面にも同じ表示を出す
 */

export type StepState = "done" | "current" | "todo" | "skip";

export interface FlowStep {
  key: "inquiry" | "request" | "schedule" | "quote" | "order" | "work" | "billing" | "payment";
  label: string;
  state: StepState;
  detail?: string;
  href?: string;
}

export interface CaseFlowView {
  steps: FlowStep[];
  /** 次にやること (ボタン) */
  next?: { text: string; who?: string; href?: string; button?: string; tone?: "critical" | "warn" | "accent" };
  inquiryFlow?: InquiryFlow;
  /** 状況の札 (期限超過・日程未定など) */
  badge?: { label: string; tone: "neutral" | "info" | "accent" | "warn" | "good" | "critical" };
  /** この記録の案件 (案件の画面へのリンク。src/lib/case-group.ts) */
  caseRef?: { id: string; number: string; href: string; inquiries: number; quotes: number; orders: number };
}

const md = (d?: string) => (d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : "");

type FlowDb = Pick<Database, "inquiries" | "quotes" | "orders" | "invoices" | "payments" | "customers" | "schedule" | "threads" | "users" | "stores">;

/** 問い合わせ・見積・受注のどれかから、案件のつながり (問い合わせ ⇄ 見積 ⇄ 受注 ⇄ 請求書) を引く */
export function caseChain(db: FlowDb, from: { inquiryId?: string; quoteId?: string; orderId?: string }): { inquiry?: Inquiry; quote?: Quote; order?: Order; invoices: Invoice[] } {
  let order = from.orderId ? db.orders.find((o) => o.id === from.orderId) : undefined;
  let quote = from.quoteId ? db.quotes.find((q) => q.id === from.quoteId) : order?.quoteId ? db.quotes.find((q) => q.id === order!.quoteId) : undefined;
  let inquiry = from.inquiryId ? db.inquiries.find((i) => i.id === from.inquiryId) : quote?.inquiryId ? db.inquiries.find((i) => i.id === quote!.inquiryId) : undefined;
  if (!quote && inquiry?.quoteId) quote = db.quotes.find((q) => q.id === inquiry!.quoteId);
  if (!order && quote) order = (quote.orderId ? db.orders.find((o) => o.id === quote!.orderId) : undefined) ?? db.orders.find((o) => o.quoteId === quote!.id);
  if (!inquiry && quote?.inquiryId) inquiry = db.inquiries.find((i) => i.id === quote!.inquiryId);
  const invoices = order ? db.invoices.filter((i) => i.status !== "void" && invoiceOrderIds(i).includes(order!.id)) : [];
  return { inquiry, quote, order, invoices };
}

export function caseFlow(db: FlowDb, from: { inquiryId?: string; quoteId?: string; orderId?: string }, now: Date): CaseFlowView {
  const { inquiry, quote, order, invoices } = caseChain(db, from);
  const today = jstDate(now);
  const ix = flowIndex(db);
  const flow = inquiry ? inquiryFlow(inquiry, ix, now) : undefined;
  const inqHref = inquiry ? `/inquiries/${inquiry.id}` : undefined;
  const steps: FlowStep[] = [];

  // 1. 受付
  steps.push({ key: "inquiry", label: "受付", state: inquiry ? "done" : "skip", detail: inquiry ? md(jstDate(new Date(inquiry.receivedAt))) : undefined, href: inqHref });

  // 2. 担当へ依頼 / 3. 日程
  const events = inquiry ? (ix.events.get(inquiry.id) ?? []) : db.schedule.filter((e) => (quote && e.quoteId === quote.id) || (order && e.orderId === order.id));
  const visitEvents = events.filter((e) => SCHEDULE_KIND[e.kind]?.group === "case" && !["pickup", "delivery", "install"].includes(e.kind));
  const firstVisit = visitEvents.slice().sort((a, b) => a.date.localeCompare(b.date))[0];
  const request = flow?.request;
  const beyond = Boolean(quote || order);
  if (inquiry) {
    const requested = Boolean(request);
    steps.push({
      key: "request",
      label: "担当へ依頼",
      state: requested || visitEvents.length || beyond ? (requested ? "done" : "skip") : "current",
      detail: request ? `${requestTargetLabel(request, ix)}${request.dueAt && flow?.state !== "scheduled" && !beyond ? ` · ${dueLabel(request.dueAt, now)}` : ""}` : undefined,
      href: request ? `/messages/${request.id}` : `${inqHref}?tab=request#actions`,
    });
  } else steps.push({ key: "request", label: "担当へ依頼", state: "skip" });
  const scheduleState: StepState = visitEvents.length ? "done" : beyond ? "skip" : inquiry ? (flow?.state === "request_waiting" ? "todo" : "current") : "skip";
  steps.push({
    key: "schedule",
    label: "日程 (見積・現調・現見)",
    state: scheduleState,
    detail: firstVisit ? `${md(firstVisit.date)} ${SCHEDULE_KIND[firstVisit.kind].short}` : flow?.state === "on_hold" ? "日程未定 (お客様都合)" : undefined,
    href: firstVisit ? `/schedule/${firstVisit.id}` : inquiry ? `${inqHref}?tab=schedule#actions` : undefined,
  });

  // 4. 見積
  const onsite = visitEvents.some((e) => e.kind === "onsite_quote");
  steps.push({
    key: "quote",
    label: onsite ? "見積 (現見)" : "見積",
    state: quote ? (["sent", "accepted"].includes(quote.status) || order ? "done" : "current") : order ? "skip" : inquiry?.status === "quoted" ? "done" : visitEvents.some((e) => e.date <= today) ? "current" : "todo",
    detail: quote ? `${quote.number}${quote.status === "draft" ? " 作成中" : quote.status === "pending_approval" ? " 承認待ち" : quote.status === "approved" ? " 承認済・未送付" : ""}` : inquiry?.status === "quoted" ? "見積済 (TEL待ち)" : undefined,
    href: quote ? `/quotes/${quote.id}` : undefined,
  });

  // 5〜8. 受注・施工・請求・入金 (受注の状態は case-status.ts と同じ判定)
  const row = order ? orderCase(order, caseIndex(db), today) : undefined;
  const done = Boolean(order && ["completed", "invoiced", "paid"].includes(order.status));
  steps.push({ key: "order", label: "受注", state: order ? (order.status === "pending_approval" || order.status === "returned" ? "current" : "done") : quote && ["sent", "accepted", "approved"].includes(quote.status) ? "current" : "todo", detail: order ? `${order.number}${order.status === "pending_approval" ? " 契約承認待ち" : order.status === "returned" ? " 差戻し" : ""}` : undefined, href: order ? `/orders/${order.id}` : quote ? `/quotes/${quote.id}#to-order` : undefined });
  steps.push({ key: "work", label: "施工", state: done ? "done" : order && order.status !== "pending_approval" && order.status !== "returned" && order.status !== "cancelled" ? "current" : "todo", detail: order?.completedAt ? `${md(order.completedAt)} 完了` : order?.scheduledStart ? `${md(order.scheduledStart)} 予定` : undefined, href: order ? `/orders/${order.id}#complete` : undefined });
  steps.push({ key: "billing", label: "売上・請求", state: row ? (row.billing === "billed" || row.billing === "not_required" ? (done ? "done" : "todo") : row.billing === "unbilled" ? "current" : "todo") : "todo", detail: order?.salesDate ? `売上 ${md(order.salesDate)}${invoices[0] ? ` · ${invoices[0].number}` : row?.billing === "not_required" ? " · 請求書なし" : ""}` : undefined, href: invoices[0] ? `/invoices/${invoices[0].id}` : order ? `/orders/${order.id}#invoice` : undefined });
  steps.push({ key: "payment", label: "入金", state: row ? (row.payment === "paid" ? "done" : done ? "current" : "todo") : "todo", detail: row && row.paid ? `${Math.round(row.paid).toLocaleString("ja-JP")}円` : undefined, href: invoices[0] ? `/invoices/${invoices[0].id}` : undefined });

  // 次にやること
  let next: CaseFlowView["next"];
  let badge: CaseFlowView["badge"];
  if (order) {
    const task = row?.tasks[0];
    if (order.status === "cancelled") next = { text: "キャンセルした案件です" };
    else if (task) {
      const href = /請求/.test(task) ? `/orders/${order.id}#invoice` : /入金/.test(task) ? (invoices[0] ? `/invoices/${invoices[0].id}` : `/orders/${order.id}`) : /日程/.test(task) ? `/orders/${order.id}#handover` : `/orders/${order.id}`;
      next = { text: task, href, button: /請求/.test(task) ? "請求書へ" : /入金/.test(task) ? "入金を記録" : "受注の画面へ" };
    } else if (!done) next = { text: "施工が終わったら「施工完了を登録」(施工完了日 = 売上計上日)", href: `/orders/${order.id}#complete`, button: "施工完了を登録" };
    else next = { text: "すべての処理が終わっています" };
    badge = row ? { label: row.detail, tone: row.closed ? "good" : "info" } : undefined;
  } else if (quote) {
    const s = quote.status;
    const q = `/quotes/${quote.id}`;
    next =
      s === "draft"
        ? { text: "見積を仕上げて提出 (承認の申請)", href: q, button: "見積を開く" }
        : s === "pending_approval"
          ? { text: "見積の承認待ち (店長・管理者)", href: q }
          : s === "rejected" || s === "expired"
            ? { text: "失注にするか、見積を出し直す", href: q }
            : { text: s === "approved" ? "お客様へ見積を送り、お返事をいただいたら受注登録" : "お客様のお返事をいただいたら受注登録 (または失注)", href: `${q}#to-order`, button: "受注登録へ" };
  } else if (inquiry && flow) {
    badge = { label: flow.label, tone: flow.tone };
    const due = flow.dueAt ? ` (期限: ${dueLabel(flow.dueAt, now)})` : "";
    switch (flow.state) {
      case "request_waiting":
        next = { text: "担当店舗・担当者へ、日程の打ち合わせを依頼する (すぐに日程が決まったら「日程を登録」)", href: `${inqHref}?tab=request#actions`, button: "担当へ依頼", tone: "warn" };
        break;
      case "adjusting":
        next = { text: `${flow.next}${due}`, who: flow.who.join("・"), href: `${inqHref}?tab=schedule#actions`, button: "日程を登録" };
        break;
      case "overdue":
        next = { text: `${flow.next}${due}`, who: flow.who.join("・"), href: `${inqHref}?tab=${inquiry.scheduleHold ? "hold" : flow.request ? "schedule" : "request"}#actions`, button: inquiry.scheduleHold || flow.request ? "日程を登録" : "担当へ依頼", tone: "critical" };
        break;
      case "on_hold":
        next = { text: flow.next, who: flow.who.join("・"), href: `${inqHref}?tab=schedule#actions`, button: "日程を登録" };
        break;
      case "scheduled":
        next = { text: `${flow.next} → 訪問のあと、見積を作成`, who: flow.who.join("・"), href: flow.nextEvent ? `/schedule/${flow.nextEvent.id}` : undefined, button: "予定を見る" };
        break;
      case "visited":
        next = inquiry.customerId
          ? { text: flow.next, who: flow.who.join("・"), href: `/quotes/new?customerId=${inquiry.customerId}&inquiryId=${inquiry.id}&category=${inquiry.category}`, button: "見積を作成", tone: "accent" }
          : { text: "見積の前に、お客様を顧客として登録するか既存の顧客に紐づける", href: `${inqHref}#link-customer`, button: "お客様を登録・紐づけ", tone: "accent" };
        break;
      default:
        next = flow.next ? { text: flow.next, who: flow.who.join("・") || undefined } : undefined;
    }
  }
  // 案件 (問い合わせ・見積・受注をまとめた箱) の画面へのリンク (お客様のご要望 2026-11-26「■4」)
  const map = buildCaseMap(db);
  const caseId = map.caseOf(from.orderId ?? from.quoteId ?? from.inquiryId);
  const m = caseId ? map.members(caseId) : undefined;
  const first = m ? (m.kind === "order" ? m.orders.find((o) => o.id === m.id) : m.kind === "quote" ? m.quotes.find((q) => q.id === m.id) : m.inquiries.find((i) => i.id === m.id)) : undefined;
  const caseRef = m && caseId ? { id: caseId, number: first?.number ?? "", href: caseHref(caseId), inquiries: m.inquiries.length, quotes: m.quotes.length, orders: m.orders.length } : undefined;
  return { steps, next, inquiryFlow: flow, badge, caseRef };
}
