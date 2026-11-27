"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { usePathname, useSearchParams } from "next/navigation";
import Link from "@/components/ui/Link";
import clsx from "clsx";
import { CalendarPlus, ClipboardList, ExternalLink, FileText, FileUp, Link2, MapPin, Megaphone, Navigation, Pencil, Phone, Store, Trash2, TriangleAlert, Truck, UserRound, Users, X } from "lucide-react";
import type { QuoteItem, ScheduleKind } from "@/lib/db/types";
import { quoteTotals } from "@/lib/quote-calc";
import { quickAmendLines, quickNewCase, relinkCase, sendCaseRequest, setCaseSite } from "@/lib/actions/case-quick";
import { CaseCustomerSearch } from "@/components/features/LinkSearch";
import { MediaSelect } from "@/components/ops-reports/MediaFields";
import { QUICK_MAX_ASSIGNEES, SCHEDULE_KIND } from "@/lib/constants";
import type { ConflictQuery, ConflictReport } from "@/lib/calendar";
import { addPairedDelivery, changeEventStore, checkScheduleConflicts, deleteScheduleEvent, quickUpdateScheduleEvent, updateEventWork } from "@/lib/actions/schedule";
import { Button, buttonClass } from "@/components/ui";
import { MapDocUploader } from "@/components/maps/MapDocUploader";
import { CopyAddress } from "@/components/maps/CopyAddress";
import { mapViewHref, reopenHref } from "@/lib/maps/links";
import { KINDS_BY_GROUP, KindMark, kindLabel } from "./parts";
import type { EventQuickData, QuickMap, QuickStaff } from "./quick-types";
import { CaseWorkSection } from "./CaseWork";
import { StaffFace } from "./StaffFace";

/**
 * 予定表で予定を押したときの小さな画面 (お客様のご要望 2026-11-24「■3」「■4」、追加「②」「⑥」「⑦」「⑧」)
 * - 上 (スクロールせずに操作する欄): 地図 (Google マップ・経路・登録済みの住宅地図・住宅地図の登録) / 担当者の確認・変更 (最大 4 名) /
 *   引取・現見 ⇄ 納品の相手の予定 (納品予定の追加)
 * - お客様は案件から引いた正しい情報 (問い合わせを既存の顧客にひも付けたあとは、その顧客の電話・住所)
 * - 日時・内容 (件名・メモ)・種類 (アイコン) をその場で変えて保存する。場所・案件の変更は「詳しく変更」(今までの変更の画面)
 * EventQuickHost は予定表のビューを包み、予定のリンク (data-ev) を押したときだけ開く (Ctrl・Shift で押したときは今までどおり別の画面)
 */

type Open = { id: string; search: string; returnTo: string };

/**
 * 検索の文字から qe (開く予定の印) と結果の知らせ (msg・err) を外す。
 * msg・err はトースト (src/components/ui/Toaster.tsx) が読んだあとに URL から外すため、比べる文字に入れると小さな画面が閉じてしまう
 */
function withoutQe(search: string): string {
  const sp = new URLSearchParams(search);
  for (const k of ["qe", "msg", "err"]) sp.delete(k);
  return sp.toString();
}

/**
 * fromUrl: URL の ?qe=<予定の ID> で小さな画面を開く部品 (画面に 1 つだけ。予定表の本体)。
 * 重複の一覧など、ほかの場所を包む部品は false (押したときだけ開く。2 つ開かないように)
 */
export function EventQuickHost({ children, fromUrl = true }: { children: ReactNode; fromUrl?: boolean }) {
  const params = useSearchParams();
  const pathname = usePathname();
  const qe = fromUrl ? params.get("qe") : null;
  // 予定表の表示 (日付・店舗・表示) の印。qe は比べない: 開いたあとの表示が変わったら (別の日・店舗へ移ったら) 小さな画面を閉じる
  // (以前は qe を含めて比べ、URL から qe を外したあとに出していた。読み込んだ直後の URL の書き換えが Next.js の
  //  useSearchParams に届かず、住宅地図の「元の画面に戻る」・予定表の検索の結果から開いても小さな画面が出なかった。2026-11-25 に修正)
  const search = withoutQe(params.toString());
  // 住宅地図の画面から戻ったとき・予定表の検索の結果 (?qe=<予定の ID>): その予定の小さな画面を開いた状態にする
  const [open, setOpen] = useState<Open | null>(() => {
    if (!qe || qe.startsWith("hold:")) return null;
    const back = new URLSearchParams(search);
    for (const k of ["msg", "err", "_r"]) back.delete(k);
    back.set("_r", Math.random().toString(36).slice(2, 8));
    // 保存のあとに開き直したときの結果の知らせ (msg・err) は、トーストが小さな画面の上に出す
    return { id: qe, search, returnTo: `${pathname}?${back.toString()}` };
  });
  // 印 (qe) は URL から外す (読み込み直しで開き直さない)。Next.js が履歴の書き換えを受け取る仕組みは画面の一番上の部品の
  // useEffect で用意されるため (子の useEffect が先に動く)、そのあとで書き換える。状態は null (Next.js の内部の状態 __NA を渡すと内部の書き換えとみなされる)
  useEffect(() => {
    if (!qe) return;
    const t = window.setTimeout(() => {
      const q = withoutQe(window.location.search.replace(/^\?/, ""));
      window.history.replaceState(null, "", `${window.location.pathname}${q ? `?${q}` : ""}${window.location.hash}`);
    }, 0);
    return () => window.clearTimeout(t);
  }, [qe]);
  const onClickCapture = (ev: React.MouseEvent<HTMLDivElement>) => {
    if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    const a = (ev.target as HTMLElement).closest("a[data-ev]");
    const id = a?.getAttribute("data-ev");
    if (!id || id.startsWith("hold:")) return;
    ev.preventDefault();
    ev.stopPropagation();
    // 保存したら同じ予定表 (日付・店舗・表示はそのまま) に戻る。_r は保存のたびに変わる印 (戻ったら小さな画面を閉じる)
    const sp = new URLSearchParams(window.location.search);
    for (const k of ["msg", "err", "_r", "qe"]) sp.delete(k);
    sp.set("_r", Math.random().toString(36).slice(2, 8));
    setOpen({ id, search, returnTo: `${window.location.pathname}?${sp.toString()}` });
  };
  return (
    <div onClickCapture={onClickCapture}>
      {children}
      {open && open.search === search && (
        <EventQuickDialog key={`${open.returnTo}|${open.id}`} id={open.id} returnTo={open.returnTo} onClose={() => setOpen(null)} onOpenEvent={(id) => setOpen((o) => (o ? { ...o, id } : o))} />
      )}
    </div>
  );
}

export type TimeMode = "allday" | "am" | "pm" | "time";

function EventQuickDialog({ id, returnTo, onClose, onOpenEvent }: { id: string; returnTo: string; onClose: () => void; onOpenEvent: (id: string) => void }) {
  const [data, setData] = useState<EventQuickData | null>(null);
  const [error, setError] = useState("");
  const [rev, setRev] = useState(0);
  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/schedule/events/${encodeURIComponent(id)}`, { cache: "no-store" })
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as (EventQuickData & { error?: string }) | null;
        if (!alive) return;
        if (res.redirected || res.status === 401) setError("ログインが切れました。画面を読み込み直してください。");
        else if (!res.ok || !body || body.error) setError(body?.error ?? "予定を読み込めませんでした。");
        else setData(body);
      })
      .catch(() => alive && setError("予定を読み込めませんでした (通信を確かめてください)。"));
    return () => {
      alive = false;
    };
  }, [id, rev]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 画面 (body) に直接出す: 本文の枠 (@container・表示のアニメーションの transform) の中だと fixed が本文の枠を基準にしてしまい、
  // 長い予定表では小さな画面が画面の外 (本文の真ん中・下端) に出て操作できなかった (2026-11-24 お客様のご連絡)
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6">
      <button type="button" tabIndex={-1} aria-label="閉じる" className="absolute inset-0 bg-ink/40 backdrop-blur-[1px]" onClick={onClose} />
      <section
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={data ? `予定: ${data.label}` : "予定"}
        data-testid="event-quick"
        className="@container relative flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-2xl border border-line bg-panel shadow-pop sm:max-w-xl sm:rounded-2xl"
      >
        <header className="flex items-start gap-2 border-b border-line px-4 py-2.5">
          <div className="min-w-0 flex-1">
            {data ? (
              <>
                <div className="flex flex-wrap items-center gap-1.5">
                  <KindMark kind={data.kind} size="md" />
                  <span className="text-xs text-ink-2">{data.storeName}</span>
                  <span className="text-xs font-medium text-ink tnum">{data.period}</span>
                </div>
                <h2 className="mt-0.5 truncate text-base leading-snug font-semibold text-ink">{data.label}</h2>
              </>
            ) : (
              <h2 className="text-sm text-ink-2">{error ? "予定" : "読み込み中…"}</h2>
            )}
          </div>
          <button type="button" onClick={onClose} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-ink-3 hover:bg-subtle hover:text-ink" aria-label="閉じる" title="閉じる (Esc)">
            <X className="h-4 w-4" aria-hidden />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {error && <p className="rounded-lg bg-critical-soft px-3 py-2 text-sm text-critical-ink">{error}</p>}
          {!data && !error && <div className="h-40 animate-pulse rounded-xl bg-subtle" />}
          {data && <QuickBody key={data.id} data={data} returnTo={returnTo} onOpenEvent={onOpenEvent} onReload={() => setRev((r) => r + 1)} />}
        </div>
      </section>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------ */
/* 上の欄: 地図・担当者・納品 (お客様のご要望 2026-11-24「⑧」: よく使う操作をスクロールせずに)        */
/* ------------------------------------------------------------------ */

function TopRow({ label, icon, children, testId }: { label: string; icon: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <div className="flex items-start gap-2 px-3 py-2" data-testid={testId}>
      <span className="mt-1 inline-flex w-14 shrink-0 items-center gap-1 text-[11px] font-semibold text-ink-2">
        {icon}
        {label}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function MapRow({ map, eventId, returnTo, onReload }: { map?: QuickMap; eventId: string; returnTo: string; onReload: () => void }) {
  const [upload, setUpload] = useState(false);
  const [done, setDone] = useState("");
  if (!map) return null;
  if (map.hidden) {
    return (
      <TopRow label="地図" icon={<MapPin className="h-3.5 w-3.5" aria-hidden />} testId="event-quick-map">
        <p className="pt-1 text-[11px] text-ink-3">地図は、この予定の店舗のメンバーと担当者が見られます。</p>
      </TopRow>
    );
  }
  return (
    <TopRow label="地図" icon={<MapPin className="h-3.5 w-3.5" aria-hidden />} testId="event-quick-map">
      <div className="flex flex-wrap items-center gap-1.5">
        {map.searchUrl ? (
          <a href={map.searchUrl} target="_blank" rel="noreferrer" className={buttonClass("secondary", "sm")}>
            <MapPin />
            Google マップ
          </a>
        ) : (
          <span className="pt-1 text-xs text-ink-3">住所の登録なし</span>
        )}
        {map.directionsUrl && (
          <a href={map.directionsUrl} target="_blank" rel="noreferrer" className={buttonClass("primary", "sm")}>
            <Navigation />
            経路
          </a>
        )}
        {map.docs.map((d, i) => (
          // システムの画面の中で地図を開き、「元の画面に戻る」でこの小さな画面に戻る (お客様のご要望 2026-11-24「①」)
          <Link key={d.id} href={mapViewHref(d.id, reopenHref(returnTo, eventId))} className={buttonClass("secondary", "sm")} title={d.title}>
            <FileText />
            住宅地図{map.docs.length > 1 ? ` ${i + 1}` : ""}
          </Link>
        ))}
        {map.docs.length === 0 && map.canEdit && (
          <button type="button" onClick={() => setUpload((u) => !u)} aria-expanded={upload} className={buttonClass(upload ? "soft" : "ghost", "sm")}>
            <FileUp />
            住宅地図を登録
          </button>
        )}
        {map.docs.length === 0 && !map.canEdit && map.address && <span className="text-[11px] text-ink-3">住宅地図 未登録</span>}
      </div>
      {map.address && (
        <p className="mt-1 truncate text-[11px] text-ink-3" title={map.address}>
          {map.heading}: {map.address}
        </p>
      )}
      {done && <p className="mt-1 text-[11px] text-good-ink">{done}</p>}
      {upload && (
        <div className="mt-2 space-y-2">
          <div className="flex flex-wrap gap-1.5">
            <a href={map.zenrinUrl} target="_blank" rel="noreferrer" className={buttonClass("secondary", "sm")}>
              <MapPin />
              ゼンリン GIS で探す
              <ExternalLink className="h-3 w-3" />
            </a>
            <CopyAddress text={map.searchText || map.address} />
          </div>
          <MapDocUploader
            targetType="event"
            targetId={eventId}
            onDone={(text) => {
              setDone(text);
              setUpload(false);
              onReload();
            }}
          />
        </div>
      )}
    </TopRow>
  );
}

/** 担当者の顔写真 (予定表のチップと同じ。輪の色 = 店舗の色) */
function StaffDot({ s, size = "sm" }: { s: Pick<QuickStaff, "id" | "name" | "avatar" | "color">; size?: "sm" | "md" }) {
  return <StaffFace name={s.name} id={s.id} src={s.avatar} color={s.color} size={size === "md" ? 22 : 18} />;
}

const GROUP_LABEL = (storeName: string) => ({ store: `${storeName} (この予定の店舗)`, common: "本部 (全店舗共通)", other: "ほかの店舗 (配送・施工の応援)" });

/** 担当者を選ぶ (予定の店舗の社員を先に、本部・ほかの店舗の社員も選べる。最大 QUICK_MAX_ASSIGNEES 名。「なし」= 担当者を決めない。お客様のご要望 2026-11-27「■2」) */
export function StaffPicker({ staff, selected, onChange, storeName, busy }: { staff: QuickStaff[]; selected: string[]; onChange: (ids: string[]) => void; storeName: string; busy?: ConflictReport["busy"] }) {
  const full = selected.length >= QUICK_MAX_ASSIGNEES;
  const labels = GROUP_LABEL(storeName);
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : full ? selected : [...selected, id]);
  return (
    <div className="mt-1.5 space-y-1.5 rounded-xl border border-line bg-panel p-2" data-testid="staff-picker">
      <button
        type="button"
        onClick={() => onChange([])}
        aria-pressed={selected.length === 0}
        className={clsx("inline-flex items-center rounded-full border border-dashed px-2.5 py-0.5 text-xs transition", selected.length === 0 ? "border-accent bg-accent-soft font-medium text-accent-ink" : "border-line bg-panel text-ink-2 hover:border-accent/50")}
      >
        なし (担当者を決めない)
      </button>
      {(["store", "common", "other"] as const).map((g) => {
        const list = staff.filter((s) => s.group === g);
        if (!list.length) return null;
        return (
          <div key={g}>
            <div className="mb-0.5 text-[10px] font-semibold text-ink-3">{labels[g]}</div>
            <div className="flex flex-wrap gap-1">
              {list.map((s) => {
                const on = selected.includes(s.id);
                const b = busy?.[s.id];
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => toggle(s.id)}
                    disabled={!on && full}
                    aria-pressed={on}
                    title={`${s.name} (${s.storeName})${b?.overlap ? " · 時間が重なる予定あり" : b?.leave ? " · 休暇" : b?.count ? ` · この日の予定 ${b.count} 件` : ""}`}
                    className={clsx(
                      "inline-flex items-center gap-1 rounded-full border py-0.5 pr-2 pl-0.5 text-xs transition disabled:opacity-40",
                      on ? "border-accent bg-accent-soft font-medium text-accent-ink" : "border-line bg-panel text-ink hover:border-accent/50",
                      b?.overlap && "ring-1 ring-critical/60",
                    )}
                  >
                    <StaffDot s={s} />
                    {s.name.split(/[\s　]/)[0]}
                    {b?.leave && <span className="text-[9px] text-warn-ink">休</span>}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
      <p className="text-[10px] text-ink-3">{full ? `最大 ${QUICK_MAX_ASSIGNEES} 名まで選べます (外してから選び直してください)` : `最大 ${QUICK_MAX_ASSIGNEES} 名。顔写真の輪の色は店舗の色です`}</p>
    </div>
  );
}

/** 重複の確認 (選んだ担当者・日時が変わるたびに。古い結果は使わない) */
export function useConflicts(query: ConflictQuery | null): ConflictReport | null {
  const key = query ? JSON.stringify(query) : "";
  const [state, setState] = useState<{ key: string; report: ConflictReport } | null>(null);
  useEffect(() => {
    if (!key) return;
    let alive = true;
    const t = setTimeout(() => {
      checkScheduleConflicts(JSON.parse(key) as ConflictQuery)
        .then((report) => alive && setState({ key, report }))
        .catch(() => {
          /* 保存のときにサーバーで確かめる */
        });
    }, 300);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [key]);
  return key && state?.key === key ? state.report : null;
}

export function ConflictNote({ report, label = "重複を承知で保存する" }: { report: ConflictReport | null; label?: string }) {
  const conflicts = report?.conflicts ?? [];
  if (!conflicts.length) return null;
  return (
    <div className="rounded-lg border border-critical/30 bg-critical-soft/60 px-3 py-2 text-xs text-critical-ink" role="alert">
      <p className="flex items-center gap-1 font-semibold">
        <TriangleAlert className="h-3.5 w-3.5" aria-hidden />
        担当者の予定が重なります
      </p>
      <ul className="mt-1 space-y-0.5">
        {conflicts.slice(0, 4).map((c) => (
          <li key={`${c.userId}-${c.eventId}`}>
            {c.userName} さん: {c.when}「{c.title}」{c.store ? ` (${c.store})` : ""}
          </li>
        ))}
      </ul>
      <label className="mt-1.5 flex items-center gap-1.5 font-medium">
        <input type="checkbox" name="allowOverlap" value="1" required className="h-4 w-4" />
        {label}
      </label>
    </div>
  );
}

function AssigneeRow({ data, returnTo }: { data: EventQuickData; returnTo: string }) {
  const [sel, setSel] = useState<string[]>(data.assigneeIds);
  const [open, setOpen] = useState(false);
  const byId = new Map(data.staff.map((s) => [s.id, s]));
  const changed = sel.join() !== data.assigneeIds.join();
  const report = useConflicts(
    data.canEdit && (open || changed) ? { eventId: data.id, date: data.date, endDate: data.endDate, startTime: data.startTime, endTime: data.endTime, slot: data.startTime ? undefined : data.slot, assigneeIds: sel, caseRef: data.caseRef, kind: data.kind, storeId: data.storeId } : null,
  );
  const nameOf = (id: string, i: number) => byId.get(id)?.name ?? data.assignees[data.assigneeIds.indexOf(id)] ?? data.assignees[i] ?? "-";
  return (
    <TopRow label="担当" icon={<Users className="h-3.5 w-3.5" aria-hidden />} testId="event-quick-assignees">
      <div className="flex flex-wrap items-center gap-1">
        {sel.map((id, i) => {
          const s = byId.get(id);
          return (
            <span key={id} className="inline-flex items-center gap-1 rounded-full border border-line bg-panel py-0.5 pr-1.5 pl-0.5 text-xs text-ink">
              {s ? <StaffDot s={s} size="md" /> : <UserRound className="h-4 w-4 text-ink-3" aria-hidden />}
              {nameOf(id, i)}
              {s && s.storeId !== data.storeId && <span className="text-[10px] text-ink-3">{s.storeName}</span>}
              {data.canEdit && (
                <button type="button" onClick={() => setSel(sel.filter((x) => x !== id))} className="rounded-full p-0.5 text-ink-3 hover:bg-subtle hover:text-ink" aria-label={`${nameOf(id, i)} を担当から外す`}>
                  <X className="h-3 w-3" />
                </button>
              )}
            </span>
          );
        })}
        {sel.length === 0 && <span className="text-xs text-warn-ink">担当者が未定です</span>}
        {data.canEdit && (
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className={buttonClass(open ? "soft" : "ghost", "sm")} data-testid="assignee-toggle">
            {open ? "閉じる" : sel.length ? "変更・追加" : "担当者を選ぶ"}
          </button>
        )}
      </div>
      {open && <StaffPicker staff={data.staff} selected={sel} onChange={setSel} storeName={data.storeName} busy={report?.busy} />}
      {changed && (
        <form action={quickUpdateScheduleEvent.bind(null, data.id)} className="mt-1.5 space-y-1.5" data-testid="assignee-form">
          <input type="hidden" name="returnTo" value={returnTo} />
          <input type="hidden" name="assigneesSent" value="1" />
          {sel.map((id) => (
            <input key={id} type="hidden" name="assigneeIds" value={id} />
          ))}
          <ConflictNote report={report} />
          {data.handover && <p className="text-[11px] text-ink-3">受注の引取・納品と連動する予定です。担当者はこの予定だけ変わります (日程の申請はいりません)。</p>}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm">
              担当者を保存
            </Button>
            <button type="button" onClick={() => setSel(data.assigneeIds)} className="text-xs text-ink-2 hover:underline">
              元に戻す
            </button>
            {sel.length === 0 && <span className="text-[11px] text-ink-3">担当者: なし (未定)</span>}
          </div>
        </form>
      )}
    </TopRow>
  );
}

const TIME_MODES: [TimeMode, string][] = [
  ["allday", "終日"],
  ["am", "午前"],
  ["pm", "午後"],
  ["time", "時刻"],
];

export function TimeModeButtons({ mode, setMode }: { mode: TimeMode; setMode: (m: TimeMode) => void }) {
  return (
    <div className="inline-flex flex-wrap gap-1 rounded-xl border border-line bg-subtle/70 p-1">
      {TIME_MODES.map(([m, l]) => (
        <button key={m} type="button" onClick={() => setMode(m)} aria-pressed={mode === m} className={clsx("rounded-lg px-3 py-1.5 text-sm", mode === m ? "bg-panel font-medium text-ink shadow-xs" : "text-ink-2 hover:text-ink")}>
          {l}
        </button>
      ))}
    </div>
  );
}

const plusDays = (d: string, n: number) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

function DeliveryForm({ data, returnTo, onCancel }: { data: EventQuickData; returnTo: string; onCancel: () => void }) {
  const pair = data.pair!;
  const [date, setDate] = useState("");
  const [mode, setMode] = useState<TimeMode>("allday");
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("");
  const [sel, setSel] = useState<string[]>(data.assigneeIds.slice(0, QUICK_MAX_ASSIGNEES));
  const report = useConflicts(date ? { date, startTime: mode === "time" ? start : undefined, endTime: mode === "time" ? end || undefined : undefined, slot: mode === "am" || mode === "pm" ? mode : undefined, assigneeIds: sel, caseRef: data.caseRef, kind: "delivery", storeId: data.storeId } : null);
  return (
    <form action={addPairedDelivery.bind(null, data.id)} className="mt-1.5 space-y-2 rounded-xl border border-accent/30 bg-accent-soft/30 p-2.5" data-testid="delivery-form">
      <input type="hidden" name="returnTo" value={returnTo} />
      <input type="hidden" name="timeMode" value={mode} />
      {sel.map((id) => (
        <input key={id} type="hidden" name="assigneeIds" value={id} />
      ))}
      <div className="text-xs font-semibold text-ink">納品予定を追加{pair.addMode === "order" && pair.undated.length ? ` (${pair.undated.join("・")})` : ""}</div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="label">納品日</span>
          <input type="date" name="date" value={date} min={data.date} onChange={(e) => setDate(e.target.value)} required className="field w-auto" />
        </label>
        <div className="flex flex-wrap gap-1 pb-1">
          {[
            [0, "同じ日"],
            [1, "翌日"],
            [7, "1 週間後"],
          ].map(([n, l]) => (
            <button key={String(n)} type="button" onClick={() => setDate(plusDays(data.date, Number(n)))} className="rounded-lg border border-line bg-panel px-2 py-1 text-xs text-ink-2 hover:border-accent/50">
              {l}
            </button>
          ))}
        </div>
      </div>
      <TimeModeButtons mode={mode} setMode={setMode} />
      {mode === "time" && (
        <div className="flex items-center gap-2">
          <input type="time" name="startTime" value={start} onChange={(e) => setStart(e.target.value)} required className="field w-auto" aria-label="納品の開始時刻" />
          <span className="text-ink-3">〜</span>
          <input type="time" name="endTime" value={end} min={start} onChange={(e) => setEnd(e.target.value)} className="field w-auto" aria-label="納品の終了時刻" />
        </div>
      )}
      <div>
        <span className="label">納品の担当者 ({sel.length} 人)</span>
        <StaffPicker staff={data.staff} selected={sel} onChange={setSel} storeName={data.storeName} busy={report?.busy} />
      </div>
      <label className="block">
        <span className="label">メモ (任意)</span>
        <input name="memo" maxLength={500} className="field" placeholder="例: 午前中にお届け・2 階和室" />
      </label>
      <ConflictNote report={report} label="重複を承知で登録する" />
      <p className="text-[11px] text-ink-3">{pair.addMode === "order" ? "受注の引取・納品の日程にこの品目の納品日を入れ、予定表に納品の予定を作ります。" : "同じ案件の納品の予定として予定表に登録します。"}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={!date}>
          <CalendarPlus />
          納品予定を登録
        </Button>
        <button type="button" onClick={onCancel} className="text-xs text-ink-2 hover:underline">
          やめる
        </button>
      </div>
    </form>
  );
}

function PairRow({ data, returnTo, onOpenEvent }: { data: EventQuickData; returnTo: string; onOpenEvent: (id: string) => void }) {
  const [adding, setAdding] = useState(false);
  const pair = data.pair;
  if (!pair) return null;
  const label = pair.want === "delivery" ? "納品" : "引取・現見";
  return (
    <TopRow label={label} icon={<Truck className="h-3.5 w-3.5" aria-hidden />} testId="event-quick-pair">
      {pair.events.length > 0 ? (
        <ul className="space-y-1">
          {pair.events.map((x) => (
            <li key={x.id}>
              <button type="button" onClick={() => onOpenEvent(x.id)} className="flex w-full min-w-0 items-center gap-1.5 rounded-lg border border-line bg-panel px-2 py-1 text-left text-xs hover:border-accent/50" title="この予定を開く">
                <KindMark kind={x.kind} />
                <span className="shrink-0 font-semibold text-ink tnum">{x.period}</span>
                <span className="min-w-0 truncate text-ink-2">{x.assignees.join("・")}</span>
                <span className="ml-auto shrink-0 text-[11px] text-accent">開く</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="pt-1 text-xs text-warn-ink">{pair.want === "delivery" ? "納品予定 未登録" : "この案件の引取・現見の予定は見つかりません"}</p>
      )}
      {pair.undated.length > 0 && <p className="mt-1 text-[11px] text-warn-ink">納品日 未定: {pair.undated.join("・")}</p>}
      {pair.canAdd && !adding && (
        <button type="button" onClick={() => setAdding(true)} className={clsx(buttonClass("soft", "sm"), "mt-1")} data-testid="delivery-add">
          <CalendarPlus />
          納品予定を追加
        </button>
      )}
      {adding && <DeliveryForm data={data} returnTo={returnTo} onCancel={() => setAdding(false)} />}
    </TopRow>
  );
}

/* ------------------------------------------------------------------ */

function CustomerBlock({ data }: { data: EventQuickData }) {
  const c = data.customer;
  if (!c && !data.contactName && !data.case) return null;
  return (
    <div className="mb-3 space-y-1 rounded-xl bg-subtle/70 px-3 py-2.5 text-sm" data-testid="event-quick-customer">
      {c ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <UserRound className="h-4 w-4 text-ink-3" aria-hidden />
          {c.href ? (
            <Link href={c.href} className="font-semibold text-accent hover:underline">
              {c.name} 様
            </Link>
          ) : (
            <span className="font-semibold text-ink">{c.name} 様</span>
          )}
          {c.corporate && <span className="rounded bg-info-soft px-1.5 text-[10px] text-info-ink">法人・業者</span>}
          {c.placeholder && <span className="rounded bg-warn-soft px-1.5 text-[10px] text-warn-ink">予定表から登録 (仮)</span>}
          {data.contactName && <span className="text-xs text-ink-3">受付時のお名前: {data.contactName}</span>}
        </div>
      ) : data.contactName ? (
        <div className="flex flex-wrap items-center gap-x-2">
          <UserRound className="h-4 w-4 text-ink-3" aria-hidden />
          <span className="font-semibold text-ink">{data.contactName} 様</span>
          <span className="text-xs text-warn-ink">顧客未登録</span>
        </div>
      ) : null}
      {/* 住所 (左) と電話 (右。押すとそのまま電話をかける)。お客様のご要望 2026-11-25「⑩」 */}
      {(() => {
        const phones = c?.phones.length ? c.phones : data.contactPhone ? [data.contactPhone] : [];
        if (!c?.address && !phones.length) return null;
        return (
          <div className="flex items-start gap-2" data-testid="event-quick-contact">
            <div className="flex min-w-0 flex-1 items-start gap-1.5 pt-1 text-xs text-ink">
              <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-3" aria-hidden />
              <span className="min-w-0 break-words">{c?.address || <span className="text-ink-3">住所の登録なし</span>}</span>
            </div>
            {phones.length > 0 && (
              <div className="flex shrink-0 flex-col items-end gap-1">
                {phones.map((p) => (
                  <a key={p} href={`tel:${p.replace(/[^0-9+]/g, "")}`} className="inline-flex items-center gap-1.5 rounded-lg border border-accent/40 bg-panel px-2.5 py-1.5 text-sm font-semibold text-accent tnum hover:bg-accent-soft" title="押すと電話をかけます">
                    <Phone className="h-3.5 w-3.5" aria-hidden />
                    {p}
                  </a>
                ))}
              </div>
            )}
          </div>
        );
      })()}
      {data.location && data.location !== c?.address && (
        <div className="flex items-start gap-2 text-xs text-ink-2">
          <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" aria-hidden />
          <span>
            現場: {data.location}
            {data.area && data.area !== data.location ? ` (${data.area})` : ""}
          </span>
        </div>
      )}
      {c?.corporate && !data.area && <p className="text-xs text-warn-ink">業者の案件です。現場の住所が未登録のため町名を出せません (下の「施工現場」に現場の住所を入れてください)。</p>}
      {data.case && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Link2 className="h-3.5 w-3.5 text-ink-3" aria-hidden />
          {data.case.canOpen ? (
            <Link href={data.case.href} className="text-accent hover:underline">
              {data.case.label} {data.case.title}
            </Link>
          ) : (
            <span className="text-ink-2">
              {data.case.label} {data.case.title}
            </span>
          )}
        </div>
      )}
      {data.inquiryHref && (
        <Link href={data.inquiryHref} className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline">
          既存の顧客に紐づける
        </Link>
      )}
    </div>
  );
}

function QuickBody({ data, returnTo, onOpenEvent, onReload }: { data: EventQuickData; returnTo: string; onOpenEvent: (id: string) => void; onReload: () => void }) {
  const initialMode: TimeMode = data.startTime ? "time" : (data.slot ?? "allday");
  const [kind, setKind] = useState<ScheduleKind>(data.kind);
  const [date, setDate] = useState(data.date);
  const [endDate, setEndDate] = useState(data.endDate ?? "");
  const [mode, setMode] = useState<TimeMode>(initialMode);
  const [start, setStart] = useState(data.startTime ?? "09:00");
  const [end, setEnd] = useState(data.endTime ?? "");
  const showEnd = !data.handover || Boolean(data.endDate);

  // 担当者の予定の重複 (日時を変えるたびに確かめる)
  const report = useConflicts(
    data.canEdit && date ? { eventId: data.id, date, endDate: endDate || undefined, startTime: mode === "time" ? start : undefined, endTime: mode === "time" ? end || undefined : undefined, slot: mode === "am" || mode === "pm" ? mode : undefined, assigneeIds: data.assigneeIds, caseRef: data.caseRef, kind, storeId: data.storeId } : null,
  );

  const moved = date !== data.date || (endDate || "") !== (data.endDate ?? "") || mode !== initialMode || (mode === "time" && (start !== (data.startTime ?? "") || end !== (data.endTime ?? "")));
  const kinds = data.lockKind ? [data.kind] : [...KINDS_BY_GROUP.case, ...KINDS_BY_GROUP.internal];

  return (
    <div>
      {/* よく使う操作 (地図・担当者・納品) は上に (お客様のご要望 2026-11-24「⑧」) */}
      <div className="mb-3 divide-y divide-line overflow-hidden rounded-xl border border-line bg-subtle/40" data-testid="event-quick-top">
        <MapRow map={data.map} eventId={data.id} returnTo={returnTo} onReload={onReload} />
        <AssigneeRow data={data} returnTo={returnTo} />
        <RequestRow data={data} returnTo={returnTo} />
        <WorkRow data={data} returnTo={returnTo} />
        <StoreRow data={data} returnTo={returnTo} />
        <PairRow data={data} returnTo={returnTo} onOpenEvent={onOpenEvent} />
      </div>

      <CustomerBlock data={data} />
      {data.caseWork && <CaseWorkSection work={data.caseWork} eventId={data.id} returnTo={returnTo} onReload={onReload} />}
      <CaseEditSection data={data} returnTo={returnTo} />

      {!data.canEdit ? (
        <p className="rounded-lg bg-subtle px-3 py-2 text-xs text-ink-2">この予定は変更できません (登録者・担当者・店舗のメンバーが変更できます{data.synced ? "。完了した受注の予定は変えられません" : ""})。</p>
      ) : (
        <form action={quickUpdateScheduleEvent.bind(null, data.id)} className="space-y-3" data-testid="event-quick-form">
          <input type="hidden" name="returnTo" value={returnTo} />
          <input type="hidden" name="kind" value={kind} />
          <input type="hidden" name="timeMode" value={mode} />

          <fieldset>
            <legend className="label">種類 (アイコン)</legend>
            {data.lockKind ? (
              <p className="text-xs text-ink-3">
                <KindMark kind={data.kind} /> 受注の日程と連動する予定のため、種類は変えられません。
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="種類">
                {kinds.map((k) => (
                  <button
                    key={k}
                    type="button"
                    role="radio"
                    aria-checked={kind === k}
                    title={kindLabel(k)}
                    onClick={() => setKind(k)}
                    className={clsx("rounded-lg border px-1 py-1 transition", kind === k ? "border-accent bg-accent-soft ring-2 ring-accent/40" : "border-line bg-panel hover:border-accent/50")}
                  >
                    <KindMark kind={k} size="md" />
                  </button>
                ))}
              </div>
            )}
            {kind !== data.kind && <p className="mt-1 text-xs text-accent-ink">「{SCHEDULE_KIND[data.kind].label}」→「{SCHEDULE_KIND[kind].label}」に変えます</p>}
          </fieldset>

          <div className="grid grid-cols-1 gap-2 @xl:grid-cols-2">
            <label className="block">
              <span className="label">日付</span>
              <input type="date" name="date" value={date} onChange={(e) => setDate(e.target.value)} required className="field" />
            </label>
            {showEnd && (
              <label className="block">
                <span className="label">終了日 (複数日のとき)</span>
                <input type="date" name="endDate" value={endDate} min={date} onChange={(e) => setEndDate(e.target.value)} className="field" />
              </label>
            )}
          </div>

          <fieldset>
            <legend className="label">時間</legend>
            <TimeModeButtons mode={mode} setMode={setMode} />
            {mode === "time" && (
              <div className="mt-2 flex items-center gap-2">
                <input type="time" name="startTime" value={start} onChange={(e) => setStart(e.target.value)} required className="field w-auto" aria-label="開始時刻" />
                <span className="text-ink-3">〜</span>
                <input type="time" name="endTime" value={end} min={start} onChange={(e) => setEnd(e.target.value)} className="field w-auto" aria-label="終了時刻" />
              </div>
            )}
          </fieldset>

          <label className="block">
            <span className="label">件名</span>
            <input name="title" defaultValue={data.title} maxLength={120} className="field" />
          </label>
          <label className="block">
            <span className="label">内容・メモ</span>
            <textarea name="memo" defaultValue={data.memo} rows={3} maxLength={2000} className="field" />
          </label>

          {data.handover && moved && (
            <p className="rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn-ink">
              {data.scheduleApproval
                ? "受注の引取・納品の日程と連動する予定です。日時の変更は受注の日程の変更の申請になり、承認のあとに予定表に反映されます。"
                : "受注の引取・納品の日程と連動する予定です。保存すると受注の日程も同じ日時に変わります (承認はいりません。担当店舗に変更をお知らせします)。"}
            </p>
          )}

          {moved && <PairMoveFields data={data} date={date} />}

          <ConflictNote report={report} />
          {(report?.impacts?.length ?? 0) > 0 && moved && (
            <ul className="rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn-ink">
              {report!.impacts!.slice(0, 4).map((x) => (
                <li key={x}>・{x}</li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
            <Button type="submit" size="sm">
              保存する
            </Button>
            <Link href={`/schedule/${data.id}/edit`} className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-ink-2 hover:bg-subtle hover:text-ink">
              <Pencil className="h-3.5 w-3.5" aria-hidden />
              詳しく変更 (場所・案件など)
            </Link>
            <Link href={`/schedule/${data.id}`} className="ml-auto inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-ink-2 hover:bg-subtle hover:text-ink">
              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              予定の詳細
            </Link>
          </div>
        </form>
      )}
      {!data.canEdit && (
        <div className="mt-3 flex justify-end">
          <Link href={`/schedule/${data.id}`} className="inline-flex items-center gap-1 text-xs text-accent hover:underline">
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            予定の詳細
          </Link>
        </div>
      )}
      {/* 予定の削除はいちばん下 (押し間違えないように、確認してから。お客様のご要望 2026-11-24) */}
      <DeleteSection data={data} returnTo={returnTo} />
    </div>
  );
}

/** 引き取り・納品などの数量の例 / 見積・現場管理・施工などの作業内容の例 (お客様のご要望 2026-11-26) */
const WORK_EXAMPLE: Partial<Record<string, string>> = {
  pickup: "例: タ6 タ新4 フ2 フ新2",
  delivery: "例: タ6 タ新4 フ2 フ新2",
  onsite_quote: "例: タ6 フ2",
  survey: "例: タ3間、フ1部屋",
  site_survey: "例: タ3間、フ1部屋",
  measure: "例: タ新4、2階和室",
  site: "例: 養生、廃材撤去",
  install: "例: クロス工事、畳下床板2間",
  visit: "例: 仕様の打合せ、見本の持参",
};

/**
 * 作業内容 (予定表のチップ)。手で決めると自動より優先 (ScheduleEvent.work)。
 * 数量 (「タ6 タ新4 フ2」= 作業量にも数える) か、自由な文 (「養生、廃材撤去」= そのまま表示。src/lib/work-summary.ts の isCountsOnlyText)
 */
function WorkRow({ data, returnTo }: { data: EventQuickData; returnTo: string }) {
  const [open, setOpen] = useState(false);
  if (!data.work && !data.canEdit) return null;
  return (
    <TopRow label="作業内容" icon={<ClipboardList className="h-3.5 w-3.5" aria-hidden />} testId="event-quick-work">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-ink">{data.work ?? <span className="text-ink-3">未設定</span>}</span>
        {data.workManual && <span className="rounded bg-accent-soft px-1 text-[10px] text-accent-ink">手入力</span>}
        {data.canEdit && (
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className={buttonClass(open ? "soft" : "ghost", "sm")} data-testid="work-toggle">
            {open ? "閉じる" : "編集"}
          </button>
        )}
      </div>
      {open && (
        <form action={updateEventWork.bind(null, data.id)} className="mt-1.5 space-y-1.5" data-testid="work-form">
          <input type="hidden" name="returnTo" value={returnTo} />
          <input name="work" defaultValue={data.workManual ?? data.workText ?? ""} maxLength={200} placeholder={WORK_EXAMPLE[data.kind] ?? "例: タ6 タ新4 フ2 / 養生、廃材撤去"} className="field" aria-label="作業内容" />
          <p className="text-[11px] leading-relaxed text-ink-3">
            数量は タ = 畳・フ = 襖・シ = 障子・ア = 網戸 のあとに数、新調は「新」を付けます (例: タ6 タ新4 フ2 フ新2。へり無し畳は「縁無6」)。数量だけなら作業量にも数えます。
            「養生、廃材撤去」「クロス工事、畳下床板2間」のような自由な文も、そのまま予定表に表示します。予定表の表示だけを変えます (見積・受注の明細は変わりません)。
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm">
              作業内容を保存
            </Button>
            {data.workManual && (
              <button type="submit" name="work" value="" className="text-xs text-ink-2 hover:underline">
                自動 (見積の明細など) に戻す
              </button>
            )}
          </div>
        </form>
      )}
    </TopRow>
  );
}

/** 施工店舗 (案件の店舗 = 売上の店舗)。変えるときは今の施工店舗の店長の承認 (店長・管理者は承認なし) */
function StoreRow({ data, returnTo }: { data: EventQuickData; returnTo: string }) {
  const sc = data.storeChange;
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState("");
  if (!sc) return null;
  return (
    <TopRow label="施工店舗" icon={<Store className="h-3.5 w-3.5" aria-hidden />} testId="event-quick-store">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs font-medium text-ink">{sc.currentName}</span>
        <span className="text-[11px] text-ink-3">売上の店舗 ({sc.caseLabel})</span>
        {sc.canChange && (
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className={buttonClass(open ? "soft" : "ghost", "sm")} data-testid="store-toggle">
            {open ? "閉じる" : "変更"}
          </button>
        )}
      </div>
      {sc.pending && <p className="mt-1 text-[11px] text-warn-ink">{sc.pending}。承認されると変わります。</p>}
      {sc.blocked && data.canEdit && <p className="mt-1 text-[11px] text-ink-3">{sc.blocked}</p>}
      {open && sc.canChange && (
        <form action={changeEventStore.bind(null, data.id)} className="mt-1.5 space-y-1.5" data-testid="store-form">
          <input type="hidden" name="returnTo" value={returnTo} />
          <label className="block">
            <span className="label">新しい施工店舗</span>
            <select name="storeId" value={to} onChange={(e) => setTo(e.target.value)} required className="field">
              <option value="">選んでください</option>
              {sc.options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label">理由 (任意)</span>
            <input name="reason" maxLength={200} placeholder="例: 西店の担当エリアのため" className="field" />
          </label>
          <p className="text-[11px] leading-relaxed text-ink-3">
            案件 (問い合わせ・見積・受注) とこの案件の予定の店舗が変わり、売上は新しい施工店舗に計上されます。お客様の店舗は変わりません。
            {sc.needsApproval ? ` ${sc.approver}の承認のあとに変わります (それまでは今の店舗のままです)。` : " 承認なしですぐに変わります。"}
          </p>
          <Button type="submit" size="sm" disabled={!to}>
            {sc.needsApproval ? `変更を申請する (${sc.approver}の承認)` : "施工店舗を変更する"}
          </Button>
        </form>
      )}
    </TopRow>
  );
}

/**
 * 予定の削除: いちばん下のボタン → 「本当に削除しますか？」の確認 → 削除 (予定だけ。案件の情報は残す)。
 * 引取 ⇄ 納品 の関連する予定があれば「関連する納品予定も削除しますか？」で、両方か、この予定だけかを選ぶ (お客様のご要望 2026-11-25「①」)
 */
function DeleteSection({ data, returnTo }: { data: EventQuickData; returnTo: string }) {
  const [confirm, setConfirm] = useState(false);
  const rm = data.remove;
  const pair = rm?.pair;
  const [picked, setPicked] = useState<string[]>(() => pair?.events.map((x) => x.id) ?? []);
  if (!rm) return null;
  if (rm.mode === "order") {
    return (
      <p className="mt-4 border-t border-line pt-3 text-[11px] text-ink-3">
        受注の施工予定と連動する予定のため、ここでは削除できません。{rm.orderHref && <Link href={`${rm.orderHref}#schedule`} className="text-accent hover:underline">受注の画面</Link>}の「施工予定・担当」で変更してください。
      </p>
    );
  }
  if (!rm.canDelete) return null;
  const self = SCHEDULE_KIND[data.kind].label;
  const pairWord = pair?.want === "delivery" ? "納品予定" : "引取・現見の予定";
  return (
    <div className="mt-4 border-t border-line pt-3" data-testid="event-quick-delete">
      {!confirm ? (
        <button type="button" onClick={() => setConfirm(true)} className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-critical-ink hover:bg-critical-soft" data-testid="delete-open">
          <Trash2 className="h-3.5 w-3.5 text-critical" aria-hidden />
          この予定を削除
        </button>
      ) : (
        <div role="alertdialog" aria-labelledby={`del-${data.id}`} className="space-y-2 rounded-xl border border-critical/40 bg-critical-soft/60 p-3" data-testid="delete-confirm">
          <p id={`del-${data.id}`} className="text-sm font-semibold text-critical-ink">
            本当に削除しますか？
          </p>
          <p className="text-xs leading-relaxed text-ink-2">
            「{data.label}」{data.period} の予定を予定表から削除します。お客様・問い合わせ・見積・受注などの案件の情報は残ります。
            {rm.mode === "handover" &&
              (rm.needsApproval
                ? ` 受注の引取・納品の日程と連動しているため、受注の日程からこの日時を外す申請になります (${rm.approver ?? "店長"}の承認のあとに消えます)。`
                : " 受注の引取・納品の日程と連動しているため、受注の日程からもこの日時を外します (品目は残ります)。")}
          </p>
          <form action={deleteScheduleEvent.bind(null, data.id)} className="space-y-2">
            <input type="hidden" name="returnTo" value={returnTo} />
            <input type="hidden" name="scope" value="one" />
            {pair && (
              <div className="rounded-lg border border-critical/30 bg-panel px-3 py-2" data-testid="delete-pair">
                <p className="text-sm font-semibold text-ink">関連する{pairWord}も削除しますか？</p>
                {pair.events.length === 1 ? (
                  <>
                    <p className="mt-0.5 text-xs text-ink-2">{pair.events[0].label}</p>
                    <input type="hidden" name="pairIds" value={pair.events[0].id} />
                  </>
                ) : (
                  <ul className="mt-1 space-y-1">
                    {pair.events.map((x) => (
                      <li key={x.id}>
                        <label className="flex items-center gap-2 text-xs text-ink">
                          <input type="checkbox" name="pairIds" value={x.id} checked={picked.includes(x.id)} onChange={() => setPicked((p) => (p.includes(x.id) ? p.filter((y) => y !== x.id) : [...p, x.id]))} className="h-4 w-4" />
                          {x.label}
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {pair ? (
                <>
                  <Button type="submit" name="withPair" value="1" variant="danger" size="sm" disabled={pair.events.length > 1 && picked.length === 0} data-testid="delete-both">
                    {rm.mode === "handover" && rm.needsApproval ? "両方の削除を申請する" : `両方削除する (${self}と${pairWord})`}
                  </Button>
                  <Button type="submit" variant="secondary" size="sm" data-testid="delete-submit">
                    {self}の予定のみ削除する
                  </Button>
                </>
              ) : (
                <Button type="submit" variant="danger" size="sm" data-testid="delete-submit">
                  {rm.mode === "handover" && rm.needsApproval ? "削除を申請する" : "削除する"}
                </Button>
              )}
              <button type="button" onClick={() => setConfirm(false)} className={buttonClass("secondary", "sm")} autoFocus>
                やめる
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

const shiftDays = (d: string, from: string, to: string) => {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return plusDays(d, Math.round(ms / 86400000));
};

/**
 * 引取・現見の日時を変えたときの「関連する納品予定も変更しますか？」(納品から引取を変えるときも同じ。お客様のご要望 2026-11-25「②」)。
 * 変更するなら、この画面で納品 (引取) の日付・時間・担当者も変え、保存で両方の予定に反映する (同じ受注の日程は 1 回の保存)
 */
function PairMoveFields({ data, date }: { data: EventQuickData; date: string }) {
  const cand = (data.pair?.events ?? []).filter((x) => x.canEdit);
  const [on, setOn] = useState(false);
  const [pid, setPid] = useState(cand[0]?.id ?? "");
  const pe = cand.find((x) => x.id === pid) ?? cand[0];
  const [pdate, setPdate] = useState("");
  const [mode, setMode] = useState<TimeMode>("allday");
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("");
  const [sel, setSel] = useState<string[]>([]);
  const report = useConflicts(on && pe && pdate ? { eventId: pe.id, date: pdate, startTime: mode === "time" ? start : undefined, endTime: mode === "time" ? end || undefined : undefined, slot: mode === "am" || mode === "pm" ? mode : undefined, assigneeIds: sel, caseRef: data.caseRef, kind: pe.kind, storeId: data.storeId } : null);
  if (!pe || !data.pair) return null;
  const word = data.pair.want === "delivery" ? "納品予定" : "引取・現見の予定";
  const choose = (x: typeof pe) => {
    setPid(x.id);
    // 初期値: 今の日時を、この予定を動かした日数だけずらす (納品は引取の日より前にしない)
    let d = shiftDays(x.date, data.date, date);
    if (data.pair!.want === "delivery" && d < date) d = date;
    if (data.pair!.want === "origin" && d > date) d = date;
    setPdate(d);
    setMode(x.startTime ? "time" : (x.slot ?? "allday"));
    setStart(x.startTime ?? "09:00");
    setEnd(x.endTime ?? "");
    setSel(x.assigneeIds.slice(0, QUICK_MAX_ASSIGNEES));
  };
  return (
    <div className="space-y-2 rounded-xl border border-accent/40 bg-accent-soft/30 p-3" data-testid="pair-move">
      <p className="text-sm font-semibold text-ink">関連する{word}も変更しますか？</p>
      <ul className="space-y-0.5 text-xs text-ink-2">
        {cand.map((x) => (
          <li key={x.id}>
            {cand.length > 1 ? (
              <label className="flex items-center gap-1.5">
                <input type="radio" checked={pid === x.id} onChange={() => (on ? choose(x) : setPid(x.id))} className="h-3.5 w-3.5" />
                {SCHEDULE_KIND[x.kind].label} {x.period} ({x.assignees.join("・") || "担当未定"})
              </label>
            ) : (
              <>いまの{SCHEDULE_KIND[x.kind].label}: {x.period} ({x.assignees.join("・") || "担当未定"})</>
            )}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-1.5">
        <button type="button" onClick={() => setOn(false)} aria-pressed={!on} className={clsx("rounded-lg border px-3 py-1.5 text-xs", !on ? "border-accent bg-panel font-medium text-ink" : "border-line bg-panel text-ink-2")} data-testid="pair-move-no">
          この予定だけ変更する
        </button>
        <button type="button" onClick={() => { setOn(true); choose(pe); }} aria-pressed={on} className={clsx("rounded-lg border px-3 py-1.5 text-xs", on ? "border-accent bg-accent-soft font-medium text-accent-ink" : "border-line bg-panel text-ink-2")} data-testid="pair-move-yes">
          {word}も変更する
        </button>
      </div>
      {on && (
        <div className="space-y-2" data-testid="pair-move-fields">
          <input type="hidden" name="pairId" value={pe.id} />
          <input type="hidden" name="pairTimeMode" value={mode} />
          <input type="hidden" name="pairAssigneesSent" value="1" />
          {sel.map((id) => (
            <input key={id} type="hidden" name="pairAssigneeIds" value={id} />
          ))}
          <label className="block">
            <span className="label">{SCHEDULE_KIND[pe.kind].label}の日付</span>
            <input type="date" name="pairDate" value={pdate} min={data.pair.want === "delivery" ? date : undefined} max={data.pair.want === "origin" ? date : undefined} onChange={(e) => setPdate(e.target.value)} required className="field w-auto" />
          </label>
          <TimeModeButtons mode={mode} setMode={setMode} />
          {mode === "time" && (
            <div className="flex items-center gap-2">
              <input type="time" name="pairStartTime" value={start} onChange={(e) => setStart(e.target.value)} required className="field w-auto" aria-label="関連する予定の開始時刻" />
              <span className="text-ink-3">〜</span>
              <input type="time" name="pairEndTime" value={end} min={start} onChange={(e) => setEnd(e.target.value)} className="field w-auto" aria-label="関連する予定の終了時刻" />
            </div>
          )}
          <div>
            <span className="label">{SCHEDULE_KIND[pe.kind].label}の担当者 ({sel.length} 人)</span>
            <StaffPicker staff={data.staff} selected={sel} onChange={setSel} storeName={data.storeName} busy={report?.busy} />
          </div>
          <ConflictNote report={report} label="重複を承知で保存する" />
          <p className="text-[11px] text-ink-3">「保存する」で、この予定と{SCHEDULE_KIND[pe.kind].label}の予定の両方に反映します。</p>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 案件の確認・変更・追加 (お客様のご要望 2026-11-25「予定表を起点に、案件の確認・変更・追加をその画面で」③④⑤⑨⑩) */
/* ------------------------------------------------------------------ */

const yen = (n: number) => `¥${Math.round(n).toLocaleString("ja-JP")}`;

function Disclosure({ title, icon, children, testId, defaultOpen = false, badge }: { title: string; icon: ReactNode; children: ReactNode; testId?: string; defaultOpen?: boolean; badge?: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-t border-line first:border-t-0" data-testid={testId}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-semibold text-ink hover:bg-subtle/60">
        {icon}
        <span className="min-w-0 flex-1">{title}</span>
        {badge}
        <span className="text-[11px] font-normal text-accent">{open ? "閉じる" : "開く"}</span>
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
    </div>
  );
}

function CaseEditSection({ data, returnTo }: { data: EventQuickData; returnTo: string }) {
  const ce = data.caseEdit;
  if (!ce) return null;
  return (
    <div className="mb-3 overflow-hidden rounded-xl border border-line bg-panel" data-testid="event-quick-case">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-subtle/60 px-3 py-1.5">
        <span className="text-xs font-semibold text-ink">案件の確認・変更</span>
        {ce.caseNumber && <span className="text-[11px] text-ink-3">{ce.caseNumber}</span>}
        {ce.lock && <span className="text-[11px] text-warn-ink">{ce.lock}</span>}
      </div>
      {ce.site && <SiteRow data={data} returnTo={returnTo} />}
      {ce.quote && <LinesBlock data={data} returnTo={returnTo} />}
      {!ce.quote && ce.orderTotal !== undefined && (
        <div className="border-t border-line px-3 py-2 text-xs text-ink-2">
          受注金額 {yen(ce.orderTotal)} (見積のない受注)。{ce.orderHref && <Link href={ce.orderHref} className="text-accent hover:underline">受注の画面</Link>}の「契約内容の変更」で直せます。
        </div>
      )}
      {ce.workStaff && (
        <Disclosure title="作業の担当 (実績・インセンティブの起点)" icon={<Users className="h-3.5 w-3.5 text-ink-3" aria-hidden />} testId="case-work-staff" badge={<span className={clsx("rounded px-1 text-[10px]", ce.workStaff.source === "saved" ? "bg-good-soft text-good-ink" : "bg-subtle text-ink-3")}>{ce.workStaff.source === "saved" ? "確定済み" : "予定表から自動"}</span>}>
          <dl className="grid grid-cols-[4.5rem_1fr] gap-x-2 gap-y-0.5 text-xs">
            {ce.workStaff.rows.map((r) => (
              <div key={r.role} className="contents">
                <dt className="text-ink-3">{r.role}</dt>
                <dd className="text-ink">{r.names}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-1 text-[11px] text-ink-3">予定の担当者を直すと自動で変わります。施工完了のときに確かめて確定します (複数名も可)。</p>
          <Link href={ce.workStaff.href} className="mt-1 inline-flex text-xs text-accent hover:underline">
            作業の担当を確認・変更する
          </Link>
        </Disclosure>
      )}
      {ce.relink && (ce.relink.canRelink || ce.relink.blocked) && (
        <Disclosure title="お客様の付け替え (紐付け間違いの修正)" icon={<Link2 className="h-3.5 w-3.5 text-ink-3" aria-hidden />} testId="case-relink">
          {ce.relink.blocked ? (
            <p className="text-xs text-ink-3">{ce.relink.blocked}</p>
          ) : (
            <>
              <p className="mb-2 text-[11px] leading-relaxed text-ink-2">
                いまのお客様: {ce.relink.current ?? "(未登録)"}。正しいお客様を検索して「付け替える」を押すと、問い合わせ・見積・受注・予定などの内容はそのままで、紐付け先だけが変わります。
              </p>
              <CaseCustomerSearch action={relinkCase.bind(null, ce.caseId!)} returnTo={returnTo} />
            </>
          )}
        </Disclosure>
      )}
      {ce.newCase && <NewCaseBlock data={data} returnTo={returnTo} />}
    </div>
  );
}

/** 施工現場の住所 (依頼主の住所と別)。予定表の町名・地図はこの住所 (お客様のご要望 2026-11-25「⑨」) */
function SiteRow({ data, returnTo }: { data: EventQuickData; returnTo: string }) {
  const ce = data.caseEdit!;
  const site = ce.site!;
  const [open, setOpen] = useState(false);
  const missing = site.corporate && !site.address;
  return (
    <div className="px-3 py-2" data-testid="case-site">
      <div className="flex flex-wrap items-start gap-x-2 gap-y-1 text-xs">
        <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" aria-hidden />
        <div className="min-w-0 flex-1">
          <div>
            <span className="font-semibold text-ink">施工現場: </span>
            {site.address ? <span className="text-ink">{site.address}</span> : missing ? <span className="text-warn-ink">未登録 (業者の所在地とは別の現場の住所を入れてください)</span> : <span className="text-ink-2">依頼主の住所と同じ</span>}
          </div>
          {site.requester && (site.address || site.corporate) && <div className="text-[11px] text-ink-3">依頼主{site.corporate ? " (業者)" : ""}の住所: {site.requester}</div>}
        </div>
        {site.canEdit && (
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className={buttonClass(open ? "soft" : missing ? "primary" : "ghost", "sm")} data-testid="site-toggle">
            {open ? "閉じる" : site.address ? "変更" : "現場の住所を入れる"}
          </button>
        )}
      </div>
      {open && (
        <form action={setCaseSite.bind(null, ce.caseId!)} className="mt-2 space-y-1.5" data-testid="site-form">
          <input type="hidden" name="returnTo" value={returnTo} />
          <input name="siteAddress" defaultValue={site.address} maxLength={200} placeholder="例: 熊本県合志市須屋 123-4 (現場)" className="field" aria-label="施工現場の住所" />
          <p className="text-[11px] leading-relaxed text-ink-3">予定表の町名と地図 (Google マップ・住宅地図) はこの住所になります。依頼主 (お客様) の住所は顧客の情報のままです。空にすると依頼主の住所と同じになります。</p>
          <Button type="submit" size="sm">
            施工現場の住所を保存
          </Button>
        </form>
      )}
    </div>
  );
}

type EditLine = QuoteItem & { removed?: boolean; added?: boolean };

/** 送る明細 (画面だけの印を外す。追加した行の仮の ID はサーバーで付け直す) */
const plainLine = (l: EditLine): QuoteItem => ({ id: l.id, productId: l.productId, name: l.name, spec: l.spec, qty: l.qty, unit: l.unit, unitPrice: l.unitPrice, amount: l.amount, itemCategory: l.itemCategory, dokoMaterialId: l.dokoMaterialId });

/** 明細 (仕様・枚数・単価) の修正・追加・部分キャンセル (お客様のご要望 2026-11-25「③」) */
function LinesBlock({ data, returnTo }: { data: EventQuickData; returnTo: string }) {
  const q = data.caseEdit!.quote!;
  const [editing, setEditing] = useState(false);
  const [lines, setLines] = useState<EditLine[]>(() => q.items.map((i) => ({ ...i })));
  const [draftNew, setDraftNew] = useState({ name: "", spec: "", qty: "1", unit: "", unitPrice: "" });
  const live = lines.filter((l) => !l.removed).map((l) => ({ ...l, amount: Math.round(l.qty * l.unitPrice) }));
  const totals = quoteTotals(live, q.discount, q.taxMode);
  const diff = totals.total - q.total;
  const small = q.smallLimit > 0 && Math.abs(diff) <= q.smallLimit;
  const touched = editing && JSON.stringify(live.map((l) => [l.name, l.spec ?? "", l.qty, l.unit, l.unitPrice])) !== JSON.stringify(q.items.map((l) => [l.name, l.spec ?? "", l.qty, l.unit, l.unitPrice]));
  const needsReason = !q.draft && !small;
  const rule = q.draft
    ? "下書きの見積です。保存すると内容が変わります (確定はしません)。"
    : q.confirmedSales && !q.ownApproval
      ? "施工完了・売上確定の案件のため、変更は管理者の承認のあとに反映されます (版の履歴に残ります)。"
      : q.ownApproval
        ? `承認を省略して第${q.version + 1}版として反映します (変更前の版は履歴に残ります)。`
        : small
          ? `差額 ${yen(Math.abs(diff))} (${yen(q.smallLimit)} 以下) のため承認なしで第${q.version + 1}版として反映します。`
          : `差額が ${yen(q.smallLimit)} を超えるため、店長 (金額により管理者) の承認のあとに反映されます。`;
  const set = (k: number, patch: Partial<EditLine>) => setLines((ls) => ls.map((l, i) => (i === k ? { ...l, ...patch } : l)));
  const addLine = () => {
    const qty = Number(draftNew.qty);
    const unitPrice = Number(draftNew.unitPrice);
    if (!draftNew.name.trim() || !(qty > 0) || !Number.isFinite(unitPrice)) return;
    setLines((ls) => [...ls, { id: `new_${ls.length}`, name: draftNew.name.trim(), spec: draftNew.spec.trim() || undefined, qty, unit: draftNew.unit.trim(), unitPrice, amount: Math.round(qty * unitPrice), added: true }]);
    setDraftNew({ name: "", spec: "", qty: "1", unit: "", unitPrice: "" });
  };
  return (
    <div className="border-t border-line px-3 py-2" data-testid="case-lines">
      <div className="flex flex-wrap items-center gap-2">
        <FileText className="h-3.5 w-3.5 text-ink-3" aria-hidden />
        <span className="text-xs font-semibold text-ink">明細・金額</span>
        <Link href={q.href} className="text-[11px] text-ink-3 hover:underline">
          見積 {q.number} 第{q.version}版{q.draft ? " (下書き)" : ""}
        </Link>
        <span className="ml-auto text-xs font-semibold text-ink tnum">合計 {yen(q.total)}</span>
      </div>
      {!editing ? (
        <>
          <ul className="mt-1 space-y-0.5 text-xs text-ink-2">
            {q.items.slice(0, 8).map((i) => (
              <li key={i.id} className="flex gap-2">
                <span className="min-w-0 flex-1 truncate">
                  {i.name}
                  {i.spec ? ` (${i.spec})` : ""}
                </span>
                <span className="shrink-0 tnum">
                  {i.qty}
                  {i.unit} × {yen(i.unitPrice)}
                </span>
              </li>
            ))}
            {q.items.length > 8 && <li className="text-ink-3">ほか {q.items.length - 8} 行</li>}
          </ul>
          {q.editable ? (
            <button type="button" onClick={() => setEditing(true)} className={clsx(buttonClass("soft", "sm"), "mt-1.5")} data-testid="lines-edit">
              <Pencil />
              仕様・枚数・単価を変更 / 追加 / 部分キャンセル
            </button>
          ) : (
            q.blocked && <p className="mt-1 text-[11px] text-ink-3">{q.blocked}</p>
          )}
        </>
      ) : (
        <form action={quickAmendLines.bind(null, q.id)} className="mt-2 space-y-2" data-testid="lines-form">
          <input type="hidden" name="returnTo" value={returnTo} />
          <input type="hidden" name="items" value={JSON.stringify(live.map(plainLine))} />
          <ul className="space-y-1.5">
            {lines.map((l, k) => (
              <li key={l.id} className={clsx("rounded-lg border px-2 py-1.5", l.removed ? "border-critical/30 bg-critical-soft/40" : l.added ? "border-good/40 bg-good-soft/40" : "border-line bg-panel")}>
                <div className="flex items-center gap-2">
                  <span className={clsx("min-w-0 flex-1 truncate text-xs font-medium", l.removed ? "text-ink-3 line-through" : "text-ink")}>
                    {l.name}
                    {l.added && <span className="ml-1 rounded bg-good-soft px-1 text-[10px] text-good-ink">追加</span>}
                  </span>
                  <button type="button" onClick={() => set(k, { removed: !l.removed })} className={clsx("shrink-0 rounded px-1.5 py-0.5 text-[11px]", l.removed ? "text-accent hover:underline" : "text-critical-ink hover:bg-critical-soft")}>
                    {l.removed ? "元に戻す" : "取り消す (部分キャンセル)"}
                  </button>
                </div>
                {!l.removed && (
                  <div className="mt-1 grid grid-cols-1 gap-1.5 @xl:grid-cols-[minmax(0,1fr)_5rem_3.5rem_6.5rem]">
                    <input value={l.spec ?? ""} onChange={(e) => set(k, { spec: e.target.value || undefined })} placeholder="仕様 (例: さくら・縁 浮14)" className="field" aria-label={`${l.name} の仕様`} />
                    <input type="number" inputMode="decimal" min="0" step="any" value={l.qty} onChange={(e) => set(k, { qty: Number(e.target.value) })} className="field" aria-label={`${l.name} の数量`} />
                    <input value={l.unit} onChange={(e) => set(k, { unit: e.target.value })} maxLength={10} className="field" aria-label={`${l.name} の単位`} />
                    <input type="number" inputMode="numeric" step="any" value={l.unitPrice} onChange={(e) => set(k, { unitPrice: Number(e.target.value) })} className="field" aria-label={`${l.name} の単価`} />
                  </div>
                )}
              </li>
            ))}
          </ul>
          <div className="rounded-lg border border-dashed border-line-strong p-2">
            <div className="mb-1 text-[11px] font-semibold text-ink-2">明細を追加</div>
            <div className="grid grid-cols-1 gap-1.5 @xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_4.5rem_3.5rem_6rem]">
              <input value={draftNew.name} onChange={(e) => setDraftNew({ ...draftNew, name: e.target.value })} placeholder="品名 (例: 網戸 張替え)" className="field" aria-label="追加する品名" />
              <input value={draftNew.spec} onChange={(e) => setDraftNew({ ...draftNew, spec: e.target.value })} placeholder="仕様" className="field" aria-label="追加する仕様" />
              <input type="number" inputMode="decimal" min="0" step="any" value={draftNew.qty} onChange={(e) => setDraftNew({ ...draftNew, qty: e.target.value })} className="field" aria-label="追加する数量" />
              <input value={draftNew.unit} onChange={(e) => setDraftNew({ ...draftNew, unit: e.target.value })} placeholder="枚" maxLength={10} className="field" aria-label="追加する単位" />
              <input type="number" inputMode="numeric" step="any" value={draftNew.unitPrice} onChange={(e) => setDraftNew({ ...draftNew, unitPrice: e.target.value })} placeholder="単価" className="field" aria-label="追加する単価" />
            </div>
            <button type="button" onClick={addLine} disabled={!draftNew.name.trim() || !(Number(draftNew.qty) > 0) || draftNew.unitPrice === ""} className={clsx(buttonClass("secondary", "sm"), "mt-1.5")}>
              <CalendarPlus />
              この行を追加
            </button>
          </div>
          <div className="rounded-lg bg-subtle px-3 py-2 text-xs">
            <div className="flex flex-wrap justify-between gap-2 tnum">
              <span>変更前 {yen(q.total)}</span>
              <span className="font-semibold text-ink">変更後 {yen(totals.total)}</span>
              <span className={clsx(diff > 0 ? "text-accent-ink" : diff < 0 ? "text-critical-ink" : "text-ink-3")}>差額 {diff >= 0 ? "+" : "−"}{yen(Math.abs(diff))}</span>
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-ink-2">{rule} 担当店舗・本部・管理者に変更をお知らせします。</p>
          </div>
          {!q.draft && (
            <label className="block">
              <span className="label">変更の理由{needsReason ? " (必須)" : " (任意)"}</span>
              <input name="reason" required={needsReason} maxLength={300} placeholder="例: お客様より網戸2枚の追加依頼 / 6畳のうち2畳をキャンセル" className="field" />
            </label>
          )}
          {live.length === 0 && <p className="text-[11px] text-critical-ink">明細をすべて取り消すことはできません (案件をやめるときは見積・受注の画面で失注・キャンセルにしてください)。</p>}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" disabled={!touched || live.length === 0 || totals.total <= 0} data-testid="lines-submit">
              {q.draft ? "明細を保存" : q.ownApproval || (small && !q.confirmedSales) ? "変更を反映する" : "変更を申請する"}
            </Button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setLines(q.items.map((i) => ({ ...i })));
              }}
              className="text-xs text-ink-2 hover:underline"
            >
              やめる
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/** 同じお客様 (取引先) の新しい案件を追加 (お客様のご要望 2026-11-25「⑩」) */
function NewCaseBlock({ data, returnTo }: { data: EventQuickData; returnTo: string }) {
  const nc = data.caseEdit!.newCase!;
  const [date, setDate] = useState("");
  const [mode, setMode] = useState<TimeMode>("allday");
  const [start, setStart] = useState("09:00");
  const [sel, setSel] = useState<string[]>(data.assigneeIds.slice(0, QUICK_MAX_ASSIGNEES));
  const report = useConflicts(date && sel.length ? { date, startTime: mode === "time" ? start : undefined, slot: mode === "am" || mode === "pm" ? mode : undefined, assigneeIds: sel, kind: "survey", storeId: nc.storeId } : null);
  return (
    <Disclosure title={`${nc.customerName} 様の新しい案件を追加${nc.corporate ? " (別の現場)" : ""}`} icon={<CalendarPlus className="h-3.5 w-3.5 text-ink-3" aria-hidden />} testId="case-new">
      <form action={quickNewCase} className="space-y-2" data-testid="new-case-form">
        <input type="hidden" name="returnTo" value={returnTo} />
        <input type="hidden" name="customerId" value={nc.customerId} />
        <input type="hidden" name="timeMode" value={mode} />
        {date && sel.map((id) => <input key={id} type="hidden" name="assigneeIds" value={id} />)}
        <label className="block">
          <span className="label">内容 (要件) *</span>
          <input name="summary" required maxLength={200} placeholder={nc.corporate ? "例: ○○様邸 和室6畳 表替え" : "例: 2階の襖4枚 張替え"} className="field" />
        </label>
        <label className="block">
          <span className="label">施工現場の住所{nc.corporate ? " (業者の所在地と別の現場)" : " (依頼主の住所と違うとき)"}</span>
          <input name="siteAddress" maxLength={200} placeholder="例: 熊本県合志市須屋 123-4" className="field" />
        </label>
        <div className="grid grid-cols-1 gap-2 @xl:grid-cols-2">
          <label className="block">
            <span className="label">種別</span>
            <select name="category" defaultValue="tatami" className="field">
              {nc.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label">媒体 (当社を知ったきっかけ) *</span>
            <MediaSelect name="media" defaultValue={nc.media} required />
          </label>
        </div>
        <label className="block">
          <span className="label">詳細 (任意)</span>
          <textarea name="detail" rows={2} maxLength={4000} className="field" />
        </label>
        <fieldset className="space-y-1.5 rounded-lg border border-line p-2">
          <legend className="px-1 text-[11px] font-semibold text-ink-2">最初の予定 (日付を入れたときだけ登録)</legend>
          <div className="grid grid-cols-1 gap-2 @xl:grid-cols-2">
            <label className="block">
              <span className="label">種類</span>
              <select name="kind" defaultValue="survey" className="field">
                {nc.kinds.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="label">日付</span>
              <input type="date" name="date" value={date} onChange={(e) => setDate(e.target.value)} className="field" />
            </label>
          </div>
          {date && (
            <>
              <TimeModeButtons mode={mode} setMode={setMode} />
              {mode === "time" && (
                <div className="flex items-center gap-2">
                  <input type="time" name="startTime" value={start} onChange={(e) => setStart(e.target.value)} required className="field w-auto" aria-label="開始時刻" />
                  <span className="text-ink-3">〜</span>
                  <input type="time" name="endTime" className="field w-auto" aria-label="終了時刻" />
                </div>
              )}
              <StaffPicker staff={data.staff} selected={sel} onChange={setSel} storeName={data.storeName} busy={report?.busy} />
              <ConflictNote report={report} label="重複を承知で登録する" />
            </>
          )}
        </fieldset>
        <p className="text-[11px] leading-relaxed text-ink-3">問い合わせとして登録し、担当店舗・本部・管理者に知らせます。見積・受注はこの案件の画面から作れます。</p>
        <Button type="submit" size="sm" data-testid="new-case-submit">
          <CalendarPlus />
          新しい案件を登録
        </Button>
      </form>
    </Disclosure>
  );
}

/**
 * 担当店舗・担当者への依頼 (メンション) (お客様のご要望 2026-11-25「⑪」)。種類 (日程変更依頼・仕様変更依頼・クレーム・手直し・その他) を選び、内容を追記して送る。
 * 受けた人はベルから案件の画面を直接開け、送った内容・日時・送信者・送信先は案件の「この案件への依頼」に残る (src/lib/case-requests.ts)
 */
function RequestRow({ data, returnTo }: { data: EventQuickData; returnTo: string }) {
  const rq = data.request;
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<string>("");
  const [target, setTarget] = useState<"store" | "users">("store");
  const [sel, setSel] = useState<string[]>([]);
  if (!rq) return null;
  const hint = rq.kinds.find((k) => k.id === kind)?.hint;
  return (
    <TopRow label="依頼" icon={<Megaphone className="h-3.5 w-3.5" aria-hidden />} testId="event-quick-request">
      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className={buttonClass(open ? "soft" : "secondary", "sm")} data-testid="request-toggle">
          {open ? "閉じる" : "担当店舗・担当者に依頼を送る"}
        </button>
        {rq.open.length > 0 && <span className="text-[11px] text-warn-ink">対応中の依頼 {rq.open.length} 件</span>}
      </div>
      {rq.open.length > 0 && !open && (
        <ul className="mt-1 space-y-0.5 text-[11px] text-ink-2">
          {rq.open.map((x) => (
            <li key={x.id} className="truncate">
              <Link href={`/messages/${x.id}`} className="text-accent hover:underline">
                {x.title}
              </Link>{" "}
              · {x.status} · {x.from} → {x.to}
            </li>
          ))}
        </ul>
      )}
      {open && (
        <form action={sendCaseRequest} className="mt-2 space-y-2 rounded-xl border border-accent/30 bg-accent-soft/20 p-2.5" data-testid="request-form">
          <input type="hidden" name="returnTo" value={returnTo} />
          <input type="hidden" name="eventId" value={data.id} />
          <input type="hidden" name="kind" value={kind} />
          <input type="hidden" name="target" value={target} />
          {target === "users" && sel.map((id) => <input key={id} type="hidden" name="assigneeIds" value={id} />)}
          <p className="text-[11px] text-ink-3">案件: {rq.caseLabel}</p>
          <fieldset>
            <legend className="label">依頼の種類</legend>
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="依頼の種類">
              {rq.kinds.map((k) => (
                <button key={k.id} type="button" role="radio" aria-checked={kind === k.id} onClick={() => setKind(k.id)} className={clsx("rounded-lg border px-3 py-1.5 text-xs", kind === k.id ? "border-accent bg-accent-soft font-medium text-accent-ink" : "border-line bg-panel text-ink-2 hover:border-accent/50")}>
                  {k.label}
                </button>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend className="label">宛先</legend>
            <div className="flex flex-wrap gap-1.5">
              <button type="button" onClick={() => setTarget("store")} aria-pressed={target === "store"} className={clsx("rounded-lg border px-3 py-1.5 text-xs", target === "store" ? "border-accent bg-panel font-medium text-ink" : "border-line bg-panel text-ink-2")}>
                店舗に送る
              </button>
              <button type="button" onClick={() => setTarget("users")} aria-pressed={target === "users"} className={clsx("rounded-lg border px-3 py-1.5 text-xs", target === "users" ? "border-accent bg-panel font-medium text-ink" : "border-line bg-panel text-ink-2")}>
                担当者を選ぶ
              </button>
            </div>
            {target === "store" ? (
              <label className="mt-1.5 block">
                <span className="sr-only">宛先の店舗</span>
                <select name="storeId" defaultValue={rq.storeId} className="field">
                  {rq.stores.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} (店長・スタッフ全員){s.id === rq.storeId ? " ← 担当店舗" : ""}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <StaffPicker staff={data.staff} selected={sel} onChange={setSel} storeName={data.storeName} />
            )}
          </fieldset>
          <label className="block">
            <span className="label">内容{kind === "other" ? " (必須)" : " (追記があれば)"}</span>
            <textarea name="note" rows={3} maxLength={2000} required={kind === "other"} placeholder={hint ?? "依頼の種類を選ぶと例が出ます"} className="field" />
          </label>
          <div className="flex flex-wrap items-end gap-3">
            <label className="block">
              <span className="label">期限</span>
              <select name="due" defaultValue="none" className="field w-auto">
                <option value="none">期限なし</option>
                <option value="noon">本日12時まで</option>
                <option value="today">本日中</option>
                <option value="tomorrow">明日中</option>
              </select>
            </label>
            <label className="flex items-center gap-1.5 pb-2 text-xs text-ink">
              <input type="checkbox" name="urgent" value="1" className="h-4 w-4" />
              至急
            </label>
          </div>
          <p className="text-[11px] leading-relaxed text-ink-3">受けた人のお知らせ (ベル) に届き、押すと依頼の画面 (お客様の電話・住所・内容・この案件の予定) が開きます。受けた人はその画面で日程を登録すると、依頼は報告・対応完了になります。送った内容・日時・送信者・送信先は案件の「この案件への依頼」に残ります。</p>
          <Button type="submit" size="sm" disabled={!kind || (target === "users" && sel.length === 0)} data-testid="request-submit">
            依頼を送る
          </Button>
        </form>
      )}
    </TopRow>
  );
}
