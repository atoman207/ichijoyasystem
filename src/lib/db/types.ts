/**
 * ドメインモデル定義
 * ------------------------------------------------------------
 * 社内のあらゆる情報を「一つの基盤」に集約するための型定義。
 * 外部との入口 (Channel) は複数あっても、ここで定義した
 * エンティティ同士が ID で関連付き、1 か所の更新が全画面に反映される。
 */

import type { AllocationRun, Bom, ExpenseClass, ItemCategory, Material, MaterialCost, MaterialTransfer, MaterialUsage, MgmtEntry, MgmtRule, OrderAttribution, PeriodClose, PurchaseLineAlloc, SalesAdjustment, SalesArea, StockMove } from "./types-mgmt";
export type * from "./types-mgmt";
import type { JobSpec, ProductionJob, ResourceBooking, ScheduleHold } from "./types-plan";
export type * from "./types-plan";
import type { HolidayWork, LeaveGrant, LeaveRequest } from "./types-hr";
export type * from "./types-hr";
import type { Condolence, OfficeImprovement } from "./types-office";
export type * from "./types-office";
import type { MediaKey, Promotion, TatamiProduction, WorkReportDay } from "./types-ops";
export type * from "./types-ops";
import type { DocDraft } from "./types-drafts";
export type * from "./types-drafts";
import type { CasePost, TidyCheck } from "./types-posts";
export type * from "./types-posts";

export type Role = "admin" | "store_manager" | "store_staff" | "hq_staff";

/** 店舗 ID (4 店舗 + 本社/坪井ショールーム) */
/**
 * 店舗 ID。開設時の 4 店舗と本部のほか、管理者が設定 → 店舗 で追加した店舗 (半角英小文字の ID) も入る。
 * 店舗の一覧・名前・色は db.stores から読む (ID の並びをコードに書かない)
 */
export type StoreId = "koshi" | "chuo" | "nishi" | "tamana" | "hq" | (string & {});

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
  /** 管理部門としての開設日・閉鎖日・統合先 (管理会計。閉鎖・統合後も過去の数字は残る) */
  openedOn?: string;
  closedOn?: string;
  mergedInto?: StoreId;
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
  /** 顔写真 (VPS のファイルのパス。src/lib/storage.ts)。画面では /api/avatars/<ID>?v=<avatarUpdatedAt> で表示する */
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
  /** 担当者・店舗の携帯電話に直接かかってきた電話 */
  | "mobile"
  | "mail"
  | "event"
  | "referral"
  | "unknown";

/** 取込データの出どころ (app = システムで登録 / import = 既存の台帳・スプレッドシートから移行) */
export type RecordSource = "app" | "import";

export type CustomerType = "individual" | "corporate";

/**
 * 顧客の連絡先 (本人以外の家族・勤務先など。1 人のお客様に電話番号を複数登録する)。
 * 主の電話番号は Customer.phone。電話番号での照合 (着信・Web フォーム・重複の確認・検索) はここも見る (src/lib/customer-contacts.ts)
 */
export interface CustomerContact {
  id: string;
  /** 続柄・種類 (例: 本人 携帯 / 夫 / 姉 / 祖母 / 勤務先) */
  relation: string;
  /** その人の名前 (任意) */
  name?: string;
  phone: string;
  note?: string;
}

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
  /** 本人以外の連絡先 (夫・姉・祖母など。電話番号が誰のものかを続柄で持つ) */
  contacts?: CustomerContact[];
  /** 取引停止 (見積・受注の登録時に警告する) と、その理由 */
  tradeStopped?: boolean;
  tradeStopNote?: string;
  /** 請求の締め (法人のお客様のまとめ請求。src/lib/billing.ts)。未設定・batch = false は案件ごとの請求 */
  billingTerms?: CustomerBillingTerms;
}

/** まとめ請求の条件: 締め日 (31 = 末日) ごとに、完了した案件を 1 枚の請求書にまとめる。支払期限は 締め日の月 + payMonthOffset か月の payDay 日 (31 = 末日) */
export interface CustomerBillingTerms {
  batch: boolean;
  closingDay: number;
  payMonthOffset: number;
  payDay: number;
  note?: string;
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
  /**
   * 媒体 (お客様が当社を知ったきっかけ。全社共通の分類 src/lib/media.ts)。画面の登録・更新では必須 (わからなければ「不明」)。
   * 移行・自動受付の問い合わせは空 (分析では見積・受注の媒体欄・顧客の媒体から対応表で読み替え、なければ「未分類」)
   */
  media?: MediaKey;
  /** この問い合わせのきっかけになった販促 (チラシ・イベントなど。promotions) */
  promotionId?: string;
  /** 既存の AI システム (AI テキスト相談・AI 音声相談・AI 電話受付) から受け取った項目 (src/lib/ai-intake.ts)。顧客の登録・重複の確認に使う */
  intake?: InquiryIntake;
}

/** AI 受付で受け取った項目 (受け取ったまま。電話番号だけ国内の形にそろえる) */
export interface InquiryIntake {
  /** お客様が名乗ったお名前 (顧客にひも付いたときも残す) */
  name?: string;
  kana?: string;
  phone?: string;
  callbackPhone?: string;
  email?: string;
  postalCode?: string;
  address?: string;
  desiredDate?: string;
  urgency?: "high" | "normal" | "low";
  /** AI が「担当者への引き継ぎが必要」とした */
  handoffRequested?: boolean;
  handoffReason?: string;
  /** 録音・会話の画面 (https のみ) */
  recordingUrl?: string;
  /** AI システムの受付 ID */
  externalId?: string;
  /** 当社を知ったきっかけ (受け取った言葉。対応表で媒体に読み替えられたときは Inquiry.media) */
  mediaText?: string;
  /** 電話番号ではない送信元 (チャットの利用者 ID など) */
  senderId?: string;
  /** 電話番号・メールが一致したお客様の件数 (2 件以上なら最近更新したお客様にひも付けた) */
  matchedCount?: number;
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
  /**
   * 管理会計の品目 (畳・襖・リフォーム・カーテン類・自社商品・その他・諸経費。src/lib/mgmt/categories.ts の ID)。
   * 空なら種別から決める (畳 → 畳、襖・障子・網戸 → 襖、カーテン → カーテン類、クロス → リフォーム、その他 → 諸経費)
   */
  mgmtCategory?: string;
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
  /** 管理会計の品目 (明細ごとに選んだもの)。空なら商品の品目 → 見積の種別から決める (src/lib/mgmt/categories.ts の lineItemCategory) */
  itemCategory?: string;
  /** 畳床 (管理会計の材料マスタの畳床)。選べば材料原価はこの畳床で計算する (空なら品名・製造の予定から判定。src/lib/mgmt/doko.ts) */
  dokoMaterialId?: string;
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
  /** 畳の製造の仕様 (部屋ごと。src/lib/tatami-spec.ts)。空なら見積の明細から自動で作る */
  tatamiRooms?: TatamiRoom[];
  /** 手書き見積書の No. */
  paperNo?: string;
  /** 現場でお客様に手書きの見積書を渡し済み (承認されたら「送付済」にする) */
  handedOver?: boolean;
  /** 打合せ中 (仕様・金額をお客様と調整中) */
  specStatus?: "discussing";
  /** 見積担当 (現場で見積をした社員) */
  estimatorId?: string;
  /** 施工場所の住所 (お客様の住所と違うとき。例: お子様・ご両親の家)。受注に引き継ぐ */
  siteAddress?: string;
  /** 領収書の宛名 (お客様名と違うとき。例: 会社名義)。受注に引き継ぐ */
  receiptName?: string;
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
  /** 畳の製造の仕様 (部屋ごと。src/lib/tatami-spec.ts)。空なら見積の明細から自動で作る */
  tatamiRooms?: TatamiRoom[];
  /** 仕様: pending = 一部の仕様が未確定 */
  specStatus?: "pending" | "fixed";
  specNote?: string;
  /** 工事日程: adjusting = 調整中 (日程は scheduledStart があれば確定) */
  scheduleStatus?: "adjusting";
  /** 領収書の宛名 (お客様名と違うとき。例: 個人のお客様の依頼で会社名義の領収書)。空のときは顧客名 */
  receiptName?: string;
  /** 請求書の発行: required = 必要 (業者・後日振込など) / not_required = 不要 (現場で集金など)。未設定は自動判定 */
  billing?: "required" | "not_required";
  /** 入金の予定方法 (cash / transfer / visit / card / epay / trade) */
  plannedPayment?: string;
  /** 案件の全処理完了 (請求・入金・その他の事務処理まで済んだ) */
  closedAt?: string;
  closedBy?: string;
  /**
   * 品目ごとの引取日・納品日 (畳・襖・障子・網戸。リフォームは施工期間)。src/lib/handover.ts。
   * あるときは予定表の受注の予定 (引き取り・納品・施工) をここから作り、scheduledStart / scheduledEnd は最初の日・最後の日になる
   * (お客様のご要望 2026-11-23「■ 予定表への反映方法」「■ 引取日・納品日の登録・変更」)
   */
  handovers?: OrderHandover[];
}

/**
 * 畳の製造の仕様 (部屋ごと。src/lib/tatami-spec.ts。お客様のご要望 2026-11-23「畳製造予定: 畳表・畳縁・畳床・寸法を部屋ごとに」)。
 * 空の項目は未確定 (画面では「寸法未確認」など)。見積の明細から自動で作り、見積・受注・畳製造予定の画面であとから入れ・直せる
 */
export interface TatamiRoom {
  id: string;
  /** 部屋 (例: 1階 和室・仏間)。空なら「部屋 1」… */
  room?: string;
  /** 作業: omote = 表替え / ura = 裏返し / new = 新調 */
  work: "omote" | "ura" | "new";
  /** 畳数 (半畳は 0.5)。0 = 未確認 */
  qty: number;
  /** 畳表 (品名。例: きずな・銀白 100A) */
  omote?: string;
  /** 畳縁 (品名。例: マス菊・アラベスク510)。縁無なら空 */
  heri?: string;
  /** 縁無 (へり無し畳) */
  herinashi?: boolean;
  /** 畳床の種類 (本ワラ床・建材床・床暖房用畳床 など。表替え・裏返しは今の床) */
  doko?: string;
  /** 畳床の厚み (例: 55mm) */
  dokoThickness?: string;
  /** 寸法 (例: 本間・江戸間 (五八)・六一・880×1760) */
  size?: string;
  /** メモ (半畳・炉あり など) */
  note?: string;
}

/** 引取・納品の品目 (src/lib/handover.ts の HANDOVER_ITEM)。reform は施工期間 (開始日〜終了日) で予定表に載せる */
export type HandoverItem = "tatami_omote" | "tatami_ura" | "tatami_new" | "fusuma" | "shoji" | "amido" | "other" | "reform";

/** 時刻を決めずに午前 (AM) / 午後 (PM) だけ決めた時間帯 (予定表の ScheduleEvent.slot と同じ) */
export type HandoverSlot = "am" | "pm";

/**
 * 受注の 1 品目の引取・納品の日程。日付は YYYY-MM-DD、時刻は HH:MM、時間帯は午前・午後 (どちらもなければ時間未定)。
 * 時刻と時間帯は同時に持たない (時刻があれば時刻)。
 * 品目が reform (施工) のときは pickupDate = 施工開始日・pickupStart / pickupEnd / pickupSlot = 各日の時間帯・deliveryDate = 施工終了日
 */
export interface OrderHandover {
  id: string;
  item: HandoverItem;
  /** 予定表の件名に出す名前 (例: 畳 表替え 16枚)。空なら品目の名前 */
  label?: string;
  pickupDate?: string;
  pickupStart?: string;
  pickupEnd?: string;
  pickupSlot?: HandoverSlot;
  deliveryDate?: string;
  deliveryStart?: string;
  deliveryEnd?: string;
  deliverySlot?: HandoverSlot;
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
  /**
   * まとめ請求 (締め日ごとに複数の案件を 1 枚にまとめた請求書。src/lib/billing.ts): 対象の受注すべて (orderId はその 1 件目)・締めの期間・案件ごとの行。
   * 案件の行は items には入れない (items は案件の明細として売上の分析・管理会計が使うため)
   */
  orderIds?: string[];
  periodFrom?: string;
  periodTo?: string;
  orderLines?: InvoiceOrderLine[];
}

/** まとめ請求の案件ごとの行 (発行時の内容。金額は税込 = 受注の金額) */
export interface InvoiceOrderLine {
  orderId: string;
  number: string;
  title: string;
  site?: string;
  completedAt?: string;
  salesDate?: string;
  amount: number;
  /** 消費税の対象外の案件 (見積・請求の消費税が 0) */
  noTax?: boolean;
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
  /** いつもの支払方法 (総合振込・都度振込・口座振替など)。支払完了の既定と買掛一覧の絞り込み・会計データの出力に使う */
  payMethod?: PurchasePayMethod;
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

/** transfer = 都度振込 (その都度の銀行振込。以前の「銀行振込」) / bulk_transfer = 総合振込 (月に 1 回まとめて振り込む分。税理士に渡す買掛一覧の対象) */
export type PurchasePayMethod = "transfer" | "bulk_transfer" | "cash" | "card" | "debit" | "other";

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
  | "customer_change"
  /** ほかの店舗の完了した案件のお客様の閲覧の申請 (閲覧の範囲 = 承認制のとき。承認から決まった日数だけ閲覧のみで見られる。src/lib/case-access.ts) */
  | "record_view"
  /** 受注の引取日・納品日 (品目ごと) の変更。はじめて入れる日程は承認なし、登録済みの日程の変更だけ (src/lib/handover.ts) */
  | "handover_change";

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
  | "import"
  /** 閲覧 (住宅地図の PDF など、閲覧の記録が必要なもの) */
  | "view";

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
  /**
   * 閲覧できる人 (AI の回答にも同じ範囲で使う): all = 全員 (既定) / manager = 店長・本部・管理者 / hq = 本部・管理者 / admin = 管理者のみ
   * 判定は permissions.ts の canViewKnowledge
   */
  visibility?: KnowledgeVisibility;
  /** 日付 (議事録の会議の日・決定事項の日など。AI が「いつ決まったか」を答えるのに使う) */
  recordDate?: string;
  /**
   * 内容の管理 (2026-11。src/lib/knowledge-review.ts):
   * 担当者 (内容に責任を持ち、定期的に確かめる社員の ID)・次に確かめる日・確かめる間隔 (日)・最後に確かめた日時と人。
   * 次に確かめる日を過ぎると「確認期限切れ」(担当者への通知・AI は古い可能性を添える)
   */
  ownerId?: string;
  reviewDue?: string;
  reviewIntervalDays?: number;
  reviewedAt?: string;
  reviewedBy?: string;
}

export type KnowledgeVisibility = "all" | "manager" | "hq" | "admin";

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
  purpose: "notify" | "document" | "message" | "test" | "schedule_offer";
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
  /** 受付 (問い合わせの手書きメモの写真・話して入力・通話の文字起こし。src/lib/reception.ts。画面は /inquiries/reception) */
  | "reception"
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
 * 添付ファイル (資料・写真)。本体はこのサーバー (VPS) のディスク (src/lib/storage.ts。本番: /srv/ichijoya/data/uploads) に置き、
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
  /** KPI の集計月 (YYYY-MM。スプレッドシートの「月」の列 = はがきを集計した月)。空 = 回答日 → 登録日の月 (src/lib/kpi-core.ts の surveyKpiDate) */
  countMonth?: string;
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
  /** 案件 (受注)。スプレッドシートから取り込んだ記録・LINE の報告から登録した記録は、案件が決まるまで空 (現場名 siteName で分かる) */
  orderId?: string;
  customerId?: string;
  /** 現場名 (案件にひも付く前の記録。例: （滑石）坂西邸) */
  siteName?: string;
  /** 発生のきっかけ (点検 DM・点検電話・アンケート・電話・LINE・現場 など) */
  origin?: string;
  /** 取り込んだ元 (sheet:claims:… = スプレッドシート「お客様アンケート集計表」の行。画面で登録した記録は空) */
  sourceRef?: string;
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
  /** 取り込んだ元 (sheet:reviews:… = スプレッドシート「お客様アンケート集計表」の Google口コミ集計 の行。画面で登録した口コミは空) */
  sourceRef?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * アンケートの過去の集計 (スプレッドシート「お客様アンケート集計表」の H26〜R4 の集計表)。
 * はがき 1 枚ごとの回答がない年度の、店舗 × 設問 × 回答 の件数 (期間の合計)。システムの回答 (surveys) と年度ごとに比べる
 */
export interface SurveyHistoryRow {
  id: string;
  /** 年度の表示 (シートの見出し。H26・R2 など) */
  fiscalLabel: string;
  /** 集計の始まりの年 (西暦。H26 = 2014、R2 = 2020) */
  startYear: number;
  /** 集計した期間 (シートの列の見出し。例: 2020年7月〜2021年6月) */
  period: string;
  /** 店舗 (店舗別の表。全社の表は空) */
  storeId?: StoreId;
  /** 設問 (回答数・電話応対・営業担当者・職人の対応・工事の仕上り・重視したこと・情報媒体・次回) */
  question: string;
  /** 回答 (大変満足・チラシ など。回答数の行は空) */
  answer: string;
  count: number;
  /** 取り込んだ元 (sheet:history:<シート>:<店舗>:<設問>:<回答>) */
  sourceRef: string;
  importedAt: string;
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

/* ---------------- 発注書・FAX (仕入先への発注と、クラウド FAX の送受信) ---------------- */

/**
 * 発注書の状態
 * draft = 下書き / issued = 発行済み (送信待ち。印刷して FAX 機で送ることもできる) / sent = 送信済み /
 * completed = 完了 (納品・回答まで済み。返信 FAX のひも付け候補から外れる) / cancelled = 取消
 */
export type PurchaseOrderStatus = "draft" | "issued" | "sent" | "completed" | "cancelled";

/** 発注書の明細。1 枚の発注書に、別の案件 (受注) の明細を混ぜられる */
export interface PurchaseOrderLine {
  id: string;
  /** 案件 (受注) の ID と番号 (番号は明細を作ったときの控え。発注書・返信 FAX の照合に使う) */
  orderId?: string;
  orderNumber?: string;
  /** 商品マスタから選んだとき */
  productId?: string;
  /** 商品名 */
  name: string;
  /** 品番 */
  code?: string;
  /** 仕様 (等級・サイズ・色など) */
  spec?: string;
  qty: number;
  unit: string;
  /** 希望納期 (明細ごと。空のときは発注書の希望納期) */
  dueDate?: string;
  notes?: string;
  /** 単価 (任意。入れた明細があるときだけ、発注書に単価・金額を載せる) */
  unitPrice?: number;
}

export interface PurchaseOrder {
  id: string;
  /** 発注番号 (例: PO-2026-0001)。返信 FAX の照合に使うため、発注書の上部に大きく載せる */
  number: string;
  supplierId: string;
  /** 発注元の店舗 (閲覧・操作の範囲) */
  storeId: StoreId;
  status: PurchaseOrderStatus;
  /** 発注日 */
  issuedOn: string;
  /** 希望納期 (発注書全体) */
  desiredDate?: string;
  /** 納品先 (名称。例: 合志店 / 現場直送) と住所 */
  deliveryPlace: string;
  deliveryAddress?: string;
  lines: PurchaseOrderLine[];
  /** 明細の案件 (受注) の ID (明細から自動で作る。検索・FAX のひも付け用) */
  orderIds: string[];
  notes?: string;
  /** お客様の氏名・電話番号を発注書に載せる (現場直送などで必要なときだけ。既定は載せない) */
  showCustomer?: boolean;
  /** 送信先の FAX 番号 (空のときは仕入先の FAX 番号) */
  faxTo?: string;
  /** 版 (送信したあとに内容を直すたびに +1。発注書に「第2版 (訂正)」と載せる) */
  version: number;
  /** 複製元の発注書 */
  copiedFrom?: string;
  createdBy: string;
  createdAt: string;
  updatedBy?: string;
  updatedAt: string;
  issuedAt?: string;
  sentAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  cancelReason?: string;
}

export type FaxDirection = "inbound" | "outbound";

/**
 * FAX の状態
 * - 送信: queued = 受付済み / sending = 処理中 / sent = 成功 / failed = 失敗 /
 *         unknown = 要確認 (通信が途中で切れ、FAX サービスが受け付けたか分からない。自動では再送しない) / manual = FAX 機で送信 (記録のみ)
 * - 受信: received
 */
export type FaxStatus = "queued" | "sending" | "sent" | "failed" | "unknown" | "manual" | "received";

/**
 * 受信 FAX の仕分け
 * auto = 登録済みの番号 (仕入先・顧客) からの FAX。自動で業務の一覧に入る /
 * review = 要確認 (未登録の番号。担当者が「取り込む」「不要」を選ぶ) / accepted = 担当者が取り込んだ /
 * junk = 不要 (通常の一覧から外す。削除はしない。「戻す」で復旧できる)
 */
export type FaxTriage = "auto" | "review" | "accepted" | "junk";

/** AI の判定: business = 業務関連 / ad = 広告・営業 / unknown = 判定不能 */
export type FaxAiLabel = "business" | "ad" | "unknown";

/** 受信 FAX の AI 判定・読み取りの結果 (担当者の判断で上書きしない。判断は triage・decidedBy に残す) */
export interface FaxAiResult {
  label: FaxAiLabel;
  /** 信頼度 0〜1 */
  confidence: number;
  reason: string;
  /** 書類に書かれた送信元の名前・FAX 番号 */
  senderName?: string;
  senderFax?: string;
  /** 書類の種類 (例: 注文請書・納期回答・請求書・広告) */
  documentType?: string;
  summary?: string;
  /** 読み取った発注番号・案件番号 (書かれたとおりを正規化したもの。システムにない番号も含む) */
  poNumbers: string[];
  orderNumbers: string[];
  provider: string;
  model?: string;
  at: string;
  error?: string;
}

/** FAX の処理の記録 (送信の受付・状態の変化・再送・エラー・AI 判定・ひも付け・仕分け) */
export interface FaxEvent {
  at: string;
  kind: "queued" | "submit" | "accepted" | "status" | "retry" | "error" | "received" | "ai" | "link" | "triage" | "manual" | "check";
  status?: FaxStatus;
  note: string;
  userId?: string;
}

/** FAX の送受信履歴。PDF の本体は VPS のディスク (src/lib/storage.ts) に置き、ここにはパスだけを持つ */
export interface FaxMessage {
  id: string;
  /** 番号 (例: FX-2026-0001) */
  number: string;
  direction: FaxDirection;
  status: FaxStatus;
  /** 受信の仕分け (送信は持たない) */
  triage?: FaxTriage;
  /** 相手の FAX 番号 (数字だけ。受信は送信元、送信は送信先) */
  remoteNumber: string;
  /** 相手の名前 (送信時の宛先・受信の発信元の表示) */
  remoteName?: string;
  /** 自社の FAX 番号 */
  localNumber?: string;
  /** 受信日時・送信の操作日時 */
  at: string;
  /** 送信が完了した日時 */
  completedAt?: string;
  pages?: number;
  /** PDF (または画像) のパス・ファイル名 */
  fileKey?: string;
  fileName: string;
  size?: number;
  contentType: string;
  /** mock = 模擬 (サンプルデータの検証環境のみ) / upload = 画面から登録 / manual = FAX 機で送信 / ほかは FAX サービスの名前 */
  provider: string;
  /** FAX サービスでの ID と、重複登録を防ぐ一意の参照 (provider:ID) */
  providerId?: string;
  providerRef?: string;
  /** 送信の操作ごとのキー (二重送信の防止。同じキーの送信は 1 回だけ) */
  idempotencyKey?: string;
  supplierId?: string;
  customerId?: string;
  purchaseOrderId?: string;
  /** 送信した発注書の版 */
  poVersion?: number;
  /** 関連する案件 (受注)。発注書の明細の案件・読み取った案件番号 */
  orderIds: string[];
  /** 閲覧範囲の店舗 (発注書・案件・顧客の店舗。未確定の受信 FAX は本社) */
  storeId: StoreId;
  /** 担当者 */
  assignedUserId?: string;
  /** 送信した人・登録した人 (FAX サービスからの受信は system) */
  userId: string;
  ai?: FaxAiResult;
  /** AI の判定待ち (受信の直後。失敗したときは定期実行で読み直す) */
  aiPending?: boolean;
  /** 送信を試みた回数と、次の自動再送の時刻 (通信エラーのとき) */
  attempts: number;
  nextRetryAt?: string;
  lastError?: string;
  events: FaxEvent[];
  /** 仕分け (取り込む・不要・戻す) をした人と日時 */
  decidedBy?: string;
  decidedAt?: string;
  /** 担当者が内容を確認した (返信 FAX の確認) */
  checkedBy?: string;
  checkedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * FAX 番号の台帳: blocked = 不要 (届いた FAX を自動で「不要」にする) / customer・supplier = 顧客・仕入先の FAX 番号
 * (仕入先は仕入先の台帳の FAX 番号でも判別する。ここには仕入先の 2 つ目以降の番号・顧客の FAX 番号を登録する)
 */
export type FaxNumberKind = "blocked" | "customer" | "supplier";

export interface FaxNumber {
  id: string;
  /** 数字だけ (一意) */
  number: string;
  kind: FaxNumberKind;
  customerId?: string;
  supplierId?: string;
  /** 名前 (例: ○○不動産 (広告)) */
  label: string;
  note?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/* ---------------- 地図・住宅地図 (顧客・案件・予定の場所と、許諾を確認した住宅地図の PDF) ---------------- */

/**
 * 場所 (地図上の 1 か所。複数の顧客・案件・予定が同じ場所を参照する)。
 * 顧客・見積・受注・予定の住所の文字は書き換えず、照合用のキー (src/lib/maps/address.ts) で結び付ける。
 * 番地のない住所の場所は自動では結び付けず、記録ごとの参照 (MapLocationRef) で結び付ける
 */
export interface MapLocation {
  id: string;
  /** 照合用のキー (都道府県 + 市区町村・町名 + 番地) */
  addressKey: string;
  /** 表示用の住所 (正規化した文字。元の住所は各記録に残る) */
  address: string;
  postalCode?: string;
  /** house = 番地まで / area = 番地なし・地区まで (自動では結び付けない) / none = 住所なし */
  precision: "house" | "area" | "none";
  /** 緯度経度 (Google マップのリンクに使うのは確認済み (coordStatus = verified) のときだけ) */
  lat?: number;
  lng?: number;
  /** Google の Place ID */
  placeId?: string;
  /** 位置の出どころ: manual = 人が地図で合わせた / geocode = 住所から自動で求めた / import = 取込 */
  coordSource?: "manual" | "geocode" | "import";
  /** unverified = 未確認 / needs_review = 要確認 (候補が複数・おおよその位置) / verified = 確認済み */
  coordStatus?: "unverified" | "needs_review" | "verified";
  coordVerifiedBy?: string;
  coordVerifiedAt?: string;
  /** 自動で位置を求めたときの結果の説明 (候補の数・精度) */
  geocodeNote?: string;
  /** 現地のメモ (例: 駐車場は裏・入口は北側) */
  note?: string;
  /** active / merged = 重複のため別の場所にまとめた (mergedInto へ参照を移した。行は残す) */
  status: "active" | "merged";
  mergedInto?: string;
  /** 登録元: app = 画面 / batch = 一括の正規化・取込 */
  source: "app" | "batch";
  /** 閲覧範囲の目安の店舗 (最初に登録した記録の店舗。参照する記録が他店舗にあれば、その店舗のメンバーも見られる) */
  storeId: StoreId;
  createdBy: string;
  createdAt: string;
  updatedBy?: string;
  updatedAt: string;
}

/** 場所の参照の対象 (顧客の住所・見積と受注の施工場所・予定の場所) */
export type MapRefType = "customer" | "quote" | "order" | "event";

/**
 * 記録と場所の明示的な結び付け (1 記録 1 行。ID は mlr_<type>_<recordId>)
 * - 顧客・見積・受注: mode = manual (番地のない住所を、人が選んだ場所に結び付けた)。住所の文字が変わったら外れる (addressSnapshot で判定)
 * - 予定: mode = follow (案件・お客様の場所に合わせる) / custom (この予定だけ別の場所。お客様の住所を変えても上書きしない)
 */
export interface MapLocationRef {
  id: string;
  recordType: MapRefType;
  recordId: string;
  mode: "manual" | "follow" | "custom";
  locationId?: string;
  /** 結び付けたときの記録の住所の文字 (変わったら結び付けを使わない) */
  addressSnapshot?: string;
  linkedBy: string;
  linkedAt: string;
}

/** 住宅地図などの地図の PDF (本体は VPS のディスク。ここには台帳とライセンスの情報だけ) */
/** 住宅地図を出力したときの用途 (ゼンリンの利用条件。src/lib/maps/purpose.ts) */
export type MapUsePurpose = "internal" | "official" | "contractor" | "neighbors";

export interface MapDocument {
  id: string;
  /** residential = 住宅地図 / other = その他の地図・案内図 */
  kind: "residential" | "other";
  /** 地図の提供元: zenrin = ゼンリン / other */
  provider: "zenrin" | "other";
  /** 表示名 (例: ゼンリン住宅地図 合志市 2025 p.123) */
  title: string;
  fileName: string;
  contentType: string;
  size: number;
  /** ファイルの SHA-256 (同じファイルの二重登録を防ぐ) */
  sha256: string;
  pageCount?: number;
  /** 保存先のキー (src/lib/storage.ts)。取り消し (removed) で本体を消したときは空 */
  storageKey?: string;
  /** active = 使用中 / replaced = 差し替え済み (古い版。台帳と本体は残す) / removed = 取り消し (台帳は残し、本体は消す) */
  status: "active" | "replaced" | "removed";
  /** 差し替えの前後 */
  replacesId?: string;
  replacedById?: string;
  /** upload = 画面から / bulk_import = 一括取込 / provider_api = 提供元の公式 API */
  source: "upload" | "bulk_import" | "provider_api";
  /** 取込元 (一括取込のフォルダー・ファイル名) */
  sourceRef?: string;
  /** 版・発行年 (例: 2025年版) */
  edition?: string;
  /** 著作権表示 (例: © ZENRIN CO., LTD.)。PDF の表示・ダウンロードでも消さない */
  copyrightNotice: string;
  /** 契約・許諾の番号やメモ */
  licenseRef?: string;
  licenseNote?: string;
  /** 「契約で社内サーバーへの保存と社内の複数人での閲覧が認められている」ことを確認した人と日時 */
  licenseConfirmedBy: string;
  licenseConfirmedAt: string;
  /** 複数の場所 (同じ地図の範囲の近所の場所) から参照してよい */
  shareable?: boolean;
  /**
   * 地図を出力したときの用途 (ゼンリン GIS の「印刷」「画像出力」で選ぶもの。src/lib/maps/purpose.ts)。
   * internal = 社内の資料 (契約部署の中だけ) / official = 官公署への届出 / contractor = 工事関係者への配布 / neighbors = 近隣住民への説明
   */
  usePurpose?: MapUsePurpose;
  /** 表札 (居住者名) の情報を含む地図 */
  nameplate?: boolean;
  /** 閲覧範囲の目安の店舗 (登録した記録の店舗) */
  storeId: StoreId;
  uploadedBy: string;
  uploadedAt: string;
  updatedAt: string;
  removedBy?: string;
  removedAt?: string;
  removeReason?: string;
}

/** 地図の PDF と場所の結び付け (1 つの PDF を複数の場所から参照できる。ID は mdl_<documentId>_<locationId>) */
export interface MapDocumentLink {
  id: string;
  documentId: string;
  locationId: string;
  linkedBy: string;
  linkedAt: string;
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
  /** アンケートの過去の集計 (H26〜R4。後から追加) */
  surveyHistory: SurveyHistoryRow[];
  sourceFiles: SourceFile[];
  photoAlbums: PhotoAlbum[];
  settings: AppSetting[];
  attachments: Attachment[];
  cashEntries: CashEntry[];
  deliveries: Delivery[];
  knowledge: KnowledgeEntry[];
  purchaseOrders: PurchaseOrder[];
  faxMessages: FaxMessage[];
  faxNumbers: FaxNumber[];
  mapLocations: MapLocation[];
  mapLocationRefs: MapLocationRef[];
  mapDocuments: MapDocument[];
  mapDocumentLinks: MapDocumentLink[];
  /* 管理会計 (types-mgmt.ts) */
  mgmtRules: MgmtRule[];
  itemCategories: ItemCategory[];
  salesAreas: SalesArea[];
  orderAttributions: OrderAttribution[];
  salesAdjustments: SalesAdjustment[];
  materials: Material[];
  materialCosts: MaterialCost[];
  boms: Bom[];
  materialUsages: MaterialUsage[];
  stockMoves: StockMove[];
  materialTransfers: MaterialTransfer[];
  purchaseLineAllocs: PurchaseLineAlloc[];
  expenseClasses: ExpenseClass[];
  mgmtEntries: MgmtEntry[];
  allocationRuns: AllocationRun[];
  periodCloses: PeriodClose[];
  /* 予定の計画 (types-plan.ts) */
  jobSpecs: JobSpec[];
  productionJobs: ProductionJob[];
  resourceBookings: ResourceBooking[];
  scheduleHolds: ScheduleHold[];
  /* 有給・休日出勤 (types-hr.ts) */
  leaveRequests: LeaveRequest[];
  leaveGrants: LeaveGrant[];
  holidayWorks: HolidayWork[];
  /* 作業日報・販促の記録 (types-ops.ts) */
  workReportDays: WorkReportDay[];
  promotions: Promotion[];
  /* 畳製造予定 (types-ops.ts。src/lib/production) */
  tatamiProduction: TatamiProduction[];
  /* 事務 (types-office.ts。事務改善シート・慶弔リスト) */
  officeImprovements: OfficeImprovement[];
  condolences: Condolence[];
  /* 文書の下書き (types-drafts.ts。AI アシスタントの「文書の作成」の保存・確認・承認・送信) */
  docDrafts: DocDraft[];
  /* 施工事例の投稿・整理整頓チェック (types-posts.ts。src/lib/case-posts.ts・src/lib/tidy.ts) */
  casePosts: CasePost[];
  tidyChecks: TidyCheck[];
}

export type CollectionName = Exclude<keyof Database, "meta">;
