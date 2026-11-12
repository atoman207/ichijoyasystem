import Link from "@/components/ui/Link";
import clsx from "clsx";
import { CalendarDays, ChartGantt, ChevronLeft, ChevronRight, Columns3, LayoutGrid, List, Plus, Rows3, TriangleAlert, UserRound } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import type { ScheduleEvent, ScheduleKind, StoreId } from "@/lib/db/types";
import { canSeeAllStores, canViewCompanySchedule } from "@/lib/auth/permissions";
import { redirect } from "next/navigation";
import { createCaseResolver, type CaseRef } from "@/lib/db/schedule";
import { addMonths, analyzeConflicts, dateRange, isDateKey, longDate, monthEnd, monthStart, occursOn, overlapsRange, shortDate, weekStart } from "@/lib/calendar";
import { addDays, toDateKey } from "@/lib/format";
import { SCHEDULE_GROUP_LABEL, SCHEDULE_KIND, SCHEDULE_KINDS } from "@/lib/constants";
import { Card, CardHeader, Flash, LinkButton, LinkTabs, PageHeader } from "@/components/ui";
import { ConflictList, DayView, ListView, MonthView, StaffView, WeekView, type CalendarContext, type CalUser } from "@/components/schedule/CalendarViews";
import { KindLegend } from "@/components/schedule/parts";

type View = "month" | "week" | "staff" | "day" | "list";

const VIEWS: { id: View; label: string; icon: typeof LayoutGrid; hint: string }[] = [
  { id: "month", label: "月", icon: LayoutGrid, hint: "1 か月の予定" },
  { id: "week", label: "週", icon: Columns3, hint: "1 週間の予定" },
  { id: "staff", label: "担当者別", icon: Rows3, hint: "社員ごとの 1 週間 (人員配置)" },
  { id: "day", label: "日", icon: ChartGantt, hint: "社員ごとの 1 日の時間割" },
  { id: "list", label: "一覧", icon: List, hint: "2 週間分の予定一覧" },
];

type SP = Record<string, string | undefined>;

export default async function SchedulePage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const user = await requireUser();
  if (!canViewCompanySchedule(user)) redirect("/?err=" + encodeURIComponent("予定表を閲覧する権限がありません。"));
  const db = getDb();
  const now = new Date();
  const today = toDateKey(now);

  const view: View = VIEWS.some((v) => v.id === sp.view) ? (sp.view as View) : "week";
  const anchor = isDateKey(sp.date) ? sp.date : today;
  // 店舗: 指定がなければ、店舗ロールは自店舗・全店舗ロールは全社 (どちらも全店舗の予定を閲覧可)
  const storeParam = sp.store === "all" || db.stores.some((s) => s.id === sp.store) ? (sp.store as string) : canSeeAllStores(user) ? "all" : user.storeId;
  const storeFilter = storeParam === "all" ? undefined : (storeParam as StoreId);
  const userParam = sp.user === "me" ? user.id : sp.user && db.users.some((u) => u.id === sp.user) ? sp.user : "";
  const kindParam = sp.kind === "case" || sp.kind === "internal" || SCHEDULE_KINDS.includes(sp.kind as ScheduleKind) ? (sp.kind as string) : "";
  const onlyConflicts = sp.conflicts === "1";

  // 表示期間
  let from: string;
  let to: string;
  let prev: string;
  let next: string;
  let periodTitle: string;
  if (view === "month") {
    from = weekStart(monthStart(anchor));
    to = addDays(weekStart(monthEnd(anchor)), 6);
    prev = addMonths(monthStart(anchor), -1);
    next = addMonths(monthStart(anchor), 1);
    periodTitle = `${Number(anchor.slice(0, 4))}年${Number(anchor.slice(5, 7))}月`;
  } else if (view === "week" || view === "staff") {
    from = weekStart(anchor);
    to = addDays(from, 6);
    prev = addDays(from, -7);
    next = addDays(from, 7);
    periodTitle = `${from.slice(0, 4)}年 ${shortDate(from)} 〜 ${shortDate(to)}`;
  } else if (view === "day") {
    from = anchor;
    to = anchor;
    prev = addDays(anchor, -1);
    next = addDays(anchor, 1);
    periodTitle = longDate(anchor);
  } else {
    from = anchor;
    to = addDays(anchor, 13);
    prev = addDays(anchor, -14);
    next = addDays(anchor, 14);
    periodTitle = `${from.slice(0, 4)}年 ${shortDate(from)} 〜 ${shortDate(to)}`;
  }
  const days = dateRange(from, to);

  const link = (over: Partial<Record<"view" | "date" | "store" | "user" | "kind" | "conflicts", string>> = {}) => {
    const m = { view, date: anchor, store: storeParam, user: sp.user === "me" ? "me" : userParam, kind: kindParam, conflicts: onlyConflicts ? "1" : "", ...over };
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(m)) if (v) p.set(k, v);
    return `/schedule?${p.toString()}`;
  };
  const here = link();

  // 期間内の全予定。重複は店舗・担当者の絞り込みに関係なく全社の予定で判定する
  const inRange = db.schedule.filter((e) => overlapsRange(e, from, to));
  const { byEvent, pairs } = analyzeConflicts(inRange);
  const kindOk = (e: ScheduleEvent) => !kindParam || (kindParam === "case" || kindParam === "internal" ? SCHEDULE_KIND[e.kind].group === kindParam : e.kind === kindParam);
  const storeOk = (e: ScheduleEvent) => !storeFilter || e.storeId === storeFilter || Boolean(e.companyWide);
  const userOk = (e: ScheduleEvent) => !userParam || e.assigneeIds.includes(userParam);
  const conflictOk = (e: ScheduleEvent) => !onlyConflicts || (byEvent.get(e.id)?.some((l) => !userParam || l.userId === userParam) ?? false);
  const shown = inRange.filter((e) => kindOk(e) && storeOk(e) && userOk(e) && conflictOk(e));

  // 担当者別・日表示の行: 店舗の所属メンバー + その店舗の予定に入っている他店舗の応援者
  const activeUsers = db.users.filter((u) => u.active);
  const helpers = new Set(shown.filter((e) => storeFilter && e.storeId === storeFilter).flatMap((e) => e.assigneeIds));
  const rowUsers: CalUser[] = (userParam ? activeUsers.filter((u) => u.id === userParam) : activeUsers.filter((u) => !storeFilter || u.storeId === storeFilter || helpers.has(u.id))).map((u) => ({ id: u.id, name: u.name, title: u.title, storeId: u.storeId }));
  const rowIds = new Set(rowUsers.map((u) => u.id));
  const personEvents = inRange.filter((e) => kindOk(e) && conflictOk(e));

  const shownIds = new Set(shown.map((e) => e.id));
  const relevantPairs = pairs.filter((p) => p.day >= from && p.day <= to && (userParam ? p.userId === userParam : !storeFilter || rowIds.has(p.userId) || shownIds.has(p.aId) || shownIds.has(p.bId)));

  const resolver = createCaseResolver(db);
  const caseCache = new Map<string, CaseRef | undefined>();
  const addBase = (p: { date: string; user?: string; start?: string }) => {
    const q = new URLSearchParams({ date: p.date });
    if (p.user) q.set("user", p.user);
    if (p.start) q.set("start", p.start);
    if (storeFilter) q.set("store", storeFilter);
    q.set("returnTo", here);
    return `/schedule/new?${q.toString()}`;
  };
  const ctx: CalendarContext = {
    today,
    nowMinutes: now.getHours() * 60 + now.getMinutes(),
    stores: new Map(db.stores.map((s) => [s.id, s])),
    users: new Map(db.users.map((u) => [u.id, { id: u.id, name: u.name, title: u.title, storeId: u.storeId }])),
    byId: new Map(inRange.map((e) => [e.id, e])),
    conflicts: byEvent,
    caseOf: (e) => {
      if (!caseCache.has(e.id)) caseCache.set(e.id, resolver.ofEvent(e));
      return caseCache.get(e.id);
    },
    showStore: !storeFilter,
    addHref: addBase,
    dayHref: (d) => link({ view: "day", date: d }),
    closedDays: new Set(db.holidays.map((h) => h.date)),
  };

  const storeTabs = [
    { href: link({ store: "all" }), label: "全社", count: inRange.filter((e) => kindOk(e) && userOk(e)).length },
    ...db.stores.map((s) => ({ href: link({ store: s.id }), label: s.name, count: inRange.filter((e) => kindOk(e) && userOk(e) && (e.storeId === s.id || e.companyWide)).length })),
  ];
  const caseCount = shown.filter((e) => SCHEDULE_KIND[e.kind].group === "case").length;
  const users = activeUsers;
  const filtered = Boolean(userParam || kindParam || onlyConflicts);
  const storeName = storeFilter ? db.stores.find((s) => s.id === storeFilter)?.name : "全社";

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader
        title="予定表"
        icon={<CalendarDays />}
        actions={
          <>
            <LinkButton href={link({ user: "me", store: "all", view: view === "month" ? "list" : view })} variant="secondary" size="sm">
              <UserRound />
              自分の予定
            </LinkButton>
            <LinkButton href={addBase({ date: anchor >= today ? anchor : today })} size="sm">
              <Plus />
              予定を追加
            </LinkButton>
          </>
        }
      />

      <LinkTabs items={storeTabs} current={link({ store: storeParam })} />

      <div className="mb-3 flex flex-col gap-3 @5xl:flex-row @5xl:items-center @5xl:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <nav aria-label="表示の切り替え" className="inline-flex rounded-xl border border-line bg-subtle/80 p-1">
            {VIEWS.map((v) => (
              <Link
                key={v.id}
                href={link({ view: v.id })}
                title={v.hint}
                aria-current={v.id === view ? "page" : undefined}
                className={clsx("inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm whitespace-nowrap transition", v.id === view ? "bg-panel font-medium text-ink shadow-xs" : "text-ink-2 hover:text-ink")}
              >
                <v.icon className="h-4 w-4" aria-hidden />
                {v.label}
              </Link>
            ))}
          </nav>
          <div className="inline-flex items-center gap-1">
            <Link href={link({ date: prev })} aria-label="前の期間" className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-line bg-panel text-ink-2 hover:bg-subtle hover:text-ink">
              <ChevronLeft className="h-4 w-4" />
            </Link>
            <Link href={link({ date: today })} className="inline-flex h-9 items-center rounded-lg border border-line bg-panel px-3 text-sm text-ink hover:bg-subtle">
              今日
            </Link>
            <Link href={link({ date: next })} aria-label="次の期間" className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-line bg-panel text-ink-2 hover:bg-subtle hover:text-ink">
              <ChevronRight className="h-4 w-4" />
            </Link>
          </div>
          <h2 className="text-base font-semibold tracking-tight text-ink">{periodTitle}</h2>
        </div>

        <form method="get" action="/schedule" className="flex flex-wrap items-center gap-2" aria-label="予定の絞り込み">
          <input type="hidden" name="view" value={view} />
          <input type="hidden" name="store" value={storeParam} />
          <input type="date" name="date" defaultValue={anchor} aria-label="表示する日付" className="field h-9 w-auto py-1" />
          <select name="user" defaultValue={sp.user === "me" ? "me" : userParam} aria-label="担当者" className="field h-9 w-auto py-1">
            <option value="">全員</option>
            <option value="me">自分 ({user.name})</option>
            {db.stores.map((s) => (
              <optgroup key={s.id} label={s.name}>
                {users
                  .filter((u) => u.storeId === s.id)
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
          <select name="kind" defaultValue={kindParam} aria-label="種別" className="field h-9 w-auto py-1">
            <option value="">すべての種別</option>
            <option value="case">{SCHEDULE_GROUP_LABEL.case} のみ</option>
            <option value="internal">{SCHEDULE_GROUP_LABEL.internal} のみ</option>
            {SCHEDULE_KINDS.map((k) => (
              <option key={k} value={k}>
                {SCHEDULE_KIND[k].label}
              </option>
            ))}
          </select>
          <label className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-panel px-2.5 text-sm text-ink-2">
            <input type="checkbox" name="conflicts" value="1" defaultChecked={onlyConflicts} className="h-4 w-4 accent-[#d03b3b]" />
            重複のみ
          </label>
          <button type="submit" className="inline-flex h-9 items-center rounded-lg border border-line bg-panel px-3 text-sm font-medium text-ink hover:bg-subtle">
            表示
          </button>
          {filtered && (
            <Link href={link({ user: "", kind: "", conflicts: "" })} className="text-xs text-ink-3 hover:text-ink">
              絞り込みを解除
            </Link>
          )}
        </form>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-2">
        <span>
          <span className="font-semibold text-ink">{storeName}</span>のカレンダー · 予定 <span className="font-semibold text-ink tnum">{shown.length}</span> 件 (案件 {caseCount} · 社内・その他 {shown.length - caseCount})
        </span>
        {userParam && <span>担当者: {db.users.find((u) => u.id === userParam)?.name}</span>}
        {relevantPairs.length > 0 ? (
          <a href="#conflicts" className="inline-flex items-center gap-1 rounded-full bg-critical-soft px-2 py-0.5 font-medium text-critical-ink hover:underline">
            <TriangleAlert className="h-3.5 w-3.5" aria-hidden />
            担当者の予定の重複 {relevantPairs.length} 件
          </a>
        ) : (
          <span className="text-good-ink">重複なし</span>
        )}
        {(view === "staff" || view === "day") && storeFilter && <span className="text-ink-3">所属メンバーと応援者の予定をすべて表示しています</span>}
      </div>

      {view === "month" && <MonthView days={days} month={anchor.slice(0, 7)} events={shown} ctx={ctx} />}
      {view === "week" && <WeekView days={days} events={shown} ctx={ctx} />}
      {view === "staff" && <StaffView days={days} rows={rowUsers} events={personEvents} unassigned={userParam ? [] : shown.filter((e) => e.assigneeIds.length === 0 && !e.companyWide)} ctx={ctx} />}
      {view === "day" && <DayView day={anchor} rows={rowUsers} events={personEvents} unassigned={shown.filter((e) => e.assigneeIds.length === 0 && occursOn(e, anchor))} ctx={ctx} />}
      {view === "list" && <ListView days={days} events={shown} ctx={ctx} />}

      <div className="mt-6 grid grid-cols-1 gap-4 @4xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div id="conflicts" className="scroll-mt-24">
          <Card>
            <CardHeader
              title="担当者の予定の重複"
              description={`${shortDate(from)}〜${shortDate(to)} · 同じ社員に時間帯の重なる予定が入っている組み合わせ (同じ案件の予定どうしは除く)`}
              icon={<TriangleAlert />}
              action={relevantPairs.length > 0 && !onlyConflicts ? <Link href={link({ conflicts: "1", view: "list" })} className="text-xs font-medium text-accent hover:underline">重複のみ表示</Link> : undefined}
            />
            <ConflictList pairs={relevantPairs} ctx={ctx} moreHref={link({ conflicts: "1", view: "list" })} />
          </Card>
        </div>
        <Card>
          <CardHeader title="凡例・使い方" />
          <KindLegend />
          <ul className="mt-4 space-y-1.5 text-xs leading-relaxed text-ink-2">
            <li>・予定はすべての社員が全店舗分を閲覧できます。上のタブで店舗ごとのカレンダーに切り替えます (全社共通の予定はどの店舗にも表示)。</li>
            <li>・現地調査・採寸・引き取り・納品・施工・顧客訪問は、問い合わせ・見積・受注の画面の「この案件の予定」から登録すると案件に紐づきます。受注の施工予定は「施工」の予定と連動します。</li>
            <li>・「担当者別」「日」は人員配置の確認用です。空いている欄の「＋」から、その社員・その日の予定を追加できます。</li>
            <li>・<span className="font-medium text-critical-ink">重複</span> は同じ社員に時間の重なる予定があることを示します。登録時にも確認され、承知のうえで登録した場合のみ残ります。</li>
          </ul>
        </Card>
      </div>
    </div>
  );
}
