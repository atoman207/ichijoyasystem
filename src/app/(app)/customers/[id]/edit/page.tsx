import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canAccessStore } from "@/lib/auth/permissions";
import { updateCustomer } from "@/lib/actions/customers";
import { CustomerForm } from "@/components/features/CustomerForm";
import { Card, Flash, PageHeader } from "@/components/ui";

export default async function EditCustomerPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string; err?: string }> }) {
  const { id } = await params;
  const { msg, err } = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const customer = db.customers.find((c) => c.id === id);
  if (!customer) notFound();
  if (!canAccessStore(user, customer.storeId)) redirect("/customers?err=" + encodeURIComponent("この顧客を編集する権限がありません。"));
  return (
    <div className="max-w-3xl">
      <Flash msg={msg} err={err} />
      <PageHeader title={`${customer.name} の情報を編集`} back={{ href: `/customers/${id}`, label: "顧客詳細" }} />
      <Card>
        <CustomerForm action={updateCustomer.bind(null, id)} customer={customer} stores={db.stores} users={db.users.filter((u) => u.active)} user={user} cancelHref={`/customers/${id}`} />
      </Card>
    </div>
  );
}
