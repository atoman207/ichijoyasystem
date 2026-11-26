import type { Database, StoreId, User } from "@/lib/db/types";
import type { QuickStaff } from "@/components/schedule/quick-types";
import { initialsByUser } from "@/lib/schedule-sheet/initials";
import { isCommonStaff } from "@/lib/staff-choices";
import { avatarUrl } from "@/lib/account-rules";

/**
 * 予定の担当者の選択肢 (予定表の小さな画面・依頼の画面の日程登録で共通): その店舗の社員 → 本部の社員 (全店舗共通) → ほかの店舗の社員 (配送・施工の応援)。
 * 丸は予定表のチップと同じ顔写真 (なければ名前の 1 文字)、輪の色は店舗の色
 */
export function quickStaff(db: Pick<Database, "users" | "stores">, storeId: StoreId): QuickStaff[] {
  const active = db.users.filter((u) => u.active && !u.id.startsWith("u_review"));
  const initials = initialsByUser(active);
  const order = new Map(db.stores.map((s, i) => [s.id, i]));
  const group = (u: User): QuickStaff["group"] => (u.storeId === storeId ? "store" : isCommonStaff(db, u) ? "common" : "other");
  const rank = { store: 0, common: 1, other: 2 };
  return active
    .map((u) => {
      const s = db.stores.find((x) => x.id === u.storeId);
      return { id: u.id, name: u.name, initial: initials.get(u.id) ?? [...u.name][0], avatar: avatarUrl(u), storeId: u.storeId, storeName: s?.shortName ?? s?.name ?? u.storeId, color: s?.color ?? "#94a3b8", group: group(u) };
    })
    .sort((a, b) => rank[a.group] - rank[b.group] || (order.get(a.storeId) ?? 99) - (order.get(b.storeId) ?? 99) || a.name.localeCompare(b.name, "ja"));
}
