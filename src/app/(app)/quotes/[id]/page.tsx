import { CaseChangeHistory } from "@/components/features/CaseChangeHistory";
import { CaseRequestsCard } from "@/components/features/CaseRequestsCard";
import { CaseCustomerSearch } from "@/components/features/LinkSearch";
import { relinkCase } from "@/lib/actions/case-quick";
import { caseRelinkBlocker } from "@/lib/customer-link";
import { caseChainOf } from "@/lib/case-store";
import Link from "@/components/ui/Link";
import { CaseViewBanner, CompletedLockBanner, ReadOnlyArea } from "@/components/features/CaseAccess";
import { quoteAccessInfo, quoteCompletedLock, deniedHref } from "@/lib/case-access";
import { logRecordView } from "@/lib/record-views";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { staffForStore } from "@/lib/staff-choices";
import { canAccessStore, canApprove, canEditProduction, skipsApproval } from "@/lib/auth/permissions";
import { TatamiRoomsCard } from "@/components/schedule/TatamiRoomsCard";
import { saveQuoteTatamiRooms } from "@/lib/actions/tatami-rooms";
import { ROOMS_SOURCE_LABEL, orderRooms, quoteRooms } from "@/lib/tatami-rooms";
import { quoteChain, userName } from "@/lib/db/queries";
import { convertQuoteToOrder, deleteQuote, markQuoteLost, sendQuote, submitQuote } from "@/lib/actions/quotes";
import { fmtDate, fmtDateTime, yen } from "@/lib/format";
import { APPROVAL_TYPE_LABEL, CATEGORY_LABEL, CHANNEL_LABEL, INVOICE_STATUS, ORDER_STATUS, QUOTE_STATUS } from "@/lib/constants";
import { customerPhonesText } from "@/lib/customer-contacts";
import { Badge, Button, Card, CardHeader, Dl, Field, Flash, Input, LinkButton, Note, PageHeader, Select, StatusBadge, StoreTag } from "@/components/ui";
import { ApprovalDecision, ApprovalHistoryCard, HistoryCard, RecordStamp } from "@/components/features/History";
import { ContactList, ContactLogForm } from "@/components/features/Contacts";
import { SendDocumentCard } from "@/components/features/SendDocument";
import { AttachmentsCard } from "@/components/attachments/AttachmentsCard";
import { MapInfoCard } from "@/components/maps/MapInfoCard";
import { SiteInfoCard } from "@/components/features/SiteInfo";
import { setQuoteDiscussing, updateSiteInfo } from "@/lib/actions/cases";
import { CaseScheduleCard } from "@/components/schedule/CaseSchedule";
import { CaseFlowBar } from "@/components/features/CaseFlowBar";
import { caseFlow } from "@/lib/case-flow";
import { formStores, formUsers } from "@/components/schedule/form-data";
import { CasePlanCard } from "@/components/scheduling/CasePlanCard";
import { caseEvents } from "@/lib/db/schedule";
import { hasHandoverItems } from "@/lib/handover";
import { quoteHandoverLines } from "@/lib/handover-save";
import { toDateKey } from "@/lib/format";
import { AiSummary } from "@/components/features/AiSummary";
import { RecordDocDrafts } from "@/components/features/DocDrafts";

/** 見積書の PDF を作ってメールで送る (送信の応答を待つ) ため */
export const maxDuration = 60;

export default async function QuoteDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string; err?: string }> }) {
  const { id } = await params;
  const { msg, err } = await searchParams;
  const user = await requireUser();
  /** 管理者 (社長) の申請は承認を省略して、そのまま反映される (permissions.ts の skipsApproval) */
  const own = skipsApproval(user, "quote");
  const db = getDb();
  const q = db.quotes.find((x) => x.id === id);
  if (!q) notFound();
  // ほかの店舗の記録は閲覧のみ (見られる範囲は閲覧の範囲の設定と案件の進み具合。承認制で申請できるときはお客様の画面の「閲覧の申請」へ。src/lib/case-access.ts)
  const info = quoteAccessInfo(db, user, q);
  if (info.access === "none") redirect(deniedHref(info, "/quotes", "見積"));
  const viewOnly = info.access === "view";
  logRecordView(user, info, { entity: "quote", id: q.id, label: q.number, storeId: q.storeId }, db.auditLogs);
  const lock = quoteCompletedLock(db, user, q);
  const relinkChain = caseChainOf(db, q.id);
  const relinkBlocked = relinkChain ? caseRelinkBlocker(db, relinkChain) : undefined;
  const customer = db.customers.find((c) => c.id === q.customerId);
  const store = db.stores.find((s) => s.id === q.storeId);
  const chain = quoteChain(db, q);
  const pending = chain.approvals.find((a) => a.status === "pending" && (a.type === "quote" || a.type === "quote_amend"));
  const canDecide = pending ? canApprove(user, pending) : false;
  const workers = staffForStore(db, q.storeId);
  const returnTo = `/quotes/${id}`;
  const doc = db.documents.find((d) => d.id === q.documentId);

  return (
    <div>
      <Flash msg={msg} err={err} />
      <PageHeader
        title={`${q.number}${q.version > 1 ? ` (第${q.version}版)` : ""} ${q.title}`}
        badge={<><StatusBadge value={q.status} map={QUOTE_STATUS} />{q.pendingChange && <Badge tone="warn">変更 承認待ち</Badge>}{q.source === "ocr" && <Badge tone="accent" dot={false}>書類取込から作成</Badge>}</>}
        description={<span className="inline-flex flex-wrap items-center gap-2">{customer?.name} 様 · {CATEGORY_LABEL[q.category]} · <StoreTag store={store} /> · 見積担当 {userName(q.estimatorId ?? q.createdBy)} · 作成 {userName(q.createdBy)} {fmtDate(q.createdAt)}{q.paperNo ? ` · 手書き見積書 No.${q.paperNo}` : ""}{q.handedOver ? " · 現場で手渡し済み" : ""}</span>}
        back={{ href: "/quotes", label: "見積一覧" }}
        actions={
          viewOnly ? undefined : <>
            <LinkButton href={`/api/pdf/quotes/${q.id}`} variant="secondary" size="sm" target="_blank">見積書 PDF</LinkButton>
            <LinkButton href={`/print/quotes/${q.id}`} variant="ghost" size="sm">画面で表示・印刷</LinkButton>
            {["draft", "approved", "sent", "accepted"].includes(q.status) && !q.pendingChange && !lock.locked && <LinkButton href={`/quotes/${q.id}/edit`} variant="secondary" size="sm">{q.status === "draft" ? "編集" : "変更を申請 (金額・数量・施工内容)"}</LinkButton>}
          </>
        }
      />
      {viewOnly && <CaseViewBanner storeName={store?.name ?? "ほかの店舗"} what="見積" basis={info.basis} grantUntil={info.grantUntil} />}
      <CaseFlowBar flow={caseFlow(db, { quoteId: q.id }, new Date())} />
      {!viewOnly && lock.reason && <CompletedLockBanner reason={lock.reason} admin={!lock.locked} />}
      <ReadOnlyArea readOnly={viewOnly || lock.locked}>

      {q.status === "pending_approval" && pending && (
        <Card className="mb-4 border-warn/40 bg-warn-soft/40">
          <CardHeader title={`承認待ち: ${APPROVAL_TYPE_LABEL[pending.type]}`} description={`${pending.requiredRole === "admin" ? "管理者" : "店長"}の承認が必要 · 申請 ${userName(pending.requestedBy)} ${fmtDateTime(pending.createdAt)}${pending.requestComment ? ` · ${pending.requestComment}` : ""}`} />
          <ApprovalDecision approval={pending} user={user} returnTo={returnTo} waitingText="承認者の確認を待っています。" />
        </Card>
      )}
      {q.status === "draft" && (() => {
        const last = chain.approvals.filter((a) => a.targetId === q.id && a.type === "quote" && (a.status === "returned" || a.status === "rejected")).sort((a, b) => (b.decidedAt ?? "").localeCompare(a.decidedAt ?? ""))[0];
        return last ? <Note tone="warn">{last.status === "returned" ? "差し戻されました" : "却下されました"} ({userName(last.decidedBy)} · {fmtDateTime(last.decidedAt)}): {last.decisionComment ?? "理由の記入なし"}。{last.status === "returned" ? "内容を修正して再申請してください。" : ""}</Note> : null;
      })()}

      {q.pendingChange && pending?.type === "quote_amend" && (
        <Card className="mb-4 border-warn/40">
          <CardHeader title="承認待ちの変更内容" description={`申請 ${userName(q.pendingChange.requestedBy)} ${fmtDateTime(q.pendingChange.requestedAt)} · 理由: ${q.pendingChange.reason}`} />
          <div className="grid grid-cols-1 gap-4 @xl:grid-cols-2">
            <div>
              <div className="mb-1 text-xs font-medium text-ink-3">変更前 (第{q.version}版) · 合計 {yen(q.total)}</div>
              <ul className="space-y-0.5 text-xs text-ink-2">{q.items.map((i) => <li key={i.id}>{i.name} × {i.qty}{i.unit} = {yen(i.amount)}</li>)}</ul>
              {q.pendingChange.title !== undefined && q.pendingChange.title !== q.title && <p className="mt-1 text-xs text-ink-2">件名: {q.title}</p>}
              {q.pendingChange.workDetails !== undefined && q.pendingChange.workDetails !== (q.workDetails ?? "") && <p className="mt-1 whitespace-pre-wrap text-xs text-ink-2">施工内容: {q.workDetails || "(なし)"}</p>}
            </div>
            <div>
              <div className="mb-1 text-xs font-medium text-warn-ink">変更後 (第{q.version + 1}版の案) · 合計 {yen(q.pendingChange.total)}</div>
              <ul className="space-y-0.5 text-xs text-ink">{q.pendingChange.items.map((i, idx) => <li key={idx}>{i.name} × {i.qty}{i.unit} = {yen(i.amount)}</li>)}</ul>
              {q.pendingChange.title !== undefined && q.pendingChange.title !== q.title && <p className="mt-1 text-xs text-ink">件名: {q.pendingChange.title}</p>}
              {q.pendingChange.workDetails !== undefined && q.pendingChange.workDetails !== (q.workDetails ?? "") && <p className="mt-1 whitespace-pre-wrap text-xs text-ink">施工内容: {q.pendingChange.workDetails || "(なし)"}</p>}
            </div>
          </div>
          <div className="mt-4">
            <ApprovalDecision approval={pending} user={user} returnTo={returnTo} approveLabel="変更を承認する" />
          </div>
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
                <tr className="border-t border-line"><td colSpan={4} className="px-5 py-1.5 text-right text-ink-2">小計{q.taxExempt ? "" : q.taxIncluded ? " (税込)" : " (税抜)"}</td><td className="px-5 py-1.5 text-right tnum">{yen(q.subtotal)}</td></tr>
                {q.discount > 0 && <tr><td colSpan={4} className="px-5 py-1.5 text-right text-ink-2">値引き</td><td className="px-5 py-1.5 text-right tnum">-{yen(q.discount)}</td></tr>}
                <tr><td colSpan={4} className="px-5 py-1.5 text-right text-ink-2">{q.taxExempt ? "消費税" : q.taxIncluded ? "うち消費税 (10%)" : "消費税 (10%)"}</td><td className="px-5 py-1.5 text-right tnum">{q.taxExempt ? "非課税" : yen(q.tax)}</td></tr>
                <tr className="border-t border-line font-semibold"><td colSpan={4} className="px-5 py-2 text-right">{q.taxExempt ? "合計 (非課税)" : "合計 (税込)"}</td><td className="px-5 py-2 text-right text-base tnum">{yen(q.total)}</td></tr>
              </tfoot>
            </table>
            {q.workDetails && <div className="border-t border-line px-5 py-3 text-xs text-ink-2"><div className="font-medium text-ink">施工内容</div><p className="mt-1 whitespace-pre-wrap">{q.workDetails}</p></div>}
            {q.notes && <p className="border-t border-line px-5 py-3 text-xs text-ink-2">備考: {q.notes}</p>}
          </Card>

          <SiteInfoCard info={q.siteInfo} action={updateSiteInfo.bind(null, "quote", q.id)} returnTo={returnTo} canEdit={!["rejected", "expired"].includes(q.status)} />

          {(() => {
            // 畳の仕様 (部屋ごと。畳表・畳縁・畳床・寸法)。受注にした見積は受注の仕様 (畳製造予定は受注の仕様を使う)
            const ord = q.orderId ? db.orders.find((x) => x.id === q.orderId) : undefined;
            const spec = ord ? orderRooms(db, ord) : quoteRooms(db, q);
            if (!spec.rooms.length && !q.tatamiRooms) return null;
            return (
              <TatamiRoomsCard
                rooms={spec.rooms}
                sourceLabel={ROOMS_SOURCE_LABEL[spec.source]}
                auto={quoteRooms(db, { items: q.items, siteInfo: q.siteInfo }).rooms}
                action={saveQuoteTatamiRooms.bind(null, q.id)}
                editable={!ord && canEditProduction(user) && !["rejected", "expired"].includes(q.status)}
                idPrefix={`qt-${q.id}`}
                description="見積の明細と手書きの備考 (サイズ・わら・建材) から部屋ごとの仕様を入れています。受注にすると畳製造予定にそのまま出ます。決まっていない項目 (建材床の厚み・寸法など) は空欄のままで、あとから入れられます"
                note={ord ? <p className="mt-2 text-xs text-ink-2">受注 <Link href={`/orders/${ord.id}#tatami-rooms`} className="text-accent-ink underline">{ord.number}</Link> の画面で入力・変更します。</p> : undefined}
              />
            );
          })()}

          {["approved", "sent"].includes(q.status) && !q.orderId && (
            <Card>
              <CardHeader title="お客様の検討状況" description={q.specStatus === "discussing" ? "打合せ中 (仕様・金額をお客様と調整中)" : "見積をお渡しして回答待ち (TEL待ち)"} />
              <form action={setQuoteDiscussing.bind(null, q.id)} className="flex flex-wrap items-center gap-2">
                <input type="hidden" name="discussing" value={q.specStatus === "discussing" ? "0" : "1"} />
                <Button type="submit" variant="secondary" size="sm">{q.specStatus === "discussing" ? "打合せ中を解除 (回答待ちに戻す)" : "打合せ中にする"}</Button>
                <span className="text-[11px] text-ink-3">案件一覧の「見積・仕様」に反映されます。</span>
              </form>
            </Card>
          )}

          {(q.revisions?.length ?? 0) > 0 && (
            <Card padded={false}>
              <div className="px-5 pt-5"><CardHeader title="版の履歴 (改訂)" description="変更が承認されるたびに、変更前の版を残しています。各版の見積書 PDF を出力できます" /></div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-sm">
                  <thead><tr className="bg-subtle text-xs text-ink-2"><th className="px-5 py-2 text-left font-medium">版</th><th className="px-3 py-2 text-right font-medium">合計</th><th className="px-3 py-2 text-left font-medium">変更理由・承認</th><th className="px-5 py-2 text-right font-medium">見積書</th></tr></thead>
                  <tbody>
                    <tr className="border-t border-line bg-accent-soft/30">
                      <td className="px-5 py-2 font-medium">第{q.version}版 (現在)</td>
                      <td className="px-3 py-2 text-right tnum">{yen(q.total)}</td>
                      <td className="px-3 py-2 text-xs text-ink-2">{q.approvedAt ? `承認 ${userName(q.approvedBy)} ${fmtDateTime(q.approvedAt)}` : "-"}</td>
                      <td className="px-5 py-2 text-right"><a href={`/api/pdf/quotes/${q.id}`} target="_blank" rel="noopener" className="text-xs text-accent hover:underline">PDF</a></td>
                    </tr>
                    {[...(q.revisions ?? [])].reverse().map((r) => (
                      <tr key={r.version} className="border-t border-line">
                        <td className="px-5 py-2">第{r.version}版<div className="text-[11px] text-ink-3">{r.title}</div></td>
                        <td className="px-3 py-2 text-right tnum">{yen(r.total)}</td>
                        <td className="px-3 py-2 text-xs text-ink-2">
                          {r.changeReason ? <>第{r.version + 1}版への変更理由: {r.changeReason}<br /></> : null}
                          <span className="text-ink-3">申請 {userName(r.changeRequestedBy)} · 承認 {userName(r.changeApprovedBy)} {fmtDateTime(r.replacedAt)}</span>
                        </td>
                        <td className="px-5 py-2 text-right"><a href={`/api/pdf/quotes/${q.id}?version=${r.version}`} target="_blank" rel="noopener" className="text-xs text-accent hover:underline">PDF</a></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {/* アクション */}
          {q.status === "draft" && (
            <Card>
              <CardHeader title="次のステップ" description={own ? "承認不要です (管理者・店長の見積)。内容を確認して確定してください" : "内容を確認して承認を申請してください"} />
              <form className="flex flex-wrap gap-2">
                <Button type="submit" formAction={submitQuote.bind(null, q.id)}>{own ? "確定する (承認不要)" : "承認を申請する"}</Button>
                <Button type="submit" variant="danger" formAction={deleteQuote.bind(null, q.id)}>下書きを削除</Button>
              </form>
            </Card>
          )}
          {(q.status === "approved" || q.status === "sent") && !q.orderId && (
            <div className="grid grid-cols-1 gap-4 @2xl:grid-cols-2">
              <Card>
                <CardHeader title="送付の記録 (郵送・手渡し・電話など)" description="システムの外で送った場合に記録します。記録は顧客のやりとり履歴に残ります" />
                <form action={sendQuote.bind(null, q.id)} className="flex flex-wrap items-end gap-2">
                  <Field label="送付手段">
                    <Select name="channel" defaultValue={customer?.preferredChannel === "visit" ? "mail" : customer?.preferredChannel ?? "email"}>
                      {(["email", "line", "chatwork", "mail", "phone", "visit"] as const).map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>)}
                    </Select>
                  </Field>
                  <Button type="submit" variant={q.status === "sent" ? "secondary" : "primary"}>{q.status === "sent" ? "再送付を記録" : "送付を記録"}</Button>
                </form>
              </Card>
              <Card id="to-order">
                <CardHeader title="受注 (契約) 登録" description="お客様の承諾後に登録。契約は承認後に確定します" />
                <form action={convertQuoteToOrder.bind(null, q.id)} className="space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    {hasHandoverItems(quoteHandoverLines(db, q.items), q.category) ? (
                      <Field label="引取日" hint="納品日は受注の画面で品目ごとに入れます (表替えは当日納品)"><Input type="date" name="scheduledStart" /></Field>
                    ) : (
                      <Field label="施工予定日"><Input type="date" name="scheduledStart" /></Field>
                    )}
                    <Field label="施工担当">
                      <Select name="workerIds">
                        {workers.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                      </Select>
                    </Field>
                  </div>
                  <Field label="施工場所" hint="お客様の住所と違うとき (ご実家など) は書き換えてください"><Input name="siteAddress" defaultValue={q.siteAddress || customer?.address} /></Field>
                  <Field label="メモ"><Input name="note" placeholder="例: LINE で正式依頼あり" /></Field>
                  <div className="flex gap-2">
                    <Button type="submit">{own ? "受注登録 (契約を確定・承認不要)" : "受注登録 (契約承認を申請)"}</Button>
                    <Button type="submit" variant="danger" formAction={markQuoteLost.bind(null, q.id)}>失注</Button>
                  </div>
                </form>
              </Card>
            </div>
          )}
          {(q.status === "approved" || q.status === "sent" || q.status === "accepted") && (
            <SendDocumentCard
              kind="quote"
              id={q.id}
              number={q.number}
              customer={customer}
              defaultMessage={`${customer?.name ?? ""} 様\n\nいつもお世話になっております。株式会社一畳屋です。\nお見積書 (${q.number}${q.version > 1 ? ` 第${q.version}版` : ""} / ${q.title} / 合計 ${yen(q.total)}) をお送りいたします。\n有効期限: ${fmtDate(q.validUntil)}\n\nご不明な点がございましたら、お気軽にお問い合わせください。`}
            />
          )}
          {q.status === "pending_approval" && !canDecide && <Note>承認されると「お客様へ送付」「受注登録」が行えるようになります。</Note>}

          <MapInfoCard db={db} user={user} target={{ type: "quote", id: q.id }} returnTo={returnTo} title="施工場所の地図・住宅地図" />

          <Card>
            <CardHeader title="やりとりの記録" description="この見積に関するお客様とのやりとり (電話・メール・LINE・対面など)" />
            {customer && <ContactLogForm returnTo={returnTo} customerId={customer.id} caseRef={q.number} defaultChannel={customer.preferredChannel === "line" ? "line" : customer.preferredChannel === "email" ? "email" : "phone"} canSend />}
            <div className="mt-4 border-t border-line pt-3">
              <ContactList db={db} logs={db.commLogs.filter((c) => c.relatedType === "quote" && c.relatedId === q.id)} showParty={false} returnTo={returnTo} />
            </div>
          </Card>

          <CasePlanCard recordType="quote" recordId={q.id} user={user} />
          <CaseScheduleCard
            events={caseEvents(db, { inquiryId: q.inquiryId, quoteId: q.id, orderId: chain.order?.id })}
            allEvents={db.schedule}
            users={new Map(db.users.map((u) => [u.id, u]))}
            stores={new Map(db.stores.map((s) => [s.id, s]))}
            today={toDateKey(new Date())}
            newParams={chain.order ? `orderId=${chain.order.id}` : `quoteId=${q.id}`}
            returnTo={returnTo}
            quickKinds={chain.order ? ["pickup", "delivery", "install", "site", "visit"] : ["visit", "measure", "survey", "onsite_quote", "site_survey"]}
            canAdd={!["rejected", "expired"].includes(q.status) && canAccessStore(user, q.storeId)}
            quickAdd={{
              caseRef: chain.order ? `order:${chain.order.id}` : `quote:${q.id}`,
              storeId: chain.order?.storeId ?? q.storeId,
              kinds: chain.order ? ["pickup", "delivery", "install", "site", "visit", "measure"] : ["visit", "measure", "survey", "onsite_quote", "site_survey", "pickup", "delivery", "install", "site"],
              users: formUsers(db),
              stores: formStores(db),
              defaultAssigneeIds: [q.estimatorId && db.users.some((u) => u.id === q.estimatorId && u.active) ? q.estimatorId : user.id],
              currentUserId: user.id,
              returnTo,
              fullHref: `/schedule/new?${chain.order ? `orderId=${chain.order.id}` : `quoteId=${q.id}`}&returnTo=${encodeURIComponent(returnTo)}`,
            }}
            description="見積の説明・再採寸などの訪問を担当者つきで登録すると、店舗の共通カレンダーに自動で反映されます。問い合わせ段階の現地調査も表示します"
          />

          <AttachmentsCard db={db} user={user} parent={{ type: "quote", id: q.id }} returnTo={returnTo} description="採寸の写真・手書きの見積書・図面などを登録できます (書類取込で読み取った元の画像もここに表示されます)" />
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title="お客様" />
            {customer && (
              <>
              <Dl columns={1} items={[["氏名", <Link key="n" href={`/customers/${customer.id}`} className="text-accent hover:underline">{customer.name}</Link>], ["電話", customerPhonesText(customer) || "-"], ["住所", customer.address], ...(q.siteAddress ? [["施工場所", q.siteAddress] as [string, string]] : []), ...(q.receiptName ? [["領収書の宛名", q.receiptName] as [string, string]] : []), ["希望連絡手段", CHANNEL_LABEL[customer.preferredChannel]]]} />
              {customer.tradeStopped && <p className="mt-2 rounded-lg bg-critical-soft px-2.5 py-1.5 text-xs text-critical-ink">取引停止のお客様です{customer.tradeStopNote ? ` (${customer.tradeStopNote})` : ""}。受注の前に店長・管理者に確認してください。</p>}
              </>
            )}
            {/* 紐付け間違いの修正 (お客様のご要望 2026-11-25「⑤」): 見積・受注・予定の内容はそのままに、お客様だけを付け替える */}
            {!viewOnly && !lock.locked && (
              <details className="mt-3 border-t border-line pt-2" id="relink">
                <summary className="cursor-pointer text-xs font-medium text-accent">紐付け先のお客様を直す</summary>
                {relinkBlocked ? <p className="mt-1 text-xs text-ink-3">{relinkBlocked}</p> : (
                  <div className="mt-2">
                    <p className="mb-2 text-[11px] text-ink-3">正しいお客様を検索して「付け替える」を押すと、問い合わせ・見積・受注・予定などの内容はそのままで、紐付け先だけが変わります。</p>
                    <CaseCustomerSearch action={relinkCase.bind(null, q.id)} returnTo={`/quotes/${q.id}`} />
                  </div>
                )}
              </details>
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
          <AiSummary kind="quote" id={q.id} />
          <RecordDocDrafts db={db} user={user} type="quote" id={q.id} number={q.number} />
          <RecordStamp db={db} targets={[{ entity: "quote", id: q.id }]} created={{ by: q.createdBy, at: q.createdAt }} approved={q.approvedBy ? [{ by: q.approvedBy, at: q.approvedAt }] : []} />
          <ApprovalHistoryCard approvals={chain.approvals.filter((a) => a.targetId === q.id)} />
          <CaseRequestsCard db={db} user={user} ids={[q.id, q.orderId ?? db.orders.find((x) => x.quoteId === q.id)?.id, q.inquiryId]} caseId={q.id} storeId={q.storeId} returnTo={`/quotes/${q.id}`} />
          <CaseChangeHistory db={db} ids={[q.id, q.orderId ?? db.orders.find((x) => x.quoteId === q.id)?.id, q.inquiryId]} />
          <HistoryCard db={db} user={user} targets={[{ entity: "quote", id: q.id }]} />
        </div>
      </div>
      </ReadOnlyArea>
    </div>
  );
}
