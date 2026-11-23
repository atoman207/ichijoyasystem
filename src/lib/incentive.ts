import type { Customer, Database, StoreId } from "@/lib/db/types";
import { countedIssue, inPeriod, issueCounts, issuePoints, type IssueCounts, type Period } from "@/lib/kpi-core";
import { kpiBasis, kpiCards, kpiDenominators, personScores, scoreAverage, type Denominators, type KpiBasis } from "@/lib/kpi-basis";
import { isPayable, tierAtLeast, tierAtMost, type KpiSettings } from "@/lib/kpi-settings";

/**
 * 年間インセンティブの計算 (年度 12/1〜11/30、12 月末に現金で支給)
 * ------------------------------------------------------------
 * 「お客様アンケート集計表」KPI シートの評価方法 (2025・2026 年度) をそのまま計算する:
 *  - はがき返信率 (店舗)      → 店舗の職人 1 人あたり (返信率が replyGate 未満の店舗は、はがきの項目を支給しない)
 *  - ① 電話対応 (全社の平均)  → 事務 1 人あたり
 *  - ② 営業対応 (本人の平均)  → 営業担当 (見積り)
 *  - ③ 職人対応 (本人の平均)  → 担当職人 (複数名なら全員に同じ点)
 *  - ④ 工事仕上り (店舗の平均) → 店舗の職人
 *  - クレーム・手直しポイント率 → 店舗の職人 / 事務 (マイナスあり)。クレーム 2 点・手直し 1 点、同じ案件は最大 3 点 (設定 qualityCaseMax)。分母は全案件数
 *  - MVP: ②③ の順位、返信率 1 位・④ 1 位の店舗、口コミ件数の順位、クレーム・手直しの件数最少・率最低
 *  - 合計がマイナスの人は 0 (マイナスにはならない)
 * 順位は同点を同じ順位にし、次の順位を飛ばす (2 位が 2 人なら 3 位はなし)。
 * 年度の途中で店舗を移った社員の月割りは自動では行わない (調整額で入力する)。
 * 分母 (個人件数・全案件数)・はがきの数え方・平均の計算は KPI の画面と同じ (src/lib/kpi-basis.ts。シートの基準が既定)
 */

export const SCORED_STORES: StoreId[] = ["koshi", "chuo", "nishi", "tamana"];

export interface UnitResult {
  unit: StoreId | "office";
  /** 全案件数 (ポイント率の分母) */
  orders: number;
  /** 個人件数 (返信率の分母) */
  individual: number;
  cards: number;
  /** ④ の平均の分母 (シートの基準ははがきの枚数) */
  finishCount: number;
  replyRate: number | null;
  finishAvg: number | null;
  /** ポイント (同じ案件は上限まで) */
  qualityPoints: number;
  /** 上限を当てる前のポイント */
  qualityPointsRaw: number;
  qualityCount: number;
  qualityRate: number | null;
  /** 経営管理の指標の件数 (クレーム・手直し・合計・発生した案件) */
  issues: IssueCounts;
  /** 返信率が基準未満 (はがきの項目を支給しない) */
  gated: boolean;
  /** 分母の内訳 (事務は 4 店舗の全案件数の合計のため空) */
  denominators?: Denominators;
}

export interface IncentiveLine {
  key: string;
  label: string;
  yen: number;
  note?: string;
}

export interface PersonIncentive {
  userId: string;
  role: "craftsman" | "clerk" | "other";
  storeId: StoreId;
  lines: IncentiveLine[];
  subtotal: number;
  adjust: number;
  adjustNote?: string;
  total: number;
  salesAvg: number | null;
  salesCount: number;
  craftsmanAvg: number | null;
  craftsmanCount: number;
  reviewCount: number;
  reviewPoints: number;
}

export interface IncentiveResult {
  units: UnitResult[];
  office: UnitResult;
  companyPhoneAvg: number | null;
  /** ① の平均の分母 (シートの基準ははがきの枚数) */
  companyPhoneCount: number;
  people: PersonIncentive[];
  total: number;
  basis: KpiBasis;
}

export type Adjustments = Record<string, { amount: number; note?: string }>;

/** 競技の順位 (同点は同じ順位。次の順位は飛ばす)。value が大きいほど上位 (asc = true なら小さいほど上位) */
export function competitionRanks<T>(items: T[], value: (t: T) => number | null, asc = false): Map<T, number> {
  const valid = items.filter((t) => value(t) !== null);
  const ranks = new Map<T, number>();
  for (const t of valid) {
    const v = value(t)!;
    const better = valid.filter((o) => (asc ? value(o)! < v - 1e-9 : value(o)! > v + 1e-9)).length;
    ranks.set(t, better + 1);
  }
  return ranks;
}

export function computeIncentives(db: Pick<Database, "orders" | "customers" | "surveys" | "qualityIssues" | "reviews" | "users"> & Partial<Pick<Database, "stores" | "settings">>, p: Period | null, s: KpiSettings, adjustments: Adjustments = {}, basisIn?: KpiBasis): IncentiveResult {
  const rules = s.incentive;
  const basis = basisIn ?? kpiBasis(db);
  // 評価する店舗: 店舗 (本部を除く)。管理者が追加した店舗も入る
  const scoredStores: StoreId[] = db.stores?.length ? db.stores.filter((x) => x.kind === "store").map((x) => x.id) : SCORED_STORES;
  const customers = new Map<string, Customer>(db.customers.map((c) => [c.id, c]));
  const cards = kpiCards(db.surveys, p, basis);
  const issues = db.qualityIssues.filter((q) => countedIssue(q) && inPeriod(q.occurredOn, p));
  const caseMax = s.qualityCaseMax;

  const units: UnitResult[] = scoredStores.map((storeId) => {
    const den = kpiDenominators(db, p, storeId, { customers, basis });
    const individual = den.individual.value;
    const sites = den.sites.value;
    const storeCards = cards.filter((c) => c.storeId === storeId);
    const finish = scoreAverage(storeCards.map((c) => c.finishScore), basis.average);
    const mine = issues.filter((q) => q.storeId === storeId && q.attribution !== "office");
    const qp = issuePoints(mine, caseMax);
    const qualityPoints = qp.points;
    const replyRate = individual ? (storeCards.length / individual) * 100 : null;
    return {
      unit: storeId,
      orders: sites,
      individual,
      cards: storeCards.length,
      finishCount: finish.n,
      replyRate,
      finishAvg: finish.avg,
      qualityPoints,
      qualityPointsRaw: qp.raw,
      qualityCount: mine.length,
      qualityRate: sites ? (qualityPoints / sites) * 100 : null,
      issues: issueCounts(mine),
      gated: replyRate !== null && replyRate < rules.replyGate,
      denominators: den,
    };
  });
  // 事務: 分母は 4 店舗の全案件数の合計 (シートの「事務は全件施工件数が分母」)
  const officeIssues = issues.filter((q) => q.attribution === "office");
  const officeOrders = units.reduce((a, u) => a + u.orders, 0);
  const officeQp = issuePoints(officeIssues, caseMax);
  const officePoints = officeQp.points;
  const office: UnitResult = {
    unit: "office",
    orders: officeOrders,
    individual: units.reduce((a, u) => a + u.individual, 0),
    cards: units.reduce((a, u) => a + u.cards, 0),
    finishCount: 0,
    replyRate: null,
    finishAvg: null,
    qualityPoints: officePoints,
    qualityPointsRaw: officeQp.raw,
    qualityCount: officeIssues.length,
    qualityRate: officeOrders ? (officePoints / officeOrders) * 100 : null,
    issues: issueCounts(officeIssues),
    gated: false,
  };
  // ① 電話対応: 全社のはがき (シートは 合計点 ÷ 返信はがきの枚数)
  const phone = scoreAverage(cards.map((c) => c.phoneScore), basis.average);
  const companyPhoneAvg = phone.avg;
  const companyPhoneCount = phone.n;

  // 店舗の順位 (返信率 1 位・④ 1 位・率最低) と、件数最少の単位 (店舗 + 事務)
  const eligible = units.filter((u) => !u.gated);
  const replyRank = competitionRanks(eligible, (u) => u.replyRate);
  const finishRank = competitionRanks(eligible, (u) => u.finishAvg);
  const rateRank = competitionRanks(units, (u) => u.qualityRate, true);
  const fewestRank = competitionRanks([...units, office], (u) => (u.orders ? u.qualityCount : null), true);

  // 対象者: 事務 + 4 店舗の社員 + ②③・口コミの記録がある社員 (除外の社員を除く)
  const payable = db.users.filter((u) => isPayable(u, s));
  const clerkSet = new Set(s.clerkUserIds);
  // ②③: 担当者ごとの行 (2 人目以降の担当の行を含む) の平均 (kpi-basis.ts の personScores)
  const scores = personScores(db.surveys, p, basis);
  const salesOf = (id: string) => scores.get(id)?.sales;
  const craftOf = (id: string) => scores.get(id)?.craft;
  const reviewCounts = new Map<string, { n: number; points: number }>();
  for (const r of db.reviews) {
    if (!inPeriod(r.postedOn, p)) continue;
    const cur = reviewCounts.get(r.userId) ?? { n: 0, points: 0 };
    reviewCounts.set(r.userId, { n: cur.n + 1, points: cur.points + r.points });
  }
  const people = payable.filter((u) => clerkSet.has(u.id) || scoredStores.includes(u.storeId) || (salesOf(u.id)?.n ?? 0) > 0 || (craftOf(u.id)?.n ?? 0) > 0 || reviewCounts.has(u.id));
  const salesAvg = (id: string) => salesOf(id)?.avg ?? null;
  const craftAvg = (id: string) => craftOf(id)?.avg ?? null;
  const salesRank = competitionRanks(people.map((u) => u.id), salesAvg);
  const craftRank = competitionRanks(people.map((u) => u.id), craftAvg);
  const reviewRank = competitionRanks(people.map((u) => u.id), (id) => (reviewCounts.get(id)?.n ? reviewCounts.get(id)!.n : null));
  const prize = (list: number[], rank: number | undefined) => (rank && rank <= list.length ? list[rank - 1] : 0);

  const rows: PersonIncentive[] = people.map((u) => {
    const clerk = clerkSet.has(u.id);
    const unit = !clerk ? units.find((x) => x.unit === u.storeId) : undefined;
    const lines: IncentiveLine[] = [];
    const add = (key: string, label: string, amount: number, note?: string) => lines.push({ key, label, yen: amount, note });
    const gated = Boolean(unit?.gated);
    if (unit) {
      add("reply", "はがき返信率 (店舗)", gated ? 0 : tierAtLeast(unit.replyRate, rules.replyRate), gated ? `返信率 ${unit.replyRate?.toFixed(1)}% が ${rules.replyGate}% 未満のため、はがきの項目はなし` : unit.replyRate === null ? "個人件数なし" : `${unit.replyRate.toFixed(1)}% (${unit.cards} 枚 ÷ 個人件数 ${unit.individual})`);
      add("replyMvp", "返信率 MVP (1 位の店舗)", replyRank.get(unit) === 1 ? rules.mvp.replyTop : 0);
    }
    if (clerk) add("phone", "① 電話対応 (全社)", tierAtLeast(companyPhoneAvg, rules.phone), companyPhoneAvg === null ? "回答なし" : `平均 ${companyPhoneAvg.toFixed(2)}`);
    const sa = salesAvg(u.id);
    if (sa !== null) {
      add("sales", "② 営業対応 (本人)", gated ? 0 : tierAtLeast(sa, rules.score), `平均 ${sa.toFixed(2)} (${salesOf(u.id)!.sum} 点 ÷ ${salesOf(u.id)!.n} 枚)`);
      const r = salesRank.get(u.id);
      add("salesMvp", "② 営業対応 MVP", prize(rules.mvp.sales, r), r ? `${r} 位` : undefined);
    }
    const ca = craftAvg(u.id);
    if (ca !== null) {
      add("craft", "③ 職人対応 (本人)", gated ? 0 : tierAtLeast(ca, rules.score), `平均 ${ca.toFixed(2)} (${craftOf(u.id)!.sum} 点 ÷ ${craftOf(u.id)!.n} 枚)`);
      const r = craftRank.get(u.id);
      add("craftMvp", "③ 職人対応 MVP", prize(rules.mvp.craftsman, r), r ? `${r} 位` : undefined);
    }
    if (unit) {
      add("finish", "④ 工事仕上り (店舗)", gated ? 0 : tierAtLeast(unit.finishAvg, rules.score), unit.finishAvg === null ? "回答なし" : `平均 ${unit.finishAvg.toFixed(2)}`);
      add("finishMvp", "④ 工事仕上り MVP (1 位の店舗)", finishRank.get(unit) === 1 ? rules.mvp.finishTop : 0);
    }
    const rv = reviewCounts.get(u.id);
    if (rv) {
      const r = reviewRank.get(u.id);
      add("reviewMvp", "Google 口コミ件数 MVP", prize(rules.mvp.reviews, r), `${rv.n} 件${r ? ` · ${r} 位` : ""}`);
    }
    const qUnit = clerk ? office : unit;
    if (qUnit) {
      const table = clerk ? rules.officeQuality : rules.storeQuality;
      add("quality", `クレーム・手直しポイント率 (${clerk ? "事務" : "店舗"})`, qUnit.orders ? tierAtMost(qUnit.qualityRate, table) : 0, qUnit.qualityRate === null ? "全案件数なし" : `${qUnit.qualityPoints} 点${qUnit.qualityPointsRaw !== qUnit.qualityPoints ? ` (同じ案件の上限 ${caseMax} 点で ${qUnit.qualityPointsRaw} 点から)` : ""} ÷ 全案件数 ${qUnit.orders} 件 = ${qUnit.qualityRate.toFixed(2)}%`);
      add("fewestMvp", "クレーム・手直し件数 MVP (最少)", fewestRank.get(qUnit) === 1 ? rules.mvp.fewestQuality : 0, `${qUnit.qualityCount} 件`);
      if (!clerk) add("rateMvp", "クレーム・手直し率 MVP (最低の店舗)", rateRank.get(qUnit) === 1 ? rules.mvp.lowestQualityRate : 0);
    }
    const subtotal = lines.reduce((a, l) => a + l.yen, 0);
    const adj = adjustments[u.id];
    const adjust = adj?.amount ?? 0;
    return {
      userId: u.id,
      role: clerk ? "clerk" : unit ? "craftsman" : "other",
      storeId: u.storeId,
      lines,
      subtotal,
      adjust,
      adjustNote: adj?.note,
      total: Math.max(0, subtotal + adjust),
      salesAvg: sa,
      salesCount: salesOf(u.id)?.n ?? 0,
      craftsmanAvg: ca,
      craftsmanCount: craftOf(u.id)?.n ?? 0,
      reviewCount: rv?.n ?? 0,
      reviewPoints: rv?.points ?? 0,
    };
  });
  return { units, office, companyPhoneAvg, companyPhoneCount, people: rows, total: rows.reduce((a, r) => a + r.total, 0), basis };
}
