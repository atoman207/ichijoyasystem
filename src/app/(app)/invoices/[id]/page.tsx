import Link from "@/components/ui/Link";
import { PdfLink } from "@/components/features/PdfLink";
import { CaseViewBanner, ReadOnlyArea } from "@/components/features/CaseAccess";
import { invoiceAccessInfo, deniedHref } from "@/lib/case-access";
import { logRecordView } from "@/lib/record-views";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canManageFinance, isManagerOrAbove } from "@/lib/auth/permissions";
import { customerName, userName } from "@/lib/db/queries";
import { ReceiptsCard } from "@/components/finance/ReceiptsCard";
import { logInvoiceContact, recordPayment, updateExpectedPayment, updateInvoiceInfo, voidInvoice } from "@/lib/actions/invoices";
import { settlePayment } from "@/lib/actions/cases";
import { fmtDate, toDateKey, yen } from "@/lib/format";
import { CHANNEL_LABEL, INVOICE_STATUS, PAYMENT_METHOD_LABEL } from "@/lib/constants";
import { Button, Card, CardHeader, Dl, Field, Flash, Input, LinkButton, Note, PageHeader, Select, StatusBadge, StoreTag, Textarea, buttonClass } from "@/components/ui";
import { HistoryCard, RecordStamp } from "@/components/features/History";
import { ContactList } from "@/components/features/Contacts";
import { SendDocumentCard } from "@/components/features/SendDocument";
import { RecordDocDrafts } from "@/components/features/DocDrafts";
import { allocatePaid, isBatchInvoice } from "@/lib/billing";

/** PDF を作ってメールで送る (送信の応答を待つ) ため */
export const maxDuration = 60;

export default async function InvoiceDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string; err?: string }> }) {
  const { id } = await params;
  const { msg, err } = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const inv = db.invoices.find((x) => x.id === id);
  if (!inv) notFound();
  // ほかの店舗の記録は閲覧のみ (見られる範囲は閲覧の範囲の設定と案件の進み具合。承認制で申請できるときはお客様の画面の「閲覧の申請」へ。src/lib/case-access.ts)
  const info = invoiceAccessInfo(db, user, inv);
  if (info.access === "none") redirect(deniedHref(info, "/invoices", "請求書"));
  const viewOnly = info.access === "view";
  logRecordView(user, info, { entity: "invoice", id: inv.id, label: inv.number, storeId: inv.storeId }, db.auditLogs);
  const today = toDateKey(new Date());
  const status = (inv.status === "issued" || inv.status === "partially_paid") && inv.dueDate < today ? "overdue" : inv.status;
  const customer = db.customers.find((c) => c.id === inv.customerId);
  const order = db.orders.find((o) => o.id === inv.orderId);
  // まとめ請求 (締め日ごとに複数の案件を 1 枚に。src/lib/billing.ts): 案件ごとの行と、入金の割り当て (売上計上日の古い順)
  const batch = isBatchInvoice(inv);
  const batchAlloc = batch ? allocatePaid(inv, inv.paidAmount) : undefined;
  const quote = order && !batch ? db.quotes.find((q) => q.id === order.quoteId) : undefined;
  const payments = db.payments.filter((p) => p.invoiceId === inv.id).sort((a, b) => b.date.localeCompare(a.date));
  const remaining = inv.total - inv.paidAmount;
  const comms = db.commLogs.filter((c) => c.relatedType === "invoice" && c.relatedId === inv.id);
  const returnTo = `/invoices/${inv.id}`;
  const open = inv.status !== "void" && inv.status !== "paid";

  return (
    <div>
      <Flash msg={msg} err={err} />
      <PageHeader
        title={`${inv.number} ${customerName(inv.customerId)} 様`}
        badge={<StatusBadge value={status} map={INVOICE_STATUS} />}
        description={<span className="inline-flex flex-wrap items-center gap-2"><StoreTag store={db.stores.find((s) => s.id === inv.storeId)} /> · 発行 {fmtDate(inv.issueDate)} · 支払期限 {fmtDate(inv.dueDate)}{batch ? ` · まとめ請求 (${inv.periodFrom ? `${fmtDate(inv.periodFrom)}〜` : ""}${fmtDate(inv.periodTo)} 締め)` : order?.salesDate ? ` · 売上計上日 ${fmtDate(order.salesDate)} (施工完了日)` : ""} · 発行者 {userName(inv.createdBy)}</span>}
        back={{ href: "/invoices", label: "請求・入金一覧" }}
        actions={
          // 帳票の出力は閲覧のみの社員もできる (お客様のご要望 2026-11-25「⑥」。出力の記録が残る)
          <>
            <PdfLink href={`/api/pdf/invoices/${inv.id}`} className={buttonClass("secondary", "sm")}>請求書 PDF</PdfLink>
            {!batch && order && inv.status !== "void" && <PdfLink href={`/api/pdf/delivery/${order.id}`} className={buttonClass("secondary", "sm")}>納品書 PDF</PdfLink>}
            {inv.status !== "void" && <LinkButton href="#receipts" variant="secondary" size="sm">領収書</LinkButton>}
            <LinkButton href={`/print/invoices/${inv.id}`} variant="ghost" size="sm">画面で表示・印刷</LinkButton>
          </>
        }
      />
      {viewOnly && <CaseViewBanner storeName={db.stores.find((x) => x.id === inv.storeId)?.name ?? "ほかの店舗"} what="案件の請求書" basis={info.basis} grantUntil={info.grantUntil} />}
      <ReadOnlyArea readOnly={viewOnly}>
      {status === "overdue" && <Note tone="warn">支払期限を {Math.round((new Date(today).getTime() - new Date(inv.dueDate).getTime()) / 86400000)} 日超過しています。督促の記録を残し、入金の予定を確認したら「入金予定」に登録してください。</Note>}

      <div className="mt-4 grid grid-cols-1 gap-4 @3xl:grid-cols-3">
        <div className="space-y-4 @3xl:col-span-2">
          <Card>
            <CardHeader title="請求内容" />
            <Dl columns={3} items={[["件名", inv.title ?? order?.title], ["小計 (税抜)", yen(inv.subtotal)], ["消費税", yen(inv.tax)], ["請求額 (税込)", <span key="t" className="font-semibold">{yen(inv.total)}</span>], ["入金額", yen(inv.paidAmount)], ["残高", <span key="r" className={remaining > 0 ? "font-semibold text-critical" : "font-semibold text-good-ink"}>{yen(remaining)}</span>], ["送付方法", inv.sentVia ? CHANNEL_LABEL[inv.sentVia] : "-"], ["受注", batch ? `${inv.orderIds?.length ?? 1} 件 (下の一覧)` : order ? <Link key="o" href={`/orders/${order.id}`} className="text-accent hover:underline">{order.number}</Link> : "-"], ["売上計上日", batch ? "案件ごとの施工完了日" : order?.salesDate ? fmtDate(order.salesDate) : "-"], ["見積", quote ? <Link key="q" href={`/quotes/${quote.id}`} className="text-accent hover:underline">{quote.number}</Link> : "-"], ["入金予定", inv.expectedDate ? `${fmtDate(inv.expectedDate)} · ${yen(inv.expectedAmount ?? remaining)}${inv.expectedNote ? ` · ${inv.expectedNote}` : ""}` : "-"], ["領収書の宛名", batch ? "お客様名 (まとめ請求)" : order?.receiptName ? <span key="rn">{order.receiptName} <Link href={`/orders/${order.id}`} className="text-xs text-accent hover:underline">変更</Link></span> : <span key="rn">お客様名 {order && <Link href={`/orders/${order.id}`} className="text-xs text-accent hover:underline">(受注で変更)</Link>}</span>]]} />
            {batch && inv.orderLines?.length ? (
              <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead><tr className="bg-subtle text-xs text-ink-2"><th className="px-3 py-1.5 text-left font-medium">受注番号</th><th className="px-3 py-1.5 text-left font-medium">件名・現場</th><th className="px-3 py-1.5 text-left font-medium">施工完了日</th><th className="px-3 py-1.5 text-right font-medium">金額 (税込)</th><th className="px-3 py-1.5 text-right font-medium">入金の割り当て</th></tr></thead>
                <tbody>{inv.orderLines.map((l) => <tr key={l.orderId} className="border-t border-line"><td className="px-3 py-1.5 font-mono text-xs"><Link href={`/orders/${l.orderId}`} className="text-accent hover:underline">{l.number}</Link></td><td className="px-3 py-1.5">{l.title}{l.site ? <span className="block text-[11px] text-ink-3">現場: {l.site}</span> : null}{l.noTax ? <span className="block text-[11px] text-ink-3">消費税の対象外</span> : null}</td><td className="px-3 py-1.5 text-xs tnum">{fmtDate(l.salesDate ?? l.completedAt)}</td><td className="px-3 py-1.5 text-right tnum">{yen(l.amount)}</td><td className="px-3 py-1.5 text-right text-xs tnum text-ink-2">{yen(batchAlloc?.get(l.orderId) ?? 0)}</td></tr>)}</tbody>
              </table>
              </div>
            ) : (inv.items ?? quote?.items) && (
              <table className="mt-4 w-full text-sm">
                <thead><tr className="bg-subtle text-xs text-ink-2"><th className="px-3 py-1.5 text-left font-medium">品名</th><th className="px-3 py-1.5 text-right font-medium">数量</th><th className="px-3 py-1.5 text-right font-medium">金額 (税抜)</th></tr></thead>
                <tbody>{(inv.items ?? quote?.items ?? []).map((i) => <tr key={i.id} className="border-t border-line"><td className="px-3 py-1.5">{i.name}{i.spec ? <span className="ml-1 text-xs text-ink-3">{i.spec}</span> : null}</td><td className="px-3 py-1.5 text-right tnum">{i.qty} {i.unit}</td><td className="px-3 py-1.5 text-right tnum">{yen(i.amount)}</td></tr>)}</tbody>
              </table>
            )}
            {inv.notes && <p className="mt-3 text-xs text-ink-2">備考: {inv.notes}</p>}
            <div className="mt-3"><RecordStamp db={db} targets={[{ entity: "invoice", id: inv.id }, { entity: "payment", id: inv.id }]} created={{ by: inv.createdBy, at: inv.createdAt }} /></div>
          </Card>

          {remaining > 0 && inv.status !== "void" && (
            <Card id="payment">
              <CardHeader title="入金を登録" description="現金・振込・カード・PayPay など。登録すると売掛残高と案件の状態に反映され、現金は店舗の現金出納帳にも記帳します" />
              <form action={recordPayment.bind(null, inv.id)} className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @5xl:grid-cols-4">
                <Field label="入金日"><Input type="date" name="date" defaultValue={today} /></Field>
                <Field label="金額"><Input type="number" name="amount" defaultValue={inv.expectedAmount ?? remaining} min={1} max={remaining} /></Field>
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

          {open && (
            <Card>
              <CardHeader title="入金予定" description="お客様と約束した入金日・金額を登録すると、入出金の予定・顧客別の請求状況に表示されます (入金を登録すると自動で消えます)" />
              <form action={updateExpectedPayment.bind(null, inv.id)} className="grid grid-cols-1 gap-3 @xl:grid-cols-4">
                <Field label="入金予定日" required><Input type="date" name="expectedDate" defaultValue={inv.expectedDate} /></Field>
                <Field label="入金予定額" hint="空欄は残高の全額"><Input type="number" name="expectedAmount" min={0} max={remaining} defaultValue={inv.expectedAmount} /></Field>
                <Field label="メモ" className="@xl:col-span-2"><Input name="expectedNote" defaultValue={inv.expectedNote} placeholder="例: 月末に振込とお電話あり" /></Field>
                <div className="flex flex-wrap gap-2 @xl:col-span-4">
                  <Button type="submit" size="sm" name="intent" value="save" variant="secondary">{inv.expectedDate ? "入金予定を変更" : "入金予定を登録"}</Button>
                  {inv.expectedDate && <Button type="submit" size="sm" name="intent" value="clear" variant="ghost">入金予定を取り消す</Button>}
                </div>
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
                        <input type="hidden" name="returnTo" value={returnTo} />
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

          {inv.status !== "void" && (
            <SendDocumentCard
              kind="invoice"
              id={inv.id}
              number={inv.number}
              customer={customer}
              defaultMessage={`${customer?.name ?? ""} 様\n\nいつもお世話になっております。株式会社一畳屋です。\nご請求書 (${inv.number} / ご請求額 ${yen(inv.total)}) をお送りいたします。\nお支払期限: ${fmtDate(inv.dueDate)}\n\nご不明な点がございましたら、お気軽にお問い合わせください。`}
            />
          )}
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title="お客様" />
            {customer && <Dl columns={1} items={[["氏名", <Link key="n" href={`/customers/${customer.id}`} className="text-accent hover:underline">{customer.name}</Link>], ["電話", customer.phone], ["メール", customer.email ?? "-"], ["住所", customer.address], ["希望連絡手段", CHANNEL_LABEL[customer.preferredChannel]]]} />}
          </Card>
          {inv.status !== "void" && (
            <Card>
              <CardHeader title={status === "overdue" ? "督促・送付の記録" : "送付の記録"} description="郵送・手渡し・電話での督促など、システムの外で行った送付も記録します" />
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
              <div className="mt-3 border-t border-line pt-2">
                <ContactList db={db} logs={comms} showParty={false} returnTo={returnTo} empty="送付・督促の記録はありません" />
              </div>
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
          <RecordDocDrafts db={db} user={user} type="invoice" id={inv.id} number={inv.number} />
          <HistoryCard db={db} user={user} targets={[{ entity: "invoice", id: inv.id }, { entity: "payment", id: inv.id }]} />
        </div>
      </div>
      </ReadOnlyArea>
      {/* 領収書の発行・印刷は閲覧のみの社員もできる (現場で集金した社員。お客様のご要望 2026-11-25「⑥」「⑧」) */}
      <div className="mt-4">
        <ReceiptsCard db={db} user={user} inv={inv} returnTo={returnTo} />
      </div>
    </div>
  );
}
