import type { Database, Order, User } from "@/lib/db/types";
import { BILLING_LABEL, PAYMENT_STATE_LABEL, PLANNED_PAYMENT_LABEL, SCHEDULE_LABEL, SPEC_LABEL, STAGE_LABEL, STAGE_TONE, billingRequired, caseIndex, orderCase } from "@/lib/case-status";
import { closeCase, recordCollection, reopenCase, updateCaseStatus } from "@/lib/actions/cases";
import { canAccessStore, canManageFinance, isManagerOrAbove } from "@/lib/auth/permissions";
import { PAYMENT_METHOD_LABEL } from "@/lib/constants";
import { fmtDate, toDateKey, yen } from "@/lib/format";
import { userName } from "@/lib/db/queries";
import { Badge, Button, Card, CardHeader, Field, Input, Select } from "@/components/ui";
import { isBatchInvoice, liveInvoicesOfOrder, usesBatchBilling } from "@/lib/billing";

/** 受注・施工の画面: 案件の状態 (進捗・仕様・日程・請求・入金・事務処理) */
/** locked: 入金完了の案件 (src/lib/case-access.ts の completedCaseLock)。状態の設定だけを止め、全処理完了の登録・再開は残す */
export function CaseStatusCard({ db, order: o, user, locked = false }: { db: Database; order: Order; user: User; locked?: boolean }) {
  const today = toDateKey(new Date());
  const row = orderCase(o, caseIndex(db), today);
  const customer = db.customers.find((c) => c.id === o.customerId);
  // まとめ請求の請求書も含める (src/lib/billing.ts)
  const invoices = liveInvoicesOfOrder(db.invoices, o);
  const batchInvoice = invoices.find((i) => isBatchInvoice(i));
  const payments = db.payments.filter((p) => invoices.some((i) => i.id === p.invoiceId)).sort((a, b) => a.date.localeCompare(b.date));
  const paidOn = row.payment === "paid" || row.payment === "settlement_pending" ? payments.at(-1)?.date : undefined;
  const settledOn = row.payment === "paid" ? (payments.filter((p) => p.method === "card" || p.method === "paypay").map((p) => p.settledOn).sort().at(-1) ?? paidOn) : undefined;
  const required = billingRequired(o, customer);
  const done = ["completed", "invoiced", "paid"].includes(o.status);
  const remaining = o.total - (row.paid ?? 0);
  const manage = canManageFinance(user) || isManagerOrAbove(user);
  // 納品時の集金・入金の記録はその店舗の社員 (全店舗ロールを含む)。店長もほかの店舗の入金は記録しない (actions/cases.ts の recordCollection)
  const ownStore = canAccessStore(user, o.storeId);
  const milestones: [string, string | undefined, string?][] = [
    ["工事完了", o.completedAt ? fmtDate(o.completedAt) : undefined],
    ["売上計上 (施工完了日)", o.salesDate ? fmtDate(o.salesDate) : undefined],
    ["請求完了 (請求書の発行日)", !required ? "請求不要" : invoices[0] ? fmtDate(invoices[0].issueDate) : undefined, usesBatchBilling(customer) ? "締め日にまとめて請求" : undefined],
    ["入金完了", settledOn ? fmtDate(settledOn) : row.payment === "settlement_pending" ? undefined : undefined, row.payment === "settlement_pending" ? "決済の入金待ち" : row.payment === "partial" ? "一部入金" : undefined],
    ["全処理完了", o.closedAt ? fmtDate(o.closedAt) : undefined],
  ];
  return (
    <Card>
      <CardHeader title="案件の状態" description="進捗・仕様・日程・請求・入金・事務処理を分けて管理します。多くは記録から自動で決まります" action={<Badge tone={STAGE_TONE[row.stage]}>{STAGE_LABEL[row.stage]}</Badge>} />
      <ol className="mb-4 grid grid-cols-2 gap-2 @xl:grid-cols-5">
        {milestones.map(([label, date, note]) => (
          <li key={label} className={`rounded-lg border px-3 py-2 text-xs ${date ? "border-good/40 bg-good-soft/50" : "border-line"}`}>
            <div className="font-medium text-ink">{date ? "✓ " : ""}{label}</div>
            <div className={date ? "text-good-ink tnum" : "text-ink-3"}>{date ?? note ?? "未"}</div>
          </li>
        ))}
      </ol>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm @xl:grid-cols-3">
        <div><dt className="text-[11px] text-ink-3">状態</dt><dd className="text-ink">{row.detail}</dd></div>
        <div><dt className="text-[11px] text-ink-3">見積・仕様</dt><dd>{SPEC_LABEL[row.spec]}{o.specNote ? <span className="block text-xs text-warn-ink">{o.specNote}</span> : null}</dd></div>
        <div><dt className="text-[11px] text-ink-3">工事日程</dt><dd>{SCHEDULE_LABEL[row.schedule]}{o.scheduledStart ? ` (${fmtDate(o.scheduledStart)})` : ""}</dd></div>
        <div><dt className="text-[11px] text-ink-3">請求</dt><dd>{BILLING_LABEL[row.billing]}{o.billing ? "" : <span className="text-[11px] text-ink-3"> (自動判定)</span>}</dd></div>
        <div><dt className="text-[11px] text-ink-3">入金</dt><dd>{PAYMENT_STATE_LABEL[row.payment]}{row.paid ? <span className="text-xs text-ink-2 tnum"> {yen(row.paid)} / {yen(o.total)}</span> : null}</dd></div>
        <div><dt className="text-[11px] text-ink-3">入金方法</dt><dd>{row.paymentMethod ?? "-"}</dd></div>
      </dl>
      {row.tasks.length > 0 && (
        <p className="mt-3 rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn-ink">残っている処理: {row.tasks.join("・")}</p>
      )}
      {o.closedAt && <p className="mt-3 rounded-lg bg-good-soft px-3 py-2 text-xs text-good-ink">全処理完了 ({userName(o.closedBy)} {fmtDate(o.closedAt)})</p>}

      {!o.closedAt && o.status !== "cancelled" && !locked && (
        <details className="mt-3 rounded-lg border border-line px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium text-accent">仕様・日程・請求・入金の予定を設定する</summary>
          <form action={updateCaseStatus.bind(null, o.id)} className="mt-3 space-y-3">
            <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
              <Field label="仕様">
                <Select name="specStatus" defaultValue={o.specStatus ?? "fixed"}>
                  <option value="fixed">決定</option>
                  <option value="pending">一部の仕様が未確定</option>
                </Select>
              </Field>
              <Field label="未確定の仕様 (未確定のとき)"><Input name="specNote" defaultValue={o.specNote} placeholder="例: 襖紙の柄をお客様が検討中" /></Field>
              <Field label="工事日程" hint={o.scheduledStart ? "施工予定日が入っているため「確定」です" : "日程は「施工予定・担当」で入れると確定になります"}>
                <Select name="scheduleStatus" defaultValue={o.scheduleStatus ?? ""} disabled={Boolean(o.scheduledStart)}>
                  <option value="">未定</option>
                  <option value="adjusting">調整中</option>
                </Select>
              </Field>
              <Field label="請求書の発行" hint="自動: 法人・後日の振込・業者取引・訪問集金は必要">
                <Select name="billing" defaultValue={o.billing ?? ""}>
                  <option value="">自動判定 (現在: {required ? "必要" : "不要"})</option>
                  <option value="required">必要 (業者・後日の振込など)</option>
                  <option value="not_required">不要 (納品時に集金・決済)</option>
                </Select>
              </Field>
              <Field label="入金の予定方法">
                <Select name="plannedPayment" defaultValue={o.plannedPayment ?? ""}>
                  <option value="">未設定</option>
                  {Object.entries(PLANNED_PAYMENT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </Select>
              </Field>
            </div>
            <Button type="submit" size="sm" variant="secondary">保存する</Button>
          </form>
        </details>
      )}

      {batchInvoice && remaining > 0 && !o.closedAt && (
        <p className="mt-3 rounded-lg bg-subtle px-3 py-2 text-xs text-ink-2">この案件はまとめ請求書 {batchInvoice.number} ({batchInvoice.orderIds?.length ?? 1} 件) で請求しています。入金は請求書の画面で登録してください (入金は売上計上日の古い案件から順に割り当てます)。</p>
      )}
      {done && remaining > 0 && !o.closedAt && !batchInvoice && ownStore && (
        <details className="mt-3 rounded-lg border border-line px-3 py-2" open={!required && invoices.length === 0}>
          <summary className="cursor-pointer text-sm font-medium text-accent">納品時の集金・決済を記録する</summary>
          <form action={recordCollection.bind(null, o.id)} className="mt-3 grid grid-cols-1 items-end gap-3 @xl:grid-cols-4">
            <Field label="金額"><Input type="number" name="amount" defaultValue={remaining} min={1} required /></Field>
            <Field label="方法">
              <Select name="method" defaultValue={o.plannedPayment === "card" ? "card" : o.plannedPayment === "epay" ? "paypay" : o.plannedPayment === "transfer" ? "transfer" : "cash"}>
                {Object.entries(PAYMENT_METHOD_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            </Field>
            <Field label="日付"><Input type="date" name="date" defaultValue={today} /></Field>
            <Button type="submit" size="sm">記録する</Button>
            <p className="text-[11px] text-ink-3 @xl:col-span-4">請求書がまだないときは、入金の記録のために社内用の請求書を自動で作ります (お客様への送付なし)。カード・電子決済は、決済会社からの入金を確認するまで「決済入金待ち」です。</p>
          </form>
        </details>
      )}

      {manage && done && !o.closedAt && (
        <form action={closeCase.bind(null, o.id)} className="mt-3 flex flex-wrap items-end gap-2 border-t border-line pt-3">
          <Field label={row.tasks.filter((t) => t !== "全処理完了の登録").length ? "残っている処理があるときは理由" : "メモ (任意)"} className="min-w-0 flex-1"><Input name="reason" placeholder="例: 請求書は業者の月末締めでまとめて発行済み" /></Field>
          <Button type="submit" size="sm" variant="secondary">全処理完了にする</Button>
        </form>
      )}
      {manage && o.closedAt && (
        <form action={reopenCase.bind(null, o.id)} className="mt-3 flex flex-wrap items-end gap-2 border-t border-line pt-3">
          <Field label="取り消す理由" className="min-w-0 flex-1"><Input name="reason" required /></Field>
          <Button type="submit" size="sm" variant="ghost">全処理完了を取り消す</Button>
        </form>
      )}
    </Card>
  );
}
