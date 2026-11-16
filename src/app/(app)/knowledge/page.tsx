import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canEditKnowledge, canManageKnowledgeSources } from "@/lib/auth/permissions";
import { userName } from "@/lib/db/queries";
import { fmtDateTime } from "@/lib/format";
import { KNOWLEDGE_CATEGORY_HINTS, knowledgeSources, searchKnowledge } from "@/lib/knowledge";
import { addKnowledgeSource, createKnowledge, importKnowledgeFile, removeKnowledgeSource, syncKnowledgeSource } from "@/lib/actions/knowledge";
import { aiEnabled } from "@/lib/ai/provider";
import Link from "@/components/ui/Link";
import { Badge, Button, Card, CardHeader, Field, Flash, Input, Note, PageHeader, Pager, Select, Textarea, paginate } from "@/components/ui";

export const maxDuration = 60;

const SOURCE_LABEL = { manual: "画面で登録", sheet: "スプレッドシート", file: "ファイル" } as const;

/**
 * 社内資料 (ナレッジ): AI アシスタントが回答の根拠にする資料
 * - 閲覧・検索: 全員 / 登録・修正・ファイル取込: 店長・本部スタッフ・管理者 / スプレッドシートの登録・同期: 本部スタッフ・管理者
 */
export default async function KnowledgePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const editable = canEditKnowledge(user);
  const manageSources = canManageKnowledgeSources(user);
  const q = (sp.q ?? "").trim();
  const cat = sp.category ?? "";
  const categories = [...new Set([...KNOWLEDGE_CATEGORY_HINTS, ...db.knowledge.map((k) => k.category).filter(Boolean)])];
  const hits = q ? searchKnowledge(db.knowledge.filter((k) => !cat || k.category === cat), q, { limit: 50, minCoverage: 0.15 }) : [];
  const list = q ? hits.map((h) => h.entry) : [...db.knowledge].filter((k) => !cat || k.category === cat).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const snippets = new Map(hits.map((h) => [h.entry.id, h.snippet]));
  const paged = paginate(list, sp.page, 50);
  const sources = knowledgeSources(db);

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader title="社内資料 (ナレッジ)" description={`AI アシスタントは、ここにある資料をもとに回答します。登録 ${db.knowledge.length} 件 (うち AI に使う ${db.knowledge.filter((k) => k.active).length} 件)`} />
      <Note>
        商品・価格の目安、施工の手順、お客様対応の決まり、社内ルール、よくある質問などを登録してください。AI は質問に関係しそうな資料を探して回答に使い、使った資料の名前を示します。資料にないことは「資料に記載がありません」と答えます。
      </Note>

      <form method="get" className="mt-4 mb-4 flex flex-wrap items-end gap-2">
        <div className="w-full @xl:w-80"><Input name="q" defaultValue={q} placeholder="資料を検索 (例: 支払方法 / 畳表の種類)" /></div>
        <Select name="category" defaultValue={cat} className="w-auto" aria-label="分類">
          <option value="">すべての分類</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </Select>
        <Button type="submit" variant="secondary">探す</Button>
        <span className="text-xs text-ink-3">{list.length} 件{q ? " (AI が回答に使う順)" : ""}</span>
      </form>

      <div className="grid grid-cols-1 gap-4 @5xl:grid-cols-3">
        <div className="@5xl:col-span-2">
          <ul className="divide-y divide-line rounded-xl border border-line bg-panel">
            {paged.items.length === 0 && <li className="px-4 py-10 text-center text-sm text-ink-3">{q ? "当てはまる資料はありません" : "まだ資料がありません。右の欄から登録してください"}</li>}
            {paged.items.map((k) => (
              <li key={k.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/knowledge/${k.id}`} className="font-medium text-accent hover:underline">{k.title}</Link>
                  <Badge dot={false}>{k.category || "その他"}</Badge>
                  <Badge dot={false} tone={k.source === "sheet" ? "info" : k.source === "file" ? "accent" : "neutral"}>{SOURCE_LABEL[k.source]}</Badge>
                  {!k.active && <Badge tone="warn" dot={false}>AI に使わない</Badge>}
                </div>
                <p className="mt-1 line-clamp-2 text-xs text-ink-2">{snippets.get(k.id) ?? k.body.slice(0, 160)}</p>
                <p className="mt-0.5 text-[11px] text-ink-3">{k.tags.length ? `タグ: ${k.tags.join("・")} · ` : ""}更新 {fmtDateTime(k.updatedAt)} {userName(k.updatedBy ?? k.createdBy)}</p>
              </li>
            ))}
          </ul>
          <Pager paged={paged} path="/knowledge" sp={sp} />
        </div>

        <div className="space-y-4">
          {editable && (
            <Card>
              <CardHeader title="資料を登録" />
              <form action={createKnowledge} className="space-y-2">
                <Field label="タイトル" required><Input name="title" required maxLength={200} placeholder="例: お支払い方法" /></Field>
                <Field label="分類">
                  <Input name="category" list="knowledge-categories" placeholder="例: よくある質問" />
                  <datalist id="knowledge-categories">{categories.map((c) => <option key={c} value={c} />)}</datalist>
                </Field>
                <Field label="内容" required><Textarea name="body" required className="min-h-[140px]" placeholder="例: 現金・クレジットカード (VISA・マスター)・PayPay・銀行振込に対応。振込の場合は納品後 2 週間以内。" /></Field>
                <Field label="タグ (読点・空白区切り)"><Input name="tags" placeholder="例: 支払い、カード、PayPay" /></Field>
                <Button type="submit" size="sm">登録する</Button>
              </form>
            </Card>
          )}
          {editable && (
            <Card>
              <CardHeader title="ファイルから取り込む" description={`テキスト (.txt・.md): 見出し (# ・■・【】) ごとに 1 件 / CSV: 1 行目に「タイトル」「内容」(と「分類」「タグ」) の見出し / PDF・写真: ${aiEnabled() ? "AI で文字にして取り込み" : "AI の設定が必要"}`} />
              <form action={importKnowledgeFile} className="space-y-2">
                <input type="file" name="file" required accept=".txt,.md,.csv,.tsv,.pdf,.jpg,.jpeg,.png,.webp" className="block w-full text-xs" />
                <Field label="分類 (ファイルに分類がないとき)"><Input name="category" list="knowledge-categories" placeholder="例: 商品・価格" /></Field>
                <Button type="submit" size="sm" variant="secondary">取り込む</Button>
              </form>
            </Card>
          )}
          <Card>
            <CardHeader title="Google スプレッドシートとの連携" description="指定したシートの内容を社内資料として取り込み、同期のたびにシートの内容に合わせます (追加・更新・削除)。シートは「リンクを知っている全員が閲覧できる」共有にしてください" />
            {sources.length === 0 && <p className="text-xs text-ink-3">登録されたシートはありません。</p>}
            <ul className="space-y-2">
              {sources.map((s) => (
                <li key={s.id} className="rounded-lg border border-line p-2 text-xs">
                  <div className="font-medium text-ink">{s.label}</div>
                  <div className="truncate text-ink-3">{s.url}</div>
                  <div className="mt-0.5 text-ink-2">
                    {s.lastSyncedAt ? `最終同期 ${fmtDateTime(s.lastSyncedAt)} · ${s.lastResult ?? ""}${typeof s.lastCount === "number" ? ` · ${s.lastCount} 件` : ""}` : "未同期"}
                  </div>
                  {s.lastError && <div className="mt-0.5 text-critical-ink">{s.lastError}</div>}
                  {manageSources && (
                    <div className="mt-1.5 flex gap-2">
                      <form action={syncKnowledgeSource.bind(null, s.id)}><Button type="submit" size="sm" variant="secondary">今すぐ同期</Button></form>
                      <form action={removeKnowledgeSource.bind(null, s.id)}><Button type="submit" size="sm" variant="ghost">削除</Button></form>
                    </div>
                  )}
                </li>
              ))}
            </ul>
            {manageSources && (
              <form action={addKnowledgeSource} className="mt-3 space-y-2 border-t border-line pt-3">
                <Field label="シートの URL" required><Input name="url" required placeholder="https://docs.google.com/spreadsheets/d/…/edit#gid=0" /></Field>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="名前"><Input name="label" placeholder="例: 商品・価格表" /></Field>
                  <Field label="分類 (列がないとき)"><Input name="category" list="knowledge-categories" placeholder="例: 商品・価格" /></Field>
                </div>
                <Button type="submit" size="sm">登録して同期する</Button>
                <p className="text-[11px] text-ink-3">シートの 1 行目に「タイトル」(または 質問・項目)「内容」(または 回答・説明) の見出しを入れてください。「分類」「タグ」の列があれば使います。サーバーの定期実行 (/api/cron/knowledge-sync) でも自動で同期できます。</p>
              </form>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
