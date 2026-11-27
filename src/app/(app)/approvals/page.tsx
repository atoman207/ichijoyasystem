import Link from "@/components/ui/Link";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canApprove, canExportAudit, canSeeAllStores } from "@/lib/auth/permissions";
import { userName } from "@/lib/db/queries";
import { fmtDateTime, yen } from "@/lib/format";
import { APPROVAL_STATUS, APPROVAL_TYPE_LABEL } from "@/lib/constants";
import { approvalSettings } from "@/lib/approval-rules";
import { approvalHref } from "@/lib/approval-href";
import type { Approval, ApprovalStatus, ApprovalType, User } from "@/lib/db/types";
import { Badge, Button, Card, Flash, Input, LinkButton, LinkTabs, Note, PageHeader, Pager, Select, StatusBadge, StoreTag, paginate } from "@/components/ui";
import { ApprovalDecision, ChangeList } from "@/components/features/History";

/** 承認の一覧を見られる範囲: 管理者・本部は全件、店長は自店舗と自分の申請、店舗スタッフは自分の申請 */
function visibleTo(user: User, all: Approval[]): Approval[] {
  if (canSeeAllStores(user)) return all;
  if (user.role === "store_manager") return all.filter((a) => a.storeId === user.storeId || a.requestedBy === user.id);
  return all.filter((a) => a.requestedBy === user.id);
}

export default async function ApprovalsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const rules = approvalSettings(db);
  const storeMap = new Map(db.stores.map((s) => [s.id, s]));
  const visible = visibleTo(user, db.approvals);
  const mine = visible.filter((a) => a.status === "pending" && canApprove(user, a));
  const requested = visible.filter((a) => a.status === "pending" && a.requestedBy === user.id);
  const allPending = visible.filter((a) => a.status === "pending");
  const tab = sp.tab ?? (mine.length > 0 ? "mine" : requested.length > 0 ? "requested" : "pending");
  // 履歴の絞り込み
  let history = visible.filter((a) => a.status !== "pending");
  if (sp.type && APPROVAL_TYPE_LABEL[sp.type as ApprovalType]) history = history.filter((a) => a.type === sp.type);
  if (sp.status && APPROVAL_STATUS[sp.status as ApprovalStatus]) history = history.filter((a) => a.status === sp.status);
  if (sp.from) history = history.filter((a) => (a.decidedAt ?? a.createdAt).slice(0, 10) >= sp.from!);
  if (sp.to) history = history.filter((a) => (a.decidedAt ?? a.createdAt).slice(0, 10) <= sp.to!);
  if (sp.requester) history = history.filter((a) => a.requestedBy === sp.requester);
  if (sp.decider) history = history.filter((a) => a.decidedBy === sp.decider);
  history = history.sort((a, b) => (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt));
  const rows = tab === "mine" ? mine : tab === "requested" ? requested : tab === "history" ? history : allPending;
  const paged = paginate(rows, sp.page, 50);
  const base = "/approvals";
  const returnsOf = (a: Approval) => db.approvals.filter((x) => x.targetId === a.targetId && x.type === a.type && x.status === "returned").length;
  const people = [...new Set(visible.flatMap((a) => [a.requestedBy, a.decidedBy]).filter((x): x is string => Boolean(x)))].map((id) => ({ id, name: userName(id) })).sort((a, b) => a.name.localeCompare(b.name, "ja"));
  const exportQs = new URLSearchParams(Object.entries({ type: "approvals", kind: sp.type, status: sp.status, from: sp.from, to: sp.to }).filter(([, v]) => v) as [string, string][]).toString();

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader title="承認" actions={canExportAudit(user) ? <LinkButton href={`/api/export?${exportQs}`} variant="secondary" size="sm" download>承認履歴 (CSV)</LinkButton> : undefined} />
      <Note>
        承認ルール: 見積・契約・契約内容の変更は {rules.quoteAdminThreshold.toLocaleString("ja-JP")} 円未満 → 店長、以上 → 管理者。経費は {rules.expenseAdminThreshold.toLocaleString("ja-JP")} 円未満 → 店長、以上と本部分 → 管理者。仕入の支払依頼 → 管理者。顧客の重要情報の変更 → {rules.customerChange ? "店長 (店長・管理者が変更したときは承認なし)" : "承認なし"}。申請者本人は判断できません。判断は「承認」「差戻し (修正して再申請)」「却下」の 3 つで、すべて履歴に残ります。
      </Note>
      <div className="mt-4">
        <LinkTabs
          current={`${base}?tab=${tab}`}
          items={[
            { href: `${base}?tab=mine`, label: "あなたの承認待ち", count: mine.length },
            { href: `${base}?tab=requested`, label: "あなたの申請中", count: requested.length },
            { href: `${base}?tab=pending`, label: "承認待ち (全体)", count: allPending.length },
            { href: `${base}?tab=history`, label: "履歴 (承認・差戻し・却下・取下げ)" },
          ]}
        />
      </div>
      {tab === "history" && (
        <form method="get" className="mb-4 flex flex-wrap items-end gap-2">
          <input type="hidden" name="tab" value="history" />
          <Select name="type" defaultValue={sp.type ?? ""} className="w-auto" aria-label="種類">
            <option value="">すべての種類</option>
            {(Object.keys(APPROVAL_TYPE_LABEL) as ApprovalType[]).map((t) => <option key={t} value={t}>{APPROVAL_TYPE_LABEL[t]}</option>)}
          </Select>
          <Select name="status" defaultValue={sp.status ?? ""} className="w-auto" aria-label="判断">
            <option value="">すべての判断</option>
            {(["approved", "returned", "rejected", "cancelled"] as const).map((s) => <option key={s} value={s}>{APPROVAL_STATUS[s].label}</option>)}
          </Select>
          <Select name="requester" defaultValue={sp.requester ?? ""} className="w-auto" aria-label="申請者">
            <option value="">すべての申請者</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
          <Select name="decider" defaultValue={sp.decider ?? ""} className="w-auto" aria-label="判断した人">
            <option value="">すべての判断者</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
          <Input type="date" name="from" defaultValue={sp.from} className="w-auto" aria-label="判断日 (から)" />
          <span className="text-xs text-ink-3">〜</span>
          <Input type="date" name="to" defaultValue={sp.to} className="w-auto" aria-label="判断日 (まで)" />
          <Button type="submit" variant="secondary">絞り込む</Button>
          <span className="text-xs text-ink-3">{history.length} 件</span>
        </form>
      )}
      <div className="space-y-3">
        {rows.length === 0 && <Card><p className="py-6 text-center text-sm text-ink-3">該当する承認依頼はありません</p></Card>}
        {paged.items.map((a) => {
          const returns = returnsOf(a);
          return (
            <Card key={a.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={a.requiredRole === "admin" ? "serious" : "warn"} dot={false}>{a.requiredRole === "admin" ? "管理者承認" : "店長承認"}</Badge>
                    <span className="text-xs text-ink-3">{APPROVAL_TYPE_LABEL[a.type]}</span>
                    <StatusBadge value={a.status} map={APPROVAL_STATUS} />
                    {returns > 0 && <Badge tone="neutral" dot={false}>差戻し {returns} 回</Badge>}
                  </div>
                  <Link href={approvalHref(a)} className="mt-1 block text-sm font-medium text-ink hover:text-accent">{a.title}</Link>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3">
                    <StoreTag store={storeMap.get(a.storeId)} short />
                    <span>申請 {userName(a.requestedBy)} · {fmtDateTime(a.createdAt)}</span>
                    {a.decidedBy && <span>{APPROVAL_STATUS[a.status].label} {userName(a.decidedBy)} · {fmtDateTime(a.decidedAt)}</span>}
                  </div>
                  {a.requestComment && <p className="mt-1 text-xs text-ink-2">申請コメント: {a.requestComment}</p>}
                  {a.decisionComment && <p className="mt-1 text-xs text-ink-2">判断コメント: {a.decisionComment}</p>}
                  {(a.status !== "pending" || a.type === "store_change") && a.type !== "customer_delete" && a.changes && a.changes.length > 0 && <ChangeList entity={a.type === "customer_change" ? "customer" : a.type === "store_change" ? "store_change" : "order"} changes={a.changes} />}
                </div>
                <div className="text-right">
                  {a.amount > 0 && <div className="text-lg font-semibold tnum">{yen(a.amount)}</div>}
                  <Link href={approvalHref(a)} className="text-xs text-accent hover:underline">詳細を確認 →</Link>
                </div>
              </div>
              {a.status === "pending" && (
                <div className="mt-3 border-t border-line pt-3">
                  <ApprovalDecision approval={a} user={user} returnTo={`${base}?tab=${tab}`} approveLabel="承認" />
                </div>
              )}
            </Card>
          );
        })}
      </div>
      <Pager paged={paged} path={base} sp={sp} />
      <div className="mt-6">
        <div className="mb-2 text-sm font-medium text-ink">承認待ちの内訳</div>
        <div className="flex flex-wrap gap-2 text-xs">
          {(Object.keys(APPROVAL_TYPE_LABEL) as Approval["type"][]).map((t) => (
            <span key={t} className="rounded-full border border-line px-2.5 py-1 text-ink-2">{APPROVAL_TYPE_LABEL[t]} <span className="tnum font-medium text-ink">{allPending.filter((a) => a.type === t).length}</span></span>
          ))}
        </div>
      </div>
    </div>
  );
}
