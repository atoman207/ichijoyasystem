import type { Customer, Database, Inquiry, Order, Quote, ScheduleEvent, StoreId, User } from "@/lib/db/types";
import { SCHEDULE_KIND } from "@/lib/constants";
import { canEditCaseStore, canReadStoreRecords } from "@/lib/auth/permissions";
import { policyReader } from "@/lib/access-policy";
import { lastDay, occursOn, periodLabel } from "@/lib/calendar";
import { addDays } from "@/lib/format";
import { eventLabeler, shortTown } from "@/lib/schedule-label";
import { geocodePlace, roadKm, type GeoPoint } from "@/lib/geo/kumamoto";
import { isClosedDay } from "@/lib/schedule-capacity";
import { areaStoreOf } from "@/lib/store-area";
import { customerPhoneDigits, phoneDigits } from "@/lib/customer-contacts";

/**
 * 予定表の検索と、場所からの訪問の候補日 (お客様のご要望 2026-11-25「予定表の検索機能と日程候補の自動提案」)
 * ------------------------------------------------------------
 * ① searchSchedule: お客様名・住所 (町名)・電話番号で予定と案件を探す。押すとその予定の日の予定表へ (予定の小さな画面を開く)。
 *    住所・町名で探したときは、その地域の今後の予定を日付の順に出す
 * ② placeCandidates: 住所・町名を入れると、今日からの日ごとに 同じ町名の予定がある日 / 近隣 (目安の距離) に予定がある日 / 予定が 1〜3 件の余裕のある日 /
 *    予定のない日 を出す (休業日は除く)。距離は社内の目安 (src/lib/geo/kumamoto.ts。外部の地図サービスは使わない)。日付の近い順
 * ③ 候補の日を押すとその日の予定表、「この日に予定を登録」で予定の入力 (場所・案件つき)
 */

const compact = (s: string | undefined | null) => (s ?? "").normalize("NFKC").replace(/[\s　,，、・()（）-]/g, "").replace(/ヶ/g, "ケ").toLowerCase();

interface EventIndex {
  orders: Map<string, Order>;
  quotes: Map<string, Quote>;
  inquiries: Map<string, Inquiry>;
  customers: Map<string, Customer>;
}

function indexOf(db: Database): EventIndex {
  return {
    orders: new Map(db.orders.map((o) => [o.id, o])),
    quotes: new Map(db.quotes.map((q) => [q.id, q])),
    inquiries: new Map(db.inquiries.map((i) => [i.id, i])),
    customers: new Map(db.customers.map((c) => [c.id, c])),
  };
}

/** 予定の現場の住所の文字 (この予定だけの場所 → 受注・見積・問い合わせの施工現場 → 個人のお客様の住所 → 問い合わせで聞いた住所 → 地区) */
export function eventPlaceText(ix: EventIndex, e: ScheduleEvent, customer?: Customer): string {
  const o = e.orderId ? ix.orders.get(e.orderId) : undefined;
  const q = e.quoteId ? ix.quotes.get(e.quoteId) : o?.quoteId ? ix.quotes.get(o.quoteId) : undefined;
  const inq = e.inquiryId ? ix.inquiries.get(e.inquiryId) : q?.inquiryId ? ix.inquiries.get(q.inquiryId) : undefined;
  const own = customer?.type !== "corporate" ? customer?.address : undefined;
  return e.location?.trim() || o?.siteAddress || q?.siteAddress || inq?.siteAddress || own || inq?.intake?.address || customer?.area || inq?.area || "";
}

export interface FindEventHit {
  id: string;
  date: string;
  period: string;
  kind: string;
  /** 予定表の件名 (例: (須屋) 山田) */
  label: string;
  storeId: StoreId;
  storeName: string;
  assignees: string;
  /** 現場の町名・住所 (見られるとき) */
  place: string;
  /** 何で当たったか (お名前・住所・電話・件名) */
  reason: string;
  upcoming: boolean;
  /** その日の予定表を開いて、予定の小さな画面を出す */
  href: string;
}

export interface FindCaseHit {
  id: string;
  label: string;
  title: string;
  customer: string;
  place: string;
  href: string;
  /** この案件の住所で候補日を探す */
  findHref: string;
}

export interface FindResult {
  query: string;
  mode: "phone" | "text";
  events: FindEventHit[];
  /** 今日以降の予定のない進行中の案件 (日程を決めていない案件) */
  cases: FindCaseHit[];
  /** 住所・町名として当たった予定の数 (地域の今後の予定) */
  areaCount: number;
}

const OPEN_INQ = new Set(["new", "in_progress", "quoted"]);
const OPEN_ORDER = new Set(["confirmed", "scheduled", "in_progress", "pending_approval", "returned"]);

export function scheduleHref(e: Pick<ScheduleEvent, "id" | "date" | "storeId">): string {
  return `/schedule?view=day&date=${e.date}&store=${e.storeId}&qe=${encodeURIComponent(e.id)}`;
}

/** ① 予定と案件を探す (お客様名・ふりがな・住所・町名・電話番号・件名) */
export function searchSchedule(db: Database, user: User, raw: string, today: string): FindResult {
  const query = raw.trim().slice(0, 60);
  const digits = phoneDigits(query);
  const mode: FindResult["mode"] = digits.length >= 4 && /^[\d\-\s()+－ー]+$/.test(query) ? "phone" : "text";
  const term = compact(query);
  const out: FindResult = { query, mode, events: [], cases: [], areaCount: 0 };
  if ((mode === "text" && term.length < 2) || (mode === "phone" && digits.length < 4)) return out;
  const ix = indexOf(db);
  const labeler = eventLabeler(db);
  const reader = policyReader(db, user);
  const canSee = (c?: Customer) => !c || canReadStoreRecords(reader, c.storeId) || canEditCaseStore(user, c.storeId);
  const names = new Map(db.users.map((u) => [u.id, u.name.split(/[\s　]/)[0]]));
  const stores = new Map(db.stores.map((s) => [s.id, s.shortName || s.name]));
  const hits: (FindEventHit & { sort: string })[] = [];
  for (const e of db.schedule) {
    if (e.companyWide || SCHEDULE_KIND[e.kind].group !== "case") continue;
    const label = labeler.label(e);
    const customer = labeler.customerOf(e);
    const visible = canSee(customer);
    const inq = e.inquiryId ? ix.inquiries.get(e.inquiryId) : undefined;
    const place = visible ? eventPlaceText(ix, e, customer) : label.area ?? "";
    let reason = "";
    if (mode === "phone") {
      if (!visible) continue;
      const phones = [...(customer ? customerPhoneDigits(customer) : []), phoneDigits(inq?.contactPhone), phoneDigits(inq?.intake?.phone)].filter((d) => d.length >= 4);
      if (phones.some((d) => d.includes(digits))) reason = "電話番号";
    } else {
      if (visible && compact(place).includes(term)) reason = "住所・町名";
      else if (label.area && compact(label.area).includes(term)) reason = "町名";
      else if (customer && (compact(customer.name).includes(term) || compact(customer.kana).includes(term))) reason = "お客様名";
      else if (compact(inq?.contactName).includes(term) || compact(e.title).includes(term)) reason = "お客様名・件名";
      else if (visible && customer?.address && compact(customer.address).includes(term)) reason = "依頼主の住所";
    }
    if (!reason) continue;
    const upcoming = lastDay(e) >= today;
    hits.push({
      id: e.id,
      date: e.date,
      period: periodLabel(e),
      kind: SCHEDULE_KIND[e.kind].label,
      label: label.text,
      storeId: e.storeId,
      storeName: stores.get(e.storeId) ?? e.storeId,
      assignees: e.assigneeIds.map((a) => names.get(a) ?? "-").join("・") || "未定",
      place,
      reason,
      upcoming,
      href: scheduleHref(e),
      // 今後の予定 (近い順) → 過去の予定 (新しい順)
      sort: upcoming ? `0${e.date}${e.startTime ?? ""}` : `1${String(99999999 - Number(e.date.replace(/-/g, ""))).padStart(8, "0")}`,
    });
  }
  hits.sort((a, b) => a.sort.localeCompare(b.sort));
  out.areaCount = hits.filter((h) => h.upcoming && (h.reason === "住所・町名" || h.reason === "町名")).length;
  const up = hits.filter((h) => h.upcoming).slice(0, 40);
  const past = hits.filter((h) => !h.upcoming).slice(0, 20);
  out.events = [...up, ...past].map((h) => {
    const { sort, ...rest } = h;
    void sort;
    return rest;
  });
  // 予定のない進行中の案件 (問い合わせ・受注)。日程を決めるために候補日を探せる
  const withUpcoming = new Set<string>();
  for (const e of db.schedule) if (lastDay(e) >= today) for (const k of [e.inquiryId, e.quoteId, e.orderId]) if (k) withUpcoming.add(k);
  const pushCase = (id: string, label: string, title: string, c: Customer | undefined, place: string, href: string) => {
    if (out.cases.length >= 10) return;
    out.cases.push({ id, label, title, customer: c ? `${c.name} 様` : "", place, href, findHref: `/schedule?find=${encodeURIComponent(place || c?.address || "")}&findCase=${encodeURIComponent(id)}` });
  };
  const matchCase = (c: Customer | undefined, place: string, extraPhones: (string | undefined)[], extraName?: string) => {
    if (!canSee(c)) return false;
    if (mode === "phone") return [...(c ? customerPhoneDigits(c) : []), ...extraPhones.map(phoneDigits)].some((d) => d.length >= 4 && d.includes(digits));
    return compact(place).includes(term) || (c ? compact(c.name).includes(term) || compact(c.kana).includes(term) || compact(c.address).includes(term) : false) || compact(extraName).includes(term);
  };
  for (const o of db.orders) {
    if (!OPEN_ORDER.has(o.status) || withUpcoming.has(o.id)) continue;
    const c = ix.customers.get(o.customerId);
    const place = o.siteAddress || c?.address || "";
    if (matchCase(c, place, [])) pushCase(o.id, `受注 ${o.number}`, o.title, c, place, `/orders/${o.id}`);
  }
  for (const i of db.inquiries) {
    if (!OPEN_INQ.has(i.status) || i.quoteId || withUpcoming.has(i.id)) continue;
    const c = i.customerId ? ix.customers.get(i.customerId) : undefined;
    const place = i.siteAddress || c?.address || i.intake?.address || "";
    if (matchCase(c, place, [i.contactPhone, i.intake?.phone], i.contactName)) pushCase(i.id, `問い合わせ ${i.number}`, i.summary, c ?? ({ name: i.contactName } as Customer), place, `/inquiries/${i.id}`);
  }
  return out;
}

/* ---------------- ② 場所からの候補日 ---------------- */

export type CandidateTier = "same" | "near" | "light" | "free" | "busy";

export const CANDIDATE_TIER_LABEL: Record<CandidateTier, string> = { same: "同じ町名に予定あり", near: "近くに予定あり", light: "予定が少ない日", free: "予定なし", busy: "予定が多い日" };

/** 余裕のある日とみなす予定の数 (お客様のご要望「まだ予定が 1〜3 件程度」) */
export const LIGHT_MAX = 3;

export interface CandidateEvent {
  id: string;
  period: string;
  kind: string;
  label: string;
  town: string;
  /** 訪問先からの道のりの目安 (km) */
  km?: number;
  href: string;
}

export interface CandidateDay {
  date: string;
  tier: CandidateTier;
  /** その日の予定の数 (店舗・案件の予定) */
  count: number;
  /** 同じ町名の予定 */
  same: CandidateEvent[];
  /** 近隣の予定 (近い順) */
  near: CandidateEvent[];
  /** いちばん近い予定までの目安 (km) */
  nearestKm?: number;
  dayHref: string;
}

export interface CandidateResult {
  address: string;
  town: string;
  /** 訪問先の位置の目安 (分からなければ町名だけで比べる) */
  located: string;
  storeId?: StoreId;
  storeName: string;
  nearKm: number;
  days: CandidateDay[];
}

/**
 * ② 場所 (住所・町名) から訪問の候補日を出す。storeId を省くと住所の担当エリアの店舗 (決まらなければ全店舗) の予定で比べる。
 * 日付の近い順 (休業日を除く)。予定が多くて近くに予定のない日は busy (画面では最後に・既定は隠す)
 */
export function placeCandidates(db: Database, opts: { address: string; storeId?: StoreId | "all"; today: string; days?: number; nearKm?: number }): CandidateResult {
  const address = opts.address.trim().slice(0, 120);
  const nearKm = opts.nearKm ?? 6;
  const days = Math.min(Math.max(opts.days ?? 30, 7), 90);
  const area = opts.storeId ? undefined : areaStoreOf(db, address);
  const storeId: StoreId | undefined = opts.storeId === "all" ? undefined : (opts.storeId ?? area?.storeId);
  const target: GeoPoint | undefined = geocodePlace(address, { storeId, customers: db.customers });
  const town = shortTown(address) || compact(address).slice(0, 8);
  const ix = indexOf(db);
  const labeler = eventLabeler(db);
  const geoCache = new Map<string, GeoPoint | undefined>();
  const out: CandidateResult = { address, town, located: target?.label ?? "", storeId, storeName: storeId ? (db.stores.find((s) => s.id === storeId)?.name ?? storeId) : "全店舗", nearKm, days: [] };
  if (!address) return out;
  const events = db.schedule.filter((e) => !e.companyWide && SCHEDULE_KIND[e.kind].group === "case" && (!storeId || e.storeId === storeId) && lastDay(e) >= opts.today);
  for (let i = 0; i < days; i++) {
    const date = addDays(opts.today, i);
    if (isClosedDay(db, date)) continue;
    const todays = events.filter((e) => occursOn(e, date));
    const same: CandidateEvent[] = [];
    const near: CandidateEvent[] = [];
    let nearestKm: number | undefined;
    for (const e of todays) {
      const label = labeler.label(e);
      const customer = labeler.customerOf(e);
      const placeText = eventPlaceText(ix, e, customer);
      const eTown = label.area || shortTown(placeText);
      const base = { id: e.id, period: periodLabel(e), kind: SCHEDULE_KIND[e.kind].label, label: label.text, town: eTown, href: scheduleHref(e) };
      if (town && eTown && (compact(eTown) === compact(town) || compact(eTown).includes(compact(town)) || compact(town).includes(compact(eTown)))) {
        same.push({ ...base, km: 0 });
        nearestKm = 0;
        continue;
      }
      if (!target) continue;
      if (!geoCache.has(e.id)) geoCache.set(e.id, geocodePlace(placeText, { storeId: e.storeId, customers: db.customers, title: e.title }));
      const g = geoCache.get(e.id);
      if (!g) continue;
      const km = Math.round(roadKm(target, g) * 10) / 10;
      if (nearestKm === undefined || km < nearestKm) nearestKm = km;
      if (km <= nearKm) near.push({ ...base, km });
    }
    near.sort((a, b) => (a.km ?? 99) - (b.km ?? 99));
    const count = todays.length;
    const tier: CandidateTier = same.length ? "same" : near.length ? "near" : count === 0 ? "free" : count <= LIGHT_MAX ? "light" : "busy";
    out.days.push({ date, tier, count, same, near: near.slice(0, 5), nearestKm, dayHref: `/schedule?view=day&date=${date}${storeId ? `&store=${storeId}` : "&store=all"}` });
  }
  return out;
}

/** おすすめの順 (同じ町名 → 近隣 (近い順) → 予定が少ない日 → 予定なし → 予定が多い日、同じなら日付の順) */
export function rankCandidates(days: CandidateDay[]): CandidateDay[] {
  const rank: Record<CandidateTier, number> = { same: 0, near: 1, light: 2, free: 3, busy: 4 };
  return [...days].sort((a, b) => rank[a.tier] - rank[b.tier] || (a.tier === "near" ? (a.nearestKm ?? 99) - (b.nearestKm ?? 99) : 0) || a.date.localeCompare(b.date));
}

/** 日付の表示 (11/27(木)) */
export function dayLabel(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${"日月火水木金土"[d.getUTCDay()]})`;
}
