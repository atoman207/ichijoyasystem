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
}
