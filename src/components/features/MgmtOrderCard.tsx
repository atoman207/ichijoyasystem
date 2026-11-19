import Link from "@/components/ui/Link";
import type { Database, Order } from "@/lib/db/types";
import { salesFacts } from "@/lib/assistant/facts";
import { WORK_KIND_LABEL, activeInternalOrder, attributionOf } from "@/lib/mgmt/attribution";
import { mainCategory, orderCategorySales, categoryName } from "@/lib/mgmt/categories";
import { countedUsages, STAGE_LABEL } from "@/lib/mgmt/costing";
import { yen } from "@/lib/format";
import { Badge, Card, CardHeader, Dl } from "@/components/ui";

/** 受注の画面の「管理会計」(売上の帰属・内部受注・材料原価の状態)。登録は管理会計の画面で行う */
export function MgmtOrderCard({ db, order }: { db: Database; order: Order }) {
  const sales = orderCategorySales(db, order, salesFacts(db).byId.get(order.id), order.salesDate ?? order.contractDate);
  const att = attributionOf(db, order, mainCategory(sales, "other"));
  const io = activeInternalOrder(db, order.id);
  const used = countedUsages(db, order.id);
  const cost = used.reduce((a, u) => a + (u.amount ?? 0), 0);
  const store = (id?: string) => db.stores.find((s) => s.id === id)?.name ?? "-";
  return (
    <Card>
      <CardHeader title="管理会計 (売上の帰属・材料原価)" description="売上は施工店舗に計上します。内部受注・材料原価の登録は管理会計の画面で行います" />
      <Dl
        columns={3}
        items={[
          ["営業エリアの店舗", att.area.storeId ? `${store(att.area.storeId)} (${att.area.key})` : att.area.status === "ambiguous" ? "要確認 (複数の店舗)" : "判定できない"],
          ["受注店舗 / 施工店舗", `${store(att.receivedStoreId)} / ${store(att.workStoreId)}`],
          ["工事の区分", WORK_KIND_LABEL[att.workKind]],
          ["内部受注", io ? `${store(io.fromStoreId)} へ ${yen(io.amount)}${io.provisional ? " (暫定)" : ""}` : "なし"],
          ["品目別の売上 (税込)", Object.entries(sales).map(([k, v]) => `${categoryName(db, k)} ${yen(v)}`).join(" / ")],
          ["材料原価", used.length ? `${yen(cost)} (${STAGE_LABEL[used[0].stage]}${used.some((u) => u.needsReview) ? "・要確認あり" : ""})` : order.tatamiCost ? `${yen(Math.round(order.tatamiCost))} (移行の畳原価)` : "未計算"],
        ]}
      />
      {att.warnings.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{att.warnings.map((w) => <Badge key={w} tone="warn">{w}</Badge>)}</div>}
      <div className="mt-2 flex gap-3 text-xs">
        <Link className="text-accent hover:underline" href={`/management?tab=cost&order=${order.id}#costing`}>材料原価を見る・登録</Link>
        <Link className="text-accent hover:underline" href="/management?tab=sales">売上配分 (内部受注)</Link>
      </div>
    </Card>
  );
}
