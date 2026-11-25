"use client";

import { useEffect, useRef, useState } from "react";
import Link from "@/components/ui/Link";
import clsx from "clsx";
import { CalendarPlus, CalendarSearch, MapPin, Search, X } from "lucide-react";
import { buttonClass } from "@/components/ui";
import type { CandidateDay, CandidateResult, CandidateTier, FindResult } from "@/lib/schedule-find";

/**
 * 予定表の検索と、場所からの候補日 (お客様のご要望 2026-11-25「予定表の検索機能と日程候補の自動提案」)
 * - 予定・案件を探す: お客様名・住所 (町名)・電話番号。押すとその予定の日の予定表へ移り、予定の小さな画面を開く
 * - 候補日を探す: 住所・町名を入れると、同じ町名・近隣に予定のある日、予定の少ない日、予定のない日を日付の近い順に出す。
 *   日を押すとその日の予定表、「この日に予定を登録」で予定の入力 (場所・案件つき)
 */

const TIER_STYLE: Record<CandidateTier, string> = {
  same: "bg-good-soft text-good-ink border-good/40",
  near: "bg-info-soft text-info-ink border-info/40",
  light: "bg-accent-soft text-accent-ink border-accent/30",
  free: "bg-subtle text-ink-2 border-line",
  busy: "bg-subtle text-ink-3 border-line",
};

const TIER_LABEL: Record<CandidateTier, string> = { same: "同じ町名に予定あり", near: "近くに予定あり", light: "予定が少ない日", free: "予定なし", busy: "予定が多い日" };

const dayLabel = (date: string) => {
  const d = new Date(`${date}T00:00:00Z`);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${"日月火水木金土"[d.getUTCDay()]})`;
};

/** 案件の ID → 予定の入力の画面の案件 (問い合わせ inq_ / 見積 q_ / 受注 o_) */
const caseParam = (id?: string): Record<string, string> => (!id ? {} : id.startsWith("o_") ? { orderId: id } : id.startsWith("q_") ? { quoteId: id } : id.startsWith("inq_") ? { inquiryId: id } : {});

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (res.redirected || res.status === 401 || !body) throw new Error("ログインが切れました。画面を読み込み直してください。");
  if (!res.ok || body.error) throw new Error(body.error ?? "読み込めませんでした。");
  return body;
}

export function ScheduleFinder({ stores, initialFind, findCase, defaultOpen }: { stores: { id: string; name: string }[]; initialFind?: string; findCase?: string; defaultOpen?: boolean }) {
  const [tab, setTab] = useState<"search" | "place">(initialFind ? "place" : "search");
  const [open, setOpen] = useState(Boolean(defaultOpen || initialFind));
  return (
    <div className="mb-3 rounded-xl border border-line bg-panel" data-testid="schedule-finder">
      <div className="flex flex-wrap items-center gap-1.5 px-3 py-2">
        <button type="button" onClick={() => { setTab("search"); setOpen(true); }} aria-pressed={open && tab === "search"} className={clsx("inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm", open && tab === "search" ? "bg-accent-soft font-medium text-accent-ink" : "text-ink-2 hover:bg-subtle")}>
          <Search className="h-4 w-4" aria-hidden />
          予定・案件を探す
        </button>
        <button type="button" onClick={() => { setTab("place"); setOpen(true); }} aria-pressed={open && tab === "place"} className={clsx("inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm", open && tab === "place" ? "bg-accent-soft font-medium text-accent-ink" : "text-ink-2 hover:bg-subtle")} data-testid="finder-place-tab">
          <CalendarSearch className="h-4 w-4" aria-hidden />
          場所から候補日を探す
        </button>
        {open && (
          <button type="button" onClick={() => setOpen(false)} className="ml-auto grid h-8 w-8 place-items-center rounded-lg text-ink-3 hover:bg-subtle" aria-label="閉じる">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      {open && <div className="border-t border-line px-3 py-3">{tab === "search" ? <SearchTab /> : <PlaceTab stores={stores} initial={initialFind ?? ""} findCase={findCase} />}</div>}
    </div>
  );
}

function SearchTab() {
  const [q, setQ] = useState("");
  const [res, setRes] = useState<FindResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const seq = useRef(0);
  useEffect(() => {
    const term = q.trim();
    const my = ++seq.current;
    if (term.length < 2) return;
    const t = setTimeout(() => {
      setBusy(true);
      getJson<FindResult>(`/api/schedule/find?q=${encodeURIComponent(term)}`)
        .then((r) => my === seq.current && (setRes(r), setError("")))
        .catch((e) => my === seq.current && setError((e as Error).message))
        .finally(() => my === seq.current && setBusy(false));
    }, 300);
    return () => clearTimeout(t);
  }, [q]);
  const shown = q.trim().length >= 2 ? res : null;
  return (
    <div className="space-y-2">
      <label className="relative block">
        <span className="sr-only">予定・案件を探す</span>
        <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-ink-3" aria-hidden />
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} autoFocus placeholder="お客様名・住所・町名・電話番号 (例: 山田 / 須屋 / 090-1234)" className="field pl-9" aria-busy={busy || undefined} data-testid="finder-search" />
      </label>
      {error && <p className="text-xs text-critical-ink">{error}</p>}
      {shown && (
        <>
          {shown.areaCount > 0 && <p className="text-xs text-ink-2">「{shown.query}」の地域の今後の予定 {shown.areaCount} 件 (日付の近い順)</p>}
          {shown.events.length === 0 && shown.cases.length === 0 && !busy && <p className="text-xs text-ink-3">当たる予定・案件はありません。</p>}
          {shown.events.length > 0 && (
            <ul className="max-h-96 divide-y divide-line overflow-y-auto rounded-lg border border-line" data-testid="finder-results">
              {shown.events.map((e) => (
                <li key={e.id}>
                  <Link href={e.href} className={clsx("flex flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-2 text-xs hover:bg-subtle", !e.upcoming && "opacity-70")}>
                    <span className="w-24 shrink-0 font-semibold text-ink tnum">{dayLabel(e.date)}</span>
                    <span className="rounded bg-subtle px-1.5 text-[11px] text-ink-2">{e.kind}</span>
                    <span className="min-w-0 flex-1 truncate font-medium text-ink">{e.label}</span>
                    <span className="text-ink-3">{e.storeName} · {e.assignees}</span>
                    <span className="w-full truncate text-[11px] text-ink-3">{e.period} · {e.place || "場所の登録なし"} · {e.reason}で一致{e.upcoming ? "" : " · 過去の予定"}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {shown.cases.length > 0 && (
            <div>
              <p className="mb-1 text-[11px] font-semibold text-ink-2">予定がまだない進行中の案件</p>
              <ul className="space-y-1">
                {shown.cases.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-line px-3 py-1.5 text-xs">
                    <Link href={c.href} className="font-medium text-accent hover:underline">{c.label}</Link>
                    <span className="text-ink">{c.customer} {c.title}</span>
                    <span className="text-ink-3">{c.place}</span>
                    {c.place && <Link href={c.findHref} className="ml-auto text-accent hover:underline">この場所で候補日を探す</Link>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function PlaceTab({ stores, initial, findCase }: { stores: { id: string; name: string }[]; initial: string; findCase?: string }) {
  const [address, setAddress] = useState(initial);
  const [store, setStore] = useState("");
  const [days, setDays] = useState("30");
  const [sort, setSort] = useState<"date" | "rank">("date");
  const [showBusy, setShowBusy] = useState(false);
  const [res, setRes] = useState<CandidateResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = (a = address) => {
    if (!a.trim()) return;
    setBusy(true);
    getJson<CandidateResult>(`/api/schedule/candidates?address=${encodeURIComponent(a.trim())}&store=${encodeURIComponent(store)}&days=${days}`)
      .then((r) => (setRes(r), setError("")))
      .catch((e) => setError((e as Error).message))
      .finally(() => setBusy(false));
  };
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !initial) return;
    started.current = true;
    const t = setTimeout(() => run(initial), 0);
    return () => clearTimeout(t);
    // 最初の 1 回だけ (予定表を開いたときの ?find=)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const rank: Record<CandidateTier, number> = { same: 0, near: 1, light: 2, free: 3, busy: 4 };
  const list = (res?.days ?? []).filter((d) => showBusy || d.tier !== "busy");
  const sorted = sort === "date" ? list : [...list].sort((a, b) => rank[a.tier] - rank[b.tier] || (a.tier === "near" ? (a.nearestKm ?? 99) - (b.nearestKm ?? 99) : 0) || a.date.localeCompare(b.date));
  const keep = (d: CandidateDay) => `${d.dayHref}&find=${encodeURIComponent(res?.address ?? "")}${findCase ? `&findCase=${encodeURIComponent(findCase)}` : ""}`;
  const newHref = (d: CandidateDay) => {
    const p = new URLSearchParams({ date: d.date, kind: "survey", ...(res?.storeId ? { store: res.storeId } : {}), ...caseParam(findCase), ...(findCase ? {} : { location: res?.address ?? "" }), returnTo: keep(d) });
    return `/schedule/new?${p.toString()}`;
  };
  return (
    <div className="space-y-2" data-testid="finder-place">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
        className="grid grid-cols-1 gap-2 @3xl:grid-cols-[minmax(0,1fr)_auto_auto_auto]"
      >
        <label className="relative block">
          <span className="sr-only">訪問先の住所・町名</span>
          <MapPin className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-ink-3" aria-hidden />
          <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="訪問先の住所・町名 (例: 合志市須屋 / 植木町)" className="field pl-9" data-testid="finder-address" />
        </label>
        <select value={store} onChange={(e) => setStore(e.target.value)} className="field w-auto" aria-label="比べる店舗">
          <option value="">店舗: 住所の担当エリア</option>
          <option value="all">全店舗</option>
          {stores.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select value={days} onChange={(e) => setDays(e.target.value)} className="field w-auto" aria-label="探す期間">
          <option value="14">2 週間</option>
          <option value="30">1 か月</option>
          <option value="60">2 か月</option>
        </select>
        <button type="submit" disabled={!address.trim() || busy} className={buttonClass("primary", "sm")} data-testid="finder-place-run">
          <CalendarSearch />
          候補日を探す
        </button>
      </form>
      {error && <p className="text-xs text-critical-ink">{error}</p>}
      {res && (
        <>
          <p className="text-xs text-ink-2">
            訪問先: <span className="font-medium text-ink">{res.address}</span>
            {res.located ? ` (位置の目安: ${res.located})` : " (位置が分からないため、町名が同じ予定だけで比べています)"} · 比べた予定: {res.storeName} · 近く = 道のりの目安 {res.nearKm} km 以内
          </p>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <div className="inline-flex rounded-lg border border-line bg-subtle/70 p-0.5">
              <button type="button" onClick={() => setSort("date")} aria-pressed={sort === "date"} className={clsx("rounded-md px-2.5 py-1", sort === "date" ? "bg-panel font-medium text-ink shadow-xs" : "text-ink-2")}>
                日付の近い順
              </button>
              <button type="button" onClick={() => setSort("rank")} aria-pressed={sort === "rank"} className={clsx("rounded-md px-2.5 py-1", sort === "rank" ? "bg-panel font-medium text-ink shadow-xs" : "text-ink-2")}>
                おすすめの順
              </button>
            </div>
            <label className="flex items-center gap-1.5 text-ink-2">
              <input type="checkbox" checked={showBusy} onChange={(e) => setShowBusy(e.target.checked)} className="h-3.5 w-3.5" />
              予定が多い日 (近くに予定なし) も出す
            </label>
            <span className="text-ink-3">{(["same", "near", "light", "free"] as const).map((t) => `${TIER_LABEL[t]} ${res.days.filter((d) => d.tier === t).length}`).join(" · ")}</span>
          </div>
          <ul className="max-h-[32rem] space-y-1.5 overflow-y-auto" data-testid="finder-days">
            {sorted.map((d) => (
              <li key={d.date} className={clsx("rounded-lg border px-3 py-2", TIER_STYLE[d.tier])} data-testid="finder-day">
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={keep(d)} className="text-sm font-semibold text-ink tnum hover:underline">
                    {dayLabel(d.date)}
                  </Link>
                  <span className="rounded border border-current/20 px-1.5 text-[11px] font-medium">{TIER_LABEL[d.tier]}</span>
                  <span className="text-[11px]">予定 {d.count} 件{d.nearestKm !== undefined && d.tier !== "same" ? ` · いちばん近い予定 約 ${d.nearestKm} km` : ""}</span>
                  <span className="ml-auto flex gap-1.5">
                    <Link href={keep(d)} className={buttonClass("secondary", "sm")}>
                      この日の予定表
                    </Link>
                    <Link href={newHref(d)} className={buttonClass("primary", "sm")} data-testid="finder-new">
                      <CalendarPlus />
                      この日に予定を登録
                    </Link>
                  </span>
                </div>
                {(d.same.length > 0 || d.near.length > 0) && (
                  <ul className="mt-1 flex flex-wrap gap-1">
                    {[...d.same, ...d.near].slice(0, 6).map((e) => (
                      <li key={e.id}>
                        <Link href={e.href} className="inline-flex items-center gap-1 rounded-full border border-line bg-panel px-2 py-0.5 text-[11px] text-ink hover:border-accent/50" title={`${e.kind} ${e.period}`}>
                          {e.town || "町名なし"} · {e.kind} {e.period.replace(/^\d+\/\d+\([^)]+\)\s*/, "")}
                          {e.km ? ` · ${e.km} km` : ""}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
