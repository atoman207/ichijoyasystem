import Link from "@/components/ui/Link";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canSeeAllStores, skipsApproval } from "@/lib/auth/permissions";
import { createExpense } from "@/lib/actions/expenses";
import { toDateKey } from "@/lib/format";
import { EXPENSE_METHOD_LABEL } from "@/lib/constants";
import { approvalSettings } from "@/lib/approval-rules";
import { readCandidates } from "@/lib/expense-account";
import { aiEnabled } from "@/lib/ai/provider";
import { Button, Card, Field, Flash, FormActions, Input, LinkButton, Note, PageHeader, Select } from "@/components/ui";
import { ExpenseFields } from "@/components/features/ExpenseFields";

/** 「AI で候補を出す」で AI の応答を待つため */
export const maxDuration = 60;

export default async function NewExpensePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  /** 管理者 (社長) の申請は承認を省略して、そのまま反映される (permissions.ts の skipsApproval) */
  const own = skipsApproval(user);
  const db = getDb();
  const allStores = canSeeAllStores(user);
  const doc = db.documents.find((d) => d.id === sp.documentId && !d.linkedId);
  const ex = (doc?.extracted ?? {}) as { vendor?: string; date?: string; amount?: number; taxAmount?: number; account?: string; paymentMethod?: string; note?: string; items?: { name?: string }[]; _accountCandidates?: unknown };
  const threshold = approvalSettings(db).expenseAdminThreshold;
  const preset = sp.preset === "fuel" ? { account: "車両費 (ガソリン代)", description: "施工車 給油" } : sp.preset === "equipment" ? { account: "消耗品費", description: "備品購入" } : undefined;

  return (
    <div className="max-w-3xl">
      <Flash err={sp.err} />
      <PageHeader title="経費を登録" back={{ href: "/expenses", label: "経費一覧" }} />
      <Note tone="accent">
        {threshold.toLocaleString("ja-JP")} 円未満は店長承認、以上 (および本部分・店長の申請・承認できる店長がいない店舗) は管理者承認です。
        {doc ? <> 取込書類「{doc.fileName}」の読取結果を初期値にしています (読取確度 {Math.round((doc.confidence ?? 0) * 100)}%)。内容を確認してください。</> : <> 手入力の代わりに <a href="/capture?kind=receipt" className="underline">レシートを撮影して取り込む</a> と、AI が金額・日付・勘定科目の候補を読み取ります。</>}
      </Note>
      {!doc && (
        <div className="mt-3 flex flex-wrap gap-2 text-xs">
          <span className="text-ink-3">よく使う経費:</span>
          <Link href="/expenses/new?preset=fuel" className="rounded-full border border-line px-2.5 py-0.5 text-accent hover:bg-accent-soft">ガソリン代</Link>
          <Link href="/expenses/new?preset=equipment" className="rounded-full border border-line px-2.5 py-0.5 text-accent hover:bg-accent-soft">備品購入</Link>
        </div>
      )}
      <Card className="mt-4">
        <form action={createExpense} className="space-y-5">
          {doc && <input type="hidden" name="documentId" value={doc.id} />}
          <div className="grid grid-cols-1 gap-4 @xl:grid-cols-3">
            <Field label="日付" required><Input type="date" name="date" defaultValue={ex.date ?? toDateKey(new Date())} required /></Field>
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
          <ExpenseFields
            initial={{ vendor: ex.vendor, amount: ex.amount, taxAmount: ex.taxAmount, account: ex.account ?? preset?.account, description: [ex.note, (ex.items ?? []).map((i) => i.name).filter(Boolean).join("・")].filter(Boolean).join(" / ") || preset?.description }}
            initialCandidates={readCandidates(ex._accountCandidates)}
            aiAvailable={aiEnabled()}
          />
          <p className="text-[11px] text-ink-3">現金で立て替えた経費は、本部で精算すると店舗の現金出納帳に出金として記帳されます。</p>
          <FormActions>
            <LinkButton href="/expenses" variant="secondary">キャンセル</LinkButton>
            <Button type="submit" name="intent" value="draft" variant="secondary">下書き保存</Button>
            <Button type="submit" name="intent" value="submit">{own ? "確定 (承認不要)" : "承認を申請"}</Button>
          </FormActions>
        </form>
      </Card>
    </div>
  );
}
