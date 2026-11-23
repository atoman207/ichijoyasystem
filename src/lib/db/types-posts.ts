import type { StoreId } from "./types";

/**
 * 施工事例の投稿 (お客様のご要望 2026-11-23「■7. 施工事例写真の活用」) と 整理整頓チェック (「■8. 整理整頓チェック」) の型
 * ------------------------------------------------------------
 * 施工事例の投稿: 案件 (受注) の写真・商品名・施工内容から AI で投稿文の下書きを作り、確認する人 (設定) が確認してから投稿する。
 *   進み方: draft (下書き) → review (確認依頼) → approved (承認済み) → posted (投稿済み)。returned = 差し戻し (理由つき)、discarded = 取りやめ。
 *   SNS への自動の投稿はしない (API なし): 画面で文面をコピーし、写真を保存して手で投稿し、投稿した日・URL を記録する。
 *   処理は src/lib/case-posts.ts、操作は src/lib/actions/case-posts.ts、画面は 資料・写真 → 施工事例の投稿 (/materials?tab=cases)
 * 整理整頓チェック: 店舗ごとのチェック項目 (設定。管理者が変える) を 良い / 要改善 / 対象外 で記録し、要改善は直すまで追う。
 *   処理は src/lib/tidy.ts、操作は src/lib/actions/tidy.ts、画面は KPI → 整理整頓 (/kpi/tidy)
 */

export type CasePostStatus = "draft" | "review" | "approved" | "returned" | "posted" | "discarded";

/** 投稿先 */
export type CasePostChannel = "instagram" | "website" | "google" | "facebook" | "line" | "other";

/** お客様の掲載の了承 */
export type CasePostConsent = "unconfirmed" | "obtained" | "not_needed";

export type CasePostAction = "create" | "edit" | "ai" | "photos" | "request" | "approve" | "return" | "withdraw" | "post" | "discard" | "restore";

/** 処理の記録 (誰が・いつ・何をしたか) */
export interface CasePostEvent {
  at: string;
  by: string;
  action: CasePostAction;
  from?: CasePostStatus;
  to?: CasePostStatus;
  /** 差し戻しの理由・投稿先など */
  comment?: string;
}

/** 投稿した記録 (投稿先ごと) */
export interface CasePostPosting {
  channel: CasePostChannel;
  /** 投稿した日 (YYYY-MM-DD) */
  on: string;
  url?: string;
  by: string;
  at: string;
}

export interface CasePost {
  id: string;
  /** 番号 (例: CP-2026-0001) */
  number: string;
  /** 案件 (受注) */
  orderId: string;
  /** 閲覧範囲の店舗 (受注の店舗) */
  storeId: StoreId;
  /** 投稿の見出し (例: 合志市 和室 6 畳の表替え) */
  title: string;
  /** 使う写真 (受注の添付ファイルの ID。並び順 = 投稿の順) */
  photoIds: string[];
  /** 商品名 (1 行に 1 つ) */
  products: string;
  /** 施工内容 */
  workContent: string;
  /** 地域 (町名まで。番地・建物名は入れない) */
  area?: string;
  channels: CasePostChannel[];
  /** 最後に AI (または定型文) で作った下書き */
  aiText?: string;
  /** 投稿文 (人が直した文。これを投稿する) */
  text: string;
  /** ハッシュタグ (空白区切り。#付き) */
  hashtags: string;
  /** 最後の下書きを作ったもの */
  provider: "claude" | "openai" | "rules" | "manual";
  consent: CasePostConsent;
  status: CasePostStatus;
  requestedBy?: string;
  requestedAt?: string;
  approvedBy?: string;
  approvedAt?: string;
  postedAt?: string;
  postings: CasePostPosting[];
  events: CasePostEvent[];
  createdBy: string;
  createdAt: string;
  updatedBy?: string;
  updatedAt: string;
}

/* ---------------- 整理整頓チェック ---------------- */

/** ok = 良い / ng = 要改善 / na = 対象外 */
export type TidyResult = "ok" | "ng" | "na";

/** 項目ごとの結果 (項目のキーと名前はチェックした時点の写し。設定の項目を変えても過去の記録は変わらない) */
export interface TidyItemResult {
  key: string;
  label: string;
  group?: string;
  result: TidyResult;
  note?: string;
  /** 要改善の直す期限 */
  dueDate?: string;
  /** 要改善の対応: open = 未対応 / fixed = 直した */
  fixStatus?: "open" | "fixed";
  fixedAt?: string;
  fixedBy?: string;
  fixNote?: string;
}

/** チェックの写真 (本体は VPS のディスク。storage.ts の tidy/。URL は /api/tidy/photos/<チェックの ID>/<写真の ID>) */
export interface TidyPhoto {
  id: string;
  key: string;
  thumbKey?: string;
  fileName: string;
  contentType: string;
  size: number;
  width?: number;
  height?: number;
  takenAt?: string;
  caption?: string;
  /** どの項目の写真か (任意) */
  itemKey?: string;
  /** LINE の「整理整頓の確認」グループから取り込んだ写真 (グループ ID:メッセージ ID) */
  lineRef?: string;
  uploadedBy: string;
  uploadedAt: string;
}

export interface TidyCheck {
  id: string;
  /** 番号 (例: TC-2026-0001) */
  number: string;
  storeId: StoreId;
  /** チェックした日 */
  date: string;
  /** チェックした人 */
  checkedBy: string;
  /** 場所 (任意。例: 作業場・店頭・車両) */
  place?: string;
  items: TidyItemResult[];
  /** 良い ÷ (良い + 要改善) × 100 (対象外は数えない)。項目がなければ空 */
  score?: number;
  okCount: number;
  ngCount: number;
  naCount: number;
  comment?: string;
  photos: TidyPhoto[];
  /** チェックに使った項目の設定 (暫定の項目か) */
  provisional?: boolean;
  createdBy: string;
  createdAt: string;
  updatedBy?: string;
  updatedAt: string;
}
