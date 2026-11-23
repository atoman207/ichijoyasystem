"use client";

import { useMemo, useState } from "react";
import { Trash, Plus } from "lucide-react";
import type { Product, QuoteItem, ServiceCategory } from "@/lib/db/types";
import { CATEGORY_LABEL } from "@/lib/constants";
import { quoteTotals } from "@/lib/quote-calc";

interface Row {
  key: string;
  productId?: string;
  name: string;
  spec: string;
  qty: number;
  unit: string;
  unitPrice: number;
  /** 管理会計の品目 ("" = 自動: 商品の品目 → 見積の種別) */
  itemCategory: string;
  /** 畳床 ("" = 自動: 品名・製造の予定から判定) */
  dokoMaterialId: string;
}

const squash = (s: string) => s.replace(/[\s　]/g, "");

const yen = (n: number) => `¥${Math.round(n).toLocaleString("ja-JP")}`;
let seq = 0;
const nextKey = () => `r${Date.now().toString(36)}_${seq++}`;

export function QuoteEditor({
  products,
  initialItems = [],
  initialDiscount = 0,
  defaultCategory,
  initialTaxIncluded = false,
  categories = [],
  productCategory = {},
  serviceItemCategory,
  doko,
}: {
  products: Product[];
  initialItems?: QuoteItem[];
  initialDiscount?: number;
  defaultCategory?: ServiceCategory;
  /** 単価を税込で入力する (手書き見積書の「税込」) */
  initialTaxIncluded?: boolean;
  /** 管理会計の品目の一覧 (畳・襖・リフォーム・カーテン類・自社商品・その他・諸経費) */
  categories?: { id: string; name: string }[];
  /** 商品 → 品目 (商品マスタの品目。src/lib/mgmt/categories.ts の productItemCategory) */
  productCategory?: Record<string, string>;
  /** 自由入力の行の品目の既定 (見積の種別から) */
  serviceItemCategory?: string;
  /** 畳床を選べる行 (材料が決まっていない畳床の行を持つ材料構成の商品・品名) と畳床の一覧 (src/lib/mgmt/costing.ts の dokoChoiceInfo) */
  doko?: { options: { id: string; label: string }[]; productIds: string[]; matchNames: string[] };
}) {
  const [taxIncluded, setTaxIncluded] = useState(initialTaxIncluded);
  const [rows, setRows] = useState<Row[]>(() => {
    if (initialItems.length > 0) {
      return initialItems.map((i) => ({ key: nextKey(), productId: i.productId, name: i.name, spec: i.spec ?? "", qty: i.qty, unit: i.unit, unitPrice: i.unitPrice, itemCategory: i.itemCategory ?? "", dokoMaterialId: i.dokoMaterialId ?? "" }));
    }
    const first = products.find((p) => p.category === (defaultCategory ?? "tatami")) ?? products[0];
    const misc = products.find((p) => p.id === "p_misc");
    const base: Row[] = [{ key: nextKey(), productId: first?.id, name: first?.name ?? "", spec: [first?.grade, first?.sizeLabel].filter(Boolean).join(" / "), qty: 6, unit: first?.unit ?? "式", unitPrice: first?.unitPrice ?? 0, itemCategory: "", dokoMaterialId: "" }];
    if (misc) base.push({ key: nextKey(), productId: misc.id, name: misc.name, spec: "", qty: 1, unit: misc.unit, unitPrice: misc.unitPrice, itemCategory: "", dokoMaterialId: "" });
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

  const { subtotal, discount: d, tax, total } = quoteTotals(rows.map((r) => ({ amount: Math.round(r.qty * r.unitPrice) })), discount || 0, taxIncluded);

  function update(key: string, patch: Partial<Row>) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }
  function choose(key: string, productId: string) {
    const p = products.find((x) => x.id === productId);
    if (!p) {
      update(key, { productId: undefined });
      return;
    }
    // 品目は「自動」に戻す (商品の品目を使う)
    update(key, { productId: p.id, name: p.name, spec: [p.grade, p.sizeLabel].filter(Boolean).join(" / "), unit: p.unit, unitPrice: p.unitPrice, itemCategory: "", dokoMaterialId: "" });
  }
  function add() {
    setRows((rs) => [...rs, { key: nextKey(), name: "", spec: "", qty: 1, unit: "式", unitPrice: 0, itemCategory: "", dokoMaterialId: "" }]);
  }
  function remove(key: string) {
    setRows((rs) => rs.filter((r) => r.key !== key));
  }

  const payload = JSON.stringify(rows.map((r) => ({ productId: r.productId, name: r.name, spec: r.spec, qty: r.qty, unit: r.unit, unitPrice: r.unitPrice, itemCategory: r.itemCategory || undefined, dokoMaterialId: r.dokoMaterialId || undefined })));
  const catName = (id: string | undefined) => categories.find((c) => c.id === id)?.name;
  // 「自動」のときに使う品目 (商品の品目 → 見積の種別)
  const autoName = (r: Row) => catName(r.productId ? productCategory[r.productId] : serviceItemCategory) ?? "見積の種別から";
  // 畳床を選べる行: 品目が畳で、材料が決まっていない畳床の行を持つ材料構成に当たる (商品または品名)
  const needsDoko = (r: Row) => {
    if (!doko?.options.length) return false;
    const cat = r.itemCategory || (r.productId ? productCategory[r.productId] : serviceItemCategory);
    if (cat !== "tatami") return false;
    const label = squash(`${r.name}${r.spec}`);
    return Boolean((r.productId && doko.productIds.includes(r.productId)) || doko.matchNames.some((m) => m && label.includes(m)));
  };

  return (
    <div>
      <input type="hidden" name="items" value={payload} />
      <input type="hidden" name="discount" value={d} />
      <input type="hidden" name="taxIncluded" value={taxIncluded ? "1" : ""} />
      <label className="mb-2 inline-flex items-center gap-2 text-xs text-ink-2">
        <input type="checkbox" checked={taxIncluded} onChange={(e) => setTaxIncluded(e.target.checked)} className="h-4 w-4" />
        単価・金額は税込 (手書き見積書の「税込」に○。消費税は合計から内税で計算します)
      </label>
      <div className="overflow-x-auto rounded-xl border border-line">
        <table className="w-full min-w-[900px] text-sm">
          <thead>
            <tr className="bg-subtle text-xs text-ink-2">
              <th className="px-3 py-2 text-left font-medium">商品 (マスタから選択)</th>
              <th className="px-3 py-2 text-left font-medium">品名</th>
              <th className="px-3 py-2 text-left font-medium">仕様・備考</th>
              {categories.length > 0 && <th className="px-3 py-2 text-left font-medium" title="管理会計 (店舗別・品目別の原価率) で数える品目。自社商品 (ミニ畳など) やリフォーム工事 (大工など) はここで選びます">品目</th>}
              <th className="px-3 py-2 text-right font-medium">数量</th>
              <th className="px-3 py-2 text-left font-medium">単位</th>
              <th className="px-3 py-2 text-right font-medium">単価 ({taxIncluded ? "税込" : "税抜"})</th>
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
                {categories.length > 0 && (
                  <td className="px-2 py-1.5">
                    <select className="field h-8 w-32 py-1 text-xs" value={r.itemCategory} onChange={(e) => update(r.key, { itemCategory: e.target.value })} aria-label="品目 (管理会計)">
                      <option value="">自動 ({autoName(r)})</option>
                      {categories.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                    {needsDoko(r) && (
                      <select className="field mt-1 h-8 w-32 py-1 text-xs" value={r.dokoMaterialId} onChange={(e) => update(r.key, { dokoMaterialId: e.target.value })} aria-label="畳床 (材料原価)" title="使う畳床 (種類・厚み・規格)。選ばなければ品名・製造の予定から判定します">
                        <option value="">畳床: 自動</option>
                        {doko!.options.map((o) => (
                          <option key={o.id} value={o.id}>{o.label}</option>
                        ))}
                      </select>
                    )}
                  </td>
                )}
                <td className="px-2 py-1.5"><input type="number" step="0.5" min="0" className="field h-8 w-20 py-1 text-right text-xs tnum" value={r.qty} onChange={(e) => update(r.key, { qty: Number(e.target.value) })} /></td>
                <td className="px-2 py-1.5"><input className="field h-8 w-14 py-1 text-xs" value={r.unit} onChange={(e) => update(r.key, { unit: e.target.value })} /></td>
                <td className="px-2 py-1.5"><input type="number" step="100" className="field h-8 w-28 py-1 text-right text-xs tnum" title="値引きの行はマイナス (例: -1000)" value={r.unitPrice} onChange={(e) => update(r.key, { unitPrice: Number(e.target.value) })} /></td>
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
          <div className="flex items-center justify-between"><span className="text-ink-2">小計 ({taxIncluded ? "税込" : "税抜"})</span><span className="tnum">{yen(subtotal)}</span></div>
          <div className="flex items-center justify-between gap-3">
            <span className="whitespace-nowrap text-ink-2">値引き</span>
            <input type="number" step="1000" min="0" className="field h-8 w-32 py-1 text-right text-xs tnum" value={discount} onChange={(e) => setDiscount(Number(e.target.value))} />
          </div>
          <div className="flex items-center justify-between"><span className="text-ink-2">{taxIncluded ? "うち消費税 (10%)" : "消費税 (10%)"}</span><span className="tnum">{yen(tax)}</span></div>
          <div className="flex items-center justify-between border-t border-line pt-1.5 text-base font-semibold"><span>合計 (税込)</span><span className="tnum">{yen(total)}</span></div>
        </div>
      </div>
    </div>
  );
}
