import type { Customer, Database, Invoice, PurchaseInvoice, PurchasePayMethod, StoreId, Supplier } from "@/lib/db/types";
import { allocatePaid, awaitsCompletion, batchTerms, invoiceOrderIds, isRecognizedSale } from "@/lib/billing";
import { payDateOf, termsLabel } from "@/lib/suppliers";
import { PURCHASE_PAY_METHOD_LABEL } from "@/lib/constants";

/**
 * 売掛一覧・買掛一覧 (基準日の残高)
 * ------------------------------------------------------------
 * 売掛: 売上計上日 (= 施工完了日) に計上した売上 − 基準日までの入金。会計データの仕訳 (src/lib/accounting.ts) と同じ範囲:
 *   売上計上の対象の受注 (isRecognizedSale) + 受注で計上できない請求書 (受注がない・移行データの受注の請求書) は請求書の発行日。
 *   請求書の発行の有無 (請求済み / 未請求) と、売上計上日からの経過日数 (年齢) で分ける。まとめ請求の入金は案件に古い順に割り当てる
 * 買掛: 請求日が基準日までの仕入 (却下を除く) − 基準日までに支払完了にしたもの。支払方法は支払完了の方法 → 仕入先のいつもの支払方法。
 *   税理士に渡す買掛一覧は「総合振込」の分だけ (お客様のご説明 2026-11-23。それ以外は通帳から仕訳している)
 */

export const AGING_BUCKETS = [
  { label: "30日以内", max: 30 },
  { label: "31〜60日", max: 60 },
  { label: "61〜90日", max: 90 },
  { label: "91〜180日", max: 180 },
  { label: "181日以上", max: Number.POSITIVE_INFINITY },
] as const;

const DAY = 86_400_000;
const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
const bucketOf = (age: number) => AGING_BUCKETS.findIndex((b) => age <= b.max);

export interface ArLine {
  kind: "order" | "invoice";
  /** 受注 ID (kind = invoice は請求書 ID) */
  id: string;
  number: string;
  title: string;
  customerId: string;
  storeId: StoreId;
  /** 売上計上日 (kind = invoice は請求書の発行日) */
  salesDate: string;
  amount: number;
  paid: number;
  balance: number;
  invoiceId?: string;
  invoiceNumber?: string;
  invoiceDate?: string;
  dueDate?: string;
  invoiced: boolean;
  overdue: boolean;
  ageDays: number;
  bucket: number;
}

export interface ArCustomer {
  customerId: string;
  code: string;
  name: string;
  corporate: boolean;
  batch: boolean;
  storeIds: StoreId[];
  balance: number;
  invoiced: number;
  uninvoiced: number;
  overdue: number;
  buckets: number[];
  oldest?: string;
  lines: ArLine[];
}

export interface ArTotals {
  balance: number;
  invoiced: number;
  uninvoiced: number;
  overdue: number;
  buckets: number[];
  customers: number;
  lines: number;
}

/** 基準日の入金の合計 (請求書ごと) */
function paidUntil(db: Pick<Database, "payments">, asOf: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of db.payments) if (p.date <= asOf) m.set(p.invoiceId, (m.get(p.invoiceId) ?? 0) + p.amount);
  return m;
}

/** 基準日 (asOf) の売掛一覧。inScope で店舗を絞る (画面の権限) */
export function receivablesAsOf(db: Pick<Database, "orders" | "invoices" | "payments" | "customers">, asOf: string, inScope: (storeId: StoreId) => boolean = () => true): { customers: ArCustomer[]; totals: ArTotals } {
  const paid = paidUntil(db, asOf);
  const live = db.invoices.filter((i) => i.status !== "void");
  const byOrder = new Map<string, Invoice[]>();
  for (const i of live) for (const id of invoiceOrderIds(i)) byOrder.set(id, [...(byOrder.get(id) ?? []), i]);
  const recognized = new Set(db.orders.filter(isRecognizedSale).map((o) => o.id));
  const orderMap = new Map(db.orders.map((o) => [o.id, o]));
  const orderOf = (id: string) => orderMap.get(id);
  const lines: ArLine[] = [];
  for (const o of db.orders) {
    if (!recognized.has(o.id) || o.salesDate! > asOf || !inScope(o.storeId)) continue;
    const invs = byOrder.get(o.id) ?? [];
    const got = invs.reduce((a, i) => a + (allocatePaid(i, paid.get(i.id) ?? 0).get(o.id) ?? 0), 0);
    const balance = o.total - got;
    if (balance === 0) continue;
    const inv = invs.filter((i) => i.issueDate <= asOf).sort((a, b) => Number(b.id === o.invoiceId) - Number(a.id === o.invoiceId))[0];
    const age = Math.max(0, days(o.salesDate!, asOf));
    lines.push({ kind: "order", id: o.id, number: o.number, title: o.title, customerId: o.customerId, storeId: o.storeId, salesDate: o.salesDate!, amount: o.total, paid: got, balance, invoiceId: inv?.id, invoiceNumber: inv?.number, invoiceDate: inv?.issueDate, dueDate: inv?.dueDate, invoiced: Boolean(inv), overdue: Boolean(inv && inv.dueDate < asOf && balance > 0), ageDays: age, bucket: bucketOf(age) });
  }
  // 受注で計上できない請求書 (受注がない・移行データの受注など) は請求書の発行日で計上している (会計データと同じ)
  for (const i of live) {
    if (!(i.total > 0) || i.issueDate > asOf || !inScope(i.storeId) || invoiceOrderIds(i).some((id) => recognized.has(id)) || awaitsCompletion(i, orderOf)) continue;
    const got = paid.get(i.id) ?? 0;
    const balance = i.total - got;
    if (balance === 0) continue;
    const age = Math.max(0, days(i.issueDate, asOf));
    lines.push({ kind: "invoice", id: i.id, number: i.number, title: i.title ?? "", customerId: i.customerId, storeId: i.storeId, salesDate: i.issueDate, amount: i.total, paid: got, balance, invoiceId: i.id, invoiceNumber: i.number, invoiceDate: i.issueDate, dueDate: i.dueDate, invoiced: true, overdue: i.dueDate < asOf && balance > 0, ageDays: age, bucket: bucketOf(age) });
  }
  const customers = new Map(db.customers.map((c) => [c.id, c]));
  const rows = new Map<string, ArCustomer>();
  for (const l of lines) {
    const c: Customer | undefined = customers.get(l.customerId);
    const r = rows.get(l.customerId) ?? { customerId: l.customerId, code: c?.code ?? "", name: c?.name ?? "(顧客不明)", corporate: c?.type === "corporate", batch: Boolean(batchTerms(c)), storeIds: [], balance: 0, invoiced: 0, uninvoiced: 0, overdue: 0, buckets: AGING_BUCKETS.map(() => 0), lines: [] };
    r.balance += l.balance;
    if (l.invoiced) r.invoiced += l.balance;
    else r.uninvoiced += l.balance;
    if (l.overdue) r.overdue += l.balance;
    r.buckets[l.bucket] += l.balance;
    if (!r.storeIds.includes(l.storeId)) r.storeIds.push(l.storeId);
    if (!r.oldest || l.salesDate < r.oldest) r.oldest = l.salesDate;
    r.lines.push(l);
    rows.set(l.customerId, r);
  }
  const list = [...rows.values()].filter((r) => r.balance !== 0);
  for (const r of list) r.lines.sort((a, b) => a.salesDate.localeCompare(b.salesDate) || a.number.localeCompare(b.number));
  list.sort((a, b) => b.balance - a.balance || a.name.localeCompare(b.name, "ja"));
  const totals: ArTotals = { balance: 0, invoiced: 0, uninvoiced: 0, overdue: 0, buckets: AGING_BUCKETS.map(() => 0), customers: list.length, lines: 0 };
  for (const r of list) {
    totals.balance += r.balance;
    totals.invoiced += r.invoiced;
    totals.uninvoiced += r.uninvoiced;
    totals.overdue += r.overdue;
    r.buckets.forEach((v, k) => (totals.buckets[k] += v));
    totals.lines += r.lines.length;
  }
  return { customers: list, totals };
}

/* ---------------- 買掛 ---------------- */

/** 買掛一覧の支払方法の絞り込み: bulk = 総合振込だけ (税理士に渡す一覧) / all = すべて / unset = 支払方法が未設定 / それぞれの方法 */
export type ApMethodFilter = "bulk" | "all" | "unset" | PurchasePayMethod;

/** 画面・CSV の絞り込みの値を読む (既定は総合振込だけ = 税理士に渡す買掛一覧) */
export function apMethodFilter(v: string | null | undefined): ApMethodFilter {
  if (v === "all" || v === "unset" || v === "bulk") return v;
  return v && Object.prototype.hasOwnProperty.call(PURCHASE_PAY_METHOD_LABEL, v) ? (v as PurchasePayMethod) : "bulk";
}

export function AP_METHOD_LABEL(m: ApMethodFilter): string {
  return m === "bulk" ? "総合振込の分だけ (税理士に渡す買掛一覧)" : m === "all" ? "すべての支払方法" : m === "unset" ? "支払方法が未設定" : PURCHASE_PAY_METHOD_LABEL[m];
}

/** 仕入の支払方法 (支払完了の方法 → 仕入先のいつもの支払方法。どちらもなければ未設定) */
export function purchaseMethodOf(p: Pick<PurchaseInvoice, "payMethod" | "status">, supplier: Pick<Supplier, "payMethod"> | undefined): PurchasePayMethod | undefined {
  return (p.status === "paid" ? p.payMethod : undefined) ?? supplier?.payMethod;
}

export interface ApLine {
  purchase: PurchaseInvoice;
  method?: PurchasePayMethod;
  payDate: string;
  /** 基準日の時点で支払期限・支払予定日を過ぎている */
  late: boolean;
}

export interface ApSupplier {
  supplierId: string;
  name: string;
  method?: PurchasePayMethod;
  terms: string;
  bankInfo?: string;
  registrationNumber?: string;
  balance: number;
  count: number;
  nextPayDate?: string;
  lines: ApLine[];
}

/** 基準日 (asOf) の買掛一覧。payMonth (YYYY-MM) を指定すると、支払予定日がその月の分だけ */
export function payablesAsOf(
  db: Pick<Database, "purchases" | "suppliers">,
  asOf: string,
  opts: { method?: ApMethodFilter; payMonth?: string; canView?: (p: PurchaseInvoice) => boolean; storeId?: StoreId } = {},
): { suppliers: ApSupplier[]; total: number; count: number; unsetSuppliers: number } {
  const method = opts.method ?? "all";
  const suppliers = new Map(db.suppliers.map((s) => [s.id, s]));
  const rows = new Map<string, ApSupplier>();
  const unset = new Set<string>();
  for (const p of db.purchases) {
    if (p.status === "rejected" || p.invoiceDate > asOf) continue;
    if (p.status === "paid" && p.paidAt && p.paidAt <= asOf) continue;
    if (opts.storeId && p.storeId !== opts.storeId) continue;
    if (opts.canView && !opts.canView(p)) continue;
    const s = suppliers.get(p.supplierId);
    const m = purchaseMethodOf(p, s);
    if (!m) unset.add(p.supplierId);
    if (method === "bulk" ? m !== "bulk_transfer" : method === "unset" ? Boolean(m) : method !== "all" && m !== method) continue;
    const payDate = payDateOf(p);
    if (opts.payMonth && !payDate.startsWith(opts.payMonth)) continue;
    const r = rows.get(p.supplierId) ?? { supplierId: p.supplierId, name: s?.name ?? "(仕入先不明)", method: s?.payMethod, terms: termsLabel(s), bankInfo: s?.bankInfo, registrationNumber: s?.registrationNumber, balance: 0, count: 0, lines: [] };
    r.balance += p.amount;
    r.count += 1;
    if (!r.nextPayDate || payDate < r.nextPayDate) r.nextPayDate = payDate;
    r.lines.push({ purchase: p, method: m, payDate, late: payDate < asOf });
    rows.set(p.supplierId, r);
  }
  const list = [...rows.values()];
  for (const r of list) r.lines.sort((a, b) => a.payDate.localeCompare(b.payDate) || a.purchase.number.localeCompare(b.purchase.number));
  list.sort((a, b) => (a.nextPayDate ?? "").localeCompare(b.nextPayDate ?? "") || b.balance - a.balance);
  return { suppliers: list, total: list.reduce((a, r) => a + r.balance, 0), count: list.reduce((a, r) => a + r.count, 0), unsetSuppliers: unset.size };
}
