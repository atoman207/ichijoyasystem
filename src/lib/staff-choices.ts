import type { Database, StoreId, User } from "@/lib/db/types";

/**
 * 担当者の選択肢 (お客様のご要望 2026-11-24「④ 担当者の選択肢」)
 * ------------------------------------------------------------
 * 本部 (店舗の種類が hq) の社員は、どの店舗の担当者の選択肢にも出す (全店舗共通)。社員の名前はコードに書かない。
 * 本部の社員が担当しても、売上は案件の担当店舗 (施工店舗 = 住所の担当エリアの店舗) に計上する (Order.storeId。担当者の店舗ではない)
 */

/** 全店舗共通の担当者 (本部の社員) か */
export function isCommonStaff(db: Pick<Database, "stores">, u: Pick<User, "storeId">): boolean {
  return db.stores.some((s) => s.id === u.storeId && s.kind === "hq");
}

/** 店舗の担当者の選択肢: その店舗の社員 → 本部の社員 (全店舗共通) → keepIds (今の担当など、ほかの店舗の人) */
export function staffForStore(db: Pick<Database, "stores" | "users">, storeId: StoreId, keepIds: (string | undefined)[] = []): User[] {
  const active = db.users.filter((u) => u.active && !u.id.startsWith("u_review"));
  const own = active.filter((u) => u.storeId === storeId);
  const common = active.filter((u) => u.storeId !== storeId && isCommonStaff(db, u));
  const keep = new Set(keepIds.filter(Boolean));
  const kept = active.filter((u) => keep.has(u.id) && !own.includes(u) && !common.includes(u));
  return [...own, ...common, ...kept];
}
