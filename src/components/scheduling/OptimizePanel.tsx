"use client";

import { useState, useTransition } from "react";
import clsx from "clsx";
import { ArrowRight, Loader2, Shuffle, Sparkles } from "lucide-react";
import Link from "@/components/ui/Link";
import type { StoreId } from "@/lib/db/types";
import type { OptimizeResult, PlanSummary } from "@/lib/scheduling/optimize";
import { optimizeScheduleAction } from "@/lib/actions/scheduling";
import { Button, Field, Input, Select } from "@/components/ui";
import { CandidateView, HoldButton, whenLabel } from "./CandidateView";
import { RouteList } from "./RoutesPanel";

/**
 * 全体の最適化 (計画の画面「最適化」)
 * 日程のない案件を選んでまとめて配置する。「いまの予定を変えない案」と「一部を動かす案」を並べて比べる。
 * 結果は提案だけ (仮押さえ・予定の変更は利用者が行う)
 */

export interface WaitingRow {
  key: string;
  label: string;
  kind: string;
  kindLabel: string;
  storeId: StoreId;
  storeName: string;
  since: string;
  why: string;
  href: string;
}

const METRICS: { key: keyof PlanSummary; label: string; unit: string; better: "low" | "high" }[] = [
  { key: "placed", label: "配置できた案件", unit: "件", better: "high" },
  { key: "avgScore", label: "平均の点数", unit: "点", better: "high" },
  { key: "travelMin", label: "移動の合計", unit: "分", better: "low" },
  { key: "helpCount", label: "応援", unit: "件", better: "low" },
  { key: "overtimeMin", label: "残業の見込み", unit: "分", better: "low" },
  { key: "lateCount", label: "期限に遅れる", unit: "件", better: "low" },
];

export function OptimizePanel({ stores, waiting, defaultStore, today }: { stores: { id: StoreId; name: string }[]; waiting: WaitingRow[]; defaultStore: StoreId | "all"; today: string }) {
  const [store, setStore] = useState<string>(defaultStore);
  const [from, setFrom] = useState(today);
  const [days, setDays] = useState("21");
  const [mode, setMode] = useState<"keep" | "rearrange">("keep");
  const [picked, setPicked] = useState<Set<string>>(() => new Set(waiting.filter((w) => defaultStore === "all" || w.storeId === defaultStore).slice(0, 12).map((w) => w.key)));
  const [result, setResult] = useState<OptimizeResult | null>(null);
  const [error, setError] = useState("");
  const [pending, start] = useTransition();
  const rows = waiting.filter((w) => store === "all" || w.storeId === store);

  const run = () => {
    setError("");
    start(async () => {
      try {
        const to = new Date(Date.parse(from) + (Number(days) || 21) * 86_400_000).toISOString().slice(0, 10);
        const storeIds = store === "all" ? [...new Set(rows.filter((w) => picked.has(w.key)).map((w) => w.storeId))] : [store];
        const r = await optimizeScheduleAction({ storeIds: storeIds.length ? storeIds : stores.map((s) => s.id), from, to, mode, jobKeys: rows.filter((w) => picked.has(w.key)).map((w) => w.key), maxMoves: 5 });
        if ("error" in r) setError(r.error);
        else setResult(r);
      } catch {
        setError("計算できませんでした。画面を再読み込みしてから、もう一度お試しください。");
      }
    });
  };

  const toggle = (k: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 @3xl:grid-cols-4">
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
        <Field label="探す期間の始まり">
          <Input type="date" value={from} min={today} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="日数">
          <Input type="number" min={7} max={62} value={days} onChange={(e) => setDays(e.target.value)} />
        </Field>
        <Field label="既存の予定">
          <Select value={mode} onChange={(e) => setMode(e.target.value === "rearrange" ? "rearrange" : "keep")}>
            <option value="keep">変えない (新しい案件だけ配置)</option>
            <option value="rearrange">一部を動かす案も出す (最大 5 件)</option>
          </Select>
        </Field>
      </div>

      <div className="rounded-xl border border-line">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-subtle/60 px-3 py-2 text-xs text-ink-2">
          <span>
            日程のない案件 {rows.length} 件 (選択 {rows.filter((w) => picked.has(w.key)).length} 件)
          </span>
          <span className="flex gap-2">
            <button type="button" className="text-accent hover:underline" onClick={() => setPicked(new Set(rows.slice(0, 40).map((w) => w.key)))}>
              すべて選ぶ
            </button>
            <button type="button" className="text-accent hover:underline" onClick={() => setPicked(new Set())}>
              選択を外す
            </button>
          </span>
        </div>
        <ul className="max-h-72 divide-y divide-line overflow-y-auto">
          {rows.length === 0 && <li className="px-3 py-4 text-center text-xs text-ink-3">日程のない案件はありません。</li>}
          {rows.map((w) => (
            <li key={w.key} className="flex items-start gap-2 px-3 py-2 text-xs">
              <input type="checkbox" className="mt-0.5" checked={picked.has(w.key)} onChange={() => toggle(w.key)} aria-label={w.label} />
              <div className="min-w-0 flex-1">
                <Link href={w.href} className="font-medium text-ink hover:text-accent hover:underline">
                  {w.label}
                </Link>
                <p className="text-ink-3">
                  {w.storeName}・{w.why}・{w.since} から
                </p>
              </div>
              <span className="shrink-0 rounded-full bg-neutral-soft px-2 py-0.5 text-[10px] text-ink-2">{w.kindLabel}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={run} disabled={pending || (mode === "keep" && !rows.some((w) => picked.has(w.key)))}>
          {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : mode === "keep" ? <Sparkles className="h-4 w-4" aria-hidden /> : <Shuffle className="h-4 w-4" aria-hidden />}
          {pending ? "計算しています…" : "まとめて配置を計算する"}
        </Button>
        <p className="text-[11px] text-ink-3">計算するだけで、予定は変わりません。良い案は「仮押さえ」してから確定します。</p>
      </div>
      {error && <p className="text-sm text-critical-ink">{error}</p>}

      {result && (
        <div className="space-y-4">
          <div className="overflow-x-auto rounded-xl border border-line">
            <table className="w-full min-w-[520px] text-xs">
              <thead>
                <tr className="bg-subtle text-ink-2">
                  <th className="px-3 py-2 text-left font-medium">比べる指標</th>
                  <th className="px-3 py-2 text-right font-medium">いまの予定を変えない案</th>
                  {mode === "rearrange" && <th className="px-3 py-2 text-right font-medium">一部を動かす案</th>}
                </tr>
              </thead>
              <tbody>
                {METRICS.map((m) => {
                  const a = result.keepSummary[m.key];
                  const b = result.summary[m.key];
                  const better = m.better === "low" ? b < a : b > a;
                  return (
                    <tr key={m.key} className="border-t border-line">
                      <td className="px-3 py-1.5 text-ink-2">{m.label}</td>
                      <td className="px-3 py-1.5 text-right tnum">
                        {a} {m.unit}
                      </td>
                      {mode === "rearrange" && (
                        <td className={clsx("px-3 py-1.5 text-right tnum", better && "font-semibold text-good-ink")}>
                          {b} {m.unit}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {result.notes.map((n) => (
            <p key={n} className="text-xs text-ink-2">
              {n}
            </p>
          ))}

          <div>
            <h3 className="mb-2 text-sm font-semibold text-ink">新しい案件の配置</h3>
            <ul className="space-y-2">
              {result.placements.map((p) => (
                <li key={p.key} className="rounded-xl border border-line bg-panel px-3 py-2.5">
                  <p className="mb-1 text-xs font-medium text-ink-2">{p.label}</p>
                  {p.candidate ? (
                    <div className="flex flex-col gap-2 @3xl:flex-row @3xl:items-start @3xl:justify-between">
                      <CandidateView c={p.candidate} compact />
                      <HoldButton
                        base={{ storeId: p.storeId, kind: p.kind, title: p.request?.title, orderId: p.request?.orderId, quoteId: p.request?.quoteId, inquiryId: p.request?.inquiryId, customerId: p.request?.customerId, location: p.request?.location }}
                        candidates={[p.candidate, ...p.alternatives.slice(0, 2)]}
                        label={p.alternatives.length ? `第 1〜${Math.min(3, 1 + p.alternatives.length)} 候補を仮押さえ` : "仮押さえ"}
                      />
                    </div>
                  ) : (
                    <p className="text-xs text-critical-ink">{p.reason ?? "入れられる日がありません"}</p>
                  )}
                </li>
              ))}
            </ul>
          </div>

          {result.moves.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-semibold text-ink">動かすと良くなる既存の予定 (お客様・担当者に連絡してから変更)</h3>
              <ul className="space-y-2">
                {result.moves.map((m) => (
                  <li key={m.eventId} className="rounded-xl border border-warn/40 bg-warn-soft/40 px-3 py-2.5 text-xs">
                    <p className="font-medium text-ink">
                      <Link href={`/schedule/${m.eventId}`} className="hover:text-accent hover:underline">
                        {m.title}
                      </Link>
                      <span className="ml-2 rounded-full bg-good-soft px-2 py-0.5 text-[10px] text-good-ink">+{m.gain} 点</span>
                    </p>
                    <p className="mt-1 flex flex-wrap items-center gap-1 text-ink-2">
                      <span className="tnum">{whenLabel({ date: m.from.date, startTime: m.from.startTime, slot: (m.from.slot as "am" | "pm" | undefined) ?? "day" })}</span>
                      <ArrowRight className="h-3 w-3" aria-hidden />
                      <span className="font-semibold tnum text-ink">{whenLabel(m.to)}</span>
                      <span className="text-ink-3">({m.from.score} 点 → {m.to.score} 点)</span>
                    </p>
                    <Link href={`/schedule/${m.eventId}/edit?date=${m.to.date}${m.to.startTime ? `&start=${m.to.startTime}` : ""}`} className="mt-1 inline-block font-medium text-accent hover:underline">
                      この予定を変更する →
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {result.routes.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-semibold text-ink">この案の 1 日の巡回順</h3>
              <RouteList routes={result.routes} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
