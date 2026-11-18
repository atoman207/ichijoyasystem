import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canEditPurchaseOrder } from "@/lib/auth/permissions";
import { savePurchaseOrder } from "@/lib/actions/purchase-orders";
import { PO_EDITABLE } from "@/lib/purchase-orders";
import { Flash, Note, PageHeader } from "@/components/ui";
import { PurchaseOrderEditor } from "@/components/fax/PurchaseOrderEditor";
import { editorData } from "@/components/fax/editor-data";

export const metadata: Metadata = { title: "発注書を編集" };

export default async function EditPurchaseOrderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string; err?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const po = db.purchaseOrders.find((p) => p.id === id);
  if (!po) notFound();
  if (!canEditPurchaseOrder(user, po)) redirect(`/purchase-orders/${id}?err=` + encodeURIComponent("この発注書を変更する権限がありません。"));
  if (!PO_EDITABLE.includes(po.status)) redirect(`/purchase-orders/${id}?err=` + encodeURIComponent("取り消した・完了した発注書は変更できません。複製して新しい発注書を作ってください。"));
  const sent = db.faxMessages.some((f) => f.purchaseOrderId === po.id && f.direction === "outbound" && f.poVersion === po.version && ["sent", "manual", "sending", "queued", "unknown"].includes(f.status));
  const data = editorData(db, user, { po });
  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader title={`発注書 ${po.number} を編集`} description={`第${po.version}版`} back={{ href: `/purchase-orders/${po.id}`, label: po.number }} />
      {sent && <div className="mb-4"><Note tone="warn">この版は仕入先へ送信済みです。内容を直して保存すると「第{po.version + 1}版 (訂正)」になり、もう一度送信が必要です。</Note></div>}
      <PurchaseOrderEditor action={savePurchaseOrder.bind(null, po.id)} sentLocked={sent} {...data} />
    </div>
  );
}
