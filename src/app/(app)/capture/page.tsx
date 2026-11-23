import Link from "@/components/ui/Link";
import { redirect } from "next/navigation";
import { receptionHref } from "@/lib/reception";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canSeeAllStores, scopeByStore } from "@/lib/auth/permissions";
import { userName } from "@/lib/db/queries";
import { attachDocument, discardDocument, retryExtraction, saveExtraction, uploadDocument } from "@/lib/actions/capture";
import { aiStatus } from "@/lib/ai/provider";
import { attachmentsOf } from "@/lib/attachments";
import { ATTACHABLE_KINDS, REGISTER_TARGETS } from "@/lib/capture-fields";
import { fmtDateTime } from "@/lib/format";
import { DOCUMENT_KIND_LABEL, DOCUMENT_STATUS } from "@/lib/constants";
import type { CapturedDocument, Customer, DocumentKind } from "@/lib/db/types";
import { CaptureUploader } from "@/components/features/CaptureUploader";
import { DocumentReview, type SurveyLinkProps } from "@/components/features/DocumentReview";
import { findOrderByPostcard, findSurveyByPostcard, matchStaff, storeFromPostcard } from "@/lib/survey-link";
import { kpiSettings } from "@/lib/kpi-settings";
import { userCanCreateCustomer } from "@/lib/ops-settings";
import { accuracyStats } from "@/lib/ocr-accuracy";
import { customerHasPhone } from "@/lib/customer-contacts";
import { Badge, Card, CardHeader, Flash, LinkButton, Note, PageHeader, Pager, StatusBadge, StoreTag, paginate } from "@/components/ui";
import { Calculator } from "lucide-react";
import { compareStoreIds } from "@/lib/store-order";

/** AI の読み取り (最大 50 秒) を待つため、Vercel の処理時間の上限を 60 秒にする */
export const maxDuration = 60;

const LINKED: Record<NonNullable<CapturedDocument["linkedType"]>, { path: string; label: string }> = {
  quote: { path: "quotes", label: "見積" },
  expense: { path: "expenses", label: "経費" },
  purchase: { path: "purchases", label: "仕入請求書" },
  order: { path: "orders", label: "受注・施工" },
  inquiry: { path: "inquiries", label: "問い合わせ" },
  customer: { path: "customers", label: "顧客" },
  survey: { path: "kpi/surveys", label: "お客様アンケート" },
};

const PROVIDER_LABEL: Record<string, string> = { claude: "Claude", openai: "OpenAI", mock: "サンプル読取", error: "読取失敗" };

/** お客様名の比較用 (敬称・空白・全角半角の違いを除く) */
const normName = (s: string) => s.normalize("NFKC").replace(/(様|さま|御中|殿)$/g, "").replace(/[\s　]/g, "");

/** 読み取ったお客様名に近い顧客 (完全一致を先に。多すぎるときは候補にしない) */
function customerCandidates(customers: Customer[], raw: unknown, phoneRaw?: unknown): Customer[] {
  // 電話番号が一致するお客様を最優先 (手書き見積書の Tel 欄)
  const digits = typeof phoneRaw === "string" ? phoneRaw.replace(/\D/g, "") : "";
  const byPhone = digits.length >= 9 ? customers.filter((c) => customerHasPhone(c, digits)) : [];
  const name = typeof raw === "string" ? normName(raw) : "";
  if (name.length < 2) return byPhone.slice(0, 12);
  const exact = customers.filter((c) => normName(c.name) === name);
  const partial = customers.filter((c) => normName(c.name) !== name && (normName(c.name).includes(name) || name.includes(normName(c.name))) && normName(c.name).length >= 2);
  const list = [...byPhone, ...exact.filter((c) => !byPhone.includes(c)), ...partial.filter((c) => !byPhone.includes(c))];
  return list.length > 12 && exact.length === 0 && byPhone.length === 0 ? [] : list.slice(0, 12);
}

export default async function CapturePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const ai = aiStatus();
  const allStores = canSeeAllStores(user);
  // 受付メモ (問い合わせの受付) は受付の画面で扱う
  if (sp.doc && db.documents.some((d) => d.id === sp.doc && d.kind === "reception")) redirect(receptionHref(sp.doc));
  const docs = scopeByStore(user, db.documents).filter((d) => d.kind !== "reception").sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  const selected = docs.find((d) => d.id === sp.doc) ?? (sp.doc ? undefined : docs.find((d) => d.status === "extracted" || d.status === "failed"));
  const kind = (sp.kind && DOCUMENT_KIND_LABEL[sp.kind as DocumentKind] ? sp.kind : "handwritten_quote") as DocumentKind;
  const paged = paginate(docs, sp.page, 50);

  const ex = (selected?.extracted ?? {}) as Record<string, unknown>;
  const warnings = Array.isArray(ex._warnings) ? (ex._warnings as string[]) : [];
  const edited = ex._edited as { by?: string; at?: string } | undefined;
  const calcCheck = ex._calcCheck as { checked?: number; issues?: string[] } | undefined;
  const providerText = selected ? `${PROVIDER_LABEL[String(ex._provider)] ?? "読取"}${ex._model ? ` (${ex._model})` : ""}` : "";
  const editable = Boolean(selected && (selected.status === "extracted" || selected.status === "failed" || selected.status === "uploaded"));
  const original = selected ? attachmentsOf(db, "document", selected.id)[0] : undefined;
  const linked = selected?.linkedType && selected.linkedId ? { ...LINKED[selected.linkedType], href: `/${LINKED[selected.linkedType].path}/${selected.linkedId}` } : undefined;
  // 手書き見積書を「確定して保存」「案件に保存 (顧客・問い合わせ)」しただけで、まだ見積になっていないもの → 見積の作成へ
  const quoteFromConfirmed =
    selected && selected.status === "confirmed" && selected.kind === "handwritten_quote" && (!selected.linkedId || selected.linkedType === "customer" || selected.linkedType === "inquiry")
      ? `/quotes/new?${new URLSearchParams({
          documentId: selected.id,
          ...(selected.linkedType === "customer" && selected.linkedId ? { customerId: selected.linkedId } : {}),
          ...(selected.linkedType === "inquiry" && selected.linkedId ? { inquiryId: selected.linkedId } : {}),
        })}`
      : undefined;

  // 確認画面に渡す候補 (見積のお客様・案件の保存先)
  const scopedCustomers = selected && editable ? scopeByStore(user, db.customers) : [];
  const candidates = selected && editable ? customerCandidates(scopedCustomers, ex.customerName ?? ex.siteName, ex.phone) : [];
  const exs = (k: string) => (typeof ex[k] === "string" ? (ex[k] as string) : "");
  const newCustomerHref =
    selected && editable && selected.kind === "handwritten_quote" && candidates.length === 0 && userCanCreateCustomer(db, user)
      ? `/customers/new?${new URLSearchParams({ ...(exs("customerName") ? { name: exs("customerName") } : {}), ...(exs("furigana") ? { kana: exs("furigana") } : {}), ...(exs("phone") ? { phone: exs("phone") } : {}), ...(exs("siteAddress") ? { address: exs("siteAddress") } : {}), returnTo: `/capture?doc=${selected.id}` })}`
      : undefined;
  const accuracy = accuracyStats(docs);
  const customerName = (id: string) => db.customers.find((c) => c.id === id)?.name ?? "";
  const targetOptions: { value: string; label: string }[] = [];
  if (selected && editable && ATTACHABLE_KINDS.includes(selected.kind)) {
    const ids = new Set(candidates.map((c) => c.id));
    const orders = scopeByStore(user, db.orders);
    const forCustomer = orders.filter((o) => ids.has(o.customerId)).sort((a, b) => b.contractDate.localeCompare(a.contractDate)).slice(0, 10);
    const active = orders.filter((o) => ["pending_approval", "returned", "confirmed", "scheduled", "in_progress"].includes(o.status) && !ids.has(o.customerId)).sort((a, b) => (b.scheduledStart ?? b.contractDate).localeCompare(a.scheduledStart ?? a.contractDate)).slice(0, 30);
    for (const o of [...forCustomer, ...active]) targetOptions.push({ value: o.number, label: `受注 ${o.title} / ${customerName(o.customerId)} 様` });
    const inquiries = scopeByStore(user, db.inquiries).filter((i) => ["new", "in_progress", "quoted"].includes(i.status)).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).slice(0, 15);
    for (const i of inquiries) targetOptions.push({ value: i.number, label: `問い合わせ ${i.summary.slice(0, 30)}` });
    for (const c of candidates) targetOptions.push({ value: c.code, label: `顧客 ${c.name}` });
  }
  const productNames = Object.fromEntries(db.products.map((p) => [p.id, p.name]));

  // アンケートはがき: はがき No. で案件を探し、手書きの名前から担当者を候補にする
  let surveyLink: SurveyLinkProps | undefined;
  if (selected && editable && selected.kind === "survey_postcard") {
    const no = ex.postcardNo as string | undefined;
    const answeredOn = ex.answeredOn as string | undefined;
    const order = findOrderByPostcard(db, no, { storeId: storeFromPostcard(no), date: answeredOn });
    const storeId = order?.storeId ?? storeFromPostcard(no) ?? selected.storeId;
    const dup = findSurveyByPostcard(db, no, { storeId, date: answeredOn });
    const sales = matchStaff(db.users, ex.salesName as string | undefined, storeId);
    const craft = matchStaff(db.users, ex.craftsmanName as string | undefined, storeId);
    const delivery = [...new Set([...sales, ...craft])];
    const recent = scopeByStore(user, db.orders)
      .filter((o) => ["completed", "invoiced", "paid"].includes(o.status))
      .sort((a, b) => (b.salesDate ?? b.contractDate).localeCompare(a.salesDate ?? a.contractDate))
      .slice(0, 40);
    const storeShort = (id: string) => db.stores.find((st) => st.id === id)?.shortName ?? "";
    surveyLink = {
      orderRef: order?.number ?? "",
      orderLabel: order ? `${order.number} ${customerName(order.customerId)} 様 · ${order.title} (${storeShort(order.storeId)})` : undefined,
      orderOptions: recent.map((o) => ({ value: o.number, label: `${customerName(o.customerId)} 様 · ${o.title}${o.postcardNo ? ` · ハガキ ${o.postcardNo}` : ""}` })),
      users: db.users
        .filter((u) => u.active)
        .sort((a, b) => (a.storeId === storeId ? -1 : 0) - (b.storeId === storeId ? -1 : 0) || compareStoreIds(a.storeId, b.storeId) || a.kana.localeCompare(b.kana, "ja"))
        .map((u) => ({ id: u.id, label: `${u.name} (${storeShort(u.storeId)})` })),
      salesUserId: sales[0] ?? "",
      deliveryUserIds: delivery.length ? delivery : (order?.workerIds ?? []),
      clerkUserId: kpiSettings(db).clerkByStore[storeId] ?? "",
      duplicate: dup ? `はがき No.${dup.postcardNo} (同じ店舗・1 年以内) のアンケートはすでに登録されています (二重に集計しないよう、登録できません)。` : undefined,
    };
  }

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader
        title="書類取込 (紙 → データ)"
        description="手書き見積・図面・施工資料・請求書・レシートを撮影して読み取り、確認・修正してから登録します"
        badge={<Badge tone={ai.enabled ? "good" : "neutral"}>{ai.enabled ? `AI 読取: ${ai.label}` : "AI 読取: サンプルモード"}</Badge>}
        actions={<LinkButton href="/capture/calc" variant="secondary"><Calculator className="h-4 w-4" /> 見積の金額の計算 (金額を書く前に撮影)</LinkButton>}
      />
      <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-5">
        <Card className="@4xl:col-span-2">
          <CardHeader title="1. 撮影・取込" description="タブレット・スマートフォンのカメラで撮影、または画像/PDF を選択" />
          <CaptureUploader action={uploadDocument} defaultKind={kind} stores={db.stores.map((s) => ({ id: s.id, name: s.name }))} defaultStoreId={user.storeId} canChooseStore={allStores} aiEnabled={ai.enabled} />
        </Card>
        <Card className="@4xl:col-span-3">
          <CardHeader
            title="2. 読取結果の確認・修正 → 登録"
            description={selected ? `${selected.fileName} · ${DOCUMENT_KIND_LABEL[selected.kind]} · ${providerText}${selected.status !== "failed" ? ` · 確度 ${Math.round((selected.confidence ?? 0) * 100)}%` : ""}` : "取込済みの書類を選択してください"}
            action={selected && <StatusBadge value={selected.status} map={DOCUMENT_STATUS} />}
          />
          {!selected && <p className="py-8 text-center text-sm text-ink-3">左の手順で書類を取り込むと、ここに読取結果が表示されます</p>}
          {selected && (
            <div className="space-y-4">
              {selected.status === "failed" && (
                <p role="alert" className="rounded-lg bg-critical-soft px-3 py-2 text-xs text-critical-ink">
                  AI で読み取れませんでした: {String(ex._error ?? "原因不明のエラー")} — 下の欄に手入力して登録するか、「もう一度読み取る」を押してください。
                </p>
              )}
              {calcCheck && !calcCheck.issues?.length && <Note tone="accent">書き写しの確認: {calcCheck.checked} 行の金額と合計が、すべてシステムの計算と一致しています。</Note>}
              {ex._mode === "calc" && <Note tone="accent">「金額を書く前に撮影」した見積書です。金額・合計はシステムの計算です。 <Link href={`/capture/calc?doc=${selected!.id}`} className="font-medium underline">計算の画面を開く</Link></Note>}
              {warnings.length > 0 && selected.status !== "failed" && <Note tone="warn">{warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}</Note>}
              {ex._provider === "mock" && <p className="text-[11px] text-ink-3">AI の API キーが未設定のため、サンプルの読取結果を表示しています。</p>}

              <div className="grid grid-cols-1 gap-4 @3xl:grid-cols-[minmax(0,13rem)_minmax(0,1fr)]">
                <div className="space-y-2">
                  {original ? (
                    original.kind === "photo" ? (
                      <a href={`/api/attachments/${original.id}`} target="_blank" rel="noopener" className="block overflow-hidden rounded-lg border border-line bg-subtle">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={`/api/attachments/${original.id}${original.thumbKey ? "?size=thumb" : ""}`} alt={`元の書類 ${original.fileName}`} className="max-h-72 w-full object-contain" />
                      </a>
                    ) : (
                      <a href={`/api/attachments/${original.id}`} target="_blank" rel="noopener" className="flex h-28 items-center justify-center rounded-lg border border-line bg-subtle text-sm text-accent hover:underline">
                        元の書類 (PDF) を開く
                      </a>
                    )
                  ) : (
                    <div className="flex h-28 items-center justify-center rounded-lg border border-dashed border-line px-3 text-center text-xs text-ink-3">
                      {linked ? "元の画像は登録先の添付ファイルにあります" : ex._sample ? "サンプル (画像なし)" : "元の画像は保存されていません"}
                    </div>
                  )}
                  {original && <p className="text-[11px] text-ink-3">画像を押すと元の大きさで開きます。書類と見比べて確認してください。</p>}
                </div>
                <DocumentReview
                  key={`${selected.id}_${String(ex._readAt ?? "")}_${String(edited?.at ?? "")}`}
                  id={selected.id}
                  kind={selected.kind}
                  initial={ex}
                  editable={editable}
                  registerTargets={REGISTER_TARGETS[selected.kind]}
                  attachable={ATTACHABLE_KINDS.includes(selected.kind)}
                  customerOptions={candidates.map((c) => ({ id: c.id, label: `${c.name} (${c.code})${c.address ? ` ${c.address.slice(0, 24)}` : ""}` }))}
                  targetOptions={targetOptions}
                  productNames={productNames}
                  saveAction={saveExtraction}
                  attachAction={attachDocument}
                  retryAction={retryExtraction}
                  discardAction={discardDocument.bind(null, selected.id)}
                  canRetry={Boolean(original) || Boolean(ex._sample)}
                  survey={surveyLink}
                  newCustomerHref={newCustomerHref}
                  customerHint={selected.kind === "handwritten_quote" && candidates.length === 0 ? (userCanCreateCustomer(db, user) ? "読み取ったお客様に当たる顧客が見つかりません。新しいお客様なら先に顧客を登録してください。" : "読み取ったお客様に当たる顧客が見つかりません。新しいお客様の登録は事務担当に依頼してください (見積の画面で既存の顧客を検索することもできます)。") : undefined}
                  aiEnabled={ai.enabled}
                />
              </div>

              {(linked || quoteFromConfirmed) && (
                <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
                  {quoteFromConfirmed && <LinkButton href={quoteFromConfirmed}>この書類から見積を作成 →</LinkButton>}
                  {linked && <LinkButton href={linked.href} variant="secondary">登録先の{linked.label}を開く →</LinkButton>}
                </div>
              )}
              {quoteFromConfirmed && <p className="text-xs text-warn-ink">この書類はまだ見積になっていません ({linked ? `${linked.label}に添付しただけです` : "読取内容を確定しただけです"})。見積にするときは「この書類から見積を作成」を押し、お客様を選んで保存してください。</p>}
              {selected.status === "confirmed" && !linked && !quoteFromConfirmed && <p className="border-t border-line pt-4 text-sm text-good-ink">確認済みのデータとして保存しています。</p>}
              <p className="text-[11px] text-ink-3">
                取込: {userName(selected.uploadedBy)} · {fmtDateTime(selected.uploadedAt)} · <StoreTag store={db.stores.find((s) => s.id === selected.storeId)} short />
                {edited?.at && <> · 修正: {userName(edited.by ?? "")} {fmtDateTime(edited.at)}</>}
                {typeof ex._ms === "number" && <> · 読取 {Math.round((ex._ms as number) / 100) / 10} 秒</>}
              </p>
            </div>
          )}
        </Card>
      </div>

      {accuracy.docs > 0 && (
        <Card className="mt-4">
          <CardHeader title="手書き見積書の読取の正確さ" description={`登録済み ${accuracy.docs} 枚で、AI の読取と担当者が確認・修正した内容が一致した割合です (筆跡ごとの直しの多さを把握できます)`} />
          <div className="grid grid-cols-2 gap-2 text-xs @xl:grid-cols-4 @4xl:grid-cols-7">
            {[
              ["明細の品名", accuracy.items.name, accuracy.items.checked],
              ["明細の数量", accuracy.items.qty, accuracy.items.checked],
              ["明細の単価", accuracy.items.unitPrice, accuracy.items.checked],
              ["明細の金額", accuracy.items.amount, accuracy.items.checked],
              ...accuracy.fields.map((f) => [f.label, f.matched, f.checked] as [string, number, number]),
            ].map(([label, ok, n]) => (
              <div key={label as string} className="rounded-lg bg-subtle/70 px-3 py-2">
                <div className="text-ink-3">{label}</div>
                <div className="text-base font-semibold tnum">{n ? Math.round(((ok as number) / (n as number)) * 100) : "-"}%</div>
                <div className="text-[10px] text-ink-3 tnum">{ok} / {n}</div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card className="mt-4" padded={false}>
        <div className="px-5 pt-5"><CardHeader title="取込済み書類" description={`${docs.length} 件 · 確認待ち・読取失敗の書類から順に処理してください`} /></div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead><tr className="bg-subtle text-xs text-ink-2"><th className="px-5 py-2 text-left font-medium">取込日時</th><th className="px-3 py-2 text-left font-medium">ファイル</th><th className="px-3 py-2 text-left font-medium">種類</th><th className="px-3 py-2 text-left font-medium">店舗</th><th className="px-3 py-2 text-left font-medium">取込者</th><th className="px-3 py-2 text-right font-medium">確度</th><th className="px-3 py-2 text-left font-medium">状態</th><th className="px-5 py-2 text-left font-medium">登録先</th></tr></thead>
            <tbody>
              {paged.items.map((d) => {
                const l = d.linkedType && d.linkedId ? LINKED[d.linkedType] : undefined;
                return (
                  <tr key={d.id} className={`border-t border-line hover:bg-subtle/70 ${selected?.id === d.id ? "bg-accent-soft/40" : ""}`}>
                    <td className="px-5 py-2 text-xs tnum">{fmtDateTime(d.uploadedAt)}</td>
                    <td className="px-3 py-2"><Link href={d.extracted?._mode === "calc" && d.status === "extracted" ? `/capture/calc?doc=${d.id}` : `/capture?doc=${d.id}`} className="font-medium text-ink hover:text-accent">{d.fileName}</Link></td>
                    <td className="px-3 py-2 text-xs text-ink-2">{DOCUMENT_KIND_LABEL[d.kind]}{d.extracted?._mode === "calc" ? " (金額の計算)" : d.extracted?._calc ? " (計算 → 書き写し済み)" : ""}</td>
                    <td className="px-3 py-2"><StoreTag store={db.stores.find((s) => s.id === d.storeId)} short /></td>
                    <td className="px-3 py-2 text-xs text-ink-2">{userName(d.uploadedBy)}</td>
                    <td className="px-3 py-2 text-right text-xs tnum">{d.status !== "failed" && d.confidence ? `${Math.round(d.confidence * 100)}%` : "-"}</td>
                    <td className="px-3 py-2"><StatusBadge value={d.status} map={DOCUMENT_STATUS} /></td>
                    <td className="px-5 py-2 text-xs">{l ? <Link href={`/${l.path}/${d.linkedId}`} className="text-accent hover:underline">{l.label} →</Link> : <span className="text-ink-3">-</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="px-5 pb-4"><Pager paged={paged} path="/capture" sp={sp} /></div>
      </Card>
      <p className="mt-4 text-[11px] leading-relaxed text-ink-3">
        流れ: 撮影 → AI 読取 (日付・取引先・品名・数量・金額など) → 担当者が確認・修正 → 見積 / 経費 / 仕入請求書として登録、または図面・施工資料を受注・問い合わせ・顧客に保存 → 承認 → 受注・施工・売上・請求・入金へ連動。紙を見ながらの手入力や別帳簿への転記は不要です。
      </p>
    </div>
  );
}
