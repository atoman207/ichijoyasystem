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
}

/** 情報の入口 / 出口 */
export type Channel =
  | "phone"
  | "ai_phone"
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
  reason: string;
  requestedBy: string;
  requestedAt: string;
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
}

export type OrderStatus =
  | "pending_approval"
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
}

export type PaymentMethod = "cash" | "transfer" | "card" | "paypay" | "other";

export interface Payment {
  id: string;
  invoiceId: string;
  date: string;
  amount: number;
  method: PaymentMethod;
  memo?: string;
  recordedBy: string;
  createdAt: string;
}

export type ExpenseStatus =
  | "draft"
  | "pending_approval"
  | "approved"
  | "rejected"
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
}

export interface Supplier {
  id: string;
  name: string;
  category: string;
  phone?: string;
  email?: string;
  paymentTerms: string;
  closingDay: number;
}

export type PurchaseStatus =
  | "received"
  | "pending_approval"
  | "approved"
  | "paid"
  | "disputed";

export interface PurchaseInvoice {
  id: string;
  number: string;
  supplierId: string;
  storeId: StoreId;
  invoiceDate: string;
  dueDate: string;
  amount: number;
  taxAmount: number;
  description: string;
  status: PurchaseStatus;
  source: "manual" | "ocr";
  documentId?: string;
  registeredBy: string;
  approvedBy?: string;
  paidAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type ApprovalType =
  | "quote"
  | "quote_amend"
  | "order"
  | "expense"
  | "purchase";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "cancelled";

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
  | "customer";

export interface CommLog {
  id: string;
  customerId: string;
  channel: Channel;
  direction: "inbound" | "outbound";
  subject: string;
  body: string;
  at: string;
  userId: string;
  relatedType?: RelatedType;
  relatedId?: string;
}

export type ThreadKind = "request" | "report" | "question" | "notice";

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
}

export interface Message {
  id: string;
  threadId: string;
  userId: string;
  body: string;
  at: string;
  mentions: string[];
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
  | "supplier_invoice"
  | "receipt"
  | "contract"
  | "other";

export type DocumentStatus = "uploaded" | "extracted" | "confirmed" | "discarded";

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
  linkedType?: "quote" | "expense" | "purchase";
  linkedId?: string;
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
  sourceFiles: SourceFile[];
  photoAlbums: PhotoAlbum[];
  attachments: Attachment[];
}

export type CollectionName = Exclude<keyof Database, "meta">;
