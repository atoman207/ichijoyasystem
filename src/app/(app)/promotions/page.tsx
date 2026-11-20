import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canEditPromotion, canManageOpsReportSettings, canSeeAllStores, canViewPromoAnalysis } from "@/lib/auth/permissions";
import { kpiSettings } from "@/lib/kpi-settings";
import { resolvePeriod } from "@/lib/kpi-period";
import { toDateKey } from "@/lib/format";
import { promoReport, scopeStores } from "@/lib/ops-reports/promo-analysis";
import { opsTablesReady } from "@/lib/ops-reports/tables";
import { Flash, LinkButton, LinkTabs, Note, PageHeader } from "@/components/ui";
import { AnalysisTab } from "./tab-analysis";
import { ListTab } from "./tab-list";
import { MappingTab } from "./tab-mapping";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 販促と媒体の分析 (F-13)
 * - 分析: 媒体別・月別・チラシの地域別の反応・町別・アンケートの媒体・年度の比較・販促ごとの反応 (すべて CSV で書き出せる)
 * - 販促の記録: チラシ (配布月・地域・部数)・イベント・点検の DM・テレアポ
 * - 対応表: 見積書・アンケート・販売管理ソフトの媒体の値を全社共通の分類に読み替える
 */
export default async function PromotionsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  if (!canViewPromoAnalysis(user)) redirect("/?err=" + encodeURIComponent("販促と媒体の分析を閲覧する権限がありません (店長・本部スタッフ・管理者)。"));
  const db = getDb();
  const tab = sp.tab === "list" || sp.tab === "mapping" ? sp.tab : "analysis";
  const today = toDateKey(new Date());
  const startMonth = kpiSettings(db).fiscalStartMonth;
  const rp = resolvePeriod(sp, startMonth, today);
  const period = rp.period ?? { from: "2000-01-01", to: today };
  const storeIds = scopeStores(db, user, sp.store);
  // 店舗の絞り込み (全店舗ロールだけ。店長は自店舗に固定)
  const store = canSeeAllStores(user) && sp.store && storeIds.length === 1 ? storeIds[0] : "";
  const ready = opsTablesReady(["promotions"]);
  const canCreate = canSeeAllStores(user) || canEditPromotion(user, user.storeId);
  const base = (t: string) => {
    const p = new URLSearchParams();
    if (t !== "analysis") p.set("tab", t);
    if (sp.p) p.set("p", sp.p);
    if (sp.from && sp.to) {
      p.set("from", sp.from);
      p.set("to", sp.to);
    }
    if (store && canSeeAllStores(user)) p.set("store", store);
    const s = p.toString();
    return s ? `/promotions?${s}` : "/promotions";
  };

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader
        title="販促と媒体の分析"
        description="お客様が当社を知ったきっかけ (媒体) を全社共通の分類で集計し、チラシ・イベント・DM の反応を比べます"
        actions={canCreate ? <LinkButton href="/promotions/new" size="sm">+ 販促を登録</LinkButton> : undefined}
      />
      <LinkTabs
        current={base(tab)}
        items={[
          { href: base("analysis"), label: "分析" },
          { href: base("list"), label: "販促の記録" },
          { href: base("mapping"), label: "媒体の分類と対応表" },
        ]}
      />
      {!ready && <div className="mb-4"><Note tone="warn">販促の記録・作業日報の手入力のテーブルがまだデータベースにありません。分析は問い合わせの媒体だけで表示します。販促の登録は管理者がデプロイ (npm run db:migrate) した後に使えます。</Note></div>}
      {tab === "analysis" && <AnalysisTab db={db} user={user} report={promoReport(db, user, { from: period.from, to: period.to, store: sp.store })} periodValue={rp.value} periodLabel={rp.label} startMonth={startMonth} today={today} store={store} sp={sp} />}
      {tab === "list" && <ListTab db={db} user={user} storeIds={storeIds} from={period.from} to={period.to} periodValue={rp.value} periodLabel={rp.label} startMonth={startMonth} today={today} store={store} sp={sp} />}
      {tab === "mapping" && <MappingTab db={db} canEdit={canManageOpsReportSettings(user)} />}
    </div>
  );
}
