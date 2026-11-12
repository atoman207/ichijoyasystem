import Link from "@/components/ui/Link";
import clsx from "clsx";
import {
  ArrowRight,
  Banknote,
  CalendarDays,
  CalendarX2,
  ChartColumn,
  ClipboardCheck,
  Clock,
  Hammer,
  Inbox,
  JapaneseYen,
  Plus,
  Receipt,
  ScanLine,
  Sun,
  type LucideIcon,
} from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { monthlySales, notificationsFor, storeKpis, userName, customerName } from "@/lib/db/queries";
import { canApprove, canSeeAllStores, canViewReports, scopeByStore } from "@/lib/auth/permissions";
import { fmtShortMonth, fmtMonth, toDateKey, yen, pct, fmtDate } from "@/lib/format";
import { APPROVAL_TYPE_LABEL, INQUIRY_STATUS, ORDER_STATUS } from "@/lib/constants";
import { Badge, Card, CardHeader, Delta, Flash, LinkButton, PageHeader, Stat, StatusBadge, StoreTag, ChannelTag, Avatar, Table, Th, Td, Tr } from "@/components/ui";
import { StackedBarChart } from "@/components/charts";
import { analyzeConflicts, compareInDay, occursOn, shortTime, timeLabel } from "@/lib/calendar";
import { ConflictBadge, KindBadge, kindStyle } from "@/components/schedule/parts";

function greeting(hour: number): string {
  if (hour < 5) return "お疲れさまです";
  if (hour < 11) return "おはようございます";
  if (hour < 18) return "こんにちは";
  return "お疲れさまです";
}

/** カード右上の「一覧へ」リンク */
function MoreLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="group inline-flex items-center gap-1 text-xs font-medium text-accent transition-colors hover:text-accent-hover">
      {children}
      <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}

const ATTENTION_TONE = {
  warn: "bg-warn-soft text-warn-ink",
  info: "bg-info-soft text-info-ink",
  critical: "bg-critical-soft text-critical-ink",
} as const;

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ msg?: string; err?: string }> }) {
  const { msg, err } = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const now = new Date();
  const today = toDateKey(now);
  const allStores = canSeeAllStores(user);
  const kpis = storeKpis(db, now);
  const myKpis = allStores ? kpis : kpis.filter((k) => k.storeId === user.storeId);
  const sum = (f: (k: (typeof kpis)[number]) => number) => myKpis.reduce((a, k) => a + f(k), 0);
  const salesThisMonth = sum((k) => k.salesThisMonth);
  const salesLastMonth = sum((k) => k.salesLastMonth);
  const delta = salesLastMonth ? (salesThisMonth - salesLastMonth) / salesLastMonth : 0;

  const sales = monthlySales(db, 12, now);
  const series = (allStores ? db.stores : db.stores.filter((s) => s.id === user.storeId)).map((s) => ({ key: s.id, label: s.name, color: s.color }));
  const chartData = sales.map((m) => ({ label: fmtShortMonth(m.month), fullLabel: fmtMonth(m.month), values: m.byStore as unknown as Record<string, number> }));

  const n = notificationsFor(user);
  const pendingForMe = db.approvals.filter((a) => a.status === "pending" && canApprove(user, a)).slice(0, 6);
  const myRequests = db.approvals.filter((a) => a.status === "pending" && a.requestedBy === user.id).slice(0, 6);
  // 本日の予定: 全店舗ロールは全社、店舗ロールは自店舗 + 全社共通 + 自分が担当の予定 (他店舗の応援など)
  const todayAll = db.schedule.filter((e) => occursOn(e, today));
  const todayConflicts = analyzeConflicts(todayAll).byEvent;
  const todayMine = todayAll.filter((e) => allStores || e.storeId === user.storeId || e.companyWide || e.assigneeIds.includes(user.id)).sort(compareInDay);
  const todayEvents = todayMine.slice(0, 8);
  const openInquiries = scopeByStore(user, db.inquiries)
    .filter((i) => i.status === "new" || i.status === "in_progress")
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
    .slice(0, 6);
  const activeJobs = scopeByStore(user, db.orders)
    .filter((o) => ["confirmed", "scheduled", "in_progress"].includes(o.status))
    .sort((a, b) => (a.scheduledStart ?? "9999").localeCompare(b.scheduledStart ?? "9999"))
    .slice(0, 6);
  const recentLogs = (allStores ? db.auditLogs : db.auditLogs.filter((l) => l.storeId === user.storeId || l.userId === user.id)).slice(-8).reverse();
  const storeMap = new Map(db.stores.map((s) => [s.id, s]));
  const overdue = sum((k) => k.overdue);
  const pendingTotal = allStores ? db.approvals.filter((a) => a.status === "pending").length : sum((k) => k.pendingApprovals);
  const scopeName = allStores ? "全店舗" : (storeMap.get(user.storeId)?.name ?? "");

  // 今日の状況: 対応が必要な件数 (0 件の行は控えめに表示)
  const attention: { label: string; count: number; href: string; tone: keyof typeof ATTENTION_TONE; icon: LucideIcon }[] = [
    { label: "未対応の問い合わせ", count: n.newInquiries, href: "/inquiries?status=new", tone: "warn", icon: Inbox },
    { label: "あなたの承認待ち", count: pendingForMe.length, href: "/approvals?tab=mine", tone: "info", icon: ClipboardCheck },
    { label: "期日超過の請求", count: n.overdueInvoices, href: "/invoices?status=overdue", tone: "critical", icon: Receipt },
    { label: "あなたの予定の重複", count: n.myConflicts, href: "/schedule?view=list&user=me&store=all&conflicts=1", tone: "critical", icon: CalendarX2 },
  ];

  return (
    <div>
      <Flash msg={msg} err={err} />

      <PageHeader
        title="ダッシュボード"
        description={
          <span className="tnum">
            {greeting(now.getHours())}、{user.name} さん · {fmtDate(today, { weekday: true })} · {scopeName}
          </span>
        }
        actions={
          <>
            <LinkButton href="/capture" variant="secondary">
              <ScanLine /> 書類を取り込む
            </LinkButton>
            <LinkButton href="/inquiries/new">
              <Plus /> 問い合わせ登録
            </LinkButton>
          </>
        }
      />

      {/* KPI */}
      <div className="mb-5 grid grid-cols-1 gap-4 @md:grid-cols-2 @3xl:grid-cols-3 @6xl:grid-cols-5">
        <Stat
          label={`今月の売上 (${fmtMonth(sales[sales.length - 1].month)})`}
          value={yen(salesThisMonth)}
          sub={
            <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
              <Delta value={delta} label="前月比" />
              <span className="text-ink-3">先月 {yen(salesLastMonth)}</span>
            </span>
          }
          icon={<JapaneseYen />}
          accent="accent"
          href={canViewReports(user) ? "/reports" : undefined}
        />
        <Stat label="今月の受注件数" value={`${sum((k) => k.orderCount)} 件`} sub={<span className="text-ink-3">進行中の施工 {sum((k) => k.activeJobs)} 件</span>} icon={<Hammer />} accent="info" href="/orders" />
        <Stat
          label="売掛残高 (未入金)"
          value={yen(sum((k) => k.receivables))}
          sub={overdue > 0 ? <Badge tone="critical" dot={false}>期日超過 {yen(overdue)}</Badge> : <span className="text-ink-3">期日超過なし</span>}
          tone={overdue > 0 ? "critical" : undefined}
          icon={<Banknote />}
          accent="good"
          href="/invoices"
        />
        <Stat
          label="未対応・対応中の問い合わせ"
          value={`${sum((k) => k.openInquiries)} 件`}
          sub={n.newInquiries > 0 ? <Badge tone="warn" dot={false}>うち未対応 {n.newInquiries} 件</Badge> : <span className="text-ink-3">未対応なし</span>}
          tone={n.newInquiries > 0 ? "warn" : undefined}
          icon={<Inbox />}
          accent="warn"
          href="/inquiries"
        />
        <Stat
          label="承認待ち"
          value={`${pendingTotal} 件`}
          sub={
            pendingForMe.length > 0 ? (
              <Badge tone="warn" dot={false}>あなたの承認待ち {pendingForMe.length} 件</Badge>
            ) : (
              <span className="text-ink-3">{myRequests.length > 0 ? `申請中 ${myRequests.length} 件` : "対応待ちなし"}</span>
            )
          }
          icon={<ClipboardCheck />}
          accent="serious"
          href="/approvals"
          tone={pendingForMe.length > 0 ? "warn" : undefined}
        />
      </div>

      {/* 売上推移 + 本日の予定 */}
      <div className="mb-5 grid grid-cols-1 gap-4 @4xl:grid-cols-3">
        <Card className="@4xl:col-span-2">
          <CardHeader title="月次売上推移" description="施工完了ベース・税込" icon={<ChartColumn />} action={canViewReports(user) ? <MoreLink href="/reports">レポート</MoreLink> : undefined} />
          <div className="mb-3 flex flex-wrap items-end gap-x-3 gap-y-1">
            <span className="text-[26px] leading-none font-bold tracking-tight text-ink tnum">{yen(salesThisMonth)}</span>
            <span className="pb-0.5 text-xs text-ink-3">今月</span>
            <Delta value={delta} label="前月比" className="mb-0.5" />
          </div>
          <StackedBarChart data={chartData} series={series} title="月次売上推移" />
        </Card>
        <Card className="flex flex-col">
          <CardHeader
            title="本日の予定"
            description={allStores ? "全社" : "自店舗・全社共通・自分の担当"}
            icon={<CalendarDays />}
            action={<MoreLink href={`/schedule?view=day&date=${today}${allStores ? "&store=all" : ""}`}>予定表</MoreLink>}
          />
          <ul className="space-y-1">
            {todayEvents.length === 0 && <li className="py-8 text-center text-sm text-ink-3">本日の予定はありません</li>}
            {todayEvents.map((e) => (
              <li key={e.id}>
                <Link href={`/schedule/${e.id}`} className="flex gap-3 rounded-xl px-2 py-2 transition hover:bg-subtle">
                  <div className="w-11 shrink-0 pt-0.5 text-xs font-semibold text-ink tnum">{shortTime(e)}</div>
                  <div className={`w-1 shrink-0 self-stretch rounded-full ${kindStyle(e.kind).bar}`} aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-ink">{e.title}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-3">
                      <KindBadge kind={e.kind} />
                      {todayConflicts.has(e.id) && <ConflictBadge />}
                      <span className="tnum">{timeLabel(e)}</span>
                      <span className="truncate">{e.assigneeIds.map((id) => userName(id)).join("・") || (e.companyWide ? "全社共通" : "")}</span>
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
          {todayMine.length > todayEvents.length && (
            <Link href={`/schedule?view=list&date=${today}${allStores ? "&store=all" : ""}`} className="mt-2 inline-block px-2 text-xs font-medium text-accent hover:underline">
              ほか {todayMine.length - todayEvents.length} 件を予定表で見る
            </Link>
          )}
        </Card>
      </div>

      {/* 承認 / 今日の状況 / 問い合わせ */}
      <div className="mb-5 grid grid-cols-1 gap-4 @3xl:grid-cols-2 @6xl:grid-cols-3">
        <Card>
          <CardHeader
            title={pendingForMe.length > 0 ? "あなたの承認待ち" : "申請中の承認"}
            icon={<ClipboardCheck />}
            action={<MoreLink href={`/approvals?tab=${pendingForMe.length > 0 ? "mine" : "requested"}`}>すべて</MoreLink>}
          />
          <ul className="space-y-1">
            {(pendingForMe.length > 0 ? pendingForMe : myRequests).map((a) => (
              <li key={a.id}>
                <Link href={`/approvals?tab=${pendingForMe.length > 0 ? "mine" : "requested"}`} className="flex items-center justify-between gap-3 rounded-xl px-2 py-2 transition hover:bg-subtle">
                  <span className="flex min-w-0 items-center gap-3">
                    <Avatar name={userName(a.requestedBy)} id={a.requestedBy} size={34} />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-ink">{a.title}</span>
                      <span className="mt-0.5 block truncate text-[11px] text-ink-3">
                        {APPROVAL_TYPE_LABEL[a.type]} · {storeMap.get(a.storeId)?.shortName} · {userName(a.requestedBy)}
                      </span>
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block text-sm font-semibold tnum">{yen(a.amount)}</span>
                    <Badge tone={a.requiredRole === "admin" ? "serious" : "warn"} dot={false}>
                      {a.requiredRole === "admin" ? "管理者承認" : "店長承認"}
                    </Badge>
                  </span>
                </Link>
              </li>
            ))}
            {pendingForMe.length === 0 && myRequests.length === 0 && <li className="py-8 text-center text-sm text-ink-3">承認待ちの案件はありません</li>}
          </ul>
        </Card>

        <Card>
          <CardHeader title="今日の状況" icon={<Sun />} action={<MoreLink href={`/schedule?view=day&date=${today}${allStores ? "&store=all" : ""}`}>予定表</MoreLink>} />
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-xl border border-line/70 bg-subtle/70 px-3 py-2.5">
              <div className="flex items-center gap-1.5 text-[11px] font-medium text-ink-3">
                <CalendarDays className="h-3.5 w-3.5" aria-hidden /> 本日の予定
              </div>
              <div className="mt-1 text-xl font-bold text-ink tnum">
                {todayMine.length}
                <span className="ml-1 text-xs font-medium text-ink-3">件</span>
              </div>
            </div>
            <div className="rounded-xl border border-line/70 bg-subtle/70 px-3 py-2.5">
              <div className="flex items-center gap-1.5 text-[11px] font-medium text-ink-3">
                <Clock className="h-3.5 w-3.5" aria-hidden /> 進行中の施工
              </div>
              <div className="mt-1 text-xl font-bold text-ink tnum">
                {sum((k) => k.activeJobs)}
                <span className="ml-1 text-xs font-medium text-ink-3">件</span>
              </div>
            </div>
          </div>
          <div className="mt-4 mb-2 text-[11px] font-semibold tracking-wide text-ink-3">要対応</div>
          <ul className="space-y-2">
            {attention.map((r) => (
              <li key={r.label}>
                <Link
                  href={r.href}
                  className={clsx(
                    "flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm transition-[transform,box-shadow] hover:-translate-y-px hover:shadow-card",
                    r.count > 0 ? ATTENTION_TONE[r.tone] : "bg-subtle text-ink-3",
                  )}
                >
                  <r.icon className="h-4 w-4 shrink-0" aria-hidden />
                  <span className="flex-1 font-medium">{r.label}</span>
                  <span className="text-base font-bold tnum">{r.count}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>

        <Card className="@3xl:col-span-2 @6xl:col-span-1">
          <CardHeader title="未対応・対応中の問い合わせ" icon={<Inbox />} action={<MoreLink href="/inquiries">すべて</MoreLink>} />
          <ul className="space-y-1">
            {openInquiries.map((i) => (
              <li key={i.id}>
                <Link href={`/inquiries/${i.id}`} className="block rounded-xl px-2 py-2 transition hover:bg-subtle">
                  <span className="flex min-w-0 items-center gap-2">
                    <StatusBadge value={i.status} map={INQUIRY_STATUS} />
                    <ChannelTag channel={i.channel} />
                    <span className="truncate text-sm font-medium text-ink">{i.summary}</span>
                  </span>
                  <span className="mt-1 block truncate text-[11px] text-ink-3">
                    {i.contactName} · {storeMap.get(i.storeId)?.shortName} · 担当 {userName(i.assignedUserId)}
                    {i.nextAction && (
                      <span className="ml-2 text-warn-ink">
                        次: {i.nextAction}
                        {i.nextActionDue ? ` (${fmtDate(i.nextActionDue)})` : ""}
                      </span>
                    )}
                  </span>
                </Link>
              </li>
            ))}
            {openInquiries.length === 0 && <li className="py-8 text-center text-sm text-ink-3">未対応の問い合わせはありません</li>}
          </ul>
        </Card>
      </div>

      {allStores && (
        <Card className="mb-5" padded={false}>
          <div className="px-5 pt-5">
            <CardHeader title="店舗別の状況 (今月)" icon={<ChartColumn />} />
          </div>
          <Table className="rounded-none rounded-b-2xl border-0 shadow-none" minWidth="min-w-[760px]">
            <thead>
              <tr>
                <Th className="pl-5">店舗</Th>
                <Th align="right">今月売上</Th>
                <Th align="right">先月売上</Th>
                <Th align="right">年初来</Th>
                <Th align="right">受注件数</Th>
                <Th align="right">成約率</Th>
                <Th align="right">問い合わせ</Th>
                <Th align="right">売掛残</Th>
                <Th align="right" className="pr-5">
                  承認待ち
                </Th>
              </tr>
            </thead>
            <tbody>
              {kpis.map((k) => (
                <Tr key={k.storeId}>
                  <Td className="pl-5">
                    <StoreTag store={storeMap.get(k.storeId)} />
                  </Td>
                  <Td align="right" className="font-semibold">
                    {yen(k.salesThisMonth)}
                  </Td>
                  <Td align="right" className="text-ink-2">
                    {yen(k.salesLastMonth)}
                  </Td>
                  <Td align="right" className="text-ink-2">
                    {yen(k.salesYtd)}
                  </Td>
                  <Td align="right">{k.orderCount}</Td>
                  <Td align="right">{pct(k.quoteWinRate)}</Td>
                  <Td align="right">{k.openInquiries}</Td>
                  <Td align="right">
                    {yen(k.receivables)}
                    {k.overdue > 0 && <span className="ml-1 text-[11px] text-critical-ink">(超過 {yen(k.overdue)})</span>}
                  </Td>
                  <Td align="right" className="pr-5">
                    {k.pendingApprovals}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      {/* 進行中の受注・施工 / 最近の更新 */}
      <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-2">
        <Card>
          <CardHeader title="進行中の受注・施工" icon={<Hammer />} action={<MoreLink href="/orders">すべて</MoreLink>} />
          <ul className="space-y-1">
            {activeJobs.map((o) => (
              <li key={o.id}>
                <Link href={`/orders/${o.id}`} className="flex items-center justify-between gap-3 rounded-xl px-2 py-2 transition hover:bg-subtle">
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-ink">
                      {customerName(o.customerId)} 様 · {o.title}
                    </span>
                    <span className="mt-0.5 block truncate text-[11px] text-ink-3">
                      {o.number} · {storeMap.get(o.storeId)?.shortName} · 施工予定 {fmtDate(o.scheduledStart)} · 担当 {o.workerIds.map((w) => userName(w)).join("・")}
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block text-sm font-semibold tnum">{yen(o.total)}</span>
                    <StatusBadge value={o.status} map={ORDER_STATUS} />
                  </span>
                </Link>
              </li>
            ))}
            {activeJobs.length === 0 && <li className="py-8 text-center text-sm text-ink-3">進行中の施工はありません</li>}
          </ul>
        </Card>
        <Card>
          <CardHeader title="最近の更新" icon={<Clock />} action={<MoreLink href="/audit">すべて</MoreLink>} />
          <ul className="space-y-1">
            {recentLogs.map((l) => (
              <li key={l.id} className="flex items-start gap-3 rounded-xl px-2 py-2">
                <Avatar name={userName(l.userId)} id={l.userId} size={30} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-ink">{l.summary}</div>
                  <div className="mt-0.5 truncate text-[11px] text-ink-3">
                    {userName(l.userId)} · {l.entityLabel} ·{" "}
                    {new Date(l.at).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                  </div>
                </div>
              </li>
            ))}
            {recentLogs.length === 0 && <li className="py-8 text-center text-sm text-ink-3">更新履歴はまだありません</li>}
          </ul>
        </Card>
      </div>
    </div>
  );
}
