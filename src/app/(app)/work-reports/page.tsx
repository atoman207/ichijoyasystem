import Link from "@/components/ui/Link";
import { redirect } from "next/navigation";
import { ChevronLeft, ChevronRight, Download, Printer } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import type { StoreId } from "@/lib/db/types";
import { canEditWorkReport, canManageOpsReportSettings, canViewWorkReport } from "@/lib/auth/permissions";
import { addMonths } from "@/lib/calendar";
import { fmtDateTime, toDateKey } from "@/lib/format";
import { userName } from "@/lib/db/queries";
import { DEFAULT_FACTORS, buildWorkReport, isMonthKey, readWorkReportSettings, weekdayLabel } from "@/lib/ops-reports/work-report";
import { opsTablesReady } from "@/lib/ops-reports/tables";
import { saveWorkReportMonth, saveWorkReportSettings } from "@/lib/actions/work-reports";
import { WorkReportHeadline, WorkReportSheet } from "@/components/ops-reports/WorkReportSheet";
import { Button, Card, CardHeader, Field, Flash, Input, LinkButton, LinkTabs, Note, PageHeader, Select, Stat } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * 作業日報 (F-11): 店舗・月ごとの引取・納品・施工・見積の件数・枚数・担当を予定表から自動で集計する。
 * 予定からわからない項目 (チラシの配布人・枚数・地域、来店数) は「入力」のタブで入れる。印刷・CSV も同じ集計
 */
export default async function WorkReportsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const stores = db.stores.filter((s) => canViewWorkReport(user, s.id));
  if (!stores.length) redirect("/?err=" + encodeURIComponent("作業日報を閲覧する権限がありません。"));
  const defaultStore = stores.find((s) => s.id === user.storeId && s.kind === "store") ?? stores.find((s) => s.kind === "store") ?? stores[0];
  const storeId = (stores.find((s) => s.id === sp.store) ?? defaultStore).id as StoreId;
  const store = stores.find((s) => s.id === storeId)!;
  const today = toDateKey(new Date());
  const month = isMonthKey(sp.month) ? sp.month : today.slice(0, 7);
  const tab = sp.tab === "input" || sp.tab === "settings" ? sp.tab : "sheet";
  const report = buildWorkReport(db, storeId, month);
  const canEdit = canEditWorkReport(user, storeId);
  const canSettings = canManageOpsReportSettings(user);
  const ready = opsTablesReady(["work_report_days"]);
  const settings = readWorkReportSettings(db);

  const q = (over: { month?: string; tab?: string } = {}) => {
    const p = new URLSearchParams({ store: storeId, month: over.month ?? month });
    const t = over.tab ?? tab;
    if (t !== "sheet") p.set("tab", t);
    return `/work-reports?${p.toString()}`;
  };
  const prev = addMonths(`${month}-01`, -1).slice(0, 7);
  const next = addMonths(`${month}-01`, 1).slice(0, 7);
  const monthLabel = `${Number(month.slice(0, 4))}年${Number(month.slice(5, 7))}月`;
  const csv = (section: string) => `/api/work-reports?store=${storeId}&month=${month}&section=${section}`;
  const scheduleHref = (kind: string) => `/schedule?view=month&date=${month}-01&store=${storeId}&kind=${kind}`;
  const t = report.totals;
  const staffNames = db.users.filter((u) => u.active && (u.storeId === storeId || u.role === "hq_staff")).map((u) => u.name);
  const knownAreas = [...new Set((db.workReportDays ?? []).flatMap((w) => w.flyers.map((f) => f.area ?? "")).concat((db.promotions ?? []).flatMap((p) => p.areas.map((a) => a.area))).filter(Boolean))].sort().slice(0, 300);

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader
        title="作業日報"
        description={`${store.name} · ${monthLabel} · 予定表の引取・納品・施工・見積から件数・枚数・担当を自動で集計します (表計算への二重の記入は不要です)`}
        actions={
          <>
            <a href={csv("sheet")} download className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-panel px-3 text-xs font-medium text-ink hover:bg-subtle"><Download className="h-3.5 w-3.5" aria-hidden /> CSV (日報の並び)</a>
            <a href={csv("lines")} download className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-panel px-3 text-xs font-medium text-ink hover:bg-subtle"><Download className="h-3.5 w-3.5" aria-hidden /> CSV (明細)</a>
            <LinkButton href={`/print/work-reports?store=${storeId}&month=${month}`} target="_blank" variant="secondary" size="sm"><Printer className="h-4 w-4" aria-hidden /> 印刷</LinkButton>
          </>
        }
      />

      <form method="get" action="/work-reports" className="mb-4 flex flex-wrap items-end gap-2">
        {tab !== "sheet" && <input type="hidden" name="tab" value={tab} />}
        <Link href={q({ month: prev })} className="inline-flex h-9 items-center rounded-lg border border-line bg-panel px-2 text-ink-2 hover:bg-subtle" aria-label="前の月"><ChevronLeft className="h-4 w-4" /></Link>
        <label className="block">
          <span className="label">月</span>
          <Input type="month" name="month" defaultValue={month} className="h-9 w-auto py-1" />
        </label>
        <Link href={q({ month: next })} className="inline-flex h-9 items-center rounded-lg border border-line bg-panel px-2 text-ink-2 hover:bg-subtle" aria-label="次の月"><ChevronRight className="h-4 w-4" /></Link>
        <label className="block">
          <span className="label">店舗</span>
          <Select name="store" defaultValue={storeId} className="h-9 w-auto py-1">
            {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </label>
        <Button type="submit" variant="secondary" size="sm">表示</Button>
      </form>

      <LinkTabs
        current={q()}
        items={[
          { href: q({ tab: "sheet" }), label: "日報" },
          ...(canEdit ? [{ href: q({ tab: "input" }), label: "入力 (チラシ・来店数)" }] : []),
          { href: q({ tab: "settings" }), label: "係数と集計の決まり" },
        ]}
      />

      {!ready && <div className="mb-4"><Note tone="warn">作業日報の手入力のテーブルがまだデータベースにありません。集計は表示できますが、チラシ・来店数の入力は管理者がデプロイ (npm run db:migrate) した後に使えます。</Note></div>}

      {tab === "sheet" && (
        <>
          <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-3 @5xl:grid-cols-6">
            <Stat label="引取" value={`${t.pickup.count} 件`} sub={`畳 ${t.pickup.tatami} 枚 · 襖類 ${t.pickup.fusumaWeighted}`} href={scheduleHref("pickup")} />
            <Stat label="納品" value={`${t.delivery.count} 件`} sub={`畳 ${t.delivery.tatami} 枚 · 襖類 ${t.delivery.fusumaWeighted}`} href={scheduleHref("delivery")} />
            <Stat label="見積 (現地調査・採寸)" value={`${t.survey} 件`} />
            <Stat label="施工" value={`${t.install} 件`} href={scheduleHref("install")} />
            <Stat label="チラシの配布" value={`${t.flyerCopies.toLocaleString("ja-JP")} 枚`} sub={`${t.flyerLines} 件の入力`} />
            <Stat label="来店数" value={`${t.visitors.toLocaleString("ja-JP")} 人`} sub={`${t.visitorDays} 日分の入力`} />
          </div>

          <div className="mt-4 grid grid-cols-1 gap-4 @4xl:grid-cols-2">
            <Card>
              <CardHeader title="見出しの集計 (引取)" description="作業日報の表計算の「畳 総数 ／人 ／日 ／人日」と「襖類 (係数後)」" />
              <WorkReportHeadline report={report} />
            </Card>
            <Card>
              <CardHeader title="予定表との照合" description="件数は予定表の予定 (開始日・予定の店舗) から数えるので、予定表の件数と一致します" />
              <ul className="space-y-1.5 text-sm">
                <li className="flex flex-wrap items-center justify-between gap-2"><span>予定表の引き取り <Link href={scheduleHref("pickup")} className="text-accent hover:underline">{report.scheduleCounts.pickup} 件</Link></span><span className={report.scheduleCounts.pickup === t.pickup.count ? "text-good" : "text-critical"}>日報 {t.pickup.count} 件{report.scheduleCounts.pickup === t.pickup.count ? " (一致)" : " (不一致)"}</span></li>
                <li className="flex flex-wrap items-center justify-between gap-2"><span>予定表の納品 <Link href={scheduleHref("delivery")} className="text-accent hover:underline">{report.scheduleCounts.delivery} 件</Link></span><span className={report.scheduleCounts.delivery === t.delivery.count ? "text-good" : "text-critical"}>日報 {t.delivery.count} 件{report.scheduleCounts.delivery === t.delivery.count ? " (一致)" : " (不一致)"}</span></li>
              </ul>
              {report.noQty.length > 0 && (
                <div className="mt-3">
                  <Note tone="warn">
                    枚数がわからない引取・納品が {report.noQty.length} 件あります。予定の件名・メモに「畳 表替え6」のように書くか、作業の内容 (作業種別と数量) を登録すると集計に入ります。
                    <ul className="mt-1.5 space-y-0.5">
                      {report.noQty.slice(0, 12).map((l) => (
                        <li key={l.eventId}>
                          {l.date.slice(5).replace("-", "/")} {l.line === "pickup" ? "引取" : "納品"} <Link href={`/schedule/${l.eventId}`} className="underline">{l.site}</Link> · <Link href={`/schedule/spec?type=event&id=${l.eventId}`} className="underline">作業の内容を登録</Link>
                        </li>
                      ))}
                      {report.noQty.length > 12 && <li>ほか {report.noQty.length - 12} 件</li>}
                    </ul>
                  </Note>
                </div>
              )}
            </Card>
          </div>

          <div className="mt-4">
            <WorkReportSheet report={report} />
            <p className="mt-2 text-[11px] text-ink-3">現場名を押すと予定を開きます。枚数は 作業の内容 &gt; 予定の件名・メモ (「畳 表替え6」) &gt; 同じ案件の予定 &gt; 受注の明細 &gt; 見積の明細 の順に読みます。表替え・裏返しは「表」、新調は「新」。休 = 休業日。</p>
          </div>
        </>
      )}

      {tab === "input" && canEdit && (
        <Card>
          <CardHeader title={`${monthLabel} の手入力 (${store.name})`} description="予定からわからない項目だけを入れます。チラシは 1 日に何行でも入れられます (保存すると空の行が 1 行増えます)。空にして保存するとその日の入力を消します" />
          <form action={saveWorkReportMonth}>
            <input type="hidden" name="storeId" value={storeId} />
            <input type="hidden" name="month" value={month} />
            <datalist id="wr-staff">{staffNames.map((n) => <option key={n} value={n} />)}</datalist>
            <datalist id="wr-areas">{knownAreas.map((a) => <option key={a} value={a} />)}</datalist>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] border-collapse text-xs">
                <thead>
                  <tr className="text-left text-[11px] text-ink-3">
                    <th className="px-2 py-1.5">日</th>
                    <th className="px-2 py-1.5">来店数</th>
                    <th className="px-2 py-1.5">チラシ: 配布人</th>
                    <th className="px-2 py-1.5">枚数</th>
                    <th className="px-2 py-1.5">配布地域 (町名)</th>
                    <th className="px-2 py-1.5">メモ</th>
                  </tr>
                </thead>
                <tbody>
                  {report.days.map((d) => {
                    // 受注のポスティングの実績 (受注の画面で登録。ここでは変えない) は読むだけ。手入力の行だけを送る
                    const fromOrders = d.flyers.filter((f) => f.orderId);
                    const lines = [...d.flyers.filter((f) => !f.orderId), { distributor: "", userIds: [], copies: 0, area: "" }];
                    const orderRows = fromOrders.map((f, i) => (
                      <tr key={`${d.date}-o${i}`} className="text-ink-2">
                        <td />
                        <td />
                        <td className="px-2 py-1">{f.distributor}</td>
                        <td className="px-2 py-1 text-right tnum">{f.copies.toLocaleString("ja-JP")}</td>
                        <td className="px-2 py-1">{f.area ?? ""}</td>
                        <td className="px-2 py-1 text-[11px] text-ink-3">
                          受注 <Link href={`/orders/${f.orderId}#work-staff`} className="text-accent hover:underline">{f.orderNumber}</Link> のポスティング
                        </td>
                      </tr>
                    ));
                    const manualRows = lines.map((f, i) => (
                      <tr key={`${d.date}-${i}`} className={i === 0 ? "border-t border-line" : ""}>
                        {i === 0 && (
                          <td rowSpan={lines.length} className={`px-2 py-1 align-top whitespace-nowrap tnum ${d.weekday === 0 ? "text-critical" : d.weekday === 6 ? "text-info" : ""}`}>
                            {Number(d.date.slice(8))} ({weekdayLabel(d.weekday)}){d.closed && <span className="ml-1 text-[10px] text-ink-3">休</span>}
                            <input type="hidden" name={`fn_${d.date}`} value={lines.length} />
                          </td>
                        )}
                        {i === 0 && (
                          <td rowSpan={lines.length} className="px-2 py-1 align-top">
                            <Input name={`v_${d.date}`} defaultValue={d.visitors ?? ""} inputMode="numeric" className="h-8 w-20 py-1 text-right" aria-label={`${d.date} の来店数`} />
                          </td>
                        )}
                        <td className="px-2 py-1"><Input name={`f_${d.date}_${i}_by`} defaultValue={f.distributor} list="wr-staff" className="h-8 w-40 py-1" aria-label={`${d.date} の配布人`} /></td>
                        <td className="px-2 py-1"><Input name={`f_${d.date}_${i}_copies`} defaultValue={f.copies || ""} inputMode="numeric" className="h-8 w-24 py-1 text-right" aria-label={`${d.date} のチラシの枚数`} /></td>
                        <td className="px-2 py-1"><Input name={`f_${d.date}_${i}_area`} defaultValue={f.area ?? ""} list="wr-areas" placeholder="例: 合志市須屋" className="h-8 w-44 py-1" aria-label={`${d.date} の配布地域`} /></td>
                        {i === 0 && (
                          <td rowSpan={lines.length} className="px-2 py-1 align-top">
                            <Input name={`n_${d.date}`} defaultValue={d.note ?? ""} className="h-8 w-48 py-1" aria-label={`${d.date} のメモ`} />
                          </td>
                        )}
                      </tr>
                    ));
                    return [...manualRows, ...orderRows];
                  })}
                </tbody>
              </table>
            </div>
            <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-line pt-4">
              <span className="mr-auto text-[11px] text-ink-3">配布人は社員の名前を選ぶと社員として記録します (アルバイト・業者の名前もそのまま書けます)。配布地域は販促と媒体の分析の「部数あたりの問い合わせ」に使います</span>
              <Button type="submit" disabled={!ready}>保存する</Button>
            </div>
          </form>
        </Card>
      )}

      {tab === "settings" && (
        <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-2">
          <Card>
            <CardHeader title="襖類 (係数後) の係数" description="作業日報の表計算と同じく、障子と網戸を襖に換算して数えます (既定: 障子 0.5・網戸 0.4)" />
            {canSettings ? (
              <form action={saveWorkReportSettings} className="space-y-3">
                <input type="hidden" name="storeId" value={storeId} />
                <input type="hidden" name="month" value={month} />
                <div className="grid grid-cols-1 gap-3 @xl:grid-cols-3">
                  <Field label="襖"><Input name="fusuma" defaultValue={settings.factors.fusuma} inputMode="decimal" /></Field>
                  <Field label="障子"><Input name="shoji" defaultValue={settings.factors.shoji} inputMode="decimal" /></Field>
                  <Field label="網戸"><Input name="amido" defaultValue={settings.factors.amido} inputMode="decimal" /></Field>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" size="sm">保存する</Button>
                  <Button type="submit" size="sm" variant="ghost" name="reset" value="1">既定 (襖 {DEFAULT_FACTORS.fusuma}・障子 {DEFAULT_FACTORS.shoji}・網戸 {DEFAULT_FACTORS.amido}) に戻す</Button>
                </div>
                {settings.configured && settings.updatedAt && <p className="text-[11px] text-ink-3">最終更新 {fmtDateTime(settings.updatedAt)} · {userName(settings.updatedBy)}</p>}
              </form>
            ) : (
              <p className="text-sm text-ink-2">襖 {settings.factors.fusuma} · 障子 {settings.factors.shoji} · 網戸 {settings.factors.amido} <span className="text-xs text-ink-3">(変更は本部スタッフ・管理者)</span></p>
            )}
          </Card>
          <Card>
            <CardHeader title="集計の決まり" />
            <ul className="list-disc space-y-1.5 pl-5 text-xs leading-relaxed text-ink-2">
              <li>件数は予定表の「引き取り」「納品」「施工」「現地調査・採寸 (見積)」の予定です。予定の店舗 (どの店舗のカレンダーに載るか) と開始日で数えます。仮押さえは数えません。</li>
              <li>枚数は 作業の内容 (登録したもの) &gt; 予定の件名・メモ (「畳 表替え6」「襖 張替3」) &gt; 同じ案件のほかの予定 &gt; 受注の明細 &gt; 見積の明細 の順に読みます。</li>
              <li>畳の「表」は表替え・裏返し、「新」は新調。襖・障子・網戸の「新」は、作業種別の名前か、件名・メモ・明細の「襖 新調」のような書き方で見分けます。</li>
              <li>担当は予定の担当者です。見出しの集計の「人」は引取・納品の担当者の人数、「日」は引取・納品のあった日数、「人日」は日ごとの担当者の人数の合計です。</li>
              <li>チラシの配布人・枚数・地域、来店数は「入力」のタブで入れます (販促と媒体の分析に反映されます)。</li>
            </ul>
          </Card>
        </div>
      )}
    </div>
  );
}
