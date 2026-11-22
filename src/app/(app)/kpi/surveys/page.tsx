import Link from "@/components/ui/Link";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canReadStoreRecords, canSeeAllStoreFigures } from "@/lib/auth/permissions";
import { policyReader } from "@/lib/access-policy";

import { answerCounts, deliveryOf, fmtRate, inPeriod, isCard, storeKpi, surveyDate } from "@/lib/kpi";
import { kpiSettings } from "@/lib/kpi-settings";
import { resolvePeriod } from "@/lib/kpi-period";
import { fmtDate, toDateKey } from "@/lib/format";
import { SCORE_QUESTIONS } from "@/lib/survey";
import { KpiTabs } from "@/components/kpi/KpiTabs";
import { PeriodSelect } from "@/components/kpi/PeriodSelect";
import { Card, CardHeader, Flash, LinkButton, PageHeader, Pager, Select, StoreTag, paginate } from "@/components/ui";
import { SurveyYearCompare } from "@/components/kpi/SurveyYearCompare";
import { surveyYearComparison } from "@/lib/survey-workbook/compare";

function Bars({ rows, total }: { rows: [string, number][]; total: number }) {
  if (!rows.length) return <p className="text-xs text-ink-3">回答はありません</p>;
  const max = Math.max(...rows.map((r) => r[1]));
  return (
    <ul className="space-y-1">
      {rows.map(([label, n]) => (
        <li key={label} className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_3.5rem] items-center gap-2 text-xs">
          <span className="truncate text-ink-2">{label}</span>
          <span className="h-2.5 rounded-full bg-subtle"><span className="block h-2.5 rounded-full bg-accent" style={{ width: `${(n / max) * 100}%` }} /></span>
          <span className="text-right tnum">{n} <span className="text-ink-3">({total ? Math.round((n / total) * 100) : 0}%)</span></span>
        </li>
      ))}
    </ul>
  );
}

export default async function SurveysPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const settings = kpiSettings(db);
  const today = toDateKey(new Date());
  const rp = resolvePeriod(sp, settings.fiscalStartMonth, today);
  // はがきの一覧は顧客情報、年度ごとの比較は経営の数字の閲覧の範囲 (src/lib/access-policy.ts)
  const reader = policyReader(db, user);
  const store = sp.store && canReadStoreRecords(reader, sp.store as never) ? sp.store : "";
  const q = sp.q?.trim() ?? "";
  const users = new Map(db.users.map((u) => [u.id, u.name]));
  const orders = new Map(db.orders.map((o) => [o.id, o]));
  const customers = new Map(db.customers.map((c) => [c.id, c]));
  let rows = db.surveys.filter((s) => canReadStoreRecords(reader, s.storeId)).filter((s) => isCard(s) && inPeriod(surveyDate(s), rp.period) && (!store || s.storeId === store));
  if (sp.link === "linked") rows = rows.filter((s) => s.orderId);
  if (sp.link === "unlinked") rows = rows.filter((s) => !s.orderId);
  if (q) rows = rows.filter((s) => [s.postcardNo, s.comment, s.salesName, s.craftsmanName, users.get(s.salesUserId ?? ""), ...deliveryOf(s).map((id) => users.get(id))].some((t) => t?.includes(q)));
  rows.sort((a, b) => surveyDate(b).localeCompare(surveyDate(a)));
  const paged = paginate(rows, sp.page, 50);
  const counts = answerCounts(rows);
  const stores = db.stores.filter((s) => s.kind === "store" && canReadStoreRecords(reader, s.id));
  const cmap = customers;
  const SOURCE: Record<string, string> = { import: "移行", capture: "写真", manual: "手入力" };
  // 年度ごとの比較: 経営の数字を全店舗見られない人は自店舗だけ (全社・ほかの店舗の数字を見せない)
  const compareStore = canSeeAllStoreFigures(reader) ? ((store || undefined) as typeof user.storeId | undefined) : user.storeId;
  const compareCols = surveyYearComparison(db, { storeId: compareStore, fiscalStartMonth: settings.fiscalStartMonth });
  const compareLabel = compareStore ? (db.stores.find((s) => s.id === compareStore)?.name ?? compareStore) : "全社";

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader
        title="KPI · お客様アンケート"
        actions={
          <>
            <LinkButton href="/capture?kind=survey_postcard" size="sm">はがきを撮影して登録</LinkButton>
            <LinkButton href="/kpi/surveys/new" variant="secondary" size="sm">手入力で登録</LinkButton>
          </>
        }
      />
      <KpiTabs current="/kpi/surveys" sp={sp} user={user} />
      <PeriodSelect
        action="/kpi/surveys"
        value={rp.value}
        startMonth={settings.fiscalStartMonth}
        today={today}
        extra={
          <>
            <label className="block"><span className="label">店舗</span><Select name="store" defaultValue={store} className="h-9 py-1 text-sm"><option value="">すべて</option>{db.stores.filter((s) => canReadStoreRecords(reader, s.id)).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></label>
            <label className="block"><span className="label">案件の紐づけ</span><Select name="link" defaultValue={sp.link ?? ""} className="h-9 py-1 text-sm"><option value="">すべて</option><option value="linked">紐づけ済み</option><option value="unlinked">未設定</option></Select></label>
            <label className="block"><span className="label">キーワード</span><input name="q" defaultValue={q} className="field h-9 py-1 text-sm" placeholder="No.・担当者・記述" /></label>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-3">
        <Card>
          <CardHeader title="返信率 (店舗別)" description="返信数 ÷ 個人のお客様の案件数" />
          <ul className="space-y-1.5 text-sm">
            {[...stores.map((s) => ({ label: <StoreTag store={s} short />, k: storeKpi(db, rp.period, s.id, cmap) })), { label: <span className="font-semibold">全社</span>, k: storeKpi(db, rp.period, undefined, cmap) }].map((r, i) => (
              <li key={i} className="flex items-center justify-between gap-2"><span>{r.label}</span><span className="tnum">{r.k.surveys} / {r.k.individualOrders} 件 · <span className="font-semibold">{fmtRate(r.k.replyRate)}</span></span></li>
            ))}
          </ul>
        </Card>
        <Card>
          <CardHeader title="⑤ 重視されたこと" description={`${rows.length} 枚中の件数 (複数回答)`} />
          <Bars rows={counts.priorities} total={rows.length} />
        </Card>
        <Card>
          <CardHeader title="⑥ 依頼のきっかけ" description="お客様ご自身の回答 (見積時の聞き取りとは別)" />
          <Bars rows={counts.media} total={rows.length} />
          <p className="mt-3 text-xs text-ink-2">⑦ 次回も依頼したい: はい {counts.again.yes} / いいえ {counts.again.no}</p>
        </Card>
      </div>

      <SurveyYearCompare cols={compareCols} scopeLabel={compareLabel} />

      <Card className="mt-4" padded={false}>
        <div className="px-5 pt-5"><CardHeader title={`アンケート一覧 (${rp.label})`} description={`${rows.length.toLocaleString("ja-JP")} 枚`} /></div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1000px] text-sm">
            <thead>
              <tr className="bg-subtle text-xs text-ink-2">
                <th className="px-4 py-2 text-left font-medium">回答日</th>
                <th className="px-2 py-2 text-left font-medium">No.</th>
                <th className="px-2 py-2 text-left font-medium">店舗</th>
                <th className="px-2 py-2 text-left font-medium">案件</th>
                {SCORE_QUESTIONS.map((x) => <th key={x.key} className="px-1 py-2 text-right font-medium">{x.no}</th>)}
                <th className="px-2 py-2 text-left font-medium">営業 / 職人</th>
                <th className="px-2 py-2 text-left font-medium">⑦</th>
                <th className="px-2 py-2 text-left font-medium">⑧</th>
                <th className="px-4 py-2 text-left font-medium">登録</th>
              </tr>
            </thead>
            <tbody>
              {paged.items.length === 0 && <tr><td colSpan={12} className="px-4 py-8 text-center text-ink-3">該当するアンケートはありません</td></tr>}
              {paged.items.map((s) => {
                const o = s.orderId ? orders.get(s.orderId) : undefined;
                return (
                  <tr key={s.id} className="border-t border-line hover:bg-subtle/60">
                    <td className="px-4 py-2 text-xs tnum"><Link href={`/kpi/surveys/${s.id}`} className="text-accent hover:underline">{fmtDate(surveyDate(s))}</Link></td>
                    <td className="px-2 py-2 text-xs">{s.postcardNo ?? "-"}</td>
                    <td className="px-2 py-2"><StoreTag store={db.stores.find((x) => x.id === s.storeId)} short /></td>
                    <td className="px-2 py-2 text-xs">{o ? <Link href={`/orders/${o.id}`} className="text-accent hover:underline">{o.number} {customers.get(o.customerId)?.name}</Link> : <span className="text-warn-ink">未設定</span>}</td>
                    {SCORE_QUESTIONS.map((x) => <td key={x.key} className="px-1 py-2 text-right tnum">{s[x.key] ?? "-"}</td>)}
                    <td className="px-2 py-2 text-xs">{users.get(s.salesUserId ?? "") ?? s.salesName ?? "-"} / {deliveryOf(s).map((id) => users.get(id)).filter(Boolean).join("・") || s.craftsmanName || "-"}</td>
                    <td className="px-2 py-2 text-xs">{s.wouldUseAgain ?? "-"}</td>
                    <td className="max-w-[16rem] truncate px-2 py-2 text-xs text-ink-2" title={s.comment}>{s.comment ?? ""}</td>
                    <td className="px-4 py-2 text-xs text-ink-3">{SOURCE[s.source ?? "import"]}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="px-5 pb-4"><Pager paged={paged} path="/kpi/surveys" sp={sp} /></div>
      </Card>
    </div>
  );
}
