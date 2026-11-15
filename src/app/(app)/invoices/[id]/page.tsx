import Link from "@/components/ui/Link";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canAccessStore, canManageFinance, isManagerOrAbove } from "@/lib/auth/permissions";
import { customerName, userName } from "@/lib/db/queries";
import { logInvoiceContact, recordPayment, updateInvoiceInfo, voidInvoice } from "@/lib/actions/invoices";
import { settlePayment } from "@/lib/actions/cases";
import { fmtDate, fmtDateTime, toDateKey, yen } from "@/lib/format";
import { CHANNEL_LABEL, INVOICE_STATUS, PAYMENT_METHOD_LABEL } from "@/lib/constants";
import { Button, Card, CardHeader, Dl, Field, Flash, Input, LinkButton, Note, PageHeader, Select, StatusBadge, StoreTag, Textarea } from "@/components/ui";

export default async function InvoiceDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string; err?: string }> }) {
  const { id } = await params;
  const { msg, err } = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const inv = db.invoices.find((x) => x.id === id);
  if (!inv) notFound();
  if (!canAccessStore(user, inv.storeId)) redirect("/invoices?err=" + encodeURIComponent("この請求書を閲覧する権限がありません。"));
  const today = toDateKey(new Date());
  const status = (inv.status === "issued" || inv.status === "partially_paid") && inv.dueDate < today ? "overdue" : inv.status;
  const customer = db.customers.find((c) => c.id === inv.customerId);
  const order = db.orders.find((o) => o.id === inv.orderId);
  const quote = order ? db.quotes.find((q) => q.id === order.quoteId) : undefined;
  const payments = db.payments.filter((p) => p.invoiceId === inv.id).sort((a, b) => b.date.localeCompare(a.date));
  const remaining = inv.total - inv.paidAmount;
  const comms = db.commLogs.filter((c) => c.relatedId === inv.id).sort((a, b) => b.at.localeCompare(a.at));

  return (
    <div>
      <Flash msg={msg} err={err} />
      <PageHeader
        title={`${inv.number} ${customerName(inv.customerId)} 様`}
        badge={<StatusBadge value={status} map={INVOICE_STATUS} />}
        description={<span className="inline-flex flex-wrap items-center gap-2"><StoreTag store={db.stores.find((s) => s.id === inv.storeId)} /> · 発行 {fmtDate(inv.issueDate)} · 支払期限 {fmtDate(inv.dueDate)} · 発行者 {userName(inv.createdBy)}</span>}
        back={{ href: "/invoices", label: "請求・入金一覧" }}
        actions={
          <>
            <LinkButton href={`/api/pdf/invoices/${inv.id}`} variant="secondary" size="sm" target="_blank">請求書 PDF</LinkButton>
            {inv.paidAmount > 0 && inv.status !== "void" && <LinkButton href={`/api/pdf/receipts/${inv.id}`} variant="secondary" size="sm" target="_blank">領収書 PDF</LinkButton>}
            <LinkButton href={`/print/invoices/${inv.id}`} variant="ghost" size="sm">画面で表示・印刷</LinkButton>
          </>
        }
      />
      {status === "overdue" && <Note tone="warn">支払期限を {Math.round((new Date(today).getTime() - new Date(inv.dueDate).getTime()) / 86400000)} 日超過しています。督促の記録を残し、入金確認後に入金登録してください。</Note>}

      <div className="mt-4 grid grid-cols-1 gap-4 @3xl:grid-cols-3">
        <div className="space-y-4 @3xl:col-span-2">
          <Card>
            <CardHeader title="請求内容" />
            <Dl columns={3} items={[["件名", inv.title ?? order?.title], ["小計 (税抜)", yen(inv.subtotal)], ["消費税", yen(inv.tax)], ["請求額 (税込)", <span key="t" className="font-semibold">{yen(inv.total)}</span>], ["入金額", yen(inv.paidAmount)], ["残高", <span key="r" className={remaining > 0 ? "font-semibold text-critical" : "font-semibold text-good-ink"}>{yen(remaining)}</span>], ["送付方法", inv.sentVia ? CHANNEL_LABEL[inv.sentVia] : "-"], ["受注", order ? <Link key="o" href={`/orders/${order.id}`} className="text-accent hover:underline">{order.number}</Link> : "-"], ["見積", quote ? <Link key="q" href={`/quotes/${quote.id}`} className="text-accent hover:underline">{quote.number}</Link> : "-"]]} />
            {(inv.items ?? quote?.items) && (
              <table className="mt-4 w-full text-sm">
                <thead><tr className="bg-subtle text-xs text-ink-2"><th className="px-3 py-1.5 text-left font-medium">品名</th><th className="px-3 py-1.5 text-right font-medium">数量</th><th className="px-3 py-1.5 text-right font-medium">金額 (税抜)</th></tr></thead>
                <tbody>{(inv.items ?? quote?.items ?? []).map((i) => <tr key={i.id} className="border-t border-line"><td className="px-3 py-1.5">{i.name}{i.spec ? <span className="ml-1 text-xs text-ink-3">{i.spec}</span> : null}</td><td className="px-3 py-1.5 text-right tnum">{i.qty} {i.unit}</td><td className="px-3 py-1.5 text-right tnum">{yen(i.amount)}</td></tr>)}</tbody>
              </table>
            )}
            {inv.notes && <p className="mt-3 text-xs text-ink-2">備考: {inv.notes}</p>}
          </Card>

          {remaining > 0 && inv.status !== "void" && (
            <Card>
              <CardHeader title="入金を登録" description="現金・振込・カード・PayPay など。登録すると売掛残高と案件状態に即時反映" />
              <form action={recordPayment.bind(null, inv.id)} className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @5xl:grid-cols-4">
                <Field label="入金日"><Input type="date" name="date" defaultValue={today} /></Field>
                <Field label="金額"><Input type="number" name="amount" defaultValue={remaining} min={1} max={remaining} /></Field>
                <Field label="方法">
                  <Select name="method" defaultValue={customer?.type === "corporate" ? "transfer" : "cash"}>
                    {(Object.keys(PAYMENT_METHOD_LABEL) as (keyof typeof PAYMENT_METHOD_LABEL)[]).map((m) => <option key={m} value={m}>{PAYMENT_METHOD_LABEL[m]}</option>)}
                  </Select>
                </Field>
                <Field label="メモ"><Input name="memo" placeholder="例: 内金 / 振込名義" /></Field>
                <div className="@xl:col-span-2 @5xl:col-span-4"><Button type="submit">入金を登録する</Button></div>
              </form>
            </Card>
          )}

          <Card>
            <CardHeader title="入金履歴" />
            <ul className="divide-y divide-line text-sm">
              {payments.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span><span className="tnum text-ink-2">{fmtDate(p.date)}</span> · {PAYMENT_METHOD_LABEL[p.method]}{p.memo ? ` · ${p.memo}` : ""} <span className="text-xs text-ink-3">({userName(p.recordedBy)})</span>
                    {(p.method === "card" || p.method === "paypay") && (p.settledOn ? <span className="ml-1 text-xs text-good-ink">決済会社から入金済 {fmtDate(p.settledOn)}</span> : <span className="ml-1 text-xs text-warn-ink">決済会社からの入金待ち</span>)}
                  </span>
                  <span className="flex items-center gap-2">
                    {(p.method === "card" || p.method === "paypay") && !p.settledOn && (
                      <form action={settlePayment.bind(null, p.id)} className="flex items-center gap-1">
                        <input type="hidden" name="returnTo" value={`/invoices/${inv.id}`} />
                        <input type="date" name="settledOn" defaultValue={today} className="field h-7 w-36 py-0.5 text-xs" aria-label="入金を確認した日" />
                        <Button type="submit" size="sm" variant="secondary">入金を確認</Button>
                      </form>
                    )}
                    <span className="font-medium tnum">{yen(p.amount)}</span>
                  </span>
                </li>
              ))}
              {payments.length === 0 && <li className="py-3 text-ink-3">入金はまだありません</li>}
            </ul>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title="お客様" />
            {customer && <Dl columns={1} items={[["氏名", <Link key="n" href={`/customers/${customer.id}`} className="text-accent hover:underline">{customer.name}</Link>], ["電話", customer.phone], ["住所", customer.address], ["希望連絡手段", CHANNEL_LABEL[customer.preferredChannel]]]} />}
          </Card>
          {inv.status !== "void" && (
            <Card>
              <CardHeader title={status === "overdue" ? "督促・送付の記録" : "送付の記録"} />
              <form action={logInvoiceContact.bind(null, inv.id)} className="space-y-2">
                <Field label="種別">
                  <Select name="kind" defaultValue={status === "overdue" ? "reminder" : "send"}>
                    <option value="send">請求書を送付</option>
                    <option value="reminder">督促</option>
                  </Select>
                </Field>
                <Field label="手段">
                  <Select name="channel" defaultValue={customer?.preferredChannel === "visit" ? "phone" : customer?.preferredChannel ?? "phone"}>
                    {(["phone", "email", "line", "chatwork", "mail", "visit"] as const).map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>)}
                  </Select>
                </Field>
                <Field label="内容"><Input name="body" placeholder="任意" /></Field>
                <Button type="submit" size="sm" variant="secondary">記録する</Button>
              </form>
              <ul className="mt-3 space-y-1.5 text-xs">
                {comms.map((c) => <li key={c.id}><span className="tnum text-ink-3">{fmtDateTime(c.at)}</span> {c.subject} <span className="text-ink-3">({CHANNEL_LABEL[c.channel]})</span></li>)}
              </ul>
            </Card>
          )}
          {(canManageFinance(user) || isManagerOrAbove(user)) && inv.status !== "void" && inv.status !== "paid" && (
            <Card>
              <CardHeader title="請求書の記載を修正" description="件名・備考・支払期限を直せます (修正は変更履歴に残り、PDF に反映されます)" />
              <form action={updateInvoiceInfo.bind(null, inv.id)} className="space-y-2">
                <div className="grid grid-cols-1 gap-2 @xl:grid-cols-3">
                  <Field label="件名" className="@xl:col-span-2"><Input name="title" defaultValue={inv.title ?? order?.title} /></Field>
                  <Field label="支払期限"><Input type="date" name="dueDate" defaultValue={inv.dueDate} required /></Field>
                </div>
                <Field label="備考 (請求書に印字)"><Textarea name="notes" defaultValue={inv.notes} rows={2} /></Field>
                <Button type="submit" size="sm" variant="secondary">修正する</Button>
              </form>
              <p className="mt-2 text-[11px] text-ink-3">金額を訂正する場合は、入金前に請求書を無効化 → 見積の変更を申請 (承認) → 受注の画面から再発行します。</p>
            </Card>
          )}
          {canManageFinance(user) && inv.paidAmount === 0 && inv.status !== "void" && (
            <Card>
              <CardHeader title="請求書の無効化" description="誤発行・金額の訂正の場合。無効化すると案件から再発行できます" />
              <form action={voidInvoice.bind(null, inv.id)} className="flex items-end gap-2">
                <Field label="理由" className="flex-1"><Input name="reason" /></Field>
                <Button type="submit" variant="danger" size="md">無効化</Button>
              </form>
            </Card>
          )}
          <Card>
            <CardHeader title="変更履歴" />
            <ul className="space-y-1.5 text-xs">
              {db.auditLogs.filter((l) => (l.entity === "invoice" || l.entity === "payment") && l.entityId === inv.id).reverse().map((l) => <li key={l.id}><span className="tnum text-ink-3">{fmtDateTime(l.at)}</span> {l.summary} <span className="text-ink-3">({userName(l.userId)})</span></li>)}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
