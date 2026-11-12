import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { syncDb } from "@/lib/db/store";
import { canAccessStore } from "@/lib/auth/permissions";
import { fmtDate, yen } from "@/lib/format";
import { PrintToolbar } from "@/components/features/PrintToolbar";
import { IchijoyaLogo } from "@/components/brand/Logo";

export const dynamic = "force-dynamic";

/** 社内所定書式の見積書 (印刷 / PDF 保存用) */
export default async function QuotePrintPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const db = await syncDb();
  const q = db.quotes.find((x) => x.id === id);
  if (!q) notFound();
  if (!canAccessStore(user, q.storeId)) redirect("/quotes");
  const customer = db.customers.find((c) => c.id === q.customerId);
  const store = db.stores.find((s) => s.id === q.storeId)!;
  const creator = db.users.find((u) => u.id === q.createdBy);

  return (
    <div className="min-h-screen bg-subtle py-6 print:bg-white print:py-0">
      <PrintToolbar backHref={`/quotes/${q.id}`} />
      <div className="mx-auto w-[210mm] max-w-full bg-white px-[18mm] py-[16mm] text-[12px] text-ink shadow print:shadow-none">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-[0.4em]">御見積書</h1>
            <p className="mt-2 text-[11px] text-ink-2">見積番号: {q.number}{q.version > 1 ? ` (改訂 v${q.version})` : ""}</p>
            <p className="text-[11px] text-ink-2">発行日: {fmtDate(q.issuedAt ?? q.createdAt)} · 有効期限: {fmtDate(q.validUntil)}</p>
          </div>
          <div className="text-right text-[11px] leading-relaxed">
            <IchijoyaLogo title="株式会社一畳屋" className="mb-2 ml-auto h-8 w-auto" />
            <div className="text-base font-semibold">株式会社一畳屋</div>
            <div>{store.name}</div>
            <div>〒{store.postalCode} {store.address}</div>
            <div>TEL {store.phone} / フリーダイヤル 0120-158-108</div>
            <div>担当: {creator?.name}</div>
          </div>
        </div>

        <div className="mt-8 flex items-end justify-between border-b-2 border-ink pb-2">
          <div className="text-lg">
            {customer?.name} <span className="text-sm">{customer?.type === "corporate" ? "御中" : "様"}</span>
          </div>
          <div className="text-[11px] text-ink-2">{customer?.address}</div>
        </div>

        <p className="mt-6">下記のとおりお見積り申し上げます。</p>
        <div className="mt-3 flex items-center gap-6">
          <div className="text-sm">件名: {q.title}</div>
        </div>
        <div className="mt-3 inline-block border-b-2 border-ink px-2 pb-1 text-xl font-semibold tnum">
          御見積金額 {yen(q.total)} <span className="text-xs font-normal">(税込)</span>
        </div>

        <table className="mt-6 w-full border-collapse text-[12px]">
          <thead>
            <tr className="border-y border-ink bg-subtle">
              <th className="px-2 py-1.5 text-left font-medium">品名</th>
              <th className="px-2 py-1.5 text-left font-medium">仕様</th>
              <th className="px-2 py-1.5 text-right font-medium">数量</th>
              <th className="px-2 py-1.5 text-left font-medium">単位</th>
              <th className="px-2 py-1.5 text-right font-medium">単価</th>
              <th className="px-2 py-1.5 text-right font-medium">金額</th>
            </tr>
          </thead>
          <tbody>
            {q.items.map((i) => (
              <tr key={i.id} className="border-b border-line">
                <td className="px-2 py-1.5">{i.name}</td>
                <td className="px-2 py-1.5 text-ink-2">{i.spec ?? ""}</td>
                <td className="px-2 py-1.5 text-right tnum">{i.qty}</td>
                <td className="px-2 py-1.5">{i.unit}</td>
                <td className="px-2 py-1.5 text-right tnum">{yen(i.unitPrice)}</td>
                <td className="px-2 py-1.5 text-right tnum">{yen(i.amount)}</td>
              </tr>
            ))}
            {Array.from({ length: Math.max(0, 8 - q.items.length) }).map((_, i) => (
              <tr key={`e${i}`} className="border-b border-line"><td className="px-2 py-1.5">&nbsp;</td><td /><td /><td /><td /><td /></tr>
            ))}
          </tbody>
          <tfoot>
            <tr><td colSpan={5} className="px-2 py-1 text-right">小計 (税抜)</td><td className="px-2 py-1 text-right tnum">{yen(q.subtotal)}</td></tr>
            {q.discount > 0 && <tr><td colSpan={5} className="px-2 py-1 text-right">値引き</td><td className="px-2 py-1 text-right tnum">-{yen(q.discount)}</td></tr>}
            <tr><td colSpan={5} className="px-2 py-1 text-right">消費税 (10%)</td><td className="px-2 py-1 text-right tnum">{yen(q.tax)}</td></tr>
            <tr className="border-t border-ink font-semibold"><td colSpan={5} className="px-2 py-1.5 text-right">合計 (税込)</td><td className="px-2 py-1.5 text-right tnum">{yen(q.total)}</td></tr>
          </tfoot>
        </table>

        <div className="mt-6 grid grid-cols-[1fr_auto] gap-6">
          <div className="text-[11px] leading-relaxed text-ink-2">
            <div className="font-medium text-ink">備考</div>
            <p className="whitespace-pre-wrap">{q.notes ?? "工賃・配送・消費税込みの価格です。規格外サイズや特殊品は別途お見積りいたします。土・祝日の工事もご予約にて承ります。"}</p>
          </div>
          <div className="flex gap-2">
            {["承認", "担当"].map((l) => (
              <div key={l} className="flex h-16 w-16 flex-col items-center justify-start rounded border border-ink-3 text-[10px] text-ink-3"><span className="w-full border-b border-ink-3 py-0.5 text-center">{l}</span><span className="mt-2 text-ink">{l === "担当" ? creator?.name?.split(" ")[0] : q.approvedBy ? db.users.find((u) => u.id === q.approvedBy)?.name.split(" ")[0] : ""}</span></div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
