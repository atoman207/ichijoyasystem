import type { Database, StoreId, User } from "@/lib/db/types";
import { matchArea } from "@/lib/mgmt/areas";
import { canAccessStore, canSeeAllStores } from "@/lib/auth/permissions";
import { toDateKey } from "@/lib/format";

/**
 * 住所からの担当店舗 (お客様のご要望 2026-11-24「③ 担当店舗 (売上計上店舗) の自動設定」)
 * ------------------------------------------------------------
 * 担当店舗 = 施工を担当し、売上を計上する店舗。住所 (施工場所 → お客様の住所) の担当エリアで決める。
 * エリアは管理会計の営業エリア (db.salesAreas = 予定表の「地域一覧」の取込 + 手で足した地域。管理会計 → 設定 → 営業エリア)。
 * 地域一覧にない地域 (お客様のご指示の郡・市・区の町など) も営業エリアの行として登録する (エリアは社外秘のためコードに書かない)。判定は mgmt/areas.ts の matchArea (一番長く一致した地域)。
 * どれにも当たらない・別の店舗の地域に同じ長さで当たるときは決めない (今までどおり受け付けた店舗)。案件ごとに手で変えられる
 */

export interface AreaStore {
  storeId: StoreId;
  storeName: string;
  /** 当たった地域の名前 (地域一覧の町名・市町村名) */
  town: string;
}

/** 住所の担当エリアの店舗。決まらないときは undefined */
export function areaStoreOf(db: Pick<Database, "salesAreas" | "stores">, address: string | undefined | null, date = toDateKey(new Date())): AreaStore | undefined {
  if (!address?.trim()) return undefined;
  const m = matchArea(db, address, date);
  if (m.status !== "matched" || !m.storeId) return undefined;
  const s = db.stores.find((x) => x.id === m.storeId);
  return s ? { storeId: s.id, storeName: s.name, town: m.key ?? "" } : undefined;
}

/**
 * 新しい問い合わせ (案件) の担当店舗
 *   手で選んだ店舗 (選べる店舗のとき) > 住所の担当エリア > お客様の店舗 > 受け付けた人の店舗
 * 選べる店舗: 全店舗のロールはすべて。ほかの人は自店舗と、住所の担当エリアの店舗 (エリアの店舗に回す = その店舗に知らせる)
 */
export function newCaseStore(
  db: Pick<Database, "salesAreas" | "stores">,
  user: User,
  p: { requested?: string; auto?: boolean; address?: string; customer?: { storeId: StoreId; address?: string } },
): { storeId: StoreId; area?: AreaStore; byArea: boolean } {
  const area = areaStoreOf(db, p.address || p.customer?.address);
  const exists = (id: string | undefined): id is StoreId => Boolean(id && db.stores.some((s) => s.id === id));
  const allowed = (id: StoreId) => canSeeAllStores(user) || canAccessStore(user, id) || id === area?.storeId;
  if (!p.auto && exists(p.requested) && allowed(p.requested)) return { storeId: p.requested, area, byArea: p.requested === area?.storeId };
  if (area) return { storeId: area.storeId, area, byArea: true };
  if (p.customer && allowed(p.customer.storeId)) return { storeId: p.customer.storeId, byArea: false };
  return { storeId: exists(p.requested) && allowed(p.requested) ? p.requested : user.storeId, byArea: false };
}
