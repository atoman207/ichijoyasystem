import type { Customer, Database, GoogleReview, Order, QualityIssue, StoreId, SurveyResponse } from "@/lib/db/types";
import { MEDIA_OPTIONS, PRIORITY_OPTIONS, SCORE_QUESTIONS, splitAnswers, type ScoreKey } from "@/lib/survey";

/**
 * KPI の集計 (アンケート・クレーム・手直し・Google 口コミ)
 * ------------------------------------------------------------
 * - 返信率 = 返信されたはがきの件数 ÷ 個人のお客様の案件数 × 100 (はがきは個人のお客様にだけ渡す)
 * - アンケートの評価 = ①〜④ の平均 (5 段階)。① は全社 (事務)、② は営業担当 (見積り)、③ は担当職人 (複数名なら全員に同じ点)、④ は店舗の評価
 *   (未回答は平均に含めない。スプレッドシートでは空欄が 0 点として分母に入っていた)
 * - クレーム・手直し率 = クレーム・手直しの合計ポイント ÷ 期間内の総案件数 (個人・業者を問わない) × 100
 * - クレーム発生率 = クレームが発生した案件数 ÷ 期間内の総案件数 × 100 (手直しのみの案件は含めない)
 * - Google 口コミ = 担当者ごと・月ごとのポイント × 1 ポイントあたりの支給額
 * 案件の日付は 売上計上日 → 完了日 → 契約日 の順に使う。アンケートは はがきの回答日 → 登録日
 */

export interface Period {
  from: string;
  to: string;
}

/** はがき 1 枚分の回答か (旧フォームの「2 人目以降の職人」だけの行は、③ の個人評価にだけ使う) */
export const isCard = (s: SurveyResponse): boolean =>
  Boolean(s.postcardNo) || s.source === "capture" || s.source === "manual" || [s.phoneScore, s.salesScore, s.finishScore].some((x) => typeof x === "number");

/** 集計に入れるクレーム・手直し (記録のみのものを除く) */
export const countedIssue = (q: QualityIssue): boolean => q.counted !== false;

export const inPeriod = (date: string | undefined, p: Period | null): boolean => Boolean(date) && (!p || (date! >= p.from && date! <= p.to));

export const orderDate = (o: Pick<Order, "salesDate" | "completedAt" | "contractDate">): string => (o.salesDate ?? o.completedAt?.slice(0, 10) ?? o.contractDate).slice(0, 10);
export const surveyDate = (s: Pick<SurveyResponse, "answeredOn" | "receivedAt">): string => (s.answeredOn ?? s.receivedAt).slice(0, 10);

/** 集計の対象になる案件 (キャンセルを除く) */
export function periodOrders(db: Pick<Database, "orders">, p: Period | null, storeId?: StoreId): Order[] {
  return db.orders.filter((o) => o.status !== "cancelled" && o.status !== "pending_approval" && (!storeId || o.storeId === storeId) && inPeriod(orderDate(o), p));
}

const avg = (xs: (number | undefined)[]): number | null => {
  const v = xs.filter((x): x is number => typeof x === "number");
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const pct = (n: number, d: number): number | null => (d > 0 ? (n / d) * 100 : null);

export interface StoreKpi {
  storeId: StoreId | "all";
  orders: number;
  individualOrders: number;
  surveys: number;
  replyRate: number | null;
  scores: Record<ScoreKey, number | null>;
  scoreCounts: Record<ScoreKey, number>;
  againYes: number;
  againAnswered: number;
  qualityPoints: number;
  qualityRate: number | null;
  claimCases: number;
  claimRate: number | null;
  reworkCount: number;
  claimCount: number;
  claimReworkCount: number;
  reviews: number;
  reviewPoints: number;
}

function customerType(customers: Map<string, Customer>, id: string): Customer["type"] | undefined {
  return customers.get(id)?.type;
}

export function storeKpi(db: Pick<Database, "orders" | "customers" | "surveys" | "qualityIssues" | "reviews">, p: Period | null, storeId?: StoreId, customers?: Map<string, Customer>): StoreKpi {
  const cmap = customers ?? new Map(db.customers.map((c) => [c.id, c]));
  const orders = periodOrders(db, p, storeId);
  const individual = orders.filter((o) => customerType(cmap, o.customerId) !== "corporate").length;
  const surveys = db.surveys.filter((s) => isCard(s) && (!storeId || s.storeId === storeId) && inPeriod(surveyDate(s), p));
  // 店舗の行は店舗に付いたポイント (原因が事務のものは事務の単位)。全社は全部
  const issues = db.qualityIssues.filter((q) => countedIssue(q) && (!storeId || (q.storeId === storeId && q.attribution !== "office")) && inPeriod(q.occurredOn, p));
  const reviews = db.reviews.filter((r) => (!storeId || r.storeId === storeId) && inPeriod(r.postedOn, p));
  const scores = Object.fromEntries(SCORE_QUESTIONS.map((q) => [q.key, avg(surveys.map((s) => s[q.key]))])) as Record<ScoreKey, number | null>;
  const scoreCounts = Object.fromEntries(SCORE_QUESTIONS.map((q) => [q.key, surveys.filter((s) => typeof s[q.key] === "number").length])) as Record<ScoreKey, number>;
  const qualityPoints = issues.reduce((a, q) => a + q.points, 0);
  const claimCases = new Set(issues.filter((q) => q.kind !== "rework").map((q) => q.orderId)).size;
  const answered = surveys.filter((s) => s.wouldUseAgain === "はい" || s.wouldUseAgain === "いいえ" || /はい|いいえ/.test(s.wouldUseAgain ?? ""));
  return {
    storeId: storeId ?? "all",
    orders: orders.length,
    individualOrders: individual,
    surveys: surveys.length,
    replyRate: pct(surveys.length, individual),
    scores,
    scoreCounts,
    againYes: answered.filter((s) => /はい/.test(s.wouldUseAgain ?? "")).length,
    againAnswered: answered.length,
    qualityPoints,
    qualityRate: pct(qualityPoints, orders.length),
    claimCases,
    claimRate: pct(claimCases, orders.length),
    reworkCount: issues.filter((q) => q.kind === "rework").length,
    claimCount: issues.filter((q) => q.kind === "claim").length,
    claimReworkCount: issues.filter((q) => q.kind === "claim_rework").length,
    reviews: reviews.length,
    reviewPoints: reviews.reduce((a, r) => a + r.points, 0),
  };
}

/* ------------------------------------------------------------------ */
/* 社員別                                                               */
/* ------------------------------------------------------------------ */

export interface StaffKpi {
  userId: string;
  /** ① 電話対応 (はがきで事務担当として選ばれた件数・平均。支給は全社の平均で決まる) */
  phoneCount: number;
  phoneAvg: number | null;
  /** ② 営業対応 (営業担当として評価された件数・平均) */
  salesCount: number;
  salesAvg: number | null;
  /** ③ 職人対応 (担当職人として評価された件数・平均) */
  craftsmanCount: number;
  craftsmanAvg: number | null;
  /** ②③ のどちらかで評価された件数 */
  deliveryCount: number;
  /** 担当した案件数 (施工担当として登録された案件) */
  orders: number;
  /** クレーム・手直し (担当者として登録された件数・ポイント) */
  qualityCount: number;
  qualityPoints: number;
  qualityRate: number | null;
  reworkCount: number;
  claimCount: number;
  /** Google 口コミ */
  reviews: number;
  reviewPoints: number;
}

/** 担当職人 (③ の評価対象。複数のことがある)。移行データは担当職人の 1 人 */
export function deliveryOf(s: Pick<SurveyResponse, "deliveryUserIds" | "craftsmanUserId">): string[] {
  if (s.deliveryUserIds && s.deliveryUserIds.length) return s.deliveryUserIds;
  return s.craftsmanUserId ? [s.craftsmanUserId] : [];
}

export function staffKpis(db: Pick<Database, "orders" | "surveys" | "qualityIssues" | "reviews" | "users">, p: Period | null, storeId?: StoreId): StaffKpi[] {
  const orders = periodOrders(db, p);
  const surveys = db.surveys.filter((s) => inPeriod(surveyDate(s), p));
  const cards = surveys.filter(isCard);
  const issues = db.qualityIssues.filter((q) => countedIssue(q) && inPeriod(q.occurredOn, p));
  const reviews = db.reviews.filter((r) => inPeriod(r.postedOn, p));
  const rows: StaffKpi[] = [];
  for (const u of db.users) {
    if (storeId && u.storeId !== storeId) continue;
    const asClerk = cards.filter((s) => s.clerkUserId === u.id);
    const asSales = cards.filter((s) => s.salesUserId === u.id);
    const asCraft = surveys.filter((s) => deliveryOf(s).includes(u.id));
    const asDelivery = [...new Set([...asSales, ...asCraft])];
    const myOrders = orders.filter((o) => o.workerIds.includes(u.id)).length;
    const myIssues = issues.filter((q) => q.responsibleUserIds.includes(u.id));
    const myReviews = reviews.filter((r) => r.userId === u.id);
    const qualityPoints = myIssues.reduce((a, q) => a + q.points, 0);
    if (!u.active && !asClerk.length && !asDelivery.length && !myIssues.length && !myReviews.length) continue;
    rows.push({
      userId: u.id,
      phoneCount: asClerk.filter((s) => typeof s.phoneScore === "number").length,
      phoneAvg: avg(asClerk.map((s) => s.phoneScore)),
      salesCount: asSales.filter((s) => typeof s.salesScore === "number").length,
      salesAvg: avg(asSales.map((s) => s.salesScore)),
      craftsmanCount: asCraft.filter((s) => typeof s.craftsmanScore === "number").length,
      craftsmanAvg: avg(asCraft.map((s) => s.craftsmanScore)),
      deliveryCount: asDelivery.length,
      orders: myOrders,
      qualityCount: myIssues.length,
      qualityPoints,
      qualityRate: pct(qualityPoints, myOrders),
      reworkCount: myIssues.filter((q) => q.kind === "rework").length,
      claimCount: myIssues.filter((q) => q.kind !== "rework").length,
      reviews: myReviews.length,
      reviewPoints: myReviews.reduce((a, r) => a + r.points, 0),
    });
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/* ⑤⑥⑦ の集計 (インセンティブとは別)                                     */
/* ------------------------------------------------------------------ */

export function answerCounts(all: SurveyResponse[]): { priorities: [string, number][]; media: [string, number][]; again: { yes: number; no: number } } {
  const pri = new Map<string, number>(PRIORITY_OPTIONS.map((o) => [o, 0]));
  const med = new Map<string, number>(MEDIA_OPTIONS.map((o) => [o, 0]));
  let yes = 0;
  let no = 0;
  for (const s of all.filter(isCard)) {
    const p = s.priorityList?.length ? s.priorityList : splitAnswers(s.priorities, PRIORITY_OPTIONS);
    const m = s.mediaList?.length ? s.mediaList : splitAnswers(s.media, MEDIA_OPTIONS);
    for (const x of new Set(p)) pri.set(x, (pri.get(x) ?? 0) + 1);
    for (const x of new Set(m)) med.set(x, (med.get(x) ?? 0) + 1);
    if (/はい/.test(s.wouldUseAgain ?? "")) yes++;
    else if (/いいえ/.test(s.wouldUseAgain ?? "")) no++;
  }
  const sort = (m: Map<string, number>) => [...m.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  return { priorities: sort(pri), media: sort(med), again: { yes, no } };
}

/* ------------------------------------------------------------------ */
/* Google 口コミ (月ごと)                                                */
/* ------------------------------------------------------------------ */

export interface ReviewMonthRow {
  month: string;
  userId: string;
  storeId: StoreId;
  count: number;
  points: number;
  yen: number;
  /** 支給日 (翌月末) */
  payOn: string;
}

export function monthEnd(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(last).padStart(2, "0")}`;
}

export function nextMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

export function reviewMonths(reviews: GoogleReview[], yenPerPoint: number, p: Period | null): ReviewMonthRow[] {
  const map = new Map<string, ReviewMonthRow>();
  for (const r of reviews) {
    if (!inPeriod(r.postedOn, p)) continue;
    const month = r.postedOn.slice(0, 7);
    const key = `${month}|${r.userId}`;
    const row = map.get(key) ?? { month, userId: r.userId, storeId: r.storeId, count: 0, points: 0, yen: 0, payOn: monthEnd(nextMonth(month)) };
    row.count++;
    row.points += r.points;
    row.yen = Math.round(row.points * yenPerPoint);
    map.set(key, row);
  }
  return [...map.values()].sort((a, b) => b.month.localeCompare(a.month) || b.points - a.points);
}

/* ------------------------------------------------------------------ */

export const fmtRate = (v: number | null, digits = 1): string => (v === null ? "-" : `${v.toFixed(digits)}%`);
export const fmtScore = (v: number | null): string => (v === null ? "-" : v.toFixed(2));

/** クレーム・手直しの件数を店舗・担当者・期間で絞り込む (一覧用) */
export function filterIssues(issues: QualityIssue[], f: { storeId?: string; userId?: string; kind?: string; status?: string; p: Period | null; q?: string }, orderNumber: (id: string) => string): QualityIssue[] {
  const q = f.q?.trim();
  return issues
    .filter((x) => (!f.storeId || x.storeId === f.storeId) && (!f.userId || x.responsibleUserIds.includes(f.userId)) && (!f.kind || x.kind === f.kind) && (!f.status || x.status === f.status) && inPeriod(x.occurredOn, f.p))
    .filter((x) => !q || [x.number, x.description, x.cause ?? "", x.countermeasure ?? "", orderNumber(x.orderId)].some((t) => t.includes(q)))
    .sort((a, b) => b.occurredOn.localeCompare(a.occurredOn) || b.number.localeCompare(a.number));
}
