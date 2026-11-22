import { KeyRound } from "lucide-react";
import type { Approval } from "@/lib/db/types";
import { requestRecordView } from "@/lib/actions/access-policy";
import { fmtDateTime } from "@/lib/format";
import { Button, Card, CardHeader, Field, LinkButton, Textarea } from "@/components/ui";

/**
 * 閲覧の範囲 = 承認制のとき、ほかの店舗の完了した案件のお客様を開いた店舗スタッフに出す「閲覧の申請」(src/lib/case-access.ts)。
 * 承認者は所属店舗の店長 (いなければ管理者)。承認されると決まった日数だけ閲覧のみで見られる
 */
export function RecordViewRequest({ customerId, storeName, pending, grantDays }: { customerId: string; storeName: string; pending?: Approval; grantDays: number }) {
  return (
    <div className="mx-auto max-w-xl" data-testid="record-view-request">
      <Card>
        <CardHeader
          title="このお客様の情報は、閲覧に上司の承認が必要です"
          icon={<KeyRound />}
          description={`${storeName}のお客様で、入金が完了した案件のお客様です。閲覧の範囲の設定 (承認制) により、ほかの店舗の完了した案件のお客様は、所属店舗の店長の承認のあと ${grantDays} 日間、閲覧のみで見られます。`}
        />
        {pending ? (
          <div className="space-y-3 text-sm">
            <p className="rounded-xl bg-warn-soft px-3 py-2 text-warn-ink">
              承認待ちです (申請 {fmtDateTime(pending.createdAt)}{pending.requestComment ? ` · 理由: ${pending.requestComment}` : ""})。承認されると通知が届きます。
            </p>
            <LinkButton href="/approvals?tab=mine" variant="secondary" size="sm">申請の状況を見る</LinkButton>
          </div>
        ) : (
          <form action={requestRecordView.bind(null, customerId)} className="space-y-3">
            <Field label="閲覧が必要な理由" hint="例: お客様から電話があり、前回の施工内容を確かめたい">
              <Textarea name="reason" rows={3} required minLength={2} maxLength={500} />
            </Field>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit">閲覧を申請する</Button>
              <LinkButton href="/customers" variant="ghost" size="sm">顧客一覧に戻る</LinkButton>
            </div>
          </form>
        )}
      </Card>
    </div>
  );
}
