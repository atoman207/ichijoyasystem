"use client";

import { useEffect, useId, useRef, useState, type ComponentType } from "react";
import clsx from "clsx";
import { ChartColumn, ChartLine, ChartPie } from "lucide-react";

/**
 * 軽量 SVG チャート (依存ライブラリなし)
 * - 各チャートは 棒 / 折れ線 / 円 をタブで切り替えられる
 * - 系列色は店舗ごとに固定 (順序や件数で塗り替えない)
 * - 2 系列以上では凡例を必ず表示、1 系列ではタイトルが系列名を兼ねる
 * - ホバーでツールチップ、<details> で表形式も参照可能 (アクセシビリティ)
 * - 表示幅に合わせて描画し直す (幅が変わっても文字や高さは拡大しない)
 */

export interface Series {
  key: string;
  label: string;
  color: string;
}

export interface StackedDatum {
  label: string;
  fullLabel?: string;
  values: Record<string, number>;
}

export type ChartType = "bar" | "line" | "pie";

/** 店舗以外 (月・種別など) を円グラフで塗り分けるときの色 */
const PALETTE = ["#3340b8", "#2a78d6", "#14a39a", "#e0a21a", "#e2603a", "#9b59d0", "#5f7186", "#c2417b", "#6aa84f", "#0e7490", "#b45309", "#8a91a5"];

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nf * exp;
}

function compactYen(v: number): string {
  if (v >= 100_000_000) return `${(v / 100_000_000).toFixed(1)}億`;
  if (v >= 10_000) return `${Math.round(v / 10_000)}万`;
  return `${v}`;
}

function compactNumber(v: number): string {
  return v.toLocaleString("ja-JP", { maximumFractionDigits: 1 });
}

const defaultYen = (v: number) => `¥${v.toLocaleString("ja-JP")}`;

const CHART_TYPES: { id: ChartType; label: string; short: string; icon: ComponentType<{ className?: string }> }[] = [
  { id: "bar", label: "棒グラフ", short: "棒", icon: ChartColumn },
  { id: "line", label: "折れ線グラフ", short: "折れ線", icon: ChartLine },
  { id: "pie", label: "円グラフ", short: "円", icon: ChartPie },
];

/** グラフの種類の切り替えタブ */
export function ChartTypeTabs({ value, onChange, className }: { value: ChartType; onChange: (t: ChartType) => void; className?: string }) {
  return (
    <div role="group" aria-label="グラフの種類" className={clsx("inline-flex shrink-0 gap-0.5 rounded-lg border border-line/70 bg-subtle/60 p-0.5", className)}>
      {CHART_TYPES.map((t) => {
        const active = t.id === value;
        return (
          <button
            key={t.id}
            type="button"
            aria-pressed={active}
            aria-label={t.label}
            title={t.label}
            onClick={() => onChange(t.id)}
            className={clsx(
              "inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs whitespace-nowrap transition",
              active ? "bg-panel font-medium text-accent-ink shadow-xs" : "text-ink-3 hover:text-ink",
            )}
          >
            <t.icon className="h-3.5 w-3.5" aria-hidden />
            <span>{t.short}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * 実際の表示サイズ (px) で描画する。枠の大きさは CSS (縦横比 10:3、高さ height〜height×1.5) で決まり、
 * 表示後に測ったサイズで描き直す (文字は拡大されず、読み込み時に枠の高さも変わらない)
 */
function useBoxSize(height: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 720, h: height });
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r && r.width > 0 && r.height > 0) setSize({ w: Math.round(r.width), h: Math.round(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // width / minWidth を明示: aspect-ratio と minHeight だけだと、最小の高さが比率で最小の幅に換算され、狭い画面ではみ出す
  const style = { aspectRatio: "10 / 3", width: "100%", minWidth: 0, minHeight: height, maxHeight: Math.round(height * 1.5) };
  return { ref, size, style };
}

const PAD = { top: 24, right: 12, bottom: 28, left: 48 };

function YGrid({ max, width, innerH, formatTick }: { max: number; width: number; innerH: number; formatTick: (v: number) => string }) {
  return (
    <>
      {[0, 0.25, 0.5, 0.75, 1].map((t) => {
        const v = t * max;
        const y = PAD.top + innerH - t * innerH;
        return (
          <g key={t}>
            <line x1={PAD.left} x2={width - PAD.right} y1={y} y2={y} stroke={t === 0 ? "#d3d8e6" : "#eceef5"} strokeWidth={1} strokeDasharray={t === 0 ? undefined : "3 4"} />
            <text x={PAD.left - 6} y={y + 4} textAnchor="end" fontSize={11} fill="#8a91a5">
              {formatTick(v)}
            </text>
          </g>
        );
      })}
    </>
  );
}

interface Slice {
  key: string;
  label: string;
  color: string;
  value: number;
}

function SeriesTooltip({ x, title, rows, formatValue }: { x: number; title: string; rows: Slice[]; formatValue: (v: number) => string }) {
  return (
    <div
      className="pointer-events-none absolute top-0 z-10 rounded-xl border border-line/80 bg-panel/95 px-3 py-2 text-xs shadow-pop backdrop-blur"
      style={{ left: x, transform: "translateX(-50%)" }}
    >
      <div className="mb-1 font-medium text-ink">{title}</div>
      {rows.map((s) =>
        s.label ? (
          <div key={s.key} className="flex items-center justify-between gap-4 text-ink-2">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-sm" style={{ background: s.color }} aria-hidden />
              {s.label}
            </span>
            <span className="tnum text-ink">{formatValue(s.value)}</span>
          </div>
        ) : (
          <div key={s.key} className="tnum text-ink">
            {formatValue(s.value)}
          </div>
        ),
      )}
      {rows.length > 1 && (
        <div className="mt-1 flex items-center justify-between gap-4 border-t border-line pt-1 font-medium text-ink">
          <span>合計</span>
          <span className="tnum">{formatValue(rows.reduce((a, r) => a + r.value, 0))}</span>
        </div>
      )}
    </div>
  );
}

function StackedBars({
  data,
  series,
  height,
  title,
  formatValue,
}: {
  data: StackedDatum[];
  series: Series[];
  height: number;
  title: string;
  formatValue: (v: number) => string;
}) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  const { ref, size, style } = useBoxSize(height);
  const width = size.w;
  const chartH = size.h;
  const innerW = width - PAD.left - PAD.right;
  const innerH = chartH - PAD.top - PAD.bottom;
  const totals = data.map((d) => series.reduce((s, sr) => s + (d.values[sr.key] ?? 0), 0));
  const max = niceMax(Math.max(...totals, 1));
  const slot = innerW / Math.max(data.length, 1);
  const barW = Math.min(40, slot * 0.56);
  // 棒の上の合計値は、棒の間隔が十分なときだけ常に表示する (狭いときはホバーで表示)
  const showTotals = slot >= 34;
  const gradId = (key: string) => `${id.replace(/[^a-zA-Z0-9_-]/g, "")}-g-${key}`;
  const gap = 2;
  const tipX = hover === null ? 0 : Math.min(Math.max(PAD.left + slot * (hover + 0.5), 110), width - 110);

  return (
    <div className="relative">
      <div ref={ref} style={style}>
        <svg width="100%" height="100%" viewBox={`0 0 ${width} ${chartH}`} className="block" role="img" aria-labelledby={`${id}-title`}>
          <title id={`${id}-title`}>{title}</title>
          <defs>
            {series.map((s) => (
              <linearGradient key={s.key} id={gradId(s.key)} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor={s.color} stopOpacity={0.72} />
                <stop offset="1" stopColor={s.color} stopOpacity={1} />
              </linearGradient>
            ))}
          </defs>
          <YGrid max={max} width={width} innerH={innerH} formatTick={compactYen} />
          {data.map((d, i) => {
            const x = PAD.left + slot * i + (slot - barW) / 2;
            let acc = 0;
            const segs = series.map((s) => {
              const v = d.values[s.key] ?? 0;
              const h = (v / max) * innerH;
              const y = PAD.top + innerH - acc - h;
              acc += h;
              return { s, v, h, y };
            });
            const isHover = hover === i;
            return (
              <g key={d.label} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                <rect x={PAD.left + slot * i} y={PAD.top} width={slot} height={innerH} fill="transparent" />
                {segs.map(({ s, v, h, y }, j) => {
                  if (v <= 0) return null;
                  return (
                    <rect
                      key={s.key}
                      x={x}
                      y={y}
                      width={barW}
                      height={Math.max(0, h - (j === 0 ? 0 : gap))}
                      fill={`url(#${gradId(s.key)})`}
                      opacity={hover === null || isHover ? 1 : 0.45}
                    />
                  );
                })}
                <text x={x + barW / 2} y={chartH - 9} textAnchor="middle" fontSize={11} fill={isHover ? "#1d2233" : "#8a91a5"}>
                  {d.label}
                </text>
                {(showTotals || isHover) && totals[i] > 0 && (
                  <text x={x + barW / 2} y={PAD.top + innerH - (totals[i] / max) * innerH - 6} textAnchor="middle" fontSize={11} fill={isHover ? "#1d2233" : "#3340b8"} fontWeight={600}>
                    {compactYen(totals[i])}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
      {hover !== null && (
        <SeriesTooltip
          x={tipX}
          title={data[hover].fullLabel ?? data[hover].label}
          rows={series.map((s) => ({ ...s, value: data[hover].values[s.key] ?? 0 }))}
          formatValue={formatValue}
        />
      )}
    </div>
  );
}

function LineSvg({
  labels,
  fullLabels,
  series,
  rows,
  height,
  title,
  formatValue,
  formatTick,
}: {
  labels: string[];
  fullLabels: string[];
  series: Series[];
  rows: Record<string, number>[];
  height: number;
  title: string;
  formatValue: (v: number) => string;
  formatTick: (v: number) => string;
}) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  const { ref, size, style } = useBoxSize(height);
  const width = size.w;
  const chartH = size.h;
  const innerW = width - PAD.left - PAD.right;
  const innerH = chartH - PAD.top - PAD.bottom;
  const max = niceMax(Math.max(1, ...rows.flatMap((r) => series.map((s) => r[s.key] ?? 0))));
  const slot = innerW / Math.max(labels.length, 1);
  const xAt = (i: number) => PAD.left + slot * (i + 0.5);
  const yAt = (v: number) => PAD.top + innerH - (v / max) * innerH;
  // 間隔が狭いときはラベルを間引き、長いラベルは省略する (全文はツールチップ)
  const labelEvery = Math.max(1, Math.ceil(28 / slot));
  const maxChars = Math.max(2, Math.floor(Math.min(slot * labelEvery, 120) / 11));
  const short = (s: string) => (s.length > maxChars ? `${s.slice(0, maxChars - 1)}…` : s);
  const areaId = `${id.replace(/[^a-zA-Z0-9_-]/g, "")}-area`;
  const single = series.length === 1;
  const baseY = PAD.top + innerH;
  const tipX = hover === null ? 0 : Math.min(Math.max(xAt(hover), 110), width - 110);

  return (
    <div className="relative">
      <div ref={ref} style={style}>
        <svg width="100%" height="100%" viewBox={`0 0 ${width} ${chartH}`} className="block" role="img" aria-labelledby={`${id}-title`}>
          <title id={`${id}-title`}>{title}</title>
          {single && (
            <defs>
              <linearGradient id={areaId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor={series[0].color} stopOpacity={0.18} />
                <stop offset="1" stopColor={series[0].color} stopOpacity={0} />
              </linearGradient>
            </defs>
          )}
          <YGrid max={max} width={width} innerH={innerH} formatTick={formatTick} />
          {hover !== null && <line x1={xAt(hover)} x2={xAt(hover)} y1={PAD.top} y2={baseY} stroke="#d3d8e6" strokeWidth={1} />}
          {series.map((s) => {
            const pts = rows.map((r, i) => [xAt(i), yAt(r[s.key] ?? 0)] as const);
            const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
            return (
              <g key={s.key} opacity={hover === null ? 1 : 0.9}>
                {single && pts.length > 1 && <path d={`${d} L${pts[pts.length - 1][0].toFixed(1)},${baseY} L${pts[0][0].toFixed(1)},${baseY} Z`} fill={`url(#${areaId})`} />}
                <path d={d} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                {pts.map(([x, y], i) => (
                  <circle key={i} cx={x} cy={y} r={hover === i ? 4.5 : 3} fill="#fff" stroke={s.color} strokeWidth={2} />
                ))}
              </g>
            );
          })}
          {labels.map((l, i) => (
            <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={PAD.left + slot * i} y={PAD.top} width={slot} height={innerH + PAD.bottom} fill="transparent" />
              {(i % labelEvery === 0 || hover === i) && (
                <text x={xAt(i)} y={chartH - 9} textAnchor="middle" fontSize={11} fill={hover === i ? "#1d2233" : "#8a91a5"}>
                  {short(l)}
                </text>
              )}
            </g>
          ))}
        </svg>
      </div>
      {hover !== null && (
        <SeriesTooltip x={tipX} title={fullLabels[hover] ?? labels[hover]} rows={series.map((s) => ({ ...s, value: rows[hover][s.key] ?? 0 }))} formatValue={formatValue} />
      )}
    </div>
  );
}

function Donut({ slices, formatValue, caption, minHeight }: { slices: Slice[]; formatValue: (v: number) => string; caption?: string; minHeight?: number }) {
  const [hover, setHover] = useState<string | null>(null);
  const total = slices.reduce((a, s) => a + Math.max(0, s.value), 0);
  if (total <= 0) {
    return (
      <div className="flex items-center justify-center text-xs text-ink-3" style={{ minHeight: minHeight ?? 168 }}>
        データがありません
      </div>
    );
  }
  const size = 168;
  const stroke = 26;
  const r = (size - stroke - 8) / 2;
  const c = size / 2;
  const circ = 2 * Math.PI * r;
  const visible = slices.filter((s) => s.value > 0);
  const gap = visible.length > 1 ? 2 : 0;
  const arcs = visible.reduce<{ s: Slice; len: number; offset: number }[]>((list, s) => {
    const prev = list[list.length - 1];
    list.push({ s, len: (s.value / total) * circ, offset: prev ? prev.offset + prev.len : 0 });
    return list;
  }, []);
  const active = slices.find((s) => s.key === hover);
  const share = (v: number) => `${((v / total) * 100).toFixed(1)}%`;

  return (
    <div style={{ minHeight }}>
      {caption && <div className="mb-2 text-[11px] text-ink-3">{caption}</div>}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
        <div className="relative mx-auto shrink-0" style={{ width: size, height: size }}>
          <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="block -rotate-90" role="img" aria-label={caption ?? "構成比"}>
            <circle cx={c} cy={c} r={r} fill="none" stroke="#eceef5" strokeWidth={stroke} />
            {arcs.map(({ s, len, offset }) => (
              <circle
                key={s.key}
                cx={c}
                cy={c}
                r={r}
                fill="none"
                stroke={s.color}
                strokeWidth={hover === s.key ? stroke + 6 : stroke}
                strokeDasharray={`${Math.max(len - gap, 0.5)} ${circ}`}
                strokeDashoffset={-offset}
                opacity={hover === null || hover === s.key ? 1 : 0.4}
                onMouseEnter={() => setHover(s.key)}
                onMouseLeave={() => setHover(null)}
                className="transition-[stroke-width,opacity] duration-150 motion-reduce:transition-none"
              />
            ))}
          </svg>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-8 text-center">
            <span className="max-w-full truncate text-[11px] text-ink-3">{active ? active.label : "合計"}</span>
            <span className="text-sm font-semibold text-ink tnum">{formatValue(active ? active.value : total)}</span>
            {active && <span className="text-[11px] text-ink-2 tnum">{share(active.value)}</span>}
          </div>
        </div>
        <ul className="min-w-[180px] flex-1 space-y-0.5 text-xs">
          {slices.map((s) => (
            <li
              key={s.key}
              onMouseEnter={() => setHover(s.key)}
              onMouseLeave={() => setHover(null)}
              className={clsx("flex items-center gap-2 rounded-md px-2 py-1 transition-colors", hover === s.key && "bg-subtle")}
            >
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: s.color }} aria-hidden />
              <span className="min-w-0 flex-1 truncate text-ink-2">{s.label}</span>
              <span className="tnum text-ink">{formatValue(s.value)}</span>
              <span className="w-12 text-right tnum text-ink-3">{share(s.value)}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** 期間 × 系列 (店舗など) のチャート。棒は積み上げ、折れ線は系列ごと、円は期間合計の構成比 */
export function StackedBarChart({
  data,
  series,
  height = 220,
  formatValue = defaultYen,
  title = "月次推移",
  defaultType = "bar",
}: {
  data: StackedDatum[];
  series: Series[];
  /** 最小の高さ (px)。幅が広いときは縦横比 10:3 で、この 1.5 倍まで高くなる */
  height?: number;
  formatValue?: (v: number) => string;
  title?: string;
  defaultType?: ChartType;
}) {
  const [type, setType] = useState<ChartType>(defaultType);
  const totals = data.map((d) => series.reduce((s, sr) => s + (d.values[sr.key] ?? 0), 0));
  const multi = series.length > 1;
  const slices: Slice[] = multi
    ? series.map((s) => ({ ...s, value: data.reduce((a, d) => a + (d.values[s.key] ?? 0), 0) }))
    : data.map((d, i) => ({ key: String(i), label: d.fullLabel ?? d.label, color: PALETTE[i % PALETTE.length], value: totals[i] }));

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-2">
        {multi && type !== "pie" && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
            {series.map((s) => (
              <span key={s.key} className="inline-flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: s.color }} aria-hidden />
                {s.label}
              </span>
            ))}
          </div>
        )}
        <ChartTypeTabs className="ml-auto" value={type} onChange={setType} />
      </div>
      {type === "bar" && <StackedBars data={data} series={series} height={height} title={title} formatValue={formatValue} />}
      {type === "line" && (
        <LineSvg
          labels={data.map((d) => d.label)}
          fullLabels={data.map((d) => d.fullLabel ?? d.label)}
          series={series}
          rows={data.map((d) => d.values)}
          height={height}
          title={title}
          formatValue={formatValue}
          formatTick={compactYen}
        />
      )}
      {type === "pie" && <Donut slices={slices} formatValue={formatValue} caption={multi ? "期間合計の店舗別構成比" : "期間別の構成比"} minHeight={height} />}
      <details className="mt-2 text-xs text-ink-3">
        <summary className="cursor-pointer select-none hover:text-ink">表で見る</summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-ink-2">
                <th className="py-1 pr-3 font-medium">期間</th>
                {series.map((s) => (
                  <th key={s.key} className="py-1 pr-3 text-right font-medium">
                    {s.label}
                  </th>
                ))}
                {multi && <th className="py-1 text-right font-medium">合計</th>}
              </tr>
            </thead>
            <tbody>
              {data.map((d, i) => (
                <tr key={d.label} className="border-t border-line text-ink-2">
                  <td className="py-1 pr-3">{d.fullLabel ?? d.label}</td>
                  {series.map((s) => (
                    <td key={s.key} className="py-1 pr-3 text-right tnum">
                      {formatValue(d.values[s.key] ?? 0)}
                    </td>
                  ))}
                  {multi && <td className="py-1 text-right tnum text-ink">{formatValue(totals[i])}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

/** 値の表示形式 (Server Component から渡せるよう関数ではなく種別で指定) */
export type BarUnit = "yen" | "count" | "plain";

function formatUnit(v: number, unit: BarUnit): string {
  if (unit === "yen") return `¥${v.toLocaleString("ja-JP")}`;
  if (unit === "count") return `${v.toLocaleString("ja-JP")} 件`;
  return v.toLocaleString("ja-JP");
}

/** 単一系列の項目比較 (棒は横棒リスト、折れ線は項目順、円は構成比) */
export function BarList({
  items,
  unit = "plain",
  color = "#2a78d6",
  title = "項目別の比較",
  height = 200,
  defaultType = "bar",
  className,
}: {
  items: { label: string; value: number; color?: string; hint?: string }[];
  unit?: BarUnit;
  color?: string;
  title?: string;
  /** 折れ線グラフの最小の高さ (px) */
  height?: number;
  defaultType?: ChartType;
  className?: string;
}) {
  const [type, setType] = useState<ChartType>(defaultType);
  const formatValue = (v: number) => formatUnit(v, unit);
  const max = Math.max(...items.map((i) => i.value), 1);

  return (
    <div className={className}>
      <div className="mb-3 flex justify-end">
        <ChartTypeTabs value={type} onChange={setType} />
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-ink-3">データがありません</p>
      ) : type === "bar" ? (
        <ul className="space-y-2">
          {items.map((it) => (
            <li key={it.label} className="text-xs">
              <div className="mb-1 flex items-center justify-between gap-2 text-ink-2">
                <span className="truncate">
                  {it.label}
                  {it.hint && <span className="ml-1 text-ink-3">{it.hint}</span>}
                </span>
                <span className="tnum text-ink">{formatValue(it.value)}</span>
              </div>
              <div className="h-2.5 w-full bg-subtle">
                <div className="h-2.5 transition-[width]" style={{ width: `${(it.value / max) * 100}%`, background: it.color ?? color }} />
              </div>
            </li>
          ))}
        </ul>
      ) : type === "line" ? (
        <LineSvg
          labels={items.map((it) => it.label)}
          fullLabels={items.map((it) => (it.hint ? `${it.label} ${it.hint}` : it.label))}
          series={[{ key: "value", label: "", color }]}
          rows={items.map((it) => ({ value: it.value }))}
          height={height}
          title={title}
          formatValue={formatValue}
          formatTick={unit === "yen" ? compactYen : compactNumber}
        />
      ) : (
        <Donut slices={items.map((it, i) => ({ key: String(i), label: it.label, color: it.color ?? PALETTE[i % PALETTE.length], value: it.value }))} formatValue={formatValue} />
      )}
    </div>
  );
}
