/**
 * 帳票 PDF (御見積書・請求書・領収書) の入力データ
 * ------------------------------------------------------------
 * 金額はすべて円の整数。日付は "YYYY-MM-DD"。描画は src/lib/pdf/render.ts
 */

export interface PdfBankAccount { bank: string; branch: string; type: string; number: string; holder: string }

export interface PdfCompany {
  name: string; postalCode?: string; address?: string; tel?: string; fax?: string; email?: string; website?: string;
  /** 適格請求書発行事業者の登録番号 (T + 13 digits). Empty/undefined = not printed */
  registrationNumber?: string;
  /** The store in charge of the case (printed under the company block when present) */
  store?: { name: string; postalCode?: string; address?: string; phone?: string };
  bankAccounts: PdfBankAccount[];
}

export interface PdfLine { name: string; spec?: string; qty: number; unit: string; unitPrice: number; amount: number }

export interface QuotePdfData {
  number: string; version: number; issuedOn: string /* YYYY-MM-DD */; validUntil?: string;
  customerName: string; honorific: "様" | "御中"; customerAddress?: string; siteAddress?: string;
  title: string; workDetails?: string; items: PdfLine[];
  subtotal: number; discount: number; tax: number; total: number; // yen integers; tax = 10% of (subtotal - discount)
  notes?: string; staffName?: string; company: PdfCompany;
  /** e.g. "第2版 (2026-11-14 改訂)"; printed near the number when version > 1 */
  revisionLabel?: string;
  /** Not yet approved → light diagonal watermark "下書き (承認前)" */
  draft?: boolean;
  /** 単価・小計が税込 (消費税は内税) */
  taxIncluded?: boolean;
}

export interface InvoicePdfData {
  number: string; issuedOn: string; dueDate?: string; /** 取引年月日 (work completion / sales date) */ transactionDate?: string;
  customerName: string; honorific: "様" | "御中"; customerAddress?: string; siteAddress?: string;
  title: string; orderNumber?: string; items: PdfLine[];
  subtotal: number; discount: number; tax: number; total: number; paidAmount?: number;
  notes?: string; company: PdfCompany;
  /** Voided invoice → big watermark "無効" */ voided?: boolean;
  /** Corrected (訂正) invoice → small label "訂正版" next to the title */ corrected?: boolean;
  /** 単価・小計が税込 (消費税は内税) */
  taxIncluded?: boolean;
}

export interface ReceiptPdfData {
  number: string; issuedOn: string; customerName: string; honorific: "様" | "御中";
  amount: number; /** tax-exclusive amount and tax for the 10% rate breakdown */ taxable: number; tax: number;
  /** e.g. "畳工事代として" */ purpose: string; paymentMethod?: string; invoiceNumber?: string;
  company: PdfCompany; reissue?: boolean;
}
