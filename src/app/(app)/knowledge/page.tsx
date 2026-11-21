import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canEditKnowledge, canManageKnowledgeSources, canViewKnowledge } from "@/lib/auth/permissions";
import { userName } from "@/lib/db/queries";
import { fmtDate, fmtDateTime, toDateKey } from "@/lib/format";
import type { KnowledgeEntry, User } from "@/lib/db/types";
import { KNOWLEDGE_CATEGORY_HINTS, KNOWLEDGE_VISIBILITY_LABEL, MINUTES_TEMPLATE, knowledgeSources, searchKnowledge } from "@/lib/knowledge";
import { ISSUE_ORDER, KNOWLEDGE_ISSUE, REVIEW_INTERVAL_CHOICES, addDays, intervalFor, intervalLabel, knowledgeIssues, knowledgeQuality, ownerCandidates, reviewCtx, reviewSettings, type KnowledgeIssue } from "@/lib/knowledge-review";
import { cronHealth, sourceHealth } from "@/lib/knowledge-sync";
import { addKnowledgeSource, bulkUpdateKnowledge, createKnowledge, importKnowledgeFile, saveKnowledgeReviewRules } from "@/lib/actions/knowledge";
import { aiEnabled } from "@/lib/ai/provider";
import { googleSheetsStatus } from "@/lib/google/sheets";
import Link from "@/components/ui/Link";
import { KnowledgeSelectAll } from "@/components/features/KnowledgeSelectAll";
import { Badge, Button, Card, CardHeader, Field, Flash, Input, Note, PageHeader, Pager, Select, Textarea, paginate } from "@/components/ui";

export const maxDuration = 60;

const SOURCE_LABEL = { manual: "画面で登録", sheet: "スプレッドシート", file: "ファイル" } as const;
const VIS_KEYS = Object.keys(KNOWLEDGE_VISIBILITY_LABEL) as (keyof typeof KNOWLEDGE_VISIBILITY_LABEL)[];
const HEALTH_FILTERS: Record<string, string> = { mine: "自分の担当", ...Object.fromEntries(ISSUE_ORDER.map((k) => [k, KNOWLEDGE_ISSUE[k].label])) };

/**
 * 社内資料 (ナレッジ): AI アシスタントが回答の根拠にする資料
 * - 閲覧・検索: 全員 (見られる人の範囲) / 登録・修正・確認・ファイル取込・まとめて変更: 店長・本部スタッフ・管理者
 * - スプレッドシートの登録・同期・確認のルール: 本部スタッフ・管理者
 * - どの資料にも 担当者・次に確かめる日・見られる人・分類 を付け、期限を過ぎたものは「確認期限切れ」(src/lib/knowledge-review.ts)
 */
export default async function KnowledgePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const editable = canEditKnowledge(user);
  const manageSources = canManageKnowledgeSources(user);
  const q = (sp.q ?? "").trim();
  const cat = sp.category ?? "";
  const health = sp.health && sp.health in HEALTH_FILTERS ? sp.health : "";
  const ownerFilter = sp.owner ?? "";
  const categories = [...new Set([...KNOWLEDGE_CATEGORY_HINTS, ...db.knowledge.map((k) => k.category).filter(Boolean)])];
  const ctx = reviewCtx(db);
  const rules = reviewSettings(db);
  // 見られる範囲の資料だけ (visibility)
  const readable = db.knowledge.filter((k) => canViewKnowledge(user, k));
  const issuesOf = new Map(readable.map((k) => [k.id, knowledgeIssues(k, ctx).filter((i) => k.active || (i !== "overdue" && i !== "due_soon"))]));
  const quality = knowledgeQuality(readable, ctx);
  const mineCount = readable.filter((k) => k.ownerId === user.id).length;
  const filtered = readable.filter(
    (k) =>
      (!cat || k.category === cat) &&
      (!ownerFilter || (ownerFilter === "none" ? !k.ownerId : k.ownerId === ownerFilter)) &&
      (!health || (health === "mine" ? k.ownerId === user.id : issuesOf.get(k.id)?.includes(health as KnowledgeIssue))),
  );
  const hits = q ? searchKnowledge(filtered, q, { limit: 50, minCoverage: 0.15 }) : [];
  const byDue = (a: KnowledgeEntry, b: KnowledgeEntry) => (a.reviewDue ?? "0000").localeCompare(b.reviewDue ?? "0000");
  const list = q ? hits.map((h) => h.entry) : [...filtered].sort(health ? byDue : (a, b) => (b.recordDate ?? b.updatedAt).localeCompare(a.recordDate ?? a.updatedAt));
  const minutes = sp.template === "minutes";
  const snippets = new Map(hits.map((h) => [h.entry.id, h.snippet]));
  const paged = paginate(list, sp.page, 50);
  const sources = knowledgeSources(db);
  const owners = ownerCandidates(db);
  const ownerName = (id?: string) => (id ? (db.users.find((u) => u.id === id)?.name ?? "(不明)") : "なし");
  const returnTo = `/knowledge?${new URLSearchParams(Object.entries(sp).filter(([k, v]) => v && !["msg", "err"].includes(k)) as [string, string][]).toString()}`;
  const filterHref = (patch: Record<string, string>) => `/knowledge?${new URLSearchParams(Object.entries({ q, category: cat, owner: ownerFilter, health, ...patch }).filter(([, v]) => v)).toString()}`;
  const gs = googleSheetsStatus();
  const cron = cronHealth(db);

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader title="社内資料 (ナレッジ)" description={`AI アシスタントは、ここにある資料をもとに回答します。登録 ${readable.length} 件 (うち AI に使う ${quality.active} 件)`} />
      <Note>
        商品・価格の目安、施工の手順、お客様対応の決まり、社内ルール、議事録、よくある質問などを登録してください。どの資料にも<strong>担当者・次に確かめる日・見られる人・分類</strong>を付け、担当者が定期的に内容を確かめて「確認した」を押します。期限を過ぎた資料は担当者に知らせ、AI は「古い可能性がある」と添えて答えます。
      </Note>

      <Card className="mt-4">
        <CardHeader
          title="資料の管理の状況"
          description={`整っている資料 ${quality.ready} / ${quality.total} 件 (担当者・次に確かめる日・見られる人・分類がそろい、期限内のもの)。期限が近いとみなすのは ${rules.soonDays} 日前から`}
          action={health || ownerFilter ? <Link href={filterHref({ health: "", owner: "" })} className="text-xs text-accent hover:underline">絞り込みを外す</Link> : undefined}
        />
        <div className="flex flex-wrap gap-2">
          <Link href={filterHref({ health: "mine", owner: "" })} className={`rounded-full border px-3 py-1 text-xs ${health === "mine" ? "border-accent bg-accent-soft text-accent-ink" : "border-line hover:bg-subtle"}`}>
            自分の担当 {mineCount} 件
          </Link>
          {ISSUE_ORDER.map((k) => (
            <Link key={k} href={filterHref({ health: k, owner: "" })} title={KNOWLEDGE_ISSUE[k].hint} className={`rounded-full border px-3 py-1 text-xs ${health === k ? "border-accent bg-accent-soft text-accent-ink" : quality.counts[k] ? (KNOWLEDGE_ISSUE[k].tone === "critical" ? "border-critical/40 text-critical-ink hover:bg-critical-soft" : "border-warn/40 text-warn-ink hover:bg-warn-soft") : "border-line text-ink-3 hover:bg-subtle"}`}>
              {KNOWLEDGE_ISSUE[k].label} {quality.counts[k]} 件
            </Link>
          ))}
        </div>
        {health && health !== "mine" && <p className="mt-2 text-xs text-ink-3">{KNOWLEDGE_ISSUE[health as KnowledgeIssue].hint}</p>}
      </Card>

      <form method="get" className="mt-4 mb-4 flex flex-wrap items-end gap-2">
        <div className="w-full @xl:w-72"><Input name="q" defaultValue={q} placeholder="資料を検索 (例: 支払方法 / 畳表の種類)" /></div>
        <Select name="category" defaultValue={cat} className="w-auto" aria-label="分類">
          <option value="">すべての分類</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </Select>
        <Select name="owner" defaultValue={ownerFilter} className="w-auto" aria-label="担当者">
          <option value="">すべての担当者</option>
          <option value="none">担当者なし</option>
          {owners.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </Select>
        <Select name="health" defaultValue={health} className="w-auto" aria-label="管理の状況">
          <option value="">管理の状況: すべて</option>
          {Object.entries(HEALTH_FILTERS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
        <Button type="submit" variant="secondary">探す</Button>
        <span className="text-xs text-ink-3">{list.length} 件{q ? " (AI が回答に使う順)" : health ? " (次に確かめる日の順)" : ""}</span>
      </form>

      <div className="grid grid-cols-1 gap-4 @5xl:grid-cols-3">
        <div className="min-w-0 @5xl:col-span-2">
          <form id="knowledge-bulk" action={bulkUpdateKnowledge}>
            <input type="hidden" name="returnTo" value={returnTo} />
            {editable && paged.items.length > 0 && <div className="mb-2"><KnowledgeSelectAll formId="knowledge-bulk" /></div>}
            <ul className="divide-y divide-line rounded-xl border border-line bg-panel">
              {paged.items.length === 0 && <li className="px-4 py-10 text-center text-sm text-ink-3">{q || health || ownerFilter ? "当てはまる資料はありません" : "まだ資料がありません。右の欄から登録してください"}</li>}
              {paged.items.map((k) => {
                const issues = issuesOf.get(k.id) ?? [];
                return (
                  <li key={k.id} className="flex gap-3 px-4 py-3">
                    {editable && <input type="checkbox" name="ids" value={k.id} aria-label={`${k.title} を選ぶ`} className="mt-1 h-4 w-4 shrink-0" />}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link href={`/knowledge/${k.id}`} className="font-medium text-accent hover:underline">{k.title}</Link>
                        <Badge dot={false}>{k.category || "その他"}</Badge>
                        <Badge dot={false} tone={k.source === "sheet" ? "info" : k.source === "file" ? "accent" : "neutral"}>{SOURCE_LABEL[k.source]}</Badge>
                        {k.visibility && k.visibility !== "all" && <Badge dot={false} tone="info">{KNOWLEDGE_VISIBILITY_LABEL[k.visibility]}</Badge>}
                        {!k.active && <Badge tone="warn" dot={false}>AI に使わない</Badge>}
                        {issues.filter((i) => i !== "no_category" && i !== "no_visibility").map((i) => <Badge key={i} tone={KNOWLEDGE_ISSUE[i].tone}>{KNOWLEDGE_ISSUE[i].label}</Badge>)}
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs text-ink-2">{snippets.get(k.id) ?? k.body.slice(0, 160)}</p>
                      <p className="mt-0.5 text-[11px] text-ink-3">
                        担当 {ownerName(k.ownerId)} · 次の確認 {k.reviewDue ? fmtDate(k.reviewDue) : "未設定"}{k.reviewedAt ? ` · 最終確認 ${fmtDate(k.reviewedAt)} ${userName(k.reviewedBy)}` : ""} · 更新 {fmtDateTime(k.updatedAt)}
                        {issues.includes("no_category") || issues.includes("no_visibility") ? ` · ${issues.filter((i) => i === "no_category" || i === "no_visibility").map((i) => KNOWLEDGE_ISSUE[i].label).join("・")}` : ""}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
            {editable && paged.items.length > 0 && <BulkBar user={user} owners={owners} categories={categories} />}
          </form>
          <Pager paged={paged} path="/knowledge" sp={sp} />
        </div>

        <div className="min-w-0 space-y-4">
          {editable && (
            <Card>
              <CardHeader title={minutes ? "議事録を登録" : "資料を登録"} action={minutes ? <Link href="/knowledge" className="text-xs text-accent hover:underline">ふつうの資料にする</Link> : <Link href="/knowledge?template=minutes" className="text-xs text-accent hover:underline">議事録のひな形</Link>} />
              <form action={createKnowledge} className="space-y-2">
                <Field label="タイトル" required><Input name="title" required maxLength={200} placeholder={minutes ? "例: 2026年11月 店長会議" : "例: お支払い方法"} /></Field>
                <Field label="分類" required>
                  <Input name="category" required list="knowledge-categories" placeholder="例: よくある質問" defaultValue={minutes ? "議事録・決定事項" : undefined} />
                  <datalist id="knowledge-categories">{categories.map((c) => <option key={c} value={c} />)}</datalist>
                </Field>
                <Field label="内容" required><Textarea name="body" required className={minutes ? "min-h-[260px]" : "min-h-[140px]"} defaultValue={minutes ? MINUTES_TEMPLATE : undefined} placeholder="例: 現金・クレジットカード (VISA・マスター)・PayPay・銀行振込に対応。振込の場合は納品後 2 週間以内。" /></Field>
                <div className="grid grid-cols-1 gap-2 @xl:grid-cols-2">
                  <Field label="見られる人" required hint="AI も同じ範囲で回答に使います">
                    <Select name="visibility" required defaultValue={minutes ? "manager" : "all"}>
                      {VIS_KEYS.filter((v) => canViewKnowledge(user, { visibility: v })).map((v) => <option key={v} value={v}>{KNOWLEDGE_VISIBILITY_LABEL[v]}</option>)}
                    </Select>
                  </Field>
                  <Field label="日付 (会議・決定の日)"><Input name="recordDate" type="date" defaultValue={minutes ? toDateKey(new Date()) : undefined} /></Field>
                  <Field label="担当者" required hint="内容に責任を持ち、定期的に確かめる人">
                    <Select name="ownerId" required defaultValue={user.id}>
                      {owners.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                    </Select>
                  </Field>
                  <Field label="確かめる間隔"><IntervalSelect /></Field>
                </div>
                <Field label="タグ (読点・空白区切り)"><Input name="tags" placeholder="例: 支払い、カード、PayPay" /></Field>
                <p className="text-[11px] text-ink-3">次に確かめる日は、登録日 + 間隔 (分類の既定: 価格 {intervalFor(rules, "商品・価格")} 日・議事録 {intervalFor(rules, "議事録・決定事項")} 日・その他 {rules.defaultDays} 日) です。資料の画面で変えられます。</p>
                <Button type="submit" size="sm">登録する</Button>
              </form>
            </Card>
          )}
          {editable && (
            <Card>
              <CardHeader title="ファイルから取り込む" description={`テキスト (.txt・.md): 見出し (# ・■・【】) ごとに 1 件 / CSV: 1 行目に「タイトル」「内容」(と「分類」「タグ」) の見出し / PDF・写真: ${aiEnabled() ? "AI で文字にして取り込み" : "AI の設定が必要"}。マニュアル・議事録は、取り込む前に見られる人を確かめてください`} />
              <form action={importKnowledgeFile} className="space-y-2">
                <input type="file" name="file" required accept=".txt,.md,.csv,.tsv,.pdf,.jpg,.jpeg,.png,.webp" className="block w-full text-xs" />
                <div className="grid grid-cols-1 gap-2 @xl:grid-cols-2">
                  <Field label="分類 (ファイルに分類がないとき)" required><Input name="category" required list="knowledge-categories" placeholder="例: マニュアル" /></Field>
                  <Field label="見られる人" required>
                    <Select name="visibility" required defaultValue="all">
                      {VIS_KEYS.filter((v) => canViewKnowledge(user, { visibility: v })).map((v) => <option key={v} value={v}>{KNOWLEDGE_VISIBILITY_LABEL[v]}</option>)}
                    </Select>
                  </Field>
                  <Field label="担当者" required>
                    <Select name="ownerId" required defaultValue={user.id}>
                      {owners.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                    </Select>
                  </Field>
                  <Field label="確かめる間隔"><IntervalSelect /></Field>
                </div>
                <Button type="submit" size="sm" variant="secondary">取り込む</Button>
              </form>
            </Card>
          )}
          <Card>
            <CardHeader
              title="Google スプレッドシートとの連携"
              description={`指定したシートの内容を社内資料として取り込みます。同期は一方向 (シート → システム) で、システムからシートには書き込みません。毎時 15 分に自動で同期し、失敗したら担当者・本部・管理者に知らせます。${gs.email ? `シートは「共有」でサービスアカウント ${gs.email} を「閲覧者」に追加する (非公開のまま) か、` : "シートは"}「リンクを知っている全員が閲覧できる」共有にしてください`}
            />
            {gs.error && <Note tone="warn">サービスアカウントの鍵を読めません: {gs.error}</Note>}
            {sources.length > 0 && <p className={`mb-2 text-[11px] ${cron.ok ? "text-ink-3" : "text-critical-ink"}`}>{cron.detail}</p>}
            {sources.length === 0 && <p className="text-xs text-ink-3">登録されたシートはありません。</p>}
            <ul className="space-y-2">
              {sources.map((s) => {
                const h = sourceHealth(s);
                return (
                  <li key={s.id} className="rounded-lg border border-line p-2 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={`/knowledge/sources/${s.id}`} className="font-medium text-accent hover:underline">{s.label}</Link>
                      <Badge tone={h.tone}>{h.label}</Badge>
                    </div>
                    <div className="mt-0.5 text-ink-2">最終成功 {s.lastSuccessAt ? fmtDateTime(s.lastSuccessAt) : "なし"}{typeof s.lastCount === "number" ? ` · ${s.lastCount} 件` : ""} · 最後に試みた {s.lastSyncedAt ? fmtDateTime(s.lastSyncedAt) : "-"}</div>
                    {s.lastError && <div className="mt-0.5 text-critical-ink">{s.lastError}</div>}
                    <div className="mt-1"><Link href={`/knowledge/sources/${s.id}?preview=1`} className="text-accent hover:underline">シートの行を確認して同期する</Link></div>
                  </li>
                );
              })}
            </ul>
            {manageSources && (
              <form action={addKnowledgeSource} className="mt-3 space-y-2 border-t border-line pt-3">
                <Field label="シートの URL" required><Input name="url" required placeholder="https://docs.google.com/spreadsheets/d/…/edit#gid=0" /></Field>
                <div className="grid grid-cols-1 gap-2 @xl:grid-cols-2">
                  <Field label="名前"><Input name="label" placeholder="例: 商品・価格表" /></Field>
                  <Field label="分類 (列がないとき)"><Input name="category" list="knowledge-categories" placeholder="例: 商品・価格" /></Field>
                  <Field label="担当者 (列がないとき)" required>
                    <Select name="ownerId" required defaultValue={user.id}>
                      {owners.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                    </Select>
                  </Field>
                  <Field label="見られる人 (列がないとき)" required>
                    <Select name="visibility" required defaultValue="all">
                      {VIS_KEYS.filter((v) => canViewKnowledge(user, { visibility: v })).map((v) => <option key={v} value={v}>{KNOWLEDGE_VISIBILITY_LABEL[v]}</option>)}
                    </Select>
                  </Field>
                  <Field label="確かめる間隔"><IntervalSelect /></Field>
                </div>
                <Button type="submit" size="sm">登録してシートを確認する</Button>
                <p className="text-[11px] text-ink-3">シートの 1 行目に「タイトル」(または 質問・項目)「内容」(または 回答・説明) の見出しを入れてください。「分類」「タグ」「見られる人」「担当者」「次回確認日」「日付」の列があれば使います。登録すると、取り込む前に行ごとの確認結果 (追加・更新・取り込めない理由) を表示します。</p>
              </form>
            )}
          </Card>
          {manageSources && <ReviewRulesCard categories={categories} owners={owners} rules={rules} open={sp.panel === "rules"} />}
        </div>
      </div>
    </div>
  );
}

function ReviewRulesCard({ categories, owners, rules, open }: { categories: string[]; owners: User[]; rules: ReturnType<typeof reviewSettings>; open: boolean }) {
    return (
      <Card id="rules">
        <details open={open}>
          <summary className="cursor-pointer text-[15px] font-semibold text-ink">確認のルール</summary>
          <p className="mt-1 text-xs text-ink-3">分類ごとの確かめる間隔と、取込・同期で増えた資料の担当者。「確認した」を押すと、次に確かめる日 = 今日 + 間隔 になります (資料ごとの間隔があればそちら)。</p>
          <form action={saveKnowledgeReviewRules} className="mt-3 space-y-2">
            <div className="grid grid-cols-1 gap-2 @xl:grid-cols-3">
              <Field label="既定の担当者">
                <Select name="defaultOwnerId" defaultValue={rules.defaultOwnerId ?? ""}>
                  <option value="">なし (画面で割り当てる)</option>
                  {owners.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </Select>
              </Field>
              <Field label="既定の間隔 (日)"><Input name="defaultDays" type="number" min={7} max={1095} defaultValue={rules.defaultDays} /></Field>
              <Field label="期限が近い (日前から)"><Input name="soonDays" type="number" min={1} max={60} defaultValue={rules.soonDays} /></Field>
            </div>
            <div className="grid grid-cols-1 gap-x-3 gap-y-1 @xl:grid-cols-2">
              {categories.map((c, i) => (
                <label key={c} className="flex items-center justify-between gap-2 text-xs text-ink-2">
                  <span className="truncate">{c}</span>
                  <input type="hidden" name={`ivname_${i}`} value={c} />
                  <span className="flex items-center gap-1"><input name={`iv_${i}`} type="number" min={7} max={1095} defaultValue={intervalFor(rules, c)} className="field h-8 w-20 text-right" aria-label={`${c} の間隔 (日)`} /> 日</span>
                </label>
              ))}
            </div>
            <Button type="submit" size="sm" variant="secondary">ルールを保存する</Button>
          </form>
        </details>
      </Card>
    );
}

function IntervalSelect({ defaultValue }: { defaultValue?: number }) {
  return (
    <Select name="reviewIntervalDays" defaultValue={defaultValue ? String(defaultValue) : ""}>
      <option value="">分類の既定</option>
      {REVIEW_INTERVAL_CHOICES.map((d) => <option key={d} value={d}>{intervalLabel(d)}</option>)}
    </Select>
  );
}

/** 一覧で選んだ資料をまとめて変える (担当者の割り当て・見られる人・分類・間隔・次に確かめる日・確認した) */
function BulkBar({ user, owners, categories }: { user: User; owners: User[]; categories: string[] }) {
  const row = "grid grid-cols-1 items-center gap-2 @xl:grid-cols-[11rem_1fr]";
  const radio = (op: string, label: string, def?: boolean) => (
    <label className="flex items-center gap-2 text-xs font-medium text-ink">
      <input type="radio" name="op" value={op} defaultChecked={def} className="h-4 w-4" /> {label}
    </label>
  );
  return (
    <div className="mt-3 space-y-2 rounded-xl border border-line bg-subtle/50 p-3">
      <p className="text-xs font-medium text-ink">選んだ資料をまとめて変更</p>
      <div className={row}>{radio("confirm", "内容を確認した", true)}<span className="text-[11px] text-ink-3">次に確かめる日 = 今日 + 間隔</span></div>
      <div className={row}>
        {radio("owner", "担当者を割り当てる")}
        <Select name="value_owner" defaultValue="" aria-label="担当者">
          <option value="">選んでください</option>
          {owners.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </Select>
      </div>
      <div className={row}>
        {radio("visibility", "見られる人")}
        <Select name="value_visibility" defaultValue="" aria-label="見られる人">
          <option value="">選んでください</option>
          {VIS_KEYS.filter((v) => canViewKnowledge(user, { visibility: v })).map((v) => <option key={v} value={v}>{KNOWLEDGE_VISIBILITY_LABEL[v]}</option>)}
        </Select>
      </div>
      <div className={row}>
        {radio("category", "分類")}
        <Input name="value_category" list="knowledge-categories-bulk" placeholder="例: マニュアル" aria-label="分類" />
        <datalist id="knowledge-categories-bulk">{categories.map((c) => <option key={c} value={c} />)}</datalist>
      </div>
      <div className={row}>
        {radio("interval", "確かめる間隔")}
        <Select name="value_interval" defaultValue="" aria-label="確かめる間隔">
          <option value="">分類の既定</option>
          {REVIEW_INTERVAL_CHOICES.map((d) => <option key={d} value={d}>{intervalLabel(d)}</option>)}
        </Select>
      </div>
      <div className={row}>
        {radio("due", "次に確かめる日")}
        <Input name="value_due" type="date" defaultValue={addDays(toDateKey(new Date()), 30)} aria-label="次に確かめる日" />
      </div>
      <div className={row}>{radio("deactivate", "AI に使わない")}<span /></div>
      <div className={row}>{radio("activate", "AI に使う")}<span /></div>
      <Button type="submit" size="sm">選んだ資料に当てはめる</Button>
      <p className="text-[11px] text-ink-3">スプレッドシートの資料の分類はシートで変えてください。変更はすべて変更履歴に残ります。</p>
    </div>
  );
}
