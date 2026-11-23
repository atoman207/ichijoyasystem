"use client";

import { useMemo, useState } from "react";
import { useFormStatus } from "react-dom";
import { Calculator, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { DocumentKind } from "@/lib/db/types";
import { CAPTURE_LAYOUT, FITTING_KINDS, REGISTER_LABEL, type FieldSpec, type RegisterTarget, type TableSpec } from "@/lib/capture-fields";
import { DOCUMENT_KIND_LABEL, EXPENSE_ACCOUNTS, EXPENSE_METHOD_LABEL } from "@/lib/constants";
import { SCORE_LABEL } from "@/lib/survey";

type Row = Record<string, string>;
type Target = RegisterTarget;

/** アンケートはがきの紐づけ (案件・担当者) の候補と初期値 */
export interface SurveyLinkProps {
  orderRef: string;
  orderLabel?: string;
  orderOptions: { value: string; label: string }[];
  users: { id: string; label: string }[];
  salesUserId: string;
  deliveryUserIds: string[];
  clerkUserId: string;
  duplicate?: string;
}

const yen = (n: number) => `¥${Math.round(n).toLocaleString("ja-JP")}`;

/** 入力欄の文字 → 数値 (カンマ・円記号・全角を許す)。空や数値でないときは null */
function num(v: string | undefined): number | null {
  const t = (v ?? "").normalize("NFKC").replace(/[,，円¥\s]/g, "");
  if (!t) return null;
  const x = Number(t);
  return Number.isFinite(x) ? x : null;
}

/** 表の列の幅 (広い欄のとき。TableSpec の width、なければ種類から) + 削除の列 */
function colTemplate(t: TableSpec): string {
  const w = (c: TableSpec["columns"][number]) => c.width ?? (c.type === "text" ? "minmax(6rem,1fr)" : c.type === "flag" ? "3.5rem" : c.type === "fittingKind" ? "5.5rem" : "5.5rem");
  return [...t.columns.map(w), "2rem"].join(" ");
}
/** カード (狭い欄) で 2 マス使う列 (品名・規格など幅の決まっていない文字の列)。カードは 2 列 (スマートフォン) か 4 列 (448px 以上) */
const wideCol = (c: TableSpec["columns"][number]) => c.type === "text" && (!c.width || c.width.startsWith("minmax"));

const toText = (v: unknown): string => (v === null || v === undefined ? "" : Array.isArray(v) ? v.map(String).join("\n") : String(v));

function Submit({ children, variant = "primary", name, value, pendingLabel, blocked = false }: { children: React.ReactNode; variant?: "primary" | "secondary" | "danger"; name?: string; value?: string; pendingLabel?: string; blocked?: boolean }) {
  const { pending, data } = useFormStatus();
  const mine = pending && (!name || data?.get(name) === value);
  const cls =
    variant === "primary"
      ? "bg-accent text-white hover:bg-accent-hover"
      : variant === "danger"
        ? "border border-critical/40 bg-panel text-critical hover:bg-critical-soft"
        : "border border-line bg-panel text-ink hover:bg-subtle";
  return (
    <button type="submit" name={name} value={value} disabled={pending || blocked} title={blocked ? "要確認の項目を確認してチェックを入れると登録できます" : undefined} className={`inline-flex h-9 items-center justify-center gap-1.5 rounded-lg px-3.5 text-sm font-medium disabled:opacity-60 ${cls}`}>
      {mine ? (pendingLabel ?? "処理中…") : children}
    </button>
  );
}

export function DocumentReview({
  id,
  kind,
  initial,
  editable,
  registerTargets,
  attachable,
  customerOptions,
  targetOptions,
  productNames,
  saveAction,
  attachAction,
  retryAction,
  discardAction,
  canRetry,
  aiEnabled,
  survey,
  newCustomerHref,
  customerHint,
}: {
  survey?: SurveyLinkProps;
  /** 新しいお客様の登録 (読み取った氏名・電話・住所を初期値に) */
  newCustomerHref?: string;
  customerHint?: string;
  id: string;
  kind: DocumentKind;
  initial: Record<string, unknown>;
  editable: boolean;
  registerTargets: Target[];
  attachable: boolean;
  /** 読み取ったお客様名に近い顧客 (見積を作るときの候補) */
  customerOptions: { id: string; label: string }[];
  /** 保存先の候補 (受注・問い合わせ・顧客の番号) */
  targetOptions: { value: string; label: string }[];
  productNames: Record<string, string>;
  saveAction: (fd: FormData) => Promise<void>;
  attachAction: (fd: FormData) => Promise<void>;
  retryAction: (fd: FormData) => Promise<void>;
  discardAction: () => Promise<void>;
  canRetry: boolean;
  aiEnabled: boolean;
}) {
  const layout = CAPTURE_LAYOUT[kind];
  const scalarFields = useMemo(() => [...layout.top, ...layout.bottom], [layout]);
  const [values, setValues] = useState<Row>(() =>
    Object.fromEntries(scalarFields.map((f) => [f.key, f.type === "multi" ? (Array.isArray(initial[f.key]) ? (initial[f.key] as unknown[]).map(String).join("|") : "") : toText(initial[f.key])])),
  );
  const [link, setLink] = useState(() => ({ orderRef: survey?.orderRef ?? "", salesUserId: survey?.salesUserId ?? "", deliveryUserIds: survey?.deliveryUserIds ?? [], clerkUserId: survey?.clerkUserId ?? "" }));
  const [tables, setTables] = useState<Record<string, Row[]>>(() =>
    Object.fromEntries(
      layout.tables.map((t) => [
        t.key,
        (Array.isArray(initial[t.key]) ? (initial[t.key] as Record<string, unknown>[]) : []).map((r) => ({
          ...Object.fromEntries(t.columns.map((c) => [c.key, c.type === "flag" ? (r?.[c.key] === true ? "true" : "") : toText(r?.[c.key])])),
          ...(t.key === "items" && typeof r?.productId === "string" ? { _productId: r.productId, _origName: toText(r.name) } : {}),
        })),
      ]),
    ),
  );
  const [customerId, setCustomerId] = useState(customerOptions.length === 1 ? customerOptions[0].id : "");

  const set = (key: string, v: string) => setValues((s) => ({ ...s, [key]: v }));
  function setCell(table: string, index: number, key: string, v: string) {
    setTables((s) => {
      const rows = [...(s[table] ?? [])];
      const row = { ...rows[index], [key]: v };
      // 数量・単価を変えたら金額を計算し直す
      if (table === "items" && (key === "qty" || key === "unitPrice")) {
        const q = num(row.qty);
        const p = num(row.unitPrice);
        if (q !== null && p !== null) row.amount = String(Math.round(q * p));
      }
      rows[index] = row;
      return { ...s, [table]: rows };
    });
  }
  const addRow = (t: TableSpec) => setTables((s) => ({ ...s, [t.key]: [...(s[t.key] ?? []), Object.fromEntries(t.columns.map((c) => [c.key, c.type === "fittingKind" ? "襖" : ""]))] }));
  const removeRow = (table: string, index: number) => setTables((s) => ({ ...s, [table]: (s[table] ?? []).filter((_, i) => i !== index) }));

  const itemsSum = (tables.items ?? []).reduce((a, r) => a + (num(r.amount) ?? (num(r.qty) ?? 0) * (num(r.unitPrice) ?? 0)), 0);
  const hasField = (k: string) => scalarFields.some((f) => f.key === k);

  /** 明細の合計から合計欄を埋める (見積: 小計・消費税・合計 / 請求書: 税抜・消費税・請求金額 / レシート: 消費税) */
  function fillTotals() {
    const sum = Math.round(itemsSum);
    if (hasField("taxMode") && values.taxMode === "税込") {
      const d = Math.min(num(values.discount) ?? 0, sum);
      const total = sum - d;
      setValues((s) => ({ ...s, subtotal: String(sum), tax: String(Math.floor((total * 10) / 110)), total: String(total), totalTaxIncluded: String(total) }));
    } else if (hasField("total")) {
      const d = Math.min(num(values.discount) ?? 0, sum);
      const tax = Math.floor((sum - d) * 0.1);
      setValues((s) => ({ ...s, subtotal: String(sum), tax: String(tax), total: String(sum - d + tax), ...(hasField("totalTaxIncluded") ? { totalTaxIncluded: String(sum - d + tax) } : {}) }));
    } else if (hasField("subtotal") && hasField("taxAmount")) {
      const tax = Math.floor(sum * 0.1);
      setValues((s) => ({ ...s, subtotal: String(sum), taxAmount: String(tax), amount: String(sum + tax) }));
    } else if (hasField("taxAmount")) {
      const amount = num(values.amount) ?? sum;
      setValues((s) => ({ ...s, amount: String(amount), taxAmount: String(Math.floor((amount * 10) / 110)) }));
    } else if (hasField("amount")) {
      setValues((s) => ({ ...s, amount: String(sum) }));
    }
  }

  const payload = useMemo(() => {
    const out: Record<string, unknown> = {};
    for (const f of scalarFields) {
      const v = values[f.key] ?? "";
      out[f.key] = f.type === "money" || f.type === "score" || f.type === "number" ? num(v) : f.type === "multi" ? v.split("|").filter(Boolean) : v.trim();
    }
    for (const t of layout.tables) {
      out[t.key] = (tables[t.key] ?? [])
        .map((r) => Object.fromEntries(t.columns.map((c) => [c.key, c.type === "number" || c.type === "money" ? num(r[c.key]) : c.type === "flag" ? r[c.key] === "true" : (r[c.key] ?? "").trim()])))
        .filter((r) => Object.entries(r).some(([k, v]) => k !== "uncertain" && v !== null && v !== ""));
    }
    return JSON.stringify(out);
  }, [values, tables, scalarFields, layout.tables]);

  const unsureFields = new Set(Array.isArray(initial.uncertainFields) ? (initial.uncertainFields as string[]) : []);
  const unsureRows = (tables.items ?? []).filter((r) => r.uncertain === "true").length;
  const needsConfirm = editable && (unsureFields.size > 0 || unsureRows > 0);
  const [confirmedChecked, setConfirmedChecked] = useState(false);
  const subtotalMismatch = (hasField("subtotal") && num(values.subtotal) !== null && (tables.items ?? []).length > 0 && Math.abs((num(values.subtotal) ?? 0) - itemsSum) > 1) || false;

  function renderField(f: FieldSpec) {
    const common = { id: `f_${f.key}`, value: values[f.key] ?? "", onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => set(f.key, e.target.value) };
    let input: React.ReactNode;
    switch (f.type) {
      case "textarea":
      case "lines":
        input = <textarea {...common} rows={f.type === "lines" ? 3 : 3} className="field min-h-[72px]" />;
        break;
      case "date":
        input = <input {...common} type="date" className="field" />;
        break;
      case "money":
        input = <input {...common} inputMode="numeric" className="field text-right tnum" placeholder="未入力" />;
        break;
      case "account":
        input = (
          <select {...common} className="field">
            <option value="">(選択)</option>
            {EXPENSE_ACCOUNTS.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        );
        break;
      case "payment":
        input = (
          <select {...common} className="field">
            <option value="">(選択)</option>
            {Object.entries(EXPENSE_METHOD_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        );
        break;
      case "choice":
        input = (
          <select {...common} className="field">
            <option value="">(なし・読めない)</option>
            {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        );
        break;
      case "number":
        input = <input {...common} inputMode="decimal" className="field text-right tnum" placeholder="未入力" />;
        break;
      case "score":
        input = (
          <select {...common} className="field">
            <option value="">(未回答・読めない)</option>
            {[5, 4, 3, 2, 1].map((n) => <option key={n} value={String(n)}>{n}. {SCORE_LABEL[n]}</option>)}
          </select>
        );
        break;
      case "yesno":
        input = (
          <select {...common} className="field">
            <option value="">(未回答)</option>
            <option value="はい">はい</option>
            <option value="いいえ">いいえ</option>
          </select>
        );
        break;
      case "multi": {
        const selected = new Set((values[f.key] ?? "").split("|").filter(Boolean));
        const toggle = (o: string) => {
          const next = new Set(selected);
          if (next.has(o)) next.delete(o);
          else next.add(o);
          set(f.key, (f.options ?? []).filter((x) => next.has(x)).join("|"));
        };
        return (
          <fieldset key={f.key} className={`min-w-0 ${f.wide ? "@xl:col-span-2" : ""} ${unsureFields.has(f.key) ? "rounded-lg bg-warn-soft/60 p-1.5 ring-1 ring-warn" : ""}`}>
            <legend className="label">{f.label}</legend>
            <div className="flex flex-wrap gap-1.5">
              {(f.options ?? []).map((o) => (
                <label key={o} className={`inline-flex cursor-pointer items-center gap-1 rounded-full border px-2.5 py-1 text-xs ${selected.has(o) ? "border-accent bg-accent-soft text-accent-ink" : "border-line text-ink-2 hover:bg-subtle"}`}>
                  <input type="checkbox" className="sr-only" checked={selected.has(o)} onChange={() => toggle(o)} />
                  {selected.has(o) ? "✓ " : ""}
                  {o}
                </label>
              ))}
            </div>
          </fieldset>
        );
      }
      default:
        input = <input {...common} className="field" placeholder={f.placeholder} />;
    }
    const unsure = unsureFields.has(f.key);
    return (
      <div key={f.key} className={`contents`}>
        {f.heading && <div className="mt-2 border-b border-line pb-1 text-xs font-semibold text-ink @xl:col-span-2">{f.heading}</div>}
        <label htmlFor={`f_${f.key}`} className={`block min-w-0 ${f.wide ? "@xl:col-span-2" : ""} ${unsure ? "rounded-lg bg-warn-soft/60 p-1.5 ring-1 ring-warn" : ""}`}>
          <span className="label">{f.label}{unsure && <span className="ml-1.5 rounded bg-warn px-1 text-[10px] font-medium text-white">要確認</span>}</span>
          {input}
        </label>
      </div>
    );
  }

  function renderTable(t: TableSpec) {
    const rows = tables[t.key] ?? [];
    return (
      <div key={t.key}>
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span className="label mb-0">{t.label}</span>
          {editable && (
            <button type="button" onClick={() => addRow(t)} className="inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1 text-xs text-ink-2 hover:bg-subtle">
              <Plus className="h-3.5 w-3.5" /> 行を追加
            </button>
          )}
        </div>
        {/* 広い欄は表 (列の幅は TableSpec の width)、狭い欄 (スマートフォン) は 1 行ずつのカード。入力欄は 1 組だけ (送る値は data の JSON) */}
        <div className="@container">
          <div className="overflow-hidden rounded-xl border border-line text-sm" style={{ "--cols": colTemplate(t) } as React.CSSProperties}>
            <div className="hidden gap-x-1.5 bg-subtle px-1.5 py-1.5 text-xs font-medium text-ink-2 @2xl:grid @2xl:grid-cols-(--cols)" aria-hidden>
              {t.columns.map((c) => <span key={c.key} className={`px-0.5 ${c.type === "text" || c.type === "fittingKind" ? "text-left" : c.type === "flag" ? "text-center" : "text-right"}`}>{c.label}</span>)}
              <span />
            </div>
            <div className="divide-y divide-line border-line @2xl:border-t">
            {rows.length === 0 && (
              <p className="px-3 py-3 text-center text-xs text-ink-3">読み取った行はありません{editable ? " (「行を追加」で入力できます)" : ""}</p>
            )}
            {rows.map((r, i) => (
              <div
                key={i}
                role="group"
                aria-label={`${i + 1} 行目`}
                className={`grid grid-cols-2 gap-x-2 gap-y-2 p-3 @md:grid-cols-4 @2xl:grid-cols-(--cols) @2xl:items-start @2xl:gap-x-1.5 @2xl:gap-y-0 @2xl:px-1.5 @2xl:py-1 ${r.uncertain === "true" ? "bg-warn-soft/70" : ""}`}
              >
                <div className="col-span-2 flex items-center justify-between gap-2 @md:col-span-4 @2xl:hidden">
                  <span className="text-xs font-medium text-ink-2">{i + 1} 行目</span>
                  {/* 要確認などの印はカードの見出しの行に (広い欄では表の列) */}
                  {t.columns.filter((c) => c.type === "flag").map((c) => (
                    <label key={c.key} className="ml-auto flex items-center gap-1.5 text-xs text-ink-2" title="読みにくい・判断が難しい行">
                      <input type="checkbox" checked={r[c.key] === "true"} onChange={(e) => setCell(t.key, i, c.key, e.target.checked ? "true" : "")} className="h-4 w-4" />
                      {c.label}
                    </label>
                  ))}
                  {editable && (
                    <button type="button" onClick={() => removeRow(t.key, i)} className="rounded p-1.5 text-ink-3 hover:bg-critical-soft hover:text-critical" aria-label={`${i + 1} 行目を削除`}>
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
                {t.columns.map((c) => (
                  <div key={c.key} className={`min-w-0 ${c.type === "flag" ? "hidden @2xl:block" : wideCol(c) ? "col-span-2" : ""} @2xl:col-span-1`}>
                    {c.type !== "flag" && <span className="mb-0.5 block text-[11px] text-ink-3 @2xl:hidden">{c.label}</span>}
                    {c.type === "flag" ? (
                      <label className="flex h-8 items-center justify-center" title="読みにくい・判断が難しい行">
                        <input type="checkbox" checked={r[c.key] === "true"} onChange={(e) => setCell(t.key, i, c.key, e.target.checked ? "true" : "")} className="h-4 w-4" aria-label={c.label} />
                      </label>
                    ) : c.type === "fittingKind" ? (
                      <select className="field h-9 py-1 text-sm @2xl:h-8 @2xl:text-xs" value={r[c.key] ?? ""} onChange={(e) => setCell(t.key, i, c.key, e.target.value)} aria-label={c.label}>
                        {FITTING_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                      </select>
                    ) : (
                      <input
                        className={`field h-9 py-1 text-sm @2xl:h-8 @2xl:text-xs ${c.type === "text" ? "" : "text-right tnum"}`}
                        inputMode={c.type === "text" ? undefined : "decimal"}
                        value={r[c.key] ?? ""}
                        onChange={(e) => setCell(t.key, i, c.key, e.target.value)}
                        aria-label={c.label}
                      />
                    )}
                    {t.key === "items" && c.key === "name" && r._productId && r.name === r._origName && productNames[r._productId] && (
                      <span className="mt-0.5 block truncate text-[10px] text-good-ink">商品マスタ: {productNames[r._productId]}</span>
                    )}
                  </div>
                ))}
                <div className="hidden justify-end @2xl:flex">
                  {editable && (
                    <button type="button" onClick={() => removeRow(t.key, i)} className="rounded p-1.5 text-ink-3 hover:bg-critical-soft hover:text-critical" aria-label={`${i + 1} 行目を削除`}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
            ))}
            </div>
          </div>
        </div>
        {t.key === "items" && rows.length > 0 && (
          <div className="mt-1.5 flex flex-wrap items-center justify-end gap-3 text-xs text-ink-2">
            <span>明細の合計: <span className="font-medium text-ink tnum">{yen(itemsSum)}</span></span>
            {editable && (hasField("total") || hasField("amount")) && (
              <button type="button" onClick={fillTotals} className="inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1 text-xs text-ink-2 hover:bg-subtle">
                <Calculator className="h-3.5 w-3.5" /> 合計欄に反映
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  const topFields = layout.top;
  const bottomFields = layout.bottom;

  return (
    <div className="@container space-y-5">
      <fieldset disabled={!editable} className="min-w-0 space-y-5">
        <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2">{topFields.map(renderField)}</div>
        {layout.tables.map(renderTable)}
        <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2">{bottomFields.map(renderField)}</div>
        {subtotalMismatch && <p className="rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn-ink">明細の合計 ({yen(itemsSum)}) と小計 ({yen(num(values.subtotal) ?? 0)}) が違います。書類を見て確認してください。</p>}
      </fieldset>

      {editable && (
        <>
          <form action={saveAction} className="space-y-3 rounded-xl border border-line bg-subtle/50 p-3">
            <input type="hidden" name="id" value={id} />
            <input type="hidden" name="data" value={payload} />
            {survey && registerTargets.includes("survey") && (
              <div className="space-y-3 rounded-lg border border-line bg-panel p-3">
                <div className="text-xs font-medium text-ink">案件・担当者との紐づけ (KPI・インセンティブの集計に使います)</div>
                {survey.duplicate && <p className="rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn-ink">{survey.duplicate}</p>}
                <label className="block">
                  <span className="label">案件 (受注番号)</span>
                  <input name="orderRef" list={`orders_${id}`} value={link.orderRef} onChange={(e) => setLink((l) => ({ ...l, orderRef: e.target.value }))} className="field" placeholder="はがき No. が売上台帳にあれば自動で入ります" autoComplete="off" />
                  <datalist id={`orders_${id}`}>
                    {survey.orderOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </datalist>
                  {survey.orderLabel && <span className="mt-1 block text-[11px] text-good-ink">はがき No. で見つかった案件: {survey.orderLabel}</span>}
                </label>
                <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
                  <label className="block">
                    <span className="label">事務担当 (① 電話対応の担当)</span>
                    <select name="clerkUserId" value={link.clerkUserId} onChange={(e) => setLink((l) => ({ ...l, clerkUserId: e.target.value }))} className="field">
                      <option value="">(未設定)</option>
                      {survey.users.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
                    </select>
                  </label>
                  <label className="block">
                    <span className="label">営業担当 (② の評価対象)</span>
                    <select name="salesUserId" value={link.salesUserId} onChange={(e) => setLink((l) => ({ ...l, salesUserId: e.target.value }))} className="field">
                      <option value="">(未設定)</option>
                      {survey.users.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
                    </select>
                  </label>
                </div>
                <fieldset>
                  <legend className="label">担当職人 (③ の評価対象・複数可)</legend>
                  <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
                    {survey.users.map((u) => {
                      const on = link.deliveryUserIds.includes(u.id);
                      return (
                        <label key={u.id} className={`inline-flex cursor-pointer items-center gap-1 rounded-full border px-2.5 py-1 text-xs ${on ? "border-accent bg-accent-soft text-accent-ink" : "border-line text-ink-2 hover:bg-subtle"}`}>
                          <input type="checkbox" name="deliveryUserIds" value={u.id} className="sr-only" checked={on} onChange={() => setLink((l) => ({ ...l, deliveryUserIds: on ? l.deliveryUserIds.filter((x) => x !== u.id) : [...l.deliveryUserIds, u.id] }))} />
                          {on ? "✓ " : ""}
                          {u.label}
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
              </div>
            )}
            {registerTargets.includes("quote") && customerHint && (
              <p className="rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn-ink">
                {customerHint}
                {newCustomerHref && <> <a href={newCustomerHref} className="font-medium underline">顧客を登録する →</a></>}
              </p>
            )}
            {registerTargets.includes("quote") && customerOptions.length > 0 && (
              <label className="block">
                <span className="label">見積のお客様 (読み取ったお客様名に近い顧客)</span>
                <select name="customerId" value={customerId} onChange={(e) => setCustomerId(e.target.value)} className="field">
                  <option value="">見積の画面で選ぶ</option>
                  {customerOptions.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                </select>
              </label>
            )}
            {needsConfirm && registerTargets.length > 0 && (
              <label className="flex items-start gap-2 rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn-ink">
                <input type="checkbox" name="confirmedUncertain" checked={confirmedChecked} onChange={(e) => setConfirmedChecked(e.target.checked)} className="mt-0.5 h-4 w-4" />
                <span>要確認の項目{unsureFields.size ? ` (${unsureFields.size} 項目)` : ""}{unsureRows ? `・黄色の明細 (${unsureRows} 行)` : ""} を、元の書類と見比べて確認しました。確認が済むまで登録はできません (「修正を保存」はできます)。</span>
              </label>
            )}
            <div className="flex flex-wrap gap-2">
              {registerTargets.map((t) => (
                <Submit key={t} name="intent" value={t} pendingLabel="保存中…" blocked={needsConfirm && !confirmedChecked}>{REGISTER_LABEL[t]} →</Submit>
              ))}
              <Submit name="intent" value="save" variant="secondary" pendingLabel="保存中…">修正を保存</Submit>
              {/* 手書き見積書は見積にするための書類。「確定して保存」は見積を作らずに書類を閉じるだけで、見積を作ったと取り違えやすいため出さない (2026-11-23) */}
              {kind !== "handwritten_quote" && <Submit name="intent" value="confirm" variant="secondary" pendingLabel="保存中…">確定して保存 (登録先なし)</Submit>}
            </div>
            {needsConfirm && registerTargets.length > 0 && !confirmedChecked && (
              <p className="text-xs font-medium text-warn-ink">「{REGISTER_LABEL[registerTargets[0]]}」は、上の「元の書類と見比べて確認しました」にチェックを入れると押せます。</p>
            )}
            <p className="text-[11px] text-ink-3">
              {registerTargets[0] === "survey"
                ? "「アンケートとして登録」を押すと、案件・担当者に紐づけて登録し、返信率・評価・KPI に反映します。はがきの写真は案件の添付ファイル (現場写真・資料) になります。"
                : registerTargets.length
                ? `「${REGISTER_LABEL[registerTargets[0]]}」を押すと、確認した内容を初期値にして作成画面を開きます。${registerTargets[0] === "quote" ? "作成画面でお客様を選び、「承認を申請」(管理者は「確定 (承認不要)」) か「下書き保存」を押すと見積になります。" : ""}元の画像は登録した記録の添付ファイルに移ります。`
                : "確認した内容を保存します。図面・施工資料は下の「案件に保存」で受注・問い合わせ・顧客に添付できます。"}
            </p>
          </form>

          {attachable && (
            <form action={attachAction} className="space-y-2 rounded-xl border border-line p-3">
              <input type="hidden" name="id" value={id} />
              <input type="hidden" name="data" value={payload} />
              <label className="block">
                <span className="label">案件に保存 (受注番号・問い合わせ番号・顧客コード)</span>
                <input name="target" list={`targets_${id}`} className="field" placeholder="例: O-2026-0012" required autoComplete="off" />
                <datalist id={`targets_${id}`}>
                  {targetOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </datalist>
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <Submit variant="secondary" pendingLabel="保存中…">案件に保存</Submit>
                <span className="text-[11px] text-ink-3">元の画像はその案件の添付ファイル (現場写真・資料) になり、読み取った内容は受注の進捗メモに残ります。{registerTargets.includes("quote") ? " 見積にはなりません (見積にするときは上の「見積を作成」)。" : ""}</span>
              </div>
            </form>
          )}

          <div className="flex flex-wrap items-end gap-2 border-t border-line pt-4">
            {canRetry && (
              <form action={retryAction} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="id" value={id} />
                <label className="block">
                  <span className="label">書類の種類</span>
                  <select name="kind" defaultValue={kind} className="field h-9 py-1 text-sm">
                    {(Object.keys(DOCUMENT_KIND_LABEL) as DocumentKind[]).filter((k) => k !== "reception").map((k) => <option key={k} value={k}>{DOCUMENT_KIND_LABEL[k]}</option>)}
                  </select>
                </label>
                <Submit variant="secondary" pendingLabel={aiEnabled ? "AI が読み取り中…" : "読み取り中…"}>
                  <RefreshCw className="h-3.5 w-3.5" /> もう一度読み取る
                </Submit>
              </form>
            )}
            <form action={discardAction} className="ml-auto">
              <Submit variant="danger" pendingLabel="破棄中…">破棄</Submit>
            </form>
          </div>
          {canRetry && <p className="-mt-3 text-[11px] text-ink-3">読み直すと、この画面で修正した内容は新しい読取結果に置き換わります。</p>}
        </>
      )}
    </div>
  );
}
