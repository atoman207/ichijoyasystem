import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Pencil } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canEditEvent, canManageCompanyEvents, canSeeAllStores } from "@/lib/auth/permissions";
import { caseValue, createCaseResolver, orderEditable } from "@/lib/db/schedule";
import { updateScheduleEvent } from "@/lib/actions/schedule";
import { Flash, PageHeader } from "@/components/ui";
import { EventForm } from "@/components/schedule/EventForm";
import { formCases, formCustomers, formStores, formUsers, toFormCase } from "@/components/schedule/form-data";

export const metadata: Metadata = { title: "予定を変更" };

export default async function EditEventPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string; err?: string }> }) {
  const { id } = await params;
  const { msg, err } = await searchParams;
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

  return (
    <div>
      <Flash msg={msg} err={err} />
      <PageHeader title="予定を変更" icon={<Pencil />} description={e.title} back={{ href: `/schedule/${id}`, label: "予定の詳細" }} />
      <EventForm
        mode="edit"
        action={updateScheduleEvent.bind(null, id)}
        eventId={id}
        initial={{
          title: e.title,
          kind: e.kind,
          date: e.date,
          endDate: e.endDate ?? "",
          allDay: !e.startTime && !e.slot,
          slot: e.startTime ? "" : (e.slot ?? ""),
          startTime: e.startTime ?? "",
          endTime: e.endTime ?? "",
          storeId: e.storeId,
          companyWide: Boolean(e.companyWide),
          assigneeIds: e.assigneeIds,
          caseValue: ref ? caseValue(ref) : "",
          customerId: e.customerId ?? "",
          location: e.location ?? "",
          memo: e.memo ?? "",
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
      />
    </div>
  );
}
