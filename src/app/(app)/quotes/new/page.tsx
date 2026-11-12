import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canSeeAllStores, scopeByStore } from "@/lib/auth/permissions";
import { createQuote } from "@/lib/actions/quotes";
import { customerOptions } from "@/lib/db/queries";
import { CustomerSearch } from "@/components/features/CustomerSearch";
import { addDays, toDateKey } from "@/lib/format";
import { APPROVAL_RULES, CATEGORY_LABEL } from "@/lib/constants";
import type { QuoteItem, ServiceCategory } from "@/lib/db/types";
import { QuoteEditor } from "@/components/features/QuoteEditor";
import { Button, Card, Field, Flash, FormActions, Input, LinkButton, Note, PageHeader, Select, Textarea } from "@/components/ui";

export default async function NewQuotePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const allStores = canSeeAllStores(user);
  const inquiry = db.inquiries.find((i) => i.id === sp.inquiryId);
  const doc = db.documents.find((d) => d.id === sp.documentId);
  const category = (sp.category ?? inquiry?.category ?? "tatami") as ServiceCategory;
  const customerId = sp.customerId ?? inquiry?.customerId ?? "";
  const customer = db.customers.find((c) => c.id === customerId);
  const choices = customerOptions(scopeByStore(user, db.customers), sp.cq, customerId);
  const customers = choices.options;

  // OCR 取込書類からの初期明細
  let initialItems: QuoteItem[] | undefined;
  if (doc?.extracted && Array.isArray((doc.extracted as { items?: unknown }).items)) {
    const items = (doc.extracted as { items: { name: string; qty: number; unitPrice: number }[] }).items;
    initialItems = items.map((it, i) => {
      const p = db.products.find((x) => it.name.includes(x.name.replace("畳表替え ", "").replace(" (一式)", "")) || x.name.includes(it.name));
      return { id: `ocr_${i}`, productId: p?.id, name: it.name, qty: it.qty, unit: p?.unit ?? "式", unitPrice: it.unitPrice, amount: it.qty * it.unitPrice };
    });
  }
  const defaultTitle = inquiry ? inquiry.summary.replace(/^[^:：]+[:：]\s*/, "") : doc ? `手書き見積より (${doc.fileName})` : "";

  return (
    <div className="max-w-5xl">
      <Flash err={sp.err} />
      <PageHeader title="見積を作成" back={{ href: inquiry ? `/inquiries/${inquiry.id}` : "/quotes", label: inquiry ? "問い合わせに戻る" : "見積一覧" }} />
      <Note tone="accent">
        合計 {APPROVAL_RULES.quoteAdminThreshold.toLocaleString("ja-JP")} 円未満は店長承認、以上は管理者承認が必要です (本部の案件と、承認できる店長がいない店舗は管理者)。「承認を申請」すると承認者に通知され、承認後にお客様へ送付できます。
        {doc && <> この見積は取込書類「{doc.fileName}」の読取結果を初期値にしています。内容を確認・修正してください。</>}
      </Note>
      <Card className="mt-4">
        {choices.searchable && (
          <CustomerSearch total={choices.total} q={sp.cq} shown={customers.filter((c) => c.id !== customerId).length} keep={{ customerId: sp.customerId, inquiryId: sp.inquiryId, documentId: sp.documentId, category: sp.category }} />
        )}
        <form action={createQuote} className="space-y-5">
          {inquiry && <input type="hidden" name="inquiryId" value={inquiry.id} />}
          {doc && <><input type="hidden" name="documentId" value={doc.id} /><input type="hidden" name="source" value="ocr" /></>}
          <div className="grid grid-cols-1 gap-4 @xl:grid-cols-2 @4xl:grid-cols-4">
            <Field label="お客様" required className="@4xl:col-span-2" hint={choices.searchable ? "上の検索で候補を表示して選びます" : undefined}>
              <Select name="customerId" defaultValue={customerId} required>
                <option value="">選択してください</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.code})</option>)}
              </Select>
            </Field>
            <Field label="店舗">
              <Select name="storeId" defaultValue={customer?.storeId ?? (allStores ? "" : user.storeId)} disabled={!allStores}>
                {allStores && <option value="">お客様の担当店舗</option>}
                {db.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </Field>
            <Field label="種別">
              <Select name="category" defaultValue={category}>
                {(Object.keys(CATEGORY_LABEL) as ServiceCategory[]).map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
              </Select>
            </Field>
            <Field label="件名" required className="@4xl:col-span-3">
              <Input name="title" required defaultValue={defaultTitle} placeholder="例: 和室6畳 畳表替え (さくら)" />
            </Field>
            <Field label="有効期限">
              <Input name="validUntil" type="date" defaultValue={addDays(toDateKey(new Date()), 30)} />
            </Field>
          </div>
          <div>
            <div className="label">明細</div>
            <QuoteEditor products={db.products} defaultCategory={category} initialItems={initialItems} />
          </div>
          <Field label="備考 (見積書に印字)">
            <Textarea name="notes" placeholder="例: 施工は 2 日仕上げ。古畳の処分費を含みます。" />
          </Field>
          <FormActions>
            <LinkButton href="/quotes" variant="secondary">キャンセル</LinkButton>
            <Button type="submit" name="intent" value="draft" variant="secondary">下書き保存</Button>
            <Button type="submit" name="intent" value="submit">承認を申請</Button>
          </FormActions>
        </form>
      </Card>
    </div>
  );
}
