import type { Customer, Database, GoogleReview, QualityIssue, StoreId, SurveyResponse } from "@/lib/db/types";
import { MEDIA_OPTIONS, PRIORITY_OPTIONS, SCORE_QUESTIONS, tallyAnswers, type ScoreKey } from "@/lib/survey";
import { countedIssue, deliveryOf, inPeriod, issueCounts, issuePoints, periodOrders, surveyKpiDate, type IssueCounts, type Period } from "./kpi-core";
import { kpiBasis, kpiCards, kpiDenominators, personScores, scoreAverage, unnamedCard, type Denominators, type KpiBasis } from "./kpi-basis";
import { qualityCaseMax } from "./kpi-settings";

/**
 * KPI の集計 (アンケート・クレーム・手直し・Google 口コミ)
 * ------------------------------------------------------------
 * 分母と数え方は「お客様アンケート集計表」の KPI シートの基準 (src/lib/kpi-basis.ts。KPI → 分母・照合 で切り替え):
 * - 返信率 = 返信されたはがきの枚数 ÷ 個人件数 × 100 (個人件数 = 年間チラシ計画の本年度実績。値のない月は自動 = 個人のお客様の案件 − 同じお客様・同じ店舗の 30 日以内のリピート)
 * - アンケートの評価 = ①〜④ の平均 (5 段階)。① は全社 (事務)、② は営業担当 (見積り)、③ は担当職人 (複数名なら全員に同じ点)、④ は店舗の評価
 *   (シートと同じく 合計点 ÷ 返信はがきの枚数 = 空欄は 0 点。設定で「回答した枚数で割る」にもできる)
 * - クレーム・手直しポイント率 (インセンティブ) = ポイント ÷ 全案件数 × 100。クレーム 2 点・手直し 1 点、同じ案件は最大 3 点 (kpi-core.ts の issuePoints)
 * - 経営管理の指標 (インセンティブとは別): クレーム発生件数・率、手直し発生件数・率、合計件数・率 (÷ 全案件数。kpi-core.ts の issueCounts)
 * - Google 口コミ = 担当者ごと・月ごとのポイント × 1 ポイントあたりの支給額
 * 案件の日付は 売上計上日 → 完了日 → 契約日 の順に使う。アンケートは 集計月 → はがきの回答日 → 登録日 (surveyKpiDate)
 */

export { countedIssue, countedOrder, deliveryOf, inPeriod, isCard, orderDate, periodOrders, surveyDate, surveyKpiDate, type Period } from "./kpi-core";

const pct = (n: number, d: number): number | null => (d > 0 ? (n / d) * 100 : null);

export interface StoreKpi {
  storeId: StoreId | "all";
  /** 全案件数 (クレーム・手直し率の分母。シートの基準なら案件の件数 = 売上台帳の現場名の行 + 新システムで完了した受注) */
  orders: number;
  /** 個人件数 (返信率の分母。シートの基準なら年間チラシ計画の本年度実績、ない月は自動 = リピートを 1 件) */
  individualOrders: number;
  surveys: number;
  replyRate: number | null;
  scores: Record<ScoreKey, number | null>;
  /** 平均の分母 (シートの基準ははがきの枚数。回答した枚数で割る設定なら回答数) */
  scoreCounts: Record<ScoreKey, number>;
  againYes: number;
  againAnswered: number;
  /** クレーム・手直しのポイント (同じ案件は上限まで。インセンティブと同じ) */
  qualityPoints: number;
  /** 上限を当てる前のポイント (記録の点数の合計) */
  qualityPointsRaw: number;
  qualityRate: number | null;
  /** クレームが発生した案件の数 (以前の「クレーム発生率」) */
  claimCases: number;
  claimRate: number | null;
  /** 記録の区分ごとの件数 (手直し・クレーム・クレーム＋手直し) */
  reworkCount: number;
  claimCount: number;
  claimReworkCount: number;
  /** 経営管理の指標: クレーム・手直し・合計・発生した案件の件数 (実数) */
  issues: IssueCounts;
  /** 同じく割合 (÷ 全案件数 × 100) */
  issueRates: { claims: number | null; reworks: number | null; total: number | null; cases: number | null };
  reviews: number;
  reviewPoints: number;
  /** 担当の名前が未記入のため数えないはがき */
  unnamedCards: number;
  /** 分母の内訳 (どの月が シート の値か) */
  denominators: Denominators;
}

type KpiDb = Pick<Database, "orders" | "customers" | "surveys" | "qualityIssues" | "reviews"> & Partial<Pick<Database, "settings" | "stores">>;

export function storeKpi(db: KpiDb, p: Period | null, storeId?: StoreId, customers?: Map<string, Customer>, basisIn?: KpiBasis): StoreKpi {
  const basis = basisIn ?? kpiBasis(db);
  const cmap = customers ?? new Map(db.customers.map((c) => [c.id, c]));
  const den = kpiDenominators(db, p, storeId, { customers: cmap, basis });
  const surveys = kpiCards(db.surveys, p, basis, storeId);
  const unnamed = db.surveys.filter((s) => (!storeId || s.storeId === storeId) && inPeriod(surveyKpiDate(s), p) && unnamedCard(s, basis)).length;
  // 店舗の行は店舗に付いたポイント (原因が事務のものは事務の単位)。全社は全部
  const issues = db.qualityIssues.filter((q) => countedIssue(q) && (!storeId || (q.storeId === storeId && q.attribution !== "office")) && inPeriod(q.occurredOn, p));
  const reviews = db.reviews.filter((r) => (!storeId || r.storeId === storeId) && inPeriod(r.postedOn, p));
  const avgs = Object.fromEntries(SCORE_QUESTIONS.map((q) => [q.key, scoreAverage(surveys.map((s) => s[q.key]), basis.average)])) as Record<ScoreKey, ReturnType<typeof scoreAverage>>;
  const scores = Object.fromEntries(SCORE_QUESTIONS.map((q) => [q.key, avgs[q.key].avg])) as Record<ScoreKey, number | null>;
  const scoreCounts = Object.fromEntries(SCORE_QUESTIONS.map((q) => [q.key, avgs[q.key].n])) as Record<ScoreKey, number>;
  const qp = issuePoints(issues, qualityCaseMax(db));
  const qualityPoints = qp.points;
  // 案件ごとに 1 件 (案件にひも付いていない記録 = スプレッドシートの取込・LINE の報告は 1 件ずつ)
  const claimCases = new Set(issues.filter((q) => q.kind !== "rework").map((q) => q.orderId ?? `qc:${q.id}`)).size;
  const counts = issueCounts(issues);
  const answered = surveys.filter((s) => /はい|いいえ/.test(s.wouldUseAgain ?? ""));
  const sites = den.sites.value;
  const individual = den.individual.value;
  return {
    storeId: storeId ?? "all",
    orders: sites,
    individualOrders: individual,
    surveys: surveys.length,
    replyRate: pct(surveys.length, individual),
    scores,
    scoreCounts,
    againYes: answered.filter((s) => /はい/.test(s.wouldUseAgain ?? "")).length,
    againAnswered: answered.length,
    qualityPoints,
    qualityPointsRaw: qp.raw,
    qualityRate: pct(qualityPoints, sites),
    claimCases,
    claimRate: pct(claimCases, sites),
    reworkCount: issues.filter((q) => q.kind === "rework").length,
    claimCount: issues.filter((q) => q.kind === "claim").length,
    claimReworkCount: issues.filter((q) => q.kind === "claim_rework").length,
    issues: counts,
    issueRates: { claims: pct(counts.claims, sites), reworks: pct(counts.reworks, sites), total: pct(counts.total, sites), cases: pct(counts.cases, sites) },
    reviews: reviews.length,
    reviewPoints: reviews.reduce((a, r) => a + r.points, 0),
    unnamedCards: unnamed,
    denominators: den,
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

export function staffKpis(db: Pick<Database, "orders" | "surveys" | "qualityIssues" | "reviews" | "users"> & Partial<Pick<Database, "settings">>, p: Period | null, storeId?: StoreId, basisIn?: KpiBasis): StaffKpi[] {
  const basis = basisIn ?? kpiBasis(db);
  const orders = periodOrders(db, p);
  const cards = kpiCards(db.surveys, p, basis);
  const people = personScores(db.surveys, p, basis);
  const issues = db.qualityIssues.filter((q) => countedIssue(q) && inPeriod(q.occurredOn, p));
  const reviews = db.reviews.filter((r) => inPeriod(r.postedOn, p));
  const caseMax = qualityCaseMax(db);
  const rows: StaffKpi[] = [];
  for (const u of db.users) {
    if (storeId && u.storeId !== storeId) continue;
    const asClerk = cards.filter((s) => s.clerkUserId === u.id);
    const phone = scoreAverage(asClerk.map((s) => s.phoneScore), basis.average);
    const ps = people.get(u.id);
    const myOrders = orders.filter((o) => o.workerIds.includes(u.id)).length;
    const myIssues = issues.filter((q) => q.responsibleUserIds.includes(u.id));
    const myReviews = reviews.filter((r) => r.userId === u.id);
    const qualityPoints = issuePoints(myIssues, caseMax).points;
    const deliveryCount = new Set(cards.filter((s) => s.salesUserId === u.id || deliveryOf(s).includes(u.id)).map((s) => s.id)).size;
    if (!u.active && !asClerk.length && !ps && !myIssues.length && !myReviews.length) continue;
    rows.push({
      userId: u.id,
      phoneCount: phone.n,
      phoneAvg: phone.avg,
      salesCount: ps?.sales.n ?? 0,
      salesAvg: ps?.sales.avg ?? null,
      craftsmanCount: ps?.craft.n ?? 0,
      craftsmanAvg: ps?.craft.avg ?? null,
      deliveryCount,
      orders: myOrders,
      qualityCount: myIssues.length,
      qualityPoints,
      qualityRate: pct(qualityPoints, myOrders),
      reworkCount: myIssues.filter((q) => q.kind !== "claim").length,
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

/**
 * ⑤ 重視したこと・⑥ 依頼のきっかけ (複数回答)・⑦ 次回も依頼したいか の件数。
 * 選択肢にない書き方 (移行データの「R」= 以前頼んだことがある・DM・Googleマップ など) は選択肢に読み替え、自由記述は「その他」に数える (survey.ts の tallyAnswers)。
 * respondents = その設問に答えたはがきの枚数 (割合の分母。シートの集計表の多くの表と同じ)
 */
export function answerCounts(cards: SurveyResponse[]): {
  priorities: [string, number][];
  media: [string, number][];
  again: { yes: number; no: number; unknown: number };
  respondents: { priorities: number; media: number; again: number };
  others: { priorities: [string, number][]; media: [string, number][] };
} {
  const pri = new Map<string, number>(PRIORITY_OPTIONS.map((o) => [o, 0]));
  const med = new Map<string, number>(MEDIA_OPTIONS.map((o) => [o, 0]));
  const priOther = new Map<string, number>();
  const medOther = new Map<string, number>();
  let yes = 0;
  let no = 0;
  let unknown = 0;
  let pr = 0;
  let mr = 0;
  for (const s of cards) {
    const p = tallyAnswers(s.priorityList?.length ? s.priorityList : s.priorities, PRIORITY_OPTIONS);
    const m = tallyAnswers(s.mediaList?.length ? s.mediaList : s.media, MEDIA_OPTIONS);
    if (p.options.length) pr++;
    if (m.options.length) mr++;
    for (const x of p.options) pri.set(x, (pri.get(x) ?? 0) + 1);
    for (const x of m.options) med.set(x, (med.get(x) ?? 0) + 1);
    for (const x of p.others) priOther.set(x, (priOther.get(x) ?? 0) + 1);
    for (const x of m.others) medOther.set(x, (medOther.get(x) ?? 0) + 1);
    const again = s.wouldUseAgain ?? "";
    if (/はい/.test(again)) yes++;
    else if (/いいえ/.test(again)) no++;
    else if (/わから/.test(again)) unknown++;
  }
  const sort = (m: Map<string, number>) => [...m.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  return { priorities: sort(pri), media: sort(med), again: { yes, no, unknown }, respondents: { priorities: pr, media: mr, again: yes + no + unknown }, others: { priorities: sort(priOther).slice(0, 20), media: sort(medOther).slice(0, 20) } };
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
    .filter((x) => !q || [x.number, x.description, x.cause ?? "", x.countermeasure ?? "", x.siteName ?? "", x.origin ?? "", x.orderId ? orderNumber(x.orderId) : ""].some((t) => t.includes(q)))
    .sort((a, b) => b.occurredOn.localeCompare(a.occurredOn) || b.number.localeCompare(a.number));
}
