"use client";

import { useState } from "react";
import { Badge } from "@/components/ui";
import type { CustomerHit } from "@/lib/link-search";
import { SearchBox, useSearch } from "./LinkSearch";

/**
 * 見積の作成の画面の「お客様の確認」(予定表から取り込んだ案件の仮のお客様のとき。お客様のご要望 2026-11-26
 * 「■ スプレッドシートから移行した予定の顧客・見積・受注登録」)。
 * 撮影した見積書から読み取ったお名前・ふりがな・電話・住所で、
 * - 既存のお客様に紐付ける: 候補は ① 住所の一致 → ② 電話番号の一致 → ③ お名前の一致 (src/lib/reception.ts の matchReception)。電話番号・お名前の検索でも選べる
 * - 新しいお客様として登録する: 仮のお客様を、読み取った内容 (直せる) で正式に登録する (新しい顧客は足さない)
 * どちらも今の予定表の予定に顧客・見積・受注がつながる (新しい予定は作らない)。送る値: customerId・placeholderId・placeholderAction (link / promote)・promote*
 */

export interface PlaceholderCandidate extends CustomerHit {
  level: "address" | "phone" | "name";
  reason: string;
}

const LEVEL_LABEL = { address: "住所が一致", phone: "電話番号が一致", name: "お名前が一致" } as const;

export function PlaceholderCustomerChoice({
  placeholder,
  read,
  candidates,
  suggestedId,
}: {
  placeholder: { id: string; name: string; area: string };
  read: { name: string; kana: string; phone: string; address: string };
  candidates: PlaceholderCandidate[];
  /** 住所が 1 人だけ一致したお客様など (最初から選ぶ) */
  suggestedId?: string;
}) {
  const [choice, setChoice] = useState<string>(suggestedId ? `link:${suggestedId}` : "promote");
  const [picked, setPicked] = useState<CustomerHit | undefined>(undefined);
  const [form, setForm] = useState(read);
  const search = useSearch<CustomerHit>("/api/customers/search", [], "");
  const linkId = choice.startsWith("link:") ? choice.slice(5) : "";
  const shown = [...candidates, ...(picked && !candidates.some((c) => c.id === picked.id) ? [{ ...picked, level: "name" as const, reason: "検索から選んだお客様" }] : [])];

  const card = (c: PlaceholderCandidate) => {
    const on = linkId === c.id;
    return (
      <li key={c.id}>
        <label className={`flex cursor-pointer gap-2 rounded-lg border p-3 text-sm ${on ? "border-accent bg-accent-soft ring-1 ring-accent/30" : "border-line bg-panel hover:border-accent/40"}`} data-testid="placeholder-candidate">
          <input type="radio" name="placeholderPick" checked={on} onChange={() => setChoice(`link:${c.id}`)} className="mt-1 h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="font-semibold text-ink">{c.name} 様</span>
              <Badge tone={c.level === "address" ? "good" : c.level === "phone" ? "info" : "neutral"} dot={false}>
                {LEVEL_LABEL[c.level]}
              </Badge>
              {suggestedId === c.id && <span className="rounded bg-accent px-1.5 text-[10px] font-semibold text-white">提案</span>}
              <span className="text-[11px] text-ink-3">
                {c.code} · {c.storeName}
              </span>
            </span>
            <span className="mt-0.5 block text-ink">{c.address || "住所未登録"}</span>
            <span className="block text-[11px] text-ink-2">
              {c.phone || "電話未登録"} · {c.reason}
            </span>
            <span className={`mt-1 block text-xs font-medium ${on ? "text-accent-ink" : "text-ink-2"}`}>{on ? "✓ このお客様に紐付ける" : "このお客様に紐付ける"}</span>
          </span>
        </label>
      </li>
    );
  };

  return (
    <section className="space-y-3 rounded-xl border-2 border-warn/40 bg-panel p-4" data-testid="placeholder-choice">
      <input type="hidden" name="placeholderId" value={placeholder.id} />
      <input type="hidden" name="placeholderAction" value={linkId ? "link" : "promote"} />
      <input type="hidden" name="customerId" value={linkId || placeholder.id} />
      <div>
        <h3 className="text-sm font-semibold text-ink">お客様の確認 (予定表から移行した案件)</h3>
        <p className="mt-0.5 text-xs text-ink-2">
          この案件のお客様は予定表から仮に登録した「{placeholder.name}{placeholder.area ? ` (${placeholder.area})` : ""}」です。撮影した見積書から読み取ったお客様の情報で、既存のお客様に紐付けるか、新しいお客様として登録してください。どちらも予定表の今の予定に見積・受注がつながります (予定は増えません)。
        </p>
      </div>
      {shown.length > 0 ? (
        <div>
          <p className="mb-1 text-xs font-semibold text-ink-2">登録済みのお客様の候補 (住所の一致を先に)</p>
          <ul className="grid grid-cols-1 gap-2 @3xl:grid-cols-2">{shown.map(card)}</ul>
        </div>
      ) : (
        <p className="text-xs text-ink-3">読み取った住所・電話番号・お名前に当たる登録済みのお客様はいません。</p>
      )}
      <details className="rounded-lg border border-line bg-subtle/40 p-2">
        <summary className="cursor-pointer text-xs font-semibold text-ink-2">電話番号・お名前・住所でほかのお客様を探す</summary>
        <div className="mt-2 space-y-2">
          <SearchBox value={search.q} onChange={search.setQ} busy={search.busy} label="既存のお客様を検索" placeholder="住所・お名前・フリガナ・電話番号で検索 (例: ○○町 123 / 山田 / 0968)" />
          {search.error && <p className="text-xs text-critical-ink">{search.error}</p>}
          {search.q.trim() && !search.busy && search.items.length === 0 && !search.error && <p className="text-xs text-ink-3">「{search.q.trim()}」に当たるお客様はいません。</p>}
          {search.items.length > 0 && (
            <ul className="max-h-64 divide-y divide-line overflow-y-auto rounded-lg border border-line bg-panel">
              {search.items
                .filter((c) => c.id !== placeholder.id)
                .map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
                    <span className="min-w-0 flex-1">
                      <span className="font-semibold text-ink">{c.name} 様</span> <span className="text-ink-3">{c.code} · {c.storeName}</span>
                      <span className="block text-ink">{c.address || "住所未登録"}</span>
                      <span className="block text-ink-3">{c.phone || "電話未登録"}</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setPicked(c);
                        setChoice(`link:${c.id}`);
                      }}
                      className="rounded-lg border border-accent px-2.5 py-1 font-medium text-accent-ink hover:bg-accent-soft"
                    >
                      このお客様を選ぶ
                    </button>
                  </li>
                ))}
            </ul>
          )}
        </div>
      </details>
      <div className={`rounded-lg border p-3 text-sm ${!linkId ? "border-accent bg-accent-soft ring-1 ring-accent/30" : "border-line bg-panel hover:border-accent/40"}`} data-testid="placeholder-promote">
        <label className="flex cursor-pointer gap-2">
          <input type="radio" name="placeholderPick" checked={!linkId} onChange={() => setChoice("promote")} className="mt-1 h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="font-semibold text-ink">新しいお客様として登録する</span>
            <span className="block text-[11px] text-ink-3">仮のお客様を、読み取ったお名前・電話・住所で正式に登録します (直せます)</span>
          </span>
        </label>
        {!linkId && (
          <div className="mt-2 grid grid-cols-1 gap-2 pl-6 @xl:grid-cols-2">
            <label className="block">
              <span className="label">お名前</span>
              <input name="promoteName" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={60} required className="field" placeholder={placeholder.name} />
            </label>
            <label className="block">
              <span className="label">ふりがな</span>
              <input name="promoteKana" value={form.kana} onChange={(e) => setForm({ ...form, kana: e.target.value })} maxLength={60} className="field" />
            </label>
            <label className="block">
              <span className="label">電話番号</span>
              <input name="promotePhone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} maxLength={30} inputMode="tel" className="field" />
            </label>
            <label className="block">
              <span className="label">住所</span>
              <input name="promoteAddress" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} maxLength={200} className="field" placeholder={placeholder.area ? `${placeholder.area}…` : "熊本県…"} />
            </label>
          </div>
        )}
      </div>
    </section>
  );
}
