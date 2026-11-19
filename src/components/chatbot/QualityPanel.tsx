import { Activity, ClipboardCheck, Database as DatabaseIcon, Gauge, ListChecks, ShieldCheck, ThumbsDown, Wallet } from "lucide-react";
import Link from "@/components/ui/Link";
import { Badge, Button, Card, CardHeader, Field, Input, Note, Select, Stat, Table, Td, Textarea, Th, Tr, EmptyRow } from "@/components/ui";
import { addChatToEval, deleteChatbotEvalCase, importChatbotEvalCsv, saveChatbotBudget, saveChatbotEvalCase, seedChatbotEvalCases, startChatbotEval, stopChatbotEval, toggleChatbotEvalCase } from "@/lib/actions/chatbot-quality";
import { ACCEPTANCE, EVAL_CATEGORIES, categoryLabel, currentEvalRun, evalResults, getEvalRun, listEvalCases, listEvalRuns, type EvalMetrics } from "@/lib/chatbot/eval";
import { aiPrices, aiUsageSummary, answerQuality, breakerState, budgetState, reviewQueue } from "@/lib/chatbot/monitor";
import { dataQualityChecks } from "@/lib/chatbot/data-quality";
import { ROLE_LABEL } from "@/lib/constants";
import type { Database, Role } from "@/lib/db/types";

/**
 * AI アシスタント →「品質・費用」(管理者): 受入基準と精度の評価・利用状況と費用・低評価の回答・正解付きの質問・データの品質
 */

const pct = (v: number | null | undefined) => (v === null || v === undefined ? "-" : `${Math.round(v * 1000) / 10}%`);
const yen = (n: number) => `${Math.round(n).toLocaleString("ja-JP")} 円`;
const sec = (ms: number) => `${(ms / 1000).toFixed(1)} 秒`;
const fmtAt = (iso?: string) => (iso ? new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "-");
const ERROR_LABEL: Record<string, string> = { timeout: "時間切れ", rate_limit: "混雑", quota: "残高・上限", auth: "キー", api: "API の失敗", unsupported: "モデル", refusal: "AI が拒否", truncated: "長すぎ", bad_output: "形式の誤り" };
const KIND_LABEL: Record<string, string> = { voice: "音声 (読み上げ・音声入力)", assistant: "AI アシスタント", guest: "ログイン前の案内", eval: "精度の評価", other: "書類の読取・要約など", ocr: "書類の読取", train: "学習" };
const ISSUE_LABEL: Record<string, string> = { number: "根拠のない数字", no_evidence: "データを調べずに回答", action: "実行したような書き方", link: "根拠のないリンク", screen: "資料にない画面・ボタン" };
const DEGRADED_LABEL: Record<string, string> = { budget: "予算の上限", outage: "AI の障害 (遮断中)", error: "AI の失敗", limit: "1 時間の回数の上限" };

function metricValue(key: string, m: EvalMetrics): string {
  switch (key) {
    case "accuracy":
      return `${pct(m.accuracy)} (${m.passed}/${m.total})`;
    case "numeric":
      return m.numericRate === null ? "対象なし" : `${pct(m.numericRate)} (${m.numericExpected} 個)`;
    case "violations":
      return `${m.violations} 件`;
    case "badScreens":
      return `${m.badScreens} 件`;
    case "ungrounded":
      return `${m.ungrounded} 件`;
    case "unknown":
      return pct(m.unknownRate);
    case "refuse":
      return pct(m.refuseRate);
    case "evidence":
      return pct(m.evidenceRate);
  }
  return "-";
}

export function QualityPanel({ db, sp }: { db: Database; sp: Record<string, string | undefined> }) {
  const runs = listEvalRuns(10);
  const running = currentEvalRun();
  const runRow = running ? getEvalRun(running.runId) : undefined;
  const latest = runs.find((r) => r.status === "done" || r.status === "stopped");
  const shownRun = sp.run ? runs.find((r) => String(r.id) === sp.run) ?? latest : latest;
  const m = shownRun?.metrics;
  const results = shownRun ? evalResults(shownRun.id) : [];
  const cases = listEvalCases();
  const caseById = new Map(cases.map((c) => [c.id, c]));
  const usage = aiUsageSummary(30);
  const budget = budgetState();
  const breaker = breakerState();
  const quality = answerQuality(30);
  const queue = reviewQueue(20);
  const dq = dataQualityChecks(db);
  const editing = sp.edit ? cases.find((c) => String(c.id) === sp.edit) : undefined;
  const prices = Object.entries(aiPrices())
    .map(([k, p]) => `${k} ${p.in} ${p.cachedIn ?? p.in} ${p.out}`)
    .join("\n");
  const countBy = new Map<string, { all: number; active: number }>();
  for (const c of cases) {
    const x = countBy.get(c.category) ?? { all: 0, active: 0 };
    x.all++;
    if (c.active) x.active++;
    countBy.set(c.category, x);
  }
  const stores = db.stores;

  return (
    <div className="space-y-4">
      <Note tone="accent">
        AI の回答は「すべての質問に必ず正解する」ことは保証できません。ここでは <strong>受入基準 (完成の条件)</strong> を決め、正解付きの質問で定期的に確かめます。
        回答はすべて道具 (検索・集計・資料) の結果と自動で突き合わせ、根拠のない数字・存在しない画面・実行したような書き方を見つけたら AI に確かめ直させます。
      </Note>

      {/* ---------------- 受入基準 ---------------- */}
      <Card id="acceptance">
        <CardHeader
          title="受入基準と精度の評価"
          description={shownRun ? `評価 #${shownRun.id} (${fmtAt(shownRun.finishedAt ?? shownRun.startedAt)}・${shownRun.label || "手動"}・${shownRun.provider || "-"})` : "まだ評価していません。「評価を実行」で正解付きの質問を AI に聞き、採点します。"}
          icon={<ShieldCheck />}
          action={
            running ? (
              <form action={stopChatbotEval}>
                <Button variant="secondary" size="sm">評価を止める</Button>
              </form>
            ) : (
              <form action={startChatbotEval} className="flex flex-wrap items-center gap-2">
                <Select name="category" defaultValue="" className="h-8 text-xs">
                  <option value="">すべての分類</option>
                  {EVAL_CATEGORIES.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.label}
                    </option>
                  ))}
                </Select>
                <Button size="sm">評価を実行</Button>
              </form>
            )
          }
        />
        {runRow && (
          <div className="mb-4 space-y-2">
            <div className="h-2 overflow-hidden rounded-full bg-subtle">
              <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${runRow.total ? Math.round((runRow.done / runRow.total) * 100) : 0}%` }} />
            </div>
            <p className="text-xs text-ink-2">
              評価中: {runRow.done} / {runRow.total} 問 (合格 {runRow.passed} 問)。開始 {fmtAt(runRow.startedAt)}。画面を再読み込みすると進み具合を更新します。
            </p>
          </div>
        )}
        {m ? (
          <>
            <div className="grid grid-cols-1 gap-2 @xl:grid-cols-2 @4xl:grid-cols-4">
              {ACCEPTANCE.map((a) => {
                const ok = a.pass(m);
                return (
                  <div key={a.key} className="rounded-xl border border-line/70 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-ink-3">{a.label}</span>
                      <Badge tone={ok ? "good" : "critical"}>{ok ? "合格" : "未達"}</Badge>
                    </div>
                    <div className="mt-1 text-lg font-bold tnum text-ink">{metricValue(a.key, m)}</div>
                    <div className="text-[11px] text-ink-3">基準: {a.target}</div>
                  </div>
                );
              })}
            </div>
            <div className="mt-3 grid grid-cols-1 gap-2 text-xs text-ink-2 @xl:grid-cols-2 @4xl:grid-cols-4">
              <div>適切な道具を使った割合: <strong>{pct(m.toolRate)}</strong></div>
              <div>回答時間: 平均 <strong>{sec(m.avgMs)}</strong>・95% が {sec(m.p95Ms)} 以内</div>
              <div>この評価の AI の費用: <strong>{yen(m.costJpy)}</strong> ({m.tokens.toLocaleString()} トークン)</div>
              <div>
                前回からの変化:{" "}
                {m.previousAccuracy === undefined ? "前回なし" : <strong className={m.accuracy < m.previousAccuracy ? "text-critical-ink" : "text-good-ink"}>{pct(m.previousAccuracy)} → {pct(m.accuracy)}</strong>}
                {m.regressions.length ? `・前回合格で今回不合格 ${m.regressions.length} 問` : ""}
              </div>
            </div>
            {m.errors > 0 && <p className="mt-2 text-xs text-critical-ink">実行できなかった質問が {m.errors} 問あります (正解の SQL の誤り・AI の失敗など。下の結果で確かめてください)。</p>}
          </>
        ) : (
          !runRow && <p className="text-sm text-ink-2">評価の結果はまだありません。</p>
        )}
        {runs.length > 1 && (
          <div className="mt-4 flex flex-wrap gap-2 text-xs">
            <span className="text-ink-3">これまでの評価:</span>
            {runs
              .filter((r) => r.metrics)
              .map((r) => (
                <Link key={r.id} href={`/ai?tab=quality&run=${r.id}#acceptance`} className={`rounded-full border px-2 py-0.5 ${shownRun?.id === r.id ? "border-accent text-accent-ink" : "border-line text-ink-2 hover:bg-subtle"}`}>
                  #{r.id} {fmtAt(r.finishedAt).slice(0, 10)} {pct(r.metrics?.accuracy)}
                </Link>
              ))}
          </div>
        )}
      </Card>

      {/* ---------------- 評価の結果 ---------------- */}
      {shownRun && results.length > 0 && (
        <Card id="results">
          <CardHeader title={`評価 #${shownRun.id} の結果`} description="不合格の質問を先に並べます。理由・正解・AI の回答を開いて確かめ、資料の不足・データの誤り・AI の誤りのどれかを見分けて直してください。" icon={<ClipboardCheck />} />
          <div className="mb-3 flex flex-wrap gap-2 text-xs">
            {Object.entries(m?.byCategory ?? {}).map(([k, v]) => (
              <Badge key={k} tone={v.passed === v.total ? "good" : "warn"} dot={false}>
                {categoryLabel(k)} {v.passed}/{v.total}
              </Badge>
            ))}
          </div>
          <div className="space-y-2">
            {[...results]
              .sort((a, b) => Number(a.ok) - Number(b.ok))
              .map((r, i) => {
                const c = caseById.get(r.caseId);
                return (
                  <details key={i} className="rounded-xl border border-line/70 px-3 py-2 text-sm" open={!r.ok && i < 3}>
                    <summary className="flex cursor-pointer flex-wrap items-center gap-2">
                      <Badge tone={r.ok ? "good" : "critical"}>{r.ok ? "合格" : "不合格"}</Badge>
                      {r.outcome.violation && <Badge tone="critical">権限違反</Badge>}
                      <span className="text-xs text-ink-3">{categoryLabel(c?.category ?? "")}{c ? `・${ROLE_LABEL[c.role]}` : ""}</span>
                      <span className="min-w-0 flex-1 break-words">{r.question}</span>
                      <span className="text-xs text-ink-3 tnum">{sec(r.ms)}</span>
                    </summary>
                    <div className="mt-2 space-y-1.5 text-xs text-ink-2">
                      {!r.ok && <p className="text-critical-ink">理由: {r.outcome.reasons.join(" / ")}</p>}
                      {r.expected && <p>正解: {r.expected}</p>}
                      {c?.answerNote && <p>正しい回答 (説明): {c.answerNote}</p>}
                      <p>使った道具: {r.tools.join("・") || "なし"}</p>
                      <p className="whitespace-pre-wrap rounded-lg bg-subtle p-2 text-ink">{r.answer || "(回答なし)"}</p>
                      {c && (
                        <Link href={`/ai?tab=quality&edit=${c.id}#case-form`} className="text-accent hover:underline">
                          この質問の正解を直す
                        </Link>
                      )}
                    </div>
                  </details>
                );
              })}
          </div>
        </Card>
      )}

      {/* ---------------- 利用状況と費用 ---------------- */}
      <div id="usage" className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @4xl:grid-cols-4">
        <Stat label="AI の呼び出し (直近 30 日)" value={`${usage.calls.toLocaleString()} 回`} sub={Object.entries(usage.byKind).map(([k, v]) => `${KIND_LABEL[k] ?? k} ${v.calls}`).join(" / ") || "なし"} icon={<Activity />} />
        <Stat label="今月の AI の費用 (見込み)" value={yen(budget.costJpy)} sub={budget.budget.monthlyJpy ? `予算 ${yen(budget.budget.monthlyJpy)} の ${pct(budget.ratio)}` : "予算は未設定"} icon={<Wallet />} accent={budget.exceeded ? "critical" : budget.ratio >= 0.8 ? "warn" : "good"} tone={budget.exceeded ? "critical" : undefined} />
        <Stat label="AI の応答時間 (直近 30 日)" value={sec(usage.avgMs)} sub={`95% が ${sec(usage.p95Ms)} 以内 (1 回の呼び出し)`} icon={<Gauge />} accent="info" />
        <Stat label="AI の失敗 (直近 30 日)" value={`${usage.failures} 回`} sub={Object.entries(usage.failuresByCode).map(([k, v]) => `${ERROR_LABEL[k] ?? k} ${v}`).join(" / ") || "なし"} icon={<Activity />} accent={usage.failures ? "warn" : "good"} />
      </div>
      {breaker.open && <Note tone="warn">AI に接続できない状態が続いたため、{fmtAt(breaker.until)} まで AI を呼ばずに (蓄えた回答・集計・資料から) 答えています (理由: {ERROR_LABEL[breaker.reason ?? ""] ?? breaker.reason})。設定 → AI の「接続を確認」でキー・残高を確かめてください。</Note>}
      {budget.exceeded && <Note tone="warn">今月の AI の利用が予算・上限を超えました。{budget.budget.onExceed === "fallback" ? "月末まで AI を使わずに答えます (予算を上げると再開します)。" : "警告だけの設定のため、AI はそのまま使っています。"}</Note>}
      {usage.unpricedModels.length > 0 && <Note tone="warn">単価が設定されていないモデルがあります ({usage.unpricedModels.join("・")})。費用の見込みに入っていません。下の「単価」に OpenAI・Anthropic の料金表の値を入れてください。</Note>}

      <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-2">
        <Card>
          <CardHeader title="回答の確かめ (直近 30 日)" description="すべての回答を、道具の結果と自動で突き合わせています。問題があれば AI に 1 回確かめ直させ、残ったものはリンクを外す・注記を付けるなどで直しています。" icon={<ListChecks />} />
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-ink-3">相談の数</dt>
            <dd className="tnum">{quality.answers.toLocaleString()} 件 (AI {quality.agent.toLocaleString()} 件)</dd>
            <dt className="text-ink-3">問題が見つかった回答</dt>
            <dd className="tnum">{quality.flagged} 件 (確かめ直し {quality.retried} 件・直して出した {quality.fixed} 件)</dd>
            {Object.entries(quality.byIssue).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="pl-3 text-ink-3">・{ISSUE_LABEL[k] ?? k}</dt>
                <dd className="tnum">{v} 件</dd>
              </div>
            ))}
            <dt className="text-ink-3">評価 👍 / 👎</dt>
            <dd className="tnum">{quality.up} / {quality.down}</dd>
            <dt className="text-ink-3">回答時間 (質問から回答まで)</dt>
            <dd className="tnum">平均 {sec(quality.avgMs)}・95% が {sec(quality.p95Ms)} 以内</dd>
            <dt className="text-ink-3">AI を使わずに答えた</dt>
            <dd className="tnum">{Object.entries(quality.degraded).map(([k, v]) => `${DEGRADED_LABEL[k] ?? k} ${v} 件`).join(" / ") || "なし"}</dd>
          </dl>
        </Card>
        <Card>
          <CardHeader title="予算と単価" description="費用 = トークン数 × 単価 (米ドル / 100 万トークン) × 為替。超えたときに AI を止める設定にすると、月末まで AI を使わない答え方 (蓄えた回答・集計・資料) になります。" icon={<Wallet />} />
          <form action={saveChatbotBudget} className="space-y-3">
            <div className="grid grid-cols-1 gap-3 @xl:grid-cols-3">
              <Field label="月の予算 (円。0 = 決めない)">
                <Input name="monthlyJpy" inputMode="numeric" defaultValue={String(budget.budget.monthlyJpy)} />
              </Field>
              <Field label="月のトークンの上限 (0 = 決めない)">
                <Input name="monthlyTokens" inputMode="numeric" defaultValue={String(budget.budget.monthlyTokens)} />
              </Field>
              <Field label="1 米ドル (円)">
                <Input name="usdJpy" inputMode="decimal" defaultValue={String(budget.budget.usdJpy)} />
              </Field>
            </div>
            <Field label="超えたとき">
              <Select name="onExceed" defaultValue={budget.budget.onExceed}>
                <option value="fallback">AI を止める (AI を使わずに答える)</option>
                <option value="warn">警告だけ (AI は使い続ける)</option>
              </Select>
            </Field>
            <Field label="単価 (1 行に「モデル名 入力 キャッシュ入力 出力」。米ドル / 100 万トークン)" hint="モデル名は前方一致 (gpt-4.1 は gpt-4.1-2025-04-14 にも使う)。料金表で確かめて直してください。">
              <Textarea name="prices" rows={5} defaultValue={prices} className="font-mono text-xs" />
            </Field>
            <p className="text-xs text-ink-3">今月: {yen(budget.costJpy)}・{budget.tokens.toLocaleString()} トークン</p>
            <Button size="sm">保存</Button>
          </form>
        </Card>
      </div>

      {/* ---------------- 低評価の回答 ---------------- */}
      <Card id="lowrated">
        <CardHeader title="確認が必要な回答" description="👎 が付いた回答と、確かめで問題が残った回答です。正しい回答を「正解付きの質問」に登録すると、次の評価から正しく答えられるかを確かめます。資料が足りないときは社内資料に登録してください (相談の履歴の画面から登録できます)。" icon={<ThumbsDown />} />
        {queue.length ? (
          <div className="space-y-2">
            {queue.map((x) => (
              <details key={x.id} className="rounded-xl border border-line/70 px-3 py-2 text-sm">
                <summary className="flex cursor-pointer flex-wrap items-center gap-2">
                  {x.rating < 0 ? <Badge tone="critical">👎</Badge> : <Badge tone="warn">要確認</Badge>}
                  <span className="text-xs text-ink-3">{fmtAt(x.at)}・{x.userName}</span>
                  <span className="min-w-0 flex-1 break-words">{x.question}</span>
                </summary>
                <div className="mt-2 space-y-2 text-xs">
                  {x.issues.length > 0 && <p className="text-warn-ink">{x.issues.join(" / ")}</p>}
                  <p className="whitespace-pre-wrap rounded-lg bg-subtle p-2 text-ink">{x.answer.slice(0, 1500)}</p>
                  <Link href={`/ai?tab=history&id=${x.id}`} className="text-accent hover:underline">
                    相談の履歴で開く (社内資料に登録)
                  </Link>
                  <form action={addChatToEval.bind(null, x.id)} className="grid grid-cols-1 gap-2 rounded-lg border border-line/70 p-2 @xl:grid-cols-2">
                    <Field label="分類">
                      <Select name="category" defaultValue="howto">
                        {EVAL_CATEGORIES.map((c) => (
                          <option key={c.key} value={c.key}>
                            {c.label}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="正解に含む言葉 (| で区切る)">
                      <Input name="contains" placeholder="例: 見積|新規" />
                    </Field>
                    <Field label="正解の数字 (| で区切る)">
                      <Input name="numbers" placeholder="例: 1234567" />
                    </Field>
                    <Field label="正しい回答 (説明)">
                      <Input name="answerNote" />
                    </Field>
                    <label className="flex items-center gap-2 text-xs">
                      <input type="checkbox" name="unknown" /> 答えられない質問 (「ない」と答えるのが正解)
                    </label>
                    <label className="flex items-center gap-2 text-xs">
                      <input type="checkbox" name="refuse" /> 実行の依頼 (断るのが正解)
                    </label>
                    <div className="@xl:col-span-2">
                      <Button size="sm" variant="secondary">正解付きの質問に登録</Button>
                    </div>
                  </form>
                </div>
              </details>
            ))}
          </div>
        ) : (
          <p className="text-sm text-ink-2">確認が必要な回答はありません。</p>
        )}
      </Card>

      {/* ---------------- 正解付きの質問 ---------------- */}
      <Card id="cases">
        <CardHeader
          title={`正解付きの質問 (${cases.filter((c) => c.active).length} 問が有効)`}
          description="社員ごと・ロールごとの実際の質問に、正しい回答・根拠・聞く人のロールを付けて登録します。数字は「正解の SQL」で書くと、データが変わっても評価のたびに正解を数え直します。表計算ソフトで作って CSV で取り込めます。"
          icon={<ClipboardCheck />}
          action={
            <div className="flex flex-wrap gap-2">
              <a href="/api/assistant/eval-cases" className="inline-flex h-8 items-center rounded-xl border border-line bg-panel px-3 text-xs hover:bg-subtle">
                CSV で保存
              </a>
              <form action={seedChatbotEvalCases}>
                <Button size="sm" variant="secondary">始めの質問を入れる</Button>
              </form>
            </div>
          }
        />
        <div className="mb-3 grid grid-cols-1 gap-2 text-xs @xl:grid-cols-3 @4xl:grid-cols-5">
          {EVAL_CATEGORIES.map((c) => {
            const n = countBy.get(c.key)?.active ?? 0;
            return (
              <div key={c.key} className="rounded-lg border border-line/70 px-2.5 py-1.5">
                <div className="text-ink-3">{c.label}</div>
                <div className="tnum">
                  <strong className={n >= c.target ? "text-good-ink" : "text-warn-ink"}>{n}</strong> / 目安 {c.target} 問
                </div>
              </div>
            );
          })}
        </div>
        <form action={importChatbotEvalCsv} className="mb-4 flex flex-wrap items-end gap-2 rounded-xl border border-dashed border-line p-3">
          <Field label="CSV を取り込む (1 行目は見出し。「CSV で保存」と同じ列)" className="min-w-0 flex-1">
            <Input type="file" name="file" accept=".csv,text/csv" />
          </Field>
          <Button size="sm" variant="secondary">取り込む</Button>
        </form>
        <Table minWidth="min-w-[760px]">
          <thead>
            <tr>
              <Th>分類</Th>
              <Th>質問</Th>
              <Th>聞く人</Th>
              <Th>正解</Th>
              <Th>直近の結果</Th>
              <Th align="right">操作</Th>
            </tr>
          </thead>
          <tbody>
            {cases.length ? (
              cases.map((c) => {
                const last = results.find((r) => r.caseId === c.id);
                const e = c.expect;
                const truth = [e.contains?.length ? `含む: ${e.contains.join("・")}` : "", e.anyOf?.length ? `どれか: ${e.anyOf.join("・")}` : "", e.numbers?.length ? `数字: ${e.numbers.join("・")}` : "", e.sql ? "SQL" : "", e.forbidSql ? "権限 (出してはいけない値)" : "", e.unknown ? "「ない」と答える" : "", e.refuse ? "断る" : "", e.links?.length ? `画面: ${e.links.join("・")}` : ""].filter(Boolean).join(" / ");
                return (
                  <Tr key={c.id} className={c.active ? "" : "opacity-50"}>
                    <Td className="text-xs">{categoryLabel(c.category)}</Td>
                    <Td className="max-w-[320px] text-sm">
                      {c.history.length > 0 && <span className="block text-[11px] text-ink-3">前: {c.history.join(" → ")}</span>}
                      {c.question}
                    </Td>
                    <Td className="text-xs">
                      {ROLE_LABEL[c.role as Role] ?? c.role}
                      {c.storeId ? `・${stores.find((s) => s.id === c.storeId)?.shortName ?? c.storeId}` : ""}
                    </Td>
                    <Td className="max-w-[240px] text-xs text-ink-2">{truth}</Td>
                    <Td>{last ? <Badge tone={last.ok ? "good" : "critical"}>{last.ok ? "合格" : "不合格"}</Badge> : <span className="text-xs text-ink-3">-</span>}</Td>
                    <Td align="right">
                      <div className="flex justify-end gap-1">
                        <Link href={`/ai?tab=quality&edit=${c.id}#case-form`} className="rounded-lg px-2 py-1 text-xs text-accent hover:bg-subtle">
                          直す
                        </Link>
                        <form action={toggleChatbotEvalCase.bind(null, c.id)}>
                          <button className="rounded-lg px-2 py-1 text-xs text-ink-2 hover:bg-subtle">{c.active ? "無効に" : "有効に"}</button>
                        </form>
                        <form action={deleteChatbotEvalCase.bind(null, c.id)}>
                          <button className="rounded-lg px-2 py-1 text-xs text-critical-ink hover:bg-critical-soft">削除</button>
                        </form>
                      </div>
                    </Td>
                  </Tr>
                );
              })
            ) : (
              <EmptyRow colSpan={6}>質問がありません。「始めの質問を入れる」か、下のフォーム・CSV で登録してください。</EmptyRow>
            )}
          </tbody>
        </Table>

        <form id="case-form" action={saveChatbotEvalCase} className="mt-4 space-y-3 rounded-xl border border-line/70 p-4">
          <h3 className="text-sm font-semibold">{editing ? `質問 #${editing.id} を直す` : "質問を追加"}</h3>
          {editing && <input type="hidden" name="id" value={editing.id} />}
          <div className="grid grid-cols-1 gap-3 @xl:grid-cols-3">
            <Field label="分類">
              <Select name="category" defaultValue={editing?.category ?? "howto"}>
                {EVAL_CATEGORIES.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="聞く人のロール">
              <Select name="role" defaultValue={editing?.role ?? "admin"}>
                {(Object.keys(ROLE_LABEL) as Role[]).map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="店舗 (店長・店舗スタッフ)">
              <Select name="storeId" defaultValue={editing?.storeId ?? ""}>
                <option value="">(ロールの最初の社員)</option>
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="質問" required>
            <Textarea name="question" rows={2} defaultValue={editing?.question ?? ""} required />
          </Field>
          <Field label="前の質問 (会話の続きを確かめるとき。| で区切る)">
            <Input name="history" defaultValue={editing?.history.join("|") ?? ""} placeholder="例: 今年の売上合計は？" />
          </Field>
          <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
            <Field label="正解に含む言葉 (すべて。| で区切る)">
              <Input name="contains" defaultValue={editing?.expect.contains?.join("|") ?? ""} />
            </Field>
            <Field label="どれかを含む言葉 (| で区切る)">
              <Input name="anyOf" defaultValue={editing?.expect.anyOf?.join("|") ?? ""} />
            </Field>
            <Field label="正解の数字 (| で区切る)">
              <Input name="numbers" defaultValue={editing?.expect.numbers?.join("|") ?? ""} />
            </Field>
            <Field label="含んではいけない言葉 (| で区切る)">
              <Input name="notContains" defaultValue={editing?.expect.notContains?.join("|") ?? ""} />
            </Field>
            <Field label="案内してほしい画面 (例: /quotes。| で区切る)">
              <Input name="links" defaultValue={editing?.expect.links?.join("|") ?? ""} />
            </Field>
            <Field label="使ってほしい道具 (指標だけ。例: analyze|query_database)">
              <Input name="tools" defaultValue={editing?.expect.tools?.join("|") ?? ""} />
            </Field>
          </div>
          <Field label="正解の SQL (VPS のデータベース。1 行目の値が正解。:store = 聞く人の店舗・:other = ほかの店舗)" hint="例: select count(*) from customers where store_id = :store">
            <Textarea name="sql" rows={2} defaultValue={editing?.expect.sql ?? ""} className="font-mono text-xs" />
          </Field>
          <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
            <Field label="SQL の値の使い方">
              <Select name="sqlMode" defaultValue={editing?.expect.sqlMode ?? "all"}>
                <option value="all">1 行目の値をすべて含む</option>
                <option value="any">どの行のどれか 1 つを含む</option>
              </Select>
            </Field>
            <Field label="SQL の閲覧範囲">
              <Select name="sqlScope" defaultValue={editing?.expect.sqlScope ?? "admin"}>
                <option value="admin">全社 (管理者)</option>
                <option value="user">聞く人の閲覧範囲</option>
              </Select>
            </Field>
          </div>
          <Field label="出してはいけない値の SQL (権限の確かめ。結果の名前・金額が回答に出たら権限違反)">
            <Textarea name="forbidSql" rows={2} defaultValue={editing?.expect.forbidSql ?? ""} className="font-mono text-xs" />
          </Field>
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" name="unknown" defaultChecked={editing?.expect.unknown} /> 答えられない質問 (「ない」と答えるのが正解)
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" name="refuse" defaultChecked={editing?.expect.refuse} /> 実行の依頼 (断るのが正解)
            </label>
          </div>
          <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
            <Field label="正しい回答 (人が読む説明)">
              <Textarea name="answerNote" rows={2} defaultValue={editing?.answerNote ?? ""} />
            </Field>
            <Field label="根拠 (資料名・画面)">
              <Textarea name="evidenceNote" rows={2} defaultValue={editing?.evidenceNote ?? ""} />
            </Field>
          </div>
          <div className="flex gap-2">
            <Button size="sm">{editing ? "直す" : "追加"}</Button>
            {editing && (
              <Link href="/ai?tab=quality#cases" className="inline-flex h-8 items-center rounded-xl px-3 text-xs text-ink-2 hover:bg-subtle">
                やめる
              </Link>
            )}
          </div>
        </form>
      </Card>

      {/* ---------------- データの品質 ---------------- */}
      <Card id="data">
        <CardHeader title="データの品質 (AI の回答に影響するもの)" description="元のデータが誤っていれば、AI も誤った結果を返します。件数が多いものから整理してください (このシステムはデータを自動では直しません)。" icon={<DatabaseIcon />} />
        <Table minWidth="min-w-[640px]">
          <thead>
            <tr>
              <Th>確認すること</Th>
              <Th align="right">件数</Th>
              <Th>影響</Th>
              <Th>説明・例</Th>
            </tr>
          </thead>
          <tbody>
            {dq.map((d) => (
              <Tr key={d.label}>
                <Td className="text-sm">
                  {d.href ? (
                    <Link href={d.href} className="text-accent hover:underline">
                      {d.label}
                    </Link>
                  ) : (
                    d.label
                  )}
                </Td>
                <Td align="right">
                  <Badge tone={d.status === "ok" ? "good" : d.status === "warn" ? "warn" : d.status === "ng" ? "critical" : "neutral"}>
                    {d.count.toLocaleString()} / {d.total.toLocaleString()}
                  </Badge>
                </Td>
                <Td className="text-xs text-ink-2">{d.impact}</Td>
                <Td className="text-xs text-ink-2">
                  {d.note}
                  {d.examples?.length ? (
                    <span className="mt-1 block">
                      例:{" "}
                      {d.examples.map((x, i) => (
                        <span key={i}>
                          {i > 0 && "、"}
                          {x.href ? (
                            <Link href={x.href} className="text-accent hover:underline">
                              {x.label}
                            </Link>
                          ) : (
                            x.label
                          )}
                        </span>
                      ))}
                    </span>
                  ) : null}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}
