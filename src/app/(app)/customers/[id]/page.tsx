import Link from "@/components/ui/Link";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canAccessStore } from "@/lib/auth/permissions";
import { customerTimeline, userName } from "@/lib/db/queries";
import { addCommLog } from "@/lib/actions/customers";
import { fmtDate, fmtDateTime, yen } from "@/lib/format";
import { CHANNEL_LABEL, INQUIRY_STATUS, INVOICE_STATUS, ORDER_STATUS, QUOTE_STATUS } from "@/lib/constants";
import { Badge, Button, Card, CardHeader, ChannelTag, Dl, Field, Flash, Input, LinkButton, PageHeader, Select, Stat, StatusBadge, StoreTag, Textarea } from "@/components/ui";
import { CaseScheduleCard } from "@/components/schedule/CaseSchedule";
import { toDateKey } from "@/lib/format";

export default async function CustomerDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string; err?: string }> }) {
  const { id } = await params;
  const { msg, err } = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const c = db.customers.find((x) => x.id === id);
  if (!c) notFound();
  if (!canAccessStore(user, c.storeId)) redirect("/customers?err=" + encodeURIComponent("この顧客を閲覧する権限がありません。"));
  const t = customerTimeline(db, id);
  const store = db.stores.find((s) => s.id === c.storeId);
  const openItems = t.inquiries.filter((i) => ["new", "in_progress", "quoted"].includes(i.status)).length + t.orders.filter((o) => ["pending_approval", "confirmed", "scheduled", "in_progress"].includes(o.status)).length;
  const receivable = t.invoices.filter((i) => ["issued", "partially_paid", "overdue"].includes(i.status)).reduce((a, i) => a + i.total - i.paidAmount, 0);

  return (
    <div>
      <Flash msg={msg} err={err} />
      <PageHeader
        title={c.name}
        badge={<span className="flex gap-1">{c.type === "corporate" && <Badge tone="info" dot={false}>法人・施設</Badge>}{c.tags.map((tag) => <Badge key={tag} dot={false}>{tag}</Badge>)}</span>}
        description={`${c.code} · ${c.kana} · 担当 ${userName(c.assignedUserId)} · 登録 ${fmtDate(c.createdAt)}`}
        back={{ href: "/customers", label: "顧客一覧" }}
        actions={
          <>
            <LinkButton href={`/inquiries/new?customerId=${c.id}`} variant="secondary" size="sm">+ 問い合わせ</LinkButton>
            <LinkButton href={`/quotes/new?customerId=${c.id}`} variant="secondary" size="sm">+ 見積</LinkButton>
            <LinkButton href={`/customers/${c.id}/edit`} size="sm">編集</LinkButton>
          </>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 @3xl:grid-cols-4">
        <Stat label="累計売上 (税込)" value={yen(t.lifetime)} />
        <Stat label="案件数 (受注)" value={`${t.orders.length} 件`} sub={`見積 ${t.quotes.length} 件 · 問い合わせ ${t.inquiries.length} 件`} />
        <Stat label="進行中" value={`${openItems} 件`} />
        <Stat label="未入金" value={yen(receivable)} tone={receivable > 0 ? "warn" : undefined} />
      </div>

      <div className="grid grid-cols-1 gap-4 @3xl:grid-cols-3">
        <div className="space-y-4 @3xl:col-span-1">
          <Card>
            <CardHeader title="基本情報" />
            <Dl
              columns={1}
              items={[
                ["電話", c.phone],
                ["メール", c.email],
                ["LINE", c.lineId ?? "未登録"],
                ["希望する連絡手段", CHANNEL_LABEL[c.preferredChannel]],
                ["初回接点", CHANNEL_LABEL[c.firstContactChannel]],
                ["住所", `〒${c.postalCode} ${c.address}`],
                ["担当店舗", <StoreTag key="s" store={store} />],
                ["備考", c.notes || "-"],
              ]}
            />
          </Card>
          <Card>
            <CardHeader title="対応履歴を記録" description="電話・LINE・メール・来店など、どの手段でのやりとりも一元化" />
            <form action={addCommLog.bind(null, c.id)} className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <Field label="手段">
                  <Select name="channel" defaultValue={c.preferredChannel}>
                    {(Object.keys(CHANNEL_LABEL) as (keyof typeof CHANNEL_LABEL)[]).map((k) => (
                      <option key={k} value={k}>{CHANNEL_LABEL[k]}</option>
                    ))}
                  </Select>
                </Field>
                <Field label="方向">
                  <Select name="direction" defaultValue="outbound">
                    <option value="outbound">こちらから連絡</option>
                    <option value="inbound">お客様から連絡</option>
                  </Select>
                </Field>
              </div>
              <Field label="件名">
                <Input name="subject" placeholder="例: 施工日の確認" />
              </Field>
              <Field label="内容" required>
                <Textarea name="body" required placeholder="やりとりの内容" />
              </Field>
              <Button type="submit" size="sm">記録する</Button>
            </form>
          </Card>
        </div>

        <div className="space-y-4 @3xl:col-span-2">
          <Card>
            <CardHeader title="案件の流れ" description="問い合わせ → 見積 → 受注・施工 → 請求 → 入金 がすべて紐づきます" />
            {t.quotes.length === 0 && t.inquiries.length === 0 && <p className="text-sm text-ink-3">まだ案件はありません</p>}
            <div className="space-y-3">
              {t.inquiries
                .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
                .map((inq) => {
                  const quote = t.quotes.find((q) => q.id === inq.quoteId);
                  const order = quote ? t.orders.find((o) => o.quoteId === quote.id) : undefined;
                  const invoice = order ? t.invoices.find((i) => i.orderId === order.id) : undefined;
                  return (
                    <div key={inq.id} className="rounded-lg border border-line p-3">
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <ChannelTag channel={inq.channel} />
                        <Link href={`/inquiries/${inq.id}`} className="font-medium text-ink hover:text-accent">{inq.summary}</Link>
                        <StatusBadge value={inq.status} map={INQUIRY_STATUS} />
                        <span className="text-xs text-ink-3">{fmtDate(inq.receivedAt)}</span>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs">
                        <span>見積: {quote ? <Link href={`/quotes/${quote.id}`} className="text-accent hover:underline">{quote.number} {yen(quote.total)}</Link> : <span className="text-ink-3">未作成</span>}{quote && <> <StatusBadge value={quote.status} map={QUOTE_STATUS} /></>}</span>
                        <span>受注: {order ? <Link href={`/orders/${order.id}`} className="text-accent hover:underline">{order.number}</Link> : <span className="text-ink-3">-</span>}{order && <> <StatusBadge value={order.status} map={ORDER_STATUS} /></>}</span>
                        <span>請求: {invoice ? <Link href={`/invoices/${invoice.id}`} className="text-accent hover:underline">{invoice.number}</Link> : <span className="text-ink-3">-</span>}{invoice && <> <StatusBadge value={invoice.status} map={INVOICE_STATUS} /></>}</span>
                      </div>
                    </div>
                  );
                })}
              {t.quotes
                .filter((q) => !q.inquiryId || !t.inquiries.some((i) => i.id === q.inquiryId))
                .map((q) => (
                  <div key={q.id} className="rounded-lg border border-line p-3 text-sm">
                    見積 <Link href={`/quotes/${q.id}`} className="text-accent hover:underline">{q.number} {q.title}</Link> <StatusBadge value={q.status} map={QUOTE_STATUS} /> <span className="tnum">{yen(q.total)}</span>
                  </div>
                ))}
            </div>
          </Card>

          <Card>
            <CardHeader title="外部とのやりとり履歴" description={`${t.comms.length} 件 · 担当者が変わっても経緯を把握できます`} />
            <ul className="divide-y divide-line">
              {t.comms.slice(0, 15).map((cl) => (
                <li key={cl.id} className="py-2.5">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
                    <span className="tnum">{fmtDateTime(cl.at)}</span>
                    <ChannelTag channel={cl.channel} />
                    <Badge tone={cl.direction === "inbound" ? "info" : "neutral"} dot={false}>{cl.direction === "inbound" ? "受信" : "送信"}</Badge>
                    <span>{userName(cl.userId)}</span>
                  </div>
                  <div className="mt-1 text-sm font-medium text-ink">{cl.subject}</div>
                  <div className="text-sm text-ink-2">{cl.body}</div>
                </li>
              ))}
              {t.comms.length === 0 && <li className="py-4 text-sm text-ink-3">履歴はありません</li>}
            </ul>
          </Card>

          {(db.photoAlbums.some((a) => a.customerId === c.id) || db.surveys.some((x) => x.customerId === c.id)) && (
            <Card>
              <CardHeader title="現場写真・お客様アンケート" description="現場写真は Google ドライブのフォルダ、アンケートはハガキの回答から" />
              <ul className="divide-y divide-line text-sm">
                {db.photoAlbums
                  .filter((a) => a.customerId === c.id)
                  .map((a) => (
                    <li key={a.id} className="flex flex-wrap items-center gap-2 py-2">
                      <Badge tone="accent" dot={false}>写真 {a.photoCount} 枚</Badge>
                      <span className="text-ink">{a.title}</span>
                      {a.driveUrl && (
                        <a href={a.driveUrl} target="_blank" rel="noreferrer" className="ml-auto text-xs font-medium text-accent hover:underline">
                          ドライブで開く
                        </a>
                      )}
                    </li>
                  ))}
                {db.surveys
                  .filter((x) => x.customerId === c.id)
                  .map((x) => (
                    <li key={x.id} className="py-2 text-xs text-ink-2">
                      <span className="font-medium text-ink">アンケート {fmtDate(x.receivedAt)}</span> · 電話 {x.phoneScore ?? "-"} / 営業 {x.salesScore ?? "-"} / 職人 {x.craftsmanScore ?? "-"} / 仕上り {x.finishScore ?? "-"}
                      {x.priorities && <> · 重視: {x.priorities}</>}
                      {x.media && <> · 媒体: {x.media}</>}
                    </li>
                  ))}
              </ul>
            </Card>
          )}

          <CaseScheduleCard
            title="予定"
            description="このお客様の案件の予定 (現地調査・採寸・引き取り・納品・施工・訪問)。登録すると担当者とともに店舗の共通カレンダーに反映されます"
            events={t.events}
            allEvents={db.schedule}
            users={new Map(db.users.map((u) => [u.id, u]))}
            stores={new Map(db.stores.map((s) => [s.id, s]))}
            today={toDateKey(new Date())}
            newParams={`customerId=${c.id}`}
            returnTo={`/customers/${c.id}`}
            quickKinds={["visit", "survey", "measure"]}
            canAdd
          />
        </div>
      </div>
    </div>
  );
}
