import { QUALITY_JUDGE_GUIDE, QUALITY_KIND_HELP, QUALITY_KIND_LABEL } from "@/lib/kpi-settings";

/** クレーム・手直しの区分の判定の目安 (登録・更新のフォームの下に出す) */
export function QualityGuide() {
  return (
    <details className="rounded-lg border border-line bg-subtle/50 px-3 py-2 text-xs text-ink-2">
      <summary className="cursor-pointer font-medium text-ink">区分の判定の目安 (クレーム・手直し・点検)</summary>
      <ul className="mt-2 space-y-1.5">
        {(["claim", "rework", "claim_rework"] as const).map((k) => (
          <li key={k}><span className="font-medium text-ink">{QUALITY_KIND_LABEL[k]}</span>: {QUALITY_KIND_HELP[k]}</li>
        ))}
        {QUALITY_JUDGE_GUIDE.map((g) => (
          <li key={g.label}><span className="font-medium text-ink">{g.label}</span>: {g.text}</li>
        ))}
        <li className="text-ink-3">判断に迷うときは社長に相談してください。ポイントは原因で決めます (事務が原因 = 事務、店舗が原因 = 店舗、見積りが原因 = 売上の付く店舗)。</li>
      </ul>
    </details>
  );
}
