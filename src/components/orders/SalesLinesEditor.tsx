"use client";

import { useMemo, useState } from "react";
import { Plus, Trash } from "lucide-react";
import { quoteTotals, type TaxMode } from "@/lib/quote-calc";

/**
 * 売上確定・請求書発行の画面の「明細・金額」(お客様のご要望 2026-11-27「■1」。シンプルに: 品名・仕様・数量・単位・単価と値引きだけ)。
 * 送る値: linesSent = 1・items (JSON。元の明細の ID を付けて、商品・品目の選択をサーバーで引き継ぐ)・discount。
 * 消費税の書き方 (内税・外税・非課税) は見積のまま (src/lib/quote-calc.ts)
 */

type Line = { key: string; id?: string; name: string; spec: string; qty: string; unit: string; unitPrice: string };
const yen = (n: number) => `¥${Math.round(n).toLocaleString("ja-JP")}`;
const num = (v: string) => Number(v.normalize("NFKC").replace(/[,¥\s]/g, ""));
const TAX_LABEL: Record<TaxMode, string> = { included: "内税 (税込)", excluded: "外税 (税抜)", exempt: "非課税" };

export function SalesLinesEditor({
  initial,
  discount: initialDiscount,
  taxMode,
  original,
  disabled = false,
}: {
  initial: { id: string; name: string; spec?: string; qty: number; unit: string; unitPrice: number }[];
  discount: number;
  taxMode: TaxMode;
  /** 今の合計 (変更前) */
  original: number;
  disabled?: boolean;
}) {
  const [lines, setLines] = useState<Line[]>(() => initial.map((i) => ({ key: i.id, id: i.id, name: i.name, spec: i.spec ?? "", qty: String(i.qty), unit: i.unit, unitPrice: String(i.unitPrice) })));
  const [discount, setDiscount] = useState(initialDiscount ? String(initialDiscount) : "");
  const rows = useMemo(() => lines.map((l) => ({ ...l, amount: Math.round((num(l.qty) || 0) * (Math.round(num(l.unitPrice)) || 0)) })), [lines]);
  const t = quoteTotals(rows.filter((r) => r.name.trim()), num(discount) || 0, taxMode);
  const payload = JSON.stringify(rows.filter((r) => r.name.trim()).map((r) => ({ id: r.id, name: r.name.trim(), spec: r.spec.trim(), qty: num(r.qty), unit: r.unit.trim(), unitPrice: Math.round(num(r.unitPrice)) })));
  const set = (key: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const changed = t.total !== original;

  return (
    <div className="@container space-y-2" data-testid="sales-lines">
      <input type="hidden" name="linesSent" value={disabled ? "0" : "1"} />
      <input type="hidden" name="items" value={payload} />
      <input type="hidden" name="discount" value={String(num(discount) || 0)} />
      <ul className="space-y-2">
        {rows.map((r, i) => (
          <li key={r.key} className="rounded-lg border border-line p-2" data-testid="sales-line">
            <div className="grid grid-cols-2 gap-2 @2xl:grid-cols-[minmax(0,2fr)_minmax(0,2fr)_5rem_4rem_7rem_6rem_auto] @2xl:items-end">
              <label className="col-span-2 block @2xl:col-span-1">
                <span className="label">品名</span>
                <input value={r.name} onChange={(e) => set(r.key, { name: e.target.value })} disabled={disabled} maxLength={100} className="field" aria-label={`明細 ${i + 1} の品名`} />
              </label>
              <label className="col-span-2 block @2xl:col-span-1">
                <span className="label">仕様</span>
                <input value={r.spec} onChange={(e) => set(r.key, { spec: e.target.value })} disabled={disabled} maxLength={200} className="field" aria-label={`明細 ${i + 1} の仕様`} />
              </label>
              <label className="block">
                <span className="label">数量</span>
                <input value={r.qty} onChange={(e) => set(r.key, { qty: e.target.value })} disabled={disabled} inputMode="decimal" className="field text-right tnum" aria-label={`明細 ${i + 1} の数量`} />
              </label>
              <label className="block">
                <span className="label">単位</span>
                <input value={r.unit} onChange={(e) => set(r.key, { unit: e.target.value })} disabled={disabled} maxLength={10} className="field" aria-label={`明細 ${i + 1} の単位`} />
              </label>
              <label className="block">
                <span className="label">単価</span>
                <input value={r.unitPrice} onChange={(e) => set(r.key, { unitPrice: e.target.value })} disabled={disabled} inputMode="numeric" className="field text-right tnum" aria-label={`明細 ${i + 1} の単価`} />
              </label>
              <div className="flex h-10 items-center justify-end text-sm font-semibold text-ink tnum @2xl:justify-end">{yen(r.amount)}</div>
              {!disabled && (
                <button type="button" onClick={() => setLines((ls) => ls.filter((l) => l.key !== r.key))} className="col-span-2 inline-flex h-9 items-center justify-center gap-1 rounded-lg text-xs text-critical hover:bg-critical-soft @2xl:col-span-1 @2xl:w-9" aria-label={`明細 ${i + 1} を削除`}>
                  <Trash className="h-4 w-4" />
                  <span className="@2xl:sr-only">この行を削除</span>
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {!disabled && (
        <button type="button" onClick={() => setLines((ls) => [...ls, { key: `n${Date.now()}`, name: "", spec: "", qty: "1", unit: "", unitPrice: "" }])} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-accent hover:bg-accent-soft">
          <Plus className="h-3.5 w-3.5" /> 明細を追加
        </button>
      )}
      <div className="flex flex-wrap items-end justify-end gap-x-4 gap-y-1 rounded-lg bg-subtle/60 px-3 py-2 text-sm" data-testid="sales-total">
        <label className="flex items-center gap-1.5 text-xs text-ink-2">
          値引き
          <input value={discount} onChange={(e) => setDiscount(e.target.value)} disabled={disabled} inputMode="numeric" placeholder="0" className="field h-8 w-28 text-right tnum" aria-label="値引き" />
        </label>
        <span className="text-xs text-ink-3">{TAX_LABEL[taxMode]} · 消費税 {yen(t.tax)}</span>
        <span className="font-semibold text-ink">
          合計 <span className="text-base tnum">{yen(t.total)}</span>
        </span>
        {changed && <span className="w-full text-right text-xs font-semibold text-warn-ink">今の金額 {yen(original)} から {t.total > original ? "+" : ""}{yen(t.total - original).replace("¥-", "−¥")} 変わります</span>}
      </div>
    </div>
  );
}
