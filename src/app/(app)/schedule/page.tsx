import Link from "@/components/ui/Link";
import clsx from "clsx";
import { CalendarDays, CalendarOff, ChartGantt, ChevronLeft, ChevronRight, Columns3, Factory, FileSpreadsheet, Gauge, LayoutGrid, List, Plus, Route, Rows3, TriangleAlert, UserRound } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { defaultScheduleStore } from "@/lib/schedule-default";
import type { ScheduleEvent, ScheduleKind, StoreId } from "@/lib/db/types";
import { canAccessStore, canImportScheduleSheet, canManageSettings, canViewCompanySchedule } from "@/lib/auth/permissions";
import { redirect } from "next/navigation";
import { createCaseResolver, orderEditable, type CaseRef } from "@/lib/db/schedule";
import { isHandoverEvent } from "@/lib/db/handover-events";
import { usesHandoverPlan } from "@/lib/handover-save";
import { addMonths, analyzeConflicts, dateRange, isDateKey, longDate, monthEnd, monthStart, occursOn, overlapsRange, shortDate, weekStart } from "@/lib/calendar";
import { addDays, toDateKey } from "@/lib/format";
import { SCHEDULE_GROUP_LABEL, SCHEDULE_KIND, SCHEDULE_KINDS } from "@/lib/constants";
import { Card, CardHeader, Flash, LinkButton, LinkTabs, PageHeader } from "@/components/ui";
import { ConflictList, DayView, ListView, MonthView, ProductionLink, StaffView, WeekView, type CalendarContext, type CalUser } from "@/components/schedule/CalendarViews";
import { scheduleWork } from "@/lib/schedule-work";
import { workDescription, workTokens } from "@/lib/work-summary";
import { productionByDay, productionRows } from "@/lib/production/plan";
import { KindLegend } from "@/components/schedule/parts";
import { activeHolds } from "@/lib/scheduling/context";
import { holidayResolver } from "@/lib/holiday-calendar";
import { expireHoldsNow } from "@/lib/actions/scheduling";
import { eventLabeler } from "@/lib/schedule-label";
import { EventQuickHost } from "@/components/schedule/EventQuick";
import { ScheduleFinder } from "@/components/schedule/ScheduleFinder";
import { initialsByUser } from "@/lib/schedule-sheet/initials";
import { DaySheetView } from "@/components/schedule/DaySheet";
import { buildStoreSheet, carrySeries, carryStart, readDayLoadSettings, storeLoadOf, type CarryIn, type DayLoad, type StoreSheet } from "@/lib/day-sheet";
import { isClosedDay } from "@/lib/schedule-capacity";

type View = "month" | "week" | "staff" | "day" | "list";

const VIEWS: { id: View; label: string; icon: typeof LayoutGrid; hint: string }[] = [
  { id: "month", label: "月", icon: LayoutGrid, hint: "1 か月の予定" },
  { id: "week", label: "週", icon: Columns3, hint: "1 週間の予定" },
  { id: "staff", label: "担当者別", icon: Rows3, hint: "社員ごとの 1 週間 (人員配置)" },
  { id: "day", label: "日", icon: ChartGantt, hint: "店舗ごとの 1 日の予定表 (スプレッドシートの形・作業量)" },
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
  // 店舗: 指定がなければ初期表示 = 所属店舗だけ (管理者・本部の所属は全社)。タブでほかの店舗・全社に切り替えられる (src/lib/schedule-default.ts)
  const storeParam = sp.store === "all" || db.stores.some((s) => s.id === sp.store) ? (sp.store as string) : defaultScheduleStore(db, user);
  const storeFilter = storeParam === "all" ? undefined : (storeParam as StoreId);
  const userParam = sp.user === "me" ? user.id : sp.user && db.users.some((u) => u.id === sp.user) ? sp.user : "";
  const kindParam = sp.kind === "case" || sp.kind === "internal" || SCHEDULE_KINDS.includes(sp.kind as ScheduleKind) ? (sp.kind as string) : "";
  const onlyConflicts = sp.conflicts === "1";
  // 日の表示の形: sheet = 店舗ごとの予定表 (スプレッドシートの形。既定。お客様のご要望 2026-11-25) / staff = 担当者 × 時間
  const layout = sp.layout === "staff" ? "staff" : "sheet";

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

  const link = (over: Partial<Record<"view" | "date" | "store" | "user" | "kind" | "conflicts" | "layout", string>> = {}) => {
    const m = { view, date: anchor, store: storeParam, user: sp.user === "me" ? "me" : userParam, kind: kindParam, conflicts: onlyConflicts ? "1" : "", layout: layout === "staff" ? "staff" : "", ...over };
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(m)) if (v) p.set(k, v);
    return `/schedule?${p.toString()}`;
  };
  const here = link();

  // 期間内の全予定。重複は店舗・担当者の絞り込みに関係なく全社の予定で判定する
  // 仮押さえ (点線で表示。押すと計画の画面) も同じ予定表に重ねる
  await expireHoldsNow().catch(() => 0);
  const holdEvents: ScheduleEvent[] = activeHolds(db, now)
    .filter((h) => overlapsRange(h, from, to))
    .map((h) => ({ id: `hold:${h.id}`, title: `[仮${h.rank > 1 ? ` 第${h.rank}候補` : ""}] ${h.title}`, kind: h.kind, date: h.date, endDate: h.endDate, startTime: h.startTime, endTime: h.endTime, slot: h.slot, storeId: h.storeId, assigneeIds: h.assigneeIds, customerId: h.customerId, inquiryId: h.inquiryId, quoteId: h.quoteId, orderId: h.orderId, location: h.location, memo: h.memo, source: "manual" }));
  const inRange = [...db.schedule.filter((e) => overlapsRange(e, from, to)), ...holdEvents];
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
  // 仕事内容と数量 (「タ12 フ6 シ4 ア2」。お客様のご要望 2026-11-23「■2」) と、日ごとの畳製造予定 (「■3」)
  const work = scheduleWork(db, inRange);
  const tokenCache = new Map<string, ReturnType<typeof workTokens>>();
  // 件名「（町名）お客様」(現場の町名・ひも付けた顧客のお名前。お客様のご要望 2026-11-24「■1」「■3」)
  const labeler = eventLabeler(db);
  const labelCache = new Map<string, string>();
  const production = productionRows(db, { from, to, today }).filter((r) => !storeFilter || r.storeId === storeFilter);
  const productionDays = productionByDay(production.filter((r) => r.date && r.date >= from && r.date <= to));
  const productionHref = (d: string) => `/schedule/production?date=${d}&days=1${storeFilter ? `&store=${storeFilter}` : ""}`;
  // 担当者の略称 (予定表のスプレッドシートと同じ 1 文字。お客様のご要望 2026-11-24「⑥」)
  const initials = initialsByUser(db.users.filter((u) => u.active));
  // 1 日の作業量と対応可能枚数 (対象人数 × 11 枚。お客様のご要望 2026-11-25「日ごとの予定表の表示形式と作業量の集計」。src/lib/day-sheet.ts)
  const loadSet = readDayLoadSettings(db);
  const leaveEvents = inRange.filter((e) => e.kind === "leave");
  const loadStore = storeFilter && db.stores.find((s) => s.id === storeFilter)?.kind !== "hq" ? storeFilter : undefined;
  // 前日繰越 (前日の超過分を翌日に。お客様のご要望 2026-11-25 の補足「③」): 繰り越しを数え始める日から表示の期間の前日までの予定も読む
  const carryStores: StoreId[] =
    view === "day" && layout === "sheet"
      ? (storeFilter ? [storeFilter] : db.stores.map((s) => s.id)).filter((id) => db.stores.find((s) => s.id === id)?.kind !== "hq")
      : loadStore && (view === "week" || view === "month")
        ? [loadStore]
        : [];
  const chainFirst = carryStores
    .map((id) => carryStart(loadSet, id, from))
    .filter((d): d is string => Boolean(d))
    .sort()[0];
  const inRangeIds = new Set(inRange.map((e) => e.id));
  const earlier = chainFirst && chainFirst < from ? db.schedule.filter((e) => !inRangeIds.has(e.id) && overlapsRange(e, chainFirst, addDays(from, -1))) : [];
  const chainEvents = [...inRange.filter((e) => !e.id.startsWith("hold:")), ...earlier];
  const chainWork = earlier.length ? new Map([...work, ...scheduleWork(db, earlier)]) : work;
  const chainLeaves = chainEvents.filter((e) => e.kind === "leave");
  const loadOfStore = new Map(
    carryStores.map((id) => [
      id,
      storeLoadOf({ db, set: loadSet, storeId: id, events: chainEvents.filter((e) => e.storeId === id && !e.companyWide), leaves: chainLeaves, work: chainWork, closed: (d) => isClosedDay(db, d) }),
    ]),
  );
  const carryOf = new Map<StoreId, Map<string, CarryIn>>(carryStores.map((id) => [id, carrySeries({ set: loadSet, storeId: id, from, to, loadOf: loadOfStore.get(id)! })]));
  const loadCache = new Map<string, DayLoad | undefined>();
  const ctx: CalendarContext = {
    today,
    nowMinutes: now.getHours() * 60 + now.getMinutes(),
    stores: new Map(db.stores.map((s) => [s.id, s])),
    users: new Map(db.users.map((u) => [u.id, { id: u.id, name: u.name, title: u.title, storeId: u.storeId, initial: initials.get(u.id) }])),
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
    holidayOf: holidayResolver(db),
    workOf: (e) => {
      if (!tokenCache.has(e.id)) tokenCache.set(e.id, workTokens(work.get(e.id)));
      return tokenCache.get(e.id);
    },
    workTextOf: (e) => workDescription(work.get(e.id)) || undefined,
    production: { byDay: productionDays, href: productionHref },
    labelOf: (e) => {
      if (!labelCache.has(e.id)) labelCache.set(e.id, labeler.label(e).text);
      return labelCache.get(e.id)!;
    },
    loadOf:
      loadStore && (view === "week" || view === "month")
        ? (d) => {
            if (!loadCache.has(d)) {
              const l = loadOfStore.get(loadStore)?.(d);
              const carry = carryOf.get(loadStore)?.get(d)?.value ?? 0;
              const total = l ? Math.round((l.dayWorkload + carry) * 10) / 10 : 0;
              loadCache.set(d, l && { ...l, carry, workload: total, over: Math.max(0, Math.round((total - l.capacity) * 10) / 10) });
            }
            return loadCache.get(d);
          }
        : undefined,
  };
  // 日の表示 (店舗ごとの予定表): 店舗を選んでいればその店舗、全社なら 4 店舗 (本部は予定があるときだけ)
  const sheets: StoreSheet[] =
    view === "day" && layout === "sheet"
      ? (storeFilter ? db.stores.filter((s) => s.id === storeFilter) : db.stores)
          .map((s) =>
            buildStoreSheet({
              day: anchor,
              storeId: s.id,
              events: shown.filter((e) => e.storeId === s.id && !e.companyWide && occursOn(e, anchor)),
              capacityEvents: leaveEvents,
              work,
              label: (e) => {
                const l = labeler.label(e);
                return { area: l.area, name: l.name };
              },
              set: loadSet,
              db,
              closed: isClosedDay(db, anchor),
              carry: carryOf.get(s.id)?.get(anchor),
            }),
          )
          .filter((sh) => storeFilter || db.stores.find((s) => s.id === sh.storeId)?.kind !== "hq" || sh.rows.length > 0)
      : [];

  const storeTabs = [
    { href: link({ store: "all" }), label: "全社", count: inRange.filter((e) => kindOk(e) && userOk(e)).length },
    ...db.stores.map((s) => ({ href: link({ store: s.id }), label: s.name, count: inRange.filter((e) => kindOk(e) && userOk(e) && (e.storeId === s.id || e.companyWide)).length })),
  ];
  const caseCount = shown.filter((e) => SCHEDULE_KIND[e.kind].group === "case").length;
  const users = activeUsers;
  const filtered = Boolean(userParam || kindParam || onlyConflicts);
  const storeName = storeFilter ? db.stores.find((s) => s.id === storeFilter)?.name : "全社";
  // 畳・襖などで、まだ以前の形 (施工期間の「施工」の予定) のまま載っている受注 → 受注の画面の「引取・納品の日程」で保存すると切り替わる
  const legacyOrders = [
    ...new Map(
      db.schedule
        .filter((e) => e.source === "order" && e.orderId && !isHandoverEvent(e) && (e.endDate ?? e.date) >= today && (!storeFilter || e.storeId === storeFilter))
        .map((e) => db.orders.find((o) => o.id === e.orderId))
        .filter((o): o is NonNullable<typeof o> => Boolean(o && !o.handovers?.length && orderEditable(o) && canAccessStore(user, o.storeId) && usesHandoverPlan(db, o)))
        .map((o) => [o.id, o] as const),
    ).values(),
  ];

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
            <LinkButton href={`/schedule/production?date=${view === "day" ? anchor : from >= today || view === "list" ? from : today}${view === "day" ? "&days=1" : ""}${storeFilter ? `&store=${storeFilter}` : ""}`} variant="secondary" size="sm">
              <Factory />
              畳製造予定
            </LinkButton>
            <LinkButton href="/schedule/planning" variant="secondary" size="sm">
              <Route />
              計画・最適化
            </LinkButton>
            <LinkButton href="/schedule/holidays" variant="secondary" size="sm">
              <CalendarOff />
              休日カレンダー
            </LinkButton>
            <LinkButton href="/schedule/capacity" variant="secondary" size="sm">
              <Gauge />
              仕事量と提案の設定
            </LinkButton>
            {canImportScheduleSheet(user) && (
              <LinkButton href="/schedule/import" variant="secondary" size="sm">
                <FileSpreadsheet />
                スプレッドシートの取込
              </LinkButton>
            )}
            <LinkButton href={addBase({ date: anchor >= today ? anchor : today })} size="sm">
              <Plus />
              予定を追加
            </LinkButton>
          </>
        }
      />

      <LinkTabs items={storeTabs} current={link({ store: storeParam })} />

      {/* 予定表の検索と、場所からの候補日 (お客様のご要望 2026-11-25。src/lib/schedule-find.ts) */}
      <ScheduleFinder stores={db.stores.filter((s) => s.kind !== "hq").map((s) => ({ id: s.id, name: s.name }))} initialFind={sp.find} findCase={sp.findCase} />

      {legacyOrders.length > 0 && (
        <p className="mb-3 rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn-ink" data-testid="handover-legacy">
          畳・襖などの受注 {legacyOrders.length} 件が、まだ施工期間 (間の日にも表示) のまま載っています。受注の画面の「引取・納品の日程」で日程を確かめて保存すると、引き取りの日・納品の日だけの表示になります:{" "}
          {legacyOrders.slice(0, 8).map((o, i) => (
            <span key={o.id}>
              {i > 0 && "、"}
              <Link href={`/orders/${o.id}`} className="font-medium underline">
                {db.customers.find((c) => c.id === o.customerId)?.name ?? o.number} 様
              </Link>
            </span>
          ))}
          {legacyOrders.length > 8 && ` ほか ${legacyOrders.length - 8} 件`}
        </p>
      )}

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
          {layout === "staff" && <input type="hidden" name="layout" value="staff" />}
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

      {/* 予定を押すと、予定表の上で日時・内容・種類を変えられる (お客様のご要望 2026-11-24「■4」) */}
      <EventQuickHost key={sp.qe ?? "_"}>
      {view === "month" && <MonthView days={days} month={anchor.slice(0, 7)} events={shown} ctx={ctx} />}
      {view === "week" && <WeekView days={days} events={shown} ctx={ctx} />}
      {view === "staff" && <StaffView days={days} rows={rowUsers} events={personEvents} unassigned={userParam ? [] : shown.filter((e) => e.assigneeIds.length === 0 && !e.companyWide)} ctx={ctx} />}
      {view === "day" && productionDays.get(anchor) && (
        <div className="mb-2">
          <ProductionLink ctx={ctx} day={anchor} variant="day" />
        </div>
      )}
      {view === "day" && (
        <nav aria-label="日の表示の形" className="mb-2 inline-flex rounded-xl border border-line bg-subtle/80 p-1 text-sm">
          {(
            [
              { id: "sheet", label: "店舗の予定表 (午前・午後 / 引取・納品)" },
              { id: "staff", label: "担当者 × 時間" },
            ] as const
          ).map((l) => (
            <Link key={l.id} href={link({ layout: l.id === "staff" ? "staff" : "" })} aria-current={layout === l.id ? "page" : undefined} className={clsx("rounded-lg px-2.5 py-1 whitespace-nowrap transition", layout === l.id ? "bg-panel font-medium text-ink shadow-xs" : "text-ink-2 hover:text-ink")}>
              {l.label}
            </Link>
          ))}
        </nav>
      )}
      {view === "day" && layout === "sheet" && (
        <DaySheetView
          sheets={sheets}
          ctx={ctx}
          set={loadSet}
          companyWide={shown.filter((e) => e.companyWide && occursOn(e, anchor))}
          addHref={(storeId) => {
            const q = new URLSearchParams({ date: anchor >= today ? anchor : today, store: storeId, returnTo: here });
            return `/schedule/new?${q.toString()}`;
          }}
          settingsHref={canManageSettings(user) ? "/schedule/capacity?tab=dayload" : undefined}
          filtered={Boolean(userParam || kindParam || onlyConflicts)}
          day={anchor}
          returnTo={here}
          canFixCarry={(id) => canAccessStore(user, id)}
        />
      )}
      {view === "day" && layout === "staff" && <DayView day={anchor} rows={rowUsers} events={personEvents} unassigned={shown.filter((e) => e.assigneeIds.length === 0 && occursOn(e, anchor))} ctx={ctx} />}
      {view === "list" && <ListView days={days} events={shown} ctx={ctx} />}
      </EventQuickHost>

      <div className="mt-6 grid grid-cols-1 gap-4 @4xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div id="conflicts" className="scroll-mt-24">
          <Card>
            <CardHeader
              title="担当者の予定の重複"
              description={`${shortDate(from)}〜${shortDate(to)} · 同じ社員に時間帯の重なる予定が入っている組み合わせ (同じ案件の予定どうしは除く)`}
              icon={<TriangleAlert />}
              action={relevantPairs.length > 0 && !onlyConflicts ? <Link href={link({ conflicts: "1", view: "list" })} className="text-xs font-medium text-accent hover:underline">重複のみ表示</Link> : undefined}
            />
            <EventQuickHost key={sp.qe ?? "_"} fromUrl={false}>
              <ConflictList pairs={relevantPairs} ctx={ctx} moreHref={link({ conflicts: "1", view: "list" })} />
            </EventQuickHost>
          </Card>
        </div>
        <Card>
          <CardHeader title="凡例・使い方" />
          <KindLegend />
          <ul className="mt-4 space-y-1.5 text-xs leading-relaxed text-ink-2">
            <li>・<span className="font-semibold text-ink">予定を押すと、予定表の上で地図 (Google マップ・住宅地図)・担当者 (最大 4 名)・納品予定 (引取・現見の予定) と、日時・内容・種類 (アイコン) を変えられます</span> (お客様の電話・住所もここで確かめられます)。場所・案件は「詳しく変更」、別の画面で開くときは Ctrl (Mac は ⌘) を押しながら。</li>
            <li>・チップの丸の文字は担当者の略称 (予定表のスプレッドシートと同じ 1 文字)、丸の色はその人の店舗の色です (ほかの店舗の応援が分かります)。丸に指を合わせると名前が出ます。</li>
            <li>・件名の頭の「（築地）」は現場の町名です (施工場所 → 問い合わせで聞いた住所 → お客様の住所。業者の案件はお客様の住所を使いません)。</li>
            <li>・予定の左の色のアイコンが種類 (引き取り・納品・見積・現調 (現地調査)・現見 (現場見積)・顧客訪問など)、その右が店舗名 (全社の表示のとき)。お客様の名前の右は仕事内容と数量です (タ = 畳・フ = 襖・シ = 障子・ア = 網戸。<span className="font-semibold text-critical-ink">(縁無)</span> はへり無し畳)。受注の見積の明細、移行した予定表の枚数、メモの「タ6フ1」から表示します。</li>
            <li>・日の見出しの「<span className="font-semibold">製 タ12</span>」はその日の畳製造予定 (押すとその日の製造予定。繰り越し・製造日未定・製造済みを記録できます)。</li>
            <li>・予定はすべての社員が全店舗分を閲覧できます。上のタブで店舗ごとのカレンダーに切り替えます (全社共通の予定はどの店舗にも表示)。</li>
            <li>・現地調査・採寸・引き取り・納品・施工・顧客訪問は、問い合わせ・見積・受注の画面の「この案件の予定」から登録すると案件に紐づきます。受注の施工予定は「施工」の予定と連動します。</li>
            <li>・「日」は店舗ごとの予定表 (スプレッドシートと同じ形: 左 = 引取・見積・現調・会議など / 右 = 納品、上 = 午前 / 下 = 午後) です。畳・襖・障子・網戸の「表」は表替え・張替え、「新」は新調。一番下にその日の枚数の合計・換算作業量 (畳 + 襖 + 障子 × 0.5 + 網戸 × 0.5)・対応可能枚数 (対象人数 × 11 枚) と、超えた枚数を出します。店舗を選んだ週・月の表示では日ごとに「作業 18/22」(超えた日は赤) を出します。</li>
            <li>・「担当者別」と日の「担当者 × 時間」は人員配置の確認用です。空いている欄の「＋」から、その社員・その日の予定を追加できます。</li>
            <li>・<span className="font-medium text-critical-ink">重複</span> は同じ社員に時間の重なる予定があることを示します。登録時にも確認され、承知のうえで登録した場合のみ残ります。</li>
          </ul>
        </Card>
      </div>
    </div>
  );
}
