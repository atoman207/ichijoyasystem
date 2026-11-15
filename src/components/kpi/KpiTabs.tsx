import { LinkTabs } from "@/components/ui";

/** KPI 画面のタブ (期間の条件を引き継ぐ) */
export function KpiTabs({ current, sp }: { current: string; sp: Record<string, string | undefined> }) {
  const keep = new URLSearchParams();
  for (const k of ["p", "fy", "period", "from", "to"]) if (sp[k]) keep.set(k, sp[k]!);
  const q = keep.toString();
  const href = (path: string) => (q ? `${path}?${q}` : path);
  const items = [
    { path: "/kpi", label: "概要" },
    { path: "/kpi/surveys", label: "アンケート" },
    { path: "/kpi/voice", label: "お客様の声" },
    { path: "/kpi/quality", label: "クレーム・手直し" },
    { path: "/kpi/reviews", label: "Google 口コミ" },
    { path: "/kpi/incentives", label: "インセンティブ" },
  ];
  return <LinkTabs current={href(current)} items={items.map((i) => ({ href: href(i.path), label: i.label }))} />;
}
