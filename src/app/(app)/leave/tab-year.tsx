import Link from "@/components/ui/Link";
import { fmtDate } from "@/lib/format";
import { closingRange, compBalance, fiscalLabel, fiscalRange, fiscalYearOf, fmtDays, monthsBetween, paidRemainingOn, periodRows } from "@/lib/hr/leave";
import { Button, EmptyRow, Field, Input, LinkButton, LinkTabs, Note, Select, StoreTag, Table, Td, Th, Tr } from "@/components/ui";
import { Days, type Ctx } from "./parts";

/** 年度 (7 月〜翌 6 月) と勤怠の締め (20 日締め) の取得状況と CSV */
export function YearTab({ ctx }: { ctx: Ctx }) {
  const { db, sp, today, employees, settings } = ctx;
  const mode = sp.mode === "month" ? "month" : "fy";
  const curFy = fiscalYearOf(today, settings.fiscalStartMonth);
  const fy = /^\d{4}$/.test(sp.fy ?? "") ? Number(sp.fy) : curFy;
  const month = /^\d{4}-\d{2}$/.test(sp.month ?? "") ? sp.month! : today.slice(0, 7);
  const range = mode === "fy" ? fiscalRange(fy, settings.fiscalStartMonth) : closingRange(month, settings.closingDay);
  const asOf = range.to < today ? range.to : today;
  const storeMap = new Map(db.stores.map((s) => [s.id, s]));
  const rows = periodRows(db, employees, range.from, range.to);
  const months = mode === "fy" ? monthsBetween(range.from, range.to) : [];
  const total = rows.reduce((t, r) => ({ paid: t.paid + r.paid, comp: t.comp + r.comp, special: t.special + r.special, worked: t.worked + r.worked }), { paid: 0, comp: 0, special: 0, worked: 0 });
  const qs = mode === "fy" ? `fy=${fy}` : `month=${month}`;
  const title = mode === "fy" ? fiscalLabel(fy) : `${month.replace("-", "年")}月の締め`;
  const fys = Array.from({ length: 5 }, (_, i) => curFy + 1 - i);

  return (
    <div className="space-y-4">
      <LinkTabs
        current={mode === "fy" ? "/leave?tab=year" : "/leave?tab=year&mode=month"}
        items={[
          { href: "/leave?tab=year", label: `年度 (${settings.fiscalStartMonth} 月〜)` },
          { href: "/leave?tab=year&mode=month", label: `勤怠の締め (${settings.closingDay >= 28 ? "月末" : `${settings.closingDay} 日`}締め)` },
        ]}
      />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <form method="get" className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="tab" value="year" />
          {mode === "fy" ? (
            <Field label="年度">
              <Select name="fy" defaultValue={String(fy)}>
                {fys.map((y) => <option key={y} value={y}>{fiscalLabel(y)}</option>)}
              </Select>
            </Field>
          ) : (
            <>
              <input type="hidden" name="mode" value="month" />
              <Field label="締めの月"><Input type="month" name="month" defaultValue={month} /></Field>
            </>
          )}
          <Button type="submit" variant="secondary">表示</Button>
        </form>
        <div className="flex flex-wrap gap-2">
          <LinkButton href={`/api/leave/export?${qs}&format=summary`} variant="secondary" size="sm" download>社員ごとの集計 (CSV)</LinkButton>
          <LinkButton href={`/api/leave/export?${qs}&format=detail`} variant="secondary" size="sm" download>日ごとの明細 (CSV)</LinkButton>
        </div>
      </div>
      <Note>
        {title}: {fmtDate(range.from)}〜{fmtDate(range.to)}。承認済みの休暇と休日出勤を数えます (申請中・却下・取消しは含めません)。CSV は勤怠システム・給与の締めへの受け渡し用です (勤怠の打刻・給与の計算はこのシステムでは行いません)。
      </Note>
      <Table minWidth="min-w-[860px]">
        <thead>
          <tr>
            <Th>社員</Th>
            <Th align="right">有給</Th>
            <Th align="right">振休</Th>
            <Th align="right">特別休暇</Th>
            <Th align="right">休日出勤</Th>
            <Th align="right">有給の残 ({fmtDate(asOf).slice(5)})</Th>
            <Th align="right">振休の残り (今日)</Th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <EmptyRow colSpan={7}>社員がいません</EmptyRow>}
          {rows.map((r) => {
            const comp = compBalance(db, r.user.id);
            return (
              <Tr key={r.user.id}>
                <Td>
                  <Link href={`/leave?tab=me&user=${r.user.id}`} className="text-sm text-ink hover:text-accent">{r.user.name}</Link>
                  <div className="mt-0.5"><StoreTag store={storeMap.get(r.storeId)} short /></div>
                </Td>
                <Td align="right" className="tnum"><Days value={r.paid} /></Td>
                <Td align="right" className="tnum"><Days value={r.comp} /></Td>
                <Td align="right" className="tnum"><Days value={r.special} /></Td>
                <Td align="right" className="tnum"><Days value={r.worked} /></Td>
                <Td align="right" className="tnum font-medium">{fmtDays(paidRemainingOn(db, r.user.id, asOf))}</Td>
                <Td align="right" className="tnum"><Days value={comp.remaining} tone={comp.overLimit ? "critical" : undefined} /></Td>
              </Tr>
            );
          })}
          {rows.length > 0 && (
            <Tr className="bg-subtle/60 font-medium">
              <Td>合計</Td>
              <Td align="right" className="tnum">{fmtDays(total.paid)}</Td>
              <Td align="right" className="tnum">{fmtDays(total.comp)}</Td>
              <Td align="right" className="tnum">{fmtDays(total.special)}</Td>
              <Td align="right" className="tnum">{fmtDays(total.worked)}</Td>
              <Td />
              <Td />
            </Tr>
          )}
        </tbody>
      </Table>
      {months.length > 0 && (
        <>
          <div className="text-sm font-medium text-ink">月ごとの取得 (有給 / 振休。休日出勤は「出」)</div>
          <Table minWidth="min-w-[1100px]">
            <thead>
              <tr>
                <Th>社員</Th>
                {months.map((m) => <Th key={m} align="center">{Number(m.slice(5))}月</Th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Tr key={r.user.id}>
                  <Td className="text-sm">{r.user.name}</Td>
                  {months.map((m) => {
                    const v = r.byMonth[m];
                    return (
                      <Td key={m} align="center" className="text-xs tnum">
                        {v && (v.paid || v.comp || v.worked || v.special) ? (
                          <>
                            {v.paid ? <div>有 {v.paid}</div> : null}
                            {v.comp ? <div className="text-info-ink">振 {v.comp}</div> : null}
                            {v.special ? <div className="text-ink-2">特 {v.special}</div> : null}
                            {v.worked ? <div className="text-warn-ink">出 {v.worked}</div> : null}
                          </>
                        ) : (
                          <span className="text-ink-3">-</span>
                        )}
                      </Td>
                    );
                  })}
                </Tr>
              ))}
            </tbody>
          </Table>
        </>
      )}
    </div>
  );
}
