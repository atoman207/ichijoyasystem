"use client";

import { useMemo, useState } from "react";
import { useFormStatus } from "react-dom";
import Link from "@/components/ui/Link";
import clsx from "clsx";
import { Clock, Globe, Link2, MapPin, Repeat } from "lucide-react";
import type { ScheduleKind, StoreId } from "@/lib/db/types";
import { SCHEDULE_GROUP_LABEL, SCHEDULE_KIND, SCHEDULE_REPEAT, type ScheduleGroup, type ScheduleRepeat } from "@/lib/constants";
import { fromMinutes, isDateKey, periodLabel, repeatDates, shortDate, toMinutes, type ConflictQuery } from "@/lib/calendar";
import { Card, Field, Input, Select, Textarea, buttonClass } from "@/components/ui";
import { KINDS_BY_GROUP, KindIcon, kindStyle } from "./parts";
import { AssigneePicker, ConflictPanel, useConflictReport, type FormStore, type FormUser } from "./form-parts";

/** 案件の選択肢 (value は "order:o_1" 形式) */
export interface FormCase {
  value: string;
  label: string;
  stage: string;
  number: string;
  storeId: StoreId;
  customerId?: string;
  customerName: string;
  location?: string;
  assigneeIds: string[];
  href?: string;
}

export interface FormCustomer {
  id: string;
  name: string;
  storeId: StoreId;
  address?: string;
}

export interface EventFormValues {
  title: string;
  kind: ScheduleKind;
  date: string;
  endDate: string;
  allDay: boolean;
  startTime: string;
  endTime: string;
  /** 時刻未定で午前 / 午後だけ決まっている */
  slot: "" | "am" | "pm";
  storeId: StoreId;
  companyWide: boolean;
  assigneeIds: string[];
  caseValue: string;
  customerId: string;
  location: string;
  memo: string;
}

const PRESETS: { label: string; start?: string; end?: string; minutes?: number; allDay?: boolean; slot?: "am" | "pm" }[] = [
  { label: "30分", minutes: 30 },
  { label: "1時間", minutes: 60 },
  { label: "2時間", minutes: 120 },
  { label: "午前 9–12時", start: "09:00", end: "12:00" },
  { label: "午後 13–17時", start: "13:00", end: "17:00" },
  { label: "午前 (時刻未定)", slot: "am" },
  { label: "午後 (時刻未定)", slot: "pm" },
  { label: "終日", allDay: true },
];

function SubmitButton({ disabled, label }: { disabled: boolean; label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={disabled || pending} className={buttonClass("primary", "lg", "w-full")}>
      {pending ? "保存しています…" : label}
    </button>
  );
}

export function EventForm({
  mode,
  action,
  eventId,
  initial,
  users,
  stores,
  cases,
  customers,
  fixedCase,
  lockKind,
  storeLocked,
  canCompanyWide,
  currentUserId,
  back,
  returnTo,
  cancelHref,
  syncedOrderNumber,
}: {
  mode: "create" | "edit";
  action: (formData: FormData) => void | Promise<void>;
  eventId?: string;
  initial: EventFormValues;
  users: FormUser[];
  stores: FormStore[];
  cases: FormCase[];
  customers: FormCustomer[];
  /** 案件の画面から登録するとき・受注と連動する予定 (案件は変更できない) */
  fixedCase?: FormCase;
  /** 受注と連動する施工予定 (種別は「施工」のまま) */
  lockKind?: boolean;
  /** 店舗ロールは自店舗に固定 */
  storeLocked: boolean;
  canCompanyWide: boolean;
  currentUserId: string;
  back: string;
  returnTo?: string;
  cancelHref: string;
  syncedOrderNumber?: string;
}) {
  const [v, setV] = useState<EventFormValues>(initial);
  const [endTouched, setEndTouched] = useState(Boolean(initial.endTime));
  const [repeat, setRepeat] = useState<ScheduleRepeat>("none");
  const [until, setUntil] = useState("");
  const [ackFor, setAckFor] = useState<string | null>(null);

  const set = <K extends keyof EventFormValues>(k: K, val: EventFormValues[K]) => setV((prev) => ({ ...prev, [k]: val }));
  const selectedCase = fixedCase ?? cases.find((c) => c.value === v.caseValue);
  const storeDisabled = storeLocked || Boolean(selectedCase) || Boolean(syncedOrderNumber);
  const caseGroups = useMemo(() => {
    const m = new Map<string, FormCase[]>();
    for (const c of cases) m.set(c.stage, [...(m.get(c.stage) ?? []), c]);
    return [...m.entries()];
  }, [cases]);

  const onKind = (k: ScheduleKind) =>
    setV((prev) => ({ ...prev, kind: k, allDay: SCHEDULE_KIND[k].minutes === 0 && !prev.startTime ? true : prev.allDay }));
  const onStart = (t: string) =>
    setV((prev) => ({
      ...prev,
      startTime: t,
      endTime: !endTouched && t ? fromMinutes(toMinutes(t) + (SCHEDULE_KIND[prev.kind].minutes || 60)) : prev.endTime,
    }));
  const onCase = (value: string) => {
    const c = cases.find((x) => x.value === value);
    setV((prev) => ({
      ...prev,
      caseValue: value,
      storeId: c && !storeLocked ? c.storeId : prev.storeId,
      customerId: c ? (c.customerId ?? "") : prev.customerId,
      location: c && !prev.location ? (c.location ?? "") : prev.location,
      assigneeIds: c && prev.assigneeIds.length === 0 ? c.assigneeIds : prev.assigneeIds,
      companyWide: c ? false : prev.companyWide,
    }));
  };
  const applyPreset = (p: (typeof PRESETS)[number]) => {
    if (p.allDay) {
      setV((prev) => ({ ...prev, allDay: true, slot: "" }));
      return;
    }
    if (p.slot) {
      const slot = p.slot;
      setV((prev) => ({ ...prev, allDay: false, slot, startTime: "", endTime: "" }));
      return;
    }
    setEndTouched(true);
    setV((prev) => {
      const start = p.start ?? (prev.startTime || "09:00");
      const end = p.end ?? fromMinutes(toMinutes(start) + (p.minutes ?? 60));
      return { ...prev, allDay: false, slot: "", startTime: start, endTime: end };
    });
  };
  const slotOnly = !v.allDay && !v.startTime && v.slot !== "";

  // 入力チェック
  const timeError = !v.allDay && v.startTime && v.endTime && toMinutes(v.endTime) <= toMinutes(v.startTime) ? "終了時刻は開始時刻より後にしてください" : "";
  const endDateError = v.endDate && v.endDate < v.date ? "終了日は開始日以降にしてください" : "";
  const repeatError = repeat !== "none" && (!isDateKey(until) || until <= v.date) ? "繰り返しの終了日を開始日より後に設定してください" : "";
  const assigneeError = v.assigneeIds.length === 0 && !v.companyWide ? "担当者を 1 人以上選んでください" : "";
  const titleError = !v.title.trim() && !selectedCase ? "件名を入力してください" : "";
  const occurrences = repeat !== "none" && !repeatError ? repeatDates(v.date, repeat, until) : [v.date];

  // 重複チェック (担当者が未選択でも、全社員の空き状況を出すために問い合わせる)
  const query: ConflictQuery | null = isDateKey(v.date)
    ? {
        eventId,
        date: v.date,
        endDate: v.endDate && v.endDate > v.date ? v.endDate : undefined,
        startTime: v.allDay ? undefined : v.startTime || undefined,
        endTime: v.allDay ? undefined : v.endTime || undefined,
        slot: slotOnly ? (v.slot as "am" | "pm") : undefined,
        assigneeIds: v.assigneeIds,
        caseRef: selectedCase?.value,
        repeat: repeat === "none" || repeatError ? "none" : repeat,
        repeatUntil: repeat === "none" || repeatError ? undefined : until,
      }
    : null;
  const { report, fresh, checking } = useConflictReport(query);
  const conflicts = fresh ? (report?.conflicts ?? []) : [];
  const conflictKey = conflicts.map((c) => `${c.userId}:${c.eventId}:${c.day}`).join(",");
  const ack = conflictKey !== "" && ackFor === conflictKey;
  const blocked = conflicts.length > 0 && !ack;
  const invalid = Boolean(timeError || endDateError || repeatError || assigneeError || titleError || !isDateKey(v.date));

  const store = stores.find((s) => s.id === v.storeId);
  const preview = isDateKey(v.date)
    ? periodLabel({ date: v.date, endDate: v.endDate || undefined, startTime: v.allDay ? undefined : v.startTime || undefined, endTime: v.allDay ? undefined : v.endTime || undefined, slot: slotOnly ? (v.slot as "am" | "pm") : undefined })
    : "";
  const customer = customers.find((c) => c.id === v.customerId);
  const suggestedLocation = selectedCase?.location || customer?.address;

  return (
    <form action={action} className="@container">
      <input type="hidden" name="back" value={back} />
      {returnTo && <input type="hidden" name="returnTo" value={returnTo} />}
      {fixedCase && <input type="hidden" name="caseRef" value={fixedCase.value} />}
      {v.allDay && <input type="hidden" name="allDay" value="1" />}
      {slotOnly && <input type="hidden" name="slot" value={v.slot} />}
      {storeDisabled && <input type="hidden" name="storeId" value={v.storeId} />}

      <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="@container min-w-0 space-y-4">
          {/* 種別・件名・案件 */}
          <Card>
            <fieldset>
              <legend className="label">種別</legend>
              {(Object.keys(KINDS_BY_GROUP) as ScheduleGroup[]).map((g) => (
                <div key={g} className="mt-1.5">
                  <div className="mb-1.5 text-[11px] font-semibold text-ink-3">{SCHEDULE_GROUP_LABEL[g]}</div>
                  <div className="grid grid-cols-2 gap-1.5 @md:grid-cols-3 @2xl:grid-cols-6">
                    {KINDS_BY_GROUP[g].map((k) => {
                      const active = v.kind === k;
                      const s = kindStyle(k);
                      const disabled = lockKind && !active;
                      return (
                        <label
                          key={k}
                          className={clsx(
                            "flex cursor-pointer items-center gap-1.5 rounded-lg border px-2 py-1.5 text-xs transition has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent/40",
                            active ? "border-accent bg-accent-soft/50 font-semibold text-ink ring-1 ring-accent/30" : "border-line text-ink-2 hover:border-line-strong hover:bg-subtle",
                            disabled && "pointer-events-none opacity-40",
                          )}
                        >
                          <input type="radio" name="kind" value={k} checked={active} onChange={() => onKind(k)} disabled={disabled} className="sr-only" />
                          <span className={clsx("inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md", s.soft, s.ink)}>
                            <KindIcon kind={k} className="h-3.5 w-3.5" />
                          </span>
                          {SCHEDULE_KIND[k].label}
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}
              {lockKind && <p className="mt-2 text-[11px] text-ink-3">受注の施工予定と連動する予定のため、種別は「施工」のままです。</p>}
            </fieldset>

            <div className="mt-4 grid gap-3">
              <Field label="件名" required={!selectedCase} hint={selectedCase ? `空欄なら「${selectedCase.customerName ? `${selectedCase.customerName} 様 ` : ""}${SCHEDULE_KIND[v.kind].label}」になります` : undefined}>
                <Input
                  name="title"
                  value={v.title}
                  onChange={(e) => set("title", e.target.value)}
                  maxLength={120}
                  required={!selectedCase}
                  placeholder={selectedCase ? `${selectedCase.customerName ? `${selectedCase.customerName} 様 ` : ""}${SCHEDULE_KIND[v.kind].label}` : SCHEDULE_KIND[v.kind].group === "case" ? "例: 坂本様 現地調査 (和室8畳)" : "例: 店長会議 / 安全講習 / 展示販売会"}
                />
              </Field>

              {fixedCase ? (
                <div className="flex flex-wrap items-center gap-2 rounded-xl border border-accent/25 bg-accent-soft/40 px-3 py-2 text-sm">
                  <Link2 className="h-4 w-4 text-accent" aria-hidden />
                  <span className="text-xs text-ink-2">案件</span>
                  <span className="min-w-0 font-medium text-ink">{fixedCase.label}</span>
                  {fixedCase.href && (
                    <Link href={fixedCase.href} className="ml-auto text-xs font-medium text-accent hover:underline">
                      案件を開く
                    </Link>
                  )}
                  <p className="w-full text-[11px] text-ink-3">
                    {syncedOrderNumber
                      ? `受注 ${syncedOrderNumber} の施工予定と連動しています。日付・担当者・場所を変えると、受注の施工期間・施工担当・現場住所も更新されます。`
                      : "案件の画面と、案件の店舗のカレンダー (担当者つき) の両方に表示されます。"}
                  </p>
                </div>
              ) : (
                <Field label="案件 (任意)" hint={SCHEDULE_KIND[v.kind].group === "case" ? "案件に紐づけると、案件の画面と店舗のカレンダーの両方に担当者つきで表示されます" : "会議・会合などは紐づけなくて構いません"}>
                  <Select name="caseRef" value={v.caseValue} onChange={(e) => onCase(e.target.value)}>
                    <option value="">紐づけない</option>
                    {caseGroups.map(([stage, list]) => (
                      <optgroup key={stage} label={stage}>
                        {list.map((c) => (
                          <option key={c.value} value={c.value}>
                            {c.label}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </Select>
                </Field>
              )}
            </div>
          </Card>

          {/* 日時 */}
          <Card>
            <h2 className="mb-3 flex items-center gap-2 text-[15px] font-semibold text-ink">
              <Clock className="h-4 w-4 text-accent" aria-hidden />
              日時
            </h2>
            <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
              <Field label="日付" required>
                <Input type="date" name="date" value={v.date} onChange={(e) => set("date", e.target.value)} required />
              </Field>
              <Field label="終了日 (複数日にわたる場合)" hint={endDateError || "空欄なら 1 日の予定です"}>
                <Input type="date" name="endDate" value={v.endDate} min={v.date} onChange={(e) => set("endDate", e.target.value)} aria-invalid={Boolean(endDateError)} />
              </Field>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <label className="mr-2 inline-flex cursor-pointer items-center gap-2 text-sm text-ink">
                <input type="checkbox" checked={v.allDay} onChange={(e) => setV((prev) => ({ ...prev, allDay: e.target.checked, slot: "" }))} className="h-4 w-4 accent-accent" />
                終日
              </label>
              {PRESETS.map((p) => {
                const on = (p.slot && slotOnly && v.slot === p.slot) || (p.allDay && v.allDay);
                return (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => applyPreset(p)}
                    aria-pressed={Boolean(on)}
                    className={clsx("rounded-full border px-2.5 py-1 text-xs transition hover:border-accent/40 hover:bg-accent-soft/40 hover:text-accent-ink", on ? "border-accent bg-accent-soft/60 text-accent-ink" : "border-line text-ink-2")}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
            {slotOnly && <p className="mt-2 text-xs text-ink-2">{v.slot === "am" ? "午前" : "午後"}の訪問 (時刻未定)。同じ時間帯の訪問どうしは重複として扱いません。時刻が決まったら下の欄に入力してください。</p>}
            {!v.allDay && (
              <div className="mt-3 grid max-w-md grid-cols-2 gap-3">
                <Field label="開始時刻" hint="空欄なら終日">
                  <Input
                    type="time"
                    name="startTime"
                    value={v.startTime}
                    step={300}
                    onChange={(e) => {
                      onStart(e.target.value);
                      if (e.target.value) set("slot", "");
                    }}
                  />
                </Field>
                <Field label="終了時刻" hint={timeError || `「${SCHEDULE_KIND[v.kind].label}」の目安で自動入力`}>
                  <Input
                    type="time"
                    name="endTime"
                    value={v.endTime}
                    step={300}
                    onChange={(e) => {
                      setEndTouched(true);
                      set("endTime", e.target.value);
                    }}
                    aria-invalid={Boolean(timeError)}
                    disabled={!v.startTime}
                  />
                </Field>
              </div>
            )}
            {timeError && <p className="mt-1 text-xs text-critical-ink">{timeError}</p>}
            {v.endDate && v.endDate > v.date && !v.allDay && v.startTime && <p className="mt-2 text-[11px] text-ink-3">複数日の予定では、時刻は「各日の時間帯」として扱います (重複の確認も各日で行います)。</p>}

            {mode === "create" && (
              <div className="mt-4 border-t border-line pt-3">
                <div className="flex flex-wrap items-end gap-3">
                  <Field label="繰り返し" className="w-44">
                    <Select name="repeat" value={repeat} onChange={(e) => setRepeat(e.target.value as ScheduleRepeat)}>
                      {(Object.keys(SCHEDULE_REPEAT) as ScheduleRepeat[]).map((r) => (
                        <option key={r} value={r}>
                          {SCHEDULE_REPEAT[r]}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  {repeat !== "none" && (
                    <Field label="繰り返しの終了日" className="w-44">
                      <Input type="date" name="repeatUntil" value={until} min={v.date} onChange={(e) => setUntil(e.target.value)} required />
                    </Field>
                  )}
                  {repeat !== "none" && (
                    <p className={clsx("pb-2 text-xs", repeatError ? "text-critical-ink" : "text-ink-2")}>
                      <Repeat className="mr-1 inline h-3.5 w-3.5" aria-hidden />
                      {repeatError || `${occurrences.length} 回登録されます (${shortDate(occurrences[0])}〜${shortDate(occurrences[occurrences.length - 1])})`}
                    </p>
                  )}
                </div>
              </div>
            )}
          </Card>

          {/* 担当者・店舗 */}
          <Card>
            <div className="mb-4 grid grid-cols-1 gap-3 @xl:grid-cols-2">
              <Field label="店舗 (載せるカレンダー)" hint={selectedCase ? "案件の店舗のカレンダーに載ります" : storeLocked ? "自店舗のカレンダーに載ります" : undefined}>
                <Select name={storeDisabled ? undefined : "storeId"} value={v.storeId} onChange={(e) => set("storeId", e.target.value as StoreId)} disabled={storeDisabled}>
                  {stores.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </Field>
              {canCompanyWide && !selectedCase && !syncedOrderNumber && (
                <label className="flex cursor-pointer items-start gap-2 self-end rounded-xl border border-line px-3 py-2 text-sm text-ink hover:bg-subtle">
                  <input type="checkbox" name="companyWide" value="1" checked={v.companyWide} onChange={(e) => set("companyWide", e.target.checked)} className="mt-0.5 h-4 w-4 accent-accent" />
                  <span>
                    <span className="inline-flex items-center gap-1 font-medium">
                      <Globe className="h-3.5 w-3.5" aria-hidden />
                      全社共通の予定にする
                    </span>
                    <span className="block text-[11px] text-ink-3">全店舗のカレンダーに表示 (社内行事・全社会議など)。担当者は省略できます</span>
                  </span>
                </label>
              )}
            </div>
            <AssigneePicker
              users={users}
              stores={stores}
              selected={v.assigneeIds}
              onChange={(ids) => set("assigneeIds", ids)}
              busy={fresh ? report?.busy : undefined}
              currentUserId={currentUserId}
              storeId={v.storeId}
              label={SCHEDULE_KIND[v.kind].group === "case" ? "担当者" : "参加者・担当者"}
              required={!v.companyWide}
              hint={`店舗をまたいで選べます (応援など)。右の数字は ${isDateKey(v.date) ? shortDate(v.date) : "選択日"} の予定の入り具合です`}
            />
            {assigneeError && <p className="mt-1 text-xs text-critical-ink">{assigneeError}</p>}
          </Card>

          {/* 場所・お客様・メモ */}
          <Card>
            <div className="grid gap-3">
              {!selectedCase && (
                <Field label="お客様 (任意)">
                  <Select name="customerId" value={v.customerId} onChange={(e) => set("customerId", e.target.value)}>
                    <option value="">指定しない</option>
                    {customers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              <Field label="場所">
                <Input name="location" value={v.location} onChange={(e) => set("location", e.target.value)} maxLength={200} placeholder={SCHEDULE_KIND[v.kind].group === "case" ? "現場住所" : "例: 本社 会議室 / 坪井ショールーム"} />
              </Field>
              {suggestedLocation && suggestedLocation !== v.location && (
                <button type="button" onClick={() => set("location", suggestedLocation)} className="-mt-1 inline-flex items-center gap-1 self-start text-xs text-accent hover:underline">
                  <MapPin className="h-3.5 w-3.5" aria-hidden />
                  {selectedCase ? "現場住所" : "お客様の住所"}を入れる ({suggestedLocation})
                </button>
              )}
              <Field label="メモ (社内共有)">
                <Textarea name="memo" value={v.memo} onChange={(e) => set("memo", e.target.value)} maxLength={2000} placeholder="持ち物・駐車場・事前連絡・議題など" />
              </Field>
            </div>
          </Card>
        </div>

        {/* 空き状況・重複 / 保存 */}
        <div className="min-w-0 space-y-4 @4xl:sticky @4xl:top-24 @4xl:self-start">
          <Card>
            <ConflictPanel
              report={report}
              fresh={fresh}
              checking={checking}
              hasAssignees={v.assigneeIds.length > 0}
              ackChecked={ack}
              onAck={(on) => setAckFor(on ? conflictKey : null)}
              ackLabel={mode === "create" ? "重複を承知で登録する (担当者・店長と調整済み)" : "重複を承知で保存する (担当者・店長と調整済み)"}
            />
          </Card>
          <Card>
            <dl className="mb-4 space-y-1 text-xs text-ink-2">
              <div className="flex gap-2">
                <dt className="w-12 shrink-0 text-ink-3">日時</dt>
                <dd className="text-ink">
                  {preview}
                  {occurrences.length > 1 ? ` ほか ${occurrences.length - 1} 回` : ""}
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-12 shrink-0 text-ink-3">表示先</dt>
                <dd className="text-ink">{v.companyWide ? "全店舗のカレンダー (全社共通)" : `${store?.name ?? ""}のカレンダー`}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-12 shrink-0 text-ink-3">担当</dt>
                <dd className="text-ink">{v.assigneeIds.length ? `${v.assigneeIds.length} 人` : v.companyWide ? "全員 (指定なし)" : "未選択"}</dd>
              </div>
            </dl>
            <SubmitButton disabled={invalid || blocked} label={mode === "create" ? (occurrences.length > 1 ? `予定を ${occurrences.length} 件登録する` : "予定を登録する") : "変更を保存する"} />
            {blocked && <p className="mt-2 text-center text-[11px] text-critical-ink">重複を解消するか、「重複を承知で…」にチェックしてください</p>}
            {invalid && !blocked && <p className="mt-2 text-center text-[11px] text-ink-3">{titleError || assigneeError || timeError || endDateError || repeatError || "日付を入力してください"}</p>}
            <Link href={cancelHref} className={buttonClass("ghost", "md", "mt-2 w-full")}>
              キャンセル
            </Link>
          </Card>
        </div>
      </div>
    </form>
  );
}
