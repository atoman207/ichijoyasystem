import Link from "@/components/ui/Link";
import clsx from "clsx";
import { CircleCheck, Globe, Link2, Plus, TriangleAlert } from "lucide-react";
import type { ScheduleEvent, Store, StoreId } from "@/lib/db/types";
import type { CaseRef } from "@/lib/db/schedule";
import {
  WEEKDAY,
  compareInDay,
  shortTime,
  dayInterval,
  dayOfWeek,
  holidayName,
  isMultiDay,
  lastDay,
  longDate,
  occursOn,
  shortDate,
  timeLabel,
  timeOverlap,
  type ConflictLink,
  type ConflictPair,
} from "@/lib/calendar";
import { daysBetween } from "@/lib/format";
import { Avatar } from "@/components/ui";
import { ConflictBadge, KindBadge, KindIcon, kindLabel, kindStyle, shortName } from "./parts";

/**
 * 予定表のビュー (サーバーコンポーネント)
 * 月 / 週 / 担当者別 (週) / 日 (担当者 × 時間) / 一覧。いずれも予定をクリックすると詳細へ移動する。
 */

export interface CalUser {
  id: string;
  name: string;
  title: string;
  storeId: StoreId;
}

export interface CalendarContext {
  today: string;
  /** 現在時刻 (分)。日表示の「いま」の線に使う */
  nowMinutes: number;
  stores: Map<StoreId, Store>;
  users: Map<string, CalUser>;
  /** 予定 ID → 予定 (重複の相手を引く) */
  byId: Map<string, ScheduleEvent>;
  /** 予定 ID → 重複の相手 */
  conflicts: Map<string, ConflictLink[]>;
  caseOf: (e: ScheduleEvent) => CaseRef | undefined;
  /** 全店舗を表示しているときはチップに店舗名を出す */
  showStore: boolean;
  /** 予定を追加するリンク (初期値つき)。登録できない場合は undefined */
  addHref?: (p: { date: string; user?: string; start?: string }) => string;
  /** 日表示へのリンク */
  dayHref: (date: string) => string;
  /** 会社の休業日 (休日カレンダー) */
  closedDays?: Set<string>;
}

const WEEK_LABELS = ["月", "火", "水", "木", "金", "土", "日"];

/** その日・その担当者にとって重複している予定か */
export function conflictOn(ctx: CalendarContext, e: ScheduleEvent, day?: string, userId?: string): boolean {
  const links = ctx.conflicts.get(e.id);
  if (!links?.length) return false;
  return links.some((l) => {
    if (userId && l.userId !== userId) return false;
    if (!day) return true;
    const other = ctx.byId.get(l.otherId);
    return Boolean(other && occursOn(other, day) && occursOn(e, day) && timeOverlap(e, other));
  });
}

/** 複数日の予定は「(2/3日目)」を添える */
export function dayTimeLabel(e: ScheduleEvent, day?: string): string {
  const base = timeLabel(e);
  if (!day || !isMultiDay(e)) return base;
  return `${base} (${daysBetween(e.date, day) + 1}/${daysBetween(e.date, lastDay(e)) + 1}日目)`;
}

function describe(ctx: CalendarContext, e: ScheduleEvent, day: string | undefined, conflict: boolean): string {
  const people = e.assigneeIds.map((id) => ctx.users.get(id)?.name).filter(Boolean);
  const store = ctx.stores.get(e.storeId);
  const c = ctx.caseOf(e);
  return [
    `${day ? shortDate(day) : shortDate(e.date)} ${dayTimeLabel(e, day)}`,
    kindLabel(e.kind),
    e.title,
    people.length ? `担当: ${people.join("・")}` : e.companyWide ? "全社共通" : "",
    store ? `${store.name}` : "",
    c ? `案件 ${c.number}${c.pending ? " (契約承認待ち)" : ""}` : "",
    e.location ?? "",
    conflict ? "担当者の予定が重複" : "",
  ]
    .filter(Boolean)
    .join(" / ");
}

export function EventChip({ e, ctx, day, variant, personId }: { e: ScheduleEvent; ctx: CalendarContext; day?: string; variant: "month" | "week" | "staff"; personId?: string }) {
  const s = kindStyle(e.kind);
  const conflict = conflictOn(ctx, e, day, personId);
  const label = describe(ctx, e, day, conflict);
  const href = `/schedule/${e.id}`;
  if (variant === "month" || variant === "staff") {
    return (
      <Link
        href={href}
        title={label}
        aria-label={label}
        className={clsx(
          "flex min-w-0 items-center gap-1 rounded border-l-[3px] px-1 py-0.5 text-[11px] leading-tight text-ink transition hover:brightness-95",
          s.soft,
          s.border,
          conflict && "ring-1 ring-critical/70",
        )}
      >
        <KindIcon kind={e.kind} className={clsx("h-3 w-3", s.ink)} />
        <span className="shrink-0 font-medium text-ink-2 tnum">{shortTime(e)}</span>
        <span className="min-w-0 truncate">{e.title}</span>
        {conflict && <TriangleAlert className="ml-auto h-3 w-3 shrink-0 text-critical" aria-hidden />}
      </Link>
    );
  }
  const c = ctx.caseOf(e);
  const store = ctx.stores.get(e.storeId);
  const people = e.assigneeIds.map((id) => ctx.users.get(id)?.name).filter((n): n is string => Boolean(n));
  return (
    <Link
      href={href}
      title={label}
      aria-label={label}
      className={clsx(
        "block rounded-lg border-l-[3px] px-2 py-1.5 text-[11px] leading-snug text-ink transition hover:shadow-lift",
        s.soft,
        s.border,
        conflict && "ring-1 ring-critical/70",
      )}
    >
      <span className="flex items-center gap-1">
        <KindIcon kind={e.kind} className={clsx("h-3.5 w-3.5", s.ink)} />
        <span className="font-semibold tnum">{dayTimeLabel(e, day)}</span>
        {conflict && <ConflictBadge className="ml-auto" />}
      </span>
      <span className="mt-0.5 line-clamp-2 block font-medium">{e.title}</span>
      <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] text-ink-2">
        <span className={clsx("font-medium", s.ink)}>{kindLabel(e.kind)}</span>
        {ctx.showStore && store && (
          <span className="inline-flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: store.color }} aria-hidden />
            {store.shortName}
          </span>
        )}
        {e.companyWide && (
          <span className="inline-flex items-center gap-0.5">
            <Globe className="h-3 w-3" aria-hidden />
            全社
          </span>
        )}
        {people.length > 0 && <span className="min-w-0 truncate">{people.map(shortName).join("・")}</span>}
        {c && (
          <span className="inline-flex items-center gap-0.5 text-ink-3">
            <Link2 className="h-3 w-3" aria-hidden />
            {c.number}
            {c.pending ? " 承認待ち" : ""}
          </span>
        )}
      </span>
    </Link>
  );
}

/** 祝日名、または会社の休業日 */
export function offLabel(ctx: Pick<CalendarContext, "closedDays">, d: string): string | undefined {
  const h = holidayName(d);
  if (h) return ctx.closedDays?.has(d) ? `${h} (休業日)` : h;
  return ctx.closedDays?.has(d) ? "休業日" : undefined;
}

function dayNumberClass(d: string, ctx: Pick<CalendarContext, "closedDays" | "today">): string {
  const today = ctx.today;
  if (d === today) return "bg-accent text-white";
  if (dayOfWeek(d) === 0 || offLabel(ctx, d)) return "text-critical-ink";
  if (dayOfWeek(d) === 6) return "text-info-ink";
  return "text-ink";
}

/* ------------------------------------------------------------------ */
/* 月                                                                  */
/* ------------------------------------------------------------------ */

export function MonthView({ days, month, events, ctx }: { days: string[]; month: string; events: ScheduleEvent[]; ctx: CalendarContext }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-panel shadow-card">
      <div className="grid grid-cols-7 border-b border-line bg-subtle/60 text-center text-[11px] font-semibold text-ink-2" aria-hidden>
        {WEEK_LABELS.map((w, i) => (
          <div key={w} className={clsx("py-2", i === 5 && "text-info-ink", i === 6 && "text-critical-ink")}>
            {w}
          </div>
        ))}
      </div>
      <ol className="grid grid-cols-7">
        {days.map((d, i) => {
          const list = events.filter((e) => occursOn(e, d)).sort(compareInDay);
          const inMonth = d.startsWith(month);
          const holiday = offLabel(ctx, d);
          const conflicts = list.filter((e) => conflictOn(ctx, e, d)).length;
          return (
            <li
              key={d}
              className={clsx(
                "group relative flex min-h-[68px] min-w-0 flex-col border-line p-1 @3xl:min-h-[124px] @3xl:p-1.5",
                i % 7 !== 6 && "border-r",
                i < days.length - 7 && "border-b",
                !inMonth && "bg-subtle/50",
                d === ctx.today && "bg-accent-soft/40",
              )}
            >
              <div className="flex min-w-0 items-center gap-1">
                <Link
                  href={ctx.dayHref(d)}
                  className={clsx("inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full px-1 text-xs font-semibold tnum hover:ring-2 hover:ring-accent/30", dayNumberClass(d, ctx), !inMonth && d !== ctx.today && "opacity-50")}
                  aria-label={`${longDate(d)}${holiday ? ` ${holiday}` : ""} の予定 ${list.length} 件${conflicts ? ` (重複 ${conflicts} 件)` : ""}`}
                >
                  {Number(d.slice(8))}
                </Link>
                {holiday && <span className="hidden min-w-0 truncate text-[10px] text-critical-ink @3xl:inline">{holiday}</span>}
                {ctx.addHref && (
                  <Link
                    href={ctx.addHref({ date: d })}
                    className="ml-auto hidden h-5 w-5 shrink-0 items-center justify-center rounded text-ink-3 opacity-0 transition group-hover:opacity-100 hover:bg-subtle hover:text-accent focus:opacity-100 @3xl:inline-flex"
                    aria-label={`${shortDate(d)} に予定を追加`}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </Link>
                )}
              </div>
              {/* 狭い幅: 種別色の点と件数 */}
              {list.length > 0 && (
                <div className="mt-1 flex flex-wrap items-center gap-0.5 @3xl:hidden" aria-hidden>
                  {list.slice(0, 6).map((e) => (
                    <span key={e.id} className={clsx("h-1.5 w-1.5 rounded-full", conflictOn(ctx, e, d) ? "bg-critical" : kindStyle(e.kind).bar)} />
                  ))}
                  <span className="ml-0.5 text-[10px] text-ink-3 tnum">{list.length}</span>
                </div>
              )}
              {/* 広い幅: 予定のチップ */}
              <ul className="mt-1 hidden min-w-0 space-y-0.5 @3xl:block">
                {list.slice(0, 3).map((e) => (
                  <li key={e.id} className="min-w-0">
                    <EventChip e={e} ctx={ctx} day={d} variant="month" />
                  </li>
                ))}
              </ul>
              {list.length > 3 && (
                <Link href={ctx.dayHref(d)} className="mt-0.5 hidden text-[11px] font-medium text-accent hover:underline @3xl:block">
                  他 {list.length - 3} 件
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 週                                                                  */
/* ------------------------------------------------------------------ */

export function WeekView({ days, events, ctx }: { days: string[]; events: ScheduleEvent[]; ctx: CalendarContext }) {
  return (
    <div className="grid grid-cols-1 gap-2 @3xl:grid-cols-7">
      {days.map((d) => {
        const list = events.filter((e) => occursOn(e, d)).sort(compareInDay);
        const holiday = offLabel(ctx, d);
        return (
          <section
            key={d}
            aria-label={`${longDate(d)} の予定 ${list.length} 件`}
            className={clsx(
              "flex min-w-0 flex-col rounded-xl border bg-panel p-2 shadow-card @3xl:min-h-[440px]",
              d === ctx.today ? "border-accent/60 ring-1 ring-accent/25" : "border-line",
              (dayOfWeek(d) === 0 || holiday) && d !== ctx.today && "bg-critical-soft/20",
            )}
          >
            <header className="mb-2 flex items-center gap-1.5">
              <Link href={ctx.dayHref(d)} className="flex items-baseline gap-1.5 rounded-md px-1 hover:bg-subtle">
                <span className={clsx("text-xs font-semibold", dayOfWeek(d) === 0 || holiday ? "text-critical-ink" : dayOfWeek(d) === 6 ? "text-info-ink" : "text-ink-2")}>{WEEKDAY[dayOfWeek(d)]}</span>
                <span className={clsx("inline-flex h-7 min-w-7 items-center justify-center rounded-full px-1 text-base font-semibold tnum", dayNumberClass(d, ctx))}>{Number(d.slice(8))}</span>
                <span className="text-[11px] text-ink-3 @3xl:hidden">{Number(d.slice(5, 7))}月</span>
              </Link>
              {holiday && <span className="min-w-0 truncate text-[10px] text-critical-ink">{holiday}</span>}
              <span className="ml-auto text-[11px] text-ink-3 tnum">{list.length > 0 ? `${list.length} 件` : ""}</span>
            </header>
            {list.length === 0 && <p className="px-1 py-2 text-[11px] text-ink-3">予定なし</p>}
            <ul className="flex-1 space-y-1.5">
              {list.map((e) => (
                <li key={e.id}>
                  <EventChip e={e} ctx={ctx} day={d} variant="week" />
                </li>
              ))}
            </ul>
            {ctx.addHref && (
              <Link href={ctx.addHref({ date: d })} className="mt-2 inline-flex items-center gap-1 self-start rounded-lg px-1.5 py-1 text-[11px] text-ink-3 transition hover:bg-subtle hover:text-accent" aria-label={`${shortDate(d)} に予定を追加`}>
                <Plus className="h-3.5 w-3.5" />
                追加
              </Link>
            )}
          </section>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 担当者別 (人員配置)                                                  */
/* ------------------------------------------------------------------ */

function groupRows(rows: CalUser[], ctx: CalendarContext): { store: Store | undefined; users: CalUser[] }[] {
  const order = [...ctx.stores.keys()];
  const groups = new Map<StoreId, CalUser[]>();
  for (const u of rows) {
    const list = groups.get(u.storeId);
    if (list) list.push(u);
    else groups.set(u.storeId, [u]);
  }
  return order.filter((s) => groups.has(s)).map((s) => ({ store: ctx.stores.get(s), users: groups.get(s)! }));
}

export function StaffView({ days, rows, events, unassigned = [], ctx }: { days: string[]; rows: CalUser[]; events: ScheduleEvent[]; unassigned?: ScheduleEvent[]; ctx: CalendarContext }) {
  const groups = groupRows(rows, ctx);
  const cell = (u: CalUser, d: string) => events.filter((e) => e.assigneeIds.includes(u.id) && occursOn(e, d)).sort(compareInDay);
  const summary = days.map((d) => {
    let busy = 0;
    let leave = 0;
    for (const u of rows) {
      const list = cell(u, d);
      if (list.length) busy++;
      if (list.some((e) => e.kind === "leave")) leave++;
    }
    return { busy, leave };
  });
  return (
    <div className="overflow-x-auto rounded-2xl border border-line bg-panel shadow-card">
      <table className="w-full min-w-[980px] table-fixed border-collapse text-left">
        <caption className="sr-only">担当者別の週間予定 (人員配置)</caption>
        <thead>
          <tr className="border-b border-line bg-subtle/60 text-[11px] text-ink-2">
            <th scope="col" className="sticky left-0 z-10 w-48 bg-subtle px-3 py-2 font-semibold">
              担当者 <span className="font-normal text-ink-3">({rows.length} 人)</span>
            </th>
            {days.map((d) => {
              const holiday = offLabel(ctx, d);
              return (
                <th key={d} scope="col" className={clsx("px-2 py-2 font-semibold", d === ctx.today && "bg-accent-soft/60")}>
                  <Link href={ctx.dayHref(d)} className="inline-flex items-baseline gap-1 hover:text-accent">
                    <span className={clsx(dayOfWeek(d) === 0 || holiday ? "text-critical-ink" : dayOfWeek(d) === 6 ? "text-info-ink" : "")}>{shortDate(d)}</span>
                  </Link>
                  {holiday && <span className="ml-1 text-[10px] font-normal text-critical-ink">{holiday}</span>}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {unassigned.length > 0 && (
            <tr className="border-b border-line bg-warn-soft/30 align-top">
              <th scope="row" className="sticky left-0 z-10 bg-panel px-3 py-2 text-left font-normal">
                <span className="block text-[13px] font-medium text-ink">担当者未設定</span>
                <span className="block text-[10px] text-ink-3">店舗の予定 {unassigned.length} 件</span>
              </th>
              {days.map((d) => (
                <td key={d} className="px-1.5 py-1.5">
                  <ul className="space-y-0.5">
                    {unassigned
                      .filter((e) => occursOn(e, d))
                      .sort(compareInDay)
                      .map((e) => (
                        <li key={e.id}>
                          <EventChip e={e} ctx={ctx} day={d} variant="staff" />
                        </li>
                      ))}
                  </ul>
                </td>
              ))}
            </tr>
          )}
          {groups.map((g) => (
            <StaffGroup key={g.store?.id ?? "none"} store={g.store} users={g.users} days={days} cell={cell} ctx={ctx} />
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={days.length + 1} className="px-4 py-12 text-center text-sm text-ink-3">
                表示する担当者がいません
              </td>
            </tr>
          )}
        </tbody>
        {rows.length > 0 && (
          <tfoot>
            <tr className="border-t border-line-strong bg-subtle/50 text-[11px] text-ink-2">
              <th scope="row" className="sticky left-0 z-10 bg-subtle px-3 py-2 text-left font-semibold">
                稼働状況
              </th>
              {summary.map((s, i) => (
                <td key={days[i]} className="px-2 py-2 tnum">
                  <span className="font-semibold text-ink">{s.busy}</span>/{rows.length} 人に予定
                  {s.leave > 0 && <span className="ml-1 text-critical-ink">休 {s.leave}</span>}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

function StaffGroup({ store, users, days, cell, ctx }: { store: Store | undefined; users: CalUser[]; days: string[]; cell: (u: CalUser, d: string) => ScheduleEvent[]; ctx: CalendarContext }) {
  return (
    <>
      <tr className="border-b border-line bg-panel">
        <th colSpan={days.length + 1} scope="colgroup" className="sticky left-0 px-3 pt-3 pb-1 text-left text-xs font-semibold text-ink">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ background: store?.color }} aria-hidden />
            {store?.name ?? "-"}
            <span className="font-normal text-ink-3">{users.length} 人</span>
          </span>
        </th>
      </tr>
      {users.map((u) => (
        <tr key={u.id} className="border-b border-line align-top">
          <th scope="row" className="sticky left-0 z-10 bg-panel px-3 py-2 text-left font-normal">
            <span className="flex items-center gap-2">
              <Avatar name={u.name} id={u.id} size={26} />
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-medium text-ink">{u.name}</span>
                <span className="block truncate text-[10px] text-ink-3">{u.title}</span>
              </span>
            </span>
          </th>
          {days.map((d) => {
            const list = cell(u, d);
            const conflict = list.some((e) => conflictOn(ctx, e, d, u.id));
            const off = dayOfWeek(d) === 0 || Boolean(offLabel(ctx, d));
            return (
              <td key={d} className={clsx("group relative px-1.5 py-1.5", d === ctx.today && "bg-accent-soft/30", off && d !== ctx.today && "bg-subtle/50", conflict && "bg-critical-soft/40")}>
                <ul className="space-y-0.5">
                  {list.map((e) => (
                    <li key={e.id}>
                      <EventChip e={e} ctx={ctx} day={d} variant="staff" personId={u.id} />
                    </li>
                  ))}
                </ul>
                {ctx.addHref && (
                  <Link
                    href={ctx.addHref({ date: d, user: u.id })}
                    className={clsx(
                      "flex items-center justify-center rounded text-ink-3 opacity-0 transition group-hover:opacity-100 hover:bg-subtle hover:text-accent focus:opacity-100",
                      list.length ? "mt-0.5 h-5" : "h-9",
                    )}
                    aria-label={`${u.name} さんの ${shortDate(d)} に予定を追加`}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </Link>
                )}
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 日 (担当者 × 時間)                                                    */
/* ------------------------------------------------------------------ */

const DAY_START = 7 * 60;
const DAY_END = 20 * 60;
const SPAN = DAY_END - DAY_START;
const LANE = 26;

function pct(min: number): number {
  return ((Math.min(Math.max(min, DAY_START), DAY_END) - DAY_START) / SPAN) * 100;
}

/** 重なる予定を段 (レーン) に振り分ける */
function lanes(events: ScheduleEvent[]): { e: ScheduleEvent; lane: number }[] {
  const ends: number[] = [];
  return [...events]
    .sort((a, b) => dayInterval(a)[0] - dayInterval(b)[0])
    .map((e) => {
      const [s, end] = dayInterval(e);
      let lane = ends.findIndex((x) => x <= s);
      if (lane < 0) {
        lane = ends.length;
        ends.push(end);
      } else ends[lane] = end;
      return { e, lane };
    });
}

export function DayView({ day, rows, events, unassigned, ctx }: { day: string; rows: CalUser[]; events: ScheduleEvent[]; unassigned: ScheduleEvent[]; ctx: CalendarContext }) {
  const hours = Array.from({ length: SPAN / 60 + 1 }, (_, i) => DAY_START / 60 + i);
  const groups = groupRows(rows, ctx);
  const showNow = day === ctx.today && ctx.nowMinutes > DAY_START && ctx.nowMinutes < DAY_END;
  const grid = { backgroundImage: `repeating-linear-gradient(to right, var(--color-line) 0 1px, transparent 1px calc(100% / ${SPAN / 60}))` };
  const row = (key: string, head: React.ReactNode, list: ScheduleEvent[], userId?: string) => {
    const allDay = list.filter((e) => !e.startTime && !e.slot);
    const timed = lanes(list.filter((e) => e.startTime || e.slot));
    const laneCount = Math.max(1, ...timed.map((t) => t.lane + 1));
    const height = (allDay.length + laneCount) * LANE + 8;
    return (
      <div key={key} className="grid grid-cols-[192px_minmax(0,1fr)] border-b border-line">
        <div className="sticky left-0 z-10 border-r border-line bg-panel px-3 py-2">{head}</div>
        <div className="group relative" style={{ ...grid, height }}>
          {showNow && <div className="absolute inset-y-0 z-10 w-px bg-critical" style={{ left: `${pct(ctx.nowMinutes)}%` }} aria-hidden />}
          {allDay.map((e, i) => (
            <DayBar key={e.id} e={e} ctx={ctx} day={day} userId={userId} style={{ top: i * LANE + 4, left: "0.25rem", right: "0.25rem" }} />
          ))}
          {timed.map(({ e, lane }) => {
            const [s, end] = dayInterval(e);
            const left = pct(s);
            const width = Math.max(pct(end) - left, 2.5);
            return <DayBar key={e.id} e={e} ctx={ctx} day={day} userId={userId} style={{ top: (allDay.length + lane) * LANE + 4, left: `${left}%`, width: `${width}%` }} />;
          })}
          {list.length === 0 && ctx.addHref && userId && (
            <Link
              href={ctx.addHref({ date: day, user: userId })}
              className="absolute inset-0 flex items-center justify-center text-[11px] text-ink-3 opacity-0 transition group-hover:opacity-100 focus:opacity-100"
              aria-label={`${ctx.users.get(userId)?.name ?? ""} さんの予定を追加`}
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              予定を追加
            </Link>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="overflow-x-auto rounded-2xl border border-line bg-panel shadow-card">
      <div className="min-w-[900px]">
        <div className="grid grid-cols-[192px_minmax(0,1fr)] border-b border-line bg-subtle/60 text-[11px] text-ink-2">
          <div className="sticky left-0 z-10 border-r border-line bg-subtle px-3 py-2 font-semibold">担当者 <span className="font-normal text-ink-3">({rows.length} 人)</span></div>
          <div className="relative h-8" aria-hidden>
            {hours.map((h) => (
              <span key={h} className="absolute top-2 -translate-x-1/2 tnum" style={{ left: `${pct(h * 60)}%` }}>
                {h === DAY_START / 60 || h === DAY_END / 60 ? "" : `${h}時`}
              </span>
            ))}
          </div>
        </div>
        {unassigned.length > 0 &&
          row(
            "unassigned",
            <span className="flex items-center gap-2 text-[13px] font-medium text-ink">
              <Globe className="h-4 w-4 text-ink-3" aria-hidden />
              全社・店舗の予定
            </span>,
            unassigned,
          )}
        {groups.map((g) => (
          <div key={g.store?.id ?? "none"}>
            <div className="sticky left-0 border-b border-line px-3 pt-3 pb-1 text-xs font-semibold text-ink">
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full" style={{ background: g.store?.color }} aria-hidden />
                {g.store?.name}
              </span>
            </div>
            {g.users.map((u) =>
              row(
                u.id,
                <span className="flex items-center gap-2">
                  <Avatar name={u.name} id={u.id} size={26} />
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-medium text-ink">{u.name}</span>
                    <span className="block truncate text-[10px] text-ink-3">{u.title}</span>
                  </span>
                </span>,
                events.filter((e) => e.assigneeIds.includes(u.id) && occursOn(e, day)),
                u.id,
              ),
            )}
          </div>
        ))}
        {rows.length === 0 && unassigned.length === 0 && <p className="px-4 py-12 text-center text-sm text-ink-3">表示する担当者がいません</p>}
      </div>
    </div>
  );
}

function DayBar({ e, ctx, day, userId, style }: { e: ScheduleEvent; ctx: CalendarContext; day: string; userId?: string; style: React.CSSProperties }) {
  const s = kindStyle(e.kind);
  const conflict = conflictOn(ctx, e, day, userId);
  const label = describe(ctx, e, day, conflict);
  return (
    <Link
      href={`/schedule/${e.id}`}
      title={label}
      aria-label={label}
      className={clsx(
        "absolute flex h-[22px] items-center gap-1 overflow-hidden rounded-md border-l-[3px] px-1.5 text-[11px] leading-none whitespace-nowrap text-ink shadow-xs transition hover:z-20 hover:shadow-lift",
        s.soft,
        s.border,
        conflict && "ring-1 ring-critical",
      )}
      style={style}
    >
      <KindIcon kind={e.kind} className={clsx("h-3 w-3", s.ink)} />
      <span className="shrink-0 font-medium text-ink-2 tnum">{dayTimeLabel(e, day)}</span>
      <span className="truncate">{e.title}</span>
      {conflict && <TriangleAlert className="h-3 w-3 shrink-0 text-critical" aria-hidden />}
    </Link>
  );
}

/* ------------------------------------------------------------------ */
/* 一覧                                                                */
/* ------------------------------------------------------------------ */

export function ListView({ days, events, ctx }: { days: string[]; events: ScheduleEvent[]; ctx: CalendarContext }) {
  const sections = days.map((d) => ({ d, list: events.filter((e) => occursOn(e, d)).sort(compareInDay) })).filter((s) => s.list.length > 0);
  if (sections.length === 0) {
    return <div className="rounded-2xl border border-dashed border-line-strong bg-panel/60 px-6 py-12 text-center text-sm text-ink-3">この期間の予定はありません</div>;
  }
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-panel shadow-card">
      {sections.map(({ d, list }) => {
        const holiday = offLabel(ctx, d);
        return (
          <section key={d} aria-label={longDate(d)}>
            <h3 className={clsx("flex items-center gap-2 border-b border-line px-4 py-2 text-xs font-semibold", d === ctx.today ? "bg-accent-soft/60 text-accent-ink" : "bg-subtle/60 text-ink-2")}>
              <Link href={ctx.dayHref(d)} className={clsx("hover:underline", (dayOfWeek(d) === 0 || holiday) && d !== ctx.today && "text-critical-ink", dayOfWeek(d) === 6 && d !== ctx.today && "text-info-ink")}>
                {longDate(d)}
              </Link>
              {d === ctx.today && <span className="rounded-full bg-accent px-1.5 text-[10px] text-white">今日</span>}
              {holiday && <span className="font-normal text-critical-ink">{holiday}</span>}
              <span className="ml-auto font-normal text-ink-3 tnum">{list.length} 件</span>
            </h3>
            <ul className="divide-y divide-line">
              {list.map((e) => (
                <ListRow key={e.id} e={e} d={d} ctx={ctx} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function ListRow({ e, d, ctx }: { e: ScheduleEvent; d: string; ctx: CalendarContext }) {
  const c = ctx.caseOf(e);
  const store = ctx.stores.get(e.storeId);
  const conflict = conflictOn(ctx, e, d);
  return (
    <li className={clsx("grid gap-x-4 gap-y-1 px-4 py-2.5 text-sm @3xl:grid-cols-[132px_112px_minmax(0,1fr)_minmax(0,220px)] @3xl:items-start", conflict && "bg-critical-soft/30")}>
      <div className="flex items-center gap-2 text-xs font-semibold text-ink tnum @3xl:pt-0.5">
        <span className={clsx("h-4 w-1 rounded-full", kindStyle(e.kind).bar)} aria-hidden />
        {dayTimeLabel(e, d)}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <KindBadge kind={e.kind} />
        {conflict && <ConflictBadge />}
      </div>
      <div className="min-w-0">
        <Link href={`/schedule/${e.id}`} className="font-medium text-ink hover:text-accent hover:underline">
          {e.title}
        </Link>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-ink-3">
          {c && (
            <span className="inline-flex items-center gap-0.5">
              <Link2 className="h-3 w-3" aria-hidden />
              {c.stage} {c.number}
              {c.pending && <span className="text-warn-ink">(契約承認待ち)</span>}
            </span>
          )}
          {e.location && <span className="truncate">{e.location}</span>}
          {e.source === "order" && <span className="text-accent-ink">受注の施工予定と連動</span>}
        </div>
      </div>
      <div className="min-w-0 text-xs text-ink-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          {store && (
            <span className="inline-flex items-center gap-1 whitespace-nowrap">
              <span className="h-2 w-2 rounded-full" style={{ background: store.color }} aria-hidden />
              {store.shortName}
            </span>
          )}
          {e.companyWide && (
            <span className="inline-flex items-center gap-0.5 whitespace-nowrap">
              <Globe className="h-3 w-3" aria-hidden />
              全社共通
            </span>
          )}
        </div>
        <div className="mt-0.5 truncate">{e.assigneeIds.map((id) => ctx.users.get(id)?.name).filter(Boolean).join("・") || (e.companyWide ? "全員" : "担当者なし")}</div>
      </div>
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* 重複の一覧                                                           */
/* ------------------------------------------------------------------ */

export function ConflictList({ pairs, ctx, limit = 8, moreHref }: { pairs: ConflictPair[]; ctx: CalendarContext; limit?: number; moreHref?: string }) {
  if (pairs.length === 0) {
    return (
      <p className="flex items-center gap-2 text-sm text-good-ink">
        <CircleCheck className="h-4 w-4" aria-hidden />
        この期間・表示中の担当者に予定の重複はありません
      </p>
    );
  }
  return (
    <div>
      <ul className="divide-y divide-line">
        {pairs.slice(0, limit).map((p) => {
          const a = ctx.byId.get(p.aId);
          const b = ctx.byId.get(p.bId);
          if (!a || !b) return null;
          return (
            <li key={`${p.userId}-${p.aId}-${p.bId}`} className="grid grid-cols-1 gap-1 py-2 text-xs @3xl:grid-cols-[150px_minmax(0,1fr)] @3xl:gap-3">
              <div className="flex items-center gap-1.5 font-medium text-ink">
                <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-critical" aria-hidden />
                <span className="tnum">{shortDate(p.day)}</span>
                <span className="truncate">{ctx.users.get(p.userId)?.name}</span>
              </div>
              <div className="flex min-w-0 flex-col gap-1 @xl:flex-row @xl:items-center @xl:gap-2">
                <PairLink e={a} />
                <span className="hidden text-ink-3 @xl:inline" aria-hidden>
                  ⇄
                </span>
                <PairLink e={b} />
              </div>
            </li>
          );
        })}
      </ul>
      {pairs.length > limit && (
        <p className="mt-2 text-xs text-ink-3">
          ほか {pairs.length - limit} 件{moreHref && <Link href={moreHref} className="ml-2 font-medium text-accent hover:underline">すべて表示</Link>}
        </p>
      )}
    </div>
  );
}

function PairLink({ e }: { e: ScheduleEvent }) {
  return (
    <Link href={`/schedule/${e.id}`} className={clsx("inline-flex min-w-0 items-center gap-1 rounded-md border-l-[3px] px-1.5 py-0.5 text-ink hover:underline", kindStyle(e.kind).soft, kindStyle(e.kind).border)}>
      <KindIcon kind={e.kind} className={clsx("h-3 w-3", kindStyle(e.kind).ink)} />
      <span className="shrink-0 tnum text-ink-2">{timeLabel(e)}</span>
      <span className="truncate">{e.title}</span>
    </Link>
  );
}
