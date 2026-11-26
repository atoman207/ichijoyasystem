import type { Database, Inquiry, Order, Quote } from "@/lib/db/types";
import { CATEGORY_LABEL } from "@/lib/constants";
import { fmtDate } from "@/lib/format";
import { invoiceOfOrder } from "@/lib/billing";
import { parseLedgerItems } from "@/lib/assistant/facts";
import { TAX_MODE_LABEL, taxModeOf } from "@/lib/quote-calc";
import { buildCaseMap, summarizeCase } from "@/lib/case-group";
import { caseIndex, type Stage } from "@/lib/case-status";

/**
 * 顧客の画面の「案件の一覧」のデータ (お客様のご要望 2026-11-25「① 顧客情報画面の表示優先順位」):
 * 受注 + 受注になっていない見積 + 見積のない進行中の問い合わせ。案件ごとに施工内容・明細・金額
 * (受注の明細 = 見積 → 請求書 → 移行した受注は経過メモの「明細 (税抜|税込): …」)。画面は src/components/customers/CustomerCases.tsx
 */

export const OPEN_ORDER = ["pending_approval", "returned", "confirmed", "scheduled", "in_progress"] as const;
const OPEN_INQUIRY = ["new", "in_progress", "quoted"];

export interface CaseLine {
  name: string;
  spec?: string;
  qty: number;
  unit?: string;
  unitPrice: number;
  amount: number;
}

export interface CaseRow {
  key: string;
  date: string;
  dateLabel: string;
  number: string;
  title: string;
  /** 状態 (画面で色つきの札にする) */
  status: { kind: "order" | "quote" | "inquiry"; value: string; invoice?: string };
  total?: number;
  href: string;
  open: boolean;
  site?: string;
  work?: string;
  category?: string;
  lines: CaseLine[];
  linesNote?: string;
  totals?: { label: string; value: number }[];
  links: { label: string; href: string }[];
}

const ledgerNote = (o: Order) => o.progressNotes.find((n) => n.body.includes("\n明細 (") || n.body.startsWith("明細 ("))?.body;

function orderRow(db: Database, o: Order, quotes: Map<string, Quote>): CaseRow {
  const q = o.quoteId ? quotes.get(o.quoteId) : undefined;
  const inv = invoiceOfOrder(db.invoices, o);
  const date = o.salesDate ?? o.scheduledStart ?? o.contractDate;
  let lines: CaseLine[] = [];
  let linesNote: string | undefined;
  let totals: CaseRow["totals"];
  if (q && q.items.length) {
    lines = q.items.map((i) => ({ name: i.name, spec: i.spec, qty: i.qty, unit: i.unit, unitPrice: i.unitPrice, amount: i.amount }));
    linesNote = `見積 ${q.number}${q.version > 1 ? ` 第${q.version}版` : ""} の明細 (${TAX_MODE_LABEL[taxModeOf(q)]})`;
    totals = [
      ...(q.discount > 0 ? [{ label: "値引き", value: -q.discount }] : []),
      ...(q.tax > 0 ? [{ label: "消費税", value: q.tax }] : []),
      { label: "合計", value: q.total },
    ];
  } else if (inv?.items?.length) {
    lines = inv.items.map((i) => ({ name: i.name, spec: i.spec, qty: i.qty, unit: i.unit, unitPrice: i.unitPrice, amount: i.amount }));
    linesNote = `請求書 ${inv.number} の明細`;
    totals = [{ label: "合計", value: inv.total }];
  } else {
    const memo = ledgerNote(o);
    const items = memo ? parseLedgerItems(memo, date) : null;
    if (items?.length) {
      lines = items.map((i) => ({ name: i.product, qty: i.qty, unitPrice: i.unitPrice, amount: i.amount }));
      linesNote = "販売管理ソフトから移行した明細 (税込)";
    }
    totals = [{ label: "合計 (税込)", value: o.total }];
  }
  const links = [{ label: `受注 ${o.number}`, href: `/orders/${o.id}` }];
  if (q) links.push({ label: `見積 ${q.number}`, href: `/quotes/${q.id}` });
  if (inv) links.push({ label: `請求書 ${inv.number}`, href: `/invoices/${inv.id}` });
  return {
    key: o.id,
    date,
    dateLabel: o.salesDate ? `施工完了 ${fmtDate(o.salesDate)}` : o.scheduledStart ? `施工予定 ${fmtDate(o.scheduledStart)}` : `契約 ${fmtDate(o.contractDate)}`,
    number: o.number,
    title: o.title,
    status: { kind: "order", value: o.status, invoice: inv?.status },
    total: o.total,
    href: `/orders/${o.id}`,
    open: (OPEN_ORDER as readonly string[]).includes(o.status),
    site: o.siteAddress || undefined,
    work: o.workDetails || q?.workDetails,
    category: CATEGORY_LABEL[o.category],
    lines,
    linesNote,
    totals,
    links,
  };
}

function quoteRow(q: Quote, inq?: Inquiry): CaseRow {
  return {
    key: q.id,
    date: q.issuedAt ?? q.createdAt.slice(0, 10),
    dateLabel: `見積 ${fmtDate(q.issuedAt ?? q.createdAt)}`,
    number: q.number,
    title: q.title,
    status: { kind: "quote", value: q.status },
    total: q.total,
    href: `/quotes/${q.id}`,
    open: ["draft", "pending_approval", "approved", "sent"].includes(q.status),
    site: q.siteAddress || undefined,
    work: q.workDetails,
    category: CATEGORY_LABEL[q.category],
    lines: q.items.map((i) => ({ name: i.name, spec: i.spec, qty: i.qty, unit: i.unit, unitPrice: i.unitPrice, amount: i.amount })),
    linesNote: `見積の明細 (${TAX_MODE_LABEL[taxModeOf(q)]})`,
    totals: [...(q.discount > 0 ? [{ label: "値引き", value: -q.discount }] : []), ...(q.tax > 0 ? [{ label: "消費税", value: q.tax }] : []), { label: "合計", value: q.total }],
    links: [{ label: `見積 ${q.number}`, href: `/quotes/${q.id}` }, ...(inq ? [{ label: `問い合わせ ${inq.number}`, href: `/inquiries/${inq.id}` }] : [])],
  };
}

function inquiryRow(i: Inquiry): CaseRow {
  return {
    key: i.id,
    date: i.receivedAt.slice(0, 10),
    dateLabel: `受付 ${fmtDate(i.receivedAt)}`,
    number: i.number,
    title: i.summary,
    status: { kind: "inquiry", value: i.status },
    href: `/inquiries/${i.id}`,
    open: OPEN_INQUIRY.includes(i.status),
    site: i.siteAddress || undefined,
    work: i.detail,
    category: CATEGORY_LABEL[i.category],
    lines: [],
    links: [{ label: `問い合わせ ${i.number}`, href: `/inquiries/${i.id}` }],
  };
}

/** お客様の案件 (受注 + 受注になっていない見積 + 見積のない問い合わせ)。新しい順 */
export function customerCaseRows(db: Database, t: { inquiries: Inquiry[]; quotes: Quote[]; orders: Order[] }): CaseRow[] {
  const quotes = new Map(t.quotes.map((q) => [q.id, q]));
  const rows: CaseRow[] = t.orders.filter((o) => o.status !== "cancelled").map((o) => orderRow(db, o, quotes));
  const ordered = new Set(t.orders.map((o) => o.quoteId).filter(Boolean));
  for (const q of t.quotes) if (!ordered.has(q.id) && q.status !== "rejected" && q.status !== "expired") rows.push(quoteRow(q, t.inquiries.find((i) => i.id === q.inquiryId)));
  const quoted = new Set(t.quotes.map((q) => q.inquiryId).filter(Boolean));
  for (const i of t.inquiries) if (!quoted.has(i.id) && OPEN_INQUIRY.includes(i.status)) rows.push(inquiryRow(i));
  return rows.sort((a, b) => b.date.localeCompare(a.date) || b.number.localeCompare(a.number));
}


/* ------------------------------------------------------------------ */
/* 案件ごとにまとめる (お客様のご要望 2026-11-26「■7 顧客詳細画面」)      */
/* ------------------------------------------------------------------ */

export interface CaseGroupRow {
  /** 案件の ID (案件の画面 /cases/<ID>) */
  key: string;
  href: string;
  number: string;
  title: string;
  open: boolean;
  stage: Stage;
  stageLabel: string;
  detail: string;
  date: string;
  dateLabel: string;
  amount?: number;
  amountLabel: string;
  counts: { inquiries: number; quotes: number; orders: number };
  /** 案件の記録 (受注・見積 (受注にならなかった見積も履歴として)・見積のない問い合わせ)。新しい順 */
  records: CaseRow[];
}

/** お客様の案件 (進行中 → 過去)。1 つの案件に問い合わせ・見積・受注がいくつあっても 1 行 */
export function customerCaseGroups(db: Database, t: { inquiries: Inquiry[]; quotes: Quote[]; orders: Order[] }, today: string): CaseGroupRow[] {
  const map = buildCaseMap(db);
  const ix = caseIndex(db);
  const quotes = new Map(t.quotes.map((q) => [q.id, q]));
  const byCase = new Map<string, CaseRow[]>();
  const push = (id: string, row: CaseRow) => {
    const c = map.caseOf(id) ?? id;
    byCase.set(c, [...(byCase.get(c) ?? []), row]);
  };
  const ordered = new Set(t.orders.map((o) => o.quoteId).filter(Boolean));
  for (const o of t.orders) if (o.status !== "cancelled") push(o.id, orderRow(db, o, quotes));
  for (const q of t.quotes) if (!ordered.has(q.id) && !q.orderId) push(q.id, quoteRow(q, t.inquiries.find((i) => i.id === q.inquiryId)));
  const quoted = new Set(t.quotes.map((q) => q.inquiryId).filter(Boolean));
  for (const i of t.inquiries) if (!quoted.has(i.id) && !i.quoteId && !i.deleted) push(i.id, inquiryRow(i));
  const out: CaseGroupRow[] = [];
  for (const [caseId, records] of byCase) {
    const m = map.members(caseId);
    if (!m) continue;
    const s = summarizeCase(m, ix, today);
    records.sort((a, b) => b.date.localeCompare(a.date) || b.number.localeCompare(a.number));
    // 受注のある案件の、受注より前の受注にならなかった見積は履歴 (進行中にしない)
    for (const r of records) if (r.status.kind === "quote" && s.counts.orders > 0 && r.open && !s.rows.some((x) => x.id === r.key && !x.closed)) r.open = false;
    out.push({
      key: caseId,
      href: s.href,
      number: s.number,
      title: s.title,
      open: s.open,
      stage: s.stage,
      stageLabel: s.stageLabel,
      detail: s.detail,
      date: s.lastAt,
      dateLabel: s.startedAt && s.lastAt && s.startedAt !== s.lastAt ? `${fmtDate(s.startedAt)}〜${fmtDate(s.lastAt)}` : fmtDate(s.lastAt || s.startedAt),
      amount: s.amount,
      amountLabel: s.amountLabel,
      counts: s.counts,
      records,
    });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date) || b.number.localeCompare(a.number));
}
