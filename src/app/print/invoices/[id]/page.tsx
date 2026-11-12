import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { syncDb } from "@/lib/db/store";
import { canAccessStore } from "@/lib/auth/permissions";
import { fmtDate, yen } from "@/lib/format";
import { PrintToolbar } from "@/components/features/PrintToolbar";
import { IchijoyaLogo } from "@/components/brand/Logo";

export const dynamic = "force-dynamic";

export default async function InvoicePrintPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const db = await syncDb();
  const inv = db.invoices.find((x) => x.id === id);
  if (!inv) notFound();
  if (!canAccessStore(user, inv.storeId)) redirect("/invoices");
  const customer = db.customers.find((c) => c.id === inv.customerId);
  const order = db.orders.find((o) => o.id === inv.orderId);
  const quote = order ? db.quotes.find((q) => q.id === order.quoteId) : undefined;
  const store = db.stores.find((s) => s.id === inv.storeId)!;

  return (
    <div className="min-h-screen bg-subtle py-6 print:bg-white print:py-0">
      <PrintToolbar backHref={`/invoices/${inv.id}`} />
      <div className="mx-auto w-[210mm] max-w-full bg-white px-[18mm] py-[16mm] text-[12px] text-ink shadow print:shadow-none">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-[0.4em]">御請求書</h1>
            <p className="mt-2 text-[11px] text-ink-2">請求番号: {inv.number}</p>
            <p className="text-[11px] text-ink-2">発行日: {fmtDate(inv.issueDate)} · お支払期限: {fmtDate(inv.dueDate)}</p>
          </div>
          <div className="text-right text-[11px] leading-relaxed">
            <IchijoyaLogo title="株式会社一畳屋" className="mb-2 ml-auto h-8 w-auto" />
            <div className="text-base font-semibold">株式会社一畳屋</div>
            <div>{store.name}</div>
            <div>〒{store.postalCode} {store.address}</div>
            <div>TEL {store.phone}</div>
            <div className="mt-1 text-ink-3">登録番号: T0000000000000 (サンプル)</div>
          </div>
        </div>
        <div className="mt-8 flex items-end justify-between border-b-2 border-ink pb-2">
          <div className="text-lg">{customer?.name} <span className="text-sm">{customer?.type === "corporate" ? "御中" : "様"}</span></div>
          <div className="text-[11px] text-ink-2">{customer?.address}</div>
        </div>
        <p className="mt-6">下記のとおりご請求申し上げます。</p>
        <div className="mt-3 text-sm">件名: {order?.title}</div>
        <div className="mt-3 inline-block border-b-2 border-ink px-2 pb-1 text-xl font-semibold tnum">御請求金額 {yen(inv.total)} <span className="text-xs font-normal">(税込)</span></div>
        <table className="mt-6 w-full border-collapse text-[12px]">
          <thead><tr className="border-y border-ink bg-subtle"><th className="px-2 py-1.5 text-left font-medium">品名</th><th className="px-2 py-1.5 text-right font-medium">数量</th><th className="px-2 py-1.5 text-right font-medium">単価</th><th className="px-2 py-1.5 text-right font-medium">金額</th></tr></thead>
          <tbody>
            {(quote?.items ?? [{ id: "x", name: order?.title ?? "工事一式", qty: 1, unit: "式", unitPrice: inv.subtotal, amount: inv.subtotal }]).map((i) => (
              <tr key={i.id} className="border-b border-line"><td className="px-2 py-1.5">{i.name}{"spec" in i && i.spec ? <span className="ml-1 text-ink-2">({i.spec})</span> : null}</td><td className="px-2 py-1.5 text-right tnum">{i.qty} {i.unit}</td><td className="px-2 py-1.5 text-right tnum">{yen(i.unitPrice)}</td><td className="px-2 py-1.5 text-right tnum">{yen(i.amount)}</td></tr>
            ))}
          </tbody>
          <tfoot>
            <tr><td colSpan={3} className="px-2 py-1 text-right">小計 (税抜)</td><td className="px-2 py-1 text-right tnum">{yen(inv.subtotal)}</td></tr>
            <tr><td colSpan={3} className="px-2 py-1 text-right">消費税 (10%)</td><td className="px-2 py-1 text-right tnum">{yen(inv.tax)}</td></tr>
            <tr className="border-t border-ink font-semibold"><td colSpan={3} className="px-2 py-1.5 text-right">合計 (税込)</td><td className="px-2 py-1.5 text-right tnum">{yen(inv.total)}</td></tr>
          </tfoot>
        </table>
        <div className="mt-6 rounded border border-line p-3 text-[11px] leading-relaxed">
          <div className="font-medium">お振込先</div>
          <div>○○銀行 △△支店 普通 0000000 カ) イチジョウヤ (サンプル)</div>
          <div className="text-ink-3">※ 振込手数料はお客様のご負担にてお願いいたします。現金・PayPay でのお支払いも承ります。</div>
        </div>
      </div>
    </div>
  );
}
