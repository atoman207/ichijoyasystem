import Link from "@/components/ui/Link";
import type { Database, User } from "@/lib/db/types";
import { canEditMaterialOrder, canViewMaterialOrders } from "@/lib/auth/permissions";
import { addMaterialRow, addMaterialsFromQuote, readMaterialPhoto } from "@/lib/actions/material-orders";
import { MATERIAL_CATEGORIES, MATERIAL_CATEGORY, materialRows, reformLines, statusCounts } from "@/lib/material-orders/plan";
import { materialTableReady } from "@/lib/material-orders/tables";
import { aiEnabled } from "@/lib/ai/ocr";
import { toDateKey } from "@/lib/format";
import { PendingButton } from "@/components/ui/PendingButton";
import { Card, CardHeader, Note, buttonClass } from "@/components/ui";
import { MaterialList } from "./MaterialList";

/**
 * 案件・受注の画面の「材料の発注」(お客様のご要望 2026-11-27「■5 案件画面と材料発注の連動」「■6 リフォーム案件の発注管理」)。
 * 材料発注の一覧と同じデータ・同じ操作 (「発注済み」など。どちらで押しても両方に出る)。
 * リフォームなど: 見積の明細から手配を足す・手書きの発注一覧を撮影して読み取る・手で足す (発注先・必要な日つき)
 */
export function MaterialOrdersCard({ db, user, orderIds, returnTo }: { db: Database; user: User; orderIds: string[]; returnTo: string }) {
  if (!canViewMaterialOrders(user) || !orderIds.length) return null;
  const today = toDateKey(new Date());
  const rows = materialRows(db, today, { orderIds });
  const counts = statusCounts(rows);
  const orders = orderIds.map((id) => db.orders.find((o) => o.id === id)).filter((o): o is NonNullable<typeof o> => Boolean(o) && o!.status !== "cancelled");
  const editable = orders.filter((o) => canEditMaterialOrder(user, o.storeId));
  const ready = materialTableReady();
  const ai = aiEnabled();
  return (
    <Card id="materials">
      <CardHeader
        title="材料の発注"
        description={`${counts.unordered ? `未発注 ${counts.unordered} 件 · ` : ""}襖紙・カーテン・クロスは見積の明細から自動で出します。発注したら「発注済み」を押してください (押した人が発注者になります)。材料発注の一覧と同じ内容です`}
        action={
          <Link href="/material-orders" className="text-xs text-accent hover:underline">
            材料発注の一覧
          </Link>
        }
      />
      {!ready && <Note tone="warn">材料発注の表がまだデータベースにありません。管理者がデプロイするまで、発注の状況は保存できません。</Note>}
      <MaterialList db={db} user={user} rows={rows} returnTo={`${returnTo}#materials`} showCase={orders.length > 1} />
      {editable.map((o) => {
        const quote = o.quoteId ? db.quotes.find((q) => q.id === o.quoteId) : undefined;
        const lines = reformLines(quote);
        return (
          <details key={o.id} className="mt-3 rounded-xl border border-line px-3 py-2" open={o.category === "reform" && rows.length === 0}>
            <summary className="cursor-pointer text-sm font-medium text-accent">
              材料・手配を追加{orders.length > 1 ? ` (${o.number})` : ""} — リフォームの材料・外注・在庫の補充など
            </summary>
            <div className="mt-2 space-y-3">
              {lines.length > 0 && (
                <form action={addMaterialsFromQuote} className="space-y-1.5">
                  <input type="hidden" name="returnTo" value={`${returnTo}#materials`} />
                  <input type="hidden" name="orderId" value={o.id} />
                  <div className="text-xs font-semibold text-ink">見積の明細から手配を足す</div>
                  <div className="flex flex-wrap gap-1">
                    {lines.map((it) => (
                      <label key={it.id} className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-line bg-panel px-2.5 py-1 text-xs has-[:checked]:border-accent has-[:checked]:bg-accent-soft">
                        <input type="checkbox" name="lineId" value={it.id} className="h-3.5 w-3.5" />
                        {it.name}
                        {it.spec ? ` ${it.spec}` : ""} ({it.qty}
                        {it.unit})
                      </label>
                    ))}
                  </div>
                  <PendingButton type="submit" className={buttonClass("secondary", "sm")}>
                    選んだ明細を手配に足す
                  </PendingButton>
                </form>
              )}
              <form action={readMaterialPhoto} encType="multipart/form-data" className="space-y-1.5">
                <input type="hidden" name="returnTo" value={`${returnTo}#materials`} />
                <input type="hidden" name="orderId" value={o.id} />
                <div className="text-xs font-semibold text-ink">手書きの発注一覧を撮影して読み取る</div>
                <p className="text-[11px] text-ink-3">工程表・発注一覧の写真か PDF。AI が材料名・品番・数量・発注先・必要な日を読み取り、「写真から読み取り (要確認)」として足します。内容を確かめて直してください。{!ai && " (AI の設定がないため使えません)"}</p>
                <input type="file" name="file" accept="image/*,application/pdf" capture="environment" className="block text-xs" disabled={!ai} required />
                <PendingButton type="submit" className={buttonClass("secondary", "sm")} disabled={!ai}>
                  読み取って足す
                </PendingButton>
              </form>
              <form action={addMaterialRow} className="grid grid-cols-1 gap-2 @xl:grid-cols-3">
                <input type="hidden" name="returnTo" value={`${returnTo}#materials`} />
                <input type="hidden" name="orderId" value={o.id} />
                <div className="text-xs font-semibold text-ink @xl:col-span-3">手で足す</div>
                <label className="block">
                  <span className="text-[11px] text-ink-3">品目</span>
                  <select name="category" defaultValue={o.category === "reform" ? "reform" : o.category === "fusuma" ? "fusuma" : "other"} className="field h-9 py-1 text-sm">
                    {MATERIAL_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {MATERIAL_CATEGORY[c]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="text-[11px] text-ink-3">材料名・手配の内容 *</span>
                  <input name="name" required placeholder="例: フローリング材・大工の手配" className="field h-9 py-1 text-sm" />
                </label>
                <label className="block">
                  <span className="text-[11px] text-ink-3">品番</span>
                  <input name="code" className="field h-9 py-1 text-sm" />
                </label>
                <label className="block">
                  <span className="text-[11px] text-ink-3">数量</span>
                  <input name="qty" inputMode="decimal" className="field h-9 py-1 text-sm" />
                </label>
                <label className="block">
                  <span className="text-[11px] text-ink-3">単位</span>
                  <input name="unit" placeholder="枚・本・m・式" className="field h-9 py-1 text-sm" />
                </label>
                <label className="block">
                  <span className="text-[11px] text-ink-3">必要な日</span>
                  <input type="date" name="neededBy" className="field h-9 py-1 text-sm" />
                </label>
                <label className="block">
                  <span className="text-[11px] text-ink-3">発注先・外注業者</span>
                  <input name="supplierName" className="field h-9 py-1 text-sm" />
                </label>
                <label className="block @xl:col-span-2">
                  <span className="text-[11px] text-ink-3">寸法・施工箇所・メモ</span>
                  <input name="spec" className="field h-9 py-1 text-sm" />
                </label>
                <div className="@xl:col-span-3">
                  <PendingButton type="submit" className={buttonClass("secondary", "sm")}>
                    追加する
                  </PendingButton>
                </div>
              </form>
            </div>
          </details>
        );
      })}
    </Card>
  );
}
