"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import Link from "@/components/ui/Link";
import type { StoreId } from "@/lib/db/types";
import { isDateKey, toMinutes, type ConflictQuery } from "@/lib/calendar";
import { Field, Input, buttonClass } from "@/components/ui";
import { AssigneePicker, ConflictPanel, useConflictReport, type FormStore, type FormUser } from "./form-parts";

function SaveButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={disabled || pending} className={buttonClass("primary", "sm")}>
      {pending ? "保存しています…" : "施工予定を保存"}
    </button>
  );
}

/**
 * 受注の施工予定 (施工期間・時間帯・施工担当・現場住所)。
 * 保存すると予定表の「施工」の予定と連動し、施工担当の予定の重複もここで確認する。
 */
export function OrderScheduleForm({
  action,
  orderId,
  mainEventId,
  initial,
  users,
  stores,
  storeId,
  currentUserId,
}: {
  action: (formData: FormData) => void | Promise<void>;
  orderId: string;
  mainEventId?: string;
  initial: { start: string; end: string; allDay: boolean; startTime: string; endTime: string; workerIds: string[]; siteAddress: string };
  users: FormUser[];
  stores: FormStore[];
  storeId: StoreId;
  currentUserId: string;
}) {
  const [v, setV] = useState(initial);
  const [ackFor, setAckFor] = useState<string | null>(null);
  const set = <K extends keyof typeof initial>(k: K, val: (typeof initial)[K]) => setV((p) => ({ ...p, [k]: val }));

  const timeError = !v.allDay && v.startTime && v.endTime && toMinutes(v.endTime) <= toMinutes(v.startTime) ? "終了時刻は開始時刻より後にしてください" : "";
  const endError = v.end && v.start && v.end < v.start ? "終了日は開始日以降にしてください" : "";
  const query: ConflictQuery | null = isDateKey(v.start)
    ? {
        eventId: mainEventId,
        date: v.start,
        endDate: v.end && v.end > v.start ? v.end : undefined,
        startTime: v.allDay ? undefined : v.startTime || undefined,
        endTime: v.allDay ? undefined : v.endTime || undefined,
        assigneeIds: v.workerIds,
        caseRef: `order:${orderId}`,
      }
    : null;
  const { report, fresh, checking } = useConflictReport(query);
  const conflicts = fresh ? (report?.conflicts ?? []) : [];
  const conflictKey = conflicts.map((c) => `${c.userId}:${c.eventId}:${c.day}`).join(",");
  const ack = conflictKey !== "" && ackFor === conflictKey;
  const blocked = conflicts.length > 0 && !ack;

  return (
    <form action={action} className="@container">
      {v.allDay && <input type="hidden" name="allDay" value="1" />}
      <div className="grid grid-cols-1 gap-4 @3xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-3">
          <div className="grid grid-cols-1 gap-3 @md:grid-cols-2">
            <Field label="施工開始日" hint="空欄にすると施工予定を未定に戻し、予定表から外します">
              <Input type="date" name="scheduledStart" value={v.start} onChange={(e) => set("start", e.target.value)} />
            </Field>
            <Field label="施工終了日" hint={endError || "1 日で終わる場合は空欄"}>
              <Input type="date" name="scheduledEnd" value={v.end} min={v.start} onChange={(e) => set("end", e.target.value)} />
            </Field>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <label className="mb-2 inline-flex cursor-pointer items-center gap-2 text-sm text-ink">
              <input type="checkbox" checked={v.allDay} onChange={(e) => set("allDay", e.target.checked)} className="h-4 w-4 accent-accent" />
              終日
            </label>
            {!v.allDay && (
              <>
                <Field label="開始時刻" className="w-32">
                  <Input type="time" name="startTime" value={v.startTime} step={300} onChange={(e) => set("startTime", e.target.value)} />
                </Field>
                <Field label="終了時刻" className="w-32">
                  <Input type="time" name="endTime" value={v.endTime} step={300} onChange={(e) => set("endTime", e.target.value)} />
                </Field>
              </>
            )}
          </div>
          {timeError && <p className="text-xs text-critical-ink">{timeError}</p>}
          <AssigneePicker
            users={users}
            stores={stores}
            selected={v.workerIds}
            onChange={(ids) => set("workerIds", ids)}
            busy={fresh ? report?.busy : undefined}
            currentUserId={currentUserId}
            storeId={storeId}
            label="施工担当"
            name="workerIds"
            hint="他店舗の応援も選べます。右の表示は施工開始日の予定の入り具合です"
          />
          <Field label="現場住所">
            <Input name="siteAddress" value={v.siteAddress} onChange={(e) => set("siteAddress", e.target.value)} />
          </Field>
        </div>
        <div className="min-w-0 space-y-3">
          <ConflictPanel
            report={report}
            fresh={fresh}
            checking={checking}
            hasAssignees={v.workerIds.length > 0 && isDateKey(v.start)}
            ackChecked={ack}
            onAck={(on) => setAckFor(on ? conflictKey : null)}
            ackLabel="重複を承知で保存する (担当者・店長と調整済み)"
          />
          <div className="flex flex-wrap items-center gap-2">
            <SaveButton disabled={blocked || Boolean(timeError || endError)} />
            {mainEventId && (
              <Link href={`/schedule/${mainEventId}`} className="text-xs font-medium text-accent hover:underline">
                予定表で開く
              </Link>
            )}
          </div>
          {blocked && <p className="text-[11px] text-critical-ink">重複を解消するか、「重複を承知で保存する」にチェックしてください</p>}
        </div>
      </div>
    </form>
  );
}
