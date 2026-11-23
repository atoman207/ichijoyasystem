import type { Database } from "@/lib/db/types";
import { LINE_GROUP_PURPOSES, LINE_GROUP_PURPOSE_LABEL, lineGroupName, lineGroups, pendingLimit } from "@/lib/line-groups";
import { linkLineGroup, setLineGroupPurpose, unlinkLineGroup } from "@/lib/actions/line-groups";
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
          title="LINE グループ (現場・業者のグループと、店舗別・クレーム報告などの社内のグループ)"
          description="会社の LINE 公式アカウントをグループに招待すると、ここに表示されます (LINE Official Account Manager の アカウント設定 →「グループ・複数人チャットへの参加を許可する」をオン)。現場・業者のグループは受注番号や協力業者をひも付けると、メッセージを案件のやりとり履歴に、写真・資料を現場写真・資料に残し、受注の画面からグループへ送れます (ひも付ける前のメッセージは 50 件まで保留)。社内のグループは「用途」を選ぶと、店舗別グループ = 新しい問い合わせをそのグループに知らせる (LINE の送信の通数を使います)・クレーム・手直し報告 = 報告を KPI → クレーム・手直し に並べて記録にする・施工事例写真・整理整頓の確認 = 写真をこのサーバーに保存し、資料・写真 → 施工事例の投稿 (案件に付ける) / KPI → 整理整頓 (チェックに付ける) で使う・その他 = メッセージを 300 件まで残します"
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
              const purpose = g.purpose && g.purpose !== "site" ? g.purpose : undefined;
              const unhandled = g.pending.filter((m) => !m.handledAt).length;
              return (
                <tr key={g.id} className="border-t border-line align-top">
                  <td className="px-4 py-2 text-xs">
                    <div className="font-medium text-ink">{lineGroupName(g)}</div>
                    {g.label && g.name && <div className="text-ink-3">LINE の名前: {g.name}</div>}
                    <div className="font-mono text-[11px] text-ink-3">{g.id}</div>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <Badge tone={g.status === "left" ? "neutral" : linked || purpose ? "good" : "warn"}>{g.status === "left" ? "退出済み" : linked ? "ひも付け済み" : purpose ? LINE_GROUP_PURPOSE_LABEL[purpose] : "未登録 (保留中)"}</Badge>
                    {purpose && g.storeId && <div className="mt-1 text-ink-2">{db.stores.find((s) => s.id === g.storeId)?.name}{g.notifyInquiries ? " · 新しい問い合わせを知らせる" : ""}</div>}
                    <div className="mt-1 text-ink-3">参加 {fmtDateTime(g.joinedAt)}</div>
                    {g.lastMessageAt && <div className="text-ink-3">最後のメッセージ {fmtDateTime(g.lastMessageAt)} · 計 {g.messageCount} 件</div>}
                    {g.pending.length > 0 && (purpose ? <div className="text-ink-3">残しているメッセージ {g.pending.length} / {pendingLimit(g)} 件{g.purpose === "quality" && unhandled ? <> · <Link href="/kpi/quality" className="text-brand hover:underline">記録にしていない報告 {unhandled} 件</Link></> : null}{(g.purpose === "photos" || g.purpose === "tidy") && g.pending.some((m) => m.type === "image" && !m.handledAt) ? <> · <Link href={g.purpose === "photos" ? "/materials/cases/line" : "/kpi/tidy/new"} className="text-brand hover:underline">{g.purpose === "photos" ? "案件に付けていない写真" : "チェックに付けていない写真"} {g.pending.filter((m) => m.type === "image" && !m.handledAt).length} 枚</Link></> : null}</div> : <div className="text-warn-ink">保留中のメッセージ {g.pending.length} 件</div>)}
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
                        {!linked && (
                          <form action={setLineGroupPurpose} className="flex flex-wrap items-center gap-1.5 border-t border-line pt-1.5">
                            <input type="hidden" name="groupId" value={g.id} />
                            <input type="hidden" name="returnTo" value={back} />
                            <Select name="purpose" defaultValue={g.purpose ?? "site"} className="h-8 w-44 text-xs" aria-label="用途">
                              {LINE_GROUP_PURPOSES.map((p) => <option key={p} value={p}>{LINE_GROUP_PURPOSE_LABEL[p]}</option>)}
                            </Select>
                            <Select name="storeId" defaultValue={g.storeId ?? ""} className="h-8 w-28 text-xs" aria-label="店舗">
                              <option value="">(全店)</option>
                              {db.stores.map((s) => <option key={s.id} value={s.id}>{s.shortName ?? s.name}</option>)}
                            </Select>
                            <label className="flex items-center gap-1 text-[11px] text-ink-2"><input type="checkbox" name="notifyInquiries" defaultChecked={g.notifyInquiries} className="h-3.5 w-3.5" /> 問い合わせを知らせる (店舗別)</label>
                            <Button type="submit" size="sm" variant="secondary">用途を保存</Button>
                          </form>
                        )}
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
