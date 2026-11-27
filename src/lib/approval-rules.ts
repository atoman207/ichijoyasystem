import type { Database } from "@/lib/db/types";
import { APPROVAL_RULES } from "@/lib/constants";

/**
 * 承認ルール (settings テーブルの id = "approval")
 * ------------------------------------------------------------
 * 設定 → 承認ルール で管理者が変える。未設定の項目は既定値 (src/lib/constants.ts の APPROVAL_RULES)。
 * - quoteAdminThreshold: 見積・受注 (契約)・契約内容の変更 で、この金額以上は管理者の承認
 * - expenseAdminThreshold: 経費で、この金額以上は管理者の承認
 * - customerChange: 顧客の重要情報 (氏名・フリガナ・電話・住所など) の変更に承認を必要とする
 *   (承認できる人 = その店舗の店長・管理者 が変更したときは、承認なしで反映して履歴に残す)
 * - scheduleChange: 予定・引取納品の日程の変更・削除に承認を必要とする (既定 = 不要)
 * - smallChangeLimit: この差額以下の工事金額の変更 (仕様の変更を含む) は承認なし (既定 1 万円)
 * - noticeHq: 案件の変更のお知らせを本部・管理者にも届ける (既定 = 届ける。src/lib/change-notices.ts)
 * - changeBell: 変更のお知らせ (日程・仕様・金額などの変更) と「予定の担当になりました・予定が変更されました」をベル・トーストで知らせる (既定 = 知らせない)
 * - autoReminders: 期限を過ぎた依頼の自動の再通知・日程未定の連絡予定日の当日の知らせを送る (既定 = 送らない)
 *   (どちらもお客様のご要望 2026-11-27「■2 日程・仕様・金額の変更・予定時刻になったことを知らせる通知は不要」。記録 (変更のお知らせの一覧・案件の変更履歴・期限超過の表示) は残す)
 */
export interface ApprovalSettings {
  quoteAdminThreshold: number;
  expenseAdminThreshold: number;
  customerChange: boolean;
  /**
   * 予定 (受注の引取・納品の日程と連動する予定を含む) の変更・削除に承認を必要とするか。
   * 既定 = 不要 (お客様のご要望 2026-11-25「⑥ 予定の変更・削除は誰の承認も必要とせず、担当者がその場で変更」)
   */
  scheduleChange: boolean;
  /**
   * 工事金額の変更で、変更前と変更後の差がこの金額以下なら承認なしで反映する (仕様だけの変更 = 差 0 円も含む)。0 = 使わない。
   * 既定 = 1 万円 (お客様のご要望 2026-11-25「⑥ 1万円以下の工事金額変更は承認なし」)。施工完了・請求済・入金済の受注は管理者の承認のまま
   */
  smallChangeLimit: number;
  /** 案件の変更のお知らせを、担当店舗に加えて本部と管理者にも届ける (既定 = 届ける。お客様のご要望 2026-11-25「⑥ 当面は本部と管理者にも」) */
  noticeHq: boolean;
  /** 変更のお知らせと予定の担当・変更をベル (とトースト) に出す (既定 = 出さない。お客様のご要望 2026-11-27「■2」) */
  changeBell: boolean;
  /** 期限を過ぎた依頼の自動の再通知と、日程未定の連絡予定日の知らせ (既定 = 送らない。お客様のご要望 2026-11-27「■2」) */
  autoReminders: boolean;
}

export const APPROVAL_SETTINGS_ID = "approval";

/** 承認なしで反映する工事金額の変更の差 (既定 1 万円) */
export const SMALL_CHANGE_LIMIT = 10_000;

export function approvalSettings(db: Pick<Database, "settings">): ApprovalSettings {
  const v = (db.settings ?? []).find((s) => s.id === APPROVAL_SETTINGS_ID)?.value ?? {};
  const money = (x: unknown, fallback: number) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? Math.round(x) : fallback);
  return {
    quoteAdminThreshold: money(v.quoteAdminThreshold, APPROVAL_RULES.quoteAdminThreshold),
    expenseAdminThreshold: money(v.expenseAdminThreshold, APPROVAL_RULES.expenseAdminThreshold),
    customerChange: v.customerChange === undefined ? true : v.customerChange === true,
    scheduleChange: v.scheduleChange === true,
    smallChangeLimit: typeof v.smallChangeLimit === "number" && Number.isFinite(v.smallChangeLimit) && v.smallChangeLimit >= 0 ? Math.round(v.smallChangeLimit) : SMALL_CHANGE_LIMIT,
    noticeHq: v.noticeHq === undefined ? true : v.noticeHq === true,
    changeBell: v.changeBell === true,
    autoReminders: v.autoReminders === true,
  };
}

/** 「¥50万」のような短い金額の表示 (監査ログ・案内文用) */
export function manYen(n: number): string {
  return n % 10000 === 0 ? `¥${(n / 10000).toLocaleString("ja-JP")}万` : `¥${n.toLocaleString("ja-JP")}`;
}

/** 顧客の重要情報 (変更に承認が必要な項目) */
export const CUSTOMER_IMPORTANT_FIELDS = ["name", "kana", "type", "phone", "email", "postalCode", "address"] as const;
