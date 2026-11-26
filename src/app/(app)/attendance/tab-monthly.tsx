import Link from "@/components/ui/Link";
import { Download, Mail, Printer } from "lucide-react";
import type { AttendanceLine } from "@/lib/db/types";
import { canManageAttendance, canSeeAllStores } from "@/lib/auth/permissions";
import { attendanceLineStoreId, attendanceMonthLabel, attendanceStatusLabel } from "@/lib/hr/attendance";
import { addAttendanceLine, createAttendanceMonth, deleteAttendanceLine, importAttendanceWorkbook, saveAttendanceLines, setAttendanceFinal } from "@/lib/actions/attendance";
import { buildAttendanceMonthFromTimecards, sendAttendanceMonth } from "@/lib/actions/timecard";
import { buildAttendanceMonth, mailDraft } from "@/lib/hr/attendance-build";
import { attendanceFileName } from "@/lib/hr/attendance-xlsx";
import { fmtDays } from "@/lib/hr/leave";
import { attendanceMonthOf, fmtHm } from "@/lib/hr/timecard";
import { PendingButton } from "@/components/ui/PendingButton";
import { Button, Card, CardHeader, Field, Input, Note, Select, Textarea, buttonClass } from "@/components/ui";
import { monthChoices, ymLabel, type Ctx } from "./parts";

/**
 * 労務士へ送る勤務表 (田仲労務士書式)
 * 打刻・休暇・インセンティブから作る → 確かめる (打刻漏れ・未承認の申請・計算の内訳) → 確定 → .xlsx をメールで送る。
 * 以前の「令和○年度.xlsx」の取込・手入力・行の追加削除もそのまま使える (src/lib/actions/attendance.ts)
 */
export function MonthlyTab({ ctx }: { ctx: Ctx }) {
  const { db, user, sp, today } = ctx;
  const manage = canManageAttendance(user);
  const allStores = canSeeAllStores(user);
  const ready = ctx.ready;
  const months = [...(db.attendanceMonths ?? [])].sort((a, b) => b.yearMonth.localeCompare(a.yearMonth));
  const choices = monthChoices(ctx);
  const selected = (sp.id && months.find((m) => m.id === sp.id)) || (sp.month && months.find((m) => m.yearMonth === sp.month)) || (!sp.month ? months[0] : undefined);
  const targetMonth = selected?.yearMonth ?? (sp.month && /^\d{4}-\d{2}$/.test(sp.month) ? sp.month : attendanceMonthOf(db, today));
  const back = selected ? `/attendance?tab=monthly&id=${selected.id}` : `/attendance?tab=monthly&month=${targetMonth}`;
  const allLines = selected ? (db.attendanceLines ?? []).filter((l) => l.monthId === selected.id).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, "ja")) : [];
  const lines = allStores ? allLines : allLines.filter((l) => attendanceLineStoreId(db, l) === user.storeId);
  const staff = lines.filter((l) => l.kind === "staff");
  const part = lines.filter((l) => l.kind === "part");
  const draft = selected?.status === "draft";
  const editable = manage && draft && ready;
  const preview = manage ? buildAttendanceMonth(db, targetMonth, today) : undefined;
  const mail = mailDraft(db, targetMonth);
  const autoLines = allLines.some((l) => l.source === "auto");

  return (
    <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-[16rem_minmax(0,1fr)]">
      <Card className="h-fit">
        <CardHeader title="対象月" description={manage ? "20 日締め。打刻から作る・取込は本部・管理者" : "自店舗の行だけ表示"} />
        <ul className="space-y-1 text-sm">
          {months.length === 0 && <li className="text-ink-3">まだ勤務表がありません</li>}
          {months.map((m) => (
            <li key={m.id}>
              <Link href={`/attendance?tab=monthly&id=${m.id}`} className={`flex items-center justify-between rounded-md px-2 py-1.5 ${selected?.id === m.id ? "bg-accent-soft font-medium text-accent-ink" : "hover:bg-subtle"}`}>
                <span>{ymLabel(m.yearMonth)}</span>
                <span className={`text-xs ${m.status === "final" ? "text-good-ink" : "text-ink-3"}`}>
                  {m.sentAt ? "送信済み" : attendanceStatusLabel(m.status)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
        {manage && ready && (
          <div className="mt-4 space-y-3 border-t border-line pt-3">
            <form action={buildAttendanceMonthFromTimecards} className="space-y-2">
              <Field label="打刻・休暇から作る" hint="下書きの月は作り直します (手で足した行は残ります)">
                <Select name="yearMonth" defaultValue={targetMonth}>
                  {choices.map((m) => (
                    <option key={m} value={m}>
                      {ymLabel(m)}
                    </option>
                  ))}
                </Select>
              </Field>
              <PendingButton type="submit" className={buttonClass("primary", "sm")}>勤務表を作る</PendingButton>
            </form>
            <details className="text-sm">
              <summary className="cursor-pointer text-xs text-ink-2">以前の表 (令和○年度.xlsx) の取込・空の月</summary>
              <div className="mt-2 space-y-3">
                <form action={importAttendanceWorkbook} className="space-y-2" encType="multipart/form-data">
                  <input type="hidden" name="back" value="/attendance?tab=monthly" />
                  <Field label="令和○年度.xlsx を取込" hint="シート「8.11」など。下書きの月は置き換えます">
                    <Input type="file" name="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required />
                  </Field>
                  <label className="flex items-center gap-2 text-xs text-ink-2">
                    <input type="checkbox" name="force" value="1" /> 確定済みも取り込む (確定を取り消して置き換え)
                  </label>
                  <Button type="submit" size="sm" variant="secondary">取り込む</Button>
                </form>
                <form action={createAttendanceMonth} className="space-y-2">
                  <input type="hidden" name="back" value="/attendance?tab=monthly" />
                  <Field label="空の月を作る (手入力)">
                    <Input type="month" name="yearMonth" defaultValue={targetMonth} required />
                  </Field>
                  <Field label="支給日 (任意)">
                    <Input name="payLabel" placeholder="例: 11/30支給" />
                  </Field>
                  <Button type="submit" size="sm" variant="secondary">作成</Button>
                </form>
              </div>
            </details>
          </div>
        )}
      </Card>

      <div className="min-w-0 space-y-4">
        {preview && (!selected || draft) && preview.warnings.length > 0 && (
          <Card>
            <CardHeader title={`確かめること (${ymLabel(targetMonth)})`} description="打刻漏れ・未承認の申請は勤務表で直してから作り直してください" />
            <ul className="list-disc space-y-0.5 pl-5 text-sm text-ink-2">
              {preview.warnings.slice(0, 30).map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </Card>
        )}
        {!selected && <Note>左の「勤務表を作る」で、打刻・休暇・インセンティブから {ymLabel(targetMonth)} の勤務表を作ります。</Note>}
        {selected && (
          <>
            <Card>
              <CardHeader
                title={attendanceMonthLabel(selected.yearMonth)}
                description={[selected.payLabel, selected.sourceLabel, attendanceStatusLabel(selected.status), selected.sentAt ? `送信 ${selected.sentAt.slice(0, 16).replace("T", " ")} → ${selected.sentTo ?? ""}` : ""].filter(Boolean).join(" · ")}
              />
              <div className="mb-3 flex flex-wrap gap-2">
                {manage && ready && draft && (
                  <form action={setAttendanceFinal}>
                    <input type="hidden" name="monthId" value={selected.id} />
                    <input type="hidden" name="back" value={back} />
                    <input type="hidden" name="final" value="1" />
                    <Button type="submit" size="sm">確定する</Button>
                  </form>
                )}
                {manage && ready && !draft && (
                  <form action={setAttendanceFinal}>
                    <input type="hidden" name="monthId" value={selected.id} />
                    <input type="hidden" name="back" value={back} />
                    <input type="hidden" name="final" value="0" />
                    <Button type="submit" size="sm" variant="secondary">確定を取り消す</Button>
                  </form>
                )}
                {manage && (
                  <a href={`/api/attendance/xlsx?id=${encodeURIComponent(selected.id)}`} className={buttonClass("secondary", "sm")}>
                    <Download aria-hidden /> {attendanceFileName(selected)}
                  </a>
                )}
                <a href={`/api/attendance/export?id=${encodeURIComponent(selected.id)}`} className={buttonClass("ghost", "sm")}>
                  CSV
                </a>
                <Link href={`/print/attendance?month=${selected.yearMonth}`} target="_blank" className={buttonClass("ghost", "sm")}>
                  <Printer aria-hidden /> 全員の勤務記録を印刷
                </Link>
              </div>
              {!allStores && <Note tone="accent">店長は自店舗の社員の行だけを表示しています。労務士へ送るのは本部・管理者です。</Note>}
              {editable && autoLines && <Note>打刻から作った行です。ここで直した値は「勤務表を作る」で作り直すと元に戻ります (直した理由は月のメモに)。</Note>}
              <div className="space-y-4">
                {editable && (
                  <form id="att-save" action={saveAttendanceLines} className="grid grid-cols-1 gap-2 @xl:grid-cols-2">
                    <input type="hidden" name="monthId" value={selected.id} />
                    <input type="hidden" name="back" value={back} />
                    <Field label="支給日">
                      <Input name="payLabel" defaultValue={selected.payLabel ?? ""} form="att-save" />
                    </Field>
                    <Field label="月のメモ">
                      <Input name="monthNote" defaultValue={selected.note ?? ""} form="att-save" />
                    </Field>
                  </form>
                )}
                {!editable && selected.note && <p className="text-sm text-ink-2">{selected.note}</p>}
                <LineTable title="社員" lines={staff} editable={editable} monthId={selected.id} back={back} formId="att-save" showCalc={manage} />
                <LineTable title="パート" lines={part} editable={editable} monthId={selected.id} back={back} formId="att-save" part showCalc={manage} />
                {editable && (
                  <Button type="submit" size="sm" form="att-save">
                    行を保存
                  </Button>
                )}
              </div>
            </Card>

            {manage && ready && selected.status === "final" && (
              <Card>
                <CardHeader title={<span className="inline-flex items-center gap-1.5"><Mail className="h-4 w-4" aria-hidden /> 労務士へ送る</span>} description={`${attendanceFileName(selected)} を添付してメールで送ります。宛先・文面の既定は 設定 → 労務士 で変えられます`} />
                <form action={sendAttendanceMonth} className="space-y-2">
                  <input type="hidden" name="monthId" value={selected.id} />
                  <input type="hidden" name="returnTo" value={back} />
                  <Field label="宛先 (複数はカンマ区切り)" required>
                    <Input name="to" type="text" defaultValue={mail.to} required placeholder="roumu@example.jp" />
                  </Field>
                  <Field label="件名" required>
                    <Input name="subject" defaultValue={mail.subject} required />
                  </Field>
                  <Field label="本文" required>
                    <Textarea name="body" rows={6} defaultValue={mail.body} required />
                  </Field>
                  <PendingButton type="submit" className={buttonClass("primary", "md")}>{selected.sentAt ? "もう一度送る" : "送る"}</PendingButton>
                </form>
              </Card>
            )}

            {editable && (
              <Card>
                <CardHeader title="行を追加" description="打刻のない人 (アカウントのないパートなど)。作り直しても残ります" />
                <form action={addAttendanceLine} className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="monthId" value={selected.id} />
                  <input type="hidden" name="back" value={back} />
                  <Field label="区分">
                    <Select name="kind" defaultValue="staff">
                      <option value="staff">社員</option>
                      <option value="part">パート</option>
                    </Select>
                  </Field>
                  <Field label="氏名">
                    <Input name="name" required />
                  </Field>
                  <Button type="submit" size="sm" variant="secondary">
                    追加
                  </Button>
                </form>
              </Card>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function CalcCell({ l }: { l: AttendanceLine }) {
  const c = l.calc;
  if (!c) return <span className="text-ink-3">{l.source === "import" ? "取込" : "手入力"}</span>;
  return (
    <div className="space-y-0.5 text-[11px] text-ink-2">
      {l.kind === "staff" && (
        <div>
          シフト外 {fmtHm(c.outsideMin)} − 固定 {fmtHm(c.fixedMin)}
        </div>
      )}
      {(c.lateMin > 0 || c.earlyMin > 0) && (
        <div>
          遅刻 {fmtHm(c.lateMin)} · 早退 {fmtHm(c.earlyMin)}
        </div>
      )}
      {c.nightMin > 0 && <div>深夜 {fmtHm(c.nightMin)}</div>}
      {c.paidRemaining !== undefined && (
        <div>
          残: 有給 {fmtDays(c.paidRemaining)} · 振休 {fmtDays(c.compRemaining ?? 0)}
        </div>
      )}
      {c.incentiveItems.map((x, i) => (
        <div key={i} title={x.detail}>
          {x.label} ￥{x.yen.toLocaleString("ja-JP")}
          {x.pay === "cash" ? " (現金)" : ""}
        </div>
      ))}
      {c.warnings.map((w, i) => (
        <div key={`w${i}`} className="text-critical-ink">
          {w}
        </div>
      ))}
    </div>
  );
}

function LineTable({ title, lines, editable, part, monthId, back, formId, showCalc }: { title: string; lines: AttendanceLine[]; editable: boolean; part?: boolean; monthId: string; back: string; formId: string; showCalc: boolean }) {
  if (lines.length === 0 && !editable) return null;
  const f = editable ? formId : undefined;
  return (
    <div>
      <h3 className="mb-2 text-sm font-medium text-ink">
        {title} ({lines.length})
      </h3>
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="min-w-full text-left text-xs">
          <thead className="bg-subtle text-ink-2">
            <tr>
              <th className="px-2 py-1.5">No</th>
              <th className="px-2 py-1.5">氏名</th>
              <th className="px-2 py-1.5">出勤</th>
              {!part && <th className="px-2 py-1.5">欠勤</th>}
              {!part && <th className="px-2 py-1.5">遅刻・早退</th>}
              {!part && <th className="px-2 py-1.5">残業</th>}
              {part && <th className="px-2 py-1.5">出勤時間</th>}
              {part && <th className="px-2 py-1.5">時給</th>}
              <th className="px-2 py-1.5">有給</th>
              <th className="px-2 py-1.5">備考</th>
              {showCalc && <th className="px-2 py-1.5">計算の内訳</th>}
              {editable && <th className="px-2 py-1.5" />}
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id} className="border-t border-line align-top">
                <td className="px-2 py-1">
                  {editable && (
                    <>
                      <input type="hidden" name="lineId" value={l.id} form={f} />
                      <input type="hidden" name={`kind_${l.id}`} value={l.kind} form={f} />
                    </>
                  )}
                  {editable ? <Input name={`no_${l.id}`} defaultValue={l.employeeNo ?? ""} className="w-14" form={f} /> : (l.employeeNo ?? "")}
                </td>
                <td className="px-2 py-1">{editable ? <Input name={`name_${l.id}`} defaultValue={l.name} className="min-w-[6rem]" form={f} /> : l.name}</td>
                <td className="px-2 py-1">{editable ? <Input name={`work_${l.id}`} defaultValue={l.workDays ?? ""} className="w-14" form={f} /> : (l.workDays ?? "")}</td>
                {!part && <td className="px-2 py-1">{editable ? <Input name={`abs_${l.id}`} defaultValue={l.absenceDays ?? ""} className="w-14" form={f} /> : (l.absenceDays ?? "")}</td>}
                {!part && <td className="px-2 py-1">{editable ? <Input name={`late_${l.id}`} defaultValue={l.lateEarly ?? ""} className="w-16" form={f} /> : (l.lateEarly ?? "")}</td>}
                {!part && <td className="px-2 py-1">{editable ? <Input name={`ot_${l.id}`} defaultValue={l.overtime ?? ""} className="w-16" form={f} /> : (l.overtime ?? "")}</td>}
                {part && <td className="px-2 py-1">{editable ? <Input name={`hours_${l.id}`} defaultValue={l.workHours ?? ""} className="w-16" form={f} /> : (l.workHours ?? "")}</td>}
                {part && <td className="px-2 py-1">{editable ? <Input name={`rate_${l.id}`} defaultValue={l.hourlyRate ?? ""} className="w-20" form={f} /> : (l.hourlyRate ?? "")}</td>}
                <td className="px-2 py-1">{editable ? <Input name={`paid_${l.id}`} defaultValue={l.paidLeaveDays ?? ""} className="w-14" form={f} /> : (l.paidLeaveDays ?? "")}</td>
                <td className="px-2 py-1">{editable ? <Textarea name={`note_${l.id}`} defaultValue={l.note ?? ""} rows={2} className="min-w-[12rem]" form={f} /> : <span className="whitespace-pre-line">{l.note ?? ""}</span>}</td>
                {showCalc && (
                  <td className="px-2 py-1">
                    <CalcCell l={l} />
                  </td>
                )}
                {editable && (
                  <td className="px-2 py-1">
                    <form action={deleteAttendanceLine}>
                      <input type="hidden" name="monthId" value={monthId} />
                      <input type="hidden" name="back" value={back} />
                      <input type="hidden" name="lineId" value={l.id} />
                      <button type="submit" className="text-critical hover:underline">
                        削除
                      </button>
                    </form>
                  </td>
                )}
              </tr>
            ))}
            {lines.length === 0 && (
              <tr>
                <td colSpan={11} className="px-2 py-3 text-ink-3">
                  行がありません
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
