import type { StaffChoiceGroup } from "@/lib/staff-choices";

/**
 * 担当者 1 人を選ぶ select の中身 (お客様のご要望 2026-11-27「■2」): 先頭に「なし」、施工店舗の社員 → 本部 → ほかの店舗 を店舗ごとのまとまりで。
 * サーバーの部品・画面の部品のどちらからも使う
 */
export function StaffOptions({ groups, noneLabel = "なし (未定)", mark }: { groups: StaffChoiceGroup[]; noneLabel?: string | false; mark?: Record<string, string> }) {
  return (
    <>
      {noneLabel !== false && <option value="none">{noneLabel}</option>}
      {groups.map((g) => (
        <optgroup key={`${g.storeId}:${g.label}`} label={g.label}>
          {g.users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
              {mark?.[u.id] ?? ""}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );
}
