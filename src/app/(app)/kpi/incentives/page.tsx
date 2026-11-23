import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canImportData, canManageSettings, canViewStaffKpi } from "@/lib/auth/permissions";
import Link from "@/components/ui/Link";
import { basisNotes, denomSummary } from "@/lib/kpi-basis";
import { saveIncentiveAdjustments } from "@/lib/actions/kpi";
import { computeIncentives, type Adjustments } from "@/lib/incentive";
import { fmtRate, fmtScore, inPeriod, reviewMonths } from "@/lib/kpi";
import { fiscalRange, fiscalYearOf, isPayable, kpiSettings } from "@/lib/kpi-settings";
import { resolvePeriod } from "@/lib/kpi-period";
import { toDateKey, yen } from "@/lib/format";
import { userName } from "@/lib/db/queries";
import { KpiTabs } from "@/components/kpi/KpiTabs";
import { PeriodSelect } from "@/components/kpi/PeriodSelect";
import { Button, Card, CardHeader, Flash, Note, PageHeader, StoreTag } from "@/components/ui";
import { compareStoreIds } from "@/lib/store-order";

const COLUMNS: [string, string][] = [
  ["reply", "返信率"],
  ["replyMvp", "返信率MVP"],
  ["phone", "①電話"],
  ["sales", "②営業"],
  ["salesMvp", "②MVP"],
  ["craft", "③職人"],
  ["craftMvp", "③MVP"],
  ["finish", "④仕上り"],
  ["finishMvp", "④MVP"],
  ["reviewMvp", "口コミMVP"],
  ["quality", "クレーム率"],
  ["fewestMvp", "件数MVP"],
  ["rateMvp", "率MVP"],
];

const signed = (n: number) => (n < 0 ? `▲${Math.abs(n).toLocaleString("ja-JP")}` : n.toLocaleString("ja-JP"));

export default async function IncentivesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const settings = kpiSettings(db);
  const today = toDateKey(new Date());
  const rp0 = resolvePeriod(sp, settings.fiscalStartMonth, today);
  // インセンティブは年度ごと (累計・月の指定のときは今年度)
  const fy = rp0.fy ?? fiscalYearOf(today, settings.fiscalStartMonth);
  const period = fiscalRange(fy, settings.fiscalStartMonth);
  const adjustments = ((db.settings.find((s) => s.id === `incentive_${fy}`)?.value as { adjust?: Adjustments } | undefined)?.adjust ?? {}) as Adjustments;
  const result = computeIncentives(db, period, settings, adjustments);
  const users = new Map(db.users.map((u) => [u.id, u]));
  const rows = result.people.filter((r) => canViewStaffKpi(user, users.get(r.userId)!)).sort((a, b) => compareStoreIds(a.storeId, b.storeId) || b.total - a.total);
  const admin = canManageSettings(user);
  const reviewRows = reviewMonths(db.reviews.filter((r) => inPeriod(r.postedOn, period) && users.get(r.userId) && isPayable(users.get(r.userId)!, settings)), settings.reviewYenPerPoint, null);
  const reviewYen = new Map<string, number>();
  for (const m of reviewRows) reviewYen.set(m.userId, (reviewYen.get(m.userId) ?? 0) + m.yen);
  const done = today > period.to;

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader title={`KPI · 年間インセンティブ (${fy}年度)`} description={`集計期間 ${period.from.replace(/-/g, "/")}〜${period.to.replace(/-/g, "/")} · 12 月末に現金で支給 · ${done ? "期間終了 (確定値)" : "期間中のため現時点の見込み"}`} />
      <KpiTabs current="/kpi/incentives" sp={sp} user={user} />
      <PeriodSelect action="/kpi/incentives" value={`fy:${fy}`} startMonth={settings.fiscalStartMonth} today={today} />

      <Card padded={false}>
        <div className="px-5 pt-5"><CardHeader title="店舗・事務の評価値" description={`はがき返信率が ${settings.incentive.replyGate}% 未満の店舗は、はがきの項目 (返信率・②③④・関連の MVP) を支給しません`} /></div>
        <ul className="space-y-0.5 px-5 pb-3 text-[11px] text-ink-3">
          {basisNotes(result.basis).map((t, i) => <li key={i}>・{t}</li>)}
          <li>・クレーム・手直しはクレーム {settings.qualityPoints.claim} 点・手直し {settings.qualityPoints.rework} 点{settings.qualityCaseMax > 0 ? `、同じ案件は最大 ${settings.qualityCaseMax} 点` : ""}。販促の KPI (チラシの反響・個人の売上・客単価など) は経営分析用の別の指標で、インセンティブには入れません (<Link href="/promotions" className="text-accent hover:underline">販促と媒体の分析</Link>)</li>
          {canImportData(user) && <li>・分母 (店舗 × 月の個人件数・全案件数) の登録と、スプレッドシートの KPI シートとの照合は <Link href={`/kpi/basis?fy=${fy}`} className="text-accent hover:underline">分母・照合</Link> / <Link href="/kpi/basis/check" className="text-accent hover:underline">支給前の照合</Link></li>}
        </ul>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead><tr className="bg-subtle text-xs text-ink-2"><th className="px-4 py-2 text-left font-medium">単位</th><th className="px-2 py-2 text-right font-medium">返信率 (枚 / 個人件数)</th><th className="px-2 py-2 text-right font-medium">④ 仕上り</th><th className="px-2 py-2 text-right font-medium">全案件数</th><th className="px-2 py-2 text-right font-medium">クレーム・手直し</th><th className="px-4 py-2 text-right font-medium">ポイント率</th></tr></thead>
            <tbody>
              {result.units.map((u) => (
                <tr key={u.unit} className="border-t border-line">
                  <td className="px-4 py-2"><StoreTag store={db.stores.find((s) => s.id === u.unit)} short />{u.gated && <span className="ml-2 text-[11px] text-warn-ink">はがきの項目なし</span>}</td>
                  <td className="px-2 py-2 text-right tnum" title={u.denominators ? `個人件数: ${denomSummary(u.denominators.individual)}` : undefined}>{fmtRate(u.replyRate)} <span className="text-[10px] text-ink-3">({u.cards}/{u.individual})</span></td>
                  <td className="px-2 py-2 text-right tnum">{fmtScore(u.finishAvg)} <span className="text-[10px] text-ink-3">({u.finishCount})</span></td>
                  <td className="px-2 py-2 text-right tnum" title={u.denominators ? `全案件数: ${denomSummary(u.denominators.sites)}` : undefined}>{u.orders.toLocaleString("ja-JP")}</td>
                  <td className="px-2 py-2 text-right tnum">{u.qualityCount} 件 / {u.qualityPoints} 点</td>
                  <td className="px-4 py-2 text-right tnum">{fmtRate(u.qualityRate, 2)}</td>
                </tr>
              ))}
              <tr className="border-t border-line">
                <td className="px-4 py-2">事務 <span className="text-[11px] text-ink-3">(① 全社平均 {fmtScore(result.companyPhoneAvg)} · {result.companyPhoneCount} 件)</span></td>
                <td className="px-2 py-2 text-right">-</td>
                <td className="px-2 py-2 text-right">-</td>
                <td className="px-2 py-2 text-right tnum">{result.office.orders.toLocaleString("ja-JP")}</td>
                <td className="px-2 py-2 text-right tnum">{result.office.qualityCount} 件 / {result.office.qualityPoints} 点</td>
                <td className="px-4 py-2 text-right tnum">{fmtRate(result.office.qualityRate, 2)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="mt-4" padded={false}>
        <div className="px-5 pt-5"><CardHeader title="社員別の支給額 (円)" description={user.role === "store_staff" ? "あなたの分です" : `合計 ${yen(rows.reduce((a, r) => a + r.total, 0))} · 金額は 1 人あたり。合計がマイナスの人は 0 円`} /></div>
        <form action={saveIncentiveAdjustments.bind(null, fy)}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1280px] text-xs">
              <thead>
                <tr className="bg-subtle text-ink-2">
                  <th className="px-3 py-2 text-left font-medium">社員</th>
                  {COLUMNS.map(([k, l]) => <th key={k} className="px-1.5 py-2 text-right font-medium">{l}</th>)}
                  <th className="px-2 py-2 text-right font-medium">調整</th>
                  <th className="px-3 py-2 text-right font-medium">合計</th>
                  <th className="px-3 py-2 text-right font-medium">口コミ (月次・別払い)</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={COLUMNS.length + 4} className="px-4 py-8 text-center text-sm text-ink-3">対象の社員がいません</td></tr>}
                {rows.map((r) => {
                  const line = new Map(r.lines.map((l) => [l.key, l]));
                  return (
                    <tr key={r.userId} className="border-t border-line align-top">
                      <td className="px-3 py-2"><div className="font-medium text-ink">{userName(r.userId)}</div><div className="text-[10px] text-ink-3">{r.role === "clerk" ? "事務" : r.role === "craftsman" ? db.stores.find((s) => s.id === r.storeId)?.shortName : "その他"}</div></td>
                      {COLUMNS.map(([k]) => {
                        const l = line.get(k);
                        return <td key={k} className={`px-1.5 py-2 text-right tnum ${l && l.yen < 0 ? "text-critical" : l && l.yen > 0 ? "text-ink" : "text-ink-3"}`} title={l?.note}>{l ? signed(l.yen) : ""}</td>;
                      })}
                      <td className="px-2 py-2 text-right">
                        {admin ? (
                          <span className="flex flex-col items-end gap-1">
                            <input name={`adj_${r.userId}`} defaultValue={r.adjust || ""} inputMode="numeric" className="field h-7 w-24 py-0.5 text-right text-xs" aria-label={`${userName(r.userId)} の調整額`} />
                            <input name={`note_${r.userId}`} defaultValue={r.adjustNote ?? ""} className="field h-7 w-24 py-0.5 text-xs" placeholder="理由" aria-label={`${userName(r.userId)} の調整の理由`} />
                          </span>
                        ) : (
                          <span className="tnum" title={r.adjustNote}>{r.adjust ? signed(r.adjust) : ""}</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right text-sm font-semibold tnum">{r.total.toLocaleString("ja-JP")}{r.subtotal + r.adjust < 0 && <div className="text-[10px] font-normal text-ink-3">計 {signed(r.subtotal + r.adjust)} → 0</div>}</td>
                      <td className="px-3 py-2 text-right tnum text-ink-2">{reviewYen.get(r.userId) ? yen(reviewYen.get(r.userId)!) : ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {admin && rows.length > 0 && (
            <div className="flex flex-wrap items-center gap-3 px-5 py-3">
              <Button type="submit" size="sm" variant="secondary">調整額を保存</Button>
              <span className="text-[11px] text-ink-3">年度の途中で店舗を移った社員の月割りなど、自動で計算しない分を入力します (変更履歴に残ります)。</span>
            </div>
          )}
        </form>
        <ul className="space-y-0.5 px-5 pb-4 text-[11px] text-ink-3">
          <li>・金額の上にカーソルを置くと、評価値 (平均・率・順位) を表示します。ルールは 設定 → KPI・インセンティブ で変更できます (管理者)。</li>
          <li>・① 電話対応は全社の平均で事務の全員に、② は営業担当本人、③ は担当職人本人、④・返信率・クレーム率は店舗の職人全員に付きます。事務は事務のクレーム率で判定します。</li>
          <li>・MVP の順位は同点を同じ順位にし、次の順位を飛ばします。支給対象外 (設定) の社員は順位・支給から外します。</li>
          <li>・Google 口コミは月ごとに翌月末に別払い (1 ポイント {yen(settings.reviewYenPerPoint)})。月間人日・伝票件数の手当は、作業日報のデータがシステムにないため対象外です。</li>
        </ul>
      </Card>
      {!settings.clerkUserIds.length && <Note tone="warn">事務担当が設定されていません。設定 → KPI・インセンティブ で事務の社員を選んでください (① 電話対応・事務のクレーム率の支給対象)。</Note>}
    </div>
  );
}
