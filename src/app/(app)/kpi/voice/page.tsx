import Link from "@/components/ui/Link";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canManageKpi, canReadStoreRecords } from "@/lib/auth/permissions";
import { policyReader } from "@/lib/access-policy";

import { analyzeCustomerVoices, retagSurveyComments } from "@/lib/actions/kpi";
import { inPeriod, surveyDate } from "@/lib/kpi";
import { kpiSettings } from "@/lib/kpi-settings";
import { resolvePeriod } from "@/lib/kpi-period";
import { aiStatus } from "@/lib/ai/provider";
import type { VoiceAnalysis } from "@/lib/ai/voice";
import { fmtDate, fmtDateTime, toDateKey } from "@/lib/format";
import { COMMENT_TAGS, COMMENT_TONE_LABEL, tagComment } from "@/lib/survey";
import { KpiTabs } from "@/components/kpi/KpiTabs";
import { PeriodSelect } from "@/components/kpi/PeriodSelect";
import { Badge, Button, Card, CardHeader, Flash, Note, PageHeader, Pager, Select, StoreTag, paginate } from "@/components/ui";

/** AI の分析 (最大 50 秒) を待つため */
export const maxDuration = 60;

export default async function VoicePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const settings = kpiSettings(db);
  const today = toDateKey(new Date());
  const rp = resolvePeriod(sp, settings.fiscalStartMonth, today);
  // お客様の声 (アンケートのコメント) は顧客情報の閲覧の範囲 (src/lib/access-policy.ts)
  const reader = policyReader(db, user);
  const store = sp.store && db.stores.some((s) => s.id === sp.store && canReadStoreRecords(reader, s.id)) ? sp.store : "";
  const all = db.surveys.filter((s) => canReadStoreRecords(reader, s.storeId)).filter((s) => s.comment && inPeriod(surveyDate(s), rp.period) && (!store || s.storeId === store));
  const tagged = all.map((s) => {
    const auto = tagComment(s.comment);
    return { s, tags: s.commentTags?.length ? s.commentTags : auto.tags, tone: s.commentTone ?? auto.tone };
  });
  const tagCounts = COMMENT_TAGS.map((t) => [t, tagged.filter((x) => x.tags.includes(t)).length] as const).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const toneCounts = (Object.keys(COMMENT_TONE_LABEL) as (keyof typeof COMMENT_TONE_LABEL)[]).map((t) => [t, tagged.filter((x) => x.tone === t).length] as const);
  let list = tagged;
  if (sp.tag) list = list.filter((x) => x.tags.includes(sp.tag!));
  if (sp.tone) list = list.filter((x) => x.tone === sp.tone);
  list.sort((a, b) => surveyDate(b.s).localeCompare(surveyDate(a.s)));
  const paged = paginate(list, sp.page, 50);
  const saved = db.settings.find((x) => x.id === `voice_${store || "all"}`)?.value as (VoiceAnalysis & { count?: number; provider?: string; model?: string }) | undefined;
  const ai = aiStatus();
  const manage = canManageKpi(user);
  const max = Math.max(1, ...tagCounts.map(([, n]) => n));

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader title="KPI · お客様の声 (⑧ 自由記述)" description="はがきのご指摘・お褒めの言葉を分類・分析し、強みとさらに磨く点を把握します" />
      <KpiTabs current="/kpi/voice" sp={sp} user={user} />
      <PeriodSelect
        action="/kpi/voice"
        value={rp.value}
        startMonth={settings.fiscalStartMonth}
        today={today}
        extra={
          <>
            <label className="block"><span className="label">店舗</span><Select name="store" defaultValue={store} className="h-9 py-1 text-sm"><option value="">すべて</option>{db.stores.filter((s) => canReadStoreRecords(reader, s.id)).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></label>
            <label className="block"><span className="label">分類</span><Select name="tag" defaultValue={sp.tag ?? ""} className="h-9 py-1 text-sm"><option value="">すべて</option>{COMMENT_TAGS.map((t) => <option key={t} value={t}>{t}</option>)}</Select></label>
            <label className="block"><span className="label">種類</span><Select name="tone" defaultValue={sp.tone ?? ""} className="h-9 py-1 text-sm"><option value="">すべて</option>{Object.entries(COMMENT_TONE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></label>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-3">
        <Card>
          <CardHeader title="分類別の件数" description={`自由記述 ${all.length} 件`} />
          {tagCounts.length === 0 && <p className="text-sm text-ink-3">自由記述はありません</p>}
          <ul className="space-y-1">
            {tagCounts.map(([t, n]) => (
              <li key={t} className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_2.5rem] items-center gap-2 text-xs">
                <Link href={`/kpi/voice?${new URLSearchParams({ ...(sp.p ? { p: sp.p } : {}), ...(store ? { store } : {}), tag: t })}`} className="truncate text-ink-2 hover:text-accent">{t}</Link>
                <span className="h-2.5 rounded-full bg-subtle"><span className="block h-2.5 rounded-full bg-accent" style={{ width: `${(n / max) * 100}%` }} /></span>
                <span className="text-right tnum">{n}</span>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {toneCounts.map(([t, n]) => <Badge key={t} tone={t === "complaint" ? "critical" : t === "request" ? "warn" : t === "praise" ? "good" : "neutral"}>{COMMENT_TONE_LABEL[t]} {n}</Badge>)}
          </div>
        </Card>

        <Card className="@4xl:col-span-2">
          <CardHeader
            title="分析 (強み・さらに磨く点)"
            description={saved ? `${fmtDateTime(saved.analyzedAt)} · ${saved.count ?? "-"} 件 · ${saved.provider === "rules" ? "簡易分類" : `AI (${saved.model ?? saved.provider})`}` : "まだ分析していません"}
          />
          {manage && (
            <div className="mb-3 flex flex-wrap gap-2">
              <form action={analyzeCustomerVoices}>
                <input type="hidden" name="returnTo" value={`/kpi/voice${store ? `?store=${store}` : ""}`} />
                <input type="hidden" name="store" value={store} />
                <input type="hidden" name="from" value={rp.period?.from ?? ""} />
                <Button type="submit" size="sm">{ai.enabled ? "AI で分析する" : "集計で分析する (AI 未設定)"}</Button>
              </form>
              <form action={retagSurveyComments}><Button type="submit" size="sm" variant="secondary">分類を付け直す</Button></form>
            </div>
          )}
          {saved ? (
            <div className="space-y-4 text-sm">
              <p className="text-ink">{saved.summary}</p>
              <div className="grid grid-cols-1 gap-4 @xl:grid-cols-2">
                <div>
                  <div className="mb-1 text-xs font-semibold text-good-ink">強み</div>
                  <ul className="space-y-2">{saved.strengths.map((t, i) => <li key={i} className="rounded-lg bg-good-soft/50 px-3 py-2 text-xs"><span className="font-medium">{t.theme}</span> ({t.count} 件)<br />{t.detail}{t.quotes.map((q, j) => <span key={j} className="mt-1 block text-ink-2">「{q}」</span>)}</li>)}</ul>
                </div>
                <div>
                  <div className="mb-1 text-xs font-semibold text-warn-ink">さらに磨く点</div>
                  {saved.improvements.length === 0 && <p className="text-xs text-ink-3">目立ったご指摘はありません</p>}
                  <ul className="space-y-2">{saved.improvements.map((t, i) => <li key={i} className="rounded-lg bg-warn-soft/50 px-3 py-2 text-xs"><span className="font-medium">{t.theme}</span> ({t.count} 件)<br />{t.detail}{t.quotes.map((q, j) => <span key={j} className="mt-1 block text-ink-2">「{q}」</span>)}</li>)}</ul>
                </div>
              </div>
              {saved.suggestions.length > 0 && (
                <div>
                  <div className="mb-1 text-xs font-semibold text-ink">サービス向上・社員教育への提案</div>
                  <ul className="list-disc space-y-0.5 pl-5 text-xs text-ink-2">{saved.suggestions.map((x, i) => <li key={i}>{x}</li>)}</ul>
                </div>
              )}
            </div>
          ) : (
            <Note>{manage ? "「AI で分析する」を押すと、自由記述から強み・磨く点・提案をまとめます。" : "店長・本部・管理者が分析を実行すると、ここに結果が表示されます。"}</Note>
          )}
        </Card>
      </div>

      <Card className="mt-4" padded={false}>
        <div className="px-5 pt-5"><CardHeader title="自由記述の一覧" description={`${list.length} 件${sp.tag ? ` · 分類「${sp.tag}」` : ""}`} /></div>
        <ul className="divide-y divide-line">
          {paged.items.length === 0 && <li className="px-5 py-8 text-center text-sm text-ink-3">該当する記述はありません</li>}
          {paged.items.map(({ s, tags, tone }) => (
            <li key={s.id} className="px-5 py-3 text-sm">
              <div className="mb-1 flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
                <Link href={`/kpi/surveys/${s.id}`} className="text-accent hover:underline">{fmtDate(surveyDate(s))} · No.{s.postcardNo ?? "-"}</Link>
                <StoreTag store={db.stores.find((x) => x.id === s.storeId)} short />
                <Badge tone={tone === "complaint" ? "critical" : tone === "request" ? "warn" : tone === "praise" ? "good" : "neutral"}>{COMMENT_TONE_LABEL[tone]}</Badge>
                {tags.map((t) => <Badge key={t} tone="neutral" dot={false}>{t}</Badge>)}
                <span className="tnum">評価 {[s.phoneScore, s.salesScore, s.craftsmanScore, s.finishScore].map((x) => x ?? "-").join("・")}</span>
              </div>
              「{s.comment}」
            </li>
          ))}
        </ul>
        <div className="px-5 pb-4"><Pager paged={paged} path="/kpi/voice" sp={sp} /></div>
      </Card>
    </div>
  );
}
