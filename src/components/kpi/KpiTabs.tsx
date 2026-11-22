import { LinkTabs } from "@/components/ui";
import { canImportData } from "@/lib/auth/permissions";
import type { User } from "@/lib/db/types";

/** KPI 画面のタブ (期間の条件を引き継ぐ)。「取込・照合」は本部スタッフ・管理者だけ */
export function KpiTabs({ current, sp, user }: { current: string; sp: Record<string, string | undefined>; user?: User }) {
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
    ...(user && canImportData(user) ? [{ path: "/kpi/import", label: "スプレッドシートの取込" }] : []),
  ];
  return <LinkTabs current={href(current)} items={items.map((i) => ({ href: href(i.path), label: i.label }))} />;
}
