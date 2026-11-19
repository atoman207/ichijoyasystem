import { fmtDate } from "@/lib/format";
import { storePnl } from "@/lib/mgmt/pnl";
import { itemCategories } from "@/lib/mgmt/categories";
import { percent1 } from "@/lib/mgmt/decimal";
import { Card, CardHeader, Table, Td, Th, Tr } from "@/components/ui";
import { BarList } from "@/components/charts";
import { Money, Pct, PeriodForm, Provisional, StoreSelect, type Ctx } from "./parts";

const shiftYear = (d: string, n: number) => `${Number(d.slice(0, 4)) + n}${d.slice(4)}`;

export function ItemsTab({ ctx }: { ctx: Ctx }) {
  const { db } = ctx;
  const store = ctx.storeIds ? ctx.storeIds[0] : db.stores.some((s) => s.id === ctx.sp.store) ? ctx.sp.store! : "all";
  if (ctx.from > ctx.to) return <PeriodForm ctx={ctx} />;
  const res = storePnl(db, ctx.from, ctx.to, { storeIds: ctx.storeIds });
  const prev = storePnl(db, shiftYear(ctx.from, -1), shiftYear(ctx.to, -1), { storeIds: ctx.storeIds });
  const cats = itemCategories(db).filter((c) => c.active);
  const pick = (r: typeof res, cat: string) => r.categories.find((c) => c.storeId === store && c.itemCategory === cat);
  const stores = db.stores.filter((s) => !ctx.storeIds || ctx.storeIds.includes(s.id));
  return (
    <div className="space-y-4">
      <PeriodForm ctx={ctx}>
        {!ctx.storeIds && (
          <label className="block">
            <span className="label">店舗</span>
            <StoreSelect db={db} name="store" defaultValue={store === "all" ? "" : store} all="全社" />
          </label>
        )}
      </PeriodForm>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span>
          {fmtDate(ctx.from)} 〜 {fmtDate(ctx.to)} · {store === "all" ? "全社" : db.stores.find((s) => s.id === store)?.name} · 金額は<strong>{res.basis}</strong>
        </span>
        <Provisional reasons={res.total.provisional} />
      </div>
      <Table minWidth="min-w-[860px]">
        <thead>
          <tr>
            <Th>品目</Th>
            <Th align="right">売上 (管理売上)</Th>
            <Th align="right">材料費</Th>
            <Th align="right">外注費</Th>
            <Th align="right">粗利益</Th>
            <Th align="right">材料原価率</Th>
            <Th align="right">前年同期の売上</Th>
            <Th align="right">前年比</Th>
          </tr>
        </thead>
        <tbody>
          {cats.map((c) => {
            const r = pick(res, c.id);
            const p = pick(prev, c.id);
            return (
              <Tr key={c.id}>
                <Td className="font-medium">{c.name}</Td>
                <Td align="right"><Money v={r?.sales ?? 0} /></Td>
                <Td align="right"><Money v={r?.material ?? 0} /></Td>
                <Td align="right"><Money v={r?.outsource ?? 0} /></Td>
                <Td align="right"><Money v={r?.gross ?? 0} strong /></Td>
                <Td align="right"><Pct v={r?.materialRate ?? null} /></Td>
                <Td align="right"><Money v={p?.sales ?? 0} muted /></Td>
                <Td align="right"><Pct v={p ? percent1(r?.sales ?? 0, p.sales) : null} /></Td>
              </Tr>
            );
          })}
        </tbody>
      </Table>
      <p className="text-xs text-ink-2">
        材料原価率 = 材料費 ÷ 売上 × 100 (売上が 0 のときは「計算不能」)。品目は売上シートの集計と同じ区分 (値引は 畳・襖・リフォーム・自社商品 の割合で案分)。外注費・材料費は 仕入明細の振り分け・材料の使用 で決まった品目に入ります。
      </p>
      {!ctx.storeIds && (
        <Card>
          <CardHeader title="店舗 × 品目の材料原価率" description="店舗ごとの品目の 売上・材料費・材料原価率" />
          <Table minWidth="min-w-[760px]">
            <thead>
              <tr>
                <Th>品目</Th>
                {stores.map((s) => (
                  <Th key={s.id} align="right">{s.shortName}</Th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cats.map((c) => (
                <Tr key={c.id}>
                  <Td>{c.name}</Td>
                  {stores.map((s) => {
                    const r = res.categories.find((x) => x.storeId === s.id && x.itemCategory === c.id);
                    return (
                      <Td key={s.id} align="right" className="text-xs">
                        <Money v={r?.sales ?? 0} />
                        <div className="text-ink-2">
                          材 <Money v={r?.material ?? 0} /> · <Pct v={r?.materialRate ?? null} />
                        </div>
                      </Td>
                    );
                  })}
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
      <Card>
        <BarList title="品目別の粗利益" unit="yen" items={cats.map((c) => ({ label: c.name, value: pick(res, c.id)?.gross ?? 0 }))} />
      </Card>
    </div>
  );
}
