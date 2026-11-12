import Link from "@/components/ui/Link";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canSeeAllStores, scopeByStore } from "@/lib/auth/permissions";
import { userName } from "@/lib/db/queries";
import { fmtDate, yen } from "@/lib/format";
import { CHANNEL_LABEL } from "@/lib/constants";
import { Badge, Button, EmptyRow, Flash, Input, LinkButton, PageHeader, Select, StoreTag, Table, Td, Th, Tr, Pager, paginate } from "@/components/ui";

export default async function CustomersPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const q = (sp.q ?? "").trim().toLowerCase();
  const allStores = canSeeAllStores(user);
  let rows = scopeByStore(user, db.customers);
  if (allStores && sp.store) rows = rows.filter((c) => c.storeId === sp.store);
  if (sp.type) rows = rows.filter((c) => c.type === sp.type);
  if (q) rows = rows.filter((c) => [c.name, c.kana, c.phone, c.address, c.code, c.email ?? "", ...c.tags].join(" ").toLowerCase().includes(q));
  rows = [...rows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const paged = paginate(rows, sp.page);
  const storeMap = new Map(db.stores.map((s) => [s.id, s]));
  const stats = new Map<string, { orders: number; lifetime: number; last?: string }>();
  for (const o of db.orders) {
    const s = stats.get(o.customerId) ?? { orders: 0, lifetime: 0 };
    if (o.status !== "cancelled") s.orders += 1;
    if (o.salesDate) s.lifetime += o.total;
    stats.set(o.customerId, s);
  }
  for (const c of db.commLogs) {
    const s = stats.get(c.customerId) ?? { orders: 0, lifetime: 0 };
    if (!s.last || c.at > s.last) s.last = c.at;
    stats.set(c.customerId, s);
  }

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader title="顧客" description={`${rows.length} 件`} actions={<LinkButton href="/customers/new">+ 顧客を登録</LinkButton>} />
      <form method="get" className="mb-4 flex flex-wrap items-end gap-2">
        <div className="w-full @xl:w-72">
          <Input name="q" defaultValue={sp.q} placeholder="氏名・フリガナ・電話・住所・タグで検索" />
        </div>
        {allStores && (
          <Select name="store" defaultValue={sp.store ?? ""} className="w-auto">
            <option value="">全店舗</option>
            {db.stores.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </Select>
        )}
        <Select name="type" defaultValue={sp.type ?? ""} className="w-auto">
          <option value="">個人・法人</option>
          <option value="individual">個人</option>
          <option value="corporate">法人・施設</option>
        </Select>
        <Button type="submit" variant="secondary">絞り込む</Button>
        {(sp.q || sp.store || sp.type) && (
          <Link href="/customers" className="text-xs text-ink-3 hover:text-ink">クリア</Link>
        )}
      </form>
      <Table>
        <thead>
          <tr>
            <Th>顧客コード</Th>
            <Th>氏名 / 会社名</Th>
            <Th>連絡先</Th>
            <Th>担当店舗</Th>
            <Th>担当者</Th>
            <Th align="right">案件数</Th>
            <Th align="right">累計売上</Th>
            <Th>最終対応</Th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <EmptyRow colSpan={8} />}
          {paged.items.map((c) => {
            const s = stats.get(c.id);
            return (
              <Tr key={c.id}>
                <Td className="font-mono text-xs text-ink-2">{c.code}</Td>
                <Td>
                  <Link href={`/customers/${c.id}`} className="font-medium text-ink hover:text-accent">{c.name}</Link>
                  <div className="text-[11px] text-ink-3">{c.kana}</div>
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    {c.type === "corporate" && <Badge tone="info" dot={false}>法人</Badge>}
                    {c.tags.slice(0, 3).map((t) => (
                      <Badge key={t} dot={false}>{t}</Badge>
                    ))}
                  </div>
                </Td>
                <Td>
                  <div className="text-sm">{c.phone}</div>
                  <div className="text-[11px] text-ink-3">{CHANNEL_LABEL[c.preferredChannel]}希望{c.lineId ? " · LINE" : ""}</div>
                </Td>
                <Td><StoreTag store={storeMap.get(c.storeId)} /></Td>
                <Td className="text-ink-2">{userName(c.assignedUserId)}</Td>
                <Td align="right">{s?.orders ?? 0}</Td>
                <Td align="right">{yen(s?.lifetime ?? 0)}</Td>
                <Td className="text-xs text-ink-2">{fmtDate(s?.last ?? c.updatedAt)}</Td>
              </Tr>
            );
          })}
        </tbody>
      </Table>
      <Pager paged={paged} path="/customers" sp={sp} />
    </div>
  );
}
