import "server-only";
import type { Database, Inquiry, Order, ScheduleKind, StoreId, User } from "@/lib/db/types";
import { canAccessStore } from "@/lib/auth/permissions";
import { SCHEDULE_KIND } from "@/lib/constants";
import { addDays, toDateKey } from "@/lib/format";
import { shortDate, toMinutes } from "@/lib/calendar";
import { SUGGEST_KINDS } from "@/lib/schedule-capacity";
import type { TravelFn } from "@/lib/geo/routing";
import { createPlanContext, eventItem, type PlanContext } from "./context";
import { evaluateJob, pickDiverse, placeCandidate, type Candidate, type JobRequest } from "./engine";
import { buildRequest, STAGE, type SuggestInput } from "./request";
import { dayRoute, type DayRoute } from "./route";
import { loadMasters, WORK_CATEGORY_LABEL } from "./masters";
import { resolveJob } from "./spec";

/**
 * 全体の最適化 (複数の案件をまとめて配置・既存の予定の入れ替えの提案)
 * ------------------------------------------------------------
 * 1. 新しい案件を「動かせない順」(優先度 → 期限 → 入れられる日の少なさ) に 1 件ずつ、最も点数の高い日・担当・車両に置く
 * 2. 置いた案件を 1 件ずつ外して置き直す (ほかの案件を置いたあとで、より良い日が見つかれば移す)。3 周まで
 * 3. 入れ替えを許すとき (rearrange): 今後の予定のうち、動かすと点数が十分に上がるもの (移動の減少・空き・早さ) を提案する。
 *    動かすことは減点 (重み「既存の予定の移動」) し、お客様と約束した可能性があるため「連絡が必要」と示す。最大 maxMoves 件
 *    その後、新しい案件をもう一度置き直す (空いた枠を使う)
 * 4. 「いまの予定を変えない案」と「一部を動かす案」の移動・応援・残業・遅れ・点数を比べて返す
 * どの結果も提案で、予定には書き込まない (仮押さえ・予定の登録は利用者が行う)
 */

export interface OptimizeJob extends SuggestInput {
  key: string;
  label?: string;
}

export interface OptimizeOptions {
  jobs: OptimizeJob[];
  mode: "keep" | "rearrange";
  /** 入れ替えを考える店舗 (空 = 新しい案件の店舗) */
  storeIds?: StoreId[];
  from?: string;
  to?: string;
  maxMoves?: number;
  rounds?: number;
  now?: Date;
  travel?: TravelFn;
}

export interface Placement {
  key: string;
  label: string;
  kind: ScheduleKind;
  storeId: StoreId;
  candidate: Candidate | null;
  alternatives: Candidate[];
  reason?: string;
  request?: Pick<JobRequest, "orderId" | "quoteId" | "inquiryId" | "customerId" | "location" | "title" | "minutes" | "durationDays">;
}

export interface Move {
  eventId: string;
  title: string;
  kind: ScheduleKind;
  storeId: StoreId;
  from: { date: string; startTime?: string; slot?: string; assigneeNames: string[]; score: number };
  to: Candidate;
  gain: number;
}

export interface PlanSummary {
  placed: number;
  unplaced: number;
  travelMin: number;
  helpCount: number;
  overtimeMin: number;
  lateCount: number;
  avgScore: number;
}

export interface OptimizeResult {
  placements: Placement[];
  moves: Move[];
  keepSummary: PlanSummary;
  summary: PlanSummary;
  routes: DayRoute[];
  notes: string[];
}

const PRIORITY_ORDER = { urgent: 0, high: 1, normal: 2, low: 3 } as const;

function summarize(placements: Placement[], moves: Move[]): PlanSummary {
  const cs = [...placements.map((p) => p.candidate).filter((c): c is Candidate => Boolean(c)), ...moves.map((m) => m.to)];
  return {
    placed: placements.filter((p) => p.candidate).length,
    unplaced: placements.filter((p) => !p.candidate).length,
    travelMin: cs.reduce((a, c) => a + (c.travelMin ?? 0), 0),
    helpCount: cs.filter((c) => c.helped).length,
    overtimeMin: cs.reduce((a, c) => a + (c.overtimeMin ?? 0), 0),
    lateCount: cs.filter((c) => (c.lateDays ?? 0) > 0).length,
    avgScore: cs.length ? Math.round(cs.reduce((a, c) => a + c.score, 0) / cs.length) : 0,
  };
}

/** 新しい案件を置く (greedy + 置き直し) */
function placeAll(ctx: PlanContext, reqs: { req: JobRequest; label: string }[], rounds: number): Map<string, Candidate | null> {
  const placed = new Map<string, Candidate | null>();
  const alt = new Map<string, Candidate[]>();
  // 動かせない順: 優先度 → 期限 → 入れられる日の少なさ
  const order = reqs
    .map((r) => ({ ...r, feasible: evaluateJob(ctx, r.req).candidates.length }))
    .sort((a, b) => PRIORITY_ORDER[a.req.job.priority] - PRIORITY_ORDER[b.req.job.priority] || (a.req.job.deadline ?? "9999").localeCompare(b.req.job.deadline ?? "9999") || a.feasible - b.feasible);
  for (const r of order) {
    const ev = evaluateJob(ctx, r.req);
    const best = pickDiverse(ev.candidates, 1)[0];
    alt.set(r.req.key, ev.candidates);
    placed.set(r.req.key, best ?? null);
    if (best) placeCandidate(ctx, r.req, best);
  }
  for (let round = 0; round < rounds; round++) {
    let changed = false;
    for (const r of order) {
      const cur = placed.get(r.req.key);
      ctx.remove(r.req.key);
      const ev = evaluateJob(ctx, r.req);
      const best = pickDiverse(ev.candidates, 1)[0];
      if (best && (!cur || best.score > cur.score + 1)) {
        placed.set(r.req.key, best);
        placeCandidate(ctx, r.req, best);
        changed = true;
      } else if (cur) {
        placeCandidate(ctx, r.req, cur);
      }
    }
    if (!changed) break;
  }
  return placed;
}

export function optimizePlan(db: Database, user: User, opts: OptimizeOptions): OptimizeResult {
  const now = opts.now ?? new Date();
  const today = toDateKey(now);
  const m = loadMasters(db);
  const from = opts.from && opts.from > today ? opts.from : today;
  const to = opts.to && opts.to > from ? opts.to : addDays(from, 30);
  const notes: string[] = [];
  const jobs = opts.jobs.slice(0, 40);
  if (opts.jobs.length > 40) notes.push(`案件が多いため、先頭の 40 件で計算しました (${opts.jobs.length} 件)。`);

  const makeCtx = (exclude: string[] = []) => createPlanContext(db, user, { now, from, to: addDays(to, 14), exclude, travel: opts.travel, masters: m });

  /* ---- 1・2: いまの予定を変えない案 ---- */
  const ctxKeep = makeCtx();
  const reqs: { req: JobRequest; label: string; input: OptimizeJob }[] = [];
  const placements: Placement[] = [];
  for (const j of jobs) {
    const built = buildRequest(ctxKeep, { ...j, from: j.from ?? from, to: j.to ?? to }, j.key);
    const label = j.label ?? SCHEDULE_KIND[j.kind]?.label ?? j.kind;
    if ("error" in built) {
      placements.push({ key: j.key, label, kind: j.kind, storeId: j.storeId, candidate: null, alternatives: [], reason: built.error });
      continue;
    }
    reqs.push({ req: built.req, label, input: j });
  }
  const rounds = Math.max(0, Math.min(5, opts.rounds ?? 3));
  const keepPlaced = placeAll(ctxKeep, reqs, rounds);
  const keepPlacements: Placement[] = [
    ...placements,
    ...reqs.map((r) => ({
      key: r.req.key,
      label: r.label,
      kind: r.req.kind,
      storeId: r.req.storeId,
      candidate: keepPlaced.get(r.req.key) ?? null,
      alternatives: [],
      reason: keepPlaced.get(r.req.key) ? undefined : "条件に合う日がありません (期間・上限・担当者・車両・期限を見直してください)",
      request: { orderId: r.req.orderId, quoteId: r.req.quoteId, inquiryId: r.req.inquiryId, customerId: r.req.customerId, location: r.req.location, title: r.req.title, minutes: r.req.minutes, durationDays: r.req.durationDays },
    })),
  ];
  const keepSummary = summarize(keepPlacements, []);
  if (opts.mode === "keep") {
    for (const p of keepPlacements) {
      const r = reqs.find((x) => x.req.key === p.key);
      if (r) {
        ctxKeep.remove(r.req.key);
        p.alternatives = pickDiverse(evaluateJob(ctxKeep, r.req).candidates, 4).filter((c) => c.date !== p.candidate?.date || c.slot !== p.candidate?.slot);
        if (p.candidate) placeCandidate(ctxKeep, r.req, p.candidate);
      }
    }
    return { placements: keepPlacements, moves: [], keepSummary, summary: keepSummary, routes: routesOf(ctxKeep, keepPlacements, []), notes };
  }

  /* ---- 3: 入れ替えを許す案 ---- */
  const storeIds = new Set<StoreId>(opts.storeIds?.length ? opts.storeIds : reqs.map((r) => r.req.storeId));
  const cap0 = (s: StoreId) => ctxKeep.capOf(s);
  const movable = db.schedule
    .filter(
      (e) =>
        storeIds.has(e.storeId) &&
        SUGGEST_KINDS.includes(e.kind) &&
        !e.companyWide &&
        e.source !== "order" &&
        e.date >= addDays(today, cap0(e.storeId).leadDays + 1) &&
        e.date <= to &&
        !e.endDate &&
        canAccessStore(user, e.storeId) &&
        (db.jobSpecs ?? []).find((s) => s.id === `js_event_${e.id}`)?.preferenceStrength !== "hard",
    )
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 60);
  const ctx = makeCtx();
  const moves: Move[] = [];
  const maxMoves = Math.max(0, Math.min(15, opts.maxMoves ?? 5));
  // まず新しい案件を置いた状態にする
  for (const r of reqs) {
    const c = keepPlaced.get(r.req.key);
    if (c) placeCandidate(ctx, r.req, c);
  }
  const moveReq = (e: (typeof movable)[number]): JobRequest | undefined => {
    const fixed = e.assigneeIds.length ? e.assigneeIds : undefined;
    const built = buildRequest(
      ctx,
      {
        storeId: e.storeId,
        kind: e.kind,
        orderId: e.orderId,
        quoteId: e.quoteId,
        inquiryId: e.inquiryId,
        customerId: e.customerId,
        address: e.location,
        assigneeIds: fixed,
        eventId: e.id,
        title: e.title,
        memo: e.memo,
        minutes: e.startTime && e.endTime ? Math.max(15, toMinutes(e.endTime) - toMinutes(e.startTime)) : undefined,
        from: addDays(e.date, -14) > today ? addDays(e.date, -14) : addDays(today, cap0(e.storeId).leadDays),
        to: addDays(e.date, 14) < to ? addDays(e.date, 14) : to,
      },
      e.id,
    );
    if ("error" in built) return undefined;
    built.req.movedFrom = e.date;
    return built.req;
  };
  for (const e of movable) {
    if (moves.length >= maxMoves) break;
    const req = moveReq(e);
    if (!req) continue;
    ctx.remove(e.id);
    // いまの日の点数 (その日だけで評価)
    const here = evaluateJob(ctx, { ...req, earliest: e.date, latest: e.date, movedFrom: undefined, fixed: req.fixed });
    const currentScore = here.candidates.length ? Math.max(...here.candidates.map((c) => c.score)) : 0;
    const best = pickDiverse(evaluateJob(ctx, req).candidates, 1)[0];
    if (best && best.date !== e.date && best.score - currentScore >= 8) {
      moves.push({
        eventId: e.id,
        title: e.title,
        kind: e.kind,
        storeId: e.storeId,
        from: { date: e.date, startTime: e.startTime, slot: e.slot, assigneeNames: e.assigneeIds.map((id) => db.users.find((u) => u.id === id)?.name ?? id), score: currentScore },
        to: best,
        gain: best.score - currentScore,
      });
      placeCandidate(ctx, req, best);
    } else {
      ctx.add(eventItem(e));
    }
  }
  // 空いた枠を使って、新しい案件をもう一度置き直す
  for (const r of reqs) ctx.remove(r.req.key);
  const placed = placeAll(ctx, reqs, rounds);
  const finalPlacements: Placement[] = keepPlacements.map((p) => {
    const r = reqs.find((x) => x.req.key === p.key);
    if (!r) return p;
    const c = placed.get(p.key) ?? null;
    return { ...p, candidate: c, reason: c ? undefined : p.reason };
  });
  for (const p of finalPlacements) {
    const r = reqs.find((x) => x.req.key === p.key);
    if (!r) continue;
    ctx.remove(r.req.key);
    p.alternatives = pickDiverse(evaluateJob(ctx, r.req).candidates, 4).filter((c) => c.date !== p.candidate?.date || c.slot !== p.candidate?.slot);
    if (p.candidate) placeCandidate(ctx, r.req, p.candidate);
  }
  const summary = summarize(finalPlacements, moves);
  if (!moves.length) notes.push("既存の予定を動かしても、十分に良くなる組み合わせは見つかりませんでした (いまの予定のままの案と同じです)。");
  else notes.push(`既存の予定を ${moves.length} 件動かすと、平均の点数が ${keepSummary.avgScore} 点 → ${summary.avgScore} 点になります。動かす予定はお客様・担当者に連絡してから変更してください。`);
  return { placements: finalPlacements, moves, keepSummary, summary, routes: routesOf(ctx, finalPlacements, moves), notes };
}

function routesOf(ctx: PlanContext, placements: Placement[], moves: Move[]): DayRoute[] {
  const keys = new Set<string>();
  for (const c of [...placements.map((p) => p.candidate), ...moves.map((m) => m.to)]) if (c) for (const u of c.assigneeIds) keys.add(`${u}|${c.date}`);
  const out: DayRoute[] = [];
  for (const k of [...keys].slice(0, 30)) {
    const [uid, day] = k.split("|");
    const u = ctx.db.users.find((x) => x.id === uid);
    const r = u ? dayRoute(ctx, u, day) : undefined;
    if (r) out.push(r);
  }
  return out.sort((a, b) => a.day.localeCompare(b.day) || a.name.localeCompare(b.name, "ja"));
}

/* ================================================================== */
/* 日程が決まっていない案件 (最適化の対象の候補)                              */
/* ================================================================== */

export interface WaitingJob extends OptimizeJob {
  label: string;
  /** 案件の画面 */
  href: string;
  since: string;
  why: string;
}

/**
 * まだ予定のない案件の次の作業: 問い合わせ (新規・対応中) で現地調査がない → 現地調査、
 * 受注 (確定・日程調整中) で引き取り・施工がない → 引き取り (製造のある作業) か 施工、引き取りのあと納品がない → 納品
 */
export function waitingJobs(db: Database, user: User, opts: { storeIds?: StoreId[]; now?: Date; limit?: number } = {}): WaitingJob[] {
  const now = opts.now ?? new Date();
  const today = toDateKey(now);
  const since = addDays(today, -120);
  const m = loadMasters(db);
  const inStores = (s: StoreId) => canAccessStore(user, s) && (!opts.storeIds?.length || opts.storeIds.includes(s));
  const evByCase = new Map<string, Set<ScheduleKind>>();
  const mark = (k: string | undefined, kind: ScheduleKind) => {
    if (!k) return;
    const set = evByCase.get(k) ?? new Set();
    set.add(kind);
    evByCase.set(k, set);
  };
  for (const e of db.schedule) {
    mark(e.orderId && `o:${e.orderId}`, e.kind);
    mark(e.quoteId && `q:${e.quoteId}`, e.kind);
    mark(e.inquiryId && `i:${e.inquiryId}`, e.kind);
  }
  for (const h of db.scheduleHolds ?? []) {
    if (h.status !== "held") continue;
    mark(h.orderId && `o:${h.orderId}`, h.kind);
    mark(h.inquiryId && `i:${h.inquiryId}`, h.kind);
  }
  const out: WaitingJob[] = [];
  const customerName = (id?: string) => (id ? (db.customers.find((c) => c.id === id)?.name ?? "") : "");
  for (const i of db.inquiries as Inquiry[]) {
    if (!inStores(i.storeId) || !["new", "in_progress"].includes(i.status) || i.receivedAt.slice(0, 10) < since) continue;
    const has = evByCase.get(`i:${i.id}`);
    if (has && [...has].some((k) => (STAGE[k] ?? 9) <= 1)) continue;
    out.push({ key: `i:${i.id}`, storeId: i.storeId, kind: "survey", inquiryId: i.id, customerId: i.customerId, label: `現地調査 ${i.number} ${customerName(i.customerId) || i.contactName || ""}`.trim(), href: `/inquiries/${i.id}`, since: i.receivedAt.slice(0, 10), why: "問い合わせに現地調査の予定がありません" });
  }
  for (const o of db.orders as Order[]) {
    if (!inStores(o.storeId) || !["confirmed", "scheduled", "in_progress"].includes(o.status) || (o.contractDate ?? o.createdAt.slice(0, 10)) < since) continue;
    const has = evByCase.get(`o:${o.id}`) ?? new Set<ScheduleKind>();
    const job = resolveJob(db, m, { orderId: o.id, order: o });
    const name = customerName(o.customerId);
    const base = { storeId: o.storeId, orderId: o.id, customerId: o.customerId, href: `/orders/${o.id}`, since: o.contractDate ?? o.createdAt.slice(0, 10) };
    if (job.production.size) {
      if (!has.has("pickup") && !has.has("install") && !has.has("delivery")) out.push({ ...base, key: `o:${o.id}:pickup`, kind: "pickup", label: `引き取り ${o.number} ${name}`.trim(), why: `受注 (${job.items.map((x) => WORK_CATEGORY_LABEL[x.workType.category]).join("・")}) に引き取りの予定がありません` });
      else if (has.has("pickup") && !has.has("delivery")) out.push({ ...base, key: `o:${o.id}:delivery`, kind: "delivery", label: `納品 ${o.number} ${name}`.trim(), why: "引き取りのあと納品の予定がありません" });
    } else if (!has.has("install") && !o.scheduledStart) {
      out.push({ ...base, key: `o:${o.id}:install`, kind: "install", label: `施工 ${o.number} ${name}`.trim(), why: "受注に施工の予定がありません" });
    }
  }
  return out.sort((a, b) => a.since.localeCompare(b.since)).slice(0, opts.limit ?? 60);
}

/** 文章 (画面の注記・AI アシスタント) */
export function describePlacement(p: Placement): string {
  const c = p.candidate;
  if (!c) return `${p.label}: 入れられる日がありません${p.reason ? ` (${p.reason})` : ""}`;
  return `${p.label}: ${shortDate(c.date)} ${c.startTime ?? (c.slot === "am" ? "午前" : c.slot === "pm" ? "午後" : "終日")} 担当 ${(c.assigneeNames ?? []).join("・") || "未定"} (${c.score} 点${c.travelMin !== undefined ? `・移動 約${c.travelMin}分` : ""})`;
}
