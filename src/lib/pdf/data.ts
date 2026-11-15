import "server-only";
import type { Customer, Database, Invoice, Quote, QuoteItem, StoreId } from "@/lib/db/types";
import { documentSettings } from "@/lib/doc-settings";
import { PAYMENT_METHOD_LABEL } from "@/lib/constants";
import type { InvoicePdfData, PdfCompany, PdfLine, QuotePdfData, ReceiptPdfData } from "./types";

/**
 * 帳票 PDF に渡すデータを、見積・請求書・会社情報 (設定 → 帳票) から組み立てる
 */

export function pdfCompany(db: Database, storeId: StoreId): PdfCompany {
  const s = documentSettings(db);
  const store = db.stores.find((x) => x.id === storeId);
  return {
    name: s.companyName,
    postalCode: s.postalCode || undefined,
    address: s.address || undefined,
    tel: s.tel || undefined,
    fax: s.fax || undefined,
    email: s.email || undefined,
    website: s.website || undefined,
    registrationNumber: s.registrationNumber || undefined,
    store: s.showStore && store && store.kind !== "hq" ? { name: store.name, postalCode: store.postalCode, address: store.address, phone: store.phone } : undefined,
    bankAccounts: s.bankAccounts,
  };
}

const honorific = (c: Customer | undefined): "様" | "御中" => (c?.type === "corporate" ? "御中" : "様");
const lines = (items: QuoteItem[]): PdfLine[] => items.map((i) => ({ name: i.name, spec: i.spec, qty: i.qty, unit: i.unit, unitPrice: i.unitPrice, amount: i.amount }));
const day = (iso?: string) => iso?.slice(0, 10);
const joinNotes = (...xs: (string | undefined)[]) => xs.map((x) => x?.trim()).filter(Boolean).join("\n") || undefined;

/** 見積書。version を指定すると、その版 (改訂前の版を含む) の内容で出す */
export function quotePdfData(db: Database, q: Quote, version?: number): QuotePdfData | null {
  const customer = db.customers.find((c) => c.id === q.customerId);
  const order = db.orders.find((o) => o.quoteId === q.id && o.status !== "cancelled");
  const settings = documentSettings(db);
  const staff = db.users.find((u) => u.id === (q.estimatorId ?? q.createdBy))?.name;
  const base = {
    number: q.number,
    customerName: customer?.name ?? "お客様",
    honorific: honorific(customer),
    customerAddress: customer?.address || undefined,
    siteAddress: order?.siteAddress && order.siteAddress !== customer?.address ? order.siteAddress : undefined,
    staffName: staff,
    company: pdfCompany(db, q.storeId),
  };
  if (version === undefined || version === q.version) {
    return {
      ...base,
      version: q.version,
      issuedOn: q.issuedAt ?? day(q.approvedAt) ?? day(q.createdAt)!,
      validUntil: q.validUntil,
      title: q.title,
      workDetails: q.workDetails,
      items: lines(q.items),
      subtotal: q.subtotal,
      discount: q.discount,
      tax: q.tax,
      total: q.total,
      notes: joinNotes(q.notes, settings.quoteNote),
      taxIncluded: q.taxIncluded,
      revisionLabel: q.version > 1 ? `第${q.version}版${q.approvedAt ? ` (${day(q.approvedAt)} 改訂)` : ""}` : undefined,
      draft: q.status === "draft" || q.status === "pending_approval",
    };
  }
  const r = (q.revisions ?? []).find((x) => x.version === version);
  if (!r) return null;
  return {
    ...base,
    version: r.version,
    issuedOn: day(r.approvedAt) ?? day(q.issuedAt) ?? day(q.createdAt)!,
    validUntil: r.validUntil,
    title: r.title,
    workDetails: r.workDetails,
    items: lines(r.items),
    subtotal: r.subtotal,
    discount: r.discount,
    tax: r.tax,
    total: r.total,
    notes: joinNotes(r.notes, settings.quoteNote),
    taxIncluded: r.taxIncluded,
    revisionLabel: `第${r.version}版 (${day(r.replacedAt)} に第${r.version + 1}版へ改訂済み)`,
    draft: false,
  };
}

/** 請求書の明細 (発行時の明細。古い請求書は見積・受注から組み立てる)。明細の合計 − 請求書の小計 = 値引き */
function invoiceLines(db: Database, inv: Invoice): PdfLine[] {
  if (inv.items?.length) return lines(inv.items);
  const order = db.orders.find((o) => o.id === inv.orderId);
  const quote = order?.quoteId ? db.quotes.find((q) => q.id === order.quoteId) : undefined;
  if (quote && quote.total === inv.total) return lines(quote.items);
  // 税込の見積から作った請求書は、明細も税込
  return [{ name: inv.title ?? order?.title ?? "工事代金", qty: 1, unit: "式", unitPrice: inv.subtotal, amount: inv.subtotal }];
}

export function invoicePdfData(db: Database, inv: Invoice): InvoicePdfData {
  const customer = db.customers.find((c) => c.id === inv.customerId);
  const order = db.orders.find((o) => o.id === inv.orderId);
  const settings = documentSettings(db);
  const items = invoiceLines(db, inv);
  const sum = items.reduce((a, i) => a + i.amount, 0);
  const quote = order?.quoteId ? db.quotes.find((q) => q.id === order.quoteId) : undefined;
  const taxIncluded = inv.taxIncluded ?? (!inv.items?.length && quote && quote.total === inv.total ? quote.taxIncluded : undefined);
  return {
    number: inv.number,
    issuedOn: inv.issueDate,
    dueDate: inv.dueDate,
    transactionDate: order?.salesDate ?? day(order?.completedAt),
    customerName: customer?.name ?? "お客様",
    honorific: honorific(customer),
    customerAddress: customer?.address || undefined,
    siteAddress: order?.siteAddress && order.siteAddress !== customer?.address ? order.siteAddress : undefined,
    title: inv.title ?? order?.title ?? "工事代金",
    orderNumber: order?.number,
    items,
    subtotal: sum,
    // 値引き = 明細の合計 − (税抜: 請求の税抜額 / 税込: 請求の合計)
    discount: Math.max(0, sum - (taxIncluded ? inv.total : inv.subtotal)),
    taxIncluded: taxIncluded || undefined,
    tax: inv.tax,
    total: inv.total,
    paidAmount: inv.paidAmount > 0 ? inv.paidAmount : undefined,
    notes: joinNotes(inv.notes, settings.invoiceNote),
    company: pdfCompany(db, inv.storeId),
    voided: inv.status === "void",
  };
}

/** 領収書 (入金済みの金額)。全額入金なら請求書の税額、一部入金なら 10% の内税で計算する */
export function receiptPdfData(db: Database, inv: Invoice): ReceiptPdfData | null {
  if (inv.paidAmount <= 0 || inv.status === "void") return null;
  const customer = db.customers.find((c) => c.id === inv.customerId);
  const order = db.orders.find((o) => o.id === inv.orderId);
  const payments = db.payments.filter((p) => p.invoiceId === inv.id).sort((a, b) => a.date.localeCompare(b.date));
  const full = inv.paidAmount === inv.total;
  const tax = full ? inv.tax : Math.floor((inv.paidAmount * 10) / 110);
  const methods = [...new Set(payments.map((p) => PAYMENT_METHOD_LABEL[p.method]))];
  return {
    number: inv.number.replace(/^INV/, "RCPT"),
    issuedOn: payments.at(-1)?.date ?? inv.issueDate,
    customerName: customer?.name ?? "お客様",
    honorific: honorific(customer),
    amount: inv.paidAmount,
    taxable: inv.paidAmount - tax,
    tax,
    purpose: `${(inv.title ?? order?.title ?? "工事").replace(/代$/, "")}代として`,
    paymentMethod: methods.join("・") || undefined,
    invoiceNumber: inv.number,
    company: pdfCompany(db, inv.storeId),
  };
}

/** ダウンロード時のファイル名 (日本語は RFC 5987 の形で渡す) */
export function pdfHeaders(fileName: string, download: boolean): HeadersInit {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_");
  return {
    "Content-Type": "application/pdf",
    "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  };
}
