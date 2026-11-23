import Link from "next/link";
import { fmtDate, yen } from "@/lib/format";
import { storePnl, pnlSources, METRIC_LABEL, type StorePnl } from "@/lib/mgmt/pnl";
import { monthRange } from "@/lib/mgmt/allocation";
import type { LedgerMetric } from "@/lib/mgmt/ledger";
import { percent1 } from "@/lib/mgmt/decimal";
import { Card, CardHeader, Note, Table, Td, Th, Tr } from "@/components/ui";
import { StackedBarChart } from "@/components/charts";
import { Money, Pct, PeriodForm, Provisional, qs, type Ctx } from "./parts";
import { MGMT_EXPORTS } from "@/lib/mgmt/export";

const shiftYear = (d: string, n: number) => `${Number(d.slice(0, 4)) + n}${d.slice(4)}`;

type Row = { label: string; key?: LedgerMetric | "gross_sales"; get: (p: StorePnl) => number | null; strong?: boolean; pct?: boolean; sub?: boolean };

const ROWS: Row[] = [
  { label: "外部売上", key: "sales", get: (p) => p.externalSales },
  { label: "　内部受注の配分", key: "adj_internal", get: (p) => p.adjInternal, sub: true },
  { label: "　本部の特殊配分", key: "adj_hq", get: (p) => p.adjHq, sub: true },
  { label: "　手入力の売上調整", key: "adj_manual", get: (p) => p.adjManual, sub: true },
  { label: "管理売上", key: "gross_sales", get: (p) => p.mgmtSales, strong: true },
  { label: "材料費", key: "material", get: (p) => p.material },
  { label: "外注費", key: "outsource", get: (p) => p.outsource },
  { label: "粗利益", get: (p) => p.gross, strong: true },
  { label: "粗利率", get: (p) => p.grossRate, pct: true },
  { label: "材料原価率", get: (p) => p.materialRate, pct: true },
  { label: "人件費", key: "labor", get: (p) => p.labor },
  { label: "店舗独自経費", key: "own_expense", get: (p) => p.ownExpense },
  { label: "共通経費の案分額", key: "allocated", get: (p) => p.allocated },
  { label: "その他管理経費", key: "other_mgmt", get: (p) => p.otherMgmt },
  { label: "店舗の損益", get: (p) => p.profit, strong: true },
];

export function PnlTab({ ctx }: { ctx: Ctx }) {
  const { db } = ctx;
  if (ctx.from > ctx.to) return <PeriodForm ctx={ctx} />;
  const res = storePnl(db, ctx.from, ctx.to, { storeIds: ctx.storeIds });
  const prev = storePnl(db, shiftYear(ctx.from, -1), shiftYear(ctx.to, -1), { storeIds: ctx.storeIds });
  const cols: StorePnl[] = ctx.storeIds ? res.stores : [...res.stores, res.total];
  const prevOf = (id: string, total: boolean) => (total ? prev.total : prev.stores.find((s) => s.storeId === id));
  const [srcStore, srcMetric] = (ctx.sp.src ?? "").split(":");
  const sources = ctx.sp.src ? pnlSources(res, { storeId: srcStore === "all" ? undefined : srcStore, metric: srcMetric as LedgerMetric }) : null;
  // 月ごとの推移 (直近 12 か月の粗利益・店舗別)
  const months: string[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Number(ctx.to.slice(0, 4)), Number(ctx.to.slice(5, 7)) - 1 - i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  const trend = months.map((m) => {
    const r = monthRange(m);
    const p = storePnl(db, r.from, r.to, { storeIds: ctx.storeIds });
    return { label: m.slice(5).replace(/^0/, "") + "月", fullLabel: m, values: Object.fromEntries(p.stores.map((s) => [s.storeId, s.gross])) };
  });
  const series = db.stores.filter((s) => !ctx.storeIds || ctx.storeIds.includes(s.id)).map((s) => ({ key: s.id, label: s.name, color: s.color }));

  return (
    <div className="space-y-4">
      <PeriodForm ctx={ctx} />
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span>
          {fmtDate(ctx.from)} 〜 {fmtDate(ctx.to)} · 金額は<strong>{res.basis}</strong>
        </span>
        <Provisional reasons={res.total.provisional} />
        {res.closedMonths.length > 0 && <span className="text-xs text-ink-2">月次確定済み: {res.closedMonths.join("・")}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="text-ink-2">CSV (この期間・画面と同じ計算):</span>
        {Object.entries(MGMT_EXPORTS).map(([k, label]) => (
          <a key={k} className="text-accent hover:underline" href={`/api/management?kind=${k}&from=${ctx.from}&to=${ctx.to}`}>
            {label}
          </a>
        ))}
        <span className="text-ink-2">— 「店舗間の振り分け」はこれまで税理士に渡していた材料移動の表に当たります</span>
      </div>
      {res.allocations.some((a) => a.status === "held" || a.status === "provisional") && (
        <Note tone="warn">
          共通経費の案分:{" "}
          {res.allocations
            .filter((a) => a.status !== "confirmed" && a.status !== "empty")
            .map((a) => `${a.month} ${a.status === "held" ? `保留 (${a.holdReason})` : "未確定 (計算のみを表示)"}`)
            .join(" / ")}{" "}
          <Link className="text-accent underline" href={qs(ctx, { tab: "alloc", month: res.allocations.find((a) => a.status !== "confirmed")?.month })}>
            案分へ
          </Link>
        </Note>
      )}
      <Table minWidth="min-w-[860px]">
        <thead>
          <tr>
            <Th>項目</Th>
            {cols.map((c, i) => (
              <Th key={c.storeName + i} align="right">
                {c.storeName}
              </Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ROWS.map((r) => (
            <Tr key={r.label}>
              <Td className={r.strong ? "font-semibold" : r.sub ? "text-xs text-ink-2" : ""}>{r.label}</Td>
              {cols.map((c, i) => {
                const v = r.get(c);
                const total = !ctx.storeIds && i === cols.length - 1;
                return (
                  <Td key={i} align="right" className={r.sub ? "text-xs" : ""}>
                    {r.pct ? (
                      <Pct v={v} />
                    ) : r.key ? (
                      <Link className="hover:underline" href={qs(ctx, { src: `${total ? "all" : c.storeId}:${r.key}` }) + "#sources"} title="計算の根拠 (元の記録) を見る">
                        <Money v={v} strong={r.strong} />
                      </Link>
                    ) : (
                      <Money v={v} strong={r.strong} />
                    )}
                  </Td>
                );
              })}
            </Tr>
          ))}
          <Tr>
            <Td className="text-xs text-ink-2">予算 (管理売上) / 達成率</Td>
            {cols.map((c, i) => (
              <Td key={i} align="right" className="text-xs">
                {c.budget.sales ? (
                  <>
                    {yen(c.budget.sales)} / <Pct v={percent1(c.mgmtSales, c.budget.sales)} />
                  </>
                ) : (
                  <span className="text-ink-3">-</span>
                )}
              </Td>
            ))}
          </Tr>
          <Tr>
            <Td className="text-xs text-ink-2">前年同期の管理売上 / 前年比</Td>
            {cols.map((c, i) => {
              const p = prevOf(c.storeId, !ctx.storeIds && i === cols.length - 1);
              return (
                <Td key={i} align="right" className="text-xs">
                  <Money v={p?.mgmtSales ?? 0} muted /> / <Pct v={p ? percent1(c.mgmtSales, p.mgmtSales) : null} />
                </Td>
              );
            })}
          </Tr>
          <Tr>
            <Td className="text-xs text-ink-2">前年同期の粗利益 / 増減</Td>
            {cols.map((c, i) => {
              const p = prevOf(c.storeId, !ctx.storeIds && i === cols.length - 1);
              const diff = p ? c.gross - p.gross : null;
              return (
                <Td key={i} align="right" className="text-xs">
                  <Money v={p?.gross ?? 0} muted /> / {diff === null ? "-" : <span className={diff < 0 ? "text-critical" : "text-good-ink"}>{diff >= 0 ? "+" : ""}{yen(diff)}</span>}
                </Td>
              );
            })}
          </Tr>
        </tbody>
      </Table>
      <p className="text-xs text-ink-2">
        管理売上 = 外部売上 + 店舗間の調整 (内部受注・本部の特殊配分。店舗の合計は 0 で、全社の外部売上は増えません) / 粗利益 = 管理売上 − 材料費 − 外注費 / 店舗の損益 = 粗利益 − 人件費 − 店舗独自経費 − 共通経費の案分額 − その他管理経費。金額をクリックすると計算の根拠 (元の記録) が出ます。
      </p>
      {res.total.provisional.length > 0 && (
        <Card>
          <CardHeader title="暫定の理由" description="未確定の設定・確認待ちの明細を含む数字です。確定するには、それぞれの画面で確認・確定してください" />
          <ul className="list-disc pl-5 text-sm">
            {res.total.provisional.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Card>
      )}
      {sources && (
        <Card id="sources">
          <CardHeader title={`計算の根拠: ${srcStore === "all" ? "全社" : db.stores.find((s) => s.id === srcStore)?.name} ・ ${METRIC_LABEL[srcMetric as LedgerMetric] ?? "管理売上"}`} description={`${sources.count} 行 · 合計 ${yen(sources.sum)}${sources.count > sources.rows.length ? ` (先頭の ${sources.rows.length} 行を表示)` : ""}`} />
          <Table minWidth="min-w-[640px]">
            <thead>
              <tr>
                <Th>日付</Th>
                <Th>店舗</Th>
                <Th>品目</Th>
                <Th>元の記録</Th>
                <Th align="right">金額</Th>
              </tr>
            </thead>
            <tbody>
              {sources.rows.map((r, i) => (
                <Tr key={i}>
                  <Td className="whitespace-nowrap">{r.date}</Td>
                  <Td>{db.stores.find((s) => s.id === r.storeId)?.shortName}</Td>
                  <Td>{r.itemCategory}</Td>
                  <Td>
                    {r.source.href ? (
                      <Link className="text-accent hover:underline" href={r.source.href}>
                        {r.source.label}
                      </Link>
                    ) : (
                      r.source.label
                    )}
                    {r.provisional && <span className="ml-2 text-xs text-warn-ink">({r.provisional})</span>}
                  </Td>
                  <Td align="right">
                    <Money v={r.amount} />
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
      <Card>
        <StackedBarChart title="粗利益の推移 (直近 12 か月・店舗別)" data={trend} series={series} defaultType="line" />
      </Card>
    </div>
  );
}
