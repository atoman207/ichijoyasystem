import type { CaseRequestKind, MediaKey, QuoteItem, ReceiptPart, ScheduleKind, StoreId } from "@/lib/db/types";
import type { TaxMode } from "@/lib/quote-calc";
import type { AttachmentView } from "@/lib/attachments";
import type { HandoverFormRow } from "@/lib/handover";
import type { FormStore, FormUser } from "./form-parts";
import type { ReceiptCheck } from "@/lib/receipts";

/** 予定表で予定を押したときの小さな画面の中身 (/api/schedule/events/[id] → EventQuickDialog) */
export interface EventQuickData {
  id: string;
  title: string;
  /** 予定表に出す件名「（町名）お客様」 */
  label: string;
  area?: string;
  kind: ScheduleKind;
  date: string;
  endDate?: string;
  startTime?: string;
  endTime?: string;
  slot?: "am" | "pm";
  memo: string;
  location?: string;
  period: string;
  storeId: StoreId;
  storeName: string;
  assigneeIds: string[];
  assignees: string[];
  /** 仕事内容 (畳 12・襖 6 など) */
  work?: string;
  /** 仕事内容の省略表記 (タ12 フ6。入力欄の初期値) */
  workText?: string;
  /** 予定表で手で決めた仕事内容 (ScheduleEvent.work。なければ自動) */
  workManual?: string;
  /** 施工店舗 (案件の店舗 = 売上の店舗) の変更 (お客様のご要望 2026-11-24。src/lib/case-store.ts) */
  storeChange?: QuickStoreChange;
  /** 予定の削除 (小さな画面のいちばん下。確認してから) */
  remove?: QuickRemove;
  /** 重複の確認に渡す案件 ("order:o_1" など) */
  caseRef?: string;
  case?: { label: string; title: string; href: string; canOpen: boolean };
  /** ひも付いているお客様 (問い合わせを既存の顧客にひも付けたあとは、その顧客) */
  customer?: { name: string; href?: string; phones: string[]; address: string; corporate: boolean; placeholder: boolean };
  /** 受付のときのお名前 (お客様の登録と違うとき・未登録のとき) */
  contactName?: string;
  contactPhone?: string;
  /** お客様が未登録・仮の顧客のときの「紐づける」の画面 */
  inquiryHref?: string;
  /** 受注と連動する予定 (種類は変えられない) */
  synced: boolean;
  /** 受注の引取・納品の日程と連動 */
  handover: boolean;
  /** 予定の変更・削除に承認が要る (設定 → 承認ルール。既定 = 不要) */
  scheduleApproval: boolean;
  lockKind: boolean;
  canEdit: boolean;
  hold: boolean;
  /** 地図 (Google マップ・登録済みの住宅地図。お客様のご要望 2026-11-24「② 予定表からの地図表示」) */
  map?: QuickMap;
  /** 担当者の選択肢 (予定の店舗の社員 → 本部 → ほかの店舗。お客様のご要望 2026-11-24「⑥」) */
  staff: QuickStaff[];
  /** 引取・現見 ⇄ 納品 の相手の予定 (お客様のご要望 2026-11-24「⑦」。src/lib/schedule-pair.ts) */
  pair?: QuickPair;
  /** 案件の確認・変更・追加 (お客様のご要望 2026-11-25「③⑤⑨⑩」。src/lib/actions/case-quick.ts) */
  caseEdit?: QuickCase;
  /** 担当店舗・担当者への依頼 (メンション。お客様のご要望 2026-11-25「⑪」。src/lib/case-requests.ts) */
  request?: QuickRequest;
  /** この案件で: 見積書の撮影・受注 (日程)・資料・帳票 (お客様のご要望 2026-11-25「②〜⑧」) */
  caseWork?: QuickWork;
}

export interface QuickRequest {
  /** 依頼する案件 (例: 受注 O-2026-0012 山田 花子 様) */
  caseLabel: string;
  /** 宛先の店舗の初期値 (案件の店舗) */
  storeId: StoreId;
  stores: { id: StoreId; name: string }[];
  kinds: { id: CaseRequestKind; label: string; hint: string }[];
  /** この案件への対応中の依頼 */
  open: { id: string; title: string; status: string; at: string; from: string; to: string }[];
}

export interface QuickCase {
  /** 案件のいちばん進んだ記録 (なければ案件のない予定) */
  caseId?: string;
  caseNumber?: string;
  /** 案件を変えられる (担当店舗のメンバー・店長以上。入金まで終わった案件は管理者) */
  canEdit: boolean;
  lock?: string;
  /** 施工現場の住所 (依頼主の住所と違うとき)。依頼主 = お客様の住所 */
  site?: { address: string; requester: string; corporate: boolean; canEdit: boolean };
  /** 見積の明細 (仕様・枚数・単価) */
  quote?: QuickQuote;
  /** 見積のない受注 (移行した受注など): 金額だけ */
  orderTotal?: number;
  orderHref?: string;
  /** お客様の付け替え (紐付け間違いの修正) */
  relink?: { canRelink: boolean; blocked?: string; current?: string };
  /** 同じお客様の新しい案件 */
  newCase?: { customerId: string; customerName: string; corporate: boolean; media: MediaKey; storeId: StoreId; categories: { id: string; label: string }[]; kinds: { id: ScheduleKind; label: string }[] };
  /** 作業の担当 (実績) の確認 (受注のとき。src/lib/work-staff.ts) */
  workStaff?: { href: string; source: "saved" | "auto"; rows: { role: string; names: string }[] };
}

export interface QuickQuote {
  id: string;
  number: string;
  href: string;
  draft: boolean;
  version: number;
  items: QuoteItem[];
  discount: number;
  taxMode: TaxMode;
  total: number;
  /** この画面で明細を変えられる */
  editable: boolean;
  /** 変えられない理由 (承認待ち・請求書を発行済みなど) */
  blocked?: string;
  /** 承認なしで反映する差額 (円。0 = 使わない) */
  smallLimit: number;
  /** 確定した売上 (施工完了・請求済・入金済) の案件: 金額の変更は管理者の承認 */
  confirmedSales: boolean;
  /** 申請者が店長・管理者 (承認を省略できる) */
  ownApproval: boolean;
}

export interface QuickStoreChange {
  /** case = 案件の施工店舗 (申請) / event = 案件のない予定の店舗 (すぐ変える) */
  mode: "case";
  caseLabel: string;
  current: StoreId;
  currentName: string;
  options: { id: StoreId; name: string }[];
  /** 変更 (申請) できる */
  canChange: boolean;
  /** 変えられない理由 (請求書を発行済みなど) */
  blocked?: string;
  /** 承認待ちの申請 (例: 西店への変更を申請中) */
  pending?: string;
  /** 店長 (管理者) の承認が要る / 承認者 */
  needsApproval: boolean;
  approver: string;
}

export interface QuickRemove {
  /** event = 予定だけ削除 / handover = 受注の引取・納品の日程から外す (申請のことがある) / order = 受注の施工予定 (ここでは消せない) */
  mode: "event" | "handover" | "order";
  canDelete: boolean;
  needsApproval: boolean;
  approver?: string;
  /** 受注の画面 (施工予定の変更) */
  orderHref?: string;
  /** あわせて削除できる関連する予定 (引取 ⇄ 納品。お客様のご要望 2026-11-25「①」) */
  pair?: { want: "delivery" | "origin"; events: { id: string; label: string }[] };
}

export interface QuickStaff {
  id: string;
  name: string;
  /** 略称 (1 文字。スプレッドシートの略称と同じ決め方。顔写真のないときの読み上げ・検索用) */
  initial: string;
  /** 顔写真の URL (予定表のチップと同じく顔写真で出す。なければ名前の 1 文字の丸) */
  avatar?: string;
  storeId: StoreId;
  storeName: string;
  color: string;
  /** 予定の店舗 / 本部 (全店舗共通) / ほかの店舗 */
  group: "store" | "common" | "other";
}

export interface QuickMap {
  /** 地図を見られない (店舗のメンバー・予定の担当者だけ) */
  hidden?: boolean;
  address: string;
  heading: string;
  searchUrl?: string;
  directionsUrl?: string;
  docs: { id: string; title: string }[];
  canEdit: boolean;
  /** 場所の詳細・位置の修正 */
  placeHref?: string;
  zenrinUrl: string;
}

export interface QuickPairEvent {
  id: string;
  kind: ScheduleKind;
  period: string;
  label: string;
  assignees: string[];
  date: string;
  startTime?: string;
  endTime?: string;
  slot?: "am" | "pm";
  assigneeIds: string[];
  /** この画面から日時・担当を変えられる / 削除できる (受注の施工予定・完了した受注の予定は不可) */
  canEdit: boolean;
}

export interface QuickPair {
  /** delivery = 納品を探す (引取・現見の予定) / origin = 引取・現見を探す (納品の予定) */
  want: "delivery" | "origin";
  events: QuickPairEvent[];
  /** 「納品予定を追加」できる (引取・現見の予定で、納品が未登録か納品日の決まっていない品目がある) */
  canAdd: boolean;
  /** 受注の日程の品目に納品日を入れる (order) / 納品の予定を足す (event) */
  addMode: "order" | "event";
  /** 受注の日程で納品日が決まっていない品目 (名前) */
  undated: string[];
}

/** 予定表の小さな画面の「この案件で」(お客様のご要望 2026-11-25「予定表 → 案件 → 見積書撮影・登録 → 受注登録 → 日程登録 → 資料登録 → 帳票出力」) */
export interface QuickWork {
  caseLabel: string;
  /** ② 手書きの見積書を撮影して見積を作る (見積のない案件) */
  capture?: { inquiryId?: string; customerId?: string };
  /** 見積の画面 (見積がある案件) */
  quote?: { id: string; number: string; status: string; href: string };
  /** ③④ 受注にする (日程つき)。見積が承認前なら「現場で受注」(見積の承認とあわせて申請) */
  toOrder?: {
    quoteId: string;
    quoteNumber: string;
    total: number;
    onsite: boolean;
    own: boolean;
    approvalNote: string;
    initial: HandoverFormRow[];
    /** 手書きの見積書の「引取日時」「納品日時」(日程の案の元) */
    sourceText?: string;
    workerIds: string[];
    siteAddress: string;
    storeId: StoreId;
    users: FormUser[];
    stores: FormStore[];
    currentUserId: string;
    /** 同じ案件の訪問 (見積・現調・現見) の予定。作業 (引取・施工) がその日なら新しい予定を足さずに「現見」に切り替わる */
    visits: { date: string; label: string; time: string }[];
  };
  /** 受注にできない理由 (承認待ちの変更など) */
  orderBlocked?: string;
  order?: { id: string; number: string; status: string; href: string };
  /** ⑤ 資料・写真 (案件の問い合わせ・見積・受注に登録したもの。登録先は一番進んだ記録) */
  files?: { parentType: "inquiry" | "quote" | "order"; parentId: string; parentLabel: string; canAdd: boolean; accept: string; items: AttachmentView[]; more: number };
  /** ⑥⑦⑧ 帳票 */
  docs?: QuickDocs;
}

export interface QuickDocs {
  quote?: { id: string; number: string; version: number; draft: boolean; outputs: number; canPrint: boolean };
  invoice?: { id: string; number: string; total: number; paidAmount: number; outputs: number; canPrint: boolean; href: string };
  /** 納品書 (受注。請求書と同じ内容で表題が「納品書」) */
  delivery?: { orderId: string; number: string; outputs: number; canPrint: boolean };
  /** 請求書がないとき: 発行できるか (店長・本部・管理者。施工完了の前も) */
  invoiceIssue?: { ok: boolean; pre: boolean; reason?: string; orderId: string; total: number };
  receipt?: {
    wanted: boolean;
    auto: boolean;
    reason: string;
    canSetWanted: boolean;
    orderId: string;
    issued: { id: string; number: string; amount: number; parts: string; outputs: number; status: "issued" | "void" }[];
    form?: { invoiceId: string; invoiceNumber: string; total: number; paidAmount: number; remaining: number; amount: number; parts: ReceiptPart[]; beforePayment: boolean; addressee: string; honorific: "様" | "御中"; purpose: string };
    checks: ReceiptCheck[];
  };
  /** まとめて印刷の画面 (その日・その店舗) */
  batchHref: string;
}
