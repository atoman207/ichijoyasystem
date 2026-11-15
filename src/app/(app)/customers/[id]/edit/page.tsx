import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canAccessStore, canApplyCustomerChange } from "@/lib/auth/permissions";
import { updateCustomer } from "@/lib/actions/customers";
import { approvalSettings } from "@/lib/approval-rules";
import { CustomerForm } from "@/components/features/CustomerForm";
import { Card, Flash, Note, PageHeader } from "@/components/ui";

export default async function EditCustomerPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string; err?: string }> }) {
  const { id } = await params;
  const { msg, err } = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const customer = db.customers.find((c) => c.id === id);
  if (!customer) notFound();
  if (!canAccessStore(user, customer.storeId)) redirect("/customers?err=" + encodeURIComponent("この顧客を編集する権限がありません。"));
  const needsApproval = approvalSettings(db).customerChange && !canApplyCustomerChange(user, customer.storeId);
  const pending = db.approvals.some((a) => a.type === "customer_change" && a.targetId === customer.id && a.status === "pending");
  return (
    <div className="max-w-3xl">
      <Flash msg={msg} err={err} />
      <PageHeader title={`${customer.name} の情報を編集`} back={{ href: `/customers/${id}`, label: "顧客詳細" }} />
      {pending && <Note tone="warn">重要情報の変更が承認待ちです。承認・差戻しの後に、もう一度変更してください (氏名・電話・住所などの欄は承認待ちの間は変えられません)。</Note>}
      <Card className="mt-4">
        <CustomerForm
          action={updateCustomer.bind(null, id)}
          customer={customer}
          stores={db.stores}
          users={db.users.filter((u) => u.active)}
          user={user}
          cancelHref={`/customers/${id}`}
          changeNote={needsApproval ? "氏名・フリガナ・区分・電話・メール・郵便番号・住所の変更は、店長 (承認できる店長がいない店舗は管理者) の承認後に反映されます。ほかの項目はすぐに反映されます。" : undefined}
        />
      </Card>
    </div>
  );
}
