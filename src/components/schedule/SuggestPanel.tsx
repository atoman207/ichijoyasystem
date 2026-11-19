"use client";

import { useState, useTransition } from "react";
import clsx from "clsx";
import { AlertTriangle, CalendarCheck, Check, ChevronDown, Loader2, MapPin, Sparkles, Users } from "lucide-react";
import Link from "@/components/ui/Link";
import type { ScheduleKind, StoreId } from "@/lib/db/types";
import type { SuggestCandidate, SuggestResult, SuggestSlot } from "@/lib/schedule-suggest";
import { suggestScheduleSlots } from "@/lib/actions/schedule";
import { shortDate, isDateKey } from "@/lib/calendar";
import { Field, Input, Select, buttonClass } from "@/components/ui";

/**
 * AI 予定候補日の提案 (予定の入力フォームの右側)
 * 店舗の 1 日の仕事量・畳の製造・担当者の空き・既存の現場との距離から、会社全体で効率のよい日時を提案する。
 * 「この日時にする」でフォームの日付・時刻・担当者に入れる (保存は利用者が「予定を登録する」で行う)。仕組みは src/lib/schedule-suggest.ts
 */

/** 候補日を提案できる種別 (案件の予定。src/lib/schedule-capacity.ts の SUGGEST_KINDS と同じ) */
export const SUGGESTABLE_KINDS: ScheduleKind[] = ["survey", "visit", "measure", "pickup", "delivery", "install"];

/** 畳の枚数を聞く種別 (引き取りは畳の製造の上限を確かめる) */
const TATAMI_KINDS: ScheduleKind[] = ["pickup", "delivery", "install", "measure"];

const SLOT_LABEL: Record<SuggestSlot, string> = { am: "午前", pm: "午後", day: "終日" };

function scoreTone(score: number) {
  if (score >= 75) return "bg-good-soft text-good-ink";
  if (score >= 60) return "bg-info-soft text-info-ink";
  return "bg-neutral-soft text-ink-2";
}

export function SuggestPanel({
  kind,
  storeId,
  caseValue,
  customerId,
  location,
  assigneeIds,
  eventId,
  onApply,
}: {
  kind: ScheduleKind;
  storeId: StoreId;
  caseValue?: string;
  customerId?: string;
  location?: string;
  assigneeIds: string[];
  eventId?: string;
  onApply: (c: SuggestCandidate) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tatami, setTatami] = useState("");
  const [staff, setStaff] = useState("");
  const [slot, setSlot] = useState<"" | SuggestSlot>("");
  const [from, setFrom] = useState("");
  const [days, setDays] = useState("21");
  const [keepAssignees, setKeepAssignees] = useState(false);
  const [result, setResult] = useState<{ key: string; data: SuggestResult } | null>(null);
  const [applied, setApplied] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  /** 候補は上位 3 件を表示し、残りは「ほかの候補」で開く (登録のボタンまで遠くならないように) */
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const fixed = keepAssignees && assigneeIds.length > 0;
  const query = {
    kind,
    storeId,
    caseRef: caseValue || undefined,
    customerId: customerId || undefined,
    location: location || undefined,
    tatamiCount: tatami.trim() ? Number(tatami) : undefined,
    staffCount: !fixed && staff ? Number(staff) : undefined,
    assigneeIds: fixed ? assigneeIds : undefined,
    slot: slot || undefined,
    from: isDateKey(from) ? from : undefined,
    days: Number(days) || undefined,
    eventId,
  };
  const key = JSON.stringify(query);
  const stale = Boolean(result && result.key !== key);

  const run = () => {
    setError("");
    setApplied(null);
    startTransition(async () => {
      try {
        const data = await suggestScheduleSlots(query);
        setResult({ key, data });
        setShowAll(false);
      } catch {
        setError("候補日を取得できませんでした。画面を再読み込みしてから、もう一度お試しください。");
      }
    });
  };

  const idOf = (c: SuggestCandidate) => `${c.date}|${c.slot}|${c.startTime ?? ""}|${c.assigneeIds.join(",")}`;
  const data = result?.data;

  return (
    <div>
      <div className="flex items-start gap-2">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
          <Sparkles className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold text-ink">AI 予定候補日の提案</h2>
          <p className="text-[11px] leading-relaxed text-ink-3">店舗の 1 日の仕事量・畳の製造・担当者の空き・近くの現場との距離から、会社全体で効率のよい日時を提案します。</p>
        </div>
      </div>

      <button type="button" onClick={() => setOpen((v) => !v)} className="mt-2 inline-flex items-center gap-1 text-xs text-accent hover:underline" aria-expanded={open}>
        <ChevronDown className={clsx("h-3.5 w-3.5 transition", open && "rotate-180")} aria-hidden />
        条件 (任意)
      </button>
      {open && (
        <div className="mt-2 grid grid-cols-2 gap-2">
          {TATAMI_KINDS.includes(kind) && (
            <Field label="畳の枚数" hint="空欄は案件から読み取り">
              <Input type="number" inputMode="numeric" min={0} max={200} value={tatami} onChange={(e) => setTatami(e.target.value)} placeholder="例: 6" />
            </Field>
          )}
          <Field label="人数" hint={fixed ? "選択中の担当者" : "空欄は過去の実績"}>
            <Select value={fixed ? String(assigneeIds.length) : staff} onChange={(e) => setStaff(e.target.value)} disabled={fixed}>
              <option value="">おまかせ</option>
              {[1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>
                  {n} 人
                </option>
              ))}
            </Select>
          </Field>
          <Field label="時間帯">
            <Select value={slot} onChange={(e) => setSlot(e.target.value as "" | SuggestSlot)}>
              <option value="">おまかせ</option>
              <option value="am">午前</option>
              <option value="pm">午後</option>
              <option value="day">終日</option>
            </Select>
          </Field>
          <Field label="探す日数">
            <Select value={days} onChange={(e) => setDays(e.target.value)}>
              {["14", "21", "30", "45", "62"].map((d) => (
                <option key={d} value={d}>
                  {d} 日間
                </option>
              ))}
            </Select>
          </Field>
          <Field label="この日から探す" hint="空欄は明日から" className="col-span-2">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          {assigneeIds.length > 0 && (
            <label className="col-span-2 flex cursor-pointer items-start gap-2 text-xs text-ink-2">
              <input type="checkbox" checked={keepAssignees} onChange={(e) => setKeepAssignees(e.target.checked)} className="mt-0.5 h-4 w-4 accent-accent" />
              選択中の担当者 ({assigneeIds.length} 人) が全員空いている日を探す
            </label>
          )}
        </div>
      )}

      <button type="button" onClick={run} disabled={pending} className={buttonClass(stale || !data ? "primary" : "secondary", "md", "mt-3 w-full")}>
        {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Sparkles className="h-4 w-4" aria-hidden />}
        {pending ? "候補を探しています…" : data ? (stale ? "条件が変わりました。もう一度探す" : "もう一度探す") : "候補日を探す"}
      </button>
      {!location && !caseValue && !customerId && <p className="mt-1.5 text-[11px] text-ink-3">場所 (現場住所) を入れると、近くの現場とまとめて回れる日を優先します。</p>}
      {error && <p className="mt-2 text-xs text-critical-ink">{error}</p>}

      {data && (
        <div className={clsx("mt-3 space-y-2", stale && "opacity-60")} aria-live="polite">
          {data.site && (
            <p className="flex items-center gap-1 text-[11px] text-ink-3">
              <MapPin className="h-3.5 w-3.5" aria-hidden />
              現場: {data.site.label}
              {data.tatamiCount ? ` ・畳 ${data.tatamiCount} 枚` : ""}
            </p>
          )}
          {data.candidates.length === 0 && <p className="rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn-ink">条件に合う日が見つかりませんでした。下の説明を確認してください。</p>}
          <ol className="space-y-2">
            {data.candidates.slice(0, showAll ? undefined : 3).map((c, i) => {
              const id = idOf(c);
              const isApplied = applied === id;
              const more = expanded === id;
              const when = c.startTime ? `${c.startTime}–${c.endTime}` : c.slot ? `${SLOT_LABEL[c.slot]} (時刻は相談)` : "";
              return (
                <li key={id} className={clsx("rounded-xl border px-3 py-2.5", isApplied ? "border-good bg-good-soft/40" : "border-line bg-panel")}>
                  <div className="flex items-start gap-2">
                    <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-subtle text-[11px] font-semibold text-ink-2">{i + 1}</span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-ink">
                        {shortDate(c.date)}
                        {c.endDate ? `〜${shortDate(c.endDate)}` : ""} <span className="font-normal text-ink-2">{when}</span>
                      </p>
                      <p className="mt-0.5 flex items-center gap-1 text-xs text-ink-2">
                        <Users className="h-3.5 w-3.5 shrink-0" aria-hidden />
                        <span className="truncate">{(c.assigneeNames ?? []).join("・") || "-"}</span>
                        {c.travelMin !== undefined && <span className="shrink-0 text-ink-3">・移動 約 {c.travelMin} 分</span>}
                      </p>
                    </div>
                    <span className={clsx("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold tnum", scoreTone(c.score))} title="効率の点数 (0〜100)">
                      {c.score} 点
                    </span>
                  </div>
                  <ul className="mt-1.5 space-y-0.5 pl-7 text-[11px] leading-relaxed text-ink-2">
                    {(more ? c.reasons : c.reasons.slice(0, 2)).map((r) => (
                      <li key={r}>・{r}</li>
                    ))}
                    {c.warnings.map((w) => (
                      <li key={w} className="flex gap-1 text-warn-ink">
                        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                        {w}
                      </li>
                    ))}
                  </ul>
                  <div className="mt-2 flex items-center gap-2 pl-7">
                    <button
                      type="button"
                      onClick={() => {
                        onApply(c);
                        setApplied(id);
                      }}
                      className={buttonClass(isApplied ? "secondary" : "primary", "sm")}
                    >
                      {isApplied ? <Check className="h-3.5 w-3.5" aria-hidden /> : <CalendarCheck className="h-3.5 w-3.5" aria-hidden />}
                      {isApplied ? "フォームに反映しました" : "この日時にする"}
                    </button>
                    {c.reasons.length > 2 && (
                      <button type="button" onClick={() => setExpanded(more ? null : id)} className="text-[11px] text-accent hover:underline">
                        {more ? "閉じる" : "理由をすべて見る"}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
          {data.candidates.length > 3 && (
            <button type="button" onClick={() => setShowAll((v) => !v)} className="inline-flex items-center gap-1 text-xs text-accent hover:underline" aria-expanded={showAll}>
              <ChevronDown className={clsx("h-3.5 w-3.5 transition", showAll && "rotate-180")} aria-hidden />
              {showAll ? "上位 3 件だけ表示" : `ほかの候補 (${data.candidates.length - 3} 件)`}
            </button>
          )}
          {data.notes.length > 0 && (
            <details className="text-[11px] text-ink-3">
              <summary className="cursor-pointer select-none hover:text-ink">提案の根拠と前提</summary>
              <ul className="mt-1 space-y-1 leading-relaxed">
                {data.notes.map((n) => (
                  <li key={n}>・{n}</li>
                ))}
              </ul>
              <Link href="/schedule/capacity" className="mt-1 inline-block text-accent hover:underline">
                仕事量と提案の設定 (1 日の上限) を見る
              </Link>
            </details>
          )}
          <p className="text-[11px] text-ink-3">反映したあと「予定を登録する」で保存します。担当者の予定の重複は下の欄で確認できます。</p>
        </div>
      )}
    </div>
  );
}
