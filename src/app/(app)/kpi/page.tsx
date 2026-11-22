import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canAccessStore, canViewStaffKpi } from "@/lib/auth/permissions";
import { fmtRate, fmtScore, staffKpis, storeKpi, type StoreKpi } from "@/lib/kpi";
import { kpiSettings } from "@/lib/kpi-settings";
import { resolvePeriod } from "@/lib/kpi-period";
import { toDateKey } from "@/lib/format";
import { SCORE_QUESTIONS } from "@/lib/survey";
import { KpiTabs } from "@/components/kpi/KpiTabs";
import { PeriodSelect } from "@/components/kpi/PeriodSelect";
import { Card, CardHeader, Flash, LinkButton, PageHeader, StoreTag } from "@/components/ui";

export default async function KpiPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const settings = kpiSettings(db);
  const today = toDateKey(new Date());
  const rp = resolvePeriod(sp, settings.fiscalStartMonth, today);
  const customers = new Map(db.customers.map((c) => [c.id, c]));
  const stores = db.stores.filter((s) => canAccessStore(user, s.id));
  const rows: { label: React.ReactNode; k: StoreKpi; total?: boolean }[] = [
    ...stores.map((s) => ({ label: <StoreTag store={s} short />, k: storeKpi(db, rp.period, s.id, customers) })),
    { label: "全社", k: storeKpi(db, rp.period, undefined, customers), total: true },
  ];
  const userById = new Map(db.users.map((u) => [u.id, u]));
  const staff = staffKpis(db, rp.period)
    .filter((r) => {
      const u = userById.get(r.userId);
      return u && canViewStaffKpi(user, u) && (r.phoneCount || r.deliveryCount || r.orders || r.qualityCount || r.reviews);
    })
    .sort((a, b) => (userById.get(a.userId)!.storeId.localeCompare(userById.get(b.userId)!.storeId)) || b.deliveryCount - a.deliveryCount);

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader
        title="KPI · 概要"
        description="アンケート・クレーム・手直し・Google 口コミを案件・担当者・店舗に紐づけて自動で集計します"
        actions={
          <>
            <LinkButton href="/capture?kind=survey_postcard" size="sm">はがきを撮影して登録</LinkButton>
            <LinkButton href="/kpi/surveys/new" variant="secondary" size="sm">手入力で登録</LinkButton>
            <LinkButton href="/kpi/reviews" variant="secondary" size="sm">Google 口コミを登録</LinkButton>
          </>
        }
      />
      <KpiTabs current="/kpi" sp={sp} user={user} />
      <PeriodSelect action="/kpi" value={rp.value} startMonth={settings.fiscalStartMonth} today={today} />

      <Card padded={false}>
        <div className="px-5 pt-5"><CardHeader title={`店舗別・全社 (${rp.label})`} description="案件は売上計上日 (なければ完了日・契約日)、アンケートははがきの回答日、クレーム・手直しは発生日、口コミは投稿日で期間を判定します" /></div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-sm">
            <thead>
              <tr className="bg-subtle text-xs text-ink-2">
                <th className="px-4 py-2 text-left font-medium">店舗</th>
                <th className="px-2 py-2 text-right font-medium">案件</th>
                <th className="px-2 py-2 text-right font-medium">個人案件</th>
                <th className="px-2 py-2 text-right font-medium">返信</th>
                <th className="px-2 py-2 text-right font-medium">返信率</th>
                {SCORE_QUESTIONS.map((q) => <th key={q.key} className="px-2 py-2 text-right font-medium">{q.no}{q.label.replace("について", "")}</th>)}
                <th className="px-2 py-2 text-right font-medium">次回も依頼</th>
                <th className="px-2 py-2 text-right font-medium">クレーム・手直し<br />点 / 率</th>
                <th className="px-2 py-2 text-right font-medium">クレーム発生<br />案件 / 率</th>
                <th className="px-4 py-2 text-right font-medium">口コミ<br />件 / 点</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className={`border-t border-line ${r.total ? "bg-accent-soft/30 font-semibold" : ""}`}>
                  <td className="px-4 py-2">{r.label}</td>
                  <td className="px-2 py-2 text-right tnum">{r.k.orders.toLocaleString("ja-JP")}</td>
                  <td className="px-2 py-2 text-right tnum">{r.k.individualOrders.toLocaleString("ja-JP")}</td>
                  <td className="px-2 py-2 text-right tnum">{r.k.surveys.toLocaleString("ja-JP")}</td>
                  <td className="px-2 py-2 text-right tnum">{fmtRate(r.k.replyRate)}</td>
                  {SCORE_QUESTIONS.map((q) => (
                    <td key={q.key} className="px-2 py-2 text-right tnum">{fmtScore(r.k.scores[q.key])}<span className="ml-0.5 text-[10px] font-normal text-ink-3">({r.k.scoreCounts[q.key]})</span></td>
                  ))}
                  <td className="px-2 py-2 text-right tnum">{r.k.againAnswered ? fmtRate((r.k.againYes / r.k.againAnswered) * 100, 0) : "-"}</td>
                  <td className="px-2 py-2 text-right tnum">{r.k.qualityPoints} / {fmtRate(r.k.qualityRate, 2)}</td>
                  <td className="px-2 py-2 text-right tnum">{r.k.claimCases} / {fmtRate(r.k.claimRate, 2)}</td>
                  <td className="px-4 py-2 text-right tnum">{r.k.reviews} / {r.k.reviewPoints}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul className="space-y-0.5 px-5 py-3 text-[11px] text-ink-3">
          <li>・返信率 = 返信されたアンケートはがきの件数 ÷ 個人のお客様の案件数 × 100 (はがきは個人のお客様にだけお渡ししています)</li>
          <li>・①〜④ は 5 段階評価の平均 (括弧内は回答数)。① は全社 (事務)、② は営業担当 (見積り)、③ は担当職人、④ は店舗の評価です。⑤⑥⑦ は「アンケート」タブで集計しています</li>
          <li>・クレーム・手直し率 = クレーム・手直しの合計ポイント (手直し {settings.qualityPoints.rework} / クレーム {settings.qualityPoints.claim} / クレーム＋手直し {settings.qualityPoints.claim_rework} 点) ÷ 期間内の総案件数 (個人・業者を問わない) × 100</li>
          <li>・クレーム発生率 = クレーム (クレーム＋手直しを含む) が発生した案件数 ÷ 期間内の総案件数 × 100</li>
        </ul>
      </Card>

      <Card className="mt-4" padded={false}>
        <div className="px-5 pt-5"><CardHeader title="社員別" description={user.role === "store_staff" ? "あなたの数値です" : user.role === "store_manager" ? "所属店舗の社員の数値です" : "全社員の数値です"} /></div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[880px] text-sm">
            <thead>
              <tr className="bg-subtle text-xs text-ink-2">
                <th className="px-4 py-2 text-left font-medium">社員</th>
                <th className="px-2 py-2 text-right font-medium">① 電話対応<br />(はがきの事務担当)</th>
                <th className="px-2 py-2 text-right font-medium">② 営業対応<br />(営業担当として)</th>
                <th className="px-2 py-2 text-right font-medium">③ 職人対応<br />(担当職人として)</th>
                <th className="px-2 py-2 text-right font-medium">担当案件</th>
                <th className="px-2 py-2 text-right font-medium">クレーム・手直し<br />件 / 点 / 率</th>
                <th className="px-4 py-2 text-right font-medium">Google 口コミ<br />件 / 点</th>
              </tr>
            </thead>
            <tbody>
              {staff.length === 0 && <tr><td colSpan={7} className="px-4 py-6 text-center text-sm text-ink-3">この期間の記録はありません</td></tr>}
              {staff.map((r) => {
                const u = userById.get(r.userId)!;
                return (
                  <tr key={r.userId} className="border-t border-line">
                    <td className="px-4 py-2"><span className="font-medium">{u.name}</span> <StoreTag store={db.stores.find((s) => s.id === u.storeId)} short /></td>
                    <td className="px-2 py-2 text-right tnum">{fmtScore(r.phoneAvg)} <span className="text-[10px] text-ink-3">({r.phoneCount})</span></td>
                    <td className="px-2 py-2 text-right tnum">{fmtScore(r.salesAvg)} <span className="text-[10px] text-ink-3">({r.salesCount})</span></td>
                    <td className="px-2 py-2 text-right tnum">{fmtScore(r.craftsmanAvg)} <span className="text-[10px] text-ink-3">({r.craftsmanCount})</span></td>
                    <td className="px-2 py-2 text-right tnum">{r.orders.toLocaleString("ja-JP")}</td>
                    <td className="px-2 py-2 text-right tnum">{r.qualityCount} / {r.qualityPoints} / {fmtRate(r.qualityRate, 2)}</td>
                    <td className="px-4 py-2 text-right tnum">{r.reviews} / {r.reviewPoints}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="px-5 py-3 text-[11px] text-ink-3">② は営業担当 (見積り)、③ は担当職人の評価です。職人が複数のときは全員に同じ評価が付きます。① の支給は全社の平均で決まります。担当案件 = 施工担当として登録された案件 (社員別のクレーム・手直し率の分母)。</p>
      </Card>
    </div>
  );
}
