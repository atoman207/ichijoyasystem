import type { ReactNode } from "react";
import { CaseViewBanner, ReadOnlyArea } from "@/components/features/CaseAccess";
import { inquiryAccessInfo, deniedHref } from "@/lib/case-access";
import { logRecordView } from "@/lib/record-views";
import Link from "@/components/ui/Link";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canAccessStore, canEditCaseStore, canSeeAllStores, canViewAuditEntry } from "@/lib/auth/permissions";
import { userName } from "@/lib/db/queries";
import { clearInquiryScheduleHold, linkInquiryFromForm, mergeInquiryIntoCase, registerCustomerFromInquiry, requestInquiry, setInquiryScheduleHold, setInquiryStatus, updateInquiry } from "@/lib/actions/inquiries";
import { customerCases } from "@/lib/reception";
import { userCanCreateCustomer } from "@/lib/ops-settings";
import { taskStep } from "@/lib/actions/messages";
import { caseFlow } from "@/lib/case-flow";
import { CaseFlowBar } from "@/components/features/CaseFlowBar";
import { InquiryActions, type ActionTab } from "@/components/inquiries/InquiryActions";
import { REQUEST_PURPOSE, dueLabel, isInquiryRequest, isOpenRequest, jstHour, requestTargetLabel, flowIndex } from "@/lib/inquiry-flow";
import { formStores, formUsers } from "@/components/schedule/form-data";
import type { ScheduleKind } from "@/lib/db/types";
import { findDuplicateCustomers, needsConfirmation } from "@/lib/duplicates";
import { addCommLog } from "@/lib/actions/customers";
import { CustomerLinkSearch } from "@/components/features/LinkSearch";
import { isPlaceholderCustomer, relinkBlocker } from "@/lib/customer-link";
import { inquiryContact } from "@/lib/link-search";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { CATEGORY_LABEL, CHANNEL_LABEL, INQUIRY_STATUS, TASK_STATUS } from "@/lib/constants";
import { Badge, Button, Card, CardHeader, ChannelTag, Dl, Field, Flash, Input, LinkButton, Note, PageHeader, Select, StatusBadge, StoreTag, Textarea } from "@/components/ui";
import { AttachmentsCard } from "@/components/attachments/AttachmentsCard";
import { CaseScheduleCard } from "@/components/schedule/CaseSchedule";
import { CasePlanCard } from "@/components/scheduling/CasePlanCard";
import { caseEvents } from "@/lib/db/schedule";
import { toDateKey } from "@/lib/format";
import { AiSummary } from "@/components/features/AiSummary";
import { RecordDocDrafts } from "@/components/features/DocDrafts";
import { MediaSelect, MediaTag, PromotionSelect, promotionOptions } from "@/components/ops-reports/MediaFields";
import { inquiryMediaMap } from "@/lib/ops-reports/promo-analysis";
import { MEDIA_SOURCE_LABEL, mediaLabel } from "@/lib/media";

export default async function InquiryDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string; err?: string; cq?: string; tab?: string }> }) {
  const { id } = await params;
  const { msg, err, cq, tab } = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const inq = db.inquiries.find((x) => x.id === id);
  if (!inq) notFound();
  // ほかの店舗の記録は閲覧のみ (見られる範囲は閲覧の範囲の設定と案件の進み具合。承認制で申請できるときはお客様の画面の「閲覧の申請」へ。src/lib/case-access.ts)
  const info = inquiryAccessInfo(db, user, inq);
  if (info.access === "none") redirect(deniedHref(info, "/inquiries", "問い合わせ"));
  const viewOnly = info.access === "view";
  logRecordView(user, info, { entity: "inquiry", id: inq.id, label: inq.number, storeId: inq.storeId }, db.auditLogs);
  const customer = db.customers.find((c) => c.id === inq.customerId);
  const quote = db.quotes.find((q) => q.id === inq.quoteId);
  const order = quote ? db.orders.find((o) => o.quoteId === quote.id) : undefined;
  const store = db.stores.find((s) => s.id === inq.storeId);
  const users = db.users.filter((u) => u.active && (canSeeAllStores(user) || u.storeId === inq.storeId));
  const isAiChannel = (ch: string) => ch === "ai_phone" || ch === "ai_chat" || ch === "ai_voice";
  // 受付 (メモの写真・話して入力・通話の文字起こし。src/lib/reception.ts) から登録した問い合わせ
  const receptionId = inq.sourceRef?.startsWith("reception:") ? inq.sourceRef.slice("reception:".length) : undefined;
  const isIntakeLog = (c: { channel: string; subject: string; relatedId?: string }) => c.relatedId === inq.id && (isAiChannel(c.channel) || (Boolean(receptionId) && c.subject.startsWith("受付:")));
  // AI 受付の会話の記録は下の「…の記録」に出すので、やりとりの一覧には重ねない
  const comms = customer ? db.commLogs.filter((c) => c.customerId === customer.id && (c.relatedId === inq.id || !c.relatedId) && !isIntakeLog(c)).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 10) : [];
  const allLogs = db.auditLogs.filter((l) => l.entity === "inquiry" && l.entityId === inq.id && canViewAuditEntry(user, l)).reverse();
  // 閲覧の記録 (1 人・1 日に 1 回) は変更の記録と分けて件数だけ出す
  const logs = allLogs.filter((l) => l.action !== "view");
  const views = allLogs.filter((l) => l.action === "view");
  const events = caseEvents(db, { inquiryId: inq.id, quoteId: quote?.id, orderId: order?.id });
  const caseParam = order ? `orderId=${order.id}` : quote ? `quoteId=${quote.id}` : `inquiryId=${inq.id}`;
  const open = !["lost", "closed"].includes(inq.status);
  // 顧客未登録のとき: 既存の顧客 (全店舗) と照合した候補
  const ik = inq.intake;
  const dup = customer ? null : findDuplicateCustomers(db, { name: inq.contactName, phone: inq.contactPhone, otherPhones: [ik?.phone, ik?.callbackPhone].filter((x): x is string => Boolean(x)), email: ik?.email, postalCode: ik?.postalCode, address: ik?.address });
  const candidates = dup ? [...dup.high.map((m) => ({ ...m, level: "high" as const })), ...dup.check.map((m) => ({ ...m, level: "check" as const })), ...dup.sameName.slice(0, 5).map((m) => ({ ...m, level: "name" as const }))] : [];
  // 紐づけ・付け替え (お客様のご要望 2026-11-24「■5」): 入力するたびに既存の顧客の候補を出し、「紐づける」を押すだけ
  // 付け替えは見積の前の案件だけ (src/lib/customer-link.ts)。予定表の取込で仮に作った顧客 (電話・住所なし) は付け替えを勧める
  const placeholder = isPlaceholderCustomer(customer);
  const relinkBlocked = customer ? relinkBlocker(db, inq) : undefined;
  const canLink = !viewOnly && canEditCaseStore(user, inq.storeId);
  const contact = inquiryContact(inq, customer);
  const here = `/inquiries/${inq.id}`;
  const storeName = (sid: string) => db.stores.find((s) => s.id === sid)?.name ?? sid;
  // AI システム (AI テキスト相談・AI 音声相談・AI 電話受付) からの受付: 会話の記録
  const fromAi = isAiChannel(inq.channel);
  const aiLogs = db.commLogs.filter((c) => c.relatedType === "inquiry" && isIntakeLog(c));
  // AI システムから受け取った項目 (src/lib/ai-intake.ts。顧客の登録で使う)
  const intakeRows: [string, ReactNode][] = ik
    ? ([
        ["名乗ったお名前", ik.name],
        ["ふりがな", ik.kana],
        ["電話", ik.phone],
        ["折返し先", ik.callbackPhone && ik.callbackPhone !== ik.phone ? ik.callbackPhone : undefined],
        ["メール", ik.email],
        ["住所", ik.postalCode || ik.address ? `${ik.postalCode ? `〒${ik.postalCode} ` : ""}${ik.address ?? ""}` : undefined],
        ["希望日", ik.desiredDate],
        ["緊急度", ik.urgency === "high" ? <Badge key="u" tone="critical">高</Badge> : ik.urgency === "low" ? "低" : ik.urgency ? "普通" : undefined],
        ["引き継ぎ", ik.handoffRequested ? `AI が必要と判断${ik.handoffReason ? ` (${ik.handoffReason})` : ""}` : ik.handoffReason],
        ["当社を知ったきっかけ", ik.mediaText],
        ["一致したお客様", ik.matchedCount && ik.matchedCount > 1 ? `${ik.matchedCount} 件 (最近更新したお客様にひも付け)` : undefined],
        ["録音", ik.recordingUrl ? <a key="r" href={ik.recordingUrl} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">開く</a> : undefined],
        ["受付 ID", ik.externalId],
        ["送信元 ID", ik.senderId],
      ].filter(([, v]) => v !== undefined && v !== "") as [string, ReactNode][])
    : [];
  const lastReport = (threadId: string) => db.messages.filter((m) => m.threadId === threadId && m.event === "report").sort((a, b) => b.at.localeCompare(a.at))[0];
  // 媒体 (当社を知ったきっかけ): 入力がなければ過去の記録からの推定 (src/lib/media.ts)
  const media = inquiryMediaMap(db, [inq]).get(inq.id)!;
  const promotion = inq.promotionId ? (db.promotions ?? []).find((p) => p.id === inq.promotionId) : undefined;
  // きっかけの販促: 全社 (本部)・自店舗・この問い合わせの店舗の販促 (actions/inquiries.ts の updateInquiry と同じ)
  const promotions = promotionOptions(db.promotions ?? [], (sid) => sid === "hq" || sid === inq.storeId || canAccessStore(user, sid), inq.promotionId);

  // 案件の流れと次にやること・対応状況 (お客様のご要望 2026-11-24「■ 問い合わせ受付後の業務フロー」。src/lib/case-flow.ts・src/lib/inquiry-flow.ts)
  const now = new Date();
  const flow = caseFlow(db, { inquiryId: inq.id }, now);
  const state = flow.inquiryFlow?.state;
  const fix = flowIndex(db);
  const requests = db.threads.filter((t) => isInquiryRequest(t) && t.relatedId === inq.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const canAct = !viewOnly && canEditCaseStore(user, inq.storeId);
  const canSchedule = !viewOnly && canAccessStore(user, inq.storeId);
  const tabParam = tab === "request" || tab === "schedule" || tab === "hold" ? (tab as ActionTab) : undefined;
  const defaultTab: ActionTab = tabParam ?? (state === "request_waiting" || (state === "overdue" && !flow.inquiryFlow?.request && !inq.scheduleHold) ? "request" : "schedule");
  const openPerson = requests.find((t) => isOpenRequest(t) && !t.assigneeStoreId && (t.assigneeIds ?? []).length === 1);
  // 同じお客様の進行中の案件 (この問い合わせ以外)。既存の案件の連絡なら「この案件にまとめる」(お客様のご要望 2026-11-24「追加 ④」)
  const canCreateCustomer = userCanCreateCustomer(db, user);
  const otherCases = customer && canLink && !quote ? customerCases(db, customer.id).filter((c) => c.open && !(c.type === "inquiry" && c.id === inq.id) && canEditCaseStore(user, c.storeId)).slice(0, 5) : [];
  const scheduleKinds: ScheduleKind[] = order ? ["pickup", "delivery", "install", "site", "visit", "measure"] : ["survey", "onsite_quote", "site_survey", "measure", "visit", "pickup", "delivery", "install", "site"];

  return (
    <div>
      <Flash msg={msg} err={err} />
      <PageHeader
        title={inq.summary}
        badge={<StatusBadge value={inq.status} map={INQUIRY_STATUS} />}
        description={<span className="inline-flex flex-wrap items-center gap-2">{inq.number} · 受付 {fmtDateTime(inq.receivedAt)} · <ChannelTag channel={inq.channel} /> · 媒体 <MediaTag {...media} /> · {CATEGORY_LABEL[inq.category]} · <StoreTag store={store} /></span>}
        back={{ href: "/inquiries", label: "問い合わせ一覧" }}
        actions={
          viewOnly ? undefined : <>
            {!quote && customer && <LinkButton href={`/quotes/new?customerId=${customer.id}&inquiryId=${inq.id}&category=${inq.category}`} size="sm">見積を作成</LinkButton>}
            {quote && <LinkButton href={`/quotes/${quote.id}`} size="sm" variant="secondary">見積 {quote.number} を開く</LinkButton>}
          </>
        }
      />
      {viewOnly && <CaseViewBanner storeName={store?.name ?? "ほかの店舗"} what="問い合わせ" basis={info.basis} grantUntil={info.grantUntil} />}
      <ReadOnlyArea readOnly={viewOnly}>

      <CaseFlowBar flow={flow} />

      {fromAi && (
        <Note tone="accent">この問い合わせは{CHANNEL_LABEL[inq.channel]}から自動登録されました。内容を確認し、担当者の割当と{inq.channel === "ai_chat" ? "お客様への連絡" : "折返し対応"}を行ってください。顧客として登録すると、その後の見積・施工・請求まで情報が引き継がれます。</Note>
      )}

      <div className="mt-4 grid grid-cols-1 gap-4 @3xl:grid-cols-3">
        <div className="space-y-4 @3xl:col-span-2">
          {open && !quote && canLink && (!customer || otherCases.length > 0) && (
            <Card id="customer-choice" className="border-accent/40">
              <CardHeader
                title={customer ? "既存の案件の連絡ですか？" : "お客様の確認: 既存のお客様に紐づける / 新しいお客様として登録"}
                description={customer ? `${customer.name} 様の進行中の案件があります。同じ件の連絡なら、案件にまとめると二重の案件になりません (この問い合わせの内容は案件のやりとりに残ります)` : "顧客の二重登録を防ぐため、先に確かめてください。住所・電話番号が同じお客様が候補に出ます"}
              />
              {!customer && (
                <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
                  <div className="rounded-xl border border-line p-3">
                    <p className="mb-2 text-sm font-semibold text-ink">① 既存のお客様に紐づける</p>
                    {candidates.length ? (
                      <form action={linkInquiryFromForm} className="space-y-2">
                        <input type="hidden" name="inquiryId" value={inq.id} />
                        <input type="hidden" name="returnTo" value={here} />
                        {candidates.slice(0, 3).map((m) => (
                          <div key={m.id} className="rounded-lg bg-subtle/70 p-2 text-xs">
                            <div className="text-sm font-medium text-ink">{m.name} <span className="text-xs font-normal text-ink-3">{m.code} · {storeName(m.storeId)}</span></div>
                            <div className="text-ink-2">{m.address || (m.area ? `地区 ${m.area}` : "住所未登録")}</div>
                            <div className="text-ink-3">{m.reasons.join("・")}</div>
                            {canEditCaseStore(user, m.storeId) && <Button type="submit" name="customerId" value={m.id} size="sm" className="mt-1.5 w-full">このお客様に紐づける</Button>}
                          </div>
                        ))}
                      </form>
                    ) : (
                      <p className="text-xs text-ink-3">住所・電話番号・お名前が同じお客様は見つかりませんでした。</p>
                    )}
                    <a href="#link-customer" className="mt-2 inline-block text-xs text-accent hover:underline">ほかのお客様を検索する</a>
                  </div>
                  <div className="rounded-xl border border-line p-3">
                    <p className="mb-2 text-sm font-semibold text-ink">② 新しいお客様として登録</p>
                    <p className="mb-2 text-xs text-ink-2">{[inq.contactName, inq.contactPhone ?? inq.intake?.phone, inq.intake?.address].filter(Boolean).join(" · ")}</p>
                    {canCreateCustomer ? (
                      <form action={registerCustomerFromInquiry.bind(null, inq.id)} className="space-y-2">
                        {dup && needsConfirmation(dup) && (
                          <label className="flex items-start gap-2 text-xs text-ink">
                            <input type="checkbox" name="confirmDuplicate" value="1" required className="mt-0.5 h-4 w-4" />
                            ①の候補とは別のお客様であることを確認した
                          </label>
                        )}
                        <Button type="submit" size="sm" variant={candidates.length ? "secondary" : "primary"} className="w-full">新しいお客様として登録する</Button>
                      </form>
                    ) : (
                      <p className="text-xs text-ink-3">顧客の新規登録は事務担当・店長が行います。担当の方に依頼してください。</p>
                    )}
                  </div>
                </div>
              )}
              {customer && otherCases.length > 0 && (
                <form action={mergeInquiryIntoCase.bind(null, inq.id)} className="space-y-1.5">
                  {otherCases.map((c) => (
                    <div key={`${c.type}:${c.id}`} className="flex flex-wrap items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm">
                      <span className="min-w-0 flex-1">
                        <Link href={c.href} className="font-medium text-accent hover:underline">{c.type === "order" ? "受注" : c.type === "quote" ? "見積" : "問い合わせ"} {c.number}</Link> <span className="text-ink-2">{c.title}</span>
                        <span className="block text-[11px] text-ink-3">{c.statusLabel} · {c.date}</span>
                      </span>
                      <Button type="submit" name="caseKey" value={`${c.type}:${c.id}`} size="sm" variant="secondary">この案件にまとめる</Button>
                    </div>
                  ))}
                  <p className="text-[11px] text-ink-3">新しいご依頼なら、そのまま下の「次にやること」へ進んでください。</p>
                </form>
              )}
            </Card>
          )}
          {open && !quote && (
            <Card id="actions">
              <CardHeader title="次にやること: 依頼・日程" description="担当店舗・担当者への依頼 (期限つき) → 日程の登録 (予定表に自動で反映) までをこの画面で行います。すぐに日程が決まらないときは「日程未定」" />
              {requests.length > 0 && (
                <ul className="mb-4 space-y-1.5 text-sm" data-testid="inquiry-requests">
                  {requests.slice(0, 5).map((t) => {
                    const late = Boolean(t.dueAt && Date.parse(t.dueAt) <= now.getTime() && isOpenRequest(t) && (t.taskStatus === "requested" || t.taskStatus === "acknowledged"));
                    const mine = (t.assigneeIds ?? []).includes(user.id);
                    return (
                      <li key={t.id} className={`flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border px-3 py-2 ${late ? "border-critical/40 bg-critical-soft/40" : "border-line"}`}>
                        <span className="font-medium text-ink">{REQUEST_PURPOSE[t.purpose ?? "other"].label}</span>
                        <span className="text-xs text-ink-2">→ {requestTargetLabel(t, fix)}</span>
                        {t.dueAt && <span className={`text-xs ${late ? "font-semibold text-critical-ink" : "text-ink-2"}`}>期限 {dueLabel(t.dueAt, now)}{late ? " (過ぎています)" : ""}</span>}
                        {t.taskStatus && <StatusBadge value={t.taskStatus} map={TASK_STATUS} />}
                        {(t.remindCount ?? 0) > 0 && <span className="text-[11px] text-ink-3">再通知 {t.remindCount} 回</span>}
                        <span className="text-[11px] text-ink-3">依頼 {userName(t.createdBy)} · {fmtDateTime(t.createdAt)}</span>
                        {(() => {
                          const r = lastReport(t.id);
                          return r ? <p className="w-full text-xs whitespace-pre-wrap text-ink-2">報告 ({userName(r.userId)} · {fmtDateTime(r.at)}): {r.body.slice(0, 300)}</p> : null;
                        })()}
                        <span className="ml-auto flex items-center gap-2">
                          {mine && t.taskStatus === "requested" && (
                            <form action={taskStep.bind(null, t.id, "ack")}>
                              <input type="hidden" name="returnTo" value={here} />
                              <Button type="submit" size="sm" variant="secondary">確認しました</Button>
                            </form>
                          )}
                          <Link href={`/messages/${t.id}`} className="text-xs text-accent hover:underline">{mine && isOpenRequest(t) ? "報告・やりとり" : "やりとりを開く"}</Link>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
              {canAct ? (
                <InquiryActions
                  defaultTab={defaultTab}
                  requestAction={requestInquiry.bind(null, inq.id)}
                  holdAction={setInquiryScheduleHold.bind(null, inq.id)}
                  clearHoldAction={clearInquiryScheduleHold.bind(null, inq.id)}
                  returnTo={here}
                  stores={db.stores.map((s) => ({ id: s.id, name: s.name }))}
                  requestStoreIds={db.stores.filter((s) => s.id === inq.storeId || canSeeAllStores(user) || canEditCaseStore(user, s.id)).map((s) => s.id)}
                  users={db.users.filter((u) => u.active).map((u) => ({ id: u.id, name: u.name, storeId: u.storeId, role: u.role }))}
                  inquiryStoreId={inq.storeId}
                  noonPassed={jstHour(now) >= 12}
                  today={toDateKey(now)}
                  hold={inq.scheduleHold ? { reason: inq.scheduleHold.reason, nextContact: inq.scheduleHold.nextContact } : undefined}
                  schedule={
                    canSchedule
                      ? {
                          caseRef: `inquiry:${inq.id}`,
                          storeId: inq.storeId,
                          kinds: scheduleKinds,
                          defaultKind: scheduleKinds[0],
                          users: formUsers(db),
                          stores: formStores(db),
                          defaultAssigneeIds: openPerson ? [...(openPerson.assigneeIds ?? [])] : inq.assignedUserId && db.users.some((u) => u.id === inq.assignedUserId && u.active) ? [inq.assignedUserId] : [user.id],
                          currentUserId: user.id,
                          location: customer ? "" : (inq.intake?.address ?? ""),
                          returnTo: here,
                          fullHref: `/schedule/new?${caseParam}&returnTo=${encodeURIComponent(here)}`,
                        }
                      : undefined
                  }
                />
              ) : (
                <p className="text-xs text-ink-3">この問い合わせの店舗の担当者・本部が依頼・日程の登録を行います。</p>
              )}
            </Card>
          )}
          <Card>
            <CardHeader title="問い合わせ内容" />
            <p className="whitespace-pre-wrap text-sm text-ink">{inq.detail || "(詳細なし)"}</p>
            <div className="mt-4">
              <Dl columns={3} items={[["お客様", customer && customer.name !== inq.contactName ? `${customer.name} 様 (受付時のお名前: ${inq.contactName})` : inq.contactName], ["電話", contact.phone || "-"], ["住所", contact.address || "-"], ["担当", userName(inq.assignedUserId)], ["登録者", userName(inq.createdBy)], ["次のアクション", inq.nextAction ?? "-"], ["期限", inq.nextActionDue ? fmtDate(inq.nextActionDue) : "-"], ["媒体 (きっかけ)", <MediaTag key="m" {...media} />], ["きっかけの販促", promotion ? `${promotion.title} (${promotion.number})` : "-"]]} />
            </div>
          </Card>

          {(aiLogs.length > 0 || intakeRows.length > 0) && (
            <Card>
              <CardHeader
                title={receptionId ? "受付の記録" : `${CHANNEL_LABEL[inq.channel]}の記録`}
                description={`${receptionId ? "受付 (メモの写真・話して入力・通話) から読み取った項目と元の内容" : "AI システムから受け取った項目と会話・要約 (受け取ったまま保存しています)"}${customer ? "" : "。「顧客として登録する」で、お名前・ふりがな・電話・メール・住所を顧客の情報に入れます"}`}
                action={receptionId && db.documents.some((d) => d.id === receptionId) ? <LinkButton href={`/inquiries/reception/${receptionId}`} size="sm" variant="secondary">元の受付</LinkButton> : undefined}
              />
              {intakeRows.length > 0 && <div className="mb-3"><Dl columns={3} items={intakeRows} /></div>}
              {aiLogs.map((c) => (
                <details key={c.id} className="text-sm" open={aiLogs.length === 1}>
                  <summary className="cursor-pointer text-xs text-ink-3"><span className="tnum">{fmtDateTime(c.at)}</span> · {c.subject}</summary>
                  <pre className="mt-2 max-h-80 overflow-y-auto rounded-lg bg-subtle p-3 font-sans text-xs whitespace-pre-wrap text-ink">{c.body}</pre>
                </details>
              ))}
            </Card>
          )}

          <CasePlanCard recordType="inquiry" recordId={inq.id} user={user} />
          <CaseScheduleCard
            events={events}
            allEvents={db.schedule}
            users={new Map(db.users.map((u) => [u.id, u]))}
            stores={new Map(db.stores.map((s) => [s.id, s]))}
            today={toDateKey(new Date())}
            newParams={caseParam}
            returnTo={`/inquiries/${inq.id}`}
            quickKinds={order ? ["pickup", "delivery", "install", "site", "visit"] : ["survey", "onsite_quote", "site_survey", "measure", "visit"]}
            canAdd={(Boolean(quote) || Boolean(order)) && canAccessStore(user, inq.storeId)}
            emptyText={open && !quote ? "まだ予定はありません。日程が決まったら上の「日程を登録」で入れてください (予定表に自動で載ります)" : "予定はありません"}
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
              <Field label="担当店舗" hint="本部・他店舗で受けた問い合わせは、担当の店舗へ回せます (担当者は回した先で決めます)">
                <Select name="storeId" defaultValue={inq.storeId}>
                  {db.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </Select>
              </Field>
              <Field label="種別">
                <Select name="category" defaultValue={inq.category}>
                  {(Object.keys(CATEGORY_LABEL) as (keyof typeof CATEGORY_LABEL)[]).map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
                </Select>
              </Field>
              <Field label="媒体 (当社を知ったきっかけ)" required hint={inq.media ? undefined : media.media ? `未入力です。${MEDIA_SOURCE_LABEL[media.source]}: ${mediaLabel(media.media)}${media.raw ? ` (元の値: ${media.raw})` : ""}。確かめて選んでください` : "未入力です。お客様に確かめて選んでください (わからなければ「不明」)"}>
                <MediaSelect name="media" defaultValue={inq.media ?? ""} required />
              </Field>
              <Field label="きっかけの販促 (チラシ・イベントなど)">
                <PromotionSelect name="promotionId" options={promotions} defaultValue={inq.promotionId} />
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
                  <Select name="channel" defaultValue={fromAi ? "phone" : inq.channel}>
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

          <AttachmentsCard db={db} user={user} parent={{ type: "inquiry", id: inq.id }} returnTo={`/inquiries/${inq.id}`} description="お客様から届いた写真 (LINE・メール)・郵送の書類・図面などを登録できます" />
        </div>

        <div className="space-y-4">
          <AiSummary kind="inquiry" id={inq.id} />
          <RecordDocDrafts db={db} user={user} type="inquiry" id={inq.id} number={inq.number} />
          <Card>
            <CardHeader title="お客様" />
            {customer ? (
              <div className="text-sm" id="link-customer">
                <Link href={`/customers/${customer.id}`} className="font-medium text-accent hover:underline">{customer.name}</Link>
                <div className="mt-1 text-xs text-ink-2">{customer.code} · {customer.phone || "電話未登録"}</div>
                <div className="text-xs text-ink-2">{customer.address || "住所未登録"}</div>
                <div className="mt-2 flex flex-wrap gap-1">{customer.tags.map((t) => <Badge key={t} dot={false}>{t}</Badge>)}</div>
                {canLink && !relinkBlocked && (
                  <details className="mt-3 rounded-xl border border-line bg-subtle/50 p-3" open={placeholder}>
                    <summary className="cursor-pointer text-xs font-semibold text-ink">{placeholder ? "予定表の取込で仮に作った顧客です。既存のお客様を探して付け替える" : "別の既存のお客様に付け替える"}</summary>
                    <p className="mt-1 mb-2 text-xs text-ink-3">付け替えると、この問い合わせの予定・資料・やりとりの記録も新しいお客様に移ります{placeholder ? " (仮の顧客にほかの記録がなければ、仮の顧客は削除します)" : ""}。</p>
                    <CustomerLinkSearch action={linkInquiryFromForm} inquiryId={inq.id} returnTo={here} relink initialQuery={placeholder ? customer.name.split(/[\s　]+/)[0] : ""} />
                  </details>
                )}
              </div>
            ) : (
              <div id="link-customer">
                <p className="text-sm text-ink-2">{inq.contactName} 様はまだ顧客登録されていません。既存のお客様なら下の欄で探して「紐づける」を押してください (受注番号は不要です)。</p>
                {candidates.length > 0 && (
                  <div className="mt-3 rounded-xl border border-warn/40 bg-warn-soft/40 p-3 text-xs" data-testid="inquiry-duplicates">
                    <div className="mb-2 font-semibold text-ink">既存の顧客 (全店舗) に候補があります (住所をいちばん確かめてください)</div>
                    <form action={linkInquiryFromForm}>
                      <input type="hidden" name="inquiryId" value={inq.id} />
                      <input type="hidden" name="returnTo" value={here} />
                      <ul className="space-y-2">
                        {candidates.map((m) => (
                          <li key={m.id} className="rounded-lg bg-panel p-2">
                            <div className="flex flex-wrap items-baseline gap-x-2">
                              {canEditCaseStore(user, m.storeId) ? <Link href={`/customers/${m.id}`} className="font-medium text-accent hover:underline">{m.code} {m.name}</Link> : <span className="font-medium text-ink">{m.code} {m.name}</span>}
                              <span className="text-ink-3">{storeName(m.storeId)}</span>
                            </div>
                            <div className="mt-0.5 text-ink-2">{m.address || (m.area ? `地区 ${m.area}` : "住所未登録")}</div>
                            <div className="text-ink-3">{m.level === "high" ? "重複の可能性が高い" : m.level === "check" ? "要確認" : "参考"}: {m.reasons.join("・")}</div>
                            {canLink && canEditCaseStore(user, m.storeId) ? (
                              <Button type="submit" name="customerId" value={m.id} size="sm" variant="secondary" className="mt-1.5">この顧客に紐づける</Button>
                            ) : (
                              <p className="mt-1 text-ink-3">他店舗の顧客です。同じお客様なら店舗または本部に確認してください。</p>
                            )}
                          </li>
                        ))}
                      </ul>
                    </form>
                    {dup && dup.sameNameTotal > 5 && <p className="mt-2 text-ink-3">同じ氏名の顧客がほかに {dup.sameNameTotal - 5} 件あります (下の検索で住所を確かめてください)。</p>}
                  </div>
                )}
                {canLink && (
                  <div className="mt-3 rounded-xl border border-line bg-subtle/50 p-3" data-testid="inquiry-link-search">
                    <div className="mb-2 text-xs font-semibold text-ink">既存の顧客を探して紐づける</div>
                    <CustomerLinkSearch action={linkInquiryFromForm} inquiryId={inq.id} returnTo={here} initialQuery={candidates.length ? "" : (cq ?? inq.contactName.split(/[\s　]+/)[0] ?? "")} />
                  </div>
                )}
                <form action={registerCustomerFromInquiry.bind(null, inq.id)} className="mt-3 space-y-2">
                  {dup && needsConfirmation(dup) && (
                    <label className="flex items-start gap-2 text-xs text-ink">
                      <input type="checkbox" name="confirmDuplicate" value="1" required className="mt-0.5 h-4 w-4" />
                      上の候補とは別のお客様であることを確認した
                    </label>
                  )}
                  <Button type="submit" size="sm" variant={candidates.length ? "secondary" : "primary"}>{candidates.length ? "新しい顧客として登録する" : "顧客として登録する"}</Button>
                </form>
              </div>
            )}
          </Card>
          <Card>
            <CardHeader title="変更履歴" />
            <ul className="space-y-2 text-xs">
              {logs.map((l) => (
                <li key={l.id}><span className="text-ink-3 tnum">{fmtDateTime(l.at)}</span> <span className="text-ink">{l.summary}</span> <span className="text-ink-3">({userName(l.userId)})</span></li>
              ))}
            </ul>
            {views.length > 0 && (
              <details className="mt-3 border-t border-line pt-2 text-xs">
                <summary className="cursor-pointer text-ink-2">閲覧の記録 {views.length} 件 (1 人・1 日に 1 回)</summary>
                <ul className="mt-1.5 max-h-60 space-y-1 overflow-y-auto text-ink-3">
                  {views.slice(0, 100).map((l) => (
                    <li key={l.id}><span className="tnum">{fmtDateTime(l.at)}</span> {userName(l.userId)} {l.summary}</li>
                  ))}
                </ul>
              </details>
            )}
          </Card>
        </div>
      </div>
      </ReadOnlyArea>
    </div>
  );
}
