import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { aiStatus } from "@/lib/ai/provider";
import { DRAFT_FORMAT_LABEL, DRAFT_TEMPLATES } from "@/lib/ai/draft";
import { AiChat } from "@/components/features/AiChat";
import { DraftForm } from "@/components/features/DraftForm";
import Link from "@/components/ui/Link";
import { Badge, Card, CardHeader, LinkTabs, PageHeader } from "@/components/ui";

/** AI の応答待ち (最大 50 秒) のため、処理時間の上限を 60 秒にする */
export const maxDuration = 60;

export default async function AiPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const status = aiStatus();
  const enabled = status.enabled;
  const tab = sp.tab === "draft" ? "draft" : "chat";
  const knowledgeCount = db.knowledge.filter((k) => k.active).length;
  return (
    <div>
      <PageHeader title="AI アシスタント" badge={<Badge tone={enabled ? "good" : "neutral"}>{enabled ? `${status.label} 接続中 (${status.model})` : "サンプルモード"}</Badge>} />
      <LinkTabs current={tab === "draft" ? "/ai?tab=draft" : "/ai"} items={[{ href: "/ai", label: "質問・検索" }, { href: "/ai?tab=draft", label: "文書の作成" }]} />
      {tab === "draft" ? (
        <DraftForm templates={Object.entries(DRAFT_TEMPLATES).map(([id, t]) => ({ id, ...t }))} formats={Object.entries(DRAFT_FORMAT_LABEL).map(([id, label]) => ({ id, label }))} defaultRef={sp.ref} aiEnabled={enabled} />
      ) : (
        <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-4">
          <div className="@4xl:col-span-3">
            <AiChat userName={user.name} userId={user.id} aiEnabled={enabled} />
          </div>
          <div className="space-y-4">
            <Card>
              <CardHeader title="できること" />
              <ul className="space-y-1.5 text-xs text-ink-2">
                <li>・顧客・案件の検索: 「田中様の履歴」「O-2026-0012 の状況」「090-… のお客様」「「健軍」の現場」</li>
                <li>・社内資料にもとづく回答 (登録 {knowledgeCount} 件・<Link href="/knowledge" className="text-accent hover:underline">社内資料を見る</Link>)</li>
                <li>・売上・受注・成約率の集計と店舗比較</li>
                <li>・未入金・期日超過の抽出、承認待ちの一覧</li>
                <li>・今日・今週の予定、担当者の予定の重複</li>
                <li>・お客様向け文面・社内の報告の下書き (「文書の作成」タブ)</li>
                <li>・見積・受注・経費・顧客の要約 (各画面の「AI で要約」)</li>
              </ul>
            </Card>
            <Card>
              <CardHeader title="安全性" />
              <ul className="space-y-1.5 text-xs text-ink-2">
                <li>・回答はログインした人が閲覧できる範囲のデータだけを使います</li>
                <li>・AI は登録・変更・承認を直接行いません (操作は担当者が画面で行います)</li>
                <li>・質問・要約・文書の作成は変更履歴に記録されます</li>
                <li>・AI テキスト相談・AI 音声相談・AI 電話受付・LINE・Web フォームからの受付も、同じデータに登録されます</li>
              </ul>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
