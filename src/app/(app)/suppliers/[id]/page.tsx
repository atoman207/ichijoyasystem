import Link from "@/components/ui/Link";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canEditSuppliers, canManagePurchaseOrders, canViewPurchase, canViewSuppliers } from "@/lib/auth/permissions";
import { updateSupplier } from "@/lib/actions/suppliers";
import { fmtDate, yen } from "@/lib/format";
import { PURCHASE_STATUS, SUPPLIER_KIND_LABEL } from "@/lib/constants";
import { isOpenPurchase, payDateOf, supplierKindOf, termsLabel } from "@/lib/suppliers";
import { Badge, Button, Card, CardHeader, Dl, EmptyRow, Flash, LinkButton, PageHeader, StatusBadge, Table, Td, Th, Tr } from "@/components/ui";
import { SupplierFields } from "@/components/features/SupplierFields";
import { ContactList, ContactLogForm } from "@/components/features/Contacts";
import { HistoryCard } from "@/components/features/History";
import { FaxHistoryCard, PurchaseOrderTable } from "@/components/fax/FaxParts";

export default async function SupplierDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string; err?: string }> }) {
  const { id } = await params;
  const { msg, err } = await searchParams;
  const user = await requireUser();
  if (!canViewSuppliers(user)) redirect("/?err=" + encodeURIComponent("仕入先・協力業者の台帳は店長・本部・管理者が閲覧できます。"));
  const db = getDb();
  const s = db.suppliers.find((x) => x.id === id);
  if (!s) notFound();
  const purchases = db.purchases.filter((p) => p.supplierId === s.id && canViewPurchase(user, p)).sort((a, b) => b.invoiceDate.localeCompare(a.invoiceDate));
  const open = purchases.filter(isOpenPurchase);
  const logs = db.commLogs.filter((c) => c.supplierId === s.id);
  const pos = db.purchaseOrders.filter((p) => p.supplierId === s.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const faxes = db.faxMessages.filter((f) => f.supplierId === s.id);
  const returnTo = `/suppliers/${id}`;
  const kind = supplierKindOf(s);

  return (
    <div>
      <Flash msg={msg} err={err} />
      <PageHeader
        title={s.name}
        badge={<><Badge tone={kind === "partner" ? "accent" : "neutral"} dot={false}>{SUPPLIER_KIND_LABEL[kind]}</Badge>{s.active === false && <Badge tone="neutral">取引終了</Badge>}</>}
        description={`${s.category} · ${termsLabel(s)}`}
        back={{ href: "/suppliers", label: "仕入先・協力業者" }}
        actions={<>{canManagePurchaseOrders(user) && s.active !== false && <LinkButton href={`/purchase-orders/new?supplierId=${s.id}`} size="sm" variant="secondary">発注書を作成</LinkButton>}<LinkButton href={`/purchases/new?supplierId=${s.id}`} size="sm">この取引先の請求書を登録</LinkButton></>}
      />
      <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-3">
        <div className="space-y-4 @4xl:col-span-2">
          <Card>
            <CardHeader title="取引先の情報" />
            <Dl columns={2} items={[["担当者", s.contactName ?? "-"], ["電話", s.phone ?? "-"], ["FAX", s.fax ?? "-"], ["メール", s.email ?? "-"], ["住所", s.address ? `${s.postalCode ? `〒${s.postalCode} ` : ""}${s.address}` : "-"], ["支払条件", termsLabel(s)], ["振込先", s.bankInfo ?? "-"], ["登録番号", s.registrationNumber ?? "-"], ["LINE", s.lineId ? "登録あり" : "-"], ["Chatwork ルーム", s.chatworkRoomId ?? "-"], ["メモ", s.notes ?? "-"]]} />
          </Card>
          <Card>
            <CardHeader title="仕入請求書" description={`未払 ${open.length} 件 ${yen(open.reduce((a, p) => a + p.amount, 0))}`} action={<LinkButton href={`/purchases?view=list&status=all&supplier=${s.id}`} variant="ghost" size="sm">一覧で見る</LinkButton>} />
            <Table minWidth="min-w-[560px]">
              <thead><tr><Th>番号</Th><Th>請求日</Th><Th>支払予定日</Th><Th align="right">金額</Th><Th>状態</Th></tr></thead>
              <tbody>
                {purchases.length === 0 && <EmptyRow colSpan={5} />}
                {purchases.slice(0, 30).map((p) => (
                  <Tr key={p.id}>
                    <Td className="font-mono text-xs"><Link href={`/purchases/${p.id}`} className="text-accent hover:underline">{p.number}</Link><div className="font-sans text-[11px] text-ink-3">{p.description}</div></Td>
                    <Td className="text-xs tnum">{fmtDate(p.invoiceDate)}</Td>
                    <Td className="text-xs tnum">{fmtDate(payDateOf(p))}</Td>
                    <Td align="right">{yen(p.amount)}</Td>
                    <Td><StatusBadge value={p.status} map={PURCHASE_STATUS} /></Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>
          <Card padded={false}>
            <div className="p-5 pb-0"><CardHeader title="発注書" description={`${pos.length} 件 · 複数の案件をまとめた発注書を含みます`} action={<LinkButton href={`/purchase-orders?status=all&supplier=${s.id}`} variant="ghost" size="sm">一覧で見る</LinkButton>} /></div>
            <div className="px-2 pb-2"><PurchaseOrderTable db={db} user={user} rows={pos.slice(0, 20)} /></div>
          </Card>
          <FaxHistoryCard db={db} user={user} faxes={faxes} title="FAX の送受信" />
          <Card>
            <CardHeader title="やりとりの記録" description="電話・メール・LINE・Chatwork・対面のやりとりを、案件 (受注番号など) に紐付けて残します。LINE ID・Chatwork ルーム・メールを登録すると、ここから送信もできます" />
            <ContactLogForm returnTo={returnTo} supplierId={s.id} defaultChannel={s.chatworkRoomId ? "chatwork" : "phone"} canSend />
            <div className="mt-4 border-t border-line pt-3">
              <ContactList db={db} logs={logs} showParty={false} returnTo={returnTo} linkable />
            </div>
          </Card>
        </div>
        <div className="space-y-4">
          {canEditSuppliers(user) && (
            <Card>
              <CardHeader title="情報を変更" />
              <form action={updateSupplier.bind(null, s.id)} className="space-y-3">
                <SupplierFields s={s} />
                <Button type="submit" size="sm" variant="secondary">変更する</Button>
              </form>
            </Card>
          )}
          <HistoryCard db={db} user={user} targets={[{ entity: "supplier", id: s.id }]} />
        </div>
      </div>
    </div>
  );
}
