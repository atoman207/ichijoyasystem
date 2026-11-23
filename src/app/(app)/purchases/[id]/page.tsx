import Link from "@/components/ui/Link";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canPay, canRegisterPurchase, canViewPurchase, skipsApproval } from "@/lib/auth/permissions";
import { canEditMgmt } from "@/lib/mgmt/access";
import { userName } from "@/lib/db/queries";
import { deletePurchase, markPurchasePaid, reschedulePurchase, submitPurchase } from "@/lib/actions/purchases";
import { fmtDate, fmtDateTime, toDateKey, yen } from "@/lib/format";
import { PURCHASE_PAY_METHOD_LABEL, PURCHASE_STATUS, SUPPLIER_KIND_LABEL } from "@/lib/constants";
import { payDateOf, supplierKindOf, termsLabel } from "@/lib/suppliers";
import { Badge, Button, Card, CardHeader, Dl, Field, Flash, Input, LinkButton, Note, PageHeader, Select, StatusBadge, StoreTag } from "@/components/ui";
import { AttachmentsCard } from "@/components/attachments/AttachmentsCard";
import { ApprovalDecision, ApprovalHistoryCard, HistoryCard, RecordStamp } from "@/components/features/History";

export default async function PurchaseDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string; err?: string }> }) {
  const { id } = await params;
  const { msg, err } = await searchParams;
  const user = await requireUser();
  /** 管理者 (社長) の申請は承認を省略して、そのまま反映される (permissions.ts の skipsApproval) */
  const own = skipsApproval(user);
  const db = getDb();
  const p = db.purchases.find((x) => x.id === id);
  if (!p) notFound();
  if (!canViewPurchase(user, p)) redirect("/purchases?err=" + encodeURIComponent("この仕入請求書を閲覧する権限がありません。"));
  const supplier = db.suppliers.find((s) => s.id === p.supplierId);
  const approvals = db.approvals.filter((a) => a.targetId === p.id && a.type === "purchase");
  const pending = approvals.find((a) => a.status === "pending");
  const lastDecision = approvals.filter((a) => a.status === "returned" || a.status === "rejected").sort((a, b) => (b.decidedAt ?? "").localeCompare(a.decidedAt ?? ""))[0];
  const doc = db.documents.find((d) => d.id === p.documentId);
  const order = p.orderId ? db.orders.find((o) => o.id === p.orderId) : undefined;
  const cash = db.cashEntries.find((c) => c.source === "purchase" && c.sourceId === p.id);
  const returnTo = `/purchases/${id}`;
  const editable = (p.status === "received" || p.status === "disputed") && canRegisterPurchase(user);
  const today = toDateKey(new Date());

  return (
    <div className="max-w-5xl">
      <Flash msg={msg} err={err} />
      <PageHeader
        title={`${p.number} ${supplier?.name ?? ""}`}
        badge={<><StatusBadge value={p.status} map={PURCHASE_STATUS} />{p.source === "ocr" && <Badge tone="accent" dot={false}>請求書取込</Badge>}</>}
        description={<span className="inline-flex flex-wrap items-center gap-2"><StoreTag store={db.stores.find((s) => s.id === p.storeId)} /> · 請求日 {fmtDate(p.invoiceDate)} · 支払予定日 {fmtDate(payDateOf(p))} · 登録 {userName(p.registeredBy)}</span>}
        back={{ href: "/purchases", label: "仕入・買掛一覧" }}
      />
      {canEditMgmt(user) && (
        <p className="mb-3 text-sm">
          <a className="text-accent hover:underline" href={`/management?tab=purchases&purchase=${p.id}#lines`}>
            管理会計: 明細の振り分け (店舗・案件・品目・費用区分){db.purchaseLineAllocs.some((a) => a.purchaseId === p.id) ? ` — 確定 ${db.purchaseLineAllocs.filter((a) => a.purchaseId === p.id && a.status === "confirmed").length}/${db.purchaseLineAllocs.filter((a) => a.purchaseId === p.id).length}` : " — 未判定"}
          </a>
        </p>
      )}
      {pending && (
        <Card className="mb-4 border-warn/40 bg-warn-soft/40">
          <CardHeader title="支払依頼 (管理者の承認待ち)" description={`申請 ${userName(pending.requestedBy)} ${fmtDateTime(pending.createdAt)}${pending.requestComment ? ` · ${pending.requestComment}` : ""}`} />
          <ApprovalDecision approval={pending} user={user} returnTo={returnTo} approveLabel="支払を承認する" waitingText="管理者の承認を待っています。" />
        </Card>
      )}
      {!pending && p.status === "disputed" && lastDecision && <Note tone="warn">支払依頼が差し戻されました ({userName(lastDecision.decidedBy)}): {lastDecision.decisionComment ?? "理由の記入なし"}。仕入先に確認し、修正して再申請してください。</Note>}
      {!pending && p.status === "rejected" && lastDecision && <Note tone="warn">支払依頼は却下されました ({userName(lastDecision.decidedBy)}): {lastDecision.decisionComment ?? "理由の記入なし"}。</Note>}
      <div className="mt-4 grid grid-cols-1 gap-4 @3xl:grid-cols-3">
        <div className="space-y-4 @3xl:col-span-2">
          <Card>
            <CardHeader title="請求内容" />
            <Dl
              columns={2}
              items={[
                ["仕入先", supplier ? <Link key="s" href={`/suppliers/${supplier.id}`} className="text-accent hover:underline">{supplier.name}</Link> : "-"],
                ["区分", `${SUPPLIER_KIND_LABEL[supplierKindOf(supplier)]} · ${supplier?.category ?? "-"}`],
                ["支払条件", termsLabel(supplier)],
                ["仕入先の請求書番号", p.supplierInvoiceNo ?? "-"],
                ["金額 (税込)", <span key="a" className="text-lg font-semibold">{yen(p.amount)}</span>],
                ["うち消費税", yen(p.taxAmount)],
                ["勘定科目", p.account ?? "仕入高"],
                ["案件", order ? <Link key="o" href={`/orders/${order.id}`} className="text-accent hover:underline">{order.number} {order.title}</Link> : "-"],
                ["支払期限", fmtDate(p.dueDate)],
                ["支払予定日", <span key="pd" className={p.status !== "paid" && payDateOf(p) < today ? "font-medium text-critical" : ""}>{fmtDate(payDateOf(p))}</span>],
                ["摘要", p.description || "-"],
                ["支払", p.paidAt ? `${fmtDate(p.paidAt)} · ${PURCHASE_PAY_METHOD_LABEL[p.payMethod ?? "transfer"]}${p.payReference ? ` · ${p.payReference}` : ""} (${userName(p.paidBy)})` : "-"],
                ["承認者", userName(p.approvedBy)],
                ["現金出納帳", cash ? <Link key="c" href={`/cashbook?store=${cash.storeId}&month=${cash.date.slice(0, 7)}`} className="text-accent hover:underline">{cash.number} に記帳</Link> : "-"],
              ]}
            />
            {p.items && p.items.length > 0 && (
              <table className="mt-4 w-full text-sm">
                <thead><tr className="bg-subtle text-xs text-ink-2"><th className="px-3 py-1.5 text-left font-medium">品名</th><th className="px-3 py-1.5 text-right font-medium">数量</th><th className="px-3 py-1.5 text-right font-medium">単価</th><th className="px-3 py-1.5 text-right font-medium">金額 (税込)</th></tr></thead>
                <tbody>
                  {p.items.map((i) => (
                    <tr key={i.id} className="border-t border-line"><td className="px-3 py-1.5">{i.name}{i.spec ? <span className="ml-1 text-xs text-ink-3">{i.spec}</span> : null}</td><td className="px-3 py-1.5 text-right tnum">{i.qty} {i.unit}</td><td className="px-3 py-1.5 text-right tnum">{yen(i.unitPrice)}</td><td className="px-3 py-1.5 text-right tnum">{yen(i.amount)}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="mt-3"><RecordStamp db={db} targets={[{ entity: "purchase", id: p.id }]} created={{ by: p.registeredBy, at: p.createdAt }} approved={p.approvedBy ? [{ by: p.approvedBy }] : []} /></div>
            {doc && (
              <div className="mt-4 rounded-lg border border-line bg-subtle p-3 text-xs">
                <div className="font-medium text-ink">取込書類: {doc.fileName}</div>
                <div className="text-ink-3">AI 読取確度 {Math.round((doc.confidence ?? 0) * 100)}% · <Link href={`/capture?doc=${doc.id}`} className="text-accent hover:underline">書類取込で見る</Link></div>
              </div>
            )}
            <div className="mt-5 flex flex-wrap items-end gap-2 border-t border-line pt-4">
              {editable && <LinkButton href={`/purchases/${p.id}/edit`} variant="secondary">修正する</LinkButton>}
              {editable && (
                <form action={submitPurchase.bind(null, p.id)} className="flex flex-wrap items-end gap-2">
                  <Field label="依頼のコメント (任意)"><Input name="comment" placeholder="例: 月末に振込をお願いします" /></Field>
                  <Button type="submit">{own ? "支払を承認済みにする (承認不要)" : p.status === "disputed" ? "再度支払依頼する" : "支払依頼する (管理者の承認へ)"}</Button>
                </form>
              )}
              {["received", "disputed", "rejected"].includes(p.status) && (p.registeredBy === user.id || canPay(user)) && <form action={deletePurchase.bind(null, p.id)}><Button type="submit" variant="danger">削除</Button></form>}
              {p.status === "approved" && !canPay(user) && <p className="text-sm text-ink-2">支払の承認済み。本部が支払予定日に支払います。</p>}
              {p.status === "paid" && <p className="text-sm text-good-ink">支払完了 ({fmtDate(p.paidAt)})</p>}
            </div>
          </Card>
          {p.status === "approved" && canPay(user) && (
            <Card>
              <CardHeader title="支払完了の登録" description="支払った日・方法・振込の記録を残します。現金で払ったときは店舗の現金出納帳に出金として記帳します" />
              <form action={markPurchasePaid.bind(null, p.id)} className="grid grid-cols-1 gap-3 @xl:grid-cols-4">
                <Field label="支払日"><Input type="date" name="paidAt" defaultValue={today} /></Field>
                <Field label="支払方法">
                  <Select name="payMethod" defaultValue={db.suppliers.find((x) => x.id === p.supplierId)?.payMethod ?? "transfer"}>
                    {(Object.keys(PURCHASE_PAY_METHOD_LABEL) as (keyof typeof PURCHASE_PAY_METHOD_LABEL)[]).map((m) => <option key={m} value={m}>{PURCHASE_PAY_METHOD_LABEL[m]}</option>)}
                  </Select>
                </Field>
                <Field label="記録 (任意)" className="@xl:col-span-2"><Input name="payReference" placeholder="例: 肥後銀行から振込 / 振込手数料 当方負担" /></Field>
                <div className="@xl:col-span-4"><Button type="submit">支払完了にする ({yen(p.amount)})</Button></div>
              </form>
            </Card>
          )}
          {(p.status === "approved" || p.status === "pending_approval" || p.status === "received") && canPay(user) && (
            <Card>
              <CardHeader title="支払予定日の変更" description="資金繰りに合わせて支払う日を変えられます (支払期限は変わりません)" />
              <form action={reschedulePurchase.bind(null, p.id)} className="flex flex-wrap items-end gap-2">
                <Field label="支払予定日"><Input type="date" name="scheduledPayDate" defaultValue={payDateOf(p)} required /></Field>
                <Button type="submit" variant="secondary">変更する</Button>
                {payDateOf(p) > p.dueDate && <span className="text-xs text-warn-ink">支払期限 ({fmtDate(p.dueDate)}) より後になっています</span>}
              </form>
            </Card>
          )}
          <AttachmentsCard db={db} user={user} parent={{ type: "purchase", id: p.id }} returnTo={returnTo} title="請求書の原本" description="仕入先の請求書 (紙・PDF) を登録できます (書類取込で読み取った元の画像もここに表示されます)" />
        </div>
        <div className="space-y-4">
          <ApprovalHistoryCard approvals={approvals} title="支払依頼・承認の履歴" />
          <HistoryCard db={db} user={user} targets={[{ entity: "purchase", id: p.id }]} />
        </div>
      </div>
    </div>
  );
}
