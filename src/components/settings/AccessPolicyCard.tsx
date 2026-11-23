import { Eye } from "lucide-react";
import type { Database, User } from "@/lib/db/types";
import { canManageAccessPolicy } from "@/lib/auth/permissions";
import { CUSTOMER_POLICY_LABEL, FIGURE_POLICY_LABEL, GRANT_DAYS_MAX, GRANT_DAYS_MIN, accessPolicy, type CustomerPolicy, type FigurePolicy } from "@/lib/access-policy";
import { saveAccessPolicy } from "@/lib/actions/access-policy";
import { userName } from "@/lib/db/queries";
import { fmtDateTime } from "@/lib/format";
import { Badge, Button, Card, CardHeader, Input } from "@/components/ui";
import Link from "@/components/ui/Link";

const FIGURE_HELP: Record<FigurePolicy, string> = {
  all: "経営ダッシュボード・管理会計・KPI の店舗の集計・販促の分析・AI アシスタントの集計を、全社員が全店舗分見られます (見るだけ。設定・確定は従来どおり)。",
  store: "店舗のロールは自店舗の数字だけ。経営ダッシュボード・管理会計・販促の分析は店長・本部・管理者だけが見られます。",
};
const CUSTOMER_HELP: Record<CustomerPolicy, string> = {
  all: "顧客・問い合わせ・見積・受注・請求書・写真・施工の履歴を、全社員がほかの店舗の分も見られます (閲覧のみ)。記録を開くと (自店舗の記録も)、変更履歴に「閲覧」として残ります (1 人・1 件・1 日に 1 回)。",
  approval: "店長・本部・管理者は全店舗。店舗スタッフは、進行中の案件 (問い合わせ〜入金完了) と、所属店舗の店長が承認したお客様 (承認から決まった日数) だけ。完了した案件のお客様を開くと「閲覧の申請」になります。",
  open: "進行中の案件 (問い合わせ〜入金完了) だけ、ほかの店舗の分も見られます。完了した案件は自店舗だけ。",
};

/** 設定 → ユーザーと権限: 閲覧の範囲 (経営の数字・顧客情報)。変更は管理者 (src/lib/access-policy.ts) */
export function AccessPolicyCard({ db, user }: { db: Database; user: User }) {
  const p = accessPolicy(db);
  const admin = canManageAccessPolicy(user);
  return (
    <div data-testid="access-policy">
    <Card>
      <CardHeader
        title="閲覧の範囲 (経営の数字・顧客情報)"
        icon={<Eye />}
        description="見られる範囲だけを決めます。登録・変更は今までどおり、その店舗の社員だけです。入金完了・全処理完了の案件の内容を変更できるのは管理者だけです。社員ごとの評価・インセンティブの金額・経費・有給・社内連絡・慶弔リストは、この設定では変わりません。"
        action={p.updatedAt ? <span className="text-[11px] text-ink-3">更新 {fmtDateTime(p.updatedAt)} {userName(p.updatedBy)}</span> : <Badge tone="neutral" dot={false}>初期設定</Badge>}
      />
      <form action={saveAccessPolicy} className="space-y-4 text-sm">
        <fieldset disabled={!admin} className="m-0 min-w-0 space-y-4 border-0 p-0">
          <div>
            <div className="label">経営の数字 (売上・原価・粗利・KPI・販促の分析)</div>
            <div className="space-y-1.5">
              {(Object.keys(FIGURE_POLICY_LABEL) as FigurePolicy[]).map((k) => (
                <label key={k} className="flex items-start gap-2 rounded-lg border border-line px-3 py-2 has-[:checked]:border-accent has-[:checked]:bg-accent-soft/40">
                  <input type="radio" name="figures" value={k} defaultChecked={p.figures === k} className="mt-0.5 h-4 w-4" />
                  <span>
                    <span className="font-medium text-ink">{FIGURE_POLICY_LABEL[k]}</span>
                    {k === "all" && <Badge tone="good" dot={false} className="ml-1.5">おすすめ</Badge>}
                    <span className="block text-xs text-ink-3">{FIGURE_HELP[k]}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
          <div>
            <div className="label">顧客情報 (顧客・問い合わせ・見積・受注・請求書・写真・施工の履歴)</div>
            <div className="space-y-1.5">
              {(Object.keys(CUSTOMER_POLICY_LABEL) as CustomerPolicy[]).map((k) => (
                <label key={k} className="flex items-start gap-2 rounded-lg border border-line px-3 py-2 has-[:checked]:border-accent has-[:checked]:bg-accent-soft/40">
                  <input type="radio" name="customers" value={k} defaultChecked={p.customers === k} className="mt-0.5 h-4 w-4" />
                  <span>
                    <span className="font-medium text-ink">{CUSTOMER_POLICY_LABEL[k]}</span>
                    {k === "all" && <Badge tone="good" dot={false} className="ml-1.5">おすすめ</Badge>}
                    <span className="block text-xs text-ink-3">{CUSTOMER_HELP[k]}</span>
                  </span>
                </label>
              ))}
            </div>
            <label className="mt-2 flex flex-wrap items-center gap-2 text-xs text-ink-2">
              承認制のとき、承認のあと見られる日数
              <Input type="number" name="grantDays" min={GRANT_DAYS_MIN} max={GRANT_DAYS_MAX} defaultValue={p.grantDays} className="h-8 w-20 py-0.5 text-sm" />日
            </label>
          </div>
        </fieldset>
        <div className="flex flex-wrap items-center gap-3">
          {admin ? <Button type="submit">閲覧の範囲を保存</Button> : <span className="text-xs text-ink-3">変更は管理者が行います。</span>}
          <Link href="/audit?action=view" className="text-xs text-accent hover:underline">閲覧の記録を見る (変更履歴 → 操作「閲覧」)</Link>
        </div>
      </form>
    </Card>
    </div>
  );
}
