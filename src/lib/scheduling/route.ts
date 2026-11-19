import "server-only";
import type { StoreId, User } from "@/lib/db/types";
import { SCHEDULE_KIND } from "@/lib/constants";
import { fromMinutes, toMinutes } from "@/lib/calendar";
import type { GeoPoint } from "@/lib/geo/kumamoto";
import { itemMinutes, type PlanContext, type PlanItem } from "./context";

/**
 * 1 日の巡回順 (担当者 1 人の 1 日の現場を回る順番)
 * ------------------------------------------------------------
 * - 時刻の決まった予定は動かさない (お客様と約束した時刻)。時刻未定・午前/午後だけの予定は、その時間帯の中で移動が最も短くなる順に入れる
 * - 店舗 (出発) → 現場 … → 店舗 (帰着)。最も移動が増えない場所に 1 件ずつ入れ (cheapest insertion)、隣どうしの入れ替えで改善する
 * - 到着の時刻・開始の時刻・遅れ (約束の時刻に間に合わない)・残業の見込みを出す
 */

export interface RouteStop {
  itemId: string;
  title: string;
  kind: string;
  place?: string;
  /** 時刻が決まっている */
  fixed: boolean;
  travelMin: number;
  arrive: string;
  start: string;
  end: string;
  /** 約束の時刻に何分遅れるか */
  lateMin?: number;
  /** 時間帯 (午前・午後) からはみ出す */
  outOfSlot?: boolean;
  /** 地図の位置がない (移動は目安の 20 分) */
  noGeo?: boolean;
}

export interface DayRoute {
  userId: string;
  name: string;
  storeId: StoreId;
  day: string;
  stops: RouteStop[];
  totalTravel: number;
  returnTravel: number;
  startAt: string;
  endAt: string;
  overtimeMin: number;
  /** 予定表のいまの順番 (時刻の順) で回ったときの移動 */
  currentTravel: number;
  /** 予定表の順番から変えた */
  reordered: boolean;
  source: "local" | "google";
}

interface Stop {
  it: PlanItem;
  geo?: GeoPoint;
  minutes: number;
  /** 開始できる時間帯 */
  win: [number, number];
  fixedAt?: number;
}

const UNKNOWN = 20;

function simulate(ctx: PlanContext, base: GeoPoint | undefined, startMin: number, seq: Stop[]): { travel: number; late: number; out: number; end: number; legs: { travel: number; arrive: number; start: number; end: number; late: number; out: boolean }[]; ret: number; google: boolean } {
  let t = startMin;
  let pos = base;
  let travel = 0;
  let late = 0;
  let out = 0;
  let google = false;
  const legs: { travel: number; arrive: number; start: number; end: number; late: number; out: boolean }[] = [];
  for (const s of seq) {
    const tr = pos && s.geo ? ctx.travel(pos, s.geo, t) : undefined;
    if (tr?.source === "google") google = true;
    const leg = tr?.minutes ?? UNKNOWN;
    travel += leg;
    const arrive = t + leg;
    const start = s.fixedAt !== undefined ? Math.max(arrive, s.fixedAt) : Math.max(arrive, s.win[0]);
    const lateMin = s.fixedAt !== undefined ? Math.max(0, arrive - s.fixedAt) : 0;
    const outOfSlot = s.fixedAt === undefined && start + s.minutes > s.win[1];
    late += lateMin;
    if (outOfSlot) out += start + s.minutes - s.win[1];
    const end = start + s.minutes;
    legs.push({ travel: leg, arrive, start, end, late: lateMin, out: outOfSlot });
    t = end;
    pos = s.geo ?? pos;
  }
  const back = pos && base ? ctx.travel(pos, base, t) : undefined;
  const ret = seq.length ? (back?.minutes ?? UNKNOWN) : 0;
  return { travel: travel + ret, late, out, end: t + ret, legs, ret, google };
}

/** 回る順番の良さ (小さいほど良い): 遅れと時間帯のはみ出しを重く、移動を軽く */
const cost = (r: ReturnType<typeof simulate>) => r.late * 10 + r.out * 5 + r.travel;

export function dayRoute(ctx: PlanContext, user: User, day: string): DayRoute | undefined {
  const items = (ctx.byPersonDay.get(`${user.id}|${day}`) ?? []).filter((it) => SCHEDULE_KIND[it.kind]?.group === "case" && !(it.kind === "install" && !it.startTime && !it.slot && it.endDate));
  if (!items.length) return undefined;
  const cap = ctx.capOf(user.storeId);
  const p = ctx.profile(user);
  const ws = toMinutes(p.configured && p.workStart ? p.workStart : cap.workStart);
  const we = toMinutes(p.configured && p.workEnd ? p.workEnd : cap.workEnd);
  const base = ctx.baseOf(user.storeId);
  const stops: Stop[] = [...new Map(items.map((it) => [it.id, it])).values()].map((it) => {
    const minutes = itemMinutes(it);
    const win: [number, number] = it.slot === "am" ? [ws, 720] : it.slot === "pm" ? [720, we] : [ws, we];
    return { it, geo: ctx.geoOf(it), minutes, win, fixedAt: it.startTime ? toMinutes(it.startTime) : undefined };
  });
  const fixed = stops.filter((s) => s.fixedAt !== undefined).sort((a, b) => a.fixedAt! - b.fixedAt!);
  const flex = stops.filter((s) => s.fixedAt === undefined).sort((a, b) => a.win[1] - b.win[1] || a.win[0] - b.win[0]);

  // いまの順番 (時刻の順。時刻のないものは午前 → 午後 → 終日の順で後ろ)
  const current = [...stops].sort((a, b) => (a.fixedAt ?? a.win[0] + 1) - (b.fixedAt ?? b.win[0] + 1));
  const currentSim = simulate(ctx, base, ws, current);

  // 時刻の決まった予定を並べ、時刻未定の予定を 1 件ずつ最も良い場所に入れる
  let seq: Stop[] = [...fixed];
  for (const s of flex) {
    let best: Stop[] | undefined;
    let bestCost = Infinity;
    for (let i = 0; i <= seq.length; i++) {
      const trial = [...seq.slice(0, i), s, ...seq.slice(i)];
      const c = cost(simulate(ctx, base, ws, trial));
      if (c < bestCost) {
        bestCost = c;
        best = trial;
      }
    }
    seq = best!;
  }
  // 隣どうしの入れ替え (時刻の決まった予定の順番は変えない)
  for (let round = 0; round < 4; round++) {
    let improved = false;
    for (let i = 0; i + 1 < seq.length; i++) {
      if (seq[i].fixedAt !== undefined && seq[i + 1].fixedAt !== undefined) continue;
      const trial = [...seq];
      [trial[i], trial[i + 1]] = [trial[i + 1], trial[i]];
      const fixedOrder = trial.filter((x) => x.fixedAt !== undefined).every((x, k, arr) => k === 0 || arr[k - 1].fixedAt! <= x.fixedAt!);
      if (fixedOrder && cost(simulate(ctx, base, ws, trial)) < cost(simulate(ctx, base, ws, seq))) {
        seq = trial;
        improved = true;
      }
    }
    if (!improved) break;
  }
  const sim = simulate(ctx, base, ws, seq);
  // 時刻の決まった予定の後に回る予定が出発を遅らせないよう、出発は最初の約束から逆算 (早すぎる出発を避ける)
  const startAt = seq.length && seq[0].fixedAt !== undefined ? Math.max(ws, seq[0].fixedAt - sim.legs[0].travel) : ws;
  const reordered = seq.some((s, i) => current[i]?.it.id !== s.it.id);
  const standard = we - ws - (p.configured ? p.breakMinutes : 60);
  return {
    userId: user.id,
    name: user.name,
    storeId: user.storeId,
    day,
    stops: seq.map((s, i) => ({
      itemId: s.it.id,
      title: s.it.title,
      kind: SCHEDULE_KIND[s.it.kind]?.label ?? s.it.kind,
      place: s.geo?.label,
      fixed: s.fixedAt !== undefined,
      travelMin: sim.legs[i].travel,
      arrive: fromMinutes(sim.legs[i].arrive),
      start: fromMinutes(sim.legs[i].start),
      end: fromMinutes(sim.legs[i].end),
      lateMin: sim.legs[i].late || undefined,
      outOfSlot: sim.legs[i].out || undefined,
      noGeo: !s.geo || undefined,
    })),
    totalTravel: sim.travel,
    returnTravel: sim.ret,
    startAt: fromMinutes(startAt),
    endAt: fromMinutes(sim.end),
    overtimeMin: Math.max(0, sim.end - startAt - (p.configured ? p.breakMinutes : 60) - standard),
    currentTravel: currentSim.travel,
    reordered,
    source: sim.google ? "google" : "local",
  };
}

/** 店舗の 1 日の全員分の巡回順 */
export function storeDayRoutes(ctx: PlanContext, storeId: StoreId, day: string): DayRoute[] {
  const ids = new Set<string>();
  for (const it of ctx.byStoreDay.get(`${storeId}|${day}`) ?? []) for (const u of it.assigneeIds) ids.add(u);
  return [...ids]
    .map((id) => ctx.db.users.find((u) => u.id === id))
    .filter((u): u is User => Boolean(u))
    .map((u) => dayRoute(ctx, u, day))
    .filter((r): r is DayRoute => Boolean(r))
    .sort((a, b) => a.name.localeCompare(b.name, "ja"));
}
