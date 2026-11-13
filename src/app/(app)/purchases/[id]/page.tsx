import Link from "@/components/ui/Link";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canApprove, canManageFinance } from "@/lib/auth/permissions";
import { userName } from "@/lib/db/queries";
import { markPurchasePaid, submitPurchase } from "@/lib/actions/purchases";
import { decideApproval } from "@/lib/actions/approvals";
import { fmtDate, fmtDateTime, toDateKey, yen } from "@/lib/format";
import { APPROVAL_STATUS, PURCHASE_STATUS } from "@/lib/constants";
import { Badge, Button, Card, CardHeader, Dl, Field, Flash, Input, PageHeader, StatusBadge } from "@/components/ui";
import { AttachmentsCard } from "@/components/attachments/AttachmentsCard";

export default async function PurchaseDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string; err?: string }> }) {
  const { id } = await params;
  const { msg, err } = await searchParams;
  const user = await requireUser();
  if (!canManageFinance(user)) redirect("/?err=" + encodeURIComponent("仕入・買掛は本部・管理者のみ閲覧できます。"));
  const db = getDb();
  const p = db.purchases.find((x) => x.id === id);
  if (!p) notFound();
  const supplier = db.suppliers.find((s) => s.id === p.supplierId);
  const approvals = db.approvals.filter((a) => a.targetId === p.id);
  const pending = approvals.find((a) => a.status === "pending");
  const canDecide = pending ? canApprove(user, pending) : false;
  const doc = db.documents.find((d) => d.id === p.documentId);
  const returnTo = `/purchases/${id}`;

  return (
    <div className="max-w-4xl">
      <Flash msg={msg} err={err} />
      <PageHeader title={`${p.number} ${supplier?.name}`} badge={<><StatusBadge value={p.status} map={PURCHASE_STATUS} />{p.source === "ocr" && <Badge tone="accent" dot={false}>請求書取込</Badge>}</>} description={`請求日 ${fmtDate(p.invoiceDate)} · 支払期限 ${fmtDate(p.dueDate)} · 登録 ${userName(p.registeredBy)}`} back={{ href: "/purchases", label: "仕入・買掛一覧" }} />
      {pending && (
        <Card className="mb-4 border-warn/40 bg-warn-soft/40">
          <CardHeader title="支払承認待ち (管理者)" description={pending.requestComment} />
          {canDecide ? (
            <form className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="returnTo" value={returnTo} />
              <Field label="コメント (任意)" className="w-full @xl:w-80"><Input name="comment" /></Field>
              <Button type="submit" formAction={decideApproval.bind(null, pending.id, "approved")}>支払を承認する</Button>
              <Button type="submit" variant="danger" formAction={decideApproval.bind(null, pending.id, "rejected")}>照会中にする</Button>
            </form>
          ) : (
            <p className="text-sm text-ink-2">管理者の承認を待っています。</p>
          )}
        </Card>
      )}
      <div className="grid grid-cols-1 gap-4 @2xl:grid-cols-3">
        <div className="space-y-4 @2xl:col-span-2">
        <Card>
          <CardHeader title="請求内容" />
          <Dl columns={2} items={[["仕入先", supplier?.name], ["区分", supplier?.category], ["支払条件", supplier?.paymentTerms], ["金額 (税込)", <span key="a" className="text-lg font-semibold">{yen(p.amount)}</span>], ["うち消費税", yen(p.taxAmount)], ["内容", p.description], ["支払日", p.paidAt ? fmtDate(p.paidAt) : "-"], ["承認者", userName(p.approvedBy)]]} />
          {doc && (
            <div className="mt-4 rounded-lg border border-line bg-subtle p-3 text-xs">
              <div className="font-medium text-ink">取込書類: {doc.fileName}</div>
              <div className="text-ink-3">AI 読取確度 {Math.round((doc.confidence ?? 0) * 100)}% · <Link href={`/capture?doc=${doc.id}`} className="text-accent hover:underline">書類取込で見る</Link></div>
            </div>
          )}
          <div className="mt-5 border-t border-line pt-4">
            {(p.status === "received" || p.status === "disputed") && (
              <form action={submitPurchase.bind(null, p.id)}><Button type="submit">管理者へ支払承認を申請</Button></form>
            )}
            {p.status === "approved" && (
              <form action={markPurchasePaid.bind(null, p.id)} className="flex flex-wrap items-end gap-2">
                <Field label="支払日"><Input type="date" name="paidAt" defaultValue={toDateKey(new Date())} /></Field>
                <Button type="submit">支払済みにする</Button>
              </form>
            )}
            {p.status === "paid" && <p className="text-sm text-good-ink">支払済み ({fmtDate(p.paidAt)})</p>}
          </div>
        </Card>
        <AttachmentsCard db={db} user={user} parent={{ type: "purchase", id: p.id }} returnTo={returnTo} title="請求書の原本" description="仕入先の請求書 (紙・PDF) を登録できます (書類取込で読み取った元の画像もここに表示されます)" />
        </div>
        <div className="space-y-4">
          <Card>
            <CardHeader title="承認履歴" />
            <ul className="space-y-2 text-xs">
              {approvals.map((a) => <li key={a.id} className="rounded-lg border border-line p-2"><div className="flex items-center justify-between"><span>管理者承認</span><StatusBadge value={a.status} map={APPROVAL_STATUS} /></div><div className="mt-1 text-ink-3">申請 {userName(a.requestedBy)} {fmtDateTime(a.createdAt)}{a.decidedBy ? ` · ${userName(a.decidedBy)} ${fmtDateTime(a.decidedAt)}` : ""}</div></li>)}
              {approvals.length === 0 && <li className="text-ink-3">まだ申請されていません</li>}
            </ul>
          </Card>
          <Card>
            <CardHeader title="変更履歴" />
            <ul className="space-y-1.5 text-xs">
              {db.auditLogs.filter((l) => l.entity === "purchase" && l.entityId === p.id).reverse().map((l) => <li key={l.id}><span className="tnum text-ink-3">{fmtDateTime(l.at)}</span> {l.summary} <span className="text-ink-3">({userName(l.userId)})</span></li>)}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
