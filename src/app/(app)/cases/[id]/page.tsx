import Link from "@/components/ui/Link";
import { notFound, redirect } from "next/navigation";
import { CalendarDays, ClipboardList, FileText, FolderOpen, Inbox, MapPin, MessageSquarePlus, Phone, Receipt, Wrench } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import type { Inquiry, Order, Quote, ScheduleKind } from "@/lib/db/types";
import { canEditCaseStore } from "@/lib/auth/permissions";
import { buildCaseMap, caseHref, summarizeCase } from "@/lib/case-group";
import { caseIndex, STAGE_TONE } from "@/lib/case-status";
import { customerAccessInfo, inquiryAccessInfo, invoiceAccessInfo, orderAccessInfo, quoteAccessInfo } from "@/lib/case-access";
import { logRecordView } from "@/lib/record-views";
import { liveInvoicesOfOrder } from "@/lib/billing";
import { activeReceipts } from "@/lib/receipts";
import { flowIndex, inquiryFlow } from "@/lib/inquiry-flow";
import { lastDay } from "@/lib/calendar";
import { scheduleCheckLink } from "@/lib/msg-link";
import { CHANNEL_LABEL, INQUIRY_STATUS, INVOICE_STATUS, ORDER_STATUS, QUOTE_STATUS } from "@/lib/constants";
import { mediaLabel } from "@/lib/media";
import { QUALITY_KIND_LABEL } from "@/lib/kpi-settings";
import { fmtDate, toDateKey, yen } from "@/lib/format";
import { Badge, Card, CardHeader, Flash, PageHeader, StoreTag, buttonClass } from "@/components/ui";
import { PdfLink } from "@/components/features/PdfLink";
import { CaseRequestsCard } from "@/components/features/CaseRequestsCard";
import { CaseChangeHistory } from "@/components/features/CaseChangeHistory";
import { AttachmentsCard } from "@/components/attachments/AttachmentsCard";
import { CaseScheduleCard } from "@/components/schedule/CaseSchedule";
import { formStores, formUsers } from "@/components/schedule/form-data";

/**
 * 案件の画面 (お客様のご要望 2026-11-26「■4 顧客と案件の定義・管理イメージ」「■6 一つの案件に対する複数見積」)
 * ------------------------------------------------------------
 * 1 つの案件 (src/lib/case-group.ts) の 問い合わせ (複数)・見積 (複数。受注にならなかった見積も履歴として残る)・受注 (追加工事を含む)・
 * 予定・請求・入金・領収書・資料・写真・アンケート・クレーム・やりとりを 1 画面にまとめ、ここから 見積の作成 (撮影 / 手入力)・受注・日程・
 * 施工完了・請求・入金・帳票 へ進む。操作そのものは今までの画面 (同じ処理・同じ権限) を開く
 */

export const dynamic = "force-dynamic";

const QUICK_KINDS: ScheduleKind[] = ["pickup", "delivery", "install", "site", "visit", "measure", "survey", "onsite_quote", "site_survey"];

export default async function CasePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const today = toDateKey(new Date());
  const map = buildCaseMap(db);
  const caseId = map.caseOf(id);
  if (!caseId) notFound();
  // 案件のどの記録の ID でも開ける (案件の ID = 最初の記録) に直す
  if (caseId !== id) redirect(caseHref(caseId));
  const m = map.members(caseId);
  if (!m) notFound();
  const s = summarizeCase(m, caseIndex(db), today);

  // 見られる記録だけ (閲覧の範囲の設定どおり。src/lib/case-access.ts)
  const inquiries = m.inquiries.filter((i) => inquiryAccessInfo(db, user, i).access !== "none");
  const quotes = m.quotes.filter((q) => quoteAccessInfo(db, user, q).access !== "none");
  const orders = m.orders.filter((o) => orderAccessInfo(db, user, o).access !== "none");
  if (!inquiries.length && !quotes.length && !orders.length) redirect(`/cases?err=${encodeURIComponent("この案件を見る権限がありません。")}`);
  const customer = s.customerId ? db.customers.find((c) => c.id === s.customerId) : undefined;
  const customerInfo = customer ? customerAccessInfo(db, user, customer) : undefined;
  if (customer && customerInfo && customerInfo.access !== "none") logRecordView(user, customerInfo, { entity: "customer", id: customer.id, label: customer.name, storeId: customer.storeId }, db.auditLogs);
  const canEdit = canEditCaseStore(user, s.storeId);
  const returnTo = caseHref(caseId);
  const users = new Map(db.users.map((u) => [u.id, u]));
  const userName = (uid?: string) => (uid ? users.get(uid)?.name ?? "" : "");

  const memberIds = new Set<string>([...inquiries.map((i) => i.id), ...quotes.map((q) => q.id), ...orders.map((o) => o.id)]);
  const events = db.schedule.filter((e) => !e.id.startsWith("hold:") && ((e.orderId && memberIds.has(e.orderId)) || (e.quoteId && memberIds.has(e.quoteId)) || (e.inquiryId && memberIds.has(e.inquiryId))));
  const orderedQuote = new Map(orders.filter((o) => o.quoteId).map((o) => [o.quoteId!, o]));
  const liveOrders = orders.filter((o) => o.status !== "cancelled");
  const invoices = [...new Map(liveOrders.flatMap((o) => liveInvoicesOfOrder(db.invoices, o)).map((inv) => [inv.id, inv])).values()].filter((inv) => invoiceAccessInfo(db, user, inv).access !== "none");
  const surveys = db.surveys.filter((x) => x.orderId && memberIds.has(x.orderId));
  const issues = db.qualityIssues.filter((x) => x.orderId && memberIds.has(x.orderId));
  const logs = db.commLogs
    .filter((c) => c.relatedId && (memberIds.has(c.relatedId) || invoices.some((inv) => inv.id === c.relatedId)))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 30);

  // 新しい記録 (予定・資料・依頼) を付ける先: 進行中の受注 → 受注になっていない最新の見積 → 最新の問い合わせ
  const openOrder = [...liveOrders].reverse().find((o) => ["pending_approval", "returned", "confirmed", "scheduled", "in_progress"].includes(o.status));
  const pendingQuotes = quotes.filter((q) => !q.orderId && !orderedQuote.has(q.id) && q.status !== "rejected" && q.status !== "expired");
  const latestInquiry = inquiries.at(-1);
  const anchor: { type: "order"; rec: Order } | { type: "quote"; rec: Quote } | { type: "inquiry"; rec: Inquiry } | undefined = openOrder
    ? { type: "order", rec: openOrder }
    : pendingQuotes.at(-1)
      ? { type: "quote", rec: pendingQuotes.at(-1)! }
      : liveOrders.at(-1)
        ? { type: "order", rec: liveOrders.at(-1)! }
        : latestInquiry
          ? { type: "inquiry", rec: latestInquiry }
          : quotes.at(-1)
            ? { type: "quote", rec: quotes.at(-1)! }
            : undefined;
  const anchorParam = anchor ? `${anchor.type === "order" ? "orderId" : anchor.type === "quote" ? "quoteId" : "inquiryId"}=${anchor.rec.id}` : "";

  // 次の操作 (ここから今までの画面のその操作の場所を開く)
  const toComplete = liveOrders.find((o) => ["confirmed", "scheduled", "in_progress"].includes(o.status));
  const toInvoice = liveOrders.find((o) => o.status === "completed" && !liveInvoicesOfOrder(db.invoices, o).length);
  const toPay = invoices.find((inv) => inv.status !== "void" && inv.status !== "paid" && inv.paidAmount < inv.total);
  const upcoming = events.filter((e) => lastDay(e) >= today).sort((a, b) => a.date.localeCompare(b.date));
  const weekLink = scheduleCheckLink(
    (upcoming.length ? upcoming : [...events].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 1)).map((e) => ({ date: e.date, pickup: e.kind === "pickup" })),
    s.storeId,
  );
  const quoteNew = `/quotes/new?caseId=${caseId}${s.customerId ? `&customerId=${s.customerId}` : ""}${latestInquiry ? `&inquiryId=${latestInquiry.id}` : ""}&returnTo=${encodeURIComponent(returnTo)}`;
  const actions: { href: string; label: string; icon: typeof FileText; primary?: boolean; note?: string }[] = [];
  if (canEdit) {
    actions.push({ href: `/inquiries/reception?caseId=${caseId}${s.customerId ? `&customer=${s.customerId}` : ""}`, label: "この案件に問い合わせを追加", icon: MessageSquarePlus, note: "追加工事・クレーム・手直しのご連絡など" });
    actions.push({ href: quoteNew, label: "見積を作成 (撮影 / 手入力)", icon: FileText, primary: !quotes.length });
    if (pendingQuotes.length === 1 && pendingQuotes[0].status !== "draft" && pendingQuotes[0].status !== "pending_approval") actions.push({ href: `/quotes/${pendingQuotes[0].id}#to-order`, label: `受注にする (${pendingQuotes[0].number})`, icon: ClipboardList, primary: true });
    else if (pendingQuotes.length > 1) actions.push({ href: "#quotes", label: `受注にする見積を選ぶ (${pendingQuotes.length} 件)`, icon: ClipboardList, primary: true });
    if (anchor) actions.push({ href: "#case-schedule", label: "日程を登録", icon: CalendarDays });
    if (toComplete) actions.push({ href: `/orders/${toComplete.id}#complete`, label: `施工完了を登録 (${toComplete.number})`, icon: Wrench, primary: toComplete.status === "in_progress" || toComplete.status === "scheduled" });
    if (toInvoice) actions.push({ href: `/orders/${toInvoice.id}#invoice`, label: `請求書を発行 (${toInvoice.number})`, icon: Receipt, primary: true });
    if (toPay) actions.push({ href: `/invoices/${toPay.id}#payment`, label: `入金を登録 (${toPay.number})`, icon: Receipt, primary: true });
  }
  if (weekLink) actions.push({ href: weekLink.href, label: "予定表で確認", icon: CalendarDays, note: "施工店舗の週の予定表" });
  actions.push({ href: "#docs", label: "帳票を出力", icon: FileText });

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader
        back={customer ? { href: `/customers/${customer.id}`, label: `${customer.name} 様 (顧客の画面)` } : { href: "/cases", label: "案件の一覧" }}
        eyebrow={<span className="inline-flex items-center gap-1"><FolderOpen className="h-3.5 w-3.5" aria-hidden />案件 {s.number}</span>}
        title={s.title || "(件名なし)"}
        badge={
          <span className="flex flex-wrap items-center gap-1.5">
            <Badge tone={s.open ? STAGE_TONE[s.stage] : "neutral"}>{s.open ? "進行中" : "完了・過去の案件"} · {s.stageLabel}</Badge>
            <StoreTag store={db.stores.find((x) => x.id === s.storeId)} />
          </span>
        }
        description={`${s.detail}${s.startedAt ? ` · ${fmtDate(s.startedAt)} から` : ""} · 問い合わせ ${s.counts.inquiries} 件・見積 ${s.counts.quotes} 件・受注 ${s.counts.orders} 件`}
      />

      {/* この案件でできること (それぞれの画面を開き直して、お客様・案件を探し直さなくてよい) */}
      <Card className="mb-4">
        <CardHeader title="この案件でできること" description="押すと、その操作の画面 (または下の欄) が開きます。お客様・案件を探し直す必要はありません" />
        <div className="flex flex-wrap gap-2" data-testid="case-actions">
          {actions.map((a) => (
            <Link key={a.label} href={a.href} className={buttonClass(a.primary ? "primary" : "secondary", "sm")} title={a.note}>
              <a.icon aria-hidden />
              {a.label}
            </Link>
          ))}
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-4 @5xl:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <div className="min-w-0 space-y-4">
          {/* 見積 (複数。受注にならなかった見積も履歴として残る) */}
          <Card id="quotes">
            <CardHeader title={`見積 (${quotes.length} 件)`} description="1 つの案件に仕様・金額の違う見積をいくつでも作れます。受注にする見積を選んで「受注にする」(いくつ受注にしても構いません)。受注にならなかった見積は削除せず履歴として残り、受注金額・売上には受注だけが入ります" action={canEdit ? <Link href={quoteNew} className={buttonClass("secondary", "sm")}>＋ 見積を作成</Link> : undefined} />
            {quotes.length === 0 ? (
              <p className="text-sm text-ink-3">まだ見積はありません。「見積を作成」で、手書きの見積書の撮影 (AI で読み取り) か手入力で作れます。</p>
            ) : (
              <ul className="divide-y divide-line" data-testid="case-quotes">
                {quotes.map((q) => {
                  const o = orderedQuote.get(q.id) ?? (q.orderId ? orders.find((x) => x.id === q.orderId) : undefined);
                  const lost = q.status === "rejected" || q.status === "expired";
                  const history = !o && !lost && liveOrders.some((x) => x.createdAt >= q.createdAt);
                  const tel = !o && !lost && !history && (q.status === "sent" || q.handedOver);
                  return (
                    <li key={q.id} className="flex flex-col gap-2 py-2.5 @3xl:flex-row @3xl:items-center">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5 text-xs">
                          <Link href={`/quotes/${q.id}`} className="font-mono font-medium text-accent hover:underline">{q.number}{q.version > 1 ? ` 第${q.version}版` : ""}</Link>
                          {o ? <Badge tone="good">受注済み ({o.number})</Badge> : history ? <Badge tone="neutral">受注にならなかった見積 (履歴)</Badge> : tel ? <Badge tone="warn">TEL待ち</Badge> : <Badge tone={QUOTE_STATUS[q.status].tone}>{QUOTE_STATUS[q.status].label}</Badge>}
                          <span className="text-ink-3">{fmtDate(q.issuedAt ?? q.createdAt)}</span>
                          {q.source === "ocr" && <span className="text-[11px] text-ink-3">手書きから読み取り</span>}
                        </div>
                        <div className="mt-0.5 text-sm font-medium text-ink">{q.title}</div>
                        <div className="text-xs text-ink-2">{q.items.slice(0, 4).map((i) => `${i.name}${i.qty ? ` ${i.qty}${i.unit ?? ""}` : ""}`).join("・")}{q.items.length > 4 ? ` ほか ${q.items.length - 4} 行` : ""}</div>
                      </div>
                      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                        <span className="mr-1 text-sm font-semibold text-ink tnum">{yen(q.total)}</span>
                        <PdfLink href={`/api/pdf/quotes/${q.id}`} returnTo={returnTo} className={buttonClass("ghost", "sm")}>見積書</PdfLink>
                        {!o && !lost && canEdit && q.status !== "draft" && q.status !== "pending_approval" && (
                          <Link href={`/quotes/${q.id}#to-order`} className={buttonClass("primary", "sm")} data-testid="case-quote-order">受注にする</Link>
                        )}
                        {!o && !lost && (q.status === "draft" || q.status === "pending_approval") && (
                          <Link href={`/quotes/${q.id}`} className={buttonClass("secondary", "sm")}>{q.status === "draft" ? "承認の申請へ" : "承認待ち"}</Link>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          {/* 受注 (追加工事を含む) */}
          <Card id="orders">
            <CardHeader title={`受注 (${orders.length} 件)`} description="同じ案件の追加工事も、この案件の見積から受注にします。受注ごとに施工完了・請求・入金を登録します" action={orders.length > 1 ? <span className="text-sm font-semibold text-ink tnum">合計 {yen(liveOrders.reduce((a, o) => a + o.total, 0))}</span> : undefined} />
            {orders.length === 0 ? (
              <p className="text-sm text-ink-3">まだ受注はありません。見積の「受注にする」で登録します (引取・納品の日程もそこで入れられます)。</p>
            ) : (
              <ul className="divide-y divide-line">
                {orders.map((o) => {
                  const inv = liveInvoicesOfOrder(db.invoices, o)[0];
                  return (
                    <li key={o.id} className="flex flex-col gap-2 py-2.5 @3xl:flex-row @3xl:items-center">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5 text-xs">
                          <Link href={`/orders/${o.id}`} className="font-mono font-medium text-accent hover:underline">{o.number}</Link>
                          <Badge tone={ORDER_STATUS[o.status].tone}>{ORDER_STATUS[o.status].label}</Badge>
                          {inv && <Badge tone={INVOICE_STATUS[inv.status].tone} dot={false}>請求 {inv.number} · {INVOICE_STATUS[inv.status].label}</Badge>}
                          <span className="text-ink-3">契約 {fmtDate(o.contractDate)}{o.scheduledStart ? ` · 施工 ${fmtDate(o.scheduledStart)}${o.scheduledEnd && o.scheduledEnd !== o.scheduledStart ? `〜${fmtDate(o.scheduledEnd)}` : ""}` : ""}{o.completedAt ? ` · 完了 ${fmtDate(o.completedAt)}` : ""}</span>
                        </div>
                        <div className="mt-0.5 text-sm font-medium text-ink">{o.title}</div>
                        {o.siteAddress && <div className="text-xs text-ink-2">施工場所: {o.siteAddress}</div>}
                      </div>
                      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                        <span className="mr-1 text-sm font-semibold text-ink tnum">{yen(o.total)}</span>
                        <Link href={`/orders/${o.id}#handover`} className={buttonClass("ghost", "sm")}>日程</Link>
                        {canEdit && ["confirmed", "scheduled", "in_progress"].includes(o.status) && <Link href={`/orders/${o.id}#complete`} className={buttonClass("secondary", "sm")}>施工完了</Link>}
                        {o.status !== "cancelled" && <PdfLink href={`/api/pdf/delivery/${o.id}`} returnTo={returnTo} className={buttonClass("ghost", "sm")}>納品書</PdfLink>}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          {/* 予定 (この案件の問い合わせ・見積・受注の予定。登録すると予定表にも載る) */}
          <CaseScheduleCard
            events={events}
            allEvents={db.schedule}
            users={users}
            stores={new Map(db.stores.map((x) => [x.id, x]))}
            today={today}
            newParams={anchorParam}
            returnTo={returnTo}
            quickKinds={QUICK_KINDS}
            canAdd={Boolean(anchor) && canEdit}
            quickAdd={
              anchor && canEdit
                ? {
                    caseRef: `${anchor.type}:${anchor.rec.id}`,
                    storeId: anchor.rec.storeId,
                    kinds: anchor.type === "inquiry" ? ["survey", "site_survey", "onsite_quote", "visit", "measure"] : ["pickup", "delivery", "install", "site", "visit", "measure", "survey", "onsite_quote"],
                    users: formUsers(db),
                    stores: formStores(db),
                    defaultAssigneeIds: anchor.type === "order" && anchor.rec.workerIds.length ? [...anchor.rec.workerIds] : [user.id],
                    currentUserId: user.id,
                    returnTo,
                    fullHref: `/schedule/new?${anchorParam}&returnTo=${encodeURIComponent(returnTo)}`,
                  }
                : undefined
            }
            description={`この案件の予定 (問い合わせ・見積・受注のどれに付いた予定も)。登録すると施工店舗の予定表に載ります${anchor ? `。ここで登録した予定は ${anchor.rec.number} に付きます` : ""}`}
          />

          {/* 請求・入金・領収書 */}
          <Card id="billing">
            <CardHeader title="請求・入金" description="請求書は受注の画面の「請求書」で発行します。入金は請求書の画面で登録します" />
            {invoices.length === 0 ? (
              <p className="text-sm text-ink-3">まだ請求書はありません。{toInvoice ? "施工完了した受注があります。上の「請求書を発行」から発行できます。" : ""}</p>
            ) : (
              <ul className="divide-y divide-line">
                {invoices.map((inv) => {
                  const pays = db.payments.filter((p) => p.invoiceId === inv.id);
                  const receipts = activeReceipts(db, inv.id);
                  return (
                    <li key={inv.id} className="flex flex-col gap-2 py-2.5 @3xl:flex-row @3xl:items-center">
                      <div className="min-w-0 flex-1 text-xs">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Link href={`/invoices/${inv.id}`} className="font-mono font-medium text-accent hover:underline">{inv.number}</Link>
                          <Badge tone={INVOICE_STATUS[inv.status].tone}>{INVOICE_STATUS[inv.status].label}</Badge>
                          <span className="text-ink-3">発行 {fmtDate(inv.issueDate)}{inv.dueDate ? ` · 期限 ${fmtDate(inv.dueDate)}` : ""}</span>
                        </div>
                        <div className="mt-0.5 text-ink-2">
                          入金 {yen(inv.paidAmount)} / {yen(inv.total)}{pays.length ? ` (${pays.length} 回)` : ""}{receipts.length ? ` · 領収書 ${receipts.map((r) => r.number).join("・")}` : ""}
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-wrap gap-1.5">
                        <PdfLink href={`/api/pdf/invoices/${inv.id}`} returnTo={returnTo} className={buttonClass("ghost", "sm")}>請求書</PdfLink>
                        {receipts.map((r) => (
                          <PdfLink key={r.id} href={`/api/pdf/receipts/${r.id}`} returnTo={returnTo} className={buttonClass("ghost", "sm")}>領収書 {r.number}</PdfLink>
                        ))}
                        {inv.status !== "void" && inv.paidAmount < inv.total && canEdit && <Link href={`/invoices/${inv.id}#payment`} className={buttonClass("secondary", "sm")}>入金を登録</Link>}
                        <Link href={`/invoices/${inv.id}#receipts`} className={buttonClass("ghost", "sm")}>領収書の発行</Link>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          {/* 資料・写真 (手書き見積書・現場写真・図面など。この案件のすべての記録の分) */}
          {anchor && (
            <AttachmentsCard
              db={db}
              user={user}
              parent={{ type: anchor.type, id: anchor.rec.id }}
              extraParents={[...inquiries.map((i) => ({ type: "inquiry" as const, id: i.id })), ...quotes.map((q) => ({ type: "quote" as const, id: q.id })), ...orders.map((o) => ({ type: "order" as const, id: o.id }))]}
              returnTo={returnTo}
              title="資料・写真 (この案件)"
              description={`この案件の問い合わせ・見積・受注に登録した写真・資料をまとめて表示します。ここで登録すると ${anchor.rec.number} に付きます`}
            />
          )}

          <Card id="history">
            <CardHeader title="やりとり (この案件)" description="お客様とのやりとり・対応の記録 (新しい順に 30 件まで)。受注の経過メモは受注の画面にあります" />
            {logs.length === 0 ? (
              <p className="text-sm text-ink-3">まだやりとりの記録はありません。</p>
            ) : (
              <ul className="space-y-2">
                {logs.map((c) => (
                  <li key={c.id} className="rounded-lg bg-subtle/60 px-3 py-2 text-sm">
                    <div className="text-[11px] text-ink-3">
                      {fmtDate(c.at)} · {CHANNEL_LABEL[c.channel as keyof typeof CHANNEL_LABEL] ?? c.channel} · {userName(c.userId)}
                    </div>
                    <div className="whitespace-pre-line text-ink">{c.body}</div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <CaseRequestsCard db={db} user={user} ids={[...memberIds]} caseId={anchor?.rec.id ?? caseId} storeId={s.storeId} returnTo={returnTo} />
          <CaseChangeHistory db={db} ids={[...memberIds]} />
        </div>

        <aside className="min-w-0 space-y-4">
          {/* お客様 */}
          <Card>
            <CardHeader title="お客様" action={customer ? <Link href={`/customers/${customer.id}`} className={buttonClass("ghost", "sm")}>顧客の画面</Link> : undefined} />
            {customer ? (
              <div className="space-y-1.5 text-sm">
                <div className="font-semibold text-ink">{customer.name} 様 <span className="ml-1 font-mono text-[11px] font-normal text-ink-3">{customer.code}</span></div>
                {customer.kana && <div className="text-xs text-ink-3">{customer.kana}</div>}
                {customer.address && (
                  <div className="flex items-start gap-1.5 text-ink-2">
                    <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span>{customer.postalCode ? `〒${customer.postalCode} ` : ""}{customer.address}</span>
                  </div>
                )}
                {[customer.phone, ...(customer.contacts ?? []).map((x) => x.phone)].filter(Boolean).map((ph, i) => (
                  <a key={`${ph}-${i}`} href={`tel:${ph}`} className="flex items-center gap-1.5 text-accent hover:underline">
                    <Phone className="h-3.5 w-3.5" aria-hidden />
                    <span className="tnum">{ph}</span>
                    {i > 0 && <span className="text-[11px] text-ink-3">{customer.contacts?.[i - 1]?.relation}</span>}
                  </a>
                ))}
              </div>
            ) : (
              <p className="text-sm text-ink-3">お客様が登録されていません。問い合わせの画面の「お客様の確認」で登録・紐付けできます。</p>
            )}
          </Card>

          {/* 問い合わせ (この案件のすべて。追加工事・クレームのご連絡も 1 件ずつ) */}
          <Card id="inquiries">
            <CardHeader title={`問い合わせ (${inquiries.length} 件)`} icon={<Inbox />} />
            {inquiries.length === 0 ? (
              <p className="text-sm text-ink-3">問い合わせの記録はありません (見積・受注から始まった案件)。</p>
            ) : (
              <ul className="space-y-2">
                {inquiries.map((i, n) => {
                  const f = inquiryFlow(i, flowIndex(db), new Date());
                  return (
                    <li key={i.id} className="rounded-lg border border-line px-3 py-2 text-xs">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Link href={`/inquiries/${i.id}`} className="font-mono font-medium text-accent hover:underline">{i.number}</Link>
                        <Badge tone={INQUIRY_STATUS[i.status].tone} dot={false}>{INQUIRY_STATUS[i.status].label}</Badge>
                        {n > 0 && <Badge tone="info" dot={false}>追加の問い合わせ</Badge>}
                      </div>
                      <div className="mt-1 text-sm text-ink">{i.summary}</div>
                      <div className="mt-0.5 text-ink-3">
                        {fmtDate(i.receivedAt)} · {CHANNEL_LABEL[i.channel]}{i.media ? ` · ${mediaLabel(i.media)}` : ""}{i.assignedUserId ? ` · 担当 ${userName(i.assignedUserId)}` : ""}
                      </div>
                      {f && i.status !== "won" && i.status !== "lost" && i.status !== "closed" && <div className="mt-0.5 text-ink-2">対応状況: {f.label}</div>}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          {/* 帳票 (見られる社員なら誰でも出力。src/lib/doc-print.ts) */}
          <Card id="docs">
            <CardHeader title="帳票" description="スマートフォンではシステムの画面の中に表示し、「元の画面に戻る」でこの画面に戻れます" />
            <div className="flex flex-col gap-1.5 text-sm">
              {quotes.filter((q) => q.status !== "draft").map((q) => (
                <PdfLink key={q.id} href={`/api/pdf/quotes/${q.id}`} returnTo={returnTo} className="text-accent hover:underline">見積書 {q.number}{q.version > 1 ? ` 第${q.version}版` : ""}</PdfLink>
              ))}
              {liveOrders.map((o) => (
                <PdfLink key={o.id} href={`/api/pdf/delivery/${o.id}`} returnTo={returnTo} className="text-accent hover:underline">納品書 {o.number}</PdfLink>
              ))}
              {invoices.map((inv) => (
                <PdfLink key={inv.id} href={`/api/pdf/invoices/${inv.id}`} returnTo={returnTo} className="text-accent hover:underline">請求書 {inv.number}</PdfLink>
              ))}
              {invoices.flatMap((inv) => activeReceipts(db, inv.id)).map((r) => (
                <PdfLink key={r.id} href={`/api/pdf/receipts/${r.id}`} returnTo={returnTo} className="text-accent hover:underline">領収書 {r.number}</PdfLink>
              ))}
              {!quotes.length && !liveOrders.length && <p className="text-ink-3">見積・受注ができると出力できます。</p>}
            </div>
          </Card>

          {/* アンケート・クレーム・手直し */}
          <Card>
            <CardHeader title="アンケート・クレーム・手直し" />
            {surveys.length === 0 && issues.length === 0 ? (
              <p className="text-sm text-ink-3">この案件のアンケート・クレーム・手直しの記録はありません。</p>
            ) : (
              <ul className="space-y-1.5 text-xs">
                {surveys.map((x) => (
                  <li key={x.id}>
                    <Link href={`/kpi/surveys/${x.id}`} className="text-accent hover:underline">アンケート{x.postcardNo ? ` No.${x.postcardNo}` : ""}</Link>
                    <span className="ml-1 text-ink-3">{fmtDate(x.answeredOn ?? x.receivedAt)}</span>
                  </li>
                ))}
                {issues.map((x) => (
                  <li key={x.id}>
                    <Link href={`/kpi/quality/${x.id}`} className="text-accent hover:underline">{QUALITY_KIND_LABEL[x.kind]} {x.number}</Link>
                    <span className="ml-1 text-ink-3">{fmtDate(x.occurredOn)} · {x.status === "open" ? "対応中" : "対応済み"}</span>
                    <div className="text-ink-2">{x.description.slice(0, 80)}</div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </aside>
      </div>
    </div>
  );
}
