import type { Database, User } from "@/lib/db/types";
import { canCreateCustomer } from "@/lib/auth/permissions";
import { kpiSettings } from "@/lib/kpi-settings";

/**
 * 運用の設定 (settings テーブルの id = "operations")
 * - customerCreators: 顧客の新規登録ができる人。office = 事務のみ / office_and_managers = 店長も可 (初期設定。お客様の決定 2026-11-24「追加 ①」) / all = 全員
 */
export interface OpsSettings {
  customerCreators: "office" | "office_and_managers" | "all";
}

export const OPS_SETTINGS_ID = "operations";

export function opsSettings(db: Pick<Database, "settings">): OpsSettings {
  const v = (db.settings ?? []).find((s) => s.id === OPS_SETTINGS_ID)?.value ?? {};
  const mode = v.customerCreators;
  return { customerCreators: mode === "office" || mode === "all" ? mode : "office_and_managers" };
}

export const CUSTOMER_CREATOR_LABEL: Record<OpsSettings["customerCreators"], string> = {
  office: "事務担当・本部・管理者のみ",
  office_and_managers: "事務担当・本部・管理者 + 店長 (初期設定)",
  all: "全員",
};

/** このユーザーが顧客を新規登録できるか */
export function userCanCreateCustomer(db: Pick<Database, "settings" | "users">, user: User): boolean {
  return canCreateCustomer(user, { mode: opsSettings(db).customerCreators, clerkUserIds: kpiSettings(db).clerkUserIds });
}
