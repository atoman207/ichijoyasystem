import Link from "@/components/ui/Link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canImportData } from "@/lib/auth/permissions";
import { googleSheetsStatus } from "@/lib/google/sheets";
import { QUALITY_KIND_LABEL } from "@/lib/kpi-settings";
import { fmtDateTime, toDateKey } from "@/lib/format";
import { userName } from "@/lib/db/queries";
import { WORKBOOK_NAME, planWorkbook, workbookSettings, type WorkbookPlan } from "@/lib/survey-workbook/plan";
import { readPreview, workbookTablesMissing } from "@/lib/survey-workbook/preview";
import { formatAliasLines } from "@/lib/survey-workbook/staff";
import { applySurveyWorkbook, discardSurveyWorkbookPreview, previewSurveyWorkbook, saveSurveyWorkbookSettings } from "@/lib/actions/survey-workbook";
import { KpiTabs } from "@/components/kpi/KpiTabs";
import { Badge, Button, Card, CardHeader, Field, Flash, Input, Note, PageHeader, StoreTag, Textarea } from "@/components/ui";

export const maxDuration = 60;

const ACTION: Record<string, { label: string; tone: "good" | "info" | "neutral" }> = {
  create: { label: "新規", tone: "good" },
  update: { label: "更新", tone: "info" },
  unchanged: { label: "変更なし", tone: "neutral" },
};

export default async function KpiImportPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  if (!canImportData(user)) redirect("/kpi?err=" + encodeURIComponent("スプレッドシートの取込は本部スタッフ・管理者が行えます。"));
  const db = getDb();
  const settings = workbookSettings(db);
  const sa = googleSheetsStatus();
  const today = toDateKey(new Date());
  const preview = sp.preview ? await readPreview(sp.preview) : null;
  const plan = preview ? planWorkbook(db, preview.tabs, { today }) : null;
  const tablesMissing = await workbookTablesMissing();
  const stores = new Map(db.stores.map((s) => [s.id, s]));
  const unmatched = plan?.reviews.unmatched ?? [];

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader title="KPI · スプレッドシートの取込" description={`「${WORKBOOK_NAME}」(Google スプレッドシート) のクレーム手直し内容・Google 口コミ集計・アンケートの過去の集計をシステムに取り込み、KPI のシートの手計算とシステムの集計を照合します`} />
      <KpiTabs current="/kpi/import" sp={sp} user={user} />

      {tablesMissing && <Note tone="warn">データベースに取込の表 (アンケートの過去の集計・クレーム・手直しの新しい列) がまだありません。確認はできますが、取り込むには開発担当が npm run db:migrate を実行してください。</Note>}

      <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-2">
        <Card>
          <CardHeader title="1. ファイルから" description="Google スプレッドシートの「ファイル → ダウンロード → CSV」で保存したタブごとの CSV (複数まとめて選べます)、または .xlsx (全タブ)" />
          <form action={previewSurveyWorkbook} className="space-y-3">
            <input type="hidden" name="source" value="files" />
            <input type="file" name="files" multiple accept=".csv,.xlsx,.xlsm,text/csv" className="block w-full text-sm" required />
            <Button type="submit">読み取って確認する (まだ取り込みません)</Button>
          </form>
        </Card>
        <Card>
          <CardHeader title="2. Google スプレッドシートから" description={settings.sheetUrl || settings.tabUrls.length ? "下の「つなぎ方の設定」の URL から読みます" : "下の「つなぎ方の設定」で URL を登録すると、スプレッドシートから直接読めます"} />
          <div className="space-y-2 text-xs text-ink-2">
            <div>
              サービスアカウント: {sa.configured ? <Badge tone="good">設定済み</Badge> : <Badge tone="warn">未設定</Badge>} {sa.email && <span className="font-mono">{sa.email}</span>}
            </div>
            <p className="text-ink-3">{sa.configured ? `スプレッドシートの「共有」で ${sa.email} を「閲覧者」に追加すると、全タブ (クレーム手直し内容・Google口コミ集計・KPI・集計) を読めます。` : "サービスアカウントがないときは、タブごとの共有リンク (リンクを知っている全員が閲覧できる設定) を登録してください。設定 → 外部連携・AI でサービスアカウントの状態を確かめられます。"}</p>
            <form action={previewSurveyWorkbook}>
              <input type="hidden" name="source" value="google" />
              <Button type="submit" variant="secondary" disabled={!settings.sheetUrl && !settings.tabUrls.length}>スプレッドシートを読んで確認する</Button>
            </form>
          </div>
        </Card>
      </div>

      {sp.preview && !plan && <Note tone="warn">確認の内容が見つかりません (取り込み済み・破棄済み、または期限切れ)。もう一度読み取ってください。</Note>}
      {plan && preview && <PlanView plan={plan} label={preview.label} at={preview.at} by={preview.by} readProblems={preview.problems} hash={sp.preview!} tablesMissing={tablesMissing} stores={stores} />}

      <Card className="mt-4">
        <CardHeader title="つなぎ方の設定" description="スプレッドシートの URL・担当者の名前の対応・定期の同期。一方向 (シート → システム) で、シートから消えた行はシステムでは消しません。システムで変えた項目 (案件のひも付け・担当者・状態) はシートで上書きしません" />
        <form action={saveSurveyWorkbookSettings} className="space-y-3">
          <input type="hidden" name="returnTo" value={sp.preview ? `/kpi/import?preview=${sp.preview}` : "/kpi/import"} />
          <Field label="スプレッドシートの URL (サービスアカウントで全タブを読む)" hint="https://docs.google.com/spreadsheets/d/…/edit">
            <Input name="sheetUrl" defaultValue={settings.sheetUrl} placeholder="https://docs.google.com/spreadsheets/d/…" />
          </Field>
          <Field label="タブごとの共有リンク (サービスアカウントがないとき。1 行に 1 つ)" hint="タブを開いた状態の URL (…#gid=数字)。共有を「リンクを知っている全員 (閲覧者)」にする">
            <Textarea name="tabUrls" rows={3} defaultValue={settings.tabUrls.join("\n")} />
          </Field>
          <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
            <Field label="口コミのシートの最初の行の年 (空欄 = 自動)" hint="入力日に年がないため、最後の行が今日から 1 年以内になるように決めます">
              <Input name="startYear" defaultValue={settings.startYear ? String(settings.startYear) : ""} placeholder={plan?.reviews.startYear ? String(plan.reviews.startYear) : "例: 2024"} inputMode="numeric" />
            </Field>
            <label className="flex items-center gap-2 self-end text-sm text-ink-2"><input type="checkbox" name="autoSync" defaultChecked={settings.autoSync} className="h-4 w-4" /> 毎日 6:20 にスプレッドシートから取り込む (定期の同期)</label>
          </div>
          <Field label="担当者の名前の対応 (1 行 = シートの名前 = 社員の氏名 / アカウントなし / 数えない)" hint="姓・名がアカウントの社員 1 人に決まる名前は書かなくても照合します。決まらない名前だけ書いてください">
            <Textarea name="aliases" rows={4} defaultValue={formatAliasLines(settings.staffAliases, db.users) || unmatched.map((u) => `${u.name} = アカウントなし`).join("\n")} placeholder="例: 〇〇 = 一畳 太郎" />
          </Field>
          <Button type="submit" variant="secondary">設定を保存する</Button>
        </form>
        <div className="mt-3 space-y-1 text-xs text-ink-3">
          {settings.lastImport && <p>前回の取込: {fmtDateTime(settings.lastImport.at)} ({userName(settings.lastImport.by)}) · {settings.lastImport.label} · {settings.lastImport.summary}</p>}
          {settings.lastSync && <p>前回の定期の同期: {fmtDateTime(settings.lastSync.at)} · {settings.lastSync.ok ? "成功" : "失敗"} · {settings.lastSync.message}</p>}
        </div>
      </Card>
    </div>
  );
}

function PlanView({ plan, label, at, by, readProblems, hash, tablesMissing, stores }: { plan: WorkbookPlan; label: string; at: string; by: string; readProblems: string[]; hash: string; tablesMissing: boolean; stores: Map<string, import("@/lib/db/types").Store> }) {
  const problems = [...readProblems, ...plan.problems];
  const c = plan.claims;
  const r = plan.reviews;
  const h = plan.history;
  const nothing = !c.items.length && !r.items.length && !h.rows.length;
  return (
    <div className="mt-4 space-y-4">
      <Card>
        <CardHeader title="確認 (まだ取り込んでいません)" description={`${label} · 読み取り ${fmtDateTime(at)} (${userName(by)})`} />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead><tr className="bg-subtle text-xs text-ink-2"><th className="px-3 py-2 text-left font-medium">タブ</th><th className="px-3 py-2 text-left font-medium">扱い</th><th className="px-3 py-2 text-right font-medium">行数</th></tr></thead>
            <tbody>
              {plan.tabs.map((t) => (
                <tr key={`${t.source}|${t.title}`} className="border-t border-line"><td className="px-3 py-1.5 text-xs">{t.title}</td><td className="px-3 py-1.5 text-xs text-ink-2">{t.label}</td><td className="px-3 py-1.5 text-right text-xs tnum">{t.rows}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        {problems.length > 0 && <div className="mt-3 space-y-1">{problems.map((p, i) => <p key={i} className="text-xs text-critical-ink">・{p}</p>)}</div>}
        {plan.warnings.length > 0 && <div className="mt-3 space-y-1">{plan.warnings.map((p, i) => <p key={i} className="text-xs text-warn-ink">・{p}</p>)}</div>}
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <form action={applySurveyWorkbook} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="hash" value={hash} />
            {r.items.length > 0 && (
              <Field label="口コミの最初の行の年">
                <Input name="startYear" defaultValue={r.startYear ? String(r.startYear) : ""} className="w-24" inputMode="numeric" />
              </Field>
            )}
            <Button type="submit" disabled={nothing || tablesMissing}>この内容で取り込む</Button>
          </form>
          <form action={discardSurveyWorkbookPreview}>
            <input type="hidden" name="hash" value={hash} />
            <Button type="submit" variant="ghost">破棄する</Button>
          </form>
        </div>
        <p className="mt-2 text-[11px] text-ink-3">取り込む直前に、いまのデータと比べ直します。同じ行を 2 回取り込んでも二重になりません (行ごとの印で照合)。</p>
      </Card>

      {c.items.length > 0 && (
        <Card padded={false}>
          <div className="px-5 pt-5">
            <CardHeader
              title={`クレーム・手直し ${c.items.length} 件`}
              description={`新規 ${c.create} · 更新 ${c.update} · 変更なし ${c.unchanged} · 案件にひも付け ${c.linked} · 集計に入れない ${c.notCounted} · 要確認 ${c.review} · 新しいタブと期間が重なり読まない行 ${c.overlapSkipped} · 空の行 ${c.emptyRows}`}
            />
            <p className="mb-2 text-xs text-ink-3">発生日はシートに日がないため月の 1 日です。クレームの行の次の「同上」の手直しは 1 件の「クレーム＋手直し」(3 点) にまとめます。案件は 現場名・店舗・月 で 1 件に決まるときだけひも付けます (決まらない記録は取り込んだ後に詳細の画面で受注番号を入れます)。</p>
          </div>
          <div className="max-h-[32rem] overflow-auto">
            <table className="w-full min-w-[1080px] text-sm">
              <thead className="sticky top-0"><tr className="bg-subtle text-xs text-ink-2"><th className="px-3 py-2 text-left font-medium">扱い</th><th className="px-2 py-2 text-left font-medium">年月</th><th className="px-2 py-2 text-left font-medium">単位</th><th className="px-2 py-2 text-left font-medium">区分</th><th className="px-2 py-2 text-left font-medium">現場名</th><th className="px-2 py-2 text-left font-medium">案件</th><th className="px-2 py-2 text-left font-medium">内容</th><th className="px-3 py-2 text-left font-medium">注意</th></tr></thead>
              <tbody>
                {[...c.items].sort((a, b) => b.rec.occurredOn.localeCompare(a.rec.occurredOn)).map((i) => (
                  <tr key={i.rec.key} className="border-t border-line align-top">
                    <td className="px-3 py-1.5"><Badge tone={ACTION[i.action].tone} dot={false}>{ACTION[i.action].label}</Badge></td>
                    <td className="px-2 py-1.5 text-xs tnum">{i.rec.occurredOn.slice(0, 7)}</td>
                    <td className="px-2 py-1.5 text-xs">{i.rec.attribution === "office" ? "事務" : <StoreTag store={stores.get(i.rec.storeId)} short />}</td>
                    <td className="px-2 py-1.5 text-xs">{QUALITY_KIND_LABEL[i.rec.kind]}{!i.rec.counted && <Badge tone="neutral" dot={false} className="ml-1">記録のみ</Badge>}</td>
                    <td className="px-2 py-1.5 text-xs">{i.rec.siteName ?? "-"}</td>
                    <td className="px-2 py-1.5 text-xs">{i.order ? <Link href={`/orders/${i.order.id}`} className="text-accent hover:underline">{i.order.number}</Link> : i.candidates > 1 ? <span className="text-warn-ink">候補 {i.candidates} 人</span> : <span className="text-ink-3">-</span>}</td>
                    <td className="max-w-[20rem] px-2 py-1.5 text-xs text-ink-2">{i.rec.description.slice(0, 80)}</td>
                    <td className="max-w-[18rem] px-3 py-1.5 text-[11px] text-warn-ink">{[i.rec.review, ...i.rec.notes].filter(Boolean).join(" / ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {r.items.length > 0 && (
        <Card padded={false}>
          <div className="px-5 pt-5">
            <CardHeader title={`Google 口コミ ${r.items.length} 件`} description={`新規 ${r.create} · 更新 ${r.update} · 変更なし ${r.unchanged} · 最初の行の年 ${r.startYear ?? "-"}${r.ignored ? ` · 数えない名前 ${r.ignored} 件` : ""}`} />
            <p className="mb-2 text-xs text-ink-3">口コミの日 = 事務の入力日 (KPI は入力月で集計)。支払日・確認・備考はメモに残します。支払日が「－」の行は支給なしの記録です (支給から外す社員は 設定 → KPI・インセンティブ の「集計・順位・支給から外す社員」)。</p>
          </div>
          <div className="max-h-[24rem] overflow-auto">
            <table className="w-full min-w-[860px] text-sm">
              <thead className="sticky top-0"><tr className="bg-subtle text-xs text-ink-2"><th className="px-3 py-2 text-left font-medium">扱い</th><th className="px-2 py-2 text-left font-medium">入力日</th><th className="px-2 py-2 text-left font-medium">担当者</th><th className="px-2 py-2 text-right font-medium">ポイント</th><th className="px-2 py-2 text-left font-medium">お客様</th><th className="px-3 py-2 text-left font-medium">メモ・注意</th></tr></thead>
              <tbody>
                {[...r.items].sort((a, b) => b.rec.postedOn.localeCompare(a.rec.postedOn)).map((i) => (
                  <tr key={i.rec.key} className="border-t border-line align-top">
                    <td className="px-3 py-1.5"><Badge tone={ACTION[i.action].tone} dot={false}>{ACTION[i.action].label}</Badge></td>
                    <td className="px-2 py-1.5 text-xs tnum">{i.rec.postedOn}</td>
                    <td className="px-2 py-1.5 text-xs">{i.rec.staff.userId ? userName(i.rec.staff.userId) : <span className="text-warn-ink">{i.rec.staff.raw} (アカウントなし)</span>}</td>
                    <td className="px-2 py-1.5 text-right text-xs tnum">{i.rec.points}</td>
                    <td className="px-2 py-1.5 text-xs">{i.rec.reviewerName ?? "-"}</td>
                    <td className="px-3 py-1.5 text-[11px] text-ink-3">{[i.rec.note, ...i.rec.notes].filter(Boolean).join(" / ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {h.rows.length > 0 && (
        <Card>
          <CardHeader title={`アンケートの過去の集計 ${h.rows.length} 行`} description={`新規 ${h.create} · 更新 ${h.update} · 変更なし ${h.unchanged}。期間の合計を 店舗 × 設問 × 回答 で残し、KPI → アンケート の「年度ごとの比較」に出します (工場 = 合志店)`} />
          <div className="flex flex-wrap gap-1.5 text-xs">
            {h.blocks.map((b, i) => <Badge key={i} tone="neutral" dot={false}>{b.fiscalLabel} {b.storeId ? (stores.get(b.storeId)?.shortName ?? b.storeId) : "全社"} · 設問 {b.questions}</Badge>)}
          </div>
        </Card>
      )}

      {plan.kpi.length > 0 && <ReconView plan={plan} />}
    </div>
  );
}

function ReconView({ plan }: { plan: WorkbookPlan }) {
  return (
    <Card padded={false}>
      <div className="px-5 pt-5">
        <CardHeader title="KPI のシートとシステムの集計の照合 (取り込んだ後の値)" description="KPI のタブの手計算と、同じ期間のシステムの値を並べます。月ごとの件数が合っていれば、取り込んだ記録で KPI とインセンティブを計算できます" />
        <ul className="mb-3 space-y-1 text-xs text-ink-3">
          <li>・シートの空欄 (まだ転記していない月) にシステムの値があるのは、シートの転記待ちです</li>
          <li>・累計 (返信率・①〜④・ポイント率) は年間インセンティブと同じ計算で比べます。分母 (個人件数・全案件数) とはがきの集計月は KPI →「<Link href="/kpi/basis" className="text-accent hover:underline">分母・照合</Link>」で登録・取込します (年度の途中のシートは、月ごとの値のある月までで比べます)</li>
          <li>・取り込んだ後は「<Link href="/kpi/basis/check" className="text-accent hover:underline">支給前の照合</Link>」で、店舗・社員ごとに計算の内訳と並べて確かめられます</li>
        </ul>
      </div>
      {plan.kpi.map((y) => {
        const diff = y.rows.filter((r) => !r.ok);
        return (
          <div key={y.label} className="border-t border-line px-5 py-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium text-ink">{y.label}</span>
              <span className="text-xs text-ink-3">({y.period.from} 〜 {y.period.to})</span>
              <Badge tone="good" dot={false}>一致 {y.matched}</Badge>
              <Badge tone={diff.length ? "warn" : "neutral"} dot={false}>差あり {diff.length}</Badge>
            </div>
            {diff.length > 0 && (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-accent">差のある項目を見る</summary>
                <div className="mt-2 max-h-72 overflow-auto">
                  <table className="w-full min-w-[560px] text-xs">
                    <thead><tr className="bg-subtle text-ink-2"><th className="px-2 py-1 text-left font-medium">項目</th><th className="px-2 py-1 text-left font-medium">対象</th><th className="px-2 py-1 text-left font-medium">月</th><th className="px-2 py-1 text-right font-medium">シート</th><th className="px-2 py-1 text-right font-medium">システム</th></tr></thead>
                    <tbody>
                      {diff.map((r, i) => <tr key={i} className="border-t border-line"><td className="px-2 py-1">{r.label}</td><td className="px-2 py-1">{r.target}</td><td className="px-2 py-1 tnum">{r.month ?? "累計"}</td><td className="px-2 py-1 text-right tnum">{r.sheet ?? "(空欄)"}</td><td className="px-2 py-1 text-right tnum">{r.system ?? "-"}</td></tr>)}
                    </tbody>
                  </table>
                </div>
              </details>
            )}
          </div>
        );
      })}
    </Card>
  );
}
