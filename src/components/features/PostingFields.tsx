"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { OrderPosting } from "@/lib/db/types";
import type { StaffChoiceGroup } from "@/lib/staff-choices";
import { StaffOptions } from "./StaffOptions";

/**
 * ポスティング (チラシの配布) の実績を入れる欄 (お客様のご要望 2026-11-27「■3」)。
 * 誰が何枚 (複数人はそれぞれの枚数)、配っていなければ「配れてない」。売上登録・請求書の発行の前に必要 (src/lib/sales-ready.ts)。
 * 送る名前: postingSent = 1・posting.status (done / none)・posting.user と posting.count (同じ並び)・posting.date・posting.area
 */
export function PostingFields({ groups, value, defaultDate, defaultUserIds = [] }: { groups: StaffChoiceGroup[]; value?: OrderPosting; defaultDate: string; defaultUserIds?: string[] }) {
  const [status, setStatus] = useState<"" | "done" | "none">(value?.status ?? "");
  const [rows, setRows] = useState<{ key: number; userId: string; count: string }[]>(() =>
    value?.status === "done" && value.entries.length
      ? value.entries.map((e, i) => ({ key: i, userId: e.userId, count: String(e.count) }))
      : (defaultUserIds.length ? defaultUserIds : [""]).map((id, i) => ({ key: i, userId: id, count: "" })),
  );
  const total = rows.reduce((a, r) => a + (Number(r.count.replace(/[,，]/g, "")) || 0), 0);
  const set = (key: number, patch: Partial<{ userId: string; count: string }>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  return (
    <fieldset className={status ? "" : "rounded-lg border border-warn/40 bg-warn-soft/30 p-2"} data-testid="posting-fields">
      <legend className="text-xs font-semibold text-ink">
        ポスティング (チラシの配布){!status && <span className="ml-1 font-normal text-warn-ink">枚数を入れるか「配れてない」を選んでください</span>}
      </legend>
      <input type="hidden" name="postingSent" value="1" />
      <div className="mt-1 flex flex-wrap gap-1.5">
        {(
          [
            ["done", "配った"],
            ["none", "配れてない"],
          ] as const
        ).map(([v, label]) => (
          <label key={v} className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-line bg-panel px-3 py-1 text-xs text-ink has-[:checked]:border-accent has-[:checked]:bg-accent-soft has-[:checked]:font-medium has-[:checked]:text-accent-ink">
            <input type="radio" name="posting.status" value={v} checked={status === v} onChange={() => setStatus(v)} className="h-3.5 w-3.5" />
            {label}
          </label>
        ))}
      </div>
      {status === "done" && (
        <div className="mt-2 space-y-1.5">
          {rows.map((r) => (
            <div key={r.key} className="flex flex-wrap items-center gap-1.5">
              <select name="posting.user" value={r.userId} onChange={(e) => set(r.key, { userId: e.target.value })} className="field h-9 w-auto min-w-40 py-1 text-sm" aria-label="配った人">
                <option value="">配った人を選ぶ</option>
                <StaffOptions groups={groups} noneLabel={false} />
              </select>
              <input name="posting.count" value={r.count} onChange={(e) => set(r.key, { count: e.target.value })} inputMode="numeric" placeholder="枚数" className="field h-9 w-24 py-1 text-sm" aria-label="配った枚数" />
              <span className="text-xs text-ink-3">枚</span>
              {rows.length > 1 && (
                <button type="button" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} className="rounded p-1 text-critical hover:bg-critical-soft" aria-label="この人を外す">
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" onClick={() => setRows((rs) => [...rs, { key: Math.max(0, ...rs.map((x) => x.key)) + 1, userId: "", count: "" }])} className="inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-xs text-ink-2 hover:bg-subtle">
              <Plus className="h-3.5 w-3.5" />
              配った人を追加
            </button>
            <span className="text-xs text-ink-2">合計 {total.toLocaleString("ja-JP")} 枚</span>
          </div>
        </div>
      )}
      {status && (
        <div className="mt-2 grid grid-cols-1 gap-2 @xl:grid-cols-2">
          <label className="block">
            <span className="text-[11px] text-ink-3">配った日 (作業日報の日)</span>
            <input type="date" name="posting.date" defaultValue={value?.date ?? defaultDate} className="field h-9 py-1 text-sm" />
          </label>
          {status === "done" && (
            <label className="block">
              <span className="text-[11px] text-ink-3">配った地域 (町名・任意)</span>
              <input name="posting.area" defaultValue={value?.area ?? ""} maxLength={80} placeholder="例: 合志市須屋" className="field h-9 py-1 text-sm" />
            </label>
          )}
        </div>
      )}
    </fieldset>
  );
}
