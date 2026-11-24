"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, getDb, mutate, nowIso } from "@/lib/db/store";
import type { MapLocation, MapRefType } from "@/lib/db/types";
import { canManageMaps, canRemoveMapDocument } from "@/lib/auth/permissions";
import { removeObjects } from "@/lib/storage";
import { purgeMapRender } from "@/lib/maps/render";
import { syncOrderEvent } from "@/lib/db/schedule";
import { canEditRecordMap, canViewLocation, canViewMapDocument } from "@/lib/maps/access";
import { fmtCoord, inJapan, parseCoordinates, validPlaceId } from "@/lib/maps/google";
import { geocode, requestResidentialMap } from "@/lib/maps/providers";
import { basePlaceOfEvent, mapIndex, placeOf, touchMapIndex } from "@/lib/maps/resolve";
import { docLabel, ensureLocation, linkDocument, mapTablesMissing, propagateOrderSite, setRef, unlinkDocument } from "@/lib/maps/store";
import { fail, requireActionUser, safeReturn, str, withMsg } from "./guards";
import { isMapUsePurpose } from "@/lib/maps/purpose";

/**
 * 地図・住宅地図の操作 (場所の位置の修正・PDF の結び付けと取り消し・予定の場所の指定・重複した場所のまとめ)
 * 順序は requireActionUser → 権限 → mutate → addAudit → revalidatePath → redirect
 */

const REF_TYPES: MapRefType[] = ["customer", "quote", "order", "event"];

async function guardTables(back: string) {
  const missing = await mapTablesMissing();
  if (missing) fail(back, missing);
}

function locationOrFail(id: string, back: string): MapLocation {
  const loc = getDb().mapLocations.find((l) => l.id === id);
  if (!loc) fail(back, "場所が見つかりません。");
  return loc;
}

/** 記録の場所を登録して、場所の画面 (位置の修正・住宅地図) を開く */
export async function openPlace(type: string, id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), "/");
  if (!REF_TYPES.includes(type as MapRefType)) fail(back, "記録の種類が正しくありません。");
  if (!canEditRecordMap(user, getDb(), type as MapRefType, id)) fail(back, "この記録の地図を扱う権限がありません。");
  await guardTables(back);
  let locId = "";
  let created = false;
  await mutate((db) => {
    const place = placeOf(db, type as MapRefType, id);
    if (!place) fail(back, "記録が見つかりません。");
    if (!place.addressText) fail(back, "住所が登録されていないため、場所を登録できません。先に住所を入力してください。");
    const r = ensureLocation(db, user, place);
    locId = r.location.id;
    created = r.created;
    if (created) addAudit(db, { userId: user.id, action: "create", entity: "map_location", entityId: r.location.id, entityLabel: r.location.address, summary: `場所を登録 (${place.record.label} の${place.heading})`, storeId: place.record.storeId });
  });
  redirect(withMsg(`/maps/locations/${locId}?returnTo=${encodeURIComponent(back)}`, created ? "場所を登録しました。位置の確認・住宅地図の登録ができます。" : "登録済みの場所を開きました。"));
}

/** 位置 (緯度経度・Google の場所 ID)・現地のメモの修正。手で合わせた位置は「確認済み」にできる */
export async function updateLocationPosition(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/maps/locations/${id}`;
  const loc0 = locationOrFail(id, back);
  if (!canViewLocation(user, getDb(), loc0)) fail(back, "この場所を変更する権限がありません。");
  await guardTables(back);
  const clear = str(formData, "clearCoords") === "1";
  const raw = str(formData, "coords");
  const coords = raw ? parseCoordinates(raw) : null;
  if (raw && !coords && !clear) fail(back, "緯度・経度を読み取れません。「32.8031, 130.7079」の形か、Google マップで場所を開いたときの URL を貼り付けてください。");
  if (coords && !inJapan(coords.lat, coords.lng)) fail(back, `日本の範囲外の位置です (${coords.lat}, ${coords.lng})。緯度と経度が逆になっていないか確かめてください。`);
  const placeId = str(formData, "placeId");
  if (placeId && !validPlaceId(placeId)) fail(back, "Google の場所 ID の形が正しくありません (英数字の ID。例: ChIJ…)。");
  const verify = str(formData, "verified") === "1";
  let changed = 0;
  await mutate((db) => {
    const loc = db.mapLocations.find((l) => l.id === id);
    if (!loc) fail(back, "場所が見つかりません。");
    const before = { lat: loc.lat, lng: loc.lng, placeId: loc.placeId, coordStatus: loc.coordStatus, coordSource: loc.coordSource, note: loc.note };
    if (clear) {
      loc.lat = undefined;
      loc.lng = undefined;
      loc.coordStatus = undefined;
      loc.coordSource = undefined;
      loc.coordVerifiedBy = undefined;
      loc.coordVerifiedAt = undefined;
      loc.geocodeNote = undefined;
    } else if (coords) {
      const moved = loc.lat !== coords.lat || loc.lng !== coords.lng;
      loc.lat = Number(fmtCoord(coords.lat));
      loc.lng = Number(fmtCoord(coords.lng));
      if (moved) {
        loc.coordSource = "manual";
        loc.geocodeNote = undefined;
      }
    }
    if (formData.has("placeId")) loc.placeId = placeId || undefined;
    if (formData.has("note")) loc.note = str(formData, "note").slice(0, 500) || undefined;
    if (!clear && loc.lat != null) {
      if (verify) {
        loc.coordStatus = "verified";
        loc.coordVerifiedBy = user.id;
        loc.coordVerifiedAt = nowIso();
      } else if (loc.coordStatus === "verified" && (before.lat !== loc.lat || before.lng !== loc.lng)) {
        loc.coordStatus = "unverified";
        loc.coordVerifiedBy = undefined;
        loc.coordVerifiedAt = undefined;
      } else if (!loc.coordStatus) loc.coordStatus = "unverified";
    }
    const after = { lat: loc.lat, lng: loc.lng, placeId: loc.placeId, coordStatus: loc.coordStatus, coordSource: loc.coordSource, note: loc.note };
    const changes = (Object.keys(before) as (keyof typeof before)[]).filter((k) => before[k] !== after[k]).map((k) => ({ field: k, before: before[k], after: after[k] }));
    changed = changes.length;
    if (!changed) return;
    loc.updatedBy = user.id;
    loc.updatedAt = nowIso();
    touchMapIndex();
    addAudit(db, { userId: user.id, action: "update", entity: "map_location", entityId: loc.id, entityLabel: loc.address, summary: clear ? "位置 (緯度経度) を消去" : `位置・メモを修正${loc.coordStatus === "verified" ? " (確認済み)" : ""}`, storeId: loc.storeId, changes });
  });
  revalidatePath("/", "layout");
  redirect(withMsg(back, changed ? "場所を更新しました。この場所を使うすべての顧客・案件・予定に反映されます。" : "変更はありませんでした。"));
}

/** 住所から位置を求める (Google Geocoding。設定があるときだけ)。結果は「未確認」か「要確認」 */
export async function geocodeLocation(id: string) {
  const user = await requireActionUser();
  const back = `/maps/locations/${id}`;
  const loc0 = locationOrFail(id, back);
  if (!canViewLocation(user, getDb(), loc0)) fail(back, "この場所を変更する権限がありません。");
  await guardTables(back);
  if (loc0.coordStatus === "verified") fail(back, "位置は確認済みです。変えるときは位置を手で入力してください。");
  const r = await geocode(loc0.address);
  if (!r.ok) fail(back, r.error);
  await mutate((db) => {
    const loc = db.mapLocations.find((l) => l.id === id);
    if (!loc) return;
    const before = { lat: loc.lat, lng: loc.lng, placeId: loc.placeId };
    loc.lat = r.best.lat;
    loc.lng = r.best.lng;
    loc.placeId = r.best.placeId ?? loc.placeId;
    loc.coordSource = "geocode";
    loc.coordStatus = r.status;
    loc.geocodeNote = r.note.slice(0, 300);
    loc.updatedBy = user.id;
    loc.updatedAt = nowIso();
    touchMapIndex();
    addAudit(db, { userId: user.id, action: "update", entity: "map_location", entityId: loc.id, entityLabel: loc.address, summary: `住所から位置を求めた (${r.status === "needs_review" ? "要確認" : "未確認"})`, storeId: loc.storeId, changes: [{ field: "lat", before: before.lat, after: loc.lat }, { field: "lng", before: before.lng, after: loc.lng }, { field: "placeId", before: before.placeId, after: loc.placeId }] });
  });
  redirect(withMsg(back, `位置を求めました (${r.note})。地図で確かめて、正しければ「この位置で確定」を押してください。`));
}

/** 住宅地図の PDF をこの場所から外す (ほかの場所でも使っている PDF のときだけ。最後の 1 か所なら「取り消し」を使う) */
export async function unlinkMapDocument(documentId: string, locationId: string, formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), `/maps/locations/${locationId}`);
  const db0 = getDb();
  const loc0 = locationOrFail(locationId, back);
  if (!canViewLocation(user, db0, loc0)) fail(back, "この場所を変更する権限がありません。");
  await guardTables(back);
  let label = "";
  await mutate((db) => {
    const doc = db.mapDocuments.find((d) => d.id === documentId);
    if (!doc) fail(back, "住宅地図が見つかりません。");
    const locs = mapIndex(db).locationsByDoc.get(doc.id) ?? [];
    if (!locs.includes(locationId)) fail(back, "この住宅地図はこの場所に結び付いていません。");
    if (locs.length <= 1) fail(back, "この住宅地図を使っているのはこの場所だけです。不要なら「取り消す」を使ってください (履歴は残ります)。");
    unlinkDocument(db, doc.id, locationId);
    label = docLabel(doc);
    const loc = db.mapLocations.find((l) => l.id === locationId)!;
    addAudit(db, { userId: user.id, action: "delete", entity: "map_location", entityId: loc.id, entityLabel: loc.address, summary: `住宅地図「${label}」をこの場所から外した (ほかの ${locs.length - 1} か所では引き続き使用)`, storeId: loc.storeId, changes: [{ field: "document", before: label, after: null }] });
  });
  revalidatePath("/", "layout");
  redirect(withMsg(back, `「${label}」をこの場所から外しました。ほかの場所では引き続き使えます。`));
}

/** 住宅地図の PDF の取り消し (台帳と変更履歴は残し、ファイルの本体を消す)。ほかの場所でも使っている PDF は取り消せない */
export async function removeMapDocument(documentId: string, formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), "/");
  const reason = str(formData, "reason").slice(0, 200);
  if (!reason) fail(back, "取り消しの理由を入力してください (例: 契約の期限切れ・別の場所の地図だった)。");
  await guardTables(back);
  let key: string | undefined;
  let label = "";
  await mutate((db) => {
    const doc = db.mapDocuments.find((d) => d.id === documentId);
    if (!doc) fail(back, "住宅地図が見つかりません。");
    if (!canViewMapDocument(user, db, doc)) fail(back, "この住宅地図を扱う権限がありません。");
    if (!canRemoveMapDocument(user, doc)) fail(back, "住宅地図を取り消せるのは、登録した本人・その店舗の店長・管理者です。");
    if (doc.status === "removed") fail(back, "すでに取り消されています。");
    const idx = mapIndex(db);
    const locs = idx.locationsByDoc.get(doc.id) ?? [];
    if (doc.status === "active" && locs.length > 1) {
      fail(back, `この住宅地図は ${locs.length} か所で使われています。ほかの記録の地図が消えないよう、先に不要な場所から「この場所から外す」で外してください。`);
    }
    key = doc.storageKey;
    label = docLabel(doc);
    const prevStatus = doc.status;
    doc.status = "removed";
    doc.storageKey = undefined;
    doc.removedBy = user.id;
    doc.removedAt = nowIso();
    doc.removeReason = reason;
    doc.updatedAt = nowIso();
    touchMapIndex();
    addAudit(db, { userId: user.id, action: "delete", entity: "map_document", entityId: doc.id, entityLabel: label, summary: `住宅地図を取り消し (理由: ${reason}${prevStatus === "replaced" ? " / 差し替え前の版" : ""})`, storeId: doc.storeId, changes: [{ field: "status", before: prevStatus, after: "removed" }] });
  });
  if (key) await removeObjects([key]).catch((err) => console.warn("[maps] file cleanup failed:", (err as Error).message));
  // 画面に出すために作った画像の控えも消す (src/lib/maps/render.ts)
  await purgeMapRender(documentId);
  revalidatePath("/", "layout");
  redirect(withMsg(back, `「${label}」を取り消しました。台帳と変更履歴は残っています。`));
}

/** 登録済みの住宅地図 (共用してよいもの) をこの場所にも結び付ける */
export async function linkSharedMapDocument(locationId: string, formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), `/maps/locations/${locationId}`);
  const loc0 = locationOrFail(locationId, back);
  if (!canViewLocation(user, getDb(), loc0)) fail(back, "この場所を変更する権限がありません。");
  await guardTables(back);
  const documentId = str(formData, "documentId");
  let label = "";
  await mutate((db) => {
    const doc = db.mapDocuments.find((d) => d.id === documentId);
    if (!doc || doc.status !== "active") fail(back, "住宅地図が見つかりません。");
    if (!canViewMapDocument(user, db, doc)) fail(back, "この住宅地図を扱う権限がありません。");
    if (!doc.shareable) fail(back, "この住宅地図は「共用しない」の設定です。契約上ほかの場所でも使ってよい地図なら、先に PDF の設定を「複数の場所で共用」にしてください。");
    if (!linkDocument(db, user, doc.id, locationId)) fail(back, "この住宅地図はすでにこの場所に結び付いています。");
    label = docLabel(doc);
    const loc = db.mapLocations.find((l) => l.id === locationId)!;
    addAudit(db, { userId: user.id, action: "create", entity: "map_location", entityId: loc.id, entityLabel: loc.address, summary: `登録済みの住宅地図「${label}」を結び付け (共用)`, storeId: loc.storeId, changes: [{ field: "document", before: null, after: label }] });
  });
  revalidatePath("/", "layout");
  redirect(withMsg(back, `「${label}」をこの場所にも結び付けました (ファイルは 1 つのまま共用します)。`));
}

/** 住宅地図の情報 (表示名・版・著作権表示・許諾・共用) の修正 */
export async function updateMapDocumentInfo(documentId: string, formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), "/");
  await guardTables(back);
  await mutate((db) => {
    const doc = db.mapDocuments.find((d) => d.id === documentId);
    if (!doc) fail(back, "住宅地図が見つかりません。");
    if (!canViewMapDocument(user, db, doc)) fail(back, "この住宅地図を扱う権限がありません。");
    const before = { title: doc.title, edition: doc.edition, copyrightNotice: doc.copyrightNotice, licenseRef: doc.licenseRef, licenseNote: doc.licenseNote, shareable: doc.shareable, usePurpose: doc.usePurpose, nameplate: doc.nameplate };
    const shareable = str(formData, "shareable") === "1" || undefined;
    if (!shareable && (mapIndex(db).locationsByDoc.get(doc.id) ?? []).length > 1) fail(back, "この住宅地図は複数の場所で使われているため「共用しない」にできません。先にほかの場所から外してください。");
    const copyright = str(formData, "copyrightNotice").slice(0, 200);
    if (doc.provider === "zenrin" && !copyright) fail(back, "ゼンリンの地図の著作権表示は消せません。");
    doc.title = str(formData, "title").slice(0, 120) || doc.title;
    doc.edition = str(formData, "edition").slice(0, 60) || undefined;
    doc.copyrightNotice = copyright;
    doc.licenseRef = str(formData, "licenseRef").slice(0, 100) || undefined;
    doc.licenseNote = str(formData, "licenseNote").slice(0, 500) || undefined;
    doc.shareable = shareable;
    if (formData.has("usePurpose")) {
      const purpose = str(formData, "usePurpose");
      doc.usePurpose = isMapUsePurpose(purpose) ? purpose : undefined;
      doc.nameplate = str(formData, "nameplate") === "1" || undefined;
    }
    const after = { title: doc.title, edition: doc.edition, copyrightNotice: doc.copyrightNotice, licenseRef: doc.licenseRef, licenseNote: doc.licenseNote, shareable: doc.shareable, usePurpose: doc.usePurpose, nameplate: doc.nameplate };
    const changes = (Object.keys(before) as (keyof typeof before)[]).filter((k) => before[k] !== after[k]).map((k) => ({ field: k, before: before[k], after: after[k] }));
    if (!changes.length) fail(back, "変更はありませんでした。");
    doc.updatedAt = nowIso();
    touchMapIndex();
    addAudit(db, { userId: user.id, action: "update", entity: "map_document", entityId: doc.id, entityLabel: docLabel(doc), summary: "住宅地図の情報を修正", storeId: doc.storeId, changes });
  });
  revalidatePath("/", "layout");
  redirect(withMsg(back, "住宅地図の情報を修正しました。"));
}

/** 予定の場所を「案件・お客様の場所に合わせる」にする (この予定だけの場所をやめる) */
export async function followCaseLocation(eventId: string, formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), `/schedule/${eventId}`);
  if (!canEditRecordMap(user, getDb(), "event", eventId)) fail(back, "この予定を変更する権限がありません。");
  await guardTables(back);
  let address = "";
  await mutate((db) => {
    const e = db.schedule.find((x) => x.id === eventId);
    if (!e) fail(back, "予定が見つかりません。");
    const base = basePlaceOfEvent(db, e);
    if (!base?.addressText) fail(back, "この予定には案件・お客様の住所がありません。");
    const prev = e.location;
    e.location = base.addressText.slice(0, 200);
    e.updatedBy = user.id;
    e.updatedAt = nowIso();
    address = e.location;
    setRef(db, user, { recordType: "event", recordId: e.id, mode: "follow" });
    addAudit(db, { userId: user.id, action: "update", entity: "schedule", entityId: e.id, entityLabel: e.title, summary: "場所を「案件・お客様の場所に合わせる」に変更", storeId: e.storeId, changes: [{ field: "location", before: prev, after: e.location }] });
  });
  revalidatePath("/schedule");
  redirect(withMsg(back, `場所を ${address} にしました。これからは案件・お客様の住所が変わると、この予定の場所も変わります。`));
}

/** 受注の施工場所をお客様の住所にする (施工場所が地区名だけで、お客様の住所と同じ地区のとき。人が押したときだけ) */
export async function applyCustomerAddressToSite(orderId: string, formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), `/orders/${orderId}`);
  if (!canEditRecordMap(user, getDb(), "order", orderId)) fail(back, "この案件を変更する権限がありません。");
  let n = 0;
  await mutate((db) => {
    const o = db.orders.find((x) => x.id === orderId);
    if (!o) fail(back, "受注が見つかりません。");
    const c = db.customers.find((x) => x.id === o.customerId);
    if (!c?.address) fail(back, "お客様の住所が登録されていません。");
    const prev = o.siteAddress;
    o.siteAddress = c.address;
    o.updatedAt = nowIso();
    o.progressNotes.push({ id: `pn_${Date.now()}`, at: nowIso(), userId: user.id, kind: "change", body: `施工場所をお客様の住所に変更: ${prev || "(なし)"} → ${c.address}` });
    if (db.schedule.some((e) => e.orderId === o.id && e.source === "order")) syncOrderEvent(db, o, user.id);
    addAudit(db, { userId: user.id, action: "update", entity: "order", entityId: o.id, entityLabel: o.number, summary: "施工場所をお客様の住所に変更", storeId: o.storeId, changes: [{ field: "siteAddress", before: prev, after: o.siteAddress }] });
    n = propagateOrderSite(db, user, o, prev);
  });
  revalidatePath("/", "layout");
  redirect(withMsg(back, `施工場所をお客様の住所にしました。${n ? `今後の予定 ${n} 件の場所も合わせました。` : ""}`));
}

/** 記録を登録済みの場所に結び付ける (番地のない住所の記録を、確かめた場所に結び付けるとき) */
export async function linkRecordToLocation(type: string, id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), "/");
  if (!REF_TYPES.includes(type as MapRefType)) fail(back, "記録の種類が正しくありません。");
  if (!canEditRecordMap(user, getDb(), type as MapRefType, id)) fail(back, "この記録の地図を扱う権限がありません。");
  await guardTables(back);
  const locationId = str(formData, "locationId");
  await mutate((db) => {
    const loc = db.mapLocations.find((l) => l.id === locationId && l.status === "active");
    if (!loc) fail(back, "場所が見つかりません。");
    if (!canViewLocation(user, db, loc)) fail(back, "この場所を扱う権限がありません。");
    const place = placeOf(db, type as MapRefType, id);
    if (!place?.addressText) fail(back, "記録の住所がありません。");
    setRef(db, user, { recordType: type as MapRefType, recordId: id, mode: type === "event" ? "custom" : "manual", locationId: loc.id, addressSnapshot: place.addressText });
    addAudit(db, { userId: user.id, action: "update", entity: "map_location", entityId: loc.id, entityLabel: loc.address, summary: `${place.record.label} (住所「${place.addressText}」) をこの場所に結び付け`, storeId: place.record.storeId, changes: [{ field: "locationId", before: place.location?.id ?? null, after: loc.id }] });
  });
  revalidatePath("/", "layout");
  redirect(withMsg(back, "場所を結び付けました。"));
}

/** 重複した場所をまとめる (結び付け・住宅地図をまとめ先へ移し、元の場所は「まとめ済み」として残す。データは消さない) */
export async function mergeLocations(sourceId: string, formData: FormData) {
  const user = await requireActionUser();
  const back = safeReturn(str(formData, "returnTo"), `/maps/locations/${sourceId}`);
  if (!canManageMaps(user)) fail(back, "場所のまとめは本部スタッフ・管理者が行います。");
  await guardTables(back);
  const targetId = str(formData, "targetId");
  if (!targetId || targetId === sourceId) fail(back, "まとめ先の場所を選んでください。");
  let moved = 0;
  await mutate((db) => {
    const src = db.mapLocations.find((l) => l.id === sourceId);
    const dst = db.mapLocations.find((l) => l.id === targetId);
    if (!src || !dst || src.status !== "active" || dst.status !== "active") fail(back, "場所が見つからないか、すでにまとめられています。");
    for (const link of db.mapDocumentLinks.filter((l) => l.locationId === src.id)) {
      if (linkDocument(db, user, link.documentId, dst.id)) moved++;
    }
    db.mapDocumentLinks = db.mapDocumentLinks.filter((l) => l.locationId !== src.id);
    for (const r of db.mapLocationRefs) if (r.locationId === src.id) r.locationId = dst.id;
    if (dst.lat == null && src.lat != null) Object.assign(dst, { lat: src.lat, lng: src.lng, coordSource: src.coordSource, coordStatus: src.coordStatus, coordVerifiedBy: src.coordVerifiedBy, coordVerifiedAt: src.coordVerifiedAt });
    if (!dst.placeId && src.placeId) dst.placeId = src.placeId;
    if (src.note && !dst.note?.includes(src.note)) dst.note = [dst.note, src.note].filter(Boolean).join(" / ").slice(0, 500);
    src.status = "merged";
    src.mergedInto = dst.id;
    src.updatedBy = dst.updatedBy = user.id;
    src.updatedAt = dst.updatedAt = nowIso();
    touchMapIndex();
    addAudit(db, { userId: user.id, action: "update", entity: "map_location", entityId: src.id, entityLabel: src.address, summary: `重複した場所を「${dst.address}」にまとめた (住宅地図 ${moved} 件を移動)`, storeId: src.storeId, changes: [{ field: "mergedInto", before: null, after: dst.id }] });
  });
  revalidatePath("/", "layout");
  redirect(withMsg(`/maps/locations/${targetId}`, `場所をまとめました (住宅地図 ${moved} 件を移しました)。元の場所の記録は「まとめ済み」として残っています。`));
}

/** 住宅地図の自動取得 (ゼンリン)。公式 API と許諾の確認がとれるまでは使えないことを伝える (取得できたように見せない) */
export async function requestProviderMap(locationId: string) {
  const user = await requireActionUser();
  const back = `/maps/locations/${locationId}`;
  const loc = locationOrFail(locationId, back);
  if (!canViewLocation(user, getDb(), loc)) fail(back, "この場所を扱う権限がありません。");
  const r = await requestResidentialMap(loc);
  if (!r.ok) fail(back, r.error);
  // 公式のアダプターができたら、ここで registerMapDocument (source: "provider_api") を呼ぶ
  fail(back, "住宅地図の自動取得の登録処理は、公式 API の接続後に有効にします。");
}
