import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canManagePurchaseOrders } from "@/lib/auth/permissions";
import { savePurchaseOrder } from "@/lib/actions/purchase-orders";
import { Flash, Note, PageHeader } from "@/components/ui";
import { PurchaseOrderEditor } from "@/components/fax/PurchaseOrderEditor";
import { editorData } from "@/components/fax/editor-data";

export const metadata: Metadata = { title: "発注書を作成" };

/** 発注書の作成。?orderId=<受注ID> (複数可) で案件を、?supplierId= で仕入先を選んだ状態で開く */
export default async function NewPurchaseOrderPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  if (!canManagePurchaseOrders(user)) redirect("/purchase-orders?err=" + encodeURIComponent("発注書を作成する権限がありません。"));
  const db = getDb();
  const orderIds = ([] as string[]).concat(sp.orderId ?? []).slice(0, 10);
  const data = editorData(db, user, { orderIds, supplierId: typeof sp.supplierId === "string" ? sp.supplierId : undefined });
  const back = orderIds.length === 1 ? { href: `/orders/${orderIds[0]}`, label: "受注・施工" } : typeof sp.supplierId === "string" ? { href: `/suppliers/${sp.supplierId}`, label: "仕入先" } : { href: "/purchase-orders", label: "発注書" };
  return (
    <div>
      <Flash msg={typeof sp.msg === "string" ? sp.msg : undefined} err={typeof sp.err === "string" ? sp.err : undefined} />
      <PageHeader title="発注書を作成" description="仕入先を選び、案件 (受注) の見積の明細・商品マスタ・手入力で明細を作ります。発行すると PDF を確認して FAX で送れます" back={back} />
      <div className="mb-4"><Note tone="accent">発注書は手書きの発注書と同じ様式 (店舗名・仕入先 御中・発注日・担当・FAX と、品名・数量・現場名・着日・備考の表) で作ります。発注番号・店舗・担当者・仕入先の名称と FAX 番号・現場名 (名字 様)・案件番号は自動で入ります。お客様の氏名・住所・電話番号は「載せる」を選んだときだけ載せます。</Note></div>
      <PurchaseOrderEditor action={savePurchaseOrder.bind(null, null)} sentLocked={false} {...data} />
    </div>
  );
}
