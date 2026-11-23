import type { Database, Order, Quote, TatamiRoom } from "@/lib/db/types";
import { cleanRooms, roomsFromLines } from "@/lib/tatami-spec";

/**
 * 案件の畳の仕様 (部屋ごと。src/lib/tatami-spec.ts) を決める: 受注で入れた仕様 → 見積で入れた仕様 → 見積の明細から自動。
 * source: order / quote = 人が入れた (保存した) 仕様、auto = 見積の明細と手書きの備考から自動で作った案
 */

export type RoomsSource = "order" | "quote" | "auto";

type Db = Pick<Database, "quotes" | "products" | "materials">;

function lookups(db: Db) {
  const products = new Map((db.products ?? []).map((p) => [p.id, p.category as string]));
  const materials = new Map((db.materials ?? []).map((m) => [m.id, m.name]));
  return { productCategory: (id: string) => products.get(id), materialName: (id: string) => materials.get(id) };
}

export function quoteRooms(db: Db, q: Pick<Quote, "items" | "siteInfo" | "tatamiRooms">): { rooms: TatamiRoom[]; source: RoomsSource } {
  const saved = cleanRooms(q.tatamiRooms ?? []).rooms;
  if (q.tatamiRooms && saved.length) return { rooms: saved, source: "quote" };
  return { rooms: roomsFromLines({ items: q.items ?? [], siteInfo: q.siteInfo, ...lookups(db) }), source: "auto" };
}

export function orderRooms(db: Db, o: Pick<Order, "quoteId" | "siteInfo" | "tatamiRooms">): { rooms: TatamiRoom[]; source: RoomsSource } {
  const saved = cleanRooms(o.tatamiRooms ?? []).rooms;
  if (o.tatamiRooms && saved.length) return { rooms: saved, source: "order" };
  const q = o.quoteId ? db.quotes.find((x) => x.id === o.quoteId) : undefined;
  if (!q) return { rooms: [], source: "auto" };
  const r = quoteRooms(db, { items: q.items, siteInfo: o.siteInfo ?? q.siteInfo, tatamiRooms: q.tatamiRooms });
  return r;
}

export const ROOMS_SOURCE_LABEL: Record<RoomsSource, string> = {
  order: "受注で入れた仕様",
  quote: "見積で入れた仕様",
  auto: "見積の明細から自動で入れた案 (確かめて直してください)",
};
