import "server-only";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { canAccessStore, canSeeAllStores } from "@/lib/auth/permissions";
import type { StoreId, User } from "@/lib/db/types";

/** サーバーアクション共通: ログインユーザー必須 */
export async function requireActionUser(): Promise<User> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return user;
}

export function withMsg(path: string, msg: string): string {
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}msg=${encodeURIComponent(msg)}`;
}

export function withErr(path: string, err: string): string {
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}err=${encodeURIComponent(err)}`;
}

export function fail(path: string, message: string): never {
  redirect(withErr(path, message));
}

export function assertStore(user: User, storeId: StoreId, backPath: string) {
  if (!canAccessStore(user, storeId)) fail(backPath, "この店舗の情報を操作する権限がありません。");
}

/** 店舗ロールは自店舗に固定、全店舗ロールはフォームの値を採用 */
export function resolveStoreId(user: User, requested: string | null | undefined, fallback?: StoreId): StoreId {
  if (!canSeeAllStores(user)) return user.storeId;
  const valid: StoreId[] = ["koshi", "chuo", "nishi", "tamana", "hq"];
  if (requested && (valid as string[]).includes(requested)) return requested as StoreId;
  return fallback ?? user.storeId;
}

/** フォームから受け取った戻り先: アプリ内のパスだけを許可 (外部サイトへの転送を防ぐ) */
export function safeReturn(value: string, fallback: string): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || /[\\\r\n]/.test(value)) return fallback;
  return value;
}

/** 選択肢の表 (ラベルの対応表など) のキーか。toString・constructor などの組み込みの名前は通さない */
export function isKeyOf<T extends object>(table: T, value: string): value is Extract<keyof T, string> {
  return Object.prototype.hasOwnProperty.call(table, value);
}

/**
 * 選択肢の値を受け取る。表 (ラベルの対応表) または一覧にない値 (改ざんされた値など) は fallback にする
 * 例: choice(formData, "channel", CHANNEL_LABEL, "phone")
 */
export function choice<K extends string>(fd: FormData, key: string, options: Record<K, unknown> | readonly K[], fallback: NoInfer<K>): K {
  const v = str(fd, key);
  const ok = Array.isArray(options) ? (options as readonly string[]).includes(v) : isKeyOf(options as object, v);
  return ok ? (v as K) : fallback;
}

export function str(fd: FormData, key: string): string {
  return String(fd.get(key) ?? "").trim();
}

export function numField(fd: FormData, key: string): number {
  const v = Number(String(fd.get(key) ?? "").replace(/[,¥\s]/g, ""));
  return Number.isFinite(v) ? v : 0;
}
