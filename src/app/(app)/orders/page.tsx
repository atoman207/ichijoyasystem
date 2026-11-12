import Link from "@/components/ui/Link";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canSeeAllStores, scopeByStore } from "@/lib/auth/permissions";
import { customerName, userName } from "@/lib/db/queries";
import { fmtDate, yen } from "@/lib/format";
import { CATEGORY_LABEL, ORDER_STATUS } from "@/lib/constants";
import type { OrderStatus } from "@/lib/db/types";
import { Button, EmptyRow, Flash, Input, LinkTabs, PageHeader, Select, StatusBadge, StoreTag, Table, Td, Th, Tr, Pager, paginate } from "@/components/ui";

const ACTIVE: OrderStatus[] = ["pending_approval", "confirmed", "scheduled", "in_progress"];

export default async function OrdersPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const allStores = canSeeAllStores(user);
  const scoped = scopeByStore(user, db.orders);
  const status = sp.status ?? "active";
  let rows = scoped;
  if (status === "active") rows = rows.filter((o) => ACTIVE.includes(o.status));
  else if (status !== "all" && ORDER_STATUS[status as OrderStatus]) rows = rows.filter((o) => o.status === status);
  if (allStores && sp.store) rows = rows.filter((o) => o.storeId === sp.store);
  const q = (sp.q ?? "").trim().toLowerCase();
  if (q) rows = rows.filter((o) => [o.number, o.title, customerName(o.customerId), o.siteAddress].join(" ").toLowerCase().includes(q));
  rows = [...rows].sort((a, b) => (status === "active" ? (a.scheduledStart ?? "9999").localeCompare(b.scheduledStart ?? "9999") : b.updatedAt.localeCompare(a.updatedAt)));
  const paged = paginate(rows, sp.page);
  const storeMap = new Map(db.stores.map((s) => [s.id, s]));
  const count = (f: (s: OrderStatus) => boolean) => scoped.filter((o) => f(o.status)).length;
  const base = "/orders";

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader title="受注・施工管理" />
      <LinkTabs
        current={`${base}?status=${status}`}
        items={[
          { href: `${base}?status=active`, label: "進行中", count: count((s) => ACTIVE.includes(s)) },
          { href: `${base}?status=pending_approval`, label: "契約承認待ち", count: count((s) => s === "pending_approval") },
          { href: `${base}?status=scheduled`, label: "施工予定", count: count((s) => s === "scheduled") },
          { href: `${base}?status=in_progress`, label: "施工中", count: count((s) => s === "in_progress") },
          { href: `${base}?status=completed`, label: "施工完了 (未請求)", count: count((s) => s === "completed") },
          { href: `${base}?status=invoiced`, label: "請求済", count: count((s) => s === "invoiced") },
          { href: `${base}?status=paid`, label: "入金済", count: count((s) => s === "paid") },
          { href: `${base}?status=all`, label: "すべて", count: scoped.length },
        ]}
      />
      <form method="get" className="mb-4 flex flex-wrap items-end gap-2">
        <input type="hidden" name="status" value={status} />
        <div className="w-full @xl:w-64"><Input name="q" defaultValue={sp.q} placeholder="番号・件名・お客様・現場住所で検索" /></div>
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
            <Th>受注番号</Th>
            <Th>お客様 / 件名</Th>
            <Th>店舗</Th>
            <Th>契約日</Th>
            <Th>施工予定</Th>
            <Th>施工担当</Th>
            <Th align="right">金額 (税込)</Th>
            <Th>状態</Th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <EmptyRow colSpan={8} />}
          {paged.items.map((o) => (
            <Tr key={o.id}>
              <Td className="font-mono text-xs"><Link href={`/orders/${o.id}`} className="text-accent hover:underline">{o.number}</Link></Td>
              <Td>
                <Link href={`/orders/${o.id}`} className="font-medium text-ink hover:text-accent">{customerName(o.customerId)} 様</Link>
                <div className="text-xs text-ink-2">{o.title} · {CATEGORY_LABEL[o.category]}</div>
              </Td>
              <Td><StoreTag store={storeMap.get(o.storeId)} short /></Td>
              <Td className="text-xs tnum">{fmtDate(o.contractDate)}</Td>
              <Td className="text-xs tnum">{o.scheduledStart ? `${fmtDate(o.scheduledStart)}${o.scheduledEnd && o.scheduledEnd !== o.scheduledStart ? `〜${fmtDate(o.scheduledEnd)}` : ""}` : <span className="text-ink-3">未定</span>}</Td>
              <Td className="text-xs text-ink-2">{o.workerIds.map((w) => userName(w)).join("・") || "-"}</Td>
              <Td align="right" className="font-medium">{yen(o.total)}</Td>
              <Td><StatusBadge value={o.status} map={ORDER_STATUS} /></Td>
            </Tr>
          ))}
        </tbody>
      </Table>
      <Pager paged={paged} path="/orders" sp={sp} />
    </div>
  );
}
