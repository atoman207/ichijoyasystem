import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canAccessStore, skipsApproval } from "@/lib/auth/permissions";
import { updateQuote } from "@/lib/actions/quotes";
import { customerName } from "@/lib/db/queries";
import { CATEGORY_LABEL } from "@/lib/constants";
import type { ServiceCategory } from "@/lib/db/types";
import { QuoteEditor } from "@/components/features/QuoteEditor";
import { Button, Card, Field, Flash, FormActions, Input, LinkButton, Note, PageHeader, Select, Textarea } from "@/components/ui";

export default async function EditQuotePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ err?: string }> }) {
  const { id } = await params;
  const { err } = await searchParams;
  const user = await requireUser();
  /** 管理者 (社長) の申請は承認を省略して、そのまま反映される (permissions.ts の skipsApproval) */
  const own = skipsApproval(user);
  const db = getDb();
  const q = db.quotes.find((x) => x.id === id);
  if (!q) notFound();
  if (!canAccessStore(user, q.storeId)) redirect("/quotes?err=" + encodeURIComponent("この見積を編集する権限がありません。"));
  const customer = db.customers.find((c) => c.id === q.customerId);
  const amend = q.status !== "draft";
  if (!["draft", "approved", "sent", "accepted"].includes(q.status) || q.pendingChange) {
    redirect(`/quotes/${id}?err=` + encodeURIComponent(q.pendingChange ? "承認待ちの変更があるため編集できません。" : "この状態の見積は編集できません。"));
  }
  return (
    <div className="max-w-5xl">
      <Flash err={err} />
      <PageHeader title={`${q.number} を編集`} description={`${customerName(q.customerId)} 様 · ${q.title} · 第${q.version}版`} back={{ href: `/quotes/${id}`, label: "見積詳細" }} />
      {amend ? (
        <Note tone="warn">この見積は確定済み (承認済・送付済・受注) です。金額・数量・施工内容の変更は <strong>変更申請</strong> として記録され、承認者 (店長または管理者) の承認後に第{q.version + 1}版として反映されます。変更前の版は「版の履歴」に残り、PDF も出力できます。</Note>
      ) : (
        <Note>{own ? "下書きの見積です。内容を修正して保存するか、そのまま確定できます (管理者の見積は承認不要)。" : "下書きの見積です。内容を修正して保存するか、そのまま承認を申請できます。"}</Note>
      )}
      <Card className="mt-4">
        <form action={updateQuote.bind(null, id)} className="space-y-5">
          <div className="grid grid-cols-1 gap-4 @xl:grid-cols-2 @4xl:grid-cols-4">
            <Field label="件名" required className="@4xl:col-span-2"><Input name="title" required defaultValue={q.title} /></Field>
            {!amend && (
              <>
                <Field label="種別">
                  <Select name="category" defaultValue={q.category}>
                    {(Object.keys(CATEGORY_LABEL) as ServiceCategory[]).map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
                  </Select>
                </Field>
                <Field label="有効期限"><Input name="validUntil" type="date" defaultValue={q.validUntil} /></Field>
              </>
            )}
          </div>
          <div>
            <div className="label">明細</div>
            <QuoteEditor products={db.products} initialItems={q.items} initialDiscount={q.discount} initialTaxIncluded={Boolean(q.taxIncluded)} />
          </div>
          <Field label="施工内容 (見積書に印字し、受注に引き継ぎます)" hint="例: 和室6畳 表替え (さくら)。家具の移動・古畳の引取を含みます">
            <Textarea name="workDetails" defaultValue={q.workDetails} rows={3} />
          </Field>
          <Field label="備考 (見積書に印字)"><Textarea name="notes" defaultValue={q.notes} /></Field>
          <div className="grid grid-cols-1 gap-4 @xl:grid-cols-2">
            <Field label="施工場所 (お客様の住所と違うとき)" hint="例: ご実家・お子様の家など。空欄ならお客様の住所。受注・予定表・見積書に引き継ぎます">
              <Input name="siteAddress" defaultValue={q.siteAddress} placeholder={customer?.address ? `空欄 = ${customer.address}` : "熊本県…"} />
            </Field>
            <Field label="領収書の宛名 (お客様名と違うとき)" hint="例: 株式会社○○ (会社名義の領収書)。空欄ならお客様名。受注で変更できます">
              <Input name="receiptName" defaultValue={q.receiptName} placeholder={customer?.name ? `空欄 = ${customer.name} 様` : "株式会社○○"} />
            </Field>
          </div>

          {amend && (
            <Field label="変更理由" required hint="承認者と変更履歴に記録されます">
              <Textarea name="reason" required placeholder="例: お客様より網戸2枚の追加依頼" />
            </Field>
          )}
          <FormActions>
            <LinkButton href={`/quotes/${id}`} variant="secondary">キャンセル</LinkButton>
            {amend ? (
              <Button type="submit" name="intent" value="amend">{own ? "変更を反映する (承認不要)" : "変更を申請する"}</Button>
            ) : (
              <>
                <Button type="submit" name="intent" value="draft" variant="secondary">下書き保存</Button>
                <Button type="submit" name="intent" value="submit">{own ? "保存して確定 (承認不要)" : "保存して承認を申請"}</Button>
              </>
            )}
          </FormActions>
        </form>
      </Card>
    </div>
  );
}
