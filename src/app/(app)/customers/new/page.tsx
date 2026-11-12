import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { createCustomer } from "@/lib/actions/customers";
import { CustomerForm } from "@/components/features/CustomerForm";
import { Card, Flash, Note, PageHeader } from "@/components/ui";

export default async function NewCustomerPage({ searchParams }: { searchParams: Promise<{ err?: string }> }) {
  const { err } = await searchParams;
  const user = await requireUser();
  const db = getDb();
  return (
    <div className="max-w-3xl">
      <Flash err={err} />
      <PageHeader title="顧客を登録" back={{ href: "/customers", label: "顧客一覧" }} />
      <Note tone="accent">
        登録した顧客情報は、問い合わせ・見積・受注・請求のすべてで参照されます。二重入力は不要です。
      </Note>
      <Card className="mt-4">
        <CustomerForm action={createCustomer} stores={db.stores} users={db.users.filter((u) => u.active)} user={user} cancelHref="/customers" />
      </Card>
    </div>
  );
}
