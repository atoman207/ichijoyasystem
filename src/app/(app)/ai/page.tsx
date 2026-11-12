import { requireUser } from "@/lib/auth/session";
import { aiEnabled } from "@/lib/ai/ocr";
import { ASSISTANT_MODEL } from "@/lib/ai/assistant";
import { AiChat } from "@/components/features/AiChat";
import { Badge, Card, CardHeader, PageHeader } from "@/components/ui";

export default async function AiPage() {
  const user = await requireUser();
  const enabled = aiEnabled();
  return (
    <div>
      <PageHeader title="AI アシスタント" badge={<Badge tone={enabled ? "good" : "neutral"}>{enabled ? `Claude 接続中 (${ASSISTANT_MODEL})` : "サンプルモード"}</Badge>} />
      <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-4">
        <div className="@4xl:col-span-3">
          <AiChat userName={user.name} userId={user.id} aiEnabled={enabled} />
        </div>
        <div className="space-y-4">
          <Card>
            <CardHeader title="できること" />
            <ul className="space-y-1.5 text-xs text-ink-2">
              <li>・売上・受注・成約率の集計と店舗比較</li>
              <li>・未入金・期日超過の抽出と督促対象の提示</li>
              <li>・承認待ち案件の一覧と判断材料の整理</li>
              <li>・今日/今週の予定、担当者の割当状況</li>
              <li>・顧客名での横断検索 (履歴・連絡手段・担当)</li>
              <li>・お客様向け文面 (メール/LINE) の下書き</li>
              <li>・社内連絡・報告の要約</li>
            </ul>
          </Card>
          <Card>
            <CardHeader title="安全性" />
            <ul className="space-y-1.5 text-xs text-ink-2">
              <li>・回答はログインユーザーの権限で閲覧できる範囲のデータのみを使用</li>
              <li>・AI は情報の登録・変更・承認を直接行わず、提案にとどめる (操作は担当者が画面で実行)</li>
              <li>・質問は変更履歴に記録</li>
              <li>・本番: AI 電話受付・LINE・Web フォームからの問い合わせも同じ基盤に自動登録</li>
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
