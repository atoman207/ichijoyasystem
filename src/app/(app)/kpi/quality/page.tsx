import Link from "@/components/ui/Link";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canAccessStore, canManageKpi, canReadStoreRecords, canSeeAllStoreFigures, canViewStoreFigures } from "@/lib/auth/permissions";
import { policyReader } from "@/lib/access-policy";

import { countedIssue, filterIssues, fmtRate, inPeriod } from "@/lib/kpi";
import { issueCounts, type IssueCounts } from "@/lib/kpi-core";
import { CASES_SOURCE_LABEL } from "@/lib/kpi-basis";
import { computeIncentives } from "@/lib/incentive";
import { QUALITY_KIND_LABEL, kpiSettings } from "@/lib/kpi-settings";
import { resolvePeriod } from "@/lib/kpi-period";
import { fmtDate, fmtDateTime, toDateKey } from "@/lib/format";
import { userName } from "@/lib/db/queries";
import { KpiTabs } from "@/components/kpi/KpiTabs";
import { PeriodSelect } from "@/components/kpi/PeriodSelect";
import { lineGroupName, lineMessageRef, pendingLineReports } from "@/lib/line-groups";
import { dismissLineReport } from "@/lib/actions/kpi";
import { Badge, Button, Card, CardHeader, Flash, LinkButton, Note, PageHeader, Pager, Select, StoreTag, paginate } from "@/components/ui";

export default async function QualityPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const settings = kpiSettings(db);
  const today = toDateKey(new Date());
  const rp = resolvePeriod(sp, settings.fiscalStartMonth, today);
  // 一覧 (個々の記録) は顧客情報、店舗・事務の集計は経営の数字の閲覧の範囲 (src/lib/access-policy.ts)
  const reader = policyReader(db, user);
  const store = sp.store && db.stores.some((s) => s.id === sp.store && canReadStoreRecords(reader, s.id)) ? sp.store : "";
  const orders = new Map(db.orders.map((o) => [o.id, o]));
  const customers = new Map(db.customers.map((c) => [c.id, c.name]));
  const rows = filterIssues(db.qualityIssues.filter((x) => canReadStoreRecords(reader, x.storeId)), { storeId: store || undefined, userId: sp.user || undefined, kind: sp.kind || undefined, status: sp.status || undefined, p: rp.period, q: sp.q }, (id) => orders.get(id)?.number ?? "");
  const paged = paginate(rows, sp.page, 50);
  const result = computeIncentives(db, rp.period, settings);
  const units = [...result.units.filter((u) => canViewStoreFigures(reader, u.unit as never)), result.office];
  // 経営管理の指標 (件数と割合。インセンティブのポイントとは別): 店舗・事務・全社 (全社は全店舗を見られる人だけ)
  const allIssues = db.qualityIssues.filter((q) => countedIssue(q) && inPeriod(q.occurredOn, rp.period));
  const mgmtRows: { key: string; label: React.ReactNode; cases: number; c: IssueCounts; total?: boolean }[] = [
    ...units.map((u) => ({ key: u.unit, label: u.unit === "office" ? "事務" : <StoreTag store={db.stores.find((s) => s.id === u.unit)} short />, cases: u.orders, c: u.issues })),
    ...(canSeeAllStoreFigures(reader) ? [{ key: "all", label: "全社", cases: result.office.orders, c: issueCounts(allIssues), total: true }] : []),
  ];
  const rate = (n: number, d: number) => fmtRate(d ? (n / d) * 100 : null, 2);
  const staff = db.users.filter((u) => u.active && (canAccessStore(user, u.storeId) || u.storeId === "hq"));
  // LINE の「クレーム・手直し報告」グループに届いた報告 (まだ記録にしていないもの。店舗のグループは見られる店舗だけ)
  const reports = pendingLineReports(db, (storeId) => (storeId ? canAccessStore(user, storeId) : canManageKpi(user))).slice(0, 30);

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader
        title="KPI · クレーム・手直し"
        description="案件 (受注・施工の画面) から登録したクレーム・手直し、LINE の報告・スプレッドシートから取り込んだ記録の一覧と、ポイント率・発生率です"
        actions={<LinkButton href="/kpi/quality/new" size="sm" variant="secondary">案件を選ばずに登録</LinkButton>}
      />
      <KpiTabs current="/kpi/quality" sp={sp} user={user} />
      <PeriodSelect
        action="/kpi/quality"
        value={rp.value}
        startMonth={settings.fiscalStartMonth}
        today={today}
        extra={
          <>
            <label className="block"><span className="label">店舗</span><Select name="store" defaultValue={store} className="h-9 py-1 text-sm"><option value="">すべて</option>{db.stores.filter((s) => canReadStoreRecords(reader, s.id)).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></label>
            <label className="block"><span className="label">担当者</span><Select name="user" defaultValue={sp.user ?? ""} className="h-9 py-1 text-sm"><option value="">すべて</option>{staff.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select></label>
            <label className="block"><span className="label">区分</span><Select name="kind" defaultValue={sp.kind ?? ""} className="h-9 py-1 text-sm"><option value="">すべて</option>{Object.entries(QUALITY_KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></label>
            <label className="block"><span className="label">状態</span><Select name="status" defaultValue={sp.status ?? ""} className="h-9 py-1 text-sm"><option value="">すべて</option><option value="open">対応中</option><option value="resolved">解決済み</option></Select></label>
            <label className="block"><span className="label">キーワード</span><input name="q" defaultValue={sp.q ?? ""} className="field h-9 py-1 text-sm" placeholder="内容・原因・対策・受注番号・現場名" /></label>
          </>
        }
      />

      <Card padded={false}>
        <div className="px-5 pt-5">
          <CardHeader
            title={`経営管理の指標 · クレーム・手直しの件数と割合 (${rp.label})`}
            description={`インセンティブのポイントとは別の指標です。割合 = 件数 ÷ 全案件数 × 100 (全案件数 = ${result.basis.denominator === "sheet" ? CASES_SOURCE_LABEL[result.basis.casesSource] : "期間内の受注"}。事務は 4 店舗の合計)`}
          />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead>
              <tr className="bg-subtle text-xs text-ink-2">
                <th className="px-4 py-2 text-left font-medium">単位</th>
                <th className="px-2 py-2 text-right font-medium">全案件数</th>
                <th className="px-2 py-2 text-right font-medium">クレーム<br />件数 / 率</th>
                <th className="px-2 py-2 text-right font-medium">手直し<br />件数 / 率</th>
                <th className="px-2 py-2 text-right font-medium">クレーム・手直しの合計<br />件数 / 率</th>
                <th className="px-4 py-2 text-right font-medium">発生した案件<br />件数 / 率</th>
              </tr>
            </thead>
            <tbody>
              {mgmtRows.map((r) => (
                <tr key={r.key} className={`border-t border-line ${r.total ? "bg-accent-soft/30 font-semibold" : ""}`}>
                  <td className="px-4 py-2">{r.label}</td>
                  <td className="px-2 py-2 text-right tnum">{r.cases.toLocaleString("ja-JP")}</td>
                  <td className="px-2 py-2 text-right tnum">{r.c.claims} 件 / {rate(r.c.claims, r.cases)}</td>
                  <td className="px-2 py-2 text-right tnum">{r.c.reworks} 件 / {rate(r.c.reworks, r.cases)}</td>
                  <td className="px-2 py-2 text-right tnum">{r.c.total} 件 / {rate(r.c.total, r.cases)}</td>
                  <td className="px-4 py-2 text-right tnum">{r.c.cases} 件 / {rate(r.c.cases, r.cases)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="px-5 py-3 text-[11px] text-ink-3">クレーム = 区分が「クレーム」「クレーム＋手直し」の記録、手直し = 「手直し」「クレーム＋手直し」の記録 (クレーム＋手直しはそれぞれに 1 件)。合計 = クレーム + 手直し。発生した案件 = クレーム・手直しのあった案件の数 (同じ案件の記録は 1 件)。「記録のみ」は数えません。</p>
      </Card>

      <Card className="mt-4" padded={false}>
        <div className="px-5 pt-5"><CardHeader title={`インセンティブ用 · ポイントとポイント率 (${rp.label})`} description={`ポイント率 = 合計ポイント ÷ 全案件数 × 100 (年間インセンティブのクレーム・手直しポイント率と同じ)。クレーム ${settings.qualityPoints.claim} 点・手直し ${settings.qualityPoints.rework} 点・クレーム＋手直し ${settings.qualityPoints.claim_rework} 点${settings.qualityCaseMax > 0 ? `、同じ案件は最大 ${settings.qualityCaseMax} 点` : ""}。事務の分母は 4 店舗の合計`} /></div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead><tr className="bg-subtle text-xs text-ink-2"><th className="px-4 py-2 text-left font-medium">単位</th><th className="px-2 py-2 text-right font-medium">全案件数</th><th className="px-2 py-2 text-right font-medium">記録の件数</th><th className="px-2 py-2 text-right font-medium">ポイント</th><th className="px-4 py-2 text-right font-medium">ポイント率</th></tr></thead>
            <tbody>
              {units.map((u) => (
                <tr key={u.unit} className="border-t border-line">
                  <td className="px-4 py-2">{u.unit === "office" ? "事務" : <StoreTag store={db.stores.find((s) => s.id === u.unit)} short />}</td>
                  <td className="px-2 py-2 text-right tnum">{u.orders.toLocaleString("ja-JP")}</td>
                  <td className="px-2 py-2 text-right tnum">{u.qualityCount}</td>
                  <td className="px-2 py-2 text-right tnum">{u.qualityPoints}{u.qualityPointsRaw !== u.qualityPoints && <span className="block text-[10px] text-ink-3" title="同じ案件のポイントの上限を当てる前">上限の前 {u.qualityPointsRaw} 点</span>}</td>
                  <td className="px-4 py-2 text-right font-semibold tnum">{fmtRate(u.qualityRate, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="px-5 py-3 text-[11px] text-ink-3">同じ案件 (受注。案件のない記録は 店舗・月・現場名) のクレームと手直しは合わせて最大 {settings.qualityCaseMax} 点です (設定 → KPI・インセンティブ で変更)。「記録のみ」(点検 DM・点検電話から分かったもの、お客様が原因のものなど) は集計に入れません。LINE の報告を「記録にする」と、区分に応じたポイントが自動で付き、この表と年間インセンティブに反映されます。</p>
      </Card>

      {reports.length > 0 && (
        <Card className="mt-4" padded={false}>
          <div className="px-5 pt-5"><CardHeader title={`LINE の報告 (まだ記録にしていないもの ${reports.length} 件)`} description="LINE の「クレーム・手直し報告」グループに届いたメッセージです。「記録にする」で内容を入れた登録の画面を開き、区分 (クレーム・手直し) を決めて登録します。クレーム・手直しでなかった報告は「対応不要」にします" /></div>
          <ul className="divide-y divide-line">
            {reports.map(({ group, message }) => {
              const ref = lineMessageRef(group.id, message.id);
              return (
                <li key={ref} className="flex flex-wrap items-start gap-3 px-5 py-2.5 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="text-xs text-ink-3"><span className="tnum">{fmtDateTime(message.at)}</span> · {lineGroupName(group)}{group.storeId && <> · <StoreTag store={db.stores.find((s) => s.id === group.storeId)} short /></>}</div>
                    <p className="whitespace-pre-wrap text-ink-2">{message.text || (message.type === "image" ? "(写真)" : message.fileName ? `(ファイル: ${message.fileName})` : `(${message.type})`)}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <LinkButton href={`/kpi/quality/new?line=${encodeURIComponent(ref)}`} size="sm">記録にする</LinkButton>
                    <form action={dismissLineReport} className="flex items-center gap-1">
                      <input type="hidden" name="lineRef" value={ref} />
                      <input type="hidden" name="returnTo" value="/kpi/quality" />
                      <input name="reason" placeholder="理由 (任意)" className="field h-8 w-28 py-0.5 text-xs" aria-label="対応不要の理由" />
                      <Button type="submit" size="sm" variant="ghost">対応不要</Button>
                    </form>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <Note>登録は受注・施工の画面 (案件) の「クレーム・手直しを登録する」から行います。案件が分からないとき (LINE の報告・電話で受けたクレームなど) は「案件を選ばずに登録」から現場名で登録し、あとで受注番号をひも付けます。登録すると店舗・集計期間・ポイントが自動で決まり、KPI とインセンティブに反映されます。過去の記録は KPI →「スプレッドシートの取込」でお客様アンケート集計表から取り込めます。</Note>

      <Card className="mt-4" padded={false}>
        <div className="px-5 pt-5"><CardHeader title="一覧" description={`${rows.length} 件 · ${rows.filter(countedIssue).reduce((a, q) => a + q.points, 0)} 点`} /></div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-sm">
            <thead><tr className="bg-subtle text-xs text-ink-2"><th className="px-4 py-2 text-left font-medium">番号</th><th className="px-2 py-2 text-left font-medium">発生日</th><th className="px-2 py-2 text-left font-medium">区分</th><th className="px-2 py-2 text-left font-medium">店舗</th><th className="px-2 py-2 text-left font-medium">案件</th><th className="px-2 py-2 text-left font-medium">担当者</th><th className="px-2 py-2 text-left font-medium">内容</th><th className="px-2 py-2 text-left font-medium">原因・対策</th><th className="px-4 py-2 text-left font-medium">状態</th></tr></thead>
            <tbody>
              {paged.items.length === 0 && <tr><td colSpan={9} className="px-4 py-8 text-center text-ink-3">該当する記録はありません</td></tr>}
              {paged.items.map((x) => {
                const o = x.orderId ? orders.get(x.orderId) : undefined;
                return (
                  <tr key={x.id} className="border-t border-line align-top hover:bg-subtle/60">
                    <td className="px-4 py-2"><Link href={`/kpi/quality/${x.id}`} className="font-medium text-accent hover:underline">{x.number}</Link></td>
                    <td className="px-2 py-2 text-xs tnum">{fmtDate(x.occurredOn)}</td>
                    <td className="px-2 py-2"><Badge tone={x.kind === "rework" ? "warn" : "critical"}>{QUALITY_KIND_LABEL[x.kind]} {x.points}点</Badge>{x.counted === false && <Badge tone="neutral" dot={false} className="ml-1">記録のみ</Badge>}{x.attribution === "office" && <Badge tone="info" dot={false} className="ml-1">事務</Badge>}</td>
                    <td className="px-2 py-2"><StoreTag store={db.stores.find((s) => s.id === x.storeId)} short /></td>
                    <td className="px-2 py-2 text-xs">{o ? <Link href={`/orders/${o.id}`} className="text-accent hover:underline">{o.number} {customers.get(o.customerId)}</Link> : x.siteName ? <span title="案件にまだひも付いていません">{x.siteName} <span className="text-ink-3">(案件未設定)</span></span> : "-"}{x.sourceRef && <Badge tone="neutral" dot={false} className="ml-1">シート</Badge>}{x.origin && <span className="ml-1 text-ink-3">· {x.origin}</span>}</td>
                    <td className="px-2 py-2 text-xs">{x.responsibleUserIds.map((u) => userName(u)).join("・")}</td>
                    <td className="max-w-[18rem] px-2 py-2 text-xs text-ink-2">{x.description}</td>
                    <td className="px-2 py-2 text-xs">{x.cause && x.countermeasure ? <span className="text-good-ink">入力済み</span> : <span className="text-warn-ink">未入力</span>}</td>
                    <td className="px-4 py-2"><Badge tone={x.status === "resolved" ? "good" : "neutral"}>{x.status === "resolved" ? "解決済み" : "対応中"}</Badge></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="px-5 pb-4"><Pager paged={paged} path="/kpi/quality" sp={sp} /></div>
      </Card>
    </div>
  );
}
