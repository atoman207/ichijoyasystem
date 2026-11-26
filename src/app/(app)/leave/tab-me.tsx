import Link from "@/components/ui/Link";
import { canApproveLeave, canCancelLeave, canManageLeaveGrants, canRegisterHolidayWork, canRequestLeaveFor, canViewLeaveBalanceOf } from "@/lib/auth/permissions";
import { userName } from "@/lib/db/queries";
import { fmtDate, fmtDateTime } from "@/lib/format";
import {
  LEAVE_SLOT,
  LEAVE_TYPE,
  annualObligation,
  compBalance,
  compLedger,
  fiscalLabel,
  fiscalRange,
  fiscalYearOf,
  fmtDays,
  grantExpiry,
  leaveProfile,
  md,
  paidBalance,
  periodRows,
  suggestGrant,
} from "@/lib/hr/leave";
import { cancelLeaveRequest, createLeaveGrant, deleteHolidayWork, deleteLeaveGrant, registerHolidayWork, requestLeave, saveLeaveProfile, updateLeaveGrant } from "@/lib/actions/leave";
import { Button, Card, CardHeader, EmptyRow, Field, Input, Note, Select, Stat, StoreTag, Table, Td, Th, Tr, Textarea } from "@/components/ui";
import { CalendarCheck, CalendarClock, Hourglass, Repeat } from "lucide-react";
import { Days, EmployeeOptions, LeaveStatusBadge, LeaveTypeBadge, leaveWhen, type Ctx } from "./parts";

/** 自分 (または選んだ社員) の残日数・申請・付与・休日出勤 */
export function MeTab({ ctx }: { ctx: Ctx }) {
  const { db, user, sp, today, employees } = ctx;
  const target = employees.find((u) => u.id === sp.user) ?? user;
  const self = target.id === user.id;
  const base = `/leave?tab=me${self ? "" : `&user=${target.id}`}`;
  const paid = paidBalance(db, target.id, today);
  const comp = compBalance(db, target.id);
  const ob = annualObligation(db, target.id, today);
  const fy = fiscalYearOf(today, ctx.settings.fiscalStartMonth);
  const range = fiscalRange(fy, ctx.settings.fiscalStartMonth);
  const year = periodRows(db, [target], range.from, range.to)[0];
  const requests = db.leaveRequests.filter((r) => r.userId === target.id).sort((a, b) => b.date.localeCompare(a.date) || b.requestedAt.localeCompare(a.requestedAt));
  const canRequest = canRequestLeaveFor(user, target);
  const settles = canApproveLeave(user, { userId: target.id, storeId: target.storeId });
  const canGrant = canManageLeaveGrants(user);
  const canWork = canRegisterHolidayWork(user, target);
  const editGrant = canGrant ? db.leaveGrants.find((g) => g.id === sp.editGrant && g.userId === target.id) : undefined;
  const suggestion = suggestGrant(db, target, today);
  const profile = leaveProfile(db, target);
  const store = db.stores.find((s) => s.id === target.storeId);
  const hidden = <input type="hidden" name="returnTo" value={base} />;
  // 残日数は本人と本部・管理者だけ (お客様のご要望 2026-11-26)。店長は自店舗の社員の休暇を申請・承認できるが残日数は見ない
  const showBalance = canViewLeaveBalanceOf(user, target);

  return (
    <div className="space-y-4">
      {employees.length > 1 && (
        <form method="get" className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="tab" value="me" />
          <Field label="社員">
            <Select name="user" defaultValue={target.id}>
              <EmployeeOptions employees={employees} db={db} />
            </Select>
          </Field>
          <Button type="submit" variant="secondary">表示</Button>
          {!self && <Link href="/leave?tab=me" className="text-xs text-accent hover:underline">自分に戻る</Link>}
        </form>
      )}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-semibold text-ink">{target.name}</span>
        <StoreTag store={store} short />
        <span className="text-xs text-ink-3">
          雇い入れ {profile.hiredOn ? fmtDate(profile.hiredOn) : "未登録"} · 基準日 {profile.baseDate ? `${md(profile.baseDate)} (毎年)` : "未登録"}
          {profile.weeklyDays !== 5 ? ` · 週 ${profile.weeklyDays} 日勤務` : ""}
        </span>
      </div>

      {showBalance ? (
        <>
      <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @4xl:grid-cols-4">
        <Stat
          label="有給の残日数"
          value={fmtDays(paid.remaining)}
          icon={<CalendarCheck />}
          tone={paid.shortage > 0 ? "critical" : undefined}
          sub={[paid.pending ? `申請中 ${fmtDays(paid.pending)}` : "", paid.expiring.length ? `${paid.expiring.map((e) => `${fmtDate(e.expiresOn)} に ${fmtDays(e.days)} が期限`).join("・")}` : "", paid.future ? `付与予定 ${fmtDays(paid.future)}` : ""].filter(Boolean).join(" · ") || "承認済みの先の休暇も差し引いた残です"}
        />
        <Stat
          label={`振休の残り (ため込みの上限 ${fmtDays(comp.limit)})`}
          value={fmtDays(comp.remaining)}
          icon={<Repeat />}
          tone={comp.overLimit ? "critical" : undefined}
          sub={comp.overLimit ? "上限を超えています。早めに振休の日を決めてください" : comp.pending ? `申請中 ${fmtDays(comp.pending)}` : `休日出勤 ${fmtDays(comp.earned)} · 取得 ${fmtDays(comp.taken)}`}
        />
        <Stat label={`${fiscalLabel(fy)}の取得`} value={fmtDays((year?.paid ?? 0) + (year?.comp ?? 0) + (year?.special ?? 0))} icon={<CalendarClock />} sub={`有給 ${fmtDays(year?.paid ?? 0)} · 振休 ${fmtDays(year?.comp ?? 0)} · 休日出勤 ${fmtDays(year?.worked ?? 0)}`} />
        <Stat
          label="年 5 日の取得 (付与から 1 年)"
          value={ob ? `${fmtDays(ob.taken)} / 5 日` : "-"}
          icon={<Hourglass />}
          tone={ob && !ob.met ? "critical" : undefined}
          sub={ob ? (ob.met ? "取得済み" : `期限 ${fmtDate(ob.deadline)} まであと ${fmtDays(ob.required - ob.taken)}`) : "10 日以上の付与の登録がありません"}
        />
      </div>
      {paid.shortage > 0 && <Note tone="warn">承認済みの有給のうち {fmtDays(paid.shortage)} に充てる付与がありません (付与の登録漏れ・期限切れ)。付与の登録を確かめてください。</Note>}
      {comp.shortage > 0 && <Note tone="warn">休日出勤のない振休が {fmtDays(comp.shortage)} あります (休日出勤の登録漏れ)。</Note>}
        </>
      ) : (
        <Note>有給・振休の残日数は、本人と本部・管理者だけが見られます。休暇の申請・承認はこの画面でできます。</Note>
      )}

      <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-3">
        <div className="space-y-4 @4xl:col-span-2">
          <Card padded={false}>
            <div className="p-5 pb-0">
              <CardHeader title="休暇の申請" description="承認されると予定表に「休暇」として表示され、残日数が減ります。申請中・まだ始まっていない休暇は取り消せます" />
            </div>
            <Table className="rounded-none border-0 shadow-none" minWidth="min-w-[640px]">
              <thead>
                <tr>
                  <Th>日付</Th>
                  <Th>種類</Th>
                  <Th align="right">日数</Th>
                  <Th>状態</Th>
                  <Th>操作</Th>
                </tr>
              </thead>
              <tbody>
                {requests.length === 0 && <EmptyRow colSpan={5}>休暇の申請はありません</EmptyRow>}
                {requests.slice(0, 60).map((r) => (
                  <Tr key={r.id}>
                    <Td className="text-xs tnum">
                      <div className="font-medium text-ink">{leaveWhen(r)}</div>
                      <div className="font-mono text-[10px] text-ink-3">{r.number}</div>
                    </Td>
                    <Td>
                      <LeaveTypeBadge type={r.leaveType} />
                      {r.reason && <div className="mt-0.5 text-[11px] text-ink-3">{r.reason}</div>}
                    </Td>
                    <Td align="right" className="tnum">{fmtDays(r.days)}</Td>
                    <Td className="text-xs">
                      <LeaveStatusBadge status={r.status} />
                      <div className="mt-0.5 text-[11px] text-ink-3">
                        申請 {userName(r.requestedBy)} {fmtDateTime(r.requestedAt)}
                        {r.decidedBy && <> · 判断 {userName(r.decidedBy)}</>}
                        {r.decisionComment && <> · {r.decisionComment}</>}
                        {r.cancelledBy && <> · 取消 {userName(r.cancelledBy)}{r.cancelReason ? ` (${r.cancelReason})` : ""}</>}
                      </div>
                      {r.eventId && r.status === "approved" && <Link href={`/schedule/${r.eventId}`} className="text-[11px] text-accent hover:underline">予定表で見る</Link>}
                    </Td>
                    <Td className="text-xs">
                      {ctx.ready && canCancelLeave(user, r, today) && (
                        <form action={cancelLeaveRequest.bind(null, r.id)} className="flex flex-wrap items-center gap-1">
                          {hidden}
                          <Input name="reason" placeholder="理由 (任意)" className="h-7 w-28 text-xs" aria-label="取消しの理由" />
                          <Button type="submit" size="sm" variant="danger">{r.status === "pending" ? "取り下げ" : "取り消す"}</Button>
                        </form>
                      )}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>

          {showBalance && (
            <>
          <Card padded={false}>
            <div className="p-5 pb-0">
              <CardHeader title="有給の付与と消化" description={`付与ごとの残。期限 (付与から 2 年) の早いものから${ctx.settings.consumeOrder === "oldest" ? "" : "ではなく、新しい付与 (当年度分) から"}消化します`} />
            </div>
            <Table className="rounded-none border-0 shadow-none" minWidth="min-w-[640px]">
              <thead>
                <tr>
                  <Th>付与日</Th>
                  <Th align="right">付与</Th>
                  <Th align="right">消化</Th>
                  <Th align="right">残</Th>
                  <Th>有効期限</Th>
                  <Th>備考</Th>
                </tr>
              </thead>
              <tbody>
                {paid.grants.length === 0 && <EmptyRow colSpan={6}>有給の付与が登録されていません (事務・管理者が登録します)</EmptyRow>}
                {[...paid.grants].reverse().map((g) => (
                  <Tr key={g.grant.id}>
                    <Td className="text-xs tnum">
                      {fmtDate(g.grant.grantDate)}
                      {g.grant.kind === "opening" && <div className="text-[10px] text-ink-3">切り替え時点{g.grant.baseDate ? ` (付与 ${fmtDate(g.grant.baseDate)})` : ""}</div>}
                    </Td>
                    <Td align="right" className="tnum">{fmtDays(g.halves / 2)}</Td>
                    <Td align="right" className="tnum"><Days value={g.usedHalves / 2} /></Td>
                    <Td align="right" className="tnum font-medium"><Days value={g.remainingHalves / 2} tone={g.state === "expired" && g.remainingHalves ? "critical" : undefined} /></Td>
                    <Td className="text-xs tnum">
                      {fmtDate(g.grant.expiresOn)}
                      <div className="text-[10px] text-ink-3">{g.state === "expired" ? (g.remainingHalves ? "期限切れ (消滅)" : "期限切れ") : g.state === "future" ? "付与前" : "使える"}</div>
                    </Td>
                    <Td className="text-xs text-ink-3">
                      {g.grant.note}
                      {canGrant && ctx.ready && (
                        <div className="mt-1 flex gap-2">
                          <Link href={`${base}&editGrant=${g.grant.id}`} className="text-[11px] text-accent hover:underline">修正</Link>
                          <form action={deleteLeaveGrant.bind(null, g.grant.id)}>
                            {hidden}
                            <button type="submit" className="text-[11px] text-critical hover:underline">削除</button>
                          </form>
                        </div>
                      )}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>

          <Card padded={false}>
            <div className="p-5 pb-0">
              <CardHeader title="休日出勤と振休" description="休日出勤 1 回ごとの振休の残。振休は古い休日出勤から順に充てます (年度をまたいでも消えません)" />
            </div>
            <Table className="rounded-none border-0 shadow-none" minWidth="min-w-[560px]">
              <thead>
                <tr>
                  <Th>休日出勤</Th>
                  <Th align="right">振休</Th>
                  <Th>充てた振休</Th>
                  <Th align="right">残り</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const works = db.holidayWorks.filter((w) => w.userId === target.id).sort((a, b) => b.date.localeCompare(a.date));
                  if (!works.length) return <EmptyRow colSpan={5}>休日出勤の登録はありません</EmptyRow>;
                  const all = new Map(compLedger(db, target.id).works.map((w) => [w.work.id, w]));
                  return works.slice(0, 40).map((w) => {
                    const st = all.get(w.id);
                    return (
                      <Tr key={w.id}>
                        <Td className="text-xs tnum">
                          {w.kind === "opening" ? `切り替え時点の残 (${fmtDate(w.date)})` : `${fmtDate(w.date, { weekday: true })} ${LEAVE_SLOT[w.slot]}`}
                          {w.note && w.kind !== "opening" && <div className="text-[10px] text-ink-3">{w.note}</div>}
                        </Td>
                        <Td align="right" className="tnum">{fmtDays(w.days)}</Td>
                        <Td className="text-xs text-ink-2">{st?.uses.map((u) => `${md(u.date)}${u.halves === 1 ? "(半日)" : ""}`).join("・") || "-"}</Td>
                        <Td align="right" className="tnum font-medium"><Days value={(st?.remainingHalves ?? 0) / 2} tone={comp.overLimit ? "warn" : undefined} /></Td>
                        <Td className="text-xs">
                          {canWork && ctx.ready && (w.kind === "work" || canGrant) && (
                            <form action={deleteHolidayWork.bind(null, w.id)}>
                              {hidden}
                              <button type="submit" className="text-[11px] text-critical hover:underline">削除</button>
                            </form>
                          )}
                        </Td>
                      </Tr>
                    );
                  });
                })()}
              </tbody>
            </Table>
          </Card>
            </>
          )}
        </div>

        <div className="space-y-4">
          {canRequest && ctx.ready && (
            <Card>
              <CardHeader title={self ? "休暇を申請する" : `${target.name} さんの休暇を登録`} description={settles ? "あなたは承認できるため、登録するとそのまま承認済みになり予定表に載ります" : "所属店舗の店長 (店長の休暇は管理者) が承認します"} />
              <form action={requestLeave} className="space-y-2">
                {hidden}
                <input type="hidden" name="userId" value={target.id} />
                <Field label="種類">
                  <Select name="leaveType" defaultValue={sp.leaveType === "comp" ? "comp" : "paid"}>
                    {(Object.keys(LEAVE_TYPE) as (keyof typeof LEAVE_TYPE)[]).map((t) => <option key={t} value={t}>{LEAVE_TYPE[t].label}{showBalance ? (t === "paid" ? ` (残 ${fmtDays(paid.remaining - paid.pending)})` : t === "comp" ? ` (残 ${fmtDays(comp.remaining - comp.pending)})` : "") : ""}</option>)}
                  </Select>
                </Field>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="日付"><Input type="date" name="date" defaultValue={sp.date} required /></Field>
                  <Field label="区分">
                    <Select name="slot" defaultValue="day">
                      <option value="day">終日 (1 日)</option>
                      <option value="am">午前 (0.5 日)</option>
                      <option value="pm">午後 (0.5 日)</option>
                    </Select>
                  </Field>
                </div>
                <Field label="終了日 (複数日のとき)" hint="終日のみ。休業日は日数に数えません"><Input type="date" name="endDate" /></Field>
                {comp.open.length > 0 && (
                  <Field label="振休に充てる休日出勤 (任意)" hint="空 = 古い休日出勤から順に充てます">
                    <Select name="holidayWorkId" defaultValue="">
                      <option value="">古いものから</option>
                      {comp.open.map((w) => <option key={w.work.id} value={w.work.id}>{w.work.kind === "opening" ? "切り替え時点の残" : `${md(w.work.date)} ${LEAVE_SLOT[w.work.slot]}`} (残 {fmtDays(w.remainingHalves / 2)})</option>)}
                    </Select>
                  </Field>
                )}
                <Field label="理由・連絡 (任意。特別休暇は必須)"><Textarea name="reason" rows={2} placeholder="例: 通院のため午前休 / 慶弔 (祖母の葬儀)" /></Field>
                <Button type="submit" size="sm">{settles ? "登録して承認する" : "申請する"}</Button>
              </form>
            </Card>
          )}
          {canWork && ctx.ready && (
            <Card>
              <CardHeader title="休日出勤を登録" description="振休が発生します (終日 1 日・半日 0.5 日)" />
              <form action={registerHolidayWork} className="space-y-2">
                {hidden}
                <input type="hidden" name="userId" value={target.id} />
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
                <Button type="submit" size="sm" variant="secondary">休日出勤を登録</Button>
              </form>
            </Card>
          )}
          {canGrant && ctx.ready && editGrant && (
            <Card>
              <CardHeader title={`付与 (${fmtDate(editGrant.grantDate)}) を修正`} action={<Link href={base} className="text-xs text-ink-3 hover:underline">閉じる</Link>} />
              <form action={updateLeaveGrant.bind(null, editGrant.id)} className="space-y-2">
                {hidden}
                <div className="grid grid-cols-2 gap-2">
                  <Field label="日数"><Input type="number" name="days" step="0.5" min="0.5" max="40" defaultValue={editGrant.days} required /></Field>
                  <Field label="有効期限"><Input type="date" name="expiresOn" defaultValue={editGrant.expiresOn} required /></Field>
                </div>
                <Field label="備考"><Input name="note" defaultValue={editGrant.note} /></Field>
                <Button type="submit" size="sm">修正する</Button>
              </form>
            </Card>
          )}
          {canGrant && ctx.ready && (
            <Card>
              <CardHeader
                title="有給を付与"
                description={suggestion ? `次の付与の目安: ${fmtDate(suggestion.date)}${suggestion.days !== undefined ? ` · 法定 ${suggestion.days} 日 (勤続 ${Math.floor((suggestion.months ?? 0) / 12)} 年 ${(suggestion.months ?? 0) % 12} か月)` : " · 雇い入れ日が未登録のため日数は手入力"}${suggestion.due ? " · 付与日を過ぎています" : ""}` : "基準日・雇い入れ日を登録すると、付与日と法定の日数の目安を表示します"}
              />
              <form action={createLeaveGrant} className="space-y-2">
                {hidden}
                <input type="hidden" name="userId" value={target.id} />
                <div className="grid grid-cols-2 gap-2">
                  <Field label="付与日 (基準日)"><Input type="date" name="grantDate" defaultValue={suggestion?.date} required /></Field>
                  <Field label="日数"><Input type="number" name="days" step="0.5" min="0.5" max="40" defaultValue={suggestion?.days || undefined} required /></Field>
                </div>
                <Field label="有効期限 (空 = 付与から 2 年)" hint={suggestion ? `空のときは ${fmtDate(grantExpiry(suggestion.date))} まで` : undefined}><Input type="date" name="expiresOn" /></Field>
                <Field label="備考 (任意)"><Input name="note" /></Field>
                <Button type="submit" size="sm" variant="secondary">付与を登録</Button>
              </form>
            </Card>
          )}
          {canGrant && ctx.ready && (
            <Card>
              <CardHeader title="雇い入れ日・基準日" description="法定の付与日数の目安 (勤続 6 か月で 10 日〜6 年 6 か月以上で 20 日) と次の付与日の計算に使います" />
              <form action={saveLeaveProfile} className="space-y-2">
                {hidden}
                <input type="hidden" name="userId" value={target.id} />
                <div className="grid grid-cols-2 gap-2">
                  <Field label="雇い入れ年月日"><Input type="date" name="hiredOn" defaultValue={ctx.settings.profiles[target.id]?.hiredOn ?? target.hiredOn} /></Field>
                  <Field label="基準日 (直近の付与日)" hint="空 = 雇い入れの 6 か月後"><Input type="date" name="baseDate" defaultValue={ctx.settings.profiles[target.id]?.baseDate} /></Field>
                </div>
                <Field label="週の所定労働日数">
                  <Select name="weeklyDays" defaultValue={String(profile.weeklyDays)}>
                    <option value="5">5 日以上 (通常)</option>
                    <option value="4">4 日 (比例付与)</option>
                    <option value="3">3 日 (比例付与)</option>
                    <option value="2">2 日 (比例付与)</option>
                    <option value="1">1 日 (比例付与)</option>
                  </Select>
                </Field>
                <Button type="submit" size="sm" variant="secondary">保存</Button>
              </form>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
