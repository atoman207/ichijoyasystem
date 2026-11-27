"use client";

import { useEffect, useState } from "react";
import Link from "@/components/ui/Link";
import clsx from "clsx";
import { TriangleAlert } from "lucide-react";
import type { ScheduleKind, StoreId } from "@/lib/db/types";
import type { ConflictReport } from "@/lib/calendar";
import { checkScheduleConflicts, createScheduleEvent } from "@/lib/actions/schedule";
import { Button } from "@/components/ui";
import { KindMark, kindLabel } from "./parts";
import { AssigneePicker, CaseDuplicateChoice, type FormStore, type FormUser } from "./form-parts";

/**
 * 案件の画面から、その場で日程を登録する (お客様のご要望 2026-11-24「■ 問い合わせ受付後の業務フロー ③」:
 * 問い合わせ画面と予定表を行き来せず、案件の画面で日時と内容 (見積・現見・現調・引取・納品…) を選んで登録 → 予定表に自動で反映)。
 * 保存は予定の登録と同じ処理 (createScheduleEvent: 重複の確認・変更履歴・問い合わせの「対応中」・日程の打ち合わせの依頼の完了)
 */

type TimeMode = "allday" | "am" | "pm" | "time";

export interface ScheduleQuickAddProps {
  /** 案件 ("inquiry:inq_1" など) */
  caseRef: string;
  storeId: StoreId;
  kinds: ScheduleKind[];
  defaultKind?: ScheduleKind;
  users: FormUser[];
  stores: FormStore[];
  defaultAssigneeIds: string[];
  currentUserId: string;
  /** お客様の登録がない問い合わせの住所 (受付で聞いた住所) */
  location?: string;
  returnTo: string;
  /** 「詳しく入力」(今までの予定の登録の画面) */
  fullHref: string;
}

export function ScheduleQuickAdd(p: ScheduleQuickAddProps) {
  const [kind, setKind] = useState<ScheduleKind>(p.defaultKind ?? p.kinds[0]);
  const [date, setDate] = useState("");
  const [mode, setMode] = useState<TimeMode>("am");
  const [start, setStart] = useState("10:00");
  const [end, setEnd] = useState("11:00");
  const [assignees, setAssignees] = useState<string[]>(p.defaultAssigneeIds);
  const [report, setReport] = useState<ConflictReport | null>(null);

  useEffect(() => {
    if (!date || !assignees.length) return;
    let alive = true;
    const t = setTimeout(() => {
      checkScheduleConflicts({ date, startTime: mode === "time" ? start : undefined, endTime: mode === "time" ? end : undefined, slot: mode === "am" || mode === "pm" ? mode : undefined, assigneeIds: assignees, caseRef: p.caseRef, kind, storeId: p.storeId })
        .then((r) => alive && setReport(r))
        .catch(() => alive && setReport(null));
    }, 350);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [date, mode, start, end, assignees, kind, p.caseRef, p.storeId]);

  const conflicts = date && assignees.length ? (report?.conflicts ?? []) : [];
  return (
    <form action={createScheduleEvent} className="space-y-3" data-testid="schedule-quick-add">
      <input type="hidden" name="caseRef" value={p.caseRef} />
      <input type="hidden" name="storeId" value={p.storeId} />
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="locationMode" value="follow" />
      <input type="hidden" name="location" value={p.location ?? ""} />
      <input type="hidden" name="back" value={p.returnTo} />
      <input type="hidden" name="returnTo" value={p.returnTo} />
      {mode === "allday" && <input type="hidden" name="allDay" value="1" />}
      {(mode === "am" || mode === "pm") && <input type="hidden" name="slot" value={mode} />}

      <fieldset>
        <legend className="label">内容</legend>
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="予定の内容">
          {p.kinds.map((k) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} title={kindLabel(k)} onClick={() => setKind(k)} className={clsx("rounded-lg border px-1 py-1 transition", kind === k ? "border-accent bg-accent-soft ring-2 ring-accent/40" : "border-line bg-panel hover:border-accent/50")}>
              <KindMark kind={k} size="md" />
            </button>
          ))}
        </div>
      </fieldset>

      <div className="grid grid-cols-1 gap-2 @xl:grid-cols-2">
        <label className="block">
          <span className="label">日付</span>
          <input type="date" name="date" value={date} onChange={(e) => setDate(e.target.value)} required className="field" />
        </label>
        <fieldset>
          <legend className="label">時間</legend>
          <div className="inline-flex flex-wrap gap-1 rounded-xl border border-line bg-subtle/70 p-1">
            {(
              [
                ["am", "午前"],
                ["pm", "午後"],
                ["time", "時刻"],
                ["allday", "終日"],
              ] as [TimeMode, string][]
            ).map(([m, l]) => (
              <button key={m} type="button" onClick={() => setMode(m)} aria-pressed={mode === m} className={clsx("rounded-lg px-3 py-1.5 text-sm", mode === m ? "bg-panel font-medium text-ink shadow-xs" : "text-ink-2 hover:text-ink")}>
                {l}
              </button>
            ))}
          </div>
        </fieldset>
      </div>
      {mode === "time" && (
        <div className="flex items-center gap-2">
          <input type="time" name="startTime" value={start} onChange={(e) => setStart(e.target.value)} required className="field w-auto" aria-label="開始時刻" />
          <span className="text-ink-3">〜</span>
          <input type="time" name="endTime" value={end} min={start} onChange={(e) => setEnd(e.target.value)} className="field w-auto" aria-label="終了時刻" />
        </div>
      )}

      <AssigneePicker users={p.users} stores={p.stores} selected={assignees} onChange={setAssignees} busy={date ? report?.busy : undefined} currentUserId={p.currentUserId} storeId={p.storeId} hint="担当者の予定と重なるときは赤く表示します。決まっていなければ「なし」" />

      <label className="block">
        <span className="label">作業内容 (任意・予定表に表示)</span>
        <input name="work" maxLength={200} className="field" placeholder={kind === "pickup" || kind === "delivery" ? "空欄なら明細から自動 (例: タ6 タ新4 フ2)" : kind === "site" ? "例: 養生、廃材撤去" : kind === "install" ? "例: クロス工事、畳下床板2間" : "例: タ3間、フ1部屋"} />
      </label>
      <label className="block">
        <span className="label">メモ (任意)</span>
        <input name="memo" maxLength={2000} className="field" placeholder="例: 網戸 大5 小2 / 駐車場あり" />
      </label>

      {/* 同じ案件・同じ日の予定 (二重登録の確かめ) */}
      {date && assignees.length > 0 && report?.day === date && <CaseDuplicateChoice items={report.caseDuplicates} />}

      {conflicts.length > 0 && (
        <div className="rounded-lg border border-critical/30 bg-critical-soft/60 px-3 py-2 text-xs text-critical-ink" role="alert">
          <p className="flex items-center gap-1 font-semibold">
            <TriangleAlert className="h-3.5 w-3.5" aria-hidden />
            担当者の予定が重なります
          </p>
          <ul className="mt-1 space-y-0.5">
            {conflicts.slice(0, 5).map((c) => (
              <li key={`${c.userId}-${c.eventId}`}>
                {c.userName} さん: {c.when}「{c.title}」
              </li>
            ))}
          </ul>
          <label className="mt-1.5 flex items-center gap-1.5 font-medium">
            <input type="checkbox" name="allowOverlap" value="1" required className="h-4 w-4" />
            重複を承知で登録する
          </label>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={!date}>
          {kindLabel(kind)}の日程を登録
        </Button>
        <Link href={p.fullHref} className="text-xs text-ink-3 hover:text-accent hover:underline">
          詳しく入力 (複数日・繰り返し・場所など)
        </Link>
      </div>
      <p className="text-[11px] text-ink-3">登録すると予定表に自動で載り、この案件の予定になります。日程の打ち合わせの依頼は完了になります。</p>
    </form>
  );
}
