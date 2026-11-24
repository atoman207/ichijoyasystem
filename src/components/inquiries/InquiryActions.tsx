"use client";

import { useState } from "react";
import clsx from "clsx";
import { CalendarPlus, CalendarX2, Send } from "lucide-react";
import type { StoreId } from "@/lib/db/types";
import { Button } from "@/components/ui";
import { DUE_CHOICES, REQUEST_PURPOSE, type DueChoice, type RequestPurpose } from "@/lib/inquiry-flow";
import { ScheduleQuickAdd, type ScheduleQuickAddProps } from "@/components/schedule/ScheduleQuickAdd";

/**
 * 問い合わせの画面の「次にやること」の操作 (お客様のご要望 2026-11-24「■ 問い合わせ受付後の業務フロー ①②③⑤⑦」)
 * 担当へ依頼 (店舗・担当者・依頼の種類・期限) / 日程を登録 (見積・現見・現調・引取・納品…) / 日程未定 (お客様都合・次回の連絡予定日) を
 * 同じ場所に並べ、案件の画面だけで日程の確定まで進められるようにする
 */

export type ActionTab = "request" | "schedule" | "hold";

export interface InquiryActionsProps {
  defaultTab: ActionTab;
  requestAction: (fd: FormData) => Promise<void>;
  holdAction: (fd: FormData) => Promise<void>;
  clearHoldAction: (fd: FormData) => Promise<void>;
  returnTo: string;
  stores: { id: StoreId; name: string }[];
  /** 依頼できる店舗 (ほかの店舗への依頼は本部・店長) */
  requestStoreIds: StoreId[];
  users: { id: string; name: string; storeId: StoreId; role: string }[];
  inquiryStoreId: StoreId;
  /** 本日 12 時を過ぎたか (サーバーの時刻で決める) */
  noonPassed: boolean;
  today: string;
  schedule?: ScheduleQuickAddProps;
  hold?: { reason: string; nextContact?: string };
}

export function InquiryActions(p: InquiryActionsProps) {
  const [tab, setTab] = useState<ActionTab>(p.defaultTab);
  const tabs: { id: ActionTab; label: string; icon: typeof Send; note: string }[] = [
    { id: "request", label: "担当へ依頼", icon: Send, note: "店舗・担当者に、日程の打ち合わせなどを期限つきで依頼" },
    { id: "schedule", label: "日程を登録", icon: CalendarPlus, note: "決まった日時と内容 (見積・現見・現調・引取・納品…) を予定表へ" },
    { id: "hold", label: "日程未定", icon: CalendarX2, note: "お客様都合ですぐに決められないとき" },
  ];
  return (
    <div data-testid="inquiry-actions">
      <div role="tablist" className="grid grid-cols-3 gap-2">
        {tabs.map((t) => {
          const Icon = t.icon;
          const on = tab === t.id;
          return (
            <button key={t.id} type="button" role="tab" aria-selected={on} onClick={() => setTab(t.id)} title={t.note} className={clsx("flex flex-col items-center gap-1 rounded-xl border px-2 py-2.5 text-sm font-medium transition", on ? "border-accent bg-accent-soft text-accent-ink" : "border-line bg-panel text-ink-2 hover:border-accent/50")}>
              <Icon className="h-5 w-5" aria-hidden />
              {t.label}
            </button>
          );
        })}
      </div>
      <p className="mt-1.5 mb-3 text-xs text-ink-3">{tabs.find((t) => t.id === tab)?.note}</p>
      {tab === "request" && <RequestForm {...p} />}
      {tab === "schedule" &&
        (p.schedule ? <ScheduleQuickAdd {...p.schedule} /> : <p className="rounded-lg bg-subtle px-3 py-2 text-xs text-ink-2">この案件の店舗の予定は登録できません (自店舗の予定を登録できます)。担当の店舗へ「担当へ依頼」で依頼してください。</p>)}
      {tab === "hold" && <HoldForm {...p} />}
    </div>
  );
}

function RequestForm(p: InquiryActionsProps) {
  const [storeId, setStoreId] = useState<StoreId>(p.inquiryStoreId);
  const [purpose, setPurpose] = useState<RequestPurpose>("schedule");
  const [note, setNote] = useState(REQUEST_PURPOSE.schedule.text);
  const [edited, setEdited] = useState(false);
  const [due, setDue] = useState<DueChoice>(p.noonPassed ? "today" : "noon");
  const people = p.users.filter((u) => u.storeId === storeId);
  const others = p.users.filter((u) => u.storeId !== storeId && (u.role === "admin" || u.role === "hq_staff"));
  const choosePurpose = (v: RequestPurpose) => {
    setPurpose(v);
    if (!edited) setNote(REQUEST_PURPOSE[v].text);
  };
  return (
    <form action={p.requestAction} className="space-y-3" data-testid="inquiry-request-form">
      <input type="hidden" name="returnTo" value={p.returnTo} />
      <div className="grid grid-cols-1 gap-2 @xl:grid-cols-2">
        <label className="block">
          <span className="label">依頼先の店舗</span>
          <select name="storeId" value={storeId} onChange={(e) => setStoreId(e.target.value as StoreId)} className="field">
            {p.stores
              .filter((s) => p.requestStoreIds.includes(s.id))
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.id !== p.inquiryStoreId ? " (担当店舗を移す)" : ""}
                </option>
              ))}
          </select>
        </label>
        <label className="block">
          <span className="label">担当者 (任意)</span>
          <select name="assigneeId" defaultValue="" key={storeId} className="field">
            <option value="">店舗のメンバー全員に依頼 (担当を決めない)</option>
            {people.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
            {others.length > 0 && (
              <optgroup label="本部">
                {others.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
      </div>
      <fieldset>
        <legend className="label">依頼の内容</legend>
        <div className="flex flex-wrap gap-1.5">
          {(Object.keys(REQUEST_PURPOSE) as RequestPurpose[]).map((k) => (
            <label key={k} className={clsx("cursor-pointer rounded-lg border px-3 py-1.5 text-sm", purpose === k ? "border-accent bg-accent-soft font-medium text-accent-ink" : "border-line bg-panel text-ink-2")}>
              <input type="radio" name="purpose" value={k} checked={purpose === k} onChange={() => choosePurpose(k)} className="sr-only" />
              {REQUEST_PURPOSE[k].label}
            </label>
          ))}
        </div>
        <textarea
          name="note"
          value={note}
          onChange={(e) => {
            setNote(e.target.value);
            setEdited(true);
          }}
          rows={3}
          maxLength={2000}
          required
          className="field mt-2"
          placeholder="依頼の内容 (お客様の状況・お願いしたいこと)"
        />
      </fieldset>
      <fieldset>
        <legend className="label">対応期限</legend>
        <div className="flex flex-wrap gap-1.5">
          {DUE_CHOICES.map((d) => (
            <label key={d.id} className={clsx("cursor-pointer rounded-lg border px-3 py-1.5 text-sm", due === d.id ? "border-accent bg-accent-soft font-medium text-accent-ink" : "border-line bg-panel text-ink-2", d.id === "noon" && p.noonPassed && "pointer-events-none opacity-40")}>
              <input type="radio" name="due" value={d.id} checked={due === d.id} disabled={d.id === "noon" && p.noonPassed} onChange={() => setDue(d.id)} className="sr-only" />
              {d.label}
            </label>
          ))}
        </div>
        {due === "custom" && <input type="datetime-local" name="dueCustom" required min={`${p.today}T00:00`} className="field mt-2 w-auto" aria-label="期限の日時" />}
        <p className="mt-1 text-[11px] text-ink-3">期限までに日程の登録・返答がなければ、依頼先へ自動で再通知します (さらに 3 時間後は店長と依頼した人にも)。</p>
      </fieldset>
      <label className="flex items-center gap-2 text-sm text-ink">
        <input type="checkbox" name="urgent" value="1" className="h-4 w-4" />
        至急
      </label>
      <Button type="submit" size="sm">
        <Send />
        依頼を送る (メンションで知らせる)
      </Button>
    </form>
  );
}

function HoldForm(p: InquiryActionsProps) {
  return (
    <div className="space-y-3">
      {p.hold && (
        <div className="rounded-lg bg-subtle px-3 py-2 text-sm text-ink">
          いま: <span className="font-medium">{p.hold.reason}</span>
          {p.hold.nextContact ? ` (次回の連絡 ${p.hold.nextContact})` : ""}
          <form action={p.clearHoldAction} className="mt-2">
            <input type="hidden" name="returnTo" value={p.returnTo} />
            <Button type="submit" size="sm" variant="secondary">
              日程未定を外す (打ち合わせを再開)
            </Button>
          </form>
        </div>
      )}
      <form action={p.holdAction} className="space-y-3" data-testid="inquiry-hold-form">
        <input type="hidden" name="returnTo" value={p.returnTo} />
        <label className="block">
          <span className="label">理由</span>
          <input name="reason" defaultValue={p.hold?.reason ?? "お客様都合により日程未定"} maxLength={200} list="hold-reasons" className="field" />
          <datalist id="hold-reasons">
            <option value="お客様都合により日程未定" />
            <option value="お客様から改めて連絡をいただく" />
            <option value="ご家族と相談中" />
            <option value="工事の時期が未定 (来年以降など)" />
          </datalist>
        </label>
        <label className="block">
          <span className="label">次回の連絡予定日 (任意)</span>
          <input type="date" name="nextContact" defaultValue={p.hold?.nextContact} min={p.today} className="field w-auto" />
          <span className="mt-1 block text-[11px] text-ink-3">入れておくと、その日の朝に担当者へ知らせます。通常の未対応とは分けて「日程未定」に入ります。</span>
        </label>
        <Button type="submit" size="sm" variant="secondary">
          <CalendarX2 />
          {p.hold ? "日程未定の内容を更新" : "日程未定にする"}
        </Button>
      </form>
    </div>
  );
}
