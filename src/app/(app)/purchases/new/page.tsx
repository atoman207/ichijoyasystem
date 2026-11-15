import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canRegisterPurchase } from "@/lib/auth/permissions";
import { createPurchase } from "@/lib/actions/purchases";
import { toDateKey } from "@/lib/format";
import { Card, Flash, Note, PageHeader } from "@/components/ui";
import { PurchaseForm } from "@/components/features/PurchaseForm";

export default async function NewPurchasePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  if (!canRegisterPurchase(user)) redirect("/?err=" + encodeURIComponent("仕入請求書の登録は店長・本部・管理者が行います。"));
  const db = getDb();
  const doc = db.documents.find((d) => d.id === sp.documentId && !d.linkedId);
  const ex = (doc?.extracted ?? {}) as { supplier?: string; invoiceNumber?: string; invoiceDate?: string; dueDate?: string; amount?: number; taxAmount?: number; note?: string; items?: { name: string; spec?: string; qty?: number; unit?: string; unitPrice?: number; amount?: number }[] };
  const matched = ex.supplier ? db.suppliers.find((s) => s.name.includes(ex.supplier!) || ex.supplier!.includes(s.name)) : undefined;
  const supplierId = sp.supplierId ?? matched?.id;

  return (
    <div className="max-w-4xl">
      <Flash err={sp.err} />
      <PageHeader title="仕入請求書を登録" back={{ href: "/purchases", label: "仕入・買掛" }} />
      <Note tone="accent">
        {doc ? <>取込書類「{doc.fileName}」の読取結果を初期値にしています。内容を確認してください。</> : <>紙・PDF の請求書は <a href="/capture?kind=supplier_invoice" className="underline">撮影・取込</a> で AI が読み取れます。</>}{" "}
        「登録して支払依頼」で管理者へ支払の承認を申請します。承認後は「支払待ち」になり、本部が支払うと「支払完了」になります。
      </Note>
      <Card className="mt-4">
        <PurchaseForm
          db={db}
          user={user}
          mode="create"
          back="/purchases/new"
          action={createPurchase}
          cancelHref="/purchases"
          initial={{
            documentId: doc?.id,
            supplierId,
            newSupplierName: !matched && ex.supplier ? ex.supplier : undefined,
            invoiceDate: ex.invoiceDate ?? toDateKey(new Date()),
            dueDate: ex.dueDate,
            amount: ex.amount,
            taxAmount: ex.taxAmount,
            supplierInvoiceNo: ex.invoiceNumber,
            description: ex.note,
            orderRef: sp.orderRef,
            items: ex.items?.filter((i) => i.name).map((i) => ({ name: i.name, spec: i.spec, qty: i.qty ?? 1, unit: i.unit, unitPrice: i.unitPrice ?? (i.amount !== undefined && (i.qty ?? 1) > 0 ? Math.round(i.amount / (i.qty ?? 1)) : undefined) })),
          }}
        />
      </Card>
    </div>
  );
}
