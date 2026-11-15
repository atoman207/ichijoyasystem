import Link from "@/components/ui/Link";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canPay, canRegisterPurchase, canViewExpense, canViewPurchase, scopeByStore } from "@/lib/auth/permissions";
import { customerName, supplierName, userName } from "@/lib/db/queries";
import { addDays, fmtDate, toDateKey, yen } from "@/lib/format";
import { EXPENSE_METHOD_LABEL, PAYMENT_METHOD_LABEL, PURCHASE_STATUS } from "@/lib/constants";
import { isOpenPurchase, payDateOf } from "@/lib/suppliers";
import { Badge, EmptyRow, Flash, LinkTabs, PageHeader, Stat, StatusBadge, StoreTag, Table, Td, Th, Tr } from "@/components/ui";

/** 入出金の予定: 未入金 (お客様からの入金待ち) と支払待ち (仕入の支払・経費の精算) の一覧 */
export default async function FinancePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const today = toDateKey(new Date());
  const week = addDays(today, 7);
  const storeMap = new Map(db.stores.map((s) => [s.id, s]));
  const showPayables = canRegisterPurchase(user) || canPay(user);
  const tab = sp.tab === "payables" && showPayables ? "payables" : sp.tab === "settlement" ? "settlement" : "receivables";

  // 未入金
  const unpaid = scopeByStore(user, db.invoices)
    .filter((i) => i.status === "issued" || i.status === "partially_paid" || i.status === "overdue")
    .map((i) => ({ i, remaining: i.total - i.paidAmount, overdue: i.dueDate < today, next: i.expectedDate ?? i.dueDate }))
    .filter((r) => r.remaining > 0)
    .sort((a, b) => a.next.localeCompare(b.next));
  const expectedWeek = unpaid.filter((r) => r.i.expectedDate && r.i.expectedDate <= week);
  // 決済会社からの入金待ち (カード・PayPay)
  const settlements = db.payments
    .filter((p) => (p.method === "card" || p.method === "paypay") && !p.settledOn)
    .map((p) => ({ p, inv: db.invoices.find((i) => i.id === p.invoiceId) }))
    .filter((r): r is { p: typeof r.p; inv: NonNullable<typeof r.inv> } => Boolean(r.inv) && scopeByStore(user, [r.inv!]).length > 0)
    .sort((a, b) => a.p.date.localeCompare(b.p.date));
  // 支払待ち
  const purchases = db.purchases.filter((p) => canViewPurchase(user, p) && isOpenPurchase(p) && p.status !== "disputed").sort((a, b) => payDateOf(a).localeCompare(payDateOf(b)));
  const expenses = scopeByStore(user, db.expenses).filter((e) => e.status === "approved" && canViewExpense(user, e)).sort((a, b) => a.date.localeCompare(b.date));
  const approvedPurchases = purchases.filter((p) => p.status === "approved");
  const base = "/finance";

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader title="入出金の予定" description="お客様からの未入金 (入金予定日・支払期限の順) と、仕入の支払・経費の精算の支払待ちをまとめて確認します" />
      <div className="mb-6 grid grid-cols-2 gap-3 @3xl:grid-cols-4">
        <Stat label="未入金 (売掛金残高)" value={yen(unpaid.reduce((a, r) => a + r.remaining, 0))} sub={`${unpaid.length} 件`} href={`${base}?tab=receivables`} />
        <Stat label="支払期限を過ぎた未入金" value={yen(unpaid.filter((r) => r.overdue).reduce((a, r) => a + r.remaining, 0))} sub={`${unpaid.filter((r) => r.overdue).length} 件 · 督促が必要`} tone={unpaid.some((r) => r.overdue) ? "critical" : undefined} />
        <Stat label="7 日以内の入金予定" value={yen(expectedWeek.reduce((a, r) => a + (r.i.expectedAmount ?? r.remaining), 0))} sub={`${expectedWeek.length} 件`} />
        {showPayables ? (
          <Stat label="支払待ち (承認済み)" value={yen(approvedPurchases.reduce((a, p) => a + p.amount, 0) + expenses.reduce((a, e) => a + e.amount, 0))} sub={`仕入 ${approvedPurchases.length} 件 · 経費 ${expenses.length} 件`} href={`${base}?tab=payables`} tone={approvedPurchases.some((p) => payDateOf(p) < today) ? "warn" : undefined} />
        ) : (
          <Stat label="精算待ちの経費" value={yen(expenses.reduce((a, e) => a + e.amount, 0))} sub={`${expenses.length} 件`} />
        )}
      </div>
      <LinkTabs
        current={`${base}?tab=${tab}`}
        items={[
          { href: `${base}?tab=receivables`, label: "未入金", count: unpaid.length },
          { href: `${base}?tab=settlement`, label: "決済会社からの入金待ち", count: settlements.length },
          ...(showPayables ? [{ href: `${base}?tab=payables`, label: "支払待ち・支払依頼中", count: purchases.length + expenses.length }] : []),
        ]}
      />

      {tab === "receivables" && (
        <Table minWidth="min-w-[860px]">
          <thead>
            <tr>
              <Th>入金予定日 / 支払期限</Th>
              <Th>請求番号</Th>
              <Th>お客様</Th>
              <Th>店舗</Th>
              <Th align="right">請求額</Th>
              <Th align="right">残高</Th>
              <Th align="right">入金予定額</Th>
              <Th>メモ</Th>
            </tr>
          </thead>
          <tbody>
            {unpaid.length === 0 && <EmptyRow colSpan={8}>未入金の請求書はありません</EmptyRow>}
            {unpaid.map(({ i, remaining, overdue }) => (
              <Tr key={i.id}>
                <Td className="text-xs tnum">
                  {i.expectedDate ? <span className={i.expectedDate < today ? "font-medium text-warn-ink" : "font-medium text-ink"}>予定 {fmtDate(i.expectedDate)}</span> : <span className="text-ink-3">予定なし</span>}
                  <div className={overdue ? "font-medium text-critical" : "text-ink-3"}>期限 {fmtDate(i.dueDate)}{overdue ? " (超過)" : ""}</div>
                </Td>
                <Td className="font-mono text-xs"><Link href={`/invoices/${i.id}`} className="text-accent hover:underline">{i.number}</Link></Td>
                <Td><Link href={`/customers/${i.customerId}`} className="hover:text-accent">{customerName(i.customerId)}</Link></Td>
                <Td><StoreTag store={storeMap.get(i.storeId)} short /></Td>
                <Td align="right">{yen(i.total)}</Td>
                <Td align="right" className="font-medium">{yen(remaining)}</Td>
                <Td align="right">{i.expectedDate ? yen(i.expectedAmount ?? remaining) : "-"}</Td>
                <Td className="text-xs text-ink-2">{i.expectedNote ?? ""}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}

      {tab === "settlement" && (
        <Table minWidth="min-w-[640px]">
          <thead><tr><Th>受領日</Th><Th>請求番号</Th><Th>お客様</Th><Th>方法</Th><Th align="right">金額</Th></tr></thead>
          <tbody>
            {settlements.length === 0 && <EmptyRow colSpan={5}>決済会社からの入金待ちはありません</EmptyRow>}
            {settlements.map(({ p, inv }) => (
              <Tr key={p.id}>
                <Td className="text-xs tnum">{fmtDate(p.date)}</Td>
                <Td className="font-mono text-xs"><Link href={`/invoices/${inv.id}`} className="text-accent hover:underline">{inv.number}</Link></Td>
                <Td>{customerName(inv.customerId)}</Td>
                <Td className="text-xs">{PAYMENT_METHOD_LABEL[p.method]}</Td>
                <Td align="right">{yen(p.amount)}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}

      {tab === "payables" && showPayables && (
        <div className="space-y-6">
          <div>
            <div className="mb-2 text-sm font-medium text-ink">仕入の支払 (支払依頼中・支払待ち・支払依頼前)</div>
            <Table minWidth="min-w-[760px]">
              <thead><tr><Th>支払予定日</Th><Th>番号</Th><Th>仕入先</Th><Th>店舗</Th><Th align="right">金額</Th><Th>状態</Th></tr></thead>
              <tbody>
                {purchases.length === 0 && <EmptyRow colSpan={6}>支払待ちの仕入はありません</EmptyRow>}
                {purchases.map((p) => (
                  <Tr key={p.id}>
                    <Td className={`text-xs tnum ${payDateOf(p) < today ? "font-medium text-critical" : ""}`}>{fmtDate(payDateOf(p))}</Td>
                    <Td className="font-mono text-xs"><Link href={`/purchases/${p.id}`} className="text-accent hover:underline">{p.number}</Link></Td>
                    <Td>{supplierName(p.supplierId)}<div className="text-[11px] text-ink-3">{p.description}</div></Td>
                    <Td><StoreTag store={storeMap.get(p.storeId)} short /></Td>
                    <Td align="right" className="font-medium">{yen(p.amount)}</Td>
                    <Td><StatusBadge value={p.status} map={PURCHASE_STATUS} /></Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </div>
          <div>
            <div className="mb-2 text-sm font-medium text-ink">経費の精算待ち (承認済み)</div>
            <Table minWidth="min-w-[640px]">
              <thead><tr><Th>日付</Th><Th>番号</Th><Th>申請者</Th><Th>支払先</Th><Th>支払方法</Th><Th align="right">金額</Th></tr></thead>
              <tbody>
                {expenses.length === 0 && <EmptyRow colSpan={6}>精算待ちの経費はありません</EmptyRow>}
                {expenses.map((e) => (
                  <Tr key={e.id}>
                    <Td className="text-xs tnum">{fmtDate(e.date)}</Td>
                    <Td className="font-mono text-xs"><Link href={`/expenses/${e.id}`} className="text-accent hover:underline">{e.number}</Link></Td>
                    <Td className="text-xs">{userName(e.submittedBy)}</Td>
                    <Td>{e.vendor}<div className="text-[11px] text-ink-3">{e.account}</div></Td>
                    <Td className="text-xs">{EXPENSE_METHOD_LABEL[e.paymentMethod]}{e.paymentMethod === "cash" && <Badge tone="neutral" dot={false}>現金出納帳へ</Badge>}</Td>
                    <Td align="right" className="font-medium">{yen(e.amount)}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </div>
        </div>
      )}
    </div>
  );
}
