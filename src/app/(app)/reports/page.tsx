import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canSeeAllStores, canViewReports, scopeByStore } from "@/lib/auth/permissions";
import { categorySales, channelCounts, monthlySales, staffPerformance, storeKpis } from "@/lib/db/queries";
import { fmtMonth, fmtShortMonth, pct, toDateKey, yen } from "@/lib/format";
import { CATEGORY_LABEL, CHANNEL_LABEL, ROLE_LABEL } from "@/lib/constants";
import type { ServiceCategory, Channel, StoreId } from "@/lib/db/types";
import { BarList, StackedBarChart } from "@/components/charts";
import { Card, CardHeader, LinkButton, LinkTabs, PageHeader, Stat, StoreTag } from "@/components/ui";

export default async function ReportsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  if (!canViewReports(user)) redirect("/?err=" + encodeURIComponent("レポートは店長・本部・管理者が閲覧できます。"));
  const db = getDb();
  const now = new Date();
  const months = [3, 6, 12].includes(Number(sp.months)) ? Number(sp.months) : 12;
  const allStores = canSeeAllStores(user);
  const storeFilter = (allStores ? (sp.store as StoreId | undefined) : user.storeId) ?? undefined;
  const stores = storeFilter ? db.stores.filter((s) => s.id === storeFilter) : db.stores;
  const scopedDb = storeFilter ? { ...db, orders: db.orders.filter((o) => o.storeId === storeFilter), inquiries: db.inquiries.filter((i) => i.storeId === storeFilter), quotes: db.quotes.filter((q) => q.storeId === storeFilter) } : db;
  const sales = monthlySales(scopedDb, months, now);
  const series = stores.map((s) => ({ key: s.id, label: s.name, color: s.color }));
  const chartData = sales.map((m) => ({ label: fmtShortMonth(m.month), fullLabel: fmtMonth(m.month), values: m.byStore as unknown as Record<string, number> }));
  const periodTotal = sales.reduce((a, m) => a + m.total, 0);
  const cats = categorySales(scopedDb, months, now);
  const channels = channelCounts(scopedDb, months * 30, now);
  const staff = staffPerformance(scopedDb, months, now).filter((r) => !storeFilter || r.user.storeId === storeFilter);
  const kpis = storeKpis(db, now).filter((k) => !storeFilter || k.storeId === storeFilter);
  const from = toDateKey(new Date(now.getFullYear(), now.getMonth() - (months - 1), 1));
  const inqs = scopeByStore(user, scopedDb.inquiries).filter((i) => i.receivedAt.slice(0, 10) >= from);
  const quotes = scopeByStore(user, scopedDb.quotes).filter((q) => q.createdAt.slice(0, 10) >= from);
  const orders = scopeByStore(user, scopedDb.orders).filter((o) => o.contractDate >= from && o.status !== "cancelled");
  const avgOrder = orders.length ? orders.reduce((a, o) => a + o.total, 0) / orders.length : 0;
  // お客様アンケート (選択期間)
  const svFrom = toDateKey(new Date(new Date().getFullYear(), new Date().getMonth() - (months - 1), 1));
  const svStores = (allStores ? db.stores : db.stores.filter((st) => st.id === user.storeId)).filter((st) => !storeFilter || st.id === storeFilter);
  const avg = (xs: (number | undefined)[]) => { const v = xs.filter((x): x is number => typeof x === "number"); return v.length ? (v.reduce((a, x) => a + x, 0) / v.length).toFixed(2) : "-"; };
  const surveyRows = svStores.map((st) => { const list = db.surveys.filter((x) => x.storeId === st.id && x.receivedAt.slice(0, 10) >= svFrom); return { store: st, n: list.length, phone: avg(list.map((x) => x.phoneScore)), sales: avg(list.map((x) => x.salesScore)), craft: avg(list.map((x) => x.craftsmanScore)), finish: avg(list.map((x) => x.finishScore)), again: list.filter((x) => x.wouldUseAgain).length ? Math.round((100 * list.filter((x) => /はい/.test(x.wouldUseAgain ?? "")).length) / list.filter((x) => x.wouldUseAgain).length) : null }; }).filter((r) => r.n > 0);
  const base = `/reports?${storeFilter && allStores ? `store=${storeFilter}&` : ""}`;

  return (
    <div>
      <PageHeader title="レポート・分析" actions={allStores && <LinkButton href="/api/export?type=sales" variant="secondary" size="sm" download>月次売上 CSV</LinkButton>} />
      <div className="flex flex-wrap items-center gap-3">
        <LinkTabs current={`${base}months=${months}`} items={[{ href: `${base}months=3`, label: "直近3か月" }, { href: `${base}months=6`, label: "直近6か月" }, { href: `${base}months=12`, label: "直近12か月" }]} />
        {allStores && (
          <form method="get" className="mb-4 flex items-center gap-2 text-sm">
            <input type="hidden" name="months" value={months} />
            <select name="store" defaultValue={storeFilter ?? ""} className="field w-auto">
              <option value="">全店舗</option>
              {db.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <button type="submit" className="shrink-0 rounded-lg border border-line bg-panel px-3 py-2 text-sm whitespace-nowrap shadow-xs hover:bg-subtle">適用</button>
          </form>
        )}
      </div>

      <div className="mb-6 grid grid-cols-1 gap-3 @md:grid-cols-2 @2xl:grid-cols-3 @5xl:grid-cols-5">
        <Stat label={`期間売上 (${months}か月)`} value={yen(periodTotal)} sub={`月平均 ${yen(periodTotal / months)}`} />
        <Stat label="問い合わせ → 見積 → 受注" value={<span className="text-xl whitespace-nowrap">{`${inqs.length} → ${quotes.length} → ${orders.length}`}</span>} sub={`見積化率 ${inqs.length ? pct(quotes.length / inqs.length) : "-"} · 成約率 ${quotes.length ? pct(orders.length / quotes.length) : "-"}`} />
        <Stat label="平均受注単価" value={yen(avgOrder)} />
        <Stat label="売掛残高" value={yen(kpis.reduce((a, k) => a + k.receivables, 0))} sub={`期日超過 ${yen(kpis.reduce((a, k) => a + k.overdue, 0))}`} />
        <Stat label="進行中の施工" value={`${kpis.reduce((a, k) => a + k.activeJobs, 0)} 件`} />
      </div>

      <Card className="mb-4">
        <CardHeader title="月次売上推移 (店舗別・税込)" description="施工完了 (売上計上日) ベース" />
        <StackedBarChart data={chartData} series={series} height={260} title="月次売上推移" />
      </Card>

      <div className="mb-4 grid grid-cols-1 gap-4 @4xl:grid-cols-3">
        <Card>
          <CardHeader title="種別別の売上" description={`直近 ${months} か月`} />
          <BarList items={cats.map(([c, v]) => ({ label: CATEGORY_LABEL[c as ServiceCategory] ?? c, value: v }))} unit="yen" color="#4a5ae8" title="種別別の売上" />
        </Card>
        <Card>
          <CardHeader title="問い合わせの入口別件数" description="どの接点からの問い合わせが多いか" />
          <BarList items={channels.map(([c, v]) => ({ label: CHANNEL_LABEL[c as Channel] ?? c, value: v }))} unit="count" color="#2a78d6" title="問い合わせの入口別件数" />
        </Card>
        <Card>
          <CardHeader title="店舗別 成約率・単価" />
          <ul className="space-y-2 text-sm">
            {kpis.map((k) => {
              const so = orders.filter((o) => o.storeId === k.storeId);
              const avg = so.length ? so.reduce((a, o) => a + o.total, 0) / so.length : 0;
              return (
                <li key={k.storeId} className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-0.5 border-b border-line pb-2 last:border-b-0 last:pb-0">
                  <StoreTag store={db.stores.find((s) => s.id === k.storeId)} short />
                  <span className="text-right text-xs whitespace-nowrap text-ink-2">成約率 <span className="tnum font-medium text-ink">{pct(k.quoteWinRate)}</span> · 単価 <span className="tnum font-medium text-ink">{yen(avg)}</span></span>
                  <span className="col-start-2 text-right text-[11px] whitespace-nowrap text-ink-3">年初来 <span className="tnum">{yen(k.salesYtd)}</span></span>
                </li>
              );
            })}
          </ul>
        </Card>
      </div>

      <Card padded={false}>
        <div className="px-5 pt-5"><CardHeader title="担当者別の実績" description={`直近 ${months} か月 · 見積作成数・受注件数・受注金額・施工完了数`} /></div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead><tr className="bg-subtle text-xs text-ink-2"><th className="px-5 py-2 text-left font-medium">担当者</th><th className="px-3 py-2 text-left font-medium">役割</th><th className="px-3 py-2 text-left font-medium">店舗</th><th className="px-3 py-2 text-right font-medium">見積</th><th className="px-3 py-2 text-right font-medium">受注</th><th className="px-3 py-2 text-right font-medium">受注金額</th><th className="px-5 py-2 text-right font-medium">施工完了</th></tr></thead>
            <tbody>
              {staff.map((r) => (
                <tr key={r.user.id} className="border-t border-line hover:bg-subtle/70">
                  <td className="px-5 py-2 font-medium">{r.user.name}</td>
                  <td className="px-3 py-2 text-xs text-ink-2">{ROLE_LABEL[r.user.role]} · {r.user.title}</td>
                  <td className="px-3 py-2"><StoreTag store={db.stores.find((s) => s.id === r.user.storeId)} short /></td>
                  <td className="px-3 py-2 text-right tnum">{r.quotes}</td>
                  <td className="px-3 py-2 text-right tnum">{r.orders}</td>
                  <td className="px-3 py-2 text-right tnum">{yen(r.orderAmount)}</td>
                  <td className="px-5 py-2 text-right tnum">{r.jobsCompleted}</td>
                </tr>
              ))}
              {staff.length === 0 && <tr><td colSpan={7} className="px-5 py-8 text-center text-ink-3">データがありません</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>

      {surveyRows.length > 0 && (
        <Card className="mt-6" padded={false}>
          <div className="px-5 pt-5">
            <CardHeader title={`お客様アンケート (直近 ${months} か月)`} description="アンケートハガキの回答 (5 段階評価の平均)。受注とはハガキ番号でひも付け" />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-y border-line bg-subtle/60 text-left text-xs text-ink-2">
                  <th className="px-5 py-2 font-semibold">店舗</th>
                  <th className="px-3 py-2 text-right font-semibold">回答数</th>
                  <th className="px-3 py-2 text-right font-semibold">電話対応</th>
                  <th className="px-3 py-2 text-right font-semibold">営業対応</th>
                  <th className="px-3 py-2 text-right font-semibold">職人対応</th>
                  <th className="px-3 py-2 text-right font-semibold">工事の仕上り</th>
                  <th className="px-5 py-2 text-right font-semibold">次回も依頼したい</th>
                </tr>
              </thead>
              <tbody>
                {surveyRows.map((r) => (
                  <tr key={r.store.id} className="border-b border-line">
                    <td className="px-5 py-2"><StoreTag store={r.store} /></td>
                    <td className="px-3 py-2 text-right tnum">{r.n}</td>
                    <td className="px-3 py-2 text-right tnum">{r.phone}</td>
                    <td className="px-3 py-2 text-right tnum">{r.sales}</td>
                    <td className="px-3 py-2 text-right tnum">{r.craft}</td>
                    <td className="px-3 py-2 text-right tnum">{r.finish}</td>
                    <td className="px-5 py-2 text-right tnum">{r.again === null ? "-" : `${r.again}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
