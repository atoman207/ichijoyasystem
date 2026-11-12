import Link from "@/components/ui/Link";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canAccessStore, canApprove, canManageFinance, isManagerOrAbove } from "@/lib/auth/permissions";
import { orderChain, userName } from "@/lib/db/queries";
import { addProgress, cancelOrder, completeOrder, createInvoiceFromOrder, updateOrderSchedule } from "@/lib/actions/orders";
import { decideApproval } from "@/lib/actions/approvals";
import { fmtDate, fmtDateTime, toDateKey, yen } from "@/lib/format";
import { APPROVAL_STATUS, APPROVAL_TYPE_LABEL, CATEGORY_LABEL, CHANNEL_LABEL, INVOICE_STATUS, ORDER_STATUS, PROGRESS_KIND_LABEL, QUOTE_STATUS } from "@/lib/constants";
import { Badge, Button, Card, CardHeader, Dl, Field, Flash, Input, LinkButton, Note, PageHeader, Select, StatusBadge, StoreTag } from "@/components/ui";
import { OrderScheduleForm } from "@/components/schedule/OrderScheduleForm";
import { CaseScheduleCard } from "@/components/schedule/CaseSchedule";
import { formStores, formUsers } from "@/components/schedule/form-data";

const STEPS = ["pending_approval", "confirmed", "scheduled", "in_progress", "completed", "invoiced", "paid"] as const;

export default async function OrderDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string; err?: string }> }) {
  const { id } = await params;
  const { msg, err } = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const o = db.orders.find((x) => x.id === id);
  if (!o) notFound();
  if (!canAccessStore(user, o.storeId)) redirect("/orders?err=" + encodeURIComponent("この案件を閲覧する権限がありません。"));
  const customer = db.customers.find((c) => c.id === o.customerId);
  const store = db.stores.find((s) => s.id === o.storeId);
  const chain = orderChain(db, o);
  const pending = chain.approvals.find((a) => a.status === "pending" && a.type === "order");
  const canDecide = pending ? canApprove(user, pending) : false;
  const stepIndex = STEPS.indexOf(o.status as (typeof STEPS)[number]);
  const returnTo = `/orders/${id}`;
  const active = ["confirmed", "scheduled", "in_progress"].includes(o.status);
  const main = db.schedule.find((e) => e.orderId === o.id && e.source === "order");
  const today = toDateKey(new Date());
  const survey = db.surveys.find((x) => x.orderId === o.id);
  const AMOUNT_LABEL: [keyof NonNullable<typeof o.amounts>, string][] = [["tatami", "畳"], ["fusuma", "襖"], ["shoji", "障子"], ["amido", "網戸"], ["curtain", "カーテン"], ["cloth", "クロス・工事"], ["own", "自社商品"], ["misc", "諸経費"], ["discount", "値引"]];

  return (
    <div>
      <Flash msg={msg} err={err} />
      <PageHeader
        title={`${o.number} ${customer?.name} 様 · ${o.title}`}
        badge={<StatusBadge value={o.status} map={ORDER_STATUS} />}
        description={<span className="inline-flex flex-wrap items-center gap-2">{CATEGORY_LABEL[o.category]} · <StoreTag store={store} /> · 契約日 {fmtDate(o.contractDate)} · 金額 {yen(o.total)} (税込)</span>}
        back={{ href: "/orders", label: "受注・施工一覧" }}
        actions={chain.quote && <LinkButton href={`/quotes/${chain.quote.id}`} variant="secondary" size="sm">見積 {chain.quote.number}</LinkButton>}
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

      {pending && (
        <Card className="mb-4 border-warn/40 bg-warn-soft/40">
          <CardHeader title="契約承認待ち" description={`${pending.requiredRole === "admin" ? "管理者" : "店長"}の承認が必要 · 申請 ${userName(pending.requestedBy)} ${fmtDateTime(pending.createdAt)}${pending.requestComment ? ` · ${pending.requestComment}` : ""}`} />
          {canDecide ? (
            <form className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="returnTo" value={returnTo} />
              <Field label="コメント (任意)" className="w-full @xl:w-80"><Input name="comment" /></Field>
              <Button type="submit" formAction={decideApproval.bind(null, pending.id, "approved")}>契約を承認する</Button>
              <Button type="submit" variant="danger" formAction={decideApproval.bind(null, pending.id, "rejected")}>却下する</Button>
            </form>
          ) : (
            <p className="text-sm text-ink-2">承認後に施工手配へ進めます。</p>
          )}
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 @3xl:grid-cols-3">
        <div className="space-y-4 @3xl:col-span-2">
          <Card>
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
              {survey && (
                <div className="mt-4 rounded-xl bg-subtle/70 px-4 py-3 text-xs text-ink-2">
                  <div className="mb-1 font-semibold text-ink">お客様アンケート ({fmtDate(survey.receivedAt)})</div>
                  電話対応 {survey.phoneScore ?? "-"} · 営業対応 {survey.salesScore ?? "-"}{survey.salesName ? ` (${survey.salesName})` : ""} · 職人対応 {survey.craftsmanScore ?? "-"}{survey.craftsmanName ? ` (${survey.craftsmanName})` : ""} · 仕上り {survey.finishScore ?? "-"} (5 段階)
                  {survey.media && <> · 情報媒体: {survey.media}</>}
                  {survey.wouldUseAgain && <> · 次回も依頼したい: {survey.wouldUseAgain}</>}
                </div>
              )}
            </Card>
          )}

          <CaseScheduleCard
            events={chain.events}
            allEvents={db.schedule}
            users={new Map(db.users.map((u) => [u.id, u]))}
            stores={new Map(db.stores.map((s) => [s.id, s]))}
            today={today}
            newParams={`orderId=${o.id}`}
            returnTo={returnTo}
            quickKinds={["pickup", "delivery", "install", "visit", "measure", "survey"]}
            canAdd={o.status !== "cancelled"}
            description="引き取り・納品・施工・顧客訪問などを案件に登録すると、担当者とともに店舗の共通カレンダーへ自動で反映されます。問い合わせ段階の現地調査も含みます"
          />

          <Card>
            <CardHeader title="進捗の記録" description="現場からスマートフォンで記録。写真や変更内容も残せます" />
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

          {active && (
            <Card>
              <CardHeader title="施工完了 → 売上計上" description="完了を登録すると売上に計上され、請求書を発行できるようになります" />
              <form action={completeOrder.bind(null, o.id)} className="flex flex-wrap items-end gap-2">
                <Field label="完了日"><Input type="date" name="completedAt" defaultValue={toDateKey(new Date())} /></Field>
                <Field label="メモ" className="w-full @xl:w-72"><Input name="body" placeholder="施工完了。お客様確認済み。" /></Field>
                <Button type="submit">施工完了を登録</Button>
              </form>
              {isManagerOrAbove(user) && (
                <form action={cancelOrder.bind(null, o.id)} className="mt-4 flex flex-wrap items-end gap-2 border-t border-line pt-3">
                  <Field label="キャンセル理由" className="w-full @xl:w-72"><Input name="reason" /></Field>
                  <Button type="submit" variant="danger" size="sm">受注をキャンセル</Button>
                </form>
              )}
            </Card>
          )}

          {o.status === "completed" && (
            <Card>
              <CardHeader title="請求書を発行" description="見積の内訳から自動作成。送付方法はお客様の希望に合わせて" />
              {canManageFinance(user) || isManagerOrAbove(user) ? (
                <form action={createInvoiceFromOrder.bind(null, o.id)} className="flex flex-wrap items-end gap-2">
                  <Field label="支払期限 (日後)"><Input type="number" name="dueDays" defaultValue={customer?.type === "corporate" ? 30 : 14} className="w-28" /></Field>
                  <Field label="送付方法">
                    <Select name="sentVia" defaultValue={customer?.type === "corporate" ? "email" : customer?.preferredChannel === "line" ? "line" : "mail"}>
                      {(["mail", "email", "line", "chatwork", "visit"] as const).map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>)}
                    </Select>
                  </Field>
                  <Button type="submit">請求書を発行 ({yen(o.total)})</Button>
                </form>
              ) : (
                <Note>請求書の発行は店長・本部スタッフ・管理者が行います。本部へ連絡してください。</Note>
              )}
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title="お客様" />
            {customer && <Dl columns={1} items={[["氏名", <Link key="n" href={`/customers/${customer.id}`} className="text-accent hover:underline">{customer.name}</Link>], ["電話", customer.phone], ["現場", o.siteAddress], ["希望連絡手段", CHANNEL_LABEL[customer.preferredChannel]]]} />}
          </Card>
          <Card>
            <CardHeader title="関連情報" />
            <ul className="space-y-2 text-sm">
              <li>問い合わせ: {chain.inquiry ? <Link href={`/inquiries/${chain.inquiry.id}`} className="text-accent hover:underline">{chain.inquiry.number}</Link> : <span className="text-ink-3">-</span>}</li>
              <li>見積: {chain.quote ? <><Link href={`/quotes/${chain.quote.id}`} className="text-accent hover:underline">{chain.quote.number}</Link> <StatusBadge value={chain.quote.status} map={QUOTE_STATUS} /></> : "-"}</li>
              <li>請求: {chain.invoice ? <><Link href={`/invoices/${chain.invoice.id}`} className="text-accent hover:underline">{chain.invoice.number}</Link> <StatusBadge value={chain.invoice.status} map={INVOICE_STATUS} /></> : <span className="text-ink-3">未発行</span>}</li>
              <li>入金: {chain.payments.length > 0 ? `${yen(chain.payments.reduce((a, p) => a + p.amount, 0))} (${chain.payments.length} 件)` : <span className="text-ink-3">-</span>}</li>
            </ul>
          </Card>

          <Card>
            <CardHeader title="承認履歴" />
            <ul className="space-y-2 text-xs">
              {chain.approvals.map((a) => (
                <li key={a.id} className="rounded-lg border border-line p-2">
                  <div className="flex items-center justify-between"><span className="font-medium">{APPROVAL_TYPE_LABEL[a.type]}</span><StatusBadge value={a.status} map={APPROVAL_STATUS} /></div>
                  <div className="mt-1 text-ink-3">申請 {userName(a.requestedBy)} · {a.decidedBy ? `${a.status === "approved" ? "承認" : "判断"} ${userName(a.decidedBy)} ${fmtDateTime(a.decidedAt)}` : "未決"}</div>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
