"use client";

import { useMemo, useState, useTransition } from "react";
import { EXPENSE_ACCOUNTS } from "@/lib/constants";
import { mergeCandidates, suggestAccounts, type AccountCandidate } from "@/lib/expense-account";
import { suggestExpenseAccounts } from "@/lib/actions/expenses";

/**
 * 経費の支払先・金額・内容・勘定科目の入力欄と、勘定科目の候補
 * - 入力しながら、言葉のルールで候補を出す (理由つき)。候補を押すと勘定科目に入る
 * - 「AI で候補を出す」で AI の候補 (理由つき) を加える (API キーがあるとき)
 * - レシートの読取で AI が出した候補 (initialCandidates) は最初から表示する
 */
export function ExpenseFields({
  initial,
  initialCandidates = [],
  aiAvailable,
}: {
  initial: { vendor?: string; amount?: number; taxAmount?: number; account?: string; description?: string };
  initialCandidates?: AccountCandidate[];
  aiAvailable: boolean;
}) {
  const [vendor, setVendor] = useState(initial.vendor ?? "");
  const [amount, setAmount] = useState(initial.amount ? String(initial.amount) : "");
  const [description, setDescription] = useState(initial.description ?? "");
  const [account, setAccount] = useState(initial.account ?? "");
  const [aiCands, setAiCands] = useState<AccountCandidate[]>(initialCandidates.filter((c) => c.source === "ai"));
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  const rule = useMemo(() => suggestAccounts({ vendor, description, amount: Number(amount) || 0 }), [vendor, description, amount]);
  const cands = mergeCandidates(aiCands, rule.length ? rule : initialCandidates.filter((c) => c.source === "rule"));
  const selected = account || cands[0]?.account || "消耗品費";

  const askAi = () =>
    start(async () => {
      setNote("");
      const r = await suggestExpenseAccounts({ vendor, description, amount: Number(amount) || 0, ai: true });
      setAiCands(r.candidates.filter((c) => c.source === "ai"));
      if (r.ai === "error") setNote(r.message ?? "AI の候補を取得できませんでした。");
      else if (r.ai === "off") setNote("支払先か内容を入力すると、AI の候補を出せます。");
      else if (!r.candidates.some((c) => c.source === "ai")) setNote("AI の候補はありませんでした。");
    });

  return (
    <div className="grid grid-cols-1 gap-4 @xl:grid-cols-2">
      <label className="block">
        <span className="label">支払先<span className="text-critical"> *</span></span>
        <input name="vendor" value={vendor} onChange={(e) => setVendor(e.target.value)} required placeholder="例: ENEOS 合志SS / ホームセンター" className="field" />
      </label>
      <label className="block">
        <span className="label">金額 (税込)<span className="text-critical"> *</span></span>
        <input name="amount" type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} required className="field" />
      </label>
      <label className="block">
        <span className="label">うち消費税</span>
        <input name="taxAmount" type="number" min={0} defaultValue={initial.taxAmount} className="field" />
        <span className="mt-1 block text-[11px] text-ink-3">空欄なら 10% として自動計算</span>
      </label>
      <label className="block">
        <span className="label">勘定科目</span>
        <select name="account" value={selected} onChange={(e) => setAccount(e.target.value)} className="field">
          {EXPENSE_ACCOUNTS.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
      </label>
      <label className="block @xl:col-span-2">
        <span className="label">内容・用途</span>
        <textarea name="description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="例: 施工車 給油 / 養生シート購入 / 現場用の脚立 (備品)" className="field min-h-[72px]" />
      </label>
      <div className="rounded-lg border border-line bg-subtle/60 p-3 @xl:col-span-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-medium text-ink">勘定科目の候補</span>
          {aiAvailable && (
            <button type="button" onClick={askAi} disabled={pending} className="rounded-md border border-line bg-panel px-2.5 py-1 text-xs text-accent hover:bg-accent-soft disabled:opacity-60">
              {pending ? "AI が考えています…" : "AI で候補を出す"}
            </button>
          )}
        </div>
        {cands.length === 0 ? (
          <p className="mt-1 text-xs text-ink-3">支払先・内容を入力すると候補が出ます。</p>
        ) : (
          <ul className="mt-2 flex flex-wrap gap-2">
            {cands.map((c) => (
              <li key={c.account}>
                <button
                  type="button"
                  onClick={() => setAccount(c.account)}
                  className={`rounded-lg border px-2.5 py-1.5 text-left text-xs ${selected === c.account ? "border-accent bg-accent-soft text-accent-ink" : "border-line bg-panel text-ink hover:border-accent"}`}
                >
                  <span className="font-medium">{c.account}</span>
                  <span className="ml-1 rounded bg-subtle px-1 text-[10px] text-ink-3">{c.source === "ai" ? "AI" : "ルール"}</span>
                  {c.reason && <span className="block text-[11px] text-ink-3">{c.reason}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
        {note && <p className="mt-1 text-[11px] text-ink-3">{note}</p>}
        <p className="mt-1 text-[11px] text-ink-3">候補は提案です。登録する科目は内容を確かめて選んでください (備品は 10 万円未満は消耗品費、10 万円以上は工具器具備品)。</p>
      </div>
    </div>
  );
}
