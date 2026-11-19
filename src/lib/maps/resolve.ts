import type { Customer, Database, MapDocument, MapLocation, MapLocationRef, MapRefType, Order, Quote, ScheduleEvent, StoreId } from "@/lib/db/types";
import { areaWithin, normalizeAddress, sameAddressText, type NormalizedAddress } from "./address";
import { mapLinkBasis, mapsDirectionsUrl, mapsSearchUrl, type MapLinkBasis, type MapTarget } from "./google";

/**
 * 顧客・見積・受注・予定の「場所」を決める (どの画面でも同じ結果になるよう、ここに集める)
 * ------------------------------------------------------------
 * 優先順位
 * - 顧客: 顧客の住所
 * - 見積: 見積の施工場所 (空ならお客様の住所と同じ)
 * - 受注: 受注の施工場所 (現場住所)。お客様の住所と違う場所なら、施工場所の住宅地図だけを使う
 *   (施工場所の地図がないときに、お客様の住所の地図を施工場所の地図として出さない)
 * - 予定: この予定だけの場所 (custom) > 案件 (受注 → 見積 → 問い合わせ) の場所 > お客様の住所。
 *   関係のない住所を黙って選ばない (案件・お客様のどちらもなく、場所も書かれていなければ「場所の登録なし」)
 *
 * 場所 (MapLocation) の見つけ方: 記録ごとの結び付け (MapLocationRef。住所の文字が変わっていないときだけ) →
 * 住所のキー (番地まであるときだけ) で登録済みの場所を探す。見つからなければ「未登録の場所」(住所の文字だけ)
 * このファイルは画面・API・テストから使う (サーバー専用の import をしない)
 */

export type PlaceRole = "customer" | "site" | "event";

export interface PlaceRecord {
  type: MapRefType;
  id: string;
  storeId: StoreId;
  customerId?: string;
  /** 例: 受注 R-2026-0012 */
  label: string;
  href: string;
}

export interface ResolvedPlace {
  role: PlaceRole;
  /** 見出し (お客様の住所 / 施工場所 / 予定の場所) */
  heading: string;
  /** どの記録の住所か (例: 受注 R-2026-0012 の施工場所 (お客様の住所と同じ)) */
  origin: string;
  /** 記録に書かれている住所 (元の文字) */
  addressText: string;
  norm: NormalizedAddress;
  /** 登録済みの場所 (なければ未登録 = 住所の文字だけ) */
  location?: MapLocation;
  /** 場所の持ち主の記録 (住宅地図の登録・位置の修正の登録先) */
  record: PlaceRecord;
  /** この場所の住宅地図 (使用中のもの。新しい順) */
  documents: MapDocument[];
  target: MapTarget;
  searchUrl?: string;
  directionsUrl?: string;
  basis: MapLinkBasis;
  /** お客様の住所と同じ場所 */
  sameAsCustomer?: boolean;
  /** 注意 (住所が不完全・位置が未確認など) */
  warnings: string[];
  /** 住宅地図がないときの説明 */
  missingNote?: string;
  /** 押せる案内 (施工場所をお客様の住所にする・案件の場所に合わせる) */
  suggestions: PlaceSuggestion[];
  /** 比較のためのお客様の住所 (施工場所・予定の場所がお客様の住所と違うとき) */
  customerAddress?: string;
}

export type PlaceSuggestion = { kind: "use_customer_address"; orderId: string; address: string } | { kind: "follow_case"; eventId: string; address: string };

/* ---------------- 索引 (場所・結び付け・PDF) ---------------- */

export interface MapIndex {
  locations: Map<string, MapLocation>;
  /** 番地まである住所のキー → 場所 (同じキーが複数あれば古いもの) */
  byKey: Map<string, MapLocation>;
  /** 同じキーの場所が 2 つ以上 (重複) */
  duplicateKeys: Map<string, MapLocation[]>;
  /** "<type>:<id>" → 結び付け */
  refs: Map<string, MapLocationRef>;
  /** 場所 → 使用中の PDF */
  docsByLocation: Map<string, MapDocument[]>;
  /** PDF → 結び付いた場所の ID */
  locationsByDoc: Map<string, string[]>;
  documents: Map<string, MapDocument>;
}

let version = 0;
/** 地図の表をこのプロセスの中で書き換えたときに呼ぶ (索引を作り直す) */
export function touchMapIndex(): void {
  version += 1;
}

const cache = new WeakMap<object, { sig: string; index: MapIndex }>();

function signature(db: Database): string {
  return [db.mapLocations.length, db.mapLocationRefs.length, db.mapDocuments.length, db.mapDocumentLinks.length, version].join(":");
}

export function mapIndex(db: Database): MapIndex {
  const holder = db.mapLocations as unknown as object;
  const sig = signature(db);
  const hit = cache.get(holder);
  if (hit && hit.sig === sig && cache.get(db.mapDocumentLinks as unknown as object)?.sig === sig) return hit.index;
  const locations = new Map(db.mapLocations.map((l) => [l.id, l]));
  const byKey = new Map<string, MapLocation>();
  const duplicateKeys = new Map<string, MapLocation[]>();
  for (const l of [...db.mapLocations].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) {
    if (l.status !== "active" || l.precision !== "house" || !l.addressKey) continue;
    const prev = byKey.get(l.addressKey);
    if (!prev) byKey.set(l.addressKey, l);
    else duplicateKeys.set(l.addressKey, [...(duplicateKeys.get(l.addressKey) ?? [prev]), l]);
  }
  const refs = new Map(db.mapLocationRefs.map((r) => [`${r.recordType}:${r.recordId}`, r]));
  const documents = new Map(db.mapDocuments.map((d) => [d.id, d]));
  const docsByLocation = new Map<string, MapDocument[]>();
  const locationsByDoc = new Map<string, string[]>();
  for (const link of db.mapDocumentLinks) {
    const d = documents.get(link.documentId);
    if (!d) continue;
    locationsByDoc.set(d.id, [...(locationsByDoc.get(d.id) ?? []), link.locationId]);
    if (d.status !== "active") continue;
    docsByLocation.set(link.locationId, [...(docsByLocation.get(link.locationId) ?? []), d]);
  }
  for (const list of docsByLocation.values()) list.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  const index = { locations, byKey, duplicateKeys, refs, docsByLocation, locationsByDoc, documents };
  cache.set(holder, { sig, index });
  cache.set(db.mapDocumentLinks as unknown as object, { sig, index });
  return index;
}

/** まとめられた (merged) 場所は、まとめ先をたどる */
export function liveLocation(idx: MapIndex, loc: MapLocation | undefined): MapLocation | undefined {
  let cur = loc;
  for (let i = 0; cur && cur.status === "merged" && i < 8; i++) cur = cur.mergedInto ? idx.locations.get(cur.mergedInto) : undefined;
  return cur && cur.status === "active" ? cur : undefined;
}

/** 記録の住所の文字から登録済みの場所を探す (結び付け → 住所のキー) */
export function findLocation(idx: MapIndex, recordType: MapRefType, recordId: string, text: string, norm: NormalizedAddress): MapLocation | undefined {
  const ref = idx.refs.get(`${recordType}:${recordId}`);
  if (ref?.locationId && (ref.mode === "manual" || ref.mode === "custom") && sameAddressText(ref.addressSnapshot ?? "", text)) {
    const loc = liveLocation(idx, idx.locations.get(ref.locationId));
    if (loc) return loc;
  }
  if (norm.precision === "house") return idx.byKey.get(norm.key);
  return undefined;
}

/* ---------------- 場所を決める ---------------- */

interface PlaceInput {
  role: PlaceRole;
  heading: string;
  origin: string;
  text: string;
  record: PlaceRecord;
  /** 場所を探すときの結び付けの記録 (省略時は record) */
  refRecord?: { type: MapRefType; id: string };
}

function build(db: Database, idx: MapIndex, input: PlaceInput): ResolvedPlace {
  const text = input.text?.trim() ?? "";
  const norm = normalizeAddress(text);
  const refRec = input.refRecord ?? input.record;
  const location = text ? findLocation(idx, refRec.type, refRec.id, text, norm) : undefined;
  const verified = location?.coordStatus === "verified";
  const target: MapTarget = {
    address: norm.display || undefined,
    lat: location?.lat,
    lng: location?.lng,
    coordsVerified: verified,
    placeId: location?.placeId,
  };
  const warnings: string[] = [];
  if (!text) warnings.push("住所が登録されていません。");
  else if (norm.precision !== "house") warnings.push(`住所が不完全です (${norm.notes.join("・")})。Google マップの位置は目安です。現地の位置を確認してください。`);
  else if (!verified && !location?.placeId) warnings.push("位置は住所の文字で検索しています (未確認)。番地まであっても位置がずれることがあります。");
  if (location?.coordStatus === "needs_review") warnings.push("自動で求めた位置が要確認です (候補が複数・おおよその位置)。");
  return {
    role: input.role,
    heading: input.heading,
    origin: input.origin,
    addressText: text,
    norm,
    location,
    record: input.record,
    documents: location ? (idx.docsByLocation.get(location.id) ?? []) : [],
    target,
    searchUrl: text || verified ? mapsSearchUrl(target) : undefined,
    directionsUrl: text || verified ? mapsDirectionsUrl(target) : undefined,
    basis: mapLinkBasis(target),
    warnings,
    suggestions: [],
  };
}

/** 同じ場所か (登録済みの場所が同じ・番地までの住所のキーが同じ・住所の文字が同じ) */
export function samePlace(a: Pick<ResolvedPlace, "location" | "norm" | "addressText">, b: Pick<ResolvedPlace, "location" | "norm" | "addressText">): boolean {
  if (a.location && b.location) return a.location.id === b.location.id;
  if (a.norm.precision === "house" && b.norm.precision === "house") return a.norm.key === b.norm.key;
  return sameAddressText(a.addressText, b.addressText);
}

const customerRecord = (c: Customer): PlaceRecord => ({ type: "customer", id: c.id, storeId: c.storeId, customerId: c.id, label: `顧客 ${c.code} ${c.name}`, href: `/customers/${c.id}` });

export function placeOfCustomer(db: Database, c: Customer, idx = mapIndex(db)): ResolvedPlace {
  return build(db, idx, { role: "customer", heading: "お客様の住所", origin: `顧客 ${c.code} ${c.name} 様の登録住所`, text: c.address, record: customerRecord(c) });
}

function withCustomer(site: ResolvedPlace, cust: ResolvedPlace | undefined, what: string, orderId?: string): ResolvedPlace {
  if (!cust || !cust.addressText) return site;
  if (samePlace(site, cust)) {
    // お客様の住所と同じ場所: 登録済みの場所 (お客様の住所で結び付けたものを含む) と地図を共有する
    const location = site.location ?? cust.location;
    return {
      ...site,
      location,
      documents: site.location ? site.documents : cust.documents,
      target: site.location ? site.target : cust.target,
      searchUrl: site.location ? site.searchUrl : cust.searchUrl,
      directionsUrl: site.location ? site.directionsUrl : cust.directionsUrl,
      basis: site.location ? site.basis : cust.basis,
      warnings: site.location ? site.warnings : cust.warnings,
      sameAsCustomer: true,
      origin: `${site.origin} (お客様の住所と同じ)`,
    };
  }
  const out: ResolvedPlace = { ...site, sameAsCustomer: false, customerAddress: cust.addressText };
  if (!site.documents.length) {
    out.missingNote = cust.documents.length
      ? `${what}はお客様の住所 (${cust.addressText}) と別の場所です。お客様の住所の住宅地図は${what}の地図ではないため表示していません。`
      : `${what}はお客様の住所と別の場所です。`;
  }
  if (orderId && site.norm.precision !== "house" && areaWithin(site.addressText, cust.addressText)) {
    out.suggestions.push({ kind: "use_customer_address", orderId, address: cust.addressText });
  }
  return out;
}

export function placeOfQuote(db: Database, q: Quote, idx = mapIndex(db)): ResolvedPlace {
  const c = db.customers.find((x) => x.id === q.customerId);
  const cust = c ? placeOfCustomer(db, c, idx) : undefined;
  const record: PlaceRecord = { type: "quote", id: q.id, storeId: q.storeId, customerId: q.customerId, label: `見積 ${q.number}`, href: `/quotes/${q.id}` };
  if (!q.siteAddress?.trim()) {
    // 見積の施工場所が空 = お客様の住所と同じ (見積の入力の決まり)
    if (!cust) return build(db, idx, { role: "site", heading: "施工場所", origin: `見積 ${q.number}`, text: "", record });
    return { ...cust, role: "site", heading: "施工場所", origin: `見積 ${q.number} の施工場所 (お客様の住所と同じ)`, sameAsCustomer: true };
  }
  return withCustomer(build(db, idx, { role: "site", heading: "施工場所", origin: `見積 ${q.number} の施工場所`, text: q.siteAddress, record }), cust, "施工場所");
}

export function placeOfOrder(db: Database, o: Order, idx = mapIndex(db)): ResolvedPlace {
  const c = db.customers.find((x) => x.id === o.customerId);
  const cust = c ? placeOfCustomer(db, c, idx) : undefined;
  const record: PlaceRecord = { type: "order", id: o.id, storeId: o.storeId, customerId: o.customerId, label: `受注 ${o.number}`, href: `/orders/${o.id}` };
  if (!o.siteAddress?.trim()) {
    if (!cust) return build(db, idx, { role: "site", heading: "施工場所", origin: `受注 ${o.number}`, text: "", record });
    // 施工場所が空の受注 (移行した記録の一部): お客様の住所であることを明示して出す
    return {
      ...cust,
      role: "site",
      heading: "施工場所",
      origin: `受注 ${o.number} に施工場所の登録がないため、お客様の住所を表示しています`,
      sameAsCustomer: true,
      warnings: ["施工場所が登録されていません。お客様の住所と違う場所なら、案件情報の「施工場所 (現場住所)」を入力してください。", ...cust.warnings],
    };
  }
  return withCustomer(build(db, idx, { role: "site", heading: "施工場所", origin: `受注 ${o.number} の施工場所`, text: o.siteAddress, record }), cust, "施工場所", o.id);
}

/** 予定が紐づく案件・お客様の場所 (予定に別の場所がなければこれを使う) */
export function basePlaceOfEvent(db: Database, e: Pick<ScheduleEvent, "orderId" | "quoteId" | "inquiryId" | "customerId">, idx = mapIndex(db)): ResolvedPlace | undefined {
  if (e.orderId) {
    const o = db.orders.find((x) => x.id === e.orderId);
    if (o) return placeOfOrder(db, o, idx);
  }
  if (e.quoteId) {
    const q = db.quotes.find((x) => x.id === e.quoteId);
    if (q) return placeOfQuote(db, q, idx);
  }
  const inq = e.inquiryId ? db.inquiries.find((x) => x.id === e.inquiryId) : undefined;
  const customerId = e.customerId ?? inq?.customerId;
  const c = customerId ? db.customers.find((x) => x.id === customerId) : undefined;
  return c ? placeOfCustomer(db, c, idx) : undefined;
}

/**
 * 予定の場所の指定: follow = 案件・お客様の場所 / custom = この予定だけの場所。
 * 結び付けの記録がない予定 (この機能より前の予定) は、場所の文字が案件・お客様の住所と同じなら follow、違えば custom とみなす
 */
export function eventLocationMode(db: Database, e: ScheduleEvent, idx = mapIndex(db), base = basePlaceOfEvent(db, e, idx)): "follow" | "custom" {
  if (e.source === "order") return "follow";
  const ref = idx.refs.get(`event:${e.id}`);
  if (ref?.mode === "follow" || ref?.mode === "custom") return base ? ref.mode : "custom";
  if (!base) return "custom";
  if (!e.location?.trim()) return "follow";
  const norm = normalizeAddress(e.location);
  return sameAddressText(e.location, base.addressText) || (norm.precision === "house" && base.norm.precision === "house" && norm.key === base.norm.key) ? "follow" : "custom";
}

export function placeOfEvent(db: Database, e: ScheduleEvent, idx = mapIndex(db)): ResolvedPlace {
  const base = basePlaceOfEvent(db, e, idx);
  const mode = eventLocationMode(db, e, idx, base);
  const record: PlaceRecord = { type: "event", id: e.id, storeId: e.storeId, customerId: e.customerId, label: `予定 ${e.title}`, href: `/schedule/${e.id}` };
  if (mode === "follow" && base) {
    const origin = e.source === "order" ? `${base.origin} (受注の施工予定と連動)` : `${base.origin} (案件・お客様の場所に合わせる)`;
    return { ...base, role: base.role === "customer" ? "customer" : "site", heading: base.role === "customer" ? "訪問先 (お客様の住所)" : "施工場所 (現場)", origin };
  }
  const text = e.location?.trim() ?? "";
  if (!text && !base) {
    return { ...build(db, idx, { role: "event", heading: "予定の場所", origin: "この予定には場所・案件・お客様の登録がありません", text: "", record }), warnings: ["場所が登録されていません (関係のない住所は表示しません)。"] };
  }
  const place = build(db, idx, { role: "event", heading: "予定の場所", origin: "この予定だけの場所 (予定に入力した場所)", text, record });
  if (base && base.addressText) {
    place.customerAddress = base.addressText;
    if (!samePlace(place, base)) {
      place.warnings.push(`${base.heading} (${base.addressText}) と違う場所です。お客様の住所を変えても、この予定の場所は変わりません。`);
      if (!place.documents.length && base.documents.length) place.missingNote = `この予定の場所の住宅地図はありません。${base.heading}の住宅地図は別の場所のため表示していません。`;
      place.suggestions.push({ kind: "follow_case", eventId: e.id, address: base.addressText });
    }
  }
  return place;
}

/** 画面の記録から場所を決める */
export function placeOf(db: Database, type: MapRefType, id: string, idx = mapIndex(db)): ResolvedPlace | undefined {
  switch (type) {
    case "customer": {
      const c = db.customers.find((x) => x.id === id);
      return c ? placeOfCustomer(db, c, idx) : undefined;
    }
    case "quote": {
      const q = db.quotes.find((x) => x.id === id);
      return q ? placeOfQuote(db, q, idx) : undefined;
    }
    case "order": {
      const o = db.orders.find((x) => x.id === id);
      return o ? placeOfOrder(db, o, idx) : undefined;
    }
    case "event": {
      const e = db.schedule.find((x) => x.id === id);
      return e ? placeOfEvent(db, e, idx) : undefined;
    }
  }
  return undefined;
}

/* ---------------- 場所を参照する記録 ---------------- */

export interface LocationReference {
  type: MapRefType;
  id: string;
  storeId: StoreId;
  label: string;
  href: string;
  /** 予定の担当者 (予定のみ) */
  assigneeIds?: string[];
  date?: string;
}

/**
 * 場所を参照している記録 (顧客・見積・受注・予定)。住所のキーが同じ記録と、結び付けた記録。
 * 予定は今日の 30 日前以降で、案件・お客様の場所に合わせている予定と、この場所を指定した予定
 */
export function locationReferences(db: Database, loc: MapLocation, opts: { today?: string } = {}, idx = mapIndex(db)): LocationReference[] {
  const out: LocationReference[] = [];
  const keyMatch = (text: string | undefined, type: MapRefType, id: string) => {
    if (!text?.trim()) return false;
    const found = findLocation(idx, type, id, text, normalizeAddress(text));
    return found?.id === loc.id;
  };
  for (const c of db.customers) if (keyMatch(c.address, "customer", c.id)) out.push({ type: "customer", id: c.id, storeId: c.storeId, label: `顧客 ${c.code} ${c.name}`, href: `/customers/${c.id}` });
  for (const q of db.quotes) if (q.siteAddress && keyMatch(q.siteAddress, "quote", q.id)) out.push({ type: "quote", id: q.id, storeId: q.storeId, label: `見積 ${q.number} ${q.title}`, href: `/quotes/${q.id}` });
  for (const o of db.orders) if (o.siteAddress && keyMatch(o.siteAddress, "order", o.id)) out.push({ type: "order", id: o.id, storeId: o.storeId, label: `受注 ${o.number} ${o.title}`, href: `/orders/${o.id}` });
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const from = new Date(Date.parse(today) - 30 * 86400000).toISOString().slice(0, 10);
  const customers = new Set(out.filter((r) => r.type === "customer").map((r) => r.id));
  const orders = new Set(out.filter((r) => r.type === "order").map((r) => r.id));
  const quotes = new Set(out.filter((r) => r.type === "quote").map((r) => r.id));
  for (const e of db.schedule) {
    if (e.date < from) continue;
    const related = (e.customerId && customers.has(e.customerId)) || (e.orderId && orders.has(e.orderId)) || (e.quoteId && quotes.has(e.quoteId)) || idx.refs.get(`event:${e.id}`)?.locationId === loc.id || Boolean(e.location && keyMatch(e.location, "event", e.id));
    if (!related) continue;
    const p = placeOfEvent(db, e, idx);
    if (p.location?.id !== loc.id) continue;
    out.push({ type: "event", id: e.id, storeId: e.storeId, label: `予定 ${e.date} ${e.title}`, href: `/schedule/${e.id}`, assigneeIds: e.assigneeIds, date: e.date });
  }
  return out;
}
