import "server-only";
import Link from "@/components/ui/Link";
import type { Database, User } from "@/lib/db/types";
import { canSeeAllStores, canShareChatToKnowledge, canViewChatLog } from "@/lib/auth/permissions";
import { getChatLog, listChatLogs, type ChatLogRow } from "@/lib/chatbot/store";
import { shareChatToKnowledge } from "@/lib/actions/chatbot";
import { KNOWLEDGE_CATEGORY_HINTS, KNOWLEDGE_FAQ_CATEGORY, KNOWLEDGE_VISIBILITY_LABEL } from "@/lib/knowledge";
import { fmtDateTime } from "@/lib/format";
import { ROLE_LABEL } from "@/lib/constants";
import type { AnalysisResult } from "@/lib/assistant/analyze";
import { Badge, Button, Card, CardHeader, Field, Input, LinkButton, Select, Textarea } from "@/components/ui";
import { AnalysisTable } from "./AnalysisTable";
import { RichText } from "./AssistantChat";

/**
 * 相談の履歴 (AI アシスタントの画面の「相談の履歴」タブ)
 * - 本人は自分の履歴、店長は自店舗の社員の履歴、管理者・本部スタッフは全員の履歴を検索できる (canViewChatLog)
 * - よい回答は「社内資料に登録」で、よくある質問として全員の AI の根拠にできる (店長・本部・管理者)
 */

const SOURCE_TEXT: Record<string, string> = {
  agent: "データを調べて回答",
  analysis: "集計 (AI なし)",
  ai: "AI (資料から)",
  database: "蓄えた回答",
  data: "社内データ",
  docs: "資料",
  none: "回答できず",
};

const PAGE = 30;

function scopeOf(user: User): "all" | "store" | "self" {
  return canSeeAllStores(user) ? "all" : user.role === "store_manager" ? "store" : "self";
}

export function ChatHistory({ user, db, sp }: { user: User; db: Database; sp: Record<string, string | undefined> }) {
  const id = Number(sp.id) || 0;
  if (id) return <ChatDetail user={user} db={db} id={id} />;
  const scope = scopeOf(user);
  const page = Math.max(1, Number(sp.page) || 1);
  const filterUserId = scope !== "self" && sp.user ? sp.user : undefined;
  const { rows, total } = listChatLogs({ scope, userId: user.id, storeId: user.storeId, filterUserId, q: sp.q, onlyRated: sp.good === "1", limit: PAGE, offset: (page - 1) * PAGE });
  const visible = rows.filter((r) => canViewChatLog(user, r));
  const users = scope === "self" ? [] : db.users.filter((u) => scope === "all" || u.storeId === user.storeId);
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const qs = (p: number) => `/ai?${new URLSearchParams({ tab: "history", ...(sp.q ? { q: sp.q } : {}), ...(sp.user ? { user: sp.user } : {}), ...(sp.good ? { good: sp.good } : {}), page: String(p) })}`;
  return (
    <Card>
      <CardHeader
        title="相談の履歴"
        description={scope === "all" ? "全員の質問と回答 (管理者・本部スタッフ)" : scope === "store" ? "自分と自店舗の社員の質問と回答" : "自分の質問と回答"}
      />
      <form className="mb-4 flex flex-wrap items-end gap-2" action="/ai">
        <input type="hidden" name="tab" value="history" />
        <Field label="言葉で探す" className="min-w-0 flex-1">
          <Input name="q" defaultValue={sp.q} placeholder="例: 粗利 / 見積の修正 / 店長会議" />
        </Field>
        {users.length > 0 && (
          <Field label="社員">
            <Select name="user" defaultValue={sp.user ?? ""}>
              <option value="">全員</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <label className="mb-2 inline-flex items-center gap-1.5 text-xs text-ink-2">
          <input type="checkbox" name="good" value="1" defaultChecked={sp.good === "1"} className="h-4 w-4" /> 👍 の回答だけ
        </label>
        <Button type="submit" variant="secondary">
          探す
        </Button>
      </form>
      {visible.length === 0 ? (
        <p className="py-6 text-center text-sm text-ink-3">{sp.q ? "当てはまる相談はありません。" : "まだ相談の履歴はありません。画面左下の「質問する」から聞いてみてください。"}</p>
      ) : (
        <ul className="divide-y divide-line">
          {visible.map((r) => (
            <li key={r.id} className="py-2.5">
              <Link href={`/ai?tab=history&id=${r.id}`} className="group block">
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-3">
                  <span>{fmtDateTime(r.at)}</span>
                  {scope !== "self" && <span>{r.userName}</span>}
                  <Badge dot={false}>{SOURCE_TEXT[r.source] ?? r.source}</Badge>
                  {r.payload.tables?.length ? <Badge tone="info" dot={false}>表 {r.payload.tables.length}</Badge> : null}
                  {r.rating > 0 && <span>👍</span>}
                  {r.rating < 0 && <span>👎</span>}
                  {r.knowledgeId && <Badge tone="good" dot={false}>社内資料に登録済み</Badge>}
                </div>
                <p className="mt-0.5 text-sm font-medium text-ink group-hover:text-accent">{r.question}</p>
                <p className="line-clamp-2 text-xs text-ink-2">{r.answer.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\*\*/g, "")}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {pages > 1 && (
        <div className="mt-3 flex items-center justify-between text-xs text-ink-3">
          <span>
            {total.toLocaleString("ja-JP")} 件中 {(page - 1) * PAGE + 1}〜{Math.min(total, page * PAGE)} 件
          </span>
          <span className="flex gap-2">
            {page > 1 && <LinkButton href={qs(page - 1)} variant="ghost" size="sm">前へ</LinkButton>}
            {page < pages && <LinkButton href={qs(page + 1)} variant="ghost" size="sm">次へ</LinkButton>}
          </span>
        </div>
      )}
    </Card>
  );
}

function ChatDetail({ user, db, id }: { user: User; db: Database; id: number }) {
  const r: ChatLogRow | undefined = getChatLog(id);
  if (!r || !canViewChatLog(user, r)) {
    return (
      <Card>
        <p className="py-6 text-center text-sm text-ink-3">相談が見つからないか、閲覧する権限がありません。</p>
        <div className="text-center">
          <LinkButton href="/ai?tab=history" variant="secondary" size="sm">履歴の一覧へ</LinkButton>
        </div>
      </Card>
    );
  }
  const asker = db.users.find((u) => u.id === r.userId);
  const tables = (r.payload.tables ?? []) as AnalysisResult[];
  const canShare = canShareChatToKnowledge(user) && !r.knowledgeId;
  const plain = r.answer.replace(/\[([^\]]+)\]\((\/[^)]+)\)/g, "$1").replace(/\*\*/g, "");
  return (
    <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-3">
      <div className="space-y-4 @4xl:col-span-2">
        <Card>
          <CardHeader
            title={r.question}
            description={`${fmtDateTime(r.at)} · ${r.userName}${asker ? ` (${ROLE_LABEL[asker.role]})` : ""} · ${SOURCE_TEXT[r.source] ?? r.source}${r.ms ? ` · ${(r.ms / 1000).toFixed(1)} 秒` : ""}`}
            action={<LinkButton href="/ai?tab=history" variant="ghost" size="sm">一覧へ</LinkButton>}
          />
          <div className="text-sm leading-relaxed text-ink">
            <RichText text={r.answer} />
          </div>
          {tables.length > 0 && (
            <div className="mt-4 space-y-3">
              {tables.map((t, i) => (
                <AnalysisTable key={i} result={t} />
              ))}
              <p className="text-[11px] text-ink-3">※ 表は質問した時点の集計です。最新の数字は同じ質問をもう一度してください。</p>
            </div>
          )}
        </Card>
      </div>
      <div className="space-y-4">
        {(r.payload.sources?.length ?? 0) > 0 && (
          <Card>
            <CardHeader title="回答の根拠" />
            <ul className="space-y-1.5 text-xs">
              {r.payload.sources!.map((s, i) => (
                <li key={i} className="flex items-start gap-1.5">
                  <span className="shrink-0 rounded bg-subtle px-1.5 py-px text-[10px] text-ink-3">{s.kind}</span>
                  {s.href ? (
                    <Link href={s.href} className="text-accent hover:underline">
                      {s.label}
                    </Link>
                  ) : (
                    <span>{s.label}</span>
                  )}
                </li>
              ))}
            </ul>
            {(r.payload.tools?.length ?? 0) > 0 && (
              <div className="mt-3 border-t border-line pt-2 text-[11px] text-ink-3">
                <p className="font-medium">調べた内容</p>
                {r.payload.tools!.map((t, i) => (
                  <p key={i}>
                    ・{t.name}: {t.summary}
                  </p>
                ))}
              </div>
            )}
          </Card>
        )}
        {r.knowledgeId && (
          <Card>
            <CardHeader title="社内資料に登録済み" />
            <Link href={`/knowledge/${r.knowledgeId}`} className="text-sm text-accent hover:underline">
              登録した社内資料を開く
            </Link>
          </Card>
        )}
        {canShare && (
          <Card>
            <CardHeader title="社内資料に登録して共有" description="よくある質問・重要な回答を、全員の AI アシスタントとチャットボットの根拠にします。その時点の数字やお客様の個人情報は消してから登録してください" />
            <form action={shareChatToKnowledge.bind(null, r.id)} className="space-y-2">
              <Field label="タイトル (質問の形がおすすめ)" required>
                <Input name="title" defaultValue={r.question.slice(0, 120)} required />
              </Field>
              <Field label="本文" required>
                <Textarea name="body" rows={8} defaultValue={plain.slice(0, 6000)} required />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="分類">
                  <Input name="category" list="share-categories" defaultValue={KNOWLEDGE_FAQ_CATEGORY} />
                  <datalist id="share-categories">
                    {KNOWLEDGE_CATEGORY_HINTS.map((c) => (
                      <option key={c} value={c} />
                    ))}
                  </datalist>
                </Field>
                <Field label="見られる人">
                  <Select name="visibility" defaultValue="all">
                    {Object.entries(KNOWLEDGE_VISIBILITY_LABEL).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <Button type="submit">社内資料に登録</Button>
            </form>
          </Card>
        )}
      </div>
    </div>
  );
}
