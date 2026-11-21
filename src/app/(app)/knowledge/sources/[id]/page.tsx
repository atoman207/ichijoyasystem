import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canEditKnowledge, canManageKnowledgeSources, canViewKnowledge } from "@/lib/auth/permissions";
import { userName } from "@/lib/db/queries";
import { fmtDateTime } from "@/lib/format";
import { KNOWLEDGE_CATEGORY_HINTS, KNOWLEDGE_VISIBILITY_LABEL, knowledgeSources } from "@/lib/knowledge";
import { REVIEW_INTERVAL_CHOICES, intervalLabel, ownerCandidates } from "@/lib/knowledge-review";
import { ROW_ACTION_LABEL, sheetPrefix, type SheetPlan } from "@/lib/knowledge-sheet";
import { cronHealth, previewSource, sourceHealth } from "@/lib/knowledge-sync";
import { removeKnowledgeSource, syncKnowledgeSource, updateKnowledgeSource } from "@/lib/actions/knowledge";
import { googleSheetsStatus } from "@/lib/google/sheets";
import { SYSTEM_USER } from "@/lib/notify/inbound";
import Link from "@/components/ui/Link";
import { Badge, Button, Card, CardHeader, Dl, Field, Flash, Input, LinkButton, Note, PageHeader, Select, Table, Td, Th, Tr } from "@/components/ui";

/** シートを読む (Google の応答待ち) ため、処理時間の上限を 60 秒にする */
export const maxDuration = 60;

const VIS_KEYS = Object.keys(KNOWLEDGE_VISIBILITY_LABEL) as (keyof typeof KNOWLEDGE_VISIBILITY_LABEL)[];

/**
 * 社内資料の取込元 (Google スプレッドシート) の画面: 状態・設定・行ごとの確認 (同期の前のプレビュー)・同期の記録
 * 見る: 社内資料を編集できる人 / 設定・同期・削除: 本部スタッフ・管理者
 */
export default async function KnowledgeSourcePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  const user = await requireUser();
  if (!canEditKnowledge(user)) redirect("/knowledge?err=" + encodeURIComponent("取込元の画面は店長・本部スタッフ・管理者が見られます。"));
  const db = getDb();
  const src = knowledgeSources(db).find((s) => s.id === id);
  if (!src) notFound();
  const manage = canManageKnowledgeSources(user);
  const health = sourceHealth(src);
  const cron = cronHealth(db);
  const gs = googleSheetsStatus();
  const items = db.knowledge.filter((k) => k.sourceRef?.startsWith(sheetPrefix(src.id)));
  const owners = ownerCandidates(db, { visibility: src.visibility ?? "all" });
  const preview = sp.preview === "1" && manage ? await previewSource(src.id) : undefined;
  const who = (by: string) => (by === SYSTEM_USER ? "定期" : userName(by));

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader title={src.label} back={{ href: "/knowledge", label: "社内資料" }} badge={<Badge tone={health.tone}>{health.label}</Badge>} description="Google スプレッドシートの取込元。同期は一方向 (シート → システム) で、システムからシートには書き込みません" />
      <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-3">
        <div className="min-w-0 space-y-4 @4xl:col-span-2">
          <Card>
            <CardHeader title="同期の状態" action={<LinkButton href={src.url} target="_blank" variant="secondary" size="sm">シートを開く</LinkButton>} />
            <Dl
              items={[
                ["最後に成功", src.lastSuccessAt ? fmtDateTime(src.lastSuccessAt) : <span className="text-warn-ink">なし</span>],
                ["最後に試みた", src.lastSyncedAt ? `${fmtDateTime(src.lastSyncedAt)} (${src.lastResult ?? "-"})` : "まだ同期していません"],
                ["続けて失敗", src.failCount ? <span className="text-critical-ink">{src.failCount} 回</span> : "なし"],
                ["取り込んだ資料", `${items.length} 件 (AI に使う ${items.filter((k) => k.active).length} 件)`],
                ["定期の同期", <span key="c" className={cron.ok ? undefined : "text-critical-ink"}>{cron.detail}</span>],
                ["読み取り", gs.configured ? `サービスアカウント ${gs.email} (シートの「共有」で閲覧者に追加) → だめならリンクの共有` : gs.error ? `サービスアカウントの鍵の誤り: ${gs.error}` : "リンクの共有 (リンクを知っている全員が閲覧できる設定のシート)"],
              ]}
            />
            {src.lastError && <Note tone="warn">最後の失敗の理由: {src.lastError}</Note>}
            <p className="mt-3 text-[11px] text-ink-3">失敗したときは、取込元の担当者と本部スタッフ・管理者に通知します (同じ失敗は 24 時間に 1 回。直ったら「復旧しました」)。失敗している間も、社内資料は前に取り込んだ内容のまま使われます。</p>
          </Card>

          {manage && !preview && (
            <Card>
              <CardHeader title="シートの行を確認して同期する" description="シートを読み、行ごとに「追加・更新・変更なし・取り込まない (理由)」と、消える資料を表示します。確かめてから同期してください" />
              <LinkButton href={`/knowledge/sources/${src.id}?preview=1`} size="sm">シートを確認する</LinkButton>
            </Card>
          )}
          {preview && !preview.ok && (
            <Card>
              <CardHeader title="シートを読めませんでした" />
              <Note tone="warn">{preview.message}</Note>
              <LinkButton href={`/knowledge/sources/${src.id}?preview=1`} size="sm" variant="secondary">もう一度読む</LinkButton>
            </Card>
          )}
          {preview?.ok && <PlanCard plan={preview.preview.plan} via={preview.preview.via} sourceId={src.id} />}

          <Card>
            <CardHeader title="同期の記録" description="新しい順に 20 件" />
            {!src.history?.length ? (
              <p className="text-xs text-ink-3">まだ記録がありません。</p>
            ) : (
              <Table minWidth="min-w-[560px]">
                <thead>
                  <tr><Th>日時</Th><Th>結果</Th><Th>実行</Th><Th>内容</Th></tr>
                </thead>
                <tbody>
                  {src.history.map((h, i) => (
                    <Tr key={`${h.at}-${i}`}>
                      <Td className="whitespace-nowrap">{fmtDateTime(h.at)}</Td>
                      <Td>{h.ok ? <Badge tone="good">成功</Badge> : <Badge tone="critical">失敗</Badge>}</Td>
                      <Td className="whitespace-nowrap">{h.trigger === "cron" ? "定期" : who(h.by)}</Td>
                      <Td className="text-xs">{h.result}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </div>

        <div className="min-w-0 space-y-4">
          <Card>
            <CardHeader title="取込元の設定" description="担当者・見られる人・確かめる間隔は、シートに列がないときに新しく増える資料に付けます" />
            <form action={updateKnowledgeSource.bind(null, src.id)} className="space-y-2">
              <fieldset disabled={!manage} className="space-y-2">
                <Field label="名前"><Input name="label" defaultValue={src.label} maxLength={60} /></Field>
                <Field label="シートの URL" required><Input name="url" defaultValue={src.url} required /></Field>
                <Field label="分類 (列がないとき)">
                  <Input name="category" defaultValue={src.category} list="knowledge-categories" />
                  <datalist id="knowledge-categories">{KNOWLEDGE_CATEGORY_HINTS.map((c) => <option key={c} value={c} />)}</datalist>
                </Field>
                <Field label="担当者 (列がないとき)" required>
                  <Select name="ownerId" required defaultValue={src.ownerId ?? ""}>
                    <option value="" disabled>選んでください</option>
                    {owners.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </Select>
                </Field>
                <Field label="見られる人 (列がないとき)" required>
                  <Select name="visibility" required defaultValue={src.visibility ?? "all"}>
                    {VIS_KEYS.filter((v) => canViewKnowledge(user, { visibility: v })).map((v) => <option key={v} value={v}>{KNOWLEDGE_VISIBILITY_LABEL[v]}</option>)}
                  </Select>
                </Field>
                <Field label="確かめる間隔">
                  <Select name="reviewIntervalDays" defaultValue={src.reviewIntervalDays ? String(src.reviewIntervalDays) : ""}>
                    <option value="">分類の既定</option>
                    {REVIEW_INTERVAL_CHOICES.map((d) => <option key={d} value={d}>{intervalLabel(d)}</option>)}
                  </Select>
                </Field>
                {manage && <Button type="submit" size="sm" variant="secondary">設定を保存する</Button>}
              </fieldset>
            </form>
          </Card>
          <Card>
            <CardHeader title="シートの書き方" />
            <ul className="space-y-1 text-xs text-ink-2">
              <li>・1 行目は見出し。「タイトル」(質問・項目) と「内容」(回答・説明) は必須</li>
              <li>・「分類」「タグ」「見られる人」(全員・店長以上・本部以上・管理者のみ)「担当者」(氏名かログイン ID)「次回確認日」(2026-12-01)「日付」(会議・決定の日) の列があれば使います</li>
              <li>・ほかの列は「見出し: 値」として内容に足します</li>
              <li>・同じタイトルの行は 1 行目だけを取り込みます。内容が空の行・値の誤りのある行は取り込まず、登録済みならそのまま残します</li>
              <li>・シートから消した行の資料は削除します。半分以上 (5 件以上) が消える同期は自動では行わず、知らせます</li>
            </ul>
          </Card>
          {manage && (
            <Card>
              <CardHeader title="取込元を削除" description="この取込元と、そこから取り込んだ資料をすべて削除します (シートは変わりません)" />
              <form action={removeKnowledgeSource.bind(null, src.id)}>
                <Button type="submit" size="sm" variant="danger">取込元と資料 {items.length} 件を削除する</Button>
              </form>
            </Card>
          )}
          <p className="text-xs"><Link href={`/knowledge?q=&category=`} className="text-accent hover:underline">社内資料の一覧へ</Link></p>
        </div>
      </div>
    </div>
  );
}

/** 同期の計画 (行ごとの確認) */
function PlanCard({ plan, via, sourceId }: { plan: SheetPlan; via: string; sourceId: string }) {
  const c = plan.counts;
  const blocked = plan.sheetErrors.length > 0;
  return (
    <Card>
      <CardHeader title="シートの確認結果 (まだ同期していません)" description={`${via} · 見出し: ${Object.entries(plan.columns).filter(([k]) => k !== "extra").map(([k, v]) => `${v} (${COL_JA[k] ?? k})`).join("・") || "なし"}${plan.columns.extra.length ? ` · 内容に足す列: ${plan.columns.extra.join("・")}` : ""}`} />
      {blocked && <Note tone="warn">{plan.sheetErrors.join(" ")}</Note>}
      <div className="mb-3 flex flex-wrap gap-2 text-xs">
        <Badge tone="good">追加 {c.add}</Badge>
        <Badge tone="info">更新 {c.update}</Badge>
        <Badge tone="neutral">変更なし {c.unchanged}</Badge>
        <Badge tone={c.skip ? "critical" : "neutral"}>取り込まない {c.skip}</Badge>
        <Badge tone={c.remove ? "warn" : "neutral"}>削除 {c.remove}</Badge>
        {c.warnings > 0 && <Badge tone="warn">注意のある行 {c.warnings}</Badge>}
      </div>
      {plan.truncated && <Note tone="warn">行が多いため、先頭の 2,000 行だけを取り込みます。シートを分けてください。</Note>}
      {plan.rows.some((r) => r.action !== "unchanged" || r.issues.length) && (
        <Table minWidth="min-w-[640px]">
          <thead>
            <tr><Th>行</Th><Th>タイトル</Th><Th>扱い</Th><Th>確認の結果</Th></tr>
          </thead>
          <tbody>
            {plan.rows.filter((r) => r.action !== "unchanged" || r.issues.length).slice(0, 300).map((r) => (
              <Tr key={r.line}>
                <Td align="right">{r.line}</Td>
                <Td className="max-w-[18rem] truncate">{r.entryId ? <Link href={`/knowledge/${r.entryId}`} className="text-accent hover:underline">{r.title}</Link> : r.title}</Td>
                <Td><Badge tone={ROW_ACTION_LABEL[r.action].tone}>{ROW_ACTION_LABEL[r.action].label}</Badge></Td>
                <Td className="text-xs">
                  {r.changes?.length ? <div className="text-ink-2">変わる項目: {r.changes.join("・")}</div> : null}
                  {r.issues.map((x, i) => <div key={i} className={x.level === "error" ? "text-critical-ink" : "text-warn-ink"}>{x.level === "error" ? "取り込めない: " : "注意: "}{x.message}</div>)}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
      {plan.kept.length > 0 && <p className="mt-2 text-xs text-ink-2">取り込めない行のため、前の内容のまま残す資料: {plan.kept.map((k) => k.title).join("・")}</p>}
      {plan.remove.length > 0 && (
        <div className="mt-2 text-xs text-warn-ink">
          シートから消えたため削除する資料 ({plan.remove.length} 件): {plan.remove.slice(0, 20).map((k) => k.title).join("・")}{plan.remove.length > 20 ? " ほか" : ""}
        </div>
      )}
      <form action={syncKnowledgeSource.bind(null, sourceId)} className="mt-4 space-y-2 border-t border-line pt-3">
        <input type="hidden" name="hash" value={plan.hash} />
        {plan.massDelete && (
          <label className="flex items-start gap-2 text-sm text-critical-ink">
            <input type="checkbox" name="allowMassDelete" required className="mt-0.5 h-4 w-4" />
            登録済みの資料の半分以上 ({plan.remove.length} 件) が削除されます。シートの行を消したのは意図どおりで、削除してよいことを確かめました
          </label>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" disabled={blocked}>この内容で同期する</Button>
          <LinkButton href={`/knowledge/sources/${sourceId}?preview=1`} size="sm" variant="secondary">読み直す</LinkButton>
        </div>
        <p className="text-[11px] text-ink-3">確認したあとにシートが変わっていたら、同期せずにもう一度確認をお願いします。取り込まない行は、シートを直すと次の同期で取り込みます。</p>
      </form>
    </Card>
  );
}

const COL_JA: Record<string, string> = { title: "タイトル", body: "内容", category: "分類", tags: "タグ", visibility: "見られる人", owner: "担当者", reviewDue: "次回確認日", recordDate: "日付" };
