import type { Metadata } from "next";
import Link from "@/components/ui/Link";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canManagePurchaseOrders, canSeeAllStores, canViewPurchaseOrder } from "@/lib/auth/permissions";
import { PURCHASE_ORDER_STATUS } from "@/lib/constants";
import { normRef } from "@/lib/fax/numbers";
import type { PurchaseOrder, PurchaseOrderStatus } from "@/lib/db/types";
import { Button, Flash, Input, LinkButton, PageHeader, Pager, Select, Stat, paginate } from "@/components/ui";
import { PurchaseOrderTable } from "@/components/fax/FaxParts";

export const metadata: Metadata = { title: "発注書" };

type SP = Record<string, string | undefined>;

export default async function PurchaseOrdersPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const all = canSeeAllStores(user);
  const scoped = db.purchaseOrders.filter((p) => canViewPurchaseOrder(user, p));
  const status = sp.status && (sp.status === "open" || sp.status === "all" || PURCHASE_ORDER_STATUS[sp.status as PurchaseOrderStatus]) ? sp.status : "open";
  let rows: PurchaseOrder[] = scoped;
  if (status === "open") rows = rows.filter((p) => p.status === "draft" || p.status === "issued" || p.status === "sent");
  else if (status !== "all") rows = rows.filter((p) => p.status === status);
  if (sp.supplier) rows = rows.filter((p) => p.supplierId === sp.supplier);
  if (all && sp.store) rows = rows.filter((p) => p.storeId === sp.store);
  if (sp.user) rows = rows.filter((p) => p.createdBy === sp.user);
  if (sp.from) rows = rows.filter((p) => p.issuedOn >= sp.from!);
  if (sp.to) rows = rows.filter((p) => p.issuedOn <= sp.to!);
  const q = (sp.q ?? "").trim();
  if (q) {
    const n = normRef(q);
    const orders = new Map(db.orders.map((o) => [o.id, o]));
    const supplierNames = new Map(db.suppliers.map((s) => [s.id, s.name]));
    rows = rows.filter((p) =>
      normRef(p.number).includes(n) ||
      p.orderIds.some((id) => normRef(orders.get(id)?.number ?? "").includes(n)) ||
      (supplierNames.get(p.supplierId) ?? "").includes(q) ||
      p.lines.some((l) => l.name.includes(q) || (l.code ?? "").includes(q)),
    );
  }
  rows = [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const paged = paginate(rows, sp.page, 50);
  const count = (s: PurchaseOrderStatus) => scoped.filter((p) => p.status === s).length;
  const waiting = db.faxMessages.filter((f) => f.direction === "inbound" && f.purchaseOrderId && !f.checkedAt && scoped.some((p) => p.id === f.purchaseOrderId) && (f.triage === "auto" || f.triage === "accepted"));
  const creators = [...new Set(scoped.map((p) => p.createdBy))].map((id) => db.users.find((u) => u.id === id)).filter(Boolean);
  const base = "/purchase-orders";

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader
        title="発注書"
        description="仕入先への発注書を作り、PDF を確認して FAX で送ります。複数の案件の材料を 1 枚にまとめられます。仕入先からの返信 FAX は、発注番号で自動的にひも付きます"
        actions={
          <>
            <LinkButton href="/fax" variant="ghost">FAX 送受信</LinkButton>
            {canManagePurchaseOrders(user) && <LinkButton href="/purchase-orders/new">+ 発注書を作成</LinkButton>}
          </>
        }
      />
      <div className="mb-6 grid grid-cols-2 gap-3 @3xl:grid-cols-4">
        <Stat label="下書き" value={count("draft")} href={`${base}?status=draft`} />
        <Stat label="発行済み (送信待ち)" value={count("issued")} tone={count("issued") ? "warn" : undefined} href={`${base}?status=issued`} />
        <Stat label="送信済み (回答待ち)" value={count("sent")} href={`${base}?status=sent`} />
        <Stat label="未確認の返信 FAX" value={waiting.length} tone={waiting.length ? "warn" : undefined} href="/fax?tab=inbox&unchecked=1" />
      </div>
      <div className="mb-3 flex flex-wrap gap-1.5 text-xs">
        {[
          ["open", "進行中", scoped.filter((p) => ["draft", "issued", "sent"].includes(p.status)).length],
          ["draft", "下書き", count("draft")],
          ["issued", "発行済み", count("issued")],
          ["sent", "送信済み", count("sent")],
          ["completed", "完了", count("completed")],
          ["cancelled", "取消", count("cancelled")],
          ["all", "すべて", scoped.length],
        ].map(([k, label, n]) => (
          <Link key={k} href={`${base}?status=${k}`} className={`rounded-full border px-2.5 py-1 ${status === k ? "border-accent bg-accent-soft text-accent-ink" : "border-line text-ink-2 hover:bg-subtle"}`}>
            {label} <span className="tnum">{n}</span>
          </Link>
        ))}
      </div>
      <form method="get" className="mb-4 flex flex-wrap items-end gap-2">
        <input type="hidden" name="status" value={status} />
        <div className="w-full @xl:w-64"><Input name="q" defaultValue={sp.q} placeholder="発注番号・受注番号・仕入先・品名" aria-label="検索" /></div>
        <Select name="supplier" defaultValue={sp.supplier ?? ""} className="w-auto" aria-label="仕入先">
          <option value="">すべての仕入先</option>
          {db.suppliers.filter((s) => scoped.some((p) => p.supplierId === s.id)).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
        {all && (
          <Select name="store" defaultValue={sp.store ?? ""} className="w-auto" aria-label="店舗">
            <option value="">全店舗</option>
            {db.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        )}
        <Select name="user" defaultValue={sp.user ?? ""} className="w-auto" aria-label="作成した人">
          <option value="">作成した人 (全員)</option>
          {creators.map((u) => <option key={u!.id} value={u!.id}>{u!.name}</option>)}
        </Select>
        <Input type="date" name="from" defaultValue={sp.from} className="w-auto" aria-label="発注日 (から)" />
        <Input type="date" name="to" defaultValue={sp.to} className="w-auto" aria-label="発注日 (まで)" />
        <Button type="submit" variant="secondary">絞り込む</Button>
      </form>
      <PurchaseOrderTable db={db} user={user} rows={paged.items} empty="条件に合う発注書はありません" />
      <Pager paged={paged} path={base} sp={sp} />
    </div>
  );
}
