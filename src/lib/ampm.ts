/**
 * 予定の午前・午後 (お客様のご要望 2026-11-27「■3 予定表の午前・午後の視認性」: 午前に何件・午後に何件かを一目で)
 * 時刻があれば 12:00 より前 = 午前・12:00 から = 午後、時刻がなく午前・午後だけ決めた予定 (slot) はそのまま、どちらもなければ none (時間指定なし)。
 * 日ごとの予定表の帯 (src/lib/day-sheet.ts の bandOf) と同じ分け方。import なし (画面・サーバー・テストで使う)
 */
export type AmPm = "am" | "pm" | "none";

export function ampmOf(e: { startTime?: string; slot?: string }): AmPm {
  if (e.slot === "am" || e.slot === "pm") return e.slot;
  if (e.startTime) return e.startTime < "12:00" ? "am" : "pm";
  return "none";
}

export const AMPM_LABEL: Record<AmPm, string> = { am: "午前", pm: "午後", none: "時間指定なし" };

/** 予定の並びの午前・午後の件数 */
export function ampmCounts(list: { startTime?: string; slot?: string }[]): Record<AmPm, number> {
  const out: Record<AmPm, number> = { am: 0, pm: 0, none: 0 };
  for (const e of list) out[ampmOf(e)] += 1;
  return out;
}
