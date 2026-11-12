import Link from "@/components/ui/Link";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canApprove, canCancelApproval, canSeeAllStores, scopeByStore } from "@/lib/auth/permissions";
import { userName } from "@/lib/db/queries";
import { cancelApproval, decideApproval } from "@/lib/actions/approvals";
import { fmtDateTime, yen } from "@/lib/format";
import { APPROVAL_RULES, APPROVAL_STATUS, APPROVAL_TYPE_LABEL } from "@/lib/constants";
import type { Approval } from "@/lib/db/types";
import { Badge, Button, Card, CardHeader, Flash, Input, LinkTabs, Note, PageHeader, StatusBadge, StoreTag } from "@/components/ui";

function targetHref(a: Approval): string {
  switch (a.type) {
    case "quote":
    case "quote_amend":
      return `/quotes/${a.targetId}`;
    case "order":
      return `/orders/${a.targetId}`;
    case "expense":
      return `/expenses/${a.targetId}`;
    case "purchase":
      return `/purchases/${a.targetId}`;
  }
}

export default async function ApprovalsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const storeMap = new Map(db.stores.map((s) => [s.id, s]));
  const visible = canSeeAllStores(user) ? db.approvals : db.approvals.filter((a) => a.storeId === user.storeId || a.requestedBy === user.id);
  const mine = visible.filter((a) => a.status === "pending" && canApprove(user, a));
  const requested = visible.filter((a) => a.status === "pending" && a.requestedBy === user.id);
  const allPending = scopeByStore(user, db.approvals).filter((a) => a.status === "pending");
  const history = visible.filter((a) => a.status !== "pending").sort((a, b) => (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt)).slice(0, 50);
  const tab = sp.tab ?? (mine.length > 0 ? "mine" : requested.length > 0 ? "requested" : "pending");
  const rows = tab === "mine" ? mine : tab === "requested" ? requested : tab === "history" ? history : allPending;
  const base = "/approvals";

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader title="承認" />
      <Note>
        承認ルール: 見積・契約は {APPROVAL_RULES.quoteAdminThreshold.toLocaleString("ja-JP")} 円未満 → 店長、以上 → 管理者。経費は {APPROVAL_RULES.expenseAdminThreshold.toLocaleString("ja-JP")} 円未満 → 店長、以上と本部分 → 管理者。仕入請求書の支払 → 管理者。申請者本人は承認できません。承認できる店長がいない店舗 (店長本人の申請を含む) は管理者が承認します。顧客情報・現場情報の登録や変更は承認不要で即時反映 (履歴は記録)。
      </Note>
      <div className="mt-4">
        <LinkTabs
          current={`${base}?tab=${tab}`}
          items={[
            { href: `${base}?tab=mine`, label: "あなたの承認待ち", count: mine.length },
            { href: `${base}?tab=requested`, label: "あなたの申請中", count: requested.length },
            { href: `${base}?tab=pending`, label: "承認待ち (全体)", count: allPending.length },
            { href: `${base}?tab=history`, label: "履歴" },
          ]}
        />
      </div>
      <div className="space-y-3">
        {rows.length === 0 && <Card><p className="py-6 text-center text-sm text-ink-3">該当する承認依頼はありません</p></Card>}
        {rows.map((a) => {
          const decidable = a.status === "pending" && canApprove(user, a);
          return (
            <Card key={a.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={a.requiredRole === "admin" ? "serious" : "warn"} dot={false}>{a.requiredRole === "admin" ? "管理者承認" : "店長承認"}</Badge>
                    <span className="text-xs text-ink-3">{APPROVAL_TYPE_LABEL[a.type]}</span>
                    <StatusBadge value={a.status} map={APPROVAL_STATUS} />
                  </div>
                  <Link href={targetHref(a)} className="mt-1 block text-sm font-medium text-ink hover:text-accent">{a.title}</Link>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3">
                    <StoreTag store={storeMap.get(a.storeId)} short />
                    <span>申請 {userName(a.requestedBy)} · {fmtDateTime(a.createdAt)}</span>
                    {a.decidedBy && <span>{a.status === "approved" ? "承認" : a.status === "rejected" ? "却下" : "取下げ"} {userName(a.decidedBy)} · {fmtDateTime(a.decidedAt)}</span>}
                  </div>
                  {a.requestComment && <p className="mt-1 text-xs text-ink-2">{a.requestComment}</p>}
                  {a.decisionComment && <p className="mt-1 text-xs text-ink-2">判断コメント: {a.decisionComment}</p>}
                </div>
                <div className="text-right">
                  <div className="text-lg font-semibold tnum">{yen(a.amount)}</div>
                  <Link href={targetHref(a)} className="text-xs text-accent hover:underline">詳細を確認 →</Link>
                </div>
              </div>
              {decidable && (
                <form className="mt-3 flex flex-wrap items-end gap-2 border-t border-line pt-3">
                  <input type="hidden" name="returnTo" value={`${base}?tab=${tab}`} />
                  <div className="w-full @xl:w-72"><Input name="comment" placeholder="コメント (任意)" /></div>
                  <Button type="submit" size="sm" formAction={decideApproval.bind(null, a.id, "approved")}>承認</Button>
                  <Button type="submit" size="sm" variant="danger" formAction={decideApproval.bind(null, a.id, "rejected")}>却下</Button>
                </form>
              )}
              {a.status === "pending" && !decidable && canCancelApproval(user, a) && (
                <form className="mt-3 border-t border-line pt-3">
                  <input type="hidden" name="returnTo" value={`${base}?tab=${tab}`} />
                  <Button type="submit" size="sm" variant="ghost" formAction={cancelApproval.bind(null, a.id)}>申請を取り下げる</Button>
                </form>
              )}
            </Card>
          );
        })}
      </div>
      <div className="mt-6">
        <CardHeader title="承認待ちの内訳" />
        <div className="flex flex-wrap gap-2 text-xs">
          {(Object.keys(APPROVAL_TYPE_LABEL) as Approval["type"][]).map((t) => (
            <span key={t} className="rounded-full border border-line px-2.5 py-1 text-ink-2">{APPROVAL_TYPE_LABEL[t]} <span className="tnum font-medium text-ink">{allPending.filter((a) => a.type === t).length}</span></span>
          ))}
        </div>
      </div>
    </div>
  );
}
