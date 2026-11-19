import type { Metadata } from "next";
import clsx from "clsx";
import { AlertTriangle, CalendarClock, Check, Factory, Route, Send, Shuffle, Undo2, X } from "lucide-react";
import Link from "@/components/ui/Link";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import type { ScheduleHold, StoreId } from "@/lib/db/types";
import { canAccessStore, canAckHold, canPlanSchedule, canSeeAllStores } from "@/lib/auth/permissions";
import { SCHEDULE_KIND } from "@/lib/constants";
import { addDays, fmtDateTime, toDateKey } from "@/lib/format";
import { shortDate } from "@/lib/calendar";
import { ackHoldForm, confirmHoldForm, createProductionJobForm, customerChoiceForm, expireHoldsNow, offerHoldsForm, releaseHoldForm, updateProductionJobForm } from "@/lib/actions/scheduling";
import { waitingJobs } from "@/lib/scheduling/optimize";
import { holdConflicts } from "@/lib/scheduling/holds";
import { describeFreed, recentFreedSlots } from "@/lib/scheduling/replan";
import { processLoads } from "@/lib/scheduling/production";
import { loadMasters } from "@/lib/scheduling/masters";
import { planTablesReady } from "@/lib/scheduling/tables";
import { Badge, Button, Card, CardHeader, Flash, LinkTabs, Note, PageHeader, Select, Input } from "@/components/ui";
import { OptimizePanel, type WaitingRow } from "@/components/scheduling/OptimizePanel";
import { RoutesPanel } from "@/components/scheduling/RoutesPanel";
import { FreedPanel, type FreedRow } from "@/components/scheduling/FreedPanel";

export const metadata: Metadata = { title: "予定の計画" };
export const maxDuration = 60;

type Tab = "optimize" | "holds" | "routes" | "freed" | "production";
const TABS: { id: Tab; label: string }[] = [
  { id: "optimize", label: "まとめて配置" },
  { id: "holds", label: "仮押さえ" },
  { id: "routes", label: "1 日の巡回順" },
  { id: "freed", label: "空いた枠" },
  { id: "production", label: "製造の予定" },
];

const HOLD_STATUS: Record<ScheduleHold["status"], { label: string; tone: "accent" | "good" | "neutral" | "warn" }> = {
  held: { label: "仮押さえ中", tone: "accent" },
  confirmed: { label: "確定", tone: "good" },
  released: { label: "解除", tone: "neutral" },
  expired: { label: "期限切れ", tone: "warn" },
};

export default async function PlanningPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  await expireHoldsNow().catch(() => 0);
  const db = getDb();
  const now = new Date();
  const today = toDateKey(now);
  const tab: Tab = TABS.some((t) => t.id === sp.tab) ? (sp.tab as Tab) : "optimize";
  const stores = db.stores.filter((s) => s.kind === "store" && !s.closedOn && canAccessStore(user, s.id)).map((s) => ({ id: s.id, name: s.name }));
  const defaultStore: StoreId = stores.some((s) => s.id === user.storeId) ? user.storeId : (stores[0]?.id ?? user.storeId);
  const storeName = (id: string) => db.stores.find((s) => s.id === id)?.shortName ?? id;
  const userName = (id: string) => db.users.find((u) => u.id === id)?.name ?? id;
  const here = `/schedule/planning?tab=${tab}`;
  const ready = planTablesReady();

  const activeHolds = (db.scheduleHolds ?? []).filter((h) => h.status === "held" && canAccessStore(user, h.storeId)).length + (db.scheduleHolds ?? []).filter((h) => h.status === "held" && !canAccessStore(user, h.storeId) && h.assigneeIds.includes(user.id)).length;

  return (
    <div className="@container">
      <Flash msg={sp.msg} err={sp.err} />
      <PageHeader title="予定の計画" icon={<Route />} description="複数の案件のまとめての配置・仮押さえ・巡回順・取消しで空いた枠・製造の予定。計算は提案だけで、予定は利用者が確定します" back={{ href: "/schedule", label: "予定表" }} />
      <LinkTabs items={TABS.map((t) => ({ href: `/schedule/planning?tab=${t.id}`, label: t.label, count: t.id === "holds" ? activeHolds : undefined }))} current={here} />
      {!ready && <Note tone="warn">予定の計画のテーブルがまだデータベースにありません (デプロイで作られます)。計算は使えますが、仮押さえ・作業の内容・製造の予定は保存できません。</Note>}

      {tab === "optimize" && (
        <Card>
          <CardHeader title="日程のない案件をまとめて配置" icon={<Shuffle />} description="問い合わせの現地調査・受注の引き取り/施工/納品で、まだ予定がないもの。優先度・期限・入れにくさの順に置き、ほかの案件を置いたあとで置き直して全体の点数を上げます" />
          <OptimizePanel
            stores={stores}
            defaultStore={canSeeAllStores(user) ? "all" : defaultStore}
            today={today}
            waiting={waitingJobs(db, user, { limit: 120 }).map(
              (w): WaitingRow => ({ key: w.key, label: w.label, kind: w.kind, kindLabel: SCHEDULE_KIND[w.kind].label, storeId: w.storeId, storeName: storeName(w.storeId), since: w.since, why: w.why, href: w.href }),
            )}
          />
        </Card>
      )}

      {tab === "holds" && <HoldsTab focus={sp.hold} here={here} />}

      {tab === "routes" && (
        <Card>
          <CardHeader title="1 日の巡回順" icon={<Route />} description="担当者ごとに、時刻の決まった予定は動かさず、時刻未定の予定を移動が最も短くなる順に並べます。予定表の時刻の順と比べて短くなる分を示します" />
          <RoutesPanel stores={stores} defaultStore={defaultStore} today={today} />
        </Card>
      )}

      {tab === "freed" && (
        <Card>
          <CardHeader title="取消し・延期で空いた枠" icon={<Undo2 />} description="この 7 日に削除・後ろへずらした予定の今後の日。後の日の予定の前倒しと、日程のない案件を提案します (自動では動かしません)" />
          <FreedPanel
            stores={stores}
            today={today}
            freed={recentFreedSlots(db, user, { now }).map((f): FreedRow => ({ storeId: f.storeId, storeName: storeName(f.storeId), date: f.date, label: `${describeFreed(f)} (${userName(f.by ?? "")}・${fmtDateTime(f.at)})`, at: f.at }))}
          />
        </Card>
      )}

      {tab === "production" && <ProductionTab here={here} />}
    </div>
  );

  /* ---------------- 仮押さえ ---------------- */
  async function HoldsTab({ focus, here }: { focus?: string; here: string }) {
    const since = addDays(today, -14);
    const visible = (db.scheduleHolds ?? []).filter((h) => (canAccessStore(user, h.storeId) || h.assigneeIds.includes(user.id)) && (h.status === "held" || (h.updatedAt ?? h.createdAt).slice(0, 10) >= since));
    const groups = [...new Map(visible.map((h) => [h.groupId, visible.filter((x) => x.groupId === h.groupId).sort((a, b) => a.rank - b.rank)])).values()].sort((a, b) => Number(b.some((h) => h.status === "held")) - Number(a.some((h) => h.status === "held")) || a[0].date.localeCompare(b[0].date));
    if (!groups.length)
      return (
        <Card>
          <CardHeader title="仮押さえ" icon={<CalendarClock />} />
          <p className="text-sm text-ink-3">仮押さえはありません。予定の入力・案件の画面・「まとめて配置」の候補から仮押さえできます。</p>
        </Card>
      );
    return (
      <div className="space-y-3">
        {groups.map((hs) => {
          const h0 = hs[0];
          const customer = h0.customerId ? db.customers.find((c) => c.id === h0.customerId) : undefined;
          const canPlan = canPlanSchedule(user, h0.storeId);
          const open = hs.filter((h) => h.status === "held");
          const caseHref = h0.orderId ? `/orders/${h0.orderId}` : h0.quoteId ? `/quotes/${h0.quoteId}` : h0.inquiryId ? `/inquiries/${h0.inquiryId}` : undefined;
          return (
            <Card key={h0.groupId} className={clsx(hs.some((h) => h.id === focus) && "ring-2 ring-accent/30")} id={`g-${h0.groupId}`}>
              <CardHeader
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    {h0.title}
                    <Badge tone="neutral">{SCHEDULE_KIND[h0.kind].label}</Badge>
                    <span className="text-xs font-normal text-ink-3">{storeName(h0.storeId)}</span>
                  </span>
                }
                description={`${userName(h0.createdBy)} が ${fmtDateTime(h0.createdAt)} に仮押さえ${open.length ? `・期限 ${fmtDateTime(open[0].expiresAt)}` : ""}${h0.offeredAt ? `・お客様に案内済み (${fmtDateTime(h0.offeredAt)})` : ""}`}
                action={caseHref ? <Link href={caseHref} className="text-xs text-accent hover:underline">案件を開く →</Link> : undefined}
              />
              <ul className="space-y-2">
                {hs.map((h) => {
                  const conflicts = h.status === "held" ? holdConflicts(db, h) : [];
                  const myAck = h.acks.find((a) => a.userId === user.id);
                  return (
                    <li key={h.id} className={clsx("rounded-xl border px-3 py-2.5", h.status === "held" ? "border-line" : "border-line/50 opacity-70", h.customerChoiceAt && h.status === "held" && "border-good/50 bg-good-soft/30")}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[11px] font-semibold text-ink-3">第 {h.rank} 候補</span>
                        <span className="text-sm font-semibold text-ink tnum">
                          {shortDate(h.date)}
                          {h.endDate ? `〜${shortDate(h.endDate)}` : ""} {h.startTime ? `${h.startTime}${h.endTime ? `–${h.endTime}` : ""}` : h.slot === "am" ? "午前" : h.slot === "pm" ? "午後" : "終日"}
                        </span>
                        {h.score !== undefined && <span className="rounded-full bg-info-soft px-2 py-0.5 text-[11px] text-info-ink tnum">{h.score} 点</span>}
                        <Badge tone={HOLD_STATUS[h.status].tone}>{HOLD_STATUS[h.status].label}</Badge>
                        {h.customerChoiceAt && <Badge tone="good">お客様が選択</Badge>}
                        {h.eventId && (
                          <Link href={`/schedule/${h.eventId}`} className="text-xs text-accent hover:underline">
                            予定を開く →
                          </Link>
                        )}
                      </div>
                      <p className="mt-1 text-xs text-ink-2">担当: {h.assigneeIds.map(userName).join("・") || "未定"}</p>
                      {h.acks.length > 0 && (
                        <p className="mt-0.5 text-[11px] text-ink-2">
                          返事: {h.acks.map((a) => `${userName(a.userId)} ${a.ok ? "○ 行ける" : "× 行けない"}${a.note ? ` (${a.note})` : ""}`).join(" / ")}
                        </p>
                      )}
                      {h.customerChoiceNote && <p className="mt-0.5 text-[11px] text-good-ink">{h.customerChoiceNote}</p>}
                      {h.warnings.length > 0 && <p className="mt-0.5 text-[11px] text-warn-ink">注意: {h.warnings.slice(0, 3).join(" / ")}</p>}
                      {conflicts.length > 0 && (
                        <p className="mt-0.5 flex items-start gap-1 text-[11px] text-critical-ink">
                          <AlertTriangle className="mt-px h-3 w-3 shrink-0" aria-hidden />
                          仮押さえのあとで担当者の予定が入りました: {conflicts.slice(0, 3).join("・")}
                        </p>
                      )}
                      {h.status === "held" && (
                        <div className="mt-2 flex flex-wrap items-start gap-2">
                          {canAckHold(user, h) && h.assigneeIds.includes(user.id) && (
                            <>
                              <form action={ackHoldForm.bind(null, h.id)}>
                                <input type="hidden" name="back" value={here} />
                                <input type="hidden" name="ok" value="yes" />
                                <Button type="submit" size="sm" variant={myAck?.ok ? "primary" : "secondary"}>
                                  <Check className="h-4 w-4" aria-hidden /> 行ける
                                </Button>
                              </form>
                              <form action={ackHoldForm.bind(null, h.id)} className="flex items-center gap-1">
                                <input type="hidden" name="back" value={here} />
                                <input type="hidden" name="ok" value="no" />
                                <Input name="note" placeholder="理由 (任意)" className="h-8 w-32 text-xs" />
                                <Button type="submit" size="sm" variant={myAck && !myAck.ok ? "primary" : "secondary"}>
                                  <X className="h-4 w-4" aria-hidden /> 行けない
                                </Button>
                              </form>
                            </>
                          )}
                          {canPlan && ready && (
                            <>
                              <form action={confirmHoldForm.bind(null, h.id)} className="flex items-center gap-2">
                                <input type="hidden" name="back" value={here} />
                                {conflicts.length > 0 && (
                                  <label className="flex items-center gap-1 text-[11px] text-ink-2">
                                    <input type="checkbox" name="allowOverlap" /> 重なりを承知で確定
                                  </label>
                                )}
                                <Button type="submit" size="sm">
                                  <CalendarClock className="h-4 w-4" aria-hidden /> 予定にする
                                </Button>
                              </form>
                              {!h.customerChoiceAt && customer && (
                                <form action={customerChoiceForm.bind(null, h.id)}>
                                  <input type="hidden" name="back" value={here} />
                                  <Button type="submit" size="sm" variant="secondary" title="お客様が電話などでこの候補を選んだことを記録します">
                                    お客様がこの日を選んだ
                                  </Button>
                                </form>
                              )}
                              <form action={releaseHoldForm.bind(null, h.id)}>
                                <input type="hidden" name="back" value={here} />
                                <input type="hidden" name="scope" value="one" />
                                <Button type="submit" size="sm" variant="ghost">
                                  この候補を解除
                                </Button>
                              </form>
                            </>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
              {open.length > 0 && canPlan && ready && (
                <div className="mt-3 flex flex-wrap items-end gap-3 border-t border-line pt-3">
                  {customer ? (
                    <form action={offerHoldsForm.bind(null, h0.groupId)} className="flex flex-wrap items-end gap-2">
                      <input type="hidden" name="back" value={here} />
                      <label className="text-xs text-ink-2">
                        お客様 ({customer.name} 様) への候補の案内
                        <Select name="channel" defaultValue={customer.lineId ? "line" : customer.email ? "email" : "phone"} className="mt-1">
                          <option value="email" disabled={!customer.email}>
                            メールで送る{customer.email ? "" : " (アドレスなし)"}
                          </option>
                          <option value="line" disabled={!customer.lineId}>
                            LINE で送る{customer.lineId ? "" : " (LINE なし)"}
                          </option>
                          <option value="phone">電話で案内した (記録だけ)</option>
                        </Select>
                      </label>
                      <Button type="submit" size="sm" variant="secondary">
                        <Send className="h-4 w-4" aria-hidden /> 案内する
                      </Button>
                    </form>
                  ) : (
                    <p className="text-xs text-ink-3">お客様がひも付いていないため、候補の案内はできません。</p>
                  )}
                  <form action={releaseHoldForm.bind(null, h0.id)}>
                    <input type="hidden" name="back" value={here} />
                    <input type="hidden" name="scope" value="group" />
                    <Button type="submit" size="sm" variant="ghost">
                      すべての候補を解除
                    </Button>
                  </form>
                </div>
              )}
              {open.length > 0 && customer && <p className="mt-2 text-[11px] text-ink-3">メール・LINE の案内には、お客様が候補を選べるリンク (7 日間有効) が付きます。選ばれると担当者と店長に通知します。</p>}
            </Card>
          );
        })}
      </div>
    );
  }

  /* ---------------- 製造の予定 ---------------- */
  async function ProductionTab({ here }: { here: string }) {
    const m = loadMasters(db);
    const loads = processLoads(db, user, today, 14, now).filter((r) => canAccessStore(user, r.storeId));
    const jobs = (db.productionJobs ?? []).filter((j) => canAccessStore(user, j.storeId) && (j.status === "planned" || j.status === "in_progress" || j.endDate >= addDays(today, -7))).sort((a, b) => a.startDate.localeCompare(b.startDate));
    const pickups = db.schedule
      .filter((e) => e.kind === "pickup" && e.date >= addDays(today, -3) && e.date <= addDays(today, 30) && canAccessStore(user, e.storeId) && !(db.productionJobs ?? []).some((j) => j.pickupEventId === e.id && j.status !== "cancelled"))
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(0, 40);
    const dates = loads[0]?.days.map((d) => d.date) ?? [];
    const procName = (id: string) => m.processes.find((p) => p.id === id)?.name ?? id;
    return (
      <div className="space-y-4">
        <Card>
          <CardHeader title="工程ごとの負荷 (14 日)" icon={<Factory />} description="作業場の工程の 1 日の能力 (分) に対する使用。登録した製造の予定 + 製造の予定がない引き取りの見込み (予定表の「畳 表替え6」から)。色が濃いほど上限に近い日です" action={<Link href="/schedule/capacity?tab=production" className="text-xs text-accent hover:underline">工程の能力を設定 →</Link>} />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-xs">
              <thead>
                <tr className="text-left text-ink-3">
                  <th className="py-1.5 pr-2 font-medium">工程</th>
                  {dates.map((d) => (
                    <th key={d} className="px-1 py-1.5 text-center font-medium whitespace-nowrap">
                      {shortDate(d).replace(/^\d+\//, "")}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loads.map((r) => (
                  <tr key={r.processId} className="border-t border-line">
                    <td className="py-1 pr-2 whitespace-nowrap text-ink-2">
                      {storeName(r.storeId)} {r.name}
                    </td>
                    {r.days.map((d) => {
                      const ratio = d.cap ? d.used / d.cap : d.used ? 2 : 0;
                      return (
                        <td key={d.date} className="px-0.5 py-0.5 text-center" title={`${d.used} / ${d.cap} 分 (見込み ${d.estimated} 分)`}>
                          <span className={clsx("inline-block min-w-9 rounded px-1 py-0.5 tnum", !d.cap ? "text-ink-3" : ratio > 1 ? "bg-critical-soft font-semibold text-critical-ink" : ratio >= 0.85 ? "bg-warn-soft font-semibold text-warn-ink" : ratio >= 0.5 ? "bg-info-soft text-info-ink" : d.used ? "text-ink-2" : "text-ink-3")}>
                            {d.cap ? `${Math.round(ratio * 100)}%` : "休"}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card>
          <CardHeader title="製造の予定" description="引き取り → 工程ごとの製造 → 納品。工程を終えたら「完了」を押します (すべて終わると製造の予定は完了)" />
          {jobs.length === 0 ? (
            <p className="text-sm text-ink-3">製造の予定はありません。引き取りの予定を確定すると自動で作られます (下の一覧から作ることもできます)。</p>
          ) : (
            <ul className="space-y-2">
              {jobs.map((j) => (
                <li key={j.id} className="rounded-xl border border-line px-3 py-2.5 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-ink">{j.title}</span>
                    <Badge tone={j.status === "done" ? "good" : j.status === "cancelled" ? "neutral" : j.status === "in_progress" ? "info" : "accent"}>{{ planned: "予定", in_progress: "製造中", done: "完了", cancelled: "取りやめ" }[j.status]}</Badge>
                    <span className="text-ink-3">{storeName(j.storeId)}・{shortDate(j.startDate)}〜{shortDate(j.endDate)}{j.dueDate ? `・納品 ${shortDate(j.dueDate)}` : ""}</span>
                    {j.orderId && (
                      <Link href={`/orders/${j.orderId}`} className="text-accent hover:underline">
                        受注 →
                      </Link>
                    )}
                  </div>
                  <p className="mt-1 text-ink-2">{j.items.map((i) => `${m.workTypeById.get(i.workTypeId)?.name ?? i.workTypeId} ${i.qty}`).join("・")}</p>
                  {j.dueDate && j.dueDate <= j.endDate && <p className="mt-0.5 text-critical-ink">納品の日 ({shortDate(j.dueDate)}) が完成 ({shortDate(j.endDate)}) より前・同じ日です。</p>}
                  {j.materialCheck && !j.materialCheck.ok && <p className="mt-0.5 text-warn-ink">材料の在庫が足りません: {j.materialCheck.lines.filter((l) => l.stock < l.need).map((l) => `${l.name} ${l.need}${l.unit ?? ""} (在庫 ${l.stock})`).join("・")}</p>}
                  {j.note && <p className="mt-0.5 text-ink-3">{j.note}</p>}
                  <ul className="mt-1.5 flex flex-wrap gap-1.5">
                    {j.steps.map((s) => (
                      <li key={`${s.processId}-${s.date}`}>
                        {s.status === "done" || j.status === "cancelled" ? (
                          <span className={clsx("inline-flex items-center gap-1 rounded-full px-2 py-0.5", s.status === "done" ? "bg-good-soft text-good-ink" : "bg-neutral-soft text-ink-3")}>
                            {shortDate(s.date)} {procName(s.processId)} {s.qty} ({s.minutes} 分){s.status === "done" ? " 完了" : ""}
                          </span>
                        ) : (
                          <form action={updateProductionJobForm.bind(null, j.id)} className="inline">
                            <input type="hidden" name="back" value={here} />
                            <input type="hidden" name="stepDone" value={`${s.processId}|${s.date}`} />
                            <button type="submit" className="inline-flex items-center gap-1 rounded-full border border-line bg-panel px-2 py-0.5 hover:border-good/50 hover:bg-good-soft" title="この工程を完了にする">
                              {shortDate(s.date)} {procName(s.processId)} {s.qty} ({s.minutes} 分) <Check className="h-3 w-3" aria-hidden />
                            </button>
                          </form>
                        )}
                      </li>
                    ))}
                  </ul>
                  {(j.status === "planned" || j.status === "in_progress") && (
                    <form action={updateProductionJobForm.bind(null, j.id)} className="mt-1.5">
                      <input type="hidden" name="back" value={here} />
                      <input type="hidden" name="status" value="cancelled" />
                      <button type="submit" className="text-[11px] text-ink-3 hover:text-critical-ink hover:underline">
                        取りやめにする
                      </button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="製造の予定がない引き取り (今後 30 日)" description="作業の内容 (または件名・メモの「畳 表替え6」) から製造の予定を作ります" />
          {pickups.length === 0 ? (
            <p className="text-sm text-ink-3">ありません。</p>
          ) : (
            <ul className="divide-y divide-line">
              {pickups.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs">
                  <span>
                    <span className="tnum text-ink-2">{shortDate(e.date)}</span>{" "}
                    <Link href={`/schedule/${e.id}`} className="font-medium text-ink hover:text-accent hover:underline">
                      {e.title}
                    </Link>{" "}
                    <span className="text-ink-3">{storeName(e.storeId)}</span>
                  </span>
                  {ready && canPlanSchedule(user, e.storeId) && (
                    <form action={createProductionJobForm.bind(null, e.id)}>
                      <input type="hidden" name="back" value={here} />
                      <Button type="submit" size="sm" variant="secondary">
                        製造の予定を作る
                      </Button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    );
  }
}
