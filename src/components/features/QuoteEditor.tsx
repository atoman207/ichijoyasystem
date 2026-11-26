"use client";

import { useMemo, useState } from "react";
import { Trash, Plus } from "lucide-react";
import type { Product, QuoteItem, ServiceCategory } from "@/lib/db/types";
import { CATEGORY_LABEL } from "@/lib/constants";
import { quoteTotals, TAX_MODE_LABEL, type TaxMode } from "@/lib/quote-calc";
import { autoItemCategory, autoUnit, UNIT_OPTIONS } from "@/lib/line-kind";

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
  /** 単位を手で選んだ (品名・仕様を変えても自動で選び直さない) */
  unitTouched: boolean;
  /** 品目を手で選んだ (同上) */
  catTouched: boolean;
  /** 単位を一覧にない値で入力する */
  unitFree: boolean;
}

const UNIT_SET = new Set<string>(UNIT_OPTIONS);
/** 数を数える単位 (品名・仕様から選び直してよい単位) */
const SOFT_UNITS = new Set(["", "式", "一式", "面", "枚", "畳", "帖", "個", "ヶ所", "箇所", "本"]);

const squash = (s: string) => s.replace(/[\s　]/g, "");

const yen = (n: number) => `¥${Math.round(n).toLocaleString("ja-JP")}`;
/** 明細の列 (広い欄のとき): 商品・品名・仕様・(品目)・数量・単位・単価・金額・削除 */
const QCOLS = "minmax(9rem,1.4fr) minmax(7rem,1fr) minmax(7rem,1fr) 4.5rem 5rem 6.5rem 6rem 2rem";
const QCOLS_CAT = "minmax(8rem,1.4fr) minmax(6rem,1fr) minmax(6rem,1fr) 8rem 4.5rem 5rem 6.5rem 6rem 2rem";
/**
 * 入力欄: 狭い欄 (カード) は指で押しやすい高さ、広い欄 (表) は詰める。
 * 数量・単価・値引きの数字の欄は step="any" (刻みを付けると 10,560 円・1,650 円・値引き 5,300 円などを
 * ブラウザーが「有効な値ではない」として保存を止める。2026-11-23 に手書き見積書から見積を保存できなかった原因)。
 * 単価は inputMode を付けない (iPhone の数字だけのキーボードにはマイナスがなく、値引きの行を入力できない)
 */
const FIELD = "field h-10 py-1 @4xl:h-8 @4xl:text-xs";
/** 項目名 (カードのときだけ出す。表は見出しの行) */
const CELL_LABEL = "mb-0.5 block text-[11px] text-ink-3 @4xl:hidden";
/** 単位の「その他 (入力)」 */
const OTHER_UNIT = "__other__";
let seq = 0;
const nextKey = () => `r${Date.now().toString(36)}_${seq++}`;

export function QuoteEditor({
  products,
  initialItems = [],
  initialDiscount = 0,
  defaultCategory,
  initialTaxIncluded = false,
  initialTaxMode,
  categories = [],
  productCategory = {},
  serviceItemCategory,
  doko,
  autoOnLoad = false,
}: {
  products: Product[];
  initialItems?: QuoteItem[];
  initialDiscount?: number;
  defaultCategory?: ServiceCategory;
  /** 単価を税込で入力する (手書き見積書の「税込」)。initialTaxMode があればそちらを使う */
  initialTaxIncluded?: boolean;
  /** 税の書き方 (内税 = 標準・外税・非課税。お客様のご要望 2026-11-24「①」。src/lib/quote-calc.ts) */
  initialTaxMode?: TaxMode;
  /** 管理会計の品目の一覧 (畳・襖・リフォーム・カーテン類・自社商品・その他・諸経費) */
  categories?: { id: string; name: string }[];
  /** 商品 → 品目 (商品マスタの品目。src/lib/mgmt/categories.ts の productItemCategory) */
  productCategory?: Record<string, string>;
  /** 自由入力の行の品目の既定 (見積の種別から) */
  serviceItemCategory?: string;
  /** 畳床を選べる行 (材料が決まっていない畳床の行を持つ材料構成の商品・品名) と畳床の一覧 (src/lib/mgmt/costing.ts の dokoChoiceInfo) */
  doko?: { options: { id: string; label: string }[]; productIds: string[]; matchNames: string[] };
  /** 読み込んだ明細 (書類取込・コピー) の単位・品目を、品名・仕様から選び直す (新しい見積) */
  autoOnLoad?: boolean;
}) {
  const [taxMode, setTaxMode] = useState<TaxMode>(initialTaxMode ?? (initialTaxIncluded ? "included" : "excluded"));
  const taxIncluded = taxMode === "included";
  const productKind = useMemo(() => new Map(products.map((p) => [p.id, p.category as string])), [products]);
  const catIds = useMemo(() => new Set(categories.map((c) => c.id)), [categories]);
  /** 品名・仕様から単位・品目を選ぶ (お客様のご要望 2026-11-23「■1」。src/lib/line-kind.ts)。手で選んだものは変えない */
  const withAuto = (r: Row): Row => {
    const pc = r.productId ? productKind.get(r.productId) : undefined;
    const next = { ...r };
    if (!r.unitTouched) {
      const u = autoUnit(r.name, r.spec, pc);
      if (u) next.unit = u;
      if (!next.unit) next.unit = "式";
      next.unitFree = !UNIT_SET.has(next.unit);
    }
    // 品目: 商品を選んだ行は商品の品目 (自動) のまま。自由入力の行だけ品名・仕様から選ぶ
    if (!r.catTouched && !r.productId && catIds.size) {
      const c = autoItemCategory(r.name, r.spec);
      next.itemCategory = c && catIds.has(c) ? c : "";
    }
    return next;
  };
  const [rows, setRows] = useState<Row[]>(() => {
    if (initialItems.length > 0) {
      return initialItems.map((i) => {
        const spec = i.spec ?? "";
        const pc = i.productId ? productKind.get(i.productId) : undefined;
        const auto = autoUnit(i.name, spec, pc);
        const autoCat = autoItemCategory(i.name, spec);
        const unit = i.unit?.trim() ?? "";
        const row: Row = {
          key: nextKey(),
          productId: i.productId,
          name: i.name,
          spec,
          qty: i.qty,
          unit,
          unitPrice: i.unitPrice,
          itemCategory: i.itemCategory ?? "",
          dokoMaterialId: i.dokoMaterialId ?? "",
          // 空・既定の「式」・自動と同じ単位は、品名を直したときに選び直す。それ以外 (面・m など) は手で選んだものとして残す。
          // 書類取込から作る新しい見積は、用紙の書き方 (面・式など) より品名・仕様の単位を優先する (m・㎡ など長さ・面積の単位は残す)
          unitTouched: autoOnLoad ? !SOFT_UNITS.has(unit) : Boolean(unit) && unit !== "式" && unit !== auto,
          catTouched: Boolean(i.itemCategory) && i.itemCategory !== autoCat,
          unitFree: Boolean(unit) && !UNIT_SET.has(unit),
        };
        // 書類取込・コピーから作る新しい見積は、読み込んだときに単位・品目を選ぶ (保存済みの見積の編集は、直した行だけ)
        return autoOnLoad || !unit ? withAuto(row) : row;
      });
    }
    const first = products.find((p) => p.category === (defaultCategory ?? "tatami")) ?? products[0];
    const misc = products.find((p) => p.id === "p_misc");
    const base: Row[] = [{ key: nextKey(), productId: first?.id, name: first?.name ?? "", spec: [first?.grade, first?.sizeLabel].filter(Boolean).join(" / "), qty: 6, unit: first?.unit ?? "式", unitPrice: first?.unitPrice ?? 0, itemCategory: "", dokoMaterialId: "", unitTouched: false, catTouched: false, unitFree: !UNIT_SET.has(first?.unit ?? "式") }];
    if (misc) base.push({ key: nextKey(), productId: misc.id, name: misc.name, spec: "", qty: 1, unit: misc.unit, unitPrice: misc.unitPrice, itemCategory: "", dokoMaterialId: "", unitTouched: true, catTouched: false, unitFree: !UNIT_SET.has(misc.unit) });
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

  const { subtotal, discount: d, tax, total } = quoteTotals(rows.map((r) => ({ amount: Math.round(r.qty * r.unitPrice) })), discount || 0, taxMode);

  function update(key: string, patch: Partial<Row>) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }
  /** 品名・仕様の入力: 単位・品目を自動で選び直す (手で選んだものはそのまま) */
  function updateText(key: string, patch: Pick<Partial<Row>, "name" | "spec">) {
    setRows((rs) => rs.map((r) => (r.key === key ? withAuto({ ...r, ...patch }) : r)));
  }
  function choose(key: string, productId: string) {
    const p = products.find((x) => x.id === productId);
    if (!p) {
      update(key, { productId: undefined });
      return;
    }
    // 品目は「自動」に戻す (商品の品目を使う)。単位は商品マスタの単位
    update(key, { productId: p.id, name: p.name, spec: [p.grade, p.sizeLabel].filter(Boolean).join(" / "), unit: p.unit, unitPrice: p.unitPrice, itemCategory: "", dokoMaterialId: "", unitTouched: false, catTouched: false, unitFree: !UNIT_SET.has(p.unit) });
  }
  function add() {
    setRows((rs) => [...rs, { key: nextKey(), name: "", spec: "", qty: 1, unit: "式", unitPrice: 0, itemCategory: "", dokoMaterialId: "", unitTouched: false, catTouched: false, unitFree: false }]);
  }
  function remove(key: string) {
    setRows((rs) => rs.filter((r) => r.key !== key));
  }

  const payload = JSON.stringify(rows.map((r) => ({ productId: r.productId, name: r.name, spec: r.spec, qty: r.qty, unit: r.unit, unitPrice: r.unitPrice, itemCategory: r.itemCategory || undefined, dokoMaterialId: r.dokoMaterialId || undefined })));
  const catName = (id: string | undefined) => categories.find((c) => c.id === id)?.name;
  // 「自動」のときに使う品目 (商品の品目 → 見積の種別)
  const autoName = (r: Row) => catName(r.productId ? productCategory[r.productId] : serviceItemCategory) ?? "見積の種別から";
  // 品名・仕様から選んだ品目・単位か (手で選んでいない) — 画面に「自動」と添える
  const autoPicked = (r: Row) => !r.catTouched && !r.productId && Boolean(r.itemCategory);
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
      <input type="hidden" name="taxMode" value={taxMode} />
      <input type="hidden" name="taxIncluded" value={taxIncluded ? "1" : ""} />
      {/* 税の書き方: 内税 (税込) が標準。業者様などへの見積はボタン一つで外税・非課税に (お客様のご要望 2026-11-24「①」) */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div role="radiogroup" aria-label="消費税の表示" className="inline-flex rounded-xl border border-line bg-subtle/70 p-1" data-testid="tax-mode">
          {(["included", "excluded", "exempt"] as TaxMode[]).map((m) => (
            <button key={m} type="button" role="radio" aria-checked={taxMode === m} onClick={() => setTaxMode(m)} className={`rounded-lg px-3 py-1.5 text-sm whitespace-nowrap ${taxMode === m ? "bg-panel font-medium text-accent-ink shadow-xs" : "text-ink-2 hover:text-ink"}`}>
              {TAX_MODE_LABEL[m]}
            </button>
          ))}
        </div>
        <span className="text-[11px] text-ink-3">{taxMode === "included" ? "単価・金額は税込。消費税は合計から内税で計算します (標準)" : taxMode === "excluded" ? "単価・金額は税抜。合計に消費税 10% を足します (業者様など)" : "消費税をかけません (非課税の取引)"}</span>
      </div>
      {/* 広い欄 (896px 以上) は表、それより狭い欄は 1 行ずつのカード (スマートフォンは 2 列、448px 以上は 4 列)。入力欄は 1 組だけ (必須・数値の確かめが二重にならないように) */}
      <div className="@container">
        <div className="overflow-hidden rounded-xl border border-line text-sm" style={{ "--qcols": categories.length > 0 ? QCOLS_CAT : QCOLS } as React.CSSProperties}>
          <div className="hidden gap-x-1.5 bg-subtle px-2 py-2 text-xs font-medium text-ink-2 @4xl:grid @4xl:grid-cols-(--qcols)" aria-hidden>
            <span className="px-1">商品 (マスタから選択)</span>
            <span className="px-1">品名</span>
            <span className="px-1">仕様・備考</span>
            {categories.length > 0 && <span className="px-1" title="管理会計 (店舗別・品目別の原価率) で数える品目。自社商品 (ミニ畳など) やリフォーム工事 (大工など) はここで選びます">品目</span>}
            <span className="px-1 text-right">数量</span>
            <span className="px-1">単位</span>
            <span className="px-1 text-right">単価 ({taxMode === "exempt" ? "非課税" : taxIncluded ? "税込" : "税抜"})</span>
            <span className="px-1 text-right">金額</span>
            <span />
          </div>
          <div className="divide-y divide-line border-line @4xl:border-t">
            {rows.map((r, i) => (
              <div key={r.key} role="group" aria-label={`明細 ${i + 1} 行目`} className="grid grid-cols-2 gap-x-2 gap-y-2 p-3 @md:grid-cols-4 @4xl:grid-cols-(--qcols) @4xl:items-start @4xl:gap-x-1.5 @4xl:gap-y-0 @4xl:px-2 @4xl:py-1.5">
                <div className="col-span-2 flex items-center justify-between @md:col-span-4 @4xl:hidden">
                  <span className="text-xs font-medium text-ink-2">明細 {i + 1}</span>
                  <button type="button" onClick={() => remove(r.key)} className="rounded p-1.5 text-critical hover:bg-critical-soft hover:text-critical-ink" aria-label={`明細 ${i + 1} 行目を削除`}>
                    <Trash className="h-4 w-4" />
                  </button>
                </div>
                <div className="col-span-2 min-w-0 @4xl:col-span-1">
                  <span className={CELL_LABEL}>商品 (マスタから選択)</span>
                  <select className={FIELD} value={r.productId ?? ""} onChange={(e) => choose(r.key, e.target.value)} aria-label="商品 (マスタから選択)">
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
                </div>
                <div className="col-span-2 min-w-0 @4xl:col-span-1">
                  <span className={CELL_LABEL}>品名</span>
                  <input className={FIELD} value={r.name} onChange={(e) => updateText(r.key, { name: e.target.value })} placeholder="品名" required aria-label="品名" />
                </div>
                <div className="col-span-2 min-w-0 @4xl:col-span-1">
                  <span className={CELL_LABEL}>仕様・備考</span>
                  <input className={FIELD} value={r.spec} onChange={(e) => updateText(r.key, { spec: e.target.value })} placeholder="サイズ・柄など" aria-label="仕様・備考" />
                </div>
                {categories.length > 0 && (
                  <div className="col-span-2 min-w-0 @4xl:col-span-1">
                    <span className={CELL_LABEL}>品目 (管理会計)</span>
                    <select className={FIELD} value={r.itemCategory} onChange={(e) => update(r.key, { itemCategory: e.target.value, catTouched: true })} aria-label="品目 (管理会計)" title={autoPicked(r) ? "品名・仕様から自動で選びました (変えられます)" : undefined}>
                      <option value="">自動 ({autoName(r)})</option>
                      {categories.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                    {needsDoko(r) && (
                      <select className={`${FIELD} mt-1`} value={r.dokoMaterialId} onChange={(e) => update(r.key, { dokoMaterialId: e.target.value })} aria-label="畳床 (材料原価)" title="使う畳床 (種類・厚み・規格)。選ばなければ品名・製造の予定から判定します">
                        <option value="">畳床: 自動</option>
                        {doko!.options.map((o) => (
                          <option key={o.id} value={o.id}>{o.label}</option>
                        ))}
                      </select>
                    )}
                  </div>
                )}
                <div className="min-w-0">
                  <span className={CELL_LABEL}>数量</span>
                  <input type="number" step="any" min="0" inputMode="decimal" className={`${FIELD} text-right tnum`} value={r.qty} onChange={(e) => update(r.key, { qty: Number(e.target.value) })} aria-label="数量" />
                </div>
                <div className="min-w-0">
                  <span className={CELL_LABEL}>単位</span>
                  {r.unitFree ? (
                    <input className={FIELD} value={r.unit} onChange={(e) => update(r.key, { unit: e.target.value, unitTouched: true })} onBlur={() => r.unit.trim() && UNIT_SET.has(r.unit.trim()) && update(r.key, { unit: r.unit.trim(), unitFree: false })} aria-label="単位" placeholder="単位" maxLength={10} />
                  ) : (
                    <select
                      className={FIELD}
                      value={r.unit}
                      onChange={(e) => (e.target.value === OTHER_UNIT ? update(r.key, { unitFree: true, unitTouched: true, unit: "" }) : update(r.key, { unit: e.target.value, unitTouched: true }))}
                      aria-label="単位"
                      title={r.unitTouched ? undefined : "品名・仕様から自動で選びます (変えられます)"}
                    >
                      {UNIT_OPTIONS.map((u) => (
                        <option key={u} value={u}>{u}</option>
                      ))}
                      <option value={OTHER_UNIT}>その他 (入力)…</option>
                    </select>
                  )}
                </div>
                <div className="min-w-0">
                  <span className={CELL_LABEL}>単価 ({taxMode === "exempt" ? "非課税" : taxIncluded ? "税込" : "税抜"})</span>
                  <input type="number" step="any" className={`${FIELD} text-right tnum`} title="値引きの行はマイナス (例: -1000)" value={r.unitPrice} onChange={(e) => update(r.key, { unitPrice: Number(e.target.value) })} aria-label="単価" />
                </div>
                <div className="min-w-0 text-right">
                  <span className={CELL_LABEL}>金額</span>
                  <span className="block py-2 text-base font-semibold tnum @4xl:py-1.5 @4xl:text-sm @4xl:font-normal">{yen(r.qty * r.unitPrice)}</span>
                </div>
                <div className="hidden justify-end @4xl:flex">
                  <button type="button" onClick={() => remove(r.key)} className="rounded p-1 text-critical hover:bg-critical-soft hover:text-critical-ink" aria-label={`明細 ${i + 1} 行目を削除`}>
                    <Trash className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
        <button type="button" onClick={add} className="inline-flex items-center gap-1 rounded-lg border border-line px-3 py-1.5 text-xs text-ink-2 hover:bg-subtle">
          <Plus className="h-3.5 w-3.5" /> 行を追加
        </button>
        <div className="w-full max-w-xs space-y-1.5 text-sm">
          <div className="flex items-center justify-between"><span className="text-ink-2">小計{taxMode === "exempt" ? "" : taxIncluded ? " (税込)" : " (税抜)"}</span><span className="tnum">{yen(subtotal)}</span></div>
          <div className="flex items-center justify-between gap-3">
            <span className="whitespace-nowrap text-ink-2">値引き</span>
            <input type="number" step="any" min="0" className="field h-8 w-32 py-1 text-right text-xs tnum" value={discount} onChange={(e) => setDiscount(Number(e.target.value))} />
          </div>
          <div className="flex items-center justify-between"><span className="text-ink-2">{taxMode === "exempt" ? "消費税" : taxIncluded ? "うち消費税 (10%)" : "消費税 (10%)"}</span><span className="tnum">{taxMode === "exempt" ? "非課税" : yen(tax)}</span></div>
          <div className="flex items-center justify-between border-t border-line pt-1.5 text-base font-semibold"><span>{taxMode === "exempt" ? "合計 (非課税)" : "合計 (税込)"}</span><span className="tnum">{yen(total)}</span></div>
        </div>
      </div>
    </div>
  );
}
