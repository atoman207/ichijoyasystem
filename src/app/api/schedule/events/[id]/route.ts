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
import type { EventQuickData } from "@/components/schedule/quick-types";

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
  const ref = createCaseResolver(db).ofEvent(e);
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
  };
  return NextResponse.json(data, { headers: NO_STORE });
}
