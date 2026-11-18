import type { Metadata } from "next";
import Link from "@/components/ui/Link";
import { notFound, redirect } from "next/navigation";
import { randomUUID } from "node:crypto";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canEditPurchaseOrder, canViewPurchaseOrder } from "@/lib/auth/permissions";
import { cancelPurchaseOrder, completePurchaseOrder, duplicatePurchaseOrder, issuePurchaseOrder, recordManualSend, reopenPurchaseOrder, sendPurchaseOrder } from "@/lib/actions/purchase-orders";
import { mockReceiveReply } from "@/lib/actions/fax";
import { PURCHASE_ORDER_STATUS } from "@/lib/constants";
import { fmtDate, fmtDateTime, yen } from "@/lib/format";
import { poAmount, poFaxTo, siteLabel } from "@/lib/purchase-orders";
import { faxConnection } from "@/lib/fax/adapter";
import { fmtFax } from "@/lib/fax/numbers";
import { Badge, Button, Card, CardHeader, Dl, Flash, Input, LinkButton, Note, PageHeader, StatusBadge, StoreTag, Table, Td, Textarea, Th, Tr } from "@/components/ui";
import { HistoryCard } from "@/components/features/History";
import { FaxConnectionNote, FaxHistoryCard } from "@/components/fax/FaxParts";

export const metadata: Metadata = { title: "発注書" };

export default async function PurchaseOrderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string; err?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const po = db.purchaseOrders.find((p) => p.id === id);
  if (!po) notFound();
  if (!canViewPurchaseOrder(user, po)) redirect("/purchase-orders?err=" + encodeURIComponent("この発注書を閲覧する権限がありません。"));
  const editable = canEditPurchaseOrder(user, po);
  const supplier = db.suppliers.find((s) => s.id === po.supplierId);
  const store = db.stores.find((s) => s.id === po.storeId);
  const orders = po.orderIds.map((oid) => db.orders.find((o) => o.id === oid)).filter((o): o is NonNullable<typeof o> => Boolean(o));
  const faxes = db.faxMessages.filter((f) => f.purchaseOrderId === po.id);
  const outbound = faxes.filter((f) => f.direction === "outbound").sort((a, b) => b.at.localeCompare(a.at));
  const inFlight = outbound.find((f) => f.status === "queued" || f.status === "sending");
  const sentThisVersion = outbound.find((f) => (f.status === "sent" || f.status === "manual") && f.poVersion === po.version);
  const unknown = outbound.find((f) => f.status === "unknown" && f.poVersion === po.version);
  const to = poFaxTo(db, po);
  const conn = faxConnection();
  const canSend = editable && po.status !== "cancelled" && po.status !== "completed";
  const amount = poAmount(po);
  const users = new Map(db.users.map((u) => [u.id, u.name]));
  const pdf = `/api/pdf/purchase-orders/${po.id}`;
  // 送信フォームの 1 回の表示ごとのキー (二重送信の防止。同じキーの送信は 1 回だけ)
  const key = randomUUID();

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader
        title={`発注書 ${po.number}`}
        badge={<><StatusBadge value={po.status} map={PURCHASE_ORDER_STATUS} />{po.version > 1 && <Badge tone="serious" dot={false}>第{po.version}版 (訂正)</Badge>}</>}
        description={<span className="inline-flex flex-wrap items-center gap-2">{supplier?.name ?? "-"} 御中 · <StoreTag store={store} /> · 発注日 {fmtDate(po.issuedOn)}{po.desiredDate ? ` · 希望納期 ${fmtDate(po.desiredDate)}` : ""}</span>}
        back={{ href: "/purchase-orders", label: "発注書" }}
        actions={
          <>
            <LinkButton href={pdf} variant="secondary" target="_blank">PDF を開く</LinkButton>
            <LinkButton href={`${pdf}?download=1`} variant="ghost" download>PDF を保存</LinkButton>
            {editable && ["draft", "issued", "sent"].includes(po.status) && <LinkButton href={`/purchase-orders/${po.id}/edit`} variant="secondary">編集</LinkButton>}
            {editable && <form action={duplicatePurchaseOrder.bind(null, po.id)}><Button type="submit" variant="ghost">複製</Button></form>}
          </>
        }
      />
      {po.status === "cancelled" && <div className="mb-4"><Note tone="warn">この発注書は取り消しました ({fmtDateTime(po.cancelledAt)} · 理由: {po.cancelReason ?? "-"})。</Note></div>}

      <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-3">
        <div className="space-y-4 @4xl:col-span-2">
          <Card padded={false}>
            <div className="p-5 pb-3"><CardHeader title="発注書の PDF" description={po.status === "draft" ? "下書きの PDF には「下書き」の透かしが入ります。送信すると透かしのない PDF を送ります" : "仕入先に送る内容です。送った PDF は FAX の記録に残ります"} /></div>
            <iframe src={pdf} title={`発注書 ${po.number} の PDF`} className="h-[70vh] min-h-[420px] w-full rounded-b-2xl border-t border-line bg-subtle" />
          </Card>

          <Card padded={false}>
            <div className="p-5 pb-0"><CardHeader title="明細" description={`${po.lines.length} 行 · 案件 ${orders.length} 件${amount !== undefined ? ` · 参考金額 ${yen(amount)} (税抜)` : ""}`} /></div>
            <div className="px-2 pb-2">
              <Table minWidth="min-w-[720px]">
                <thead><tr><Th>No</Th><Th>品名・品番・仕様</Th><Th align="right">数量</Th><Th>現場名・案件</Th><Th>着日</Th><Th>備考</Th></tr></thead>
                <tbody>
                  {po.lines.map((l, i) => (
                    <Tr key={l.id}>
                      <Td className="text-xs tnum">{i + 1}</Td>
                      <Td><div className="text-sm">{l.name}</div><div className="text-xs text-ink-3">{[l.code && `品番 ${l.code}`, l.spec].filter(Boolean).join(" · ")}</div></Td>
                      <Td align="right" className="whitespace-nowrap tnum">{l.qty} {l.unit}{typeof l.unitPrice === "number" && <div className="text-xs text-ink-3">@{yen(l.unitPrice)}</div>}</Td>
                      <Td className="text-xs">{l.orderId ? (() => { const o = db.orders.find((x) => x.id === l.orderId); return <>{o ? siteLabel(db, o, Boolean(po.showCustomer)) : ""}<div><Link href={`/orders/${l.orderId}`} className="font-mono text-accent hover:underline">{l.orderNumber ?? "-"}</Link></div></>; })() : "-"}</Td>
                      <Td className="text-xs tnum">{fmtDate(l.dueDate || po.desiredDate) || "-"}</Td>
                      <Td className="text-xs">{l.notes ?? ""}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </div>
          </Card>

          <FaxHistoryCard db={db} user={user} faxes={faxes} title="この発注書の FAX (送信・返信)" />
        </div>

        <div className="space-y-4">
          {canSend && (
            <Card id="send">
              <CardHeader title={sentThisVersion ? "FAX で再送する" : "FAX で送信する"} description="PDF の内容と送信先の FAX 番号を確かめてから送信してください" />
              <div className="mb-3"><FaxConnectionNote /></div>
              {inFlight ? (
                <Note tone="accent">送信を処理中です ({inFlight.number}・{inFlight.status === "queued" ? "受付済み" : "処理中"})。結果が出るまでお待ちください。<Link href={`/fax/${inFlight.id}`} className="ml-1 text-accent underline">送信の記録を見る</Link></Note>
              ) : conn.mode === "mock" || conn.mode === "live" ? (
                <form action={sendPurchaseOrder.bind(null, po.id)} className="space-y-3">
                  <input type="hidden" name="key" value={key} />
                  <label className="block">
                    <span className="label">送信先の FAX 番号</span>
                    <Input name="to" defaultValue={fmtFax(to)} inputMode="tel" required />
                    <span className="mt-1 block text-[11px] text-ink-3">{supplier?.name ?? ""}{supplier?.fax ? ` の登録: ${fmtFax(supplier.fax)}` : " (仕入先の FAX 番号が未登録です)"}</span>
                  </label>
                  {(sentThisVersion || unknown) && (
                    <label className="flex items-start gap-2 text-sm text-ink-2">
                      <input type="checkbox" name="resend" className="mt-1" />
                      <span>同じ内容を再送する{unknown && <span className="block text-[11px] text-serious-ink">前回の送信 ({unknown.number}) が届いていないことを FAX サービスで確かめてください</span>}</span>
                    </label>
                  )}
                  <label className="flex items-start gap-2 text-sm">
                    <input type="checkbox" name="confirm" className="mt-1" required />
                    <span>PDF の内容 (仕入先・明細・数量・納期・納品先) と送信先の FAX 番号を確認しました</span>
                  </label>
                  <Button type="submit" className="w-full">{sentThisVersion ? "再送する" : "FAX を送信する"}</Button>
                </form>
              ) : (
                <form action={recordManualSend.bind(null, po.id)} className="space-y-3">
                  <input type="hidden" name="key" value={key} />
                  <p className="text-xs text-ink-2">FAX サービスにつながるまでは、PDF を印刷して FAX 機で送り、ここで送信の記録を残します (返信 FAX は「FAX 送受信」で PDF を登録すると、この発注書にひも付きます)。</p>
                  <label className="block">
                    <span className="label">送信先の FAX 番号</span>
                    <Input name="to" defaultValue={fmtFax(to)} inputMode="tel" required />
                  </label>
                  <label className="flex items-start gap-2 text-sm">
                    <input type="checkbox" name="confirm" className="mt-1" required />
                    <span>この内容を FAX 機で送信しました</span>
                  </label>
                  <Button type="submit" variant="secondary" className="w-full">FAX 機で送信したことを記録</Button>
                </form>
              )}
              {editable && po.status === "draft" && (
                <form action={issuePurchaseOrder.bind(null, po.id)} className="mt-3 border-t border-line pt-3">
                  <Button type="submit" variant="ghost" size="sm">送信せずに発行だけする (印刷用)</Button>
                </form>
              )}
            </Card>
          )}

          <Card>
            <CardHeader title="発注の内容" />
            <Dl
              columns={1}
              items={[
                ["仕入先", supplier ? <Link href={`/suppliers/${supplier.id}`} className="text-accent hover:underline">{supplier.name}</Link> : "-"],
                ["送信先 FAX", fmtFax(to) || <span className="text-critical-ink">未登録</span>],
                ["納品先", `${po.deliveryPlace}${po.deliveryAddress ? ` (${po.deliveryAddress})` : ""}`],
                ["お客様の情報", po.showCustomer ? "発注書に載せる (氏名・住所・電話)" : "現場名は「名字 様」と案件番号だけ"],
                ["作成", `${users.get(po.createdBy) ?? "-"} · ${fmtDateTime(po.createdAt)}`],
                ["送信", po.sentAt ? fmtDateTime(po.sentAt) : "-"],
                ["備考", po.notes ?? "-"],
              ]}
            />
            {po.copiedFrom && <p className="mt-2 text-xs text-ink-3">複製元: <Link href={`/purchase-orders/${po.copiedFrom}`} className="text-accent hover:underline">{db.purchaseOrders.find((p) => p.id === po.copiedFrom)?.number ?? "-"}</Link></p>}
          </Card>

          <Card>
            <CardHeader title="案件" description="明細の案件 (受注)。発注書と FAX の記録は各案件の画面にも表示されます" />
            {orders.length === 0 && <p className="text-xs text-ink-3">案件のない発注です</p>}
            <ul className="space-y-2">
              {orders.map((o) => (
                <li key={o.id} className="text-sm">
                  <Link href={`/orders/${o.id}`} className="font-mono text-xs text-accent hover:underline">{o.number}</Link> {siteLabel(db, o, true)}
                  <div className="text-xs text-ink-3">施工予定 {fmtDate(o.scheduledStart) || "未定"}</div>
                </li>
              ))}
            </ul>
          </Card>

          {editable && (
            <Card>
              <CardHeader title="発注の完了・取消" />
              <div className="space-y-3">
                {(po.status === "sent" || po.status === "issued") && (
                  <form action={completePurchaseOrder.bind(null, po.id)}>
                    <Button type="submit" variant="secondary" size="sm">完了にする (納品・回答まで済み)</Button>
                    <p className="mt-1 text-[11px] text-ink-3">完了にすると、返信 FAX のひも付けの候補から外れます</p>
                  </form>
                )}
                {po.status === "completed" && (
                  <form action={reopenPurchaseOrder.bind(null, po.id)}>
                    <Button type="submit" variant="ghost" size="sm">完了を取り消す</Button>
                  </form>
                )}
                {po.status !== "cancelled" && (
                  <form action={cancelPurchaseOrder.bind(null, po.id)} className="space-y-2 border-t border-line pt-3">
                    <Textarea name="reason" placeholder="取消の理由 (必須)" className="min-h-[60px]" required maxLength={300} />
                    <Button type="submit" variant="danger" size="sm">発注書を取り消す</Button>
                  </form>
                )}
              </div>
            </Card>
          )}

          {conn.mode === "mock" && editable && po.status !== "draft" && po.status !== "cancelled" && (
            <Card>
              <CardHeader title="模擬の返信 (検証環境)" description="仕入先がこの発注書に受注確認を書き込んで FAX で返信した想定で、受信を試せます" />
              <form action={mockReceiveReply.bind(null, po.id)}><Button type="submit" variant="soft" size="sm">返信 FAX を受信する (模擬)</Button></form>
            </Card>
          )}

          <HistoryCard db={db} user={user} targets={[{ entity: "purchase_order", id: po.id }]} />
        </div>
      </div>
    </div>
  );
}
