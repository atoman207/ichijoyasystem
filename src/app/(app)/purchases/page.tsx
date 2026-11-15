import Link from "@/components/ui/Link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canManageFinance, canRegisterPurchase, canViewPurchase } from "@/lib/auth/permissions";
import { supplierName } from "@/lib/db/queries";
import { addDays, fmtDate, fmtMonth, toDateKey, yen } from "@/lib/format";
import { PURCHASE_STATUS, SUPPLIER_KIND_LABEL } from "@/lib/constants";
import { isOpenPurchase, payDateOf, supplierKindOf, termsLabel } from "@/lib/suppliers";
import type { PurchaseInvoice, PurchaseStatus } from "@/lib/db/types";
import { Badge, Button, EmptyRow, Flash, Input, LinkButton, LinkTabs, PageHeader, Pager, Select, Stat, StatusBadge, StoreTag, Table, Td, Th, Tr, paginate } from "@/components/ui";

export default async function PurchasesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  if (!canRegisterPurchase(user)) redirect("/?err=" + encodeURIComponent("仕入・買掛は店長・本部・管理者が閲覧できます。"));
  // 取込書類からの登録は登録画面へ
  if (sp.documentId) redirect(`/purchases/new?documentId=${encodeURIComponent(sp.documentId)}`);
  const db = getDb();
  const finance = canManageFinance(user);
  const today = toDateKey(new Date());
  const scoped = db.purchases.filter((p) => canViewPurchase(user, p));
  const view = sp.view === "suppliers" || sp.view === "schedule" ? sp.view : "list";
  const status = sp.status ?? "open";
  let rows: PurchaseInvoice[] = scoped;
  if (status === "open") rows = rows.filter(isOpenPurchase);
  else if (status !== "all" && PURCHASE_STATUS[status as PurchaseStatus]) rows = rows.filter((p) => p.status === status);
  if (sp.supplier) rows = rows.filter((p) => p.supplierId === sp.supplier);
  if (finance && sp.store) rows = rows.filter((p) => p.storeId === sp.store);
  const q = (sp.q ?? "").trim().toLowerCase();
  if (q) rows = rows.filter((p) => [p.number, supplierName(p.supplierId), p.description, p.supplierInvoiceNo ?? ""].join(" ").toLowerCase().includes(q));
  rows = [...rows].sort((a, b) => payDateOf(a).localeCompare(payDateOf(b)));
  const paged = paginate(rows, sp.page);
  const open = scoped.filter(isOpenPurchase);
  const payable = open.reduce((a, p) => a + p.amount, 0);
  const dueSoon = open.filter((p) => payDateOf(p) <= addDays(today, 14));
  const overdue = open.filter((p) => payDateOf(p) < today);
  const paidThisMonth = scoped.filter((p) => p.status === "paid" && p.paidAt?.startsWith(today.slice(0, 7))).reduce((a, p) => a + p.amount, 0);
  const storeMap = new Map(db.stores.map((s) => [s.id, s]));
  const count = (s: PurchaseStatus) => scoped.filter((p) => p.status === s).length;
  const base = "/purchases";

  // 仕入先別の買掛金残高
  const bySupplier = new Map<string, { open: number; count: number; overdue: number; next?: string; paidYtd: number }>();
  for (const p of scoped) {
    const r = bySupplier.get(p.supplierId) ?? { open: 0, count: 0, overdue: 0, paidYtd: 0 };
    if (isOpenPurchase(p)) {
      r.open += p.amount;
      r.count += 1;
      if (payDateOf(p) < today) r.overdue += p.amount;
      if (!r.next || payDateOf(p) < r.next) r.next = payDateOf(p);
    }
    if (p.status === "paid" && p.paidAt?.startsWith(today.slice(0, 4))) r.paidYtd += p.amount;
    bySupplier.set(p.supplierId, r);
  }
  const supplierRows = [...bySupplier.entries()].map(([id, r]) => ({ s: db.suppliers.find((x) => x.id === id), id, ...r })).sort((a, b) => b.open - a.open);

  // 支払予定 (未払を支払予定日の月・日ごとに)
  const schedule = new Map<string, Map<string, PurchaseInvoice[]>>();
  for (const p of [...open].sort((a, b) => payDateOf(a).localeCompare(payDateOf(b)))) {
    const d = payDateOf(p);
    const m = schedule.get(d.slice(0, 7)) ?? new Map<string, PurchaseInvoice[]>();
    m.set(d, [...(m.get(d) ?? []), p]);
    schedule.set(d.slice(0, 7), m);
  }

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader
        title="仕入・買掛管理"
        description={finance ? "仕入先・協力業者の請求書 (仕入内容) を登録し、支払依頼 → 管理者の承認 → 支払完了 まで管理します" : "自店舗の仕入請求書を登録し、本部へ支払依頼します"}
        actions={
          <>
            <LinkButton href="/suppliers" variant="ghost">仕入先・協力業者</LinkButton>
            <LinkButton href="/capture?kind=supplier_invoice" variant="secondary">請求書を撮影・取込</LinkButton>
            <LinkButton href="/purchases/new">+ 仕入請求書を登録</LinkButton>
          </>
        }
      />
      <div className="mb-6 grid grid-cols-2 gap-3 @3xl:grid-cols-4">
        <Stat label="買掛金残高 (未払)" value={yen(payable)} sub={`${open.length} 件`} href={`${base}?status=open`} />
        <Stat label="14 日以内の支払予定" value={yen(dueSoon.reduce((a, p) => a + p.amount, 0))} sub={`${dueSoon.length} 件`} tone={dueSoon.length ? "warn" : undefined} href={`${base}?view=schedule`} />
        <Stat label="支払予定日を過ぎた未払" value={yen(overdue.reduce((a, p) => a + p.amount, 0))} sub={`${overdue.length} 件`} tone={overdue.length ? "critical" : undefined} />
        <Stat label="今月の支払額" value={yen(paidThisMonth)} />
      </div>
      <LinkTabs
        current={`${base}?view=${view}`}
        items={[
          { href: `${base}?view=list`, label: "請求書の一覧" },
          { href: `${base}?view=suppliers`, label: "仕入先別の買掛金" },
          { href: `${base}?view=schedule`, label: "支払予定" },
        ]}
      />

      {view === "list" && (
        <>
          <div className="mb-3 flex flex-wrap gap-1.5 text-xs">
            {[
              ["open", "未払", open.length],
              ["received", "受領 (支払依頼前)", count("received")],
              ["pending_approval", "支払依頼中", count("pending_approval")],
              ["approved", "支払待ち", count("approved")],
              ["disputed", "差戻し (照会中)", count("disputed")],
              ["paid", "支払完了", count("paid")],
              ["rejected", "支払却下", count("rejected")],
              ["all", "すべて", scoped.length],
            ].map(([k, label, n]) => (
              <Link key={k} href={`${base}?view=list&status=${k}`} className={`rounded-full border px-2.5 py-1 ${status === k ? "border-accent bg-accent-soft text-accent-ink" : "border-line text-ink-2 hover:bg-subtle"}`}>
                {label} <span className="tnum">{n}</span>
              </Link>
            ))}
          </div>
          <form method="get" className="mb-4 flex flex-wrap items-end gap-2">
            <input type="hidden" name="view" value="list" />
            <input type="hidden" name="status" value={status} />
            <div className="w-full @xl:w-56"><Input name="q" defaultValue={sp.q} placeholder="番号・仕入先・内容で検索" /></div>
            <Select name="supplier" defaultValue={sp.supplier ?? ""} className="w-auto" aria-label="仕入先">
              <option value="">すべての仕入先</option>
              {db.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
            {finance && (
              <Select name="store" defaultValue={sp.store ?? ""} className="w-auto" aria-label="店舗">
                <option value="">全店舗</option>
                {db.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            )}
            <Button type="submit" variant="secondary">絞り込む</Button>
          </form>
          <Table minWidth="min-w-[760px]">
            <thead>
              <tr>
                <Th>番号</Th>
                <Th>仕入先 / 内容</Th>
                <Th>店舗</Th>
                <Th>請求日</Th>
                <Th>支払予定日</Th>
                <Th align="right">金額 (税込)</Th>
                <Th>状態</Th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <EmptyRow colSpan={7} />}
              {paged.items.map((p) => (
                <Tr key={p.id}>
                  <Td className="font-mono text-xs"><Link href={`/purchases/${p.id}`} className="text-accent hover:underline">{p.number}</Link></Td>
                  <Td>
                    <Link href={`/purchases/${p.id}`} className="font-medium text-ink hover:text-accent">{supplierName(p.supplierId)}</Link>
                    <div className="flex flex-wrap items-center gap-1 text-xs text-ink-3">{p.description}{p.items?.length ? <span>(明細 {p.items.length} 行)</span> : null}{p.source === "ocr" && <Badge tone="accent" dot={false}>取込</Badge>}</div>
                  </Td>
                  <Td><StoreTag store={storeMap.get(p.storeId)} short /></Td>
                  <Td className="text-xs tnum">{fmtDate(p.invoiceDate)}</Td>
                  <Td className={`text-xs tnum ${isOpenPurchase(p) && payDateOf(p) < today ? "font-medium text-critical" : ""}`}>{fmtDate(payDateOf(p))}{p.scheduledPayDate && p.scheduledPayDate !== p.dueDate ? <div className="text-[10px] text-ink-3">期限 {fmtDate(p.dueDate)}</div> : null}</Td>
                  <Td align="right" className="font-medium">{yen(p.amount)}</Td>
                  <Td><StatusBadge value={p.status} map={PURCHASE_STATUS} /></Td>
                </Tr>
              ))}
            </tbody>
          </Table>
          <Pager paged={paged} path={base} sp={sp} />
        </>
      )}

      {view === "suppliers" && (
        <Table minWidth="min-w-[720px]">
          <thead>
            <tr>
              <Th>仕入先・協力業者</Th>
              <Th>支払条件</Th>
              <Th align="right">未払 (件数)</Th>
              <Th align="right">うち支払予定日を過ぎた額</Th>
              <Th>次の支払予定日</Th>
              <Th align="right">今年の支払額</Th>
            </tr>
          </thead>
          <tbody>
            {supplierRows.length === 0 && <EmptyRow colSpan={6} />}
            {supplierRows.map((r) => (
              <Tr key={r.id}>
                <Td>
                  <Link href={`/suppliers/${r.id}`} className="font-medium text-ink hover:text-accent">{r.s?.name ?? "-"}</Link>
                  <div className="text-[11px] text-ink-3">{SUPPLIER_KIND_LABEL[supplierKindOf(r.s)]} · {r.s?.category}</div>
                </Td>
                <Td className="text-xs text-ink-2">{termsLabel(r.s)}</Td>
                <Td align="right" className="font-medium"><Link href={`${base}?view=list&status=open&supplier=${r.id}`} className="hover:text-accent">{yen(r.open)} ({r.count})</Link></Td>
                <Td align="right" className={r.overdue ? "font-medium text-critical" : "text-ink-3"}>{yen(r.overdue)}</Td>
                <Td className="text-xs tnum">{r.next ? fmtDate(r.next) : "-"}</Td>
                <Td align="right" className="text-ink-2">{yen(r.paidYtd)}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}

      {view === "schedule" && (
        <div className="space-y-4">
          {schedule.size === 0 && <p className="rounded-xl border border-line bg-panel px-4 py-8 text-center text-sm text-ink-3">未払の請求書はありません</p>}
          {[...schedule.entries()].map(([month, days]) => {
            const all = [...days.values()].flat();
            return (
              <div key={month} className="rounded-xl border border-line bg-panel">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2">
                  <span className="text-sm font-medium text-ink">{fmtMonth(month)}</span>
                  <span className="text-sm tnum">{all.length} 件 · <span className="font-semibold">{yen(all.reduce((a, p) => a + p.amount, 0))}</span></span>
                </div>
                <ul className="divide-y divide-line">
                  {[...days.entries()].map(([day, list]) => (
                    <li key={day} className="px-4 py-2">
                      <div className={`text-xs font-medium ${day < today ? "text-critical" : "text-ink-2"}`}>{fmtDate(day)}{day < today ? " (予定日を過ぎています)" : ""} · {yen(list.reduce((a, p) => a + p.amount, 0))}</div>
                      <ul className="mt-1 space-y-0.5 text-xs">
                        {list.map((p) => (
                          <li key={p.id} className="flex flex-wrap items-center gap-2">
                            <Link href={`/purchases/${p.id}`} className="font-mono text-accent hover:underline">{p.number}</Link>
                            <span className="text-ink">{supplierName(p.supplierId)}</span>
                            <span className="tnum">{yen(p.amount)}</span>
                            <StatusBadge value={p.status} map={PURCHASE_STATUS} />
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
