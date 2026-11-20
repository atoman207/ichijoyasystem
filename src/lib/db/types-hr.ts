/**
 * 有給・休日出勤の管理 (F-16) の型
 * ------------------------------------------------------------
 * - 休暇の申請 (有給・振休・特別休暇): 申請 → 承認 (店長・管理者) で予定表に「休暇」(kind = leave) を登録する
 * - 有給の付与: 社員ごとの付与日 (基準日)・日数・有効期限 (付与から 2 年)。切り替え時点の残日数 (有給管理表) は kind = opening
 * - 休日出勤: 振休の発生 (0.5 日単位)。振休の取得 (休暇の申請の leaveType = comp) と古い順に対応させる
 * 計算 (残日数・消化の順番・年度の集計) は src/lib/hr/leave.ts。既存の表は変えない
 */
import type { StoreId } from "./types";

/** paid = 有給休暇 / comp = 振休 (休日出勤の振替) / special = 特別休暇 (慶弔など。残日数は持たない) */
export type LeaveType = "paid" | "comp" | "special";
/** day = 終日 / am = 午前 (半日) / pm = 午後 (半日) */
export type LeaveSlot = "day" | "am" | "pm";
export type LeaveStatus = "pending" | "approved" | "rejected" | "cancelled";

export interface LeaveRequest {
  id: string;
  /** 申請番号 (LV-2026-0001) */
  number: string;
  /** 休む社員 */
  userId: string;
  /** 社員の所属店舗 (承認する店長・予定表の店舗) */
  storeId: StoreId;
  leaveType: LeaveType;
  /** 開始日 (YYYY-MM-DD) */
  date: string;
  /** 終了日 (複数日の終日のみ) */
  endDate?: string;
  slot: LeaveSlot;
  /** 日数に数える日 (複数日は休業日を除く。1 日だけの申請はその日) */
  dates: string[];
  /** 日数 (0.5 単位) */
  days: number;
  reason?: string;
  /** 振休: 充てる休日出勤 (空 = 古いものから順に充てる) */
  holidayWorkId?: string;
  status: LeaveStatus;
  /** 申請した人 (本人。店長・事務が代わりに登録したときはその人) */
  requestedBy: string;
  requestedAt: string;
  decidedBy?: string;
  decidedAt?: string;
  decisionComment?: string;
  /** 承認で登録した予定 (予定表の「休暇」) */
  eventId?: string;
  cancelledBy?: string;
  cancelledAt?: string;
  cancelReason?: string;
  updatedAt: string;
}

/**
 * 有給休暇の付与 (1 行 = 1 回の付与)
 * - grant: 基準日の付与。grantDate = 付与日、expiresOn = 付与日から 2 年 (の前日まで使える)
 * - opening: 切り替え時点の残日数 (有給管理表の当年度分・繰越分)。grantDate = 時点 (この日から使う)、baseDate = もとの付与日
 */
export interface LeaveGrant {
  id: string;
  userId: string;
  kind: "grant" | "opening";
  grantDate: string;
  /** もとの付与日 (opening のとき。有給管理表の本年基準日・前年の基準日) */
  baseDate?: string;
  /** 有効期限 (この日まで使える) */
  expiresOn: string;
  days: number;
  note?: string;
  createdBy: string;
  createdAt: string;
  updatedBy?: string;
  updatedAt?: string;
}

/**
 * 休日出勤 (振休の発生)。kind = opening は切り替え時点の振休の残 (休日出勤管理表の未取得分)
 */
export interface HolidayWork {
  id: string;
  userId: string;
  storeId: StoreId;
  kind: "work" | "opening";
  date: string;
  slot: LeaveSlot;
  /** 振休の日数 (終日 1・半日 0.5。opening は残の日数) */
  days: number;
  note?: string;
  createdBy: string;
  createdAt: string;
  updatedBy?: string;
  updatedAt?: string;
}
