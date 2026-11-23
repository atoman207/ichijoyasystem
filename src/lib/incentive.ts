import type { Customer, Database, StoreId } from "@/lib/db/types";
import { countedIssue, deliveryOf, inPeriod, isCard, periodOrders, surveyDate, type Period } from "@/lib/kpi";
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
 *  - クレーム・手直しポイント率 → 店舗の職人 / 事務 (マイナスあり)
 *  - MVP: ②③ の順位、返信率 1 位・④ 1 位の店舗、口コミ件数の順位、クレーム・手直しの件数最少・率最低
 *  - 合計がマイナスの人は 0 (マイナスにはならない)
 * 順位は同点を同じ順位にし、次の順位を飛ばす (2 位が 2 人なら 3 位はなし)。
 * 年度の途中で店舗を移った社員の月割りは自動では行わない (調整額で入力する)
 */

export const SCORED_STORES: StoreId[] = ["koshi", "chuo", "nishi", "tamana"];

export interface UnitResult {
  unit: StoreId | "office";
  orders: number;
  individual: number;
  cards: number;
  replyRate: number | null;
  finishAvg: number | null;
  qualityPoints: number;
  qualityCount: number;
  qualityRate: number | null;
  /** 返信率が基準未満 (はがきの項目を支給しない) */
  gated: boolean;
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
  companyPhoneCount: number;
  people: PersonIncentive[];
  total: number;
}

export type Adjustments = Record<string, { amount: number; note?: string }>;

const avg = (xs: (number | undefined)[]): number | null => {
  const v = xs.filter((x): x is number => typeof x === "number");
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

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

export function computeIncentives(db: Pick<Database, "orders" | "customers" | "surveys" | "qualityIssues" | "reviews" | "users"> & Partial<Pick<Database, "stores">>, p: Period | null, s: KpiSettings, adjustments: Adjustments = {}): IncentiveResult {
  const rules = s.incentive;
  // 評価する店舗: 店舗 (本部を除く)。管理者が追加した店舗も入る
  const scoredStores: StoreId[] = db.stores?.length ? db.stores.filter((x) => x.kind === "store").map((x) => x.id) : SCORED_STORES;
  const customers = new Map<string, Customer>(db.customers.map((c) => [c.id, c]));
  const cards = db.surveys.filter((x) => isCard(x) && inPeriod(surveyDate(x), p));
  const allSurveys = db.surveys.filter((x) => inPeriod(surveyDate(x), p));
  const issues = db.qualityIssues.filter((q) => countedIssue(q) && inPeriod(q.occurredOn, p));

  const units: UnitResult[] = scoredStores.map((storeId) => {
    const orders = periodOrders(db, p, storeId);
    const individual = orders.filter((o) => customers.get(o.customerId)?.type !== "corporate").length;
    const storeCards = cards.filter((c) => c.storeId === storeId);
    const mine = issues.filter((q) => q.storeId === storeId && q.attribution !== "office");
    const qualityPoints = mine.reduce((a, q) => a + q.points, 0);
    const replyRate = individual ? (storeCards.length / individual) * 100 : null;
    return {
      unit: storeId,
      orders: orders.length,
      individual,
      cards: storeCards.length,
      replyRate,
      finishAvg: avg(storeCards.map((c) => c.finishScore)),
      qualityPoints,
      qualityCount: mine.length,
      qualityRate: orders.length ? (qualityPoints / orders.length) * 100 : null,
      gated: replyRate !== null && replyRate < rules.replyGate,
    };
  });
  const officeIssues = issues.filter((q) => q.attribution === "office");
  const officeOrders = units.reduce((a, u) => a + u.orders, 0);
  const officePoints = officeIssues.reduce((a, q) => a + q.points, 0);
  const office: UnitResult = {
    unit: "office",
    orders: officeOrders,
    individual: units.reduce((a, u) => a + u.individual, 0),
    cards: units.reduce((a, u) => a + u.cards, 0),
    replyRate: null,
    finishAvg: null,
    qualityPoints: officePoints,
    qualityCount: officeIssues.length,
    qualityRate: officeOrders ? (officePoints / officeOrders) * 100 : null,
    gated: false,
  };
  const companyPhoneAvg = avg(cards.map((c) => c.phoneScore));
  const companyPhoneCount = cards.filter((c) => typeof c.phoneScore === "number").length;

  // 店舗の順位 (返信率 1 位・④ 1 位・率最低) と、件数最少の単位 (店舗 + 事務)
  const eligible = units.filter((u) => !u.gated);
  const replyRank = competitionRanks(eligible, (u) => u.replyRate);
  const finishRank = competitionRanks(eligible, (u) => u.finishAvg);
  const rateRank = competitionRanks(units, (u) => u.qualityRate, true);
  const fewestRank = competitionRanks([...units, office], (u) => (u.orders ? u.qualityCount : null), true);

  // 対象者: 事務 + 4 店舗の社員 + ②③・口コミの記録がある社員 (除外の社員を除く)
  const payable = db.users.filter((u) => isPayable(u, s));
  const clerkSet = new Set(s.clerkUserIds);
  const salesCards = new Map<string, number[]>();
  for (const c of cards) if (c.salesUserId && typeof c.salesScore === "number") salesCards.set(c.salesUserId, [...(salesCards.get(c.salesUserId) ?? []), c.salesScore]);
  const craftScores = new Map<string, number[]>();
  for (const c of allSurveys) {
    if (typeof c.craftsmanScore !== "number") continue;
    for (const id of deliveryOf(c)) craftScores.set(id, [...(craftScores.get(id) ?? []), c.craftsmanScore]);
  }
  const reviewCounts = new Map<string, { n: number; points: number }>();
  for (const r of db.reviews) {
    if (!inPeriod(r.postedOn, p)) continue;
    const cur = reviewCounts.get(r.userId) ?? { n: 0, points: 0 };
    reviewCounts.set(r.userId, { n: cur.n + 1, points: cur.points + r.points });
  }
  const people = payable.filter((u) => clerkSet.has(u.id) || scoredStores.includes(u.storeId) || salesCards.has(u.id) || craftScores.has(u.id) || reviewCounts.has(u.id));
  const salesAvg = (id: string) => avg(salesCards.get(id) ?? []);
  const craftAvg = (id: string) => avg(craftScores.get(id) ?? []);
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
      add("reply", "はがき返信率 (店舗)", gated ? 0 : tierAtLeast(unit.replyRate, rules.replyRate), gated ? `返信率 ${unit.replyRate?.toFixed(1)}% が ${rules.replyGate}% 未満のため、はがきの項目はなし` : unit.replyRate === null ? "個人の案件なし" : `${unit.replyRate.toFixed(1)}%`);
      add("replyMvp", "返信率 MVP (1 位の店舗)", replyRank.get(unit) === 1 ? rules.mvp.replyTop : 0);
    }
    if (clerk) add("phone", "① 電話対応 (全社)", tierAtLeast(companyPhoneAvg, rules.phone), companyPhoneAvg === null ? "回答なし" : `平均 ${companyPhoneAvg.toFixed(2)}`);
    const sa = salesAvg(u.id);
    if (sa !== null) {
      add("sales", "② 営業対応 (本人)", gated ? 0 : tierAtLeast(sa, rules.score), `平均 ${sa.toFixed(2)} (${salesCards.get(u.id)!.length} 件)`);
      const r = salesRank.get(u.id);
      add("salesMvp", "② 営業対応 MVP", prize(rules.mvp.sales, r), r ? `${r} 位` : undefined);
    }
    const ca = craftAvg(u.id);
    if (ca !== null) {
      add("craft", "③ 職人対応 (本人)", gated ? 0 : tierAtLeast(ca, rules.score), `平均 ${ca.toFixed(2)} (${craftScores.get(u.id)!.length} 件)`);
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
      add("quality", `クレーム・手直しポイント率 (${clerk ? "事務" : "店舗"})`, qUnit.orders ? tierAtMost(qUnit.qualityRate, table) : 0, qUnit.qualityRate === null ? "案件なし" : `${qUnit.qualityPoints} 点 ÷ ${qUnit.orders} 件 = ${qUnit.qualityRate.toFixed(2)}%`);
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
      salesCount: salesCards.get(u.id)?.length ?? 0,
      craftsmanAvg: ca,
      craftsmanCount: craftScores.get(u.id)?.length ?? 0,
      reviewCount: rv?.n ?? 0,
      reviewPoints: rv?.points ?? 0,
    };
  });
  return { units, office, companyPhoneAvg, companyPhoneCount, people: rows, total: rows.reduce((a, r) => a + r.total, 0) };
}
