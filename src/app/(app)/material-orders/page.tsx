import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import type { MaterialOrderCategory, MaterialOrderStatus, StoreId } from "@/lib/db/types";
import { canEditMaterialOrder, canSeeAllStores, canViewMaterialOrders } from "@/lib/auth/permissions";
import { addMaterialRow } from "@/lib/actions/material-orders";
import { MATERIAL_CATEGORIES, MATERIAL_CATEGORY, MATERIAL_STATUS, MATERIAL_STATUSES, materialRows, statusCounts } from "@/lib/material-orders/plan";
import { materialTableReady } from "@/lib/material-orders/tables";
import { toDateKey } from "@/lib/format";
import { MaterialList } from "@/components/material-orders/MaterialList";
import { PendingButton } from "@/components/ui/PendingButton";
import { Card, CardHeader, Field, Input, LinkTabs, Note, PageHeader, Select, buttonClass } from "@/components/ui";

export const metadata: Metadata = { title: "材料発注" };
export const dynamic = "force-dynamic";

/**
 * 材料発注 (お客様のご要望 2026-11-27「■4 材料発注フロー」): 受注した案件の襖紙・カーテン・クロスを見積の明細から自動で一覧にし、
 * 発注したら「発注済み」(押した人 = 発注者)。在庫使用・別途発注・発注不要も選べる。在庫補充など案件にひも付かない発注はここから手で足す。
 * 案件の画面の「材料の発注」と同じデータ (src/lib/material-orders/plan.ts)
 */
export default async function MaterialOrdersPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  if (!canViewMaterialOrders(user)) redirect("/");
  const db = getDb();
  const today = toDateKey(new Date());
  const allStores = canSeeAllStores(user);
  const store = (sp.store ?? (allStores ? "all" : user.storeId)) as StoreId | "all";
  const status = (sp.status && ((MATERIAL_STATUSES as string[]).includes(sp.status) || sp.status === "all") ? sp.status : "unordered") as MaterialOrderStatus | "all";
  const category = (MATERIAL_CATEGORIES as string[]).includes(sp.category ?? "") ? (sp.category as MaterialOrderCategory) : undefined;
  const q = (sp.q ?? "").trim();
  const all = materialRows(db, today, { storeId: store });
  const filtered = all.filter((r) => (!category || r.category === category) && (!q || `${r.name} ${r.code ?? ""} ${r.customerName ?? ""} ${r.caseTitle ?? ""} ${r.orderNumber ?? ""} ${r.spec ?? ""}`.includes(q)));
  const counts = statusCounts(filtered);
  const rows = status === "all" ? filtered : filtered.filter((r) => r.status === status);
  const urgent = filtered.filter((r) => r.urgent).length;
  const qs = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const v = { store, status, category, q, ...patch };
    for (const [k, x] of Object.entries(v)) if (x) p.set(k, x);
    return `/material-orders?${p.toString()}`;
  };
  const returnTo = qs({});
  const stores = db.stores.filter((s) => allStores || canEditMaterialOrder(user, s.id) || s.id === user.storeId);
  const ready = materialTableReady();
  return (
    <div>
      <PageHeader title="材料発注" description="受注した案件の襖紙・カーテン・クロスを見積の明細から自動で一覧にします。発注したら「発注済み」を押してください (押した人が発注者・日時が残ります)。案件を開くと、その案件の材料と発注状況が同じように見られます" />
      {!ready && <Note tone="warn">材料発注の表がまだデータベースにありません。管理者がデプロイするまで、発注の状況は保存できません。</Note>}
      {urgent > 0 && (
        <div className="mb-3">
          <Note tone="warn">未発注で、必要な日 (納品・工事の日) まで 3 日以内の材料が {urgent} 件あります (「急ぎ」)。</Note>
        </div>
      )}
      <LinkTabs
        current={qs({})}
        items={[
          ...MATERIAL_STATUSES.map((s) => ({ href: qs({ status: s }), label: MATERIAL_STATUS[s].label, count: counts[s] || undefined })),
          { href: qs({ status: "all" }), label: "すべて", count: filtered.length || undefined },
        ]}
      />
      <Card className="mb-4">
        <form method="get" className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="status" value={status} />
          <Field label="店舗">
            <Select name="store" defaultValue={store}>
              <option value="all">全店舗</option>
              {db.stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="品目">
            <Select name="category" defaultValue={category ?? ""}>
              <option value="">すべて</option>
              {MATERIAL_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {MATERIAL_CATEGORY[c]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="検索 (品番・お客様・受注番号)">
            <Input name="q" defaultValue={q} placeholder="例: のぞみ177" />
          </Field>
          <button type="submit" className={buttonClass("secondary", "md")}>
            絞り込む
          </button>
        </form>
      </Card>
      <MaterialList db={db} user={user} rows={rows} returnTo={returnTo} showCase />
      {stores.some((s) => canEditMaterialOrder(user, s.id)) && (
        <Card className="mt-4">
          <CardHeader title="材料を追加 (在庫補充・案件にひも付かない発注など)" description="受注の番号を入れるとその案件の材料になります (空 = 案件なし)。リフォームの手配・手書きの発注一覧の読み取りは、案件の画面の「材料の発注」からもできます" />
          <form action={addMaterialRow} className="grid grid-cols-1 gap-2 @xl:grid-cols-3">
            <input type="hidden" name="returnTo" value={returnTo} />
            <Field label="店舗">
              <Select name="storeId" defaultValue={stores.some((s) => s.id === user.storeId) ? user.storeId : stores[0]?.id}>
                {stores
                  .filter((s) => canEditMaterialOrder(user, s.id))
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="品目">
              <Select name="category" defaultValue="tatami">
                {MATERIAL_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {MATERIAL_CATEGORY[c]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="受注の番号 (任意)">
              <Input name="orderNumber" placeholder="例: O-2026-0012" />
            </Field>
            <Field label="材料名" required>
              <Input name="name" required placeholder="例: 畳表 きずな" />
            </Field>
            <Field label="品番">
              <Input name="code" />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="数量">
                <Input name="qty" inputMode="decimal" />
              </Field>
              <Field label="単位">
                <Input name="unit" placeholder="枚・本・巻" />
              </Field>
            </div>
            <Field label="必要な日">
              <Input type="date" name="neededBy" />
            </Field>
            <Field label="発注先">
              <Input name="supplierName" />
            </Field>
            <Field label="状況">
              <Select name="status" defaultValue="unordered">
                {MATERIAL_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {MATERIAL_STATUS[s].label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="寸法・メモ" className="@xl:col-span-3">
              <Input name="spec" />
            </Field>
            <div className="@xl:col-span-3">
              <PendingButton type="submit" className={buttonClass("primary", "md")}>
                追加する
              </PendingButton>
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}
