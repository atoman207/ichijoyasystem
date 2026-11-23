import type { ReactNode } from "react";
import { CaseViewBanner, ReadOnlyArea } from "@/components/features/CaseAccess";
import { inquiryAccessInfo, deniedHref } from "@/lib/case-access";
import { logRecordView } from "@/lib/record-views";
import Link from "@/components/ui/Link";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canAccessStore, canSeeAllStores, canViewAuditEntry } from "@/lib/auth/permissions";
import { userName } from "@/lib/db/queries";
import { handoffInquiry, linkInquiryToCustomer, registerCustomerFromInquiry, setInquiryStatus, updateInquiry } from "@/lib/actions/inquiries";
import { findDuplicateCustomers, needsConfirmation } from "@/lib/duplicates";
import { addCommLog } from "@/lib/actions/customers";
import { fmtDate, fmtDateTime, yen } from "@/lib/format";
import { CATEGORY_LABEL, CHANNEL_LABEL, INQUIRY_STATUS, ORDER_STATUS, QUOTE_STATUS, TASK_STATUS } from "@/lib/constants";
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

export default async function InquiryDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string; err?: string }> }) {
  const { id } = await params;
  const { msg, err } = await searchParams;
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
  // 担当者への引き継ぎ (業務依頼)。依頼先の最後の報告も出す
  const handoffs = db.threads.filter((t) => t.kind === "request" && t.relatedType === "inquiry" && t.relatedId === inq.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const lastReport = (threadId: string) => db.messages.filter((m) => m.threadId === threadId && m.event === "report").sort((a, b) => b.at.localeCompare(a.at))[0];
  const handoffUsers = db.users.filter((u) => u.active && (u.storeId === inq.storeId || u.role === "admin" || u.role === "hq_staff" || canSeeAllStores(user)));
  // 媒体 (当社を知ったきっかけ): 入力がなければ過去の記録からの推定 (src/lib/media.ts)
  const media = inquiryMediaMap(db, [inq]).get(inq.id)!;
  const promotion = inq.promotionId ? (db.promotions ?? []).find((p) => p.id === inq.promotionId) : undefined;
  const promotions = promotionOptions(db.promotions ?? [], (sid) => sid === "hq" || canAccessStore(user, sid), inq.promotionId);

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

      {fromAi && (
        <Note tone="accent">この問い合わせは{CHANNEL_LABEL[inq.channel]}から自動登録されました。内容を確認し、担当者の割当と{inq.channel === "ai_chat" ? "お客様への連絡" : "折返し対応"}を行ってください。顧客として登録すると、その後の見積・施工・請求まで情報が引き継がれます。</Note>
      )}

      <div className="mt-4 grid grid-cols-1 gap-4 @3xl:grid-cols-3">
        <div className="space-y-4 @3xl:col-span-2">
          <Card>
            <CardHeader title="問い合わせ内容" />
            <p className="whitespace-pre-wrap text-sm text-ink">{inq.detail || "(詳細なし)"}</p>
            <div className="mt-4">
              <Dl columns={3} items={[["お客様", inq.contactName], ["電話", inq.contactPhone ?? "-"], ["担当", userName(inq.assignedUserId)], ["登録者", userName(inq.createdBy)], ["次のアクション", inq.nextAction ?? "-"], ["期限", inq.nextActionDue ? fmtDate(inq.nextActionDue) : "-"], ["媒体 (きっかけ)", <MediaTag key="m" {...media} />], ["きっかけの販促", promotion ? `${promotion.title} (${promotion.number})` : "-"]]} />
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

          <Card>
            <CardHeader title="担当者への引き継ぎ" description="引き継ぎ先に「業務依頼」を作って通知します。相手が確認 → 対応の報告 → 依頼者の確認で完了になります" />
            {handoffs.length > 0 && (
              <ul className="mb-3 space-y-1.5 text-sm">
                {handoffs.map((t) => (
                  <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line px-3 py-2">
                    <span className="min-w-0">
                      <Link href={`/messages/${t.id}`} className="font-medium text-accent hover:underline">{(t.assigneeIds ?? []).map((a) => userName(a)).join("・")}</Link>
                      <span className="ml-2 text-xs text-ink-3">依頼 {userName(t.createdBy)} · {fmtDateTime(t.createdAt)}{t.dueDate ? ` · 期限 ${fmtDate(t.dueDate)}` : ""}</span>
                    </span>
                    {t.taskStatus && <StatusBadge value={t.taskStatus} map={TASK_STATUS} />}
                    {(() => {
                      const r = lastReport(t.id);
                      return r ? <p className="w-full text-xs whitespace-pre-wrap text-ink-2">報告 ({userName(r.userId)} · {fmtDateTime(r.at)}): {r.body.slice(0, 400)}</p> : null;
                    })()}
                  </li>
                ))}
              </ul>
            )}
            {open && (
              <form action={handoffInquiry.bind(null, inq.id)} className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
                <Field label="引き継ぎ先" required>
                  <Select name="assigneeId" defaultValue={inq.assignedUserId ?? ""} required>
                    <option value="">選んでください</option>
                    {handoffUsers.map((u) => <option key={u.id} value={u.id}>{u.name} ({storeName(u.storeId)})</option>)}
                  </Select>
                </Field>
                <Field label="期限"><Input type="date" name="dueDate" defaultValue={toDateKey(new Date())} /></Field>
                <Field label="引き継ぐ内容" className="@xl:col-span-2" required><Textarea name="note" required placeholder="例: 6畳の表替えのご相談。明日の午前中に折返しを希望されています。" /></Field>
                <div className="@xl:col-span-2"><Button type="submit" size="sm">引き継ぐ</Button></div>
              </form>
            )}
          </Card>

          <CasePlanCard recordType="inquiry" recordId={inq.id} user={user} />
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
              <Field label="担当店舗" hint="本社・他店舗で受けた問い合わせは、担当の店舗へ回せます (担当者は回した先で決めます)">
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
              <div className="text-sm">
                <Link href={`/customers/${customer.id}`} className="font-medium text-accent hover:underline">{customer.name}</Link>
                <div className="mt-1 text-xs text-ink-2">{customer.code} · {customer.phone}</div>
                <div className="text-xs text-ink-2">{customer.address || "住所未登録"}</div>
                <div className="mt-2 flex flex-wrap gap-1">{customer.tags.map((t) => <Badge key={t} dot={false}>{t}</Badge>)}</div>
              </div>
            ) : (
              <div>
                <p className="text-sm text-ink-2">{inq.contactName} 様はまだ顧客登録されていません。</p>
                {candidates.length > 0 && (
                  <div className="mt-3 rounded-xl border border-warn/40 bg-warn-soft/40 p-3 text-xs" data-testid="inquiry-duplicates">
                    <div className="mb-2 font-semibold text-ink">既存の顧客 (全店舗) に候補があります</div>
                    <ul className="space-y-2">
                      {candidates.map((m) => (
                        <li key={m.id} className="rounded-lg bg-panel p-2">
                          <div className="flex flex-wrap items-baseline gap-x-2">
                            {canAccessStore(user, m.storeId) ? <Link href={`/customers/${m.id}`} className="font-medium text-accent hover:underline">{m.code} {m.name}</Link> : <span className="font-medium text-ink">{m.code} {m.name}</span>}
                            <span className="text-ink-3">{storeName(m.storeId)}{m.area ? ` · 地区 ${m.area}` : ""}</span>
                          </div>
                          <div className="text-ink-3">{m.level === "high" ? "重複の可能性が高い" : m.level === "check" ? "要確認" : "参考"}: {m.reasons.join("・")}</div>
                          {canAccessStore(user, m.storeId) ? (
                            <form action={linkInquiryToCustomer.bind(null, inq.id, m.id)} className="mt-1.5">
                              <Button type="submit" size="sm" variant="secondary">この顧客に紐づける</Button>
                            </form>
                          ) : (
                            <p className="mt-1 text-ink-3">他店舗の顧客です。同じお客様なら店舗または本部に確認してください。</p>
                          )}
                        </li>
                      ))}
                    </ul>
                    {dup && dup.sameNameTotal > 5 && <p className="mt-2 text-ink-3">同じ氏名の顧客がほかに {dup.sameNameTotal - 5} 件あります (顧客一覧で検索できます)。</p>}
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
