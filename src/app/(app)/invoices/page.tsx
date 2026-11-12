import Link from "@/components/ui/Link";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canSeeAllStores, scopeByStore } from "@/lib/auth/permissions";
import { customerName } from "@/lib/db/queries";
import { fmtDate, toDateKey, yen } from "@/lib/format";
import { CHANNEL_LABEL, INVOICE_STATUS } from "@/lib/constants";
import type { Invoice } from "@/lib/db/types";
import { Button, EmptyRow, Flash, Input, LinkTabs, PageHeader, Select, Stat, StatusBadge, StoreTag, Table, Td, Th, Tr, Pager, paginate } from "@/components/ui";

function effectiveStatus(i: Invoice, today: string) {
  if ((i.status === "issued" || i.status === "partially_paid") && i.dueDate < today) return "overdue" as const;
  return i.status;
}

export default async function InvoicesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const today = toDateKey(new Date());
  const allStores = canSeeAllStores(user);
  const scoped = scopeByStore(user, db.invoices).map((i) => ({ ...i, status: effectiveStatus(i, today) }));
  const status = sp.status ?? "unpaid";
  let rows = scoped;
  if (status === "unpaid") rows = rows.filter((i) => ["issued", "partially_paid", "overdue"].includes(i.status));
  else if (status !== "all") rows = rows.filter((i) => i.status === status);
  if (allStores && sp.store) rows = rows.filter((i) => i.storeId === sp.store);
  const q = (sp.q ?? "").trim().toLowerCase();
  if (q) rows = rows.filter((i) => [i.number, customerName(i.customerId)].join(" ").toLowerCase().includes(q));
  rows = [...rows].sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const paged = paginate(rows, sp.page);
  const storeMap = new Map(db.stores.map((s) => [s.id, s]));
  const unpaid = scoped.filter((i) => ["issued", "partially_paid", "overdue"].includes(i.status));
  const receivable = unpaid.reduce((a, i) => a + i.total - i.paidAmount, 0);
  const overdue = scoped.filter((i) => i.status === "overdue").reduce((a, i) => a + i.total - i.paidAmount, 0);
  const paidThisMonth = db.payments.filter((p) => p.date.startsWith(today.slice(0, 7)) && scoped.some((i) => i.id === p.invoiceId)).reduce((a, p) => a + p.amount, 0);
  const base = "/invoices";

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader title="請求・入金" />
      <div className="mb-6 grid grid-cols-2 gap-3 @3xl:grid-cols-4">
        <Stat label="売掛残高 (未入金)" value={yen(receivable)} sub={`${unpaid.length} 件`} />
        <Stat label="期日超過" value={yen(overdue)} tone={overdue > 0 ? "critical" : undefined} sub={`${scoped.filter((i) => i.status === "overdue").length} 件 · 督促が必要`} href={`${base}?status=overdue`} />
        <Stat label="今月の入金" value={yen(paidThisMonth)} />
        <Stat label="発行済 (累計)" value={`${scoped.filter((i) => i.status !== "void").length} 件`} />
      </div>
      <LinkTabs
        current={`${base}?status=${status}`}
        items={[
          { href: `${base}?status=unpaid`, label: "未入金", count: unpaid.length },
          { href: `${base}?status=overdue`, label: "期日超過", count: scoped.filter((i) => i.status === "overdue").length },
          { href: `${base}?status=partially_paid`, label: "一部入金", count: scoped.filter((i) => i.status === "partially_paid").length },
          { href: `${base}?status=paid`, label: "入金済", count: scoped.filter((i) => i.status === "paid").length },
          { href: `${base}?status=all`, label: "すべて", count: scoped.length },
        ]}
      />
      <form method="get" className="mb-4 flex flex-wrap items-end gap-2">
        <input type="hidden" name="status" value={status} />
        <div className="w-full @xl:w-64"><Input name="q" defaultValue={sp.q} placeholder="請求番号・お客様名で検索" /></div>
        {allStores && (
          <Select name="store" defaultValue={sp.store ?? ""} className="w-auto">
            <option value="">全店舗</option>
            {db.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        )}
        <Button type="submit" variant="secondary">絞り込む</Button>
      </form>
      <Table>
        <thead>
          <tr>
            <Th>請求番号</Th>
            <Th>お客様</Th>
            <Th>店舗</Th>
            <Th>発行日</Th>
            <Th>支払期限</Th>
            <Th align="right">請求額</Th>
            <Th align="right">入金額</Th>
            <Th align="right">残高</Th>
            <Th>状態</Th>
            <Th>送付</Th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <EmptyRow colSpan={10} />}
          {paged.items.map((i) => (
            <Tr key={i.id}>
              <Td className="font-mono text-xs"><Link href={`/invoices/${i.id}`} className="text-accent hover:underline">{i.number}</Link></Td>
              <Td><Link href={`/customers/${i.customerId}`} className="hover:text-accent">{customerName(i.customerId)}</Link></Td>
              <Td><StoreTag store={storeMap.get(i.storeId)} short /></Td>
              <Td className="text-xs tnum">{fmtDate(i.issueDate)}</Td>
              <Td className={`text-xs tnum ${i.status === "overdue" ? "font-medium text-critical" : ""}`}>{fmtDate(i.dueDate)}</Td>
              <Td align="right">{yen(i.total)}</Td>
              <Td align="right" className="text-ink-2">{yen(i.paidAmount)}</Td>
              <Td align="right" className="font-medium">{yen(i.total - i.paidAmount)}</Td>
              <Td><StatusBadge value={i.status} map={INVOICE_STATUS} /></Td>
              <Td className="text-xs text-ink-2">{i.sentVia ? CHANNEL_LABEL[i.sentVia] : "-"}</Td>
            </Tr>
          ))}
        </tbody>
      </Table>
      <Pager paged={paged} path="/invoices" sp={sp} />
    </div>
  );
}
