"use client";

import { Fragment, useState, useTransition, type ReactNode } from "react";
import { Copy, Sparkles } from "lucide-react";
import Link from "@/components/ui/Link";
import { summarizeRecord } from "@/lib/actions/ai";
import { SECTIONS_BY_KIND, SECTION_LABEL, SUMMARY_PERIODS, type SummaryKind, type SummaryResult, type SummarySection, type SummarySource } from "@/lib/ai/summary-sections";

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** 要約の文の [P3]・[B1, B2] を、根拠の記録へのリンクにする */
function withRefs(text: string, byRef: Map<string, SummarySource>): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(/\[([A-Z]\d{1,4}(?:, [A-Z]\d{1,4})*)\]/g)) {
    out.push(text.slice(last, m.index));
    const refs = m[1].split(", ");
    out.push(
      <span key={`${m.index}`} className="whitespace-nowrap text-[11px]">
        [
        {refs.map((r, i) => {
          const s = byRef.get(r);
          return (
            <Fragment key={r}>
              {i > 0 && ", "}
              {s?.href ? <Link href={s.href} title={`${s.date ?? ""} ${s.label}`} className="text-accent hover:underline">{r}</Link> : <span title={s?.label}>{r}</span>}
            </Fragment>
          );
        })}
        ]
      </span>,
    );
    last = (m.index ?? 0) + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

/**
 * 「AI で要約」(見積・受注・経費・顧客・問い合わせの詳細画面)
 * 期間と内容の区分 (進捗・予定・請求・やりとり など) を選んで要約する。長い履歴は区分ごと・期間ごとに要約してから全体をまとめる。
 * 要約の文の記号 ([P3] など) と「根拠の記録」から元の記録を開ける。押したときだけ要約する (保存しない)
 */
export function AiSummary({ kind, id, label = "AI で要約" }: { kind: SummaryKind; id: string; label?: string }) {
  const available = SECTIONS_BY_KIND[kind];
  const [result, setResult] = useState<SummaryResult | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [period, setPeriod] = useState("0");
  const [from, setFrom] = useState(daysAgo(90));
  const [to, setTo] = useState(today());
  const [picked, setPicked] = useState<SummarySection[]>(available);
  const [pending, start] = useTransition();
  const run = () =>
    start(async () => {
      setError("");
      setCopied(false);
      try {
        const range = period === "custom" ? { from, to } : Number(period) > 0 ? { from: daysAgo(Number(period)), to: today() } : {};
        const r = await summarizeRecord(kind, id, { ...range, sections: picked.length === available.length ? [] : picked });
        if (!r.ok) setError(r.message ?? "要約できませんでした。");
        else setResult(r);
      } catch {
        setError("要約できませんでした。時間をおいてもう一度お試しください。");
      }
    });
  const byRef = new Map((result?.sources ?? []).map((s) => [s.ref, s]));
  return (
    <div className="rounded-xl border border-line bg-panel p-3" data-testid="ai-summary">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-sm font-medium text-ink"><Sparkles className="h-4 w-4 text-accent" aria-hidden /> 要約</span>
        <button type="button" onClick={run} disabled={pending || !picked.length} className="rounded-lg border border-line px-3 py-1 text-xs font-medium text-accent hover:bg-accent-soft disabled:opacity-60">
          {pending ? "まとめています… (最大 50 秒)" : result ? "この条件でもう一度要約する" : label}
        </button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-ink-2">
        <label className="inline-flex items-center gap-1">
          <span className="text-ink-3">期間</span>
          <select value={period} onChange={(e) => setPeriod(e.target.value)} className="field h-7 w-auto py-0 text-xs" aria-label="要約する期間">
            {SUMMARY_PERIODS.map((p) => <option key={p.days} value={String(p.days)}>{p.label}</option>)}
            <option value="custom">期間を指定</option>
          </select>
        </label>
        {period === "custom" && (
          <span className="inline-flex items-center gap-1">
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="field h-7 w-auto py-0 text-xs" aria-label="期間の始まり" />〜
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="field h-7 w-auto py-0 text-xs" aria-label="期間の終わり" />
          </span>
        )}
        {available.length > 1 && (
          <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-ink-3">内容</span>
            {available.map((s) => (
              <label key={s} className="inline-flex items-center gap-1">
                <input type="checkbox" className="h-3.5 w-3.5" checked={picked.includes(s)} onChange={(e) => setPicked((cur) => (e.target.checked ? available.filter((x) => x === s || cur.includes(x)) : cur.filter((x) => x !== s)))} />
                {SECTION_LABEL[s]}
              </label>
            ))}
          </span>
        )}
      </div>
      {error && <p className="mt-2 text-xs text-critical-ink">{error}</p>}
      {result && (
        <div className="mt-3 space-y-3">
          <p className="text-[11px] text-ink-3">範囲: {result.scope}</p>
          <div className="text-sm leading-relaxed whitespace-pre-wrap text-ink">{withRefs(result.overview, byRef)}</div>
          {result.sections.map((s) => (
            <section key={s.key} className="rounded-lg border border-line/70 p-2.5">
              <h3 className="text-xs font-semibold text-ink">
                {s.label} <span className="font-normal text-ink-3">({s.count} 件{s.used < s.count ? `・新しい ${s.used} 件を要約` : ""})</span>
              </h3>
              <div className="mt-1 text-sm leading-relaxed whitespace-pre-wrap text-ink">{withRefs(s.text, byRef)}</div>
            </section>
          ))}
          {result.sources.length > 0 && (
            <details className="rounded-lg border border-line/70 p-2.5">
              <summary className="cursor-pointer text-xs font-medium text-ink">根拠の記録 ({result.sources.length} 件) — 元の画面で確かめる</summary>
              <ul className="mt-2 max-h-72 space-y-0.5 overflow-y-auto text-xs">
                {result.sources.map((s) => (
                  <li key={s.ref} className="flex gap-2">
                    <span className="w-9 shrink-0 font-mono text-ink-3">{s.ref}</span>
                    <span className="w-20 shrink-0 text-ink-3">{s.date ?? ""}</span>
                    {s.href ? <Link href={s.href} className="min-w-0 truncate text-accent hover:underline">{s.label}</Link> : <span className="min-w-0 truncate">{s.label}</span>}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-3">
            <span>{result.provider === "openai" ? "OpenAI による要約" : result.provider === "claude" ? "Claude による要約" : "記録から自動でまとめました"}{result.calls && result.calls > 1 ? ` (区分ごとに要約してから全体をまとめました・AI ${result.calls} 回)` : ""}</span>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(result.text).then(() => setCopied(true));
              }}
              className="inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5 hover:bg-subtle"
            >
              <Copy className="h-3 w-3" aria-hidden /> {copied ? "コピーしました" : "コピー"}
            </button>
          </div>
          {result.message && <p className="text-[11px] text-warn-ink">{result.message}</p>}
          <p className="text-[11px] text-ink-3">要約は保存されません。[P3] などの記号を押すと元の記録を開きます。内容は元の記録で確認してください。</p>
        </div>
      )}
    </div>
  );
}
