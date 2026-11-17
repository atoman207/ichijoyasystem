/**
 * ドメインモデル定義
 * ------------------------------------------------------------
 * 社内のあらゆる情報を「一つの基盤」に集約するための型定義。
 * 外部との入口 (Channel) は複数あっても、ここで定義した
 * エンティティ同士が ID で関連付き、1 か所の更新が全画面に反映される。
 */

export type Role = "admin" | "store_manager" | "store_staff" | "hq_staff";

/** 店舗 ID (4 店舗 + 本社/坪井ショールーム) */
export type StoreId = "koshi" | "chuo" | "nishi" | "tamana" | "hq";

export interface Store {
  id: StoreId;
  code: string;
  name: string;
  shortName: string;
  kind: "store" | "hq";
  postalCode: string;
  address: string;
  phone: string;
  managerUserId?: string;
  /** グラフ・バッジ用の系列色 (固定順・入れ替えない) */
  color: string;
}

export interface User {
  id: string;
  name: string;
  kana: string;
  /** ログイン ID (メールアドレスまたは社員ごとの ID) */
  email: string;
  /** デモ (サンプルデータ) 用の平文パスワード。本番データでは使わない */
  password?: string;
  /** 本番データのパスワード (scrypt ハッシュ) */
  passwordHash?: string;
  role: Role;
  storeId: StoreId;
  title: string;
  phone?: string;
  active: boolean;
  /** 入社日 */
  hiredOn?: string;
  /** 通知を受け取るメールアドレス (ログイン ID がメールアドレスでない社員も設定できる) */
  notifyEmail?: string;
  /** メールで通知を受け取る (承認依頼・承認結果・メンション・業務依頼) */
  notifyByEmail?: boolean;
  /** Chatwork のアカウント ID (社内ルームへの通知で [To] に使う) */
  chatworkAccountId?: string;
  /** 顔写真 (Storage のキー)。画面では /api/avatars/<ID>?v=<avatarUpdatedAt> で表示する */
  avatarKey?: string;
  avatarUpdatedAt?: string;
  /** 新規登録の申請中 (承認されるまで active = false。承認すると消える) */
  signupStatus?: "pending";
  signupRequestedAt?: string;
  /** 申請時の連絡事項 (所属・入社予定など) */
  signupNote?: string;
}

/** 情報の入口 / 出口 */
export type Channel =
  | "phone"
  | "ai_phone"
  /** AI テキスト相談 (既存の AI チャット相談からの連携) */
  | "ai_chat"
  /** AI 音声相談 (既存の AI 音声相談からの連携) */
  | "ai_voice"
  | "web"
  | "email"
  | "line"
  | "chatwork"
  | "visit"
  | "mail"
  | "event"
  | "referral"
  | "unknown";

/** 取込データの出どころ (app = システムで登録 / import = 既存の台帳・スプレッドシートから移行) */
export type RecordSource = "app" | "import";

export type CustomerType = "individual" | "corporate";

export interface Customer {
  id: string;
  code: string;
  name: string;
  kana: string;
  type: CustomerType;
  phone: string;
  email?: string;
  lineId?: string;
  postalCode: string;
  address: string;
  /** 地区 (売上台帳・予定表の「地区」欄) */
  area?: string;
  storeId: StoreId;
  assignedUserId?: string;
  preferredChannel: Channel;
  firstContactChannel: Channel;
  tags: string[];
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export type ServiceCategory =
  | "tatami"
  | "fusuma"
  | "shoji"
  | "amido"
  | "curtain"
  | "cloth"
  | "other";

export type InquiryStatus =
  | "new"
  | "in_progress"
  | "quoted"
  | "won"
  | "lost"
  | "closed";

export interface Inquiry {
  id: string;
  number: string;
  customerId?: string;
  contactName: string;
  contactPhone?: string;
  channel: Channel;
  storeId: StoreId;
  category: ServiceCategory;
  summary: string;
  detail: string;
  status: InquiryStatus;
  assignedUserId?: string;
  receivedAt: string;
  nextAction?: string;
  nextActionDue?: string;
  quoteId?: string;
  createdBy: string;
  updatedAt: string;
  area?: string;
  /** TEL待ちリストの「結果」欄 (施工・キャンセルなど) */
  result?: string;
  source?: RecordSource;
  /** 取込元 (ファイル#シート!行) */
  sourceRef?: string;
}

export interface Product {
  id: string;
  category: ServiceCategory;
  name: string;
  grade?: string;
  unit: string;
  unitPrice: number;
  sizeLabel?: string;
  description?: string;
  active: boolean;
}

export interface QuoteItem {
  id: string;
  productId?: string;
  name: string;
  spec?: string;
  qty: number;
  unit: string;
  unitPrice: number;
  amount: number;
}

export type QuoteStatus =
  | "draft"
  | "pending_approval"
  | "approved"
  | "sent"
  | "accepted"
  | "rejected"
  | "expired";

export interface QuoteChange {
  items: QuoteItem[];
  discount: number;
  subtotal: number;
  tax: number;
  total: number;
  /** 単価が税込 */
  taxIncluded?: boolean;
  /** 件名・施工内容・備考の変更 (省略時は変更なし) */
  title?: string;
  workDetails?: string;
  notes?: string;
  reason: string;
  requestedBy: string;
  requestedAt: string;
}

/** 見積の改訂前の版 (金額・内容の変更が承認されるたびに、変更前の内容を残す) */
export interface QuoteRevision {
  version: number;
  title: string;
  items: QuoteItem[];
  taxIncluded?: boolean;
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  workDetails?: string;
  notes?: string;
  validUntil?: string;
  approvedBy?: string;
  approvedAt?: string;
  /** この版から次の版への変更の理由・申請者・承認者・日時 */
  changeReason?: string;
  changeRequestedBy?: string;
  changeApprovedBy?: string;
  replacedAt: string;
}

/**
 * 現場情報・引継ぎ事項 (手書き見積書の 引取・納品日時、支払い方法、備考欄以下の項目)。
 * 見積 → 受注へ引き継ぎ、受注・施工の画面と予定表で施工担当者と共有する
 */
export interface SiteInfo {
  /** 引取日時 (書かれたとおり。例: 11/21 8:00-8:30) */
  pickupAt?: string;
  /** 納品日時 (例: 畳翌日 11/26PM 襖・障子) */
  deliveryAt?: string;
  /** 支払い方法 (納品時) */
  paymentMethod?: string;
  /** 支払い方法の補足 (VISA など) */
  paymentNote?: string;
  /** 備考 */
  remarks?: string;
  /** 荷物 (ベッド・タンスなど) */
  baggage?: string;
  /** 1 人で作業 OK / NG */
  oneOk?: string;
  /** かえ畳 (枚) */
  spareTatami?: number;
  /** 戸建て・階 (例: 戸建て 2F) */
  floor?: string;
  /** サイズ */
  sizes?: string;
  /** わら A / B */
  straw?: string;
  /** 建材 A / B */
  material?: string;
  /** 必要な道具 (脚立・ローラー・ジャッキ・台車・ジン) */
  equipment?: string[];
  /** 紙カーテン */
  paperCurtain?: string;
  /** 搬出 遠 / 近 */
  carryOut?: string;
  /** 雨天 OK / NG */
  rain?: string;
  /** 媒体 (○が付いたもの) */
  media?: string[];
  mediaOther?: string;
  /** 襖紙 */
  fusumaPaper?: string;
  /** 欄外の書き込み */
  otherNotes?: string;
  updatedBy?: string;
  updatedAt?: string;
}

export interface Quote {
  id: string;
  number: string;
  version: number;
  customerId: string;
  inquiryId?: string;
  storeId: StoreId;
  title: string;
  category: ServiceCategory;
  items: QuoteItem[];
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  status: QuoteStatus;
  validUntil: string;
  issuedAt?: string;
  sentVia?: Channel;
  createdBy: string;
  approvedBy?: string;
  approvedAt?: string;
  notes?: string;
  source: "manual" | "ocr" | "ai_phone";
  documentId?: string;
  orderId?: string;
  /** 承認待ちの変更案 (確定後の金額変更フロー) */
  pendingChange?: QuoteChange;
  createdAt: string;
  updatedAt: string;
  /** 施工内容 (工事の説明。見積書に載せ、受注に引き継ぐ) */
  workDetails?: string;
  /** 改訂前の版 (古い順) */
  revisions?: QuoteRevision[];
  /** 単価・小計が税込 (手書き見積書の「税込」)。消費税は合計から内税で計算する */
  taxIncluded?: boolean;
  /** 現場情報・引継ぎ事項 */
  siteInfo?: SiteInfo;
  /** 手書き見積書の No. */
  paperNo?: string;
  /** 現場でお客様に手書きの見積書を渡し済み (承認されたら「送付済」にする) */
  handedOver?: boolean;
  /** 打合せ中 (仕様・金額をお客様と調整中) */
  specStatus?: "discussing";
  /** 見積担当 (現場で見積をした社員) */
  estimatorId?: string;
}

export type OrderStatus =
  | "pending_approval"
  /** 契約の承認が差し戻された (内容を見直して再申請する) */
  | "returned"
  | "confirmed"
  | "scheduled"
  | "in_progress"
  | "completed"
  | "invoiced"
  | "paid"
  | "cancelled";

export type ProgressKind =
  | "note"
  | "survey"
  | "production"
  | "install"
  | "complete"
  | "change";

export interface ProgressNote {
  id: string;
  at: string;
  userId: string;
  kind: ProgressKind;
  body: string;
}

/** 売上台帳の内訳 (税込) */
export interface OrderAmounts {
  tatami: number;
  fusuma: number;
  shoji: number;
  amido: number;
  curtain: number;
  cloth: number;
  own: number;
  misc: number;
  discount: number;
}

export interface Order {
  id: string;
  number: string;
  /** 見積から受注した場合の見積 ID (売上台帳から移行した過去の受注にはない) */
  quoteId?: string;
  customerId: string;
  storeId: StoreId;
  title: string;
  category: ServiceCategory;
  contractDate: string;
  total: number;
  status: OrderStatus;
  scheduledStart?: string;
  scheduledEnd?: string;
  workerIds: string[];
  siteAddress: string;
  completedAt?: string;
  /** 売上計上日 (施工完了時に自動設定) */
  salesDate?: string;
  progressNotes: ProgressNote[];
  createdBy: string;
  approvedBy?: string;
  invoiceId?: string;
  createdAt: string;
  updatedAt: string;
  /** アンケートハガキ番号 (売上台帳の「ハガキ」欄) */
  postcardNo?: string;
  amounts?: OrderAmounts;
  /** 畳原価合計 */
  tatamiCost?: number;
  /** 使用した襖紙 */
  fusumaPaper?: string;
  source?: RecordSource;
  sourceRef?: string;
  /** 施工内容 (見積から引き継ぎ。受注・施工の画面で変更できる) */
  workDetails?: string;
  /** 現場情報・引継ぎ事項 (見積から引き継ぎ) */
  siteInfo?: SiteInfo;
  /** 仕様: pending = 一部の仕様が未確定 */
  specStatus?: "pending" | "fixed";
  specNote?: string;
  /** 工事日程: adjusting = 調整中 (日程は scheduledStart があれば確定) */
  scheduleStatus?: "adjusting";
  /** 請求書の発行: required = 必要 (業者・後日振込など) / not_required = 不要 (現場で集金など)。未設定は自動判定 */
  billing?: "required" | "not_required";
  /** 入金の予定方法 (cash / transfer / visit / card / epay / trade) */
  plannedPayment?: string;
  /** 案件の全処理完了 (請求・入金・その他の事務処理まで済んだ) */
  closedAt?: string;
  closedBy?: string;
}

export type InvoiceStatus =
  | "draft"
  | "issued"
  | "partially_paid"
  | "paid"
  | "overdue"
  | "void";

export interface Invoice {
  id: string;
  number: string;
  orderId: string;
  customerId: string;
  storeId: StoreId;
  issueDate: string;
  dueDate: string;
  subtotal: number;
  tax: number;
  total: number;
  paidAmount: number;
  status: InvoiceStatus;
  sentVia?: Channel;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** 発行時の件名・明細・備考 (明細は税抜。Phase 2 以前の請求書にはない → 見積・受注から組み立てる) */
  title?: string;
  items?: QuoteItem[];
  notes?: string;
  /** 明細が税込 (税込の見積から発行) */
  taxIncluded?: boolean;
  /** 入金予定日 (お客様と約束した日) */
  expectedDate?: string;
  /** 入金予定額 (分割・一部の入金のときは今回の予定額。空は残高の全額) */
  expectedAmount?: number;
  /** 入金予定のメモ (例: 月末に振込予定と電話あり) */
  expectedNote?: string;
}

export type PaymentMethod = "cash" | "transfer" | "card" | "paypay" | "other";

export interface Payment {
  id: string;
  invoiceId: string;
  date: string;
  amount: number;
  method: PaymentMethod;
  memo?: string;
  /** カード・電子決済の入金 (決済会社からの振込) を確認した日。未設定のカード・電子決済は「決済入金待ち」 */
  settledOn?: string;
  recordedBy: string;
  createdAt: string;
}

/** rejected = 差戻し (修正して再申請できる) / denied = 却下 (再申請しない) */
export type ExpenseStatus =
  | "draft"
  | "pending_approval"
  | "approved"
  | "rejected"
  | "denied"
  | "paid";

export type ExpensePaymentMethod = "cash" | "card" | "transfer";

export interface Expense {
  id: string;
  number: string;
  storeId: StoreId;
  submittedBy: string;
  date: string;
  vendor: string;
  amount: number;
  taxAmount: number;
  /** 勘定科目 */
  account: string;
  paymentMethod: ExpensePaymentMethod;
  description: string;
  status: ExpenseStatus;
  source: "manual" | "ocr";
  documentId?: string;
  approvedBy?: string;
  approvedAt?: string;
  createdAt: string;
  updatedAt: string;
  /** 精算日 (精算済みにした日) と処理した人 */
  paidAt?: string;
  paidBy?: string;
}

/** 取引先の区分: supplier = 仕入先 (材料・商品) / partner = 協力業者 (外注・施工の協力会社) */
export type SupplierKind = "supplier" | "partner";

export interface Supplier {
  id: string;
  name: string;
  category: string;
  phone?: string;
  email?: string;
  /** 支払条件 (文章。例: 月末締め 翌月末払い)。締め日・支払月・支払日が未設定のときはここから読み取る */
  paymentTerms: string;
  /** 締め日 (31 = 末日) */
  closingDay: number;
  kind?: SupplierKind;
  kana?: string;
  /** 先方の担当者 */
  contactName?: string;
  postalCode?: string;
  address?: string;
  fax?: string;
  /** 支払月 (締め日の月から 0 = 当月 / 1 = 翌月 / 2 = 翌々月) */
  payMonthOffset?: number;
  /** 支払日 (31 = 末日) */
  payDay?: number;
  /** 振込先 (銀行・支店・種別・口座番号・名義) */
  bankInfo?: string;
  /** 適格請求書発行事業者の登録番号 */
  registrationNumber?: string;
  /** LINE のユーザー ID (協力業者へ LINE で連絡するとき) */
  lineId?: string;
  /** Chatwork のルーム ID (協力業者とのやりとりのルーム) */
  chatworkRoomId?: string;
  notes?: string;
  /** false = 取引終了 (一覧・選択肢に出さない) */
  active?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/** rejected = 支払の却下 / disputed = 照会中 (差戻し。内容を確認して再申請できる) */
export type PurchaseStatus =
  | "received"
  | "pending_approval"
  | "approved"
  | "paid"
  | "disputed"
  | "rejected";

/** 仕入の明細 (品名・数量・単価・金額は税込) */
export interface PurchaseItem {
  id: string;
  name: string;
  spec?: string;
  qty: number;
  unit: string;
  unitPrice: number;
  amount: number;
}

export type PurchasePayMethod = "transfer" | "cash" | "card" | "debit" | "other";

export interface PurchaseInvoice {
  id: string;
  number: string;
  supplierId: string;
  storeId: StoreId;
  invoiceDate: string;
  /** 支払期限 (請求書に書かれた期限。仕入先の締め日・支払日から自動で計算) */
  dueDate: string;
  amount: number;
  taxAmount: number;
  description: string;
  status: PurchaseStatus;
  source: "manual" | "ocr";
  documentId?: string;
  registeredBy: string;
  approvedBy?: string;
  /** 支払日 (支払完了の日) */
  paidAt?: string;
  createdAt: string;
  updatedAt: string;
  /** 仕入内容 (明細) */
  items?: PurchaseItem[];
  /** 勘定科目 (仕入高・外注費・材料費など) */
  account?: string;
  /** 関連する案件 (受注) */
  orderId?: string;
  /** 仕入先の請求書番号 */
  supplierInvoiceNo?: string;
  /** 支払予定日 (支払う日。既定は支払期限) */
  scheduledPayDate?: string;
  /** 支払方法と記録 (支払完了のとき) */
  payMethod?: PurchasePayMethod;
  payReference?: string;
  paidBy?: string;
}

export type ApprovalType =
  | "quote"
  | "quote_amend"
  | "order"
  | "expense"
  | "purchase"
  /** 受注 (契約) の重要な情報 (契約金額・契約日) の変更 */
  | "order_change"
  /** 顧客の重要な情報 (氏名・住所・電話など) の変更 */
  | "customer_change";

/** returned = 差戻し (修正して再申請) / rejected = 却下 / cancelled = 取下げ */
export type ApprovalStatus = "pending" | "approved" | "returned" | "rejected" | "cancelled";

export interface Approval {
  id: string;
  type: ApprovalType;
  targetId: string;
  title: string;
  amount: number;
  storeId: StoreId;
  requestedBy: string;
  requiredRole: "store_manager" | "admin";
  status: ApprovalStatus;
  requestComment?: string;
  decidedBy?: string;
  decidedAt?: string;
  decisionComment?: string;
  createdAt: string;
  /** 変更の申請 (order_change / customer_change) の内容。承認すると after の値を反映する */
  changes?: AuditChange[];
}

export type AuditAction =
  | "create"
  | "update"
  | "delete"
  | "approve"
  | "reject"
  | "submit"
  | "send"
  | "status"
  | "login"
  | "logout"
  | "export"
  | "import";

export interface AuditChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface AuditLog {
  id: string;
  at: string;
  userId: string;
  action: AuditAction;
  entity: string;
  entityId: string;
  entityLabel: string;
  summary: string;
  changes?: AuditChange[];
  storeId?: StoreId;
}

export type RelatedType =
  | "inquiry"
  | "quote"
  | "order"
  | "invoice"
  | "expense"
  | "purchase"
  | "customer"
  | "supplier";

/**
 * 外部とのやりとり (お客様・協力業者・仕入先との連絡の記録)。
 * お客様とのやりとりは customerId、協力業者・仕入先とのやりとりは supplierId を持つ (両方を持つこともある。例: 協力業者と案件の打合せ)
 */
export interface CommLog {
  id: string;
  customerId?: string;
  channel: Channel;
  direction: "inbound" | "outbound";
  subject: string;
  body: string;
  at: string;
  userId: string;
  relatedType?: RelatedType;
  relatedId?: string;
  /** 協力業者・仕入先 */
  supplierId?: string;
  /** 閲覧範囲の店舗 (登録時に案件・お客様の店舗から決める) */
  storeId?: StoreId;
  /** 相手の担当者名 */
  contactName?: string;
  /** 送信履歴 (メール・LINE・Chatwork で送ったとき) */
  deliveryId?: string;
}

export type ThreadKind = "request" | "report" | "question" | "notice";

/** 業務依頼の進み方: 依頼 → 確認 (受付) → 報告 → 依頼者の確認 (完了) */
export type TaskStatus = "requested" | "acknowledged" | "reported" | "confirmed";

export interface Thread {
  id: string;
  title: string;
  kind: ThreadKind;
  storeId?: StoreId;
  createdBy: string;
  participants: string[];
  relatedType?: RelatedType;
  relatedId?: string;
  relatedLabel?: string;
  status: "open" | "done";
  createdAt: string;
  updatedAt: string;
  /** 業務依頼の担当者 (依頼先) */
  assigneeIds?: string[];
  /** 業務依頼の期限 */
  dueDate?: string;
  taskStatus?: TaskStatus;
  acknowledgedAt?: string;
  reportedAt?: string;
  confirmedAt?: string;
  confirmedBy?: string;
}

/** 業務依頼の操作を記録した投稿 (ack = 確認・受付 / report = 報告 / confirm = 依頼者の確認 / reopen = 差し戻し) */
export type MessageEvent = "ack" | "report" | "confirm" | "reopen";

export interface Message {
  id: string;
  threadId: string;
  userId: string;
  body: string;
  at: string;
  mentions: string[];
  event?: MessageEvent;
}

/** 現金出納 (店舗の手元現金の入出金) */
export type CashSource = "manual" | "opening" | "payment" | "expense" | "purchase";

export interface CashEntry {
  id: string;
  number: string;
  storeId: StoreId;
  date: string;
  direction: "in" | "out";
  amount: number;
  /** 科目・区分 (例: 売掛金回収・消耗品費・銀行預入・小口現金補充) */
  account: string;
  /** 相手 (お客様・支払先) */
  counterparty?: string;
  description: string;
  /** manual = 手入力 / opening = 繰越 (期首の残高) / payment・expense・purchase = 入金・経費精算・仕入の支払から自動で記帳 */
  source: CashSource;
  /** 自動で記帳した元の記録 (入金・経費・仕入請求書の ID) */
  sourceId?: string;
  recordedBy: string;
  createdAt: string;
  updatedAt: string;
}

/** 社内資料 (ナレッジ) の出どころ: 画面で登録 / Google スプレッドシートから同期 / ファイルから取込 */
export type KnowledgeSource = "manual" | "sheet" | "file";

/** 社内資料 (ナレッジ)。AI アシスタントが回答の根拠に使う (商品・価格の目安、施工の手順、社内ルール、よくある質問など) */
export interface KnowledgeEntry {
  id: string;
  title: string;
  body: string;
  /** 分類 (例: 商品・価格 / 施工 / 社内ルール / よくある質問) */
  category: string;
  tags: string[];
  source: KnowledgeSource;
  /** 取込元 (sheet:<シートの設定 ID>:<行の見出し> / ファイル名) */
  sourceRef?: string;
  /** false = AI の回答に使わない (一時的に止める) */
  active: boolean;
  createdBy: string;
  createdAt: string;
  updatedBy?: string;
  updatedAt: string;
}

export type DeliveryChannel = "email" | "line" | "chatwork";
/** sent = 送信 / failed = 送信失敗 / skipped = 送信の設定がないため記録のみ */
export type DeliveryStatus = "sent" | "failed" | "skipped";

/** 送信履歴 (メール・LINE・Chatwork で外部へ送った通知・帳票・連絡) */
export interface Delivery {
  id: string;
  channel: DeliveryChannel;
  /** 宛先 (メールアドレス・LINE のユーザー ID・Chatwork のルーム ID) */
  recipient: string;
  /** 宛先の名前 (お客様・社員・協力業者) */
  recipientLabel?: string;
  subject?: string;
  body: string;
  /** 添付したファイル名 */
  attachments?: string[];
  status: DeliveryStatus;
  error?: string;
  /** notify = 社内通知 / document = 見積書・請求書の送付 / message = 個別の連絡 / test = 接続の確認 */
  purpose: "notify" | "document" | "message" | "test";
  relatedType?: RelatedType | "approval" | "thread";
  relatedId?: string;
  /** 送信した人 (自動の通知は操作した人) */
  userId: string;
  createdAt: string;
}

/**
 * 予定の種別
 * - 案件の予定: 問い合わせ・見積・受注に紐づけて登録する (現地調査〜顧客訪問)
 * - 社内・その他の予定: 案件と関係なく自由に登録する (会議〜その他)
 */
export type ScheduleKind =
  | "survey"
  | "measure"
  | "pickup"
  | "delivery"
  | "install"
  | "visit"
  | "meeting"
  | "gathering"
  | "company"
  | "event"
  | "leave"
  | "other";

export interface ScheduleEvent {
  id: string;
  title: string;
  kind: ScheduleKind;
  /** 開始日 (YYYY-MM-DD) */
  date: string;
  /** 終了日。複数日にわたる予定のみ (単日は省略) */
  endDate?: string;
  /** 開始・終了時刻 (HH:MM)。省略時は終日。複数日の予定では「各日の時間帯」 */
  startTime?: string;
  endTime?: string;
  /** 時刻未定で午前 / 午後だけ決まっている予定 (予定表スプレッドの AM / PM 欄) */
  slot?: "am" | "pm";
  /** 予定を管理する店舗 (どの店舗のカレンダーに載るか) */
  storeId: StoreId;
  /** 全社共通の予定 (全店舗のカレンダーに表示。社内行事・全社会議など) */
  companyWide?: boolean;
  /** 担当者・参加者 (店舗をまたいで指定可) */
  assigneeIds: string[];
  /** 案件 (問い合わせ → 見積 → 受注) とお客様への紐づけ。登録時に案件の連鎖をたどって埋める */
  customerId?: string;
  inquiryId?: string;
  quoteId?: string;
  orderId?: string;
  /** order: 受注の施工予定 (施工期間・施工担当・現場住所) と双方向に連動する予定 / import: 予定表スプレッドから移行 */
  source?: "manual" | "order" | "import";
  /** 取込元 (ファイル#シート!行) */
  sourceRef?: string;
  /** 繰り返し登録した予定のまとまり */
  seriesId?: string;
  location?: string;
  memo?: string;
  createdBy?: string;
  createdAt?: string;
  updatedBy?: string;
  updatedAt?: string;
}

export type DocumentKind =
  | "handwritten_quote"
  | "drawing"
  | "site_document"
  | "supplier_invoice"
  | "receipt"
  | "contract"
  | "survey_postcard"
  | "other";

/** failed = AI の読取に失敗 (手入力で登録するか、読み取り直す) */
export type DocumentStatus = "uploaded" | "extracted" | "failed" | "confirmed" | "discarded";

export interface CapturedDocument {
  id: string;
  kind: DocumentKind;
  fileName: string;
  uploadedBy: string;
  storeId: StoreId;
  uploadedAt: string;
  status: DocumentStatus;
  /** AI/OCR による読取結果 (構造化 JSON) */
  extracted?: Record<string, unknown>;
  confidence?: number;
  /** 登録先 (見積・経費・仕入請求書、または図面・施工資料を保存した受注・問い合わせ・顧客) */
  linkedType?: "quote" | "expense" | "purchase" | "order" | "inquiry" | "customer" | "survey";
  linkedId?: string;
}

/** 設定 (id ごとに 1 行。値は JSON。例: "documents" = 帳票に載せる会社情報・登録番号・振込先) */
export interface AppSetting {
  id: string;
  value: Record<string, unknown>;
  updatedBy?: string;
  updatedAt: string;
}

/** 添付ファイルの登録先 (document = 書類取込の元画像。見積・経費・仕入に登録すると、その記録へ付け替える) */
export type AttachmentParent = "customer" | "inquiry" | "quote" | "order" | "expense" | "purchase" | "document";

/**
 * 添付ファイル (資料・写真)。本体はストレージ (本番: Supabase Storage の非公開バケット / ローカル: data/uploads) に置き、
 * ここには台帳 (どの記録の添付か・誰がいつ登録したか) だけを持つ
 */
export interface Attachment {
  id: string;
  parentType: AttachmentParent;
  parentId: string;
  /** 顧客 360 に集めるための顧客 ID (登録先から自動で設定) */
  customerId?: string;
  /** 閲覧権限の判定に使う店舗 (登録先の店舗) */
  storeId: StoreId;
  kind: "photo" | "file";
  fileName: string;
  contentType: string;
  size: number;
  storageKey: string;
  /** 一覧用の縮小画像 (写真のみ) */
  thumbKey?: string;
  width?: number;
  height?: number;
  caption?: string;
  /** 撮影日時 (写真の Exif、なければファイルの更新日時) */
  takenAt?: string;
  uploadedBy: string;
  uploadedAt: string;
}

/** 会社の休業日 (休日カレンダー) */
export interface CompanyHoliday {
  id: string;
  date: string;
  label: string;
}

/** お客様アンケート (アンケートハガキの回答) */
export interface SurveyResponse {
  id: string;
  receivedAt: string;
  postcardNo?: string;
  storeId: StoreId;
  orderId?: string;
  customerId?: string;
  phoneScore?: number;
  salesName?: string;
  salesUserId?: string;
  salesScore?: number;
  craftsmanName?: string;
  craftsmanUserId?: string;
  craftsmanScore?: number;
  finishScore?: number;
  priorities?: string;
  media?: string;
  wouldUseAgain?: string;
  sourceRef?: string;
  /** はがきに書かれた回答日 */
  answeredOn?: string;
  /** ① 電話対応の評価対象 (事務担当) */
  clerkUserId?: string;
  /** ②③ の評価対象 (納品担当。複数のことがある。salesUserId・craftsmanUserId を含む) */
  deliveryUserIds?: string[];
  /** ⑤ ご利用にあたって重視されたこと (複数回答) */
  priorityList?: string[];
  /** ⑥ 何を見てご依頼いただいたか (複数回答) */
  mediaList?: string[];
  /** ⑧ ご指摘・お褒めの言葉 (自由記述) */
  comment?: string;
  /** ⑧ の分類 (AI またはルールで付ける。例: 仕上がり・職人の対応・説明・提案) */
  commentTags?: string[];
  /** ⑧ の内容の種類 */
  commentTone?: "praise" | "request" | "complaint" | "neutral";
  /** 取込書類 (はがきの写真) */
  documentId?: string;
  /** import = スプレッドシートから移行 / capture = はがきの写真から登録 / manual = 画面で入力 */
  source?: "import" | "capture" | "manual";
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** クレーム・手直し (手直し 1 点 / クレーム 2 点 / クレーム＋手直し 3 点) */
export type QualityKind = "rework" | "claim" | "claim_rework";

export interface QualityIssue {
  id: string;
  number: string;
  orderId: string;
  customerId?: string;
  /** 集計する店舗 (登録時の案件の担当店舗) */
  storeId: StoreId;
  kind: QualityKind;
  /** 登録時のポイント (ルールを後で変えても、登録済みの点数は変わらない) */
  points: number;
  /** 発生日 (集計期間の判定に使う) */
  occurredOn: string;
  /** 対象の担当者 (納品担当など) */
  responsibleUserIds: string[];
  /** 内容 */
  description: string;
  /** 原因 */
  cause?: string;
  /** 対策 (再発防止) */
  countermeasure?: string;
  status: "open" | "resolved";
  resolvedOn?: string;
  /** ポイントを付ける単位 (原因で決める): store = 案件の店舗 / office = 事務 */
  attribution?: "store" | "office";
  /** カテゴリー (精度・確認不足・説明不足・その他) */
  category?: string;
  /** false = 記録のみで集計しない (点検 DM・点検電話から分かったもの、お客様が原因のものなど) */
  counted?: boolean;
  reportedBy: string;
  createdAt: string;
  updatedAt: string;
}

/** Google の口コミ (口コミをいただいた担当者にポイント。月ごとに集計し、翌月末に支給) */
export interface GoogleReview {
  id: string;
  /** 口コミの投稿日 (集計月の判定に使う) */
  postedOn: string;
  storeId: StoreId;
  /** ポイントの対象の担当者 */
  userId: string;
  reviewerName?: string;
  /** 星の数 (1〜5) */
  rating?: number;
  comment?: string;
  /** 写真つきの口コミ */
  hasPhoto?: boolean;
  /** 登録時のポイント (星の評価・コメント・写真 で 1 点ずつ) */
  points: number;
  orderId?: string;
  customerId?: string;
  note?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** 資料台帳 (Google ドライブで共有された業務資料 1 ファイル) */
export interface SourceFile {
  id: string;
  folder: string;
  folderName: string;
  path: string;
  name: string;
  ext: string;
  kind: "spreadsheet" | "document" | "pdf" | "image" | "media" | "other";
  bytes?: number;
  modifiedOn?: string;
  driveUrl?: string;
  status: string;
  /** システムのどのデータに取り込んだか (未設定 = 台帳に記録のみ) */
  importedTo?: string;
}

/** 現場写真台帳 (現場ごとの写真フォルダ。画像は Google ドライブに置いたまま) */
export interface PhotoAlbum {
  id: string;
  title: string;
  date?: string;
  area?: string;
  customerName?: string;
  customerId?: string;
  storeId: StoreId;
  photoCount: number;
  driveUrl?: string;
  sampleFiles: string[];
}

export interface Database {
  meta: { version: number; seededAt: string; source?: string; importedAt?: string; revision?: number };
  stores: Store[];
  users: User[];
  customers: Customer[];
  inquiries: Inquiry[];
  products: Product[];
  quotes: Quote[];
  orders: Order[];
  invoices: Invoice[];
  payments: Payment[];
  expenses: Expense[];
  suppliers: Supplier[];
  purchases: PurchaseInvoice[];
  approvals: Approval[];
  auditLogs: AuditLog[];
  commLogs: CommLog[];
  threads: Thread[];
  messages: Message[];
  schedule: ScheduleEvent[];
  documents: CapturedDocument[];
  holidays: CompanyHoliday[];
  surveys: SurveyResponse[];
  qualityIssues: QualityIssue[];
  reviews: GoogleReview[];
  sourceFiles: SourceFile[];
  photoAlbums: PhotoAlbum[];
  settings: AppSetting[];
  attachments: Attachment[];
  cashEntries: CashEntry[];
  deliveries: Delivery[];
  knowledge: KnowledgeEntry[];
}

export type CollectionName = Exclude<keyof Database, "meta">;
