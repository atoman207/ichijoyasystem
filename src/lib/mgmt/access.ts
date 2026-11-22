import type { Order, StoreId, User } from "@/lib/db/types";
import { canManageFinance, canSeeAllStoreFigures } from "@/lib/auth/permissions";

/**
 * 管理会計の権限
 * ------------------------------------------------------------
 * - 見る: 管理者・本部スタッフは全店舗、店長は自店舗 (店舗スタッフは見ない)。
 *   閲覧の範囲 = 経営の数字は全社員 (既定。src/lib/access-policy.ts) のときは全社員が全店舗を見る (policyReader の写しで判定。登録・設定・確定は変わらない)
 * - 日々の登録 (売上の帰属・内部受注・材料の使用・在庫の移動・仕入明細の振り分け・経費の区分・手入力): 本部スタッフ・管理者。
 *   店長は自店舗の受注の材料の使用 (実績) と、自店舗が移動元・移動先の在庫の移動の申請 (本部スタッフ・管理者が確定)
 * - 設定 (配分率・端数・単価・材料構成・営業エリア・品目・店舗)・特例の配分率・本部の特殊配分・案分の確定・月次確定と解除: 管理者
 * 店舗別損益・原価の数字は社外秘のため、AI の SQL (src/lib/datastore/model.ts の scopeStatements) も同じ範囲にする
 */

export function canViewMgmt(user: User): boolean {
  return user.active && (canSeeAllStoreFigures(user) || user.role === "store_manager");
}

/** 見られる店舗 (全店舗なら undefined) */
export function mgmtStores(user: User): StoreId[] | undefined {
  return canSeeAllStoreFigures(user) ? undefined : [user.storeId];
}

export function canViewMgmtStore(user: User, storeId: string): boolean {
  return canViewMgmt(user) && (canSeeAllStoreFigures(user) || user.storeId === storeId);
}

export function canEditMgmt(user: User): boolean {
  return user.active && canManageFinance(user);
}

export function canAdminMgmt(user: User): boolean {
  return user.active && user.role === "admin";
}

/** 材料の使用 (原価) の登録: 本部スタッフ・管理者、店長は自店舗の受注 */
export function canRecordUsage(user: User, order: Pick<Order, "storeId">): boolean {
  return canEditMgmt(user) || (user.active && user.role === "store_manager" && order.storeId === user.storeId);
}

/** 在庫の移動の登録: 本部スタッフ・管理者 (確定)、店長は自店舗が移動元・移動先の移動 (申請) */
export function canRequestMove(user: User, from?: string, to?: string): boolean {
  if (canEditMgmt(user)) return true;
  return user.active && user.role === "store_manager" && (from === `store:${user.storeId}` || to === `store:${user.storeId}`);
}
