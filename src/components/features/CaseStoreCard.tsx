import type { Database, User } from "@/lib/db/types";
import { caseChainOf } from "@/lib/case-store";
import { caseStoreChangeInfo } from "@/lib/case-store-view";
import { changeCaseStore } from "@/lib/actions/schedule";
import { Button, Card, CardHeader, Field, Input, Select } from "@/components/ui";

/**
 * 見積・受注の画面の「施工店舗 (売上を計上する店舗)」: 登録した店舗を間違えたときに、ここから変える
 * (予定表の予定の小さな画面の「施工店舗の変更」と同じ申請。店長・管理者はすぐ反映、店舗スタッフは店長の承認、
 * 施工完了・請求済・入金済の受注は管理者の承認。請求書を発行済み・キャンセル・月次確定の月は変えられない)
 */
export function CaseStoreCard({ db, user, recordId, canEdit, returnTo }: { db: Database; user: User; recordId: string; canEdit: boolean; returnTo: string }) {
  const chain = caseChainOf(db, recordId);
  if (!chain) return null;
  const info = caseStoreChangeInfo(db, user, chain, canEdit, chain.head.number);
  return (
    <Card id="case-store">
      <CardHeader title="施工店舗 (売上を計上する店舗)" description="登録した店舗を間違えたときは、ここで正しい店舗に変更します。案件の記録 (問い合わせ・見積・受注) と予定表の予定の店舗がそろって変わります" />
      <p className="text-sm text-ink">
        今の施工店舗: <span className="font-semibold">{info.currentName}</span>
      </p>
      {info.pending ? (
        <p className="mt-2 text-xs text-warn">{info.pending}。承認・差戻しのあとに、もう一度変更できます。</p>
      ) : info.blocked ? (
        <p className="mt-2 text-xs text-ink-3">変更できません: {info.blocked}</p>
      ) : !info.canChange ? (
        <p className="mt-2 text-xs text-ink-3">この案件の施工店舗を変える権限がありません。{info.currentName}の店長・本部・管理者に依頼してください。</p>
      ) : (
        <form action={changeCaseStore.bind(null, recordId)} className="mt-3 grid grid-cols-1 gap-3 @xl:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto] @xl:items-end">
          <input type="hidden" name="returnTo" value={returnTo} />
          <Field label="変更先の店舗">
            <Select name="storeId" defaultValue="" required>
              <option value="" disabled>
                選んでください
              </option>
              {info.options.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="理由 (任意)">
            <Input name="reason" maxLength={200} placeholder="例: 登録する店舗を間違えたため" />
          </Field>
          <Button type="submit" variant="secondary">
            施工店舗を変更する
          </Button>
          <p className="text-[11px] text-ink-3 @xl:col-span-3">{info.needsApproval ? `${info.approver}の承認のあとに反映します (それまでは今の店舗のまま)。` : "承認なしで、すぐに反映します。"}</p>
        </form>
      )}
    </Card>
  );
}
