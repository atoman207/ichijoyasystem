import type { Approval, Expense, Role, ScheduleEvent, StoreId, Thread, User } from "@/lib/db/types";

/**
 * 権限ルール
 * ------------------------------------------------------------
 * - 管理者 / 本部スタッフ: 全店舗の情報を閲覧
 * - 店長 / 店舗スタッフ: 自店舗の情報のみ
 * - 承認: 店長は自店舗の「店長承認」案件、管理者は全案件
 * - 設定 (ユーザー・商品・承認ルール): 管理者のみ
 * - 請求書の発行: 管理者・本部スタッフ・店長。入金の登録: 自店舗のメンバー (店舗スタッフも可)。仕入の処理: 管理者・本部スタッフ
 * - 承認: 自分が申請したものは承認できない (管理者どうし・店長と管理者で相互に承認する)
 * - 経費: 店舗スタッフは自分の経費のみ、店長は自店舗、全店舗ロールは全件
 * - 社内連絡: 参加しているスレッド・自店舗のスレッド・全社向け (店舗指定なし) のスレッド。全店舗ロールは全件
 * - 予定表 (全社カレンダー): 全ロールが全店舗・全社員の予定を閲覧。登録は自店舗 (全店舗ロールは全店舗)、
 *   変更・削除は登録者・担当者・その店舗のメンバー。全社共通の予定は店長以上と本部スタッフ
 */

export function canSeeAllStores(user: User): boolean {
  return user.role === "admin" || user.role === "hq_staff";
}

export function canAccessStore(user: User, storeId: StoreId): boolean {
  return canSeeAllStores(user) || user.storeId === storeId;
}

/** ユーザーが閲覧できる範囲に絞り込む */
export function scopeByStore<T extends { storeId: StoreId }>(user: User, items: T[]): T[] {
  if (canSeeAllStores(user)) return items;
  return items.filter((i) => i.storeId === user.storeId);
}

/** すべての承認依頼 (店長承認・管理者承認) を承認できる (自分の申請を除く) */
export function canApproveAll(user: User): boolean {
  return user.role === "admin";
}

/** 承認申請の取下げ: 申請者本人と管理者 */
export function canCancelApproval(user: User, approval: Pick<Approval, "requestedBy">): boolean {
  return approval.requestedBy === user.id || canApproveAll(user);
}

export function canApprove(user: User, approval: Pick<Approval, "storeId" | "requiredRole" | "requestedBy">): boolean {
  if (approval.requestedBy === user.id) return false;
  if (canApproveAll(user)) return true;
  if (user.role === "store_manager") {
    return approval.requiredRole === "store_manager" && approval.storeId === user.storeId;
  }
  return false;
}

/**
 * 承認者のロールを決める (見積・金額変更・受注 (契約)・経費)
 * - 本部の案件、または金額が基準以上 → 管理者
 * - 店舗の案件 → 店長。ただし、その店舗に申請者以外の有効な店長がいないとき
 *   (店長のいない店舗・店長本人の申請) は、承認できる人がいないので管理者
 * - 店長として数えるのは、申請者と同じ種類のアカウントだけ (社員の申請は社員の店長、デモ用アカウントの申請はデモ用の店長)。
 *   本番データにデモ用アカウントを加えても、社員の申請の承認先は変わらない
 */
export function approverRole(users: Pick<User, "id" | "email" | "role" | "storeId" | "active">[], storeId: StoreId, overThreshold: boolean, requesterId: string): "store_manager" | "admin" {
  if (storeId === "hq" || overThreshold) return "admin";
  const requester = users.find((u) => u.id === requesterId);
  const demo = requester ? isDemoAccount(requester) : false;
  // 確認用アカウント (お客様の画面確認用) は、実際の承認先の判定に入れない
  const hasManager = users.some(
    (u) => u.active && u.role === "store_manager" && u.storeId === storeId && u.id !== requesterId && !isReviewAccount(u) && isDemoAccount(u) === demo,
  );
  return hasManager ? "store_manager" : "admin";
}

/** デモ用アカウント (架空の 15 名。ログイン ID が予約ドメイン @ichijoya.example。src/lib/db/master.ts の USERS) */
export const DEMO_EMAIL_DOMAIN = "@ichijoya.example";
export function isDemoAccount(user: Pick<User, "email">): boolean {
  return user.email.toLowerCase().endsWith(DEMO_EMAIL_DOMAIN);
}

/** 確認用アカウント (確認用リンクのロールボタンでログインするアカウント。src/lib/auth/review.ts) */
export function isReviewAccount(user: Pick<User, "id">): boolean {
  return user.id.startsWith("u_review_");
}

/** 承認者の説明 (監査ログ・メッセージ用) */
export function approverLabel(role: "store_manager" | "admin", overThreshold: boolean, thresholdLabel: string): string {
  if (role === "store_manager") return "店長承認";
  return overThreshold ? `管理者承認 (${thresholdLabel}以上)` : "管理者承認";
}

export function isManagerOrAbove(user: User): boolean {
  return user.role === "admin" || user.role === "store_manager";
}

export function canManageSettings(user: User): boolean {
  return user.role === "admin";
}

export function canManageFinance(user: User): boolean {
  return user.role === "admin" || user.role === "hq_staff";
}

export function canResetData(user: User): boolean {
  return user.role === "admin";
}

/** 予定表は全社で共有する (予定の重複防止・人員配置の調整・社内の情報共有のため、全ロールが全店舗の予定を閲覧) */
export function canViewCompanySchedule(user: User): boolean {
  return user.active;
}

/** 全社共通の予定 (全店舗のカレンダーに載る社内行事・全社会議など) を登録・変更できる */
export function canManageCompanyEvents(user: User): boolean {
  return user.role !== "store_staff";
}

/** 予定を変更・削除できるか: 登録者・担当者・その店舗のメンバー (全店舗ロールは全件) */
export function canEditEvent(user: User, e: Pick<ScheduleEvent, "storeId" | "assigneeIds" | "createdBy" | "companyWide">): boolean {
  if (e.companyWide && !canManageCompanyEvents(user)) return false;
  return canAccessStore(user, e.storeId) || e.assigneeIds.includes(user.id) || e.createdBy === user.id;
}

export const ROLE_ORDER: Role[] = ["admin", "store_manager", "store_staff", "hq_staff"];

/** 経費を閲覧・申請・削除できるか (店舗スタッフは自分の経費のみ) */
export function canViewExpense(user: User, e: Pick<Expense, "storeId" | "submittedBy">): boolean {
  if (canSeeAllStores(user)) return true;
  if (user.role === "store_manager") return e.storeId === user.storeId;
  return e.submittedBy === user.id;
}

/** 社内連絡のスレッドを閲覧・返信できるか */
export function canViewThread(user: User, t: Pick<Thread, "storeId" | "participants" | "createdBy">): boolean {
  return canSeeAllStores(user) || t.participants.includes(user.id) || t.createdBy === user.id || !t.storeId || t.storeId === user.storeId;
}

/** 資料台帳 (経営・人事・経理の資料を含む Google ドライブの共有資料一覧) を閲覧できる: 管理者・本部スタッフ */
export function canViewSourceFiles(user: User): boolean {
  return canSeeAllStores(user);
}

/** レポート・分析を閲覧できる: 店長・本部スタッフ・管理者 */
export function canViewReports(user: User): boolean {
  return isManagerOrAbove(user) || canSeeAllStores(user);
}

/** 全データのエクスポート (JSON / CSV): 管理者・本部スタッフ */
export function canExportData(user: User): boolean {
  return canSeeAllStores(user);
}
