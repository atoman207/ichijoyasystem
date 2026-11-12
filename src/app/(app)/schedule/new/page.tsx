import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { CalendarPlus } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import type { ScheduleKind, StoreId } from "@/lib/db/types";
import { canAccessStore, canManageCompanyEvents, canSeeAllStores } from "@/lib/auth/permissions";
import { createCaseResolver, type CaseRef } from "@/lib/db/schedule";
import { createScheduleEvent } from "@/lib/actions/schedule";
import { fromMinutes, isDateKey, normTime, toMinutes } from "@/lib/calendar";
import { toDateKey } from "@/lib/format";
import { SCHEDULE_KIND, SCHEDULE_KINDS } from "@/lib/constants";
import { Flash, PageHeader } from "@/components/ui";
import { EventForm } from "@/components/schedule/EventForm";
import { formCases, formCustomers, formStores, formUsers, toFormCase } from "@/components/schedule/form-data";

export const metadata: Metadata = { title: "予定を追加" };

type SP = Record<string, string | undefined>;

function safePath(p?: string): string | undefined {
  return p && p.startsWith("/") && !p.startsWith("//") && !p.includes("\\") ? p : undefined;
}

export default async function NewEventPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const today = toDateKey(new Date());
  const returnTo = safePath(sp.returnTo);

  // 案件の画面から: 案件 (受注 / 見積 / 問い合わせ) に紐づけて登録する
  const resolver = createCaseResolver(db);
  let fixed: CaseRef | undefined;
  if (sp.orderId || sp.quoteId || sp.inquiryId) {
    fixed = sp.orderId ? resolver.resolve("order", sp.orderId) : sp.quoteId ? resolver.resolve("quote", sp.quoteId) : resolver.resolve("inquiry", sp.inquiryId!);
    if (!fixed) redirect(`/schedule?err=${encodeURIComponent("案件が見つかりません。")}`);
    if (!canAccessStore(user, fixed.storeId)) redirect(`/schedule?err=${encodeURIComponent("この案件の店舗の予定を登録する権限がありません。")}`);
  }

  const kind: ScheduleKind = SCHEDULE_KINDS.includes(sp.kind as ScheduleKind) ? (sp.kind as ScheduleKind) : fixed ? (fixed.type === "inquiry" ? "survey" : "visit") : "meeting";
  const date = isDateKey(sp.date) ? sp.date : today;
  const minutes = SCHEDULE_KIND[kind].minutes;
  const start = normTime(sp.start) ?? (minutes === 0 ? "" : "10:00");
  const requested = (sp.user ?? "").split(",").filter((id) => db.users.some((u) => u.id === id && u.active));
  const assigneeIds = requested.length ? requested : fixed?.assigneeIds.length ? fixed.assigneeIds : kind === "leave" || minutes === 0 ? [] : [user.id];
  const storeId: StoreId = fixed?.storeId ?? (sp.store && db.stores.some((s) => s.id === sp.store) && canAccessStore(user, sp.store as StoreId) ? (sp.store as StoreId) : user.storeId);
  const customer = sp.customerId ? db.customers.find((c) => c.id === sp.customerId && canAccessStore(user, c.storeId)) : undefined;

  const query = new URLSearchParams(Object.entries(sp).filter(([k, v]) => v && k !== "err" && k !== "msg") as [string, string][]);
  const back = `/schedule/new${query.size ? `?${query.toString()}` : ""}`;
  const fixedCase = fixed ? toFormCase(db, fixed) : undefined;

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader
        title="予定を追加"
        icon={<CalendarPlus />}
        description={fixed ? `${fixed.stage} ${fixed.number} の予定として登録します` : undefined}
        back={{ href: returnTo ?? "/schedule", label: returnTo?.startsWith("/schedule") || !returnTo ? "予定表" : "元の画面" }}
      />
      <EventForm
        mode="create"
        action={createScheduleEvent}
        initial={{
          title: "",
          kind,
          date,
          endDate: "",
          allDay: !start,
          slot: "",
          startTime: start,
          endTime: start ? fromMinutes(toMinutes(start) + (minutes || 60)) : "",
          storeId,
          companyWide: false,
          assigneeIds,
          caseValue: fixedCase?.value ?? "",
          customerId: fixed?.customerId ?? customer?.id ?? "",
          location: fixed?.location ?? customer?.address ?? "",
          memo: "",
        }}
        users={formUsers(db)}
        stores={formStores(db)}
        cases={fixed ? [] : formCases(db, user)}
        customers={fixed ? [] : formCustomers(db, user)}
        fixedCase={fixedCase}
        storeLocked={!canSeeAllStores(user)}
        canCompanyWide={canManageCompanyEvents(user)}
        currentUserId={user.id}
        back={back}
        returnTo={returnTo}
        cancelHref={returnTo ?? "/schedule"}
      />
    </div>
  );
}
