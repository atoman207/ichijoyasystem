"use client";

import { useState } from "react";

interface Row {
  name: string;
  spec: string;
  qty: string;
  unit: string;
  unitPrice: string;
}

const empty = (): Row => ({ name: "", spec: "", qty: "1", unit: "", unitPrice: "" });

/**
 * 仕入内容 (明細) の入力。行を JSON にして hidden の items で送る。
 * 金額 (税込) が空欄のときは明細の合計を金額にする (サーバー側で計算)
 */
export function PurchaseItemsEditor({ initial }: { initial?: { name: string; spec?: string; qty?: number; unit?: string; unitPrice?: number }[] }) {
  const [rows, setRows] = useState<Row[]>(
    initial?.length ? initial.map((i) => ({ name: i.name, spec: i.spec ?? "", qty: String(i.qty ?? 1), unit: i.unit ?? "", unitPrice: i.unitPrice != null ? String(i.unitPrice) : "" })) : [empty()],
  );
  const set = (i: number, k: keyof Row, v: string) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const amount = (r: Row) => Math.round((Number(r.qty) || 0) * (Number(r.unitPrice) || 0));
  const total = rows.filter((r) => r.name.trim()).reduce((a, r) => a + amount(r), 0);
  const json = JSON.stringify(rows.filter((r) => r.name.trim()).map((r) => ({ name: r.name.trim(), spec: r.spec.trim(), qty: Number(r.qty) || 0, unit: r.unit.trim(), unitPrice: Number(r.unitPrice) || 0 })));

  return (
    <div>
      <input type="hidden" name="items" value={json} />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="bg-subtle text-xs text-ink-2">
              <th className="px-2 py-1.5 text-left font-medium">品名</th>
              <th className="px-2 py-1.5 text-left font-medium">規格・色など</th>
              <th className="w-20 px-2 py-1.5 text-right font-medium">数量</th>
              <th className="w-16 px-2 py-1.5 text-left font-medium">単位</th>
              <th className="w-28 px-2 py-1.5 text-right font-medium">単価 (税込)</th>
              <th className="w-28 px-2 py-1.5 text-right font-medium">金額</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-line">
                <td className="px-1 py-1"><input value={r.name} onChange={(e) => set(i, "name", e.target.value)} className="field h-8 py-1 text-xs" placeholder="例: 畳表 (い草)" aria-label={`${i + 1} 行目の品名`} /></td>
                <td className="px-1 py-1"><input value={r.spec} onChange={(e) => set(i, "spec", e.target.value)} className="field h-8 py-1 text-xs" aria-label={`${i + 1} 行目の規格`} /></td>
                <td className="px-1 py-1"><input type="number" step="any" min={0} value={r.qty} onChange={(e) => set(i, "qty", e.target.value)} className="field h-8 py-1 text-right text-xs tnum" aria-label={`${i + 1} 行目の数量`} /></td>
                <td className="px-1 py-1"><input value={r.unit} onChange={(e) => set(i, "unit", e.target.value)} className="field h-8 py-1 text-xs" placeholder="枚" aria-label={`${i + 1} 行目の単位`} /></td>
                <td className="px-1 py-1"><input type="number" step="any" value={r.unitPrice} onChange={(e) => set(i, "unitPrice", e.target.value)} className="field h-8 py-1 text-right text-xs tnum" aria-label={`${i + 1} 行目の単価`} /></td>
                <td className="px-2 py-1 text-right text-xs tnum">{r.name.trim() ? `¥${amount(r).toLocaleString("ja-JP")}` : ""}</td>
                <td className="px-1 py-1 text-center">
                  <button type="button" onClick={() => setRows((rs) => (rs.length > 1 ? rs.filter((_, j) => j !== i) : [empty()]))} className="text-xs text-ink-3 hover:text-critical" aria-label={`${i + 1} 行目を削除`}>×</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs">
        <button type="button" onClick={() => setRows((rs) => [...rs, empty()])} className="rounded-md border border-line px-2.5 py-1 text-accent hover:bg-accent-soft">+ 行を追加</button>
        <span className="text-ink-2">明細の合計 <span className="font-semibold tnum text-ink">¥{total.toLocaleString("ja-JP")}</span> (金額の欄が空欄ならこの合計を金額にします)</span>
      </div>
    </div>
  );
}
