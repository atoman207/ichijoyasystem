import { redirect } from "next/navigation";
import { Download } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canSeeAllStores, canViewReports } from "@/lib/auth/permissions";
import { fmtShortMonth, fmtMonth, pct, toDateKey, yen } from "@/lib/format";
import { PERIOD_LABEL, managementReport, resolvePeriod, staffOptions, type MgmtCsvSection, type PeriodPreset } from "@/lib/management";
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
  const staffFilter = sp.staff && people.some((u) => u.id === sp.staff) ? sp.staff : undefined;
  const r = managementReport(db, user, { from: period.from, to: period.to, storeId: storeFilter, staffId: staffFilter }, now);
  const t = r.totals;
  const storeMap = new Map(db.stores.map((s) => [s.id, s]));

  // 同じ条件の CSV
  const qs = new URLSearchParams(Object.entries({ period: period.preset, from: period.preset === "custom" ? period.from : undefined, to: period.preset === "custom" ? period.to : undefined, store: storeFilter, staff: staffFilter }).filter(([, v]) => v) as [string, string][]);
  const csv = (section: MgmtCsvSection) => `/api/reports?section=${section}&${qs.toString()}`;

  const salesSeries = r.stores.map((s) => ({ key: s.id, label: s.name, color: s.color }));
  const salesData = r.months.map((m) => ({ label: fmtShortMonth(m.month), fullLabel: fmtMonth(m.month), values: m.byStore }));
  const flowSeries = [
    { key: "sales", label: "売上", color: "#3340b8" },
    { key: "received", label: "入金", color: "#14a39a" },
    { key: "purchases", label: "仕入", color: "#e0a21a" },
    { key: "expenses", label: "経費", color: "#e2603a" },
  ];
  const flowData = r.months.map((m) => ({ label: fmtShortMonth(m.month), fullLabel: fmtMonth(m.month), values: { sales: m.sales, received: m.received, purchases: m.purchases, expenses: m.expenses } }));
  const pipelineMax = Math.max(...r.pipeline.map((p) => p.count), 1);

  // お客様アンケート (選択期間・選択店舗)
  const svStores = db.stores.filter((st) => r.stores.some((x) => x.id === st.id));
  const avg = (xs: (number | undefined)[]) => {
    const v = xs.filter((x): x is number => typeof x === "number");
    return v.length ? (v.reduce((a, x) => a + x, 0) / v.length).toFixed(2) : "-";
  };
  const surveyRows = svStores
    .map((st) => {
      const list = db.surveys.filter((x) => x.storeId === st.id && (x.answeredOn ?? x.receivedAt.slice(0, 10)) >= period.from && (x.answeredOn ?? x.receivedAt.slice(0, 10)) <= period.to);
      const answered = list.filter((x) => x.wouldUseAgain);
      return { store: st, n: list.length, phone: avg(list.map((x) => x.phoneScore)), sales: avg(list.map((x) => x.salesScore)), craft: avg(list.map((x) => x.craftsmanScore)), finish: avg(list.map((x) => x.finishScore)), again: answered.length ? Math.round((100 * answered.filter((x) => /はい/.test(x.wouldUseAgain ?? "")).length) / answered.length) : null };
    })
    .filter((x) => x.n > 0);

  const scopeText = [storeFilter ? storeMap.get(storeFilter)?.name : allStores ? "全店舗" : storeMap.get(user.storeId)?.name, staffFilter ? `担当 ${people.find((u) => u.id === staffFilter)?.name}` : ""].filter(Boolean).join(" · ");

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
          <Select name="staff" defaultValue={staffFilter ?? ""} className="w-auto max-w-[14rem]">
            <option value="">全員</option>
            {people.map((u) => <option key={u.id} value={u.id}>{u.name}{u.active ? "" : " (退職)"} · {storeMap.get(u.storeId)?.shortName}</option>)}
          </Select>
        </label>
        <button type="submit" className="h-9 rounded-lg bg-accent px-4 text-sm font-medium text-white hover:bg-accent-hover">集計する</button>
        <p className="basis-full text-[11px] text-ink-3">「から・まで」は期間で「期間を指定」を選んだときに使います。売上は施工完了 (売上計上日)、受注は契約日、請求は請求日、入金は入金日で数えます。未入金残高は今日時点の値です。</p>
      </form>

      <div className="mb-4 grid grid-cols-1 gap-3 @md:grid-cols-2 @3xl:grid-cols-3 @6xl:grid-cols-5">
        <Stat label="売上 (税込・施工完了)" value={yen(t.sales)} sub={`${t.salesCount.toLocaleString("ja-JP")} 件`} />
        <Stat label="受注 (契約日)" value={yen(t.orderAmount)} sub={`${t.orderCount.toLocaleString("ja-JP")} 件 · 平均 ${yen(t.orderCount ? t.orderAmount / t.orderCount : 0)}`} />
        <Stat label="問い合わせ → 見積 → 受注" value={<span className="text-xl whitespace-nowrap">{`${t.inquiries} → ${t.quotes} → ${t.orderCount}`}</span>} sub={`見積化率 ${t.inquiries ? pct(t.quotes / t.inquiries) : "-"} · 施工完了 ${t.jobsCompleted} 件`} />
        <Stat label="請求 / 入金" value={<span className="text-xl">{yen(t.invoiced)}</span>} sub={`入金 ${yen(t.received)} · 請求 ${t.invoiceCount} 件`} />
        <Stat label="未入金残高 (今日時点)" value={yen(t.receivables)} sub={t.overdue > 0 ? `期日超過 ${yen(t.overdue)} (${t.overdueCount} 件)` : "期日超過なし"} tone={t.overdue > 0 ? "critical" : undefined} href="/finance" />
      </div>
      <div className="mb-5 grid grid-cols-1 gap-3 @md:grid-cols-3">
        <Stat label="経費 (承認済・精算済)" value={yen(t.expenses)} sub={t.expensesPending ? `承認待ち ${yen(t.expensesPending)}` : "承認待ちなし"} accent="warn" />
        <Stat label="仕入 (請求日)" value={yen(t.purchases)} accent="warn" />
        <Stat label="簡易粗利 (売上 − 仕入 − 経費)" value={yen(t.gross)} sub={`売上比 ${t.sales ? pct(t.gross / t.sales) : "-"} · 税込のまま計算 (会計上の利益ではありません)`} tone={t.gross < 0 ? "critical" : undefined} accent="good" />
      </div>

      <div className="mb-4 grid grid-cols-1 gap-4 @5xl:grid-cols-2">
        <Card>
          <CardHeader title="月次売上 (店舗別・税込)" description="施工完了 (売上計上日) ベース" action={<CsvLink href={csv("monthly")} />} />
          <StackedBarChart data={salesData} series={salesSeries} height={240} title="月次売上" />
        </Card>
        <Card>
          <CardHeader title="売上・入金・仕入・経費の推移" description="経費は承認済・精算済、仕入は請求日で集計" action={<CsvLink href={csv("monthly")} />} />
          <StackedBarChart data={flowData} series={flowSeries} height={240} title="売上・入金・仕入・経費" defaultType="line" />
        </Card>
      </div>

      <div className="mb-4 grid grid-cols-1 gap-4 @4xl:grid-cols-2">
        <Card>
          <CardHeader title="受注の進み具合" description="契約日が期間内の受注を、今の状態で分けています" action={<CsvLink href={csv("pipeline")} />} />
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
          <p className="mt-2 text-[11px] text-ink-3">移行データ (売上台帳) の受注には請求書がないため、請求・入金の件数には含まれません。</p>
        </Card>
      </div>

      <Card padded={false} className="mb-4">
        <div className="px-5 pt-5"><CardHeader title="店舗別" description="期間内の集計 (未入金残高は今日時点)" action={<CsvLink href={csv("stores")} />} /></div>
        <Table className="rounded-none rounded-b-2xl border-0 shadow-none" minWidth="min-w-[980px]">
          <thead>
            <tr><Th className="pl-5">店舗</Th><Th align="right">売上</Th><Th align="right">受注</Th><Th align="right">平均単価</Th><Th align="right">問い合わせ</Th><Th align="right">見積</Th><Th align="right">成約率</Th><Th align="right">施工完了</Th><Th align="right">入金</Th><Th align="right">未入金残</Th><Th align="right">経費</Th><Th align="right">仕入</Th><Th align="right" className="pr-5">簡易粗利</Th></tr>
          </thead>
          <tbody>
            {r.storeRows.map((s) => (
              <Tr key={s.storeId}>
                <Td className="pl-5"><StoreTag store={storeMap.get(s.storeId)} short /></Td>
                <Td align="right" className="font-semibold">{yen(s.sales)}</Td>
                <Td align="right">{s.orderCount} 件<br /><span className="text-[11px] text-ink-3">{yen(s.orderAmount)}</span></Td>
                <Td align="right">{yen(s.avgOrder)}</Td>
                <Td align="right">{s.inquiries}</Td>
                <Td align="right">{s.quotes}</Td>
                <Td align="right">{s.winRate === null ? "-" : pct(s.winRate)}</Td>
                <Td align="right">{s.jobsCompleted}</Td>
                <Td align="right">{yen(s.received)}</Td>
                <Td align="right">{yen(s.receivables)}{s.overdue > 0 && <span className="block text-[11px] text-critical-ink">超過 {yen(s.overdue)}</span>}</Td>
                <Td align="right">{yen(s.expenses)}</Td>
                <Td align="right">{yen(s.purchases)}</Td>
                <Td align="right" className={`pr-5 ${s.gross < 0 ? "text-critical-ink" : ""}`}>{yen(s.gross)}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </Card>

      <Card padded={false} className="mb-4">
        <div className="px-5 pt-5"><CardHeader title="担当者別" description="受注・売上は受注を登録した人、施工完了は施工担当、問い合わせは担当者で数えています" action={<CsvLink href={csv("staff")} />} /></div>
        <Table className="rounded-none rounded-b-2xl border-0 shadow-none" minWidth="min-w-[860px]">
          <thead>
            <tr><Th className="pl-5">担当者</Th><Th>所属</Th><Th align="right">問い合わせ</Th><Th align="right">見積</Th><Th align="right">受注</Th><Th align="right">受注金額</Th><Th align="right">売上</Th><Th align="right">施工完了</Th><Th align="right" className="pr-5">経費</Th></tr>
          </thead>
          <tbody>
            {r.staffRows.slice(0, 100).map((s) => (
              <Tr key={s.userId}>
                <Td className="pl-5"><span className="font-medium">{s.name}</span><span className="block text-[11px] text-ink-3">{s.role}</span></Td>
                <Td><StoreTag store={storeMap.get(s.storeId)} short /></Td>
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
        {r.staffRows.length > 100 && <p className="px-5 py-2 text-[11px] text-ink-3">上位 100 人を表示しています。すべては CSV で確認できます。</p>}
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

      {surveyRows.length > 0 && (
        <Card className="mb-4" padded={false}>
          <div className="px-5 pt-5">
            <CardHeader title="お客様アンケート" description="回答日が期間内のアンケートハガキ (5 段階評価の平均)" />
          </div>
          <Table className="rounded-none rounded-b-2xl border-0 shadow-none" minWidth="min-w-[640px]">
            <thead>
              <tr><Th className="pl-5">店舗</Th><Th align="right">回答数</Th><Th align="right">電話対応</Th><Th align="right">営業対応</Th><Th align="right">職人対応</Th><Th align="right">工事の仕上り</Th><Th align="right" className="pr-5">次回も依頼したい</Th></tr>
            </thead>
            <tbody>
              {surveyRows.map((x) => (
                <Tr key={x.store.id}>
                  <Td className="pl-5"><StoreTag store={x.store} /></Td>
                  <Td align="right">{x.n}</Td>
                  <Td align="right">{x.phone}</Td>
                  <Td align="right">{x.sales}</Td>
                  <Td align="right">{x.craft}</Td>
                  <Td align="right">{x.finish}</Td>
                  <Td align="right" className="pr-5">{x.again === null ? "-" : `${x.again}%`}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      <Note>集計の基準: 売上 = 受注の売上計上日 (施工完了) が期間内 / 受注 = 契約日が期間内 (キャンセルを除く) / 請求 = 請求日 / 入金 = 入金日 / 経費 = 承認済・精算済 / 仕入 = 請求日 (支払却下を除く)。金額はすべて税込です。</Note>
    </div>
  );
}
