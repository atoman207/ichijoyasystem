import { canManageAttendanceRules } from "@/lib/auth/permissions";
import { saveAttendanceProfiles, saveAttendanceRules, saveExtraStaff, saveSharoushi } from "@/lib/actions/timecard";
import { attendanceEmployees, fixedOvertimeMin, hourlyRateOn, shiftOf, staffCategory, STAFF_CATEGORIES, STAFF_CATEGORY, WEEKDAY_JA } from "@/lib/hr/timecard";
import { PendingButton } from "@/components/ui/PendingButton";
import { Card, CardHeader, Field, Input, Note, Select, Textarea, buttonClass } from "@/components/ui";
import { documentSettings } from "@/lib/doc-settings";
import type { Ctx } from "./parts";

/** 勤怠の設定: 決まり (管理者) / 社員ごと (区分・社員番号・シフト・固定残業・時給。本部・管理者) / 勤務表にだけ載せる社員 (アカウントなし) / 労務士の宛先と文面 (本部・管理者) */
export function SetupTab({ ctx }: { ctx: Ctx }) {
  const { db, user, today, settings: s, clerks } = ctx;
  const rules = canManageAttendanceRules(user);
  const users = attendanceEmployees(db);
  const back = "/attendance?tab=setup";
  const companyName = documentSettings(db).companyName;
  const shiftRows = [...s.shifts, { id: "", name: "", start: "", end: "", breaks: [] }];
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="決まり" description={rules ? "シフト (始業・終業・休憩)・法定休日・固定残業・インセンティブの単価。変えた日から勤務表の計算が変わります (作った勤務表は作り直すと反映)" : "管理者が変更します"} />
        <form action={saveAttendanceRules} className="space-y-4">
          <input type="hidden" name="returnTo" value={back} />
          <fieldset disabled={!rules} className="space-y-4">
            <div className="grid grid-cols-1 gap-3 @xl:grid-cols-3">
              <Field label="打刻を使い始めた日" hint="この日より前は欠勤・打刻漏れを数えません">
                <Input type="date" name="startDate" defaultValue={s.startDate} />
              </Field>
              <Field label="法定休日の曜日" hint="ほかの休業日は所定休日">
                <Select name="legalHolidayWeekday" defaultValue={String(s.legalHolidayWeekday)}>
                  {WEEKDAY_JA.map((w, i) => (
                    <option key={i} value={i}>
                      {w}曜日
                    </option>
                  ))}
                </Select>
              </Field>
              <label className="flex items-center gap-2 self-end text-sm text-ink-2">
                <input type="checkbox" name="countEarlyStart" value="1" defaultChecked={s.countEarlyStart} /> 始業より前の時間もシフト外残業に数える
              </label>
              <Field label="固定残業 (職人・時間/月)">
                <Input name="fixed_craft" inputMode="numeric" defaultValue={s.fixedOvertime.craft} />
              </Field>
              <Field label="固定残業 (事務・時間/月)">
                <Input name="fixed_office" inputMode="numeric" defaultValue={s.fixedOvertime.office} />
              </Field>
            </div>

            <div>
              <h3 className="mb-2 text-sm font-medium text-ink">シフト</h3>
              <div className="space-y-2">
                {shiftRows.map((sh, i) => (
                  <div key={i} className="grid grid-cols-2 gap-2 rounded-lg border border-line p-2 @3xl:grid-cols-[6rem_8rem_5rem_5rem_minmax(0,1fr)_auto]">
                    <Field label="ID">
                      <Input name={`shift_${i}_id`} defaultValue={sh.id} placeholder={i === s.shifts.length ? "新しいシフト" : ""} />
                    </Field>
                    <Field label="名前">
                      <Input name={`shift_${i}_name`} defaultValue={sh.name} />
                    </Field>
                    <Field label="始業">
                      <Input name={`shift_${i}_start`} defaultValue={sh.start} placeholder="08:00" />
                    </Field>
                    <Field label="終業">
                      <Input name={`shift_${i}_end`} defaultValue={sh.end} placeholder="17:00" />
                    </Field>
                    <div className="col-span-2 @3xl:col-span-1">
                      <span className="mb-1 block text-xs text-ink-2">休憩 (3 つまで)</span>
                      <div className="flex flex-wrap gap-1">
                        {[0, 1, 2].map((j) => (
                          <span key={j} className="inline-flex items-center gap-0.5">
                            <Input name={`shift_${i}_b${j}_start`} defaultValue={sh.breaks[j]?.start ?? ""} className="w-16" placeholder="10:30" aria-label={`休憩${j + 1}の始まり`} />
                            〜
                            <Input name={`shift_${i}_b${j}_end`} defaultValue={sh.breaks[j]?.end ?? ""} className="w-16" placeholder="10:45" aria-label={`休憩${j + 1}の終わり`} />
                          </span>
                        ))}
                      </div>
                    </div>
                    {i < s.shifts.length && (
                      <label className="flex items-center gap-1 self-end text-xs text-ink-2">
                        <input type="checkbox" name={`shift_${i}_remove`} value="1" /> 消す
                      </label>
                    )}
                  </div>
                ))}
              </div>
              <div className="mt-2 grid grid-cols-1 gap-2 @xl:grid-cols-2">
                <Field label="社員の既定のシフト">
                  <Select name="default_staff" defaultValue={s.defaultShift.staff}>
                    {s.shifts.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name} ({x.start}〜{x.end})
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="パートの既定のシフト">
                  <Select name="default_part" defaultValue={s.defaultShift.part}>
                    {s.shifts.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name} ({x.start}〜{x.end})
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            </div>

            <div>
              <h3 className="mb-2 text-sm font-medium text-ink">インセンティブ (勤務表の備考)</h3>
              <div className="grid grid-cols-1 gap-2 @3xl:grid-cols-2">
                {(["review", "inspection"] as const).map((k) => {
                  const r = s.incentives[k];
                  return (
                    <div key={k} className="space-y-2 rounded-lg border border-line p-2">
                      <label className="flex items-center gap-2 text-sm font-medium text-ink">
                        <input type="checkbox" name={`${k}_enabled`} value="1" defaultChecked={r.enabled} /> {k === "review" ? "Google 口コミ (1 点あたり)" : "点検 (1 件あたり)"}
                      </label>
                      <div className="grid grid-cols-3 gap-2">
                        <Field label="円">
                          <Input name={`${k}_yen`} inputMode="numeric" defaultValue={r.yen} />
                        </Field>
                        <Field label="期間">
                          <Select name={`${k}_period`} defaultValue={r.period}>
                            <option value="prev_month">前月 1 日〜末日</option>
                            <option value="closing">締め (21 日〜20 日)</option>
                          </Select>
                        </Field>
                        <Field label="支給">
                          <Select name={`${k}_pay`} defaultValue={r.pay}>
                            <option value="cash">現金</option>
                            <option value="salary">成果給 (給与)</option>
                          </Select>
                        </Field>
                      </div>
                    </div>
                  );
                })}
                <div className="space-y-2 rounded-lg border border-line p-2">
                  <label className="flex items-center gap-2 text-sm font-medium text-ink">
                    <input type="checkbox" name="manday_enabled" value="1" defaultChecked={s.incentives.manDay.enabled} /> 月間人日 (店舗の職人・KPI の月次の手当)
                  </label>
                  <Field label="支給">
                    <Select name="manday_pay" defaultValue={s.incentives.manDay.pay}>
                      <option value="cash">現金</option>
                      <option value="salary">成果給 (給与)</option>
                    </Select>
                  </Field>
                </div>
                <div className="space-y-2 rounded-lg border border-line p-2">
                  <label className="flex items-center gap-2 text-sm font-medium text-ink">
                    <input type="checkbox" name="slip_enabled" value="1" defaultChecked={s.incentives.slip.enabled} /> 伝票件数 (事務・KPI の月次の手当)
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="支給">
                      <Select name="slip_pay" defaultValue={s.incentives.slip.pay}>
                        <option value="cash">現金</option>
                        <option value="salary">成果給 (給与)</option>
                      </Select>
                    </Field>
                    <Field label="この月の分まで (廃止)" hint="空 = 続ける">
                      <Input type="month" name="slip_until" defaultValue={s.incentives.slip.until ?? ""} />
                    </Field>
                  </div>
                </div>
              </div>
            </div>
          </fieldset>
          {rules && <PendingButton type="submit" className={buttonClass("primary", "md")}>決まりを保存</PendingButton>}
        </form>
      </Card>

      <Card padded={false}>
        <div className="p-4 pb-0">
          <CardHeader title="社員ごと" description="区分 (役員は労務士の勤務表に出しません)・労務士の勤務表の No・シフト・固定残業 (空 = 区分の既定)・パートの時給 (変更日から)" />
        </div>
        <form action={saveAttendanceProfiles}>
          <input type="hidden" name="returnTo" value={back} />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-left text-xs">
              <thead className="bg-subtle text-ink-2">
                <tr>
                  <th className="px-2 py-2">社員</th>
                  <th className="px-2 py-2">区分</th>
                  <th className="px-2 py-2">No</th>
                  <th className="px-2 py-2">シフト</th>
                  <th className="px-2 py-2">固定残業 (時間)</th>
                  <th className="px-2 py-2">時給 (パート)</th>
                  <th className="px-2 py-2">時給の変更日</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const p = s.profiles[u.id] ?? {};
                  const cat = staffCategory(s, u, clerks);
                  const rate = hourlyRateOn(s, u.id, today);
                  return (
                    <tr key={u.id} className="border-t border-line">
                      <td className="px-2 py-1.5">
                        <input type="hidden" name="uid" value={u.id} />
                        <div className="font-medium text-ink">{u.name}</div>
                        <div className="text-[11px] text-ink-3">{db.stores.find((x) => x.id === u.storeId)?.shortName}</div>
                      </td>
                      <td className="px-2 py-1.5">
                        <Select name={`cat_${u.id}`} defaultValue={p.category ?? ""} aria-label={`${u.name} 区分`}>
                          <option value="">自動 ({STAFF_CATEGORY[cat].short})</option>
                          {STAFF_CATEGORIES.map((c) => (
                            <option key={c} value={c}>
                              {STAFF_CATEGORY[c].label}
                            </option>
                          ))}
                        </Select>
                      </td>
                      <td className="px-2 py-1.5">
                        <Input name={`no_${u.id}`} defaultValue={p.employeeNo ?? ""} className="w-16" aria-label={`${u.name} No`} />
                      </td>
                      <td className="px-2 py-1.5">
                        <Select name={`shift_${u.id}`} defaultValue={p.shiftId ?? ""} aria-label={`${u.name} シフト`}>
                          <option value="">既定 ({shiftOf(s, u, clerks).name})</option>
                          {s.shifts.map((x) => (
                            <option key={x.id} value={x.id}>
                              {x.name}
                            </option>
                          ))}
                        </Select>
                      </td>
                      <td className="px-2 py-1.5">
                        <Input name={`fixed_${u.id}`} defaultValue={p.fixedOvertimeHours ?? ""} placeholder={String(fixedOvertimeMin(s, u, clerks) / 60)} className="w-16" inputMode="numeric" aria-label={`${u.name} 固定残業`} />
                      </td>
                      <td className="px-2 py-1.5">
                        <Input name={`rate_${u.id}`} defaultValue={rate?.yen ?? ""} className="w-20" inputMode="numeric" aria-label={`${u.name} 時給`} />
                        {(p.rates?.length ?? 0) > 1 && <div className="text-[10px] text-ink-3">{p.rates!.map((r) => `${r.from}〜 ${r.yen}`).join(" / ")}</div>}
                      </td>
                      <td className="px-2 py-1.5">
                        <Input type="date" name={`ratefrom_${u.id}`} defaultValue={rate?.from ?? ""} aria-label={`${u.name} 時給の変更日`} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="border-t border-line p-3">
            <PendingButton type="submit" className={buttonClass("primary", "md")}>社員ごとの設定を保存</PendingButton>
            <span className="ml-3 text-xs text-ink-3">時給を変えるときは新しい時給と変更日を入れます (前の時給は履歴に残り、勤務表の備考に「時給変更」と書きます)。</span>
          </div>
        </form>
      </Card>

      <Card padded={false}>
        <div id="extra-staff" className="p-4 pb-0">
          <CardHeader
            title="勤務表にだけ載せる社員 (アカウントなし)"
            description="アカウントがなく打刻しない社員。労務士へ送る勤務表に行を入れます (数字は手で入力)。以前の表を取り込むと、アカウントに当たらなかった人がここに入ります。退職などで載せなくなったら「最後の月」を入れるか削除します"
          />
        </div>
        <form action={saveExtraStaff}>
          <input type="hidden" name="returnTo" value={`${back}#extra-staff`} />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-xs">
              <thead className="bg-subtle text-ink-2">
                <tr>
                  <th className="px-2 py-2">氏名</th>
                  <th className="px-2 py-2">区分</th>
                  <th className="px-2 py-2">No</th>
                  <th className="px-2 py-2">時給 (パート)</th>
                  <th className="px-2 py-2">最後の月 (空 = 続ける)</th>
                  <th className="px-2 py-2">削除</th>
                </tr>
              </thead>
              <tbody>
                {[...s.extraStaff, undefined].map((e, i) => (
                  <tr key={e?.key ?? "new"} className="border-t border-line">
                    <td className="px-2 py-1.5">
                      <Input name={`x_${i}_name`} defaultValue={e?.name ?? ""} placeholder={e ? undefined : "追加する人の氏名"} aria-label="氏名" />
                    </td>
                    <td className="px-2 py-1.5">
                      <Select name={`x_${i}_kind`} defaultValue={e?.kind ?? "staff"} aria-label="区分">
                        <option value="staff">社員</option>
                        <option value="part">パート</option>
                      </Select>
                    </td>
                    <td className="px-2 py-1.5">
                      <Input name={`x_${i}_no`} defaultValue={e?.employeeNo ?? ""} className="w-16" aria-label="No" />
                    </td>
                    <td className="px-2 py-1.5">
                      <Input name={`x_${i}_rate`} defaultValue={e?.hourlyRate ?? ""} className="w-20" inputMode="numeric" aria-label="時給" />
                    </td>
                    <td className="px-2 py-1.5">
                      <Input type="month" name={`x_${i}_until`} defaultValue={e?.until ?? ""} aria-label="最後の月" />
                    </td>
                    <td className="px-2 py-1.5">
                      {e && (
                        <label className="flex items-center gap-1 text-critical">
                          <input type="checkbox" name={`x_${i}_remove`} value="1" /> 削除
                        </label>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="border-t border-line p-3">
            <PendingButton type="submit" className={buttonClass("primary", "md")}>勤務表にだけ載せる社員を保存</PendingButton>
            <span className="ml-3 text-xs text-ink-3">アカウントを作った人は打刻から計算するので、ここから外れます。</span>
          </div>
        </form>
      </Card>

      <Card>
        <CardHeader title="労務士" description="勤務表の宛名・送り先と、メールの件名・本文の既定。{月}・{期間}・{会社}・{宛名} を差し込みます" />
        <form action={saveSharoushi} className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
          <input type="hidden" name="returnTo" value={back} />
          <Field label="宛名 (勤務表の「○○ 御中」)">
            <Input name="name" defaultValue={s.sharoushi.name} placeholder="○○労務士事務所" />
          </Field>
          <Field label="送り先のメールアドレス (複数はカンマ区切り)">
            <Input name="to" defaultValue={s.sharoushi.to} placeholder="roumu@example.jp" />
          </Field>
          <Field label="勤務表の 2 行目の会社名" hint="空のときは帳票の会社名。以前の表を取り込むと、その表の書き方 (空白を含む) が入ります" className="@xl:col-span-2">
            <Input name="companyLine" defaultValue={s.sharoushi.companyLine} placeholder={companyName} />
          </Field>
          <Field label="件名" className="@xl:col-span-2">
            <Input name="subject" defaultValue={s.sharoushi.subject} />
          </Field>
          <Field label="本文" className="@xl:col-span-2">
            <Textarea name="body" rows={6} defaultValue={s.sharoushi.body} />
          </Field>
          <div className="@xl:col-span-2">
            <PendingButton type="submit" className={buttonClass("primary", "md")}>労務士の宛先・文面を保存</PendingButton>
          </div>
        </form>
        {!s.sharoushi.to && <div className="mt-3"><Note tone="warn">送り先がまだ設定されていません。</Note></div>}
      </Card>
    </div>
  );
}
