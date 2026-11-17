import { CATEGORY_LABEL, CHANNEL_LABEL, EXPENSE_METHOD_LABEL, PURCHASE_PAY_METHOD_LABEL, ROLE_LABEL, SUPPLIER_KIND_LABEL } from "@/lib/constants";

/**
 * 変更履歴 (監査ログ) の項目名と値の表示
 * ------------------------------------------------------------
 * 監査ログの changes は項目のフィールド名 (英字) で保存する。画面と CSV ではここで日本語にする。
 * 対象 (entity) ごとの名前を優先し、なければ共通の名前、それもなければフィールド名のまま出す
 */

const COMMON: Record<string, string> = {
  name: "名前",
  kana: "フリガナ",
  phone: "電話",
  email: "メール",
  postalCode: "郵便番号",
  address: "住所",
  title: "件名",
  notes: "備考",
  note: "備考",
  description: "内容",
  storeId: "担当店舗",
  status: "状態",
  amount: "金額",
  total: "合計",
  taxAmount: "消費税",
  date: "日付",
  dueDate: "期限",
  category: "種別",
  memo: "メモ",
};

const BY_ENTITY: Record<string, Record<string, string>> = {
  customer: { name: "氏名", kana: "フリガナ", type: "顧客区分", lineId: "LINE ID", area: "地区", assignedUserId: "担当者", preferredChannel: "希望連絡手段", tags: "タグ", notes: "メモ" },
  inquiry: { contactName: "お客様名", contactPhone: "電話", channel: "受付経路", summary: "要件", detail: "詳細", assignedUserId: "担当者", nextAction: "次の対応", nextActionDue: "次の対応の期限", receivedAt: "受付日時", customerId: "顧客" },
  quote: { total: "見積金額 (税込)", title: "件名", items: "明細", validUntil: "有効期限", workDetails: "施工内容" },
  order: { total: "契約金額 (税込)", contractDate: "契約日", siteAddress: "現場住所", workDetails: "施工内容", scheduledStart: "施工開始日", scheduledEnd: "施工終了日", workerIds: "施工担当", billing: "請求書の発行", plannedPayment: "入金の予定方法", specStatus: "仕様", scheduleStatus: "工事日程" },
  invoice: { dueDate: "支払期限", expectedDate: "入金予定日", expectedAmount: "入金予定額", expectedNote: "入金予定のメモ", title: "件名", notes: "備考" },
  expense: { vendor: "支払先", date: "日付", amount: "金額 (税込)", taxAmount: "うち消費税", account: "勘定科目", paymentMethod: "支払方法", description: "内容・用途" },
  purchase: { supplierId: "仕入先", invoiceDate: "請求日", dueDate: "支払期限", scheduledPayDate: "支払予定日", amount: "金額 (税込)", taxAmount: "うち消費税", account: "勘定科目", items: "仕入内容", orderId: "案件", supplierInvoiceNo: "請求書番号", payMethod: "支払方法", payReference: "支払の記録" },
  ai: { question: "質問", answer: "回答", disabled: "無効" },
  settings: { lineGroup: "LINE グループのひも付け (受注 / 協力業者 / 呼び名)" },
  supplier: { kind: "区分", category: "取扱品目", contactName: "担当者", fax: "FAX", paymentTerms: "支払条件 (文章)", closingDay: "締め日", payMonthOffset: "支払月", payDay: "支払日", bankInfo: "振込先", registrationNumber: "登録番号", lineId: "LINE ユーザー ID", chatworkRoomId: "Chatwork ルーム ID", active: "取引中" },
  cash: { direction: "入出金", account: "科目", counterparty: "相手", description: "摘要" },
  schedule: { kind: "種別", startTime: "開始時刻", endTime: "終了時刻", endDate: "終了日", assigneeIds: "担当者", location: "場所", memo: "メモ" },
  user: { role: "ロール", title: "役職", active: "有効", notifyEmail: "通知用メール", notifyByEmail: "メール通知", chatworkAccountId: "Chatwork アカウント ID", email: "ログイン ID", kana: "フリガナ", phone: "電話", avatarKey: "顔写真", signupStatus: "新規登録の申請" },
  thread: { assigneeIds: "依頼先", dueDate: "期限", taskStatus: "依頼の状態" },
};

export function fieldLabel(entity: string, field: string): string {
  return BY_ENTITY[entity]?.[field] ?? COMMON[field] ?? field;
}

const VALUE_LABEL: Record<string, Record<string, string>> = {
  channel: CHANNEL_LABEL,
  preferredChannel: CHANNEL_LABEL,
  category: CATEGORY_LABEL,
  paymentMethod: EXPENSE_METHOD_LABEL,
  payMethod: PURCHASE_PAY_METHOD_LABEL,
  role: ROLE_LABEL,
  kind: SUPPLIER_KIND_LABEL,
  type: { individual: "個人", corporate: "法人" },
  direction: { in: "入金", out: "出金" },
  storeId: { koshi: "合志店", chuo: "中央店", nishi: "西店", tamana: "玉名店", hq: "本社" },
};

/** 値の表示 (空・配列・金額・真偽値・選択肢のラベル) */
export function fieldValue(field: string, v: unknown, names?: Map<string, string>): string {
  if (v === undefined || v === null || v === "") return "(空)";
  if (typeof v === "boolean") return v ? "はい" : "いいえ";
  if (Array.isArray(v)) {
    if (v.length === 0) return "(空)";
    if (v.every((x) => typeof x === "string")) return v.map((x) => names?.get(x) ?? x).join("、");
    return `${v.length} 行`;
  }
  if (typeof v === "object") return JSON.stringify(v).slice(0, 200);
  if (typeof v === "number" && /amount|total|price|Amount|Total|Threshold/.test(field)) return `¥${v.toLocaleString("ja-JP")}`;
  const s = String(v);
  const opts = VALUE_LABEL[field];
  if (opts && opts[s]) return opts[s];
  return names?.get(s) ?? s;
}
