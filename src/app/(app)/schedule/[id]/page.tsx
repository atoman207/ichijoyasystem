import type { Metadata } from "next";
import Link from "@/components/ui/Link";
import { notFound } from "next/navigation";
import { CalendarDays, ExternalLink, Globe, History, Link2, MapPin, Pencil, Repeat, TriangleAlert, Users } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canAccessStore, canEditEvent } from "@/lib/auth/permissions";
import { caseEvents, createCaseResolver, orderEditable } from "@/lib/db/schedule";
import { deleteScheduleEvent } from "@/lib/actions/schedule";
import { compareEvents, compareInDay, findConflicts, lastDay, longDate, occursOn, periodLabel, shortDate, timeLabel } from "@/lib/calendar";
import { daysBetween, fmtDateTime } from "@/lib/format";
import { AUDIT_ACTION_LABEL } from "@/lib/constants";
import { Avatar, Badge, Button, Card, CardHeader, Dl, Flash, LinkButton, Note, PageHeader } from "@/components/ui";
import { ConflictBadge, KindBadge, KindIcon, kindStyle } from "@/components/schedule/parts";

export const metadata: Metadata = { title: "予定の詳細" };

export default async function EventDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string; err?: string }> }) {
  const { id } = await params;
  const { msg, err } = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const e = db.schedule.find((x) => x.id === id);
  if (!e) notFound();

  const userMap = new Map(db.users.map((u) => [u.id, u]));
  const store = db.stores.find((s) => s.id === e.storeId);
  const customer = e.customerId ? db.customers.find((c) => c.id === e.customerId) : undefined;
  const ref = createCaseResolver(db).ofEvent(e);
  const order = e.orderId ? db.orders.find((o) => o.id === e.orderId) : undefined;
  const synced = e.source === "order";
  const canEdit = canEditEvent(user, e) && (!synced || (order ? orderEditable(order) : false));
  const conflicts = findConflicts(e, db.schedule);
  const sameCase = ref ? caseEvents(db, ref).filter((x) => x.id !== e.id).sort(compareEvents) : [];
  const series = e.seriesId ? db.schedule.filter((x) => x.seriesId === e.seriesId).sort(compareEvents) : [];
  const logs = db.auditLogs.filter((l) => l.entity === "schedule" && l.entityId === e.id).slice().reverse();
  const multi = lastDay(e) !== e.date;
  const back = `/schedule?view=week&date=${e.date}`;
  const dayAgenda = e.assigneeIds.map((uid) => ({
    user: userMap.get(uid),
    items: db.schedule.filter((x) => x.id !== e.id && x.assigneeIds.includes(uid) && occursOn(x, e.date)).sort(compareInDay),
  }));
  const conflictIds = new Set(conflicts.map((c) => `${c.userId}|${c.event.id}`));

  return (
    <div>
      <Flash msg={msg} err={err} />
      <PageHeader
        title={e.title}
        badge={
          <span className="flex flex-wrap items-center gap-1.5">
            <KindBadge kind={e.kind} />
            {e.companyWide && (
              <Badge tone="accent" dot={false}>
                <Globe className="h-3 w-3" aria-hidden />
                全社共通
              </Badge>
            )}
            {conflicts.length > 0 && <ConflictBadge count={conflicts.length} />}
          </span>
        }
        description={`${periodLabel(e)}${multi ? ` (${daysBetween(e.date, lastDay(e)) + 1}日間)` : ""} · ${store?.name ?? "-"}のカレンダー`}
        back={{ href: back, label: "予定表" }}
        actions={
          <>
            <LinkButton href={`/schedule?view=day&date=${e.date}&store=all`} variant="secondary" size="sm">
              <Users />
              この日の全社員の予定
            </LinkButton>
            {canEdit && (
              <LinkButton href={`/schedule/${e.id}/edit`} size="sm">
                <Pencil />
                変更する
              </LinkButton>
            )}
          </>
        }
      />

      {synced && (
        <div className="mb-4">
          <Note tone="accent">
            受注 {order?.number} の施工予定と連動している予定です。日付・担当者・場所を変更すると、受注の施工期間・施工担当・現場住所にも反映されます (受注・施工の画面から変更しても、この予定に反映されます)。
          </Note>
        </div>
      )}
      {ref?.pending && (
        <div className="mb-4">
          <Note tone="warn">受注の契約承認待ちのため、施工の日程は仮押さえです。承認されると確定します。</Note>
        </div>
      )}
      {conflicts.length > 0 && (
        <div className="mb-4 rounded-xl border border-critical/30 bg-critical-soft/60 px-4 py-3 text-sm text-critical-ink" role="alert">
          <p className="flex items-center gap-1.5 font-semibold">
            <TriangleAlert className="h-4 w-4" aria-hidden />
            担当者の予定が {conflicts.length} 件重複しています
          </p>
          <ul className="mt-1.5 space-y-1 text-xs">
            {conflicts.map((c) => (
              <li key={`${c.userId}-${c.event.id}`}>
                <span className="font-medium">{userMap.get(c.userId)?.name}</span> さん: {shortDate(c.day)} {timeLabel(c.event)}{" "}
                <Link href={`/schedule/${c.event.id}`} className="underline-offset-2 hover:underline">
                  「{c.event.title}」
                </Link>
                {" "}({db.stores.find((s) => s.id === c.event.storeId)?.shortName})
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-xs">日時か担当者を変更して調整してください。</p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 @3xl:grid-cols-3">
        <div className="min-w-0 space-y-4 @3xl:col-span-2">
          <Card>
            <CardHeader title="予定の内容" icon={<CalendarDays />} />
            <Dl
              columns={2}
              items={[
                ["日時", `${periodLabel(e)}${multi && e.startTime ? " (各日)" : ""}`],
                ["店舗 (カレンダー)", e.companyWide ? `${store?.name ?? "-"} (全社共通: 全店舗に表示)` : (store?.name ?? "-")],
                [
                  "案件",
                  ref ? (
                    canAccessStore(user, ref.storeId) ? (
                      <Link key="c" href={ref.href} className="inline-flex items-center gap-1 text-accent hover:underline">
                        <Link2 className="h-3.5 w-3.5" aria-hidden />
                        {ref.stage} {ref.number} {ref.title}
                      </Link>
                    ) : (
                      `${ref.stage} ${ref.number} ${ref.title} (他店舗の案件)`
                    )
                  ) : (
                    "紐づけなし"
                  ),
                ],
                ["お客様", customer ? canAccessStore(user, customer.storeId) ? <Link key="cu" href={`/customers/${customer.id}`} className="text-accent hover:underline">{customer.name}</Link> : customer.name : "-"],
                [
                  "場所",
                  e.location ? (
                    <span key="l" className="inline-flex flex-wrap items-center gap-2">
                      {e.location}
                      <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(e.location)}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-xs text-accent hover:underline">
                        <MapPin className="h-3.5 w-3.5" aria-hidden />
                        地図で開く
                        <ExternalLink className="h-3 w-3" aria-hidden />
                      </a>
                    </span>
                  ) : (
                    "-"
                  ),
                ],
                ["繰り返し", series.length > 1 ? `${series.length} 回のうち ${series.findIndex((x) => x.id === e.id) + 1} 回目` : "なし"],
                ["登録", e.createdBy ? `${userMap.get(e.createdBy)?.name ?? "-"} · ${fmtDateTime(e.createdAt)}` : "-"],
                ["最終更新", e.updatedBy ? `${userMap.get(e.updatedBy)?.name ?? "-"} · ${fmtDateTime(e.updatedAt)}` : "-"],
              ]}
            />
            {e.memo && (
              <div className="mt-4 rounded-xl bg-subtle/70 px-4 py-3">
                <div className="text-xs text-ink-3">メモ</div>
                <p className="mt-1 text-sm whitespace-pre-wrap text-ink">{e.memo}</p>
              </div>
            )}
          </Card>

          <Card>
            <CardHeader title="担当者と、この日のほかの予定" description={`${longDate(e.date)} · 人員配置の確認に`} icon={<Users />} />
            {dayAgenda.length === 0 && <p className="text-sm text-ink-3">担当者は指定されていません{e.companyWide ? " (全社共通の予定)" : ""}</p>}
            <ul className="divide-y divide-line">
              {dayAgenda.map(({ user: u, items }) =>
                u ? (
                  <li key={u.id} className="flex flex-col gap-2 py-3 @xl:flex-row @xl:items-start">
                    <div className="flex w-56 shrink-0 items-center gap-2">
                      <Avatar name={u.name} id={u.id} size={30} />
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-ink">{u.name}</div>
                        <div className="truncate text-[11px] text-ink-3">{u.title}</div>
                      </div>
                    </div>
                    <ul className="min-w-0 flex-1 space-y-1">
                      {items.length === 0 && <li className="text-xs text-good-ink">この日のほかの予定はありません</li>}
                      {items.map((x) => {
                        const clash = conflictIds.has(`${u.id}|${x.id}`);
                        return (
                          <li key={x.id} className="flex min-w-0 items-center gap-2 text-xs">
                            <span className="w-24 shrink-0 text-ink-2 tnum">{timeLabel(x)}</span>
                            <KindIcon kind={x.kind} className={`h-3.5 w-3.5 ${kindStyle(x.kind).ink}`} />
                            <Link href={`/schedule/${x.id}`} className="min-w-0 truncate text-ink hover:text-accent hover:underline">
                              {x.title}
                            </Link>
                            {clash && <ConflictBadge />}
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                ) : null,
              )}
            </ul>
          </Card>

          <Card>
            <CardHeader title="変更履歴" icon={<History />} />
            {logs.length === 0 && <p className="text-sm text-ink-3">履歴はありません</p>}
            <ul className="space-y-2 text-xs">
              {logs.map((l) => (
                <li key={l.id}>
                  <span className="text-ink-3 tnum">{fmtDateTime(l.at)}</span> <Badge dot={false}>{AUDIT_ACTION_LABEL[l.action]}</Badge> <span className="text-ink">{l.summary}</span> <span className="text-ink-3">({userMap.get(l.userId)?.name})</span>
                </li>
              ))}
            </ul>
          </Card>
        </div>

        <div className="min-w-0 space-y-4">
          {ref && (
            <Card>
              <CardHeader title="この案件のほかの予定" description={`${ref.stage} ${ref.number}`} />
              {sameCase.length === 0 && <p className="text-sm text-ink-3">ほかの予定はありません</p>}
              <ul className="space-y-2 text-xs">
                {sameCase.map((x) => (
                  <li key={x.id} className="flex flex-wrap items-center gap-1.5">
                    <span className="text-ink-3 tnum">{periodLabel(x)}</span>
                    <KindBadge kind={x.kind} />
                    <Link href={`/schedule/${x.id}`} className="min-w-0 truncate text-ink hover:text-accent hover:underline">
                      {x.title}
                    </Link>
                  </li>
                ))}
              </ul>
              {canAccessStore(user, ref.storeId) && (
                <LinkButton href={`/schedule/new?${ref.type}Id=${ref.id}&returnTo=${encodeURIComponent(`/schedule/${e.id}`)}`} variant="secondary" size="sm" className="mt-3">
                  この案件の予定を追加
                </LinkButton>
              )}
            </Card>
          )}

          {series.length > 1 && (
            <Card>
              <CardHeader title="繰り返しの予定" icon={<Repeat />} description={`${series.length} 回`} />
              <ul className="max-h-60 space-y-1 overflow-y-auto text-xs">
                {series.map((x) => (
                  <li key={x.id}>
                    {x.id === e.id ? (
                      <span className="font-semibold text-ink">{periodLabel(x)} (この予定)</span>
                    ) : (
                      <Link href={`/schedule/${x.id}`} className="text-ink-2 hover:text-accent hover:underline">
                        {periodLabel(x)}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {canEditEvent(user, e) && !synced && (
            <Card>
              <CardHeader title="予定の削除" description="削除は変更履歴に残ります" />
              <form action={deleteScheduleEvent.bind(null, e.id)} className="space-y-3">
                <input type="hidden" name="returnTo" value={back} />
                {series.length > 1 && (
                  <fieldset className="space-y-1 text-sm text-ink">
                    <legend className="label">削除する範囲</legend>
                    <label className="flex items-center gap-2">
                      <input type="radio" name="scope" value="one" defaultChecked className="accent-[#d03b3b]" />
                      この予定のみ
                    </label>
                    <label className="flex items-center gap-2">
                      <input type="radio" name="scope" value="series" className="accent-[#d03b3b]" />
                      この予定以降の繰り返しすべて
                    </label>
                  </fieldset>
                )}
                <Button type="submit" variant="danger" size="sm">
                  予定を削除する
                </Button>
              </form>
            </Card>
          )}
          {synced && (
            <Card>
              <CardHeader title="受注の施工予定" />
              <p className="text-xs leading-relaxed text-ink-2">この予定は受注の施工予定と連動しているため、ここでは削除できません。施工を取りやめる場合は受注・施工の画面で施工開始日を空欄にするか、受注をキャンセルしてください。</p>
              {order && canAccessStore(user, order.storeId) && (
                <LinkButton href={`/orders/${order.id}`} variant="secondary" size="sm" className="mt-3">
                  受注 {order.number} を開く
                </LinkButton>
              )}
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
