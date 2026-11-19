import "server-only";
import type { Database, ScheduleEvent, StoreId, User } from "@/lib/db/types";
import { canAccessStore } from "@/lib/auth/permissions";
import { addDays, daysBetween, toDateKey } from "@/lib/format";
import { toMinutes } from "@/lib/calendar";
import { SUGGEST_KINDS } from "@/lib/schedule-capacity";
import type { TravelFn } from "@/lib/geo/routing";
import { createPlanContext } from "./context";
import { evaluateJob, type Candidate } from "./engine";
import { loadMasters, WEIGHT_LABEL, type Masters, type WeightSettings, type Weights } from "./masters";
import { buildRequest } from "./request";

/**
 * 提案の検証 (過去の予定で「当時の担当者が選んだ日」と「システムの提案」を比べる) と重みの調整
 * ------------------------------------------------------------
 * - 過去 N か月の案件の予定 (現地調査・訪問・採寸・引き取り・納品・施工) から最大 maxSamples 件を選ぶ
 * - その予定を決めた日 (登録の日。移行した予定は登録の日が分からないため、予定の日の 7 日前とみなす) の時点の予定表で、
 *   その予定を除いて候補を出す (それより後に登録された予定も除く。移行した予定は残る = 当時より少し混んでいる見込み)
 * - 比べる指標: 提案の 1 位・上位 3 件に当時の日が入った割合 / 移動 (当時の日と提案の 1 位。同じ計算の目安) /
 *   待ち日数 (決めた日から予定の日まで) / 残業の見込み / 1 日あたりの件数
 * - 重みの調整: 候補ごとの評価の内訳から、重みを変えたときの 1 位を計算し直し (計算をやり直さないので速い)、
 *   重視する指標 (focus) が良くなる重みを探す (座標ごとに 0.5〜2 倍を試す)。適用は管理者が画面で行う
 * 実際の移動時間・残業の記録 (勤怠) はシステムにないため、移動・残業は同じ計算の目安で比べる
 */

export interface BacktestSample {
  eventId: string;
  title: string;
  kind: string;
  storeId: StoreId;
  decidedOn: string;
  decidedEstimated: boolean;
  actualDate: string;
  /** 当時の日の評価 (その日だけで計算) */
  actual?: { score: number; travelMin?: number; overtimeMin?: number };
  /** 提案の 1 位 */
  top?: { date: string; score: number; travelMin?: number; overtimeMin?: number };
  /** 当時の日が提案の何位か (なければ undefined) */
  rank?: number;
  candidates: { date: string; slot?: string; comp: Record<string, number>; helped: boolean; overtime: number; travelMin?: number }[];
}

export interface BacktestMetrics {
  samples: number;
  /** 提案の 1 位が当時の日 */
  top1: number;
  /** 上位 3 件に当時の日 */
  top3: number;
  /** 当時の日が候補 (条件を満たす日) に入っていた */
  feasible: number;
  avgTravelActual: number;
  avgTravelTop: number;
  avgWaitActual: number;
  avgWaitTop: number;
  overtimeActual: number;
  overtimeTop: number;
  /** 1 日あたりの案件の予定の件数 (期間の実績) */
  jobsPerDay: number;
}

export interface BacktestResult {
  from: string;
  to: string;
  storeIds: StoreId[];
  metrics: BacktestMetrics;
  samples: BacktestSample[];
  tuned?: { weights: Weights; metrics: BacktestMetrics; objectiveBefore: number; objectiveAfter: number };
  notes: string[];
  ranAt: string;
  ms: number;
}

const COMP_KEYS = ["route", "capacity", "production", "staff", "earliness", "experience"] as const;

function compOf(c: Candidate): Record<string, number> {
  return { ...(c.breakdown ?? {}) };
}

/** 重みで点数を計算し直す (engine.ts と同じ式の主要部分) */
function rescore(c: BacktestSample["candidates"][number], w: Weights): number {
  const sumW = COMP_KEYS.reduce((a, k) => a + w[k], 0) || 1;
  let s = COMP_KEYS.reduce((a, k) => a + w[k] * (c.comp[k] ?? 0), 0) / sumW;
  if (c.helped) s -= w.help;
  if (c.overtime > 0) s -= Math.min(0.15, (c.overtime / 120) * w.overtime);
  return s;
}

function metricsFor(samples: BacktestSample[], w: Weights | undefined, jobsPerDay: number): BacktestMetrics {
  let top1 = 0;
  let top3 = 0;
  let feasible = 0;
  let travelA = 0;
  let travelT = 0;
  let nTravel = 0;
  let waitA = 0;
  let waitT = 0;
  let otA = 0;
  let otT = 0;
  for (const s of samples) {
    const ranked = w ? [...s.candidates].sort((a, b) => rescore(b, w) - rescore(a, w) || a.date.localeCompare(b.date)) : s.candidates;
    const dates = [...new Set(ranked.map((c) => c.date))];
    const top = ranked[0];
    if (s.candidates.some((c) => c.date === s.actualDate)) feasible++;
    if (dates[0] === s.actualDate) top1++;
    if (dates.slice(0, 3).includes(s.actualDate)) top3++;
    if (top && s.actual?.travelMin !== undefined && top.travelMin !== undefined) {
      travelA += s.actual.travelMin;
      travelT += top.travelMin;
      nTravel++;
    }
    waitA += daysBetween(s.decidedOn, s.actualDate);
    waitT += top ? daysBetween(s.decidedOn, top.date) : daysBetween(s.decidedOn, s.actualDate);
    otA += s.actual?.overtimeMin ?? 0;
    otT += top?.overtime ?? 0;
  }
  const n = Math.max(1, samples.length);
  return {
    samples: samples.length,
    top1: Math.round((top1 / n) * 100),
    top3: Math.round((top3 / n) * 100),
    feasible: Math.round((feasible / n) * 100),
    avgTravelActual: nTravel ? Math.round(travelA / nTravel) : 0,
    avgTravelTop: nTravel ? Math.round(travelT / nTravel) : 0,
    avgWaitActual: Math.round((waitA / n) * 10) / 10,
    avgWaitTop: Math.round((waitT / n) * 10) / 10,
    overtimeActual: Math.round(otA),
    overtimeTop: Math.round(otT),
    jobsPerDay,
  };
}

/** 重視する指標ごとの目的 (大きいほど良い) */
function objective(mt: BacktestMetrics, focus: WeightSettings["focus"]): number {
  const travel = mt.avgTravelActual ? 1 - mt.avgTravelTop / Math.max(1, mt.avgTravelActual) : 0;
  const wait = mt.avgWaitActual ? 1 - mt.avgWaitTop / Math.max(0.5, mt.avgWaitActual) : 0;
  const agree = mt.top3 / 100;
  const ot = mt.overtimeActual ? 1 - mt.overtimeTop / Math.max(1, mt.overtimeActual) : 0;
  switch (focus) {
    case "travel":
      return travel * 0.7 + agree * 0.2 + wait * 0.1;
    case "speed":
    case "deadline":
      return wait * 0.7 + agree * 0.2 + travel * 0.1;
    case "revenue":
      return wait * 0.4 + travel * 0.3 + agree * 0.2 + ot * 0.1;
    default:
      return agree * 0.4 + travel * 0.3 + wait * 0.2 + ot * 0.1;
  }
}

export function runBacktest(db: Database, user: User, opts: { months?: number; storeIds?: StoreId[]; maxSamples?: number; tune?: boolean; now?: Date; travel?: TravelFn } = {}): BacktestResult {
  const t0 = Date.now();
  const now = opts.now ?? new Date();
  const today = toDateKey(now);
  const months = Math.max(1, Math.min(12, opts.months ?? 6));
  const from = addDays(today, -months * 30);
  const to = addDays(today, -1);
  const m: Masters = loadMasters(db);
  const storeIds = (opts.storeIds?.length ? opts.storeIds : db.stores.filter((s) => s.kind === "store").map((s) => s.id)).filter((s) => canAccessStore(user, s));
  const notes: string[] = [];
  const pool = db.schedule.filter((e) => storeIds.includes(e.storeId) && SUGGEST_KINDS.includes(e.kind) && e.date >= from && e.date <= to && !e.endDate && !e.companyWide);
  // 均等に選ぶ (期間の全体から)
  const max = Math.max(10, Math.min(300, opts.maxSamples ?? 80));
  const step = Math.max(1, Math.floor(pool.length / max));
  const picked = pool.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)).filter((_, i) => i % step === 0).slice(0, max);
  const days = new Set(pool.map((e) => `${e.storeId}|${e.date}`));
  const jobsPerDay = days.size ? Math.round((pool.length / days.size) * 10) / 10 : 0;

  const samples: BacktestSample[] = [];
  let estimated = 0;
  for (const e of picked) {
    const created = e.createdAt?.slice(0, 10);
    const genuine = e.source !== "import" && created && created < e.date;
    const decidedOn = genuine ? created! : addDays(e.date, -7);
    if (!genuine) estimated++;
    const later = db.schedule.filter((x) => x.source !== "import" && x.createdAt && x.createdAt.slice(0, 10) > decidedOn).map((x) => x.id);
    const asOf = new Date(`${decidedOn}T09:00:00+09:00`);
    const ctx = createPlanContext(db, user, { now: asOf, from: decidedOn, to: addDays(e.date, 30), exclude: [e.id, ...later], travel: opts.travel, masters: m });
    const built = buildRequest(ctx, sampleInput(e, decidedOn), e.id);
    if ("error" in built) continue;
    const req = { ...built.req, earliest: addDays(decidedOn, 1), latest: addDays(e.date, 21) };
    const ev = evaluateJob(ctx, req);
    const here = evaluateJob(ctx, { ...req, earliest: e.date, latest: e.date });
    const actualBest = [...here.candidates].sort((a, b) => b.score - a.score)[0];
    const ranked = [...ev.candidates].sort((a, b) => b.score - a.score || a.date.localeCompare(b.date));
    const dates = [...new Set(ranked.map((c) => c.date))];
    const top = ranked[0];
    const rank = dates.indexOf(e.date);
    samples.push({
      eventId: e.id,
      title: e.title,
      kind: e.kind,
      storeId: e.storeId,
      decidedOn,
      decidedEstimated: !genuine,
      actualDate: e.date,
      actual: actualBest ? { score: actualBest.score, travelMin: actualBest.travelMin, overtimeMin: actualBest.overtimeMin } : undefined,
      top: top ? { date: top.date, score: top.score, travelMin: top.travelMin, overtimeMin: top.overtimeMin } : undefined,
      rank: rank >= 0 ? rank + 1 : undefined,
      candidates: ranked.slice(0, 40).map((c) => ({ date: c.date, slot: c.slot, comp: compOf(c), helped: Boolean(c.helped), overtime: c.overtimeMin ?? 0, travelMin: c.travelMin })),
    });
  }
  const metrics = metricsFor(samples, undefined, jobsPerDay);
  if (estimated) notes.push(`${estimated} 件は登録の日が分からない (移行した予定など) ため、予定の日の 7 日前に決めたとみなしました。`);
  notes.push("移行した予定は登録の日が分からないため、当時の予定表に後から入った予定も含みます (当時より少し混んで見えます)。");
  notes.push("実際の移動時間・残業の記録 (勤怠) はシステムにないため、当時の日の移動・残業は同じ計算の目安で比べています。");
  if (samples.length < 20) notes.push("比べた予定が少ないため、結果の差は参考程度です (3〜12 か月分で確かめてください)。");

  let tuned: BacktestResult["tuned"];
  if (opts.tune && samples.length >= 5) {
    const focus = m.weights.focus;
    let best: Weights = { ...m.weights };
    let bestObj = objective(metricsFor(samples, best, jobsPerDay), focus);
    const before = bestObj;
    const keys = [...COMP_KEYS, "help", "overtime"] as (keyof Weights)[];
    for (let pass = 0; pass < 3; pass++) {
      let improved = false;
      for (const k of keys) {
        for (const f of [0.5, 0.75, 1.25, 1.5, 2]) {
          const trial = { ...best, [k]: Math.max(0, Math.min(1, Math.round(best[k] * f * 1000) / 1000)) };
          const o = objective(metricsFor(samples, trial, jobsPerDay), focus);
          if (o > bestObj + 0.002) {
            best = trial;
            bestObj = o;
            improved = true;
          }
        }
      }
      if (!improved) break;
    }
    tuned = { weights: pickWeights(best), metrics: metricsFor(samples, best, jobsPerDay), objectiveBefore: Math.round(before * 1000) / 1000, objectiveAfter: Math.round(bestObj * 1000) / 1000 };
    if (bestObj <= before + 0.002) notes.push("いまの重みより良くなる重みは見つかりませんでした。");
  }
  return { from, to, storeIds, metrics, samples, tuned, notes, ranAt: now.toISOString(), ms: Date.now() - t0 };
}

function pickWeights(w: Weights): Weights {
  const out = {} as Weights;
  for (const k of Object.keys(WEIGHT_LABEL) as (keyof Weights)[]) out[k] = w[k];
  return out;
}

function sampleInput(e: ScheduleEvent, decidedOn: string) {
  return {
    storeId: e.storeId,
    kind: e.kind,
    orderId: e.orderId,
    quoteId: e.quoteId,
    inquiryId: e.inquiryId,
    customerId: e.customerId,
    address: e.location,
    title: e.title,
    memo: e.memo,
    staffCount: e.assigneeIds.length || undefined,
    minutes: e.startTime && e.endTime ? Math.max(15, toMinutes(e.endTime) - toMinutes(e.startTime)) : undefined,
    from: addDays(decidedOn, 1),
  };
}
