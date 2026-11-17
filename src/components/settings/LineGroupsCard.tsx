import type { Database } from "@/lib/db/types";
import { lineGroupName, lineGroups } from "@/lib/line-groups";
import { linkLineGroup, unlinkLineGroup } from "@/lib/actions/line-groups";
import { fmtDateTime } from "@/lib/format";
import { Badge, Button, Card, CardHeader, Input, Select } from "@/components/ui";
import Link from "@/components/ui/Link";

/**
 * 設定 → 外部連携・AI: LINE グループの一覧 (公式アカウントを招待したグループ)
 * 受注番号・協力業者を入れてひも付けると、そのグループのメッセージ・写真・資料を案件の履歴に残す
 */
export function LineGroupsCard({ db, admin }: { db: Database; admin: boolean }) {
  const groups = [...lineGroups(db)].sort((a, b) => (a.status === b.status ? (b.lastMessageAt ?? b.joinedAt).localeCompare(a.lastMessageAt ?? a.joinedAt) : a.status === "joined" ? -1 : 1));
  const suppliers = db.suppliers.filter((s) => s.active !== false).sort((a, b) => (a.kana || a.name).localeCompare(b.kana || b.name, "ja"));
  const back = "/settings?tab=integrations";
  return (
    <Card className="@2xl:col-span-2" padded={false}>
      <div className="px-5 pt-5">
        <CardHeader
          title="LINE グループ (現場ごとのグループ・業者とのグループ)"
          description="会社の LINE 公式アカウントをグループに招待すると、ここに表示されます (LINE Official Account Manager の アカウント設定 →「グループ・複数人チャットへの参加を許可する」をオン)。受注番号や協力業者をひも付けると、そのグループのメッセージを案件のやりとり履歴に、写真・資料を現場写真・資料に残し、受注の画面からグループへ送れます。ひも付ける前のメッセージは 50 件まで保留し、ひも付けたときに履歴へ移します"
        />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] text-sm">
          <thead>
            <tr className="bg-subtle text-xs text-ink-2">
              <th className="px-4 py-2 text-left font-medium">グループ</th>
              <th className="px-3 py-2 text-left font-medium">状態</th>
              <th className="px-3 py-2 text-left font-medium">ひも付け</th>
              <th className="px-3 py-2 text-left font-medium">{admin ? "変更" : ""}</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => {
              const order = g.orderId ? db.orders.find((o) => o.id === g.orderId) : undefined;
              const supplier = g.supplierId ? db.suppliers.find((s) => s.id === g.supplierId) : undefined;
              const linked = Boolean(order || supplier);
              return (
                <tr key={g.id} className="border-t border-line align-top">
                  <td className="px-4 py-2 text-xs">
                    <div className="font-medium text-ink">{lineGroupName(g)}</div>
                    {g.label && g.name && <div className="text-ink-3">LINE の名前: {g.name}</div>}
                    <div className="font-mono text-[11px] text-ink-3">{g.id}</div>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <Badge tone={g.status === "left" ? "neutral" : linked ? "good" : "warn"}>{g.status === "left" ? "退出済み" : linked ? "ひも付け済み" : "未登録 (保留中)"}</Badge>
                    <div className="mt-1 text-ink-3">参加 {fmtDateTime(g.joinedAt)}</div>
                    {g.lastMessageAt && <div className="text-ink-3">最後のメッセージ {fmtDateTime(g.lastMessageAt)} · 計 {g.messageCount} 件</div>}
                    {g.pending.length > 0 && <div className="text-warn-ink">保留中のメッセージ {g.pending.length} 件</div>}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {order && <div><Link href={`/orders/${order.id}`} className="text-brand hover:underline">受注 {order.number}</Link></div>}
                    {supplier && <div><Link href={`/suppliers/${supplier.id}`} className="text-brand hover:underline">{supplier.name}</Link></div>}
                    {!linked && <span className="text-ink-3">-</span>}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {admin && (
                      <div className="space-y-1.5">
                        <form action={linkLineGroup} className="flex flex-wrap items-center gap-1.5">
                          <input type="hidden" name="groupId" value={g.id} />
                          <input type="hidden" name="returnTo" value={back} />
                          <Input name="label" defaultValue={g.label} placeholder="社内の呼び名 (任意)" className="h-8 w-36 text-xs" aria-label="社内の呼び名" />
                          <Input name="orderRef" defaultValue={order?.number} placeholder="受注番号 O-…" className="h-8 w-32 text-xs" aria-label="受注番号" />
                          <Select name="supplierId" defaultValue={g.supplierId ?? ""} className="h-8 w-40 text-xs" aria-label="協力業者・仕入先">
                            <option value="">(協力業者なし)</option>
                            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                          </Select>
                          <Button type="submit" size="sm">保存</Button>
                        </form>
                        {linked && (
                          <form action={unlinkLineGroup}>
                            <input type="hidden" name="groupId" value={g.id} />
                            <input type="hidden" name="returnTo" value={back} />
                            <Button type="submit" size="sm" variant="secondary">ひも付けを外す</Button>
                          </form>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
            {groups.length === 0 && <tr><td colSpan={4} className="px-4 py-6 text-center text-xs text-ink-3">まだグループはありません。現場の LINE グループに会社の公式アカウントを招待すると表示されます</td></tr>}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
