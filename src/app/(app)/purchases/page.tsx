import Link from "@/components/ui/Link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canManageFinance } from "@/lib/auth/permissions";
import { supplierName, userName } from "@/lib/db/queries";
import { createPurchase } from "@/lib/actions/purchases";
import { addDays, fmtDate, toDateKey, yen } from "@/lib/format";
import { PURCHASE_STATUS } from "@/lib/constants";
import type { PurchaseStatus } from "@/lib/db/types";
import { Badge, Button, Card, CardHeader, EmptyRow, Field, Flash, Input, LinkButton, LinkTabs, PageHeader, Select, Stat, StatusBadge, Table, Td, Th, Textarea, Tr } from "@/components/ui";

export default async function PurchasesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  if (!canManageFinance(user)) redirect("/?err=" + encodeURIComponent("仕入・買掛は本部・管理者のみ閲覧できます。"));
  const db = getDb();
  const today = toDateKey(new Date());
  const status = sp.status ?? "open";
  let rows = db.purchases;
  if (status === "open") rows = rows.filter((p) => p.status !== "paid");
  else if (status !== "all" && PURCHASE_STATUS[status as PurchaseStatus]) rows = rows.filter((p) => p.status === status);
  if (sp.supplier) rows = rows.filter((p) => p.supplierId === sp.supplier);
  rows = [...rows].sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const unpaid = db.purchases.filter((p) => p.status !== "paid");
  const payable = unpaid.reduce((a, p) => a + p.amount, 0);
  const dueSoon = unpaid.filter((p) => p.dueDate <= addDays(today, 14)).reduce((a, p) => a + p.amount, 0);
  const paidThisMonth = db.purchases.filter((p) => p.status === "paid" && p.paidAt?.startsWith(today.slice(0, 7))).reduce((a, p) => a + p.amount, 0);
  const doc = db.documents.find((d) => d.id === sp.documentId);
  const ex = (doc?.extracted ?? {}) as { supplier?: string; invoiceDate?: string; dueDate?: string; amount?: number; taxAmount?: number };
  const matchedSupplier = ex.supplier ? db.suppliers.find((s) => s.name.includes(ex.supplier!) || ex.supplier!.includes(s.name)) : undefined;
  const base = "/purchases";

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader title="仕入・買掛管理" actions={<LinkButton href="/capture?kind=supplier_invoice" variant="secondary">請求書を撮影・取込</LinkButton>} />
      <div className="mb-6 grid grid-cols-2 gap-3 @3xl:grid-cols-4">
        <Stat label="買掛金残高 (未払)" value={yen(payable)} sub={`${unpaid.length} 件`} />
        <Stat label="14日以内に支払期限" value={yen(dueSoon)} tone={dueSoon > 0 ? "warn" : undefined} />
        <Stat label="支払承認待ち" value={`${db.purchases.filter((p) => p.status === "pending_approval").length} 件`} href={`${base}?status=pending_approval`} />
        <Stat label="今月の支払額" value={yen(paidThisMonth)} />
      </div>
      <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-3">
        <div className="@4xl:col-span-2">
          <LinkTabs
            current={`${base}?status=${status}`}
            items={[
              { href: `${base}?status=open`, label: "未払", count: unpaid.length },
              { href: `${base}?status=received`, label: "受領 (未申請)", count: db.purchases.filter((p) => p.status === "received").length },
              { href: `${base}?status=pending_approval`, label: "承認待ち", count: db.purchases.filter((p) => p.status === "pending_approval").length },
              { href: `${base}?status=approved`, label: "支払承認済", count: db.purchases.filter((p) => p.status === "approved").length },
              { href: `${base}?status=paid`, label: "支払済", count: db.purchases.filter((p) => p.status === "paid").length },
              { href: `${base}?status=all`, label: "すべて", count: db.purchases.length },
            ]}
          />
          <Table minWidth="min-w-[640px]">
            <thead>
              <tr>
                <Th>番号</Th>
                <Th>仕入先 / 内容</Th>
                <Th>請求日</Th>
                <Th>支払期限</Th>
                <Th align="right">金額 (税込)</Th>
                <Th>状態</Th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <EmptyRow colSpan={6} />}
              {rows.map((p) => (
                <Tr key={p.id}>
                  <Td className="font-mono text-xs"><Link href={`/purchases/${p.id}`} className="text-accent hover:underline">{p.number}</Link></Td>
                  <Td>
                    <Link href={`/purchases/${p.id}`} className="font-medium text-ink hover:text-accent">{supplierName(p.supplierId)}</Link>
                    <div className="flex flex-wrap items-center gap-1 text-xs text-ink-3">{p.description}{p.source === "ocr" && <Badge tone="accent" dot={false}>取込</Badge>}</div>
                  </Td>
                  <Td className="text-xs tnum">{fmtDate(p.invoiceDate)}</Td>
                  <Td className={`text-xs tnum ${p.status !== "paid" && p.dueDate < today ? "font-medium text-critical" : ""}`}>{fmtDate(p.dueDate)}</Td>
                  <Td align="right" className="font-medium">{yen(p.amount)}</Td>
                  <Td><StatusBadge value={p.status} map={PURCHASE_STATUS} /></Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </div>
        <Card>
          <CardHeader title="仕入請求書を登録" description={doc ? `取込書類「${doc.fileName}」の読取結果` : "紙の請求書は「請求書を撮影・取込」から自動読取できます"} />
          <form action={createPurchase} className="space-y-3">
            {doc && <><input type="hidden" name="documentId" value={doc.id} /><input type="hidden" name="source" value="ocr" /></>}
            <Field label="仕入先" required>
              <Select name="supplierId" defaultValue={matchedSupplier?.id ?? ""}>
                <option value="">{db.suppliers.length ? "選択 (一覧にないときは下に入力)" : "登録済みの仕入先はありません (下に入力)"}</option>
                {db.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </Field>
            <Field label="新しい仕入先 (一覧にないとき)">
              <Input name="newSupplierName" defaultValue={!matchedSupplier && ex.supplier ? ex.supplier : ""} placeholder="例: ○○畳材 株式会社" />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="請求日"><Input type="date" name="invoiceDate" defaultValue={ex.invoiceDate ?? today} /></Field>
              <Field label="支払期限"><Input type="date" name="dueDate" defaultValue={ex.dueDate ?? addDays(today, 30)} /></Field>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Field label="金額 (税込)" required><Input type="number" name="amount" defaultValue={ex.amount} required /></Field>
              <Field label="うち消費税"><Input type="number" name="taxAmount" defaultValue={ex.taxAmount} /></Field>
            </div>
            <Field label="内容"><Textarea name="description" placeholder="例: 10月分 い草・畳表" /></Field>
            <div className="flex gap-2">
              <Button type="submit" name="intent" value="draft" variant="secondary" size="sm">登録のみ</Button>
              <Button type="submit" name="intent" value="submit" size="sm">登録して支払承認を申請</Button>
            </div>
          </form>
          <p className="mt-3 text-[11px] text-ink-3">登録者: {userName(user.id)}</p>
        </Card>
      </div>
    </div>
  );
}
