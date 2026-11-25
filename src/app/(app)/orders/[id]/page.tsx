import Link from "@/components/ui/Link";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { staffForStore } from "@/lib/staff-choices";
import { areaStoreOf } from "@/lib/store-area";
import { canAccessStore, canEditProduction, canManageFinance, canManagePurchaseOrders, canRegisterPurchase, canSeeAllStores, isManagerOrAbove, skipsApproval } from "@/lib/auth/permissions";
import { TatamiRoomsCard } from "@/components/schedule/TatamiRoomsCard";
import { saveOrderTatamiRooms } from "@/lib/actions/tatami-rooms";
import { ROOMS_SOURCE_LABEL, orderRooms, quoteRooms } from "@/lib/tatami-rooms";
import { orderChain, userName } from "@/lib/db/queries";
import { addProgress, cancelOrder, completeOrder, createInvoiceFromOrder, requestOrderChange, resubmitOrder, saveWorkStaff, updateOrderInfo, updateOrderSchedule } from "@/lib/actions/orders";
import { WORK_ROLES, WORK_ROLE_LABEL, workStaffOf } from "@/lib/work-staff";
import { WorkStaffFields } from "@/components/features/WorkStaffFields";
import { CaseChangeHistory } from "@/components/features/CaseChangeHistory";
import { CaseStoreCard } from "@/components/features/CaseStoreCard";
import { CaseRequestsCard } from "@/components/features/CaseRequestsCard";
import { CaseCustomerSearch } from "@/components/features/LinkSearch";
import { relinkCase } from "@/lib/actions/case-quick";
import { caseRelinkBlocker } from "@/lib/customer-link";
import { fmtDate, fmtDateTime, toDateKey, yen } from "@/lib/format";
import { APPROVAL_TYPE_LABEL, CATEGORY_LABEL, CHANNEL_LABEL, INVOICE_STATUS, ORDER_STATUS, PROGRESS_KIND_LABEL, QUOTE_STATUS } from "@/lib/constants";
import { customerPhonesText } from "@/lib/customer-contacts";
import { ApprovalDecision, ApprovalHistoryCard, HistoryCard, RecordStamp } from "@/components/features/History";
import { ContactList, ContactLogForm } from "@/components/features/Contacts";
import { Badge, Button, Card, CardHeader, Dl, Field, Flash, Input, LinkButton, Note, PageHeader, Select, StatusBadge, StoreTag, Textarea } from "@/components/ui";
import { OrderScheduleForm } from "@/components/schedule/OrderScheduleForm";
import { HandoverEditor } from "@/components/schedule/HandoverEditor";
import { saveOrderHandovers } from "@/lib/actions/handovers";
import { cleanHandovers, handoverLabel, rowText, toFormRows } from "@/lib/handover";
import { suggestOrderHandovers, usesHandoverPlan } from "@/lib/handover-save";
import { isHandoverEvent } from "@/lib/db/handover-events";
import { orderEditable } from "@/lib/db/schedule";
import { lastDay, shortDate } from "@/lib/calendar";
import { CaseScheduleCard } from "@/components/schedule/CaseSchedule";
import { CaseFlowBar } from "@/components/features/CaseFlowBar";
import { caseFlow } from "@/lib/case-flow";
import { formStores, formUsers } from "@/components/schedule/form-data";
import { CasePlanCard } from "@/components/scheduling/CasePlanCard";
import { AttachmentsCard } from "@/components/attachments/AttachmentsCard";
import { createQualityIssue } from "@/lib/actions/kpi";
import { updateSiteInfo } from "@/lib/actions/cases";
import { CaseStatusCard } from "@/components/features/CaseStatusCard";
import { SiteInfoCard } from "@/components/features/SiteInfo";
import { QUALITY_CATEGORIES, QUALITY_KIND_HELP, QUALITY_KIND_LABEL, kpiSettings } from "@/lib/kpi-settings";
import { QualityGuide } from "@/components/kpi/QualityGuide";
import { SCORE_QUESTIONS, SCORE_LABEL } from "@/lib/survey";
import { deliveryOf } from "@/lib/kpi";
import { AiSummary } from "@/components/features/AiSummary";
import { RecordDocDrafts } from "@/components/features/DocDrafts";
import { lineGroupName, lineGroups } from "@/lib/line-groups";
import { linkLineGroup, unlinkLineGroup } from "@/lib/actions/line-groups";
import { FaxHistoryCard, PurchaseOrderTable } from "@/components/fax/FaxParts";
import { MapInfoCard } from "@/components/maps/MapInfoCard";
import { canViewMgmtStore } from "@/lib/mgmt/access";
import { policyReader } from "@/lib/access-policy";
import { MgmtOrderCard } from "@/components/features/MgmtOrderCard";
import { CaseViewBanner, CompletedLockBanner, ReadOnlyArea } from "@/components/features/CaseAccess";
import { completedCaseLock, completedCaseReason, orderAccessInfo, deniedHref } from "@/lib/case-access";
import { logRecordView } from "@/lib/record-views";
import { OrderCasePostsCard } from "@/components/case-posts/CasePostParts";
import { batchTerms, closingDateCovering, isBatchInvoice, termsText } from "@/lib/billing";

const STEPS = ["pending_approval", "confirmed", "scheduled", "in_progress", "completed", "invoiced", "paid"] as const;

export default async function OrderDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string; err?: string }> }) {
  const { id } = await params;
  const { msg, err } = await searchParams;
  const user = await requireUser();
  /** 管理者・店長の申請は承認を省略して、そのまま反映される (permissions.ts の skipsApproval) */
  const own = skipsApproval(user, "order");
  const db = getDb();
  const o = db.orders.find((x) => x.id === id);
  if (!o) notFound();
  // 施工完了・請求済・入金済の受注 (確定した売上) の変更は、店長でも管理者の承認 (approval-decide.ts の touchesConfirmedSales)
  const salesConfirmed = ["completed", "invoiced", "paid"].includes(o.status);
  const ownChange = skipsApproval(user, "order_change") && (user.role === "admin" || !salesConfirmed);
  // ほかの店舗の記録は閲覧のみ (見られる範囲は閲覧の範囲の設定と案件の進み具合。承認制で申請できるときはお客様の画面の「閲覧の申請」へ。src/lib/case-access.ts)
  const info = orderAccessInfo(db, user, o);
  if (info.access === "none") redirect(deniedHref(info, "/orders", "案件"));
  const viewOnly = info.access === "view";
  // その店舗の社員 (全店舗ロールを含む)。店長はほかの店舗の受注も変更できる (edit) が、請求書・入金・仕入・発注書・KPI はその店舗のまま (canAccessStore)
  const ownStore = canAccessStore(user, o.storeId);
  logRecordView(user, info, { entity: "order", id: o.id, label: o.number, storeId: o.storeId }, db.auditLogs);
  const lock = completedCaseLock(db, user, o);
  const relinkBlocked = caseRelinkBlocker(db, { order: o, head: { type: "order", id: o.id, number: o.number, title: o.title, storeId: o.storeId } });
  const customer = db.customers.find((c) => c.id === o.customerId);
  // まとめ請求のお客様 (締め日ごとに 1 枚の請求書。src/lib/billing.ts)
  const bTerms = batchTerms(customer);
  const batchBilling = Boolean(bTerms);
  const batchTermsLabel = bTerms ? termsText(bTerms) : "";
  const batchMonth = bTerms && o.salesDate ? closingDateCovering(o.salesDate, bTerms.closingDay).slice(0, 7) : toDateKey(new Date()).slice(0, 7);
  const store = db.stores.find((s) => s.id === o.storeId);
  const chain = orderChain(db, o);
  const pending = chain.approvals.find((a) => a.status === "pending" && a.type === "order");
  const pendingChange = chain.approvals.find((a) => a.status === "pending" && a.type === "order_change" && a.targetId === o.id);
  const lastReturn = chain.approvals.filter((a) => a.type === "order" && a.targetId === o.id && a.status === "returned").sort((a, b) => (b.decidedAt ?? "").localeCompare(a.decidedAt ?? ""))[0];
  const stepIndex = STEPS.indexOf((o.status === "returned" ? "pending_approval" : o.status) as (typeof STEPS)[number]);
  const contactLogs = db.commLogs.filter((c) => (c.relatedType === "order" && c.relatedId === o.id) || (chain.quote && c.relatedType === "quote" && c.relatedId === chain.quote.id) || (chain.invoice && c.relatedType === "invoice" && c.relatedId === chain.invoice.id) || db.purchases.some((p) => p.orderId === o.id && c.relatedType === "purchase" && c.relatedId === p.id));
  // やりとりの相手に選べる協力業者・仕入先 (取引中。協力業者を先に)
  const partners = db.suppliers
    .filter((s) => s.active !== false)
    .sort((a, b) => Number(b.kind === "partner") - Number(a.kind === "partner") || a.name.localeCompare(b.name, "ja"))
    .map((s) => ({ id: s.id, label: `${s.kind === "partner" ? "[協力業者] " : "[仕入先] "}${s.name}` }));
  const orderPurchases = db.purchases.filter((p) => p.orderId === o.id);
  // この案件の明細を含む発注書と、この案件にひも付いた FAX (送信・返信)
  const orderPos = db.purchaseOrders.filter((p) => p.orderIds.includes(o.id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const orderFaxes = db.faxMessages.filter((f) => f.orderIds.includes(o.id));
  const returnTo = `/orders/${id}`;
  // この案件の LINE グループ (現場のグループ) と、まだひも付けていないグループ
  const allGroups = lineGroups(db).filter((g) => g.status === "joined");
  const orderGroups = allGroups.filter((g) => g.orderId === o.id);
  const freeGroups = allGroups.filter((g) => !g.orderId && !g.supplierId);
  const active = ["confirmed", "scheduled", "in_progress"].includes(o.status);
  const main = db.schedule.find((e) => e.orderId === o.id && e.source === "order");
  // 品目ごとの引取・納品の日程 (畳・襖・障子・網戸。src/lib/handover.ts)。リフォームだけの受注はこれまでどおりの施工予定
  const planMode = usesHandoverPlan(db, o);
  const savedPlan = cleanHandovers(o.handovers ?? []).rows;
  const planRows = planMode ? (savedPlan.length ? savedPlan : suggestOrderHandovers(db, o)) : [];
  const legacyEvent = planMode && !savedPlan.length ? db.schedule.find((e) => e.orderId === o.id && e.source === "order" && !isHandoverEvent(e)) : undefined;
  const pendingHandover = chain.approvals.find((a) => a.status === "pending" && a.type === "handover_change" && a.targetId === o.id);
  const planEditable = planMode && orderEditable(o) && !lock.locked && !viewOnly;
  // 畳の仕様 (部屋ごと。畳表・畳縁・畳床・寸法)。受注 → 見積で入れた仕様 → 見積の明細から自動 (src/lib/tatami-rooms.ts)
  const tatamiSpec = orderRooms(db, o);
  const today = toDateKey(new Date());
  const survey = db.surveys.find((x) => x.orderId === o.id);
  const issues = db.qualityIssues.filter((x) => x.orderId === o.id).sort((a, b) => b.occurredOn.localeCompare(a.occurredOn));
  const qp = kpiSettings(db).qualityPoints;
  // 施工担当の選択肢: 担当店舗の社員 + 本部の社員 (全店舗共通。お客様のご要望 2026-11-24「④」) + 今の担当
  // 施工場所 (なければお客様の住所) の担当エリアの店舗 (お客様のご要望 2026-11-24「③」。担当店舗の変更の目安)
  const orderArea = areaStoreOf(db, o.siteAddress || customer?.address);
  const staffChoices = staffForStore(db, o.storeId, o.workerIds).sort((a, b) => Number(o.workerIds.includes(b.id)) - Number(o.workerIds.includes(a.id)));
  // 作業の担当 (実績。src/lib/work-staff.ts): 保存した値、なければ予定表の予定の担当者から
  const workStaff = workStaffOf(db, o);
  const wsIds = WORK_ROLES.flatMap((r) => workStaff[r]);
  const workStaffChoices = staffForStore(db, o.storeId, wsIds).map((u) => ({ id: u.id, label: u.name }));
  const AMOUNT_LABEL: [keyof NonNullable<typeof o.amounts>, string][] = [["tatami", "畳"], ["fusuma", "襖"], ["shoji", "障子"], ["amido", "網戸"], ["curtain", "カーテン"], ["cloth", "クロス・工事"], ["own", "自社商品"], ["misc", "諸経費"], ["discount", "値引"]];

  // 案件ごとの請求書の発行 (まとめ請求のお客様は折りたたんで出す)
  const perOrderInvoice = !ownStore ? (
    <Note>この案件の請求書は {store?.name ?? "案件の店舗"} の店長・本部スタッフ・管理者が発行します。</Note>
  ) : canManageFinance(user) || isManagerOrAbove(user) ? (
    <form action={createInvoiceFromOrder.bind(null, o.id)} className="flex flex-wrap items-end gap-2">
      <Field label="支払期限 (日後)"><Input type="number" name="dueDays" defaultValue={customer?.type === "corporate" ? 30 : 14} className="w-28" /></Field>
      <Field label="送付方法">
        <Select name="sentVia" defaultValue={customer?.type === "corporate" ? "email" : customer?.preferredChannel === "line" ? "line" : "mail"}>
          {(["mail", "email", "line", "chatwork", "visit"] as const).map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>)}
        </Select>
      </Field>
      <Field label="備考 (請求書に印字・任意)" className="w-full"><Input name="notes" placeholder="例: 11月分の施工代金です" /></Field>
      <Button type="submit">請求書を発行 ({yen(o.total)})</Button>
    </form>
  ) : (
    <Note>請求書の発行は店長・本部スタッフ・管理者が行います。本部へ連絡してください。</Note>
  );

  return (
    <div>
      <Flash msg={msg} err={err} />
      <PageHeader
        title={`${o.number} ${customer?.name} 様 · ${o.title}`}
        badge={<StatusBadge value={o.status} map={ORDER_STATUS} />}
        description={<span className="inline-flex flex-wrap items-center gap-2">{CATEGORY_LABEL[o.category]} · <StoreTag store={store} /> · 契約日 {fmtDate(o.contractDate)} · 金額 {yen(o.total)} (税込){o.salesDate ? ` · 売上計上日 ${fmtDate(o.salesDate)}` : ""}{chain.invoice && chain.invoice.status !== "void" ? ` · 請求書の発行日 ${fmtDate(chain.invoice.issueDate)}` : ""}</span>}
        back={{ href: "/orders", label: "受注・施工一覧" }}
        actions={
          <>
            {chain.quote && <LinkButton href={`/quotes/${chain.quote.id}`} variant="secondary" size="sm">見積 {chain.quote.number}</LinkButton>}
            {chain.quote && !viewOnly && <LinkButton href={`/api/pdf/quotes/${chain.quote.id}`} variant="ghost" size="sm" target="_blank">見積書 PDF</LinkButton>}
            {chain.invoice && chain.invoice.status !== "void" && !viewOnly && ownStore && <LinkButton href={`/api/pdf/invoices/${chain.invoice.id}`} variant="secondary" size="sm" target="_blank">請求書 PDF</LinkButton>}
          </>
        }
      />

      {o.status !== "cancelled" && (
        <ol className="mb-6 flex flex-wrap gap-1 text-xs">
          {STEPS.map((s, i) => (
            <li key={s} className={`flex items-center gap-1 rounded-full px-2.5 py-1 ${i < stepIndex ? "bg-good-soft text-good-ink" : i === stepIndex ? "bg-ink text-white" : "bg-subtle text-ink-3"}`}>
              <span className="tnum">{i + 1}</span> {ORDER_STATUS[s].label}
            </li>
          ))}
        </ol>
      )}

      {viewOnly && <CaseViewBanner storeName={store?.name ?? "ほかの店舗"} basis={info.basis} grantUntil={info.grantUntil} />}
      <CaseFlowBar flow={caseFlow(db, { orderId: o.id }, new Date())} />
      {!viewOnly && completedCaseReason(db, o) && <CompletedLockBanner reason={completedCaseReason(db, o)} admin={!lock.locked} />}

      <ReadOnlyArea readOnly={viewOnly}>
      {pending && (
        <Card className="mb-4 border-warn/40 bg-warn-soft/40">
          <CardHeader title="契約承認待ち" description={`${pending.requiredRole === "admin" ? "管理者" : "店長"}の承認が必要 · 申請 ${userName(pending.requestedBy)} ${fmtDateTime(pending.createdAt)}${pending.requestComment ? ` · ${pending.requestComment}` : ""}`} />
          <ApprovalDecision approval={pending} user={user} returnTo={returnTo} approveLabel="契約を承認する" waitingText="承認後に施工手配へ進めます。" />
        </Card>
      )}
      {o.status === "returned" && !pending && (
        <Card className="mb-4 border-serious/40 bg-serious-soft/40">
          <CardHeader title="契約承認が差し戻されました" description={lastReturn ? `${userName(lastReturn.decidedBy)} · ${fmtDateTime(lastReturn.decidedAt)} · 理由: ${lastReturn.decisionComment ?? "記入なし"}` : undefined} />
          <p className="mb-3 text-xs text-ink-2">施工予定・案件情報・見積 (金額は見積の変更申請) を見直してから再申請してください。案件をやめる場合はキャンセルします。</p>
          <form action={resubmitOrder.bind(null, o.id)} className="flex flex-wrap items-end gap-2">
            <Field label="再申請のコメント" className="w-full @xl:w-96"><Input name="comment" placeholder="例: 施工日を確定し、材料の手配先を変更しました" /></Field>
            <Button type="submit">{own ? "契約を確定する (承認不要)" : "契約承認を再申請する"}</Button>
          </form>
          {isManagerOrAbove(user) && (
            <form action={cancelOrder.bind(null, o.id)} className="mt-3 flex flex-wrap items-end gap-2 border-t border-line pt-3">
              <Field label="キャンセル理由" className="w-full @xl:w-72"><Input name="reason" /></Field>
              <Button type="submit" variant="danger" size="sm">受注をキャンセル</Button>
            </form>
          )}
        </Card>
      )}
      {pendingHandover && (
        <Card className="mb-4 border-warn/40 bg-warn-soft/40">
          <CardHeader title={`承認待ち: ${APPROVAL_TYPE_LABEL[pendingHandover.type]}`} description={`${pendingHandover.requiredRole === "admin" ? "管理者" : "店長"}の承認が必要 · 申請 ${userName(pendingHandover.requestedBy)} ${fmtDateTime(pendingHandover.createdAt)}${pendingHandover.requestComment ? ` · 理由: ${pendingHandover.requestComment}` : ""}`} />
          <ApprovalDecision approval={pendingHandover} user={user} returnTo={returnTo} approveLabel="日程の変更を承認する" waitingText="承認されると予定表に反映されます (それまでは前の日程のままです)。" />
        </Card>
      )}
      {pendingChange && (
        <Card className="mb-4 border-warn/40 bg-warn-soft/40">
          <CardHeader title={`承認待ち: ${APPROVAL_TYPE_LABEL[pendingChange.type]}`} description={`${pendingChange.requiredRole === "admin" ? "管理者" : "店長"}の承認が必要 · 申請 ${userName(pendingChange.requestedBy)} ${fmtDateTime(pendingChange.createdAt)} · 理由: ${pendingChange.requestComment ?? "-"}`} />
          <ApprovalDecision approval={pendingChange} user={user} returnTo={returnTo} approveLabel="変更を承認する" />
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 @3xl:grid-cols-3">
        <div className="space-y-4 @3xl:col-span-2">
          {planMode ? (
            <Card id="handover">
              <CardHeader
                title="引取・納品の日程 (品目ごと)"
                description={`品目ごとに引取日・納品日を入れます。予定表には引き取りの日と納品の日だけが載ります (間の日には出ません)。はじめて入れる日程はすぐに反映し、登録済みの日程の変更は${own ? "そのまま反映します (承認不要)" : "店長 (店長の申請は管理者) の承認のあとに反映します"}`}
              />
              {planEditable ? (
                <HandoverEditor
                  key={`${o.updatedAt}_${pendingHandover?.id ?? ""}`}
                  action={saveOrderHandovers.bind(null, o.id)}
                  initial={toFormRows(planRows)}
                  saved={savedPlan}
                  suggested={!savedPlan.length && planRows.length > 0}
                  legacyNote={
                    legacyEvent
                      ? `予定表には以前の形 (「施工」${shortDate(legacyEvent.date)}${lastDay(legacyEvent) !== legacyEvent.date ? `〜${shortDate(lastDay(legacyEvent))} の毎日` : ""}) で載っています。日程を確かめて「保存する」を押すと、引き取りの日・納品の日だけの表示に切り替わります。`
                      : undefined
                  }
                  pendingNote={pendingHandover ? `承認待ちの日程の変更があります (${userName(pendingHandover.requestedBy)} さんの申請)。承認・差戻しのあとに保存できます。急ぐときは上の「申請を取り下げる」のあとに保存し直してください。` : undefined}
                  own={own}
                  workerIds={o.workerIds}
                  siteAddress={o.siteAddress}
                  users={formUsers(db)}
                  stores={formStores(db)}
                  storeId={o.storeId}
                  currentUserId={user.id}
                />
              ) : savedPlan.length ? (
                <ul className="space-y-1 text-sm" data-testid="handover-list">
                  {savedPlan.map((r) => (
                    <li key={r.id}>
                      <span className="font-medium text-ink">{handoverLabel(r)}</span> <span className="text-ink-2">{rowText(r)}</span>
                    </li>
                  ))}
                  <li className="pt-1 text-xs text-ink-3">担当: {o.workerIds.map((w) => userName(w)).join("・") || "-"} · 現場住所: {o.siteAddress || "-"}</li>
                </ul>
              ) : (
                <p className="text-sm text-ink-3">引取・納品の日程は登録されていません。</p>
              )}
            </Card>
          ) : (
          <Card id="schedule">
            <CardHeader title="施工予定・担当" description="保存すると予定表 (店舗のカレンダー) の「施工」の予定に施工担当とともに反映されます。予定表の側で日程・担当を変えた場合もここに反映されます" />
            {active ? (
              <OrderScheduleForm
                action={updateOrderSchedule.bind(null, o.id)}
                orderId={o.id}
                mainEventId={main?.id}
                initial={{
                  start: o.scheduledStart ?? "",
                  end: o.scheduledEnd && o.scheduledEnd !== o.scheduledStart ? o.scheduledEnd : "",
                  allDay: main ? !main.startTime : false,
                  startTime: main ? (main.startTime ?? "") : "09:00",
                  endTime: main ? (main.endTime ?? "") : "15:00",
                  workerIds: o.workerIds,
                  siteAddress: o.siteAddress,
                }}
                users={formUsers(db)}
                stores={formStores(db)}
                storeId={o.storeId}
                currentUserId={user.id}
              />
            ) : (
              <Dl columns={3} items={[["施工期間", o.scheduledStart ? `${fmtDate(o.scheduledStart)}${o.scheduledEnd && o.scheduledEnd !== o.scheduledStart ? `〜${fmtDate(o.scheduledEnd)}` : ""}` : "未定"], ["施工担当", o.workerIds.map((w) => userName(w)).join("・") || "-"], ["現場住所", o.siteAddress], ["完了日", o.completedAt ? fmtDate(o.completedAt) : "-"], ["売上計上日", o.salesDate ? fmtDate(o.salesDate) : "-"], ["承認者", userName(o.approvedBy)]]} />
            )}
          </Card>
          )}

          {tatamiSpec.rooms.length > 0 || o.handovers?.some((h) => h.item.startsWith("tatami_")) ? (
            <TatamiRoomsCard
              rooms={tatamiSpec.rooms}
              sourceLabel={ROOMS_SOURCE_LABEL[tatamiSpec.source]}
              auto={chain.quote ? quoteRooms(db, { items: chain.quote.items, siteInfo: o.siteInfo ?? chain.quote.siteInfo }).rooms : []}
              action={saveOrderTatamiRooms.bind(null, o.id)}
              editable={canEditProduction(user) && o.status !== "cancelled"}
              idPrefix={`or-${o.id}`}
              description="部屋ごとの畳数・畳表・畳縁 (縁無)・畳床・寸法。畳製造予定にそのまま出ます。決まっていない項目は空欄のままにして、現地の採寸のあとに入れてください"
            />
          ) : null}

          <MapInfoCard db={db} user={user} target={{ type: "order", id: o.id }} returnTo={returnTo} title="施工場所の地図・住宅地図" />

          <CaseStatusCard db={db} order={o} user={user} locked={lock.locked} />

          <SiteInfoCard info={o.siteInfo} action={updateSiteInfo.bind(null, "order", o.id)} returnTo={returnTo} canEdit={o.status !== "cancelled" && !lock.locked && !viewOnly} description={chain.quote?.siteInfo ? `見積 ${chain.quote.number} (手書き見積書の備考欄以下など) から引き継ぎ。施工担当者と共有し、予定表の施工のメモにも載ります` : undefined} />

          <Card>
            <CardHeader title="施工内容" description={chain.quote ? `見積 ${chain.quote.number} (第${chain.quote.version}版) から引き継ぎ。右の「案件情報」で変更できます (変更は進捗と変更履歴に残ります)` : "右の「案件情報」で入力・変更できます"} />
            {o.workDetails ? <p className="whitespace-pre-wrap text-sm text-ink">{o.workDetails}</p> : <p className="text-sm text-ink-3">施工内容は未入力です。</p>}
            {chain.quote && chain.quote.items.length > 0 && (
              <ul className="mt-3 space-y-0.5 border-t border-line pt-3 text-xs text-ink-2">
                {chain.quote.items.map((i) => <li key={i.id}>{i.name}{i.spec ? ` (${i.spec})` : ""} × {i.qty}{i.unit}</li>)}
              </ul>
            )}
          </Card>

          {canViewMgmtStore(policyReader(db, user), o.storeId) && <MgmtOrderCard db={db} order={o} />}

          {o.amounts && (
            <Card>
              <CardHeader
                title="売上の内訳 (税込)"
                description={[o.source === "import" ? "売上台帳から移行" : "", o.postcardNo ? `ハガキ No.${o.postcardNo}` : "", o.fusumaPaper ? `襖紙: ${o.fusumaPaper}` : "", o.tatamiCost ? `畳原価 ${yen(o.tatamiCost)}` : ""].filter(Boolean).join(" · ")}
              />
              <Dl
                columns={3}
                items={AMOUNT_LABEL.filter(([k]) => o.amounts![k]).map(([k, label]) => [label, yen(o.amounts![k])] as [string, string])}
              />
            </Card>
          )}

          <Card id="work-staff">
            <CardHeader
              title="作業の担当 (実績)"
              description={workStaff.source === "saved" ? `${workStaff.confirmedAt ? `施工完了で確定 (${fmtDateTime(workStaff.confirmedAt)}・${userName(workStaff.confirmedBy)})` : `保存済み (${fmtDateTime(workStaff.updatedAt ?? "")}・${userName(workStaff.updatedBy)})`}。この担当をインセンティブ (アンケートの担当) と経営の集計に使います` : "予定表の予定の担当者から自動で出しています。施工完了のときに確かめて確定します (この画面でいつでも直せます)"}
            />
            <Dl columns={2} items={WORK_ROLES.map((r) => [WORK_ROLE_LABEL[r], workStaff[r].map((id) => userName(id)).join("・") || "-"] as [string, string])} />
            {!viewOnly && !lock.locked && o.status !== "cancelled" && (
              <details className="mt-3">
                <summary className="cursor-pointer text-sm font-medium text-accent">担当を変更する</summary>
                <form action={saveWorkStaff.bind(null, o.id)} className="mt-2 space-y-3">
                  <WorkStaffFields staff={workStaffChoices} value={workStaff} />
                  <Button type="submit" size="sm">作業の担当を保存</Button>
                </form>
              </details>
            )}
          </Card>

          <CasePlanCard recordType="order" recordId={o.id} user={user} />
          <CaseScheduleCard
            events={chain.events}
            allEvents={db.schedule}
            users={new Map(db.users.map((u) => [u.id, u]))}
            stores={new Map(db.stores.map((s) => [s.id, s]))}
            today={today}
            newParams={`orderId=${o.id}`}
            returnTo={returnTo}
            quickKinds={["pickup", "delivery", "install", "site", "visit", "measure", "survey", "onsite_quote", "site_survey"]}
            canAdd={o.status !== "cancelled" && ownStore}
            quickAdd={
              planMode
                ? undefined
                : {
                    caseRef: `order:${o.id}`,
                    storeId: o.storeId,
                    kinds: ["install", "site", "visit", "measure", "pickup", "delivery"],
                    users: formUsers(db),
                    stores: formStores(db),
                    defaultAssigneeIds: o.workerIds.length ? [...o.workerIds] : [user.id],
                    currentUserId: user.id,
                    returnTo,
                    fullHref: `/schedule/new?orderId=${o.id}&returnTo=${encodeURIComponent(returnTo)}`,
                  }
            }
            description="引き取り・納品・施工・顧客訪問などを案件に登録すると、担当者とともに店舗の共通カレンダーへ自動で反映されます。問い合わせ段階の現地調査も含みます"
          />

          <Card>
            <CardHeader
              title="お客様アンケート"
              description={survey ? `はがき No.${survey.postcardNo ?? "-"} · 回答 ${fmtDate(survey.answeredOn ?? survey.receivedAt)}` : "施工後に返信いただいたアンケートはがきを登録すると、返信率・評価・KPI に反映されます"}
              action={survey ? <LinkButton href={`/kpi/surveys/${survey.id}`} variant="ghost" size="sm">詳細</LinkButton> : undefined}
            />
            {survey ? (
              <div className="space-y-2 text-sm">
                <div className="grid grid-cols-2 gap-2 @xl:grid-cols-4">
                  {SCORE_QUESTIONS.map((q) => (
                    <div key={q.key} className="rounded-lg bg-subtle/70 px-3 py-2">
                      <div className="text-[11px] text-ink-3">{q.no} {q.label}</div>
                      <div className="font-semibold tnum">{survey[q.key] ?? "-"}<span className="ml-1 text-[11px] font-normal text-ink-3">{survey[q.key] ? SCORE_LABEL[survey[q.key]!] : ""}</span></div>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-ink-2">
                  営業担当: {survey.salesUserId ? userName(survey.salesUserId) : survey.salesName ?? "-"} · 担当職人: {deliveryOf(survey).map((u) => userName(u)).join("・") || survey.craftsmanName || "-"}
                  {survey.media && <> · 依頼のきっかけ: {survey.media}</>}
                  {survey.wouldUseAgain && <> · 次回も依頼したい: {survey.wouldUseAgain}</>}
                </p>
                {survey.comment && <p className="rounded-lg border border-line px-3 py-2 text-xs text-ink">「{survey.comment}」</p>}
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                <LinkButton href="/capture?kind=survey_postcard" variant="secondary" size="sm">はがきを撮影して登録</LinkButton>
                <LinkButton href={`/kpi/surveys/new?orderId=${o.id}`} variant="ghost" size="sm">手入力で登録</LinkButton>
              </div>
            )}
          </Card>

          <Card>
            <CardHeader
              title="クレーム・手直し"
              description={`手直し ${qp.rework} 点 / クレーム ${qp.claim} 点 / クレーム＋手直し ${qp.claim_rework} 点。登録すると店舗・集計期間・ポイントが自動で KPI に反映されます`}
              action={<LinkButton href={`/kpi/quality?store=${o.storeId}`} variant="ghost" size="sm">一覧</LinkButton>}
            />
            {issues.length > 0 && (
              <ul className="mb-3 space-y-2">
                {issues.map((x) => (
                  <li key={x.id} className="rounded-lg border border-line px-3 py-2 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={`/kpi/quality/${x.id}`} className="font-medium text-accent hover:underline">{x.number}</Link>
                      <Badge tone={x.kind === "rework" ? "warn" : "critical"}>{QUALITY_KIND_LABEL[x.kind]} {x.points} 点</Badge>
                      <Badge tone={x.status === "resolved" ? "good" : "neutral"}>{x.status === "resolved" ? "解決済み" : "対応中"}</Badge>
                      <span className="text-ink-3">{fmtDate(x.occurredOn)} · 担当: {x.responsibleUserIds.map((u) => userName(u)).join("・")}</span>
                    </div>
                    <p className="mt-1 text-ink-2">{x.description}</p>
                    {(x.cause || x.countermeasure) && <p className="mt-1 text-ink-3">原因: {x.cause ?? "-"} / 対策: {x.countermeasure ?? "-"}</p>}
                  </li>
                ))}
              </ul>
            )}
            {o.status !== "cancelled" && o.status !== "pending_approval" && ownStore && (
              <details className="rounded-lg border border-line px-3 py-2">
                <summary className="cursor-pointer text-sm font-medium text-accent">クレーム・手直しを登録する</summary>
                <form action={createQualityIssue.bind(null, o.id)} className="mt-3 space-y-3">
                  <input type="hidden" name="returnTo" value={returnTo} />
                  <fieldset>
                    <legend className="label">区分</legend>
                    <div className="grid grid-cols-1 gap-2 @xl:grid-cols-3">
                      {(["rework", "claim", "claim_rework"] as const).map((k, i) => (
                        <label key={k} className="flex cursor-pointer gap-2 rounded-lg border border-line p-2 text-xs has-[:checked]:border-accent has-[:checked]:bg-accent-soft/50">
                          <input type="radio" name="kind" value={k} defaultChecked={i === 0} className="mt-0.5" />
                          <span><span className="font-medium text-ink">{QUALITY_KIND_LABEL[k]} ({qp[k]} 点)</span><br /><span className="text-ink-3">{QUALITY_KIND_HELP[k]}</span></span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <QualityGuide />
                  <div className="grid grid-cols-1 gap-3 @xl:grid-cols-3">
                    <Field label="発生日" required><Input type="date" name="occurredOn" defaultValue={today} required /></Field>
                    <Field label="ポイントの単位 (原因)" hint="見積の原因は売上の店舗">
                      <Select name="attribution" defaultValue="store"><option value="store">店舗 (施工・見積の原因)</option><option value="office">事務 (事務の原因)</option></Select>
                    </Field>
                    <Field label="カテゴリー">
                      <Select name="category" defaultValue=""><option value="">(未選択)</option>{QUALITY_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</Select>
                    </Field>
                  </div>
                  <fieldset>
                    <legend className="label">対象の担当者 (複数可)</legend>
                    <div className="flex flex-wrap gap-1.5">
                      {staffChoices.map((u) => (
                        <label key={u.id} className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-line px-2.5 py-1 text-xs has-[:checked]:border-accent has-[:checked]:bg-accent-soft">
                          <input type="checkbox" name="responsibleUserIds" value={u.id} defaultChecked={o.workerIds.includes(u.id)} className="h-3.5 w-3.5" />
                          {u.name}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <Field label="内容" required><Textarea name="description" required rows={2} placeholder="例: 納品時に畳のへりの浮きに気づき、持ち帰って修正" /></Field>
                  <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
                    <Field label="原因 (分かれば)"><Textarea name="cause" rows={2} /></Field>
                    <Field label="対策・再発防止 (分かれば)"><Textarea name="countermeasure" rows={2} /></Field>
                  </div>
                  <div className="flex flex-wrap gap-4 text-xs text-ink-2">
                    <label className="flex items-center gap-2"><input type="checkbox" name="resolved" className="h-4 w-4" /> 原因と対策まで入力済み (解決済みにする)</label>
                    <label className="flex items-center gap-2"><input type="checkbox" name="notCounted" className="h-4 w-4" /> 記録のみ (点検 DM・点検電話から分かったもの、お客様が原因のものなど。集計しない)</label>
                  </div>
                  <Button type="submit" size="sm">登録する</Button>
                </form>
              </details>
            )}
          </Card>

          {chain.quote && db.attachments.some((a) => a.parentType === "quote" && a.parentId === chain.quote!.id) && (
            <Card>
              <CardHeader title="見積の資料 (手書き見積書の元の画像など)" description={`見積 ${chain.quote.number} に保存した写真・PDF です`} />
              <div className="flex flex-wrap gap-2">
                {db.attachments.filter((a) => a.parentType === "quote" && a.parentId === chain.quote!.id).map((a) => (
                  <a key={a.id} href={`/api/attachments/${a.id}`} target="_blank" rel="noopener" className="block w-28 overflow-hidden rounded-lg border border-line bg-subtle text-[10px] text-ink-2 hover:border-accent">
                    {a.kind === "photo" ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={`/api/attachments/${a.id}${a.thumbKey ? "?size=thumb" : ""}`} alt={a.fileName} className="h-24 w-full object-cover" />
                    ) : (
                      <span className="flex h-24 items-center justify-center">PDF</span>
                    )}
                    <span className="block truncate px-1.5 py-1">{a.fileName}</span>
                  </a>
                ))}
              </div>
            </Card>
          )}

          <AttachmentsCard db={db} user={user} parent={{ type: "order", id: o.id }} returnTo={returnTo} title="現場写真・資料" description="施工前・施工中・完了の写真や図面を、スマートフォンのカメラ・アルバムから複数枚まとめて登録できます。この店舗の担当者・本部・管理者だけが表示できます" />
          <OrderCasePostsCard db={db} user={user} order={o} />

          <Card>
            <CardHeader title="進捗の記録" description="現場からスマートフォンで記録。写真は上の「現場写真・資料」に登録します" />
            {active && (
              <form action={addProgress.bind(null, o.id)} className="mb-4 grid grid-cols-1 gap-2 @xl:grid-cols-[160px_1fr_auto]">
                <Select name="kind" defaultValue={o.status === "in_progress" ? "install" : "note"}>
                  {(Object.keys(PROGRESS_KIND_LABEL) as (keyof typeof PROGRESS_KIND_LABEL)[]).filter((k) => k !== "complete").map((k) => <option key={k} value={k}>{PROGRESS_KIND_LABEL[k]}</option>)}
                </Select>
                <Input name="body" placeholder="例: 現場到着、古畳の引取開始" required />
                <Button type="submit" size="md" variant="secondary">記録</Button>
              </form>
            )}
            <ol className="relative space-y-3 border-l border-line pl-4">
              {[...o.progressNotes].reverse().map((n) => (
                <li key={n.id} className="text-sm">
                  <span className="absolute -left-1 mt-1.5 h-2 w-2 rounded-full bg-accent" aria-hidden />
                  <div className="flex flex-wrap items-center gap-2 text-xs text-ink-3"><span className="tnum">{fmtDateTime(n.at)}</span><Badge dot={false}>{PROGRESS_KIND_LABEL[n.kind]}</Badge>{userName(n.userId)}</div>
                  <div className="text-ink">{n.body}</div>
                </li>
              ))}
            </ol>
          </Card>

          <Card>
            <CardHeader title="やりとりの記録 (お客様・協力業者)" description="この案件のお客様・協力業者・仕入先とのやりとりを残します。見積・請求・仕入に紐付いた記録もここに集まります" />
            {o.status !== "cancelled" && <ContactLogForm returnTo={returnTo} customerId={o.customerId} caseRef={o.number} suppliers={partners} defaultChannel={customer?.preferredChannel === "line" || orderGroups.length ? "line" : "phone"} canSend lineGroups={orderGroups.map((g) => ({ id: g.id, label: lineGroupName(g) }))} />}
            <p className="mt-1 text-[11px] text-ink-3">協力業者を選ぶと協力業者とのやりとりとして、選ばないとお客様とのやりとりとして記録します。</p>
            {(orderGroups.length > 0 || (freeGroups.length > 0 && o.status !== "cancelled")) && (
              <div className="mt-3 space-y-2 rounded-lg bg-subtle px-3 py-2 text-xs text-ink-2">
                <div className="font-medium text-ink">LINE グループ (現場のグループ)</div>
                {orderGroups.map((g) => (
                  <form key={g.id} action={unlinkLineGroup} className="flex flex-wrap items-center gap-2">
                    <input type="hidden" name="groupId" value={g.id} />
                    <input type="hidden" name="returnTo" value={returnTo} />
                    <Badge tone="good">ひも付け済み</Badge>
                    <span className="text-ink">{lineGroupName(g)}</span>
                    {g.lastMessageAt && <span className="text-ink-3">最後のメッセージ {fmtDateTime(g.lastMessageAt)}</span>}
                    <Button type="submit" size="sm" variant="secondary">外す</Button>
                  </form>
                ))}
                {freeGroups.length > 0 && o.status !== "cancelled" && (
                  <form action={linkLineGroup} className="flex flex-wrap items-center gap-2">
                    <input type="hidden" name="orderRef" value={o.number} />
                    <input type="hidden" name="returnTo" value={returnTo} />
                    <Select name="groupId" defaultValue="" className="h-8 w-56 text-xs" aria-label="ひも付ける LINE グループ" required>
                      <option value="" disabled>未登録のグループを選ぶ</option>
                      {freeGroups.map((g) => <option key={g.id} value={g.id}>{lineGroupName(g)}{g.pending.length ? ` (保留 ${g.pending.length} 件)` : ""}</option>)}
                    </Select>
                    <Button type="submit" size="sm">この案件にひも付ける</Button>
                  </form>
                )}
                <p className="text-[11px] text-ink-3">ひも付けたグループのメッセージはこの履歴に、写真・資料は「現場写真・資料」に自動で残ります。上のフォームで手段を LINE にすると、グループへ送れます。</p>
              </div>
            )}
            <div className="mt-3 border-t border-line pt-3">
              <ContactList db={db} logs={contactLogs} returnTo={returnTo} empty="この案件のやりとりの記録はありません" />
            </div>
          </Card>

          {!viewOnly && (orderPurchases.length > 0 || canRegisterPurchase(user)) && (
            <Card>
              <CardHeader title="この案件の仕入・外注" description={orderPurchases.length ? `${orderPurchases.length} 件 · ${yen(orderPurchases.filter((p) => p.status !== "rejected").reduce((a, p) => a + p.amount, 0))}` : "協力業者への外注・材料の仕入を案件に紐付けて登録できます"} action={canRegisterPurchase(user) && ownStore && o.status !== "cancelled" ? <LinkButton href={`/purchases/new?orderRef=${encodeURIComponent(o.number)}`} variant="ghost" size="sm">仕入を登録</LinkButton> : undefined} />
              {orderPurchases.length > 0 && (
                <ul className="space-y-1 text-xs">
                  {orderPurchases.map((p) => (
                    <li key={p.id} className="flex flex-wrap items-center gap-2">
                      {canManageFinance(user) || p.storeId === user.storeId ? <Link href={`/purchases/${p.id}`} className="font-mono text-accent hover:underline">{p.number}</Link> : <span className="font-mono">{p.number}</span>}
                      <span>{db.suppliers.find((s) => s.id === p.supplierId)?.name}</span>
                      <span className="tnum">{yen(p.amount)}</span>
                      <span className="text-ink-3">{p.description}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}

          {!viewOnly && (
          <Card padded={false}>
            <div className="p-5 pb-0">
              <CardHeader
                title="発注書 (仕入先への発注)"
                description={orderPos.length ? `${orderPos.length} 件 · 同じ仕入先への別の案件の材料と 1 枚にまとめた発注書も含みます` : "この案件の材料を仕入先へ発注し、FAX で送れます"}
                action={canManagePurchaseOrders(user) && ownStore && o.status !== "cancelled" ? <LinkButton href={`/purchase-orders/new?orderId=${o.id}`} size="sm">発注書を作成</LinkButton> : undefined}
              />
            </div>
            <div className="px-2 pb-2"><PurchaseOrderTable db={db} user={user} rows={orderPos} /></div>
          </Card>
          )}

          {!viewOnly && <FaxHistoryCard db={db} user={user} faxes={orderFaxes} title="この案件の FAX (発注書の送信・仕入先の返信)" />}

          {active && (
            <Card id="complete">
              <CardHeader title="施工完了 → 売上計上" description={`完了を登録すると、施工完了日を売上計上日として売上に計上します (経営ダッシュボード・会計データとも)。${batchBilling ? "このお客様はまとめ請求のため、請求書は締め日にまとめて発行します" : "続けて請求書を発行できます (請求書の発行日は別に持ちます)"}`} />
              <form action={completeOrder.bind(null, o.id)} className="space-y-3">
                {/* 作業の担当を確かめてから完了にする (インセンティブの集計の起点。お客様のご要望 2026-11-25「④」) */}
                <div className="rounded-xl border border-accent/30 bg-accent-soft/20 p-3">
                  <div className="mb-1 text-sm font-semibold text-ink">作業の担当を確かめてください</div>
                  <p className="mb-2 text-[11px] text-ink-3">{workStaff.source === "saved" ? "保存した担当です。" : "予定表の予定の担当者から入れています。"}実際に作業した人に直してください (複数名可)。完了の登録と一緒に確定し、インセンティブ (アンケートの担当) と経営の集計に使います。</p>
                  <WorkStaffFields staff={workStaffChoices} value={workStaff} />
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <Field label="施工完了日 (= 売上計上日)"><Input type="date" name="completedAt" defaultValue={toDateKey(new Date())} /></Field>
                  <Field label="メモ" className="w-full @xl:w-72"><Input name="body" placeholder="施工完了。お客様確認済み。" /></Field>
                  <Button type="submit">施工完了を登録</Button>
                </div>
              </form>
              {isManagerOrAbove(user) && (
                <form action={cancelOrder.bind(null, o.id)} className="mt-4 flex flex-wrap items-end gap-2 border-t border-line pt-3">
                  <Field label="キャンセル理由" className="w-full @xl:w-72"><Input name="reason" /></Field>
                  <Button type="submit" variant="danger" size="sm">受注をキャンセル</Button>
                </form>
              )}
            </Card>
          )}

          {o.status === "completed" && batchBilling && (
            <Card>
              <CardHeader title="締め日にまとめて請求" description={`このお客様はまとめ請求 (${batchTermsLabel}) です。締め日に、ほかの完了した案件と 1 枚の請求書にまとめて発行します。売上計上日は施工完了日 (${fmtDate(o.salesDate)}) のままです`} action={<LinkButton href={`/invoices/batch?month=${batchMonth}`} variant="secondary" size="sm">まとめ請求の画面</LinkButton>} />
            </Card>
          )}
          {o.status === "completed" && (
            <Card id="invoice">
              {batchBilling ? (
                <details>
                  <summary className="cursor-pointer text-sm font-medium text-accent">この案件だけ請求書を発行する (必要なときだけ)</summary>
                  <p className="mb-3 mt-1 text-xs text-ink-3">まとめ請求のお客様ですが、この案件だけ別に請求するときに使います。発行すると締め日のまとめ請求には入りません</p>
                  {perOrderInvoice}
                </details>
              ) : (
                <>
                  <CardHeader title="請求書を発行" description="見積の内訳から自動作成。送付方法はお客様の希望に合わせて。請求書の発行日は今日 (売上計上日とは別)" />
                  {perOrderInvoice}
                </>
              )}
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title="案件情報" description={lock.locked ? "入金完了・全処理完了の案件のため変更できません (管理者が変更できます)" : "件名・種別・現場住所を変更できます。担当店舗の変更は本部スタッフ・管理者"} />
            <ReadOnlyArea readOnly={lock.locked}>
            <form action={updateOrderInfo.bind(null, o.id)} className="space-y-2">
              <Field label="件名" required><Input name="title" defaultValue={o.title} required /></Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="種別">
                  <Select name="category" defaultValue={o.category}>
                    {(Object.keys(CATEGORY_LABEL) as (keyof typeof CATEGORY_LABEL)[]).map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
                  </Select>
                </Field>
                <Field label="担当店舗 (売上計上)" hint={orderArea ? `施工場所の担当エリア: ${orderArea.storeName}${orderArea.storeId !== o.storeId ? " (今の担当店舗と違います)" : ""}` : undefined}>
                  <Select name="storeId" defaultValue={o.storeId} disabled={!canSeeAllStores(user) || ["invoiced", "paid", "cancelled"].includes(o.status)}>
                    {db.stores.map((s) => <option key={s.id} value={s.id}>{s.name}{s.id === orderArea?.storeId ? " (担当エリア)" : ""}</option>)}
                  </Select>
                </Field>
              </div>
              <Field label="施工場所 (現場住所)" hint="お客様の住所と違うとき (ご実家など) はここを変えます"><Input name="siteAddress" defaultValue={o.siteAddress} /></Field>
              <Field label="領収書の宛名" hint={`空欄なら「${customer?.name ?? "お客様名"}」。会社名義などで変えるとき (「御中」と書けば御中で出します)`}><Input name="receiptName" defaultValue={o.receiptName} placeholder={customer?.name} /></Field>
              <Field label="施工内容"><Textarea name="workDetails" defaultValue={o.workDetails} rows={3} /></Field>
              <Button type="submit" size="sm" variant="secondary">変更する</Button>
            </form>
            </ReadOnlyArea>
          </Card>
          <Card>
            <CardHeader title="お客様" />
            {customer && <Dl columns={1} items={[["氏名", <Link key="n" href={`/customers/${customer.id}`} className="text-accent hover:underline">{customer.name}</Link>], ["電話", customerPhonesText(customer) || "-"], ["住所", customer.address || "-"], ["施工場所", o.siteAddress && o.siteAddress !== customer.address ? o.siteAddress : "お客様の住所と同じ"], ["領収書の宛名", o.receiptName || `${customer.name} (顧客名)`], ["希望連絡手段", CHANNEL_LABEL[customer.preferredChannel]]]} />}
            {customer?.tradeStopped && <p className="mt-2 rounded-lg bg-critical-soft px-2.5 py-1.5 text-xs text-critical-ink">取引停止のお客様です{customer.tradeStopNote ? ` (${customer.tradeStopNote})` : ""}。</p>}
            {/* 紐付け間違いの修正: 案件の内容はそのままに、お客様だけを付け替える (お客様のご要望 2026-11-25「⑤」) */}
            {!viewOnly && !lock.locked && o.status !== "cancelled" && (
              <details className="mt-3 border-t border-line pt-2" id="relink">
                <summary className="cursor-pointer text-xs font-medium text-accent">紐付け先のお客様を直す</summary>
                {relinkBlocked ? <p className="mt-1 text-xs text-ink-3">{relinkBlocked}</p> : (
                  <div className="mt-2">
                    <p className="mb-2 text-[11px] text-ink-3">正しいお客様を検索して「付け替える」を押すと、問い合わせ・見積・受注・予定などの内容はそのままで、紐付け先だけが変わります。</p>
                    <CaseCustomerSearch action={relinkCase.bind(null, o.id)} returnTo={`/orders/${o.id}`} />
                  </div>
                )}
              </details>
            )}
          </Card>
          <Card>
            <CardHeader title="関連情報" />
            <ul className="space-y-2 text-sm">
              <li>問い合わせ: {chain.inquiry ? <Link href={`/inquiries/${chain.inquiry.id}`} className="text-accent hover:underline">{chain.inquiry.number}</Link> : <span className="text-ink-3">-</span>}</li>
              <li>見積: {chain.quote ? <><Link href={`/quotes/${chain.quote.id}`} className="text-accent hover:underline">{chain.quote.number}</Link> <StatusBadge value={chain.quote.status} map={QUOTE_STATUS} /></> : "-"}</li>
              <li>請求: {chain.invoice ? <><Link href={`/invoices/${chain.invoice.id}`} className="text-accent hover:underline">{chain.invoice.number}</Link> <StatusBadge value={chain.invoice.status} map={INVOICE_STATUS} /> <span className="text-xs text-ink-3">発行 {fmtDate(chain.invoice.issueDate)}{isBatchInvoice(chain.invoice) ? ` · まとめ請求 ${chain.invoice.orderIds?.length ?? 1} 件` : ""}</span></> : <span className="text-ink-3">{batchBilling && o.status === "completed" ? "未発行 (締め日にまとめて請求)" : "未発行"}</span>}</li>
              <li>入金: {chain.payments.length > 0 ? `${yen(chain.payments.reduce((a, p) => a + p.amount, 0))} (${chain.payments.length} 件${chain.invoice && isBatchInvoice(chain.invoice) ? "・請求書全体" : ""})` : <span className="text-ink-3">-</span>}</li>
            </ul>
          </Card>

          {o.status !== "cancelled" && !pendingChange && !lock.locked && (
            <Card>
              <CardHeader title={ownChange ? "契約内容の変更 (承認不要)" : "契約内容の変更 (承認が必要)"} description={`${chain.quote ? "契約日を変更できます。金額は見積の画面の「変更を申請」で直します (版として残ります)" : "契約日・契約金額の変更を申請します。承認されると反映し、変更前後を履歴に残します"}${o.completedAt ? "。施工完了日・売上計上日の入力の誤りもここで直します (会計データ・経営ダッシュボードの月が変わります)" : ""}`} />
              <form action={requestOrderChange.bind(null, o.id)} className="space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <Field label="契約日"><Input type="date" name="contractDate" defaultValue={o.contractDate} /></Field>
                  {!chain.quote && <Field label="契約金額 (税込)"><Input type="number" name="total" defaultValue={o.total} min={1} /></Field>}
                  {o.completedAt && ["completed", "invoiced", "paid"].includes(o.status) && (
                    <>
                      <Field label="施工完了日" hint="直すと売上計上日も合わせます"><Input type="date" name="completedAt" defaultValue={o.completedAt} /></Field>
                      <Field label="売上計上日" hint="原則は施工完了日。請求書の発行日は変わりません"><Input type="date" name="salesDate" defaultValue={o.salesDate} /></Field>
                    </>
                  )}
                </div>
                <Field label="変更の理由" required><Input name="reason" required placeholder="例: お客様のご要望で追加工事" /></Field>
                <Button type="submit" size="sm" variant="secondary">{ownChange ? "契約内容を変更する (承認不要)" : "変更を申請する"}</Button>
              </form>
            </Card>
          )}

          <AiSummary kind="order" id={o.id} />
          <RecordDocDrafts db={db} user={user} type="order" id={o.id} number={o.number} />
          <RecordStamp db={db} targets={[{ entity: "order", id: o.id }]} created={{ by: o.createdBy, at: o.createdAt }} approved={o.approvedBy ? [{ by: o.approvedBy }] : []} />
          <CaseRequestsCard db={db} user={user} ids={[o.id, chain.quote?.id, chain.quote?.inquiryId]} caseId={o.id} storeId={o.storeId} returnTo={`/orders/${o.id}`} />
          <CaseStoreCard db={db} user={user} recordId={o.id} canEdit={!viewOnly} returnTo={`/orders/${o.id}`} />
          <CaseChangeHistory db={db} ids={[o.id, chain.quote?.id, chain.quote?.inquiryId]} />
          <HistoryCard
            db={db}
            user={user}
            targets={[{ entity: "order", id: o.id }, ...(chain.quote ? [{ entity: "quote", id: chain.quote.id }] : []), ...(chain.invoice ? [{ entity: "invoice", id: chain.invoice.id }, { entity: "payment", id: chain.invoice.id }] : [])]}
            description="この案件 (見積・請求を含む) の登録・変更・承認の記録。変更した項目は変更前と変更後の値を残しています"
          />
          <ApprovalHistoryCard approvals={chain.approvals} />
        </div>
      </div>
      </ReadOnlyArea>
    </div>
  );
}
