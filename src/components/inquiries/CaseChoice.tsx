"use client";

import { ExternalLink } from "lucide-react";
import type { CaseOption } from "@/lib/case-choice";
import { fmtDate, yen } from "@/lib/format";
import { Badge } from "@/components/ui";

/**
 * 問い合わせの登録のときの「新規案件 / 既存の案件に追加」(お客様のご要望 2026-11-26「■5」)。
 * 既存のお客様の進行中の案件 (工事内容・進み具合・最後の動き・金額・店舗) と、最近の完了した案件 (クレーム・手直しの連絡。たたんで表示) を出し、
 * 「新規案件として登録」か「この案件に問い合わせを追加」を選ぶ。案件のカードの「案件を開く」は別のタブで案件の画面 (/cases/<ID>)。
 * 選んだ値は hidden の name (既定 caseId) で送る: "new" = 新規案件 / 案件の ID。候補は src/lib/case-choice.ts の caseOptionsForCustomer
 */
export function CaseChoice({
  name = "caseId",
  value,
  onChange,
  open,
  past,
  pastTotal = past.length,
  customerName,
  suggestedId,
  step,
}: {
  name?: string;
  value: string;
  onChange: (v: string) => void;
  open: CaseOption[];
  past: CaseOption[];
  pastTotal?: number;
  customerName: string;
  /** 提案 (進行中の案件が 1 件だけ・案件番号が一致など) */
  suggestedId?: string;
  /** 見出しの番号 (例: ②) */
  step?: string;
}) {
  const all = [...open, ...past];
  const selected = all.find((c) => c.id === value);
  const pastSelected = past.some((c) => c.id === value);
  const radio = `${name}Pick`;
  const card = (c: CaseOption) => {
    const on = value === c.id;
    return (
      <li key={c.id}>
        <label className={`flex gap-2 rounded-lg border p-3 text-sm ${c.canAdd ? "cursor-pointer" : "cursor-not-allowed opacity-70"} ${on ? "border-accent bg-accent-soft ring-1 ring-accent/30" : "border-line bg-panel hover:border-accent/40"}`} data-testid="case-choice-case">
          <input type="radio" name={radio} checked={on} disabled={!c.canAdd} onChange={() => onChange(c.id)} className="mt-1 h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="font-semibold text-ink tnum">{c.number}</span>
              <Badge tone={c.open ? "accent" : "neutral"} dot={false}>
                {c.stageLabel}
              </Badge>
              {suggestedId === c.id && <span className="rounded bg-accent px-1.5 text-[10px] font-semibold text-white">提案</span>}
              <span className="text-[11px] text-ink-3">{c.storeName}</span>
            </span>
            <span className="mt-0.5 block font-medium text-ink">{c.title || "(工事内容の記入なし)"}</span>
            <span className="block text-[11px] text-ink-2">
              {[c.detail, c.lastAt ? `最後の動き ${fmtDate(c.lastAt)}` : "", c.amount !== undefined && c.amountLabel ? `${c.amountLabel} ${yen(c.amount)}` : "", `問い合わせ ${c.counts.inquiries}・見積 ${c.counts.quotes}・受注 ${c.counts.orders}`].filter(Boolean).join(" · ")}
            </span>
            {!c.canAdd && <span className="mt-0.5 block text-[11px] text-warn-ink">{c.storeName}の案件のため、ここからは追加できません (店舗に依頼してください)</span>}
            <span className="mt-1 flex flex-wrap items-center gap-3">
              {c.canAdd && <span className={`text-xs font-medium ${on ? "text-accent-ink" : "text-ink-2"}`}>{on ? "✓ この案件に問い合わせを追加" : "この案件に問い合わせを追加"}</span>}
              <a href={c.href} target="_blank" rel="noopener" className="inline-flex items-center gap-0.5 text-xs text-accent hover:underline" onClick={(e) => e.stopPropagation()}>
                案件を開く (別のタブ) <ExternalLink className="h-3 w-3" aria-hidden />
              </a>
            </span>
          </span>
        </label>
      </li>
    );
  };
  return (
    <section className="space-y-3 rounded-xl border-2 border-accent/30 bg-panel p-4" data-testid="case-choice">
      <input type="hidden" name={name} value={value} />
      <div>
        <h3 className="text-sm font-semibold text-ink">{step ? `${step} ` : ""}案件: 新しいご依頼ですか？ すでにある案件のご連絡ですか？</h3>
        <p className="mt-0.5 text-xs text-ink-2">
          {open.length === 0
            ? `${customerName} 様の進行中の案件はありません。新しいご依頼として登録します (完了した工事へのクレーム・手直しのご連絡は、下の「完了した案件」から選べます)。`
            : `${customerName} 様の進行中の案件が ${open.length} 件あります。工事内容・進み具合を確かめて、同じ件のご連絡なら「この案件に問い合わせを追加」、新しいご依頼なら「新規案件として登録」を選んでください。`}
        </p>
      </div>
      <label className={`flex cursor-pointer gap-2 rounded-lg border p-3 text-sm ${value === "new" ? "border-accent bg-accent-soft ring-1 ring-accent/30" : "border-line bg-panel hover:border-accent/40"}`} data-testid="case-choice-new">
        <input type="radio" name={radio} checked={value === "new"} onChange={() => onChange("new")} className="mt-1 h-4 w-4 shrink-0" />
        <span>
          <span className="font-semibold text-ink">新規案件として登録</span>
          {suggestedId === "new" && open.length > 0 && <span className="ml-1 rounded bg-accent px-1.5 text-[10px] font-semibold text-white">提案</span>}
          <span className="block text-[11px] text-ink-3">新しいご依頼 (別の部屋・別の工事など)。この問い合わせが新しい案件の始まりになります</span>
        </span>
      </label>
      {open.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-semibold text-ink-2">進行中の案件</p>
          <ul className="grid grid-cols-1 gap-2 @3xl:grid-cols-2">{open.map(card)}</ul>
        </div>
      )}
      {past.length > 0 && (
        <details open={pastSelected} className="rounded-lg border border-line bg-subtle/50 p-2">
          <summary className="cursor-pointer text-xs font-semibold text-ink-2">
            完了した案件 (クレーム・手直し・前回の工事のご連絡) {pastTotal > past.length ? `最近の ${past.length} 件 / ${pastTotal} 件` : `${past.length} 件`}
          </summary>
          <ul className="mt-2 grid grid-cols-1 gap-2 @3xl:grid-cols-2">{past.map(card)}</ul>
        </details>
      )}
      <p className={`rounded-lg px-3 py-2 text-xs ${value === "new" ? "bg-subtle text-ink-2" : "bg-accent-soft text-accent-ink"}`} data-testid="case-choice-summary">
        {selected ? `→ 案件 ${selected.number} (${selected.title || "工事内容の記入なし"}) に問い合わせを追加します${selected.open ? "" : " (完了した案件へのご連絡)"}。問い合わせ一覧と案件の画面の両方に出ます。` : "→ 新しい案件として登録します。"}
      </p>
    </section>
  );
}
