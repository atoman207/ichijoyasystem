import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canSeeAllStores } from "@/lib/auth/permissions";
import { createExpense } from "@/lib/actions/expenses";
import { toDateKey } from "@/lib/format";
import { APPROVAL_RULES, EXPENSE_ACCOUNTS, EXPENSE_METHOD_LABEL } from "@/lib/constants";
import { Button, Card, Field, Flash, FormActions, Input, LinkButton, Note, PageHeader, Select, Textarea } from "@/components/ui";

export default async function NewExpensePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const allStores = canSeeAllStores(user);
  const doc = db.documents.find((d) => d.id === sp.documentId);
  const ex = (doc?.extracted ?? {}) as { vendor?: string; date?: string; amount?: number; taxAmount?: number; account?: string; paymentMethod?: string };

  return (
    <div className="max-w-3xl">
      <Flash err={sp.err} />
      <PageHeader title="経費を登録" back={{ href: "/expenses", label: "経費一覧" }} />
      <Note tone="accent">
        {APPROVAL_RULES.expenseAdminThreshold.toLocaleString("ja-JP")} 円未満は店長承認、以上 (および本部分・承認できる店長がいない店舗) は管理者承認です。
        {doc ? <> 取込書類「{doc.fileName}」の読取結果を初期値にしています (読取確度 {Math.round((doc.confidence ?? 0) * 100)}%)。内容を確認してください。</> : <> 手入力の代わりに <a href="/capture?kind=receipt" className="underline">レシートを撮影して取り込む</a> こともできます。</>}
      </Note>
      <Card className="mt-4">
        <form action={createExpense} className="space-y-5">
          {doc && <><input type="hidden" name="documentId" value={doc.id} /><input type="hidden" name="source" value="ocr" /></>}
          <div className="grid grid-cols-1 gap-4 @xl:grid-cols-2">
            <Field label="日付" required><Input type="date" name="date" defaultValue={ex.date ?? toDateKey(new Date())} required /></Field>
            <Field label="支払先" required><Input name="vendor" defaultValue={ex.vendor} required placeholder="例: ENEOS 合志SS" /></Field>
            <Field label="金額 (税込)" required><Input type="number" name="amount" defaultValue={ex.amount} required min={1} /></Field>
            <Field label="うち消費税" hint="空欄なら 10% として自動計算"><Input type="number" name="taxAmount" defaultValue={ex.taxAmount} /></Field>
            <Field label="勘定科目">
              <Select name="account" defaultValue={ex.account ?? "消耗品費"}>
                {EXPENSE_ACCOUNTS.map((a) => <option key={a} value={a}>{a}</option>)}
              </Select>
            </Field>
            <Field label="支払方法">
              <Select name="paymentMethod" defaultValue={ex.paymentMethod ?? "cash"}>
                {(Object.keys(EXPENSE_METHOD_LABEL) as (keyof typeof EXPENSE_METHOD_LABEL)[]).map((m) => <option key={m} value={m}>{EXPENSE_METHOD_LABEL[m]}</option>)}
              </Select>
            </Field>
            <Field label="店舗">
              <Select name="storeId" defaultValue={doc?.storeId ?? user.storeId} disabled={!allStores}>
                {db.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </Field>
          </div>
          <Field label="内容・用途"><Textarea name="description" placeholder="例: 施工車 給油 / 養生シート購入" /></Field>
          <FormActions>
            <LinkButton href="/expenses" variant="secondary">キャンセル</LinkButton>
            <Button type="submit" name="intent" value="draft" variant="secondary">下書き保存</Button>
            <Button type="submit" name="intent" value="submit">承認を申請</Button>
          </FormActions>
        </form>
      </Card>
    </div>
  );
}
