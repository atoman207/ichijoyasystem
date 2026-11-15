import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canAccessStore } from "@/lib/auth/permissions";
import { createSurvey } from "@/lib/actions/kpi";
import { kpiSettings } from "@/lib/kpi-settings";
import { recentOrderOptions, staffOptions } from "@/lib/kpi-options";
import { SurveyForm } from "@/components/kpi/SurveyForm";
import { Card, Flash, Note, PageHeader } from "@/components/ui";

export default async function NewSurveyPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const order = sp.orderId ? db.orders.find((o) => o.id === sp.orderId && canAccessStore(user, o.storeId)) : undefined;
  const storeId = order?.storeId ?? user.storeId;
  return (
    <div className="max-w-5xl">
      <Flash err={sp.err} />
      <PageHeader title="アンケートを手入力で登録" back={{ href: order ? `/orders/${order.id}` : "/kpi/surveys", label: order ? "案件に戻る" : "アンケート一覧" }} />
      <Note tone="accent">はがきの写真があるときは「書類取込」で撮影すると AI が読み取ります。はがき No. が同じ店舗で 1 年以内に登録済みのときは、二重に集計しないよう登録できません。</Note>
      <Card className="mt-4">
        <SurveyForm
          action={createSurvey}
          orderRef={order?.number}
          orderOptions={recentOrderOptions(db, user)}
          users={staffOptions(db, storeId)}
          stores={db.stores.filter((s) => canAccessStore(user, s.id))}
          defaults={{ storeId, clerkUserId: kpiSettings(db).clerkByStore[storeId], salesUserId: order?.createdBy, deliveryUserIds: order?.workerIds }}
          cancelHref={order ? `/orders/${order.id}` : "/kpi/surveys"}
          submitLabel="登録する"
        />
      </Card>
    </div>
  );
}
