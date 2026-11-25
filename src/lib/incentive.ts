import type { Customer, Database, StoreId } from "@/lib/db/types";
import { countedIssue, inPeriod, issueCounts, issuePoints, type IssueCounts, type Period } from "@/lib/kpi-core";
import { kpiBasis, kpiCards, kpiDenominators, personScores, scoreAverage, type Denominators, type KpiBasis } from "@/lib/kpi-basis";
import { isPayable, tierAtLeast, tierAtMost, type KpiSettings } from "@/lib/kpi-settings";
import type { AssignSegment, IncentiveUnit, IncentiveYear } from "@/lib/incentive-year";

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
 *  - 年度の途中で店舗を移った・途中から入った社員は、店舗・事務で決まる項目を月割り (所属ごとの金額 × 月数 ÷ 12。年度の設定 src/lib/incentive-year.ts)
 * 順位は同点を同じ順位にし、次の順位を飛ばす (2 位が 2 人なら 3 位はなし)。
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
  /** 社員 ID か「name:<名前>」(アカウントのない対象者) */
  userId: string;
  /** アカウントのない対象者の名前 */
  name?: string;
  role: "craftsman" | "clerk" | "other";
  /** 主な所属 (月数の一番多い店舗) */
  storeId: StoreId;
  /** 所属の月割り (店舗・事務 × 月数) */
  segments: AssignSegment[];
  /** 月数の合計 (12 未満 = 年度の途中から) */
  months: number;
  /** 所属の項目を月割りした */
  prorated: boolean;
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

/**
 * year = 年度の設定 (src/lib/incentive-year.ts): 所属の月割り (assign) とアカウントのない対象者 (extra)。なし = 今の所属で 12 か月
 */
export function computeIncentives(db: Pick<Database, "orders" | "customers" | "surveys" | "qualityIssues" | "reviews" | "users"> & Partial<Pick<Database, "stores" | "settings">>, p: Period | null, s: KpiSettings, adjustments: Adjustments = {}, basisIn?: KpiBasis, year?: Pick<IncentiveYear, "assign" | "extra">): IncentiveResult {
  const rules = s.incentive;
  const qualityNote = (u: UnitResult) => (u.qualityRate === null ? "全案件数なし" : `${u.qualityPoints} 点${u.qualityPointsRaw !== u.qualityPoints ? ` (同じ案件の上限 ${caseMax} 点で ${u.qualityPointsRaw} 点から)` : ""} ÷ 全案件数 ${u.orders} 件 = ${u.qualityRate.toFixed(2)}%`);
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

  // 対象者: 事務 + 4 店舗の社員 + ②③・口コミの記録がある社員 (除外の社員を除く) + アカウントのない対象者 (年度の設定)
  const payable = db.users.filter((u) => isPayable(u, s));
  const clerkSet = new Set(s.clerkUserIds);
  const assign = year?.assign ?? {};
  const extras = (year?.extra ?? []).filter((e) => !s.excludedUserIds.includes(e.key));
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
  interface Target {
    key: string;
    name?: string;
    storeId: StoreId;
    segments: AssignSegment[];
  }
  const defaultSegments = (key: string, storeId: StoreId | undefined, unit?: IncentiveUnit): AssignSegment[] => {
    if (assign[key]) return assign[key];
    if (unit) return [{ unit, months: 12 }];
    if (clerkSet.has(key)) return [{ unit: "office", months: 12 }];
    return storeId && scoredStores.includes(storeId) ? [{ unit: storeId, months: 12 }] : [];
  };
  const targets: Target[] = [
    ...payable
      // 年度の設定で「対象外」(所属の月割りが空) の社員は入れない (入社前・退職後の年度)
      .filter((u) => !(assign[u.id] && assign[u.id].length === 0))
      .filter((u) => clerkSet.has(u.id) || scoredStores.includes(u.storeId) || assign[u.id]?.length || (salesOf(u.id)?.n ?? 0) > 0 || (craftOf(u.id)?.n ?? 0) > 0 || reviewCounts.has(u.id))
      .map((u) => ({ key: u.id, storeId: u.storeId, segments: defaultSegments(u.id, u.storeId) })),
    ...extras.filter((e) => !payable.some((u) => u.id === e.key) && !(assign[e.key] && assign[e.key].length === 0)).map((e) => ({ key: e.key, name: e.name, storeId: (e.unit === "office" ? "hq" : e.unit) as StoreId, segments: defaultSegments(e.key, undefined, e.unit) })),
  ];
  const keys = targets.map((t) => t.key);
  const salesAvg = (id: string) => salesOf(id)?.avg ?? null;
  const craftAvg = (id: string) => craftOf(id)?.avg ?? null;
  const salesRank = competitionRanks(keys, salesAvg);
  const craftRank = competitionRanks(keys, craftAvg);
  const reviewRank = competitionRanks(keys, (id) => (reviewCounts.get(id)?.n ? reviewCounts.get(id)!.n : null));
  const prize = (list: number[], rank: number | undefined) => (rank && rank <= list.length ? list[rank - 1] : 0);

  // 所属 (店舗・事務) で決まる項目の 1 人あたりの金額 (12 か月分)
  const unitLines = new Map<IncentiveUnit, IncentiveLine[]>();
  const linesOfUnit = (unit: IncentiveUnit): IncentiveLine[] => {
    const cached = unitLines.get(unit);
    if (cached) return cached;
    const lines: IncentiveLine[] = [];
    const add = (key: string, label: string, amount: number, note?: string) => lines.push({ key, label, yen: amount, note });
    if (unit === "office") {
      add("phone", "① 電話対応 (全社)", tierAtLeast(companyPhoneAvg, rules.phone), companyPhoneAvg === null ? "回答なし" : `平均 ${companyPhoneAvg.toFixed(2)}`);
      add("quality", "クレーム・手直しポイント率 (事務)", office.orders ? tierAtMost(office.qualityRate, rules.officeQuality) : 0, qualityNote(office));
      add("fewestMvp", "クレーム・手直し件数 MVP (最少)", fewestRank.get(office) === 1 ? rules.mvp.fewestQuality : 0, `${office.qualityCount} 件`);
    } else {
      const u = units.find((x) => x.unit === unit);
      if (u) {
        add("reply", "はがき返信率 (店舗)", u.gated ? 0 : tierAtLeast(u.replyRate, rules.replyRate), u.gated ? `返信率 ${u.replyRate?.toFixed(1)}% が ${rules.replyGate}% 未満のため、はがきの項目はなし` : u.replyRate === null ? "個人件数なし" : `${u.replyRate.toFixed(1)}% (${u.cards} 枚 ÷ 個人件数 ${u.individual})`);
        add("replyMvp", "返信率 MVP (1 位の店舗)", replyRank.get(u) === 1 ? rules.mvp.replyTop : 0);
        add("finish", "④ 工事仕上り (店舗)", u.gated ? 0 : tierAtLeast(u.finishAvg, rules.score), u.finishAvg === null ? "回答なし" : `平均 ${u.finishAvg.toFixed(2)}`);
        add("finishMvp", "④ 工事仕上り MVP (1 位の店舗)", finishRank.get(u) === 1 ? rules.mvp.finishTop : 0);
        add("quality", "クレーム・手直しポイント率 (店舗)", u.orders ? tierAtMost(u.qualityRate, rules.storeQuality) : 0, qualityNote(u));
        add("fewestMvp", "クレーム・手直し件数 MVP (最少)", fewestRank.get(u) === 1 ? rules.mvp.fewestQuality : 0, `${u.qualityCount} 件`);
        add("rateMvp", "クレーム・手直し率 MVP (最低の店舗)", rateRank.get(u) === 1 ? rules.mvp.lowestQualityRate : 0);
      }
    }
    unitLines.set(unit, lines);
    return lines;
  };
  const unitLabel = (unit: IncentiveUnit) => (unit === "office" ? "事務" : (db.stores?.find((x) => x.id === unit)?.shortName ?? unit));

  const rows: PersonIncentive[] = targets.map((t) => {
    const segs = t.segments;
    const lines: IncentiveLine[] = [];
    const storeSegs = segs.filter((x) => x.unit !== "office");
    const storeMonths = storeSegs.reduce((a, x) => a + x.months, 0);
    const gatedMonths = storeSegs.filter((x) => units.find((u) => u.unit === x.unit)?.gated).reduce((a, x) => a + x.months, 0);
    // はがきの項目 (②③) の支給の割合: 返信率が基準未満の店舗にいた月は支給しない
    const cardShare = storeMonths ? (storeMonths - gatedMonths) / storeMonths : 1;
    const full = segs.length === 1 && segs[0].months >= 12;
    const months = segs.reduce((a, x) => a + x.months, 0);
    const prorated = segs.length > 0 && !full;
    const segText = segs.map((x) => `${unitLabel(x.unit)} ${x.months} か月`).join(" + ");
    // 所属で決まる項目: 所属ごとの金額 × 月数 ÷ 12 の合計
    const order: string[] = [];
    const sums = new Map<string, { label: string; yen: number; parts: string[]; note?: string }>();
    for (const seg of segs) {
      for (const l of linesOfUnit(seg.unit)) {
        if (!sums.has(l.key)) {
          order.push(l.key);
          sums.set(l.key, { label: l.label, yen: 0, parts: [], note: l.note });
        }
        const cur = sums.get(l.key)!;
        cur.yen += (l.yen * seg.months) / 12;
        cur.parts.push(`${unitLabel(seg.unit)} ${l.yen.toLocaleString("ja-JP")} 円 × ${seg.months}/12`);
      }
    }
    const unitLine = (key: string) => {
      const x = sums.get(key);
      if (!x) return;
      lines.push({ key, label: x.label, yen: Math.round(x.yen), note: prorated ? `月割り (${segText}): ${x.parts.join(" + ")}${x.note && segs.length === 1 ? ` · ${x.note}` : ""}` : x.note });
    };
    const personal = (key: string, label: string, amount: number, note?: string) => lines.push({ key, label, yen: amount, note });
    unitLine("reply");
    unitLine("replyMvp");
    unitLine("phone");
    const sa = salesAvg(t.key);
    if (sa !== null) {
      const base = tierAtLeast(sa, rules.score);
      personal("sales", "② 営業対応 (本人)", Math.round(base * cardShare), `平均 ${sa.toFixed(2)} (${salesOf(t.key)!.sum} 点 ÷ ${salesOf(t.key)!.n} 枚)${cardShare < 1 ? ` · 返信率が基準未満の店舗の月を除く (${Math.round(cardShare * 100)}%)` : ""}`);
      const r = salesRank.get(t.key);
      personal("salesMvp", "② 営業対応 MVP", prize(rules.mvp.sales, r), r ? `${r} 位` : undefined);
    }
    const ca = craftAvg(t.key);
    if (ca !== null) {
      const base = tierAtLeast(ca, rules.score);
      personal("craft", "③ 職人対応 (本人)", Math.round(base * cardShare), `平均 ${ca.toFixed(2)} (${craftOf(t.key)!.sum} 点 ÷ ${craftOf(t.key)!.n} 枚)${cardShare < 1 ? ` · 返信率が基準未満の店舗の月を除く (${Math.round(cardShare * 100)}%)` : ""}`);
      const r = craftRank.get(t.key);
      personal("craftMvp", "③ 職人対応 MVP", prize(rules.mvp.craftsman, r), r ? `${r} 位` : undefined);
    }
    unitLine("finish");
    unitLine("finishMvp");
    const rv = reviewCounts.get(t.key);
    if (rv) {
      const r = reviewRank.get(t.key);
      personal("reviewMvp", "Google 口コミ件数 MVP", prize(rules.mvp.reviews, r), `${rv.n} 件${r ? ` · ${r} 位` : ""}`);
    }
    unitLine("quality");
    unitLine("fewestMvp");
    unitLine("rateMvp");
    const subtotal = lines.reduce((a, l) => a + l.yen, 0);
    const adj = adjustments[t.key];
    const adjust = adj?.amount ?? 0;
    const mainUnit = [...segs].sort((a, b) => b.months - a.months)[0]?.unit;
    return {
      userId: t.key,
      name: t.name,
      role: storeSegs.length ? "craftsman" : segs.some((x) => x.unit === "office") ? "clerk" : "other",
      storeId: mainUnit && mainUnit !== "office" ? mainUnit : t.storeId,
      segments: segs,
      months,
      prorated,
      lines,
      subtotal,
      adjust,
      adjustNote: adj?.note,
      total: Math.max(0, subtotal + adjust),
      salesAvg: sa,
      salesCount: salesOf(t.key)?.n ?? 0,
      craftsmanAvg: ca,
      craftsmanCount: craftOf(t.key)?.n ?? 0,
      reviewCount: rv?.n ?? 0,
      reviewPoints: rv?.points ?? 0,
    };
  });
  return { units, office, companyPhoneAvg, companyPhoneCount, people: rows, total: rows.reduce((a, r) => a + r.total, 0), basis };
}
