import type { Metadata } from "next";
import clsx from "clsx";
import { Gauge } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canManageSettings } from "@/lib/auth/permissions";
import { updateScheduleCapacity } from "@/lib/actions/schedule";
import { CAPACITY_LABEL, DEFAULTS, effectiveCapacity, isClosedDay, readCapacitySettings, scheduleStats, storeDayLoads, type CapacityKey, type CapacitySource } from "@/lib/schedule-capacity";
import { shortDate } from "@/lib/calendar";
import { addDays, toDateKey } from "@/lib/format";
import { Button, Card, CardHeader, Field, Flash, Input, LinkTabs, Note, PageHeader } from "@/components/ui";
import { WorkTab, ProductionTab, StaffTab, ResourcesTab, RoutingTab, WeightsTab, RulesTab, ReadyTab } from "./tabs";
import { BacktestTab } from "./tab-backtest";
import { DayLoadTab } from "./tab-dayload";

export const metadata: Metadata = { title: "仕事量と提案の設定" };

const KEYS: CapacityKey[] = ["jobsPerDay", "visitsPerDay", "tatamiPerDay"];
const SHORT: Record<CapacityKey, string> = { jobsPerDay: "現場作業 (件)", visitsPerDay: "営業の訪問 (件)", tatamiPerDay: "畳の製造 (枚)" };
const SOURCE: Record<CapacitySource, string> = { setting: "設定値", auto: "自動", default: "標準" };

/** 使用率の色 (上限に近いほど濃い) */
function loadTone(used: number, cap: number): string {
  if (!used) return "text-ink-3";
  const r = used / cap;
  if (r > 1) return "bg-critical-soft text-critical-ink font-semibold";
  if (r >= 0.85) return "bg-warn-soft text-warn-ink font-semibold";
  if (r >= 0.5) return "bg-info-soft text-info-ink";
  return "text-ink-2";
}

const TABS = [
  { id: "ready", label: "準備の状況" },
  { id: "capacity", label: "1 日の上限" },
  { id: "dayload", label: "1 日の対応可能枚数" },
  { id: "work", label: "作業種別・標準工数" },
  { id: "production", label: "製造の工程" },
  { id: "staff", label: "社員の勤務と技能" },
  { id: "resources", label: "車両・設備" },
  { id: "routing", label: "経路" },
  { id: "rules", label: "計画の基準" },
  { id: "weights", label: "最適化の重み" },
  { id: "backtest", label: "提案の検証" },
] as const;
type TabId = (typeof TABS)[number]["id"];

export default async function ScheduleCapacityPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();
  const tab: TabId = TABS.some((t) => t.id === sp.tab) ? (sp.tab as TabId) : "capacity";
  const tabs = <LinkTabs items={TABS.map((t) => ({ href: `/schedule/capacity?tab=${t.id}`, label: t.label }))} current={`/schedule/capacity?tab=${tab}`} />;
  const header = (
    <PageHeader title="仕事量と提案の設定" icon={<Gauge />} description="AI 予定候補日の提案・全体の最適化で使う、店舗の仕事量・作業の標準・製造の能力・社員と車両・経路・重み" back={{ href: "/schedule", label: "予定表" }} />
  );
  if (tab !== "capacity") {
    return (
      <div className="@container">
        <Flash msg={sp.msg} err={sp.err} />
        {header}
        {tabs}
        {tab === "ready" && <ReadyTab />}
        {tab === "dayload" && <DayLoadTab />}
        {tab === "work" && <WorkTab />}
        {tab === "production" && <ProductionTab />}
        {tab === "staff" && <StaffTab focus={sp.user} />}
        {tab === "resources" && <ResourcesTab />}
        {tab === "routing" && <RoutingTab />}
        {tab === "rules" && <RulesTab />}
        {tab === "weights" && <WeightsTab />}
        {tab === "backtest" && <BacktestTab />}
      </div>
    );
  }
  const admin = canManageSettings(user);
  const now = new Date();
  const today = toDateKey(now);
  const set = readCapacitySettings(db);
  const stats = scheduleStats(db, now);
  const stores = db.stores;
  const caps = new Map(stores.map((s) => [s.id, effectiveCapacity(db, s.id, now)]));
  const common = caps.get(stores[0]?.id ?? "koshi")!;

  // これから 14 営業日の店舗ごとの仕事量
  const days: string[] = [];
  for (let d = today; days.length < 14 && d <= addDays(today, 40); d = addDays(d, 1)) if (!isClosedDay(db, d)) days.push(d);
  const loads = new Map(stores.map((s) => [s.id, storeDayLoads(db, s.id, today, days[days.length - 1] ?? today)]));

  return (
    <div className="@container">
      <Flash msg={sp.msg} err={sp.err} />
      {header}
      {tabs}

      <div className="grid grid-cols-1 gap-4 @5xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-4">
          <Card>
            <CardHeader title="これからの仕事量 (14 営業日)" description="店舗ごとの 1 日の件数 / 上限。畳は引き取る枚数 (製造の予定)。色が濃いほど上限に近い日です" />
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-xs">
                <thead>
                  <tr className="text-left text-ink-3">
                    <th className="py-1.5 pr-2 font-medium">店舗</th>
                    <th className="py-1.5 pr-2 font-medium">項目</th>
                    {days.map((d) => (
                      <th key={d} className="px-1 py-1.5 text-center font-medium whitespace-nowrap">
                        {shortDate(d).replace(/^\d+\//, "")}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {stores.map((s) =>
                    KEYS.map((k, i) => {
                      const cap = caps.get(s.id)!;
                      return (
                        <tr key={`${s.id}-${k}`} className={clsx(i === 0 && "border-t border-line")}>
                          {i === 0 && (
                            <td rowSpan={3} className="py-1.5 pr-2 align-top font-medium whitespace-nowrap text-ink">
                              <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: s.color }} aria-hidden />
                              {s.shortName}
                            </td>
                          )}
                          <td className="py-1 pr-2 whitespace-nowrap text-ink-3">
                            {SHORT[k]} <span className="tnum">/ {cap[k]}</span>
                          </td>
                          {days.map((d) => {
                            const l = loads.get(s.id)?.get(d);
                            const used = k === "jobsPerDay" ? (l?.jobs ?? 0) : k === "visitsPerDay" ? (l?.visits ?? 0) : (l?.tatami ?? 0);
                            return (
                              <td key={d} className="px-0.5 py-0.5 text-center">
                                <span className={clsx("inline-block min-w-7 rounded px-1 py-0.5 tnum", loadTone(used, cap[k]))}>{used || "·"}</span>
                              </td>
                            );
                          })}
                        </tr>
                      );
                    }),
                  )}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-[11px] text-ink-3">担当者が未設定の予定も店舗の件数に含めます。畳の枚数は予定の件名・メモの「畳 表替え6」「畳 新調12」のような書き方から読み取ります。</p>
          </Card>

          <Card>
            <CardHeader title="提案の仕組み" />
            <ul className="space-y-1.5 text-xs leading-relaxed text-ink-2">
              <li>・休業日 (休日カレンダー) と、店舗の 1 日の上限 (現場作業・営業の訪問・引き取る畳) を超える日は候補にしません。</li>
              <li>・作業の内容 (作業種別と数量・標準工数・人数・技能・車両・製造日数・期限・お客様の希望・優先度) を予定・案件ごとに登録できます。登録がないときは件名・メモ・明細から推定します。</li>
              <li>・担当者は、休暇・終日の予定がなく、件数・作業時間・勤務日・連続勤務・残業の上限に収まり、移動時間を含めて時間が空いている人から選びます。技能を登録した社員は、必要な技能を一人前以上で持つ人を選び、同行が必要な人には熟練者を付けます。</li>
              <li>・車両・設備を登録した店舗は、必要な種類の車両の空きと積める数を確かめます。引き取りは、製造の工程の空きから完成の日を出し、期限に間に合わない日は候補にしません。</li>
              <li>・同じ案件の予定の順番 (現地調査 → 採寸 → 引き取り → 施工 → 納品。納品は製造の完成の後) を守ります。仮押さえ中の候補の枠も使いません。</li>
              <li>・点数 (0〜100) は 移動の効率・店舗の空き・製造の空き・担当者の負担・早さ・経験と熟練度・お客様の希望・期限 から計算し、応援・残業を減点します。重みは「最適化の重み」で変えられ、「提案の検証」で過去の予定と比べて調整できます。</li>
              <li>・移動時間は社内の計算 (住所の町名からの距離・道路の回り道・距離の帯・朝夕の混雑の目安) です。社内の承認と Google のキーがあれば、実際の道路の経路を使えます (「経路」)。</li>
              <li>・提案はフォームに入れる・仮押さえするだけで、予定の確定は担当者が行います。</li>
            </ul>
          </Card>
        </div>

        <Card className="@5xl:self-start">
          <CardHeader title="1 日の上限" description={admin ? "空欄は「自動」(過去 1 年の予定表で、件数の多い方から 10% の日の値)。変更は次の提案から使われます" : "設定の変更は管理者が行います"} />
          <form action={updateScheduleCapacity} className="space-y-4">
            <fieldset disabled={!admin} className="space-y-4">
              {stores.map((s) => {
                const cap = caps.get(s.id)!;
                const st = stats.stores[s.id];
                return (
                  <div key={s.id} className="rounded-xl border border-line px-3 py-2.5">
                    <p className="mb-2 text-sm font-semibold text-ink">
                      <span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: s.color }} aria-hidden />
                      {s.name}
                    </p>
                    <div className="grid grid-cols-3 gap-2">
                      {KEYS.map((k) => (
                        <Field key={k} label={SHORT[k]} hint={`${SOURCE[cap.source[k]]}: ${cap[k]}`}>
                          <Input type="number" inputMode="numeric" name={`${s.id}.${k}`} min={1} max={k === "tatamiPerDay" ? 999 : 99} defaultValue={set.stores[s.id]?.[k] ?? ""} placeholder={`自動 ${st?.[k] ?? ""}`} aria-label={`${s.shortName} ${CAPACITY_LABEL[k]}`} />
                        </Field>
                      ))}
                    </div>
                  </div>
                );
              })}
              <div className="grid grid-cols-2 gap-3">
                <Field label="1 人の 1 日の件数" hint={`${SOURCE[common.staffSource]}: ${common.staffEventsPerDay} 件`}>
                  <Input type="number" inputMode="numeric" name="staffEventsPerDay" min={1} max={20} defaultValue={set.staffEventsPerDay ?? ""} placeholder={`自動 ${stats.staffEventsPerDay}`} />
                </Field>
                <Field label="移動の速さ (km/h)" hint={`既定 ${DEFAULTS.travelSpeedKmh}`}>
                  <Input type="number" inputMode="numeric" name="travelSpeedKmh" min={10} max={80} defaultValue={set.travelSpeedKmh ?? ""} placeholder={String(DEFAULTS.travelSpeedKmh)} />
                </Field>
                <Field label="作業の開始" hint={`既定 ${DEFAULTS.workStart}`}>
                  <Input type="time" name="workStart" defaultValue={set.workStart ?? ""} />
                </Field>
                <Field label="作業の終了" hint={`既定 ${DEFAULTS.workEnd}`}>
                  <Input type="time" name="workEnd" defaultValue={set.workEnd ?? ""} />
                </Field>
                <Field label="何日後から提案するか" hint={`既定 ${DEFAULTS.leadDays} (0 = 今日から)`}>
                  <Input type="number" inputMode="numeric" name="leadDays" min={0} max={30} defaultValue={set.leadDays ?? ""} placeholder={String(DEFAULTS.leadDays)} />
                </Field>
                <Field label="探す日数" hint={`既定 ${DEFAULTS.horizonDays} 日`}>
                  <Input type="number" inputMode="numeric" name="horizonDays" min={7} max={62} defaultValue={set.horizonDays ?? ""} placeholder={String(DEFAULTS.horizonDays)} />
                </Field>
              </div>
            </fieldset>
            {admin ? <Button type="submit">保存する</Button> : <Note>設定の変更は管理者が行います。値の見直しが必要なときは管理者に依頼してください。</Note>}
          </form>
        </Card>
      </div>
    </div>
  );
}
