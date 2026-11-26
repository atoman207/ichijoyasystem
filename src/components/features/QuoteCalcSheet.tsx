"use client";

import { useMemo, useState } from "react";
import { useFormStatus } from "react-dom";
import { Check, Plus, Trash2 } from "lucide-react";
import { calcSheet, rateBasis, rowRate, type SheetRow } from "@/lib/quote-sheet-calc";

/**
 * 金額を書く前に撮影した手書き見積書の計算 (/capture/calc)
 * ------------------------------------------------------------
 * AI が読み取った数量・単価を用紙と見比べて直すと、その場で金額・小計・消費税・合計を計算し直す。
 * 職人はこの画面の金額を見積書に書き写す。計算は quote-sheet-calc.ts (サーバーの保存・照合と同じ関数)
 */

export interface CalcItem {
  name: string;
  spec?: string;
  unit?: string;
  qty?: number;
  unitPrice?: number;
  amount?: number;
  rate?: number;
  uncertain?: boolean;
  corrected?: boolean;
}

interface Row {
  name: string;
  spec: string;
  unit: string;
  qty: string;
  unitPrice: string;
  /** 割合の値引き (2割引 = 0.2)。null = 普通の行 */
  rate: number | null;
  uncertain: boolean;
  corrected: boolean;
  /** 画面で足した行 (品名を入力できる) */
  added?: boolean;
}

const yen = (n: number) => Math.round(n).toLocaleString("ja-JP");
const signed = (n: number) => (n < 0 ? `▲${yen(-n)}` : yen(n));

function num(v: string): number | undefined {
  const t = v.normalize("NFKC").replace(/[,，円¥\s]/g, "").replace(/^[▲△]/, "-");
  if (!t) return undefined;
  const x = Number(t);
  return Number.isFinite(x) ? x : undefined;
}
const str = (n: number | undefined) => (n === undefined || n === null ? "" : String(n));

function toRow(it: CalcItem): Row {
  const rate = rowRate({ ...it, qty: it.rate ? undefined : it.qty, unitPrice: it.rate ? undefined : it.unitPrice, amount: it.rate ? undefined : it.amount }) ?? null;
  // 金額だけの行 (諸経費・▲ の値引き) は 数量 1 × 単価 = 金額 にする
  const onlyAmount = rate === null && it.amount !== undefined && (it.qty === undefined || it.unitPrice === undefined);
  return {
    name: it.name ?? "",
    spec: it.spec ?? "",
    unit: it.unit ?? "",
    qty: rate !== null ? "" : onlyAmount ? "1" : str(it.qty),
    unitPrice: rate !== null ? "" : onlyAmount ? str(it.amount) : str(it.unitPrice),
    rate,
    uncertain: it.uncertain === true,
    corrected: it.corrected === true,
  };
}

function SaveButton({ dirty }: { dirty: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={`inline-flex h-11 items-center justify-center gap-1.5 rounded-lg px-4 text-sm font-medium disabled:opacity-60 ${dirty ? "bg-accent text-white hover:bg-accent-hover" : "border border-line bg-panel text-ink hover:bg-subtle"}`}>
      {pending ? "保存中…" : "確かめた内容を保存"}
    </button>
  );
}

export function QuoteCalcSheet({
  id,
  items,
  taxMode: initialTaxMode,
  taxModeRead,
  discount: initialDiscount,
  editable,
  saveAction,
}: {
  id: string;
  items: CalcItem[];
  taxMode: "税込" | "税抜";
  /** 用紙の「税込 / 税抜」に○があったか */
  taxModeRead: boolean;
  discount: number;
  editable: boolean;
  saveAction: (fd: FormData) => Promise<void>;
}) {
  const [rows, setRows] = useState<Row[]>(() => items.map(toRow));
  const [taxMode, setTaxMode] = useState<"税込" | "税抜">(initialTaxMode);
  const [discount, setDiscount] = useState(initialDiscount ? String(initialDiscount) : "");
  const [dirty, setDirty] = useState(false);

  const sheet: SheetRow[] = useMemo(() => rows.map((r) => ({ name: r.name, spec: r.spec, qty: r.rate !== null ? undefined : num(r.qty), unitPrice: r.rate !== null ? undefined : num(r.unitPrice), rate: r.rate })), [rows]);
  const res = useMemo(() => calcSheet(sheet, { taxIncluded: taxMode === "税込", discount: Math.max(0, num(discount) ?? 0) }), [sheet, taxMode, discount]);
  const unsure = rows.filter((r) => r.uncertain).length;

  const update = (i: number, patch: Partial<Row>) => {
    setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...patch } : r)));
    setDirty(true);
  };
  const remove = (i: number) => {
    setRows((rs) => rs.filter((_, k) => k !== i));
    setDirty(true);
  };
  const add = () => {
    setRows((rs) => [...rs, { name: "", spec: "", unit: "", qty: "", unitPrice: "", rate: null, uncertain: false, corrected: false, added: true }]);
    setDirty(true);
  };

  const payload = JSON.stringify({
    items: rows
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.name.trim() || r.qty || r.unitPrice || r.rate !== null)
      .map(({ r, i }) => ({
        name: r.name.trim() || "(品名なし)",
        spec: r.spec,
        unit: r.unit,
        qty: r.rate !== null ? 1 : (num(r.qty) ?? null),
        unitPrice: r.rate !== null ? res.rows[i].amount : (num(r.unitPrice) ?? null),
        amount: res.rows[i].amount,
        rate: r.rate,
        uncertain: r.uncertain,
        corrected: r.corrected,
      })),
    taxMode,
    discount: Math.max(0, num(discount) ?? 0),
  });

  return (
    <div className="@container space-y-4">
      {/* 税込・税抜 */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-ink-2">単価は</span>
        <div role="radiogroup" aria-label="単価は税込か税抜か" className="inline-flex overflow-hidden rounded-lg border border-line">
          {(["税込", "税抜"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={taxMode === m}
              disabled={!editable}
              onClick={() => {
                setTaxMode(m);
                setDirty(true);
              }}
              className={`h-9 px-4 text-sm font-medium ${taxMode === m ? "bg-accent text-white" : "bg-panel text-ink-2 hover:bg-subtle"}`}
            >
              {m}
            </button>
          ))}
        </div>
        {!taxModeRead && <span className="text-[11px] text-warn-ink">用紙に○がないため、{initialTaxMode}で計算しています</span>}
      </div>

      {/* 明細 */}
      <ol className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel">
        {rows.length === 0 && <li className="px-3 py-6 text-center text-sm text-ink-3">読み取った明細がありません。「行を追加」で入力してください。</li>}
        {rows.map((r, i) => {
          const out = res.rows[i];
          const isRate = r.rate !== null;
          return (
            <li key={i} className={`px-3 py-2.5 ${r.uncertain ? "bg-warn-soft/70" : ""}`}>
              <div className="flex items-start gap-2">
                <span className="mt-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded bg-subtle px-1 text-[11px] font-medium text-ink-2 tnum">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  {r.added && editable ? (
                    <input value={r.name} onChange={(e) => update(i, { name: e.target.value })} placeholder="品名 (例: 金券)" aria-label={`${i + 1} 行目の品名`} className="field h-8 py-1 text-sm" />
                  ) : (
                    <div className="text-sm font-medium text-ink">
                      {r.name}
                      {r.spec && <span className="ml-1.5 font-normal text-ink-2">{r.spec}</span>}
                    </div>
                  )}
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    {r.uncertain && <span className="rounded bg-warn px-1.5 text-[10px] font-medium text-white">要確認 (読みにくい)</span>}
                    {r.corrected && <span className="rounded bg-ink-2 px-1.5 text-[10px] font-medium text-white">消して書き直しあり</span>}
                  </div>
                </div>
                {editable && (
                  <div className="flex shrink-0 items-center gap-1">
                    {r.uncertain && (
                      <button type="button" onClick={() => update(i, { uncertain: false })} className="inline-flex h-8 items-center gap-1 rounded-lg border border-line bg-panel px-2 text-xs text-ink hover:bg-subtle">
                        <Check className="h-3.5 w-3.5" /> 用紙と同じ
                      </button>
                    )}
                    <button type="button" onClick={() => remove(i)} className="rounded p-1.5 text-critical hover:bg-critical-soft hover:text-critical-ink" aria-label={`${i + 1} 行目を削除`}>
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </div>

              <div className="mt-2 flex flex-wrap items-center justify-end gap-x-2 gap-y-1.5 pl-7">
                {isRate ? (
                  <>
                    <span className="mr-auto text-xs text-ink-2">{rateBasis(out)}</span>
                    {editable && (
                      <button type="button" onClick={() => update(i, { rate: null, qty: "1", unitPrice: out.amount !== null ? String(out.amount) : "" })} className="text-[11px] text-accent hover:underline">
                        金額を直接入力する
                      </button>
                    )}
                  </>
                ) : (
                  <>
                    <label className="flex items-center gap-1">
                      <span className="sr-only">{i + 1} 行目の数量</span>
                      <input value={r.qty} onChange={(e) => update(i, { qty: e.target.value })} disabled={!editable} inputMode="decimal" placeholder="数量" className="field h-10 w-20 py-1 text-right text-base tnum" />
                      {r.unit && <span className="text-xs text-ink-2">{r.unit}</span>}
                    </label>
                    <span className="text-ink-3">×</span>
                    <label className="flex items-center gap-1">
                      <span className="sr-only">{i + 1} 行目の単価</span>
                      <input value={r.unitPrice} onChange={(e) => update(i, { unitPrice: e.target.value })} disabled={!editable} inputMode="numeric" placeholder="単価" className="field h-10 w-28 py-1 text-right text-base tnum" />
                      <span className="text-xs text-ink-2">円</span>
                    </label>
                  </>
                )}
                <span className="text-ink-3">=</span>
                <span className={`min-w-[7.5rem] text-right text-xl font-bold tnum ${out.amount === null ? "text-critical" : out.amount < 0 ? "text-critical-ink" : "text-ink"}`}>
                  {out.amount === null ? "計算できません" : `${signed(out.amount)} 円`}
                </span>
              </div>
              {out.writtenDiffers !== undefined && <p className="mt-1 pl-7 text-[11px] text-warn-ink">用紙の金額欄に {yen(out.writtenDiffers)} 円と書かれています (数量 × 単価と違います)</p>}
              {out.ambiguous && <p className="mt-1 pl-7 text-[11px] text-warn-ink">上の {out.baseRows?.length} 行の合計に対して計算しました。一部の行だけの値引きなら「金額を直接入力する」で直してください。</p>}
              {out.amount === null && !isRate && <p className="mt-1 pl-7 text-[11px] text-critical-ink">数量と単価を入力してください (諸経費など金額だけの行は 数量 1 × 金額)。</p>}
            </li>
          );
        })}
      </ol>
      {editable && (
        <button type="button" onClick={add} className="inline-flex items-center gap-1 rounded-lg border border-line px-3 py-1.5 text-xs text-ink-2 hover:bg-subtle">
          <Plus className="h-3.5 w-3.5" /> 行を追加 (読み落とした行・金券など)
        </button>
      )}

      {/* 合計 (用紙の下の欄と上部の「税込合計金額」に書き写す) */}
      <div className="rounded-xl border-2 border-accent/40 bg-accent-soft/30 p-4">
        {unsure > 0 && <p className="mb-3 rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn-ink">黄色の行が {unsure} 行あります。用紙の数量・単価と見比べ、同じなら「用紙と同じ」、違えば直してから書き写してください。</p>}
        {res.missing.length > 0 && <p className="mb-3 rounded-lg bg-critical-soft px-3 py-2 text-xs text-critical-ink">金額を計算できない行が {res.missing.length} 行あります。合計はその行を 0 円として計算しています。</p>}
        <dl className="space-y-1.5 text-sm">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-ink-2">小計</dt>
            <dd className="text-lg font-semibold tnum">{signed(res.subtotal)} 円</dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-ink-2">
              <label htmlFor={`calc_discount_${id}`}>値引き (明細とは別)</label>
            </dt>
            <dd className="flex items-center gap-1">
              <span className="text-ink-3">▲</span>
              <input id={`calc_discount_${id}`} value={discount} onChange={(e) => { setDiscount(e.target.value); setDirty(true); }} disabled={!editable} inputMode="numeric" placeholder="0" className="field h-9 w-28 py-1 text-right tnum" />
              <span className="text-xs text-ink-2">円</span>
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-ink-2">{taxMode === "税込" ? "うち消費税 (10%)" : "消費税 (10%)"}</dt>
            <dd className="text-lg font-semibold tnum">{yen(res.tax)} 円</dd>
          </div>
          <div className="flex items-baseline justify-between gap-3 border-t border-line pt-2">
            <dt className="font-medium text-ink">合計 = 税込合計金額</dt>
            <dd className="text-3xl font-bold text-accent-ink tnum">{yen(res.total)} 円</dd>
          </div>
        </dl>
        <p className="mt-2 text-[11px] leading-relaxed text-ink-3">
          {taxMode === "税込" ? "単価は税込として計算しています (合計 = 小計 − 値引き。消費税は合計に含まれる 10%)。" : "単価は税抜として計算しています (合計 = 小計 − 値引き + 消費税 10%。円未満切り捨て)。"} 合計は見積書の下の「合計」と、上の「税込合計金額」の欄に書き写します。割合の値引きは円未満を切り捨てています。
        </p>
      </div>

      {editable && (
        <form action={saveAction} className="flex flex-wrap items-center gap-3">
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="data" value={payload} />
          <SaveButton dirty={dirty} />
          <span className="text-[11px] text-ink-3">{dirty ? "保存していない変更があります。直したときは保存してください (書き写しの確認と見積の登録に使います)。" : "数量・単価を直したら保存してください。"}</span>
        </form>
      )}
    </div>
  );
}
