import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canImportData, canManageSettings, canViewStaffKpi } from "@/lib/auth/permissions";
import Link from "@/components/ui/Link";
import { basisNotes, denomSummary } from "@/lib/kpi-basis";
import { saveIncentiveAdjustments, saveIncentiveMembers, saveMonthlyAllowances } from "@/lib/actions/kpi";
import { computeIncentives } from "@/lib/incentive";
import { formatAssign, readIncentiveYear } from "@/lib/incentive-year";
import { monthlyAllowances, monthlyKey } from "@/lib/kpi-monthly";
import { fmtRate, fmtScore, inPeriod, reviewMonths } from "@/lib/kpi";
import { fiscalRange, fiscalYearOf, isPayable, kpiSettings } from "@/lib/kpi-settings";
import { resolvePeriod } from "@/lib/kpi-period";
import { toDateKey, yen } from "@/lib/format";
import { userName } from "@/lib/db/queries";
import { KpiTabs } from "@/components/kpi/KpiTabs";
import { PeriodSelect } from "@/components/kpi/PeriodSelect";
import { Button, Card, CardHeader, Flash, LinkButton, Note, PageHeader, StoreTag, Textarea } from "@/components/ui";
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
  // 年度の設定: 調整額・所属の月割り・アカウントのない対象者 (src/lib/incentive-year.ts)
  const year = readIncentiveYear(db, fy);
  const result = computeIncentives(db, period, settings, year.adjust, undefined, year);
  const users = new Map(db.users.map((u) => [u.id, u]));
  // アカウントのない対象者 (事務など) は全店舗を見られる人だけ (店長・スタッフには出さない)
  const rows = result.people.filter((r) => canViewStaffKpi(user, users.get(r.userId) ?? { id: r.userId, storeId: "hq" })).sort((a, b) => (a.role === "clerk" ? 1 : 0) - (b.role === "clerk" ? 1 : 0) || compareStoreIds(a.storeId, b.storeId) || b.total - a.total);
  const nameOf = (r: { userId: string; name?: string }) => r.name ?? userName(r.userId);
  const admin = canManageSettings(user);
  // 月次の手当 (月間人日・伝票件数): 事務の人数 = 事務担当 + アカウントのない事務
  const officePeople = result.people.filter((r) => r.role === "clerk").length;
  const monthly = admin || canImportData(user) ? monthlyAllowances(db, fy, settings, { today, officePeople }) : [];
  const monthlyMonths = [...new Set(monthly.map((m) => m.month))];
  const unitName = (u: string) => (u === "office" ? "事務 (伝票件数)" : `${db.stores.find((x) => x.id === u)?.shortName ?? u} (人日)`);
  // 対象者と所属の月割りの入力 (有効な社員 + アカウントのない対象者)
  const memberRows = [
    ...db.users.filter((u) => isPayable(u, settings)).sort((a, b) => compareStoreIds(a.storeId, b.storeId)).map((u) => ({ key: u.id, name: u.name, storeId: u.storeId, clerk: settings.clerkUserIds.includes(u.id) })),
    ...year.extra.map((e) => ({ key: e.key, name: `${e.name} (アカウントなし)`, storeId: (e.unit === "office" ? "hq" : e.unit) as string, clerk: e.unit === "office" })),
  ];
  const personOf = new Map(result.people.map((r) => [r.userId, r]));
  const reviewRows = reviewMonths(db.reviews.filter((r) => inPeriod(r.postedOn, period) && users.get(r.userId) && isPayable(users.get(r.userId)!, settings)), settings.reviewYenPerPoint, null);
  const reviewYen = new Map<string, number>();
  for (const m of reviewRows) reviewYen.set(m.userId, (reviewYen.get(m.userId) ?? 0) + m.yen);
  const done = today > period.to;

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader title={`KPI · 年間インセンティブ (${fy}年度)`} description={`集計期間 ${period.from.replace(/-/g, "/")}〜${period.to.replace(/-/g, "/")} · 12 月末に現金で支給 · ${done ? "期間終了 (確定値)" : "期間中のため現時点の見込み"}`} actions={canImportData(user) ? <LinkButton href={`/api/kpi/incentives?fy=${fy}`} size="sm" variant="secondary">集計表 CSV</LinkButton> : undefined} />
      <KpiTabs current="/kpi/incentives" sp={sp} user={user} />
      <PeriodSelect action="/kpi/incentives" value={`fy:${fy}`} startMonth={settings.fiscalStartMonth} today={today} />

      <Card padded={false}>
        <div className="px-5 pt-5"><CardHeader title="店舗・事務の評価値" description={`はがき返信率が ${settings.incentive.replyGate}% 未満の店舗は、はがきの項目 (返信率・②③④・関連の MVP) を支給しません`} /></div>
        <ul className="space-y-0.5 px-5 pb-3 text-[11px] text-ink-3">
          {basisNotes(result.basis).map((t, i) => <li key={i}>・{t}</li>)}
          <li>・クレーム・手直しはクレーム {settings.qualityPoints.claim} 点・手直し {settings.qualityPoints.rework} 点{settings.qualityCaseMax > 0 ? `、同じ案件の同じ月は最大 ${settings.qualityCaseMax} 点` : ""}。販促の KPI (チラシの反響・個人の売上・客単価など) は経営分析用の別の指標で、インセンティブには入れません (<Link href="/promotions" className="text-accent hover:underline">販促と媒体の分析</Link>)</li>
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
          {rows.map((r) => <input key={r.userId} type="hidden" name="keys" value={r.userId} />)}
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
                      <td className="px-3 py-2"><div className="font-medium text-ink">{nameOf(r)}</div><div className="text-[10px] text-ink-3">{r.prorated ? `${formatAssign(r.segments, db.stores)} か月 (月割り)` : r.role === "clerk" ? "事務" : r.role === "craftsman" ? db.stores.find((s) => s.id === r.storeId)?.shortName : "その他"}</div></td>
                      {COLUMNS.map(([k]) => {
                        const l = line.get(k);
                        return <td key={k} className={`px-1.5 py-2 text-right tnum ${l && l.yen < 0 ? "text-critical" : l && l.yen > 0 ? "text-ink" : "text-ink-3"}`} title={l?.note}>{l ? signed(l.yen) : ""}</td>;
                      })}
                      <td className="px-2 py-2 text-right">
                        {admin ? (
                          <span className="flex flex-col items-end gap-1">
                            <input name={`adj_${r.userId}`} defaultValue={r.adjust || ""} inputMode="numeric" className="field h-7 w-24 py-0.5 text-right text-xs" aria-label={`${nameOf(r)} の調整額`} />
                            <input name={`note_${r.userId}`} defaultValue={r.adjustNote ?? ""} className="field h-7 w-24 py-0.5 text-xs" placeholder="理由" aria-label={`${nameOf(r)} の調整の理由`} />
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
              <span className="text-[11px] text-ink-3">自動で計算しない分を入力します (変更履歴に残ります)。年度の途中で店舗を移った・途中から入った社員は、下の「対象者と所属の月割り」で月数を入れると自動で月割りします。</span>
            </div>
          )}
        </form>
        <ul className="space-y-0.5 px-5 pb-4 text-[11px] text-ink-3">
          <li>・金額の上にカーソルを置くと、評価値 (平均・率・順位) を表示します。ルールは 設定 → KPI・インセンティブ で変更できます (管理者)。</li>
          <li>・① 電話対応は全社の平均で事務の全員に、② は営業担当本人、③ は担当職人本人、④・返信率・クレーム率は店舗の職人全員に付きます。事務は事務のクレーム率で判定します。</li>
          <li>・MVP の順位は同点を同じ順位にし、次の順位を飛ばします。支給対象外 (設定) の社員は順位・支給から外します。</li>
          <li>・店舗・事務で決まる項目 (返信率・④・クレーム率・それぞれの MVP・① 電話対応) は、所属の月割り (所属ごとの金額 × 月数 ÷ 12、円未満は四捨五入) です。② 営業・③ 職人・口コミの MVP は本人の値なので月割りしません。</li>
          <li>・Google 口コミは月ごとに翌月末に別払い (1 ポイント {yen(settings.reviewYenPerPoint)})。月間人日・伝票件数の手当は月ごとの別払いで、下の「月次の手当」で決めます。</li>
        </ul>
      </Card>

      {admin && (
        <Card className="mt-4" id="members">
          <CardHeader title="対象者と所属の月割り" description="年度の途中で店舗を移った・途中から入った社員は「合志 8, 中央 4」「事務 7」のように所属ごとの月数を入れます (空欄 = 今の所属で 12 か月)。事務担当・支給の対象外は 設定 → KPI・インセンティブ で選びます" />
          <form action={saveIncentiveMembers.bind(null, fy)} className="space-y-4">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-xs">
                <thead><tr className="bg-subtle text-ink-2"><th className="px-3 py-2 text-left font-medium">対象者</th><th className="px-2 py-2 text-left font-medium">今の所属</th><th className="px-2 py-2 text-left font-medium">所属の月割り (店舗・事務 + 月数)</th><th className="px-3 py-2 text-right font-medium">いまの計算</th></tr></thead>
                <tbody>
                  {memberRows.map((m) => {
                    const r = personOf.get(m.key);
                    return (
                      <tr key={m.key} className="border-t border-line">
                        <td className="px-3 py-1.5">{m.name}<input type="hidden" name="keys" value={m.key} /></td>
                        <td className="px-2 py-1.5 text-ink-2">{m.clerk ? "事務" : (db.stores.find((x) => x.id === m.storeId)?.shortName ?? "-")}</td>
                        <td className="px-2 py-1.5"><input name={`as_${m.key}`} defaultValue={formatAssign(year.assign[m.key], db.stores)} placeholder="例: 合志 8, 中央 4" className="field h-7 w-56 py-0.5 text-xs" aria-label={`${m.name} の所属の月割り`} /></td>
                        <td className="px-3 py-1.5 text-right tnum text-ink-2">{r ? `${formatAssign(r.segments, db.stores) || "所属の項目なし"}${r.segments.length ? " か月" : ""}` : "対象外"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="max-w-xl">
              <label className="label" htmlFor="extra">アカウントのない対象者 (1 行に 1 人「名前: 所属」)</label>
              <Textarea id="extra" name="extra" rows={3} defaultValue={year.extra.map((e) => `${e.name}: ${e.unit === "office" ? "事務" : (db.stores.find((x) => x.id === e.unit)?.shortName ?? e.unit)}`).join("\n")} placeholder={"例: 山田: 事務"} />
              <p className="mt-1 text-[11px] text-ink-3">パートの事務など、システムのアカウントのない人を支給の対象にします。月割りは保存したあと上の表で入れます。</p>
            </div>
            <Button type="submit" size="sm" variant="secondary">対象者と所属を保存</Button>
          </form>
        </Card>
      )}

      {monthly.length > 0 && (
        <Card className="mt-4" padded={false} id="monthly">
          <div className="px-5 pt-5"><CardHeader title="月次の手当 (月間人日・伝票件数)" description={`月締め・翌月に現金で支給。月間人日 = 畳と襖類 (係数後) ÷ 人日が ${settings.incentive.monthly.manDayMin} 以上で (${yen(settings.incentive.monthly.manDayYen)} × 人数 − 総残業代) ÷ 人数、伝票件数 = 事務 1 人 ${settings.incentive.monthly.slipPerClerk} 件 × 人数 以上で (${yen(settings.incentive.monthly.slipYen)} × 人数 − 総残業代) ÷ 人数。目安の値だけでは支給にしません (実績の値かクリアの印を入れます)`} /></div>
          <form action={saveMonthlyAllowances.bind(null, fy)}>
            <div className="max-h-[36rem] overflow-auto">
              <table className="w-full min-w-[980px] text-xs">
                <thead className="sticky top-0"><tr className="bg-subtle text-ink-2"><th className="px-3 py-2 text-left font-medium">月</th><th className="px-2 py-2 text-left font-medium">単位</th><th className="px-2 py-2 text-right font-medium">目安</th><th className="px-2 py-2 text-right font-medium">実績</th><th className="px-2 py-2 text-right font-medium">基準</th><th className="px-2 py-2 text-left font-medium">クリア</th><th className="px-2 py-2 text-right font-medium">人数</th><th className="px-2 py-2 text-right font-medium">総残業代</th><th className="px-3 py-2 text-right font-medium">1 人あたり</th></tr></thead>
                <tbody>
                  {monthlyMonths.flatMap((month) =>
                    monthly.filter((m) => m.month === month).map((m, i) => {
                      const k = monthlyKey(m.unit, m.month);
                      return (
                        <tr key={k} className={`border-t border-line ${i === 0 ? "border-t-line-strong" : ""}`}>
                          <td className="px-3 py-1.5 tnum">{i === 0 ? `${Number(month.slice(0, 4))}年${Number(month.slice(5))}月` : ""}<input type="hidden" name="mkeys" value={k} /></td>
                          <td className="px-2 py-1.5">{unitName(m.unit)}</td>
                          <td className="px-2 py-1.5 text-right tnum text-ink-2" title={m.autoNote}>{m.auto ?? "-"}{m.autoClears && <span className="ml-1 text-[10px] text-good-ink">基準以上</span>}</td>
                          <td className="px-2 py-1.5 text-right">{admin ? <input name={`mv_${k}`} defaultValue={m.entry?.value ?? ""} inputMode="decimal" className="field h-7 w-20 py-0.5 text-right text-xs" aria-label={`${unitName(m.unit)} ${month} の実績`} /> : (m.value ?? "")}</td>
                          <td className="px-2 py-1.5 text-right tnum text-ink-3">{m.threshold}</td>
                          <td className="px-2 py-1.5">
                            {admin ? (
                              <select name={`mc_${k}`} defaultValue={m.entry?.cleared === undefined ? "" : m.entry.cleared ? "1" : "0"} className="field h-7 py-0.5 text-xs" aria-label={`${unitName(m.unit)} ${month} のクリア`}>
                                <option value="">実績で決める{m.clearedBy === "value" ? ` (${m.cleared ? "クリア" : "未達"})` : ""}</option>
                                <option value="1">クリア (1)</option>
                                <option value="0">未達</option>
                              </select>
                            ) : m.cleared ? "クリア" : ""}
                          </td>
                          <td className="px-2 py-1.5 text-right">{admin ? <input name={`mp_${k}`} defaultValue={m.entry?.people ?? ""} placeholder={String(m.people)} inputMode="numeric" className="field h-7 w-14 py-0.5 text-right text-xs" aria-label={`${unitName(m.unit)} ${month} の人数`} /> : m.people}</td>
                          <td className="px-2 py-1.5 text-right">{admin ? <input name={`mo_${k}`} defaultValue={m.entry?.overtime ?? ""} placeholder="0" inputMode="numeric" className="field h-7 w-24 py-0.5 text-right text-xs" aria-label={`${unitName(m.unit)} ${month} の総残業代`} /> : m.overtime ? yen(m.overtime) : ""}</td>
                          <td className={`px-3 py-1.5 text-right tnum ${m.perPerson ? "font-semibold text-ink" : "text-ink-3"}`}>{m.cleared ? yen(m.perPerson) : "-"}</td>
                        </tr>
                      );
                    }),
                  )}
                </tbody>
              </table>
            </div>
            {admin && (
              <div className="flex flex-wrap items-center gap-3 px-5 py-3">
                <Button type="submit" size="sm" variant="secondary">月次の手当を保存</Button>
                <span className="text-[11px] text-ink-3">人数の空欄は店舗の有効な社員・事務の人数です。目安の人日は作業日報 (予定表) と同じ計算、伝票件数の目安はシステムの受注の件数です。</span>
              </div>
            )}
          </form>
        </Card>
      )}
      {!settings.clerkUserIds.length && <Note tone="warn">事務担当が設定されていません。設定 → KPI・インセンティブ で事務の社員を選んでください (① 電話対応・事務のクレーム率の支給対象)。</Note>}
    </div>
  );
}
