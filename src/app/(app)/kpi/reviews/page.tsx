import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canAccessStore, canManageKpi, canViewStaffKpi, scopeByStore } from "@/lib/auth/permissions";
import { createReview, deleteReview } from "@/lib/actions/kpi";
import { inPeriod, reviewMonths } from "@/lib/kpi";
import { isPayable, kpiSettings } from "@/lib/kpi-settings";
import { resolvePeriod } from "@/lib/kpi-period";
import { staffOptions } from "@/lib/kpi-options";
import { fmtDate, toDateKey, yen } from "@/lib/format";
import { userName } from "@/lib/db/queries";
import { KpiTabs } from "@/components/kpi/KpiTabs";
import { PeriodSelect } from "@/components/kpi/PeriodSelect";
import { Button, Card, CardHeader, Field, Flash, Input, PageHeader, Pager, Select, StoreTag, Textarea, paginate } from "@/components/ui";

export default async function ReviewsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const settings = kpiSettings(db);
  const today = toDateKey(new Date());
  const rp = resolvePeriod(sp, settings.fiscalStartMonth, today);
  const users = new Map(db.users.map((u) => [u.id, u]));
  const visible = scopeByStore(user, db.reviews).filter((r) => inPeriod(r.postedOn, rp.period));
  // 支給対象外 (経営者の家族など) は記録だけ残し、支給額に入れない
  const payableReviews = visible.filter((r) => {
    const u = users.get(r.userId);
    return u && isPayable(u, settings);
  });
  const months = reviewMonths(payableReviews, settings.reviewYenPerPoint, null).filter((m) => {
    const u = users.get(m.userId);
    return u && canViewStaffKpi(user, u);
  });
  const list = [...visible].sort((a, b) => b.postedOn.localeCompare(a.postedOn));
  const paged = paginate(list, sp.page, 50);
  const manage = canManageKpi(user);

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader title="KPI · Google 口コミ" description="口コミの返信で名前を出した担当者にポイント (星の評価・コメント・写真で 1 点ずつ)。事務の入力月で集計し、翌月末に現金で支給します" />
      <KpiTabs current="/kpi/reviews" sp={sp} user={user} />
      <PeriodSelect action="/kpi/reviews" value={rp.value} startMonth={settings.fiscalStartMonth} today={today} />

      <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-3">
        <Card>
          <CardHeader title="口コミを登録" description={`1 ポイント = ${yen(settings.reviewYenPerPoint)}`} />
          <form action={createReview} className="space-y-3">
            <input type="hidden" name="returnTo" value="/kpi/reviews" />
            <div className="grid grid-cols-2 gap-2">
              <Field label="入力日 (集計月)" required><Input type="date" name="postedOn" defaultValue={today} required /></Field>
              <Field label="星の数"><Select name="rating" defaultValue="5"><option value="">-</option>{[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{"★".repeat(n)}</option>)}</Select></Field>
            </div>
            <Field label="担当者 (返信で名前を出した社員)" required>
              <Select name="userId" required defaultValue="">
                <option value="">選択してください</option>
                {staffOptions(db, user.storeId).map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
              </Select>
            </Field>
            <Field label="店舗 (空欄なら担当者の店舗)">
              <Select name="storeId" defaultValue="">
                <option value="">担当者の店舗</option>
                {db.stores.filter((s) => canAccessStore(user, s.id)).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </Field>
            <Field label="投稿者のニックネーム"><Input name="reviewerName" /></Field>
            <Field label="コメント (あれば貼り付け)"><Textarea name="comment" rows={2} /></Field>
            <div className="flex flex-wrap gap-4 text-xs text-ink-2">
              <label className="flex items-center gap-2"><input type="checkbox" name="hasComment" className="h-4 w-4" /> コメントあり</label>
              <label className="flex items-center gap-2"><input type="checkbox" name="hasPhoto" className="h-4 w-4" /> 写真あり</label>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Field label="受注番号 (分かれば)"><Input name="orderRef" placeholder="O-2026-0123" /></Field>
              <Field label="ポイント (自動計算を上書き)"><Input type="number" name="points" min={0} max={10} placeholder="自動" /></Field>
            </div>
            <Field label="メモ"><Input name="note" /></Field>
            <Button type="submit">登録する</Button>
          </form>
        </Card>

        <Card className="@4xl:col-span-2" padded={false}>
          <div className="px-5 pt-5"><CardHeader title={`月ごとのポイント・支給額 (${rp.label})`} description="支給日は集計月の翌月末 (現金)。支給対象外に設定した社員は含めません" /></div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead><tr className="bg-subtle text-xs text-ink-2"><th className="px-4 py-2 text-left font-medium">集計月</th><th className="px-2 py-2 text-left font-medium">担当者</th><th className="px-2 py-2 text-right font-medium">件数</th><th className="px-2 py-2 text-right font-medium">ポイント</th><th className="px-2 py-2 text-right font-medium">支給額</th><th className="px-4 py-2 text-left font-medium">支給日</th></tr></thead>
              <tbody>
                {months.length === 0 && <tr><td colSpan={6} className="px-4 py-8 text-center text-ink-3">この期間の口コミはありません</td></tr>}
                {months.map((m) => (
                  <tr key={`${m.month}_${m.userId}`} className="border-t border-line">
                    <td className="px-4 py-2 tnum">{m.month.replace("-", "年")}月</td>
                    <td className="px-2 py-2">{userName(m.userId)} <StoreTag store={db.stores.find((s) => s.id === users.get(m.userId)?.storeId)} short /></td>
                    <td className="px-2 py-2 text-right tnum">{m.count}</td>
                    <td className="px-2 py-2 text-right tnum">{m.points}</td>
                    <td className="px-2 py-2 text-right font-semibold tnum">{yen(m.yen)}</td>
                    <td className="px-4 py-2 text-xs tnum">{fmtDate(m.payOn)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="px-5 py-3 text-[11px] text-ink-3">口コミの件数の順位 (年間) はインセンティブの「口コミ MVP」になります。</p>
        </Card>
      </div>

      <Card className="mt-4" padded={false}>
        <div className="px-5 pt-5"><CardHeader title="登録した口コミ" description={`${list.length} 件`} /></div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead><tr className="bg-subtle text-xs text-ink-2"><th className="px-4 py-2 text-left font-medium">入力日</th><th className="px-2 py-2 text-left font-medium">担当者</th><th className="px-2 py-2 text-left font-medium">店舗</th><th className="px-2 py-2 text-left font-medium">星</th><th className="px-2 py-2 text-left font-medium">投稿者・コメント</th><th className="px-2 py-2 text-right font-medium">ポイント</th><th className="px-4 py-2" /></tr></thead>
            <tbody>
              {paged.items.length === 0 && <tr><td colSpan={7} className="px-4 py-8 text-center text-ink-3">登録はありません</td></tr>}
              {paged.items.map((r) => (
                <tr key={r.id} className="border-t border-line align-top">
                  <td className="px-4 py-2 text-xs tnum">{fmtDate(r.postedOn)}</td>
                  <td className="px-2 py-2">{userName(r.userId)}{users.get(r.userId) && !isPayable(users.get(r.userId)!, settings) && <span className="ml-1 text-[10px] text-ink-3">(支給対象外)</span>}</td>
                  <td className="px-2 py-2"><StoreTag store={db.stores.find((s) => s.id === r.storeId)} short /></td>
                  <td className="px-2 py-2 text-xs text-warn-ink">{r.rating ? "★".repeat(r.rating) : "-"}</td>
                  <td className="max-w-[20rem] px-2 py-2 text-xs text-ink-2">{r.reviewerName ?? ""}{r.comment ? ` 「${r.comment}」` : ""}{r.hasPhoto ? " (写真あり)" : ""}{r.note && <span className="block text-[11px] text-ink-3">{r.note}{r.sourceRef ? " · スプレッドシートから取込" : ""}</span>}</td>
                  <td className="px-2 py-2 text-right tnum">{r.points}</td>
                  <td className="px-4 py-2 text-right">
                    {(manage || r.createdBy === user.id) && (
                      <form action={deleteReview.bind(null, r.id)}>
                        <input type="hidden" name="returnTo" value="/kpi/reviews" />
                        <button type="submit" className="text-xs text-critical hover:underline">削除</button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="px-5 pb-4"><Pager paged={paged} path="/kpi/reviews" sp={sp} /></div>
      </Card>
    </div>
  );
}
