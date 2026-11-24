import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { syncDb } from "@/lib/db/store";
import { canAccessStore, canEditCaseStore, canEditEvent, canReadStoreRecords, canViewCompanySchedule } from "@/lib/auth/permissions";
import { policyReader } from "@/lib/access-policy";
import { caseValue, createCaseResolver, orderEditable } from "@/lib/db/schedule";
import { parseHandoverRef } from "@/lib/handover";
import { periodLabel } from "@/lib/calendar";
import { eventLabeler } from "@/lib/schedule-label";
import { isPlaceholderCustomer } from "@/lib/customer-link";
import { scheduleWork } from "@/lib/schedule-work";
import { workDescription } from "@/lib/work-summary";
import type { EventQuickData, QuickMap, QuickPair, QuickStaff } from "@/components/schedule/quick-types";
import type { Database, ScheduleEvent, StoreId, User } from "@/lib/db/types";
import { canEditRecordMap, canViewRecordMap } from "@/lib/maps/access";
import { mapIndex, placeOf } from "@/lib/maps/resolve";
import { ZENRIN_GIS } from "@/lib/maps/purpose";
import { isCommonStaff } from "@/lib/staff-choices";
import { initialsByUser } from "@/lib/schedule-sheet/initials";
import { eventPair } from "@/lib/schedule-pair";
import { handoverLabel } from "@/lib/handover";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };

/**
 * 予定表で予定を押したときの小さな画面 (EventQuickDialog) の中身 (お客様のご要望 2026-11-24「■3」「■4」)
 * お客様は案件 (受注 → 見積 → 問い合わせ) から引く (問い合わせを既存の顧客にひも付けたあとは、その顧客の情報)
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  if (!canViewCompanySchedule(user)) return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  const { id } = await params;
  const db = await syncDb();
  const e = db.schedule.find((x) => x.id === id);
  if (!e) return NextResponse.json({ error: "予定が見つかりません (削除された可能性があります)。" }, { status: 404, headers: NO_STORE });
  const resolver = createCaseResolver(db);
  const ref = resolver.ofEvent(e);
  const labeler = eventLabeler(db);
  const label = labeler.label(e);
  const customer = labeler.customerOf(e);
  const reader = policyReader(db, user);
  const canSeeCustomer = customer ? canReadStoreRecords(reader, customer.storeId) || canEditCaseStore(user, customer.storeId) : false;
  const order = e.orderId ? db.orders.find((o) => o.id === e.orderId) : undefined;
  const synced = e.source === "order";
  const handover = synced && Boolean(parseHandoverRef(e.sourceRef));
  const canEdit = canEditEvent(user, e) && (!synced || (order ? orderEditable(order) : false));
  const inq = ref?.inquiryId ? db.inquiries.find((i) => i.id === ref.inquiryId) : undefined;
  const store = db.stores.find((s) => s.id === e.storeId);
  const users = new Map(db.users.map((u) => [u.id, u.name]));
  const data: EventQuickData = {
    id: e.id,
    title: e.title,
    label: label.text,
    area: label.area,
    kind: e.kind,
    date: e.date,
    endDate: e.endDate,
    startTime: e.startTime,
    endTime: e.endTime,
    slot: e.slot,
    memo: e.memo ?? "",
    location: e.location,
    period: periodLabel(e),
    storeId: e.storeId,
    storeName: store?.name ?? e.storeId,
    assigneeIds: e.assigneeIds,
    assignees: e.assigneeIds.map((a) => users.get(a) ?? "-"),
    work: workDescription(scheduleWork(db, [e]).get(e.id)) || undefined,
    caseRef: ref ? caseValue(ref) : undefined,
    case: ref ? { label: `${ref.stage} ${ref.number}`, title: ref.title, href: ref.href, canOpen: canAccessStore(user, ref.storeId) || canEditCaseStore(user, ref.storeId) } : undefined,
    customer: customer
      ? {
          name: customer.name,
          href: canSeeCustomer ? `/customers/${customer.id}` : undefined,
          phones: canSeeCustomer ? [customer.phone, ...(customer.contacts ?? []).map((x) => x.phone)].filter((p): p is string => Boolean(p?.trim())).slice(0, 3) : [],
          address: canSeeCustomer ? customer.address || (customer.area ? `地区 ${customer.area}` : "") : "",
          corporate: customer.type === "corporate",
          placeholder: isPlaceholderCustomer(customer),
        }
      : undefined,
    contactName: inq && customer && inq.contactName !== customer.name ? inq.contactName : !customer && inq ? inq.contactName : undefined,
    contactPhone: !customer && inq ? inq.contactPhone || inq.intake?.phone : undefined,
    inquiryHref: inq && !customer ? `/inquiries/${inq.id}#link-customer` : isPlaceholderCustomer(customer) && inq ? `/inquiries/${inq.id}#link-customer` : undefined,
    synced,
    handover,
    lockKind: synced,
    canEdit,
    hold: false,
    map: quickMap(db, user, e),
    staff: quickStaff(db, e.storeId),
    pair: quickPair(db, e, canEdit, labeler, users, resolver),
  };
  return NextResponse.json(data, { headers: NO_STORE });
}

/** 地図: Google マップ・経路案内・登録済みの住宅地図 (MapInfoCard と同じ場所の決め方。src/lib/maps/resolve.ts) */
function quickMap(db: Database, user: User, e: ScheduleEvent): QuickMap | undefined {
  if (!canViewRecordMap(user, db, "event", e.id)) return { hidden: true, address: "", heading: "", docs: [], canEdit: false, zenrinUrl: ZENRIN_GIS.url };
  const place = placeOf(db, "event", e.id, mapIndex(db));
  if (!place) return undefined;
  return {
    address: place.addressText,
    heading: place.heading,
    searchUrl: place.searchUrl,
    directionsUrl: place.directionsUrl,
    docs: place.documents.map((d) => ({ id: d.id, title: d.title })),
    canEdit: canEditRecordMap(user, db, "event", e.id) && Boolean(place.addressText),
    placeHref: place.location ? `/maps/locations/${place.location.id}` : undefined,
    zenrinUrl: ZENRIN_GIS.url,
  };
}

/** 担当者の選択肢: 予定の店舗の社員 → 本部の社員 (全店舗共通) → ほかの店舗の社員 (配送・施工の応援) */
function quickStaff(db: Database, storeId: StoreId): QuickStaff[] {
  const active = db.users.filter((u) => u.active && !u.id.startsWith("u_review"));
  const initials = initialsByUser(active);
  const order = new Map(db.stores.map((s, i) => [s.id, i]));
  const group = (u: User): QuickStaff["group"] => (u.storeId === storeId ? "store" : isCommonStaff(db, u) ? "common" : "other");
  const rank = { store: 0, common: 1, other: 2 };
  return active
    .map((u) => {
      const s = db.stores.find((x) => x.id === u.storeId);
      return { id: u.id, name: u.name, initial: initials.get(u.id) ?? [...u.name][0], storeId: u.storeId, storeName: s?.shortName ?? s?.name ?? u.storeId, color: s?.color ?? "#94a3b8", group: group(u) };
    })
    .sort((a, b) => rank[a.group] - rank[b.group] || (order.get(a.storeId) ?? 99) - (order.get(b.storeId) ?? 99) || a.name.localeCompare(b.name, "ja"));
}

/** 引取・現見 ⇄ 納品 の相手 (src/lib/schedule-pair.ts) */
function quickPair(db: Database, e: ScheduleEvent, canEdit: boolean, labeler: ReturnType<typeof eventLabeler>, users: Map<string, string>, resolver: ReturnType<typeof createCaseResolver>): QuickPair | undefined {
  const info = eventPair(db, e, resolver);
  if (!info) return undefined;
  const orderOk = info.order ? orderEditable(info.order) : false;
  const rows = info.order?.handovers ?? [];
  const undated = info.undatedRows.map((id) => rows.find((r) => r.id === id)).filter((r): r is NonNullable<typeof r> => Boolean(r)).map((r) => handoverLabel(r));
  const addMode: QuickPair["addMode"] = info.order && info.undatedRows.length && orderOk ? "order" : "event";
  // 納品予定を追加できる: 引取・現見の予定で、納品の予定がないか、受注の日程に納品日の決まっていない品目がある
  const canAdd = canEdit && info.want === "delivery" && (addMode === "order" ? true : info.events.length === 0) && !(info.order && !orderOk);
  return {
    want: info.want,
    events: info.events.map((x) => ({ id: x.id, kind: x.kind, period: periodLabel(x), label: labeler.label(x).text, assignees: x.assigneeIds.map((a) => users.get(a) ?? "-") })),
    canAdd,
    addMode,
    undated,
  };
}
