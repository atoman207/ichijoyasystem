import Link from "@/components/ui/Link";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canAccessStore, canApprove, canCancelApproval } from "@/lib/auth/permissions";
import { quoteChain, userName } from "@/lib/db/queries";
import { convertQuoteToOrder, deleteQuote, markQuoteLost, sendQuote, submitQuote } from "@/lib/actions/quotes";
import { decideApproval, cancelApproval } from "@/lib/actions/approvals";
import { fmtDate, fmtDateTime, yen } from "@/lib/format";
import { APPROVAL_STATUS, APPROVAL_TYPE_LABEL, CATEGORY_LABEL, CHANNEL_LABEL, INVOICE_STATUS, ORDER_STATUS, QUOTE_STATUS } from "@/lib/constants";
import { Badge, Button, Card, CardHeader, Dl, Field, Flash, Input, LinkButton, Note, PageHeader, Select, StatusBadge, StoreTag } from "@/components/ui";
import { CaseScheduleCard } from "@/components/schedule/CaseSchedule";
import { caseEvents } from "@/lib/db/schedule";
import { toDateKey } from "@/lib/format";

export default async function QuoteDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string; err?: string }> }) {
  const { id } = await params;
  const { msg, err } = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const q = db.quotes.find((x) => x.id === id);
  if (!q) notFound();
  if (!canAccessStore(user, q.storeId)) redirect("/quotes?err=" + encodeURIComponent("この見積を閲覧する権限がありません。"));
  const customer = db.customers.find((c) => c.id === q.customerId);
  const store = db.stores.find((s) => s.id === q.storeId);
  const chain = quoteChain(db, q);
  const pending = chain.approvals.find((a) => a.status === "pending" && (a.type === "quote" || a.type === "quote_amend"));
  const canDecide = pending ? canApprove(user, pending) : false;
  const workers = db.users.filter((u) => u.active && u.storeId === q.storeId);
  const returnTo = `/quotes/${id}`;
  const doc = db.documents.find((d) => d.id === q.documentId);

  return (
    <div>
      <Flash msg={msg} err={err} />
      <PageHeader
        title={`${q.number}${q.version > 1 ? ` (v${q.version})` : ""} ${q.title}`}
        badge={<><StatusBadge value={q.status} map={QUOTE_STATUS} />{q.pendingChange && <Badge tone="warn">金額変更 承認待ち</Badge>}{q.source === "ocr" && <Badge tone="accent" dot={false}>手書き見積から取込</Badge>}</>}
        description={<span className="inline-flex flex-wrap items-center gap-2">{customer?.name} 様 · {CATEGORY_LABEL[q.category]} · <StoreTag store={store} /> · 作成 {userName(q.createdBy)} {fmtDate(q.createdAt)}</span>}
        back={{ href: "/quotes", label: "見積一覧" }}
        actions={
          <>
            <LinkButton href={`/print/quotes/${q.id}`} variant="secondary" size="sm">見積書を表示・印刷</LinkButton>
            {["draft", "approved", "sent", "accepted"].includes(q.status) && !q.pendingChange && <LinkButton href={`/quotes/${q.id}/edit`} variant="secondary" size="sm">{q.status === "draft" ? "編集" : "金額変更を申請"}</LinkButton>}
          </>
        }
      />

      {q.status === "pending_approval" && pending && (
        <Card className="mb-4 border-warn/40 bg-warn-soft/40">
          <CardHeader title={`承認待ち: ${APPROVAL_TYPE_LABEL[pending.type]}`} description={`${pending.requiredRole === "admin" ? "管理者" : "店長"}の承認が必要 · 申請 ${userName(pending.requestedBy)} ${fmtDateTime(pending.createdAt)}${pending.requestComment ? ` · ${pending.requestComment}` : ""}`} />
          {canDecide ? (
            <form className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="returnTo" value={returnTo} />
              <Field label="コメント (任意)" className="w-full @xl:w-80"><Input name="comment" placeholder="例: 値引き幅を確認済み" /></Field>
              <Button type="submit" formAction={decideApproval.bind(null, pending.id, "approved")}>承認する</Button>
              <Button type="submit" variant="danger" formAction={decideApproval.bind(null, pending.id, "rejected")}>差し戻す</Button>
            </form>
          ) : (
            <form className="flex items-center gap-3">
              <input type="hidden" name="returnTo" value={returnTo} />
              <p className="text-sm text-ink-2">承認者の確認を待っています。</p>
              {canCancelApproval(user, pending) && <Button type="submit" variant="ghost" size="sm" formAction={cancelApproval.bind(null, pending.id)}>申請を取り下げる</Button>}
            </form>
          )}
        </Card>
      )}

      {q.pendingChange && pending?.type === "quote_amend" && (
        <Card className="mb-4 border-warn/40">
          <CardHeader title="承認待ちの変更内容" description={`申請 ${userName(q.pendingChange.requestedBy)} ${fmtDateTime(q.pendingChange.requestedAt)} · 理由: ${q.pendingChange.reason}`} />
          <div className="grid grid-cols-1 gap-4 @xl:grid-cols-2">
            <div>
              <div className="mb-1 text-xs font-medium text-ink-3">変更前 (現在) · 合計 {yen(q.total)}</div>
              <ul className="space-y-0.5 text-xs text-ink-2">{q.items.map((i) => <li key={i.id}>{i.name} × {i.qty}{i.unit} = {yen(i.amount)}</li>)}</ul>
            </div>
            <div>
              <div className="mb-1 text-xs font-medium text-warn-ink">変更後 (案) · 合計 {yen(q.pendingChange.total)}</div>
              <ul className="space-y-0.5 text-xs text-ink">{q.pendingChange.items.map((i, idx) => <li key={idx}>{i.name} × {i.qty}{i.unit} = {yen(i.amount)}</li>)}</ul>
            </div>
          </div>
          {canDecide ? (
            <form className="mt-4 flex flex-wrap items-end gap-2">
              <input type="hidden" name="returnTo" value={returnTo} />
              <Field label="コメント (任意)" className="w-full @xl:w-80"><Input name="comment" /></Field>
              <Button type="submit" formAction={decideApproval.bind(null, pending.id, "approved")}>変更を承認する</Button>
              <Button type="submit" variant="danger" formAction={decideApproval.bind(null, pending.id, "rejected")}>却下する</Button>
            </form>
          ) : (
            <p className="mt-3 text-xs text-ink-3">{pending.requiredRole === "admin" ? "管理者" : "店長"}の承認待ちです。</p>
          )}
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 @3xl:grid-cols-3">
        <div className="space-y-4 @3xl:col-span-2">
          <Card padded={false}>
            <div className="px-5 pt-5"><CardHeader title="明細" description={`有効期限 ${fmtDate(q.validUntil)}${q.issuedAt ? ` · 発行 ${fmtDate(q.issuedAt)}` : ""}${q.sentVia ? ` · 送付: ${CHANNEL_LABEL[q.sentVia]}` : ""}`} /></div>
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-subtle text-xs text-ink-2">
                  <th className="px-5 py-2 text-left font-medium">品名</th>
                  <th className="px-3 py-2 text-left font-medium">仕様</th>
                  <th className="px-3 py-2 text-right font-medium">数量</th>
                  <th className="px-3 py-2 text-right font-medium">単価</th>
                  <th className="px-5 py-2 text-right font-medium">金額</th>
                </tr>
              </thead>
              <tbody>
                {q.items.map((i) => (
                  <tr key={i.id} className="border-t border-line">
                    <td className="px-5 py-2">{i.name}</td>
                    <td className="px-3 py-2 text-xs text-ink-2">{i.spec ?? "-"}</td>
                    <td className="px-3 py-2 text-right tnum">{i.qty} {i.unit}</td>
                    <td className="px-3 py-2 text-right tnum">{yen(i.unitPrice)}</td>
                    <td className="px-5 py-2 text-right tnum">{yen(i.amount)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="text-sm">
                <tr className="border-t border-line"><td colSpan={4} className="px-5 py-1.5 text-right text-ink-2">小計 (税抜)</td><td className="px-5 py-1.5 text-right tnum">{yen(q.subtotal)}</td></tr>
                {q.discount > 0 && <tr><td colSpan={4} className="px-5 py-1.5 text-right text-ink-2">値引き</td><td className="px-5 py-1.5 text-right tnum">-{yen(q.discount)}</td></tr>}
                <tr><td colSpan={4} className="px-5 py-1.5 text-right text-ink-2">消費税 (10%)</td><td className="px-5 py-1.5 text-right tnum">{yen(q.tax)}</td></tr>
                <tr className="border-t border-line font-semibold"><td colSpan={4} className="px-5 py-2 text-right">合計 (税込)</td><td className="px-5 py-2 text-right text-base tnum">{yen(q.total)}</td></tr>
              </tfoot>
            </table>
            {q.notes && <p className="border-t border-line px-5 py-3 text-xs text-ink-2">備考: {q.notes}</p>}
          </Card>

          {/* アクション */}
          {q.status === "draft" && (
            <Card>
              <CardHeader title="次のステップ" description="内容を確認して承認を申請してください" />
              <form className="flex flex-wrap gap-2">
                <Button type="submit" formAction={submitQuote.bind(null, q.id)}>承認を申請する</Button>
                <Button type="submit" variant="danger" formAction={deleteQuote.bind(null, q.id)}>下書きを削除</Button>
              </form>
            </Card>
          )}
          {(q.status === "approved" || q.status === "sent") && !q.orderId && (
            <div className="grid grid-cols-1 gap-4 @2xl:grid-cols-2">
              <Card>
                <CardHeader title="お客様へ送付" description="送付手段は相手に合わせて選択。送付の記録は顧客のやりとり履歴に残ります" />
                <form action={sendQuote.bind(null, q.id)} className="flex flex-wrap items-end gap-2">
                  <Field label="送付手段">
                    <Select name="channel" defaultValue={customer?.preferredChannel === "visit" ? "mail" : customer?.preferredChannel ?? "email"}>
                      {(["email", "line", "chatwork", "mail", "phone", "visit"] as const).map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>)}
                    </Select>
                  </Field>
                  <Button type="submit" variant={q.status === "sent" ? "secondary" : "primary"}>{q.status === "sent" ? "再送付を記録" : "送付を記録"}</Button>
                </form>
              </Card>
              <Card>
                <CardHeader title="受注 (契約) 登録" description="お客様の承諾後に登録。契約は承認後に確定します" />
                <form action={convertQuoteToOrder.bind(null, q.id)} className="space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="施工予定日"><Input type="date" name="scheduledStart" /></Field>
                    <Field label="施工担当">
                      <Select name="workerIds">
                        {workers.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                      </Select>
                    </Field>
                  </div>
                  <Field label="メモ"><Input name="note" placeholder="例: LINE で正式依頼あり" /></Field>
                  <div className="flex gap-2">
                    <Button type="submit">受注登録 (契約承認を申請)</Button>
                    <Button type="submit" variant="danger" formAction={markQuoteLost.bind(null, q.id)}>失注</Button>
                  </div>
                </form>
              </Card>
            </div>
          )}
          {q.status === "pending_approval" && !canDecide && <Note>承認されると「お客様へ送付」「受注登録」が行えるようになります。</Note>}

          <CaseScheduleCard
            events={caseEvents(db, { inquiryId: q.inquiryId, quoteId: q.id, orderId: chain.order?.id })}
            allEvents={db.schedule}
            users={new Map(db.users.map((u) => [u.id, u]))}
            stores={new Map(db.stores.map((s) => [s.id, s]))}
            today={toDateKey(new Date())}
            newParams={chain.order ? `orderId=${chain.order.id}` : `quoteId=${q.id}`}
            returnTo={returnTo}
            quickKinds={chain.order ? ["pickup", "delivery", "install", "visit"] : ["visit", "measure", "survey"]}
            canAdd={!["rejected", "expired"].includes(q.status)}
            description="見積の説明・再採寸などの訪問を担当者つきで登録すると、店舗の共通カレンダーに自動で反映されます。問い合わせ段階の現地調査も表示します"
          />
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title="お客様" />
            {customer && (
              <Dl columns={1} items={[["氏名", <Link key="n" href={`/customers/${customer.id}`} className="text-accent hover:underline">{customer.name}</Link>], ["電話", customer.phone], ["住所", customer.address], ["希望連絡手段", CHANNEL_LABEL[customer.preferredChannel]]]} />
            )}
          </Card>
          <Card>
            <CardHeader title="関連情報" description="問い合わせ → 見積 → 受注 → 請求 → 入金" />
            <ul className="space-y-2 text-sm">
              <li>問い合わせ: {chain.inquiry ? <Link href={`/inquiries/${chain.inquiry.id}`} className="text-accent hover:underline">{chain.inquiry.number}</Link> : <span className="text-ink-3">-</span>}</li>
              <li>受注: {chain.order ? <><Link href={`/orders/${chain.order.id}`} className="text-accent hover:underline">{chain.order.number}</Link> <StatusBadge value={chain.order.status} map={ORDER_STATUS} /></> : <span className="text-ink-3">未登録</span>}</li>
              <li>請求: {chain.invoice ? <><Link href={`/invoices/${chain.invoice.id}`} className="text-accent hover:underline">{chain.invoice.number}</Link> <StatusBadge value={chain.invoice.status} map={INVOICE_STATUS} /></> : <span className="text-ink-3">-</span>}</li>
              <li>入金: {chain.payments.length > 0 ? `${chain.payments.length} 件 / ${yen(chain.payments.reduce((a, p) => a + p.amount, 0))}` : <span className="text-ink-3">-</span>}</li>
              {doc && <li>取込書類: <Link href={`/capture?doc=${doc.id}`} className="text-accent hover:underline">{doc.fileName}</Link></li>}
            </ul>
          </Card>
          <Card>
            <CardHeader title="承認履歴" />
            <ul className="space-y-2 text-xs">
              {chain.approvals.filter((a) => a.targetId === q.id).map((a) => (
                <li key={a.id} className="rounded-lg border border-line p-2">
                  <div className="flex items-center justify-between gap-2"><span className="font-medium">{APPROVAL_TYPE_LABEL[a.type]}</span><StatusBadge value={a.status} map={APPROVAL_STATUS} /></div>
                  <div className="mt-1 text-ink-3">申請 {userName(a.requestedBy)} {fmtDateTime(a.createdAt)}</div>
                  {a.decidedBy && <div className="text-ink-3">{a.status === "approved" ? "承認" : "判断"} {userName(a.decidedBy)} {fmtDateTime(a.decidedAt)}{a.decisionComment ? ` · ${a.decisionComment}` : ""}</div>}
                </li>
              ))}
              {chain.approvals.filter((a) => a.targetId === q.id).length === 0 && <li className="text-ink-3">履歴はありません</li>}
            </ul>
          </Card>
          <Card>
            <CardHeader title="変更履歴" />
            <ul className="space-y-1.5 text-xs">
              {db.auditLogs.filter((l) => l.entity === "quote" && l.entityId === q.id).reverse().map((l) => (
                <li key={l.id}><span className="text-ink-3 tnum">{fmtDateTime(l.at)}</span> {l.summary} <span className="text-ink-3">({userName(l.userId)})</span></li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
