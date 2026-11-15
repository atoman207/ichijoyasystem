import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canAccessStore, canViewExpense } from "@/lib/auth/permissions";
import { updateExpense } from "@/lib/actions/expenses";
import { EXPENSE_METHOD_LABEL, EXPENSE_STATUS } from "@/lib/constants";
import { aiEnabled } from "@/lib/ai/provider";
import { Button, Card, Field, Flash, FormActions, Input, LinkButton, Note, PageHeader, Select, StatusBadge } from "@/components/ui";
import { ExpenseFields } from "@/components/features/ExpenseFields";

export const maxDuration = 60;

export default async function EditExpensePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ err?: string }> }) {
  const { id } = await params;
  const { err } = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const e = db.expenses.find((x) => x.id === id);
  if (!e) notFound();
  if (!canAccessStore(user, e.storeId) || !canViewExpense(user, e)) redirect("/expenses?err=" + encodeURIComponent("この経費を修正する権限がありません。"));
  if (e.status !== "draft" && e.status !== "rejected") redirect(`/expenses/${id}?err=` + encodeURIComponent("下書き・差戻しの経費のみ修正できます。"));
  const returned = db.approvals.filter((a) => a.targetId === e.id && a.type === "expense" && a.status === "returned").sort((a, b) => (b.decidedAt ?? "").localeCompare(a.decidedAt ?? ""))[0];

  return (
    <div className="max-w-3xl">
      <Flash err={err} />
      <PageHeader title={`${e.number} を修正`} badge={<StatusBadge value={e.status} map={EXPENSE_STATUS} />} back={{ href: `/expenses/${id}`, label: "経費の詳細" }} />
      {returned?.decisionComment && <Note tone="warn">差戻しの理由: {returned.decisionComment}</Note>}
      <Card className="mt-4">
        <form action={updateExpense.bind(null, e.id)} className="space-y-5">
          <div className="grid grid-cols-1 gap-4 @xl:grid-cols-2">
            <Field label="日付" required><Input type="date" name="date" defaultValue={e.date} required /></Field>
            <Field label="支払方法">
              <Select name="paymentMethod" defaultValue={e.paymentMethod}>
                {(Object.keys(EXPENSE_METHOD_LABEL) as (keyof typeof EXPENSE_METHOD_LABEL)[]).map((m) => <option key={m} value={m}>{EXPENSE_METHOD_LABEL[m]}</option>)}
              </Select>
            </Field>
          </div>
          <ExpenseFields initial={{ vendor: e.vendor, amount: e.amount, taxAmount: e.taxAmount, account: e.account, description: e.description }} aiAvailable={aiEnabled()} />
          <FormActions>
            <LinkButton href={`/expenses/${id}`} variant="secondary">キャンセル</LinkButton>
            <Button type="submit" name="intent" value="save" variant="secondary">修正を保存</Button>
            <Button type="submit" name="intent" value="submit">修正して申請</Button>
          </FormActions>
        </form>
      </Card>
    </div>
  );
}
