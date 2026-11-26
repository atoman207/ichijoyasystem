import { currentEventMode } from "@/lib/maps/store";
import { fromMinutes, isDateKey, normTime, toMinutes } from "@/lib/calendar";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Pencil } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canEditEvent, canManageCompanyEvents, canSeeAllStores } from "@/lib/auth/permissions";
import { caseValue, createCaseResolver, orderEditable } from "@/lib/db/schedule";
import { updateScheduleEvent } from "@/lib/actions/schedule";
import { parseHandoverRef } from "@/lib/handover";
import { Flash, PageHeader } from "@/components/ui";
import { EventForm } from "@/components/schedule/EventForm";
import { formCases, formCustomers, formStores, formUsers, toFormCase } from "@/components/schedule/form-data";

export const metadata: Metadata = { title: "予定を変更" };

export default async function EditEventPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string; err?: string; date?: string; start?: string }> }) {
  const { id } = await params;
  const { msg, err, date: propDate, start: propStart } = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const e = db.schedule.find((x) => x.id === id);
  if (!e) notFound();
  if (!canEditEvent(user, e)) redirect(`/schedule/${id}?err=${encodeURIComponent("この予定を変更する権限がありません (登録者・担当者・店舗のメンバーが変更できます)。")}`);
  const synced = e.source === "order";
  const order = e.orderId ? db.orders.find((o) => o.id === e.orderId) : undefined;
  if (synced && (!order || !orderEditable(order))) redirect(`/schedule/${id}?err=${encodeURIComponent("施工完了・キャンセル済みの受注の施工予定は変更できません。")}`);

  const ref = createCaseResolver(db).ofEvent(e);
  const cases = synced ? [] : formCases(db, user);
  // 現在の案件が選択肢にない (完了済みなど) 場合も、そのまま選べるようにする
  const current = ref ? toFormCase(db, ref) : undefined;
  if (current && !synced && !cases.some((c) => c.value === current.value)) cases.unshift(current);
  const customers = formCustomers(db, user);
  const customer = e.customerId ? db.customers.find((c) => c.id === e.customerId) : undefined;
  if (customer && !customers.some((c) => c.id === customer.id)) customers.unshift({ id: customer.id, name: customer.name, storeId: customer.storeId, address: customer.address || undefined });

  // 計画の画面 (最適化・空いた枠) の提案の日時を入れて開く (保存するまで予定は変わらない)
  const proposed = isDateKey(propDate) && !synced ? propDate : undefined;
  const pStart = proposed ? normTime(propStart) : undefined;
  const span = e.startTime && e.endTime ? toMinutes(e.endTime) - toMinutes(e.startTime) : 60;
  return (
    <div>
      <Flash msg={msg ?? (proposed ? `提案の日時 (${proposed}${pStart ? ` ${pStart}` : ""}) を入れています。お客様・担当者に連絡してから保存してください。` : undefined)} err={err} />
      <PageHeader title="予定を変更" icon={<Pencil />} description={e.title} back={{ href: `/schedule/${id}`, label: "予定の詳細" }} />
      <EventForm
        mode="edit"
        action={updateScheduleEvent.bind(null, id)}
        eventId={id}
        initial={{
          title: e.title,
          kind: e.kind,
          date: proposed ?? e.date,
          endDate: proposed ? "" : (e.endDate ?? ""),
          allDay: pStart ? false : !e.startTime && !e.slot,
          slot: pStart || e.startTime ? "" : (e.slot ?? ""),
          startTime: pStart ?? e.startTime ?? "",
          endTime: pStart ? fromMinutes(toMinutes(pStart) + span) : (e.endTime ?? ""),
          storeId: e.storeId,
          companyWide: Boolean(e.companyWide),
          assigneeIds: e.assigneeIds,
          caseValue: ref ? caseValue(ref) : "",
          customerId: e.customerId ?? "",
          location: e.location ?? "",
          locationMode: currentEventMode(db, e),
          memo: e.memo ?? "",
          work: e.work ?? "",
          inspectionBy: e.inspectionBy ?? "",
        }}
        users={formUsers(db)}
        stores={formStores(db)}
        cases={cases}
        customers={customers}
        fixedCase={synced ? current : undefined}
        lockKind={synced}
        storeLocked={!canSeeAllStores(user)}
        canCompanyWide={canManageCompanyEvents(user)}
        currentUserId={user.id}
        back={`/schedule/${id}/edit`}
        returnTo={`/schedule/${id}`}
        cancelHref={`/schedule/${id}`}
        syncedOrderNumber={synced ? order?.number : undefined}
        handoverLinked={synced && Boolean(parseHandoverRef(e.sourceRef))}
      />
    </div>
  );
}
