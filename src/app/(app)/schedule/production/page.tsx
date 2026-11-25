import Link from "@/components/ui/Link";
import clsx from "clsx";
import { CalendarDays, CalendarX2, Check, ChevronLeft, ChevronRight, Factory, Plus, RotateCcw, TriangleAlert, Undo2 } from "lucide-react";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import type { Store, StoreId } from "@/lib/db/types";
import { canEditProduction, canViewCompanySchedule } from "@/lib/auth/permissions";
import { dateRange, dayOfWeek, isDateKey, longDate, shortDate } from "@/lib/calendar";
import { addDays, toDateKey } from "@/lib/format";
import { Button, Card, CardHeader, Field, Flash, Input, LinkButton, LinkTabs, Note, PageHeader, Select, Textarea } from "@/components/ui";
import { addProduction, deleteProduction, saveProductionRooms, updateProduction } from "@/lib/actions/production";
import { TatamiRoomsTable, pendingRoomCount } from "@/components/schedule/TatamiRoomsTable";
import { TatamiRoomsEditor } from "@/components/schedule/TatamiRoomsEditor";
import { roomsFromSheetMemo } from "@/lib/tatami-spec";
import { quoteRooms } from "@/lib/tatami-rooms";
import { carryTarget, productionByDay, productionMaterials, productionRows, productionView, type ProductionRow } from "@/lib/production/plan";
import { productionTableReady } from "@/lib/production/tables";

/**
 * 畳製造予定 (お客様のご要望 2026-11-23「■3. 畳製造予定表」)
 * いつ・どの店舗の・どの案件 (仕様) で・何畳を製造するか。受注の引取日・採寸日と予定表の引き取りから自動で入り、
 * 翌日への繰り越し・製造日の変更・製造日未定・製造済みを記録する (予定表の引取日・納品日は変えない)
 */

type SP = Record<string, string | undefined>;

const STATUS_STYLE = {
  planned: "bg-info-soft text-info-ink",
  done: "bg-good-soft text-good-ink",
  undecided: "bg-warn-soft text-warn-ink",
} as const;

function num(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** 使う材料 (畳表・畳縁・畳床の畳数。部屋ごとの仕様から。縁の在庫は縁在庫の画面) */
function Materials({ rows, title }: { rows: ProductionRow[]; title?: string }) {
  const m = productionMaterials(rows);
  const part = (label: string, xs: { name: string; qty: number }[]) =>
    xs.length ? (
      <span>
        <span className="text-ink-3">{label}</span> {xs.map((x) => `${x.name} ${num(x.qty)}`).join("・")}
      </span>
    ) : null;
  if (!m.omote.length && !m.heri.length && !m.doko.length && !m.herinashi && !m.unknown) return null;
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-line bg-subtle/40 px-4 py-1.5 text-[11px] text-ink-2" data-testid="production-materials">
      <span className="font-medium text-ink">{title ?? "使う材料"}</span>
      {part("畳表", m.omote)}
      {part("畳縁", m.heri)}
      {m.herinashi > 0 && <span className="text-critical-ink">縁無 {num(m.herinashi)}</span>}
      {part("畳床 (新調)", m.doko)}
      {m.unknown > 0 && <span className="text-warn-ink">仕様の未確認 {num(m.unknown)}</span>}
      <Link href="/heri" className="ml-auto text-accent hover:underline">
        縁の在庫
      </Link>
    </div>
  );
}

function Totals({ rows, compact = false }: { rows: ProductionRow[]; compact?: boolean }) {
  const qty = rows.reduce((a, r) => a + r.qty, 0);
  const herinashi = rows.filter((r) => r.herinashiSeen);
  const open = rows.filter((r) => r.status === "planned").length;
  const pending = rows.filter((r) => r.status === "planned" && pendingRoomCount(r.rooms) > 0).length;
  return (
    <span className={clsx("inline-flex flex-wrap items-center gap-x-2 gap-y-0.5", compact ? "text-[11px]" : "text-xs")}>
      <span className="font-semibold text-ink tnum">{rows.length} 件</span>
      <span className="font-semibold text-ink tnum">タ{num(qty)}</span>
      {herinashi.length > 0 && <span className="font-semibold text-critical-ink">縁無 {herinashi.length} 件</span>}
      {open < rows.length && <span className="text-ink-3">済 {rows.length - open} 件</span>}
      {pending > 0 && <span className="font-semibold text-warn-ink">仕様の未確認 {pending} 件</span>}
    </span>
  );
}

const ROOMS_SOURCE: Record<ProductionRow["roomsSource"], string> = {
  order: "受注で入れた仕様",
  quote: "見積で入れた仕様",
  record: "製造予定で入れた仕様",
  auto: "見積の明細から自動 (確かめて直してください)",
  sheet: "予定表の製造の表から",
  count: "仕様は未入力 (畳数だけ)",
};

/** 「見積の明細から作り直す」の案 (受注の行は見積の明細、移行した予定表の行は製造の表) */
function autoRooms(db: ReturnType<typeof getDb>, r: ProductionRow) {
  if (r.roomsTarget.kind === "order") {
    const works = r.roomsTarget.works;
    const o = db.orders.find((x) => x.id === r.orderId);
    const q = o?.quoteId ? db.quotes.find((x) => x.id === o.quoteId) : undefined;
    return q ? quoteRooms(db, { items: q.items, siteInfo: o?.siteInfo ?? q.siteInfo }).rooms.filter((x) => works.includes(x.work)) : [];
  }
  const ev = r.eventId ? db.schedule.find((e) => e.id === r.eventId) : undefined;
  return ev ? roomsFromSheetMemo(ev.memo) : [];
}

function RowItem({ r, stores, editable, back, today, db }: { r: ProductionRow; stores: Map<StoreId, Store>; editable: boolean; back: string; today: string; db: ReturnType<typeof getDb> }) {
  const store = stores.get(r.storeId);
  const status = r.status === "done" ? "done" : r.mode === "undecided" ? "undecided" : "planned";
  const statusLabel = r.status === "done" ? (r.autoDone && r.record?.status !== "done" ? "済 (納品済み)" : "製造済み") : r.mode === "undecided" ? "製造日未定" : r.mode === "manual" ? "予定 (日付を変更)" : "予定";
  const carryTo = carryTarget(db, r.date, today);
  const hidden = (op: string) => (
    <>
      <input type="hidden" name="key" value={r.key} />
      <input type="hidden" name="op" value={op} />
      <input type="hidden" name="back" value={back} />
    </>
  );
  return (
    <li className={clsx("grid grid-cols-1 gap-x-4 gap-y-2 px-4 py-3 @3xl:grid-cols-[minmax(0,1fr)_minmax(0,auto)]", r.status === "done" && "bg-subtle/40")} data-testid="production-row">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={clsx("rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap", STATUS_STYLE[status])}>{statusLabel}</span>
          {store && (
            <span className="inline-flex items-center gap-1 text-xs whitespace-nowrap text-ink-2">
              <span className="h-2 w-2 rounded-full" style={{ background: store.color }} aria-hidden />
              {store.shortName}
            </span>
          )}
          {r.href ? (
            <Link href={r.href} className="font-medium text-ink hover:text-accent hover:underline">
              {r.name}
            </Link>
          ) : (
            <span className="font-medium text-ink">{r.name}</span>
          )}
          {r.orderNumber && <span className="text-[11px] text-ink-3">{r.orderNumber}</span>}
        </div>
        <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <span className={clsx("text-base font-semibold tnum", r.status === "done" ? "text-ink-2" : "text-ink")} data-testid="production-qty">
            {r.qty ? `${num(r.qty)}畳` : "畳数不明"}
            {r.herinashiSeen && (
              <span className="ml-1 rounded bg-critical-soft px-1 text-xs font-semibold text-critical-ink" title="へり無し畳 (製造に時間がかかります)">
                縁無{r.herinashiHalf ? "半" : ""}
                {r.herinashi && r.herinashi < r.qty ? ` ${num(r.herinashi)}` : ""}
              </span>
            )}
          </span>
          {r.work && <span className="text-xs text-ink-2">{r.work}</span>}
          {pendingRoomCount(r.rooms) > 0 && r.status === "planned" && <span className="rounded bg-warn-soft px-1.5 py-0.5 text-[11px] font-semibold text-warn-ink">仕様の未確認 {pendingRoomCount(r.rooms)} 部屋</span>}
        </div>
        <div className="mt-1.5">
          <TatamiRoomsTable rooms={r.rooms} dim={r.status === "done"} />
          <p className="mt-0.5 text-[11px] text-ink-3" data-testid="rooms-source">{ROOMS_SOURCE[r.roomsSource]}</p>
        </div>
        {r.roomsSource === "count" && r.spec && <p className="mt-0.5 text-xs break-words text-ink-2">明細: {r.spec}</p>}
        <p className="mt-0.5 text-[11px] text-ink-3">
          {r.baseDate ? `${r.baseLabel} ${shortDate(r.baseDate)}` : r.baseLabel === "手で追加" ? "手で追加した予定" : `${r.baseLabel}なし`}
          {r.deliveryDate && ` · 納品 ${shortDate(r.deliveryDate)}`}
          {r.mode === "manual" && r.date && ` · 製造日 ${shortDate(r.date)} (変更済み)`}
          {r.record?.note && ` · ${r.record.note}`}
        </p>
        {r.warnings.map((w) => (
          <p key={w} className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-warn-ink">
            <TriangleAlert className="h-3.5 w-3.5" aria-hidden />
            {w}
          </p>
        ))}
        {editable && (
          <details className="mt-2 rounded-lg border border-line bg-panel" data-testid="rooms-edit">
            <summary className="cursor-pointer px-3 py-1.5 text-xs font-medium text-accent-ink">仕様を入力・変更 (部屋ごとの畳表・畳縁・畳床・寸法)</summary>
            <div className="border-t border-line p-3">
              <TatamiRoomsEditor
                action={saveProductionRooms}
                initial={r.rooms}
                auto={autoRooms(db, r)}
                hidden={{ key: r.key, back }}
                works={r.roomsTarget.kind === "order" ? r.roomsTarget.works : undefined}
                idPrefix={`pr-${r.key.replace(/[^a-z0-9]/gi, "")}`}
                submitLabel={r.roomsTarget.kind === "order" ? "仕様を保存する (受注にも反映)" : "仕様を保存する"}
              />
            </div>
          </details>
        )}
      </div>
      {editable && (
        <div className="flex flex-wrap items-center gap-1.5 @3xl:justify-end">
          {r.status === "planned" && (
            <>
              <form action={updateProduction}>
                {hidden("carry")}
                <Button size="sm" variant="secondary" title={`製造日を ${shortDate(carryTo)} にします (引取日・納品日は変わりません)`}>
                  <ChevronRight />
                  {r.date && r.date < today ? "今日へ繰り越す" : `${shortDate(carryTo)} へ繰り越す`}
                </Button>
              </form>
              <form action={updateProduction} className="flex items-center gap-1">
                {hidden("date")}
                <input type="date" name="date" defaultValue={r.date ?? ""} required aria-label={`${r.name} の製造日`} className="field h-8 w-[9.5rem] py-1 text-xs" />
                <Button size="sm" variant="secondary">日付を変更</Button>
              </form>
              {r.mode !== "undecided" && (
                <form action={updateProduction}>
                  {hidden("undecided")}
                  <Button size="sm" variant="ghost" title="長期預かりなどで製造日が決まっていないとき">
                    <CalendarX2 />
                    未定にする
                  </Button>
                </form>
              )}
              {(r.mode === "manual" || (r.mode === "undecided" && r.baseDate)) && (
                <form action={updateProduction}>
                  {hidden("auto")}
                  <Button size="sm" variant="ghost" title={`製造日を${r.baseLabel} (${r.baseDate ? shortDate(r.baseDate) : "-"}) に戻します`}>
                    <Undo2 />
                    {r.baseLabel}に戻す
                  </Button>
                </form>
              )}
              <form action={updateProduction}>
                {hidden("done")}
                <Button size="sm" variant="soft">
                  <Check />
                  製造済み
                </Button>
              </form>
            </>
          )}
          {r.status === "done" && (r.record?.status === "done" || !r.autoDone) && (
            <form action={updateProduction}>
              {hidden("reopen")}
              <Button size="sm" variant="ghost">
                <RotateCcw />
                未製造に戻す
              </Button>
            </form>
          )}
          {r.source === "manual" && r.record && (
            <form action={deleteProduction}>
              <input type="hidden" name="id" value={r.record.id} />
              <input type="hidden" name="back" value={back} />
              <Button size="sm" variant="ghost" className="text-critical-ink">削除</Button>
            </form>
          )}
        </div>
      )}
    </li>
  );
}

export default async function ProductionPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const user = await requireUser();
  if (!canViewCompanySchedule(user)) redirect("/?err=" + encodeURIComponent("予定表を閲覧する権限がありません。"));
  const db = getDb();
  const today = toDateKey(new Date());
  const days = sp.days === "1" ? 1 : 7;
  const from = isDateKey(sp.date) ? sp.date : today;
  const to = addDays(from, days - 1);
  const storeParam = sp.store && db.stores.some((s) => s.id === sp.store) ? sp.store : "all";
  const storeFilter = storeParam === "all" ? undefined : (storeParam as StoreId);
  const editable = canEditProduction(user);
  const ready = productionTableReady();

  const link = (over: Partial<Record<"date" | "days" | "store", string>> = {}) => {
    const m = { date: from, days: String(days), store: storeParam, ...over };
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(m)) if (v && !(k === "store" && v === "all") && !(k === "days" && v === "7")) p.set(k, v);
    const qs = p.toString();
    return `/schedule/production${qs ? `?${qs}` : ""}`;
  };
  const back = link();

  const q = { from, to, today };
  const all = productionRows(db, q);
  const inStore = (r: ProductionRow) => !storeFilter || r.storeId === storeFilter;
  const view = productionView(all.filter(inStore), q);
  const stores = new Map(db.stores.map((s) => [s.id, s]));
  const byDay = productionByDay(all.filter(inStore).filter((r) => r.date && r.date >= from && r.date <= to));
  const storeTabs = [
    { href: link({ store: "all" }), label: "全社", count: all.filter((r) => r.status !== "cancelled" && r.date && r.date >= from && r.date <= to).length },
    ...db.stores
      .filter((s) => s.id !== "hq" || all.some((r) => r.storeId === "hq"))
      .map((s) => ({ href: link({ store: s.id }), label: s.name, count: all.filter((r) => r.storeId === s.id && r.status !== "cancelled" && r.date && r.date >= from && r.date <= to).length })),
  ];
  const periodTitle = days === 1 ? longDate(from) : `${shortDate(from)} 〜 ${shortDate(to)}`;
  const scheduleHref = `/schedule?view=${days === 1 ? "day" : "week"}&date=${from}${storeFilter ? `&store=${storeFilter}` : ""}`;

  return (
    <div>
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader
        title="畳製造予定"
        icon={<Factory />}
        description="いつ・どの店舗の・どの案件 (仕様) で・何畳を製造するか。受注の引取日・採寸日と予定表の引き取りから自動で入ります"
        actions={
          <>
            <LinkButton href={scheduleHref} variant="secondary" size="sm">
              <CalendarDays />
              予定表へ
            </LinkButton>
            {editable && (
              <LinkButton href="#add" size="sm">
                <Plus />
                製造の予定を追加
              </LinkButton>
            )}
          </>
        }
      />
      {!ready && <Note tone="warn">畳製造予定のテーブルがまだデータベースにありません。表示はできますが、繰り越し・製造済みなどの記録はデプロイ (テーブルの作成) のあとにできます。</Note>}

      <LinkTabs items={storeTabs} current={link({ store: storeParam })} />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <nav aria-label="表示の期間" className="inline-flex rounded-xl border border-line bg-subtle/80 p-1">
          {[
            { d: "1", label: "1日" },
            { d: "7", label: "1週間" },
          ].map((v) => (
            <Link key={v.d} href={link({ days: v.d })} aria-current={String(days) === v.d ? "page" : undefined} className={clsx("rounded-lg px-3 py-1.5 text-sm whitespace-nowrap", String(days) === v.d ? "bg-panel font-medium text-ink shadow-xs" : "text-ink-2 hover:text-ink")}>
              {v.label}
            </Link>
          ))}
        </nav>
        <div className="inline-flex items-center gap-1">
          <Link href={link({ date: addDays(from, -days) })} aria-label="前の期間" className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-line bg-panel text-ink-2 hover:bg-subtle hover:text-ink">
            <ChevronLeft className="h-4 w-4" />
          </Link>
          <Link href={link({ date: today })} className="inline-flex h-9 items-center rounded-lg border border-line bg-panel px-3 text-sm text-ink hover:bg-subtle">
            今日
          </Link>
          <Link href={link({ date: addDays(from, days) })} aria-label="次の期間" className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-line bg-panel text-ink-2 hover:bg-subtle hover:text-ink">
            <ChevronRight className="h-4 w-4" />
          </Link>
        </div>
        <form method="get" action="/schedule/production" className="flex items-center gap-1">
          <input type="hidden" name="days" value={days} />
          {storeFilter && <input type="hidden" name="store" value={storeFilter} />}
          <input type="date" name="date" defaultValue={from} aria-label="表示する日" className="field h-9 w-auto py-1" />
          <button type="submit" className="inline-flex h-9 items-center rounded-lg border border-line bg-panel px-3 text-sm text-ink hover:bg-subtle">
            表示
          </button>
        </form>
        <h2 className="text-base font-semibold tracking-tight text-ink">{periodTitle}</h2>
        <Totals rows={view.inRange} />
      </div>

      {view.overdue.length > 0 && (
        <Card className="mb-4 border-warn/40" padded={false}>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
            <div>
              <h3 className="flex items-center gap-1.5 text-sm font-semibold text-warn-ink">
                <TriangleAlert className="h-4 w-4" aria-hidden />
                前日までに製造済みになっていない予定 {view.overdue.length} 件
              </h3>
              <p className="mt-0.5 text-xs text-ink-2">終わっていれば「製造済み」、まだなら今日 (または別の日) へ繰り越してください。</p>
            </div>
            {editable && (
              <form action={updateProduction}>
                {view.overdue.map((r) => (
                  <input key={r.key} type="hidden" name="key" value={r.key} />
                ))}
                <input type="hidden" name="op" value="carry" />
                <input type="hidden" name="back" value={back} />
                <Button size="sm" variant="secondary">
                  <ChevronRight />
                  すべて今日へ繰り越す
                </Button>
              </form>
            )}
          </div>
          <ul className="divide-y divide-line @container">
            {view.overdue.map((r) => (
              <RowItem key={r.key} r={r} stores={stores} editable={editable} back={back} today={today} db={db} />
            ))}
          </ul>
        </Card>
      )}

      <div className="space-y-4">
        {days > 1 && view.inRange.length > 0 && (
          <Card padded={false} id="materials">
            <Materials rows={view.inRange} title={`この期間 (${periodTitle}) に使う材料`} />
          </Card>
        )}
        {dateRange(from, to).map((d) => {
          const list = view.inRange.filter((r) => r.date === d);
          const t = byDay.get(d);
          const perStore = [...new Set(list.map((r) => r.storeId))].map((s) => ({ s, rows: list.filter((r) => r.storeId === s) }));
          return (
            <Card key={d} padded={false} id={`d-${d}`}>
              <div className={clsx("flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-2.5", d === today && "bg-accent-soft/50")}>
                <h3 className={clsx("text-sm font-semibold", dayOfWeek(d) === 0 ? "text-critical-ink" : dayOfWeek(d) === 6 ? "text-info-ink" : "text-ink")}>
                  {longDate(d)}
                  {d === today && <span className="ml-1.5 rounded-full bg-accent px-1.5 text-[10px] text-white">今日</span>}
                </h3>
                {t ? <Totals rows={list} /> : <span className="text-xs text-ink-3">製造の予定はありません</span>}
                {perStore.length > 1 && (
                  <span className="flex flex-wrap gap-x-3 text-[11px] text-ink-2">
                    {perStore.map(({ s, rows }) => (
                      <span key={s} className="inline-flex items-center gap-1">
                        <span className="h-1.5 w-1.5 rounded-full" style={{ background: stores.get(s)?.color }} aria-hidden />
                        {stores.get(s)?.shortName} タ{num(rows.reduce((a, r) => a + r.qty, 0))}
                      </span>
                    ))}
                  </span>
                )}
                <Link href={`/schedule?view=day&date=${d}${storeFilter ? `&store=${storeFilter}` : ""}`} className="ml-auto text-[11px] text-accent hover:underline">
                  この日の予定表
                </Link>
              </div>
              {list.length > 0 && <Materials rows={list} />}
              {list.length > 0 && (
                <ul className="divide-y divide-line @container">
                  {list.map((r) => (
                    <RowItem key={r.key} r={r} stores={stores} editable={editable} back={back} today={today} db={db} />
                  ))}
                </ul>
              )}
            </Card>
          );
        })}

        <Card padded={false} id="undecided">
          <div className="border-b border-line px-4 py-2.5">
            <h3 className="text-sm font-semibold text-ink">製造日未定 ({view.undecided.length} 件)</h3>
            <p className="mt-0.5 text-xs text-ink-2">長期預かりなどで製造日が決まっていない予定。日付を入れると、その日の製造予定に移ります。</p>
          </div>
          {view.undecided.length ? (
            <ul className="divide-y divide-line @container">
              {view.undecided.map((r) => (
                <RowItem key={r.key} r={r} stores={stores} editable={editable} back={back} today={today} db={db} />
              ))}
            </ul>
          ) : (
            <p className="px-4 py-6 text-center text-xs text-ink-3">製造日未定の予定はありません</p>
          )}
        </Card>

        {editable && (
          <Card id="add">
            <CardHeader title="製造の予定を追加" description="受注・予定表にない製造 (在庫の畳・置き畳の製作など) を追加します。受注の引き取りの分は自動で入るので追加は不要です" icon={<Plus />} />
            <form action={addProduction} className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @4xl:grid-cols-3">
              <input type="hidden" name="back" value={back} />
              <Field label="店舗" required>
                <Select name="storeId" defaultValue={storeFilter ?? user.storeId} required>
                  {db.stores.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="製造日" hint="未定のときは下の「製造日未定」に印">
                <Input type="date" name="date" defaultValue={from} />
              </Field>
              <Field label="製造日未定">
                <label className="flex h-10 items-center gap-2 text-sm text-ink">
                  <input type="checkbox" name="undecided" value="1" className="h-4 w-4" />
                  製造日がまだ決まっていない
                </label>
              </Field>
              <Field label="案件・内容" required>
                <Input name="title" required maxLength={80} placeholder="例: 置き畳 (展示用)" />
              </Field>
              <Field label="仕様">
                <Input name="spec" maxLength={200} placeholder="例: 表替え さくら / 縁 マス菊" />
              </Field>
              <Field label="受注番号 (あれば)">
                <Input name="orderNumber" placeholder="例: O-2026-1480" />
              </Field>
              <Field label="畳数">
                <Input type="number" name="qty" min={0} max={500} step="any" inputMode="decimal" />
              </Field>
              <Field label="うちへり無し畳">
                <Input type="number" name="herinashi" min={0} max={500} step="any" inputMode="decimal" />
              </Field>
              <Field label="メモ" className="@xl:col-span-2 @4xl:col-span-1">
                <Textarea name="note" rows={1} maxLength={300} />
              </Field>
              <div className="@xl:col-span-2 @4xl:col-span-3">
                <Button>
                  <Plus />
                  追加する
                </Button>
              </div>
            </form>
          </Card>
        )}

        <Card>
          <CardHeader title="使い方" />
          <ul className="space-y-1.5 text-xs leading-relaxed text-ink-2">
            <li>・受注の「引取・納品の日程」の畳 (表替え・裏返しは引取日、新調は採寸の予定の日) と、予定表の引き取りの予定 (畳の枚数のあるもの) から自動で入ります。引取日が変わると、日付を変えていない製造予定も一緒に動きます。</li>
            <li>・当日に製造できなかったときは「繰り越す」で翌営業日へ (休業日は飛ばします)。別の日は「日付を変更」、長期預かりなどは「未定にする」。</li>
            <li>・製造日を変えても、予定表の引取日・納品日の予定は変わりません。製造日が納品日より後になると注意が出ます。</li>
            <li>・<span className="font-semibold text-critical-ink">縁無</span> はへり無し畳 (製造に時間がかかります)。納品の日が過ぎた予定・施工完了の受注は製造済みとみなします。</li>
          </ul>
        </Card>
      </div>
    </div>
  );
}
