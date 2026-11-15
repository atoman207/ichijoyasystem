import Link from "@/components/ui/Link";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canSeeAllStores, scopeByStore } from "@/lib/auth/permissions";
import { customerName } from "@/lib/db/queries";
import { fmtDate, toDateKey, yen } from "@/lib/format";
import { CHANNEL_LABEL, INVOICE_STATUS } from "@/lib/constants";
import type { Invoice } from "@/lib/db/types";
import { Button, EmptyRow, Flash, Input, LinkButton, LinkTabs, PageHeader, Select, Stat, StatusBadge, StoreTag, Table, Td, Th, Tr, Pager, paginate } from "@/components/ui";

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
  const view = sp.view === "customers" ? "customers" : "list";
  const status = sp.status ?? "unpaid";
  let rows = scoped;
  if (status === "unpaid") rows = rows.filter((i) => ["issued", "partially_paid", "overdue"].includes(i.status));
  else if (status === "expected") rows = rows.filter((i) => i.expectedDate && ["issued", "partially_paid", "overdue"].includes(i.status));
  else if (status !== "all") rows = rows.filter((i) => i.status === status);
  if (allStores && sp.store) rows = rows.filter((i) => i.storeId === sp.store);
  const q = (sp.q ?? "").trim().toLowerCase();
  if (q) rows = rows.filter((i) => [i.number, customerName(i.customerId)].join(" ").toLowerCase().includes(q));
  rows = [...rows].sort((a, b) => (status === "expected" ? (a.expectedDate ?? "").localeCompare(b.expectedDate ?? "") : a.dueDate.localeCompare(b.dueDate)));
  const paged = paginate(rows, sp.page);
  const storeMap = new Map(db.stores.map((s) => [s.id, s]));
  const unpaid = scoped.filter((i) => ["issued", "partially_paid", "overdue"].includes(i.status));
  const receivable = unpaid.reduce((a, i) => a + i.total - i.paidAmount, 0);
  const overdue = scoped.filter((i) => i.status === "overdue").reduce((a, i) => a + i.total - i.paidAmount, 0);
  const paidThisMonth = db.payments.filter((p) => p.date.startsWith(today.slice(0, 7)) && scoped.some((i) => i.id === p.invoiceId)).reduce((a, p) => a + p.amount, 0);
  const base = "/invoices";

  // 顧客別の請求状況
  const byCustomer = new Map<string, { count: number; billed: number; paid: number; open: number; overdue: number; openCount: number; lastPayment?: string; nextExpected?: string; storeId: Invoice["storeId"] }>();
  const lastPay = new Map<string, string>();
  for (const p of db.payments) if (!lastPay.get(p.invoiceId) || p.date > lastPay.get(p.invoiceId)!) lastPay.set(p.invoiceId, p.date);
  for (const i of scoped) {
    if (i.status === "void") continue;
    if (allStores && sp.store && i.storeId !== sp.store) continue;
    const r = byCustomer.get(i.customerId) ?? { count: 0, billed: 0, paid: 0, open: 0, overdue: 0, openCount: 0, storeId: i.storeId };
    r.count += 1;
    r.billed += i.total;
    r.paid += i.paidAmount;
    const rem = i.total - i.paidAmount;
    if (rem > 0) {
      r.open += rem;
      r.openCount += 1;
      if (i.status === "overdue") r.overdue += rem;
      if (i.expectedDate && (!r.nextExpected || i.expectedDate < r.nextExpected)) r.nextExpected = i.expectedDate;
    }
    const lp = lastPay.get(i.id);
    if (lp && (!r.lastPayment || lp > r.lastPayment)) r.lastPayment = lp;
    byCustomer.set(i.customerId, r);
  }
  let customerRows = [...byCustomer.entries()].map(([id, r]) => ({ id, name: customerName(id), ...r }));
  if (q) customerRows = customerRows.filter((r) => r.name.toLowerCase().includes(q));
  if (sp.only === "open") customerRows = customerRows.filter((r) => r.open > 0);
  customerRows.sort((a, b) => b.overdue - a.overdue || b.open - a.open || b.billed - a.billed);
  const customerPaged = paginate(customerRows, sp.page);

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader title="請求・入金" actions={<LinkButton href="/finance" variant="secondary">入出金の予定</LinkButton>} />
      <div className="mb-6 grid grid-cols-2 gap-3 @3xl:grid-cols-4">
        <Stat label="売掛残高 (未入金)" value={yen(receivable)} sub={`${unpaid.length} 件`} />
        <Stat label="期日超過" value={yen(overdue)} tone={overdue > 0 ? "critical" : undefined} sub={`${scoped.filter((i) => i.status === "overdue").length} 件 · 督促が必要`} href={`${base}?status=overdue`} />
        <Stat label="今月の入金" value={yen(paidThisMonth)} />
        <Stat label="入金予定の登録あり" value={`${unpaid.filter((i) => i.expectedDate).length} 件`} href={`${base}?status=expected`} />
      </div>
      <LinkTabs current={`${base}?view=${view}`} items={[{ href: `${base}?view=list`, label: "請求書の一覧" }, { href: `${base}?view=customers&only=open`, label: "顧客別の請求状況" }]} />

      {view === "list" ? (
        <>
          <LinkTabs
            current={`${base}?status=${status}`}
            items={[
              { href: `${base}?status=unpaid`, label: "未入金", count: unpaid.length },
              { href: `${base}?status=overdue`, label: "期日超過", count: scoped.filter((i) => i.status === "overdue").length },
              { href: `${base}?status=expected`, label: "入金予定あり", count: unpaid.filter((i) => i.expectedDate).length },
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
                <Th>入金予定</Th>
                <Th align="right">請求額</Th>
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
                  <Td className="text-xs tnum">{i.expectedDate ? <>{fmtDate(i.expectedDate)}{i.expectedAmount ? <div className="text-[10px] text-ink-3">{yen(i.expectedAmount)}</div> : null}</> : <span className="text-ink-3">-</span>}</Td>
                  <Td align="right">{yen(i.total)}</Td>
                  <Td align="right" className="font-medium">{yen(i.total - i.paidAmount)}</Td>
                  <Td><StatusBadge value={i.status} map={INVOICE_STATUS} /></Td>
                  <Td className="text-xs text-ink-2">{i.sentVia ? CHANNEL_LABEL[i.sentVia] : "-"}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
          <Pager paged={paged} path="/invoices" sp={sp} />
        </>
      ) : (
        <>
          <form method="get" className="mb-4 flex flex-wrap items-end gap-2">
            <input type="hidden" name="view" value="customers" />
            <div className="w-full @xl:w-64"><Input name="q" defaultValue={sp.q} placeholder="お客様名で検索" /></div>
            <Select name="only" defaultValue={sp.only ?? ""} className="w-auto" aria-label="表示">
              <option value="open">未入金のあるお客様</option>
              <option value="">すべてのお客様</option>
            </Select>
            {allStores && (
              <Select name="store" defaultValue={sp.store ?? ""} className="w-auto">
                <option value="">全店舗</option>
                {db.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            )}
            <Button type="submit" variant="secondary">絞り込む</Button>
            <span className="text-xs text-ink-3">{customerRows.length} 件</span>
          </form>
          <Table minWidth="min-w-[860px]">
            <thead>
              <tr>
                <Th>お客様</Th>
                <Th>店舗</Th>
                <Th align="right">請求 (件)</Th>
                <Th align="right">請求額の合計</Th>
                <Th align="right">入金済</Th>
                <Th align="right">未入金 (件)</Th>
                <Th align="right">うち期日超過</Th>
                <Th>次の入金予定</Th>
                <Th>最後の入金</Th>
              </tr>
            </thead>
            <tbody>
              {customerRows.length === 0 && <EmptyRow colSpan={9} />}
              {customerPaged.items.map((r) => (
                <Tr key={r.id}>
                  <Td><Link href={`/customers/${r.id}`} className="font-medium hover:text-accent">{r.name}</Link></Td>
                  <Td><StoreTag store={storeMap.get(r.storeId)} short /></Td>
                  <Td align="right">{r.count}</Td>
                  <Td align="right">{yen(r.billed)}</Td>
                  <Td align="right" className="text-ink-2">{yen(r.paid)}</Td>
                  <Td align="right" className="font-medium">{r.open ? <Link href={`${base}?status=unpaid&q=${encodeURIComponent(r.name)}`} className="hover:text-accent">{yen(r.open)} ({r.openCount})</Link> : "-"}</Td>
                  <Td align="right" className={r.overdue ? "font-medium text-critical" : "text-ink-3"}>{r.overdue ? yen(r.overdue) : "-"}</Td>
                  <Td className="text-xs tnum">{r.nextExpected ? fmtDate(r.nextExpected) : "-"}</Td>
                  <Td className="text-xs tnum text-ink-3">{r.lastPayment ? fmtDate(r.lastPayment) : "-"}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
          <Pager paged={customerPaged} path="/invoices" sp={sp} />
        </>
      )}
    </div>
  );
}
