import "server-only";
import crypto from "node:crypto";
import { cookies } from "next/headers";
import type { Role, StoreId } from "@/lib/db/types";

/**
 * 確認用ログイン (お客様による画面確認用)
 * ------------------------------------------------------------
 * - 確認用リンク (/review?key=…) を開いた端末にだけ Cookie を付け、ログイン画面に「ロールを選んでログイン」のボタンを出す。
 *   リンクを知らない人には通常のログイン画面 (ID とパスワード) だけが表示される
 * - ボタンは確認用アカウント (確認用 管理者 など) でログインする。社員のアカウントは使わない
 * - リンクの鍵: 環境変数 REVIEW_ACCESS_KEY があればその値、なければ SUPABASE_SECRET_KEY から導出した値。
 *   REVIEW_LOGIN=off で確認用ログインを止める (確認期間の終了後など)
 */

export const REVIEW_COOKIE = "ichijoya_review";
export const REVIEW_COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 日

export function reviewKey(): string | null {
  if (process.env.REVIEW_LOGIN === "off") return null;
  const explicit = process.env.REVIEW_ACCESS_KEY?.trim();
  if (explicit) return explicit.length >= 16 ? explicit : null;
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!secret) return null;
  return crypto.createHmac("sha256", secret).update("ichijoya-review-link-v1").digest("base64url").slice(0, 24);
}

export function isReviewKey(value: string | null | undefined): boolean {
  const key = reviewKey();
  if (!key || !value) return false;
  const a = Buffer.from(value);
  const b = Buffer.from(key);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** この端末で確認用リンクを開いているか */
export async function hasReviewAccess(): Promise<boolean> {
  return isReviewKey((await cookies()).get(REVIEW_COOKIE)?.value);
}

export interface ReviewAccount {
  id: string;
  email: string;
  name: string;
  kana: string;
  role: Role;
  storeId: StoreId;
  /** ボタンの表示 */
  label: string;
  desc: string;
}

/** 確認用アカウント (id は u_review_ で始める。承認先の判定から除外する: permissions.ts の isReviewAccount) */
export const REVIEW_ACCOUNTS: ReviewAccount[] = [
  { id: "u_review_admin", email: "review-admin", name: "確認用 管理者", kana: "カクニンヨウ カンリシャ", role: "admin", storeId: "hq", label: "管理者", desc: "全店舗の閲覧・設定・管理者承認" },
  { id: "u_review_hq", email: "review-hq", name: "確認用 本部スタッフ", kana: "カクニンヨウ ホンブスタッフ", role: "hq_staff", storeId: "hq", label: "本部スタッフ", desc: "全店舗の請求・入金・仕入・経費" },
  { id: "u_review_manager", email: "review-manager", name: "確認用 店長", kana: "カクニンヨウ テンチョウ", role: "store_manager", storeId: "chuo", label: "店長 (中央店)", desc: "中央店の情報の管理と店長承認" },
  { id: "u_review_staff", email: "review-staff", name: "確認用 店舗スタッフ", kana: "カクニンヨウ テンポスタッフ", role: "store_staff", storeId: "chuo", label: "店舗スタッフ (中央店)", desc: "中央店の顧客・問い合わせ・見積・予定の登録" },
];
