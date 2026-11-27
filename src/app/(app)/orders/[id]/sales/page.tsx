import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { ClipboardCheck, FileText, TriangleAlert } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canConfirmSales, skipsApproval } from "@/lib/auth/permissions";
import { orderAccessInfo, completedCaseLock, completedLockMessage } from "@/lib/case-access";
import { liveInvoicesOfOrder, usesBatchBilling } from "@/lib/billing";
import { salesReadinessOf } from "@/lib/sales-ready";
import { salesConfirmed } from "@/lib/sales-lines";
import { amendBlockedByInvoice } from "@/lib/invoice-sync";
import { staffChoiceGroups } from "@/lib/staff-choices";
import { WORK_ROLES, deliveryStaffOf, workStaffOf } from "@/lib/work-staff";
import { taxModeOf } from "@/lib/quote-calc";
import { CHANNEL_LABEL, ORDER_STATUS } from "@/lib/constants";
import { documentSettings } from "@/lib/doc-settings";
import { fmtDate, toDateKey, yen } from "@/lib/format";
import { saveSales } from "@/lib/actions/sales";
import { Badge, Button, Card, CardHeader, Field, Flash, Input, Note, PageHeader, Select, StatusBadge, Textarea, buttonClass } from "@/components/ui";
import { PdfLink } from "@/components/features/PdfLink";
import { WorkStaffFields } from "@/components/features/WorkStaffFields";
import { PostingFields } from "@/components/features/PostingFields";
import { SalesLinesEditor } from "@/components/orders/SalesLinesEditor";

export const metadata: Metadata = { title: "売上確定・請求書発行" };

/**
 * 売上確定・請求書発行 (お客様のご要望 2026-11-27「■1」。帳票の「売上確定・請求書発行」のボタンから)
 * 売上確定に要る 施工内容・明細と金額・作業の担当・ポスティング だけを 1 画面に出し、「売上確定・請求書発行」で施工完了 (売上計上日) と請求書の発行を 1 回で。
 * 確定のあとは同じ画面で修正 (金額は一般社員は店長の承認、店長・管理者は承認なし)。処理は src/lib/actions/sales.ts の saveSales
 */
export default async function SalesClosePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string; err?: string; returnTo?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const o = db.orders.find((x) => x.id === id);
  if (!o) notFound();
  const info = orderAccessInfo(db, user, o);
  if (info.access === "none") redirect(`/orders?err=${encodeURIComponent("この案件を見る権限がありません。")}`);
  const returnTo = sp.returnTo && sp.returnTo.startsWith("/") && !sp.returnTo.startsWith("//") ? sp.returnTo : undefined;
  const back = returnTo ?? `/orders/${o.id}`;
  const self = `/orders/${o.id}/sales${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ""}`;
  const customer = db.customers.find((c) => c.id === o.customerId);
  const q = o.quoteId ? db.quotes.find((x) => x.id === o.quoteId) : undefined;
  const confirmed = salesConfirmed(o);
  const open = ["confirmed", "scheduled", "in_progress"].includes(o.status);
  const lock = completedCaseLock(db, user, o);
  const canUse = canConfirmSales(user, o.storeId) && !lock.locked && (open || confirmed);
  const invoice = liveInvoicesOfOrder(db.invoices, o)[0];
  const batch = usesBatchBilling(customer);
  // ポスティングは個人のお客様の案件だけ (お客様のご連絡 2026-11-27「ポスティングは個人のみです」。法人は ④ を出さない)
  const ready = salesReadinessOf(db, o);
  const withPosting = ready.postingNeeded;
  const workStaff = workStaffOf(db, o);
  const groups = staffChoiceGroups(db, o.storeId, WORK_ROLES.flatMap((r) => workStaff[r]));
  const ownAmend = skipsApproval(user, "quote_amend");
  const amountBlock = confirmed ? amendBlockedByInvoice(db, { orderId: o.id }) : undefined;
  const linesLocked = Boolean(q?.pendingChange) || Boolean(amountBlock);
  const settings = documentSettings(db);
  const dueDefault = customer?.type === "corporate" ? Math.max(settings.paymentDays, 30) : 14;
  const title = confirmed ? "売上・請求書の修正" : "売上確定・請求書発行";

  return (
    <div className="mx-auto max-w-4xl">
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader
        title={title}
        icon={<ClipboardCheck />}
        badge={<StatusBadge value={o.status} map={ORDER_STATUS} />}
        description={`${o.number} · ${customer?.name ?? "-"} 様 · ${o.title}${o.siteAddress ? ` · ${o.siteAddress}` : ""}`}
        back={{ href: back, label: returnTo?.startsWith("/schedule") ? "予定表に戻る" : "受注の画面に戻る" }}
      />

      {confirmed && (
        <Card className="mb-4 border-good/40 bg-good-soft/30" data-testid="sales-confirmed">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Badge tone="good">売上確定済み</Badge>
            <span className="text-sm text-ink">売上計上日 {fmtDate(o.salesDate)} · {yen(o.total)} (税込)</span>
            {invoice ? (
              <PdfLink href={`/api/pdf/invoices/${invoice.id}`} returnTo={self} className={buttonClass("primary", "sm")} testId="sales-invoice">
                <FileText />
                請求書 {invoice.number} {yen(invoice.total)}
              </PdfLink>
            ) : batch ? (
              <span className="text-xs text-ink-2">まとめ請求のお客様のため、請求書は締め日にまとめて発行します</span>
            ) : null}
          </div>
          <p className="mt-2 text-[11px] text-ink-2">
            直すときは下の内容を変えて「修正を保存」を押してください。施工内容・作業の担当{withPosting ? "・ポスティング" : ""}はすぐに反映します。明細・金額は{ownAmend ? "店長・管理者のためすぐに反映し" : "店長の承認のあとに反映し"}、受注・請求書 (入金前)・経営の集計・作業日報・インセンティブにも反映します。
          </p>
        </Card>
      )}

      {lock.locked && <Note tone="warn">{completedLockMessage(lock.reason)}</Note>}
      {!canConfirmSales(user, o.storeId) && <Note tone="warn">この案件の売上確定・請求書の発行は、担当店舗の社員・本部・管理者が行えます (見るだけです)。</Note>}
      {!open && !confirmed && o.status !== "cancelled" && <Note tone="warn">{o.status === "pending_approval" || o.status === "returned" ? "契約の承認のあとに売上確定できます。" : "この状態の案件は売上確定できません。"}</Note>}
      {o.status === "cancelled" && <Note tone="warn">キャンセルした受注です。</Note>}
      {q?.pendingChange && (
        <Note tone="warn">
          明細・金額の修正が承認待ちです (¥{q.total.toLocaleString("ja-JP")} → ¥{q.pendingChange.total.toLocaleString("ja-JP")} · 申請 {db.users.find((u) => u.id === q.pendingChange?.requestedBy)?.name ?? "-"})。承認・差戻しのあとに明細を直せます。
        </Note>
      )}
      {amountBlock && <Note tone="warn">{amountBlock}</Note>}

      <form action={saveSales.bind(null, o.id)} className="space-y-4" data-testid="sales-form">
        {returnTo && <input type="hidden" name="returnTo" value={returnTo} />}
        <fieldset disabled={!canUse} className="space-y-4">
          <Card>
            <CardHeader title="① 施工内容" description="お客様に行った工事の内容 (請求書・受注に残ります)" />
            <Textarea name="workDetails" rows={3} maxLength={2000} defaultValue={o.workDetails ?? q?.workDetails ?? ""} placeholder="例: 和室6畳 表替え (さくら)・襖 2 枚 張替え" />
          </Card>

          <Card>
            <CardHeader
              title="② 明細・金額"
              description={
                q
                  ? confirmed
                    ? `直すと見積の新しい版になります (前の版は残ります)。${ownAmend ? "店長・管理者のためすぐに反映します" : "一般社員の修正は店長の承認のあとに反映します"}`
                    : "当日の追加・取りやめがあれば直してください。直すと見積の新しい版になります (前の版は残ります)"
                  : "見積から作っていない受注のため、金額は受注の画面の「契約内容の変更」で直します"
              }
            />
            {q ? (
              <>
                <SalesLinesEditor initial={q.items.map((i) => ({ id: i.id, name: i.name, spec: i.spec, qty: i.qty, unit: i.unit, unitPrice: i.unitPrice }))} discount={q.discount} taxMode={taxModeOf(q)} original={q.total} disabled={linesLocked || !canUse} />
                {!linesLocked && canUse && (
                  <Field label="金額を直す理由 (直したときだけ)" className="mt-2">
                    <Input name="reason" maxLength={200} placeholder={confirmed ? "例: 請求金額の入力の誤り・追加の工事" : "例: 現場で襖 1 枚を追加"} />
                  </Field>
                )}
              </>
            ) : (
              <p className="text-lg font-semibold text-ink tnum">{yen(o.total)} <span className="text-xs font-normal text-ink-3">(税込)</span></p>
            )}
          </Card>

          <Card id="work-staff">
            <CardHeader title="③ 担当者" description="作業ごとに実際に作業した人 (複数可。いなければ「なし」)。インセンティブ・作業日報に使います" />
            <WorkStaffFields groups={groups} value={workStaff} require />
          </Card>

          {withPosting && (
            <Card>
              <CardHeader title="④ ポスティング実績" description="誰が何枚配ったか (配っていなければ「配れてない」)。作業日報に出ます" />
              <PostingFields groups={groups} value={o.posting} defaultDate={o.posting?.date ?? o.salesDate ?? toDateKey(new Date())} defaultUserIds={o.posting ? [] : deliveryStaffOf(workStaff).slice(0, 3)} />
            </Card>
          )}

          {!confirmed && open && (
            <Card>
              <CardHeader title={`${withPosting ? "⑤" : "④"} 売上確定・請求書発行`} description={batch ? "施工完了日を売上計上日として売上を確定します。このお客様はまとめ請求のため、請求書は締め日にまとめて発行します" : "施工完了日を売上計上日として売上を確定し、請求書を発行します"} />
              <div className="flex flex-wrap items-end gap-3">
                <Field label="施工完了日 (= 売上計上日)">
                  <Input type="date" name="completedAt" defaultValue={toDateKey(new Date())} />
                </Field>
                {!ready.ok && <p className="w-full text-[11px] text-warn-ink">{withPosting ? "③ 担当者と ④ ポスティングを入れてから確定してください (作業ごとに担当者か「なし」、ポスティングは枚数か「配れてない」)。" : "③ 担当者を入れてから確定してください (作業ごとに担当者か「なし」)。"}</p>}
              </div>
              {!batch && !invoice && (
                <details className="mt-2 text-xs">
                  <summary className="cursor-pointer text-ink-2">請求書の設定 (支払期限・お渡しの方法・備考。ふだんはそのまま)</summary>
                  <div className="mt-2 grid grid-cols-1 gap-2 @xl:grid-cols-3">
                    <Field label="支払期限 (日後)">
                      <Input type="number" name="dueDays" min={1} max={180} defaultValue={dueDefault} />
                    </Field>
                    <Field label="お渡しの方法">
                      <Select name="sentVia" defaultValue="visit">
                        {(["visit", "mail", "email", "line", "chatwork"] as const).map((c) => (
                          <option key={c} value={c}>
                            {CHANNEL_LABEL[c]}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="備考 (請求書に印字)">
                      <Input name="notes" maxLength={200} />
                    </Field>
                  </div>
                </details>
              )}
              {invoice && <p className="mt-2 text-[11px] text-ink-2">請求書 {invoice.number} は発行済みです (売上確定で請求済みになります)。</p>}
            </Card>
          )}

          {canUse && (
            <div className="flex flex-wrap items-center gap-2">
              {!confirmed ? (
                <>
                  <Button type="submit" name="intent" value="confirm" data-testid="sales-confirm">
                    <ClipboardCheck />
                    {batch || invoice ? "売上確定" : "売上確定・請求書発行"} ({yen(o.total)})
                  </Button>
                  <Button type="submit" name="intent" value="save" variant="ghost" size="sm">
                    確定せずに保存
                  </Button>
                </>
              ) : (
                <>
                  <Button type="submit" name="intent" value="save" data-testid="sales-save">
                    修正を保存
                  </Button>
                  {o.status === "completed" && !invoice && !batch && (
                    <Button type="submit" name="intent" value="invoice" variant="secondary" data-testid="sales-invoice-issue">
                      <FileText />
                      請求書を発行 ({yen(o.total)})
                    </Button>
                  )}
                </>
              )}
              {!confirmed && ready.ok === false && (
                <span className="inline-flex items-center gap-1 text-[11px] text-ink-3">
                  <TriangleAlert className="h-3.5 w-3.5" aria-hidden />
                  {withPosting ? "担当者・ポスティングが未入力のときは確定できません" : "担当者が未入力のときは確定できません"}
                </span>
              )}
            </div>
          )}
        </fieldset>
      </form>
    </div>
  );
}
