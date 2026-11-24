import type { Database, User } from "@/lib/db/types";
import { canSeeAllStores } from "@/lib/auth/permissions";
import { isCommonStaff } from "@/lib/staff-choices";

/**
 * 予定表の初期表示の店舗 (お客様のご要望 2026-11-24「予定表の初期表示」)
 * ------------------------------------------------------------
 * 合志店・中央店・西店・玉名店の所属 → その店舗だけ / 管理者・本部 (ロールが管理者・本部スタッフ、または所属が本部の店舗) → 全店舗 ("all")。
 * 所属の店舗がない・見つからないときも全店舗。あくまで初期表示で、予定表の店舗のタブでほかの店舗・全社に切り替えられる (URL の store が優先)
 */
export function defaultScheduleStore(db: Pick<Database, "stores">, user: User): string {
  if (canSeeAllStores(user)) return "all";
  if (!user.storeId || !db.stores.some((s) => s.id === user.storeId)) return "all";
  if (isCommonStaff(db, user)) return "all";
  return user.storeId;
}
