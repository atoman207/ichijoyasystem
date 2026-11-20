import "server-only";
import type { Database, User } from "@/lib/db/types";
import { withAllStoresReadScope } from "@/lib/auth/permissions";
import { toDateKey } from "@/lib/format";

/**
 * AI アシスタントの閲覧範囲 (設定の id = assistant_scope)
 * - permission (既定): ログインした人の権限どおり (店舗のロールは自店舗)
 * - all_stores: AI アシスタントの読み取り (検索・集計・SQL・会社の全体像) だけ、全員が全店舗のデータを見られる。
 *   テスト期間などのため。終了日を決めると、その日を過ぎたら自動で権限どおりに戻る
 * 画面・登録・変更・承認・AI からの実行 (確認のカード)・ほかの人の相談の履歴・社内資料の公開範囲・管理会計 (社外秘) は変えない
 */

export const ASSISTANT_SCOPE_ID = "assistant_scope";

export interface AssistantScope {
  mode: "permission" | "all_stores";
  /** 全店舗にする最終日 (YYYY-MM-DD。空 = 戻すまで) */
  until?: string;
  updatedBy?: string;
  updatedAt?: string;
}

export function assistantScope(db: Pick<Database, "settings">): AssistantScope {
  const row = (db.settings ?? []).find((s) => s.id === ASSISTANT_SCOPE_ID);
  const v = (row?.value ?? {}) as Partial<AssistantScope>;
  return { mode: v.mode === "all_stores" ? "all_stores" : "permission", until: typeof v.until === "string" && v.until ? v.until : undefined, updatedBy: row?.updatedBy, updatedAt: row?.updatedAt };
}

/** いま全店舗を見られる設定か (終了日を過ぎていれば権限どおり) */
export function assistantAllStores(db: Pick<Database, "settings">, now = new Date()): boolean {
  const s = assistantScope(db);
  return s.mode === "all_stores" && (!s.until || s.until >= toDateKey(now));
}

/** AI アシスタントの読み取りに使う利用者 (全店舗の設定なら、全店舗を見られる写し) */
export function assistantReadUser(db: Pick<Database, "settings">, user: User, now = new Date()): User {
  return assistantAllStores(db, now) ? withAllStoresReadScope(user) : user;
}
