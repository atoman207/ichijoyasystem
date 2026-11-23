import type { Store } from "@/lib/db/types";
import { STORES } from "@/lib/db/master";

/**
 * 店舗の表示順 (お客様のご要望 2026-11-23「予定表の表示順: 全社 → 合志店 → 中央店 → 西店 → 玉名店 → 本部・ショールーム。
 * ほかの画面・項目もこの並び」)
 * ------------------------------------------------------------
 * 店舗 (kind = store) → 本部 (kind = hq) の順。店舗の中は店舗マスタ (src/lib/db/master.ts) の並び、管理者があとから足した店舗は
 * その後ろ (コードの順)。データベースの読み込み (migrateDb・変更の取り込み) で db.stores をこの順に並べるので、
 * 店舗の一覧 (タブ・選択肢・表・グラフ) はどの画面も db.stores の順のままで同じ並びになる
 */

const MASTER_RANK = new Map(STORES.map((s, i) => [s.id, i]));

export function compareStores(a: Pick<Store, "id" | "kind" | "code">, b: Pick<Store, "id" | "kind" | "code">): number {
  const hq = (s: Pick<Store, "kind">) => (s.kind === "hq" ? 1 : 0);
  const rank = (s: Pick<Store, "id">) => MASTER_RANK.get(s.id) ?? Number.MAX_SAFE_INTEGER;
  return hq(a) - hq(b) || rank(a) - rank(b) || String(a.code ?? "").localeCompare(String(b.code ?? ""), "ja", { numeric: true });
}

/** 表示順に並べた写し */
export function sortStores<T extends Pick<Store, "id" | "kind" | "code">>(list: readonly T[]): T[] {
  return [...list].sort(compareStores);
}

/** db.stores を表示順に並べ直す (読み込みのたびに呼ぶ。配列は作り直す) */
export function orderStores(db: { stores?: Store[] }): void {
  if (!Array.isArray(db.stores)) return;
  const sorted = sortStores(db.stores);
  if (sorted.some((s, i) => s !== db.stores![i])) db.stores = sorted;
}

/** 店舗 ID だけで並べるとき (店舗の行の並べ替え): 店舗マスタの店舗 → あとから足した店舗 → 本部 */
const ID_RANK = new Map(STORES.map((s, i) => [s.id, s.kind === "hq" ? 1000 + i : i]));
export function compareStoreIds(a: string | undefined, b: string | undefined): number {
  const r = (id: string | undefined) => (id ? (ID_RANK.get(id) ?? 500) : 2000);
  return r(a) - r(b) || String(a ?? "").localeCompare(String(b ?? ""));
}
