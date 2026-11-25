"use client";

import { useState } from "react";
import clsx from "clsx";
import { CalendarPlus } from "lucide-react";
import type { ScheduleKind } from "@/lib/db/types";
import { QUICK_MAX_ASSIGNEES, SCHEDULE_KIND } from "@/lib/constants";
import { scheduleFromRequest } from "@/lib/actions/case-quick";
import { Button } from "@/components/ui";
import { ConflictNote, StaffPicker, TimeModeButtons, useConflicts, type TimeMode } from "./EventQuick";
import type { QuickStaff } from "./quick-types";

const KINDS: ScheduleKind[] = ["survey", "site_survey", "onsite_quote", "measure", "visit", "pickup", "delivery", "install", "site"];

/**
 * 依頼 (メンション) の画面の日程登録 (お客様のご要望 2026-11-25「メンションからの日程調整・予定登録」)。
 * お客様に電話して決めた日時・担当者を、その場で予定表に登録する (日程変更依頼で予定がわかっていれば、その予定の日時を変える)。
 * 登録できたら依頼を報告・対応完了にする (src/lib/actions/case-quick.ts の scheduleFromRequest)
 */
export function RequestScheduleForm({
  threadId,
  caseRef,
  storeId,
  storeName,
  defaultKind,
  move,
  preferMove,
  staff,
  currentUserId,
}: {
  threadId: string;
  caseRef: string;
  storeId: string;
  storeName: string;
  defaultKind: ScheduleKind;
  move?: { id: string; period: string; kind: ScheduleKind; date: string; startTime?: string; endTime?: string; slot?: "am" | "pm"; assigneeIds: string[] };
  preferMove: boolean;
  staff: QuickStaff[];
  currentUserId: string;
}) {
  const [mode, setMode] = useState<"new" | "move">(preferMove && move ? "move" : "new");
  const [kind, setKind] = useState<ScheduleKind>(defaultKind);
  const [date, setDate] = useState(mode === "move" && move ? move.date : "");
  const [time, setTime] = useState<TimeMode>(mode === "move" && move ? (move.startTime ? "time" : (move.slot ?? "allday")) : "allday");
  const [start, setStart] = useState(mode === "move" && move?.startTime ? move.startTime : "10:00");
  const [end, setEnd] = useState(mode === "move" && move?.endTime ? move.endTime : "");
  const [close, setClose] = useState(true);
  const [sel, setSel] = useState<string[]>(mode === "move" && move ? move.assigneeIds.slice(0, QUICK_MAX_ASSIGNEES) : staff.some((s) => s.id === currentUserId) ? [currentUserId] : []);
  const report = useConflicts(date && sel.length ? { eventId: mode === "move" ? move?.id : undefined, date, startTime: time === "time" ? start : undefined, endTime: time === "time" ? end || undefined : undefined, slot: time === "am" || time === "pm" ? time : undefined, assigneeIds: sel, caseRef, kind: mode === "move" && move ? move.kind : kind, storeId } : null);
  const pickMode = (m: "new" | "move") => {
    setMode(m);
    if (m === "move" && move) {
      setDate(move.date);
      setTime(move.startTime ? "time" : (move.slot ?? "allday"));
      setStart(move.startTime ?? "10:00");
      setEnd(move.endTime ?? "");
      setSel(move.assigneeIds.slice(0, QUICK_MAX_ASSIGNEES));
    }
  };
  return (
    <form action={scheduleFromRequest.bind(null, threadId)} className="space-y-3" data-testid="request-schedule">
      <input type="hidden" name="mode" value={mode} />
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="timeMode" value={time} />
      {sel.map((id) => (
        <input key={id} type="hidden" name="assigneeIds" value={id} />
      ))}
      {move && (
        <div className="flex flex-wrap gap-1.5">
          <button type="button" onClick={() => pickMode("move")} aria-pressed={mode === "move"} className={clsx("rounded-lg border px-3 py-2 text-sm", mode === "move" ? "border-accent bg-accent-soft font-medium text-accent-ink" : "border-line bg-panel text-ink-2")}>
            依頼の予定 ({SCHEDULE_KIND[move.kind].label} {move.period}) の日時を変更
          </button>
          <button type="button" onClick={() => pickMode("new")} aria-pressed={mode === "new"} className={clsx("rounded-lg border px-3 py-2 text-sm", mode === "new" ? "border-accent bg-accent-soft font-medium text-accent-ink" : "border-line bg-panel text-ink-2")}>
            新しい予定を登録
          </button>
        </div>
      )}
      {mode === "new" && (
        <fieldset>
          <legend className="label">予定の種類</legend>
          <div className="flex flex-wrap gap-1.5">
            {KINDS.map((k) => (
              <button key={k} type="button" onClick={() => setKind(k)} aria-pressed={kind === k} className={clsx("rounded-lg border px-2.5 py-1.5 text-xs", kind === k ? "border-accent bg-accent-soft font-medium text-accent-ink" : "border-line bg-panel text-ink-2")}>
                {SCHEDULE_KIND[k].label}
              </button>
            ))}
          </div>
        </fieldset>
      )}
      <label className="block">
        <span className="label">日付</span>
        <input type="date" name="date" value={date} onChange={(e) => setDate(e.target.value)} required className="field w-auto" />
      </label>
      <fieldset>
        <legend className="label">時間</legend>
        <TimeModeButtons mode={time} setMode={setTime} />
        {time === "time" && (
          <div className="mt-2 flex items-center gap-2">
            <input type="time" name="startTime" value={start} onChange={(e) => setStart(e.target.value)} required className="field w-auto" aria-label="開始時刻" />
            <span className="text-ink-3">〜</span>
            <input type="time" name="endTime" value={end} min={start} onChange={(e) => setEnd(e.target.value)} className="field w-auto" aria-label="終了時刻" />
          </div>
        )}
      </fieldset>
      <div>
        <span className="label">担当者 ({sel.length} 人)</span>
        <StaffPicker staff={staff} selected={sel} onChange={setSel} storeName={storeName} busy={report?.busy} />
      </div>
      {mode === "new" && (
        <label className="block">
          <span className="label">メモ (任意)</span>
          <input name="memo" maxLength={500} placeholder="例: 2 階の和室。駐車場は家の前" className="field" />
        </label>
      )}
      <ConflictNote report={report} label="重複を承知で登録する" />
      <label className="flex items-start gap-2 text-sm text-ink">
        <input type="checkbox" name="close" value="1" checked={close} onChange={(e) => setClose(e.target.checked)} className="mt-0.5 h-4 w-4" />
        <span>登録したら、この依頼を報告・対応完了にする (依頼した人に知らせます)</span>
      </label>
      <Button type="submit" disabled={!date || sel.length === 0} data-testid="request-schedule-submit">
        <CalendarPlus />
        {mode === "move" ? (close ? "日時を変更して完了にする" : "日時を変更する") : close ? "予定を登録して完了にする" : "予定を登録する"}
      </Button>
    </form>
  );
}
