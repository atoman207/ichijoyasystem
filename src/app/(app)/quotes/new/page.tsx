import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canEditCaseStore, canSeeAllStores, skipsApproval } from "@/lib/auth/permissions";
import { createQuote } from "@/lib/actions/quotes";
import { customerOptions } from "@/lib/db/queries";
import { CustomerSearch } from "@/components/features/CustomerSearch";
import { customerOptionLabel } from "@/lib/duplicates";
import { addDays, toDateKey } from "@/lib/format";
import { CATEGORY_LABEL, DOCUMENT_KIND_LABEL } from "@/lib/constants";
import { approvalSettings } from "@/lib/approval-rules";
import { matchProduct } from "@/lib/product-match";
import { documentSettings } from "@/lib/doc-settings";
import { toSiteInfo } from "@/lib/site-info";
import { matchStaff } from "@/lib/survey-link";
import { userCanCreateCustomer } from "@/lib/ops-settings";
import { SiteInfoFields } from "@/components/features/SiteInfo";
import type { QuoteItem, ServiceCategory } from "@/lib/db/types";
import { QuoteEditor } from "@/components/features/QuoteEditor";
import type { TaxMode } from "@/lib/quote-calc";
import { itemCategoryProps } from "@/lib/mgmt/categories";
import { dokoChoiceInfo } from "@/lib/mgmt/costing";
import { Button, Card, Field, Flash, FormActions, Input, LinkButton, Note, PageHeader, Select, Textarea } from "@/components/ui";

export default async function NewQuotePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  /** 管理者 (社長) の申請は承認を省略して、そのまま反映される (permissions.ts の skipsApproval) */
  const own = skipsApproval(user, "quote");
  const db = getDb();
  const allStores = canSeeAllStores(user);
  const inquiry = db.inquiries.find((i) => i.id === sp.inquiryId);
  const doc = db.documents.find((d) => d.id === sp.documentId);
  const category = (sp.category ?? inquiry?.category ?? "tatami") as ServiceCategory;
  const customerId = sp.customerId ?? inquiry?.customerId ?? "";
  const customer = db.customers.find((c) => c.id === customerId);
  // 見積を作れるお客様: 自店舗 (全店舗ロールは全店舗)、店長は全店舗 (permissions.ts の canEditCaseStore)
  const choices = customerOptions(db.customers.filter((c) => canEditCaseStore(user, c.storeId)), sp.cq, customerId);
  const customers = choices.options;

  // 取込書類 (手書き見積・図面・施工資料・契約書) の読取結果を初期値にする。品名は商品マスタに対応づけ、単価がなければマスタの単価
  const ex = (doc?.extracted ?? {}) as Record<string, unknown>;
  let initialItems: QuoteItem[] | undefined;
  let docCategory: ServiceCategory | undefined;
  if (doc && Array.isArray(ex.items)) {
    const rows = (ex.items as { name?: string; spec?: string; qty?: number; unit?: string; unitPrice?: number; amount?: number; productId?: string }[]).filter((it) => it?.name);
    initialItems = rows.map((it, i) => {
      const p = (it.productId ? db.products.find((x) => x.id === it.productId) : undefined) ?? matchProduct(db.products, `${it.name} ${it.spec ?? ""}`);
      const qty = typeof it.qty === "number" && it.qty > 0 ? it.qty : 1;
      const unitPrice = typeof it.unitPrice === "number" ? it.unitPrice : typeof it.amount === "number" ? Math.round(it.amount / qty) : (p?.unitPrice ?? 0);
      docCategory ??= p?.category;
      return { id: `ocr_${i}`, productId: p?.id, name: it.name!, spec: it.spec || (p ? [p.grade, p.sizeLabel].filter(Boolean).join(" / ") || undefined : undefined), qty, unit: it.unit || p?.unit || "式", unitPrice, amount: Math.round(qty * unitPrice) };
    });
    if (!initialItems.length) initialItems = undefined;
  }
  const exText = (k: string) => (typeof ex[k] === "string" ? (ex[k] as string).trim() : "");
  const docTitle = exText("title") || (doc ? `${exText("customerName") || exText("siteName") || "お客様"} ${DOCUMENT_KIND_LABEL[doc.kind].replace(/ \(.*\)$/, "")}より` : "");
  const defaultTitle = inquiry ? inquiry.summary.replace(/^[^:：]+[:：]\s*/, "") : docTitle;
  const roomsText = Array.isArray(ex.rooms) ? (ex.rooms as { name?: string; size?: string; tatamiCount?: number }[]).map((r) => [r.name, r.size ?? (r.tatamiCount ? `${r.tatamiCount}畳` : "")].filter(Boolean).join(" ")).filter(Boolean).join("、") : "";
  const defaultWork = [exText("instructions"), roomsText ? `部屋: ${roomsText}` : "", exText("siteAddress") ? `現場: ${exText("siteAddress")}` : ""].filter(Boolean).join("\n");
  const settings = documentSettings(db);
  // 手書き見積書: 担当者・税込・現場情報 (備考欄以下)・お渡し済み
  const handwritten = doc?.kind === "handwritten_quote";
  const estimatorDefault = matchStaff(db.users, exText("staffName"), customer?.storeId ?? user.storeId)[0] ?? user.id;
  // 見積は内税 (税込) が標準 (お客様のご要望 2026-11-24「①」)。読み取った見積書が「税抜」のときだけ外税
  const taxModeDefault: TaxMode = ex.taxMode === "税抜" || (ex.taxMode !== "税込" && ex.taxIncluded === false) ? "excluded" : "included";
  const siteDefaults = doc ? toSiteInfo({ ...ex, remarks: ex.note }) : undefined;
  const canRegisterCustomer = userCanCreateCustomer(db, user);
  const newCustomerHref = `/customers/new?${new URLSearchParams({ ...(exText("customerName") ? { name: exText("customerName") } : {}), ...(exText("furigana") ? { kana: exText("furigana") } : {}), ...(exText("phone") ? { phone: exText("phone") } : {}), ...(exText("siteAddress") ? { address: exText("siteAddress") } : {}), returnTo: `/quotes/new?documentId=${doc?.id ?? ""}` })}`;
  const staff = db.users.filter((u) => u.active).sort((a, b) => Number(b.storeId === (customer?.storeId ?? user.storeId)) - Number(a.storeId === (customer?.storeId ?? user.storeId)));
  const docCategoryValue = sp.category ? category : (docCategory ?? category);

  return (
    <div className="max-w-5xl">
      <Flash err={sp.err} />
      <PageHeader title="見積を作成" back={{ href: inquiry ? `/inquiries/${inquiry.id}` : "/quotes", label: inquiry ? "問い合わせに戻る" : "見積一覧" }} />
      <Note tone="accent">
        合計 {approvalSettings(db).quoteAdminThreshold.toLocaleString("ja-JP")} 円未満は店長承認、以上は管理者承認が必要です (本部の案件・店長の申請・承認できる店長がいない店舗は管理者)。「承認を申請」すると承認者に通知され、承認後にお客様へ送付できます。
        {doc && <> この見積は取込書類「{doc.fileName}」の読取結果を初期値にしています (品名は商品マスタに対応づけ、単価が読み取れない行はマスタの単価)。内容を確認・修正してください。</>}
      </Note>
      {customer?.tradeStopped && (
        <Note tone="warn">
          {customer.name} 様は<strong>取引停止</strong>のお客様です{customer.tradeStopNote ? ` (理由: ${customer.tradeStopNote})` : ""}。見積を作る前に店長・管理者に確認してください。
        </Note>
      )}
      <Card className="mt-4">
        {choices.searchable && (
          <CustomerSearch total={choices.total} q={sp.cq} shown={customers.filter((c) => c.id !== customerId).length} keep={{ customerId: sp.customerId, inquiryId: sp.inquiryId, documentId: sp.documentId, category: sp.category }} />
        )}
        <form action={createQuote} className="space-y-5">
          {inquiry && <input type="hidden" name="inquiryId" value={inquiry.id} />}
          {doc && <><input type="hidden" name="documentId" value={doc.id} /><input type="hidden" name="source" value="ocr" /><input type="hidden" name="paperNo" value={exText("paperNo")} /><input type="hidden" name="quoteDate" value={exText("quoteDate")} /></>}
          {doc && !customerId && (exText("customerName") || exText("phone")) && (
            <div className="rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn-ink">
              手書き見積書のお客様: <span className="font-medium">{exText("customerName") || "(氏名なし)"}</span>{exText("phone") ? ` · Tel ${exText("phone")}` : ""}{exText("siteAddress") ? ` · ${exText("siteAddress")}` : ""}。
              登録済みのお客様なら下で選んでください。{canRegisterCustomer ? <> 新しいお客様なら <a href={newCustomerHref} className="font-medium underline">顧客を登録</a> してから続けます (読み取った氏名・電話・住所が入ります)。</> : " 新しいお客様の登録は事務担当が行います。事務担当に依頼してください。"}
            </div>
          )}
          <div className="grid grid-cols-1 gap-4 @xl:grid-cols-2 @4xl:grid-cols-4">
            <Field label="お客様" required className="@4xl:col-span-2" hint={choices.searchable ? "上の検索 (住所・町名が確実) で候補を表示。同じ氏名・電話でも住所が違うことがあるので、住所を確かめて選んでください" : "候補の住所を確かめて選んでください (受注番号は不要です)"}>
              <Select name="customerId" defaultValue={customerId} required>
                <option value="">選択してください</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{customerOptionLabel(c)}</option>)}
              </Select>
            </Field>
            <Field label="店舗">
              <Select name="storeId" defaultValue={allStores ? (customer?.storeId ?? "") : (inquiry?.storeId ?? user.storeId)} disabled={!allStores}>
                {allStores && <option value="">お客様の担当店舗</option>}
                {db.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </Field>
            <Field label="種別">
              <Select name="category" defaultValue={docCategoryValue}>
                {(Object.keys(CATEGORY_LABEL) as ServiceCategory[]).map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
              </Select>
            </Field>
            <Field label="件名" required className="@4xl:col-span-3">
              <Input name="title" required defaultValue={defaultTitle} placeholder="例: 和室6畳 畳表替え (さくら)" />
            </Field>
            <Field label="有効期限">
              <Input name="validUntil" type="date" defaultValue={addDays(toDateKey(new Date()), settings.quoteValidDays)} />
            </Field>
          </div>
          <div>
            <div className="label">明細</div>
            <QuoteEditor products={db.products} defaultCategory={docCategoryValue} initialItems={initialItems} autoOnLoad initialDiscount={typeof ex.discount === "number" ? ex.discount : 0} initialTaxMode={taxModeDefault} {...itemCategoryProps(db, docCategoryValue)} doko={dokoChoiceInfo(db, toDateKey(new Date()))} />
          </div>
          <Field label="施工内容 (見積書に印字し、受注に引き継ぎます)" hint="例: 和室6畳 表替え (さくら)。家具の移動・古畳の引取を含みます">
            <Textarea name="workDetails" rows={3} defaultValue={defaultWork} />
          </Field>
          <Field label="備考 (見積書に印字)">
            <Textarea name="notes" placeholder="例: 施工は 2 日仕上げ。古畳の処分費を含みます。" defaultValue={exText("note")} />
          </Field>
          <div className="grid grid-cols-1 gap-4 @xl:grid-cols-2">
            <Field label="施工場所 (お客様の住所と違うとき)" hint="例: ご実家・お子様の家など。空欄ならお客様の住所。受注・予定表・見積書に引き継ぎます">
              <Input name="siteAddress" defaultValue={exText("siteAddress") && exText("siteAddress") !== customer?.address ? exText("siteAddress") : undefined} placeholder={customer?.address ? `空欄 = ${customer.address}` : "熊本県…"} />
            </Field>
            <Field label="領収書の宛名 (お客様名と違うとき)" hint="例: 株式会社○○ (会社名義の領収書)。空欄ならお客様名。受注で変更できます">
              <Input name="receiptName" defaultValue={undefined} placeholder={customer?.name ? `空欄 = ${customer.name} 様` : "株式会社○○"} />
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 @xl:grid-cols-2">
            <Field label="見積担当 (現場で見積をした社員)">
              <Select name="estimatorId" defaultValue={estimatorDefault}>
                {staff.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </Select>
            </Field>
            <label className="flex items-center gap-2 self-end pb-2 text-sm text-ink">
              <input type="checkbox" name="handedOver" defaultChecked={handwritten} className="h-4 w-4" />
              現場でお客様に見積書を渡し済み (承認後に「送付済 (手渡し)」になります)
            </label>
          </div>
          <details className="rounded-xl border border-line px-4 py-3" open={Boolean(siteDefaults)}>
            <summary className="cursor-pointer text-sm font-medium text-ink">現場情報・引継ぎ事項 (引取・納品日時、支払い方法、備考欄以下)</summary>
            <p className="mb-3 mt-1 text-[11px] text-ink-3">受注に引き継ぎ、施工担当者と共有します (受注・施工の画面と予定表のメモ)。後から見積・受注の画面で修正できます。</p>
            <SiteInfoFields value={siteDefaults} />
          </details>
          <FormActions>
            <LinkButton href="/quotes" variant="secondary">キャンセル</LinkButton>
            <Button type="submit" name="intent" value="draft" variant="secondary">下書き保存</Button>
            <Button type="submit" name="intent" value="submit">{own ? "確定 (承認不要)" : "承認を申請"}</Button>
          </FormActions>
        </form>
      </Card>
    </div>
  );
}
