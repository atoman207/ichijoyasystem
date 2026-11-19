"use client";

import { useState } from "react";
import clsx from "clsx";
import { ChartColumn, Download, Table2 } from "lucide-react";
import { BarList, StackedBarChart } from "@/components/charts";
import type { AnalysisResult, Cell, ColumnKind } from "@/lib/assistant/analyze";

/**
 * AI アシスタントの集計結果 (src/lib/assistant/analyze.ts) を表とグラフで表示する。
 * 表 ⇔ グラフの切り替えと CSV の保存 (Excel で開ける BOM つき) ができる
 */

const PALETTE = ["#3340b8", "#2a78d6", "#14a39a", "#e0a21a", "#e2603a", "#9b59d0", "#5f7186", "#c2417b", "#6aa84f", "#0e7490"];

export function formatCell(kind: ColumnKind, v: Cell | undefined): string {
  if (v === null || v === undefined || v === "") return kind === "text" ? "" : "-";
  if (typeof v === "string") return v;
  switch (kind) {
    case "yen":
      return `¥${Math.round(v).toLocaleString("ja-JP")}`;
    case "percent":
      return `${(v * 100).toFixed(1)}%`;
    case "count":
      return Math.round(v).toLocaleString("ja-JP");
    default:
      return v.toLocaleString("ja-JP", { maximumFractionDigits: 1 });
  }
}

function toCsv(r: AnalysisResult): string {
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const raw = (v: Cell | undefined) => (v === null || v === undefined ? "" : typeof v === "number" ? String(Math.round(v * 1000) / 1000) : v);
  const rows = [r.columns.map((c) => c.label), ...r.rows.map((row) => r.columns.map((c) => raw(row[c.key]))), ...(Object.keys(r.total).length ? [r.columns.map((c) => raw(r.total[c.key]))] : [])];
  return `﻿${rows.map((x) => x.map(esc).join(",")).join("\r\n")}`;
}

export function AnalysisTable({ result, compact = false }: { result: AnalysisResult; compact?: boolean }) {
  const [view, setView] = useState<"table" | "chart">("table");
  const chart = result.chart;
  const hasTotal = Object.keys(result.total).length > 0;

  const download = () => {
    const blob = new Blob([toCsv(result)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${result.title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 60)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-panel">
      <div className="flex flex-wrap items-start gap-2 border-b border-line bg-subtle/60 px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-ink">{result.title}</p>
          <p className="text-[11px] text-ink-3">
            期間 {result.period.label}
            {result.compareLabel ? ` · 比較 ${result.compareLabel}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {chart && (
            <div className="flex rounded-lg border border-line bg-panel p-0.5" role="tablist" aria-label="表示の切り替え">
              <button type="button" role="tab" aria-selected={view === "table"} onClick={() => setView("table")} className={clsx("grid h-6 w-7 place-items-center rounded-md", view === "table" ? "bg-accent text-white" : "text-ink-3 hover:text-ink")} title="表">
                <Table2 className="h-3.5 w-3.5" aria-hidden />
                <span className="sr-only">表</span>
              </button>
              <button type="button" role="tab" aria-selected={view === "chart"} onClick={() => setView("chart")} className={clsx("grid h-6 w-7 place-items-center rounded-md", view === "chart" ? "bg-accent text-white" : "text-ink-3 hover:text-ink")} title="グラフ">
                <ChartColumn className="h-3.5 w-3.5" aria-hidden />
                <span className="sr-only">グラフ</span>
              </button>
            </div>
          )}
          <button type="button" onClick={download} className="grid h-7 w-7 place-items-center rounded-lg text-ink-3 hover:bg-panel hover:text-ink" title="CSV で保存 (Excel で開けます)" aria-label="CSV で保存">
            <Download className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      </div>

      {view === "chart" && chart ? (
        <div className="px-3 py-3">
          {chart.kind === "time" || chart.series.length > 1 ? (
            <StackedBarChart
              data={result.rows.map((row) => ({ label: String(row[chart.x] ?? ""), values: Object.fromEntries(chart.series.map((s) => [s.key, typeof row[s.key] === "number" ? (row[s.key] as number) : 0])) }))}
              series={chart.series.map((s, i) => ({ key: s.key, label: s.label, color: s.color ?? PALETTE[i % PALETTE.length] }))}
              formatValue={(v) => formatCell(chart.unit === "yen" ? "yen" : chart.unit === "count" ? "count" : "number", v)}
              title={result.title}
              height={compact ? 180 : 240}
              defaultType={chart.kind === "time" ? (chart.series.length > 1 ? "line" : "bar") : "bar"}
            />
          ) : (
            <BarList items={result.rows.slice(0, 20).map((row) => ({ label: String(row[chart.x] ?? ""), value: typeof row[chart.series[0].key] === "number" ? (row[chart.series[0].key] as number) : 0, color: chart.pointColors?.[String(row[chart.x] ?? "")] }))} unit={chart.unit} title={result.title} />
          )}
        </div>
      ) : (
        <div className={clsx("overflow-auto", compact ? "max-h-72" : "max-h-[28rem]")}>
          <table className="w-full min-w-max text-xs">
            <thead className="sticky top-0 bg-panel shadow-[0_1px_0_var(--color-line)]">
              <tr>
                {result.columns.map((c) => (
                  <th key={c.key} scope="col" className={clsx("px-2.5 py-1.5 font-medium whitespace-nowrap text-ink-2", c.kind === "text" ? "text-left" : "text-right")}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, i) => (
                <tr key={i} className="border-t border-line/70 hover:bg-subtle/50">
                  {result.columns.map((c) => {
                    const v = row[c.key];
                    const negative = typeof v === "number" && v < 0 && (c.key.endsWith("_diff") || c.key.endsWith("_ratio"));
                    return (
                      <td key={c.key} className={clsx("px-2.5 py-1 whitespace-nowrap", c.kind === "text" ? "text-left text-ink" : "text-right tnum", negative ? "text-critical-ink" : c.kind !== "text" && "text-ink")}>
                        {c.key.endsWith("_ratio") && c.kind === "percent" && typeof v === "number" ? `${(v * 100).toFixed(1)}%` : formatCell(c.kind, v)}
                      </td>
                    );
                  })}
                </tr>
              ))}
              {result.rows.length === 0 && (
                <tr>
                  <td colSpan={result.columns.length} className="px-2.5 py-3 text-center text-ink-3">
                    該当するデータがありません
                  </td>
                </tr>
              )}
            </tbody>
            {hasTotal && result.rows.length > 0 && (
              <tfoot className="sticky bottom-0 bg-subtle">
                <tr className="border-t border-line font-semibold">
                  {result.columns.map((c) => (
                    <td key={c.key} className={clsx("px-2.5 py-1.5 whitespace-nowrap", c.kind === "text" ? "text-left" : "text-right tnum")}>
                      {formatCell(c.kind, result.total[c.key])}
                    </td>
                  ))}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
      {(result.omitted > 0 || result.notes.length > 0) && (
        <div className="space-y-0.5 border-t border-line px-3 py-2 text-[11px] leading-relaxed text-ink-3">
          {result.omitted > 0 && <p>ほか {result.omitted.toLocaleString("ja-JP")} 行 (合計にはすべて含みます。行を増やすときは「すべて表示して」と聞いてください)</p>}
          {result.notes.map((n) => (
            <p key={n}>※ {n}</p>
          ))}
        </div>
      )}
    </div>
  );
}
