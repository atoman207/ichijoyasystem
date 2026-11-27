"use client";

import { useState } from "react";
import { WORK_ROLES, WORK_ROLE_HINT, WORK_ROLE_LABEL, type WorkRole } from "@/lib/work-staff";
import type { StaffChoiceGroup } from "@/lib/staff-choices";

type Value = Record<WorkRole, string[]> & { none?: WorkRole[] };

const chip =
  "inline-flex cursor-pointer items-center gap-1 rounded-full border border-line bg-panel px-2.5 py-1 text-xs text-ink has-[:checked]:border-accent has-[:checked]:bg-accent-soft has-[:checked]:font-medium has-[:checked]:text-accent-ink";

/**
 * 作業の担当 (現地見積・引取・納品・施工) を選ぶ欄。複数名可 (お客様のご要望 2026-11-25「④」)。
 * お客様のご要望 2026-11-27「■2」: 作業ごとに「なし」も選べる・施工店舗の社員を先に出す・ほかの店舗の社員も選べる (「ほかの店舗の社員」を開く)。
 * 送る名前は workStaff.<役割> (社員 ID。複数)・workStaff.<役割>.none = 1 (なし)、送ったことを workStaffSent = 1 で知らせる
 * (src/lib/work-staff.ts の workStaffFromForm・src/lib/sales-ready.ts の workStaffNoneFromForm)
 */
export function WorkStaffFields({ groups, value, require = false }: { groups: StaffChoiceGroup[]; value: Value; require?: boolean }) {
  const [sel, setSel] = useState<Value>(() => ({ survey: [...value.survey], pickup: [...value.pickup], delivery: [...value.delivery], install: [...value.install], none: [...(value.none ?? [])] }));
  const primary = groups.filter((g) => g.primary || g === groups[0]);
  const others = groups.filter((g) => !primary.includes(g));
  const toggle = (role: WorkRole, id: string) =>
    setSel((s) => {
      const on = s[role].includes(id);
      return { ...s, [role]: on ? s[role].filter((x) => x !== id) : [...s[role], id], none: (s.none ?? []).filter((r) => r !== role) };
    });
  const setNone = (role: WorkRole, v: boolean) => setSel((s) => ({ ...s, [role]: v ? [] : s[role], none: v ? [...new Set([...(s.none ?? []), role])] : (s.none ?? []).filter((r) => r !== role) }));
  const people = (role: WorkRole, list: StaffChoiceGroup[]) =>
    list.map((g) => (
      <div key={`${g.storeId}:${g.label}`} className="flex flex-wrap items-center gap-1">
        <span className="mr-1 text-[10px] text-ink-3">{g.label}</span>
        {g.users.map((u) => (
          <label key={u.id} className={chip}>
            <input type="checkbox" name={`workStaff.${role}`} value={u.id} checked={sel[role].includes(u.id)} onChange={() => toggle(role, u.id)} className="h-3.5 w-3.5" />
            {u.name}
          </label>
        ))}
      </div>
    ));
  return (
    <div className="space-y-3" data-testid="work-staff-fields">
      <input type="hidden" name="workStaffSent" value="1" />
      {WORK_ROLES.map((role) => {
        const none = (sel.none ?? []).includes(role);
        const undecided = !none && sel[role].length === 0;
        const otherPicked = others.some((g) => g.users.some((u) => sel[role].includes(u.id)));
        return (
          <fieldset key={role} className={undecided && require ? "rounded-lg border border-warn/40 bg-warn-soft/30 p-2" : ""}>
            <legend className="text-xs font-semibold text-ink">
              {WORK_ROLE_LABEL[role]} <span className="font-normal text-ink-3">({WORK_ROLE_HINT[role]})</span>
              {undecided && require && <span className="ml-1 font-normal text-warn-ink">担当者か「なし」を選んでください</span>}
            </legend>
            <div className="mt-1 space-y-1">
              <div className="flex flex-wrap items-center gap-1">
                <label className={`${chip} border-dashed`}>
                  <input type="checkbox" name={`workStaff.${role}.none`} value="1" checked={none} onChange={(e) => setNone(role, e.target.checked)} className="h-3.5 w-3.5" />
                  なし
                </label>
              </div>
              {people(role, primary)}
              {others.length > 0 && (
                <details open={otherPicked} className="text-xs">
                  <summary className="cursor-pointer text-[11px] text-accent">ほかの店舗の社員 ({others.reduce((a, g) => a + g.users.length, 0)} 人)</summary>
                  <div className="mt-1 space-y-1">{people(role, others)}</div>
                </details>
              )}
            </div>
          </fieldset>
        );
      })}
    </div>
  );
}
