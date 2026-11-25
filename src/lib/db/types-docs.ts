import type { StoreId } from "./types";

/**
 * 帳票の出力記録と領収書の発行台帳の型 (お客様のご要望 2026-11-25「⑥ 帳票出力」「⑦ 一括印刷」「⑧ 領収書の支払内訳」)
 * ------------------------------------------------------------
 * 出力記録 (doc_outputs): 見積書・請求書・領収書の PDF を開いた・保存した・まとめて印刷したときに 1 行 (誰が・いつ・どの帳票・どの案件・何回目)。
 *   帳票の出力は記録を見られる社員なら誰でもでき (金額・請求・入金を変える権限とは別)、2 回目からは「再発行」として数える。src/lib/doc-outputs.ts
 * 領収書 (receipts): 請求書 1 枚に対して発行した領収書 (支払方法ごとの内訳・宛名・但し書き)。番号は R-年-連番。
 *   内訳の合計 = 領収金額でないと発行しない。請求書の金額を超える発行 (二重発行) は断る。取り消し (void) は理由つき・作り直しは前の領収書を残す。
 *   入金の記録 (payments) と比べて、入金が未記録・支払方法の違いを知らせる。src/lib/receipts.ts
 */

/** 領収書の支払方法 (お客様のご要望 2026-11-25「⑧」: 現金・商品券・カード・電子決済・振込・その他 (自由記載)) */
export type ReceiptMethod = "cash" | "voucher" | "card" | "epay" | "transfer" | "other";

export interface ReceiptPart {
  method: ReceiptMethod;
  amount: number;
  /** その他の支払方法の名前・メモ (例: 地域振興券) */
  note?: string;
}

export interface Receipt {
  id: string;
  /** 領収書の番号 (R-2026-0001) */
  number: string;
  invoiceId: string;
  orderId?: string;
  customerId: string;
  storeId: StoreId;
  /** 領収日 (発行日) */
  issueDate: string;
  /** 宛名 (敬称は honorific) */
  addressee: string;
  honorific: "様" | "御中";
  /** 但し書き (例: 畳工事代として) */
  purpose: string;
  /** 領収金額 (税込) とうち消費税 */
  amount: number;
  tax: number;
  taxExempt?: boolean;
  /** 支払方法ごとの内訳 (合計 = amount) */
  parts: ReceiptPart[];
  status: "issued" | "void";
  /** 作り直したときの前の領収書 */
  replacesId?: string;
  voidReason?: string;
  voidedAt?: string;
  voidedBy?: string;
  note?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export type DocOutputKind = "quote" | "invoice" | "receipt";

export interface DocOutput {
  id: string;
  kind: DocOutputKind;
  /** 見積・請求書・領収書の ID と番号 */
  refId: string;
  number: string;
  /** 見積の版 */
  version?: number;
  storeId: StoreId;
  customerId?: string;
  /** 対象の案件 (受注) */
  orderId?: string;
  at: string;
  userId: string;
  /** 0 = 最初の出力、1 以上 = 再発行の何回目 */
  reissue: number;
  /** view = 画面で開いた / download = 保存 / batch = まとめて印刷 */
  via: "view" | "download" | "batch";
  /** 納品書 (kind = invoice・refId = 受注の ID。請求書と同じ内容で表題が「納品書」。お客様のご要望 2026-11-25) */
  doc?: "delivery";
}
