import "server-only";
import type { Database, MapDocument, MapLocation, MapRefType, User } from "@/lib/db/types";
import { canAccessStore, canSeeAllStores } from "@/lib/auth/permissions";
import { toDateKey } from "@/lib/format";
import { locationReferences, mapIndex } from "./resolve";

/**
 * 地図・住宅地図の閲覧と操作の権限
 * ------------------------------------------------------------
 * - 画面の記録 (顧客・見積・受注) を見られる人 = その店舗のメンバーと全店舗ロール
 * - 予定: その店舗のメンバー・担当者・登録者 (予定表は全社で見られるが、住宅地図は担当する人だけ)
 * - 場所・PDF を直接開くとき (URL): その場所を参照する記録のどれかを見られる人、またはその場所の今後の予定の担当者
 */

/** 画面の記録から、その記録の地図 (場所・住宅地図) を見られるか */
export function canViewRecordMap(user: User, db: Database, type: MapRefType, id: string): boolean {
  const all = canSeeAllStores(user);
  switch (type) {
    case "customer": {
      const c = db.customers.find((x) => x.id === id);
      return Boolean(c && (all || canAccessStore(user, c.storeId)));
    }
    case "quote": {
      const q = db.quotes.find((x) => x.id === id);
      return Boolean(q && (all || canAccessStore(user, q.storeId)));
    }
    case "order": {
      const o = db.orders.find((x) => x.id === id);
      return Boolean(o && (all || canAccessStore(user, o.storeId)));
    }
    case "event": {
      const e = db.schedule.find((x) => x.id === id);
      return Boolean(e && (all || canAccessStore(user, e.storeId) || e.assigneeIds.includes(user.id) || e.createdBy === user.id));
    }
  }
  return false;
}

/** 記録の地図に住宅地図を登録・差し替え・位置を修正できるか (閲覧できる人と同じ。店舗スタッフも現場で使うため) */
export function canEditRecordMap(user: User, db: Database, type: MapRefType, id: string): boolean {
  return user.active && canViewRecordMap(user, db, type, id);
}

/** 場所を見られるか (場所の画面・PDF を直接開くとき) */
export function canViewLocation(user: User, db: Database, loc: MapLocation): boolean {
  if (canSeeAllStores(user)) return true;
  if (loc.storeId === user.storeId) return true;
  const today = toDateKey(new Date());
  return locationReferences(db, loc, { today }).some((r) => (r.type === "event" ? (canAccessStore(user, r.storeId) || r.assigneeIds?.includes(user.id)) && (r.date ?? "") >= today : canAccessStore(user, r.storeId)));
}

/** PDF を見られるか: 結び付いた場所のどれかを見られる人 (結び付きのない PDF は登録した店舗) */
export function canViewMapDocument(user: User, db: Database, doc: MapDocument): boolean {
  if (canSeeAllStores(user)) return true;
  const idx = mapIndex(db);
  const locIds = idx.locationsByDoc.get(doc.id) ?? [];
  if (!locIds.length) return canAccessStore(user, doc.storeId);
  return locIds.some((id) => {
    const loc = idx.locations.get(id);
    return Boolean(loc && canViewLocation(user, db, loc));
  });
}
