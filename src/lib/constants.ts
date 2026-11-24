import type {
  ApprovalStatus,
  ApprovalType,
  AuditAction,
  CashSource,
  Channel,
  DeliveryChannel,
  DeliveryStatus,
  DocumentKind,
  DocumentStatus,
  ExpensePaymentMethod,
  ExpenseStatus,
  FaxAiLabel,
  FaxNumberKind,
  FaxStatus,
  FaxTriage,
  InquiryStatus,
  InvoiceStatus,
  OrderStatus,
  PaymentMethod,
  ProgressKind,
  PurchaseOrderStatus,
  PurchasePayMethod,
  PurchaseStatus,
  QuoteStatus,
  Role,
  ScheduleKind,
  ServiceCategory,
  SupplierKind,
  TaskStatus,
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
  admin: "全店舗の情報閲覧・設定変更・高額案件と店長のいない店舗の承認 (自分の申請は承認なしで反映)。経営ダッシュボードを利用",
  store_manager: "自店舗の全情報を管理し、見積・受注・経費を承認 (自分の申請は管理者が承認)",
  store_staff: "自店舗の顧客・問い合わせ・見積・施工進捗を登録 (承認は店長へ依頼。店長のいない店舗は管理者)",
  hq_staff: "全店舗の請求・入金・仕入・経費を横断して処理 (経理・総務)",
};

export const CHANNEL_LABEL: Record<Channel, string> = {
  phone: "電話",
  ai_phone: "AI電話受付",
  ai_chat: "AIテキスト相談",
  ai_voice: "AI音声相談",
  web: "Webフォーム",
  email: "メール",
  line: "LINE",
  chatwork: "Chatwork",
  visit: "来店・対面",
  mobile: "担当者の携帯",
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
  returned: { label: "契約差戻し (再申請待ち)", tone: "serious" },
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
  rejected: { label: "差戻し", tone: "serious" },
  denied: { label: "却下", tone: "critical" },
  paid: { label: "精算済", tone: "good" },
};

export const PURCHASE_STATUS: Record<PurchaseStatus, { label: string; tone: Tone }> = {
  received: { label: "受領 (支払依頼前)", tone: "neutral" },
  pending_approval: { label: "支払依頼中 (承認待ち)", tone: "warn" },
  approved: { label: "支払待ち (承認済)", tone: "accent" },
  paid: { label: "支払完了", tone: "good" },
  disputed: { label: "差戻し (照会中)", tone: "serious" },
  rejected: { label: "支払却下", tone: "critical" },
};

/** 発注書の状態 */
export const PURCHASE_ORDER_STATUS: Record<PurchaseOrderStatus, { label: string; tone: Tone }> = {
  draft: { label: "下書き", tone: "neutral" },
  issued: { label: "発行済み (送信待ち)", tone: "warn" },
  sent: { label: "送信済み", tone: "accent" },
  completed: { label: "完了", tone: "good" },
  cancelled: { label: "取消", tone: "critical" },
};

/** FAX の状態 (送信: 受付済み → 処理中 → 成功 / 失敗) */
export const FAX_STATUS: Record<FaxStatus, { label: string; tone: Tone }> = {
  queued: { label: "受付済み", tone: "neutral" },
  sending: { label: "処理中", tone: "info" },
  sent: { label: "送信成功", tone: "good" },
  failed: { label: "送信失敗", tone: "critical" },
  unknown: { label: "要確認 (送信できたか不明)", tone: "serious" },
  manual: { label: "FAX 機で送信", tone: "good" },
  received: { label: "受信", tone: "accent" },
};

/** 受信 FAX の仕分け */
export const FAX_TRIAGE: Record<FaxTriage, { label: string; tone: Tone }> = {
  auto: { label: "登録済みの番号", tone: "accent" },
  review: { label: "要確認", tone: "warn" },
  accepted: { label: "取り込み済み", tone: "good" },
  junk: { label: "不要", tone: "neutral" },
};

/** AI の判定 */
export const FAX_AI_LABEL: Record<FaxAiLabel, { label: string; tone: Tone }> = {
  business: { label: "業務関連", tone: "accent" },
  ad: { label: "広告・営業", tone: "serious" },
  unknown: { label: "判定不能", tone: "neutral" },
};

export const FAX_NUMBER_KIND_LABEL: Record<FaxNumberKind, string> = {
  blocked: "不要な番号",
  customer: "顧客の FAX",
  supplier: "仕入先の FAX",
};

export const PURCHASE_PAY_METHOD_LABEL: Record<PurchasePayMethod, string> = {
  bulk_transfer: "総合振込",
  transfer: "都度振込",
  cash: "現金",
  card: "法人カード",
  debit: "口座振替",
  other: "その他",
};

export const SUPPLIER_KIND_LABEL: Record<SupplierKind, string> = {
  supplier: "仕入先",
  partner: "協力業者",
};

export const APPROVAL_STATUS: Record<ApprovalStatus, { label: string; tone: Tone }> = {
  pending: { label: "承認待ち", tone: "warn" },
  approved: { label: "承認", tone: "good" },
  returned: { label: "差戻し", tone: "serious" },
  rejected: { label: "却下", tone: "critical" },
  cancelled: { label: "取下げ", tone: "neutral" },
};

export const APPROVAL_TYPE_LABEL: Record<ApprovalType, string> = {
  quote: "見積の確定",
  quote_amend: "確定見積の金額変更",
  order: "受注 (契約) の確定",
  expense: "経費精算",
  purchase: "仕入請求書の支払",
  order_change: "契約内容の変更",
  customer_change: "顧客の重要情報の変更",
  record_view: "顧客情報の閲覧の申請",
  handover_change: "引取・納品日の変更",
};

/** 承認の判断の説明 (承認・差戻し・却下で記録の扱いが変わる) */
export const APPROVAL_DECISION_HELP = {
  approved: "承認: 申請の内容を反映します",
  returned: "差戻し: 申請者に戻します。修正して再申請できます",
  rejected: "却下: 申請を認めません (再申請はしない前提。記録は残ります)",
} as const;

export const DOCUMENT_KIND_LABEL: Record<DocumentKind, string> = {
  handwritten_quote: "手書き見積書",
  drawing: "現場図面・採寸メモ",
  site_document: "施工資料 (仕様書・指示書・注文書)",
  supplier_invoice: "請求書 (仕入先・業者から)",
  receipt: "レシート・領収書",
  contract: "契約書",
  survey_postcard: "お客様アンケート (はがき)",
  reception: "受付メモ (問い合わせ・電話の内容)",
  other: "その他",
};

export const DOCUMENT_STATUS: Record<DocumentStatus, { label: string; tone: Tone }> = {
  uploaded: { label: "取込済", tone: "neutral" },
  extracted: { label: "読取完了 (確認待ち)", tone: "warn" },
  failed: { label: "読取失敗 (手入力)", tone: "critical" },
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
 * - short: 予定表のアイコンの横に出す短い名前 (お客様のご要望 2026-11-23「アイコンの横に『納品』『引取』『見積り』『顧客訪問』『現場管理』などの文字」)
 * survey は見積り (現地調査・見積) の予定 (お客様の言い方は「見積予定」)
 */
export const SCHEDULE_KIND: Record<ScheduleKind, { label: string; short: string; tone: Tone; group: ScheduleGroup; minutes: number }> = {
  survey: { label: "見積り", short: "見積", tone: "info", group: "case", minutes: 60 },
  site_survey: { label: "現地調査 (現調)", short: "現調", tone: "info", group: "case", minutes: 60 },
  onsite_quote: { label: "現場見積 (現見)", short: "現見", tone: "info", group: "case", minutes: 120 },
  measure: { label: "採寸", short: "採寸", tone: "info", group: "case", minutes: 60 },
  pickup: { label: "引き取り", short: "引取", tone: "warn", group: "case", minutes: 60 },
  delivery: { label: "納品", short: "納品", tone: "good", group: "case", minutes: 90 },
  install: { label: "施工", short: "施工", tone: "accent", group: "case", minutes: 360 },
  visit: { label: "顧客訪問", short: "顧客訪問", tone: "serious", group: "case", minutes: 60 },
  site: { label: "現場管理", short: "現場管理", tone: "accent", group: "case", minutes: 60 },
  meeting: { label: "会議・打合せ", short: "会議", tone: "neutral", group: "internal", minutes: 60 },
  gathering: { label: "会合", short: "会合", tone: "neutral", group: "internal", minutes: 120 },
  company: { label: "社内行事", short: "社内行事", tone: "neutral", group: "internal", minutes: 120 },
  event: { label: "イベント", short: "イベント", tone: "neutral", group: "internal", minutes: 0 },
  leave: { label: "休暇・不在", short: "休暇", tone: "critical", group: "internal", minutes: 0 },
  other: { label: "その他", short: "その他", tone: "neutral", group: "internal", minutes: 60 },
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

/** 業務依頼の状態 (依頼 → 確認 → 報告 → 完了) */
export const TASK_STATUS: Record<TaskStatus, { label: string; tone: Tone }> = {
  requested: { label: "依頼中 (未確認)", tone: "warn" },
  acknowledged: { label: "対応中", tone: "info" },
  reported: { label: "報告あり (確認待ち)", tone: "accent" },
  confirmed: { label: "完了", tone: "good" },
};

export const CASH_SOURCE_LABEL: Record<CashSource, string> = {
  manual: "手入力",
  opening: "繰越",
  payment: "入金から自動",
  expense: "経費精算から自動",
  purchase: "仕入の支払から自動",
};

/** 現金出納の科目・区分 (入金 / 出金)。経費の勘定科目も出金に使える */
export const CASH_IN_ACCOUNTS = ["売掛金回収 (現金入金)", "小口現金補充", "銀行引出", "雑収入", "その他の入金"] as const;
export const CASH_OUT_ACCOUNTS = ["銀行預入", "小口現金返却", "仕入 (現金払い)", "その他の出金"] as const;

export const DELIVERY_CHANNEL_LABEL: Record<DeliveryChannel, string> = {
  email: "メール",
  line: "LINE",
  chatwork: "Chatwork",
};

export const DELIVERY_STATUS: Record<DeliveryStatus, { label: string; tone: Tone }> = {
  sent: { label: "送信", tone: "good" },
  failed: { label: "送信失敗", tone: "critical" },
  skipped: { label: "記録のみ (送信の設定なし)", tone: "neutral" },
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
  view: "閲覧",
};

export const ENTITY_LABEL: Record<string, string> = {
  customer: "顧客",
  knowledge: "社内資料 (ナレッジ)",
  registry: "データ台帳 (資料庫)",
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
  cash: "現金出納",
  comm: "やりとり履歴",
  delivery: "送信",
  settings: "設定",
  survey: "アンケート",
  quality: "クレーム・手直し",
  review: "口コミ",
  attachment: "添付ファイル",
  store: "店舗",
  accounting: "会計データ",
  map_location: "場所 (地図)",
  map_document: "住宅地図 (PDF)",
  map_batch: "地図の一括処理",
  leave: "休暇 (有給・振休)",
  holiday_work: "休日出勤",
  leave_grant: "有給の付与",
  work_report: "作業日報",
  production: "畳製造予定",
  holiday: "休日カレンダー",
  promotion: "販促の記録",
  office_improvement: "事務改善シート",
  condolence: "慶弔リスト",
  material: "材料マスタ (縁の品番など)",
  stock_move: "在庫の移動 (縁在庫・材料)",
  doc_draft: "文書の下書き",
  case_post: "施工事例の投稿",
  tidy_check: "整理整頓チェック",
};

/** 勘定科目 (仕入) */
export const PURCHASE_ACCOUNTS = ["仕入高", "材料費", "外注費", "消耗品費", "荷造運賃", "修繕費", "支払手数料", "雑費"] as const;

/** 勘定科目 (経費)。備品は 10 万円未満なら消耗品費、10 万円以上は工具器具備品 (固定資産) */
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
  "工具器具備品",
  "荷造運賃",
  "支払手数料",
  "租税公課",
  "福利厚生費",
  "新聞図書費",
  "雑費",
] as const;

/** 承認ルール (閾値) */
export const APPROVAL_RULES = {
  /** 見積・受注: この金額以上は管理者承認 */
  quoteAdminThreshold: 500_000,
  /** 経費: この金額以上は管理者承認 */
  expenseAdminThreshold: 50_000,
} as const;
