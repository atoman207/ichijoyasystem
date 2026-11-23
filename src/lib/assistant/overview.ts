import "server-only";
import type { Database, StoreId, User } from "@/lib/db/types";
import { canApprove, canSeeAllStoreFigures, canViewExpense } from "@/lib/auth/permissions";
import { growth, managementReport, visibleStores } from "@/lib/management";
import { storeKpi } from "@/lib/kpi";
import { qualityCaseMax } from "@/lib/kpi-settings";
import { SCORE_QUESTIONS } from "@/lib/survey";
import { APPROVAL_TYPE_LABEL, SCHEDULE_KIND } from "@/lib/constants";
import { addDays, fmtMonth, toDateKey, yen } from "@/lib/format";

/**
 * 会社 (または店舗) の全体像 (AI アシスタントの道具 business_overview)
 * ------------------------------------------------------------
 * 売上・受注・問い合わせ・見積・施工・請求・入金・未入金・畳原価・経費・仕入・簡易粗利・前年同期 (経営ダッシュボードと同じ managementReport)、
 * 店舗別・月別・種別・受付経路・担当者、お客様アンケート・クレーム・口コミ (KPI と同じ storeKpi)、
 * いま対応が要るもの (承認待ち・未対応の問い合わせ・期日超過・今後 7 日の予定) を 1 回でまとめる。
 * 「今の状況は？」「今年はどう？」「店舗の比較と課題は？」のような広い質問の出発点にする。閲覧範囲は画面と同じ
 */

const pct = (v: number | null | undefined) => (v === null || v === undefined || Number.isNaN(v) ? "-" : `${(v * 100).toFixed(1)}%`);
const num = (v: number | null | undefined, d = 2) => (v === null || v === undefined ? "-" : v.toFixed(d));

export function businessOverview(db: Database, user: User, opts: { from?: string; to?: string; store?: string }, now = new Date()): string {
  const today = toDateKey(now);
  const from = opts.from && /^\d{4}-\d{2}-\d{2}$/.test(opts.from) ? opts.from : `${today.slice(0, 4)}-01-01`;
  const to = opts.to && /^\d{4}-\d{2}-\d{2}$/.test(opts.to) ? opts.to : today;
  const allowed = visibleStores(db, user);
  const store = opts.store ? db.stores.find((s) => allowed.includes(s.id) && (s.id === opts.store || s.name.includes(opts.store!) || opts.store!.includes(s.shortName))) : undefined;
  const r = managementReport(db, user, { from, to, storeId: store?.id }, now);
  const t = r.totals;
  const scope = store ? store.name : canSeeAllStoreFigures(user) ? "全社" : (db.stores.find((s) => s.id === user.storeId)?.name ?? "自店舗");
  const L: string[] = [];
  L.push(`# ${scope} の全体像 (期間 ${from}〜${to}。今日 ${today})`);
  L.push("※ 数字は経営ダッシュボード・KPI の画面と同じ集計。売上 = 売上計上日 (施工完了) ベース・税込");
  L.push("");
  L.push("## 業績");
  const prev = r.previous.totals;
  const base = r.previous.base;
  const vs = (cur: number, before: number) => (growth(cur, before) === null ? "前年同期の記録なし" : `前年同期 ${yen(before)}・前年比 ${growth(cur, before)! >= 0 ? "+" : ""}${pct(growth(cur, before))}`);
  L.push(`- 売上 ${yen(t.sales)} (${t.salesCount} 件・1 件あたり ${yen(t.salesCount ? t.sales / t.salesCount : 0)}) / ${vs(base.sales, prev.sales)} (前年同期 = ${r.previous.label})`);
  if (t.importedSalesCount) L.push(`  - うち販売管理ソフトから移行した売上 ${yen(t.importedSales)} (${t.importedSalesCount} 件。契約日 = 売上計上日・見積と請求書の記録なし)`);
  L.push(`- 受注 (契約日) ${yen(t.orderAmount)} (${t.orderCount} 件) / ${vs(base.orderAmount, prev.orderAmount)}`);
  L.push(`- 問い合わせ ${t.inquiries} 件 → 見積 ${t.quotes} 件 → 受注 (システムで登録) ${t.funnelOrders} 件${t.importedOrderCount ? ` (移行データの受注 ${t.importedOrderCount} 件は見積とつながっていないので含めない)` : ""} / 施工完了 ${t.jobsCompleted} 件`);
  L.push(`- 請求 ${yen(t.invoiced)} (${t.invoiceCount} 件) / 入金 ${yen(t.received)}${t.invoiceCount === 0 && t.importedSalesCount ? " (移行データには請求書・入金の記録がない)" : ""}`);
  L.push(`- 畳原価 ${yen(t.tatamiCost)} / 仕入 ${t.purchaseCount ? yen(t.purchases) : "記録なし"} / 経費 (承認済・精算済) ${t.expenseCount ? yen(t.expenses) : "記録なし"}${t.expensesPending ? ` / 承認待ち ${yen(t.expensesPending)}` : ""} / 簡易粗利 (売上−畳原価−仕入−経費) ${yen(t.gross)} (売上比 ${pct(t.sales ? t.gross / t.sales : null)})${t.purchaseCount + t.expenseCount === 0 ? " ※仕入・経費の記録がまだないため畳原価だけを引いた値" : ""}`);
  L.push(`- 未入金残高 (今日時点) ${yen(t.receivables)} / うち期日超過 ${yen(t.overdue)} (${t.overdueCount} 件)`);
  if (r.months.length > 1) {
    L.push("");
    L.push("## 月別の売上");
    L.push(r.months.map((m) => `${fmtMonth(m.month)} ${yen(m.sales)}`).join(" / "));
  }
  if (r.storeRows.length > 1) {
    L.push("");
    L.push("## 店舗別");
    for (const s of r.storeRows) L.push(`- ${s.storeName}: 売上 ${yen(s.sales)} (${s.salesCount} 件・前年比 ${s.salesGrowth === null ? "-" : `${s.salesGrowth >= 0 ? "+" : ""}${pct(s.salesGrowth)}`}) / 受注 ${yen(s.orderAmount)} (${s.orderCount} 件) / 成約率 ${pct(s.winRate)} / 平均単価 ${yen(s.avgOrder)} / 未入金 ${yen(s.receivables)} / 畳原価 ${yen(s.tatamiCost)} / 経費 ${yen(s.expenses)} / 簡易粗利 ${yen(s.gross)}${s.allocation ? ` / 内部受注などの配分 ${s.allocation > 0 ? "+" : ""}${yen(s.allocation)} (配分後の売上 ${yen(s.salesAllocated)}・配分後の簡易粗利 ${yen(s.grossAllocated)})` : ""}`);
  }
  if (r.categories.length) {
    L.push("");
    L.push("## 種別の売上");
    L.push(r.categories.slice(0, 8).map((c) => `${c.label} ${yen(c.amount)} (${c.count} 件)`).join(" / "));
  }
  if (r.channels.length) {
    L.push("");
    L.push("## 問い合わせの入口");
    L.push(r.channels.slice(0, 8).map((c) => `${c.label} ${c.count} 件`).join(" / "));
  }
  if (r.pipeline.length) {
    L.push("");
    L.push("## 受注の進み具合 (期間内に契約した、システムで登録した受注の今の状態)");
    L.push(r.pipeline.filter((p) => p.count).map((p) => `${p.label} ${p.count} 件 ${yen(p.amount)}`).join(" / ") || "システムで登録した受注なし");
    if (r.migrated.count) L.push(`移行データ (販売管理ソフトの売上。入金済として移行) ${r.migrated.count} 件 ${yen(r.migrated.amount)} は進み具合に含めない`);
  }
  if (r.staffRows.length) {
    L.push("");
    L.push("## 担当者別 (上位。担当 = 見積の担当者、移行データは担当者欄の 1 番目。施工完了は施工担当)");
    for (const s of [...r.staffRows].sort((a, b) => b.sales - a.sales).slice(0, 8)) L.push(`- ${s.name} (${s.storeName}): 売上 ${yen(s.sales)} / 受注 ${s.orderCount} 件 / 問い合わせ ${s.inquiries} 件 / 見積 ${s.quotes} 件 / 施工完了 ${s.jobsCompleted} 件`);
  }
  // KPI (アンケート・クレーム・口コミ)
  const k = storeKpi(db, { from, to }, store?.id ?? (canSeeAllStoreFigures(user) ? undefined : user.storeId));
  L.push("");
  L.push("## お客様の評価・品質 (KPI と同じ集計)");
  // storeKpi の率は % の値 (49.2 = 49.2%)。pct は割合 (0.492) を % にするため 100 で割って渡す
  const rate = (v: number | null) => pct(v === null ? null : v / 100);
  L.push(`- アンケート ${k.surveys} 枚 (返信率 ${rate(k.replyRate)} = はがき ÷ 個人件数 ${k.individualOrders}。個人件数は約 1 か月以内のリピートを 1 件) / 平均: ${SCORE_QUESTIONS.map((q) => `${q.no}${q.label} ${num(k.scores[q.key])}`).join("・")} / また利用したい ${k.againAnswered ? pct(k.againYes / k.againAnswered) : "-"}`);
  L.push(`- クレーム・手直し (経営管理の指標。÷ 全案件数 ${k.orders}): クレーム ${k.issues.claims} 件 (${rate(k.issueRates.claims)})・手直し ${k.issues.reworks} 件 (${rate(k.issueRates.reworks)})・合計 ${k.issues.total} 件 (${rate(k.issueRates.total)}) / インセンティブのポイント ${k.qualityPoints} 点 (ポイント率 ${rate(k.qualityRate)}。同じ案件は最大 ${qualityCaseMax(db)} 点) / Google 口コミ ${k.reviews} 件`);
  // いま対応が要るもの
  const stores = new Set<StoreId>(store ? [store.id] : allowed);
  const pending = db.approvals.filter((a) => a.status === "pending" && stores.has(a.storeId));
  const mine = pending.filter((a) => canApprove(user, a));
  const openInq = db.inquiries.filter((i) => stores.has(i.storeId) && (i.status === "new" || i.status === "in_progress"));
  const overdueInv = db.invoices.filter((i) => stores.has(i.storeId) && ["issued", "partially_paid", "overdue"].includes(i.status) && i.dueDate < today && i.total > i.paidAmount);
  const upcoming = db.schedule.filter((e) => e.date >= today && e.date <= addDays(today, 7) && (stores.has(e.storeId) || e.companyWide));
  const byKind = new Map<string, number>();
  for (const e of upcoming) byKind.set(SCHEDULE_KIND[e.kind]?.label ?? e.kind, (byKind.get(SCHEDULE_KIND[e.kind]?.label ?? e.kind) ?? 0) + 1);
  const openQuality = db.qualityIssues.filter((q) => stores.has(q.storeId) && q.status === "open");
  const pendingExp = db.expenses.filter((e) => stores.has(e.storeId) && e.status === "pending_approval" && canViewExpense(user, e));
  L.push("");
  L.push("## いま対応が要るもの (今日時点)");
  L.push(`- 承認待ち ${pending.length} 件 (あなたが承認できるもの ${mine.length} 件): ${[...new Set(pending.map((a) => APPROVAL_TYPE_LABEL[a.type]))].join("・") || "なし"}`);
  L.push(`- 未対応・対応中の問い合わせ ${openInq.length} 件 (うち未対応 ${openInq.filter((i) => i.status === "new").length} 件)`);
  L.push(`- 期日超過の請求 ${overdueInv.length} 件 ${yen(overdueInv.reduce((a, i) => a + i.total - i.paidAmount, 0))}`);
  L.push(`- 承認待ちの経費 ${pendingExp.length} 件 ${yen(pendingExp.reduce((a, e) => a + e.amount, 0))} / 対応中のクレーム・手直し ${openQuality.length} 件`);
  L.push(`- 今後 7 日の予定 ${upcoming.length} 件: ${[...byKind].map(([k2, n]) => `${k2} ${n}`).join("・") || "なし"}`);
  return L.join("\n");
}
