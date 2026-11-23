import Link from "@/components/ui/Link";
import { CaseViewBanner, ReadOnlyArea } from "@/components/features/CaseAccess";
import { customerAccessInfo, openCaseTimeline } from "@/lib/case-access";
import { accessPolicy, policyReader } from "@/lib/access-policy";
import { logRecordView } from "@/lib/record-views";
import { RecordViewRequest } from "@/components/features/RecordViewRequest";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canReadStoreRecords } from "@/lib/auth/permissions";
import { customerTimeline, userName } from "@/lib/db/queries";
import { fmtDate, fmtDateTime, yen } from "@/lib/format";
import { CHANNEL_LABEL, INQUIRY_STATUS, INVOICE_STATUS, ORDER_STATUS, QUOTE_STATUS } from "@/lib/constants";
import { Badge, Card, CardHeader, ChannelTag, Dl, Flash, LinkButton, PageHeader, Stat, StatusBadge, StoreTag } from "@/components/ui";
import { ApprovalDecision, ApprovalHistoryCard, HistoryCard, RecordStamp } from "@/components/features/History";
import { ContactList, ContactLogForm } from "@/components/features/Contacts";
import { AttachmentsCard } from "@/components/attachments/AttachmentsCard";
import { CaseScheduleCard } from "@/components/schedule/CaseSchedule";
import { toDateKey } from "@/lib/format";
import { findDuplicateCustomers } from "@/lib/duplicates";
import { AiSummary } from "@/components/features/AiSummary";
import { RecordDocDrafts } from "@/components/features/DocDrafts";
import { contactLabel, phoneDigits } from "@/lib/customer-contacts";
import { MapInfoCard } from "@/components/maps/MapInfoCard";
import { customerMedia, mediaIndex } from "@/lib/media";
import { MediaTag } from "@/components/ops-reports/MediaFields";

export default async function CustomerDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string; err?: string }> }) {
  const { id } = await params;
  const { msg, err } = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const c = db.customers.find((x) => x.id === id);
  if (!c) notFound();
  // ほかの店舗の顧客は閲覧のみ。見られる範囲は閲覧の範囲の設定 (src/lib/access-policy.ts) と案件の進み具合で決まる (src/lib/case-access.ts)
  const info = customerAccessInfo(db, user, c);
  const store = db.stores.find((s) => s.id === c.storeId);
  if (info.access === "none") {
    if (!info.canRequest) redirect("/customers?err=" + encodeURIComponent("この顧客を閲覧する権限がありません (ほかの店舗の案件は、入金が完了するまでの間だけ閲覧できます)。"));
    // 承認制: ほかの店舗の完了した案件のお客様は、上司の承認を受けてから見る
    return (
      <div>
        <Flash msg={msg} err={err} />
        <PageHeader title="閲覧の申請" back={{ href: "/customers", label: "顧客一覧" }} />
        <RecordViewRequest customerId={c.id} storeName={store?.name ?? "ほかの店舗"} pending={info.pending} grantDays={accessPolicy(db).grantDays} />
      </div>
    );
  }
  const viewOnly = info.access === "view";
  logRecordView(user, info, { entity: "customer", id: c.id, label: `${c.code} ${c.name}`, storeId: c.storeId }, db.auditLogs);
  // 進行中の案件だけで見ている人 (basis = open) には、進行中の案件だけを見せる。全社員に公開・閲覧の申請の承認のときは施工の履歴もすべて
  const t = viewOnly && info.basis === "open" ? openCaseTimeline(db, customerTimeline(db, id)) : customerTimeline(db, id);
  const openItems = t.inquiries.filter((i) => ["new", "in_progress", "quoted"].includes(i.status)).length + t.orders.filter((o) => ["pending_approval", "returned", "confirmed", "scheduled", "in_progress"].includes(o.status)).length;
  // 重複の可能性がある既存顧客 (電話・メール・氏名と住所の一致、同じ姓と地区)
  const dup = findDuplicateCustomers(db, { ...c, otherPhones: (c.contacts ?? []).map((x) => x.phone) }, c.id);
  const dupRows = [...dup.high.map((m) => ({ ...m, label: "重複の可能性が高い" })), ...dup.check.map((m) => ({ ...m, label: "要確認" }))];
  const receivable = t.invoices.filter((i) => ["issued", "partially_paid", "overdue"].includes(i.status)).reduce((a, i) => a + i.total - i.paidAmount, 0);
  const changeApprovals = db.approvals.filter((a) => a.type === "customer_change" && a.targetId === c.id);
  const pendingChange = changeApprovals.find((a) => a.status === "pending");
  const returnTo = `/customers/${c.id}`;
  const billed = t.invoices.filter((i) => i.status !== "void");
  // 媒体 (当社を知ったきっかけ。全社共通の分類): 最初の問い合わせ > 顧客の媒体 (販売管理ソフト) > 初回接点 (src/lib/media.ts)
  const media = customerMedia(mediaIndex(db), c, db.inquiries.filter((i) => i.customerId === c.id));

  return (
    <div>
      <Flash msg={msg} err={err} />
      <PageHeader
        title={c.name}
        badge={<span className="flex gap-1">{c.tradeStopped && <Badge tone="critical">取引停止</Badge>}{c.type === "corporate" && <Badge tone="info" dot={false}>法人・施設</Badge>}{c.tags.map((tag) => <Badge key={tag} dot={false}>{tag}</Badge>)}</span>}
        description={`${c.code} · ${c.kana} · 担当 ${userName(c.assignedUserId)} · 登録 ${fmtDate(c.createdAt)}`}
        back={{ href: "/customers", label: "顧客一覧" }}
        actions={
          viewOnly ? undefined : <>
            <LinkButton href={`/inquiries/new?customerId=${c.id}`} variant="secondary" size="sm">+ 問い合わせ</LinkButton>
            <LinkButton href={`/quotes/new?customerId=${c.id}`} variant="secondary" size="sm">+ 見積</LinkButton>
            <LinkButton href={`/customers/${c.id}/edit`} size="sm">編集</LinkButton>
          </>
        }
      />
      {viewOnly && <CaseViewBanner storeName={store?.name ?? "ほかの店舗"} what={info.basis === "open" ? "お客様の案件" : "お客様"} basis={info.basis} grantUntil={info.grantUntil} />}
      <ReadOnlyArea readOnly={viewOnly}>

      {c.tradeStopped && (
        <Card className="mb-4 border-critical/40 bg-critical-soft/40">
          <CardHeader title="このお客様は取引停止です" description={c.tradeStopNote ? `理由: ${c.tradeStopNote}` : "理由は登録されていません。見積・受注の前に店長・管理者に確認してください"} />
        </Card>
      )}
      {pendingChange && (
        <Card className="mb-4 border-warn/40 bg-warn-soft/40">
          <CardHeader title="承認待ち: 顧客の重要情報の変更" description={`${pendingChange.requiredRole === "admin" ? "管理者" : "店長"}の承認が必要 · 申請 ${userName(pendingChange.requestedBy)} ${fmtDateTime(pendingChange.createdAt)}${pendingChange.requestComment ? ` · 理由: ${pendingChange.requestComment}` : ""}`} />
          <ApprovalDecision approval={pendingChange} user={user} returnTo={returnTo} approveLabel="変更を承認する" />
        </Card>
      )}

      <div className="mb-6 grid grid-cols-2 gap-3 @3xl:grid-cols-4">
        <Stat label="累計売上 (税込)" value={viewOnly && info.basis === "open" ? "-" : yen(t.lifetime)} />
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
                ["電話", c.phone || "-"],
                ...(c.contacts?.length
                  ? ([
                      [
                        "ほかの連絡先",
                        <ul key="cc" className="space-y-0.5">
                          {c.contacts.map((x) => (
                            <li key={x.id}>
                              <span className="text-ink-2">{contactLabel(x)}</span> <a href={`tel:${phoneDigits(x.phone)}`} className="tnum text-accent hover:underline">{x.phone}</a>
                              {x.note && <span className="text-ink-3"> · {x.note}</span>}
                            </li>
                          ))}
                        </ul>,
                      ],
                    ] as [string, React.ReactNode][])
                  : []),
                ["メール", c.email],
                ["LINE", c.lineId ?? "未登録"],
                ["希望する連絡手段", CHANNEL_LABEL[c.preferredChannel]],
                ["初回接点", CHANNEL_LABEL[c.firstContactChannel]],
                ["媒体 (当社を知ったきっかけ)", <MediaTag key="m" {...media} />],
                ["住所", `〒${c.postalCode} ${c.address}`],
                ["担当店舗", <StoreTag key="s" store={store} />],
                ["備考", c.notes || "-"],
              ]}
            />
          </Card>
          {dupRows.length > 0 && (
            <Card className="border-warn/40 bg-warn-soft/30">
              <CardHeader title="重複の可能性がある顧客" description="同じお客様が別の顧客として登録されていないか確認してください (全店舗の顧客と照合)" />
              <ul className="space-y-2 text-xs">
                {dupRows.map((m) => (
                  <li key={m.id}>
                    {canReadStoreRecords(policyReader(db, user), m.storeId) ? <Link href={`/customers/${m.id}`} className="font-medium text-accent hover:underline">{m.code} {m.name}</Link> : <span className="font-medium text-ink">{m.code} {m.name}</span>}
                    <span className="text-ink-3"> · {db.stores.find((s) => s.id === m.storeId)?.name}{m.area ? ` · 地区 ${m.area}` : ""}</span>
                    <div className="text-ink-3">{m.label}: {m.reasons.join("・")}</div>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <Card>
            <CardHeader title="請求状況" description={`請求 ${billed.length} 件 · 請求額 ${yen(billed.reduce((a, i) => a + i.total, 0))} · 入金済 ${yen(billed.reduce((a, i) => a + i.paidAmount, 0))}`} action={<LinkButton href={`/invoices?view=customers&q=${encodeURIComponent(c.name)}`} variant="ghost" size="sm">顧客別の一覧</LinkButton>} />
            {billed.filter((i) => i.total - i.paidAmount > 0).length === 0 ? (
              <p className="text-xs text-ink-3">未入金の請求はありません</p>
            ) : (
              <ul className="space-y-1.5 text-xs">
                {billed.filter((i) => i.total - i.paidAmount > 0).map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center gap-2">
                    <Link href={`/invoices/${i.id}`} className="font-mono text-accent hover:underline">{i.number}</Link>
                    <StatusBadge value={i.status} map={INVOICE_STATUS} />
                    <span className="tnum">残 {yen(i.total - i.paidAmount)}</span>
                    <span className="text-ink-3">期限 {fmtDate(i.dueDate)}{i.expectedDate ? ` · 入金予定 ${fmtDate(i.expectedDate)}` : ""}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <AiSummary kind="customer" id={c.id} label="AI で履歴を要約" />
          <RecordDocDrafts db={db} user={user} type="customer" id={c.id} number={c.code} />
          <RecordStamp db={db} targets={[{ entity: "customer", id: c.id }]} created={{ at: c.createdAt }} />
          {changeApprovals.length > 0 && <ApprovalHistoryCard approvals={changeApprovals} title="重要情報の変更の承認履歴" />}
          <HistoryCard db={db} user={user} targets={[{ entity: "customer", id: c.id }]} description="顧客情報の登録・変更 (変更前と変更後の値)・承認の記録" />
        </div>

        <div className="space-y-4 @3xl:col-span-2">
          <MapInfoCard db={db} user={user} target={{ type: "customer", id: c.id }} returnTo={returnTo} />
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
            <CardHeader title="外部とのやりとり履歴" description={`${t.comms.length} 件 · 電話・メール・LINE・Web・対面のやりとりを案件に紐付けて残します。メール・LINE は「相手に送信する」で送れます`} />
            <ContactLogForm returnTo={returnTo} customerId={c.id} defaultChannel={c.preferredChannel === "line" ? "line" : c.preferredChannel === "email" ? "email" : "phone"} canSend />
            <div className="mt-4 border-t border-line pt-3">
              <ContactList db={db} logs={t.comms.slice(0, 50)} showParty={false} returnTo={returnTo} linkable empty="やりとりの記録はありません" />
            </div>
          </Card>

          <AttachmentsCard db={db} user={user} parent={{ type: "customer", id: c.id }} customerId={c.id} returnTo={`/customers/${c.id}`} />

          {(db.photoAlbums.some((a) => a.customerId === c.id) || db.surveys.some((x) => x.customerId === c.id)) && (
            <Card>
              <CardHeader title="移行した現場写真フォルダ・お客様アンケート" description="移行前の現場写真は Google ドライブのフォルダ (リンク)、アンケートはハガキの回答から" />
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
      </ReadOnlyArea>
    </div>
  );
}
