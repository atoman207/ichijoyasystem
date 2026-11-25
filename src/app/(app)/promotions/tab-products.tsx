import { Download } from "lucide-react";
import type { Database, StoreId, User } from "@/lib/db/types";
import { canSeeAllStoreFigures } from "@/lib/auth/permissions";
import { salesFacts } from "@/lib/assistant/facts";
import { yen } from "@/lib/format";
import { scopeStores } from "@/lib/ops-reports/promo-analysis";
import { GBP_LABEL, OMOTE_GROUPS, PRODUCT_CATS, PRODUCT_LABEL, formatRules, omoteCounts, productKpis, promoFyMonths, promoFyOf, promoKpiSettings, readGbp, type GbpMetric, type ProductMonth } from "@/lib/ops-reports/promo-products";
import { importGbpSheet, resetPromoKpiSettings, savePromoKpiSettings, saveGbpMonth } from "@/lib/actions/promo-kpi";
import { Button, Card, CardHeader, Field, Input, Note, Textarea } from "@/components/ui";

const n = (v: number) => v.toLocaleString("ja-JP");
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");
const monthLabel = (m: string) => (m === "total" ? "累計" : `${Number(m.slice(5))}月`);

function Csv({ href }: { href: string }) {
  return (
    <a href={href} download className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[11px] font-medium text-ink-2 hover:bg-subtle hover:text-ink">
      <Download className="h-3 w-3" aria-hidden /> CSV
    </a>
  );
}

/**
 * 販促と媒体の分析 → 商品の KPI (スプレッドシート「販促」の販促計画の KPI の表・畳表出数表・グーグルアクセスをシステムで集計)。
 * 集計は src/lib/ops-reports/promo-products.ts。経営分析用 (インセンティブに入れない)
 */
/** user = 閲覧の範囲の写し (見る範囲)、canEdit = 本物の利用者の権限 (設定・取込。本部スタッフ・管理者) */
export function ProductsTab({ db, user, sp, today, canEdit }: { db: Database; user: User; sp: Record<string, string | undefined>; today: string; canEdit: boolean }) {
  const s = promoKpiSettings(db);
  const storeIds = scopeStores(db, user, sp.store).filter((id) => db.stores.find((x) => x.id === id)?.kind === "store");
  const canAll = canSeeAllStoreFigures(user);
  const curFy = promoFyOf(today, s.fyStartMonth);
  const fy = Number(sp.pfy) >= 2015 && Number(sp.pfy) <= curFy + 1 ? Number(sp.pfy) : curFy;
  const months = promoFyMonths(fy, s.fyStartMonth);
  const facts = salesFacts(db).facts;
  const customers = new Map(db.customers.map((c) => [c.id, c]));
  const kpis = productKpis(facts, customers, storeIds, months, s);
  const view = (sp.store && kpis.find((k) => k.storeId === sp.store)) || kpis.find((k) => k.storeId === "all") || kpis[0];
  const storeName = (id: StoreId | "all") => (id === "all" ? "全店" : (db.stores.find((x) => x.id === id)?.shortName ?? id));
  const shown = view?.months.filter((m) => m.month <= today.slice(0, 7)) ?? [];
  const fusumaCols = [...s.fusuma.map((r) => r.label), "その他"];
  // 畳表の出数 (11 月〜翌 10 月。シートの「2025年」= 2024-11〜2025-10)
  const oy = Number(sp.oy) >= 2015 && Number(sp.oy) <= Number(today.slice(0, 4)) + 1 ? Number(sp.oy) : Number(today.slice(5, 7)) >= 11 ? Number(today.slice(0, 4)) + 1 : Number(today.slice(0, 4));
  const omoteNow = omoteCounts(facts, `${oy - 1}-11-01`, `${oy}-10-31`, s, storeIds);
  const omotePrev = omoteCounts(facts, `${oy - 2}-11-01`, `${oy - 1}-10-31`, s, storeIds);
  const sumNow = omoteNow.reduce((a, x) => a + x.qty, 0);
  const sumPrev = omotePrev.reduce((a, x) => a + x.qty, 0);
  const domestic = (list: { label: string; qty: number }[]) => list.filter((x) => s.domestic.includes(x.label)).reduce((a, x) => a + x.qty, 0);
  // Google ビジネスプロフィール (暦年)
  const gy = Number(sp.gy) >= 2015 && Number(sp.gy) <= Number(today.slice(0, 4)) ? Number(sp.gy) : Number(today.slice(0, 4));
  const gbp = readGbp(db);
  const gbpStores = db.stores.filter((x) => canAll || storeIds.includes(x.id));
  const qs = (extra: Record<string, string | number>) => {
    const p = new URLSearchParams({ tab: "products" });
    if (sp.store) p.set("store", sp.store);
    p.set("pfy", String(fy));
    for (const [k, v] of Object.entries(extra)) p.set(k, String(v));
    return `/promotions?${p.toString()}`;
  };
  const csv = (section: string) => `/api/promotions/products?section=${section}&pfy=${fy}&oy=${oy}&gy=${gy}${sp.store ? `&store=${sp.store}` : ""}`;
  const back = qs({});

  return (
    <div className="space-y-4">
      <form action="/promotions" className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="tab" value="products" />
        <label className="block">
          <span className="label">年度 ({s.fyStartMonth} 月〜)</span>
          <select name="pfy" defaultValue={fy} className="field h-9 py-1 text-sm">
            {Array.from({ length: 5 }, (_, i) => curFy - i).map((y) => <option key={y} value={y}>{y}年度</option>)}
          </select>
        </label>
        {canAll && (
          <label className="block">
            <span className="label">店舗</span>
            <select name="store" defaultValue={sp.store ?? ""} className="field h-9 py-1 text-sm">
              <option value="">全店</option>
              {db.stores.filter((x) => x.kind === "store").map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          </label>
        )}
        <Button type="submit" size="sm" variant="secondary">表示</Button>
      </form>

      <Note>
        個人のお客様の受注を売上計上日 (施工完了) の月で数えます (販促計画の KPI の表と同じ {s.fyStartMonth} 月始まりの年度)。売上 = その品目の明細の合計 (税込。縁・防虫加工・引手などを含む)、枚数 = 本体の明細の数量 (付属を除く)、平均単価 (税抜) = 売上 ÷ 枚数 ÷ 1.1。
        移行した受注は売上台帳の明細、新システムは見積・請求書の明細を使います。種類 (畳表・襖紙) は品名・仕様の言葉で見分けます (下の設定で変えられます)。経営分析用で、インセンティブには入れません。
      </Note>

      {view && (
        <Card padded={false}>
          <div className="flex items-center justify-between gap-2 px-5 pt-5">
            <CardHeader title={`畳・襖・障子・網戸 (${storeName(view.storeId)} · ${fy}年度)`} description="平均単価 (税抜) / 売上 (税込) / 枚数" />
            <Csv href={csv("products")} />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px] text-xs">
              <thead>
                <tr className="bg-subtle text-ink-2"><th className="px-3 py-2 text-left font-medium" rowSpan={2}>月</th>{PRODUCT_CATS.map((c) => <th key={c} colSpan={3} className="border-l border-line px-2 py-1 text-center font-medium">{PRODUCT_LABEL[c]}</th>)}</tr>
                <tr className="bg-subtle text-ink-3">{PRODUCT_CATS.flatMap((c) => [<th key={`${c}u`} className="border-l border-line px-2 py-1 text-right font-normal">単価</th>, <th key={`${c}s`} className="px-2 py-1 text-right font-normal">売上</th>, <th key={`${c}q`} className="px-2 py-1 text-right font-normal">枚数</th>])}</tr>
              </thead>
              <tbody>
                {[...shown, view.total].map((m) => (
                  <tr key={m.month} className={`border-t border-line ${m.month === "total" ? "bg-subtle/60 font-semibold" : ""}`}>
                    <td className="px-3 py-1.5">{monthLabel(m.month)}</td>
                    {PRODUCT_CATS.flatMap((c) => [
                      <td key={`${c}u`} className="border-l border-line px-2 py-1.5 text-right tnum">{m.cats[c].unitPrice === null ? "-" : n(m.cats[c].unitPrice!)}</td>,
                      <td key={`${c}s`} className="px-2 py-1.5 text-right tnum">{m.cats[c].sales ? n(m.cats[c].sales) : ""}</td>,
                      <td key={`${c}q`} className="px-2 py-1.5 text-right tnum">{m.cats[c].qty ? n(Math.round(m.cats[c].qty * 10) / 10) : ""}</td>,
                    ])}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {kpis.length > 1 && (
            <div className="overflow-x-auto border-t border-line">
              <table className="w-full min-w-[720px] text-xs">
                <thead><tr className="bg-subtle text-ink-2"><th className="px-3 py-2 text-left font-medium">店舗 (累計)</th>{PRODUCT_CATS.map((c) => <th key={c} className="px-2 py-2 text-right font-medium">{PRODUCT_LABEL[c]} 単価 / 枚数</th>)}<th className="px-3 py-2 text-right font-medium">受注</th></tr></thead>
                <tbody>
                  {kpis.map((k) => (
                    <tr key={k.storeId} className={`border-t border-line ${k.storeId === "all" ? "font-semibold" : ""}`}>
                      <td className="px-3 py-1.5">{storeName(k.storeId)}</td>
                      {PRODUCT_CATS.map((c) => <td key={c} className="px-2 py-1.5 text-right tnum">{k.total.cats[c].unitPrice === null ? "-" : yen(k.total.cats[c].unitPrice!)} / {n(Math.round(k.total.cats[c].qty))}</td>)}
                      <td className="px-3 py-1.5 text-right tnum">{n(k.total.orders)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {view && (
        <div className="grid grid-cols-1 gap-4 @5xl:grid-cols-2">
          <MixCard title={`畳表の内訳 (件数ベース · ${storeName(view.storeId)})`} cols={[...OMOTE_GROUPS]} rows={shown} total={view.total} pick={(m) => m.omote} csv={csv("omote_mix")} />
          <MixCard title={`襖紙の内訳 (件数ベース · ${storeName(view.storeId)})`} cols={fusumaCols} rows={shown} total={view.total} pick={(m) => m.fusuma} csv={csv("fusuma_mix")} />
        </div>
      )}

      {view && (
        <Card padded={false}>
          <div className="flex items-center justify-between gap-2 px-5 pt-5">
            <CardHeader title={`マイトスタット (防虫加工)・${yen(s.reformMin)} 以上のリフォーム (${storeName(view.storeId)})`} description="マイトスタット = 防虫加工の明細のある受注の件数と枚数。リフォーム = クロス・雑工事 (諸経費を除く) の金額が下限以上の受注の件数と、その金額 (税込)" />
            <Csv href={csv("extras")} />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-xs">
              <thead><tr className="bg-subtle text-ink-2"><th className="px-3 py-2 text-left font-medium">月</th><th className="px-2 py-2 text-right font-medium">マイト 件数</th><th className="px-2 py-2 text-right font-medium">マイト 枚数</th><th className="px-2 py-2 text-right font-medium">リフォーム 件数</th><th className="px-3 py-2 text-right font-medium">リフォーム 売上</th></tr></thead>
              <tbody>
                {[...shown, view.total].map((m) => (
                  <tr key={m.month} className={`border-t border-line ${m.month === "total" ? "bg-subtle/60 font-semibold" : ""}`}>
                    <td className="px-3 py-1.5">{monthLabel(m.month)}</td>
                    <td className="px-2 py-1.5 text-right tnum">{m.mite.orders || ""}</td>
                    <td className="px-2 py-1.5 text-right tnum">{m.mite.qty ? n(m.mite.qty) : ""}</td>
                    <td className="px-2 py-1.5 text-right tnum">{m.reform.orders || ""}</td>
                    <td className="px-3 py-1.5 text-right tnum">{m.reform.sales ? n(m.reform.sales) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card padded={false}>
        <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-5">
          <CardHeader title={`畳表の出数 (${oy - 1}年11月〜${oy}年10月)`} description={`畳表の種類ごとの枚数 (全てのお客様${storeIds.length === 1 ? ` · ${storeName(storeIds[0])}` : ""})。スプレッドシート「畳表出数表」と同じ並び`} />
          <div className="flex items-center gap-2">
            <a href={qs({ oy: oy - 1 })} className="text-xs text-accent hover:underline">← {oy - 1}年</a>
            {oy < Number(today.slice(0, 4)) + 1 && <a href={qs({ oy: oy + 1 })} className="text-xs text-accent hover:underline">{oy + 1}年 →</a>}
            <Csv href={csv("omote_counts")} />
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[480px] text-xs">
            <thead><tr className="bg-subtle text-ink-2"><th className="px-3 py-2 text-left font-medium">種類</th><th className="px-2 py-2 text-right font-medium">{oy - 1}年 (前年)</th><th className="px-2 py-2 text-right font-medium">比率</th><th className="px-2 py-2 text-right font-medium">{oy}年</th><th className="px-3 py-2 text-right font-medium">比率</th></tr></thead>
            <tbody>
              {omoteNow.map((x) => {
                const prev = omotePrev.find((p) => p.label === x.label)?.qty ?? 0;
                return (
                  <tr key={x.label} className="border-t border-line">
                    <td className="px-3 py-1.5">{x.label}</td>
                    <td className="px-2 py-1.5 text-right tnum">{n(prev)}</td>
                    <td className="px-2 py-1.5 text-right tnum text-ink-2">{pct(prev, sumPrev)}</td>
                    <td className="px-2 py-1.5 text-right tnum">{n(x.qty)}</td>
                    <td className="px-3 py-1.5 text-right tnum text-ink-2">{pct(x.qty, sumNow)}</td>
                  </tr>
                );
              })}
              <tr className="border-t border-line font-semibold"><td className="px-3 py-1.5">合計</td><td className="px-2 py-1.5 text-right tnum">{n(sumPrev)}</td><td /><td className="px-2 py-1.5 text-right tnum">{n(sumNow)}</td><td /></tr>
              <tr className="border-t border-line text-ink-2"><td className="px-3 py-1.5">国産 ({s.domestic.join("・")})</td><td className="px-2 py-1.5 text-right tnum">{n(domestic(omotePrev))}</td><td className="px-2 py-1.5 text-right tnum">{pct(domestic(omotePrev), sumPrev)}</td><td className="px-2 py-1.5 text-right tnum">{n(domestic(omoteNow))}</td><td className="px-3 py-1.5 text-right tnum">{pct(domestic(omoteNow), sumNow)}</td></tr>
            </tbody>
          </table>
        </div>
      </Card>

      <Card padded={false}>
        <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-5">
          <CardHeader title={`Google ビジネスプロフィール (${gy}年)`} description="店舗ごとの月の 通話・ウェブサイトへのアクセス・プロフィール閲覧 (Google のビジネスプロフィールの数を転記)" />
          <div className="flex items-center gap-2">
            <a href={qs({ gy: gy - 1 })} className="text-xs text-accent hover:underline">← {gy - 1}年</a>
            {gy < Number(today.slice(0, 4)) && <a href={qs({ gy: gy + 1 })} className="text-xs text-accent hover:underline">{gy + 1}年 →</a>}
            <Csv href={csv("gbp")} />
          </div>
        </div>
        {(["calls", "web", "views"] as GbpMetric[]).map((metric) => (
          <div key={metric} className="overflow-x-auto border-t border-line first:border-t-0">
            <table className="w-full min-w-[760px] text-xs">
              <thead><tr className="bg-subtle text-ink-2"><th className="px-3 py-1.5 text-left font-medium">{GBP_LABEL[metric]}</th>{Array.from({ length: 12 }, (_, i) => <th key={i} className="px-1.5 py-1.5 text-right font-medium">{i + 1}月</th>)}<th className="px-3 py-1.5 text-right font-medium">合計</th></tr></thead>
              <tbody>
                {gbpStores.map((st) => {
                  const vals = Array.from({ length: 12 }, (_, i) => gbp[`${st.id}|${gy}-${String(i + 1).padStart(2, "0")}`]?.[metric]);
                  return (
                    <tr key={st.id} className="border-t border-line">
                      <td className="px-3 py-1">{st.shortName}</td>
                      {vals.map((v, i) => <td key={i} className="px-1.5 py-1 text-right tnum">{v ?? ""}</td>)}
                      <td className="px-3 py-1 text-right tnum font-semibold">{vals.some((v) => v !== undefined) ? n(vals.reduce((a: number, v) => a + (v ?? 0), 0)) : ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
        {canEdit && (
          <div className="grid grid-cols-1 gap-4 border-t border-line px-5 py-4 @4xl:grid-cols-2">
            <form action={importGbpSheet} className="space-y-2">
              <input type="hidden" name="returnTo" value={back} />
              <div className="label">スプレッドシートから取り込む</div>
              <input type="file" name="file" accept=".csv,text/csv" required className="block text-sm" />
              <p className="text-[11px] text-ink-3">「販促」の「グーグルアクセス」のタブを開いて ファイル → ダウンロード → CSV。ファイルにある店舗・月の値だけを書き換えます (SR = 本部・ショールーム)。</p>
              <Button type="submit" size="sm" variant="secondary">取り込む</Button>
            </form>
            <form action={saveGbpMonth} className="space-y-2">
              <input type="hidden" name="returnTo" value={back} />
              <Field label="月を入力する"><Input type="month" name="month" required defaultValue={`${today.slice(0, 7)}`} className="h-8 py-1 text-sm" /></Field>
              <div className="overflow-x-auto">
                <table className="text-xs">
                  <thead><tr className="text-ink-3"><th className="pr-2 text-left font-normal">店舗</th>{(["calls", "web", "views"] as GbpMetric[]).map((m) => <th key={m} className="px-1 text-left font-normal">{GBP_LABEL[m]}</th>)}</tr></thead>
                  <tbody>
                    {db.stores.map((st) => (
                      <tr key={st.id}>
                        <td className="pr-2">{st.shortName}</td>
                        {(["calls", "web", "views"] as GbpMetric[]).map((m) => <td key={m} className="px-1 py-0.5"><input name={`${m}_${st.id}`} inputMode="numeric" className="field h-7 w-20 py-0.5 text-right text-xs" aria-label={`${st.shortName} の${GBP_LABEL[m]}`} /></td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[11px] text-ink-3">入れた月の値を書き換えます (空欄の店舗はその月の値を消します)。</p>
              <Button type="submit" size="sm" variant="secondary">保存</Button>
            </form>
          </div>
        )}
      </Card>

      {canEdit && (
        <Card>
          <CardHeader title="商品の KPI の設定" description="種類は上から順に品名・仕様の言葉で見分けます (1 行に 1 種類「名前: 言葉, 言葉 → 件数ベースの列」)。本部スタッフ・管理者" />
          <form action={savePromoKpiSettings} className="space-y-3">
            <input type="hidden" name="returnTo" value={back} />
            <div className="grid grid-cols-1 gap-3 @4xl:grid-cols-2">
              <Field label="畳表の種類 (出数表の列 → 件数ベースの列)"><Textarea name="omote" rows={12} defaultValue={formatRules(s.omote)} className="font-mono text-xs" /></Field>
              <Field label="襖紙の種類 (〇〇系)"><Textarea name="fusuma" rows={12} defaultValue={formatRules(s.fusuma)} className="font-mono text-xs" /></Field>
            </div>
            <Field label="付属 (枚数に数えない明細の言葉。カンマ区切り)"><Textarea name="accessory" rows={2} defaultValue={s.accessory.join(", ")} className="text-xs" /></Field>
            <div className="grid grid-cols-1 gap-3 @3xl:grid-cols-4">
              <Field label="ヘリ無しの言葉"><Input name="heriNashi" defaultValue={s.heriNashi.join(", ")} /></Field>
              <Field label="防虫加工の言葉"><Input name="mite" defaultValue={s.mite.join(", ")} /></Field>
              <Field label="リフォームの下限 (円・税込)"><Input name="reformMin" inputMode="numeric" defaultValue={s.reformMin} /></Field>
              <Field label="年度の開始月"><Input type="number" min={1} max={12} name="fyStartMonth" defaultValue={s.fyStartMonth} /></Field>
            </div>
            <Field label="国産の畳表の種類 (出数表の国産の割合)"><Input name="domestic" defaultValue={s.domestic.join(", ")} /></Field>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm">保存</Button>
            </div>
          </form>
          <form action={resetPromoKpiSettings} className="mt-2">
            <input type="hidden" name="returnTo" value={back} />
            <Button type="submit" size="sm" variant="ghost">既定に戻す</Button>
          </form>
        </Card>
      )}
    </div>
  );
}

function MixCard({ title, cols, rows, total, pick, csv }: { title: string; cols: string[]; rows: ProductMonth[]; total: ProductMonth; pick: (m: ProductMonth) => Record<string, number>; csv: string }) {
  const allCols = [...cols, ...Object.keys(pick(total)).filter((k) => !cols.includes(k))];
  const sum = (m: ProductMonth) => Object.values(pick(m)).reduce((a, b) => a + b, 0);
  const t = sum(total);
  return (
    <Card padded={false}>
      <div className="flex items-center justify-between gap-2 px-5 pt-5">
        <CardHeader title={title} description="受注ごとに一番枚数の多い種類で 1 件" />
        <Csv href={csv} />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-xs">
          <thead><tr className="bg-subtle text-ink-2"><th className="px-3 py-2 text-left font-medium">月</th>{allCols.map((c) => <th key={c} className="px-1.5 py-2 text-right font-medium">{c}</th>)}<th className="px-3 py-2 text-right font-medium">合計</th></tr></thead>
          <tbody>
            {[...rows, total].map((m) => (
              <tr key={m.month} className={`border-t border-line ${m.month === "total" ? "bg-subtle/60 font-semibold" : ""}`}>
                <td className="px-3 py-1.5">{monthLabel(m.month)}</td>
                {allCols.map((c) => <td key={c} className="px-1.5 py-1.5 text-right tnum">{pick(m)[c] || ""}</td>)}
                <td className="px-3 py-1.5 text-right tnum">{sum(m) || ""}</td>
              </tr>
            ))}
            <tr className="border-t border-line text-ink-2">
              <td className="px-3 py-1.5">比率</td>
              {allCols.map((c) => <td key={c} className="px-1.5 py-1.5 text-right tnum">{pct(pick(total)[c] ?? 0, t)}</td>)}
              <td className="px-3 py-1.5 text-right tnum">{t ? "100%" : ""}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </Card>
  );
}

