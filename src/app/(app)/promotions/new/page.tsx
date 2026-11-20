import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canEditPromotion, canSeeAllStores } from "@/lib/auth/permissions";
import { createPromotion } from "@/lib/actions/promotions";
import { opsTablesReady } from "@/lib/ops-reports/tables";
import { PromotionForm } from "@/components/ops-reports/PromotionForm";
import { Card, Flash, Note, PageHeader } from "@/components/ui";

export default async function NewPromotionPage({ searchParams }: { searchParams: Promise<{ err?: string }> }) {
  const { err } = await searchParams;
  const user = await requireUser();
  const allStores = canSeeAllStores(user);
  if (!allStores && !canEditPromotion(user, user.storeId)) redirect("/promotions?err=" + encodeURIComponent("販促を登録できるのは本部スタッフ・管理者・店長です。"));
  const db = getDb();
  const ready = opsTablesReady(["promotions"]);
  return (
    <div className="max-w-4xl">
      <Flash err={err} />
      <PageHeader title="販促を登録" back={{ href: "/promotions?tab=list", label: "販促の記録" }} />
      <Note tone="accent">チラシは配布日と地域ごとの部数を入れると、分析で「1,000 部あたりの問い合わせ」を地域ごとに出せます。年間のチラシ計画は状態を「計画」で登録し、配布したら「実施済み」にします。イベントは登録の後、受付票をまとめて問い合わせとして登録できます。</Note>
      {!ready && <div className="mt-3"><Note tone="warn">販促の記録のテーブルがまだデータベースにありません。管理者がデプロイ (npm run db:migrate) した後に登録できます。</Note></div>}
      <Card className="mt-4">
        <PromotionForm action={createPromotion} stores={db.stores} storeLocked={!allStores} defaultStore={user.storeId} cancelHref="/promotions?tab=list" submitLabel="登録する" disabled={!ready} />
      </Card>
    </div>
  );
}
