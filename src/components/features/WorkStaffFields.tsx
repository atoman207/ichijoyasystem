import type { OrderWorkStaff } from "@/lib/db/types";
import { WORK_ROLES, WORK_ROLE_HINT, WORK_ROLE_LABEL } from "@/lib/work-staff";

/**
 * 作業の担当 (現地見積・引取・納品・施工) を選ぶ欄 (お客様のご要望 2026-11-25「④」。複数名可)。
 * チェックボックスの名前は workStaff.<役割>、送ったことを workStaffSent = 1 で知らせる (src/lib/work-staff.ts の workStaffFromForm)
 */
export function WorkStaffFields({ staff, value }: { staff: { id: string; label: string }[]; value: Pick<OrderWorkStaff, "survey" | "pickup" | "delivery" | "install"> }) {
  return (
    <div className="space-y-2" data-testid="work-staff-fields">
      <input type="hidden" name="workStaffSent" value="1" />
      {WORK_ROLES.map((role) => (
        <fieldset key={role}>
          <legend className="text-xs font-semibold text-ink">
            {WORK_ROLE_LABEL[role]} <span className="font-normal text-ink-3">({WORK_ROLE_HINT[role]})</span>
          </legend>
          <div className="mt-1 flex flex-wrap gap-1">
            {staff.map((u) => (
              <label key={u.id} className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-line bg-panel px-2.5 py-1 text-xs text-ink has-[:checked]:border-accent has-[:checked]:bg-accent-soft has-[:checked]:font-medium has-[:checked]:text-accent-ink">
                <input type="checkbox" name={`workStaff.${role}`} value={u.id} defaultChecked={value[role].includes(u.id)} className="h-3.5 w-3.5" />
                {u.label}
              </label>
            ))}
          </div>
        </fieldset>
      ))}
    </div>
  );
}
