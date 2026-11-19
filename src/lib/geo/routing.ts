import "server-only";
import fs from "node:fs";
import path from "node:path";
import { straightKm, type GeoPoint } from "./kumamoto";
import type { RoutingSettings } from "@/lib/scheduling/masters";

/**
 * 移動時間 (予定の候補日の提案・1 日の巡回順・全体の最適化)
 * ------------------------------------------------------------
 * 2 つの求め方を同じ形 (Travel) で返す:
 * - local (既定): 社内の計算。お客様の住所を社外に送らない。
 *     道路距離 = 直線距離 × 回り道の係数 (市街地 1.4・平地 1.3・山間部 1.5・天草 1.45)
 *     速さ = 設定の時速 × 距離の帯 (5 km 未満は市街地で 0.75 倍・20 km 超はバイパスで 1.25 倍)
 *     熊本市・合志市・菊陽町の朝夕 (7:30〜9:00・17:00〜18:30) は混雑の係数 (設定。既定 1.25 倍)
 *     + 5 分 (駐車・積み込み)
 * - google: Google Routes API (computeRouteMatrix) の実際の道路の経路と、設定すれば時間帯の交通状況。次がそろったときだけ使う:
 *     ① GOOGLE_MAPS_API_KEY ② 設定の経路サービス = google ③ 社内の承認 (お客様の位置を社外に送ってよい) ④ 月の上限の残り
 *   送るのは緯度経度だけ (住所・お客様の名前は送らない)。細かさの設定が「町名」なら約 1 km 単位に丸めて送る
 *   結果は VPS の SQLite (ROUTING_DB_PATH。既定 /srv/ichijoya/data/cache/routing.sqlite) に 30 日保存して再利用する
 *   失敗・時間切れ・上限超えのときは社内の計算に切り替え (10 分は Google を呼ばない)、回答に「概算」と示す
 * 計算は同期 (提案の計算の中で呼ぶ) なので、Google の結果は prefetchTravel で先に取りに行き、キャッシュから読む
 */

export type TravelSource = "local" | "google";

export interface Travel {
  minutes: number;
  km: number;
  source: TravelSource;
}

export type TravelFn = (a: GeoPoint, b: GeoPoint, departMin?: number) => Travel;

const MOUNTAIN = /阿蘇|小国|産山|高森|南阿蘇|西原|山都|美里|五木|水上|球磨村|山江|相良|多良木|湯前|あさぎり|芦北|津奈木|泉町|五家荘|矢部|清和|蘇陽/;
const ISLAND = /天草|上天草|苓北/;
const CONGESTED = /^熊本市|^合志市|^菊陽町/;
const PEAKS: [number, number][] = [
  [450, 540],
  [1020, 1110],
];

const inPeak = (m?: number) => m !== undefined && PEAKS.some(([s, e]) => m >= s && m < e);

/** 社内の計算 (道路距離と移動時間の目安) */
export function localTravel(a: GeoPoint, b: GeoPoint, speedKmh: number, rushFactor = 1.25, departMin?: number): Travel {
  if (a.label === b.label && a.precision !== "unknown") {
    const km = a.precision === "locality" ? 1 : 3;
    return { km, minutes: Math.round((km / Math.max(10, speedKmh * 0.75)) * 60 + 5), source: "local" };
  }
  const straight = straightKm(a, b);
  const label = `${a.label} ${b.label}`;
  const detour = MOUNTAIN.test(label) ? 1.5 : ISLAND.test(label) ? 1.45 : straight < 3 ? 1.4 : 1.3;
  const km = Math.max(1, straight * detour);
  const band = km < 5 ? 0.75 : km > 20 ? 1.25 : 1;
  const speed = Math.min(60, Math.max(10, speedKmh * band));
  const rush = inPeak(departMin) && (CONGESTED.test(a.label) || CONGESTED.test(b.label)) ? rushFactor : 1;
  return { km: Math.round(km * 10) / 10, minutes: Math.round((km / speed) * 60 * rush + 5), source: "local" };
}

/* ================================================================== */
/* キャッシュ (VPS の SQLite)                                            */
/* ================================================================== */

interface Stmt {
  run(...p: unknown[]): unknown;
  get(...p: unknown[]): Record<string, unknown> | undefined;
  all(...p: unknown[]): Record<string, unknown>[];
}
interface Sqlite {
  exec(sql: string): void;
  prepare(sql: string): Stmt;
}

const TTL_MS = 30 * 86_400_000;
interface RoutingState {
  db: Sqlite | null;
  mem: Map<string, { minutes: number; km: number; at: number }>;
  loaded: boolean;
  breakerUntil: number;
  lastError?: string;
  usage: Map<string, number>;
}
const g = globalThis as typeof globalThis & { __ichijoyaRouting?: RoutingState };
const state: RoutingState = (g.__ichijoyaRouting ??= { db: null, mem: new Map(), loaded: false, breakerUntil: 0, usage: new Map() });

export function routingDbPath(): string | null {
  const env = process.env.ROUTING_DB_PATH?.trim();
  if (env === "off") return null;
  if (env) return env;
  if (process.env.DATA_BACKEND !== "json" && fs.existsSync("/srv/ichijoya")) return "/srv/ichijoya/data/cache/routing.sqlite";
  return path.join(process.cwd(), "data", "cache", "routing.sqlite");
}

function open(): Sqlite | null {
  if (state.loaded) return state.db;
  state.loaded = true;
  const file = routingDbPath();
  if (!file) return null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const { DatabaseSync } = (process as unknown as { getBuiltinModule(id: string): { DatabaseSync: new (f: string) => Sqlite } }).getBuiltinModule("node:sqlite");
    const db = new DatabaseSync(file);
    db.exec("create table if not exists routes (k text primary key, minutes integer not null, km real not null, at integer not null); create table if not exists usage (month text primary key, elements integer not null default 0, errors integer not null default 0);");
    const since = Date.now() - TTL_MS;
    for (const r of db.prepare("select k, minutes, km, at from routes where at > ?").all(since)) state.mem.set(String(r.k), { minutes: Number(r.minutes), km: Number(r.km), at: Number(r.at) });
    for (const r of db.prepare("select month, elements from usage").all()) state.usage.set(String(r.month), Number(r.elements));
    state.db = db;
  } catch (err) {
    console.warn("[routing] cache unavailable:", (err as Error).message);
    state.db = null;
  }
  return state.db;
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
/** 送る位置 (細かさの設定で丸める) */
const sendPoint = (p: GeoPoint, precision: RoutingSettings["precision"]) => (precision === "area" ? { lat: round(p.lat, 2), lng: round(p.lng, 2) } : { lat: round(p.lat, 5), lng: round(p.lng, 5) });
const bucket = (departMin: number | undefined, traffic: boolean) => (traffic ? (inPeak(departMin) ? "peak" : "off") : "any");
const keyOf = (a: { lat: number; lng: number }, b: { lat: number; lng: number }, bk: string) => `${a.lat},${a.lng}>${b.lat},${b.lng}|${bk}`;
const month = () => new Date().toISOString().slice(0, 7);

/* ================================================================== */
/* Google Routes API                                                    */
/* ================================================================== */

export interface RoutingStatus {
  provider: TravelSource;
  /** Google を使える状態か (使えないときは理由) */
  ready: boolean;
  reason?: string;
  usedThisMonth: number;
  limit: number;
  cached: number;
  lastError?: string;
}

export function googleKey(): string | undefined {
  return process.env.GOOGLE_MAPS_API_KEY?.trim() || undefined;
}

export function routingStatus(s: RoutingSettings): RoutingStatus {
  open();
  const used = state.usage.get(month()) ?? 0;
  const base = { usedThisMonth: used, limit: s.monthlyElementLimit, cached: state.mem.size, lastError: state.lastError };
  if (s.provider !== "google") return { provider: "local", ready: false, reason: "社内の計算を使う設定です (お客様の住所を社外に送りません)。", ...base };
  if (!s.policy.approved) return { provider: "local", ready: false, reason: "お客様の位置を社外の経路サービスに送ることの社内の承認が記録されていません。", ...base };
  if (!googleKey()) return { provider: "local", ready: false, reason: "GOOGLE_MAPS_API_KEY が設定されていません (.env.local → npm run env:apply)。", ...base };
  if (used >= s.monthlyElementLimit) return { provider: "local", ready: false, reason: `今月の上限 (${s.monthlyElementLimit} 件) に達しました。来月まで社内の計算を使います。`, ...base };
  if (Date.now() < state.breakerUntil) return { provider: "local", ready: false, reason: `Google の経路の取得に失敗したため、しばらく社内の計算を使います (${state.lastError ?? ""})。`, ...base };
  return { provider: "google", ready: true, ...base };
}

/**
 * 経路を先に取りに行く (Google が使えるときだけ)。pairs は [出発, 到着, 出発の時刻 (分)]。
 * 戻り値は取りに行った組の数 (キャッシュにあったものは数えない)
 */
export async function prefetchTravel(pairs: [GeoPoint, GeoPoint, number?][], s: RoutingSettings, opts: { timeoutMs?: number; maxElements?: number } = {}): Promise<{ fetched: number; error?: string }> {
  const st = routingStatus(s);
  if (!st.ready) return { fetched: 0 };
  const key = googleKey()!;
  // まだない組だけ (同じ出発点ごとにまとめる)
  const need = new Map<string, { o: { lat: number; lng: number }; d: { lat: number; lng: number }; bk: string }>();
  for (const [a, b, dep] of pairs) {
    if (a.precision === "unknown" || b.precision === "unknown") continue;
    const o = sendPoint(a, s.precision);
    const d = sendPoint(b, s.precision);
    if (o.lat === d.lat && o.lng === d.lng) continue;
    const bk = bucket(dep, s.trafficAware);
    const k = keyOf(o, d, bk);
    const hit = state.mem.get(k);
    if (hit && Date.now() - hit.at < TTL_MS) continue;
    need.set(k, { o, d, bk });
  }
  if (!need.size) return { fetched: 0 };
  const left = Math.max(0, s.monthlyElementLimit - st.usedThisMonth);
  const max = Math.min(left, opts.maxElements ?? 400);
  const todo = [...need.values()].slice(0, max);
  if (!todo.length) return { fetched: 0 };
  // 出発点・到着点の一覧を作り、組ごとに行列で問い合わせる (1 回 25 × 25 まで)
  const byBucket = new Map<string, typeof todo>();
  for (const t of todo) byBucket.set(t.bk, [...(byBucket.get(t.bk) ?? []), t]);
  let fetched = 0;
  try {
    for (const [bk, list] of byBucket) {
      const origins = uniq(list.map((x) => x.o));
      const dests = uniq(list.map((x) => x.d));
      for (let i = 0; i < origins.length; i += 25) {
        for (let j = 0; j < dests.length; j += 25) {
          const os = origins.slice(i, i + 25);
          const ds = dests.slice(j, j + 25);
          const rows = await computeMatrix(key, os, ds, bk, s, opts.timeoutMs ?? 8000);
          const now = Date.now();
          for (const r of rows) {
            const o = os[r.originIndex];
            const d = ds[r.destinationIndex];
            if (!o || !d || r.minutes === undefined) continue;
            const k = keyOf(o, d, bk);
            const v = { minutes: r.minutes + 5, km: round((r.meters ?? 0) / 1000, 1), at: now };
            state.mem.set(k, v);
            state.db?.prepare("insert into routes (k, minutes, km, at) values (?, ?, ?, ?) on conflict(k) do update set minutes = excluded.minutes, km = excluded.km, at = excluded.at").run(k, v.minutes, v.km, v.at);
            fetched++;
          }
          addUsage(os.length * ds.length);
        }
      }
    }
    state.lastError = undefined;
    return { fetched };
  } catch (err) {
    state.lastError = (err as Error).message.slice(0, 200);
    state.breakerUntil = Date.now() + 10 * 60_000;
    try {
      state.db?.prepare("insert into usage (month, elements, errors) values (?, 0, 1) on conflict(month) do update set errors = errors + 1").run(month());
    } catch {
      /* 記録できなくても続ける */
    }
    console.warn("[routing] google routes failed, falling back to local:", state.lastError);
    return { fetched, error: state.lastError };
  }
}

function uniq(xs: { lat: number; lng: number }[]) {
  const seen = new Map<string, { lat: number; lng: number }>();
  for (const x of xs) seen.set(`${x.lat},${x.lng}`, x);
  return [...seen.values()];
}

function addUsage(n: number) {
  const m = month();
  state.usage.set(m, (state.usage.get(m) ?? 0) + n);
  try {
    state.db?.prepare("insert into usage (month, elements, errors) values (?, ?, 0) on conflict(month) do update set elements = elements + excluded.elements").run(m, n);
  } catch {
    /* 記録できなくても続ける */
  }
}

/** 次の平日のその時刻 (交通状況を反映するとき。過去の時刻は送れないため) */
function departureTime(bk: string): string | undefined {
  if (bk === "any") return undefined;
  // 明日以降の最初の平日 (日本時間) の 8:00 (混雑) / 11:00 (それ以外)
  const jst = new Date(Date.now() + 9 * 3600_000);
  let d = new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate() + 1));
  while ([0, 6].includes(d.getUTCDay())) d = new Date(d.getTime() + 86_400_000);
  return new Date(d.getTime() + ((bk === "peak" ? 8 : 11) - 9) * 3600_000).toISOString();
}

async function computeMatrix(key: string, os: { lat: number; lng: number }[], ds: { lat: number; lng: number }[], bk: string, s: RoutingSettings, timeoutMs: number): Promise<{ originIndex: number; destinationIndex: number; minutes?: number; meters?: number }[]> {
  const wp = (p: { lat: number; lng: number }) => ({ waypoint: { location: { latLng: { latitude: p.lat, longitude: p.lng } } } });
  const dep = s.trafficAware ? departureTime(bk) : undefined;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch("https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": "originIndex,destinationIndex,duration,distanceMeters,condition" },
      body: JSON.stringify({ origins: os.map(wp), destinations: ds.map(wp), travelMode: "DRIVE", routingPreference: dep ? "TRAFFIC_AWARE" : "TRAFFIC_UNAWARE", ...(dep ? { departureTime: dep } : {}), languageCode: "ja", regionCode: "JP" }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${text.slice(0, 120)}`);
    }
    const body = (await res.json()) as { originIndex?: number; destinationIndex?: number; duration?: string; distanceMeters?: number; condition?: string }[];
    return (Array.isArray(body) ? body : []).map((r) => ({
      originIndex: r.originIndex ?? 0,
      destinationIndex: r.destinationIndex ?? 0,
      minutes: r.condition === "ROUTE_EXISTS" && r.duration ? Math.round(Number(r.duration.replace(/s$/, "")) / 60) : undefined,
      meters: r.distanceMeters,
    }));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 計算の中で使う移動時間の関数。Google の結果がキャッシュにあれば使い、なければ社内の計算。
 * 使った求め方は Travel.source に残る (候補の説明で「実際の道路の経路」か「概算」かを示す)
 */
export function createTravel(s: RoutingSettings, speedKmh: number): TravelFn {
  const useCache = s.provider === "google";
  if (useCache) open();
  return (a, b, departMin) => {
    if (useCache && a.precision !== "unknown" && b.precision !== "unknown") {
      const k = keyOf(sendPoint(a, s.precision), sendPoint(b, s.precision), bucket(departMin, s.trafficAware));
      const hit = state.mem.get(k);
      if (hit && Date.now() - hit.at < TTL_MS) return { minutes: hit.minutes, km: hit.km, source: "google" };
    }
    return localTravel(a, b, speedKmh, s.rushFactor, departMin);
  };
}

/** テスト用: キャッシュと遮断を空にする */
export function resetRoutingForTest(): void {
  state.mem.clear();
  state.usage.clear();
  state.breakerUntil = 0;
  state.lastError = undefined;
  state.loaded = false;
  state.db = null;
}

/** テスト用: キャッシュに経路を入れる */
export function seedRouteForTest(a: GeoPoint, b: GeoPoint, minutes: number, km: number, s: RoutingSettings, departMin?: number): void {
  state.mem.set(keyOf(sendPoint(a, s.precision), sendPoint(b, s.precision), bucket(departMin, s.trafficAware)), { minutes, km, at: Date.now() });
}
