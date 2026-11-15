import { periodOptions } from "@/lib/kpi-period";

/** 集計期間の選択 (GET のフォーム。ほかの絞り込み条件は hidden で引き継ぐ) */
export function PeriodSelect({ action, value, startMonth, today, keep = {}, extra }: { action: string; value: string; startMonth: number; today: string; keep?: Record<string, string | undefined>; extra?: React.ReactNode }) {
  const options = periodOptions(startMonth, today);
  const known = options.some((o) => o.value === value);
  return (
    <form action={action} method="get" className="mb-4 flex flex-wrap items-end gap-2">
      {Object.entries(keep).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null))}
      <label className="block">
        <span className="label">集計期間</span>
        <select name="p" defaultValue={known ? value : options[0].value} className="field h-9 py-1 text-sm">
          {options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </label>
      {extra}
      <button type="submit" className="inline-flex h-9 items-center rounded-lg border border-line bg-panel px-3 text-sm font-medium text-ink hover:bg-subtle">表示</button>
    </form>
  );
}
