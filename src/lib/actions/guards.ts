import "server-only";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { canAccessStore, canEditCaseStore, canSeeAllStores } from "@/lib/auth/permissions";
import type { StoreId, User } from "@/lib/db/types";
import { getDb } from "@/lib/db/store";

/** サーバーアクション共通: ログインユーザー必須 */
export async function requireActionUser(): Promise<User> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return user;
}

/** 戻り先に ?msg= / ?err= を付ける。ページ内の位置 (#…) があればその前に付ける (後ろに付けると位置の一部になって画面にメッセージが出ない) */
function withParam(path: string, key: string, value: string): string {
  const i = path.indexOf("#");
  const base = i < 0 ? path : path.slice(0, i);
  const hash = i < 0 ? "" : path.slice(i);
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}${key}=${encodeURIComponent(value)}${hash}`;
}

export function withMsg(path: string, msg: string): string {
  return withParam(path, "msg", msg);
}

export function withErr(path: string, err: string): string {
  return withParam(path, "err", err);
}

export function fail(path: string, message: string): never {
  redirect(withErr(path, message));
}

export function assertStore(user: User, storeId: StoreId, backPath: string) {
  if (!canAccessStore(user, storeId)) fail(backPath, "この店舗の情報を操作する権限がありません。");
}

/** 顧客・問い合わせ・見積・受注の登録・変更: 自店舗 (全店舗ロールは全店舗)、店長は全店舗 (permissions.ts の canEditCaseStore) */
export function assertCaseStore(user: User, storeId: StoreId, backPath: string) {
  if (!canEditCaseStore(user, storeId)) fail(backPath, "この店舗の情報を操作する権限がありません。");
}

/** 店舗ロールは自店舗に固定、全店舗ロールはフォームの値を採用 */
export function resolveStoreId(user: User, requested: string | null | undefined, fallback?: StoreId): StoreId {
  if (!canSeeAllStores(user)) return user.storeId;
  // 店舗の一覧はデータベースから (管理者が追加した店舗も選べる)
  if (requested && getDb().stores.some((s) => s.id === requested)) return requested as StoreId;
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
