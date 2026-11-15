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
 */
export interface ApprovalSettings {
  quoteAdminThreshold: number;
  expenseAdminThreshold: number;
  customerChange: boolean;
}

export const APPROVAL_SETTINGS_ID = "approval";

export function approvalSettings(db: Pick<Database, "settings">): ApprovalSettings {
  const v = (db.settings ?? []).find((s) => s.id === APPROVAL_SETTINGS_ID)?.value ?? {};
  const money = (x: unknown, fallback: number) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? Math.round(x) : fallback);
  return {
    quoteAdminThreshold: money(v.quoteAdminThreshold, APPROVAL_RULES.quoteAdminThreshold),
    expenseAdminThreshold: money(v.expenseAdminThreshold, APPROVAL_RULES.expenseAdminThreshold),
    customerChange: v.customerChange === undefined ? true : v.customerChange === true,
  };
}

/** 「¥50万」のような短い金額の表示 (監査ログ・案内文用) */
export function manYen(n: number): string {
  return n % 10000 === 0 ? `¥${(n / 10000).toLocaleString("ja-JP")}万` : `¥${n.toLocaleString("ja-JP")}`;
}

/** 顧客の重要情報 (変更に承認が必要な項目) */
export const CUSTOMER_IMPORTANT_FIELDS = ["name", "kana", "type", "phone", "email", "postalCode", "address"] as const;
