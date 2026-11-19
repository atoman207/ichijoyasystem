import "server-only";
import type { Customer, Database, Order, ScheduleEvent, ScheduleKind, StoreId, User } from "@/lib/db/types";
import { canAccessStore } from "@/lib/auth/permissions";
import { SCHEDULE_KIND } from "@/lib/constants";
import { addDays, daysBetween, toDateKey } from "@/lib/format";
import { dateRange, eventDays, fromMinutes, isDateKey, lastDay, shortDate, toMinutes } from "@/lib/calendar";
import { geocodeAddress, geocodePlace, roadKm, travelMinutes, type GeoPoint } from "@/lib/geo/kumamoto";
import { effectiveCapacity, isClosedDay, JOB_KINDS, scheduleStats, storeDayLoads, SUGGEST_KINDS, VISIT_KINDS, workOf, type DayLoad, type EffectiveCapacity } from "@/lib/schedule-capacity";

/**
 * 予定の候補日の提案 (AI 予定候補日)
 * ------------------------------------------------------------
 * 新しい案件の予定 (現地調査・顧客訪問・採寸・引き取り・納品・施工) を入れる日を、会社全体の生産性が高くなる順に複数提案する。
 * 守ること (満たさない日は候補にしない):
 *  - 休業日 (休日カレンダー) を除く
 *  - 店舗の 1 日の上限: 現場作業の件数・営業の訪問の件数・畳の製造 (引き取る畳の枚数)。上限は schedule-capacity.ts
 *  - 担当者: 休暇・終日の予定がない、1 日の件数が上限未満、前後の予定との移動時間を含めて時間が空いている
 *  - 案件の順番: 納品は引き取りの翌日以降、ほかの予定も先の段階 (現地調査 → 採寸 → 引き取り → 施工 → 納品) の後
 * 比べること (点数 0〜100):
 *  - 移動の効率 (同じ日に担当者が近くの現場を回るほど高い。既存の現場と新しい現場の距離・移動時間)
 *  - 店舗の空き (その日の現場作業・訪問の件数と上限)
 *  - 畳の製造の空き (引き取りで畳があるとき)
 *  - 担当者の負担の偏り (その日の件数が少ない人)
 *  - 早さ (早い日ほど高い。お客様を待たせない)
 *  - 担当の経験 (過去 1 年に同じ種類の予定を担当した件数)
 * 距離は src/lib/geo/kumamoto.ts の目安 (市区町村・町名の位置)。外部の地図サービスは使わない
 */

export type SuggestSlot = "am" | "pm" | "day";

export interface SuggestInput {
  storeId: StoreId;
  kind: ScheduleKind;
  /** 複数日にわたる予定 (施工など) の日数 */
  durationDays?: number;
  /** 希望の時間帯 (指定なしは種別から決める: 施工は終日、それ以外は午前・午後) */
  slot?: SuggestSlot;
  /** 現場の住所 (なければ受注の現場住所・お客様の住所) */
  address?: string;
  customerId?: string;
  orderId?: string;
  inquiryId?: string;
  quoteId?: string;
  /** 畳の枚数 (なければ案件の予定・明細から読む) */
  tatamiCount?: number;
  /** 必要な人数 (なければ過去の同じ種類の予定の人数) */
  staffCount?: number;
  /** 担当者を決めている (この人たちが全員空いている日を探す) */
  assigneeIds?: string[];
  /** 探す期間 (YYYY-MM-DD) */
  from?: string;
  to?: string;
  /** 変更中の予定 (自分自身を数えない) */
  eventId?: string;
  /** 1 件の所要時間 (分)。なければ種別の標準 */
  minutes?: number;
  /** 候補の数 (既定 5) */
  limit?: number;
}

export interface SuggestCandidate {
  date: string;
  slot?: SuggestSlot;
  assigneeIds: string[];
  /** 0〜100 */
  score: number;
  reasons: string[];
  warnings: string[];
  /** 以下は表示・登録用の補足 */
  endDate?: string;
  startTime?: string;
  endTime?: string;
  assigneeNames?: string[];
  /** 直前・直後の現場 (なければ店舗) からの移動の目安 */
  travelMin?: number;
  distanceKm?: number;
  nearby?: { title: string; place: string; km: number; mine: boolean }[];
  load?: { jobs: number; jobsCap: number; visits: number; visitsCap: number; tatami: number; tatamiCap: number };
  breakdown?: Record<"route" | "capacity" | "production" | "staff" | "earliness" | "experience", number>;
}

export interface SuggestResult {
  candidates: SuggestCandidate[];
  notes: string[];
  /** 現場の位置の推定 */
  site?: { label: string; precision: GeoPoint["precision"] };
  window?: { from: string; to: string };
  tatamiCount?: number;
  staffCount?: number;
  minutes?: number;
  capacity?: Pick<EffectiveCapacity, "jobsPerDay" | "visitsPerDay" | "tatamiPerDay" | "source" | "staffEventsPerDay">;
}

/** 案件の段階の順番 (先の段階の予定より後に入れる) */
const STAGE: Partial<Record<ScheduleKind, number>> = { survey: 0, visit: 0, measure: 1, pickup: 2, install: 3, delivery: 4 };
const SOURCE_LABEL = { setting: "設定値", auto: "過去 1 年の実績から自動", default: "標準値" } as const;
const UNKNOWN_TRAVEL = 20;
const STEP = 15;

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const roundUp = (m: number, step = STEP) => Math.ceil(m / step) * step;

/** 受注の明細 (経過メモ「明細 (税込): 畳 きずな 6×¥…」・見積の明細) から畳の枚数を読む。縁・乾燥・処分などの付帯は数えない */
function tatamiFromOrder(db: Database, o: Order | undefined): number {
  if (!o) return 0;
  const accessory = /縁|ヘリ|へり|乾燥|処分|運搬|値引|防虫|シート|配送|諸経費|交換/;
  let n = 0;
  for (const p of o.progressNotes ?? []) {
    const m = p.body.match(/明細 \((?:税込|税抜)\): (.*)/);
    if (!m) continue;
    for (const part of m[1].split(" / ")) {
      const r = part.match(/^畳 (.+?) (-?[\d.]+)×¥/);
      if (r && !accessory.test(r[1])) n += Math.max(0, Math.round(Number(r[2])));
    }
  }
  if (n) return Math.min(n, 200);
  const q = o.quoteId ? db.quotes.find((x) => x.id === o.quoteId) : undefined;
  for (const it of q?.items ?? []) {
    const prod = it.productId ? db.products.find((p) => p.id === it.productId) : undefined;
    const isTatami = prod ? prod.category === "tatami" : /畳/.test(it.name);
    if (isTatami && !accessory.test(it.name) && /枚|畳|帖/.test(it.unit)) n += Math.max(0, Math.round(it.qty));
  }
  return Math.min(n, 200);
}

interface Busy {
  /** 時刻の決まった予定 (前後の移動時間を含む) */
  timed: [number, number][];
  /** 時刻未定 (午前・午後だけ決まっている・時刻のない案件の予定) で使う分 */
  flex: number;
  flexCount: number;
  /** 終日の予定・休暇で、その日は入れられない */
  blocked?: string;
  /** その日の予定の件数 */
  count: number;
  /** その人のその日の現場 (位置が分かるもの) */
  sites: { ev: ScheduleEvent; geo: GeoPoint }[];
}

/**
 * 候補日を提案する。user の閲覧範囲で案件 (お客様・受注) を読む。
 * 予定表は全社共有のため、担当者の予定・ほかの店舗の予定は全員分を使う
 */
export function suggestScheduleDates(db: Database, user: User, input: SuggestInput, now = new Date()): SuggestResult {
  const notes: string[] = [];
  const store = db.stores.find((s) => s.id === input.storeId);
  if (!store) return { candidates: [], notes: ["店舗が見つかりません。"] };
  const kind = input.kind;
  if (!SUGGEST_KINDS.includes(kind)) return { candidates: [], notes: [`「${SCHEDULE_KIND[kind]?.label ?? kind}」は候補日の提案の対象外です (現地調査・顧客訪問・採寸・引き取り・納品・施工が対象)。`] };
  if (!canAccessStore(user, store.id)) notes.push(`${store.name}の予定の登録は、${store.shortName}のメンバーと本部・管理者が行います (候補の確認だけできます)。`);

  const cap = effectiveCapacity(db, store.id, now);
  const stats = scheduleStats(db, now);
  const today = toDateKey(now);
  const isJob = JOB_KINDS.includes(kind);
  const isVisit = VISIT_KINDS.includes(kind);

  /* ---- 案件と現場 ---- */
  const visible = <T extends { storeId: StoreId }>(x: T | undefined): T | undefined => (x && canAccessStore(user, x.storeId) ? x : undefined);
  const order = visible(input.orderId ? db.orders.find((o) => o.id === input.orderId) : undefined);
  const quote = visible(input.quoteId ? db.quotes.find((q) => q.id === input.quoteId) : order?.quoteId ? db.quotes.find((q) => q.id === order.quoteId) : undefined);
  const inquiry = visible(input.inquiryId ? db.inquiries.find((i) => i.id === input.inquiryId) : quote?.inquiryId ? db.inquiries.find((i) => i.id === quote.inquiryId) : undefined);
  const customerId = input.customerId ?? order?.customerId ?? quote?.customerId ?? inquiry?.customerId;
  const customer = visible(customerId ? db.customers.find((c) => c.id === customerId) : undefined);
  if ((input.orderId && !order) || (input.customerId && !customer)) notes.push("案件・お客様の一部は閲覧の権限がないため、住所・畳の枚数の手がかりに使っていません。");

  const caseEvents = db.schedule.filter(
    (e) => e.id !== input.eventId && ((order && e.orderId === order.id) || (quote && e.quoteId === quote.id) || (inquiry && e.inquiryId === inquiry.id)),
  );
  const customers = db.customers;
  const address = input.address?.trim() || order?.siteAddress || quote?.siteAddress || customer?.address || inquiry?.area || "";
  const site = address ? geocodePlace(address, { storeId: store.id, customers }) : undefined;
  const base = geocodeAddress(store.address);
  if (site) notes.push(`現場の場所: ${site.label} (${site.precision === "locality" ? "町名まで推定" : "市区町村まで推定"})。移動時間は距離からの目安です。`);
  else notes.push(address ? "現場の住所から場所を特定できなかったため、移動の距離は比べていません (市区町村から書くと精度が上がります)。" : "現場の住所がないため、移動の距離は比べていません (住所を入れると、近くの現場とまとめて回れる日を優先します)。");

  const fromCase = Math.max(0, ...caseEvents.map((e) => workOf(e).tatami));
  const tatami = Math.max(0, Math.round(input.tatamiCount ?? (fromCase || tatamiFromOrder(db, order))));
  const production = kind === "pickup" && tatami > 0;

  const fixed = [...new Set(input.assigneeIds ?? [])].map((id) => db.users.find((u) => u.id === id && u.active)).filter((u): u is User => Boolean(u));
  const staffCount = fixed.length || Math.max(1, Math.min(4, Math.round(input.staffCount ?? stats.stores[store.id]?.teamSize[kind] ?? 1)));
  const duration = Math.max(1, Math.min(10, Math.round(input.durationDays ?? 1)));
  const minutes = Math.max(15, Math.min(600, Math.round(input.minutes ?? (SCHEDULE_KIND[kind].minutes || 60))));
  const slots: SuggestSlot[] = input.slot ? [input.slot] : kind === "install" || minutes >= 300 ? ["day"] : ["am", "pm"];

  /* ---- 探す期間 (案件の先の段階の予定より後) ---- */
  let earliest = addDays(today, cap.leadDays);
  const myStage = STAGE[kind] ?? 0;
  /** 引き取った畳・建具を納める (お客様が使えない期間を短くするため、早い日を強く優先する) */
  let afterPickup: string | undefined;
  for (const e of caseEvents) {
    const st = STAGE[e.kind];
    if (st === undefined || st >= myStage) continue;
    const after = kind === "delivery" && e.kind === "pickup" ? addDays(lastDay(e), 1) : lastDay(e);
    if (kind === "delivery" && e.kind === "pickup" && (!afterPickup || e.date > afterPickup)) afterPickup = e.date;
    if (after > earliest) {
      earliest = after;
      notes.push(`同じ案件の「${SCHEDULE_KIND[e.kind].label}」(${shortDate(e.date)}) より後の日から探しました${kind === "delivery" && e.kind === "pickup" ? " (納品は引き取りの翌日以降)" : ""}。`);
    }
  }
  const from = isDateKey(input.from) && input.from > earliest ? input.from : earliest;
  let to = isDateKey(input.to) && input.to >= from ? input.to : addDays(from, cap.horizonDays - 1);
  if (to > addDays(from, 61)) to = addDays(from, 61);
  const span = Math.max(1, dateRange(from, to, 62).length);

  /* ---- 予定の索引 (期間内) ---- */
  const scanTo = addDays(to, duration);
  const byPersonDay = new Map<string, ScheduleEvent[]>();
  const byStoreDay = new Map<string, ScheduleEvent[]>();
  for (const e of db.schedule) {
    if (e.id === input.eventId || e.date > scanTo || lastDay(e) < from) continue;
    for (const d of eventDays(e)) {
      if (d < from || d > scanTo) continue;
      for (const uid of new Set(e.assigneeIds)) {
        const k = `${uid}|${d}`;
        const list = byPersonDay.get(k);
        if (list) list.push(e);
        else byPersonDay.set(k, [e]);
      }
      const sk = `${e.storeId}|${d}`;
      const list = byStoreDay.get(sk);
      if (list) list.push(e);
      else byStoreDay.set(sk, [e]);
    }
  }
  const loads = storeDayLoads(db, store.id, from, scanTo, input.eventId);
  const customerById = new Map<string, Customer>();
  const orderById = new Map<string, Order>();
  const geoCache = new Map<string, GeoPoint | null>();
  const geoOf = (e: ScheduleEvent): GeoPoint | undefined => {
    if (geoCache.has(e.id)) return geoCache.get(e.id) ?? undefined;
    let p = e.location ? geocodePlace(e.location, { storeId: e.storeId, customers, title: e.title }) : undefined;
    if (!p && e.orderId) {
      if (!orderById.size) for (const o of db.orders) orderById.set(o.id, o);
      const o = orderById.get(e.orderId);
      if (o?.siteAddress) p = geocodePlace(o.siteAddress, { storeId: e.storeId, customers });
    }
    if (!p && e.customerId) {
      if (!customerById.size) for (const c of customers) customerById.set(c.id, c);
      const c = customerById.get(e.customerId);
      if (c?.address) p = geocodeAddress(c.address);
    }
    if (!p) p = geocodePlace("", { storeId: e.storeId, customers, title: e.title });
    geoCache.set(e.id, p ?? null);
    return p;
  };
  const travelTo = (p: GeoPoint | undefined) => (site && p ? travelMinutes(p, site, cap.travelSpeedKmh) : UNKNOWN_TRAVEL);
  const baseTravel = site && base ? travelMinutes(base, site, cap.travelSpeedKmh) : UNKNOWN_TRAVEL;
  const baseKm = site && base ? roadKm(base, site) : undefined;

  const ws = toMinutes(cap.workStart);
  const we = toMinutes(cap.workEnd);
  const windowOf = (slot: SuggestSlot): [number, number] => (slot === "am" ? [ws, Math.max(ws + 60, 720)] : slot === "pm" ? [Math.min(780, we - 60), we] : [ws, we]);

  /** その人のその日の空き */
  const busyOf = (uid: string, day: string, win: [number, number]): Busy => {
    const evs = byPersonDay.get(`${uid}|${day}`) ?? [];
    const b: Busy = { timed: [], flex: 0, flexCount: 0, count: 0, sites: [] };
    for (const e of evs) {
      const caseKind = SCHEDULE_KIND[e.kind]?.group === "case";
      if (caseKind || e.kind === "meeting" || e.kind === "other" || e.kind === "gathering") b.count++;
      const geo = caseKind ? geoOf(e) : undefined;
      if (geo) b.sites.push({ ev: e, geo });
      const buffer = caseKind ? travelTo(geo) : 15;
      if (e.kind === "leave") {
        if (!e.startTime) {
          b.blocked = "休暇・不在";
          continue;
        }
      }
      if (e.startTime) {
        const s = toMinutes(e.startTime);
        const end = e.endTime ? toMinutes(e.endTime) : s + (SCHEDULE_KIND[e.kind]?.minutes || 60);
        if (end + buffer > win[0] && s - buffer < win[1]) b.timed.push([s - buffer, end + buffer]);
        continue;
      }
      if (e.slot) {
        const half: [number, number] = e.slot === "am" ? [0, 720] : [720, 1440];
        if (half[1] > win[0] && half[0] < win[1]) {
          b.flex += (SCHEDULE_KIND[e.kind]?.minutes || 60) + buffer;
          b.flexCount++;
        }
        continue;
      }
      // 終日: 施工・社内の行事などはその日は入れない。時刻のない引き取り・納品・訪問は時刻未定として扱う
      if (caseKind && e.kind !== "install") {
        b.flex += (SCHEDULE_KIND[e.kind]?.minutes || 60) + buffer;
        b.flexCount++;
      } else {
        b.blocked = `終日の予定 (${SCHEDULE_KIND[e.kind]?.label ?? "予定"})`;
      }
    }
    return b;
  };

  /** その人がその時間帯に入れるか。入れるなら、最も早い開始 (時刻未定の予定があるときは null = 時間帯だけ) */
  const fits = (b: Busy, win: [number, number], startMin: number, slot: SuggestSlot): { ok: boolean; start: number | null; why?: string } => {
    if (b.blocked) return { ok: false, start: null, why: b.blocked };
    if (b.count >= cap.staffEventsPerDay) return { ok: false, start: null, why: `予定が ${b.count} 件 (1 日の上限)` };
    // 終日の作業 (施工など) は、時刻未定の訪問がある日には入れない (どの時間に回るか決められないため)
    if (slot === "day" && b.flexCount) return { ok: false, start: null, why: "時刻未定の予定あり" };
    const busyMin = b.timed.reduce((a, [s, e]) => a + Math.max(0, Math.min(e, win[1]) - Math.max(s, win[0])), 0);
    if (win[1] - win[0] - busyMin - b.flex < minutes) return { ok: false, start: null, why: "時間の空きなし" };
    for (let t = roundUp(startMin); t + minutes <= win[1]; t += STEP) {
      if (b.timed.every(([s, e]) => t + minutes <= s || t >= e)) return { ok: true, start: b.flexCount ? null : t };
    }
    return { ok: false, start: null, why: "時間の空きなし" };
  };

  /* ---- 担当者の候補 ---- */
  const exp = (uid: string) => {
    const x = stats.experience.get(uid);
    return x ? (isVisit ? x.visit : x.job) : 0;
  };
  const field = (u: User) => u.role === "store_staff" || u.role === "store_manager" || exp(u.id) > 0;
  const own = fixed.length ? fixed : db.users.filter((u) => u.active && u.storeId === store.id && field(u));
  const helpers = fixed.length ? [] : db.users.filter((u) => u.active && u.storeId !== store.id && u.storeId !== "hq" && (u.role === "store_staff" || u.role === "store_manager") && exp(u.id) > 0);
  if (!fixed.length && !own.length) notes.push(`${store.shortName}に担当できる社員がいないため、ほかの店舗の社員 (応援) で探しました。`);
  /** 経験 (同じ店舗の候補の中での相対値。0〜1) */
  const maxExp = Math.max(1, ...[...own, ...helpers].map((u) => exp(u.id)));
  const relExp = (uid: string) => exp(uid) / maxExp;
  /**
   * 役割の向き不向き (0〜1): 現場作業は肩書きに「施工」がある社員・店舗スタッフを優先し、店長・管理者の手を空ける。
   * 営業の訪問 (現地調査・見積の訪問) は「営業」の社員と店長を優先する
   */
  const roleFit = (u: User): number => {
    if (isJob) return /施工/.test(u.title) ? 1 : u.role === "store_staff" ? 0.8 : u.role === "store_manager" ? 0.6 : 0.3;
    return /営業|店長/.test(u.title) || u.role === "store_manager" ? 1 : u.role === "admin" ? 0.8 : 0.5;
  };
  const kindLabel = isJob ? "現場作業" : "営業の訪問";
  const storeShort = (id: StoreId) => db.stores.find((s) => s.id === id)?.shortName ?? id;

  /* ---- 日ごとに評価 ---- */
  let closed = 0;
  let full = 0;
  let noStaff = 0;
  const all: SuggestCandidate[] = [];
  const zero: DayLoad = { jobs: 0, visits: 0, tatami: 0 };
  const capJobs = isJob ? cap.jobsPerDay : cap.visitsPerDay;

  for (const [i, day] of dateRange(from, to, 62).entries()) {
    const days = dateRange(day, addDays(day, duration - 1), 10);
    if (days.some((d) => isClosedDay(db, d))) {
      closed++;
      continue;
    }
    const dayLoads = days.map((d) => loads.get(d) ?? zero);
    const used = Math.max(...dayLoads.map((l) => (isJob ? l.jobs : l.visits)));
    const prod = dayLoads[0].tatami;
    const overProduction = production && prod + tatami > cap.tatamiPerDay && !(prod === 0 && tatami > cap.tatamiPerDay);
    if (used + 1 > capJobs || overProduction) {
      full++;
      continue;
    }

    let best: SuggestCandidate | undefined;
    for (const slot of slots) {
      const win = windowOf(slot);
      const startMin = slot === "pm" ? win[0] : win[0] + Math.min(baseTravel, 60);
      // 各日の空きを人ごとに
      const evalPerson = (u: User) => {
        const busies = days.map((d) => busyOf(u.id, d, win));
        const checks = busies.map((b) => fits(b, win, startMin, slot));
        const ok = checks.every((c) => c.ok);
        const first = busies[0];
        const near = first.sites.map((s) => ({ s, t: travelTo(s.geo) })).sort((a, b) => a.t - b.t)[0];
        return { u, ok, why: checks.find((c) => !c.ok)?.why, start: checks[0].start, timedOnly: checks.every((c) => c.start !== null), busy: first, near, count: Math.max(...busies.map((b) => b.count)) };
      };
      const personScore = (p: ReturnType<typeof evalPerson>) =>
        0.35 * (1 - p.count / cap.staffEventsPerDay) + 0.25 * (site ? clamp01(1 - ((p.near?.t ?? baseTravel) - 5) / 45) : 0.5) + 0.2 * relExp(p.u.id) + 0.2 * roleFit(p.u);

      let team: ReturnType<typeof evalPerson>[];
      let helped = false;
      if (fixed.length) {
        team = fixed.map(evalPerson);
        if (!team.every((p) => p.ok)) continue;
      } else {
        const pool = own.map(evalPerson).filter((p) => p.ok).sort((a, b) => personScore(b) - personScore(a));
        if (pool.length < staffCount) {
          const extra = helpers.map(evalPerson).filter((p) => p.ok).sort((a, b) => personScore(b) - personScore(a));
          if (pool.length + extra.length < staffCount) continue;
          team = [...pool, ...extra.slice(0, staffCount - pool.length)];
          helped = true;
        } else team = pool.slice(0, staffCount);
      }

      // 開始時刻: 全員の時刻の決まった予定を避けた最も早い時刻 (誰かに時刻未定の予定があれば時間帯だけ)
      let startTime: string | undefined;
      let endTime: string | undefined;
      if (team.every((p) => p.timedOnly)) {
        let t = roundUp(Math.max(startMin, ...team.map((p) => p.start ?? startMin)));
        for (; t + minutes <= win[1]; t += STEP) if (team.every((p) => days.every((d) => busyOf(p.u.id, d, win).timed.every(([s, e]) => t + minutes <= s || t >= e)))) break;
        if (t + minutes <= win[1]) {
          startTime = fromMinutes(t);
          endTime = fromMinutes(t + minutes);
        } else if (slot === "day") continue;
      }

      // 移動: 担当者のその日の現場のうち最も近いもの (なければ店舗から)
      const nearest = team.map((p) => p.near).filter(Boolean).sort((a, b) => a!.t - b!.t)[0];
      const travel = Math.min(nearest?.t ?? Infinity, baseTravel);
      const nearbyStore = (byStoreDay.get(`${store.id}|${day}`) ?? [])
        .filter((e) => SCHEDULE_KIND[e.kind]?.group === "case")
        .map((e) => ({ e, geo: geoOf(e) }))
        .filter((x): x is { e: ScheduleEvent; geo: GeoPoint } => Boolean(x.geo && site))
        .map((x) => ({ title: x.e.title, place: x.geo.label, km: Math.round(roadKm(x.geo, site!) * 10) / 10, mine: team.some((p) => x.e.assigneeIds.includes(p.u.id)) }))
        .filter((x) => x.km <= 12)
        .sort((a, b) => a.km - b.km)
        .slice(0, 3);

      // 担当者自身の移動に加え、同じ日に店舗のほかの担当が近くへ行く日も少し高くする (担当を合わせれば会社全体の移動が減る)
      const storeNear = nearbyStore.find((x) => !x.mine);
      const storeTravel = storeNear && site ? Math.round((storeNear.km / Math.max(10, cap.travelSpeedKmh)) * 60 + 5) : Infinity;
      const route = site ? Math.max(clamp01(1 - (travel - 5) / 45), 0.6 * clamp01(1 - (storeTravel - 5) / 45)) : 0.5;
      const capacityScore = clamp01(1 - used / capJobs);
      const productionScore = production ? clamp01(1 - prod / cap.tatamiPerDay) : 1;
      const staffScore = clamp01(1 - team.reduce((a, p) => a + p.count, 0) / team.length / cap.staffEventsPerDay);
      const earliness = clamp01(1 - i / Math.max(span, 7));
      const experience = clamp01(team.reduce((a, p) => a + relExp(p.u.id), 0) / team.length);
      const w = afterPickup
        ? { route: 0.2, capacity: 0.15, production: 0, staff: 0.1, earliness: 0.5, experience: 0.05 }
        : production
          ? { route: 0.3, capacity: 0.15, production: 0.15, staff: 0.15, earliness: 0.2, experience: 0.05 }
          : { route: 0.3, capacity: 0.25, production: 0, staff: 0.15, earliness: 0.2, experience: 0.05 };
      let score = w.route * route + w.capacity * capacityScore + w.production * productionScore + w.staff * staffScore + w.earliness * earliness + w.experience * experience;
      if (helped) score -= 0.08;
      if (startTime === undefined && slot !== "day") score -= 0.02;

      const reasons: string[] = [];
      const warnings: string[] = [];
      const near = nearest && nearest.t <= baseTravel ? nearest : undefined;
      if (site && near && near.t <= 25) reasons.push(`同じ日に担当者が近くの現場「${near.s.ev.title}」(${near.s.geo.label}) を回ります (約 ${Math.round(roadKm(near.s.geo, site) * 10) / 10} km・移動 ${near.t} 分)`);
      else if (site && storeNear && (baseKm === undefined || storeNear.km < baseKm - 1))
        reasons.push(`同じ日に${store.shortName}の別の予定「${storeNear.title}」が近く (${storeNear.place}・約 ${storeNear.km} km) にあります (担当を合わせると移動が減ります)`);
      else if (site && baseKm !== undefined) reasons.push(`${store.shortName}から約 ${Math.round(baseKm * 10) / 10} km (移動 ${baseTravel} 分)`);
      reasons.push(`${storeShort(store.id)}のこの日の${kindLabel}: ${used} 件 → ${used + 1} 件 (上限 ${capJobs} 件)`);
      if (production) reasons.push(`畳の製造: ${prod} 枚 → ${prod + tatami} 枚 (上限 ${cap.tatamiPerDay} 枚)`);
      reasons.push(`担当: ${team.map((p) => `${p.u.name} (この日の予定 ${p.count} 件)`).join("・")}`);
      if (afterPickup) reasons.push(`引き取り (${shortDate(afterPickup)}) から ${daysBetween(afterPickup, day)} 日後の納品${daysBetween(afterPickup, day) <= 1 ? " (翌日)" : ""}`);
      else if (i === 0) reasons.push("探した期間で最も早い日です");
      const expert = team.filter((p) => exp(p.u.id) >= 20);
      if (expert.length) reasons.push(`${expert.map((p) => `${p.u.name} は過去 1 年に${kindLabel}を ${exp(p.u.id)} 件担当`).join("・")}`);

      if (helped) warnings.push(`${team.filter((p) => p.u.storeId !== store.id).map((p) => `${p.u.name} (${storeShort(p.u.storeId)})`).join("・")} の応援が必要です`);
      for (const p of team) if (p.count + 1 >= cap.staffEventsPerDay) warnings.push(`${p.u.name}はこの日の予定が多め (${p.count + 1} 件。1 日の目安 ${cap.staffEventsPerDay} 件)`);
      if (used + 1 >= capJobs) warnings.push("この日の店舗の予定は上限に達します");
      if (production && prod + tatami > cap.tatamiPerDay * 0.85) warnings.push(prod === 0 && tatami > cap.tatamiPerDay ? `畳 ${tatami} 枚は 1 日の製造の上限 (${cap.tatamiPerDay} 枚) を超えます。分けて引き取るか、製造の日程を確認してください` : "畳の製造が上限に近くなります");
      if (startTime === undefined && slot !== "day") warnings.push("担当者に時刻未定の予定があるため、時刻は担当者と決めてください");
      if (!site) warnings.push("場所が分からないため、移動の距離は比べていません");

      const cand: SuggestCandidate = {
        date: day,
        endDate: duration > 1 ? days[days.length - 1] : undefined,
        slot,
        startTime,
        endTime,
        assigneeIds: team.map((p) => p.u.id),
        assigneeNames: team.map((p) => p.u.name),
        score: Math.max(0, Math.min(100, Math.round(score * 100))),
        reasons,
        warnings,
        travelMin: site ? travel : undefined,
        distanceKm: site && near ? Math.round(roadKm(near.s.geo, site) * 10) / 10 : baseKm !== undefined ? Math.round(baseKm * 10) / 10 : undefined,
        nearby: nearbyStore,
        load: { jobs: dayLoads[0].jobs, jobsCap: cap.jobsPerDay, visits: dayLoads[0].visits, visitsCap: cap.visitsPerDay, tatami: prod, tatamiCap: cap.tatamiPerDay },
        breakdown: { route, capacity: capacityScore, production: productionScore, staff: staffScore, earliness, experience },
      };
      all.push(cand);
      if (!best || cand.score > best.score) best = cand;
    }
    if (!best) noStaff++;
  }

  /* ---- 候補の選び方: 点数の高い順。同じ日は 2 件まで (違う日を並べる) ---- */
  const limit = Math.max(1, Math.min(10, input.limit ?? 5));
  const sorted = [...all].sort((a, b) => b.score - a.score || a.date.localeCompare(b.date));
  // まず違う日を 1 件ずつ。日が足りないときだけ、同じ日の別の時間帯を加える
  const candidates: SuggestCandidate[] = [];
  const days = new Set<string>();
  for (const c of sorted) {
    if (candidates.length >= limit) break;
    if (days.has(c.date)) continue;
    days.add(c.date);
    candidates.push(c);
  }
  for (const c of sorted) {
    if (candidates.length >= limit) break;
    if (!candidates.includes(c)) candidates.push(c);
  }
  candidates.sort((a, b) => b.score - a.score || a.date.localeCompare(b.date));
  const soonest = [...all].sort((a, b) => a.date.localeCompare(b.date) || b.score - a.score)[0];
  if (soonest && !candidates.some((c) => c.date === soonest.date)) notes.push(`最も早く入れられるのは ${shortDate(soonest.date)} (${soonest.slot === "am" ? "午前" : soonest.slot === "pm" ? "午後" : "終日"}・${soonest.score} 点) です。`);

  const src = cap.source;
  notes.push(
    `1 日の上限 (${store.shortName}): 現場作業 ${cap.jobsPerDay} 件 (${SOURCE_LABEL[src.jobsPerDay]})・営業の訪問 ${cap.visitsPerDay} 件 (${SOURCE_LABEL[src.visitsPerDay]})・畳の製造 ${cap.tatamiPerDay} 枚 (${SOURCE_LABEL[src.tatamiPerDay]})・1 人 ${cap.staffEventsPerDay} 件。予定表 → 「仕事量と提案の設定」で変更できます。`,
  );
  const windowCase = [...byStoreDay.entries()].filter(([k]) => k.startsWith(`${store.id}|`)).flatMap(([, evs]) => evs.filter((e) => SCHEDULE_KIND[e.kind]?.group === "case"));
  const unassigned = windowCase.filter((e) => !e.assigneeIds.length).length;
  if (!fixed.length && windowCase.length && unassigned / windowCase.length >= 0.5)
    notes.push(`この期間の${store.shortName}の案件の予定 ${windowCase.length} 件のうち ${unassigned} 件は担当者が未設定のため、担当者の空きは担当者が登録された予定だけで判断しています (店舗の件数の上限には含めています)。`);
  if (closed || full || noStaff) notes.push(`${shortDate(from)}〜${shortDate(to)} のうち、休業日 ${closed} 日・店舗の上限に達している日 ${full} 日・担当者の空きがない日 ${noStaff} 日を除きました。`);
  if (!candidates.length) notes.push("条件に合う日がありませんでした。探す期間を広げる、担当者・人数を変える、または上限の設定を見直してください。");
  if (tatami > 0 && kind !== "pickup") notes.push(`畳 ${tatami} 枚の案件です (畳の製造の上限は引き取りの日で確認します)。`);

  return {
    candidates,
    notes,
    site: site ? { label: site.label, precision: site.precision } : undefined,
    window: { from, to },
    tatamiCount: tatami,
    staffCount,
    minutes,
    capacity: { jobsPerDay: cap.jobsPerDay, visitsPerDay: cap.visitsPerDay, tatamiPerDay: cap.tatamiPerDay, source: cap.source, staffEventsPerDay: cap.staffEventsPerDay },
  };
}
