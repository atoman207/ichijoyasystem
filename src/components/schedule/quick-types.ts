import type { ScheduleKind, StoreId } from "@/lib/db/types";

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
  /** 受注の引取・納品の日程と連動 (日時の変更は申請) */
  handover: boolean;
  lockKind: boolean;
  canEdit: boolean;
  hold: boolean;
  /** 地図 (Google マップ・登録済みの住宅地図。お客様のご要望 2026-11-24「② 予定表からの地図表示」) */
  map?: QuickMap;
  /** 担当者の選択肢 (予定の店舗の社員 → 本部 → ほかの店舗。お客様のご要望 2026-11-24「⑥」) */
  staff: QuickStaff[];
  /** 引取・現見 ⇄ 納品 の相手の予定 (お客様のご要望 2026-11-24「⑦」。src/lib/schedule-pair.ts) */
  pair?: QuickPair;
}

export interface QuickStaff {
  id: string;
  name: string;
  /** 略称 (1 文字。予定表のチップと同じ) */
  initial: string;
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
