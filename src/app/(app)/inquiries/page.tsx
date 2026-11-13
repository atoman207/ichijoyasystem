import Link from "@/components/ui/Link";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canImportData, canSeeAllStores, scopeByStore } from "@/lib/auth/permissions";
import { userName } from "@/lib/db/queries";
import { fmtDate, fmtDateTime, toDateKey } from "@/lib/format";
import { CATEGORY_LABEL, CHANNEL_LABEL, INQUIRY_STATUS } from "@/lib/constants";
import type { InquiryStatus } from "@/lib/db/types";
import { Button, ChannelTag, EmptyRow, Flash, Input, LinkButton, LinkTabs, PageHeader, Select, StatusBadge, StoreTag, Table, Td, Th, Tr, Pager, paginate } from "@/components/ui";

export default async function InquiriesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const allStores = canSeeAllStores(user);
  const today = toDateKey(new Date());
  const scoped = scopeByStore(user, db.inquiries);
  const status = sp.status as InquiryStatus | "open" | undefined;
  let rows = scoped;
  if (status === "open") rows = rows.filter((i) => i.status === "new" || i.status === "in_progress" || i.status === "quoted");
  else if (status && INQUIRY_STATUS[status as InquiryStatus]) rows = rows.filter((i) => i.status === status);
  if (sp.channel) rows = rows.filter((i) => i.channel === sp.channel);
  if (allStores && sp.store) rows = rows.filter((i) => i.storeId === sp.store);
  const q = (sp.q ?? "").trim().toLowerCase();
  if (q) rows = rows.filter((i) => [i.number, i.contactName, i.summary, i.detail].join(" ").toLowerCase().includes(q));
  rows = [...rows].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  const paged = paginate(rows, sp.page);
  const storeMap = new Map(db.stores.map((s) => [s.id, s]));
  const count = (f: (s: InquiryStatus) => boolean) => scoped.filter((i) => f(i.status)).length;
  const base = "/inquiries";
  const current = status ? `${base}?status=${status}` : base;

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader title="問い合わせ" actions={<>{canImportData(user) && <LinkButton href="/data" variant="secondary">CSV 取込・書き出し</LinkButton>}<LinkButton href="/inquiries/new">+ 問い合わせを登録</LinkButton></>} />
      <LinkTabs
        current={current}
        items={[
          { href: base, label: "すべて", count: scoped.length },
          { href: `${base}?status=new`, label: "未対応", count: count((s) => s === "new") },
          { href: `${base}?status=in_progress`, label: "対応中", count: count((s) => s === "in_progress") },
          { href: `${base}?status=quoted`, label: "見積提出済", count: count((s) => s === "quoted") },
          { href: `${base}?status=won`, label: "受注", count: count((s) => s === "won") },
          { href: `${base}?status=lost`, label: "失注", count: count((s) => s === "lost") },
        ]}
      />
      <form method="get" className="mb-4 flex flex-wrap items-end gap-2">
        {status && <input type="hidden" name="status" value={status} />}
        <div className="w-full @xl:w-64"><Input name="q" defaultValue={sp.q} placeholder="番号・お客様名・内容で検索" /></div>
        <Select name="channel" defaultValue={sp.channel ?? ""} className="w-auto">
          <option value="">すべての入口</option>
          {(Object.keys(CHANNEL_LABEL) as (keyof typeof CHANNEL_LABEL)[]).map((c) => (
            <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>
          ))}
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
            <Th>受付日時</Th>
            <Th>入口</Th>
            <Th>お客様</Th>
            <Th>内容</Th>
            <Th>種別</Th>
            <Th>店舗</Th>
            <Th>担当</Th>
            <Th>状態</Th>
            <Th>次のアクション</Th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <EmptyRow colSpan={9} />}
          {paged.items.map((i) => {
            const overdue = i.nextActionDue && i.nextActionDue < today && ["new", "in_progress"].includes(i.status);
            return (
              <Tr key={i.id}>
                <Td className="text-xs text-ink-2 tnum">{fmtDateTime(i.receivedAt)}<div className="font-mono text-[10px] text-ink-3">{i.number}</div></Td>
                <Td><ChannelTag channel={i.channel} /></Td>
                <Td>
                  {i.customerId ? <Link href={`/customers/${i.customerId}`} className="hover:text-accent">{i.contactName}</Link> : <span>{i.contactName} <span className="text-[10px] text-ink-3">(未登録)</span></span>}
                </Td>
                <Td><Link href={`/inquiries/${i.id}`} className="font-medium text-ink hover:text-accent">{i.summary}</Link></Td>
                <Td className="text-xs text-ink-2">{CATEGORY_LABEL[i.category]}</Td>
                <Td><StoreTag store={storeMap.get(i.storeId)} short /></Td>
                <Td className="text-xs text-ink-2">{userName(i.assignedUserId)}</Td>
                <Td><StatusBadge value={i.status} map={INQUIRY_STATUS} /></Td>
                <Td className="text-xs">
                  {i.nextAction ? (
                    <span className={overdue ? "text-critical" : "text-ink-2"}>{i.nextAction}{i.nextActionDue && <span className="ml-1 tnum">({fmtDate(i.nextActionDue)}{overdue ? " 期限超過" : ""})</span>}</span>
                  ) : (
                    <span className="text-ink-3">-</span>
                  )}
                </Td>
              </Tr>
            );
          })}
        </tbody>
      </Table>
      <Pager paged={paged} path="/inquiries" sp={sp} />
    </div>
  );
}
