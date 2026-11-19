"use client";

import { useState, useTransition } from "react";
import { CalendarPlus, FastForward, Loader2 } from "lucide-react";
import Link from "@/components/ui/Link";
import type { StoreId } from "@/lib/db/types";
import type { PullForwardOption } from "@/lib/scheduling/replan";
import { pullForwardAction } from "@/lib/actions/scheduling";
import { Button, Field, Input, Select } from "@/components/ui";
import { CandidateView, HoldButton } from "./CandidateView";

/**
 * 空いた枠の使い方 (取消し・延期のあと)。後の日の予定の前倒しと、日程のない案件を提案する。
 * 前倒しは予定の変更画面へ (お客様・担当者に連絡してから)、日程のない案件は仮押さえ
 */

export interface FreedRow {
  storeId: StoreId;
  storeName: string;
  date: string;
  label: string;
  at: string;
}

function Options({ storeId, date }: { storeId: StoreId; date: string }) {
  const [opts, setOpts] = useState<PullForwardOption[] | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="mt-2">
      {!opts && (
        <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={() => start(async () => setOpts(await pullForwardAction({ storeId, date }).catch(() => [])))}>
          {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <FastForward className="h-4 w-4" aria-hidden />}
          この枠に入れられる予定・案件を探す
        </Button>
      )}
      {opts && opts.length === 0 && <p className="text-xs text-ink-3">この日に入れられる予定・案件は見つかりませんでした。</p>}
      {opts && opts.length > 0 && (
        <ul className="space-y-2">
          {opts.map((o) => (
            <li key={o.eventId ?? o.key} className="rounded-lg border border-line bg-panel px-3 py-2">
              <p className="mb-1 text-xs font-medium text-ink">
                {o.type === "advance" ? (
                  <>
                    前倒し: {o.title} <span className="text-ink-3">({o.currentDate} → {date}・{o.daysEarlier} 日早く)</span>
                  </>
                ) : (
                  <>日程のない案件: {o.title}</>
                )}
              </p>
              <div className="flex flex-col gap-2 @3xl:flex-row @3xl:items-start @3xl:justify-between">
                <CandidateView c={o.candidate} compact />
                {o.type === "advance" && o.eventId ? (
                  <Link href={`/schedule/${o.eventId}/edit?date=${o.candidate.date}${o.candidate.startTime ? `&start=${o.candidate.startTime}` : ""}`} className="text-xs font-medium text-accent hover:underline">
                    予定を変更する (連絡してから) →
                  </Link>
                ) : (
                  <HoldButton base={{ storeId, kind: o.kind, title: o.title }} candidates={[o.candidate]} />
                )}
              </div>
              {o.href && o.type === "waiting" && (
                <Link href={o.href} className="mt-1 inline-block text-[11px] text-accent hover:underline">
                  案件を開く →
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function FreedPanel({ freed, stores, today }: { freed: FreedRow[]; stores: { id: StoreId; name: string }[]; today: string }) {
  const [store, setStore] = useState<string>(stores[0]?.id ?? "");
  const [date, setDate] = useState(today);
  const [manual, setManual] = useState<{ storeId: StoreId; date: string } | null>(null);
  return (
    <div className="space-y-4">
      {freed.length === 0 ? (
        <p className="text-xs text-ink-3">この 7 日の取消し・延期で空いた今後の枠はありません。</p>
      ) : (
        <ul className="space-y-3">
          {freed.map((f) => (
            <li key={`${f.storeId}-${f.date}-${f.at}`} className="rounded-xl border border-line px-3 py-2.5">
              <p className="text-sm font-medium text-ink">
                {f.date} <span className="text-xs font-normal text-ink-3">{f.storeName}</span>
              </p>
              <p className="text-xs text-ink-2">{f.label}</p>
              <Options storeId={f.storeId} date={f.date} />
            </li>
          ))}
        </ul>
      )}
      <div className="rounded-xl border border-dashed border-line px-3 py-2.5">
        <p className="mb-2 flex items-center gap-1 text-xs font-medium text-ink-2">
          <CalendarPlus className="h-3.5 w-3.5" aria-hidden /> 日を指定して空き枠の使い方を探す
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="店舗">
            <Select value={store} onChange={(e) => setStore(e.target.value)}>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="日">
            <Input type="date" min={today} value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Button type="button" size="sm" variant="secondary" onClick={() => setManual({ storeId: store as StoreId, date })}>
            探す
          </Button>
        </div>
        {manual && <Options key={`${manual.storeId}-${manual.date}`} storeId={manual.storeId} date={manual.date} />}
      </div>
    </div>
  );
}
