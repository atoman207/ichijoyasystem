import Link from "@/components/ui/Link";
import { canApproveLeave, canRegisterHolidayWork } from "@/lib/auth/permissions";
import { fmtDate } from "@/lib/format";
import { LEAVE_SLOT, compBalance, daysBetweenKeys, fmtDays, md } from "@/lib/hr/leave";
import { registerHolidayWork, requestLeave } from "@/lib/actions/leave";
import { Button, Card, CardHeader, EmptyRow, Field, Input, Note, Select, StoreTag, Table, Td, Th, Tr } from "@/components/ui";
import { EmployeeOptions, type Ctx } from "./parts";

/** 振休の未取得一覧 (休日出勤ごと) と、休日出勤・振休の登録 */
export function CompTab({ ctx }: { ctx: Ctx }) {
  const { db, user, today, employees } = ctx;
  const storeMap = new Map(db.stores.map((s) => [s.id, s]));
  const balances = employees.map((u) => ({ user: u, comp: compBalance(db, u.id) }));
  const open = balances.flatMap((b) => b.comp.open.map((w) => ({ user: b.user, over: b.comp.overLimit, total: b.comp.remaining, w })));
  const over = balances.filter((b) => b.comp.overLimit);
  const registrable = employees.filter((u) => canRegisterHolidayWork(user, u));
  const hidden = <input type="hidden" name="returnTo" value={ctx.returnTo} />;

  return (
    <div className="space-y-4">
      {over.length > 0 ? (
        <Note tone="warn">
          振休のため込みが上限 ({fmtDays(ctx.settings.compLimit)}) を超えています: {over.map((b) => `${b.user.name} ${fmtDays(b.comp.remaining)}`).join("・")}。社内規定「振休ため込みは 3 日まで」のため、今月中に消化する日を決めて登録してください。
        </Note>
      ) : (
        <Note>休日出勤を登録すると、ここ (振休の未取得一覧) に入ります。振休を登録すると、古い休日出勤から順に充てて一覧から外れます。振休は年度をまたいでも消えません。ため込みの上限は {fmtDays(ctx.settings.compLimit)} です。</Note>
      )}
      <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-3">
        <div className="@4xl:col-span-2">
          <Table minWidth="min-w-[720px]">
            <thead>
              <tr>
                <Th>社員</Th>
                <Th>休日出勤</Th>
                <Th align="right">振休の残り</Th>
                <Th align="right">経過</Th>
                <Th>振休を登録</Th>
              </tr>
            </thead>
            <tbody>
              {open.length === 0 && <EmptyRow colSpan={5}>未取得の振休はありません</EmptyRow>}
              {open.map(({ user: u, over: isOver, total, w }) => (
                <Tr key={w.work.id}>
                  <Td>
                    <Link href={`/leave?tab=me&user=${u.id}`} className="text-sm font-medium text-ink hover:text-accent">{u.name}</Link>
                    <div className="mt-0.5 flex items-center gap-1.5">
                      <StoreTag store={storeMap.get(u.storeId)} short />
                      <span className={`text-[11px] ${isOver ? "font-medium text-critical-ink" : "text-ink-3"}`}>計 {fmtDays(total)}{isOver ? " (上限超え)" : ""}</span>
                    </div>
                  </Td>
                  <Td className="text-xs tnum">
                    {w.work.kind === "opening" ? `切り替え時点の残 (${fmtDate(w.work.date)})` : `${fmtDate(w.work.date, { weekday: true })} ${LEAVE_SLOT[w.work.slot]}`}
                    {w.uses.length > 0 && <div className="text-[10px] text-ink-3">充てた振休 {w.uses.map((x) => md(x.date)).join("・")}</div>}
                  </Td>
                  <Td align="right" className="tnum font-medium">{fmtDays(w.remainingHalves / 2)}</Td>
                  <Td align="right" className="text-xs tnum text-ink-3">{Math.max(0, daysBetweenKeys(w.work.date, today))} 日</Td>
                  <Td>
                    {ctx.ready && canRegisterHolidayWork(user, u) && (
                      <form action={requestLeave} className="flex flex-wrap items-center gap-1">
                        {hidden}
                        <input type="hidden" name="userId" value={u.id} />
                        <input type="hidden" name="leaveType" value="comp" />
                        <input type="hidden" name="holidayWorkId" value={w.work.id} />
                        <Input type="date" name="date" required className="h-7 w-36 text-xs" aria-label="振休の日" />
                        <Select name="slot" defaultValue={w.remainingHalves === 1 ? "am" : "day"} className="h-7 w-20 text-xs" aria-label="区分">
                          <option value="day">終日</option>
                          <option value="am">午前</option>
                          <option value="pm">午後</option>
                        </Select>
                        <Button type="submit" size="sm" variant="secondary">{canApproveLeave(user, { userId: u.id, storeId: u.storeId }) ? "登録" : "申請"}</Button>
                      </form>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
          <p className="mt-2 text-xs text-ink-3">店長・管理者が登録した振休はそのまま承認済みになり、予定表に「休暇」として載ります。本部 (事務) の登録は店長の承認を待ちます。</p>
        </div>
        <div className="space-y-4">
          {ctx.ready && registrable.length > 0 && (
            <Card>
              <CardHeader title="休日出勤を登録" description="振休が発生します (終日 1 日・半日 0.5 日)" />
              <form action={registerHolidayWork} className="space-y-2">
                {hidden}
                <Field label="社員">
                  <Select name="userId" required defaultValue="">
                    <option value="" disabled>選んでください</option>
                    <EmployeeOptions employees={registrable} db={db} />
                  </Select>
                </Field>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="出勤した日"><Input type="date" name="date" required /></Field>
                  <Field label="区分">
                    <Select name="slot" defaultValue="day">
                      <option value="day">終日</option>
                      <option value="am">午前</option>
                      <option value="pm">午後</option>
                    </Select>
                  </Field>
                </div>
                <Field label="メモ (任意)"><Input name="note" placeholder="例: 〇〇様 施工" /></Field>
                <Button type="submit" size="sm">休日出勤を登録</Button>
              </form>
            </Card>
          )}
          {ctx.ready && registrable.length > 0 && (
            <Card>
              <CardHeader title="振休を登録" description="古い休日出勤から順に充てます (特定の休日出勤に充てるときは左の一覧から)" />
              <form action={requestLeave} className="space-y-2">
                {hidden}
                <input type="hidden" name="leaveType" value="comp" />
                <Field label="社員">
                  <Select name="userId" required defaultValue="">
                    <option value="" disabled>選んでください</option>
                    <EmployeeOptions employees={registrable} db={db} />
                  </Select>
                </Field>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="振休の日"><Input type="date" name="date" required /></Field>
                  <Field label="区分">
                    <Select name="slot" defaultValue="day">
                      <option value="day">終日</option>
                      <option value="am">午前</option>
                      <option value="pm">午後</option>
                    </Select>
                  </Field>
                </div>
                <Button type="submit" size="sm" variant="secondary">振休を登録</Button>
              </form>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
