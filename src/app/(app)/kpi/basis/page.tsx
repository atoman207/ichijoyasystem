import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canImportData, canManageSettings } from "@/lib/auth/permissions";
import { AVERAGE_LABEL, CASES_SOURCE_LABEL, DENOMINATOR_LABEL, DENOM_SOURCE_LABEL, INDIVIDUAL_SOURCE_LABEL, MAX_REPEAT_DAYS, basisNotes, denomRepeats, fiscalMonths, kpiBasis, kpiDenominators, ledgerCounts, monthFacts, monthKey, type KpiBasis } from "@/lib/kpi-basis";
import { BASIS_SOURCE_LABEL, planBasisImport, type BasisPlan, type BasisPreview } from "@/lib/kpi-basis-import";
import { readBasisPreview } from "@/lib/kpi-check";
import { fiscalRange, fiscalYearOf, kpiSettings } from "@/lib/kpi-settings";
import { fmtDateTime, toDateKey } from "@/lib/format";
import { userName } from "@/lib/db/queries";
import { applyKpiBasisImport, discardKpiBasisPreview, previewKpiBasisImport, saveKpiBasisRules, saveKpiMonthValues } from "@/lib/actions/kpi-basis";
import { KpiTabs } from "@/components/kpi/KpiTabs";
import { Badge, Button, Card, CardHeader, Field, Flash, LinkButton, Note, PageHeader, Select, Textarea } from "@/components/ui";
import type { Database, Store } from "@/lib/db/types";

export const maxDuration = 60;

const ACTION: Record<string, { label: string; tone: "good" | "info" | "neutral" | "warn" }> = {
  create: { label: "新規", tone: "good" },
  update: { label: "更新", tone: "info" },
  unchanged: { label: "変更なし", tone: "neutral" },
  manual: { label: "手入力のため取り込まない", tone: "warn" },
};

const monthLabel = (m: string) => `${Number(m.slice(0, 4))}年${Number(m.slice(5, 7))}月`;

export default async function KpiBasisPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  if (!canImportData(user)) redirect("/kpi?err=" + encodeURIComponent("KPI の分母の登録・照合は本部スタッフ・管理者が行えます。"));
  const db = getDb();
  const settings = kpiSettings(db);
  const basis = kpiBasis(db);
  const today = toDateKey(new Date());
  const fy = sp.fy && /^20\d\d$/.test(sp.fy) ? Number(sp.fy) : fiscalYearOf(today, settings.fiscalStartMonth);
  const months = fiscalMonths(fy, settings.fiscalStartMonth);
  const stores = db.stores.filter((s) => s.kind === "store");
  const admin = canManageSettings(user);
  const preview = sp.preview ? await readBasisPreview(sp.preview) : null;
  const plan = preview ? planBasisImport(db, preview, basis) : null;
  const fyOptions = Array.from({ length: 4 }, (_, i) => fiscalYearOf(today, settings.fiscalStartMonth) - i);

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader
        title="KPI · 分母・照合"
        description="返信率・クレーム手直しポイント率の分母 (店舗 × 月の個人件数・全案件数) と、はがきの数え方。スプレッドシート「お客様アンケート集計表」の KPI シートの集計基準に合わせ、手計算していたリピートの調整も自動で行います"
        actions={<LinkButton href={`/kpi/basis/check`} size="sm">支給前の照合 (KPI シートとの比較)</LinkButton>}
      />
      <KpiTabs current="/kpi/basis" sp={sp} user={user} />

      <RulesCard basis={basis} admin={admin} />

      <MonthTable db={db} basis={basis} fy={fy} months={months} stores={stores} fyOptions={fyOptions} startMonth={settings.fiscalStartMonth} />

      <Card className="mt-4">
        <CardHeader title="年間チラシ計画・アンケートはがきの取込" description="読み取って確認してから取り込みます (一方向: シート → システム)。手入力した個人件数は上書きしません" />
        <ul className="mb-3 space-y-1 text-xs text-ink-2">
          <li>・{BASIS_SOURCE_LABEL.individual}: 表「個人売上目標・実績（○○年度）」(7 月〜翌 6 月) の店舗ごとの「本年度実績」の件数。空欄の月 (まだ記入していない月) は読みません</li>
          <li>・{BASIS_SOURCE_LABEL.cardMonths}: 移行したはがきの「月」(集計月) を入れます。シートでは前月のはがきを月初に入力していたため、入力日のままだと年度の境目 (11 月・12 月) で 1 か月ずれます。2 人目以降の担当を手で書き足した行 (タイムスタンプのない行) で移行に漏れたものは、②③ の評価の行として足します</li>
          <li>・年間チラシ計画のファイルは 4 MB を超えるため、「個人件数売上」のタブを開いて ファイル → ダウンロード → CSV で保存したもの、またはタブの URL (共有・サービスアカウント) を使ってください</li>
        </ul>
        <form action={previewKpiBasisImport} className="space-y-3">
          <input type="file" name="files" multiple accept=".csv,.xlsx,.xlsm,text/csv" className="block w-full text-sm" />
          <Field label="Google スプレッドシートのタブの URL (1 行に 1 つ。任意)" hint="タブを開いた状態の URL (…#gid=数字)。サービスアカウントに共有するか、リンクを知っている全員が閲覧できる設定にしてください">
            <Textarea name="urls" rows={2} defaultValue={basis.sourceUrls.join("\n")} placeholder="https://docs.google.com/spreadsheets/d/…/edit#gid=…" />
          </Field>
          <Button type="submit" variant="secondary">読み取って確認する (まだ取り込みません)</Button>
        </form>
        {basis.lastImport && <p className="mt-3 text-xs text-ink-3">前回の取込: {fmtDateTime(basis.lastImport.at)} ({userName(basis.lastImport.by)}) · {basis.lastImport.label} · {basis.lastImport.summary}</p>}
      </Card>

      {sp.preview && !plan && <Note tone="warn">確認の内容が見つかりません (取り込み済み・破棄済み)。もう一度読み取ってください。</Note>}
      {plan && preview && <PlanView plan={plan} preview={preview} hash={sp.preview!} stores={stores} />}
    </div>
  );
}

function RulesCard({ basis, admin }: { basis: KpiBasis; admin: boolean }) {
  return (
    <Card>
      <CardHeader title="数え方 (いまの設定)" description="KPI の概要・アンケート・クレーム・手直し・インセンティブ・経営ダッシュボードのアンケートは、すべてこの数え方で集計します" />
      <ul className="space-y-1 text-xs text-ink-2">
        {basisNotes(basis).map((t, i) => <li key={i}>・{t}</li>)}
      </ul>
      {admin ? (
        <form action={saveKpiBasisRules} className="mt-4 space-y-3 border-t border-line pt-4">
          <div className="grid grid-cols-1 gap-3 @3xl:grid-cols-2">
            <Field label="返信率・ポイント率の分母">
              <Select name="denominator" defaultValue={basis.denominator}>
                {(Object.keys(DENOMINATOR_LABEL) as (keyof typeof DENOMINATOR_LABEL)[]).map((k) => <option key={k} value={k}>{DENOMINATOR_LABEL[k]}{k === "sheet" ? " (既定)" : ""}</option>)}
              </Select>
            </Field>
            <Field label="①〜④ の平均の計算">
              <Select name="average" defaultValue={basis.average}>
                {(Object.keys(AVERAGE_LABEL) as (keyof typeof AVERAGE_LABEL)[]).map((k) => <option key={k} value={k}>{AVERAGE_LABEL[k]}{k === "sheet" ? " (既定)" : ""}</option>)}
              </Select>
            </Field>
            <Field label="個人件数 (返信率の分母) の決め方">
              <Select name="individualSource" defaultValue={basis.individualSource}>
                {(Object.keys(INDIVIDUAL_SOURCE_LABEL) as (keyof typeof INDIVIDUAL_SOURCE_LABEL)[]).map((k) => <option key={k} value={k}>{INDIVIDUAL_SOURCE_LABEL[k]}{k === "plan" ? " (既定)" : ""}</option>)}
              </Select>
            </Field>
            <Field label="リピートを 1 件にまとめる日数" hint={`同じお客様・同じ店舗の、はがきを渡した案件から この日数以内の次の案件は個人件数に数えません (別の店舗の案件・売上は 1 件ずつ)。既定 30 日。0 = まとめない`}>
              <input type="number" name="repeatDays" min={0} max={MAX_REPEAT_DAYS} step={1} defaultValue={basis.repeatDays} className="field" />
            </Field>
            <Field label="全案件数 (クレーム・手直し率の分母) の数え方">
              <Select name="casesSource" defaultValue={basis.casesSource}>
                {(Object.keys(CASES_SOURCE_LABEL) as (keyof typeof CASES_SOURCE_LABEL)[]).map((k) => <option key={k} value={k}>{CASES_SOURCE_LABEL[k]}{k === "cases" ? " (既定)" : ""}</option>)}
              </Select>
            </Field>
          </div>
          <label className="flex items-start gap-2 text-sm text-ink-2"><input type="checkbox" name="requireStaffNames" defaultChecked={basis.requireStaffNames} className="mt-0.5 h-4 w-4" /> 担当 (営業担当・担当職人) の名前が一つでも未記入のはがきは数えない (シートの「担当の名前が一つでも未記入の場合ノーカウント」。既定)</label>
          <Button type="submit" size="sm" variant="secondary">数え方を保存する</Button>
          <p className="text-[11px] text-ink-3">平均の計算・分母の決め方は支給額に直結します (例: ① 電話対応の平均が 4.4 をまたぐと、事務 1 人あたりの金額が変わります)。変更は変更履歴に残ります。全案件数の既定 (案件の件数) は KPI シートの「売上の現場名下の数字」と同じ数で、作業日報の納品件数 (手直しの納品・1 件の工事の分けた納品も 1 件ずつ) より少し少なくなります。</p>
        </form>
      ) : (
        <p className="mt-3 text-[11px] text-ink-3">数え方の変更は管理者が行えます。</p>
      )}
    </Card>
  );
}

function MonthTable({ db, basis, fy, months, stores, fyOptions, startMonth }: { db: Database; basis: KpiBasis; fy: number; months: string[]; stores: Store[]; fyOptions: number[]; startMonth: number }) {
  const range = { from: `${months[0]}-01`, to: fiscalRangeEnd(months) };
  const cmap = new Map(db.customers.map((c) => [c.id, c]));
  // 店舗|月 の件数 (案件・個人・リピート・作業日報の納品・期間内の受注)
  const facts = monthFacts(db, range, undefined, { customers: cmap, basis });
  const ledger = ledgerCounts(db.orders);
  const totals = new Map(stores.map((s) => [s.id, kpiDenominators(db, range, s.id, { customers: cmap, basis })]));
  const src = (s: keyof typeof DENOM_SOURCE_LABEL) => DENOM_SOURCE_LABEL[s];
  const n = (v: number) => v.toLocaleString("ja-JP");
  return (
    <Card className="mt-4" padded={false}>
      <div className="px-5 pt-5">
        <CardHeader
          title={`店舗 × 月の個人件数・全案件数 (${fy}年度 ${range.from.replace(/-/g, "/")}〜${range.to.replace(/-/g, "/")})`}
          description={`個人件数 = 返信率の分母 (年間チラシ計画の本年度実績。空欄の月は自動 = 個人のお客様の案件 − ${basis.repeatDays > 0 ? `同じお客様・同じ店舗の ${basis.repeatDays} 日以内のリピート` : "リピート (まとめない設定)"})。全案件数 = クレーム・手直し率の分母 (${CASES_SOURCE_LABEL[basis.casesSource]})。入力欄の下に、自動の値・作業日報の納品件数を出しています`}
        />
        <form method="get" action="/kpi/basis" className="mb-3 flex flex-wrap items-end gap-2">
          <label className="block"><span className="label">年度</span><select name="fy" defaultValue={String(fy)} className="field h-9 py-1 text-sm">{[...new Set([fy, ...fyOptions])].sort((a, b) => b - a).map((y) => { const r = fiscalRange(y, startMonth); return <option key={y} value={y}>{y}年度 ({r.from.slice(0, 7)}〜{r.to.slice(0, 7)})</option>; })}</select></label>
          <button type="submit" className="inline-flex h-9 items-center rounded-lg border border-line bg-panel px-3 text-sm font-medium text-ink hover:bg-subtle">表示</button>
        </form>
      </div>
      <form action={saveKpiMonthValues}>
        <input type="hidden" name="fy" value={fy} />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1040px] text-xs">
            <thead>
              <tr className="bg-subtle text-ink-2">
                <th rowSpan={2} className="px-3 py-2 text-left font-medium">月</th>
                {stores.map((s) => <th key={s.id} colSpan={2} className="border-l border-line px-2 py-1.5 text-center font-medium">{s.shortName}</th>)}
              </tr>
              <tr className="bg-subtle text-ink-2">
                {stores.map((s) => (
                  <th key={s.id} colSpan={2} className="border-l border-line px-2 pb-1.5 font-normal">
                    <span className="grid grid-cols-2 gap-1"><span>個人件数</span><span>全案件数</span></span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {months.map((m) => (
                <tr key={m} className="border-t border-line align-top">
                  <td className="whitespace-nowrap px-3 py-1.5 tnum">{monthLabel(m)}</td>
                  {stores.map((s) => {
                    const k = monthKey(s.id, m);
                    const v = basis.months[k];
                    const f = facts.get(k);
                    const auto = f && f.cases > 0 ? f.individual - f.repeats : undefined;
                    const autoText = auto !== undefined ? `自動 ${n(auto)}${f!.repeats ? ` (リピート ${f!.repeats} を除く)` : ""}` : `システム ${n(f?.systemIndividual ?? 0)}`;
                    const planUsed = v?.individual !== undefined && (basis.individualSource === "plan" || v.individualSrc === "manual");
                    const casesVal = f && f.cases > 0 ? f.cases : undefined;
                    const autoSites = basis.casesSource === "deliveries" ? (f?.deliveries ?? 0) : basis.casesSource === "cases" && casesVal !== undefined ? casesVal : (f?.systemAll ?? 0);
                    const last = ledger.lastDate.get(s.id);
                    const ledgerEnds = last && last.slice(0, 7) === m && last < monthEndOf(m);
                    return (
                      <td key={s.id} colSpan={2} className="border-l border-line px-2 py-1.5">
                        <span className="grid grid-cols-2 gap-1">
                          <span>
                            <input name={`ind_${s.id}_${m}`} defaultValue={v?.individual ?? ""} inputMode="numeric" placeholder={String(auto ?? f?.systemIndividual ?? "")} className="field h-7 w-full py-0.5 text-right text-xs tnum" aria-label={`${s.shortName} ${monthLabel(m)} の個人件数`} />
                            <span className={`mt-0.5 block text-[10px] ${v?.individual !== undefined && !planUsed ? "text-warn-ink" : "text-ink-3"}`}>
                              {v?.individual !== undefined ? `${src(v.individualSrc ?? "import")}${planUsed ? "" : " (使わない)"} · ${autoText}` : `空欄 → ${autoText}`}
                            </span>
                          </span>
                          <span>
                            <input name={`sites_${s.id}_${m}`} defaultValue={v?.sites ?? ""} inputMode="numeric" placeholder={String(autoSites)} className="field h-7 w-full py-0.5 text-right text-xs tnum" aria-label={`${s.shortName} ${monthLabel(m)} の全案件数`} />
                            <span className={`mt-0.5 block text-[10px] ${ledgerEnds ? "text-warn-ink" : "text-ink-3"}`}>
                              {v?.sites !== undefined ? "手入力 · " : "空欄 → "}案件 {casesVal !== undefined ? n(casesVal) : "-"} · 納品 {n(f?.deliveries ?? 0)}
                              {ledgerEnds && <> · 台帳 {Number(last!.slice(5, 7))}/{Number(last!.slice(8, 10))} まで + 新システム</>}
                            </span>
                          </span>
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
              <tr className="border-t-2 border-line bg-accent-soft/30 font-semibold">
                <td className="px-3 py-2">年度の合計</td>
                {stores.map((s) => {
                  const d = totals.get(s.id)!;
                  const rep = denomRepeats(d.individual);
                  return (
                    <td key={s.id} colSpan={2} className="border-l border-line px-2 py-2">
                      <span className="grid grid-cols-2 gap-1 text-right tnum">
                        <span>{n(d.individual.value)}{rep > 0 && <span className="block text-[10px] font-normal text-ink-3">リピート {rep} 件を除く</span>}</span>
                        <span>{n(d.sites.value)}</span>
                      </span>
                    </td>
                  );
                })}
              </tr>
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center gap-3 px-5 py-3">
          <Button type="submit" size="sm" variant="secondary">個人件数・全案件数を保存</Button>
          <span className="text-[11px] text-ink-3">入れた値は「手入力」になり、取り込みで上書きしません。空欄にすると年間チラシ計画の取込・自動の値に戻ります。自動の個人件数は、案件 (売上台帳の現場名の行 + 新システムで完了した受注) のうち個人のお客様の件数から、同じお客様・同じ店舗の {basis.repeatDays} 日以内のリピートを除いた数です (はがきを渡した案件から数えます。別の店舗の案件は 1 件ずつ)。「案件」= 全案件数の自動の値、「納品」= 作業日報の納品件数 (予定表の納品の予定) です。</span>
        </div>
      </form>
      {basis.denominator === "system" && <div className="px-5 pb-4"><Note tone="warn">いまの設定は「{DENOMINATOR_LABEL.system}」のため、この表の値は集計に使っていません。</Note></div>}
    </Card>
  );
}

function monthEndOf(m: string): string {
  const [y, mo] = m.split("-").map(Number);
  return `${m}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, "0")}`;
}
function fiscalRangeEnd(months: string[]): string {
  return monthEndOf(months[months.length - 1]);
}

function PlanView({ plan, preview, hash, stores }: { plan: BasisPlan; preview: BasisPreview; hash: string; stores: Store[] }) {
  const ind = plan.individual;
  const c = plan.cards;
  const nothing = !ind.some((i) => i.action === "create" || i.action === "update") && !c.changes.length && !c.adds.length && !c.newCards.length;
  const unresolvedNames = [...new Set(c.newCards.flatMap((x) => x.unresolvedNames))];
  const newByMonth = [...c.newCards.reduce((m, x) => m.set(x.month || "(月なし)", (m.get(x.month || "(月なし)") ?? 0) + 1), new Map<string, number>())].sort();
  // 個人件数: 年度 × 店舗の表 (新しい月から 24 か月)
  const indMonths = [...new Set(ind.map((i) => i.month))].sort().reverse().slice(0, 24);
  const byKey = new Map(ind.map((i) => [monthKey(i.storeId, i.month), i]));
  return (
    <div className="mt-4 space-y-4">
      <Card>
        <CardHeader title="確認 (まだ取り込んでいません)" description={`${preview.label} · 読み取り ${fmtDateTime(preview.at)} (${userName(preview.by)})`} />
        <div className="flex flex-wrap gap-1.5 text-xs">
          <Badge tone="info" dot={false}>個人件数 {ind.length} か月分 (新規 {plan.counts.individual.create}・更新 {plan.counts.individual.update}・変更なし {plan.counts.individual.unchanged}・手入力のため取り込まない {plan.counts.individual.manual})</Badge>
          {preview.cardMonths.length > 0 && <Badge tone="info" dot={false}>はがきの集計月 {c.changes.length} 行 (変更なし {c.unchanged})</Badge>}
          {c.adds.length > 0 && <Badge tone="good" dot={false}>移行で漏れた担当の行を追加 {c.adds.length} 行</Badge>}
          {c.newCards.length > 0 && <Badge tone="good" dot={false}>新しいはがき (移行のあとに入力した行) {c.newCards.length} 枚</Badge>}
          {c.registered > 0 && <Badge tone="neutral" dot={false}>同じハガキ№ が登録済みのため取り込まない {c.registered} 枚</Badge>}
          {(c.notInSystem > 0 || c.mismatch > 0 || c.unresolved > 0) && <Badge tone="warn" dot={false}>システムにない行 {c.notInSystem} · 行が合わない {c.mismatch} · 担当者が決まらない {c.unresolved}</Badge>}
        </div>
        {preview.problems.length > 0 && <div className="mt-3 space-y-1">{preview.problems.map((p, i) => <p key={i} className="text-xs text-warn-ink">・{p}</p>)}</div>}
        {c.newCards.length > 0 && (
          <div className="mt-3 text-xs text-ink-2">
            <p>新しいはがき (集計月ごと): {newByMonth.map(([m, n]) => `${m === "(月なし)" ? m : monthLabel(m)} ${n} 枚`).join("・")}</p>
            {unresolvedNames.length > 0 && <p className="mt-1 text-warn-ink">社員のアカウントに決まらない担当の名前 (名前の文字のまま登録し、②③ の個人の評価には入りません): {unresolvedNames.slice(0, 20).join("・")}。取り込んだあと、はがきの画面 (KPI → アンケート) で担当者を選べます</p>}
          </div>
        )}
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <form action={applyKpiBasisImport}>
            <input type="hidden" name="hash" value={hash} />
            <Button type="submit" disabled={nothing}>この内容で取り込む</Button>
          </form>
          <form action={discardKpiBasisPreview}>
            <input type="hidden" name="hash" value={hash} />
            <Button type="submit" variant="ghost">破棄する</Button>
          </form>
        </div>
        <p className="mt-2 text-[11px] text-ink-3">取り込む直前に、いまのデータと比べ直します。同じ内容を 2 回取り込んでも変わりません。</p>
      </Card>

      {ind.length > 0 && (
        <Card padded={false}>
          <div className="px-5 pt-5"><CardHeader title="個人件数 (年間チラシ計画)" description="シートの値 (いまの値)。新しい月から 24 か月" /></div>
          <div className="max-h-[28rem] overflow-auto">
            <table className="w-full min-w-[640px] text-xs">
              <thead className="sticky top-0"><tr className="bg-subtle text-ink-2"><th className="px-3 py-2 text-left font-medium">月</th>{stores.map((s) => <th key={s.id} className="px-2 py-2 text-right font-medium">{s.shortName}</th>)}</tr></thead>
              <tbody>
                {indMonths.map((m) => (
                  <tr key={m} className="border-t border-line">
                    <td className="px-3 py-1.5 tnum">{monthLabel(m)}</td>
                    {stores.map((s) => {
                      const i = byKey.get(monthKey(s.id, m));
                      if (!i) return <td key={s.id} className="px-2 py-1.5 text-right text-ink-3">-</td>;
                      return (
                        <td key={s.id} className="px-2 py-1.5 text-right tnum" title={`${i.ref} · ${ACTION[i.action].label}`}>
                          {i.value}
                          {i.action !== "unchanged" && i.current !== undefined && <span className="ml-1 text-[10px] text-ink-3">({i.current})</span>}
                          {i.action !== "unchanged" && <Badge tone={ACTION[i.action].tone} dot={false} className="ml-1">{ACTION[i.action].label}</Badge>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {preview.cardMonths.length > 0 && (
        <Card padded={false}>
          <div className="px-5 pt-5">
            <CardHeader title="はがきの集計月 (アンケートハガキ（回答）の「月」)" description="集計月ごとのはがきの枚数 (取り込んだ後) と、いまの数え方 (入力日・回答日の月) の枚数。新しい月から 15 か月" />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px] text-xs">
              <thead><tr className="bg-subtle text-ink-2"><th className="px-3 py-2 text-left font-medium">月</th><th className="px-2 py-2 text-right font-medium">集計月で数えた枚数</th><th className="px-3 py-2 text-right font-medium">いま (入力日の月)</th></tr></thead>
              <tbody>
                {[...c.byMonth].reverse().slice(0, 15).map((r) => (
                  <tr key={r.month} className="border-t border-line"><td className="px-3 py-1.5 tnum">{monthLabel(r.month)}</td><td className="px-2 py-1.5 text-right tnum">{r.after}</td><td className="px-3 py-1.5 text-right tnum text-ink-2">{r.before}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          {c.adds.length > 0 && (
            <div className="px-5 py-3 text-xs text-ink-2">
              追加する担当の行: {c.adds.map((a) => `${a.row} 行目 (${monthLabel(a.month)}${a.craftsmanScore !== undefined ? ` · ③ ${a.craftsmanScore}` : ""}${a.salesScore !== undefined ? ` · ② ${a.salesScore}` : ""})`).join("、")}
            </div>
          )}
          <p className="px-5 pb-4 text-[11px] text-ink-3">行の照合: 移行したはがき (変更履歴の元 = アンケートハガキ（回答）の行) と、はがき No.・入力日時が同じ行だけに集計月を入れます。</p>
        </Card>
      )}
    </div>
  );
}
