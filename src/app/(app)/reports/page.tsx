import { redirect } from "next/navigation";
import { Download } from "lucide-react";
import Link from "@/components/ui/Link";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canSeeAllStores, canViewReports } from "@/lib/auth/permissions";
import { fmtShortMonth, fmtMonth, pct, toDateKey, yen } from "@/lib/format";
import { PERIOD_LABEL, growth, managementReport, resolvePeriod, staffOptions, type MgmtCsvSection, type PeriodPreset } from "@/lib/management";
import { SCORE_QUESTIONS } from "@/lib/survey";
import type { StoreId } from "@/lib/db/types";
import { BarList, StackedBarChart } from "@/components/charts";
import { Card, CardHeader, Input, Note, PageHeader, Select, Stat, StoreTag, Table, Td, Th, Tr } from "@/components/ui";

/**
 * 経営ダッシュボード (店長・本部スタッフ・管理者)
 * 期間・店舗・担当者で絞り込み、売上・受注・施工・請求・入金・経費・仕入を集計する (集計は src/lib/management.ts)
 * 各表は同じ条件で CSV に書き出せる (/api/reports)
 */
/** 表ごとの CSV の書き出し (画面と同じ条件) */
function CsvLink({ href }: { href: string }) {
  return (
    <a href={href} download className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[11px] font-medium text-ink-2 hover:bg-subtle hover:text-ink">
      <Download className="h-3 w-3" aria-hidden /> CSV
    </a>
  );
}

/** 前年同期との比較の文字 (例: 前年比 +12.3%) */
function growthText(cur: number, prev: number): string {
  const g = growth(cur, prev);
  if (g === null) return "前年同期の記録なし";
  return `前年比 ${g >= 0 ? "+" : ""}${pct(g, 1)}`;
}

function GrowthTag({ g }: { g: number | null }) {
  if (g === null) return <span className="block text-[11px] text-ink-3">前年 -</span>;
  return <span className={`block text-[11px] ${g < 0 ? "text-critical-ink" : "text-good-ink"}`}>{`前年比 ${g >= 0 ? "+" : ""}${pct(g, 1)}`}</span>;
}

const line = (s: string) => <span className="block">{s}</span>;

export default async function ReportsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  if (!canViewReports(user)) redirect("/?err=" + encodeURIComponent("経営ダッシュボードは店長・本部・管理者が閲覧できます。"));
  const db = getDb();
  const now = new Date();
  const allStores = canSeeAllStores(user);
  const period = resolvePeriod(sp, now);
  const storeFilter = allStores && db.stores.some((s) => s.id === sp.store) ? (sp.store as StoreId) : undefined;
  const people = staffOptions(db, user);
  const staffFilter = sp.staff && people.some((u) => u.key === sp.staff) ? sp.staff : undefined;
  const r = managementReport(db, user, { from: period.from, to: period.to, storeId: storeFilter, staffId: staffFilter }, now);
  const t = r.totals;
  const prev = r.previous.totals;
  const base = r.previous.base;
  const storeMap = new Map(db.stores.map((s) => [s.id, s]));

  // 同じ条件の CSV・担当者で絞ったリンク
  const params = (extra: Record<string, string | undefined> = {}) =>
    new URLSearchParams(Object.entries({ period: period.preset, from: period.preset === "custom" ? period.from : undefined, to: period.preset === "custom" ? period.to : undefined, store: storeFilter, staff: staffFilter, ...extra }).filter(([, v]) => v) as [string, string][]).toString();
  const csv = (section: MgmtCsvSection) => `/api/reports?section=${section}&${params()}`;
  const staffHref = (key: string) => `/reports?${params({ staff: key })}`;

  const salesSeries = r.stores.map((s) => ({ key: s.id, label: s.name, color: s.color }));
  const salesData = r.months.map((m) => ({ label: fmtShortMonth(m.month), fullLabel: fmtMonth(m.month), values: m.byStore }));
  const yoySeries = [
    { key: "sales", label: "今期", color: "#3340b8" },
    { key: "prevSales", label: "前年同月", color: "#8a91a5" },
  ];
  const yoyData = r.months.map((m) => ({ label: fmtShortMonth(m.month), fullLabel: fmtMonth(m.month), values: { sales: m.sales, prevSales: m.prevSales } }));
  const flowSeries = [
    { key: "sales", label: "売上", color: "#3340b8" },
    { key: "received", label: "入金", color: "#14a39a" },
    { key: "tatamiCost", label: "畳原価", color: "#9b59d0" },
    { key: "purchases", label: "仕入", color: "#e0a21a" },
    { key: "expenses", label: "経費", color: "#e2603a" },
  ];
  const flowData = r.months.map((m) => ({ label: fmtShortMonth(m.month), fullLabel: fmtMonth(m.month), values: { sales: m.sales, received: m.received, tatamiCost: m.tatamiCost, purchases: m.purchases, expenses: m.expenses } }));
  const systemOrders = r.pipeline.reduce((a, p) => a + p.count, 0);
  const pipelineMax = Math.max(...r.pipeline.map((p) => p.count), 1);
  const noCostRecords = t.purchaseCount + t.expenseCount === 0;
  const hasMigrated = t.importedSalesCount > 0 || r.migrated.count > 0;

  const staffName = staffFilter ? people.find((u) => u.key === staffFilter)?.name : undefined;
  const scopeText = [storeFilter ? storeMap.get(storeFilter)?.name : allStores ? "全店舗" : storeMap.get(user.storeId)?.name, staffName ? `担当 ${staffName}` : ""].filter(Boolean).join(" · ");

  return (
    <div>
      <PageHeader title="経営ダッシュボード" description={`${period.label} · ${scopeText} · 今日 ${toDateKey(now).replaceAll("-", "/")}`} actions={<a href={csv("summary")} download className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-panel px-3 text-xs font-medium text-ink hover:bg-subtle"><Download className="h-3.5 w-3.5" aria-hidden /> 概要を CSV で書き出す</a>} />

      <form method="get" className="mb-4 flex flex-wrap items-end gap-2 rounded-xl border border-line bg-panel p-3">
        <label className="block">
          <span className="label">期間</span>
          <Select name="period" defaultValue={period.preset} className="w-auto">
            {(Object.keys(PERIOD_LABEL) as PeriodPreset[]).map((p) => <option key={p} value={p}>{PERIOD_LABEL[p]}</option>)}
          </Select>
        </label>
        <label className="block">
          <span className="label">から (期間を指定)</span>
          <Input type="date" name="from" defaultValue={period.from} className="w-auto" />
        </label>
        <label className="block">
          <span className="label">まで</span>
          <Input type="date" name="to" defaultValue={period.to} className="w-auto" />
        </label>
        {allStores && (
          <label className="block">
            <span className="label">店舗</span>
            <Select name="store" defaultValue={storeFilter ?? ""} className="w-auto">
              <option value="">全店舗</option>
              {db.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </label>
        )}
        <label className="block">
          <span className="label">担当者</span>
          <Select name="staff" defaultValue={staffFilter ?? ""} className="w-auto max-w-[16rem]">
            <option value="">全員</option>
            {people.map((u) => <option key={u.key} value={u.key}>{u.name}{u.hasAccount ? (u.active ? "" : " (退職)") : " (アカウントなし)"} · {storeMap.get(u.storeId)?.shortName}</option>)}
          </Select>
        </label>
        <button type="submit" className="h-9 rounded-lg bg-accent px-4 text-sm font-medium text-white hover:bg-accent-hover">集計する</button>
        <p className="basis-full text-[11px] text-ink-3">「から・まで」は期間で「期間を指定」を選んだときに使います。売上は施工完了 (売上計上日)、受注は契約日、請求は請求日、入金は入金日で数えます。未入金残高は今日時点の値です。前年同期は同じ期間の 1 年前 (今日をまたぐ期間は今日まで) と比べます。</p>
      </form>

      <div className="mb-4 grid grid-cols-1 gap-3 @md:grid-cols-2 @3xl:grid-cols-3 @6xl:grid-cols-5">
        <Stat label="売上 (税込・施工完了)" value={yen(t.sales)} sub={<>{line(`${t.salesCount.toLocaleString("ja-JP")} 件`)}{line(`${growthText(base.sales, prev.sales)} (前年同期 ${yen(prev.sales)})`)}</>} />
        <Stat label="受注 (契約日)" value={yen(t.orderAmount)} sub={<>{line(`${t.orderCount.toLocaleString("ja-JP")} 件 · 平均 ${yen(t.orderCount ? t.orderAmount / t.orderCount : 0)}`)}{line(growthText(base.orderAmount, prev.orderAmount))}</>} />
        <Stat
          label="問い合わせ → 見積 → 受注 (システムで登録)"
          value={<span className="text-xl whitespace-nowrap">{`${t.inquiries.toLocaleString("ja-JP")} → ${t.quotes.toLocaleString("ja-JP")} → ${t.funnelOrders.toLocaleString("ja-JP")}`}</span>}
          sub={<>{line(`${t.quotes ? `見積化率 ${t.inquiries ? pct(t.quotes / t.inquiries, 1) : "-"}` : "見積の記録なし"} · 施工完了 ${t.jobsCompleted.toLocaleString("ja-JP")} 件`)}{t.importedOrderCount > 0 && line(`移行データの受注 ${t.importedOrderCount.toLocaleString("ja-JP")} 件は含めていません`)}</>}
        />
        <Stat label="請求 / 入金" value={<span className="text-xl">{yen(t.invoiced)}</span>} sub={<>{line(`入金 ${yen(t.received)} · 請求 ${t.invoiceCount.toLocaleString("ja-JP")} 件`)}{t.invoiceCount === 0 && hasMigrated && line("移行データには請求書・入金の記録がありません")}</>} />
        <Stat label="未入金残高 (今日時点)" value={yen(t.receivables)} sub={t.overdue > 0 ? `期日超過 ${yen(t.overdue)} (${t.overdueCount} 件)` : "期日超過なし"} tone={t.overdue > 0 ? "critical" : undefined} href="/finance" />
      </div>
      <div className="mb-5 grid grid-cols-1 gap-3 @md:grid-cols-2 @5xl:grid-cols-4">
        <Stat label="畳原価" value={yen(t.tatamiCost)} sub="売上に数えた受注の畳原価 (販売管理ソフトの売上台帳)" accent="warn" />
        <Stat label="仕入 (請求日)" value={yen(t.purchases)} sub={t.purchaseCount ? `${t.purchaseCount.toLocaleString("ja-JP")} 件` : "この期間の記録なし"} accent="warn" />
        <Stat label="経費 (承認済・精算済)" value={yen(t.expenses)} sub={t.expenseCount ? (t.expensesPending ? `承認待ち ${yen(t.expensesPending)}` : "承認待ちなし") : "この期間の記録なし"} accent="warn" />
        <Stat
          label="簡易粗利 (売上 − 畳原価 − 仕入 − 経費)"
          value={yen(t.gross)}
          sub={<>{line(`売上比 ${t.sales ? pct(t.gross / t.sales, 1) : "-"} · ${growthText(base.gross, prev.gross)}`)}{line(noCostRecords ? "仕入・経費の記録がまだないため、畳原価だけを引いています (会計上の利益ではありません)" : "税込のまま計算 (会計上の利益ではありません)")}</>}
          tone={t.gross < 0 ? "critical" : undefined}
          accent="good"
        />
      </div>

      <div className="mb-4 grid grid-cols-1 gap-4 @5xl:grid-cols-2">
        <Card>
          <CardHeader title="月次売上 (店舗別・税込)" description="施工完了 (売上計上日) ベース" action={<CsvLink href={csv("monthly")} />} />
          <StackedBarChart data={salesData} series={salesSeries} height={240} title="月次売上" />
        </Card>
        <Card>
          <CardHeader title="売上の前年同月比較" description={`前年同期 ${r.previous.label} の売上 ${yen(prev.sales)} · ${growthText(base.sales, prev.sales)}`} action={<CsvLink href={csv("monthly")} />} />
          <StackedBarChart data={yoyData} series={yoySeries} height={240} title="売上の前年同月比較" defaultType="line" />
        </Card>
      </div>
      <Card className="mb-4">
        <CardHeader title="売上・入金・畳原価・仕入・経費の推移" description="経費は承認済・精算済、仕入は請求日、畳原価は売上計上日で集計" action={<CsvLink href={csv("monthly")} />} />
        <StackedBarChart data={flowData} series={flowSeries} height={220} title="売上・入金・畳原価・仕入・経費" defaultType="line" />
      </Card>

      <div className="mb-4 grid grid-cols-1 gap-4 @4xl:grid-cols-2">
        <Card>
          <CardHeader title="受注の進み具合" description="契約日が期間内の、システムで登録した受注を今の状態で分けています" action={<CsvLink href={csv("pipeline")} />} />
          {systemOrders > 0 ? (
            <ul className="space-y-2">
              {r.pipeline.map((p) => (
                <li key={p.key} className="text-xs">
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="text-ink-2">{p.label}</span>
                    <span className="tnum text-ink"><span className="font-semibold">{p.count.toLocaleString("ja-JP")}</span> 件 · {yen(p.amount)}</span>
                  </div>
                  <div className="h-2 rounded-full bg-subtle"><div className={`h-2 rounded-full ${p.key === "cancelled" ? "bg-ink-3/50" : p.key === "paid" ? "bg-good" : "bg-accent"}`} style={{ width: `${(p.count / pipelineMax) * 100}%` }} /></div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-lg bg-subtle px-3 py-4 text-center text-xs text-ink-3">この期間に契約した、システムで登録した受注はありません</p>
          )}
          {r.migrated.count > 0 && (
            <div className="mt-3 rounded-lg border border-line/70 px-3 py-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="text-ink-2">移行データ (販売管理ソフトの売上)</span>
                <span className="tnum text-ink"><span className="font-semibold">{r.migrated.count.toLocaleString("ja-JP")}</span> 件 · {yen(r.migrated.amount)}</span>
              </div>
              <p className="mt-1 text-[11px] text-ink-3">施工・入金が済んだ売上として移行したため (請求書・入金の記録はありません)、進み具合には含めていません。</p>
            </div>
          )}
        </Card>
        <Card>
          <CardHeader title="請求・入金の状況" description="請求日が期間内の請求 (期日超過は今日時点で判定)" action={<CsvLink href={csv("invoices")} />} />
          <Table className="border-0 shadow-none" minWidth="min-w-0">
            <thead><tr><Th>状態</Th><Th align="right">件数</Th><Th align="right">請求額</Th><Th align="right">未入金残高</Th></tr></thead>
            <tbody>
              {r.invoiceStatus.map((i) => (
                <Tr key={i.key}>
                  <Td className={i.key === "overdue" && i.count ? "font-medium text-critical-ink" : ""}>{i.label}</Td>
                  <Td align="right">{i.count.toLocaleString("ja-JP")}</Td>
                  <Td align="right">{yen(i.amount)}</Td>
                  <Td align="right">{yen(i.balance)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
          {hasMigrated && <p className="mt-2 text-[11px] text-ink-3">移行データ (販売管理ソフトの売上) の受注には請求書がないため、請求・入金の件数には含まれません。</p>}
        </Card>
      </div>

      <Card padded={false} className="mb-4">
        <div className="px-5 pt-5"><CardHeader title="店舗別" description={`期間内の集計 (未入金残高は今日時点・前年比は ${r.previous.label} の売上と比較)`} action={<CsvLink href={csv("stores")} />} /></div>
        <Table className="rounded-none rounded-b-2xl border-0 shadow-none" minWidth="min-w-[1080px]">
          <thead>
            <tr><Th className="pl-5">店舗</Th><Th align="right">売上</Th><Th align="right">受注</Th><Th align="right">平均単価</Th><Th align="right">問い合わせ</Th><Th align="right">見積</Th><Th align="right">成約率</Th><Th align="right">施工完了</Th><Th align="right">入金</Th><Th align="right">未入金残</Th><Th align="right">畳原価</Th><Th align="right">仕入</Th><Th align="right">経費</Th><Th align="right" className="pr-5">簡易粗利</Th></tr>
          </thead>
          <tbody>
            {r.storeRows.map((s) => (
              <Tr key={s.storeId}>
                <Td className="pl-5"><StoreTag store={storeMap.get(s.storeId)} short /></Td>
                <Td align="right"><span className="font-semibold">{yen(s.sales)}</span><GrowthTag g={s.salesGrowth} /></Td>
                <Td align="right">{s.orderCount} 件<br /><span className="text-[11px] text-ink-3">{yen(s.orderAmount)}</span></Td>
                <Td align="right">{yen(s.avgOrder)}</Td>
                <Td align="right">{s.inquiries}</Td>
                <Td align="right">{s.quotes}</Td>
                <Td align="right">{s.winRate === null ? "-" : pct(s.winRate)}</Td>
                <Td align="right">{s.jobsCompleted}</Td>
                <Td align="right">{yen(s.received)}</Td>
                <Td align="right">{yen(s.receivables)}{s.overdue > 0 && <span className="block text-[11px] text-critical-ink">超過 {yen(s.overdue)}</span>}</Td>
                <Td align="right">{yen(s.tatamiCost)}</Td>
                <Td align="right">{yen(s.purchases)}</Td>
                <Td align="right">{yen(s.expenses)}</Td>
                <Td align="right" className={`pr-5 ${s.gross < 0 ? "text-critical-ink" : ""}`}>{yen(s.gross)}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </Card>

      <Card padded={false} className="mb-4">
        <div className="px-5 pt-5"><CardHeader title="担当者別" description="売上・受注は担当 (見積の担当者。移行データは販売管理ソフトの担当者欄の 1 番目)、施工完了は施工担当、問い合わせは担当者で数えています。名前を押すとその人で絞り込みます" action={<CsvLink href={csv("staff")} />} /></div>
        <Table className="rounded-none rounded-b-2xl border-0 shadow-none" minWidth="min-w-[860px]">
          <thead>
            <tr><Th className="pl-5">担当者</Th><Th>所属</Th><Th align="right">問い合わせ</Th><Th align="right">見積</Th><Th align="right">受注</Th><Th align="right">受注金額</Th><Th align="right">売上</Th><Th align="right">施工完了</Th><Th align="right" className="pr-5">経費</Th></tr>
          </thead>
          <tbody>
            {r.staffRows.slice(0, 100).map((s) => (
              <Tr key={s.key}>
                <Td className="pl-5">
                  {people.some((u) => u.key === s.key) && s.key !== staffFilter ? <Link href={staffHref(s.key)} className="font-medium text-accent-ink hover:underline">{s.name}</Link> : <span className="font-medium">{s.name}</span>}
                  <span className="block text-[11px] text-ink-3">{s.role}{s.hasAccount && !s.active ? " (退職)" : ""}</span>
                </Td>
                <Td><StoreTag store={s.storeId ? storeMap.get(s.storeId) : undefined} short /></Td>
                <Td align="right">{s.inquiries}</Td>
                <Td align="right">{s.quotes}</Td>
                <Td align="right">{s.orderCount}</Td>
                <Td align="right">{yen(s.orderAmount)}</Td>
                <Td align="right">{yen(s.sales)}</Td>
                <Td align="right">{s.jobsCompleted}</Td>
                <Td align="right" className="pr-5">{yen(s.expenses)}</Td>
              </Tr>
            ))}
            {r.staffRows.length === 0 && <tr><td colSpan={9} className="px-5 py-8 text-center text-sm text-ink-3">この条件の記録はありません</td></tr>}
          </tbody>
        </Table>
        <p className="px-5 py-2 text-[11px] text-ink-3">
          「アカウントなし」は販売管理ソフトの担当者欄にだけ名前がある人 (退職者など) です。担当者欄の 3 番目 (伝票の入力者) は数えていません。
          {r.staffRows.length > 100 && " 上位 100 人を表示しています。すべては CSV で確認できます。"}
        </p>
      </Card>

      <div className="mb-4 grid grid-cols-1 gap-4 @4xl:grid-cols-3">
        <Card>
          <CardHeader title="種別別の売上" action={<CsvLink href={csv("categories")} />} />
          <BarList items={r.categories.map((c) => ({ label: c.label, value: c.amount }))} unit="yen" color="#4a5ae8" title="種別別の売上" />
        </Card>
        <Card>
          <CardHeader title="問い合わせの入口別" action={<CsvLink href={csv("channels")} />} />
          <BarList items={r.channels.map((c) => ({ label: c.label, value: c.count }))} unit="count" color="#2a78d6" title="問い合わせの入口別" />
        </Card>
        <Card>
          <CardHeader title="経費の勘定科目別" description="承認済・精算済" action={<CsvLink href={csv("expenses")} />} />
          <BarList items={r.expenseAccounts.map((e) => ({ label: e.account, value: e.amount }))} unit="yen" color="#e2603a" title="経費の勘定科目別" />
        </Card>
      </div>

      {r.surveys.length > 0 && (
        <Card className="mb-4" padded={false}>
          <div className="px-5 pt-5">
            <CardHeader title="お客様アンケート" description="回答日が期間内のアンケートはがき (5 段階評価の平均。KPI の画面と同じ集計。担当者の絞り込みは使いません)" action={<CsvLink href={csv("surveys")} />} />
          </div>
          <Table className="rounded-none rounded-b-2xl border-0 shadow-none" minWidth="min-w-[720px]">
            <thead>
              <tr><Th className="pl-5">店舗</Th><Th align="right">回答数</Th><Th align="right">返信率</Th>{SCORE_QUESTIONS.map((q) => <Th key={q.key} align="right">{q.no} {q.label}</Th>)}<Th align="right" className="pr-5">次回も依頼したい</Th></tr>
            </thead>
            <tbody>
              {r.surveys.map((x) => (
                <Tr key={x.storeId}>
                  <Td className={`pl-5 ${x.storeId === "all" ? "font-semibold" : ""}`}>{x.storeId === "all" ? x.storeName : <StoreTag store={storeMap.get(x.storeId)} />}</Td>
                  <Td align="right">{x.n.toLocaleString("ja-JP")}</Td>
                  <Td align="right">{x.replyRate === null ? "-" : pct(x.replyRate, 1)}</Td>
                  {SCORE_QUESTIONS.map((q) => <Td key={q.key} align="right">{x.scores[q.key] === null ? "-" : x.scores[q.key]!.toFixed(2)}</Td>)}
                  <Td align="right" className="pr-5">{x.againRate === null ? "-" : pct(x.againRate)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      <Note>
        集計の基準: 売上 = 受注の売上計上日 (施工完了) が期間内 (キャンセルを除く) / 受注 = 契約日が期間内 (キャンセルを除く) / 請求 = 請求日 / 入金 = 入金日 / 経費 = 承認済・精算済 / 仕入 = 請求日 (支払却下を除く) / 簡易粗利 = 売上 − 畳原価 − 仕入 − 経費。金額はすべて税込です。
        {hasMigrated && " 販売管理ソフトから移行した受注 (移行データ) は契約日 = 売上計上日のため、受注と売上が同じ金額になります。"}
      </Note>
    </div>
  );
}
