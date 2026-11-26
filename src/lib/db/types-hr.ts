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

/**
 * 勤怠の月次表 (労務士へ送る一覧。打刻・給与計算は対象外)
 * ------------------------------------------------------------
 * シート「令和○年○月分」= 1 か月。社員行 (出勤日数・欠勤・遅刻早退・残業・備考・有給) と
 * パート行 (出勤日数・出勤時間・時給・備考・有休取得) を持つ。確定すると書き換えを止め、CSV を出す
 */
export type AttendanceMonthStatus = "draft" | "final";
export type AttendanceLineKind = "staff" | "part";

export interface AttendanceMonth {
  id: string;
  /** 対象月 (YYYY-MM。シートの「令和 8 年 11 月分」= 2026-11) */
  yearMonth: string;
  /** 支給日 (空 = 月末など。表示用) */
  payLabel?: string;
  status: AttendanceMonthStatus;
  note?: string;
  /** 取込元のファイル名 */
  sourceLabel?: string;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  finalizedBy?: string;
  finalizedAt?: string;
  /** 労務士へ送った記録 (送信履歴 deliveries の ID・日時・宛先) */
  sentAt?: string;
  sentBy?: string;
  sentTo?: string;
  deliveryIds?: string[];
}

/** 勤怠の月次表の 1 行 (社員またはパート) */
export interface AttendanceLine {
  id: string;
  monthId: string;
  kind: AttendanceLineKind;
  /** 表示順 */
  sort: number;
  /** 社員番号 (シートの No) */
  employeeNo?: string;
  /** 社員マスタに当たったとき */
  userId?: string;
  /** 氏名 (シートの表記を残す) */
  name: string;
  /** 出勤日数 */
  workDays?: number;
  /** 欠勤日数 (社員) */
  absenceDays?: number;
  /** 遅刻・早退の合計時間 (「0:21」「1：36」など。分に直さず文字のまま) */
  lateEarly?: string;
  /** 残業時間 (文字) */
  overtime?: string;
  /** 出勤時間の合計 (パート。「82：48」) */
  workHours?: string;
  /** 時給 (パート) */
  hourlyRate?: number;
  /** 有給取得日数 */
  paidLeaveDays?: number;
  note?: string;
  /** import = 取り込んだ表 / auto = 打刻と休暇から作った / manual = 手で足した */
  source?: "import" | "auto" | "manual";
  /** 自動で作ったときの計算の内訳 (シフト外残業・深夜・固定残業・残日数・インセンティブ。画面の確認用) */
  calc?: AttendanceLineCalc;
  createdAt: string;
  updatedAt: string;
}

/** 勤怠の月次表の行の計算の内訳 (自動で作った行) */
export interface AttendanceLineCalc {
  /** 締めの期間 */
  from: string;
  to: string;
  /** シフト外残業の合計 (分) と固定残業 (分) */
  outsideMin: number;
  fixedMin: number;
  nightMin: number;
  lateMin: number;
  earlyMin: number;
  workedMin: number;
  holidayWorkDays: number;
  compUsedDays: number;
  specialDays: number;
  /** 期間の終わりの残日数 */
  paidRemaining?: number;
  compRemaining?: number;
  /** インセンティブ (円) */
  incentiveSalary: number;
  incentiveCash: number;
  incentiveItems: { label: string; yen: number; pay: "cash" | "salary"; detail?: string }[];
  /** 打刻漏れ・未承認の申請など (送る前に確かめる) */
  warnings: string[];
}

/* ================================================================== */
/* 打刻・勤務表 (src/lib/hr/timecard.ts・/attendance。キャスタイムの代わり)          */
/* ================================================================== */

/** 打刻の記録 1 件 (押した・直した・取り消した。消さずに残す = 労働時間の記録) */
export interface AttendanceLogEntry {
  at: string;
  /** in = 出勤 / out = 退勤 / fix = 打刻修正・休日出勤の承認で直した / clear = 打刻を取り消した / breaks = 休憩の変更 */
  kind: "in" | "out" | "fix" | "clear" | "breaks";
  /** 直したあとの値 (出勤・退勤の時刻 HH:MM。breaks は外した休憩の番号) */
  value?: string;
  /** 直す前の値 */
  before?: string;
  by: string;
  /** stamp = 本人の打刻 / request = 申請の承認 / admin = 承認できる人が直接 */
  via: "stamp" | "request" | "admin";
  requestId?: string;
  note?: string;
}

/** 社員 × 日の勤怠 (id = ad_<社員>_<日付>) */
export interface AttendanceDay {
  id: string;
  userId: string;
  /** その日の所属店舗 (打刻したとき) */
  storeId: StoreId;
  /** 勤務日 (YYYY-MM-DD。日をまたいだ退勤もこの日) */
  date: string;
  /** 出勤の時刻 (ISO) */
  clockIn?: string;
  /** 退勤の時刻 (ISO。翌日の朝も可) */
  clockOut?: string;
  /** 外した休憩 (シフトの休憩の番号 0〜)。休憩をとらなかった日 (パートの休憩を 0 にする) */
  skipBreaks?: number[];
  /** 打刻の記録 (新しいものが後ろ) */
  log: AttendanceLogEntry[];
  note?: string;
  createdAt: string;
  updatedAt: string;
}

/** correction = 打刻修正 (打刻漏れ・時刻の誤り・休憩) / holiday_work = 休日出勤 (承認で振休が付く) */
export type AttendanceRequestKind = "correction" | "holiday_work";

/** 打刻修正・休日出勤の申請 (有給・振休・特別休暇は leave_requests) */
export interface AttendanceRequest {
  id: string;
  /** 申請番号 (AT-2026-0001) */
  number: string;
  userId: string;
  storeId: StoreId;
  kind: AttendanceRequestKind;
  date: string;
  /** 出勤の時刻 (HH:MM。空 = 変えない) */
  clockIn?: string;
  /** 退勤の時刻 (HH:MM。翌日の朝は 24:00〜29:59 = 翌 5:59 まで) */
  clockOut?: string;
  /** 外す休憩 (シフトの休憩の番号) */
  skipBreaks?: number[];
  /** 休日出勤の区分 (終日・午前・午後) */
  slot?: LeaveSlot;
  reason: string;
  status: LeaveStatus;
  requestedBy: string;
  requestedAt: string;
  decidedBy?: string;
  decidedAt?: string;
  decisionComment?: string;
  /** 承認で登録した休日出勤 (holiday_works) と予定 */
  holidayWorkId?: string;
  eventId?: string;
  /** 申請したときの打刻 (承認の画面で前後を比べる) */
  previous?: { clockIn?: string; clockOut?: string; skipBreaks?: number[] };
  cancelledBy?: string;
  cancelledAt?: string;
  updatedAt: string;
}
