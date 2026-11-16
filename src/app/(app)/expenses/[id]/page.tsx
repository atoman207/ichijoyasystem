import Link from "@/components/ui/Link";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canAccessStore, canPay, canViewExpense } from "@/lib/auth/permissions";
import { userName } from "@/lib/db/queries";
import { deleteExpense, markExpensePaid, submitExpense } from "@/lib/actions/expenses";
import { fmtDate, fmtDateTime, toDateKey, yen } from "@/lib/format";
import { EXPENSE_METHOD_LABEL, EXPENSE_STATUS } from "@/lib/constants";
import { Badge, Button, Card, CardHeader, Dl, Field, Flash, Input, LinkButton, Note, PageHeader, StatusBadge, StoreTag } from "@/components/ui";
import { AttachmentsCard } from "@/components/attachments/AttachmentsCard";
import { ApprovalDecision, ApprovalHistoryCard, HistoryCard, RecordStamp } from "@/components/features/History";
import { AiSummary } from "@/components/features/AiSummary";

export default async function ExpenseDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string; err?: string }> }) {
  const { id } = await params;
  const { msg, err } = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const e = db.expenses.find((x) => x.id === id);
  if (!e) notFound();
  if (!canAccessStore(user, e.storeId) || !canViewExpense(user, e)) redirect("/expenses?err=" + encodeURIComponent("この経費を閲覧する権限がありません。"));
  const approvals = db.approvals.filter((a) => a.targetId === e.id && a.type === "expense");
  const pending = approvals.find((a) => a.status === "pending");
  const lastDecision = approvals.filter((a) => a.status === "returned" || a.status === "rejected").sort((a, b) => (b.decidedAt ?? "").localeCompare(a.decidedAt ?? ""))[0];
  const doc = db.documents.find((d) => d.id === e.documentId);
  const cash = db.cashEntries.find((c) => c.source === "expense" && c.sourceId === e.id);
  const returnTo = `/expenses/${id}`;
  const editable = (e.status === "draft" || e.status === "rejected") && canViewExpense(user, e);

  return (
    <div className="max-w-4xl">
      <Flash msg={msg} err={err} />
      <PageHeader title={`${e.number} ${e.vendor}`} badge={<><StatusBadge value={e.status} map={EXPENSE_STATUS} />{e.source === "ocr" && <Badge tone="accent" dot={false}>レシート取込</Badge>}</>} description={<span className="inline-flex flex-wrap items-center gap-2">{fmtDate(e.date)} · {e.account} · <StoreTag store={db.stores.find((s) => s.id === e.storeId)} /> · 申請者 {userName(e.submittedBy)}</span>} back={{ href: "/expenses", label: "経費一覧" }} />

      {pending && (
        <Card className="mb-4 border-warn/40 bg-warn-soft/40">
          <CardHeader title="承認待ち" description={`${pending.requiredRole === "admin" ? "管理者" : "店長"}の承認が必要 · 申請 ${fmtDateTime(pending.createdAt)}`} />
          <ApprovalDecision approval={pending} user={user} returnTo={returnTo} waitingText="承認者の確認を待っています。" />
        </Card>
      )}
      {!pending && e.status === "rejected" && lastDecision && <Note tone="warn">差し戻されました ({userName(lastDecision.decidedBy)}): {lastDecision.decisionComment ?? "理由の記入なし"}。内容を修正して再申請してください。</Note>}
      {!pending && e.status === "denied" && lastDecision && <Note tone="warn">却下されました ({userName(lastDecision.decidedBy)}): {lastDecision.decisionComment ?? "理由の記入なし"}。この経費は精算しません。</Note>}

      <div className="mt-4 grid grid-cols-1 gap-4 @2xl:grid-cols-3">
        <div className="space-y-4 @2xl:col-span-2">
          <Card>
            <CardHeader title="内容" />
            <Dl columns={2} items={[["支払先", e.vendor], ["日付", fmtDate(e.date)], ["金額 (税込)", <span key="a" className="text-lg font-semibold">{yen(e.amount)}</span>], ["うち消費税", yen(e.taxAmount)], ["勘定科目", e.account], ["支払方法", EXPENSE_METHOD_LABEL[e.paymentMethod]], ["内容・用途", e.description || "-"], ["承認者", e.approvedBy ? `${userName(e.approvedBy)} (${fmtDateTime(e.approvedAt)})` : "-"], ["精算", e.paidAt ? `${fmtDate(e.paidAt)} (${userName(e.paidBy)})` : "-"], ["現金出納帳", cash ? <Link key="c" href={`/cashbook?store=${cash.storeId}&month=${cash.date.slice(0, 7)}`} className="text-accent hover:underline">{cash.number} に記帳</Link> : "-"]]} />
            <div className="mt-3"><RecordStamp db={db} targets={[{ entity: "expense", id: e.id }]} created={{ by: e.submittedBy, at: e.createdAt }} approved={e.approvedBy ? [{ by: e.approvedBy, at: e.approvedAt }] : []} /></div>
            {doc && (
              <div className="mt-4 rounded-lg border border-line bg-subtle p-3 text-xs">
                <div className="font-medium text-ink">取込書類: {doc.fileName}</div>
                <div className="text-ink-3">AI 読取確度 {Math.round((doc.confidence ?? 0) * 100)}% · 取込 {userName(doc.uploadedBy)} {fmtDateTime(doc.uploadedAt)} · <Link href={`/capture?doc=${doc.id}`} className="text-accent hover:underline">書類取込で見る</Link></div>
              </div>
            )}
            <div className="mt-5 flex flex-wrap items-end gap-2 border-t border-line pt-4">
              {editable && <LinkButton href={`/expenses/${e.id}/edit`} variant="secondary">修正する</LinkButton>}
              {editable && <form action={submitExpense.bind(null, e.id)}><Button type="submit">{e.status === "rejected" ? "再申請する" : "承認を申請する"}</Button></form>}
              {(editable || (e.status === "denied" && canViewExpense(user, e))) && <form action={deleteExpense.bind(null, e.id)}><Button type="submit" variant="danger">削除</Button></form>}
              {e.status === "approved" && canPay(user) && (
                <form action={markExpensePaid.bind(null, e.id)} className="flex flex-wrap items-end gap-2">
                  <Field label="精算日"><Input type="date" name="paidAt" defaultValue={toDateKey(new Date())} /></Field>
                  <Button type="submit">精算済みにする</Button>
                  {e.paymentMethod === "cash" && <span className="text-[11px] text-ink-3">現金の経費は現金出納帳に出金として記帳します</span>}
                </form>
              )}
              {e.status === "approved" && !canPay(user) && <p className="text-sm text-ink-2">承認済み。本部で精算処理を行います。</p>}
            </div>
          </Card>
          <AttachmentsCard db={db} user={user} parent={{ type: "expense", id: e.id }} returnTo={returnTo} title="レシート・領収書" description="レシートや領収書の写真を登録できます (書類取込で読み取った元の画像もここに表示されます)" />
        </div>
        <div className="space-y-4">
          <AiSummary kind="expense" id={e.id} />
          <ApprovalHistoryCard approvals={approvals} />
          <HistoryCard db={db} user={user} targets={[{ entity: "expense", id: e.id }]} />
        </div>
      </div>
    </div>
  );
}
