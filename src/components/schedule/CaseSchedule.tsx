import Link from "@/components/ui/Link";
import clsx from "clsx";
import { CalendarDays, Plus } from "lucide-react";
import type { ScheduleEvent, ScheduleKind, Store, StoreId } from "@/lib/db/types";
import { compareEvents, findConflicts, lastDay, periodLabel } from "@/lib/calendar";
import { Card, CardHeader } from "@/components/ui";
import { ConflictBadge, KindBadge, kindLabel, kindStyle, KindIcon } from "./parts";

/**
 * 案件 (問い合わせ・見積・受注) や顧客の画面に置く「この案件の予定」カード。
 * 予定は案件に紐づけて登録すると、担当者とともに店舗の共通カレンダーにもそのまま載る。
 */
export function CaseScheduleCard({
  title = "この案件の予定",
  description = "ここで登録した予定は、担当者とともに店舗の共通カレンダー (予定表) に自動で反映されます",
  events,
  allEvents,
  users,
  stores,
  today,
  newParams,
  returnTo,
  quickKinds,
  canAdd,
  emptyText = "まだ予定はありません",
}: {
  title?: string;
  description?: string;
  events: ScheduleEvent[];
  /** 重複の確認に使う全予定 */
  allEvents: ScheduleEvent[];
  users: Map<string, { name: string }>;
  stores: Map<StoreId, Store>;
  today: string;
  /** 予定追加画面に渡す案件の指定 (例: orderId=o_1) */
  newParams: string;
  returnTo: string;
  /** すぐ追加できる種別 */
  quickKinds: ScheduleKind[];
  canAdd: boolean;
  emptyText?: string;
}) {
  const upcoming = events.filter((e) => lastDay(e) >= today).sort(compareEvents);
  const past = events.filter((e) => lastDay(e) < today).sort((a, b) => compareEvents(b, a));
  const href = (kind: ScheduleKind) => `/schedule/new?${newParams}&kind=${kind}&returnTo=${encodeURIComponent(returnTo)}`;
  const row = (e: ScheduleEvent, dim: boolean) => {
    const conflicts = dim ? [] : findConflicts(e, allEvents);
    const people = e.assigneeIds.map((id) => users.get(id)?.name).filter(Boolean);
    const store = stores.get(e.storeId);
    return (
      <li key={e.id} className={clsx("flex gap-3 py-2.5", dim && "opacity-70")}>
        <span className={clsx("mt-0.5 h-auto w-1 shrink-0 rounded-full", kindStyle(e.kind).bar)} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="font-semibold text-ink tnum">{periodLabel(e)}</span>
            <KindBadge kind={e.kind} />
            {conflicts.length > 0 && <ConflictBadge count={conflicts.length} />}
            {e.source === "order" && <span className="rounded-full bg-accent-soft px-1.5 py-px text-[10px] font-medium text-accent-ink">施工予定と連動</span>}
          </div>
          <Link href={`/schedule/${e.id}`} className="mt-0.5 block truncate text-sm font-medium text-ink hover:text-accent hover:underline">
            {e.title}
          </Link>
          <div className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-ink-3">
            <span>担当: {people.join("・") || "-"}</span>
            {store && <span>{store.shortName}のカレンダー</span>}
            {e.location && <span className="truncate">{e.location}</span>}
          </div>
        </div>
      </li>
    );
  };
  return (
    <Card>
      <CardHeader title={title} description={description} icon={<CalendarDays />} />
      {canAdd && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {quickKinds.map((k) => (
            <Link
              key={k}
              href={href(k)}
              className={clsx("inline-flex items-center gap-1 rounded-full border border-line px-2.5 py-1 text-xs font-medium text-ink-2 transition hover:border-accent/40 hover:bg-accent-soft/40 hover:text-accent-ink")}
              aria-label={`${kindLabel(k)}の予定を追加`}
            >
              <Plus className="h-3 w-3" aria-hidden />
              <KindIcon kind={k} className={clsx("h-3.5 w-3.5", kindStyle(k).ink)} />
              {kindLabel(k)}
            </Link>
          ))}
        </div>
      )}
      {events.length === 0 && <p className="py-3 text-sm text-ink-3">{emptyText}</p>}
      {upcoming.length > 0 && <ul className="divide-y divide-line">{upcoming.map((e) => row(e, false))}</ul>}
      {past.length > 0 && (
        <details className="group mt-2 border-t border-line pt-2" open={upcoming.length === 0}>
          <summary className="cursor-pointer text-xs font-medium text-ink-3 hover:text-ink">過去の予定 ({past.length} 件)</summary>
          <ul className="divide-y divide-line">{past.map((e) => row(e, true))}</ul>
        </details>
      )}
    </Card>
  );
}
