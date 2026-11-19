/**
 * 予定の計画 (作業の内容・製造の予定・車両と設備の予約・仮押さえ) の型
 * ------------------------------------------------------------
 * 既存の予定 (schedule)・受注・見積・問い合わせの表は変えず、ここの表から ID で参照する。
 * マスタ (作業種別・製造工程・技能・社員の勤務と技能・車両と設備・経路・最適化の重み) は settings (src/lib/scheduling/masters.ts)
 */
import type { ScheduleKind, StoreId } from "./types";

export type PlanSlot = "am" | "pm" | "day";

/** 作業の明細 (作業種別 × 数量) */
export interface JobItem {
  /** 作業種別の ID (masters.ts の WorkType) */
  workTypeId: string;
  qty: number;
  note?: string;
}

/** お客様の希望の強さ: none = なし / soft = できれば / hard = 必ず (希望の日時以外は提案しない) */
export type PreferenceStrength = "none" | "soft" | "hard";
export type JobPriority = "urgent" | "high" | "normal" | "low";

/**
 * 作業の内容 (案件または予定ごとに 1 行。ID は js_<recordType>_<recordId>)
 * 予定の件名・メモの「畳 表替え6」から読むのではなく、ここに専用の項目として持つ。
 * 予定 (event) の行は、案件 (order / quote / inquiry) の行より優先する (その予定だけの人数・時間など)
 */
export interface JobSpec {
  id: string;
  recordType: "order" | "quote" | "inquiry" | "event";
  recordId: string;
  storeId: StoreId;
  items: JobItem[];
  /** 現場の標準作業時間 (分)。空 = 作業種別から計算 */
  minutes?: number;
  /** 必要な人数。空 = 作業種別・過去の実績から */
  staffCount?: number;
  /** 必要な技能 (技能の ID)。作業種別の技能に足す */
  skills: string[];
  /** 必要な車両・設備の種類 (例: truck)。作業種別の種類に足す */
  resourceKinds: string[];
  /** 製造日数 (引き取りから納品までの最短の日数)。空 = 製造工程から計算 */
  productionDays?: number;
  /** 引き取りができる最初の日 */
  pickupFrom?: string;
  /** 納品・完了の期限 */
  deadline?: string;
  /** お客様の希望の日 (YYYY-MM-DD) */
  preferredDates: string[];
  /** お客様の希望の曜日 (0 = 日〜6 = 土) */
  preferredWeekdays: number[];
  preferredSlot?: PlanSlot;
  /** 希望の開始時刻 (HH:MM) */
  preferredTime?: string;
  /** お客様の都合の悪い日 */
  avoidDates: string[];
  preferenceStrength: PreferenceStrength;
  priority: JobPriority;
  note?: string;
  updatedBy: string;
  updatedAt: string;
}

export interface ProductionStep {
  processId: string;
  date: string;
  /** その日の作業時間 (分) */
  minutes: number;
  /** その日に作る数量 */
  qty: number;
  status: "planned" | "done";
  assigneeId?: string;
  resourceId?: string;
}

/** 製造の予定 (引き取り → 製造 → 納品)。1 行 = 1 案件の製造 */
export interface ProductionJob {
  id: string;
  /** 製造する店舗 (作業場) */
  storeId: StoreId;
  orderId?: string;
  quoteId?: string;
  customerId?: string;
  title: string;
  items: JobItem[];
  pickupEventId?: string;
  deliveryEventId?: string;
  /** 仮押さえから作った予定 (確定前) */
  holdId?: string;
  steps: ProductionStep[];
  startDate: string;
  /** 製造が終わる日 */
  endDate: string;
  /** 納品の日・期限 */
  dueDate?: string;
  status: "planned" | "in_progress" | "done" | "cancelled";
  /** 材料の在庫の確かめ (計画したときの結果) */
  materialCheck?: { ok: boolean; checkedAt: string; lines: { materialId: string; name: string; need: number; stock: number; unit?: string }[] };
  note?: string;
  createdBy: string;
  createdAt: string;
  updatedBy?: string;
  updatedAt?: string;
}

/** 車両・設備・工具の予約 */
export interface ResourceBooking {
  id: string;
  /** 車両・設備の ID (masters.ts の Resource) */
  resourceId: string;
  storeId: StoreId;
  date: string;
  endDate?: string;
  startTime?: string;
  endTime?: string;
  slot?: "am" | "pm";
  eventId?: string;
  holdId?: string;
  productionJobId?: string;
  note?: string;
  createdBy: string;
  createdAt: string;
}

/**
 * 予定の仮押さえ (候補日を押さえておき、担当者・お客様の確認のあとで予定にする)
 * 同じ groupId の仮押さえは同じ作業の候補どうし (第 1 候補・第 2 候補…)。どれか 1 つを確定すると、ほかは解除する
 */
export interface ScheduleHold {
  id: string;
  groupId: string;
  /** 候補の順位 (1 = 第 1 候補) */
  rank: number;
  storeId: StoreId;
  kind: ScheduleKind;
  title: string;
  date: string;
  endDate?: string;
  startTime?: string;
  endTime?: string;
  slot?: "am" | "pm";
  assigneeIds: string[];
  resourceIds: string[];
  customerId?: string;
  inquiryId?: string;
  quoteId?: string;
  orderId?: string;
  location?: string;
  memo?: string;
  /** 一連の予定 (現地調査 → 引き取り → 納品) のまとまり */
  chainId?: string;
  score?: number;
  reasons: string[];
  warnings: string[];
  status: "held" | "confirmed" | "released" | "expired";
  /** この日時を過ぎると自動で解除 */
  expiresAt: string;
  /** 担当者の確認 (ok = 行ける / ng = 行けない) */
  acks: { userId: string; ok: boolean; note?: string; at: string }[];
  /** お客様への候補の案内 */
  offeredAt?: string;
  offeredVia?: string;
  /** お客様が選んだ (案内のリンクから・電話で聞いた) */
  customerChoiceAt?: string;
  customerChoiceNote?: string;
  /** 確定して作った予定 */
  eventId?: string;
  createdBy: string;
  createdAt: string;
  updatedBy?: string;
  updatedAt?: string;
}
