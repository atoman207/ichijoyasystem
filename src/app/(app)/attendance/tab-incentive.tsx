import Link from "@/components/ui/Link";
import { saveIncentiveAdjust } from "@/lib/actions/timecard";
import { incentiveNote, incentiveRange, inspectionCounts, monthIncentives, readIncentiveAdjust, reviewPoints } from "@/lib/hr/incentive-month";
import { attendanceEmployees, staffCategory, STAFF_CATEGORY } from "@/lib/hr/timecard";
import { PendingButton } from "@/components/ui/PendingButton";
import { Card, CardHeader, Field, Input, Note, Select, buttonClass } from "@/components/ui";
import { monthChoices, ymLabel, type Ctx } from "./parts";

/**
 * インセンティブ (勤務表の備考に書く金額)。口コミ (前月の Google 口コミの点)・点検 (点検の電話をした人の、お客様宅に行った点検)・
 * 月間人日・伝票件数 (KPI の月次の手当)。件数・点の手入力と調整額を入れられる。計算は src/lib/hr/incentive-month.ts
 */
export function IncentiveTab({ ctx }: { ctx: Ctx }) {
  const { db, sp, today, settings: s, clerks } = ctx;
  const months = monthChoices(ctx);
  const ym = sp.month && /^\d{4}-\d{2}$/.test(sp.month) ? sp.month : months[1];
  const users = attendanceEmployees(db).filter((u) => staffCategory(s, u, clerks) !== "officer");
  const inc = monthIncentives(db, ym, users, today, s);
  const adjust = readIncentiveAdjust(db, ym);
  const rr = incentiveRange(db, ym, s.incentives.review.period);
  const ir = incentiveRange(db, ym, s.incentives.inspection.period);
  const pts = reviewPoints(db, rr.from, rr.to);
  const insp = inspectionCounts(db, ir.from, ir.to, today);
  const inspections = db.schedule.filter((e) => e.inspectionBy && e.date >= ir.from && e.date <= ir.to).sort((a, b) => a.date.localeCompare(b.date));
  const back = `/attendance?tab=incentive&month=${ym}`;
  const yen = (n: number) => (n ? `￥${n.toLocaleString("ja-JP")}` : "");
  return (
    <div className="space-y-4">
      <Card>
        <form method="get" action="/attendance" className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="tab" value="incentive" />
          <Field label="勤務表の月">
            <Select name="month" defaultValue={ym}>
              {months.map((m) => (
                <option key={m} value={m}>
                  {ymLabel(m)}
                </option>
              ))}
            </Select>
          </Field>
          <button type="submit" className={buttonClass("secondary", "md")}>表示</button>
        </form>
        <p className="mt-3 text-xs text-ink-2">
          口コミ: {s.incentives.review.enabled ? `${rr.label}の Google 口コミの点 × ${s.incentives.review.yen.toLocaleString()} 円 (${s.incentives.review.pay === "cash" ? "現金" : "成果給"})` : "なし"} · 点検:{" "}
          {s.incentives.inspection.enabled ? `${ir.label}に行った点検 × ${s.incentives.inspection.yen.toLocaleString()} 円 (${s.incentives.inspection.pay === "cash" ? "現金" : "成果給"})` : "なし"} · 月間人日・伝票件数: {inc.ranges.allowance} (KPI → インセンティブ の月次の手当)
        </p>
        {inc.notes.map((n, i) => (
          <p key={i} className="mt-1 text-xs text-warn-ink">
            {n}
          </p>
        ))}
      </Card>

      <Card padded={false}>
        <form action={saveIncentiveAdjust}>
          <input type="hidden" name="yearMonth" value={ym} />
          <input type="hidden" name="returnTo" value={back} />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1000px] text-left text-xs">
              <thead className="bg-subtle text-ink-2">
                <tr>
                  <th className="px-2 py-2">社員</th>
                  <th className="px-2 py-2">口コミの点 (記録 / 手入力)</th>
                  <th className="px-2 py-2">点検の件数 (予定表 / 手入力)</th>
                  <th className="px-2 py-2">内訳</th>
                  <th className="px-2 py-2">調整 (現金)</th>
                  <th className="px-2 py-2">調整 (成果給)</th>
                  <th className="px-2 py-2">メモ</th>
                  <th className="px-2 py-2">備考に書く文</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const p = inc.persons.get(u.id);
                  const a = adjust[u.id] ?? {};
                  return (
                    <tr key={u.id} className="border-t border-line align-top">
                      <td className="px-2 py-1.5">
                        <input type="hidden" name="uid" value={u.id} />
                        <div className="font-medium text-ink">{u.name}</div>
                        <div className="text-[11px] text-ink-3">
                          {db.stores.find((x) => x.id === u.storeId)?.shortName} · {STAFF_CATEGORY[staffCategory(s, u, clerks)].short}
                        </div>
                      </td>
                      <td className="px-2 py-1.5">
                        <span className="mr-1 tabular-nums">{pts.get(u.id)?.points ?? 0}</span>
                        <Input name={`rev_${u.id}`} defaultValue={a.review ?? ""} className="w-16" inputMode="numeric" aria-label={`${u.name} 口コミの点 (手入力)`} />
                      </td>
                      <td className="px-2 py-1.5">
                        <span className="mr-1 tabular-nums">{insp.get(u.id) ?? 0}</span>
                        <Input name={`insp_${u.id}`} defaultValue={a.inspection ?? ""} className="w-16" inputMode="numeric" aria-label={`${u.name} 点検の件数 (手入力)`} />
                      </td>
                      <td className="px-2 py-1.5 text-[11px] text-ink-2">
                        {(p?.items ?? []).map((x, i) => (
                          <div key={i}>
                            {x.detail}: {yen(x.yen)}
                            {x.pay === "cash" ? " (現金)" : ""}
                          </div>
                        ))}
                      </td>
                      <td className="px-2 py-1.5">
                        <Input name={`cash_${u.id}`} defaultValue={a.cash ?? ""} className="w-24" inputMode="numeric" aria-label={`${u.name} 調整 (現金)`} />
                      </td>
                      <td className="px-2 py-1.5">
                        <Input name={`sal_${u.id}`} defaultValue={a.salary ?? ""} className="w-24" inputMode="numeric" aria-label={`${u.name} 調整 (成果給)`} />
                      </td>
                      <td className="px-2 py-1.5">
                        <Input name={`note_${u.id}`} defaultValue={a.note ?? ""} className="w-40" aria-label={`${u.name} メモ`} />
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 font-medium text-ink">{incentiveNote(p).join(" ") || <span className="text-ink-3">-</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center gap-3 border-t border-line p-3">
            <PendingButton type="submit" className={buttonClass("primary", "md")}>手入力を保存</PendingButton>
            <span className="text-xs text-ink-3">手入力の点・件数は、記録・予定表から数えた値の代わりに使います (空 = 記録のまま)。保存のあと「労務士へ送る勤務表」で作り直すと備考に入ります。</span>
          </div>
        </form>
      </Card>

      <Card>
        <CardHeader title={`点検の予定 (${ir.label})`} description="予定の「点検の電話をした人」で数えます。予定の日が過ぎた (お客様宅に行った) ものだけ。直すときは予定を開いて変えます" />
        {inspections.length === 0 ? (
          <Note>この期間の点検の予定はありません。点検の予定を登録するときに「点検の電話をした人」を選ぶと、ここで数えます。</Note>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {inspections.map((e) => (
              <li key={e.id} className="flex flex-wrap justify-between gap-2 py-1.5">
                <Link href={`/schedule/${e.id}`} className="text-accent hover:underline">
                  {e.date.slice(5).replace("-", "/")} {e.title}
                </Link>
                <span className="text-xs text-ink-2">
                  電話: {db.users.find((u) => u.id === e.inspectionBy)?.name ?? "-"}
                  {e.date > today ? " (まだ行っていない)" : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
