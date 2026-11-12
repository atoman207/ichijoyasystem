import Link from "@/components/ui/Link";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canAccessStore, canSeeAllStores } from "@/lib/auth/permissions";
import { userName } from "@/lib/db/queries";
import { registerCustomerFromInquiry, setInquiryStatus, updateInquiry } from "@/lib/actions/inquiries";
import { addCommLog } from "@/lib/actions/customers";
import { fmtDate, fmtDateTime, yen } from "@/lib/format";
import { CATEGORY_LABEL, CHANNEL_LABEL, INQUIRY_STATUS, ORDER_STATUS, QUOTE_STATUS } from "@/lib/constants";
import { Badge, Button, Card, CardHeader, ChannelTag, Dl, Field, Flash, Input, LinkButton, Note, PageHeader, Select, StatusBadge, StoreTag, Textarea } from "@/components/ui";
import { CaseScheduleCard } from "@/components/schedule/CaseSchedule";
import { caseEvents } from "@/lib/db/schedule";
import { toDateKey } from "@/lib/format";

export default async function InquiryDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string; err?: string }> }) {
  const { id } = await params;
  const { msg, err } = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const inq = db.inquiries.find((x) => x.id === id);
  if (!inq) notFound();
  if (!canAccessStore(user, inq.storeId)) redirect("/inquiries?err=" + encodeURIComponent("この問い合わせを閲覧する権限がありません。"));
  const customer = db.customers.find((c) => c.id === inq.customerId);
  const quote = db.quotes.find((q) => q.id === inq.quoteId);
  const order = quote ? db.orders.find((o) => o.quoteId === quote.id) : undefined;
  const store = db.stores.find((s) => s.id === inq.storeId);
  const users = db.users.filter((u) => u.active && (canSeeAllStores(user) || u.storeId === inq.storeId));
  const comms = customer ? db.commLogs.filter((c) => c.customerId === customer.id && (c.relatedId === inq.id || !c.relatedId)).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 10) : [];
  const logs = db.auditLogs.filter((l) => l.entity === "inquiry" && l.entityId === inq.id).reverse();
  const events = caseEvents(db, { inquiryId: inq.id, quoteId: quote?.id, orderId: order?.id });
  const caseParam = order ? `orderId=${order.id}` : quote ? `quoteId=${quote.id}` : `inquiryId=${inq.id}`;
  const open = !["lost", "closed"].includes(inq.status);

  return (
    <div>
      <Flash msg={msg} err={err} />
      <PageHeader
        title={inq.summary}
        badge={<StatusBadge value={inq.status} map={INQUIRY_STATUS} />}
        description={<span className="inline-flex flex-wrap items-center gap-2">{inq.number} · 受付 {fmtDateTime(inq.receivedAt)} · <ChannelTag channel={inq.channel} /> · {CATEGORY_LABEL[inq.category]} · <StoreTag store={store} /></span>}
        back={{ href: "/inquiries", label: "問い合わせ一覧" }}
        actions={
          <>
            {!quote && customer && <LinkButton href={`/quotes/new?customerId=${customer.id}&inquiryId=${inq.id}&category=${inq.category}`} size="sm">見積を作成</LinkButton>}
            {quote && <LinkButton href={`/quotes/${quote.id}`} size="sm" variant="secondary">見積 {quote.number} を開く</LinkButton>}
          </>
        }
      />

      {inq.channel === "ai_phone" && (
        <Note tone="accent">この問い合わせは AI 電話受付から自動登録されました。内容を確認し、担当者の割当と折返し対応を行ってください。顧客として登録すると、その後の見積・施工・請求まで情報が引き継がれます。</Note>
      )}

      <div className="mt-4 grid grid-cols-1 gap-4 @3xl:grid-cols-3">
        <div className="space-y-4 @3xl:col-span-2">
          <Card>
            <CardHeader title="問い合わせ内容" />
            <p className="whitespace-pre-wrap text-sm text-ink">{inq.detail || "(詳細なし)"}</p>
            <div className="mt-4">
              <Dl columns={3} items={[["お客様", inq.contactName], ["電話", inq.contactPhone ?? "-"], ["担当", userName(inq.assignedUserId)], ["登録者", userName(inq.createdBy)], ["次のアクション", inq.nextAction ?? "-"], ["期限", inq.nextActionDue ? fmtDate(inq.nextActionDue) : "-"]]} />
            </div>
          </Card>

          <CaseScheduleCard
            events={events}
            allEvents={db.schedule}
            users={new Map(db.users.map((u) => [u.id, u]))}
            stores={new Map(db.stores.map((s) => [s.id, s]))}
            today={toDateKey(new Date())}
            newParams={caseParam}
            returnTo={`/inquiries/${inq.id}`}
            quickKinds={order ? ["pickup", "delivery", "install", "visit"] : ["survey", "measure", "visit"]}
            canAdd={open || Boolean(order)}
            emptyText={open ? "まだ予定はありません。現地調査・採寸の日程が決まったら登録してください (未対応の問い合わせは「対応中」になります)" : "予定はありません"}
            description="現地調査・採寸・顧客訪問を担当者つきで登録すると、店舗の共通カレンダーに自動で反映されます。見積・受注に進んでも同じ案件の予定として引き継がれます"
          />

          <Card>
            <CardHeader title="対応を更新" description="状態・担当・次のアクションを変更すると、変更履歴に記録されます" />
            <form action={updateInquiry.bind(null, inq.id)} className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
              <Field label="状態">
                <Select name="status" defaultValue={inq.status}>
                  {(Object.keys(INQUIRY_STATUS) as (keyof typeof INQUIRY_STATUS)[]).map((s) => <option key={s} value={s}>{INQUIRY_STATUS[s].label}</option>)}
                </Select>
              </Field>
              <Field label="担当者">
                <Select name="assignedUserId" defaultValue={inq.assignedUserId}>
                  {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </Select>
              </Field>
              <Field label="種別">
                <Select name="category" defaultValue={inq.category}>
                  {(Object.keys(CATEGORY_LABEL) as (keyof typeof CATEGORY_LABEL)[]).map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
                </Select>
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="次のアクション"><Input name="nextAction" defaultValue={inq.nextAction} /></Field>
                <Field label="期限"><Input name="nextActionDue" type="date" defaultValue={inq.nextActionDue} /></Field>
              </div>
              <Field label="詳細" className="@xl:col-span-2"><Textarea name="detail" defaultValue={inq.detail} /></Field>
              <div className="flex flex-wrap gap-2 @xl:col-span-2">
                <Button type="submit" size="sm">更新する</Button>
                {inq.status === "new" && <Button type="submit" size="sm" variant="secondary" formAction={setInquiryStatus.bind(null, inq.id, "in_progress")}>対応を開始する</Button>}
                {["new", "in_progress", "quoted"].includes(inq.status) && <Button type="submit" size="sm" variant="danger" formAction={setInquiryStatus.bind(null, inq.id, "lost")}>失注にする</Button>}
                {["new", "in_progress"].includes(inq.status) && <Button type="submit" size="sm" variant="ghost" formAction={setInquiryStatus.bind(null, inq.id, "closed")}>完了 (見積不要)</Button>}
              </div>
            </form>
          </Card>

          {customer && (
            <Card>
              <CardHeader title="やりとりを記録" description="この問い合わせに関する電話・LINE・メールの内容" />
              <form action={addCommLog.bind(null, customer.id)} className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
                <input type="hidden" name="relatedType" value="inquiry" />
                <input type="hidden" name="relatedId" value={inq.id} />
                <input type="hidden" name="returnTo" value={`/inquiries/${inq.id}`} />
                <Field label="手段">
                  <Select name="channel" defaultValue={inq.channel === "ai_phone" ? "phone" : inq.channel}>
                    {(Object.keys(CHANNEL_LABEL) as (keyof typeof CHANNEL_LABEL)[]).map((k) => <option key={k} value={k}>{CHANNEL_LABEL[k]}</option>)}
                  </Select>
                </Field>
                <Field label="方向">
                  <Select name="direction" defaultValue="outbound">
                    <option value="outbound">こちらから連絡</option>
                    <option value="inbound">お客様から連絡</option>
                  </Select>
                </Field>
                <Field label="内容" className="@xl:col-span-2" required><Textarea name="body" required /></Field>
                <div className="@xl:col-span-2"><Button type="submit" size="sm">記録する</Button></div>
              </form>
              <ul className="mt-4 divide-y divide-line">
                {comms.map((c) => (
                  <li key={c.id} className="py-2 text-sm">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-ink-3"><span className="tnum">{fmtDateTime(c.at)}</span><ChannelTag channel={c.channel} /><Badge dot={false} tone={c.direction === "inbound" ? "info" : "neutral"}>{c.direction === "inbound" ? "受信" : "送信"}</Badge>{userName(c.userId)}</div>
                    <div className="mt-0.5 text-ink">{c.body}</div>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title="お客様" />
            {customer ? (
              <div className="text-sm">
                <Link href={`/customers/${customer.id}`} className="font-medium text-accent hover:underline">{customer.name}</Link>
                <div className="mt-1 text-xs text-ink-2">{customer.code} · {customer.phone}</div>
                <div className="text-xs text-ink-2">{customer.address || "住所未登録"}</div>
                <div className="mt-2 flex flex-wrap gap-1">{customer.tags.map((t) => <Badge key={t} dot={false}>{t}</Badge>)}</div>
              </div>
            ) : (
              <div>
                <p className="text-sm text-ink-2">{inq.contactName} 様はまだ顧客登録されていません。</p>
                <form action={registerCustomerFromInquiry.bind(null, inq.id)} className="mt-3">
                  <Button type="submit" size="sm">顧客として登録する</Button>
                </form>
              </div>
            )}
          </Card>
          <Card>
            <CardHeader title="この案件の進行" />
            <ol className="space-y-2 text-sm">
              <li className="flex items-center gap-2"><Badge tone="good">1</Badge> 問い合わせ <span className="text-xs text-ink-3">{fmtDate(inq.receivedAt)}</span></li>
              <li className="flex items-center gap-2"><Badge tone={quote ? "good" : "neutral"}>2</Badge> 見積 {quote ? <Link href={`/quotes/${quote.id}`} className="text-accent hover:underline">{quote.number}</Link> : <span className="text-xs text-ink-3">未作成</span>}{quote && <StatusBadge value={quote.status} map={QUOTE_STATUS} />}</li>
              <li className="flex items-center gap-2"><Badge tone={order ? "good" : "neutral"}>3</Badge> 受注・施工 {order ? <Link href={`/orders/${order.id}`} className="text-accent hover:underline">{order.number}</Link> : <span className="text-xs text-ink-3">-</span>}{order && <StatusBadge value={order.status} map={ORDER_STATUS} />}</li>
              <li className="flex items-center gap-2"><Badge tone={order?.invoiceId ? "good" : "neutral"}>4</Badge> 請求・入金 {order?.invoiceId ? <Link href={`/invoices/${order.invoiceId}`} className="text-accent hover:underline">請求書</Link> : <span className="text-xs text-ink-3">-</span>}</li>
            </ol>
            {quote && <p className="mt-3 text-xs text-ink-3">見積金額 {yen(quote.total)} (税込)</p>}
          </Card>
          <Card>
            <CardHeader title="変更履歴" />
            <ul className="space-y-2 text-xs">
              {logs.map((l) => (
                <li key={l.id}><span className="text-ink-3 tnum">{fmtDateTime(l.at)}</span> <span className="text-ink">{l.summary}</span> <span className="text-ink-3">({userName(l.userId)})</span></li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
