import type { Period } from "@/lib/kpi";
import { fiscalRange, fiscalYearOf } from "@/lib/kpi-settings";

/**
 * KPI 画面の集計期間 (URL の検索条件から決める)
 *   ?period=all          → 累計 (全期間)
 *   ?fy=2026             → 2026 年度 (12 月始まりなら 2025-12-01〜2026-11-30)
 *   ?month=2026-10       → その月 (Google 口コミの月次集計など)
 *   ?from=…&to=…         → 任意の期間
 *   指定なし             → 今年度
 */
export interface ResolvedPeriod {
  period: Period | null;
  label: string;
  /** 選択中の値 (期間の選択欄の value) */
  value: string;
  fy: number | null;
}

const isDate = (v: string | undefined): v is string => Boolean(v && /^\d{4}-\d{2}-\d{2}$/.test(v));

export function resolvePeriod(input: Record<string, string | undefined>, startMonth: number, today: string): ResolvedPeriod {
  // 期間の選択欄 (?p=fy:2026 / all / month:2026-10) を、ほかの書き方にそろえる
  const sp = { ...input };
  if (sp.p === "all") sp.period = "all";
  else if (sp.p?.startsWith("fy:")) sp.fy = sp.p.slice(3);
  else if (sp.p?.startsWith("month:")) sp.month = sp.p.slice(6);
  if (sp.period === "all") return { period: null, label: "累計 (全期間)", value: "all", fy: null };
  if (sp.month && /^\d{4}-\d{2}$/.test(sp.month)) {
    const [y, m] = sp.month.split("-").map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { period: { from: `${sp.month}-01`, to: `${sp.month}-${String(last).padStart(2, "0")}` }, label: `${y}年${m}月`, value: `month:${sp.month}`, fy: null };
  }
  if (isDate(sp.from) && isDate(sp.to) && sp.from <= sp.to) return { period: { from: sp.from, to: sp.to }, label: `${sp.from}〜${sp.to}`, value: "custom", fy: null };
  const fy = sp.fy && /^\d{4}$/.test(sp.fy) ? Number(sp.fy) : fiscalYearOf(today, startMonth);
  const r = fiscalRange(fy, startMonth);
  return { period: r, label: `${fy}年度 (${r.from.replace(/-/g, "/")}〜${r.to.replace(/-/g, "/")})`, value: `fy:${fy}`, fy };
}

/** 期間の選択肢 (今年度から過去 years 年度 + 累計) */
export function periodOptions(startMonth: number, today: string, years = 4): { value: string; label: string; query: string }[] {
  const cur = fiscalYearOf(today, startMonth);
  const out: { value: string; label: string; query: string }[] = [];
  for (let fy = cur; fy > cur - years; fy--) {
    const r = fiscalRange(fy, startMonth);
    out.push({ value: `fy:${fy}`, label: `${fy}年度 (${r.from.slice(0, 7).replace("-", "/")}〜${r.to.slice(0, 7).replace("-", "/")})${fy === cur ? " ・今年度" : ""}`, query: `fy=${fy}` });
  }
  out.push({ value: "all", label: "累計 (全期間)", query: "period=all" });
  return out;
}
