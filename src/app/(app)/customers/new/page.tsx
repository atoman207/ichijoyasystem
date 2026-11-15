import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { createCustomer } from "@/lib/actions/customers";
import { CustomerForm } from "@/components/features/CustomerForm";
import { Card, Flash, LinkButton, Note, PageHeader } from "@/components/ui";
import { userCanCreateCustomer } from "@/lib/ops-settings";

export default async function NewCustomerPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const err = sp.err;
  const user = await requireUser();
  const db = getDb();
  const allowed = userCanCreateCustomer(db, user);
  // 書類取込 (手書き見積書) などからの初期値
  const prefill = { name: sp.name, kana: sp.kana, phone: sp.phone, address: sp.address };
  const returnTo = sp.returnTo && sp.returnTo.startsWith("/") && !sp.returnTo.startsWith("//") ? sp.returnTo : undefined;
  return (
    <div className="max-w-3xl">
      <Flash err={err} />
      <PageHeader title="顧客を登録" back={{ href: "/customers", label: "顧客一覧" }} />
      <Note tone="accent">
        登録した顧客情報は、問い合わせ・見積・受注・請求のすべてで参照されます。二重入力は不要です。
      </Note>
      {allowed ? (
        <Card className="mt-4">
          <CustomerForm action={createCustomer} customer={prefill} returnTo={returnTo} stores={db.stores} users={db.users.filter((u) => u.active)} user={user} cancelHref={returnTo ?? "/customers"} />
        </Card>
      ) : (
        <Card className="mt-4">
          <p className="text-sm text-ink">顧客の新規登録は、重複を防ぐため事務担当が行います (本部・管理者も可)。お客様の名前・電話番号を事務担当に伝えて登録を依頼してください。</p>
          <p className="mt-2 text-xs text-ink-3">既存のお客様は「顧客」の検索から選べます。登録できる人は 設定 → 運用 で管理者が変更できます。</p>
          <div className="mt-3"><LinkButton href={returnTo ?? "/customers"} variant="secondary" size="sm">戻る</LinkButton></div>
        </Card>
      )}
    </div>
  );
}
