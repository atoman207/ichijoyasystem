import { BookOpen, Bot, Database, HardDrive, PiggyBank, Sparkles } from "lucide-react";
import Link from "@/components/ui/Link";
import { Badge, Button, Card, CardHeader, Field, Input, Note, Select, Stat, Table, Td, Textarea, Th, Tr, EmptyRow } from "@/components/ui";
import { deleteChatbotQa, rebuildChatbot, saveChatbotQa, startChatbotTraining, stopChatbotTraining, toggleChatbotQa } from "@/lib/actions/chatbot";
import type { ChatbotStats, QaOrigin, QaRow } from "@/lib/chatbot/store";
import type { TrainState } from "@/lib/chatbot/train";
import { ROLE_LABEL } from "@/lib/constants";
import type { Role } from "@/lib/db/types";

const ORIGIN: Record<QaOrigin, { label: string; tone: "neutral" | "info" | "accent" | "good" }> = {
  seed: { label: "自動 (システムの説明)", tone: "neutral" },
  generated: { label: "学習 (AI の言い換え)", tone: "info" },
  ai: { label: "AI の回答", tone: "accent" },
  manual: { label: "管理者が登録", tone: "good" },
};

const SOURCE_LABEL: Record<string, string> = {
  database: "データベースの回答",
  data: "社内データ (集計・検索)",
  smalltalk: "あいさつ",
  docs: "資料の抜き出し",
  ai: "AI (OpenAI)",
  none: "回答できず",
};

const fmtBytes = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const fmtAt = (iso?: string) => (iso ? new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "-");

export function ChatbotAdmin({
  stats,
  train,
  pending,
  aiEnabled,
  list,
  sp,
}: {
  stats: ChatbotStats;
  train: TrainState;
  pending: number;
  aiEnabled: boolean;
  list: { rows: QaRow[]; total: number; page: number; size: number };
  sp: Record<string, string | undefined>;
}) {
  const saved = stats.asks.total - (stats.asks.bySource.ai ?? 0);
  const savedRate = stats.asks.total ? Math.round((saved / stats.asks.total) * 100) : 0;
  const editing = sp.edit ? list.rows.find((r) => String(r.id) === sp.edit) : undefined;
  const q = (extra: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ tab: "bot", q: sp.q, origin: sp.origin, flagged: sp.flagged, ...extra })) if (v) p.set(k, v);
    return `/ai?${p.toString()}`;
  };
  const returnTo = q({ page: sp.page });
  const pages = Math.max(1, Math.ceil(list.total / list.size));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @4xl:grid-cols-4">
        <Stat label="蓄えた質問と回答" value={`${stats.qa.total.toLocaleString()} 件`} sub={`自動 ${stats.qa.seed.toLocaleString()} / 学習 ${stats.qa.generated.toLocaleString()} / AI ${stats.qa.ai.toLocaleString()} / 登録 ${stats.qa.manual.toLocaleString()}`} icon={<Database />} />
        <Stat label={`AI を使わずに答えた割合 (直近 ${stats.asks.days} 日)`} value={`${savedRate}%`} sub={`質問 ${stats.asks.total.toLocaleString()} 件のうち AI ${(stats.asks.bySource.ai ?? 0).toLocaleString()} 件`} icon={<PiggyBank />} accent="good" />
        <Stat label="回答の根拠の資料" value={`${stats.docs.total} 件`} sub={`学習済み ${stats.docs.trained} 件 / 未学習 ${pending} 件`} icon={<BookOpen />} accent="info" />
        <Stat label="データベースの大きさ" value={fmtBytes(stats.sizeBytes)} sub={<span className="break-all">{stats.path}</span>} icon={<HardDrive />} accent="warn" />
      </div>

      <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-3">
        <Card className="@4xl:col-span-2">
          <CardHeader title="学習 (質問の言い換えを作る)" description="資料 1 件につき AI を 1 回だけ使い、社員が聞きそうな質問と回答を約 20 組作って蓄えます。普段の質問はこの蓄えから答えるので、AI の利用が減ります。内容が変わった資料だけを学習し直します。" icon={<Sparkles />} />
          {train.running ? (
            <div className="space-y-3">
              <div className="h-2 overflow-hidden rounded-full bg-subtle">
                <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${train.total ? Math.round((train.done / train.total) * 100) : 0}%` }} />
              </div>
              <p className="text-sm text-ink-2">
                学習中: {train.done} / {train.total} 件 (追加 {train.added.toLocaleString()} 組{train.failed ? `・失敗 ${train.failed} 件` : ""})。開始 {fmtAt(train.startedAt)}。画面を再読み込みすると進み具合を更新します。
              </p>
              <form action={stopChatbotTraining}>
                <Button variant="secondary" size="sm">学習を止める</Button>
              </form>
            </div>
          ) : (
            <div className="space-y-3">
              {train.startedAt && (
                <p className="text-sm text-ink-2">
                  前回: {fmtAt(train.startedAt)} 〜 {fmtAt(train.finishedAt)}、{train.done} / {train.total} 件、追加 {train.added.toLocaleString()} 組{train.failed ? `、失敗 ${train.failed} 件` : ""}。
                  {train.error && <span className="block text-critical-ink">{train.error}</span>}
                </p>
              )}
              {!aiEnabled && <Note tone="warn">AI の API キーが設定されていないため、学習できません (自動で作った質問とデータの回答は使えます)。</Note>}
              <div className="flex flex-wrap items-end gap-2">
                <form action={startChatbotTraining} className="flex flex-wrap items-end gap-2">
                  <Field label="学習する資料の数" hint={`未学習 ${pending} 件。空欄はすべて`}>
                    <Input name="limit" type="number" min={1} max={10000} placeholder="すべて" className="w-32" />
                  </Field>
                  <Button disabled={!aiEnabled || pending === 0}>学習を始める</Button>
                </form>
                <form action={rebuildChatbot}>
                  <Button variant="secondary">資料と自動の質問を作り直す</Button>
                </form>
              </div>
              <p className="text-xs text-ink-3">使い方・権限一覧・画面の説明・承認ルール・社内資料を変えると、次の質問のときに自動で作り直します (5 分ごとに確認)。</p>
            </div>
          )}
        </Card>

        <Card>
          <CardHeader title="どうやって答えたか" description={`直近 ${stats.asks.days} 日`} icon={<Bot />} />
          <ul className="space-y-1.5 text-sm">
            {Object.entries(SOURCE_LABEL).map(([k, label]) => (
              <li key={k} className="flex items-center justify-between gap-2">
                <span className="text-ink-2">{label}</span>
                <span className="font-semibold tnum text-ink">{(stats.asks.bySource[k] ?? 0).toLocaleString()} 件</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-2">
        <Card>
          <CardHeader title="回答できなかった質問" description="資料に見つからなかったもの。社内資料に追加するか、下で回答を登録してください" />
          {stats.recentNone.length ? (
            <ul className="space-y-1 text-sm">
              {stats.recentNone.map((a, i) => (
                <li key={i} className="flex gap-2">
                  <span className="shrink-0 text-xs text-ink-3 tnum">{fmtAt(a.at)}</span>
                  <Link href={`${q({})}&newq=${encodeURIComponent(a.question)}#chatbot-edit`} className="min-w-0 truncate text-accent hover:underline">{a.question}</Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink-3">ありません。</p>
          )}
        </Card>
        <Card>
          <CardHeader title="最近 AI が答えた質問" description="次からはデータベースの回答で答えます。違っていれば下の一覧で修正してください" />
          {stats.recentAi.length ? (
            <ul className="space-y-1 text-sm">
              {stats.recentAi.map((a, i) => (
                <li key={i} className="flex gap-2">
                  <span className="shrink-0 text-xs text-ink-3 tnum">{fmtAt(a.at)}</span>
                  <Link href={q({ q: a.question.slice(0, 30) })} className="min-w-0 truncate text-accent hover:underline">{a.question}</Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink-3">ありません。</p>
          )}
        </Card>
      </div>

      <Card id="chatbot-edit">
        <CardHeader title={editing ? "回答を修正する" : "回答を登録する"} description={editing ? "修正した回答は「管理者が登録」になり、自動の回答より優先されます。" : "よく聞かれる質問と正しい回答を登録します。似た聞き方の質問にも、この回答が使われます。"} />
        <form action={saveChatbotQa} className="grid grid-cols-1 gap-3 @3xl:grid-cols-2">
          <input type="hidden" name="returnTo" value={returnTo} />
          {editing && <input type="hidden" name="id" value={editing.id} />}
          <Field label="質問" required>
            <Input name="question" defaultValue={editing?.question ?? sp.newq ?? ""} maxLength={200} required placeholder="例: 見積の承認は誰がしますか" />
          </Field>
          {!editing && (
            <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
              <Field label="案内する画面 (任意)" hint="/ から始まるパス">
                <Input name="href" placeholder="/quotes" />
              </Field>
              <Field label="リンクの名前 (任意)">
                <Input name="hrefLabel" placeholder="見積" maxLength={30} />
              </Field>
            </div>
          )}
          <Field label="回答" required className="@3xl:col-span-2">
            <Textarea name="answer" rows={5} defaultValue={editing?.answer ?? ""} maxLength={3000} required />
          </Field>
          <div className="flex gap-2 @3xl:col-span-2">
            <Button>{editing ? "修正を保存" : "登録する"}</Button>
            {editing && <Link href={returnTo} className="inline-flex h-9 items-center px-3 text-sm text-ink-2 hover:text-ink">やめる</Link>}
          </div>
        </form>
      </Card>

      <Card padded={false}>
        <div className="p-4">
          <CardHeader title="蓄えた質問と回答" description={`${list.total.toLocaleString()} 件。👎 が多い回答・無効にした回答は使われません。`} />
          <form className="flex flex-wrap items-end gap-2" action="/ai">
            <input type="hidden" name="tab" value="bot" />
            <Field label="検索">
              <Input name="q" defaultValue={sp.q ?? ""} placeholder="質問・回答の言葉" className="w-56" />
            </Field>
            <Field label="種類">
              <Select name="origin" defaultValue={sp.origin ?? ""}>
                <option value="">すべて</option>
                {Object.entries(ORIGIN).map(([k, v]) => (
                  <option key={k} value={k}>{v.label}</option>
                ))}
              </Select>
            </Field>
            <label className="flex h-9 items-center gap-1.5 text-sm text-ink-2">
              <input type="checkbox" name="flagged" value="1" defaultChecked={sp.flagged === "1"} /> 👎・無効のみ
            </label>
            <Button variant="secondary">絞り込む</Button>
          </form>
        </div>
        <Table minWidth="min-w-[900px]">
          <thead>
            <tr>
              <Th>質問</Th>
              <Th>回答</Th>
              <Th>種類</Th>
              <Th align="right">利用</Th>
              <Th align="right">👍 / 👎</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {list.rows.length === 0 && <EmptyRow colSpan={6} />}
            {list.rows.map((r) => (
              <Tr key={r.id} className={r.disabled ? "opacity-50" : undefined}>
                <Td className="max-w-[240px] align-top">
                  <div className="font-medium text-ink">{r.question}</div>
                  {r.role && <div className="text-[11px] text-ink-3">{ROLE_LABEL[r.role as Role] ?? r.role} 向け</div>}
                </Td>
                <Td className="max-w-[420px] align-top text-xs whitespace-pre-wrap text-ink-2">{r.answer.length > 220 ? `${r.answer.slice(0, 220)}…` : r.answer}</Td>
                <Td className="align-top">
                  <Badge tone={ORIGIN[r.origin]?.tone ?? "neutral"}>{ORIGIN[r.origin]?.label ?? r.origin}</Badge>
                  {r.disabled && <div className="mt-1 text-[11px] text-critical-ink">無効</div>}
                </Td>
                <Td align="right" className="align-top tnum">{r.hits}</Td>
                <Td align="right" className="align-top tnum">{r.up} / {r.down}</Td>
                <Td className="align-top whitespace-nowrap">
                  <div className="flex items-center justify-end gap-1">
                    <Link href={`${q({ page: sp.page, edit: String(r.id) })}#chatbot-edit`} className="rounded px-2 py-1 text-xs text-accent hover:bg-accent-soft">修正</Link>
                    <form action={toggleChatbotQa.bind(null, r.id)}>
                      <input type="hidden" name="returnTo" value={returnTo} />
                      <button className="rounded px-2 py-1 text-xs text-ink-2 hover:bg-subtle">{r.disabled ? "有効に" : "無効に"}</button>
                    </form>
                    <form action={deleteChatbotQa.bind(null, r.id)}>
                      <input type="hidden" name="returnTo" value={returnTo} />
                      <button className="rounded px-2 py-1 text-xs text-critical-ink hover:bg-critical-soft">削除</button>
                    </form>
                  </div>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
        {pages > 1 && (
          <div className="flex items-center justify-between gap-2 border-t border-line p-3 text-sm">
            <span className="text-ink-3">{list.page} / {pages} ページ</span>
            <div className="flex gap-2">
              {list.page > 1 && <Link href={q({ page: String(list.page - 1) })} className="rounded-lg border border-line px-3 py-1 hover:bg-subtle">前へ</Link>}
              {list.page < pages && <Link href={q({ page: String(list.page + 1) })} className="rounded-lg border border-line px-3 py-1 hover:bg-subtle">次へ</Link>}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
