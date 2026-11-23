import type { Customer, User } from "@/lib/db/types";
import { canAccessStore, canIssueInvoices } from "@/lib/auth/permissions";
import { CLOSING_DAY_CHOICES, DEFAULT_BILLING_TERMS, PAY_DAY_CHOICES, PAY_MONTH_LABEL, batchTerms, normalizeTerms, termsText } from "@/lib/billing";
import { updateBillingTerms } from "@/lib/actions/billing";
import { Button, Card, CardHeader, Field, Input, LinkButton, Select } from "@/components/ui";

const dayLabel = (d: number) => (d >= 31 ? "末日" : `${d}日`);

/** お客様の画面: 請求の締め (法人のお客様のまとめ請求の有無・締め日・支払期限) */
export function BillingTermsCard({ customer: c, user }: { customer: Customer; user: User }) {
  const terms = batchTerms(c);
  const form = c.billingTerms ? normalizeTerms(c.billingTerms) : { ...DEFAULT_BILLING_TERMS, batch: c.type === "corporate" };
  const canEdit = canIssueInvoices(user) && canAccessStore(user, c.storeId);
  if (!terms && !canEdit && c.type !== "corporate") return null;
  return (
    <Card>
      <CardHeader
        title="請求の締め"
        description={terms ? `まとめ請求: ${termsText(terms)}。完了した案件は締め日にまとめて 1 枚の請求書にします (売上計上日は各案件の施工完了日)` : "案件ごとに請求書を発行しています。法人のお客様など、締め日ごとにまとめて請求するときは「まとめ請求」にします"}
        action={terms ? <LinkButton href="/invoices/batch" variant="ghost" size="sm">まとめ請求</LinkButton> : undefined}
      />
      {terms?.note && <p className="mb-2 text-xs text-ink-2">{terms.note}</p>}
      {canEdit && (
        <details className="rounded-lg border border-line px-3 py-2" open={!c.billingTerms && c.type === "corporate"}>
          <summary className="cursor-pointer text-sm font-medium text-accent">{c.billingTerms ? "締め日・支払期限を変更する" : "まとめ請求を設定する"}</summary>
          <form action={updateBillingTerms.bind(null, c.id)} className="mt-3 space-y-3">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="batch" defaultChecked={form.batch} className="h-4 w-4" /> 締め日ごとにまとめて請求する (まとめ請求)</label>
            <div className="grid grid-cols-1 gap-2 @xl:grid-cols-3">
              <Field label="締め日">
                <Select name="closingDay" defaultValue={String(form.closingDay)}>
                  {CLOSING_DAY_CHOICES.map((d) => <option key={d} value={d}>{dayLabel(d)}締め</option>)}
                </Select>
              </Field>
              <Field label="支払期限の月">
                <Select name="payMonthOffset" defaultValue={String(form.payMonthOffset)}>
                  {Object.entries(PAY_MONTH_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </Select>
              </Field>
              <Field label="支払期限の日">
                <Select name="payDay" defaultValue={String(form.payDay)}>
                  {PAY_DAY_CHOICES.map((d) => <option key={d} value={d}>{dayLabel(d)}</option>)}
                </Select>
              </Field>
            </div>
            <Field label="メモ (任意)" hint="例: 請求書は経理部 ○○様宛て・郵送"><Input name="note" defaultValue={form.note} maxLength={200} /></Field>
            <Button type="submit" size="sm" variant="secondary">保存する</Button>
          </form>
        </details>
      )}
    </Card>
  );
}
