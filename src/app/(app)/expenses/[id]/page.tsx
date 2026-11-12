import Link from "@/components/ui/Link";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canAccessStore, canApprove, canManageFinance, canViewExpense } from "@/lib/auth/permissions";
import { userName } from "@/lib/db/queries";
import { deleteExpense, markExpensePaid, submitExpense } from "@/lib/actions/expenses";
import { decideApproval } from "@/lib/actions/approvals";
import { fmtDate, fmtDateTime, yen } from "@/lib/format";
import { APPROVAL_STATUS, EXPENSE_METHOD_LABEL, EXPENSE_STATUS } from "@/lib/constants";
import { Badge, Button, Card, CardHeader, Dl, Field, Flash, Input, PageHeader, StatusBadge, StoreTag } from "@/components/ui";

export default async function ExpenseDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string; err?: string }> }) {
  const { id } = await params;
  const { msg, err } = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const e = db.expenses.find((x) => x.id === id);
  if (!e) notFound();
  if (!canAccessStore(user, e.storeId) || !canViewExpense(user, e)) redirect("/expenses?err=" + encodeURIComponent("この経費を閲覧する権限がありません。"));
  const approvals = db.approvals.filter((a) => a.targetId === e.id);
  const pending = approvals.find((a) => a.status === "pending");
  const canDecide = pending ? canApprove(user, pending) : false;
  const doc = db.documents.find((d) => d.id === e.documentId);
  const returnTo = `/expenses/${id}`;

  return (
    <div className="max-w-4xl">
      <Flash msg={msg} err={err} />
      <PageHeader title={`${e.number} ${e.vendor}`} badge={<><StatusBadge value={e.status} map={EXPENSE_STATUS} />{e.source === "ocr" && <Badge tone="accent" dot={false}>レシート取込</Badge>}</>} description={<span className="inline-flex flex-wrap items-center gap-2">{fmtDate(e.date)} · {e.account} · <StoreTag store={db.stores.find((s) => s.id === e.storeId)} /> · 申請者 {userName(e.submittedBy)}</span>} back={{ href: "/expenses", label: "経費一覧" }} />

      {pending && (
        <Card className="mb-4 border-warn/40 bg-warn-soft/40">
          <CardHeader title="承認待ち" description={`${pending.requiredRole === "admin" ? "管理者" : "店長"}の承認が必要 · 申請 ${fmtDateTime(pending.createdAt)}`} />
          {canDecide ? (
            <form className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="returnTo" value={returnTo} />
              <Field label="コメント (任意)" className="w-full @xl:w-80"><Input name="comment" placeholder="例: 領収書確認済み" /></Field>
              <Button type="submit" formAction={decideApproval.bind(null, pending.id, "approved")}>承認する</Button>
              <Button type="submit" variant="danger" formAction={decideApproval.bind(null, pending.id, "rejected")}>差し戻す</Button>
            </form>
          ) : (
            <p className="text-sm text-ink-2">承認者の確認を待っています。</p>
          )}
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 @2xl:grid-cols-3">
        <Card className="@2xl:col-span-2">
          <CardHeader title="内容" />
          <Dl columns={2} items={[["支払先", e.vendor], ["日付", fmtDate(e.date)], ["金額 (税込)", <span key="a" className="text-lg font-semibold">{yen(e.amount)}</span>], ["うち消費税", yen(e.taxAmount)], ["勘定科目", e.account], ["支払方法", EXPENSE_METHOD_LABEL[e.paymentMethod]], ["内容・用途", e.description || "-"], ["承認者", e.approvedBy ? `${userName(e.approvedBy)} (${fmtDateTime(e.approvedAt)})` : "-"]]} />
          {doc && (
            <div className="mt-4 rounded-lg border border-line bg-subtle p-3 text-xs">
              <div className="font-medium text-ink">取込書類: {doc.fileName}</div>
              <div className="text-ink-3">AI 読取確度 {Math.round((doc.confidence ?? 0) * 100)}% · 取込 {userName(doc.uploadedBy)} {fmtDateTime(doc.uploadedAt)} · <Link href={`/capture?doc=${doc.id}`} className="text-accent hover:underline">書類取込で見る</Link></div>
            </div>
          )}
          <form className="mt-5 flex flex-wrap gap-2 border-t border-line pt-4">
            {(e.status === "draft" || e.status === "rejected") && <Button type="submit" formAction={submitExpense.bind(null, e.id)}>承認を申請する</Button>}
            {(e.status === "draft" || e.status === "rejected") && <Button type="submit" variant="danger" formAction={deleteExpense.bind(null, e.id)}>削除</Button>}
            {e.status === "approved" && canManageFinance(user) && <Button type="submit" formAction={markExpensePaid.bind(null, e.id)}>精算済みにする</Button>}
            {e.status === "approved" && !canManageFinance(user) && <p className="text-sm text-ink-2">承認済み。本部で精算処理を行います。</p>}
          </form>
        </Card>
        <div className="space-y-4">
          <Card>
            <CardHeader title="承認履歴" />
            <ul className="space-y-2 text-xs">
              {approvals.map((a) => (
                <li key={a.id} className="rounded-lg border border-line p-2">
                  <div className="flex items-center justify-between"><span>{a.requiredRole === "admin" ? "管理者承認" : "店長承認"}</span><StatusBadge value={a.status} map={APPROVAL_STATUS} /></div>
                  <div className="mt-1 text-ink-3">申請 {fmtDateTime(a.createdAt)}{a.decidedBy ? ` · ${userName(a.decidedBy)} ${fmtDateTime(a.decidedAt)}` : ""}{a.decisionComment ? ` · ${a.decisionComment}` : ""}</div>
                </li>
              ))}
              {approvals.length === 0 && <li className="text-ink-3">まだ申請されていません</li>}
            </ul>
          </Card>
          <Card>
            <CardHeader title="変更履歴" />
            <ul className="space-y-1.5 text-xs">
              {db.auditLogs.filter((l) => l.entity === "expense" && l.entityId === e.id).reverse().map((l) => <li key={l.id}><span className="tnum text-ink-3">{fmtDateTime(l.at)}</span> {l.summary} <span className="text-ink-3">({userName(l.userId)})</span></li>)}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
