import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canEditKnowledge, canViewKnowledge } from "@/lib/auth/permissions";
import { redirect } from "next/navigation";
import { userName } from "@/lib/db/queries";
import { fmtDateTime } from "@/lib/format";
import { KNOWLEDGE_CATEGORY_HINTS, KNOWLEDGE_VISIBILITY_LABEL, knowledgeSources } from "@/lib/knowledge";
import { deleteKnowledge, updateKnowledge } from "@/lib/actions/knowledge";
import { HistoryCard } from "@/components/features/History";
import { Badge, Button, Card, CardHeader, Field, Flash, Input, Note, PageHeader, Select, Textarea } from "@/components/ui";
import { fmtDate } from "@/lib/format";

export default async function KnowledgeDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const k = db.knowledge.find((x) => x.id === id);
  if (!k) notFound();
  if (!canViewKnowledge(user, k)) redirect("/knowledge?err=" + encodeURIComponent("この社内資料を閲覧する権限がありません。"));
  const editable = canEditKnowledge(user);
  const sheet = k.source === "sheet" ? knowledgeSources(db).find((s) => k.sourceRef?.startsWith(`sheet:${s.id}:`)) : undefined;
  const categories = [...new Set([...KNOWLEDGE_CATEGORY_HINTS, ...db.knowledge.map((x) => x.category).filter(Boolean)])];

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader title={k.title} back={{ href: "/knowledge", label: "社内資料" }} badge={<span className="flex gap-1">{k.active ? <Badge tone="good">AI に使う</Badge> : <Badge tone="warn">AI に使わない</Badge>}{k.visibility && k.visibility !== "all" && <Badge tone="info" dot={false}>{KNOWLEDGE_VISIBILITY_LABEL[k.visibility]}</Badge>}</span>} description={`${k.category || "その他"}${k.recordDate ? ` · 日付 ${fmtDate(k.recordDate)}` : ""} · 登録 ${fmtDateTime(k.createdAt)} ${userName(k.createdBy)} · 更新 ${fmtDateTime(k.updatedAt)} ${userName(k.updatedBy ?? k.createdBy)}`} />
      {sheet && <Note tone="warn">この資料はスプレッドシート「{sheet.label}」から取り込んだものです。ここで修正しても、次の同期でシートの内容に戻ります。修正はシートで行ってください。</Note>}
      {k.source === "file" && <p className="mb-2 text-xs text-ink-3">取込元のファイル: {k.sourceRef}</p>}
      <div className="mt-4 grid grid-cols-1 gap-4 @4xl:grid-cols-3">
        <div className="@4xl:col-span-2">
          {editable ? (
            <Card>
              <CardHeader title="内容" />
              <form action={updateKnowledge.bind(null, k.id)} className="space-y-3">
                <Field label="タイトル" required><Input name="title" defaultValue={k.title} required maxLength={200} /></Field>
                <Field label="分類">
                  <Input name="category" defaultValue={k.category} list="knowledge-categories" />
                  <datalist id="knowledge-categories">{categories.map((c) => <option key={c} value={c} />)}</datalist>
                </Field>
                <Field label="内容" required><Textarea name="body" defaultValue={k.body} required className="min-h-[260px]" /></Field>
                <Field label="タグ (読点・空白区切り)"><Input name="tags" defaultValue={k.tags.join("、")} /></Field>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="見られる人" hint="AI も同じ範囲で回答に使います">
                    <Select name="visibility" defaultValue={k.visibility ?? "all"}>
                      {(Object.keys(KNOWLEDGE_VISIBILITY_LABEL) as (keyof typeof KNOWLEDGE_VISIBILITY_LABEL)[]).filter((v) => canViewKnowledge(user, { visibility: v })).map((v) => <option key={v} value={v}>{KNOWLEDGE_VISIBILITY_LABEL[v]}</option>)}
                    </Select>
                  </Field>
                  <Field label="日付 (会議・決定の日)"><Input name="recordDate" type="date" defaultValue={k.recordDate} /></Field>
                </div>
                <input type="hidden" name="activeShown" value="1" />
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="active" defaultChecked={k.active} className="h-4 w-4" /> AI の回答に使う</label>
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" size="sm">保存する</Button>
                  <Button type="submit" size="sm" variant="danger" formAction={deleteKnowledge.bind(null, k.id)} formNoValidate>削除する</Button>
                </div>
              </form>
            </Card>
          ) : (
            <Card>
              <CardHeader title="内容" />
              <div className="text-sm leading-relaxed whitespace-pre-wrap text-ink">{k.body}</div>
              {k.tags.length > 0 && <p className="mt-3 text-xs text-ink-3">タグ: {k.tags.join("・")}</p>}
            </Card>
          )}
        </div>
        <HistoryCard db={db} user={user} targets={[{ entity: "knowledge", id: k.id }]} />
      </div>
    </div>
  );
}
