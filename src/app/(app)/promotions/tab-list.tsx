import Link from "@/components/ui/Link";
import type { Database, PromotionKind, StoreId, User } from "@/lib/db/types";
import { canSeeAllStores } from "@/lib/auth/permissions";
import { yen } from "@/lib/format";
import { fiscalRange, fiscalYearOf } from "@/lib/kpi-settings";
import { PROMOTION_KIND, PROMOTION_KINDS, PROMOTION_STATUS } from "@/lib/ops-reports/promo-analysis";
import { PeriodSelect } from "@/components/kpi/PeriodSelect";
import { Badge, Card, CardHeader, EmptyRow, StoreTag, Table, Td, Th, Tr } from "@/components/ui";

const n = (v: number) => v.toLocaleString("ja-JP");

/** 販促の記録の一覧 (期間 = 配布日・開始日) と、今年度のチラシの計画と実施 */
export function ListTab({ db, user, storeIds, from, to, periodValue, periodLabel, startMonth, today, store, sp }: { db: Database; user: User; storeIds: StoreId[]; from: string; to: string; periodValue: string; periodLabel: string; startMonth: number; today: string; store: string; sp: Record<string, string | undefined> }) {
  const kind = PROMOTION_KINDS.includes(sp.kind as PromotionKind) ? (sp.kind as PromotionKind) : undefined;
  const stores = new Set(storeIds);
  const rows = (db.promotions ?? []).filter((p) => stores.has(p.storeId) && p.startDate >= from && p.startDate <= to && (!kind || p.kind === kind)).sort((a, b) => b.startDate.localeCompare(a.startDate) || b.number.localeCompare(a.number));
  const linked = new Map<string, number>();
  for (const i of db.inquiries) if (i.promotionId) linked.set(i.promotionId, (linked.get(i.promotionId) ?? 0) + 1);
  const storeMap = new Map(db.stores.map((s) => [s.id, s]));
  // 今年度のチラシの計画と実施 (店舗別)
  const fy = fiscalYearOf(today, startMonth);
  const fr = fiscalRange(fy, startMonth);
  const plan = db.stores
    .filter((s) => stores.has(s.id))
    .map((s) => {
      const fl = (db.promotions ?? []).filter((p) => p.kind === "flyer" && p.storeId === s.id && p.startDate >= fr.from && p.startDate <= fr.to);
      const done = fl.filter((p) => p.status === "done").reduce((a, p) => a + p.copies, 0);
      const planned = fl.filter((p) => p.status === "planned").reduce((a, p) => a + p.copies, 0);
      return { store: s, done, planned };
    })
    .filter((x) => x.done || x.planned);

  return (
    <div className="space-y-4">
      <PeriodSelect
        action="/promotions"
        value={periodValue}
        startMonth={startMonth}
        today={today}
        keep={{ tab: "list" }}
        extra={
          <>
            {canSeeAllStores(user) && (
              <label className="block">
                <span className="label">店舗</span>
                <select name="store" defaultValue={store} className="field h-9 py-1 text-sm">
                  <option value="">全店舗</option>
                  {db.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </label>
            )}
            <label className="block">
              <span className="label">種類</span>
              <select name="kind" defaultValue={kind ?? ""} className="field h-9 py-1 text-sm">
                <option value="">すべて</option>
                {PROMOTION_KINDS.map((k) => <option key={k} value={k}>{PROMOTION_KIND[k].label}</option>)}
              </select>
            </label>
          </>
        }
      />

      {plan.length > 0 && (
        <Card>
          <CardHeader title={`${fy}年度のチラシ (${fr.from.replaceAll("-", "/")}〜${fr.to.replaceAll("-", "/")})`} description="計画 (未実施) は状態が「計画」のチラシ。配布したら「実施済み」にします" />
          <div className="grid grid-cols-1 gap-2 @xl:grid-cols-2 @4xl:grid-cols-4">
            {plan.map((x) => (
              <div key={x.store.id} className="rounded-xl border border-line px-3 py-2 text-sm">
                <StoreTag store={x.store} />
                <div className="mt-1 tnum">実施 <span className="font-semibold">{n(x.done)}</span> 部 · 計画 {n(x.planned)} 部</div>
                <div className="text-[11px] text-ink-3">合計 {n(x.done + x.planned)} 部</div>
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-ink-2">全体: 実施 {n(plan.reduce((a, x) => a + x.done, 0))} 部 · 計画 {n(plan.reduce((a, x) => a + x.planned, 0))} 部 · 合計 {n(plan.reduce((a, x) => a + x.done + x.planned, 0))} 部</p>
        </Card>
      )}

      <p className="text-xs text-ink-3">{periodLabel} · 配布日・開始日で絞り込み · {rows.length} 件</p>
      <Table minWidth="min-w-[860px]">
        <thead>
          <tr>
            <Th>配布日・開始日</Th>
            <Th>種類</Th>
            <Th>名前</Th>
            <Th>店舗</Th>
            <Th>状態</Th>
            <Th align="right">部数・件数</Th>
            <Th>地域</Th>
            <Th align="right">問い合わせ</Th>
            <Th align="right">費用</Th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <EmptyRow colSpan={9}>期間内の販促の記録はありません</EmptyRow>}
          {rows.map((p) => (
            <Tr key={p.id}>
              <Td className="text-xs tnum">{p.startDate.replaceAll("-", "/")}{p.endDate ? `〜${p.endDate.slice(5).replace("-", "/")}` : ""}<div className="font-mono text-[10px] text-ink-3">{p.number}</div></Td>
              <Td className="text-xs">{PROMOTION_KIND[p.kind].label}</Td>
              <Td><Link href={`/promotions/${p.id}`} className="font-medium text-ink hover:text-accent">{p.title}</Link></Td>
              <Td><StoreTag store={storeMap.get(p.storeId)} short /></Td>
              <Td><Badge tone={PROMOTION_STATUS[p.status].tone}>{PROMOTION_STATUS[p.status].label}</Badge></Td>
              <Td align="right">{n(p.copies)}{PROMOTION_KIND[p.kind].unit}</Td>
              <Td className="max-w-[16rem] truncate text-xs text-ink-2" >{p.areas.map((a) => a.area).join("・") || "-"}</Td>
              <Td align="right">{n(linked.get(p.id) ?? 0)}</Td>
              <Td align="right">{p.cost !== undefined ? yen(p.cost) : "-"}</Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
