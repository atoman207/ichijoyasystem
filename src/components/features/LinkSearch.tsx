"use client";

import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { Badge, Button } from "@/components/ui";
import type { CustomerHit, InquiryHit } from "@/lib/link-search";

/**
 * 問い合わせ ⇄ 既存の顧客のひも付け (お客様のご要望 2026-11-24「■5」「■6」: 少ない操作で検索・選択してひも付ける)
 * 入力するたびに候補を出し、候補の「紐づける」を押すだけでひも付ける (検索 → 選択 → 送信の 3 段階にしない)
 */

/** 入力するたびに候補を読む (250 ミリ秒待ってから)。endpoint は ?q= を足す前の URL (ほかの条件は付けておく)。入力が空のときは initial */
function useSearch<T>(endpoint: string, initial: T[] = [], initialQuery = "") {
  const [q, setQuery] = useState(initialQuery);
  const [items, setItems] = useState<T[]>([]);
  const [busy, setBusy] = useState(Boolean(initialQuery.trim()));
  const [error, setError] = useState("");
  const seq = useRef(0);
  const setQ = (v: string) => {
    setQuery(v);
    setBusy(Boolean(v.trim()));
    setError("");
  };
  useEffect(() => {
    const term = q.trim();
    const my = ++seq.current;
    if (!term) return;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`${endpoint}${endpoint.includes("?") ? "&" : "?"}q=${encodeURIComponent(term)}`, { cache: "no-store" });
        const body = (await res.json().catch(() => null)) as { items?: T[]; error?: string } | null;
        if (my !== seq.current) return;
        if (!res.ok) throw new Error(body?.error === "unauthorized" ? "ログインし直してください。" : "検索できませんでした。");
        setItems(body?.items ?? []);
        setError("");
      } catch (err) {
        if (my === seq.current) setError((err as Error).message);
      } finally {
        if (my === seq.current) setBusy(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [q, endpoint]);
  return { q, setQ, items: q.trim() ? items : initial, busy, error };
}

function SearchBox({ value, onChange, placeholder, busy, label }: { value: string; onChange: (v: string) => void; placeholder: string; busy: boolean; label: string }) {
  return (
    <label className="relative block">
      <span className="sr-only">{label}</span>
      <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-ink-3" aria-hidden />
      <input type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} autoComplete="off" className="field pl-9" aria-busy={busy || undefined} />
    </label>
  );
}

/** 問い合わせの画面: 既存の顧客を探して紐づける (付け替える) */
export function CustomerLinkSearch({ action, inquiryId, returnTo, initialQuery = "", relink = false }: { action: (fd: FormData) => Promise<void>; inquiryId: string; returnTo: string; initialQuery?: string; relink?: boolean }) {
  const s = useSearch<CustomerHit>("/api/customers/search", [], initialQuery);
  return (
    <div className="space-y-2" data-testid="customer-link-search">
      <SearchBox value={s.q} onChange={s.setQ} busy={s.busy} label="既存の顧客を検索" placeholder="お名前・フリガナ・町名・住所・電話番号で検索 (例: 山田 / 須屋 / 0968)" />
      {s.error && <p className="text-xs text-critical-ink">{s.error}</p>}
      {s.q.trim() && !s.busy && s.items.length === 0 && !s.error && <p className="text-xs text-ink-3">「{s.q.trim()}」に当たるお客様はいません (ひも付けを変更できる店舗のお客様から探しています)。</p>}
      {s.items.length > 0 && (
        <form action={action}>
          <input type="hidden" name="inquiryId" value={inquiryId} />
          <input type="hidden" name="returnTo" value={returnTo} />
          <ul className="max-h-80 divide-y divide-line overflow-y-auto rounded-lg border border-line bg-panel">
            {s.items.map((c) => (
              <li key={c.id} className="flex items-start gap-2 px-3 py-2">
                <div className="min-w-0 flex-1 text-xs">
                  <div className="flex flex-wrap items-center gap-1.5 text-sm">
                    <span className="font-medium text-ink">{c.name}</span>
                    <span className="text-ink-3">{c.code}</span>
                    {c.corporate && <Badge tone="info" dot={false}>法人・業者</Badge>}
                    {c.placeholder && <Badge tone="warn" dot={false}>予定表から登録 (仮)</Badge>}
                    {c.open > 0 && <Badge tone="accent" dot={false}>進行中 {c.open}</Badge>}
                  </div>
                  <div className="mt-0.5 text-ink-2">{c.address || "住所未登録"}</div>
                  <div className="text-ink-3">
                    {c.phone || "電話未登録"} · {c.storeName}
                    {c.kana ? ` · ${c.kana}` : ""}
                  </div>
                </div>
                <Button type="submit" name="customerId" value={c.id} size="sm" variant="secondary" className="shrink-0">
                  {relink ? "付け替える" : "紐づける"}
                </Button>
              </li>
            ))}
          </ul>
        </form>
      )}
    </div>
  );
}

/** 顧客の画面: このお客様に問い合わせ (案件) を紐づける。候補 (電話・お名前・地区が合う問い合わせ) を最初から出す */
export function InquiryLinkSearch({ action, customerId, returnTo, initial }: { action: (fd: FormData) => Promise<void>; customerId: string; returnTo: string; initial: InquiryHit[] }) {
  const s = useSearch<InquiryHit>(`/api/inquiries/linkable?customer=${encodeURIComponent(customerId)}`, initial);
  return (
    <div className="space-y-2" data-testid="inquiry-link-search">
      <SearchBox value={s.q} onChange={s.setQ} busy={s.busy} label="紐づける問い合わせを検索" placeholder="問い合わせ番号・お名前・電話番号・内容・町名で検索" />
      {s.error && <p className="text-xs text-critical-ink">{s.error}</p>}
      {!s.q.trim() && s.items.length > 0 && <p className="text-xs text-ink-2">電話番号・お名前・地区が合う問い合わせ (お客様が未登録か、予定表の取込で仮に作った顧客のもの):</p>}
      {!s.q.trim() && s.items.length === 0 && <p className="text-xs text-ink-3">電話番号・お名前が合う未登録の問い合わせはありません。上の欄で番号・お名前などを入れて探せます。</p>}
      {s.q.trim() && !s.busy && s.items.length === 0 && !s.error && <p className="text-xs text-ink-3">「{s.q.trim()}」に当たる問い合わせはありません (お客様が未登録か、予定表の取込で仮に作った顧客の、見積の前の問い合わせから探しています)。</p>}
      {s.items.length > 0 && (
        <form action={action}>
          <input type="hidden" name="customerId" value={customerId} />
          <input type="hidden" name="returnTo" value={returnTo} />
          <ul className="max-h-96 divide-y divide-line overflow-y-auto rounded-lg border border-line bg-panel">
            {s.items.map((i) => (
              <li key={i.id} className="flex items-start gap-2 px-3 py-2">
                <div className="min-w-0 flex-1 text-xs">
                  <div className="flex flex-wrap items-center gap-1.5 text-sm">
                    <a href={`/inquiries/${i.id}`} className="font-medium text-ink hover:text-accent hover:underline">
                      {i.contactName} 様
                    </a>
                    <span className="text-ink-2">{i.summary}</span>
                    {i.reason && <Badge tone="good" dot={false}>{i.reason}</Badge>}
                  </div>
                  <div className="mt-0.5 text-ink-2">
                    {[i.phone, i.address].filter(Boolean).join(" · ") || "電話・住所の記録なし"}
                  </div>
                  <div className="text-ink-3">
                    {i.number} · {i.date} · {i.statusLabel} · {i.storeName}
                    {i.events ? ` · 予定 ${i.events} 件` : ""}
                    {i.currentCustomer ? ` · 今: ${i.currentCustomer}` : " · お客様未登録"}
                  </div>
                </div>
                <Button type="submit" name="inquiryId" value={i.id} size="sm" variant="secondary" className="shrink-0">
                  紐づける
                </Button>
              </li>
            ))}
          </ul>
        </form>
      )}
    </div>
  );
}
