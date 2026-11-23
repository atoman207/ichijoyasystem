import Link from "@/components/ui/Link";
import { Download } from "lucide-react";
import type { Database, User } from "@/lib/db/types";
import { canSeeAllStoreFigures } from "@/lib/auth/permissions";
import { yen } from "@/lib/format";
import { MEDIA_KEYS, MEDIA_LABEL, MEDIA_NONE, UNCLASSIFIED } from "@/lib/media";
import { PROMOTION_KIND, PROMOTION_STATUS, type PromoCsvSection, type PromoReport } from "@/lib/ops-reports/promo-analysis";
import { PeriodSelect } from "@/components/kpi/PeriodSelect";
import { Badge, Card, CardHeader, Note, Stat, Table, Td, Th, Tr } from "@/components/ui";

const n = (v: number) => v.toLocaleString("ja-JP");
const rate = (a: number, b: number) => (b ? `${Math.round((a / b) * 1000) / 10}%` : "-");

function Csv({ href }: { href: string }) {
  return (
    <a href={href} download className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[11px] font-medium text-ink-2 hover:bg-subtle hover:text-ink">
      <Download className="h-3 w-3" aria-hidden /> CSV
    </a>
  );
}

export function AnalysisTab({ db, user, report: r, periodValue, periodLabel, startMonth, today, store, sp }: { db: Database; user: User; report: PromoReport; periodValue: string; periodLabel: string; startMonth: number; today: string; store: string; sp: Record<string, string | undefined> }) {
  const { from, to } = r.scope;
  const qs = new URLSearchParams();
  if (sp.p) qs.set("p", sp.p);
  if (sp.from && sp.to && !sp.p) {
    qs.set("from", sp.from);
    qs.set("to", sp.to);
  }
  if (store) qs.set("store", store);
  const csv = (section: PromoCsvSection) => `/api/promotions?section=${section}${qs.toString() ? `&${qs.toString()}` : ""}`;
  // 問い合わせ一覧の同じ条件 (件数が一致する)
  const inquiriesHref = (media?: string) => {
    const p = new URLSearchParams({ from, to });
    if (media) p.set("media", media);
    if (store) p.set("store", store);
    return `/inquiries?${p.toString()}`;
  };
  const scopeName = r.scope.storeIds.length === 1 ? (db.stores.find((s) => s.id === r.scope.storeIds[0])?.name ?? "") : "全店舗";
  const t = r.totals;
  const maxMedia = Math.max(1, ...r.media.map((m) => m.inquiries));
  const maxSurvey = Math.max(1, ...r.surveys.map((s) => s.count));

  return (
    <div className="space-y-4">
      <PeriodSelect
        action="/promotions"
        value={periodValue}
        startMonth={startMonth}
        today={today}
        extra={
          canSeeAllStoreFigures(user) ? (
            <label className="block">
              <span className="label">店舗</span>
              <select name="store" defaultValue={store} className="field h-9 py-1 text-sm">
                <option value="">全店舗</option>
                {db.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
          ) : undefined
        }
      />
      <p className="-mt-2 text-xs text-ink-3">{periodLabel} · {scopeName} · 受付日 {from.replaceAll("-", "/")}〜{to.replaceAll("-", "/")}</p>

      <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-3 @5xl:grid-cols-5">
        <Stat label="問い合わせ" value={`${n(t.inquiries)} 件`} sub={`入力 ${n(t.input)} · 推定 ${n(t.estimated)} · 未分類 ${n(t.unclassified)}`} href={inquiriesHref()} />
        <Stat label="成約 (成約率)" value={`${n(t.won)} 件`} sub={rate(t.won, t.inquiries)} />
        <Stat label="成約の売上 (税込)" value={yen(t.sales)} />
        <Stat label="チラシの部数" value={`${n(t.flyerCopies)} 部`} sub="販促の記録 + 作業日報" />
        <Stat label="来店数" value={`${n(t.visitors)} 人`} sub="作業日報の手入力" />
      </div>

      <Card padded={false}>
        <div className="px-5 pt-5">
          <CardHeader
            title="販促 KPI (経営分析用)"
            description="チラシの反響・個人の売上・客単価などの販促の指標です。経営分析に使う別の指標で、インセンティブの計算には使いません。個人件数は売上の実績どおり 1 件ずつ数えます (アンケート返信率の分母は、約 1 か月以内のリピートを 1 件にまとめた別の数字です)"
            action={<Csv href={csv("kpi")} />}
          />
        </div>
        <Table minWidth="min-w-[960px]">
          <thead>
            <tr>
              <Th>店舗</Th>
              <Th align="right">全案件数</Th>
              <Th align="right">個人件数</Th>
              <Th align="right">個人の売上 (税込)</Th>
              <Th align="right">個人客単価</Th>
              <Th align="right">チラシの部数</Th>
              <Th align="right">問い合わせ</Th>
              <Th align="right">チラシの反響 (1,000 部あたり)</Th>
              <Th align="right">成約 (成約率)</Th>
            </tr>
          </thead>
          <tbody>
            {r.kpi.map((k) => (
              <Tr key={k.storeId} className={k.storeId === "all" ? "font-semibold" : ""}>
                <Td>{k.storeId === "all" ? "合計" : (db.stores.find((s) => s.id === k.storeId)?.name ?? k.storeId)}</Td>
                <Td align="right">{n(k.cases)}</Td>
                <Td align="right">
                  {n(k.individualCases)}
                  {k.plan && <span className="block text-[10px] font-normal text-ink-3" title="年間チラシ計画「個人件数売上」の本年度実績 (取込・手入力)">年間チラシ計画 {n(k.plan.value)}{k.plan.months < k.plan.of ? ` (${k.plan.months}/${k.plan.of} か月)` : ""}</span>}
                </Td>
                <Td align="right">{yen(k.individualSales)}</Td>
                <Td align="right">{k.unitPrice === null ? "-" : yen(k.unitPrice)}</Td>
                <Td align="right">{n(k.flyerCopies)}</Td>
                <Td align="right">{n(k.inquiries)}</Td>
                <Td align="right">{n(k.flyerInquiries)} 件{k.per1000 !== null && <span className="block text-[10px] font-normal text-ink-3">{k.per1000} 件 / 1,000 部</span>}</Td>
                <Td align="right">{n(k.won)}<span className="block text-[10px] font-normal text-ink-3">{k.winRate === null ? "-" : `${Math.round(k.winRate * 1000) / 10}%`}</span></Td>
              </Tr>
            ))}
          </tbody>
        </Table>
        <p className="px-5 py-3 text-[11px] text-ink-3">全案件数・個人件数・売上 = 売上台帳の現場名の行 + 新システムで完了した受注 (売上計上日 = 施工完了日が期間内)。客単価 = 個人の売上 ÷ 個人件数。チラシの部数 = 販促の記録 (実施済み) + 作業日報の配布。問い合わせは受付日、成約は問い合わせから受注になったもの。</p>
      </Card>

      {t.unclassified > 0 && (
        <Note tone="warn">
          媒体がわからない問い合わせが {n(t.unclassified)} 件あります (移行・自動受付で媒体の入力がなく、見積・受注の媒体欄や顧客の媒体からも読み替えられないもの)。
          <Link href={inquiriesHref(MEDIA_NONE)} className="ml-1 underline">一覧で開く</Link>。新しい問い合わせは登録時に媒体が必須です。
        </Note>
      )}

      <Card>
        <CardHeader title="媒体別" description="問い合わせは受付日、受注は契約日が期間内のもの (受注は問い合わせのない移行した受注を含む)。件数を押すと同じ条件の問い合わせ一覧を開きます (件数は一致します)" action={<Csv href={csv("media")} />} />
        <Table minWidth="min-w-[820px]">
          <thead>
            <tr>
              <Th>媒体</Th>
              <Th align="right">問い合わせ</Th>
              <Th>割合</Th>
              <Th align="right">うち入力</Th>
              <Th align="right">うち推定</Th>
              <Th align="right">成約</Th>
              <Th align="right">成約率</Th>
              <Th align="right">成約の売上</Th>
              <Th align="right">受注 (契約日)</Th>
              <Th align="right">受注金額</Th>
            </tr>
          </thead>
          <tbody>
            {r.media.map((m) => (
              <Tr key={m.key}>
                <Td className={m.key === MEDIA_NONE ? "text-warn-ink" : ""}>{m.label}</Td>
                <Td align="right">{m.inquiries ? <Link href={inquiriesHref(m.key)} className="text-accent hover:underline">{n(m.inquiries)}</Link> : "0"}</Td>
                <Td className="w-40"><span className="block h-2 rounded-full bg-subtle"><span className="block h-2 rounded-full bg-accent" style={{ width: `${(m.inquiries / maxMedia) * 100}%` }} /></span></Td>
                <Td align="right">{n(m.input)}</Td>
                <Td align="right">{n(m.estimated)}</Td>
                <Td align="right">{n(m.won)}</Td>
                <Td align="right">{rate(m.won, m.inquiries)}</Td>
                <Td align="right">{yen(m.sales)}</Td>
                <Td align="right">{n(m.orders)}</Td>
                <Td align="right">{yen(m.orderAmount)}</Td>
              </Tr>
            ))}
            <Tr className="font-semibold">
              <Td>合計</Td>
              <Td align="right"><Link href={inquiriesHref()} className="text-accent hover:underline">{n(t.inquiries)}</Link></Td>
              <Td />
              <Td align="right">{n(t.input)}</Td>
              <Td align="right">{n(t.estimated)}</Td>
              <Td align="right">{n(t.won)}</Td>
              <Td align="right">{rate(t.won, t.inquiries)}</Td>
              <Td align="right">{yen(t.sales)}</Td>
              <Td align="right">{n(r.media.reduce((a, m) => a + m.orders, 0))}</Td>
              <Td align="right">{yen(r.media.reduce((a, m) => a + m.orderAmount, 0))}</Td>
            </Tr>
          </tbody>
        </Table>
        <p className="mt-2 text-[11px] text-ink-3">推定 = 問い合わせに媒体の入力がなく、見積・受注の媒体欄 → アンケート → 顧客の媒体 (販売管理ソフト) → 入口 (紹介・イベント) の順に「媒体の分類と対応表」で読み替えたもの。明細は「問い合わせの明細」の CSV で確かめられます <Csv href={csv("inquiries")} /></p>
      </Card>

      <div className="grid grid-cols-1 gap-4 @5xl:grid-cols-2">
        <Card>
          <CardHeader title="月別" description="チラシの部数 (販促の記録の実施済み + 作業日報の配布)・来店数 (作業日報)・問い合わせ" action={<Csv href={csv("monthly")} />} />
          <Table minWidth="min-w-[560px]">
            <thead>
              <tr>
                <Th>月</Th>
                <Th align="right">チラシ (部)</Th>
                <Th align="right">来店数</Th>
                <Th align="right">問い合わせ</Th>
                <Th align="right">うちチラシ</Th>
                <Th align="right">成約</Th>
                <Th align="right">販促</Th>
              </tr>
            </thead>
            <tbody>
              {r.months.map((m) => (
                <Tr key={m.month}>
                  <Td className="tnum">{m.month.replace("-", "/")}</Td>
                  <Td align="right">{n(m.copies)}</Td>
                  <Td align="right">{n(m.visitors)}</Td>
                  <Td align="right">{n(m.inquiries)}</Td>
                  <Td align="right">{n(m.flyerInquiries)}</Td>
                  <Td align="right">{n(m.won)}</Td>
                  <Td align="right">{n(m.promotions)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>

        <Card>
          <CardHeader title="チラシの地域別の反応" description="配布地域 (町名・市区町村) ごとの部数と、その地域に住むお客様の媒体「チラシ」の問い合わせ。1,000 部あたりの件数で比べます" action={<Csv href={csv("flyers")} />} />
          {r.flyerAreas.length === 0 ? (
            <p className="text-sm text-ink-3">期間内のチラシの配布の記録がありません。「販促の記録」でチラシ (地域と部数) を登録するか、作業日報の入力で配布の枚数・地域を入れてください。</p>
          ) : (
            <Table minWidth="min-w-[560px]">
              <thead>
                <tr>
                  <Th>配布地域</Th>
                  <Th align="right">部数</Th>
                  <Th align="right">問い合わせ</Th>
                  <Th align="right">うちチラシ</Th>
                  <Th align="right">チラシの成約</Th>
                  <Th align="right">1,000 部あたり</Th>
                </tr>
              </thead>
              <tbody>
                {r.flyerAreas.map((a) => (
                  <Tr key={a.area}>
                    <Td>{a.area}<div className="text-[10px] text-ink-3">販促の記録 {n(a.fromPromotions)} · 作業日報 {n(a.fromWorkReports)}</div></Td>
                    <Td align="right">{n(a.copies)}</Td>
                    <Td align="right">{n(a.inquiries)}</Td>
                    <Td align="right">{n(a.flyerInquiries)}</Td>
                    <Td align="right">{n(a.won)}</Td>
                    <Td align="right" className="font-semibold">{a.per1000 === null ? "-" : a.per1000.toLocaleString("ja-JP", { maximumFractionDigits: 2 })}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 @5xl:grid-cols-2">
        <Card>
          <CardHeader title="町別 (問い合わせの多い順)" description="お客様の住所 → 施工場所 → 問い合わせの地区 の市区町村・町名。上位 30 町 (すべては CSV)" action={<Csv href={csv("areas")} />} />
          <Table minWidth="min-w-[520px]">
            <thead>
              <tr>
                <Th>町</Th>
                <Th align="right">問い合わせ</Th>
                <Th align="right">うちチラシ</Th>
                <Th align="right">成約</Th>
                <Th align="right">成約の売上</Th>
                <Th align="right">チラシ (部)</Th>
              </tr>
            </thead>
            <tbody>
              {r.areas.slice(0, 30).map((a) => (
                <Tr key={a.town}>
                  <Td>{a.town}</Td>
                  <Td align="right">{n(a.inquiries)}</Td>
                  <Td align="right">{n(a.flyerInquiries)}</Td>
                  <Td align="right">{n(a.won)}</Td>
                  <Td align="right">{yen(a.sales)}</Td>
                  <Td align="right">{a.copies ? n(a.copies) : "-"}</Td>
                </Tr>
              ))}
              {r.areas.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-6 text-center text-sm text-ink-3">期間内の問い合わせがありません</td></tr>
              )}
            </tbody>
          </Table>
        </Card>

        <Card>
          <CardHeader title="アンケートの媒体 (⑥ 何を見てご依頼いただいたか)" description={`はがきの回答を全社共通の分類に読み替えたもの (複数回答)。期間内に媒体の回答があったアンケート ${n(r.surveyCount)} 枚`} action={<Csv href={csv("surveys")} />} />
          {r.surveys.length === 0 ? (
            <p className="text-sm text-ink-3">期間内のアンケートの回答がありません</p>
          ) : (
            <ul className="space-y-1">
              {r.surveys.map((s) => (
                <li key={s.key} className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)_4.5rem] items-center gap-2 text-xs">
                  <span className="truncate text-ink-2">{s.label}</span>
                  <span className="h-2.5 rounded-full bg-subtle"><span className="block h-2.5 rounded-full bg-info" style={{ width: `${(s.count / maxSurvey) * 100}%` }} /></span>
                  <span className="text-right tnum">{s.count} <span className="text-ink-3">({rate(s.count, r.surveyCount)})</span></span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card>
        <CardHeader title="年度の比較" description="期間の終わりの年度と、その前の 2 年度 (年度は KPI の設定の開始月)。問い合わせ / 受注 (契約日) の件数" action={<Csv href={csv("years")} />} />
        <Table minWidth="min-w-[720px]">
          <thead>
            <tr>
              <Th>媒体</Th>
              {r.years.map((y) => <Th key={y.fy} align="right">{y.fy}年度<div className="font-normal text-ink-3">問い合わせ / 受注</div></Th>)}
            </tr>
          </thead>
          <tbody>
            {[...MEDIA_KEYS, MEDIA_NONE].filter((k) => r.years.some((y) => y.byMedia[k].inquiries || y.byMedia[k].orders)).map((k) => (
              <Tr key={k}>
                <Td className={k === MEDIA_NONE ? "text-warn-ink" : ""}>{k === MEDIA_NONE ? UNCLASSIFIED : MEDIA_LABEL[k as keyof typeof MEDIA_LABEL]}</Td>
                {r.years.map((y) => <Td key={y.fy} align="right">{n(y.byMedia[k].inquiries)} / {n(y.byMedia[k].orders)}</Td>)}
              </Tr>
            ))}
            <Tr className="font-semibold">
              <Td>合計</Td>
              {r.years.map((y) => <Td key={y.fy} align="right">{n(y.inquiries)} / {n(Object.values(y.byMedia).reduce((a, b) => a + b.orders, 0))}</Td>)}
            </Tr>
            <Tr>
              <Td>チラシの部数 (実施 / 計画・未実施)</Td>
              {r.years.map((y) => <Td key={y.fy} align="right">{n(y.flyerCopies)} / {n(y.plannedCopies)}</Td>)}
            </Tr>
            <Tr>
              <Td>来店数</Td>
              {r.years.map((y) => <Td key={y.fy} align="right">{n(y.visitors)}</Td>)}
            </Tr>
          </tbody>
        </Table>
      </Card>

      <Card>
        <CardHeader title="販促ごとの反応" description="配布日・開始日が期間内の販促と、きっかけの販促にひも付いた問い合わせ" action={<Csv href={csv("promotions")} />} />
        {r.promotions.length === 0 ? (
          <p className="text-sm text-ink-3">期間内の販促の記録がありません。</p>
        ) : (
          <Table minWidth="min-w-[760px]">
            <thead>
              <tr>
                <Th>配布日</Th>
                <Th>販促</Th>
                <Th>状態</Th>
                <Th align="right">部数・件数</Th>
                <Th align="right">問い合わせ</Th>
                <Th align="right">成約</Th>
                <Th align="right">成約の売上</Th>
                <Th align="right">1,000 あたり</Th>
              </tr>
            </thead>
            <tbody>
              {r.promotions.map((row) => (
                <Tr key={row.promotion.id}>
                  <Td className="text-xs tnum">{row.promotion.startDate.replaceAll("-", "/")}</Td>
                  <Td><Link href={`/promotions/${row.promotion.id}`} className="font-medium text-ink hover:text-accent">{row.promotion.title}</Link><div className="text-[10px] text-ink-3">{PROMOTION_KIND[row.promotion.kind].label} · {row.promotion.number}</div></Td>
                  <Td><Badge tone={PROMOTION_STATUS[row.promotion.status].tone}>{PROMOTION_STATUS[row.promotion.status].label}</Badge></Td>
                  <Td align="right">{n(row.promotion.copies)}{PROMOTION_KIND[row.promotion.kind].unit}</Td>
                  <Td align="right">{n(row.inquiries)}</Td>
                  <Td align="right">{n(row.won)}</Td>
                  <Td align="right">{yen(row.sales)}</Td>
                  <Td align="right">{row.per1000 === null ? "-" : row.per1000.toLocaleString("ja-JP", { maximumFractionDigits: 2 })}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
