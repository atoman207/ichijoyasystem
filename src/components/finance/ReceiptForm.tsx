"use client";

import { useState } from "react";
import clsx from "clsx";
import { Plus, Receipt, TriangleAlert, X } from "lucide-react";
import type { ReceiptMethod, ReceiptPart } from "@/lib/db/types";
import { RECEIPT_METHODS, RECEIPT_METHOD_LABEL } from "@/lib/receipts";
import { issueReceipt } from "@/lib/actions/receipts";
import { Button } from "@/components/ui";

/**
 * 領収書の発行 (支払方法ごとの内訳。お客様のご要望 2026-11-25「⑧」): 現金・商品券・カード・電子決済・振込・その他 (自由記載) の金額を入れ、
 * 合計が領収金額と合わないときは赤く知らせて発行できない。請求書の残り (二重発行) を超えるときも知らせる (サーバーでも確かめる)
 */

export interface ReceiptFormProps {
  invoiceId: string;
  invoiceNumber: string;
  returnTo: string;
  total: number;
  paidAmount: number;
  /** あと何円まで発行できるか */
  remaining: number;
  amount: number;
  parts: ReceiptPart[];
  beforePayment: boolean;
  addressee: string;
  honorific: "様" | "御中";
  purpose: string;
  today: string;
  compact?: boolean;
}

type Row = { key: number; method: ReceiptMethod; amount: string; note: string };

const yen = (n: number) => `¥${Math.round(n).toLocaleString("ja-JP")}`;
const toNum = (s: string) => {
  const n = Number(s.normalize("NFKC").replace(/[,，円¥\s]/g, ""));
  return Number.isFinite(n) ? Math.round(n) : NaN;
};

export function ReceiptForm(p: ReceiptFormProps) {
  const [amount, setAmount] = useState(String(p.amount || ""));
  const [rows, setRows] = useState<Row[]>(() => (p.parts.length ? p.parts : [{ method: "cash" as ReceiptMethod, amount: p.amount }]).map((x, i) => ({ key: i, method: x.method, amount: String(x.amount || ""), note: x.note ?? "" })));
  const [more, setMore] = useState(false);
  const total = toNum(amount);
  const sum = rows.reduce((a, r) => a + (toNum(r.amount) || 0), 0);
  const bad = rows.some((r) => r.amount.trim() !== "" && Number.isNaN(toNum(r.amount)));
  const mismatch = Number.isFinite(total) && total > 0 && sum !== total;
  const over = Number.isFinite(total) && total > p.remaining;
  const otherNoName = rows.some((r) => r.method === "other" && toNum(r.amount) > 0 && !r.note.trim());
  const set = (k: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === k ? { ...r, ...patch } : r)));
  const parts = rows.map((r) => ({ method: r.method, amount: toNum(r.amount) || 0, note: r.method === "other" ? r.note.trim() : undefined })).filter((r) => r.amount !== 0);
  /** 1 つの支払方法だけのときは、領収金額を変えたら内訳も合わせる */
  const changeAmount = (v: string) => {
    setAmount(v);
    if (rows.length === 1) setRows((rs) => [{ ...rs[0], amount: v }]);
  };
  const fillRest = (k: number) => {
    const others = rows.filter((r) => r.key !== k).reduce((a, r) => a + (toNum(r.amount) || 0), 0);
    if (Number.isFinite(total)) set(k, { amount: String(Math.max(0, total - others)) });
  };

  if (p.remaining <= 0) return <p className="text-xs text-ink-3">この請求書 ({yen(p.total)}) の領収書はすべて発行済みです。作り直すときは、発行した領収書を取り消してから発行してください。</p>;

  return (
    <form action={issueReceipt} className={clsx("space-y-2.5", p.compact && "text-sm")} data-testid="receipt-form">
      <input type="hidden" name="invoiceId" value={p.invoiceId} />
      <input type="hidden" name="returnTo" value={p.returnTo} />
      <input type="hidden" name="parts" value={JSON.stringify(parts)} />
      {p.beforePayment && <p className="rounded-lg bg-info-soft px-3 py-1.5 text-[11px] text-info-ink">入金の記録の前に発行します (納品・施工の日にお渡しする領収書)。お預かりしたら、請求書の画面で入金を記録してください (下の「この領収書の内訳で入金を記録」でも記録できます)。</p>}
      <div className="flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="label">領収金額 (税込)</span>
          <input name="amount" inputMode="numeric" value={amount} onChange={(e) => changeAmount(e.target.value)} required className="field w-36 text-right tnum" aria-label="領収金額" />
        </label>
        <label className="block">
          <span className="label">領収日</span>
          <input type="date" name="issueDate" defaultValue={p.today} required className="field w-auto" />
        </label>
        <span className="pb-2 text-[11px] text-ink-3">
          請求 {yen(p.total)} · 入金の記録 {yen(p.paidAmount)} · 発行できる残り {yen(p.remaining)}
        </span>
      </div>

      <fieldset className="rounded-lg border border-line p-2">
        <legend className="px-1 text-[11px] font-semibold text-ink-2">お支払の内訳 (支払方法ごとの金額)</legend>
        <ul className="space-y-1.5">
          {rows.map((r) => (
            <li key={r.key} className="flex flex-wrap items-center gap-1.5">
              <select value={r.method} onChange={(e) => set(r.key, { method: e.target.value as ReceiptMethod })} className="field w-auto" aria-label="支払方法">
                {RECEIPT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {RECEIPT_METHOD_LABEL[m]}
                  </option>
                ))}
              </select>
              {r.method === "other" && <input value={r.note} onChange={(e) => set(r.key, { note: e.target.value })} maxLength={40} placeholder="支払方法の名前 (例: 地域振興券)" className="field w-44" aria-label="その他の支払方法の名前" />}
              <input inputMode="numeric" value={r.amount} onChange={(e) => set(r.key, { amount: e.target.value })} placeholder="金額" className="field w-32 text-right tnum" aria-label={`${RECEIPT_METHOD_LABEL[r.method]}の金額`} />
              {rows.length > 1 && (
                <button type="button" onClick={() => fillRest(r.key)} className="rounded px-1.5 py-1 text-[11px] text-accent hover:bg-accent-soft" title="領収金額からほかの内訳を引いた残りを入れる">
                  残りを入れる
                </button>
              )}
              {rows.length > 1 && (
                <button type="button" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} className="rounded p-1 text-critical hover:bg-critical-soft hover:text-critical-ink" aria-label="この支払方法を外す">
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
        {rows.length < RECEIPT_METHODS.length && (
          <button type="button" onClick={() => setRows((rs) => [...rs, { key: Math.max(...rs.map((x) => x.key)) + 1, method: RECEIPT_METHODS.find((m) => !rs.some((x) => x.method === m)) ?? "other", amount: "", note: "" }])} className="mt-1.5 inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-accent hover:bg-accent-soft">
            <Plus className="h-3.5 w-3.5" aria-hidden />
            支払方法を追加 (組み合わせのとき)
          </button>
        )}
        <div className={clsx("mt-1.5 flex flex-wrap justify-between gap-2 border-t border-line pt-1.5 text-xs tnum", mismatch ? "text-critical-ink" : "text-ink-2")}>
          <span>内訳の合計 {yen(sum)}</span>
          <span>領収金額 {Number.isFinite(total) ? yen(total) : "-"}</span>
        </div>
      </fieldset>

      {(mismatch || bad) && (
        <p className="flex items-center gap-1.5 rounded-lg border border-critical/40 bg-critical-soft px-3 py-2 text-xs font-medium text-critical-ink" role="alert" data-testid="receipt-mismatch">
          <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden />
          {bad ? "内訳の金額を数字で入れてください。" : `内訳の合計 (${yen(sum)}) と領収金額 (${yen(total)}) が合いません (差 ${yen(Math.abs(total - sum))})。`}
        </p>
      )}
      {over && (
        <p className="flex items-center gap-1.5 rounded-lg border border-critical/40 bg-critical-soft px-3 py-2 text-xs font-medium text-critical-ink" role="alert">
          <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden />
          発行できる残り ({yen(p.remaining)}) を超えています。二重発行にならないよう金額を確かめてください。
        </p>
      )}
      {otherNoName && <p className="text-[11px] text-critical-ink">「その他」は支払方法の名前を入れてください。</p>}

      <button type="button" onClick={() => setMore((m) => !m)} className="text-[11px] text-accent hover:underline" aria-expanded={more}>
        {more ? "宛名・但し書きを閉じる" : `宛名・但し書きを変える (いま: ${p.addressee} ${p.honorific} / 但し ${p.purpose})`}
      </button>
      {more && (
        <div className="grid grid-cols-1 gap-2 @xl:grid-cols-[minmax(0,1fr)_6rem]">
          <label className="block">
            <span className="label">宛名</span>
            <input name="addressee" defaultValue={p.addressee} maxLength={80} className="field" />
          </label>
          <label className="block">
            <span className="label">敬称</span>
            <select name="honorific" defaultValue={p.honorific} className="field">
              <option value="様">様</option>
              <option value="御中">御中</option>
            </select>
          </label>
          <label className="block @xl:col-span-2">
            <span className="label">但し書き</span>
            <input name="purpose" defaultValue={p.purpose} maxLength={80} className="field" />
          </label>
        </div>
      )}
      <Button type="submit" size="sm" disabled={mismatch || bad || over || otherNoName || !(total > 0)} data-testid="receipt-submit">
        <Receipt />
        領収書を発行 ({p.invoiceNumber})
      </Button>
    </form>
  );
}
