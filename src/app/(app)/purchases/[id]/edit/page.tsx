import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canRegisterPurchase, canViewPurchase } from "@/lib/auth/permissions";
import { updatePurchase } from "@/lib/actions/purchases";
import { PURCHASE_STATUS } from "@/lib/constants";
import { Card, Flash, Note, PageHeader, StatusBadge } from "@/components/ui";
import { PurchaseForm, purchaseInitial } from "@/components/features/PurchaseForm";

export default async function EditPurchasePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ err?: string }> }) {
  const { id } = await params;
  const { err } = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const p = db.purchases.find((x) => x.id === id);
  if (!p) notFound();
  if (!canViewPurchase(user, p) || !canRegisterPurchase(user)) redirect("/purchases?err=" + encodeURIComponent("この仕入請求書を修正する権限がありません。"));
  if (p.status !== "received" && p.status !== "disputed") redirect(`/purchases/${id}?err=` + encodeURIComponent("支払依頼の前と差戻しの請求書のみ修正できます。"));
  const returned = db.approvals.filter((a) => a.targetId === p.id && a.status === "returned").sort((a, b) => (b.decidedAt ?? "").localeCompare(a.decidedAt ?? ""))[0];

  return (
    <div className="max-w-4xl">
      <Flash err={err} />
      <PageHeader title={`${p.number} を修正`} badge={<StatusBadge value={p.status} map={PURCHASE_STATUS} />} back={{ href: `/purchases/${id}`, label: "仕入請求書" }} />
      {returned?.decisionComment && <Note tone="warn">差戻しの理由: {returned.decisionComment}</Note>}
      <Card className="mt-4">
        <PurchaseForm db={db} user={user} mode="edit" back={`/purchases/${id}/edit`} action={updatePurchase.bind(null, p.id)} cancelHref={`/purchases/${id}`} initial={purchaseInitial(db, p)} />
      </Card>
    </div>
  );
}
