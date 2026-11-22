import type { Database, User } from "@/lib/db/types";
import { readWideningFor, withReadWidening } from "@/lib/auth/permissions";

/**
 * 閲覧の範囲の設定 (設定 → ユーザーと権限 の「閲覧の範囲」。settings の id = access_policy。変更は管理者)
 * ------------------------------------------------------------
 * お客様のご要望 (2026-11-22「■8. 権限設定について」): 経営の数字は店舗間の制限なし、顧客情報もできるだけ全社員が見られるように。
 * 編集の範囲は変えない (登録・変更は従来どおりその店舗の社員。入金完了・全処理完了の案件は管理者だけ = src/lib/case-access.ts)
 *
 * - figures (経営の数字 = 経営ダッシュボード・管理会計・KPI の店舗の集計・販促の分析・AI アシスタントの集計):
 *     all   = 全社員が全店舗の数字を見られる (既定)
 *     store = 従来どおり (店舗のロールは自店舗。経営ダッシュボード・管理会計・販促の分析は店長以上)
 * - customers (顧客情報 = 顧客・問い合わせ・見積・受注・請求書・写真・施工の履歴):
 *     all      = 全社員が全店舗の顧客情報を見られる (既定。ほかの店舗の記録は閲覧のみ。閲覧は変更履歴に記録する = src/lib/record-views.ts)
 *     approval = 店長・本部・管理者は全店舗。店舗スタッフは進行中の案件 (問い合わせ → 入金完了まで) と、
 *                上司 (所属店舗の店長) が承認した顧客 (承認から grantDays 日)。完了した案件の顧客は「閲覧の申請」(承認の type = record_view)
 *     open     = 進行中の案件だけ (ほかの店舗の完了した案件は見られない。2026-11-22 の仕組み)
 * 社員ごとの評価・インセンティブの金額・経費・有給・社内連絡・慶弔リストなどの個人の情報は、この設定では変わらない
 */

export const ACCESS_POLICY_ID = "access_policy";

export type FigurePolicy = "all" | "store";
export type CustomerPolicy = "all" | "approval" | "open";

export interface AccessPolicy {
  figures: FigurePolicy;
  customers: CustomerPolicy;
  /** 閲覧の申請を承認したあと見られる日数 (customers = approval のとき) */
  grantDays: number;
  updatedBy?: string;
  updatedAt?: string;
}

export const DEFAULT_ACCESS_POLICY: AccessPolicy = { figures: "all", customers: "all", grantDays: 7 };

export const FIGURE_POLICY_LABEL: Record<FigurePolicy, string> = {
  all: "全社員が全店舗の数字を見られる",
  store: "店舗のロールは自店舗の数字だけ (経営ダッシュボード・管理会計・販促の分析は店長以上)",
};

export const CUSTOMER_POLICY_LABEL: Record<CustomerPolicy, string> = {
  all: "全社員が全店舗の顧客情報を見られる (ほかの店舗は閲覧のみ・閲覧を記録)",
  approval: "店長以上は全店舗。店舗スタッフは進行中の案件と、上司が承認した顧客",
  open: "進行中の案件 (入金完了まで) だけ、ほかの店舗も見られる",
};

export const GRANT_DAYS_MIN = 1;
export const GRANT_DAYS_MAX = 90;

export function normalizeAccessPolicy(v: unknown): AccessPolicy {
  const o = (v && typeof v === "object" ? v : {}) as Partial<AccessPolicy>;
  const days = Math.round(Number(o.grantDays));
  return {
    figures: o.figures === "store" ? "store" : "all",
    customers: o.customers === "approval" || o.customers === "open" ? o.customers : "all",
    grantDays: Number.isFinite(days) && days >= GRANT_DAYS_MIN && days <= GRANT_DAYS_MAX ? days : DEFAULT_ACCESS_POLICY.grantDays,
  };
}

export function accessPolicy(db: Pick<Database, "settings">): AccessPolicy {
  const row = (db.settings ?? []).find((s) => s.id === ACCESS_POLICY_ID);
  return { ...normalizeAccessPolicy(row?.value), updatedBy: row?.updatedBy, updatedAt: row?.updatedAt };
}

/**
 * 画面の表示・集計に使う「閲覧の範囲を設定どおりに広げた利用者の写し」。
 * 経営の数字 (canSeeAllStoreFigures) と顧客情報 (canSeeAllCustomerRecords) の判定だけが変わる。
 * 登録・変更・承認・実行の判定には本物の利用者を使う
 */
export function policyReader(db: Pick<Database, "settings">, user: User): User {
  return withReadWidening(user, readWideningFor(user, accessPolicy(db)));
}
