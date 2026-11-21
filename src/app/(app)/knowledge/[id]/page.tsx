import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canEditKnowledge, canViewKnowledge } from "@/lib/auth/permissions";
import { userName } from "@/lib/db/queries";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { KNOWLEDGE_CATEGORY_HINTS, KNOWLEDGE_VISIBILITY_LABEL, knowledgeSources } from "@/lib/knowledge";
import { KNOWLEDGE_ISSUE, REVIEW_INTERVAL_CHOICES, entryInterval, intervalFor, intervalLabel, knowledgeIssues, ownerCandidates, reviewCtx, reviewSettings } from "@/lib/knowledge-review";
import { confirmKnowledge, deleteKnowledge, updateKnowledge } from "@/lib/actions/knowledge";
import { HistoryCard } from "@/components/features/History";
import Link from "@/components/ui/Link";
import { Badge, Button, Card, CardHeader, Dl, Field, Flash, Input, Note, PageHeader, Select, Textarea } from "@/components/ui";

const VIS_KEYS = Object.keys(KNOWLEDGE_VISIBILITY_LABEL) as (keyof typeof KNOWLEDGE_VISIBILITY_LABEL)[];

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
  const fromSheet = k.source === "sheet";
  const categories = [...new Set([...KNOWLEDGE_CATEGORY_HINTS, ...db.knowledge.map((x) => x.category).filter(Boolean)])];
  const rules = reviewSettings(db);
  const issues = knowledgeIssues(k, reviewCtx(db)).filter((i) => k.active || (i !== "overdue" && i !== "due_soon"));
  const owners = ownerCandidates(db, k);
  // 今の担当者が候補にいない (退職・権限が変わった) ときも選択肢に出して、変えるまで値を保つ
  const ownerOptions = k.ownerId && !owners.some((u) => u.id === k.ownerId) ? [...owners, ...db.users.filter((u) => u.id === k.ownerId)] : owners;
  const interval = entryInterval(rules, k);
  const content = (
    <Card>
      <CardHeader title="内容" description={fromSheet ? "スプレッドシートの内容 (ここでは変えられません)" : undefined} />
      <div className="text-sm leading-relaxed whitespace-pre-wrap text-ink">{k.body}</div>
      {k.tags.length > 0 && <p className="mt-3 text-xs text-ink-3">タグ: {k.tags.join("・")}</p>}
    </Card>
  );

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader
        title={k.title}
        back={{ href: "/knowledge", label: "社内資料" }}
        badge={
          <span className="flex flex-wrap gap-1">
            {k.active ? <Badge tone="good">AI に使う</Badge> : <Badge tone="warn">AI に使わない</Badge>}
            <Badge tone="info" dot={false}>{KNOWLEDGE_VISIBILITY_LABEL[k.visibility ?? "all"]}</Badge>
            {issues.map((i) => <Badge key={i} tone={KNOWLEDGE_ISSUE[i].tone}>{KNOWLEDGE_ISSUE[i].label}</Badge>)}
          </span>
        }
        description={`${k.category || "その他"}${k.recordDate ? ` · 日付 ${fmtDate(k.recordDate)}` : ""} · 登録 ${fmtDateTime(k.createdAt)} ${userName(k.createdBy)} · 更新 ${fmtDateTime(k.updatedAt)} ${userName(k.updatedBy ?? k.createdBy)}`}
      />
      {fromSheet && (
        <Note tone="warn">
          この資料はスプレッドシート{sheet ? <>「<Link href={`/knowledge/sources/${sheet.id}`} className="text-accent hover:underline">{sheet.label}</Link>」</> : ""}から取り込んだものです (同期は一方向: シート → システム)。タイトル・内容・分類・タグはシートで直してください (次の同期で反映)。担当者・見られる人・確かめる間隔・次に確かめる日はここで変えられます (シートに「見られる人」「担当者」「次回確認日」の列があれば、シートの値が優先されます)。
        </Note>
      )}
      {k.source === "file" && <p className="mb-2 text-xs text-ink-3">取込元のファイル: {k.sourceRef}</p>}
      <div className="mt-4 grid grid-cols-1 gap-4 @4xl:grid-cols-3">
        <div className="min-w-0 space-y-4 @4xl:col-span-2">
          <Card>
            <CardHeader
              title="内容の確認"
              description={`担当者が定期的に内容を確かめ、今も正しければ「確認した」を押します (次に確かめる日 = 今日 + ${interval} 日)。期限を過ぎると担当者に知らせ、AI は古い可能性を添えて答えます`}
              action={
                editable ? (
                  <form action={confirmKnowledge.bind(null, k.id)}>
                    <Button type="submit" size="sm">確認した (内容は今も正しい)</Button>
                  </form>
                ) : undefined
              }
            />
            <Dl
              items={[
                ["担当者", k.ownerId ? userName(k.ownerId) : <span className="text-warn-ink">なし</span>],
                ["次に確かめる日", k.reviewDue ? <span className={issues.includes("overdue") ? "font-medium text-critical-ink" : issues.includes("due_soon") ? "text-warn-ink" : undefined}>{fmtDate(k.reviewDue)}</span> : <span className="text-warn-ink">未設定</span>],
                ["確かめる間隔", `${intervalLabel(interval)}${k.reviewIntervalDays ? "" : " (分類の既定)"}`],
                ["最後に確かめた", k.reviewedAt ? `${fmtDateTime(k.reviewedAt)} ${userName(k.reviewedBy)}` : "記録なし"],
              ]}
            />
            {issues.filter((i) => i !== "overdue" && i !== "due_soon").length > 0 && (
              <ul className="mt-3 space-y-0.5 text-xs text-warn-ink">
                {issues.filter((i) => i !== "overdue" && i !== "due_soon").map((i) => <li key={i}>・{KNOWLEDGE_ISSUE[i].hint}</li>)}
              </ul>
            )}
          </Card>
          {fromSheet || !editable ? content : null}
          {editable && (
            <Card>
              <CardHeader title={fromSheet ? "管理の項目" : "内容と管理の項目"} />
              <form action={updateKnowledge.bind(null, k.id)} className="space-y-3">
                {!fromSheet && (
                  <>
                    <Field label="タイトル" required><Input name="title" defaultValue={k.title} required maxLength={200} /></Field>
                    <Field label="分類" required>
                      <Input name="category" defaultValue={k.category} required list="knowledge-categories" />
                      <datalist id="knowledge-categories">{categories.map((c) => <option key={c} value={c} />)}</datalist>
                    </Field>
                    <Field label="内容" required><Textarea name="body" defaultValue={k.body} required className="min-h-[260px]" /></Field>
                    <Field label="タグ (読点・空白区切り)"><Input name="tags" defaultValue={k.tags.join("、")} /></Field>
                  </>
                )}
                <div className="grid grid-cols-1 gap-2 @xl:grid-cols-2">
                  <Field label="見られる人" required hint="AI も同じ範囲で回答に使います">
                    <Select name="visibility" required defaultValue={k.visibility ?? "all"}>
                      {VIS_KEYS.filter((v) => canViewKnowledge(user, { visibility: v })).map((v) => <option key={v} value={v}>{KNOWLEDGE_VISIBILITY_LABEL[v]}</option>)}
                    </Select>
                  </Field>
                  {!fromSheet && <Field label="日付 (会議・決定の日)"><Input name="recordDate" type="date" defaultValue={k.recordDate} /></Field>}
                  <Field label="担当者" required hint="社内資料を編集でき、この資料を見られる人">
                    <Select name="ownerId" required defaultValue={k.ownerId ?? ""}>
                      <option value="" disabled>選んでください</option>
                      {ownerOptions.map((u) => <option key={u.id} value={u.id}>{u.name}{u.active ? "" : " (無効)"}</option>)}
                    </Select>
                  </Field>
                  <Field label="確かめる間隔">
                    <Select name="reviewIntervalDays" defaultValue={k.reviewIntervalDays ? String(k.reviewIntervalDays) : ""}>
                      <option value="">分類の既定 ({intervalFor(rules, k.category)} 日)</option>
                      {REVIEW_INTERVAL_CHOICES.map((d) => <option key={d} value={d}>{intervalLabel(d)}</option>)}
                    </Select>
                  </Field>
                  <Field label="次に確かめる日" required><Input name="reviewDue" type="date" required defaultValue={k.reviewDue} /></Field>
                </div>
                <input type="hidden" name="activeShown" value="1" />
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="active" defaultChecked={k.active} className="h-4 w-4" /> AI の回答に使う</label>
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="confirm" className="h-4 w-4" /> 保存と同時に「確認した」にする (次に確かめる日 = 今日 + 間隔)</label>
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" size="sm">保存する</Button>
                  {!fromSheet && <Button type="submit" size="sm" variant="danger" formAction={deleteKnowledge.bind(null, k.id)} formNoValidate>削除する</Button>}
                </div>
              </form>
            </Card>
          )}
        </div>
        <HistoryCard db={db} user={user} targets={[{ entity: "knowledge", id: k.id }]} />
      </div>
    </div>
  );
}
