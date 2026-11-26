import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canEditCaseStore, canSeeAllStores, skipsApproval } from "@/lib/auth/permissions";
import { createQuote } from "@/lib/actions/quotes";
import { captureCaseQuote } from "@/lib/actions/capture";
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
import { mediaLabel } from "@/lib/media";
import { buildCaseMap, caseHref, caseSummary, quoteLinkForCase } from "@/lib/case-group";
import { aiEnabled } from "@/lib/ai/ocr";
import { SiteInfoFields } from "@/components/features/SiteInfo";
import type { ServiceCategory } from "@/lib/db/types";
import { QuoteEditor, type EditorItem } from "@/components/features/QuoteEditor";
import { QuoteStartChoice } from "@/components/features/QuoteStartChoice";
import { CaptureUploader } from "@/components/features/CaptureUploader";
import type { TaxMode } from "@/lib/quote-calc";
import { itemCategoryProps } from "@/lib/mgmt/categories";
import { dokoChoiceInfo } from "@/lib/mgmt/costing";
import { attachmentsOf } from "@/lib/attachments";
import { Button, Card, CardHeader, Field, Flash, FormActions, Input, LinkButton, Note, PageHeader, Select, Textarea } from "@/components/ui";

/** 手書きの見積書の撮影から開くとき、AI の読み取り (最大 50 秒・行が足りなければ読み直し) を待つ */
export const maxDuration = 60;

/** 読み取った明細の行に何か入っているか (品名・規格・数字・要確認の印。品名が読めない行も残す = お客様のご要望 2026-11-26「■1」) */
type OcrItem = { name?: string; spec?: string; qty?: number; unit?: string; unitPrice?: number; amount?: number; productId?: string; uncertain?: boolean };
const hasContent = (it: OcrItem | null | undefined): it is OcrItem =>
  Boolean(it && ((it.name ?? "").trim() || (it.spec ?? "").trim() || typeof it.qty === "number" || typeof it.unitPrice === "number" || typeof it.amount === "number" || it.uncertain === true));

export default async function NewQuotePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  /** 管理者 (社長) の申請は承認を省略して、そのまま反映される (permissions.ts の skipsApproval) */
  const own = skipsApproval(user, "quote");
  const db = getDb();
  const allStores = canSeeAllStores(user);
  // 案件 (お客様のご要望 2026-11-26「■4」) から作るとき: 問い合わせのある案件はその問い合わせ、ない案件 (見積・受注から始まった案件) は案件の ID でつなぐ
  const caseMap = sp.caseId ? buildCaseMap(db) : undefined;
  const caseRoot = sp.caseId ? caseMap!.caseOf(sp.caseId) : undefined;
  const caseLink = caseRoot ? quoteLinkForCase(db, caseRoot, caseMap) : undefined;
  const inquiry = db.inquiries.find((i) => i.id === (sp.inquiryId || caseLink?.inquiryId) && !i.deleted);
  const doc = db.documents.find((d) => d.id === sp.documentId);
  const category = (sp.category ?? inquiry?.category ?? "tatami") as ServiceCategory;
  const customerId = sp.customerId ?? inquiry?.customerId ?? caseLink?.customerId ?? "";
  const customer = db.customers.find((c) => c.id === customerId);
  // 問い合わせ・案件の店舗 (入力し直さない。全店舗のロールは変えられる)
  const contextStore = inquiry?.storeId ?? (caseLink?.storeId || undefined);
  // 見積を作れるお客様: 自店舗 (全店舗ロールは全店舗)、店長は全店舗 (permissions.ts の canEditCaseStore)
  const choices = customerOptions(db.customers.filter((c) => canEditCaseStore(user, c.storeId)), sp.cq, customerId);
  const customers = choices.options;

  // 取込書類 (手書き見積・図面・施工資料・契約書) の読取結果を初期値にする。品名は商品マスタに対応づけ、単価がなければマスタの単価。
  // 品名が読めなかった行も、数字・規格・要確認の印があれば残す (品名を入力してもらう。行を省くと見積書と順番・合計が合わなくなる)
  const ex = (doc?.extracted ?? {}) as Record<string, unknown>;
  let initialItems: EditorItem[] | undefined;
  let docCategory: ServiceCategory | undefined;
  if (doc && Array.isArray(ex.items)) {
    const rows = (ex.items as (OcrItem | null)[]).filter(hasContent);
    initialItems = rows.map((it, i) => {
      const name = (it.name ?? "").trim();
      const p = (it.productId ? db.products.find((x) => x.id === it.productId) : undefined) ?? (name ? matchProduct(db.products, `${name} ${it.spec ?? ""}`) : undefined);
      const qty = typeof it.qty === "number" && it.qty > 0 ? it.qty : 1;
      const unitPrice = typeof it.unitPrice === "number" ? it.unitPrice : typeof it.amount === "number" ? Math.round(it.amount / qty) : (p?.unitPrice ?? 0);
      docCategory ??= p?.category;
      return { id: `ocr_${i}`, productId: p?.id, name, spec: it.spec || (p ? [p.grade, p.sizeLabel].filter(Boolean).join(" / ") || undefined : undefined), qty, unit: it.unit || p?.unit || "式", unitPrice, amount: Math.round(qty * unitPrice), uncertain: it.uncertain === true || !name };
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
  const staff = db.users.filter((u) => u.active).sort((a, b) => Number(b.storeId === (customer?.storeId ?? user.storeId)) - Number(a.storeId === (customer?.storeId ?? user.storeId)));
  const docCategoryValue = sp.category ? category : (docCategory ?? category);
  // ほかの画面 (予定表の小さな画面・案件の画面) から開いたとき: 保存のあとその画面に戻る (お客様のご要望 2026-11-25「②」)
  const returnTo = sp.returnTo && sp.returnTo.startsWith("/") && !sp.returnTo.startsWith("//") ? sp.returnTo : undefined;
  const original = doc ? attachmentsOf(db, "document", doc.id)[0] : undefined;
  const warnings = Array.isArray(ex._warnings) ? (ex._warnings as string[]).slice(0, 6) : [];

  /** この画面の場所 (案件・お客様・戻り先を付けたまま。読み取りの前に断られたとき・顧客の登録のあとに戻る) */
  const here = (extra: Record<string, string | undefined> = {}) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries({ customerId: sp.customerId, inquiryId: sp.inquiryId, caseId: caseRoot ? sp.caseId : undefined, category: sp.category, returnTo, ...extra })) if (v) q.set(k, v);
    const s = q.toString();
    return s ? `/quotes/new?${s}` : "/quotes/new";
  };
  const newCustomerHref = `/customers/new?${new URLSearchParams({ ...(exText("customerName") ? { name: exText("customerName") } : {}), ...(exText("furigana") ? { kana: exText("furigana") } : {}), ...(exText("phone") ? { phone: exText("phone") } : {}), ...(exText("siteAddress") ? { address: exText("siteAddress") } : {}), returnTo: here({ documentId: doc?.id }) })}`;
  const back = returnTo
    ? { href: returnTo, label: returnTo.startsWith("/schedule") ? "予定表に戻る" : "元の画面に戻る" }
    : inquiry
      ? { href: `/inquiries/${inquiry.id}`, label: "問い合わせに戻る" }
      : caseRoot
        ? { href: caseHref(caseRoot), label: "案件に戻る" }
        : { href: "/quotes", label: "見積一覧" };
  const contextStoreName = contextStore ? db.stores.find((s) => s.id === contextStore)?.name : undefined;
  const caseNumber = caseRoot && !inquiry ? (caseSummary(db, caseRoot, toDateKey(new Date()), caseMap)?.number ?? caseRoot) : undefined;

  const form = (
    <Card>
      {choices.searchable && (
        <CustomerSearch total={choices.total} q={sp.cq} shown={customers.filter((c) => c.id !== customerId).length} keep={{ customerId: sp.customerId, inquiryId: sp.inquiryId, caseId: caseRoot ? sp.caseId : undefined, documentId: sp.documentId, category: sp.category, returnTo: sp.returnTo }} />
      )}
      <form action={createQuote} className="space-y-5">
        {inquiry && <input type="hidden" name="inquiryId" value={inquiry.id} />}
        {caseRoot && <input type="hidden" name="caseId" value={caseRoot} />}
        {returnTo && <input type="hidden" name="returnTo" value={returnTo} />}
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
          <Field label="店舗" hint={contextStoreName ? `${inquiry ? "問い合わせ" : "案件"}の店舗 (${contextStoreName}) を入れています` : undefined}>
            <Select name="storeId" defaultValue={allStores ? (contextStore ?? customer?.storeId ?? "") : (contextStore ?? user.storeId)} disabled={!allStores}>
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
            <Input name="siteAddress" defaultValue={exText("siteAddress") && exText("siteAddress") !== customer?.address ? exText("siteAddress") : inquiry?.siteAddress || undefined} placeholder={customer?.address ? `空欄 = ${customer.address}` : "熊本県…"} />
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
          <LinkButton href={back.href} variant="secondary">キャンセル</LinkButton>
          <Button type="submit" name="intent" value="draft" variant="secondary">下書き保存</Button>
          <Button type="submit" name="intent" value="submit">{own ? "確定 (承認不要)" : "承認を申請"}</Button>
        </FormActions>
      </form>
    </Card>
  );

  // 手書きの見積書の撮影 (予定表の小さな画面と同じ読み取り = captureCaseQuote。読み取った明細を入れてこの画面を開き直す)
  const photo = (
    <Card>
      <CardHeader title="手書きの見積書を撮影して AI で読み取る" description="スマートフォン・タブレットは端末のカメラ、パソコンは Web カメラ・書画カメラで撮影するか、写真・PDF を選びます" />
      <CaptureUploader
        action={captureCaseQuote}
        defaultKind="handwritten_quote"
        fixedKind
        hideStore
        stores={[]}
        defaultStoreId={contextStore ?? customer?.storeId ?? user.storeId}
        canChooseStore={false}
        aiEnabled={aiEnabled()}
        zoneFirst
        hidden={Object.fromEntries(Object.entries({ inquiryId: inquiry?.id, customerId: customerId || undefined, caseId: caseRoot, returnTo, back: here({ method: "photo" }) }).filter((e): e is [string, string] => Boolean(e[1])))}
        labels={{
          submit: "撮影した見積書を AI で読み取る",
          pending: "AI が読み取り中… (20〜60 秒)",
          sample: "サンプル画像で読み取りを試す",
          drop: "手書きの見積書を撮影するか、写真・PDF を選んでください",
          dropNote: "見積書の全体が入るように、真上から明るい所で撮影してください",
          note: "AI が品名・数量・単価・お客様・引取日時などを読み取り、この画面の見積の欄に入れて開き直します。読み取れない行も省かずに空の行 (黄色) として残すので、写真と見比べて直してから保存してください。",
        }}
      />
    </Card>
  );

  return (
    <div className="max-w-5xl">
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader title="見積を作成" back={back} />
      {sp.caseId && !caseRoot && <Note tone="warn">指定された案件が見つかりません。お客様を選んで見積を作成してください。</Note>}
      {(inquiry || caseRoot) && (
        <p className="mb-3 rounded-xl border border-accent/30 bg-accent-soft/40 px-3 py-2 text-xs leading-relaxed text-ink" data-testid="quote-context">
          {inquiry ? <>問い合わせ <span className="font-mono">{inquiry.number}</span></> : <>案件 <span className="font-mono">{caseNumber}</span></>} の見積を作ります。
          {[customer ? `お客様 (${customer.name} 様)` : "", contextStoreName ? `店舗 (${contextStoreName})` : "", inquiry?.media ? `媒体 (${mediaLabel(inquiry.media)})` : ""].filter(Boolean).join("・")}
          {customer || contextStoreName ? `は${inquiry ? "問い合わせ" : "案件"}から引き継ぐので、入力し直す必要はありません (変えるときは下の欄で)。` : ""}
        </p>
      )}
      {doc && (original || warnings.length > 0) && (
        <div className="mb-3 grid grid-cols-1 gap-3 rounded-2xl border border-line bg-panel p-3 @xl:grid-cols-[10rem_minmax(0,1fr)]" data-testid="quote-doc-original">
          {original ? (
            original.kind === "photo" ? (
              <a href={`/api/attachments/${original.id}`} target="_blank" rel="noopener" className="block overflow-hidden rounded-lg border border-line bg-subtle" title="押すと元の大きさで開きます">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/api/attachments/${original.id}${original.thumbKey ? "?size=thumb" : ""}`} alt="撮影した見積書" className="max-h-56 w-full object-contain" />
              </a>
            ) : (
              <a href={`/api/attachments/${original.id}`} target="_blank" rel="noopener" className="flex h-24 items-center justify-center rounded-lg border border-line bg-subtle text-xs text-accent hover:underline">
                元の書類 (PDF) を開く
              </a>
            )
          ) : (
            <span />
          )}
          <div className="min-w-0 space-y-1 text-xs">
            <p className="font-medium text-ink">撮影した見積書「{doc.fileName}」の読み取り結果を下に入れています。写真と見比べて確かめてください。黄色の行は読み取りに自信がない行・品名が読めなかった行です。行と行の間に入れるときは各行の「上に挿入」「下に挿入」を使います。</p>
            {warnings.map((w, i) => (
              <p key={i} className="text-warn-ink">
                ⚠ {w}
              </p>
            ))}
            <a href={`/capture?doc=${doc.id}`} className="inline-flex text-accent hover:underline">
              読み取りの確認の画面で直す・読み直す
            </a>
          </div>
        </div>
      )}
      <Note tone="accent">
        合計 {approvalSettings(db).quoteAdminThreshold.toLocaleString("ja-JP")} 円未満は店長承認、以上は管理者承認が必要です (本部の案件・店長の申請・承認できる店長がいない店舗は管理者)。「承認を申請」すると承認者に通知され、承認後にお客様へ送付できます。
        {doc && <> この見積は取込書類「{doc.fileName}」の読取結果を初期値にしています (品名は商品マスタに対応づけ、単価が読み取れない行はマスタの単価)。内容を確認・修正してください。</>}
      </Note>
      {customer?.tradeStopped && (
        <Note tone="warn">
          {customer.name} 様は<strong>取引停止</strong>のお客様です{customer.tradeStopNote ? ` (理由: ${customer.tradeStopNote})` : ""}。見積を作る前に店長・管理者に確認してください。
        </Note>
      )}
      <div className="mt-4">{doc ? form : <QuoteStartChoice initial={sp.method === "photo" ? "photo" : "manual"} photo={photo} manual={form} />}</div>
    </div>
  );
}
