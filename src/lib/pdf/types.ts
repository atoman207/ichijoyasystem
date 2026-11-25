/**
 * 帳票 PDF (御見積書・請求書・領収書) の入力データ
 * ------------------------------------------------------------
 * 金額はすべて円の整数。日付は "YYYY-MM-DD"。描画は src/lib/pdf/render.ts
 */

export interface PdfBankAccount { bank: string; branch: string; type: string; number: string; holder: string; holderKana?: string }

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
  /** 非課税 (消費税 0) */
  taxExempt?: boolean;
}

export interface InvoicePdfData {
  number: string; issuedOn: string; dueDate?: string; /** 取引年月日 (work completion / sales date) */ transactionDate?: string;
  /** まとめ請求の締めの期間 (取引年月日の代わりに「取引期間」) */ transactionPeriod?: { from?: string; to: string };
  customerName: string; honorific: "様" | "御中"; customerAddress?: string; siteAddress?: string;
  title: string; orderNumber?: string; items: PdfLine[];
  subtotal: number; discount: number; tax: number; total: number; paidAmount?: number;
  notes?: string; company: PdfCompany;
  /** Voided invoice → big watermark "無効" */ voided?: boolean;
  /** Corrected (訂正) invoice → small label "訂正版" next to the title */ corrected?: boolean;
  /** 単価・小計が税込 (消費税は内税) */
  taxIncluded?: boolean;
  /** 非課税 (消費税 0) */
  taxExempt?: boolean;
}

export interface ReceiptPdfData {
  number: string; issuedOn: string; customerName: string; honorific: "様" | "御中";
  amount: number; /** tax-exclusive amount and tax for the 10% rate breakdown */ taxable: number; tax: number;
  /** e.g. "畳工事代として" */ purpose: string; paymentMethod?: string; invoiceNumber?: string;
  company: PdfCompany; reissue?: boolean;
  /** 再発行の何回目 (2 回目以降の出力。領収書の台帳の出力記録から) */ reissueNo?: number;
  /** 支払方法ごとの内訳 (お客様のご要望 2026-11-25「⑧」。合計 = amount) */ parts?: { label: string; amount: number }[];
  /** 非課税の取引 (内訳を「非課税」で表示) */ taxExempt?: boolean;
}

/**
 * 発注書 (一畳屋の手書きの発注書の様式: 店舗名・仕入先 御中・発注日・担当・FAX、品名・数量・現場名・着日・備考の表)。
 * FAX の標準に合わせて A4 縦。返信 FAX の照合のため、発注番号と受注確認欄を加えている
 */
export interface PurchaseOrderPdfLine {
  name: string; code?: string; spec?: string; qty: number; unit: string;
  /** 現場名 (既定は「名字 様」。showCustomer のときは氏名・住所・電話) と案件番号 */
  site?: string; orderNumber?: string;
  /** 着日 (希望納期 YYYY-MM-DD) */
  arrival?: string;
  notes?: string; unitPrice?: number;
}

export interface PurchaseOrderPdfData {
  number: string; version: number; /** 例: "第2版 (訂正)" */ revisionLabel?: string; issuedOn: string;
  /** 発注元: 会社名・店舗名・担当者・住所・電話・返信先 FAX */
  companyName: string; storeName: string; staffName?: string; storeAddress?: string; storeTel?: string; replyFax?: string;
  supplierName: string; supplierFax?: string; supplierContact?: string;
  deliveryPlace: string; deliveryAddress?: string;
  lines: PurchaseOrderPdfLine[];
  notes?: string;
  /** 下書き → 透かし「下書き」/ 取消 → 透かし「取消」 */
  draft?: boolean; cancelled?: boolean;
}
