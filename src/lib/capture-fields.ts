import type { DocumentKind } from "@/lib/db/types";
import { MEDIA_OPTIONS, PRIORITY_OPTIONS } from "@/lib/survey";
import { SITE_FIELDS } from "@/lib/site-info";

/**
 * 書類取込の確認画面に出す項目 (書類の種類ごと)
 * 項目名は AI の読取項目 (src/lib/ai/ocr.ts の SCHEMAS) と同じにする
 */

export type FieldType = "text" | "textarea" | "date" | "money" | "account" | "payment" | "lines" | "score" | "multi" | "yesno" | "choice" | "number";

export interface FieldSpec {
  key: string;
  label: string;
  type: FieldType;
  wide?: boolean;
  placeholder?: string;
  /** この項目の前に出す見出し (項目のまとまり) */
  heading?: string;
  /** multi (複数選択) の選択肢 */
  options?: readonly string[];
}

export type ColumnType = "text" | "number" | "money" | "fittingKind" | "flag";

export interface TableSpec {
  key: "items" | "rooms" | "fittings" | "fields";
  label: string;
  columns: { key: string; label: string; type: ColumnType; width?: string }[];
}

/** 手書き見積書の明細 (読みにくい行に「要確認」) */
export const HW_ITEM_TABLE: TableSpec = {
  key: "items",
  label: "明細 (〃 は上の行の内容に置き換えています。▲ の値引きはマイナス)",
  columns: [
    { key: "name", label: "品名", type: "text", width: "minmax(8rem,2fr)" },
    { key: "spec", label: "規格・仕様", type: "text", width: "minmax(7rem,2fr)" },
    { key: "qty", label: "数量", type: "number", width: "4rem" },
    { key: "unit", label: "単位", type: "text", width: "3rem" },
    { key: "unitPrice", label: "単価", type: "money", width: "5.5rem" },
    { key: "amount", label: "金額", type: "money", width: "6rem" },
    { key: "uncertain", label: "要確認", type: "flag", width: "3.5rem" },
  ],
};

export const ITEM_TABLE = (label = "明細"): TableSpec => ({
  key: "items",
  label,
  columns: [
    { key: "name", label: "品名・作業", type: "text", width: "minmax(9rem,2fr)" },
    { key: "spec", label: "仕様・銘柄", type: "text", width: "minmax(6rem,1fr)" },
    { key: "qty", label: "数量", type: "number", width: "4.5rem" },
    { key: "unit", label: "単位", type: "text", width: "3.5rem" },
    { key: "unitPrice", label: "単価", type: "money", width: "6rem" },
    { key: "amount", label: "金額", type: "money", width: "6.5rem" },
  ],
});

const ROOM_TABLE: TableSpec = {
  key: "rooms",
  label: "部屋",
  columns: [
    { key: "name", label: "部屋", type: "text", width: "minmax(7rem,1fr)" },
    { key: "size", label: "広さ", type: "text", width: "5rem" },
    { key: "widthMm", label: "幅 mm", type: "number", width: "5rem" },
    { key: "depthMm", label: "奥行 mm", type: "number", width: "5rem" },
    { key: "tatamiCount", label: "畳数", type: "number", width: "4.5rem" },
  ],
};

const FITTING_TABLE: TableSpec = {
  key: "fittings",
  label: "建具 (襖・障子・網戸など)",
  columns: [
    { key: "kind", label: "種類", type: "fittingKind", width: "5.5rem" },
    { key: "name", label: "場所", type: "text", width: "minmax(6rem,1fr)" },
    { key: "count", label: "枚数", type: "number", width: "4rem" },
    { key: "widthMm", label: "幅 mm", type: "number", width: "5rem" },
    { key: "heightMm", label: "高さ mm", type: "number", width: "5rem" },
  ],
};

const FIELDS_TABLE: TableSpec = {
  key: "fields",
  label: "そのほかの項目",
  columns: [
    { key: "label", label: "見出し", type: "text", width: "minmax(6rem,1fr)" },
    { key: "value", label: "内容", type: "text", width: "minmax(9rem,2fr)" },
  ],
};

export const FITTING_KINDS = ["襖", "障子", "網戸", "戸", "窓", "その他"] as const;

export interface KindLayout {
  top: FieldSpec[];
  tables: TableSpec[];
  bottom: FieldSpec[];
}

export const CAPTURE_LAYOUT: Record<DocumentKind, KindLayout> = {
  handwritten_quote: {
    top: [
      { key: "customerName", label: "氏名", type: "text", heading: "お客様・見積" },
      { key: "furigana", label: "ふりがな", type: "text" },
      { key: "phone", label: "Tel", type: "text" },
      { key: "siteAddress", label: "住所", type: "text" },
      { key: "quoteDate", label: "見積日", type: "date" },
      { key: "paperNo", label: "見積書の No.", type: "text" },
      { key: "staffName", label: "担当者 (書かれた名前)", type: "text" },
      { key: "title", label: "件名", type: "text", wide: true, placeholder: "例: 和室6畳 畳表替え・襖張替え" },
      { key: "pickupAt", label: "引取日時", type: "text", heading: "引取・納品・支払い" },
      { key: "deliveryAt", label: "納品日時", type: "text" },
      { key: "paymentMethod", label: "支払い方法 (納品時)", type: "choice", options: ["現金", "カード", "PayPay", "振込", "訪問集金", "その他"] },
      { key: "paymentNote", label: "支払いの補足 (VISA など)", type: "text" },
    ],
    tables: [HW_ITEM_TABLE],
    bottom: [
      { key: "taxMode", label: "単価・小計は", type: "choice", options: ["税込", "税抜"], heading: "合計" },
      { key: "totalTaxIncluded", label: "税込合計金額 (見積書の上部)", type: "money" },
      { key: "subtotal", label: "小計", type: "money" },
      { key: "discount", label: "値引き (明細とは別)", type: "money" },
      { key: "tax", label: "消費税", type: "money" },
      { key: "total", label: "合計", type: "money" },
      { key: "note", label: "備考", type: "textarea", wide: true, heading: "備考欄以下 (現場情報・引継ぎ事項。受注・施工担当者に引き継ぎます)" },
      ...SITE_FIELDS.filter((f) => !["pickupAt", "deliveryAt", "paymentMethod", "paymentNote", "remarks"].includes(f.key)).map((f) => ({ key: f.key, label: f.label, type: f.type as FieldType, options: f.options, wide: f.wide })),
    ],
  },
  drawing: {
    top: [
      { key: "siteName", label: "現場名・お客様", type: "text" },
      { key: "siteAddress", label: "現場住所", type: "text" },
      { key: "drawingDate", label: "日付", type: "date" },
    ],
    tables: [ROOM_TABLE, FITTING_TABLE, ITEM_TABLE("見積に使う作業の候補")],
    bottom: [
      { key: "measurements", label: "そのほかの寸法・書き込み (1 行に 1 つ)", type: "lines", wide: true },
      { key: "note", label: "備考", type: "textarea", wide: true },
    ],
  },
  site_document: {
    top: [
      { key: "title", label: "書類名・件名", type: "text", wide: true },
      { key: "documentDate", label: "書類の日付", type: "date" },
      { key: "partnerName", label: "発行元・取引先", type: "text" },
      { key: "customerName", label: "お客様・施主", type: "text" },
      { key: "siteAddress", label: "現場住所", type: "text" },
      { key: "workDate", label: "施工予定日", type: "date" },
    ],
    tables: [ITEM_TABLE("作業・材料")],
    bottom: [
      { key: "amount", label: "金額の合計", type: "money" },
      { key: "instructions", label: "作業の指示・仕様", type: "textarea", wide: true },
      { key: "note", label: "備考", type: "textarea", wide: true },
    ],
  },
  supplier_invoice: {
    top: [
      { key: "supplier", label: "請求元 (仕入先・業者)", type: "text" },
      { key: "invoiceNumber", label: "請求書番号", type: "text" },
      { key: "invoiceDate", label: "請求日", type: "date" },
      { key: "dueDate", label: "支払期限", type: "date" },
      { key: "registrationNumber", label: "登録番号 (T + 13 桁)", type: "text" },
    ],
    tables: [ITEM_TABLE()],
    bottom: [
      { key: "subtotal", label: "税抜の合計", type: "money" },
      { key: "taxAmount", label: "消費税", type: "money" },
      { key: "amount", label: "請求金額 (税込)", type: "money" },
      { key: "note", label: "振込先・備考", type: "textarea", wide: true },
    ],
  },
  receipt: {
    top: [
      { key: "vendor", label: "支払先 (店名)", type: "text" },
      { key: "date", label: "日付", type: "date" },
      { key: "account", label: "勘定科目", type: "account" },
      { key: "paymentMethod", label: "支払方法", type: "payment" },
      { key: "registrationNumber", label: "登録番号 (T + 13 桁)", type: "text" },
    ],
    tables: [ITEM_TABLE("品目")],
    bottom: [
      { key: "amount", label: "支払金額 (税込)", type: "money" },
      { key: "taxAmount", label: "うち消費税", type: "money" },
      { key: "note", label: "但し書き・備考", type: "textarea", wide: true },
    ],
  },
  contract: {
    top: [
      { key: "customerName", label: "契約者 (お客様)", type: "text" },
      { key: "contractDate", label: "契約日", type: "date" },
      { key: "title", label: "工事名・件名", type: "text", wide: true },
      { key: "siteAddress", label: "現場住所", type: "text" },
    ],
    tables: [ITEM_TABLE()],
    bottom: [
      { key: "amount", label: "契約金額 (税込)", type: "money" },
      { key: "note", label: "特記事項・支払条件", type: "textarea", wide: true },
    ],
  },
  survey_postcard: {
    top: [
      { key: "postcardNo", label: "はがき No.", type: "text", placeholder: "例: 13338 / T698" },
      { key: "answeredOn", label: "回答日", type: "date" },
      { key: "phoneScore", label: "① 電話対応 (事務の評価)", type: "score" },
      { key: "salesScore", label: "② 営業担当者の対応 (営業担当の評価)", type: "score" },
      { key: "craftsmanScore", label: "③ 職人の対応 (担当職人の評価)", type: "score" },
      { key: "finishScore", label: "④ 工事の仕上がり (店舗の評価)", type: "score" },
      { key: "priorityList", label: "⑤ ご利用にあたって重視されたこと (複数)", type: "multi", options: PRIORITY_OPTIONS, wide: true },
      { key: "priorityOther", label: "⑤ その他の内容", type: "text", wide: true },
      { key: "mediaList", label: "⑥ 何を見てご依頼いただきましたか (複数)", type: "multi", options: MEDIA_OPTIONS, wide: true },
      { key: "mediaOther", label: "⑥ その他の内容", type: "text", wide: true },
      { key: "wouldUseAgain", label: "⑦ 次回も依頼したいか", type: "yesno" },
      { key: "salesName", label: "営業担当 (はがきの記入)", type: "text" },
      { key: "craftsmanName", label: "工事担当 (はがきの記入)", type: "text" },
    ],
    tables: [],
    bottom: [{ key: "comment", label: "⑧ ご指摘・お褒めの言葉", type: "textarea", wide: true }],
  },
  // 受付メモは受付の画面 (/inquiries/reception) で確かめる。書類取込の画面からは開かない
  reception: {
    top: [
      { key: "customerName", label: "お名前", type: "text" },
      { key: "phone", label: "電話番号", type: "text" },
      { key: "address", label: "住所", type: "text", wide: true },
      { key: "summary", label: "用件", type: "text", wide: true },
    ],
    tables: [],
    bottom: [{ key: "detail", label: "内容", type: "textarea", wide: true }],
  },
  other: {
    top: [
      { key: "title", label: "件名", type: "text", wide: true },
      { key: "documentDate", label: "日付", type: "date" },
      { key: "partnerName", label: "取引先・発行元", type: "text" },
    ],
    tables: [FIELDS_TABLE, ITEM_TABLE()],
    bottom: [{ key: "summary", label: "内容の要約", type: "textarea", wide: true }],
  },
};

/** 読取結果から進める登録先 (見積・経費・仕入請求書の作成画面) */
export type RegisterTarget = "quote" | "expense" | "purchase" | "survey";

export const REGISTER_TARGETS: Record<DocumentKind, RegisterTarget[]> = {
  handwritten_quote: ["quote"],
  drawing: ["quote"],
  site_document: ["quote"],
  supplier_invoice: ["purchase"],
  receipt: ["expense"],
  contract: ["quote"],
  survey_postcard: ["survey"],
  reception: [],
  other: [],
};

/** 受注・問い合わせ・顧客に保存できる書類 (図面・施工資料など) */
export const ATTACHABLE_KINDS: DocumentKind[] = ["drawing", "site_document", "handwritten_quote", "contract", "other"];

export const REGISTER_LABEL: Record<RegisterTarget, string> = {
  quote: "見積を作成",
  expense: "経費として登録",
  purchase: "仕入請求書として登録",
  survey: "アンケートとして登録",
};
