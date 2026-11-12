import Link from "@/components/ui/Link";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canSeeAllStores, scopeByStore } from "@/lib/auth/permissions";
import { customerName, userName } from "@/lib/db/queries";
import { fmtDate, yen } from "@/lib/format";
import { CATEGORY_LABEL, QUOTE_STATUS } from "@/lib/constants";
import type { QuoteStatus } from "@/lib/db/types";
import { Badge, Button, EmptyRow, Flash, Input, LinkButton, LinkTabs, PageHeader, Select, StatusBadge, StoreTag, Table, Td, Th, Tr, Pager, paginate } from "@/components/ui";

export default async function QuotesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const allStores = canSeeAllStores(user);
  const scoped = scopeByStore(user, db.quotes);
  const status = sp.status as QuoteStatus | "open" | undefined;
  let rows = scoped;
  if (status === "open") rows = rows.filter((q) => ["draft", "pending_approval", "approved", "sent"].includes(q.status));
  else if (status && QUOTE_STATUS[status as QuoteStatus]) rows = rows.filter((q) => q.status === status);
  if (allStores && sp.store) rows = rows.filter((q) => q.storeId === sp.store);
  const q = (sp.q ?? "").trim().toLowerCase();
  if (q) rows = rows.filter((x) => [x.number, x.title, customerName(x.customerId)].join(" ").toLowerCase().includes(q));
  rows = [...rows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const paged = paginate(rows, sp.page);
  const storeMap = new Map(db.stores.map((s) => [s.id, s]));
  const count = (s: QuoteStatus) => scoped.filter((x) => x.status === s).length;
  const base = "/quotes";
  const current = status ? `${base}?status=${status}` : base;
  const sum = rows.reduce((a, x) => a + x.total, 0);

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader title="見積" description={`${rows.length} 件 · 合計 ${yen(sum)}`} actions={<><LinkButton href="/capture?kind=handwritten_quote" variant="secondary">手書き見積を取り込む</LinkButton><LinkButton href="/quotes/new">+ 見積を作成</LinkButton></>} />
      <LinkTabs
        current={current}
        items={[
          { href: base, label: "すべて", count: scoped.length },
          { href: `${base}?status=draft`, label: "下書き", count: count("draft") },
          { href: `${base}?status=pending_approval`, label: "承認待ち", count: count("pending_approval") },
          { href: `${base}?status=approved`, label: "承認済", count: count("approved") },
          { href: `${base}?status=sent`, label: "送付済", count: count("sent") },
          { href: `${base}?status=accepted`, label: "受注", count: count("accepted") },
          { href: `${base}?status=rejected`, label: "失注", count: count("rejected") },
        ]}
      />
      <form method="get" className="mb-4 flex flex-wrap items-end gap-2">
        {status && <input type="hidden" name="status" value={status} />}
        <div className="w-full @xl:w-64"><Input name="q" defaultValue={sp.q} placeholder="番号・件名・お客様名で検索" /></div>
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
            <Th>見積番号</Th>
            <Th>お客様</Th>
            <Th>件名</Th>
            <Th>店舗</Th>
            <Th align="right">合計 (税込)</Th>
            <Th>状態</Th>
            <Th>作成者</Th>
            <Th>有効期限</Th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <EmptyRow colSpan={8} />}
          {paged.items.map((x) => (
            <Tr key={x.id}>
              <Td className="font-mono text-xs">
                <Link href={`/quotes/${x.id}`} className="text-accent hover:underline">{x.number}</Link>
                {x.version > 1 && <span className="ml-1 text-ink-3">v{x.version}</span>}
                <div className="text-[10px] text-ink-3">{fmtDate(x.createdAt)}</div>
              </Td>
              <Td><Link href={`/customers/${x.customerId}`} className="hover:text-accent">{customerName(x.customerId)}</Link></Td>
              <Td>
                <Link href={`/quotes/${x.id}`} className="font-medium text-ink hover:text-accent">{x.title}</Link>
                <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px] text-ink-3">
                  {CATEGORY_LABEL[x.category]}
                  {x.source === "ocr" && <Badge tone="accent" dot={false}>手書き取込</Badge>}
                  {x.pendingChange && <Badge tone="warn" dot={false}>変更申請中</Badge>}
                </div>
              </Td>
              <Td><StoreTag store={storeMap.get(x.storeId)} short /></Td>
              <Td align="right" className="font-medium">{yen(x.total)}</Td>
              <Td><StatusBadge value={x.status} map={QUOTE_STATUS} /></Td>
              <Td className="text-xs text-ink-2">{userName(x.createdBy)}</Td>
              <Td className="text-xs text-ink-2 tnum">{fmtDate(x.validUntil)}</Td>
            </Tr>
          ))}
        </tbody>
      </Table>
      <Pager paged={paged} path="/quotes" sp={sp} />
    </div>
  );
}
