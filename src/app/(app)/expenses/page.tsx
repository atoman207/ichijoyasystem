import Link from "@/components/ui/Link";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canSeeAllStores, scopeByStore, canViewExpense } from "@/lib/auth/permissions";
import { userName } from "@/lib/db/queries";
import { fmtDate, toDateKey, yen } from "@/lib/format";
import { EXPENSE_METHOD_LABEL, EXPENSE_STATUS } from "@/lib/constants";
import type { ExpenseStatus } from "@/lib/db/types";
import { Badge, Button, EmptyRow, Flash, Input, LinkButton, LinkTabs, PageHeader, Select, Stat, StatusBadge, StoreTag, Table, Td, Th, Tr, Pager, paginate } from "@/components/ui";

export default async function ExpensesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const allStores = canSeeAllStores(user);
  const month = toDateKey(new Date()).slice(0, 7);
  const scoped = scopeByStore(user, db.expenses).filter((e) => canViewExpense(user, e));
  const status = sp.status ?? "all";
  let rows = scoped;
  if (status !== "all" && EXPENSE_STATUS[status as ExpenseStatus]) rows = rows.filter((e) => e.status === status);
  if (allStores && sp.store) rows = rows.filter((e) => e.storeId === sp.store);
  if (sp.account) rows = rows.filter((e) => e.account === sp.account);
  const q = (sp.q ?? "").trim().toLowerCase();
  if (q) rows = rows.filter((e) => [e.number, e.vendor, e.description, e.account].join(" ").toLowerCase().includes(q));
  rows = [...rows].sort((a, b) => b.date.localeCompare(a.date));
  const paged = paginate(rows, sp.page);
  const storeMap = new Map(db.stores.map((s) => [s.id, s]));
  const thisMonth = scoped.filter((e) => e.date.startsWith(month) && e.status !== "rejected" && e.status !== "draft");
  const byAccount = new Map<string, number>();
  for (const e of thisMonth) byAccount.set(e.account, (byAccount.get(e.account) ?? 0) + e.amount);
  const top = [...byAccount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const accounts = [...new Set(scoped.map((e) => e.account))].sort();
  const base = "/expenses";

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader title="経費精算" actions={<><LinkButton href="/capture?kind=receipt" variant="secondary">レシートを撮影・取込</LinkButton><LinkButton href="/expenses/new">+ 経費を登録</LinkButton></>} />
      <div className="mb-6 grid grid-cols-2 gap-3 @3xl:grid-cols-4">
        <Stat label="今月の経費 (申請済)" value={yen(thisMonth.reduce((a, e) => a + e.amount, 0))} sub={`${thisMonth.length} 件`} />
        <Stat label="承認待ち" value={`${scoped.filter((e) => e.status === "pending_approval").length} 件`} sub={yen(scoped.filter((e) => e.status === "pending_approval").reduce((a, e) => a + e.amount, 0))} href={`${base}?status=pending_approval`} />
        <Stat label="精算待ち (承認済)" value={`${scoped.filter((e) => e.status === "approved").length} 件`} sub={yen(scoped.filter((e) => e.status === "approved").reduce((a, e) => a + e.amount, 0))} href={`${base}?status=approved`} />
        <Stat label="今月の内訳 (上位)" value={<span className="text-sm font-normal">{top.map(([k, v]) => `${k} ${yen(v)}`).join(" / ") || "-"}</span>} />
      </div>
      <LinkTabs
        current={`${base}?status=${status}`}
        items={[
          { href: `${base}?status=all`, label: "すべて", count: scoped.length },
          { href: `${base}?status=pending_approval`, label: "承認待ち", count: scoped.filter((e) => e.status === "pending_approval").length },
          { href: `${base}?status=approved`, label: "承認済 (精算待ち)", count: scoped.filter((e) => e.status === "approved").length },
          { href: `${base}?status=paid`, label: "精算済", count: scoped.filter((e) => e.status === "paid").length },
          { href: `${base}?status=rejected`, label: "差戻し", count: scoped.filter((e) => e.status === "rejected").length },
          { href: `${base}?status=draft`, label: "下書き", count: scoped.filter((e) => e.status === "draft").length },
        ]}
      />
      <form method="get" className="mb-4 flex flex-wrap items-end gap-2">
        <input type="hidden" name="status" value={status} />
        <div className="w-full @xl:w-56"><Input name="q" defaultValue={sp.q} placeholder="支払先・内容で検索" /></div>
        <Select name="account" defaultValue={sp.account ?? ""} className="w-auto">
          <option value="">すべての勘定科目</option>
          {accounts.map((a) => <option key={a} value={a}>{a}</option>)}
        </Select>
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
            <Th>日付 / 番号</Th>
            <Th>支払先</Th>
            <Th>勘定科目</Th>
            <Th>申請者</Th>
            <Th>店舗</Th>
            <Th>支払方法</Th>
            <Th align="right">金額 (税込)</Th>
            <Th>状態</Th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <EmptyRow colSpan={8} />}
          {paged.items.map((e) => (
            <Tr key={e.id}>
              <Td className="text-xs tnum">{fmtDate(e.date)}<div className="font-mono text-[10px] text-ink-3">{e.number}</div></Td>
              <Td>
                <Link href={`/expenses/${e.id}`} className="font-medium text-ink hover:text-accent">{e.vendor}</Link>
                <div className="flex flex-wrap items-center gap-1 text-xs text-ink-3">{e.description}{e.source === "ocr" && <Badge tone="accent" dot={false}>レシート取込</Badge>}</div>
              </Td>
              <Td className="text-xs text-ink-2">{e.account}</Td>
              <Td className="text-xs text-ink-2">{userName(e.submittedBy)}</Td>
              <Td><StoreTag store={storeMap.get(e.storeId)} short /></Td>
              <Td className="text-xs text-ink-2">{EXPENSE_METHOD_LABEL[e.paymentMethod]}</Td>
              <Td align="right" className="font-medium">{yen(e.amount)}</Td>
              <Td><StatusBadge value={e.status} map={EXPENSE_STATUS} /></Td>
            </Tr>
          ))}
        </tbody>
      </Table>
      <Pager paged={paged} path="/expenses" sp={sp} />
    </div>
  );
}
