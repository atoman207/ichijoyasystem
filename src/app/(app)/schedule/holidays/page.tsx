import Link from "@/components/ui/Link";
import clsx from "clsx";
import { CalendarOff, ChevronLeft, ChevronRight, Printer } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/store";
import { canManageHolidays } from "@/lib/auth/permissions";
import { dayOfWeek, isDateKey, lawHolidayName, shortDate } from "@/lib/calendar";
import { fmtDateTime, toDateKey } from "@/lib/format";
import { userName } from "@/lib/db/queries";
import {
  DEFAULT_CLOSED_LABEL,
  HOLIDAY_SETTINGS_ID,
  HOLIDAY_SOURCE_LABEL,
  LABEL_MAX,
  closedDayMap,
  describeRule,
  holidayResolver,
  holidayYears,
  planClosedDays,
  readClosedDayRule,
  readHolidayOverrides,
  ruleParams,
  yearHolidays,
  yearSummary,
} from "@/lib/holiday-calendar";
import { applyClosedDays, saveClosedDay, saveNationalHoliday } from "@/lib/actions/holidays";
import { HolidayYear } from "@/components/schedule/HolidayYear";
import { Badge, Button, Card, CardHeader, Field, Flash, Input, LinkButton, LinkTabs, Note, PageHeader, Select, Stat, Table, Td, Th, Tr } from "@/components/ui";

export const dynamic = "force-dynamic";

const WEEK = ["日", "月", "火", "水", "木", "金", "土"];
const longDay = (d: string) => `${Number(d.slice(0, 4))}年${Number(d.slice(5, 7))}月${Number(d.slice(8))}日 (${WEEK[dayOfWeek(d)]})`;

/**
 * 休日カレンダー: 会社の休業日 (company_holidays) と祝日 (規則で計算 + 管理者の変更) を 1 年ずつ表示する。
 * 見るのは全員、変更は管理者 (canManageHolidays)。休業日は予定表・予定の候補日の提案・有給の日数・作業日報が使う
 */
export default async function HolidayCalendarPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = await searchParams;
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(raw)) for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) sp.append(k, x);
  const user = await requireUser();
  const db = getDb();
  const canEdit = canManageHolidays(user);
  const today = toDateKey(new Date());
  const yearParam = Number(sp.get("year"));
  const year = Number.isInteger(yearParam) && yearParam >= 2000 && yearParam <= 2099 ? yearParam : Number(today.slice(0, 4));
  const years = [...new Set([...holidayYears(db), year])].sort((a, b) => a - b);
  const selected = isDateKey(sp.get("date")) && sp.get("date")!.startsWith(`${year}-`) ? sp.get("date")! : undefined;

  const closed = closedDayMap(db);
  const closedLabels = new Map([...closed].map(([d, h]) => [d, h.label]));
  const holidayOf = holidayResolver(db);
  const summary = yearSummary(db, year);
  const holidays = yearHolidays(db, year);
  const overrides = readHolidayOverrides(db);
  const lastClosed = [...closed.keys()].reduce((m, d) => (d > m ? d : m), "");
  const setting = db.settings.find((s) => s.id === HOLIDAY_SETTINGS_ID);

  const here = (over: Record<string, string | undefined> = {}, hash = "") => {
    const p = new URLSearchParams({ year: String(year) });
    for (const [k, v] of Object.entries(over)) if (v) p.set(k, v);
    return `/schedule/holidays?${p.toString()}${hash}`;
  };
  const back = here(selected ? { date: selected } : {});

  // まとめて登録の確認 (検索パラメーターで条件を受け取り、書き込まずに計算する)
  // preview = 1 で確認の画面、0 は条件を直す (入力欄に前の条件を入れる)
  const parsed = canEdit && sp.has("from") ? readClosedDayRule((k) => sp.get(k), (k) => sp.getAll(k)) : undefined;
  const ruleDefaults = parsed && !("error" in parsed) ? parsed : undefined;
  const preview = sp.get("preview") === "1" ? parsed : undefined;
  const plan = preview && !("error" in preview) ? planClosedDays(db, preview) : undefined;
  const yearHolidaysTotal = holidays.filter((h) => h.source !== "removed").length;
  const closedHolidays = holidays.filter((h) => h.source !== "removed" && h.closed).length;

  return (
    <div>
      <Flash msg={sp.get("msg") ?? undefined} err={sp.get("err") ?? undefined} />
      <PageHeader
        title="休日カレンダー"
        icon={<CalendarOff />}
        description="会社の休業日と祝日。休業日は予定表・予定の候補日の提案・有給の日数・作業日報に使います。祝日は休業日とは別で、祝日を休業日にするかは休業日として登録します"
        back={{ href: "/schedule", label: "予定表" }}
        actions={
          <LinkButton href={`/print/holidays?year=${year}`} variant="secondary" size="sm">
            <Printer />
            印刷
          </LinkButton>
        }
      />

      <div className="mb-2 flex items-center gap-2">
        {year > 2000 && (
          <LinkButton href={here({ year: String(year - 1) })} variant="ghost" size="sm" aria-label="前の年">
            <ChevronLeft />
          </LinkButton>
        )}
        <div className="min-w-0 flex-1">
          <LinkTabs items={years.map((y) => ({ href: `/schedule/holidays?year=${y}`, label: `${y}年` }))} current={`/schedule/holidays?year=${year}`} />
        </div>
        {year < 2099 && (
          <LinkButton href={here({ year: String(year + 1) })} variant="ghost" size="sm" aria-label="次の年">
            <ChevronRight />
          </LinkButton>
        )}
      </div>

      <div className="mb-4 grid grid-cols-1 gap-3 @xl:grid-cols-2 @4xl:grid-cols-4">
        <Stat label={`${year}年の休業日`} value={`${summary.closed} 日`} sub={`日曜 ${summary.sundays} · 土曜 ${summary.saturdays} · 祝日 ${summary.holidays} · その他 ${summary.others}`} />
        <Stat label="営業日" value={`${summary.workdays} 日`} sub="休業日として登録していない日" />
        <Stat label="祝日" value={`${yearHolidaysTotal} 日`} sub={`うち休業日 ${closedHolidays} 日`} />
        <Stat label="休業日の登録" value={lastClosed ? `${lastClosed.replaceAll("-", "/")} まで` : "なし"} sub="これより後は日曜だけを休みとして扱います" />
      </div>

      {summary.emptyMonths.length > 0 && (
        <div className="mb-4">
          <Note tone="warn">
            {year}年の {summary.emptyMonths.map((m) => `${m}月`).join("・")} は休業日が 1 日も登録されていません。
            {canEdit ? "下の「休業日のまとめて登録」で、曜日・隔週の土曜・祝日・期間から登録できます。" : "休業日の登録は管理者が行います。"}
          </Note>
        </div>
      )}

      <Card>
        <CardHeader
          title={`${year}年`}
          description={
            <>
              <span className="mr-2 inline-block h-3 w-3 rounded-sm bg-critical-soft align-middle ring-1 ring-critical/30" /> 休業日 ·
              <span className="mx-1 text-critical-ink">赤字</span>日曜・祝日 ·<span className="mx-1 text-info-ink">青字</span>土曜 · 点 = 祝日
              {canEdit && " · 日付を押すと、その日の休業日・祝日を変更できます"}
            </>
          }
        />
        <HolidayYear year={year} closed={closedLabels} holidayOf={holidayOf} today={today} selected={selected} hrefOf={canEdit ? (d) => here({ date: d }, "#day") : undefined} />
      </Card>

      <div className="mt-4 grid grid-cols-1 gap-4 @4xl:grid-cols-2">
        {canEdit && (
          <Card id="day">
            {selected ? (
              <DayEditor date={selected} closedLabel={closed.get(selected)?.label} holiday={holidayOf(selected)} lawName={lawHolidayName(selected)} overridden={Object.prototype.hasOwnProperty.call(overrides, selected)} back={back} />
            ) : (
              <>
                <CardHeader title="1 日の変更" description="上のカレンダーの日付を押すと、その日を休業日にする・外す・名前を変える、祝日を追加する・外す・名前を変えることができます" />
                <p className="text-sm text-ink-3">日付が選ばれていません。</p>
              </>
            )}
          </Card>
        )}

        {canEdit && (
          <Card id="bulk">
            <CardHeader title="休業日のまとめて登録" description="期間と条件 (毎週の曜日・隔週の土曜・祝日・期間のすべての日) で、休業日をまとめて登録・解除します。「確認する」で対象の日を確かめてから反映します" />
            {preview && "error" in preview && (
              <div className="mb-3">
                <Note tone="warn">{preview.error}</Note>
              </div>
            )}
            {plan ? (
              <BulkPreview plan={plan} back={here()} />
            ) : (
              <form action="/schedule/holidays#bulk" method="get" className="space-y-3">
                <input type="hidden" name="year" value={year} />
                <input type="hidden" name="preview" value="1" />
                <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
                  <Field label="開始日" required>
                    <Input type="date" name="from" defaultValue={ruleDefaults?.from ?? `${year}-01-01`} required />
                  </Field>
                  <Field label="終了日" required hint="3 年以内">
                    <Input type="date" name="to" defaultValue={ruleDefaults?.to ?? `${year}-12-31`} required />
                  </Field>
                </div>
                <fieldset>
                  <legend className="mb-1 text-xs font-medium text-ink-2">毎週の曜日</legend>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                    {WEEK.map((w, i) => (
                      <label key={w} className="inline-flex items-center gap-1.5">
                        <input type="checkbox" name="weekday" value={i} defaultChecked={ruleDefaults ? ruleDefaults.weekdays.includes(i) : i === 0} /> {w}曜
                      </label>
                    ))}
                  </div>
                </fieldset>
                <Field label="隔週の土曜 (基準の土曜)" hint="入力すると、この土曜と 2 週ごとの土曜が対象になります (毎週の土曜を選んだときは使いません)">
                  <Input type="date" name="altSaturday" defaultValue={ruleDefaults?.altSaturday ?? ""} />
                </Field>
                <div className="flex flex-col gap-1 text-sm">
                  <label className="inline-flex items-center gap-1.5">
                    <input type="checkbox" name="holidays" value="1" defaultChecked={ruleDefaults?.holidays ?? false} /> 祝日 (振替休日・国民の休日を含む)
                  </label>
                  <label className="inline-flex items-center gap-1.5">
                    <input type="checkbox" name="allDays" value="1" defaultChecked={ruleDefaults?.allDays ?? false} /> 期間のすべての日 (年末年始・お盆・夏季休業など。曜日の条件は使いません)
                  </label>
                </div>
                <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
                  <Field label="休業日の名前" hint="例: 休業日・年末年始・お盆・社員旅行">
                    <Input name="label" defaultValue={ruleDefaults?.label ?? DEFAULT_CLOSED_LABEL} maxLength={LABEL_MAX} />
                  </Field>
                  <Field label="操作">
                    <Select name="mode" defaultValue={ruleDefaults?.mode ?? "add"}>
                      <option value="add">休業日にする</option>
                      <option value="remove">休業日から外す</option>
                    </Select>
                  </Field>
                </div>
                <Button type="submit" variant="secondary">
                  確認する
                </Button>
              </form>
            )}
          </Card>
        )}
      </div>

      <Card className="mt-4">
        <CardHeader
          title={`${year}年の祝日`}
          description="「国民の祝日に関する法律」の規則で計算しています。春分の日・秋分の日は毎年 2 月に翌年の分が官報で決まるため、それより先の年は計算による予定の日付です。法律の変更などで違うときは、管理者が日付を押して直します"
        />
        <Table minWidth="min-w-[560px]">
            <thead>
              <tr>
                <Th>日付</Th>
                <Th>祝日</Th>
                <Th>種類</Th>
                <Th>会社</Th>
              </tr>
            </thead>
            <tbody>
              {holidays.map((h) => (
                <Tr key={h.date} className={clsx(h.source === "removed" && "opacity-60")}>
                  <Td>
                    {canEdit ? (
                      <Link href={here({ date: h.date }, "#day")} className="text-accent-ink hover:underline">
                        {shortDate(h.date)}
                      </Link>
                    ) : (
                      shortDate(h.date)
                    )}
                  </Td>
                  <Td>
                    <span className={clsx(h.source === "removed" && "line-through")}>{h.name}</span>
                    {h.source === "renamed" && h.lawName && <span className="ml-1 text-xs text-ink-3">(規則では {h.lawName})</span>}
                  </Td>
                  <Td>
                    <Badge tone={h.source === "law" ? "neutral" : h.source === "removed" ? "warn" : "info"}>{HOLIDAY_SOURCE_LABEL[h.source]}</Badge>
                  </Td>
                  <Td>{h.closed ? <Badge tone="critical">休業日 ({closed.get(h.date)?.label})</Badge> : <span className="text-xs text-ink-3">{dayOfWeek(h.date) === 0 ? "日曜 (休業日の登録なし)" : "営業日"}</span>}</Td>
                </Tr>
              ))}
            </tbody>
        </Table>
        {setting?.updatedAt && (
          <p className="mt-2 text-[11px] text-ink-3">
            祝日の最後の変更: {fmtDateTime(setting.updatedAt)} ({userName(setting.updatedBy)})
          </p>
        )}
      </Card>

      {!canEdit && (
        <div className="mt-4">
          <Note>休業日・祝日の変更は管理者が行います。違いに気づいたら管理者に知らせてください。</Note>
        </div>
      )}
    </div>
  );
}

function DayEditor({ date, closedLabel, holiday, lawName, overridden, back }: { date: string; closedLabel?: string; holiday?: string; lawName?: string; overridden: boolean; back: string }) {
  const w = dayOfWeek(date);
  return (
    <>
      <CardHeader
        title={longDay(date)}
        description={
          <span className="inline-flex flex-wrap items-center gap-1.5">
            {closedLabel ? <Badge tone="critical">休業日 ({closedLabel})</Badge> : <Badge tone="good">営業日</Badge>}
            {holiday ? <Badge tone="info">祝日: {holiday}</Badge> : <span className="text-ink-3">祝日ではありません</span>}
            {w === 0 && !closedLabel && <span className="text-ink-3">日曜ですが休業日として登録されていません</span>}
          </span>
        }
      />
      <div className="space-y-5">
        <form action={saveClosedDay} className="space-y-2">
          <input type="hidden" name="date" value={date} />
          <input type="hidden" name="back" value={back} />
          <Field label="休業日の名前" hint="例: 休業日・年末年始・お盆・社員旅行">
            <Input name="label" defaultValue={closedLabel ?? (holiday ? holiday : DEFAULT_CLOSED_LABEL)} maxLength={LABEL_MAX} />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" name="closed" value="1" size="sm">
              {closedLabel ? "名前を保存" : "休業日にする"}
            </Button>
            {closedLabel && (
              <Button type="submit" name="closed" value="0" size="sm" variant="secondary">
                休業日から外す (営業日にする)
              </Button>
            )}
          </div>
        </form>

        <form action={saveNationalHoliday} className="space-y-2 border-t border-line pt-4">
          <input type="hidden" name="date" value={date} />
          <input type="hidden" name="back" value={back} />
          <Field label="祝日の名前" hint={lawName ? `規則では「${lawName}」` : "規則では祝日ではありません"}>
            <Input name="name" defaultValue={holiday ?? ""} maxLength={LABEL_MAX} placeholder="例: 振替休日" />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" name="op" value="set" size="sm" variant="secondary">
              {holiday ? "祝日の名前を保存" : "祝日にする"}
            </Button>
            {holiday && (
              <Button type="submit" name="op" value="remove" size="sm" variant="ghost">
                祝日から外す
              </Button>
            )}
            {overridden && (
              <Button type="submit" name="op" value="reset" size="sm" variant="ghost">
                規則どおりに戻す
              </Button>
            )}
          </div>
          <p className="text-[11px] text-ink-3">祝日を変えても休業日は変わりません。祝日を休業日にするときは、上で休業日にしてください。</p>
        </form>
      </div>
    </>
  );
}

function BulkPreview({ plan, back }: { plan: NonNullable<ReturnType<typeof planClosedDays>>; back: string }) {
  const add = plan.rule.mode === "add";
  const items = add ? plan.add.map((a) => ({ date: a.date, note: a.reason })) : plan.remove.map((h) => ({ date: h.date, note: h.label }));
  const byMonth = new Map<string, typeof items>();
  for (const it of items) {
    const k = it.date.slice(0, 7);
    byMonth.set(k, [...(byMonth.get(k) ?? []), it]);
  }
  const editHref = `/schedule/holidays?${new URLSearchParams([["year", plan.rule.from.slice(0, 4)], ["preview", "0"], ...ruleParams(plan.rule)]).toString()}#bulk`;
  return (
    <div className="space-y-3">
      <div className="rounded-xl bg-subtle px-3 py-2 text-sm">
        <div className="font-medium text-ink">{describeRule(plan.rule)}</div>
        <div className="mt-0.5 text-ink-2">
          条件に合う日 {plan.matched.length} 日 → {add ? `休業日にする ${plan.add.length} 日 (名前「${plan.rule.label}」)` : `休業日から外す ${plan.remove.length} 日`} · {add ? "すでに休業日" : "休業日ではない"} {plan.unchanged} 日
        </div>
      </div>
      {items.length > 0 ? (
        <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
          {[...byMonth].map(([ym, list]) => (
            <div key={ym}>
              <div className="text-xs font-semibold text-ink-2">
                {Number(ym.slice(0, 4))}年{Number(ym.slice(5))}月 ({list.length} 日)
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                {list.map((it) => (
                  <span key={it.date} className={clsx("rounded-md px-1.5 py-0.5 text-[11px] tnum", add ? "bg-critical-soft text-critical-ink" : "bg-neutral-soft text-ink-2")} title={it.note}>
                    {shortDate(it.date)}
                    {!/^毎週|^隔週|^期間$|^休業日$/.test(it.note) && <span className="ml-0.5 text-ink-3">{it.note}</span>}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-ink-3">{add ? "休業日にする日はありません (条件に合う日はすべて休業日です)。" : "休業日から外す日はありません。"}</p>
      )}
      <form action={applyClosedDays} className="flex flex-wrap items-center gap-2">
        {ruleParams(plan.rule).map(([k, v], i) => (
          <input key={`${k}${i}`} type="hidden" name={k} value={v} />
        ))}
        <input type="hidden" name="expect" value={items.length} />
        <input type="hidden" name="back" value={back} />
        <Button type="submit" variant={add ? "primary" : "danger"} disabled={!items.length}>
          {add ? `この ${items.length} 日を休業日にする` : `この ${items.length} 日を休業日から外す`}
        </Button>
        <LinkButton href={editHref} variant="ghost">
          条件を直す
        </LinkButton>
      </form>
    </div>
  );
}
