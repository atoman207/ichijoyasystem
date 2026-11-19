import "server-only";
import type { Customer, Database, MapDocument, MapLocation, MapLocationRef, MapRefType, Order, ScheduleEvent, StoreId, User } from "@/lib/db/types";
import { BACKEND, addAudit, newId, nowIso } from "@/lib/db/store";
import { missingTables, recheckMissingTables } from "@/lib/db/supabase";
import { syncOrderEvent } from "@/lib/db/schedule";
import { toDateKey } from "@/lib/format";
import { normalizeAddress, sameAddressText, sameHouse } from "./address";
import { basePlaceOfEvent, eventLocationMode, mapIndex, touchMapIndex, type ResolvedPlace } from "./resolve";

/**
 * 地図・住宅地図の書き込み (mutate の中で呼ぶ関数と、表の有無の確認)
 * ------------------------------------------------------------
 * - 場所は住所のキーで 1 つにまとめる (同じ番地の場所を二重に作らない)
 * - 住所の変更は、施工場所がお客様の住所と同じ進行中の受注と、案件・お客様の場所に合わせている今後の予定に反映する
 *   (この予定だけの場所 (custom) は変えない。完了した受注・過去の予定は当時の住所のまま残す)
 */

export const MAP_TABLES = ["map_locations", "map_location_refs", "map_documents", "map_document_links"];

/**
 * 地図の表が本番のデータベースにあるか (npm run deploy / npm run db:migrate で作る)。
 * ない間は地図の書き込みを断る (表示は住所の文字と Google マップのリンクだけで続く)。ないときは説明を返す
 */
export async function mapTablesMissing(): Promise<string | null> {
  if (BACKEND !== "supabase") return null;
  if (!missingTables().some((t) => MAP_TABLES.includes(t))) return null;
  const still = (await recheckMissingTables()).filter((t) => MAP_TABLES.includes(t));
  return still.length ? `地図の表 (${still.join("・")}) がまだデータベースにありません。管理者がデプロイ (npm run deploy) するか、npm run db:migrate を実行してください。` : null;
}

/** 地図の表が使えるか (mutate の中で、既存の画面の保存に地図の書き込みを足すときの確認。ないときは地図の書き込みだけを省く) */
export function mapTablesReady(): boolean {
  return BACKEND !== "supabase" || !missingTables().some((t) => MAP_TABLES.includes(t));
}

export const refId = (type: MapRefType, id: string) => `mlr_${type}_${id}`;
export const linkId = (documentId: string, locationId: string) => `mdl_${documentId}_${locationId}`;

/** 記録の結び付けを設定する (1 記録 1 行) */
export function setRef(db: Database, user: Pick<User, "id">, ref: Omit<MapLocationRef, "id" | "linkedBy" | "linkedAt">): MapLocationRef {
  const id = refId(ref.recordType, ref.recordId);
  const row: MapLocationRef = { id, ...ref, linkedBy: user.id, linkedAt: nowIso() };
  const i = db.mapLocationRefs.findIndex((r) => r.id === id);
  if (i >= 0) db.mapLocationRefs[i] = row;
  else db.mapLocationRefs.push(row);
  touchMapIndex();
  return row;
}

export function clearRef(db: Database, type: MapRefType, id: string): void {
  const rid = refId(type, id);
  const before = db.mapLocationRefs.length;
  db.mapLocationRefs = db.mapLocationRefs.filter((r) => r.id !== rid);
  if (db.mapLocationRefs.length !== before) touchMapIndex();
}

/**
 * 場所を登録する (登録済みならそれを返す)。番地まである住所は同じキーの場所を使う。
 * 番地のない住所は記録ごとの場所を作り、記録に結び付ける (自動では他の記録と共有しない)
 */
export function ensureLocation(db: Database, user: Pick<User, "id">, place: Pick<ResolvedPlace, "location" | "norm" | "addressText" | "record">, opts: { source?: "app" | "batch" } = {}): { location: MapLocation; created: boolean } {
  if (place.location) return { location: place.location, created: false };
  const norm = place.norm;
  if (norm.precision === "house") {
    const existing = mapIndex(db).byKey.get(norm.key);
    if (existing) return { location: existing, created: false };
  }
  const now = nowIso();
  const location: MapLocation = {
    id: newId("loc"),
    addressKey: norm.key,
    address: norm.display || place.addressText,
    postalCode: norm.postalCode,
    precision: norm.precision,
    status: "active",
    source: opts.source ?? "app",
    storeId: place.record.storeId,
    createdBy: user.id,
    createdAt: now,
    updatedBy: user.id,
    updatedAt: now,
  };
  db.mapLocations.push(location);
  touchMapIndex();
  if (norm.precision !== "house") {
    setRef(db, user, { recordType: place.record.type, recordId: place.record.id, mode: place.record.type === "event" ? "custom" : "manual", locationId: location.id, addressSnapshot: place.addressText });
  }
  return { location, created: true };
}

/** 場所に結び付いた使用中の PDF */
export function activeDocumentsOf(db: Database, locationId: string): MapDocument[] {
  return mapIndex(db).docsByLocation.get(locationId) ?? [];
}

export function linkDocument(db: Database, user: Pick<User, "id">, documentId: string, locationId: string): boolean {
  const id = linkId(documentId, locationId);
  if (db.mapDocumentLinks.some((l) => l.id === id)) return false;
  db.mapDocumentLinks.push({ id, documentId, locationId, linkedBy: user.id, linkedAt: nowIso() });
  touchMapIndex();
  return true;
}

export function unlinkDocument(db: Database, documentId: string, locationId: string): boolean {
  const before = db.mapDocumentLinks.length;
  db.mapDocumentLinks = db.mapDocumentLinks.filter((l) => !(l.documentId === documentId && l.locationId === locationId));
  touchMapIndex();
  return db.mapDocumentLinks.length !== before;
}

/* ---------------- 住所の変更の反映 ---------------- */

const DONE = ["completed", "invoiced", "paid", "cancelled"];
const todayKey = () => toDateKey(new Date());

/** 住所の文字が「同じ場所」か (番地まで同じ、または文字が同じ) */
function sameSpot(a: string | undefined, b: string | undefined): boolean {
  return sameAddressText(a, b) || sameHouse(a, b);
}

/**
 * 予定の場所の文字を、案件・お客様の場所に合わせている今後の予定について更新する (受注と連動する施工の予定は syncOrderEvent が更新する)。
 * beforeAddress: 変更前の住所 (結び付けの記録がない予定は、場所の文字が変更前の住所と同じなら「合わせている」とみなす)
 */
function refreshFollowingEvents(db: Database, user: Pick<User, "id">, events: ScheduleEvent[], beforeAddress: string | undefined): number {
  const today = todayKey();
  const idx = mapIndex(db);
  let n = 0;
  for (const e of events) {
    if (e.date < today || e.source === "order") continue;
    const ref = idx.refs.get(`event:${e.id}`);
    if (ref?.mode === "custom") continue;
    const follows = ref?.mode === "follow" || !e.location?.trim() || sameSpot(e.location, beforeAddress);
    if (!follows) continue;
    const base = basePlaceOfEvent(db, e, idx);
    if (!base?.addressText || sameAddressText(base.addressText, e.location)) continue;
    const prev = e.location;
    e.location = base.addressText.slice(0, 200);
    e.updatedBy = user.id;
    e.updatedAt = nowIso();
    addAudit(db, { userId: user.id, action: "update", entity: "schedule", entityId: e.id, entityLabel: e.title, summary: "案件・お客様の住所の変更に合わせて場所を更新", storeId: e.storeId, changes: [{ field: "location", before: prev, after: e.location }] });
    n += 1;
  }
  return n;
}

/**
 * お客様の住所が変わったとき (変更・承認の反映の直後に呼ぶ)。
 * - 施工場所がお客様の変更前の住所と同じ進行中の受注 → 新しい住所へ (施工の予定も)
 * - 案件・お客様の場所に合わせている今後の予定 → 新しい住所へ
 * 完了した受注・過去の予定・この予定だけの場所は変えない。反映した件数を返す
 */
export function propagateCustomerAddress(db: Database, user: Pick<User, "id">, c: Customer, beforeAddress: string): { orders: number; events: number } {
  if (sameAddressText(beforeAddress, c.address)) return { orders: 0, events: 0 };
  let orders = 0;
  const changedOrders = new Set<string>();
  for (const o of db.orders) {
    if (o.customerId !== c.id || DONE.includes(o.status)) continue;
    if (!o.siteAddress || !sameSpot(o.siteAddress, beforeAddress)) continue;
    const prev = o.siteAddress;
    o.siteAddress = c.address;
    o.updatedAt = nowIso();
    o.progressNotes.push({ id: newId("pn"), at: nowIso(), userId: user.id, kind: "change", body: `お客様の住所の変更に合わせて施工場所を変更: ${prev} → ${c.address}` });
    addAudit(db, { userId: user.id, action: "update", entity: "order", entityId: o.id, entityLabel: o.number, summary: "お客様の住所の変更に合わせて施工場所を変更", storeId: o.storeId, changes: [{ field: "siteAddress", before: prev, after: o.siteAddress }] });
    if (db.schedule.some((e) => e.orderId === o.id && e.source === "order")) syncOrderEvent(db, o, user.id);
    changedOrders.add(o.id);
    orders += 1;
  }
  for (const q of db.quotes) {
    // 見積の施工場所に変更前の住所がそのまま入っているもの (受注前) は、空 (= お客様の住所と同じ) に戻す
    if (q.customerId !== c.id || q.orderId || !q.siteAddress || !sameSpot(q.siteAddress, beforeAddress)) continue;
    if (["rejected", "expired"].includes(q.status)) continue;
    const prev = q.siteAddress;
    q.siteAddress = undefined;
    q.updatedAt = nowIso();
    addAudit(db, { userId: user.id, action: "update", entity: "quote", entityId: q.id, entityLabel: q.number, summary: "お客様の住所の変更に合わせて施工場所を「お客様の住所と同じ」に変更", storeId: q.storeId, changes: [{ field: "siteAddress", before: prev, after: undefined }] });
  }
  touchMapIndex();
  const events = db.schedule.filter((e) => e.customerId === c.id || (e.orderId && changedOrders.has(e.orderId)));
  return { orders, events: refreshFollowingEvents(db, user, events, beforeAddress) };
}

/** 受注の施工場所が変わったとき: 案件の場所に合わせている今後の予定を更新する (施工の予定は syncOrderEvent が更新する) */
export function propagateOrderSite(db: Database, user: Pick<User, "id">, o: Order, beforeSite: string | undefined): number {
  if (sameAddressText(beforeSite, o.siteAddress)) return 0;
  touchMapIndex();
  return refreshFollowingEvents(db, user, db.schedule.filter((e) => e.orderId === o.id), beforeSite);
}

/**
 * 予定の場所の指定を保存する (予定の登録・変更の後)。案件・お客様がない予定は custom。
 * custom で番地まである住所は、場所のキーで探せるので結び付けの場所は持たない
 */
export function saveEventLocationMode(db: Database, user: Pick<User, "id">, e: ScheduleEvent, mode: "follow" | "custom"): void {
  if (e.source === "order") {
    clearRef(db, "event", e.id);
    return;
  }
  const base = basePlaceOfEvent(db, e);
  const m = base ? mode : "custom";
  const prev = mapIndex(db).refs.get(`event:${e.id}`);
  const keepLoc = m === "custom" && prev?.locationId && sameAddressText(prev.addressSnapshot, e.location) ? prev.locationId : undefined;
  setRef(db, user, { recordType: "event", recordId: e.id, mode: m, locationId: keepLoc, addressSnapshot: m === "custom" ? e.location : undefined });
}

/** 予定の今の場所の指定 (画面の初期値) */
export function currentEventMode(db: Database, e: ScheduleEvent): "follow" | "custom" {
  return eventLocationMode(db, e);
}

/* ---------------- 閲覧の記録 ---------------- */

const gv = globalThis as typeof globalThis & { __ichijoyaMapViews?: Map<string, number> };
const viewed: Map<string, number> = (gv.__ichijoyaMapViews ??= new Map());
const VIEW_LOG_INTERVAL = 10 * 60 * 1000;

/** 住宅地図の PDF の閲覧を記録するか (同じ人・同じ PDF は 10 分に 1 回だけ記録する。書き込みを増やしすぎないため) */
export function shouldLogView(userId: string, documentId: string): boolean {
  const key = `${userId}:${documentId}`;
  const now = Date.now();
  const last = viewed.get(key) ?? 0;
  if (now - last < VIEW_LOG_INTERVAL) return false;
  viewed.set(key, now);
  if (viewed.size > 5000) for (const [k, t] of viewed) if (now - t > VIEW_LOG_INTERVAL) viewed.delete(k);
  return true;
}

export function docLabel(d: Pick<MapDocument, "title" | "fileName">): string {
  return d.title || d.fileName;
}

export function storeOfRecord(db: Database, type: MapRefType, id: string): StoreId | undefined {
  switch (type) {
    case "customer":
      return db.customers.find((x) => x.id === id)?.storeId;
    case "quote":
      return db.quotes.find((x) => x.id === id)?.storeId;
    case "order":
      return db.orders.find((x) => x.id === id)?.storeId;
    case "event":
      return db.schedule.find((x) => x.id === id)?.storeId;
  }
}

/** 住所の正規化 (表示用に再公開) */
export { normalizeAddress };
