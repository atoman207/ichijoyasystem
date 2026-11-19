import type { AuditLog, User } from "@/lib/db/types";
import { DEMO_EMAIL_DOMAIN } from "@/lib/auth/permissions";

/**
 * テスト期間中のアカウントの変更の停止 (設定 → ユーザーと権限・社員管理・アカウント画面)
 * - 止めるもの: 氏名・ログイン ID・役職・電話の変更、ロール・所属の変更、有効と無効の切り替え、追加、削除、パスワードの変更・再設定
 * - 止めないもの: 本人の顔写真、通知の受け取り方、新規登録の申請と、その承認・却下 (2026-11-19: 止めていると申請した社員がいつまでも
 *   ログインできないため。承認できるのは管理者と、自店舗の店舗スタッフの申請の店長だけ)
 * - 既定で停止。ACCOUNT_EDIT_LOCK=off を設定して再起動すると変更できるようになる
 * 画面のボタンは押すとこの文言を出し (AccountLockButton)、サーバーの処理 (actions/accounts.ts) も同じ文言で断る
 */
export const ACCOUNT_LOCK_MESSAGE = "テスト期間中のため、現在はアカウントの情報を変更できません。";
export const PASSWORD_LOCK_MESSAGE = "テスト期間中のため、現在はパスワードの変更・再設定はできません。";

export function accountEditLocked(): boolean {
  return !/^(off|false|0|no)$/i.test(process.env.ACCOUNT_EDIT_LOCK?.trim() ?? "");
}

/** 変更履歴に残すパスワードの操作 (credentialStatus がこの文言で判定する。変えるときは両方そろえる) */
export const PASSWORD_AUDIT = { changed: "パスワードを変更", reset: "パスワードを再設定" } as const;

export interface CredentialStatus {
  /** initial = 管理者などが決めたパスワード (アカウントの追加・再設定) のまま / own = 本人が決めた (変更・新規登録の申請) / unknown = 記録なし (移行したアカウントなど) */
  password: "initial" | "own" | "unknown";
  passwordAt?: string;
  /** 最後にログイン ID が変わった日時と変更前の ID (本人の変更・管理者の変更) */
  loginIdChangedAt?: string;
  loginIdBefore?: string;
  loginIdChangedBySelf?: boolean;
}

/**
 * パスワードとログイン ID の状態を変更履歴から求める (パスワードはハッシュで保存しており、誰も中身を見られないため)
 * - パスワードを決める操作: アカウントの追加 (create)・パスワードの変更・再設定。最後の操作を本人がしたら own
 */
export function credentialStatus(logs: Pick<AuditLog, "at" | "userId" | "action" | "entity" | "entityId" | "summary" | "changes">[], userId: string): CredentialStatus {
  const out: CredentialStatus = { password: "unknown" };
  for (const l of logs) {
    if (l.entity !== "user" || l.entityId !== userId) continue;
    if (l.action === "create" || l.summary === PASSWORD_AUDIT.changed || l.summary === PASSWORD_AUDIT.reset) {
      if (!out.passwordAt || l.at >= out.passwordAt) {
        out.password = l.userId === userId ? "own" : "initial";
        out.passwordAt = l.at;
      }
    }
    const email = l.changes?.find((c) => c.field === "email");
    if (email && (!out.loginIdChangedAt || l.at >= out.loginIdChangedAt)) {
      out.loginIdChangedAt = l.at;
      out.loginIdBefore = typeof email.before === "string" ? email.before : undefined;
      out.loginIdChangedBySelf = l.userId === userId;
    }
  }
  return out;
}

/** ログイン ID (メールアドレスまたは社員ごとの ID) の形式の問題。問題がなければ undefined */
export function loginIdProblem(id: string): string | undefined {
  if (!id) return "ログイン ID を入力してください。";
  if (id.length > 120) return "ログイン ID は 120 文字以内にしてください。";
  if (/\s/.test(id)) return "ログイン ID に空白は使えません。";
  if (!/^[\w.+\-@]+$/.test(id)) return "ログイン ID は半角の英数字と . _ - + @ で入力してください。";
  return undefined;
}

/** 新規登録・本人の変更で使えないログイン ID (デモ用アカウントの予約ドメイン) */
export function reservedLoginId(id: string): boolean {
  return id.toLowerCase().endsWith(DEMO_EMAIL_DOMAIN);
}

/** 顔写真の URL (登録していなければ undefined。変更したら URL が変わり、ブラウザーのキャッシュを使わない) */
export function avatarUrl(u: Pick<User, "id" | "avatarKey" | "avatarUpdatedAt">): string | undefined {
  if (!u.avatarKey) return undefined;
  return `/api/avatars/${encodeURIComponent(u.id)}?v=${encodeURIComponent(u.avatarUpdatedAt ?? "")}`;
}
