"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import Link from "@/components/ui/Link";
import clsx from "clsx";
import { ExternalLink, Link2, MapPin, Pencil, Phone, TriangleAlert, UserRound, X } from "lucide-react";
import type { ScheduleKind } from "@/lib/db/types";
import { SCHEDULE_KIND } from "@/lib/constants";
import type { ConflictReport } from "@/lib/calendar";
import { checkScheduleConflicts, quickUpdateScheduleEvent } from "@/lib/actions/schedule";
import { Button } from "@/components/ui";
import { KINDS_BY_GROUP, KindMark, kindLabel } from "./parts";
import type { EventQuickData } from "./quick-types";

/**
 * 予定表で予定を押したときの小さな画面 (お客様のご要望 2026-11-24「■4. 予定表からの予定変更」「■3. 予定表からの顧客情報の確認」)
 * - 予定表の上で開き、日時・内容 (件名・メモ)・種類 (アイコン) をその場で変えて保存する (別の画面に移らない)
 * - お客様は案件から引いた正しい情報 (問い合わせを既存の顧客にひも付けたあとは、その顧客の電話・住所)
 * - 担当者・場所・案件の変更は「詳しく変更」(今までの変更の画面)
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
      {open && open.search === search && <EventQuickDialog key={open.returnTo} id={open.id} returnTo={open.returnTo} onClose={() => setOpen(null)} />}
    </div>
  );
}

type TimeMode = "allday" | "am" | "pm" | "time";

function EventQuickDialog({ id, returnTo, onClose }: { id: string; returnTo: string; onClose: () => void }) {
  const [data, setData] = useState<EventQuickData | null>(null);
  const [error, setError] = useState("");
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
  }, [id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6">
      <button type="button" tabIndex={-1} aria-label="閉じる" className="absolute inset-0 bg-ink/40 backdrop-blur-[1px]" onClick={onClose} />
      <section
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={data ? `予定: ${data.label}` : "予定"}
        data-testid="event-quick"
        className="relative flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-2xl border border-line bg-panel shadow-pop sm:max-w-xl sm:rounded-2xl"
      >
        <header className="flex items-start gap-2 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            {data ? (
              <>
                <div className="flex flex-wrap items-center gap-1.5">
                  <KindMark kind={data.kind} size="md" />
                  <span className="text-xs text-ink-2">{data.storeName}</span>
                </div>
                <h2 className="mt-1 text-base leading-snug font-semibold text-ink">{data.label}</h2>
                <p className="text-xs text-ink-2 tnum">{data.period}</p>
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
          {data && <QuickBody data={data} returnTo={returnTo} />}
        </div>
      </section>
    </div>
  );
}

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

function QuickBody({ data, returnTo }: { data: EventQuickData; returnTo: string }) {
  const initialMode: TimeMode = data.startTime ? "time" : data.slot ?? "allday";
  const [kind, setKind] = useState<ScheduleKind>(data.kind);
  const [date, setDate] = useState(data.date);
  const [endDate, setEndDate] = useState(data.endDate ?? "");
  const [mode, setMode] = useState<TimeMode>(initialMode);
  const [start, setStart] = useState(data.startTime ?? "09:00");
  const [end, setEnd] = useState(data.endTime ?? "");
  const [report, setReport] = useState<ConflictReport | null>(null);
  const showEnd = !data.handover || Boolean(data.endDate);

  // 担当者の予定の重複 (日時を変えるたびに確かめる)
  useEffect(() => {
    if (!data.canEdit || !date) return;
    let alive = true;
    const t = setTimeout(() => {
      checkScheduleConflicts({ eventId: data.id, date, endDate: endDate || undefined, startTime: mode === "time" ? start : undefined, endTime: mode === "time" ? end || undefined : undefined, slot: mode === "am" || mode === "pm" ? mode : undefined, assigneeIds: data.assigneeIds, caseRef: data.caseRef, kind, storeId: data.storeId })
        .then((r) => alive && setReport(r))
        .catch(() => alive && setReport(null));
    }, 350);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [data, date, endDate, mode, start, end, kind]);

  const moved = date !== data.date || (endDate || "") !== (data.endDate ?? "") || mode !== initialMode || (mode === "time" && (start !== (data.startTime ?? "") || end !== (data.endTime ?? "")));
  const conflicts = report?.conflicts ?? [];
  const kinds = data.lockKind ? [data.kind] : [...KINDS_BY_GROUP.case, ...KINDS_BY_GROUP.internal];

  return (
    <div>
      <CustomerBlock data={data} />
      <dl className="mb-3 grid grid-cols-[5rem_minmax(0,1fr)] gap-x-2 gap-y-1 text-xs">
        <dt className="text-ink-3">担当</dt>
        <dd className="text-ink">{data.assignees.join("・") || "なし"}</dd>
        {data.work && (
          <>
            <dt className="text-ink-3">仕事内容</dt>
            <dd className="text-ink">{data.work}</dd>
          </>
        )}
      </dl>

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
            <div className="inline-flex flex-wrap gap-1 rounded-xl border border-line bg-subtle/70 p-1">
              {(
                [
                  ["allday", "終日"],
                  ["am", "午前"],
                  ["pm", "午後"],
                  ["time", "時刻を指定"],
                ] as [TimeMode, string][]
              ).map(([m, l]) => (
                <button key={m} type="button" onClick={() => setMode(m)} aria-pressed={mode === m} className={clsx("rounded-lg px-3 py-1.5 text-sm", mode === m ? "bg-panel font-medium text-ink shadow-xs" : "text-ink-2 hover:text-ink")}>
                  {l}
                </button>
              ))}
            </div>
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

          {conflicts.length > 0 && (
            <div className="rounded-lg border border-critical/30 bg-critical-soft/60 px-3 py-2 text-xs text-critical-ink" role="alert">
              <p className="flex items-center gap-1 font-semibold">
                <TriangleAlert className="h-3.5 w-3.5" aria-hidden />
                担当者の予定が重なります
              </p>
              <ul className="mt-1 space-y-0.5">
                {conflicts.slice(0, 5).map((c) => (
                  <li key={`${c.userId}-${c.eventId}`}>
                    {c.userName} さん: {c.when}「{c.title}」{c.store ? ` (${c.store})` : ""}
                  </li>
                ))}
              </ul>
              <label className="mt-1.5 flex items-center gap-1.5 font-medium">
                <input type="checkbox" name="allowOverlap" value="1" required className="h-4 w-4" />
                重複を承知で保存する
              </label>
            </div>
          )}
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
              詳しく変更 (担当者・場所など)
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
