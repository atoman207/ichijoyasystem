import "server-only";
import type { Database, User } from "@/lib/db/types";
import { canViewStoreFigures } from "@/lib/auth/permissions";
import { toDateKey } from "@/lib/format";
import { runAnalysis, type AnalysisColumn, type AnalysisError, type AnalysisResult, type Cell } from "./analyze";

/**
 * AI アシスタントの予測の道具 (forecast)
 * ------------------------------------------------------------
 * 過去の実績 (analyze と同じ集計・同じ閲覧範囲) から、これからの月の売上・件数などを決まった方法で計算する。
 * AI に数字を推測させないため、計算はすべてここで行い、方法と前提を注記に書く:
 *  - 季節の方法: 前年同月の実績 × 直近 12 か月の伸び (直近 12 か月 ÷ その前の 12 か月。0.5〜1.5 倍に抑える)
 *  - 最近の方法: 直近 3 か月 (終わった月) の平均
 *  - 今月のペース: 今月の今日までの実績 ÷ 経過日数 × 月の日数 (今月だけ。10 日以上たってから使う)
 *  - 受注残 (売上だけ): 施工予定の受注 (契約済み・日程確定・施工中で売上計上日のないもの) の金額を、施工の終わりの月で数える
 * 予測 (中心) は季節の方法 (前年同月がなければ最近の方法)。今月はペースとの平均。幅は使えた方法の最小〜最大。
 * 受注残が予測を上回る月は、受注残を下限にする (すでに決まっている工事の分は入る見込みのため)。今月は今日までの実績を下限にする
 */

export type ForecastSubject = "sales" | "inquiries" | "quotes" | "expenses" | "purchases" | "payments";

export interface ForecastOpts {
  subject?: ForecastSubject;
  /** 指標 (analyze の指標の名前。省略 = 売上は sales、ほかは件数か金額) */
  metric?: string;
  /** 何か月先まで (今月を含む。1〜12、既定 3) */
  months?: number;
  stores?: string[];
  categories?: string[];
}

const SUBJECT_LABEL: Record<ForecastSubject, string> = { sales: "売上", inquiries: "問い合わせ", quotes: "見積", expenses: "経費", purchases: "仕入", payments: "入金" };
const DEFAULT_METRIC: Record<ForecastSubject, string> = { sales: "sales", inquiries: "count", quotes: "count", expenses: "amount", purchases: "amount", payments: "amount" };
const BACKLOG_STATUSES = new Set(["confirmed", "scheduled", "in_progress"]);

const ymOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const addMonths = (ym: string, n: number) => {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return ymOf(d);
};
const labelOf = (ym: string) => `${ym.slice(0, 4)}年${ym.slice(5, 7)}月`;
const ymFromLabel = (label: string) => {
  const m = /^(\d{4})年(\d{2})月$/.exec(label);
  return m ? `${m[1]}-${m[2]}` : undefined;
};
const daysIn = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m, 0).getDate();
};
const lastDay = (ym: string) => `${ym}-${String(daysIn(ym)).padStart(2, "0")}`;

export function forecast(db: Database, user: User, opts: ForecastOpts, now = new Date()): AnalysisResult | AnalysisError {
  const subject: ForecastSubject = opts.subject && opts.subject in SUBJECT_LABEL ? opts.subject : "sales";
  // 今月だけの予測を「来月」と取り違えないよう、少なくとも今月と来月を出す (表の行に「(今月)」「(来月)」と書く)
  const months = Math.min(12, Math.max(2, Math.round(opts.months ?? 3)));
  const today = toDateKey(now);
  const cur = today.slice(0, 7);
  const lastDone = addMonths(cur, -1);
  const histFrom = `${addMonths(cur, -36)}-01`;

  // 過去 36 か月 (終わった月) の月別の実績。analyze と同じ集計・閲覧範囲
  const hist = runAnalysis(db, user, { subject, metrics: [opts.metric || DEFAULT_METRIC[subject]], group_by: ["month"], from: histFrom, to: lastDay(lastDone), stores: opts.stores, categories: opts.categories, pivot: false, limit: 200 }, now);
  if (!hist.ok) return hist;
  const valueCol = hist.columns.find((c) => c.kind !== "text");
  if (!valueCol) return { ok: false, error: "予測に使える指標がありません。" };
  const kind = valueCol.kind;
  const byMonth = new Map<string, number>();
  for (const r of hist.rows) {
    const ym = ymFromLabel(String(r.k0 ?? ""));
    if (ym && typeof r[valueCol.key] === "number") byMonth.set(ym, r[valueCol.key] as number);
  }
  if (byMonth.size < 3) return { ok: false, error: `予測には 3 か月以上の実績が要りますが、${SUBJECT_LABEL[subject]}の実績は ${byMonth.size} か月分しかありません。`, hint: "経営ダッシュボードで、これまでの実績を確かめてください。" };
  const first = [...byMonth.keys()].sort()[0];
  // 記録が始まってからの月で、行がない月は 0 (その月の記録がない)。始まる前の月は「データなし」
  const val = (ym: string): number | undefined => (ym < first || ym > lastDone ? undefined : (byMonth.get(ym) ?? 0));

  const sumMonths = (end: string, n: number) => {
    let s = 0;
    for (let i = 0; i < n; i++) {
      const v = val(addMonths(end, -i));
      if (v === undefined) return undefined;
      s += v;
    }
    return s;
  };
  const last12 = sumMonths(lastDone, 12);
  const prev12 = sumMonths(addMonths(lastDone, -12), 12);
  let growth: number | undefined = last12 !== undefined && prev12 ? last12 / prev12 : undefined;
  let clamped = false;
  if (growth !== undefined && (growth < 0.5 || growth > 1.5)) {
    growth = Math.min(1.5, Math.max(0.5, growth));
    clamped = true;
  }
  const recent = [0, 1, 2].map((i) => val(addMonths(lastDone, -i))).filter((v): v is number => v !== undefined);
  const avg3 = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : undefined;

  // 今月の今日までの実績
  const mtd = runAnalysis(db, user, { subject, metrics: [valueCol.key], from: `${cur}-01`, to: today, stores: opts.stores, categories: opts.categories, pivot: false }, now);
  const mtdValue = mtd.ok ? Number(mtd.total[valueCol.key] ?? mtd.rows[0]?.[valueCol.key] ?? 0) : 0;
  const elapsed = Number(today.slice(8, 10));
  const runRate = elapsed >= 10 ? (mtdValue / elapsed) * daysIn(cur) : undefined;

  // 受注残 (売上だけ): 施工予定の受注の金額を、施工の終わり (なければ始まり) の月で数える
  const backlog = new Map<string, { amount: number; count: number }>();
  if (subject === "sales" && (!opts.metric || opts.metric === "sales")) {
    const storeIds = opts.stores?.length ? new Set(db.stores.filter((s) => opts.stores!.some((x) => x === s.id || s.name.includes(x) || (s.shortName ?? "").includes(x))).map((s) => s.id)) : undefined;
    // 受注残の金額は経営の数字 (閲覧の範囲の設定で全社員が全店舗。src/lib/access-policy.ts)
    for (const o of db.orders.filter((x) => canViewStoreFigures(user, x.storeId))) {
      if (!BACKLOG_STATUSES.has(o.status) || o.salesDate) continue;
      if (storeIds && !storeIds.has(o.storeId)) continue;
      if (opts.categories?.length && !opts.categories.some((c) => o.category === c || String(o.category).includes(c))) continue;
      const when = (o.scheduledEnd || o.scheduledStart || "").slice(0, 7);
      if (!when || when < cur) continue;
      const b = backlog.get(when) ?? { amount: 0, count: 0 };
      b.amount += o.total;
      b.count++;
      backlog.set(when, b);
    }
  }

  const round = (v: number | undefined, up = false) => (v === undefined ? null : kind === "yen" ? (up ? Math.ceil(v / 1000) : Math.round(v / 1000)) * 1000 : Math.round(v * 10) / 10);
  const rows: Record<string, Cell>[] = [];
  const targets = Array.from({ length: months }, (_, i) => addMonths(cur, i));
  for (const t of targets) {
    const ly = val(addMonths(t, -12));
    const seasonal = ly !== undefined ? ly * (growth ?? 1) : undefined;
    const methods = [seasonal, avg3, t === cur ? runRate : undefined].filter((v): v is number => v !== undefined);
    let central = seasonal ?? avg3;
    if (t === cur && runRate !== undefined && central !== undefined) central = (central + runRate) / 2;
    const b = backlog.get(t);
    if (central !== undefined && b && b.amount > central) central = b.amount;
    let low = methods.length ? Math.min(...methods, ...(b ? [b.amount] : [])) : undefined;
    let high = methods.length ? Math.max(...methods, ...(b ? [b.amount] : [])) : undefined;
    // 今月は、今日までの実績より少なくはならない (月末までに減ることはないため)
    if (t === cur && central !== undefined) {
      central = Math.max(central, mtdValue);
      low = Math.max(low ?? mtdValue, mtdValue);
      high = Math.max(high ?? mtdValue, mtdValue, central);
    }
    const row: Record<string, Cell> = {
      k0: labelOf(t) + (t === cur ? " (今月)" : t === addMonths(cur, 1) ? " (来月)" : t === addMonths(cur, 2) ? " (再来月)" : ""),
      // 今月は切り上げ (丸めで今日までの実績を下回らないように)
      forecast: round(central, t === cur),
      low: round(low, t === cur),
      high: round(high, t === cur),
      last_year: ly === undefined ? null : Math.round(ly),
      avg3: avg3 === undefined ? null : Math.round(avg3),
    };
    if (t === cur) row.actual_mtd = Math.round(mtdValue);
    if (backlog.size) row.backlog = b ? Math.round(b.amount) : 0;
    rows.push(row);
  }
  const k: AnalysisColumn["kind"] = kind;
  const columns: AnalysisColumn[] = [
    { key: "k0", label: "月", kind: "text" },
    { key: "forecast", label: `予測 (中心)・${valueCol.label}`, kind: k },
    { key: "low", label: "幅 (下)", kind: k },
    { key: "high", label: "幅 (上)", kind: k },
    { key: "last_year", label: "前年同月の実績", kind: k },
    { key: "avg3", label: "直近 3 か月の平均", kind: k },
    { key: "actual_mtd", label: "今月の実績 (今日まで)", kind: k },
    ...(backlog.size ? [{ key: "backlog", label: "受注残 (施工予定の受注)", kind: "yen" as const }] : []),
  ];
  const total: Record<string, Cell> = { k0: "合計" };
  for (const key of ["forecast", "low", "high", "last_year", "backlog"]) {
    const xs = rows.map((r) => r[key]).filter((v): v is number => typeof v === "number");
    if (xs.length) total[key] = xs.reduce((a, b) => a + b, 0);
  }
  const notes = [
    "予測は過去の実績からの推定です (確定した数字ではありません)。天候・キャンペーン・大口の案件・人員の変化は入っていません。",
    `予測 (中心) = 前年同月の実績 × 直近 12 か月の伸び${growth !== undefined ? ` (${(growth * 100).toFixed(1)}%${clamped ? "。極端な値のため 50〜150% に抑えた" : ""})` : " (2 年分の実績がないため伸びは 100% とした)"}。前年同月の実績がない月は直近 3 か月の平均。`,
    runRate !== undefined ? `今月は、今日までのペース (${elapsed} 日で ${Math.round(mtdValue).toLocaleString("ja-JP")}) から月末まで延ばした値との平均。` : "今月はまだ 10 日たっていないため、今日までのペースは使っていません。",
    backlog.size ? "受注残 = 契約済み・日程確定・施工中で、まだ売上に計上していない受注の金額 (施工の終わりの月)。予測より大きい月は受注残を予測にしています。" : "",
    `実績に使った期間: ${labelOf(first > addMonths(cur, -36) ? first : addMonths(cur, -36))}〜${labelOf(lastDone)} (${byMonth.size} か月に記録あり)。${kind === "yen" ? "金額は千円単位に丸めています。" : ""}`,
  ].filter(Boolean);
  return {
    ok: true,
    title: `${SUBJECT_LABEL[subject]}の予測 (${labelOf(cur)}から ${months} か月)`,
    period: { from: `${cur}-01`, to: lastDay(targets[targets.length - 1]), label: `${labelOf(cur)}〜${labelOf(targets[targets.length - 1])} (予測)` },
    spec: { subject, metrics: [valueCol.key], group_by: ["month"], from: `${cur}-01`, to: lastDay(targets[targets.length - 1]), title: `${SUBJECT_LABEL[subject]}の予測` },
    columns: columns.filter((c) => rows.some((r) => r[c.key] !== undefined)),
    rows,
    total,
    omitted: 0,
    notes,
    chart: { kind: "time", x: "k0", series: [{ key: "forecast", label: "予測 (中心)" }, { key: "last_year", label: "前年同月の実績" }], unit: kind === "yen" ? "yen" : kind === "count" ? "count" : "plain" },
  };
}
