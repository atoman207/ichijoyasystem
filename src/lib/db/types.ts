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
}

export type CollectionName = Exclude<keyof Database, "meta">;
