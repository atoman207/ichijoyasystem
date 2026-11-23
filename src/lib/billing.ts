import type { Customer, CustomerBillingTerms, Database, Invoice, InvoiceOrderLine, Order, StoreId } from "@/lib/db/types";
import { dueDateFor } from "@/lib/suppliers";

/**
 * 売上計上と請求 (法人のお客様のまとめ請求)
 * ------------------------------------------------------------
 * お客様のご指示 (2026-11-23「■4. 売上計上日と法人のまとめ請求」):
 * - 売上計上日は個人・法人を問わず施工完了日 (Order.salesDate = completedAt)。経営ダッシュボードと会計データの仕訳は同じ日付で数える
 * - 請求書の発行日 (Invoice.issueDate) は売上計上日とは別に持つ。法人のお客様は締め日ごとに完了した案件を 1 枚にまとめて請求する
 * まとめ請求の請求書は orderIds (対象の受注すべて。orderId は 1 件目)・periodFrom / periodTo (締めの期間)・orderLines (案件ごとの行) を持つ。
 * 案件ごとの行は items に入れない (items は案件の明細として売上の分析・管理会計が使うため)。
 * 入金は請求書に登録し、案件には売上計上日の古い順に案件の金額まで割り当てる (allocatePaid)
 */

/* ---------------- 請求書と受注のつながり ---------------- */

/** 請求書が対象とする受注 (まとめ請求は複数。従来の請求書は orderId の 1 件) */
export function invoiceOrderIds(inv: Pick<Invoice, "orderId" | "orderIds">): string[] {
  if (inv.orderIds?.length) return inv.orderIds;
  return inv.orderId ? [inv.orderId] : [];
}

/** まとめ請求の請求書か */
export function isBatchInvoice(inv: Pick<Invoice, "orderIds" | "periodTo" | "orderLines">): boolean {
  return Boolean(inv.periodTo || inv.orderLines?.length || (inv.orderIds?.length ?? 0) > 1);
}

export function invoiceCoversOrder(inv: Pick<Invoice, "orderId" | "orderIds">, orderId: string): boolean {
  return invoiceOrderIds(inv).includes(orderId);
}

/** 受注の有効な請求書 (無効化したものを除く。受注が指している請求書を先に) */
export function liveInvoicesOfOrder(invoices: Invoice[], o: Pick<Order, "id" | "invoiceId">): Invoice[] {
  const list = invoices.filter((i) => i.status !== "void" && invoiceCoversOrder(i, o.id));
  return list.sort((a, b) => Number(b.id === o.invoiceId) - Number(a.id === o.invoiceId));
}

/** 受注の請求書 (表示用。受注が指している請求書 → 有効な請求書 → 無効の請求書) */
export function invoiceOfOrder(invoices: Invoice[], o: Pick<Order, "id" | "invoiceId">): Invoice | undefined {
  return invoices.find((i) => i.id === o.invoiceId && invoiceCoversOrder(i, o.id)) ?? liveInvoicesOfOrder(invoices, o)[0] ?? invoices.find((i) => invoiceCoversOrder(i, o.id));
}

/**
 * 請求書の入金を案件に割り当てる。1 件の請求書は全額をその受注に、まとめ請求は行の順 (売上計上日の古い順) に案件の金額まで埋める
 * (多く入金されたときの残りは最後の案件に)
 */
export function allocatePaid(inv: Pick<Invoice, "orderId" | "orderIds" | "orderLines" | "total">, paid: number): Map<string, number> {
  const out = new Map<string, number>();
  const ids = invoiceOrderIds(inv);
  if (!ids.length) return out;
  const lines = inv.orderLines?.length ? inv.orderLines : ids.length === 1 ? [{ orderId: ids[0], amount: inv.total }] : [];
  if (!lines.length) {
    // 案件ごとの行のないまとめ請求 (通常は作らない): 1 件目に寄せる
    out.set(ids[0], paid);
    return out;
  }
  let rest = paid;
  for (const l of lines) {
    const a = Math.max(0, Math.min(l.amount, rest));
    out.set(l.orderId, (out.get(l.orderId) ?? 0) + a);
    rest -= a;
  }
  if (rest > 0) {
    const last = lines[lines.length - 1].orderId;
    out.set(last, (out.get(last) ?? 0) + rest);
  }
  return out;
}

/** 入金済みの額のうち、その受注の分 */
export function paidForOrder(inv: Pick<Invoice, "orderId" | "orderIds" | "orderLines" | "total">, paid: number, orderId: string): number {
  return allocatePaid(inv, paid).get(orderId) ?? 0;
}

/* ---------------- 売上計上 ---------------- */

/**
 * 売上として計上する受注 (会計データの仕訳・売掛一覧で共通): 売上計上日 (= 施工完了日) があり、キャンセルでなく、金額がある。
 * 販売管理ソフトから移行した過去の受注 (source = import。入金済み・請求書なし) は、移行前の会計で処理済みのため含めない
 */
export function isRecognizedSale(o: Pick<Order, "salesDate" | "status" | "source" | "total">): boolean {
  return Boolean(o.salesDate) && o.status !== "cancelled" && o.source !== "import" && o.total > 0;
}

/** 受注の消費税の計算 (見積の金額が受注と同じなら見積の税 → 受注 1 件の請求書の税 → 10% の内税)。何度も使うときは索引を作る */
export function orderTaxIndex(db: Pick<Database, "quotes" | "invoices">): (o: Pick<Order, "id" | "quoteId" | "total">) => number {
  const quotes = new Map(db.quotes.map((q) => [q.id, q]));
  const single = new Map<string, Invoice>();
  for (const i of db.invoices) if (i.status !== "void" && !isBatchInvoice(i) && i.orderId) single.set(i.orderId, i);
  return (o) => {
    const q = o.quoteId ? quotes.get(o.quoteId) : undefined;
    if (q && q.total === o.total) return q.tax;
    const inv = single.get(o.id);
    if (inv && inv.total === o.total) return inv.tax;
    return o.total - Math.round(o.total / 1.1);
  };
}

/* ---------------- 請求の締め (まとめ請求) ---------------- */

export const CLOSING_DAY_CHOICES = [5, 10, 15, 20, 25, 31] as const;
export const PAY_DAY_CHOICES = [5, 10, 15, 20, 25, 31] as const;
export const PAY_MONTH_LABEL: Record<number, string> = { 0: "当月", 1: "翌月", 2: "翌々月", 3: "3 か月後" };

/** 法人のお客様に初めて設定するときの既定 (月末締め 翌月末払い) */
export const DEFAULT_BILLING_TERMS: CustomerBillingTerms = { batch: true, closingDay: 31, payMonthOffset: 1, payDay: 31 };

const clampDay = (d: unknown, fallback: number) => {
  const n = Math.round(Number(d));
  return Number.isFinite(n) && n >= 1 ? Math.min(31, n) : fallback;
};

/** 値をそろえる (範囲外は既定) */
export function normalizeTerms(t: Partial<CustomerBillingTerms> | undefined): CustomerBillingTerms {
  const offset = Math.round(Number(t?.payMonthOffset));
  return {
    batch: Boolean(t?.batch),
    closingDay: clampDay(t?.closingDay, 31),
    payMonthOffset: [0, 1, 2, 3].includes(offset) ? offset : 1,
    payDay: clampDay(t?.payDay, 31),
    note: t?.note?.trim() ? t.note.trim().slice(0, 200) : undefined,
  };
}

/** まとめ請求の条件 (まとめ請求にしていないお客様は undefined) */
export function batchTerms(c: Pick<Customer, "billingTerms"> | undefined): CustomerBillingTerms | undefined {
  return c?.billingTerms?.batch ? normalizeTerms(c.billingTerms) : undefined;
}

export function usesBatchBilling(c: Pick<Customer, "billingTerms"> | undefined): boolean {
  return Boolean(batchTerms(c));
}

const dayText = (d: number) => (d >= 31 ? "末日" : `${d}日`);

/** 例: 20日締め 翌月末日払い */
export function termsText(t: CustomerBillingTerms): string {
  return `${t.closingDay >= 31 ? "末日" : `${t.closingDay}日`}締め ${PAY_MONTH_LABEL[t.payMonthOffset] ?? `${t.payMonthOffset} か月後`}${dayText(t.payDay)}払い`;
}

const lastDayOf = (y: number, m0: number) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
const ymd = (y: number, m0: number, d: number) => {
  const yy = y + Math.floor(m0 / 12);
  const mm = ((m0 % 12) + 12) % 12;
  return `${String(yy).padStart(4, "0")}-${String(mm + 1).padStart(2, "0")}-${String(Math.min(d, lastDayOf(yy, mm))).padStart(2, "0")}`;
};
const nextDay = (date: string) => {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return t.toISOString().slice(0, 10);
};

/** その月の締め日 (month = YYYY-MM。31 = 末日。2 月の 30 日締めなどは月末) */
export function closingDateInMonth(month: string, closingDay: number): string {
  const [y, m] = month.split("-").map(Number);
  return ymd(y, m - 1, closingDay);
}

/** 締めの期間 (前の締め日の翌日 〜 その月の締め日) */
export function closingPeriod(month: string, closingDay: number): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number);
  const to = closingDateInMonth(month, closingDay);
  const prev = ymd(y, m - 2, closingDay);
  return { from: nextDay(prev), to };
}

/** その日を含む締めの締め日 (例: 20日締め・11/25 → 12/20) */
export function closingDateCovering(date: string, closingDay: number): string {
  const month = date.slice(0, 7);
  const close = closingDateInMonth(month, closingDay);
  if (date <= close) return close;
  const [y, m] = month.split("-").map(Number);
  return ymd(y, m, closingDay);
}

/** まとめ請求の支払期限 (締め日から payMonthOffset か月後の payDay 日) */
export function batchDueDate(closingDate: string, t: CustomerBillingTerms): string {
  return dueDateFor(closingDate, { closingDay: t.closingDay, payMonthOffset: t.payMonthOffset, payDay: t.payDay });
}

/** 受注に有効な請求書があるか */
function hasLiveInvoice(invoices: Invoice[], o: Order): boolean {
  return invoices.some((i) => i.status !== "void" && invoiceCoversOrder(i, o.id));
}

export interface BatchGroup {
  key: string;
  customer: Customer;
  storeId: StoreId;
  terms: CustomerBillingTerms;
  /** 締め日と期間 */
  closingDate: string;
  from: string;
  to: string;
  dueDate: string;
  /** まだ請求していない完了した案件 (売上計上日の順)。earlier = 前の締めの期間の未請求 */
  orders: { order: Order; earlier: boolean }[];
  total: number;
  /** この締めで発行済みのまとめ請求 */
  issued: Invoice[];
}

/**
 * 締め日のまとめ請求の候補 (お客様 × 店舗ごと)。month の締め日までに完了し、まだ請求書のない案件。
 * 請求書は 1 店舗の記録 (売上・入金の部門) のため、ほかの店舗の案件は別の請求書にする
 */
export function batchGroups(db: Pick<Database, "customers" | "orders" | "invoices">, month: string, inScope: (storeId: StoreId) => boolean): BatchGroup[] {
  const groups = new Map<string, BatchGroup>();
  const customers = new Map(db.customers.map((c) => [c.id, c]));
  for (const c of db.customers) {
    const terms = batchTerms(c);
    if (!terms) continue;
    const { from, to } = closingPeriod(month, terms.closingDay);
    for (const inv of db.invoices) {
      if (inv.customerId !== c.id || inv.status === "void" || inv.periodTo !== to || !inScope(inv.storeId)) continue;
      const key = `${c.id}|${inv.storeId}`;
      const g = groups.get(key) ?? { key, customer: c, storeId: inv.storeId, terms, closingDate: to, from, to, dueDate: batchDueDate(to, terms), orders: [], total: 0, issued: [] };
      g.issued.push(inv);
      groups.set(key, g);
    }
  }
  for (const o of db.orders) {
    const c = customers.get(o.customerId);
    const terms = batchTerms(c);
    if (!c || !terms || o.status !== "completed" || !isRecognizedSale(o) || !inScope(o.storeId)) continue;
    const { from, to } = closingPeriod(month, terms.closingDay);
    if (o.salesDate! > to || hasLiveInvoice(db.invoices, o)) continue;
    const key = `${c.id}|${o.storeId}`;
    const g = groups.get(key) ?? { key, customer: c, storeId: o.storeId, terms, closingDate: to, from, to, dueDate: batchDueDate(to, terms), orders: [], total: 0, issued: [] };
    g.orders.push({ order: o, earlier: o.salesDate! < from });
    g.total += o.total;
    groups.set(key, g);
  }
  for (const g of groups.values()) g.orders.sort((a, b) => a.order.salesDate!.localeCompare(b.order.salesDate!) || a.order.number.localeCompare(b.order.number));
  return [...groups.values()].sort((a, b) => a.customer.name.localeCompare(b.customer.name, "ja") || a.storeId.localeCompare(b.storeId));
}

/** 締めの設定がない法人のお客様のうち、請求書のない完了した案件があるお客様 (まとめ請求の画面で案内する) */
export function corporateWithoutTerms(db: Pick<Database, "customers" | "orders" | "invoices">, inScope: (storeId: StoreId) => boolean): { customer: Customer; count: number; total: number }[] {
  const out = new Map<string, { customer: Customer; count: number; total: number }>();
  const customers = new Map(db.customers.map((c) => [c.id, c]));
  for (const o of db.orders) {
    const c = customers.get(o.customerId);
    if (!c || c.type !== "corporate" || c.billingTerms || o.status !== "completed" || !isRecognizedSale(o) || !inScope(o.storeId) || hasLiveInvoice(db.invoices, o)) continue;
    const r = out.get(c.id) ?? { customer: c, count: 0, total: 0 };
    r.count += 1;
    r.total += o.total;
    out.set(c.id, r);
  }
  return [...out.values()].sort((a, b) => b.total - a.total);
}

const jpDate = (d: string) => `${Number(d.slice(0, 4))}年${Number(d.slice(5, 7))}月${Number(d.slice(8, 10))}日`;

/** まとめ請求の件名 (例: 2026年11月20日締め ご請求分 (3 件)) */
export function batchTitle(closingDate: string, count: number): string {
  return `${jpDate(closingDate)}締め ご請求分 (${count} 件)`;
}

/**
 * まとめ請求の金額: 行は案件ごとの税込の金額 (= 受注の金額。売上計上と同じ額)、合計 = 行の合計。
 * 消費税は請求書の 10% 対象 (税込) の合計から 1 回だけ計算する (内税・切り捨て。インボイスの端数処理は請求書ごとに 1 回)
 */
export function batchAmounts(lines: Pick<InvoiceOrderLine, "amount" | "noTax">[]): { subtotal: number; tax: number; total: number } {
  const total = lines.reduce((a, l) => a + l.amount, 0);
  const taxable = lines.filter((l) => !l.noTax).reduce((a, l) => a + l.amount, 0);
  const tax = Math.floor((Math.max(0, taxable) * 10) / 110);
  return { subtotal: total - tax, tax, total };
}

/** 案件ごとの行 (売上計上日の順) */
export function batchLines(db: Pick<Database, "quotes" | "invoices">, customer: Pick<Customer, "address"> | undefined, orders: Order[]): InvoiceOrderLine[] {
  const taxOf = orderTaxIndex(db);
  return [...orders]
    .sort((a, b) => (a.salesDate ?? "").localeCompare(b.salesDate ?? "") || a.number.localeCompare(b.number))
    .map((o) => ({
      orderId: o.id,
      number: o.number,
      title: o.title,
      site: o.siteAddress && o.siteAddress !== customer?.address ? o.siteAddress : undefined,
      completedAt: o.completedAt,
      salesDate: o.salesDate,
      amount: o.total,
      noTax: taxOf(o) === 0 ? true : undefined,
    }));
}

/**
 * 入金のあと、請求書の対象の受注を入金済みにする (mutate の中で呼ぶ)。
 * 1 件の請求書は請求書が入金済みになったとき、まとめ請求は割り当てた入金が受注の金額に届いた案件 (売上計上日の古い順)
 */
export function settleInvoiceOrders(db: Pick<Database, "orders">, inv: Invoice, now: string): string[] {
  const ids = new Set(invoiceOrderIds(inv));
  const alloc = allocatePaid(inv, inv.paidAmount);
  const done: string[] = [];
  for (const o of db.orders) {
    if (!ids.has(o.id) || o.status === "cancelled" || o.status === "paid") continue;
    const full = isBatchInvoice(inv) ? (alloc.get(o.id) ?? 0) >= o.total : inv.status === "paid";
    if (!full) continue;
    o.status = "paid";
    o.updatedAt = now;
    done.push(o.id);
  }
  return done;
}
