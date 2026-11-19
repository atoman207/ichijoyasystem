import "server-only";
import type { Database, StoreId, User } from "@/lib/db/types";
import { addDays, toDateKey } from "@/lib/format";
import { geocodePlace, type GeoPoint } from "@/lib/geo/kumamoto";
import { prefetchTravel, routingStatus } from "@/lib/geo/routing";
import { createPlanContext } from "./context";
import { loadMasters } from "./masters";

/**
 * Google の経路を使う設定のとき、提案・巡回順の計算の前に、使いそうな経路 (現場 ⇄ その期間の店舗の現場・店舗) を先に取りに行く。
 * 失敗しても計算は社内の目安で続く (routing.ts)
 */
export async function prefetchForStore(db: Database, user: User, q: { storeId: StoreId; address?: string; from?: string; days?: number; dayOnly?: string }, now = new Date()): Promise<void> {
  const m = loadMasters(db);
  if (!routingStatus(m.routing).ready) return;
  const today = toDateKey(now);
  const from = q.dayOnly ?? (q.from && q.from > today ? q.from : today);
  const to = q.dayOnly ?? addDays(from, Math.min(62, q.days ?? 21));
  const ctx = createPlanContext(db, user, { now, from, to, masters: m });
  const site = q.address ? geocodePlace(q.address, { storeId: q.storeId, customers: db.customers }) : undefined;
  const base = ctx.baseOf(q.storeId);
  const points: GeoPoint[] = [];
  for (const [k, items] of ctx.byStoreDay) {
    const [sid, d] = k.split("|");
    if (sid !== q.storeId || d < from || d > to) continue;
    for (const it of items) {
      const g = ctx.geoOf(it);
      if (g && !points.some((p) => p.lat === g.lat && p.lng === g.lng)) points.push(g);
    }
  }
  const pairs: [GeoPoint, GeoPoint, number?][] = [];
  if (site) {
    if (base) pairs.push([base, site, 510], [site, base, 1020]);
    for (const p of points.slice(0, 120)) pairs.push([p, site], [site, p]);
  }
  if (q.dayOnly) {
    const all = base ? [base, ...points] : points;
    for (const a of all.slice(0, 15)) for (const b of all.slice(0, 15)) if (a !== b) pairs.push([a, b]);
  }
  if (pairs.length) await prefetchTravel(pairs, m.routing, { maxElements: 300 });
}
