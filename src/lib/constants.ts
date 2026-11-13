import type {
  ApprovalStatus,
  ApprovalType,
  AuditAction,
  Channel,
  DocumentKind,
  DocumentStatus,
  ExpensePaymentMethod,
  ExpenseStatus,
  InquiryStatus,
  InvoiceStatus,
  OrderStatus,
  PaymentMethod,
  ProgressKind,
  PurchaseStatus,
  QuoteStatus,
  Role,
  ScheduleKind,
  ServiceCategory,
  ThreadKind,
} from "@/lib/db/types";

/** バッジの色種別 (アイコン・ラベルと併用し、色のみに意味を持たせない) */
export type Tone =
  | "neutral"
  | "info"
  | "good"
  | "warn"
  | "serious"
  | "critical"
  | "accent";

export const ROLE_LABEL: Record<Role, string> = {
  admin: "管理者",
  store_manager: "店長",
  store_staff: "店舗スタッフ",
  hq_staff: "本部スタッフ",
};

export const ROLE_DESCRIPTION: Record<Role, string> = {
  admin: "全店舗の情報閲覧・設定変更・高額案件と店長のいない店舗の承認。経営ダッシュボードを利用",
  store_manager: "自店舗の全情報を管理し、見積・受注・経費を承認 (自分の申請は管理者が承認)",
  store_staff: "自店舗の顧客・問い合わせ・見積・施工進捗を登録 (承認は店長へ依頼。店長のいない店舗は管理者)",
  hq_staff: "全店舗の請求・入金・仕入・経費を横断して処理 (経理・総務)",
};

export const CHANNEL_LABEL: Record<Channel, string> = {
  phone: "電話",
  ai_phone: "AI電話受付",
  web: "Webフォーム",
  email: "メール",
  line: "LINE",
  chatwork: "Chatwork",
  visit: "来店・対面",
  mail: "郵送",
  event: "イベント・展示会",
  referral: "紹介",
  unknown: "未登録",
};

export const CATEGORY_LABEL: Record<ServiceCategory, string> = {
  tatami: "畳",
  fusuma: "襖",
  shoji: "障子",
  amido: "網戸",
  curtain: "カーテン・ブラインド",
  cloth: "クロス張替え",
  other: "その他",
};

export const INQUIRY_STATUS: Record<InquiryStatus, { label: string; tone: Tone }> = {
  new: { label: "新規", tone: "info" },
  in_progress: { label: "対応中", tone: "warn" },
  quoted: { label: "見積提出済", tone: "accent" },
  won: { label: "受注", tone: "good" },
  lost: { label: "失注", tone: "neutral" },
  closed: { label: "完了", tone: "neutral" },
};

export const QUOTE_STATUS: Record<QuoteStatus, { label: string; tone: Tone }> = {
  draft: { label: "下書き", tone: "neutral" },
  pending_approval: { label: "承認待ち", tone: "warn" },
  approved: { label: "承認済", tone: "accent" },
  sent: { label: "送付済", tone: "info" },
  accepted: { label: "受注", tone: "good" },
  rejected: { label: "失注", tone: "neutral" },
  expired: { label: "期限切れ", tone: "neutral" },
};

export const ORDER_STATUS: Record<OrderStatus, { label: string; tone: Tone }> = {
  pending_approval: { label: "契約承認待ち", tone: "warn" },
  confirmed: { label: "受注確定", tone: "accent" },
  scheduled: { label: "施工予定", tone: "info" },
  in_progress: { label: "施工中", tone: "info" },
  completed: { label: "施工完了", tone: "good" },
  invoiced: { label: "請求済", tone: "good" },
  paid: { label: "入金済", tone: "neutral" },
  cancelled: { label: "キャンセル", tone: "critical" },
};

export const INVOICE_STATUS: Record<InvoiceStatus, { label: string; tone: Tone }> = {
  draft: { label: "下書き", tone: "neutral" },
  issued: { label: "発行済", tone: "info" },
  partially_paid: { label: "一部入金", tone: "warn" },
  paid: { label: "入金済", tone: "good" },
  overdue: { label: "期日超過", tone: "critical" },
  void: { label: "無効", tone: "neutral" },
};

export const EXPENSE_STATUS: Record<ExpenseStatus, { label: string; tone: Tone }> = {
  draft: { label: "下書き", tone: "neutral" },
  pending_approval: { label: "承認待ち", tone: "warn" },
  approved: { label: "承認済", tone: "accent" },
  rejected: { label: "差戻し", tone: "critical" },
  paid: { label: "精算済", tone: "good" },
};

export const PURCHASE_STATUS: Record<PurchaseStatus, { label: string; tone: Tone }> = {
  received: { label: "受領", tone: "neutral" },
  pending_approval: { label: "支払承認待ち", tone: "warn" },
  approved: { label: "支払承認済", tone: "accent" },
  paid: { label: "支払済", tone: "good" },
  disputed: { label: "照会中", tone: "critical" },
};

export const APPROVAL_STATUS: Record<ApprovalStatus, { label: string; tone: Tone }> = {
  pending: { label: "承認待ち", tone: "warn" },
  approved: { label: "承認", tone: "good" },
  rejected: { label: "却下", tone: "critical" },
  cancelled: { label: "取下げ", tone: "neutral" },
};

export const APPROVAL_TYPE_LABEL: Record<ApprovalType, string> = {
  quote: "見積の確定",
  quote_amend: "確定見積の金額変更",
  order: "受注 (契約) の確定",
  expense: "経費精算",
  purchase: "仕入請求書の支払",
};

export const DOCUMENT_KIND_LABEL: Record<DocumentKind, string> = {
  handwritten_quote: "手書き見積書",
  drawing: "現場図面・採寸メモ",
  supplier_invoice: "仕入先請求書",
  receipt: "レシート・領収書",
  contract: "契約書",
  other: "その他",
};

export const DOCUMENT_STATUS: Record<DocumentStatus, { label: string; tone: Tone }> = {
  uploaded: { label: "取込済", tone: "neutral" },
  extracted: { label: "読取完了 (確認待ち)", tone: "warn" },
  confirmed: { label: "登録済", tone: "good" },
  discarded: { label: "破棄", tone: "neutral" },
};

export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  cash: "現金",
  transfer: "銀行振込",
  card: "クレジットカード",
  paypay: "PayPay",
  other: "その他",
};

export const EXPENSE_METHOD_LABEL: Record<ExpensePaymentMethod, string> = {
  cash: "現金",
  card: "法人カード",
  transfer: "振込",
};

export type ScheduleGroup = "case" | "internal";

export const SCHEDULE_GROUP_LABEL: Record<ScheduleGroup, string> = {
  case: "案件の予定",
  internal: "社内・その他の予定",
};

/**
 * 予定の種別 (表示順 = この並び)
 * - group: case = 案件 (問い合わせ・見積・受注) に紐づく予定 / internal = 案件と関係のない予定
 * - minutes: 開始時刻を入れたときの標準の所要時間 (終了時刻の初期値)。0 は終日を既定にする
 */
export const SCHEDULE_KIND: Record<ScheduleKind, { label: string; tone: Tone; group: ScheduleGroup; minutes: number }> = {
  survey: { label: "現地調査", tone: "info", group: "case", minutes: 60 },
  measure: { label: "採寸", tone: "info", group: "case", minutes: 60 },
  pickup: { label: "引き取り", tone: "warn", group: "case", minutes: 60 },
  delivery: { label: "納品", tone: "good", group: "case", minutes: 90 },
  install: { label: "施工", tone: "accent", group: "case", minutes: 360 },
  visit: { label: "顧客訪問", tone: "serious", group: "case", minutes: 60 },
  meeting: { label: "会議・打合せ", tone: "neutral", group: "internal", minutes: 60 },
  gathering: { label: "会合", tone: "neutral", group: "internal", minutes: 120 },
  company: { label: "社内行事", tone: "neutral", group: "internal", minutes: 120 },
  event: { label: "イベント", tone: "neutral", group: "internal", minutes: 0 },
  leave: { label: "休暇・不在", tone: "critical", group: "internal", minutes: 0 },
  other: { label: "その他", tone: "neutral", group: "internal", minutes: 60 },
};

export const SCHEDULE_KINDS = Object.keys(SCHEDULE_KIND) as ScheduleKind[];

/** 予定の繰り返し (登録時に個別の予定として展開する) */
export const SCHEDULE_REPEAT = {
  none: "繰り返さない",
  weekly: "毎週",
  biweekly: "隔週",
  monthly: "毎月 (同じ日)",
} as const;
export type ScheduleRepeat = keyof typeof SCHEDULE_REPEAT;

export const THREAD_KIND_LABEL: Record<ThreadKind, string> = {
  request: "依頼",
  report: "報告",
  question: "確認・質問",
  notice: "連絡",
};

export const PROGRESS_KIND_LABEL: Record<ProgressKind, string> = {
  note: "メモ",
  survey: "現場調査",
  production: "製作・手配",
  install: "施工",
  complete: "完了",
  change: "変更",
};

export const AUDIT_ACTION_LABEL: Record<AuditAction, string> = {
  create: "登録",
  update: "更新",
  delete: "削除",
  approve: "承認",
  reject: "却下",
  submit: "申請",
  send: "送付",
  status: "状態変更",
  login: "ログイン",
  logout: "ログアウト",
  export: "書き出し",
  import: "取込",
};

export const ENTITY_LABEL: Record<string, string> = {
  customer: "顧客",
  inquiry: "問い合わせ",
  quote: "見積",
  order: "受注・施工",
  invoice: "請求書",
  payment: "入金",
  expense: "経費",
  purchase: "仕入請求書",
  supplier: "仕入先",
  approval: "承認",
  thread: "社内連絡",
  schedule: "予定",
  document: "取込書類",
  user: "ユーザー",
  product: "商品",
  session: "セッション",
  data: "データ",
};

/** 勘定科目 (経費) */
export const EXPENSE_ACCOUNTS = [
  "消耗品費",
  "車両費 (ガソリン代)",
  "旅費交通費",
  "通信費",
  "接待交際費",
  "会議費",
  "水道光熱費",
  "修繕費",
  "広告宣伝費",
  "材料費",
  "雑費",
] as const;

/** 承認ルール (閾値) */
export const APPROVAL_RULES = {
  /** 見積・受注: この金額以上は管理者承認 */
  quoteAdminThreshold: 500_000,
  /** 経費: この金額以上は管理者承認 */
  expenseAdminThreshold: 50_000,
} as const;
