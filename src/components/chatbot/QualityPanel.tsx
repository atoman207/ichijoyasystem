import { Activity, ClipboardCheck, Database as DatabaseIcon, Gauge, ListChecks, ShieldCheck, ThumbsDown, Wallet } from "lucide-react";
import Link from "@/components/ui/Link";
import { Badge, Button, Card, CardHeader, Field, Input, Note, Select, Stat, Table, Td, Textarea, Th, Tr, EmptyRow } from "@/components/ui";
import { addChatToEval, deleteChatbotEvalCase, importChatbotEvalCsv, revokeChatbotSignoff, saveChatbotBudget, saveChatbotEvalCase, seedChatbotEvalCases, signoffChatbotEval, startChatbotEval, stopChatbotEval, toggleChatbotEvalCase, toggleChatbotEvalRepresentative } from "@/lib/actions/chatbot-quality";
import { ACCEPTANCE, EVAL_CATEGORIES, EVAL_TARGET_LABEL, categoryLabel, currentEvalRun, currentRevision, evalResults, getEvalRun, listEvalCases, listEvalRuns, listSignoffs, signoffReadiness, signoffStatus, type EvalCase, type EvalMetrics } from "@/lib/chatbot/eval";
import { SECTION_LABEL, SUMMARY_KIND_LABEL } from "@/lib/ai/summary-sections";
import { DRAFT_FORMAT_LABEL, DRAFT_TEMPLATES } from "@/lib/ai/draft";
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
    case "sources":
      return m.sourceRate === null || m.sourceRate === undefined ? "対象なし" : pct(m.sourceRate);
  }
  return "-";
}

/** ロールの組み合わせの表示 */
function matrixLabel(c: EvalCase): string {
  const mx = c.expect.matrix;
  if (!mx?.roles.length) return "";
  return `${mx.roles.map((r) => ROLE_LABEL[r]).join("・")}${mx.stores === "all" ? " × 全店舗" : ""}`;
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
          description={shownRun ? `評価 #${shownRun.id} (${fmtAt(shownRun.finishedAt ?? shownRun.startedAt)}・${shownRun.label || "手動"}・${shownRun.provider || "-"}・版 ${shownRun.revision ? shownRun.revision.slice(0, 7) : "-"})。いまの版 ${currentRevision().slice(0, 7)}${shownRun.revision && shownRun.revision !== currentRevision() ? " (この版ではまだ評価していません。AI アシスタントを変えたら評価してください)" : ""}` : "まだ評価していません。「評価を実行」で正解付きの質問を AI に聞き、採点します。"}
          icon={<ShieldCheck />}
          action={
            running ? (
              <form action={stopChatbotEval}>
                <Button variant="secondary" size="sm">評価を止める</Button>
              </form>
            ) : (
              <form action={startChatbotEval} className="flex flex-wrap items-center gap-2">
                <Select name="scope" defaultValue="" className="h-8 text-xs" aria-label="評価の範囲">
                  <option value="">分類で選ぶ</option>
                  <option value="representative">代表シナリオだけ</option>
                </Select>
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
            {Boolean(m.skipped) && <p className="mt-1 text-xs text-ink-3">対象の記録がなく数えなかった質問: {m.skipped} 問 (データが増えたら確かめます)。</p>}
            {m.byRole && Object.keys(m.byRole).length > 0 && (
              <div className="mt-3">
                <p className="mb-1 text-xs font-medium text-ink">聞いた人 (ロール・店舗) ごと</p>
                <div className="flex flex-wrap gap-1.5 text-xs">
                  {Object.entries(m.byRole).map(([k, v]) => (
                    <Badge key={k} tone={v.violations ? "critical" : v.passed === v.total ? "good" : "warn"} dot={false}>
                      {k} {v.passed}/{v.total}{v.violations ? `・権限違反 ${v.violations}` : ""}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
            {m.byTarget && Object.keys(m.byTarget).length > 1 && (
              <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
                {Object.entries(m.byTarget).map(([k, v]) => (
                  <Badge key={k} tone={v.passed === v.total ? "good" : "warn"} dot={false}>
                    {EVAL_TARGET_LABEL[k as keyof typeof EVAL_TARGET_LABEL] ?? k} {v.passed}/{v.total}
                  </Badge>
                ))}
              </div>
            )}
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
              .sort((a, b) => Number(a.ok || Boolean(a.outcome.skipped)) - Number(b.ok || Boolean(b.outcome.skipped)))
              .map((r, i) => {
                const c = caseById.get(r.caseId);
                return (
                  <details key={i} className="rounded-xl border border-line/70 px-3 py-2 text-sm" open={!r.ok && i < 3}>
                    <summary className="flex cursor-pointer flex-wrap items-center gap-2">
                      {r.outcome.skipped ? <Badge tone="neutral">対象なし</Badge> : <Badge tone={r.ok ? "good" : "critical"}>{r.ok ? "合格" : "不合格"}</Badge>}
                      {r.outcome.violation && <Badge tone="critical">権限違反</Badge>}
                      {c?.representative && <Badge tone="accent" dot={false}>代表</Badge>}
                      <span className="text-xs text-ink-3">{categoryLabel(c?.category ?? "")}・{r.variant || (c ? ROLE_LABEL[c.role] : "")}{c?.expect.target && c.expect.target !== "ask" ? `・${EVAL_TARGET_LABEL[c.expect.target]}` : ""}</span>
                      <span className="min-w-0 flex-1 break-words">{r.question}</span>
                      <span className="text-xs text-ink-3 tnum">{sec(r.ms)}</span>
                    </summary>
                    <div className="mt-2 space-y-1.5 text-xs text-ink-2">
                      {!r.ok && <p className={r.outcome.skipped ? "text-ink-3" : "text-critical-ink"}>理由: {r.outcome.reasons.join(" / ")}</p>}
                      {r.outcome.scopeViolations?.length ? <p className="text-critical-ink">閲覧範囲の外の記録へのリンク: {r.outcome.scopeViolations.join("・")}</p> : null}
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

      <SignoffCard runId={shownRun?.status === "done" ? shownRun.id : undefined} />

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
                const truth = [e.target && e.target !== "ask" ? `対象: ${EVAL_TARGET_LABEL[e.target]}` : "", e.pick ? "記録を SQL で選ぶ" : "", e.contains?.length ? `含む: ${e.contains.join("・")}` : "", e.anyOf?.length ? `どれか: ${e.anyOf.join("・")}` : "", e.numbers?.length ? `数字: ${e.numbers.join("・")}` : "", e.sql ? "SQL" : "", e.forbidSql ? "権限 (出してはいけない値)" : "", e.sources?.length ? `根拠: ${e.sources.join("・")}` : "", e.forbidSources?.length ? `出してはいけない根拠: ${e.forbidSources.join("・")}` : "", e.unknown ? "「ない」と答える" : "", e.refuse ? "断る" : "", e.links?.length ? `画面: ${e.links.join("・")}` : ""].filter(Boolean).join(" / ");
                return (
                  <Tr key={c.id} className={c.active ? "" : "opacity-50"}>
                    <Td className="text-xs">{categoryLabel(c.category)}</Td>
                    <Td className="max-w-[320px] text-sm">
                      {c.history.length > 0 && <span className="block text-[11px] text-ink-3">前: {c.history.join(" → ")}</span>}
                      {c.question}
                    </Td>
                    <Td className="text-xs">
                      {matrixLabel(c) || (
                        <>
                          {ROLE_LABEL[c.role as Role] ?? c.role}
                          {c.storeId ? `・${stores.find((s) => s.id === c.storeId)?.shortName ?? c.storeId}` : ""}
                        </>
                      )}
                      {c.representative && <Badge tone="accent" dot={false} className="ml-1">代表</Badge>}
                    </Td>
                    <Td className="max-w-[240px] text-xs text-ink-2">{truth}</Td>
                    <Td>{(() => {
                      const mine = results.filter((r) => r.caseId === c.id && !r.outcome.skipped);
                      if (!mine.length) return last?.outcome.skipped ? <span className="text-xs text-ink-3">対象なし</span> : <span className="text-xs text-ink-3">-</span>;
                      const okN = mine.filter((r) => r.ok).length;
                      return <Badge tone={okN === mine.length ? "good" : "critical"}>{mine.length > 1 ? `${okN}/${mine.length} 合格` : okN ? "合格" : "不合格"}</Badge>;
                    })()}</Td>
                    <Td align="right">
                      <div className="flex justify-end gap-1">
                        <Link href={`/ai?tab=quality&edit=${c.id}#case-form`} className="rounded-lg px-2 py-1 text-xs text-accent hover:bg-subtle">
                          直す
                        </Link>
                        <form action={toggleChatbotEvalRepresentative.bind(null, c.id)}>
                          <button className="rounded-lg px-2 py-1 text-xs text-ink-2 hover:bg-subtle">{c.representative ? "代表から外す" : "代表にする"}</button>
                        </form>
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
          <details className="rounded-xl border border-line/70 p-3" open={Boolean(editing?.expect.target && editing.expect.target !== "ask") || Boolean(editing?.expect.pick) || Boolean(editing?.expect.matrix)}>
            <summary className="cursor-pointer text-xs font-medium text-ink">対象・実際の記録・ロールの組み合わせ (社内資料・要約・文書の作成・全ロールの確かめ)</summary>
            <div className="mt-3 space-y-3">
              <div className="grid grid-cols-1 gap-3 @xl:grid-cols-3">
                <Field label="確かめるもの">
                  <Select name="target" defaultValue={editing?.expect.target ?? "ask"}>
                    {Object.entries(EVAL_TARGET_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </Select>
                </Field>
                <label className="flex items-center gap-2 self-end text-xs">
                  <input type="checkbox" name="representative" defaultChecked={editing?.representative} /> 代表シナリオ (お客様の承認の対象)
                </label>
              </div>
              <Field label="対象の記録を選ぶ SQL (1 行目の列を {列名} で質問・正解・根拠に入れる。:store = 聞く人の店舗)" hint="例: select o.id, o.number, c.name customer_name from orders o join customers c on c.id = o.customer_id where o.store_id = :store order by o.contract_date desc limit 1">
                <Textarea name="pick" rows={2} defaultValue={editing?.expect.pick ?? ""} className="font-mono text-xs" />
              </Field>
              <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
                <Field label="対象を選ぶ SQL の閲覧範囲">
                  <Select name="pickScope" defaultValue={editing?.expect.pickScope ?? "admin"}>
                    <option value="admin">全社 (管理者)</option>
                    <option value="user">聞く人の閲覧範囲</option>
                  </Select>
                </Field>
                <Field label="正解の数字にする列 (| で区切る)">
                  <Input name="pickNumbers" defaultValue={editing?.expect.pickNumbers?.join("|") ?? ""} placeholder="例: balance" />
                </Field>
                <Field label="必要な根拠のリンク (すべて。| で区切る。{列名} 可)">
                  <Input name="sources" defaultValue={editing?.expect.sources?.join("|") ?? ""} placeholder="例: /knowledge/{id}" />
                </Field>
                <Field label="出してはいけない根拠のリンク (| で区切る)">
                  <Input name="forbidSources" defaultValue={editing?.expect.forbidSources?.join("|") ?? ""} placeholder="例: /orders/{id}" />
                </Field>
              </div>
              <div className="text-xs">
                <span className="mr-2 text-ink-3">ロールの組み合わせ (選ぶと、ロール × 店舗ごとの社員として聞く)</span>
                {(Object.keys(ROLE_LABEL) as Role[]).map((r) => (
                  <label key={r} className="mr-3 inline-flex items-center gap-1">
                    <input type="checkbox" name="matrixRoles" value={r} defaultChecked={editing?.expect.matrix?.roles.includes(r)} /> {ROLE_LABEL[r]}
                  </label>
                ))}
                <label className="inline-flex items-center gap-1">
                  <input type="checkbox" name="matrixStores" value="all" defaultChecked={editing?.expect.matrix?.stores === "all"} /> 店舗のロールは全店舗で
                </label>
              </div>
              <div className="grid grid-cols-1 gap-3 @xl:grid-cols-4">
                <Field label="要約: 記録の種類">
                  <Select name="summaryKind" defaultValue={editing?.expect.summary?.kind ?? "order"}>
                    {Object.entries(SUMMARY_KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </Select>
                </Field>
                <Field label="要約: 記録の ID ({列名} 可)"><Input name="summaryId" defaultValue={editing?.expect.summary?.id ?? ""} placeholder="{id}" /></Field>
                <Field label="要約: 直近の日数 (空 = 全期間)"><Input name="summaryDays" type="number" min={0} defaultValue={editing?.expect.summary?.days ?? ""} /></Field>
                <Field label={`要約: 内容 (| で区切る: ${Object.keys(SECTION_LABEL).join("・")})`}><Input name="summarySections" defaultValue={editing?.expect.summary?.sections?.join("|") ?? ""} placeholder="例: billing|comms" /></Field>
              </div>
              <div className="grid grid-cols-1 gap-3 @xl:grid-cols-4">
                <Field label="文書: ひな形">
                  <Select name="draftTemplate" defaultValue={editing?.expect.draft?.template ?? "quote_send"}>
                    {Object.entries(DRAFT_TEMPLATES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                  </Select>
                </Field>
                <Field label="文書: 形式">
                  <Select name="draftFormat" defaultValue={editing?.expect.draft?.format ?? "email"}>
                    {Object.entries(DRAFT_FORMAT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </Select>
                </Field>
                <Field label="文書: 記録の番号 ({列名} 可)"><Input name="draftRef" defaultValue={editing?.expect.draft?.ref ?? ""} placeholder="{number}" /></Field>
                <Field label="文書: 要点"><Input name="draftNotes" defaultValue={editing?.expect.draft?.notes ?? ""} /></Field>
              </div>
            </div>
          </details>
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

/** 代表シナリオのお客様の承認 (受入の確認): 評価の結果を読んで承認した人・日時・版を残す。版が変わる・不合格になると再確認 */
function SignoffCard({ runId }: { runId?: number }) {
  const status = signoffStatus();
  const ready = runId ? signoffReadiness(runId) : undefined;
  const history = listSignoffs(5);
  const reps = listEvalCases({ activeOnly: true }).filter((c) => c.representative);
  return (
    <Card id="signoff">
      <CardHeader
        title="代表シナリオのお客様の承認"
        description={`代表シナリオ ${reps.length} 件 (正解付きの質問で「代表にする」)。AI アシスタントを変えたら評価を実行し、お客様 (一畳屋の責任者) が回答を読んで承認します。承認のあとに代表シナリオが不合格になる・アプリの版が変わってまだ評価していないときは「要再確認」になります`}
        icon={<ShieldCheck />}
        action={runId ? <a href={`/print/ai-acceptance?run=${runId}`} target="_blank" rel="noopener" className="inline-flex h-8 items-center rounded-xl border border-line bg-panel px-3 text-xs hover:bg-subtle">受入確認書を印刷</a> : undefined}
      />
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <Badge tone={status.state === "valid" ? "good" : status.state === "recheck" ? "critical" : "warn"}>{status.state === "valid" ? "承認済み" : status.state === "recheck" ? "要再確認" : "未承認"}</Badge>
        {status.signoff && <span className="text-xs text-ink-2">承認 #{status.signoff.id}: {fmtAt(status.signoff.createdAt)} · {status.signoff.signerName}{status.signoff.signerOrg ? ` (${status.signoff.signerOrg})` : ""} · 評価 #{status.signoff.runId} · 版 {status.signoff.revision.slice(0, 7) || "-"} · {status.signoff.scenarios.length} 件</span>}
      </div>
      {status.reasons.length > 0 && status.state !== "valid" && <ul className="mb-3 space-y-0.5 text-xs text-warn-ink">{status.reasons.map((r, i) => <li key={i}>・{r}</li>)}</ul>}
      {runId && ready && (
        <div className="space-y-3 rounded-xl border border-line/70 p-3">
          <p className="text-xs font-medium text-ink">評価 #{runId} の代表シナリオ ({ready.scenarios.length} 件)</p>
          <div className="space-y-1.5">
            {ready.scenarios.map((x, i) => (
              <details key={i} className="rounded-lg border border-line/60 px-2.5 py-1.5 text-xs">
                <summary className="flex cursor-pointer flex-wrap items-center gap-2">
                  <Badge tone={x.ok ? "good" : "critical"}>{x.ok ? "合格" : "不合格"}</Badge>
                  <span className="text-ink-3">{categoryLabel(x.category)}・{x.variant}</span>
                  <span className="min-w-0 flex-1 break-words text-ink">{x.question}</span>
                </summary>
                <div className="mt-1.5 space-y-1 text-ink-2">
                  {x.answerNote && <p>正しい回答 (説明): {x.answerNote}</p>}
                  {x.expected && <p>正解の条件: {x.expected}</p>}
                  <p className="whitespace-pre-wrap rounded bg-subtle p-2 text-ink">{x.answer || "(回答なし)"}</p>
                </div>
              </details>
            ))}
          </div>
          {ready.ok ? (
            <form action={signoffChatbotEval} className="grid grid-cols-1 gap-2 @xl:grid-cols-3">
              <input type="hidden" name="runId" value={runId} />
              <Field label="承認した方のお名前" required><Input name="signerName" required maxLength={60} /></Field>
              <Field label="会社・役職"><Input name="signerOrg" maxLength={60} placeholder="例: 株式会社一畳屋 代表取締役" /></Field>
              <Field label="コメント"><Input name="comment" maxLength={2000} /></Field>
              <label className="flex items-center gap-2 text-xs @xl:col-span-3">
                <input type="checkbox" name="confirmRead" required /> 代表シナリオの質問と回答をすべて読み、この内容で使うことを承認します
              </label>
              <div className="@xl:col-span-3"><Button size="sm">承認を記録する</Button></div>
            </form>
          ) : (
            <ul className="space-y-0.5 text-xs text-warn-ink">{ready.reasons.map((r, i) => <li key={i}>・{r}</li>)}</ul>
          )}
        </div>
      )}
      {history.length > 0 && (
        <div className="mt-3 space-y-1 text-xs">
          <p className="font-medium text-ink">承認の記録</p>
          {history.map((h) => (
            <div key={h.id} className="flex flex-wrap items-center gap-2 text-ink-2">
              <span>#{h.id} {fmtAt(h.createdAt)} {h.signerName} · 評価 #{h.runId} · 版 {h.revision.slice(0, 7) || "-"}</span>
              {h.revokedAt ? (
                <Badge tone="neutral" dot={false}>取り消し {fmtAt(h.revokedAt)} ({h.revokeReason})</Badge>
              ) : (
                <form action={revokeChatbotSignoff.bind(null, h.id)} className="flex items-center gap-1">
                  <Input name="reason" placeholder="取り消しの理由" className="h-7 w-40 text-xs" />
                  <Button size="sm" variant="ghost">取り消す</Button>
                </form>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
