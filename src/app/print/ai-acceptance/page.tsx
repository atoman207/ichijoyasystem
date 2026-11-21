import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { canManageChatbot } from "@/lib/auth/permissions";
import { ACCEPTANCE, categoryLabel, getEvalRun, getSignoff, listSignoffs, representativeScenarios } from "@/lib/chatbot/eval";
import { toDateKey } from "@/lib/format";
import { PrintToolbar } from "@/components/features/PrintToolbar";

export const dynamic = "force-dynamic";

const pct = (v: number | null | undefined) => (v === null || v === undefined ? "-" : `${Math.round(v * 1000) / 10}%`);
const at = (iso?: string) => (iso ? new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }) : "-");

/**
 * AI アシスタントの受入確認書 (A4 縦): 評価の受入基準と代表シナリオの質問・回答・合否、承認欄 (承認済みなら承認者・日時)
 * 管理者だけ (AI アシスタント →「品質・費用」→「受入確認書を印刷」)
 */
export default async function AiAcceptancePrintPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  if (!canManageChatbot(user)) redirect("/ai?err=" + encodeURIComponent("受入確認書は管理者が印刷できます。"));
  const runId = Number(sp.run);
  const run = runId ? getEvalRun(runId) : undefined;
  if (!run) redirect("/ai?tab=quality&err=" + encodeURIComponent("評価が見つかりません。"));
  const scenarios = representativeScenarios(run.id);
  const signoff = sp.signoff ? getSignoff(Number(sp.signoff)) : listSignoffs(20).find((s) => s.runId === run.id && !s.revokedAt);
  const m = run.metrics;

  return (
    <div className="min-h-screen bg-subtle py-6 print:bg-white print:py-0">
      <style>{"@page { size: A4 portrait; margin: 12mm; }"}</style>
      <PrintToolbar backHref="/ai?tab=quality#signoff" />
      <div className="mx-auto w-[210mm] max-w-full bg-white px-[12mm] py-[12mm] text-[11px] leading-relaxed text-ink shadow print:w-auto print:px-0 print:py-0 print:shadow-none">
        <h1 className="text-lg font-semibold tracking-wide">AI アシスタント 受入確認書</h1>
        <p className="text-ink-2">
          株式会社一畳屋 統合業務システム · 評価 #{run.id} ({at(run.finishedAt ?? run.startedAt)}・{run.label || "手動"}・{run.provider || "-"}) · アプリの版 {run.revision ? run.revision.slice(0, 7) : "-"} · 出力 {toDateKey(new Date()).replaceAll("-", "/")}
        </p>

        <h2 className="mt-4 mb-1 text-sm font-semibold">1. 受入基準</h2>
        {m ? (
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-ink/40 text-left"><th className="py-1">項目</th><th>基準</th><th>結果</th><th>合否</th></tr>
            </thead>
            <tbody>
              {ACCEPTANCE.map((a) => (
                <tr key={a.key} className="border-b border-line">
                  <td className="py-1">{a.label}</td>
                  <td>{a.target}</td>
                  <td>{a.key === "accuracy" ? `${pct(m.accuracy)} (${m.passed}/${m.total})` : a.key === "violations" ? `${m.violations} 件` : a.key === "badScreens" ? `${m.badScreens} 件` : a.key === "ungrounded" ? `${m.ungrounded} 件` : a.key === "numeric" ? pct(m.numericRate) : a.key === "unknown" ? pct(m.unknownRate) : a.key === "refuse" ? pct(m.refuseRate) : a.key === "evidence" ? pct(m.evidenceRate) : pct(m.sourceRate)}</td>
                  <td>{a.pass(m) ? "合格" : "未達"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p>この評価の指標はありません。</p>
        )}
        {m?.byRole && (
          <p className="mt-1 text-ink-2">聞いた人ごと: {Object.entries(m.byRole).map(([k, v]) => `${k} ${v.passed}/${v.total}${v.violations ? ` (権限違反 ${v.violations})` : ""}`).join(" · ")}</p>
        )}

        <h2 className="mt-4 mb-1 text-sm font-semibold">2. 代表シナリオ ({scenarios.length} 件・合格 {scenarios.filter((x) => x.ok).length} 件)</h2>
        <ol className="space-y-2">
          {scenarios.map((x, i) => (
            <li key={i} className="break-inside-avoid border-b border-line pb-2">
              <div className="font-medium">
                {i + 1}. [{x.ok ? "合格" : "不合格"}] {x.question} <span className="font-normal text-ink-2">({categoryLabel(x.category)}・{x.variant})</span>
              </div>
              {x.answerNote && <div className="text-ink-2">正しい回答: {x.answerNote}</div>}
              <div className="mt-0.5 whitespace-pre-wrap">{x.answer.slice(0, 1500) || "(回答なし)"}</div>
            </li>
          ))}
          {!scenarios.length && <li>代表シナリオがありません。</li>}
        </ol>

        <h2 className="mt-4 mb-1 text-sm font-semibold">3. 承認</h2>
        {signoff && !signoff.revokedAt ? (
          <p>
            上記の代表シナリオの質問と回答を確認し、承認しました。承認 #{signoff.id} · {at(signoff.createdAt)} · {signoff.signerName}
            {signoff.signerOrg ? ` (${signoff.signerOrg})` : ""}
            {signoff.comment ? ` · ${signoff.comment}` : ""}
          </p>
        ) : (
          <div className="mt-2 grid grid-cols-2 gap-6">
            <div className="border-b border-ink/60 pb-6">確認日: 　　　年　　月　　日</div>
            <div className="border-b border-ink/60 pb-6">承認者 (署名):</div>
          </div>
        )}
        <p className="mt-4 text-[10px] text-ink-3">AI の回答は、受入基準と正解付きの質問で定期的に確かめています (AI アシスタント →「品質・費用」)。AI アシスタントを変えたときは評価を実行し、代表シナリオが合格していることを確かめてから使います。</p>
      </div>
    </div>
  );
}
