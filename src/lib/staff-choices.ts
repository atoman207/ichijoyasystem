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

/**
 * 店舗の担当者の選択肢: その店舗 (施工店舗) の社員 → 本部の社員 (全店舗共通) → ほかの店舗の社員 (店舗の表示順) → keepIds (今の担当で退職した人など)。
 * ほかの店舗の社員も選べる (お客様のご要望 2026-11-27「■2」: 店舗をまたいで引き取り・納品・工事を行うため)
 */
export function staffForStore(db: Pick<Database, "stores" | "users">, storeId: StoreId, keepIds: (string | undefined)[] = []): User[] {
  const active = db.users.filter((u) => u.active && !u.id.startsWith("u_review"));
  const own = active.filter((u) => u.storeId === storeId);
  const common = active.filter((u) => u.storeId !== storeId && isCommonStaff(db, u));
  const rank = new Map(db.stores.map((s, i) => [s.id, i]));
  const others = active.filter((u) => !own.includes(u) && !common.includes(u)).sort((a, b) => (rank.get(a.storeId) ?? 99) - (rank.get(b.storeId) ?? 99));
  const keep = new Set(keepIds.filter(Boolean));
  const kept = db.users.filter((u) => keep.has(u.id) && !u.active);
  return [...own, ...common, ...others, ...kept];
}

/** 担当者の選択肢のまとまり (店舗ごと)。画面の選択肢 (StaffOptions・作業の担当) で使う */
export interface StaffChoiceGroup {
  storeId: string;
  /** 店舗名 (先頭のまとまりは「(施工店舗)」を付ける) */
  label: string;
  /** 施工店舗 (案件の店舗) のまとまり */
  primary: boolean;
  users: { id: string; name: string; storeId: string; title?: string }[];
}

/**
 * 担当者の選択肢を店舗ごとに (お客様のご要望 2026-11-27「■2 担当者の選択」: 施工店舗の社員を優先して表示・ほかの店舗の社員も選べる。
 * 店舗をまたいで引き取り・納品・工事に行くため)。並び = 施工店舗 → 本部 → ほかの店舗 (店舗の表示順) → 今の担当のうち退職などで選べない人
 */
export function staffChoiceGroups(db: Pick<Database, "stores" | "users">, storeId: StoreId | string | undefined, keepIds: (string | undefined)[] = []): StaffChoiceGroup[] {
  const active = db.users.filter((u) => u.active && !u.id.startsWith("u_review"));
  const order = [
    ...db.stores.filter((s) => s.id === storeId),
    ...db.stores.filter((s) => s.id !== storeId && s.kind === "hq"),
    ...db.stores.filter((s) => s.id !== storeId && s.kind !== "hq"),
  ];
  const groups: StaffChoiceGroup[] = order
    .map((s) => ({
      storeId: s.id,
      label: s.id === storeId ? `${s.name} (施工店舗)` : s.name,
      primary: s.id === storeId,
      users: active.filter((u) => u.storeId === s.id).map((u) => ({ id: u.id, name: u.name, storeId: u.storeId, title: u.title })),
    }))
    .filter((g) => g.users.length > 0);
  const listed = new Set(groups.flatMap((g) => g.users.map((u) => u.id)));
  const orphans = active.filter((u) => !listed.has(u.id));
  const keep = new Set(keepIds.filter((x): x is string => Boolean(x)));
  const former = db.users.filter((u) => keep.has(u.id) && !listed.has(u.id) && !orphans.includes(u));
  if (orphans.length) groups.push({ storeId: "", label: "所属なし", primary: false, users: orphans.map((u) => ({ id: u.id, name: u.name, storeId: u.storeId, title: u.title })) });
  if (former.length) groups.push({ storeId: "", label: "今の担当 (選択肢にない人)", primary: false, users: former.map((u) => ({ id: u.id, name: u.name, storeId: u.storeId, title: u.title })) });
  return groups;
}
