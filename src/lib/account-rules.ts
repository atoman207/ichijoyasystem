import type { User } from "@/lib/db/types";
import { DEMO_EMAIL_DOMAIN } from "@/lib/auth/permissions";

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
