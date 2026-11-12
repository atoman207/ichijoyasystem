"use client";

import { useMemo, useState } from "react";
import { Trash, Plus } from "lucide-react";
import type { Product, QuoteItem, ServiceCategory } from "@/lib/db/types";
import { CATEGORY_LABEL } from "@/lib/constants";

interface Row {
  key: string;
  productId?: string;
  name: string;
  spec: string;
  qty: number;
  unit: string;
  unitPrice: number;
}

const yen = (n: number) => `¥${Math.round(n).toLocaleString("ja-JP")}`;
let seq = 0;
const nextKey = () => `r${Date.now().toString(36)}_${seq++}`;

export function QuoteEditor({
  products,
  initialItems = [],
  initialDiscount = 0,
  defaultCategory,
}: {
  products: Product[];
  initialItems?: QuoteItem[];
  initialDiscount?: number;
  defaultCategory?: ServiceCategory;
}) {
  const [rows, setRows] = useState<Row[]>(() => {
    if (initialItems.length > 0) {
      return initialItems.map((i) => ({ key: nextKey(), productId: i.productId, name: i.name, spec: i.spec ?? "", qty: i.qty, unit: i.unit, unitPrice: i.unitPrice }));
    }
    const first = products.find((p) => p.category === (defaultCategory ?? "tatami")) ?? products[0];
    const misc = products.find((p) => p.id === "p_misc");
    const base: Row[] = [{ key: nextKey(), productId: first?.id, name: first?.name ?? "", spec: [first?.grade, first?.sizeLabel].filter(Boolean).join(" / "), qty: 6, unit: first?.unit ?? "式", unitPrice: first?.unitPrice ?? 0 }];
    if (misc) base.push({ key: nextKey(), productId: misc.id, name: misc.name, spec: "", qty: 1, unit: misc.unit, unitPrice: misc.unitPrice });
    return base;
  });
  const [discount, setDiscount] = useState(initialDiscount);

  const grouped = useMemo(() => {
    const map = new Map<ServiceCategory, Product[]>();
    for (const p of products.filter((x) => x.active)) {
      map.set(p.category, [...(map.get(p.category) ?? []), p]);
    }
    return [...map.entries()];
  }, [products]);

  const subtotal = rows.reduce((s, r) => s + Math.round(r.qty * r.unitPrice), 0);
  const d = Math.min(Math.max(0, discount || 0), subtotal);
  const tax = Math.floor((subtotal - d) * 0.1);
  const total = subtotal - d + tax;

  function update(key: string, patch: Partial<Row>) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }
  function choose(key: string, productId: string) {
    const p = products.find((x) => x.id === productId);
    if (!p) {
      update(key, { productId: undefined });
      return;
    }
    update(key, { productId: p.id, name: p.name, spec: [p.grade, p.sizeLabel].filter(Boolean).join(" / "), unit: p.unit, unitPrice: p.unitPrice });
  }
  function add() {
    setRows((rs) => [...rs, { key: nextKey(), name: "", spec: "", qty: 1, unit: "式", unitPrice: 0 }]);
  }
  function remove(key: string) {
    setRows((rs) => rs.filter((r) => r.key !== key));
  }

  const payload = JSON.stringify(rows.map((r) => ({ productId: r.productId, name: r.name, spec: r.spec, qty: r.qty, unit: r.unit, unitPrice: r.unitPrice })));

  return (
    <div>
      <input type="hidden" name="items" value={payload} />
      <input type="hidden" name="discount" value={d} />
      <div className="overflow-x-auto rounded-xl border border-line">
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr className="bg-subtle text-xs text-ink-2">
              <th className="px-3 py-2 text-left font-medium">商品 (マスタから選択)</th>
              <th className="px-3 py-2 text-left font-medium">品名</th>
              <th className="px-3 py-2 text-left font-medium">仕様・備考</th>
              <th className="px-3 py-2 text-right font-medium">数量</th>
              <th className="px-3 py-2 text-left font-medium">単位</th>
              <th className="px-3 py-2 text-right font-medium">単価 (税抜)</th>
              <th className="px-3 py-2 text-right font-medium">金額</th>
              <th className="px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-t border-line">
                <td className="px-2 py-1.5">
                  <select className="field h-8 py-1 text-xs" value={r.productId ?? ""} onChange={(e) => choose(r.key, e.target.value)}>
                    <option value="">(自由入力)</option>
                    {grouped.map(([cat, list]) => (
                      <optgroup key={cat} label={CATEGORY_LABEL[cat]}>
                        {list.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}{p.sizeLabel ? ` (${p.sizeLabel})` : ""} - {yen(p.unitPrice)}/{p.unit}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </td>
                <td className="px-2 py-1.5"><input className="field h-8 py-1 text-xs" value={r.name} onChange={(e) => update(r.key, { name: e.target.value })} placeholder="品名" required /></td>
                <td className="px-2 py-1.5"><input className="field h-8 py-1 text-xs" value={r.spec} onChange={(e) => update(r.key, { spec: e.target.value })} placeholder="サイズ・柄など" /></td>
                <td className="px-2 py-1.5"><input type="number" step="0.5" min="0" className="field h-8 w-20 py-1 text-right text-xs tnum" value={r.qty} onChange={(e) => update(r.key, { qty: Number(e.target.value) })} /></td>
                <td className="px-2 py-1.5"><input className="field h-8 w-14 py-1 text-xs" value={r.unit} onChange={(e) => update(r.key, { unit: e.target.value })} /></td>
                <td className="px-2 py-1.5"><input type="number" step="100" min="0" className="field h-8 w-28 py-1 text-right text-xs tnum" value={r.unitPrice} onChange={(e) => update(r.key, { unitPrice: Number(e.target.value) })} /></td>
                <td className="px-3 py-1.5 text-right text-sm tnum">{yen(r.qty * r.unitPrice)}</td>
                <td className="px-2 py-1.5 text-right">
                  <button type="button" onClick={() => remove(r.key)} className="rounded p-1 text-ink-3 hover:bg-critical-soft hover:text-critical" aria-label="行を削除">
                    <Trash className="h-4 w-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
        <button type="button" onClick={add} className="inline-flex items-center gap-1 rounded-lg border border-line px-3 py-1.5 text-xs text-ink-2 hover:bg-subtle">
          <Plus className="h-3.5 w-3.5" /> 行を追加
        </button>
        <div className="w-full max-w-xs space-y-1.5 text-sm">
          <div className="flex items-center justify-between"><span className="text-ink-2">小計 (税抜)</span><span className="tnum">{yen(subtotal)}</span></div>
          <div className="flex items-center justify-between gap-3">
            <span className="whitespace-nowrap text-ink-2">値引き</span>
            <input type="number" step="1000" min="0" className="field h-8 w-32 py-1 text-right text-xs tnum" value={discount} onChange={(e) => setDiscount(Number(e.target.value))} />
          </div>
          <div className="flex items-center justify-between"><span className="text-ink-2">消費税 (10%)</span><span className="tnum">{yen(tax)}</span></div>
          <div className="flex items-center justify-between border-t border-line pt-1.5 text-base font-semibold"><span>合計 (税込)</span><span className="tnum">{yen(total)}</span></div>
        </div>
      </div>
    </div>
  );
}
