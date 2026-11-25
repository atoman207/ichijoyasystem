import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canEditCaseStore, skipsApproval } from "@/lib/auth/permissions";
import { completedLockMessage, quoteCompletedLock } from "@/lib/case-access";
import { updateQuote } from "@/lib/actions/quotes";
import { customerName } from "@/lib/db/queries";
import { CATEGORY_LABEL } from "@/lib/constants";
import type { ServiceCategory } from "@/lib/db/types";
import { QuoteEditor } from "@/components/features/QuoteEditor";
import { taxModeOf } from "@/lib/quote-calc";
import { itemCategoryProps } from "@/lib/mgmt/categories";
import { dokoChoiceInfo } from "@/lib/mgmt/costing";
import { toDateKey } from "@/lib/format";
import { approvalSettings, manYen } from "@/lib/approval-rules";
import { Button, Card, Field, Flash, FormActions, Input, LinkButton, Note, PageHeader, Select, Textarea } from "@/components/ui";

export default async function EditQuotePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ err?: string }> }) {
  const { id } = await params;
  const { err } = await searchParams;
  const user = await requireUser();
  /** 管理者・店長の見積は承認を省略して、そのまま反映される (permissions.ts の skipsApproval) */
  const own = skipsApproval(user, "quote");
  const db = getDb();
  const q = db.quotes.find((x) => x.id === id);
  if (!q) notFound();
  // 施工完了した受注の見積の金額変更は、店長でも管理者の承認 (確定した売上。approval-decide.ts の touchesConfirmedSales)
  const confirmed = db.orders.some((o) => o.quoteId === q.id && ["completed", "invoiced", "paid"].includes(o.status));
  const ownAmend = skipsApproval(user, "quote_amend") && (user.role === "admin" || !confirmed);
  // 承認なしで反映する差額 (設定 → 承認ルール。既定 1 万円。お客様のご要望 2026-11-25「⑥」)
  const small = approvalSettings(db).smallChangeLimit;
  if (!canEditCaseStore(user, q.storeId)) redirect("/quotes?err=" + encodeURIComponent("この見積を編集する権限がありません。"));
  const lock = quoteCompletedLock(db, user, q);
  if (lock.locked) redirect(`/quotes/${id}?err=` + encodeURIComponent(completedLockMessage(lock.reason)));
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
        <Note tone="warn">この見積は確定済み (承認済・送付済・受注) です。変更は第{q.version + 1}版として記録され、変更前の版は「版の履歴」に残ります (PDF も出力できます)。仕様だけの変更と、変更前後の差額が{manYen(small)}以下の変更は承認なしですぐに反映し、それを超える変更は承認者 (店長または管理者) の承認後に反映されます{confirmed ? "。施工完了・売上確定の案件の変更は管理者の承認です" : ""}。変更は担当店舗・本部・管理者にお知らせします。</Note>
      ) : (
        <Note>{own ? "下書きの見積です。内容を修正して保存するか、そのまま確定できます (承認不要)。" : "下書きの見積です。内容を修正して保存するか、そのまま承認を申請できます。"}</Note>
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
            <QuoteEditor products={db.products} initialItems={q.items} initialDiscount={q.discount} initialTaxMode={taxModeOf(q)} {...itemCategoryProps(db, q.category)} doko={dokoChoiceInfo(db, toDateKey(new Date()))} />
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
            <Field label="変更理由" hint={`差額が${manYen(small)}を超える変更のときは必須です (承認者と変更履歴に記録されます)。差額が${manYen(small)}以下の変更・仕様だけの変更、施工場所・領収書の宛名・明細の品目だけの変更は省略できます`}>
              <Textarea name="reason" placeholder="例: お客様より網戸2枚の追加依頼" />
            </Field>
          )}
          <FormActions>
            <LinkButton href={`/quotes/${id}`} variant="secondary">キャンセル</LinkButton>
            {amend ? (
              <Button type="submit" name="intent" value="amend">{ownAmend ? "変更を反映する (承認不要)" : `変更を保存する (${manYen(small)}を超える変更は承認申請)`}</Button>
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
