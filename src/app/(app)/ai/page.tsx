import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { aiStatus } from "@/lib/ai/provider";
import { DRAFT_FORMAT_LABEL, DRAFT_TEMPLATES } from "@/lib/ai/draft";
import { AssistantPage } from "@/components/chatbot/AssistantPage";
import { ChatHistory } from "@/components/chatbot/ChatHistory";
import { DraftForm } from "@/components/features/DraftForm";
import Link from "@/components/ui/Link";
import { Badge, Card, CardHeader, Flash, LinkTabs, PageHeader } from "@/components/ui";
import { ChatbotAdmin } from "@/components/chatbot/ChatbotAdmin";
import { canManageChatbot } from "@/lib/auth/permissions";
import { ensureChatbotData } from "@/lib/chatbot/build";
import { chatbotStats, listQa } from "@/lib/chatbot/store";
import { pendingDocs, trainState } from "@/lib/chatbot/train";

/** AI の応答待ち (最大 50 秒) のため、処理時間の上限を 60 秒にする */
export const maxDuration = 60;

export default async function AiPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const status = aiStatus();
  const enabled = status.enabled;
  const manage = canManageChatbot(user);
  const tab = sp.tab === "draft" ? "draft" : sp.tab === "history" ? "history" : sp.tab === "bot" && manage ? "bot" : "chat";
  const knowledgeCount = db.knowledge.filter((k) => k.active).length;
  return (
    <div>
      <PageHeader title="AI アシスタント" badge={<Badge tone={enabled ? "good" : "neutral"}>{enabled ? `${status.label} 接続中 (${status.model})` : "サンプルモード"}</Badge>} />
      <LinkTabs
        current={tab === "chat" ? "/ai" : `/ai?tab=${tab}`}
        items={[{ href: "/ai", label: "質問・検索・分析" }, { href: "/ai?tab=history", label: "相談の履歴" }, { href: "/ai?tab=draft", label: "文書の作成" }, ...(manage ? [{ href: "/ai?tab=bot", label: "チャットボットの管理" }] : [])]}
      />
      <Flash msg={sp.msg} err={sp.err} />
      {tab === "bot" ? (
        <BotTab sp={sp} enabled={enabled} db={db} />
      ) : tab === "history" ? (
        <ChatHistory user={user} db={db} sp={sp} />
      ) : tab === "draft" ? (
        <DraftForm templates={Object.entries(DRAFT_TEMPLATES).map(([id, t]) => ({ id, ...t }))} formats={Object.entries(DRAFT_FORMAT_LABEL).map(([id, label]) => ({ id, label }))} defaultRef={sp.ref} aiEnabled={enabled} />
      ) : (
        <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-4">
          <div className="@4xl:col-span-3">
            <AssistantPage userName={user.name} />
            {!enabled && <p className="mt-2 text-xs text-ink-3">AI のキーが設定されていないため、集計の質問は言葉の決まりで読み取り、使い方は資料から答えます。</p>}
          </div>
          <div className="space-y-4">
            <Card>
              <CardHeader title="できること" />
              <ul className="space-y-1.5 text-xs text-ink-2">
                <li>・<strong>使い方の案内</strong>: 顧客の登録・問い合わせから入金までの手順・修正のしかた・帳票の作り方を、画面とボタンの順に</li>
                <li>・<strong>横断検索</strong>: 顧客・案件・施工履歴・見積・請求・入金・予定・経費・仕入・発注・連絡履歴・社内連絡・議事録 (「○○様の前回の担当者は？」「来週の合志店の予定」「似た工事はある？」)</li>
                <li>・<strong>売上・粗利の分析</strong>: 期間・店舗・種別・商品・顧客・担当者・地区を自由に組み合わせ、前年同期と比較。表とグラフで表示し、CSV で保存</li>
                <li>・<strong>集計のしかたの案内</strong>: 直接集計できないときは、経営ダッシュボード・CSV 出力での手順</li>
                <li>・<strong>社内資料</strong> (業務ルール・議事録・マニュアル・価格・施工方法) にもとづく回答 (登録 {knowledgeCount} 件・<Link href="/knowledge" className="text-accent hover:underline">社内資料を見る</Link>)</li>
                <li>・<strong>予定の候補日の提案</strong>: 店舗の受け入れ量・畳の製造・担当者の空き・現場の距離から</li>
                <li>・<strong>相談の履歴</strong>: 過去の質問と回答を検索。よい回答は社内資料 (よくある質問) に登録して共有</li>
              </ul>
            </Card>
            <Card>
              <CardHeader title="安全性" />
              <ul className="space-y-1.5 text-xs text-ink-2">
                <li>・回答はログインした人が閲覧できる範囲のデータだけを使います (店舗のロールは自店舗。社内資料は資料ごとの公開範囲)</li>
                <li>・数字は AI が計算せず、システムの集計で出します。回答の下の「回答の根拠」で元の記録・資料・集計の条件を確認できます</li>
                <li>・見つからないときは「記録がありません」と答え、推測で補いません</li>
                <li>・AI は登録・変更・承認を直接行いません (操作は担当者が画面で行います)</li>
                <li>・質問と回答は相談の履歴に残ります (本人のほか、管理者・本部は全員分、店長は自店舗の分を閲覧できます)</li>
                <li>・AI テキスト相談・AI 音声相談・AI 電話受付・LINE・Web フォームからの受付も、同じデータに登録されます</li>
              </ul>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

const PAGE_SIZE = 50;

function BotTab({ sp, enabled, db }: { sp: Record<string, string | undefined>; enabled: boolean; db: ReturnType<typeof getDb> }) {
  ensureChatbotData(db);
  const page = Math.max(1, Number(sp.page) || 1);
  const { rows, total } = listQa({ q: sp.q, origin: sp.origin, flagged: sp.flagged === "1", limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
  return <ChatbotAdmin stats={chatbotStats()} train={trainState()} pending={pendingDocs().length} aiEnabled={enabled} list={{ rows, total, page, size: PAGE_SIZE }} sp={sp} />;
}
