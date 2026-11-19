"use client";

import { useState, useTransition } from "react";
import clsx from "clsx";
import { FlaskConical, Loader2 } from "lucide-react";
import type { StoreId } from "@/lib/db/types";
import type { BacktestMetrics, BacktestResult } from "@/lib/scheduling/backtest";
import type { Weights } from "@/lib/scheduling/masters";
import { applyTunedWeightsForm, runBacktestAction } from "@/lib/actions/scheduling";
import { Button, Field, Input, Select } from "@/components/ui";

/** 提案の検証の実行と結果 (指標の表・重みの候補・比べた予定の一覧) */

const WEIGHT_NAMES: Record<string, string> = { route: "移動", capacity: "店舗の空き", production: "製造", staff: "負担", earliness: "早さ", experience: "経験", preference: "希望", deadline: "期限", help: "応援", overtime: "残業", move: "移動の減点" };

type Last = { ranAt: string; by: string; metrics?: BacktestMetrics; tuned?: { weights: Weights; metrics: BacktestMetrics; objectiveBefore: number; objectiveAfter: number }; notes: string[] };

function MetricsTable({ m, tuned }: { m: BacktestMetrics; tuned?: BacktestMetrics }) {
  const rows: [string, string, string, string?][] = [
    ["比べた予定", `${m.samples} 件`, ""],
    ["当時の日が条件を満たす候補に入った", `${m.feasible}%`, "", tuned ? `${tuned.feasible}%` : undefined],
    ["提案の 1 位 = 当時の日", `${m.top1}%`, "", tuned ? `${tuned.top1}%` : undefined],
    ["上位 3 件に当時の日", `${m.top3}%`, "", tuned ? `${tuned.top3}%` : undefined],
    ["移動 (1 件あたり・目安)", `当時 ${m.avgTravelActual} 分`, `提案 ${m.avgTravelTop} 分`, tuned ? `${tuned.avgTravelTop} 分` : undefined],
    ["決めた日から予定の日まで", `当時 ${m.avgWaitActual} 日`, `提案 ${m.avgWaitTop} 日`, tuned ? `${tuned.avgWaitTop} 日` : undefined],
    ["残業の見込み (合計)", `当時 ${m.overtimeActual} 分`, `提案 ${m.overtimeTop} 分`, tuned ? `${tuned.overtimeTop} 分` : undefined],
    ["1 日あたりの案件の予定 (実績)", `${m.jobsPerDay} 件`, ""],
  ];
  return (
    <div className="overflow-x-auto rounded-xl border border-line">
      <table className="w-full min-w-[560px] text-xs">
        <thead>
          <tr className="bg-subtle text-left text-ink-2">
            <th className="px-3 py-2 font-medium">指標</th>
            <th className="px-3 py-2 font-medium">いまの重み</th>
            <th className="px-3 py-2 font-medium" />
            {tuned && <th className="px-3 py-2 font-medium text-good-ink">調整した重み</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, a, b, c]) => (
            <tr key={label} className="border-t border-line">
              <td className="px-3 py-1.5 text-ink-2">{label}</td>
              <td className="px-3 py-1.5 tnum">{a}</td>
              <td className="px-3 py-1.5 tnum">{b}</td>
              {tuned && <td className="px-3 py-1.5 tnum font-semibold text-good-ink">{c ?? ""}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function BacktestPanel({ stores, canApply, focus, last }: { stores: { id: StoreId; name: string }[]; canApply: boolean; focus: string; last?: Last }) {
  const [months, setMonths] = useState("6");
  const [store, setStore] = useState("all");
  const [samples, setSamples] = useState("80");
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [error, setError] = useState("");
  const [pending, start] = useTransition();
  const view = result ? { metrics: result.metrics, tuned: result.tuned, notes: result.notes, ranAt: result.ranAt } : last;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="期間">
          <Select value={months} onChange={(e) => setMonths(e.target.value)}>
            {[3, 6, 9, 12].map((n) => (
              <option key={n} value={n}>
                過去 {n} か月
              </option>
            ))}
          </Select>
        </Field>
        <Field label="店舗">
          <Select value={store} onChange={(e) => setStore(e.target.value)}>
            <option value="all">全店舗</option>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="比べる予定の数">
          <Input type="number" min={10} max={300} value={samples} onChange={(e) => setSamples(e.target.value)} className="w-24" />
        </Field>
        <Button
          type="button"
          disabled={pending}
          onClick={() =>
            start(async () => {
              setError("");
              const r = await runBacktestAction({ months: Number(months), storeIds: store === "all" ? [] : [store], maxSamples: Number(samples) || 80, tune: true }).catch(() => ({ error: "検証できませんでした。" }));
              if ("error" in r) setError(r.error);
              else setResult(r);
            })
          }
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <FlaskConical className="h-4 w-4" aria-hidden />}
          {pending ? "検証しています… (1 分ほど)" : "検証する"}
        </Button>
      </div>
      {error && <p className="text-sm text-critical-ink">{error}</p>}
      {view?.metrics && (
        <>
          <p className="text-xs text-ink-3">
            {view.ranAt ? `${view.ranAt.slice(0, 16).replace("T", " ")} の結果` : ""}
            {last && !result ? ` (${last.by})` : ""}
            {result ? `・${Math.round(result.ms / 100) / 10} 秒` : ""}・重視する指標: {{ balanced: "バランス", travel: "移動", speed: "早さ", deadline: "期限", revenue: "売上・粗利" }[focus] ?? focus}
          </p>
          <MetricsTable m={view.metrics} tuned={view.tuned?.metrics} />
          {view.notes.map((n) => (
            <p key={n} className="text-[11px] text-ink-3">
              ・{n}
            </p>
          ))}
          {view.tuned && view.tuned.objectiveAfter > view.tuned.objectiveBefore && (
            <div className="rounded-xl border border-good/40 bg-good-soft/30 px-3 py-2.5 text-xs">
              <p className="font-medium text-ink">
                重みを調整すると、目的の値が {view.tuned.objectiveBefore} → {view.tuned.objectiveAfter} になります
              </p>
              <p className="mt-1 text-ink-2">
                {Object.entries(view.tuned.weights)
                  .map(([k, v]) => `${WEIGHT_NAMES[k] ?? k} ${Math.round(Number(v) * 1000) / 10}`)
                  .join("・")}
              </p>
              {canApply ? (
                <form action={applyTunedWeightsForm} className="mt-2 flex flex-wrap items-center gap-2">
                  <input type="hidden" name="weights" value={JSON.stringify(view.tuned.weights)} />
                  <Input name="note" placeholder="メモ (任意)" className="h-8 w-56 text-xs" defaultValue={`検証 ${view.metrics.samples} 件から`} />
                  <Button type="submit" size="sm">
                    この重みを適用する
                  </Button>
                </form>
              ) : (
                <p className="mt-1 text-ink-3">重みの適用は管理者が行います。</p>
              )}
            </div>
          )}
        </>
      )}
      {result && result.samples.length > 0 && (
        <details className="rounded-xl border border-line px-3 py-2 text-xs">
          <summary className="cursor-pointer text-ink-2">比べた予定 ({result.samples.length} 件)</summary>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[640px]">
              <thead>
                <tr className="text-left text-ink-3">
                  <th className="py-1 pr-2 font-medium">予定</th>
                  <th className="py-1 pr-2 font-medium">決めた日</th>
                  <th className="py-1 pr-2 font-medium">当時の日</th>
                  <th className="py-1 pr-2 font-medium">提案の 1 位</th>
                  <th className="py-1 pr-2 font-medium">当時の日の順位</th>
                </tr>
              </thead>
              <tbody>
                {result.samples.map((s) => (
                  <tr key={s.eventId} className="border-t border-line">
                    <td className="py-1 pr-2">{s.title}</td>
                    <td className="py-1 pr-2 tnum">
                      {s.decidedOn}
                      {s.decidedEstimated ? " (推定)" : ""}
                    </td>
                    <td className="py-1 pr-2 tnum">{s.actualDate}</td>
                    <td className="py-1 pr-2 tnum">{s.top ? `${s.top.date} (${s.top.score} 点)` : "-"}</td>
                    <td className={clsx("py-1 pr-2 tnum", s.rank === 1 ? "font-semibold text-good-ink" : s.rank && s.rank <= 3 ? "text-info-ink" : "text-ink-3")}>{s.rank ? `${s.rank} 位` : "候補外"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}
