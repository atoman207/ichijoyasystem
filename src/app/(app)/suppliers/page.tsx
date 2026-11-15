import Link from "@/components/ui/Link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canEditSuppliers, canViewPurchase, canViewSuppliers } from "@/lib/auth/permissions";
import { createSupplier } from "@/lib/actions/suppliers";
import { fmtDateTime, yen } from "@/lib/format";
import { SUPPLIER_KIND_LABEL } from "@/lib/constants";
import { isOpenPurchase, supplierKindOf, termsLabel } from "@/lib/suppliers";
import { Badge, Button, Card, CardHeader, EmptyRow, Flash, Input, LinkButton, LinkTabs, PageHeader, Table, Td, Th, Tr } from "@/components/ui";
import { SupplierFields } from "@/components/features/SupplierFields";

export default async function SuppliersPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  if (!canViewSuppliers(user)) redirect("/?err=" + encodeURIComponent("仕入先・協力業者の台帳は店長・本部・管理者が閲覧できます。"));
  const db = getDb();
  const kind = sp.kind === "supplier" || sp.kind === "partner" || sp.kind === "inactive" ? sp.kind : "all";
  let rows = db.suppliers;
  if (kind === "inactive") rows = rows.filter((s) => s.active === false);
  else rows = rows.filter((s) => s.active !== false && (kind === "all" || supplierKindOf(s) === kind));
  const q = (sp.q ?? "").trim().toLowerCase();
  if (q) rows = rows.filter((s) => [s.name, s.kana ?? "", s.category, s.contactName ?? "", s.phone ?? ""].join(" ").toLowerCase().includes(q));
  rows = [...rows].sort((a, b) => (a.kana || a.name).localeCompare(b.kana || b.name, "ja"));
  const purchases = db.purchases.filter((p) => canViewPurchase(user, p));
  const lastContact = new Map<string, string>();
  for (const c of db.commLogs) if (c.supplierId && (!lastContact.get(c.supplierId) || c.at > lastContact.get(c.supplierId)!)) lastContact.set(c.supplierId, c.at);
  const base = "/suppliers";
  const active = db.suppliers.filter((s) => s.active !== false);

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader title="仕入先・協力業者" description="仕入先 (材料・商品) と協力業者 (外注・施工の協力会社) の台帳。支払条件から仕入請求書の支払期限を自動で計算し、やりとりの記録を集めます" actions={<LinkButton href="/purchases" variant="secondary">仕入・買掛へ</LinkButton>} />
      <LinkTabs
        current={`${base}?kind=${kind}`}
        items={[
          { href: `${base}?kind=all`, label: "すべて (取引中)", count: active.length },
          { href: `${base}?kind=supplier`, label: "仕入先", count: active.filter((s) => supplierKindOf(s) === "supplier").length },
          { href: `${base}?kind=partner`, label: "協力業者", count: active.filter((s) => supplierKindOf(s) === "partner").length },
          { href: `${base}?kind=inactive`, label: "取引終了", count: db.suppliers.length - active.length },
        ]}
      />
      <div className="grid grid-cols-1 gap-4 @5xl:grid-cols-3">
        <div className="@5xl:col-span-2">
          <form method="get" className="mb-3 flex flex-wrap items-end gap-2">
            <input type="hidden" name="kind" value={kind} />
            <div className="w-full @xl:w-64"><Input name="q" defaultValue={sp.q} placeholder="名前・品目・担当者・電話で検索" /></div>
            <Button type="submit" variant="secondary">絞り込む</Button>
          </form>
          <Table minWidth="min-w-[640px]">
            <thead>
              <tr>
                <Th>名前</Th>
                <Th>支払条件</Th>
                <Th>連絡先</Th>
                <Th align="right">未払</Th>
                <Th>最後のやりとり</Th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <EmptyRow colSpan={5} />}
              {rows.map((s) => {
                const open = purchases.filter((p) => p.supplierId === s.id && isOpenPurchase(p));
                return (
                  <Tr key={s.id}>
                    <Td>
                      <Link href={`/suppliers/${s.id}`} className="font-medium text-ink hover:text-accent">{s.name}</Link>
                      <div className="flex flex-wrap items-center gap-1 text-[11px] text-ink-3">
                        <Badge tone={supplierKindOf(s) === "partner" ? "accent" : "neutral"} dot={false}>{SUPPLIER_KIND_LABEL[supplierKindOf(s)]}</Badge>
                        {s.category}
                      </div>
                    </Td>
                    <Td className="text-xs text-ink-2">{termsLabel(s)}</Td>
                    <Td className="text-xs text-ink-2">{[s.contactName, s.phone, s.email].filter(Boolean).join(" · ") || "-"}{(s.lineId || s.chatworkRoomId) && <div className="text-[11px] text-ink-3">{[s.lineId ? "LINE" : "", s.chatworkRoomId ? "Chatwork" : ""].filter(Boolean).join("・")} で連絡可</div>}</Td>
                    <Td align="right" className="text-xs">{open.length ? <span className="font-medium">{yen(open.reduce((a, p) => a + p.amount, 0))} ({open.length})</span> : "-"}</Td>
                    <Td className="text-xs tnum text-ink-3">{lastContact.get(s.id) ? fmtDateTime(lastContact.get(s.id)) : "-"}</Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        </div>
        {canEditSuppliers(user) && (
          <Card>
            <CardHeader title="仕入先・協力業者を登録" />
            <form action={createSupplier} className="space-y-3">
              <SupplierFields />
              <Button type="submit" size="sm">登録する</Button>
            </form>
          </Card>
        )}
      </div>
    </div>
  );
}
