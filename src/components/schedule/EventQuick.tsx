"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "next/navigation";
import Link from "@/components/ui/Link";
import clsx from "clsx";
import { CalendarPlus, ExternalLink, FileText, FileUp, Link2, MapPin, Navigation, Pencil, Phone, TriangleAlert, Truck, UserRound, Users, X } from "lucide-react";
import type { ScheduleKind } from "@/lib/db/types";
import { QUICK_MAX_ASSIGNEES, SCHEDULE_KIND } from "@/lib/constants";
import type { ConflictQuery, ConflictReport } from "@/lib/calendar";
import { addPairedDelivery, checkScheduleConflicts, quickUpdateScheduleEvent } from "@/lib/actions/schedule";
import { Button, buttonClass } from "@/components/ui";
import { MapDocUploader } from "@/components/maps/MapDocUploader";
import { CopyAddress } from "@/components/maps/CopyAddress";
import { KINDS_BY_GROUP, KindMark, kindLabel } from "./parts";
import type { EventQuickData, QuickMap, QuickStaff } from "./quick-types";

/**
 * 予定表で予定を押したときの小さな画面 (お客様のご要望 2026-11-24「■3」「■4」、追加「②」「⑥」「⑦」「⑧」)
 * - 上 (スクロールせずに操作する欄): 地図 (Google マップ・経路・登録済みの住宅地図・住宅地図の登録) / 担当者の確認・変更 (最大 4 名) /
 *   引取・現見 ⇄ 納品の相手の予定 (納品予定の追加)
 * - お客様は案件から引いた正しい情報 (問い合わせを既存の顧客にひも付けたあとは、その顧客の電話・住所)
 * - 日時・内容 (件名・メモ)・種類 (アイコン) をその場で変えて保存する。場所・案件の変更は「詳しく変更」(今までの変更の画面)
 * EventQuickHost は予定表のビューを包み、予定のリンク (data-ev) を押したときだけ開く (Ctrl・Shift で押したときは今までどおり別の画面)
 */

type Open = { id: string; search: string; returnTo: string };

export function EventQuickHost({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<Open | null>(null);
  const search = useSearchParams().toString();
  const onClickCapture = (ev: React.MouseEvent<HTMLDivElement>) => {
    if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    const a = (ev.target as HTMLElement).closest("a[data-ev]");
    const id = a?.getAttribute("data-ev");
    if (!id || id.startsWith("hold:")) return;
    ev.preventDefault();
    ev.stopPropagation();
    // 保存したら同じ予定表 (日付・店舗・表示はそのまま) に戻る。_r は保存のたびに変わる印 (戻ったら小さな画面を閉じる)
    const sp = new URLSearchParams(window.location.search);
    for (const k of ["msg", "err", "_r"]) sp.delete(k);
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

type TimeMode = "allday" | "am" | "pm" | "time";

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

function MapRow({ map, eventId, onReload }: { map?: QuickMap; eventId: string; onReload: () => void }) {
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
          <a key={d.id} href={`/api/maps/documents/${d.id}`} target="_blank" rel="noreferrer" className={buttonClass("secondary", "sm")} title={d.title}>
            <FileText />
            住宅地図{map.docs.length > 1 ? ` ${i + 1}` : ""}
          </a>
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
            <CopyAddress text={map.address} />
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

/** 担当者の丸 (予定表のチップと同じ略称・店舗の色) */
function StaffDot({ s, size = "sm" }: { s: Pick<QuickStaff, "initial" | "color">; size?: "sm" | "md" }) {
  return (
    <span className={clsx("grid shrink-0 place-items-center rounded-full border font-bold leading-none text-ink", size === "md" ? "h-5 w-5 text-[10px]" : "h-4 w-4 text-[9px]")} style={{ borderColor: s.color, background: `color-mix(in srgb, ${s.color} 22%, white)` }} aria-hidden>
      {s.initial}
    </span>
  );
}

const GROUP_LABEL = (storeName: string) => ({ store: `${storeName} (この予定の店舗)`, common: "本部 (全店舗共通)", other: "ほかの店舗 (配送・施工の応援)" });

/** 担当者を選ぶ (予定の店舗の社員を先に、本部・ほかの店舗の社員も選べる。最大 4 名) */
function StaffPicker({ staff, selected, onChange, storeName, busy }: { staff: QuickStaff[]; selected: string[]; onChange: (ids: string[]) => void; storeName: string; busy?: ConflictReport["busy"] }) {
  const full = selected.length >= QUICK_MAX_ASSIGNEES;
  const labels = GROUP_LABEL(storeName);
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : full ? selected : [...selected, id]);
  return (
    <div className="mt-1.5 space-y-1.5 rounded-xl border border-line bg-panel p-2" data-testid="staff-picker">
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
      <p className="text-[10px] text-ink-3">{full ? `最大 ${QUICK_MAX_ASSIGNEES} 名まで選べます (外してから選び直してください)` : `最大 ${QUICK_MAX_ASSIGNEES} 名。丸の色は店舗の色です`}</p>
    </div>
  );
}

/** 重複の確認 (選んだ担当者・日時が変わるたびに。古い結果は使わない) */
function useConflicts(query: ConflictQuery | null): ConflictReport | null {
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

function ConflictNote({ report, label = "重複を承知で保存する" }: { report: ConflictReport | null; label?: string }) {
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
            <Button type="submit" size="sm" disabled={sel.length === 0}>
              担当者を保存
            </Button>
            <button type="button" onClick={() => setSel(data.assigneeIds)} className="text-xs text-ink-2 hover:underline">
              元に戻す
            </button>
            {sel.length === 0 && <span className="text-[11px] text-critical-ink">1 人以上選んでください</span>}
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

function TimeModeButtons({ mode, setMode }: { mode: TimeMode; setMode: (m: TimeMode) => void }) {
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
        <Button type="submit" size="sm" disabled={!date || sel.length === 0}>
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
      {(c?.phones.length ? c.phones : data.contactPhone ? [data.contactPhone] : []).map((p) => (
        <a key={p} href={`tel:${p.replace(/[^0-9+]/g, "")}`} className="flex items-center gap-2 text-accent tnum hover:underline">
          <Phone className="h-3.5 w-3.5" aria-hidden />
          {p}
        </a>
      ))}
      {c?.address && (
        <div className="flex items-start gap-2 text-xs text-ink-2">
          <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-3" aria-hidden />
          <span>{c.address}</span>
        </div>
      )}
      {data.location && data.location !== c?.address && (
        <div className="flex items-start gap-2 text-xs text-ink-2">
          <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" aria-hidden />
          <span>
            現場: {data.location}
            {data.area && data.area !== data.location ? ` (${data.area})` : ""}
          </span>
        </div>
      )}
      {c?.corporate && !data.area && <p className="text-xs text-warn-ink">業者の案件です。現場の住所が未登録のため町名を出せません (見積・受注の「施工場所」に入れてください)。</p>}
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
        <MapRow map={data.map} eventId={data.id} onReload={onReload} />
        <AssigneeRow data={data} returnTo={returnTo} />
        <PairRow data={data} returnTo={returnTo} onOpenEvent={onOpenEvent} />
      </div>

      <CustomerBlock data={data} />
      {data.work && (
        <dl className="mb-3 grid grid-cols-[5rem_minmax(0,1fr)] gap-x-2 gap-y-1 text-xs">
          <dt className="text-ink-3">仕事内容</dt>
          <dd className="text-ink">{data.work}</dd>
        </dl>
      )}

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

          {data.handover && moved && <p className="rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn-ink">受注の引取・納品の日程と連動する予定です。日時の変更は受注の日程の変更の申請になり、承認のあとに予定表に反映されます (管理者は申請を省略してすぐ反映)。</p>}

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
    </div>
  );
}
