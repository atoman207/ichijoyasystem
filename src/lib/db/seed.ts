import type {

  AuditAction,
  AuditChange,
  AuditLog,
  CapturedDocument,
  Channel,

  Customer,
  Database,
  Expense,
  Inquiry,
  Invoice,

  Order,
  Payment,
  Product,
  PurchaseInvoice,
  Quote,
  QuoteItem,
  ScheduleEvent,
  ServiceCategory,
  StoreId,
  Thread,
} from "./types";
import { PRODUCTS, SALES_BY_STORE, STORES, SUPPLIERS, USERS, WORKER_BY_STORE } from "./master";
import { addDays, calcTax, daysBetween, parseDate, toDateKey } from "@/lib/format";
import { APPROVAL_RULES, CATEGORY_LABEL } from "@/lib/constants";
import { compareEvents, dateRange, dayInterval, eventDays, fromMinutes, isOffDay, sameCase, weekStart } from "@/lib/calendar";
import { DATA_VERSION } from "./migrate";

/**
 * サンプルデータ生成
 * ------------------------------------------------------------
 * 「今日」を基準に過去 13 か月分の案件 (問い合わせ→見積→受注→施工→請求→入金) を
 * 決定論的な乱数で生成し、さらに各ロールで操作を試せる「承認待ち」などの
 * デモ用レコードを明示的に追加する。
 */

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SURNAMES: [string, string][] = [
  ["佐々木", "ササキ"], ["山口", "ヤマグチ"], ["松田", "マツダ"], ["井上", "イノウエ"], ["岡田", "オカダ"],
  ["前田", "マエダ"], ["藤田", "フジタ"], ["後藤", "ゴトウ"], ["村上", "ムラカミ"], ["石井", "イシイ"],
  ["坂本", "サカモト"], ["森", "モリ"], ["上田", "ウエダ"], ["原田", "ハラダ"], ["中島", "ナカシマ"],
  ["宮崎", "ミヤザキ"], ["大塚", "オオツカ"], ["平野", "ヒラノ"], ["菊池", "キクチ"], ["野口", "ノグチ"],
  ["福田", "フクダ"], ["西村", "ニシムラ"], ["竹内", "タケウチ"], ["横山", "ヨコヤマ"], ["岩崎", "イワサキ"],
  ["緒方", "オガタ"], ["松岡", "マツオカ"], ["宮本", "ミヤモト"], ["本田", "ホンダ"], ["永田", "ナガタ"],
];
const GIVEN: [string, string][] = [
  ["和子", "カズコ"], ["博", "ヒロシ"], ["幸子", "サチコ"], ["健", "ケン"], ["恵子", "ケイコ"],
  ["誠", "マコト"], ["美智子", "ミチコ"], ["隆", "タカシ"], ["洋子", "ヨウコ"], ["浩", "ヒロシ"],
  ["久美子", "クミコ"], ["徹", "トオル"], ["裕子", "ユウコ"], ["修", "オサム"], ["由美", "ユミ"],
  ["茂", "シゲル"], ["典子", "ノリコ"], ["勝", "マサル"], ["真理", "マリ"], ["学", "マナブ"],
];
const CORPORATE: [string, string, string][] = [
  ["社会福祉法人 清風会 デイサービスせいふう", "セイフウカイ", "koshi"],
  ["旅館 菊池温泉 松乃家", "マツノヤ", "koshi"],
  ["宗教法人 蓮華寺", "レンゲジ", "chuo"],
  ["有限会社 熊本ハウジング (管理物件)", "クマモトハウジング", "chuo"],
  ["株式会社 肥後建設", "ヒゴケンセツ", "nishi"],
  ["介護老人保健施設 さくら苑", "サクラエン", "tamana"],
  ["学校法人 玉名学園 こども園", "タマナガクエン", "tamana"],
  ["坪井地域コミュニティセンター", "ツボイチイキコミュニティセンター", "hq"],
];
const AREAS: Record<StoreId, [string, string][]> = {
  koshi: [["861-1102", "熊本県合志市須屋"], ["861-1104", "熊本県合志市御代志"], ["861-1112", "熊本県合志市幾久富"], ["869-1101", "熊本県菊池郡菊陽町津久礼"], ["869-1235", "熊本県菊池郡大津町室"], ["861-1331", "熊本県菊池市隈府"]],
  chuo: [["862-0926", "熊本県熊本市東区保田窪"], ["861-8003", "熊本県熊本市東区長嶺"], ["862-0920", "熊本県熊本市東区月出"], ["861-8001", "熊本県熊本市北区武蔵ヶ丘"], ["860-0811", "熊本県熊本市中央区本荘"]],
  nishi: [["861-4101", "熊本県熊本市南区近見"], ["861-4131", "熊本県熊本市南区薄場"], ["860-0063", "熊本県熊本市西区島崎"], ["869-0433", "熊本県宇土市栗崎町"], ["861-3101", "熊本県上益城郡嘉島町鯰"]],
  tamana: [["865-0023", "熊本県玉名市大倉"], ["865-0061", "熊本県玉名市立願寺"], ["864-0041", "熊本県荒尾市荒尾"], ["869-0123", "熊本県玉名郡長洲町長洲"], ["861-0501", "熊本県山鹿市山鹿"]],
  hq: [["860-0863", "熊本県熊本市中央区坪井"], ["860-0862", "熊本県熊本市中央区黒髪"], ["860-0079", "熊本県熊本市中央区上熊本"]],
};
const TAGS = ["リピーター", "OB客", "紹介", "高齢者宅", "LINE登録", "DM可", "土日希望", "法人"];

const TITLES: Record<ServiceCategory, string[]> = {
  tatami: ["和室6畳 畳表替え", "和室8畳 畳表替え", "和室4.5畳 畳表替え", "二間続き 畳表替え", "和室 へり無し畳へ新調", "新築和室 畳新調"],
  fusuma: ["襖張替え (押入・間仕切)", "襖張替え 4枚", "襖張替え 6枚", "客間 襖張替え"],
  shoji: ["障子張替え", "障子張替え (縁側)", "障子張替え 全室"],
  amido: ["網戸張替え", "網戸張替え (全窓)", "ペット対応 網戸張替え"],
  curtain: ["リビング オーダーカーテン", "寝室 カーテン・ブラインド"],
  cloth: ["和室 クロス張替え", "居間 クロス張替え"],
  other: ["その他 内装工事"],
};

/** 予定表の空き管理 (シード生成時に担当者の予定が重ならないようにする) */
interface BusySlot {
  s: number;
  e: number;
  id: string;
  orderId?: string;
  quoteId?: string;
  inquiryId?: string;
}

interface Ctx {
  now: Date;
  today: string;
  rand: () => number;
  db: Database;
  counters: Record<string, number>;
  /** `${userId}|${YYYY-MM-DD}` → その日の予定の時間帯 */
  busy: Map<string, BusySlot[]>;
}

function at(dateKey: string, h = 9, m = 0): string {
  const d = parseDate(dateKey);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}

function yearOf(dateKey: string): string {
  return dateKey.slice(0, 4);
}

export function createSeed(now = new Date()): Database {
  const rand = mulberry32(20261110);
  const today = toDateKey(now);
  const db: Database = {
    meta: { version: DATA_VERSION, seededAt: now.toISOString() },
    stores: STORES.map((s) => ({ ...s })),
    users: USERS.map((u) => ({ ...u })),
    customers: [],
    inquiries: [],
    products: PRODUCTS.map((p) => ({ ...p })),
    quotes: [],
    orders: [],
    invoices: [],
    payments: [],
    expenses: [],
    suppliers: SUPPLIERS.map((s) => ({ ...s })),
    purchases: [],
    approvals: [],
    auditLogs: [],
    commLogs: [],
    threads: [],
    messages: [],
    schedule: [],
    documents: [],
    holidays: [],
    surveys: [],
    sourceFiles: [],
    photoAlbums: [],
  };
  const ctx: Ctx = { now, today, rand, db, counters: {}, busy: new Map() };

  seedCustomers(ctx);
  seedCompanyCalendar(ctx);
  seedDeals(ctx);
  ensureInProgress(ctx);
  seedShowcase(ctx);
  seedExpensesAndPurchases(ctx);
  seedThreads(ctx);
  seedDocuments(ctx);
  finalize(ctx);
  return db;
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function pick<T>(ctx: Ctx, arr: readonly T[]): T {
  return arr[Math.floor(ctx.rand() * arr.length)];
}
function between(ctx: Ctx, min: number, max: number): number {
  return min + Math.floor(ctx.rand() * (max - min + 1));
}
function chance(ctx: Ctx, p: number): boolean {
  return ctx.rand() < p;
}
function weighted<T>(ctx: Ctx, entries: [T, number][]): T {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = ctx.rand() * total;
  for (const [v, w] of entries) {
    r -= w;
    if (r <= 0) return v;
  }
  return entries[entries.length - 1][0];
}
function nextId(ctx: Ctx, prefix: string): string {
  ctx.counters[prefix] = (ctx.counters[prefix] ?? 0) + 1;
  return `${prefix}_${String(ctx.counters[prefix]).padStart(4, "0")}`;
}
function nextNumber(ctx: Ctx, prefix: string, dateKey: string): string {
  const key = `${prefix}-${yearOf(dateKey)}`;
  ctx.counters[key] = (ctx.counters[key] ?? 0) + 1;
  return `${key}-${String(ctx.counters[key]).padStart(4, "0")}`;
}
function audit(
  ctx: Ctx,
  atIso: string,
  userId: string,
  action: AuditAction,
  entity: string,
  entityId: string,
  entityLabel: string,
  summary: string,
  storeId?: StoreId,
  changes?: AuditChange[],
) {
  const log: AuditLog = {
    id: nextId(ctx, "log"),
    at: atIso,
    userId,
    action,
    entity,
    entityId,
    entityLabel,
    summary,
    storeId,
  };
  if (changes) log.changes = changes;
  ctx.db.auditLogs.push(log);
}
function product(id: string): Product {
  const p = PRODUCTS.find((x) => x.id === id);
  if (!p) throw new Error(`unknown product ${id}`);
  return p;
}
function item(ctx: Ctx, p: Product, qty: number, spec?: string): QuoteItem {
  return {
    id: nextId(ctx, "qi"),
    productId: p.id,
    name: p.name,
    spec: spec ?? ([p.grade, p.sizeLabel].filter(Boolean).join(" / ") || undefined),
    qty,
    unit: p.unit,
    unitPrice: p.unitPrice,
    amount: Math.round(p.unitPrice * qty),
  };
}
export function totals(items: QuoteItem[], discount = 0) {
  const subtotal = items.reduce((s, i) => s + i.amount, 0);
  const tax = calcTax(subtotal - discount);
  return { subtotal, discount, tax, total: subtotal - discount + tax };
}

/* ---------------- 予定 (担当者の空きを見て配置する) ---------------- */

type Linked = { orderId?: string; quoteId?: string; inquiryId?: string };

function reserve(ctx: Ctx, ev: ScheduleEvent) {
  const [s, e] = dayInterval(ev);
  for (const d of eventDays(ev)) {
    for (const u of ev.assigneeIds) {
      const key = `${u}|${d}`;
      const list = ctx.busy.get(key) ?? [];
      list.push({ s, e, id: ev.id, orderId: ev.orderId, quoteId: ev.quoteId, inquiryId: ev.inquiryId });
      ctx.busy.set(key, list);
    }
  }
}

function release(ctx: Ctx, ev: ScheduleEvent) {
  for (const [key, list] of ctx.busy) {
    const next = list.filter((b) => b.id !== ev.id);
    if (next.length !== list.length) ctx.busy.set(key, next);
  }
}

function isFree(ctx: Ctx, userIds: string[], days: string[], s: number, e: number, link?: Linked): boolean {
  for (const d of days) {
    for (const u of userIds) {
      for (const b of ctx.busy.get(`${u}|${d}`) ?? []) {
        if (link && sameCase(link, b)) continue;
        if (s < b.e && b.s < e) return false;
      }
    }
  }
  return true;
}

/** date 以降で、全員が空いている最初の枠 (日曜・祝日は避ける)。見つからなければ date の最初の候補 */
function findSlot(ctx: Ctx, userIds: string[], date: string, minutes: number, hours: number[], opts: { days?: number; link?: Linked } = {}) {
  const len = opts.days ?? 1;
  for (let shift = 0; shift < 90; shift++) {
    const d = addDays(date, shift);
    const span = dateRange(d, addDays(d, len - 1));
    if (span.some(isOffDay)) continue;
    for (const h of hours) {
      const s = Math.round(h * 60);
      if (isFree(ctx, userIds, span, s, s + minutes, opts.link)) return { date: d, start: fromMinutes(s), end: fromMinutes(s + minutes) };
    }
  }
  return { date, start: fromMinutes(hours[0] * 60), end: fromMinutes(hours[0] * 60 + minutes) };
}

function shuffled<T>(ctx: Ctx, arr: readonly T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(ctx.rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function addEvent(ctx: Ctx, p: Omit<ScheduleEvent, "id">): ScheduleEvent {
  const ev: ScheduleEvent = { id: nextId(ctx, "ev"), source: "manual", ...p };
  ctx.db.schedule.push(ev);
  reserve(ctx, ev);
  return ev;
}

function by(userId: string, atIso: string) {
  return { createdBy: userId, createdAt: atIso, updatedBy: userId, updatedAt: atIso };
}

/** d 以降で最初の平日 (日曜・祝日以外) */
function workday(d: string): string {
  let x = d;
  while (isOffDay(x)) x = addDays(x, 1);
  return x;
}

function managerOf(storeId: StoreId): string {
  return STORES.find((s) => s.id === storeId)?.managerUserId ?? "u01";
}
function requiredRoleFor(storeId: StoreId, amount: number, threshold: number): "store_manager" | "admin" {
  if (storeId === "hq") return "admin";
  return amount >= threshold ? "admin" : "store_manager";
}

/* ------------------------------------------------------------------ */
/* customers                                                           */
/* ------------------------------------------------------------------ */

function seedCustomers(ctx: Ctx) {
  const { db } = ctx;
  const storeIds: StoreId[] = ["koshi", "chuo", "nishi", "tamana", "hq"];
  const perStore: Record<StoreId, number> = { koshi: 10, chuo: 9, nishi: 8, tamana: 8, hq: 4 };
  let n = 0;
  for (const storeId of storeIds) {
    for (let i = 0; i < perStore[storeId]; i++) {
      n++;
      const [sn, snk] = SURNAMES[(n * 7) % SURNAMES.length];
      const [gn, gnk] = GIVEN[(n * 3) % GIVEN.length];
      const [postal, area] = pick(ctx, AREAS[storeId]);
      const createdDays = between(ctx, 30, 900);
      const createdAt = at(addDays(ctx.today, -createdDays), between(ctx, 9, 17), between(ctx, 0, 59));
      const first = weighted<Channel>(ctx, [["phone", 35], ["line", 18], ["web", 15], ["visit", 12], ["referral", 8], ["event", 5], ["email", 4], ["ai_phone", 3]]);
      const tags = [...new Set([pick(ctx, TAGS), chance(ctx, 0.4) ? pick(ctx, TAGS) : ""])].filter((t) => t && t !== "法人");
      db.customers.push({
        id: nextId(ctx, "cust"),
        code: `C-${String(n).padStart(5, "0")}`,
        name: `${sn} ${gn}`,
        kana: `${snk} ${gnk}`,
        type: "individual",
        phone: chance(ctx, 0.6) ? `090-${between(ctx, 1000, 9999)}-${between(ctx, 1000, 9999)}` : `096-${between(ctx, 200, 399)}-${between(ctx, 1000, 9999)}`,
        email: chance(ctx, 0.45) ? `customer${n}@example.com` : undefined,
        lineId: first === "line" || chance(ctx, 0.3) ? `line_${n}` : undefined,
        postalCode: postal,
        address: `${area}${between(ctx, 1, 5)}丁目${between(ctx, 1, 30)}-${between(ctx, 1, 20)}`,
        storeId,
        assignedUserId: SALES_BY_STORE[storeId],
        preferredChannel: first === "ai_phone" ? "phone" : first === "event" || first === "referral" ? "phone" : first,
        firstContactChannel: first,
        tags,
        notes: chance(ctx, 0.3) ? "駐車は敷地内可。訪問前に電話連絡希望。" : "",
        createdAt,
        updatedAt: createdAt,
      });
    }
  }
  for (const [name, kana, storeId] of CORPORATE) {
    n++;
    const [postal, area] = pick(ctx, AREAS[storeId as StoreId]);
    const createdAt = at(addDays(ctx.today, -between(ctx, 60, 1200)), 10, 0);
    db.customers.push({
      id: nextId(ctx, "cust"),
      code: `C-${String(n).padStart(5, "0")}`,
      name,
      kana,
      type: "corporate",
      phone: `096-${between(ctx, 200, 399)}-${between(ctx, 1000, 9999)}`,
      email: `info${n}@example.co.jp`,
      postalCode: postal,
      address: `${area}${between(ctx, 1, 5)}丁目${between(ctx, 1, 30)}-${between(ctx, 1, 20)}`,
      storeId: storeId as StoreId,
      assignedUserId: SALES_BY_STORE[storeId],
      preferredChannel: "email",
      firstContactChannel: "phone",
      tags: ["法人", "請求書払い"],
      notes: "請求書は月末締め。担当者宛にメール送付。",
      createdAt,
      updatedAt: createdAt,
    });
  }
}

/* ------------------------------------------------------------------ */
/* deals (inquiry -> quote -> order -> invoice -> payment)              */
/* ------------------------------------------------------------------ */

function buildItems(ctx: Ctx, category: ServiceCategory): QuoteItem[] {
  const misc = item(ctx, product("p_misc"), 1);
  switch (category) {
    case "tatami": {
      const grade = weighted(ctx, [["p_t_kizuna", 25], ["p_t_nagomi", 20], ["p_t_sakura", 18], ["p_t_yasuragi", 15], ["p_t_koto", 10], ["p_t_megumi", 8], ["p_t_kiwami", 2], ["p_t_herinashi", 6], ["p_t_shincho", 4]]);
      if (grade === "p_t_herinashi") {
        const qty = pick(ctx, [8, 9, 12, 16]);
        return [item(ctx, product(grade), qty), item(ctx, product("p_t_disposal"), qty / 2), misc];
      }
      const qty = pick(ctx, [4.5, 6, 6, 6, 8, 8, 10, 12]);
      return [item(ctx, product(grade), qty), item(ctx, product("p_t_disposal"), qty), misc];
    }
    case "fusuma": {
      const grade = weighted(ctx, [["p_f_nozomi", 35], ["p_f_chidori", 25], ["p_f_suzaku", 20], ["p_f_shizuka", 15], ["p_f_torinoko", 5]]);
      return [item(ctx, product(grade), pick(ctx, [2, 4, 4, 6, 8])), misc];
    }
    case "shoji": {
      const grade = pick(ctx, ["eco", "strike", "puraka", "warlon"]);
      const items = [item(ctx, product(`p_s_${grade}_l`), pick(ctx, [2, 4, 4, 6]))];
      if (chance(ctx, 0.5)) items.push(item(ctx, product(`p_s_${grade}_m`), pick(ctx, [1, 2])));
      items.push(misc);
      return items;
    }
    case "amido": {
      const grade = pick(ctx, ["18", "24", "24", "pet"]);
      const items = [item(ctx, product(`p_a_${grade}_l`), pick(ctx, [2, 3, 4, 6]))];
      if (chance(ctx, 0.5)) items.push(item(ctx, product(`p_a_${grade}_m`), pick(ctx, [1, 2])));
      items.push(misc);
      return items;
    }
    case "curtain": {
      const items = [item(ctx, product("p_c_curtain"), pick(ctx, [1, 2, 3]))];
      if (chance(ctx, 0.5)) items.push(item(ctx, product("p_c_blind"), pick(ctx, [1, 2])));
      items.push(misc);
      return items;
    }
    case "cloth":
      return [item(ctx, product("p_w_cloth"), pick(ctx, [24, 32, 40, 55])), misc];
    default:
      return [misc];
  }
}

function seedDeals(ctx: Ctx) {
  const { db } = ctx;
  const DEALS = 240;
  for (let i = 0; i < DEALS; i++) {
    const storeId = weighted<StoreId>(ctx, [["koshi", 30], ["chuo", 27], ["nishi", 22], ["tamana", 18], ["hq", 6]]);
    const candidates = db.customers.filter((c) => c.storeId === storeId);
    const customer = pick(ctx, candidates);
    const category = weighted<ServiceCategory>(ctx, [["tatami", 52], ["fusuma", 18], ["shoji", 11], ["amido", 9], ["curtain", 5], ["cloth", 5]]);
    const ageDays = chance(ctx, 0.3) ? between(ctx, 6, 50) : between(ctx, 51, 395);
    const inqDate = addDays(ctx.today, -ageDays);
    const channel = weighted<Channel>(ctx, [["phone", 34], ["line", 20], ["web", 14], ["visit", 12], ["ai_phone", 8], ["referral", 5], ["email", 4], ["event", 3]]);
    const sales = SALES_BY_STORE[storeId];
    const worker = WORKER_BY_STORE[storeId];
    const title = pick(ctx, TITLES[category]);
    const receivedAt = at(inqDate, between(ctx, 9, 17), between(ctx, 0, 59));

    const inquiry: Inquiry = {
      id: nextId(ctx, "inq"),
      number: nextNumber(ctx, "INQ", inqDate),
      customerId: customer.id,
      contactName: customer.name,
      contactPhone: customer.phone,
      channel,
      storeId,
      category,
      summary: `${CATEGORY_LABEL[category]}: ${title}`,
      detail: `${customer.name} 様より ${title} のご相談。現地調査の上で見積を提出する。`,
      status: "in_progress",
      assignedUserId: sales,
      receivedAt,
      createdBy: channel === "ai_phone" || channel === "web" ? "u15" : sales,
      updatedAt: receivedAt,
    };
    db.inquiries.push(inquiry);
    audit(ctx, receivedAt, inquiry.createdBy, "create", "inquiry", inquiry.id, inquiry.number, `問い合わせを登録 (${customer.name} 様 / ${title})`, storeId);
    db.commLogs.push({
      id: nextId(ctx, "cl"), customerId: customer.id, channel, direction: "inbound", subject: `${title} のご相談`,
      body: inquiry.detail, at: receivedAt, userId: inquiry.createdBy, relatedType: "inquiry", relatedId: inquiry.id,
    });

    // 現地調査の予定 (案件 = 問い合わせに紐づけ、営業担当の空いている時間に入れる)
    const sv = findSlot(ctx, [sales], addDays(inqDate, between(ctx, 1, 4)), 60, shuffled(ctx, [9, 10, 11, 13, 14, 15, 16]));
    const surveyDate = sv.date;
    addEvent(ctx, {
      title: `${customer.name} 様 現地調査・採寸`, kind: "survey", date: sv.date, startTime: sv.start, endTime: sv.end, storeId, assigneeIds: [sales],
      customerId: customer.id, inquiryId: inquiry.id, location: customer.address, ...by(sales, receivedAt),
    });

    // 見積
    const quoteDate = addDays(surveyDate, between(ctx, 0, 2));
    const items = buildItems(ctx, category);
    const discount = chance(ctx, 0.15) ? Math.floor(items.reduce((s, x) => s + x.amount, 0) * 0.05 / 1000) * 1000 : 0;
    const t = totals(items, discount);
    const quoteAt = at(quoteDate, between(ctx, 10, 18), between(ctx, 0, 59));
    const quote: Quote = {
      id: nextId(ctx, "q"),
      number: nextNumber(ctx, "Q", quoteDate),
      version: 1,
      customerId: customer.id,
      inquiryId: inquiry.id,
      storeId,
      title,
      category,
      items,
      ...t,
      status: "draft",
      validUntil: addDays(quoteDate, 30),
      createdBy: sales,
      source: chance(ctx, 0.25) ? "ocr" : "manual",
      createdAt: quoteAt,
      updatedAt: quoteAt,
    };
    db.quotes.push(quote);
    inquiry.quoteId = quote.id;
    inquiry.status = "quoted";
    audit(ctx, quoteAt, sales, "create", "quote", quote.id, quote.number, `見積を作成 (${title} / 合計 ¥${t.total.toLocaleString("ja-JP")})`, storeId);

    // 承認 (履歴)
    const reqRole = requiredRoleFor(storeId, t.total, APPROVAL_RULES.quoteAdminThreshold);
    const approver = reqRole === "admin" ? "u01" : managerOf(storeId);
    const approvedAt = at(addDays(quoteDate, between(ctx, 0, 1)), between(ctx, 10, 19), between(ctx, 0, 59));
    db.approvals.push({
      id: nextId(ctx, "ap"), type: "quote", targetId: quote.id, title: `${quote.number} ${title}`, amount: t.total, storeId,
      requestedBy: sales, requiredRole: reqRole, status: "approved", decidedBy: approver, decidedAt: approvedAt, decisionComment: "内容確認済み", createdAt: quoteAt,
    });
    quote.status = "approved";
    quote.approvedBy = approver;
    quote.approvedAt = approvedAt;
    audit(ctx, approvedAt, approver, "approve", "quote", quote.id, quote.number, "見積を承認", storeId);

    const sentVia: Channel = customer.preferredChannel === "visit" ? "phone" : customer.preferredChannel;
    const sentAt = at(addDays(quoteDate, 1), 10, between(ctx, 0, 59));
    quote.status = "sent";
    quote.issuedAt = addDays(quoteDate, 1);
    quote.sentVia = sentVia;
    db.commLogs.push({
      id: nextId(ctx, "cl"), customerId: customer.id, channel: sentVia, direction: "outbound", subject: `お見積書 ${quote.number} 送付`,
      body: `${title} のお見積書 (合計 ¥${t.total.toLocaleString("ja-JP")}) をお送りしました。`, at: sentAt, userId: sales, relatedType: "quote", relatedId: quote.id,
    });
    audit(ctx, sentAt, sales, "send", "quote", quote.id, quote.number, `見積書を送付 (${sentVia})`, storeId);

    // 結果
    const quoteAge = ageDays - (quoteDate === inqDate ? 0 : Math.round((parseDate(quoteDate).getTime() - parseDate(inqDate).getTime()) / 86400000));
    let outcome: "accepted" | "rejected" | "open";
    if (quoteAge < 10) outcome = chance(ctx, 0.5) ? "accepted" : "open";
    else outcome = chance(ctx, 0.78) ? "accepted" : chance(ctx, 0.75) ? "rejected" : "open";

    if (outcome === "rejected") {
      quote.status = "rejected";
      inquiry.status = "lost";
      const lostAt = at(addDays(quoteDate, between(ctx, 3, 12)), 11, 0);
      quote.updatedAt = lostAt;
      audit(ctx, lostAt, sales, "status", "quote", quote.id, quote.number, "失注として登録 (他社に決定)", storeId);
      continue;
    }
    if (outcome === "open") {
      if (quoteAge > 45) {
        quote.status = "expired";
        inquiry.status = "closed";
      }
      continue;
    }

    // 受注
    const contractDate = addDays(quoteDate, between(ctx, 2, 9));
    const contractAt = at(contractDate, between(ctx, 10, 17), between(ctx, 0, 59));
    quote.status = "accepted";
    inquiry.status = "won";
    const order: Order = {
      id: nextId(ctx, "o"),
      number: nextNumber(ctx, "O", contractDate),
      quoteId: quote.id,
      customerId: customer.id,
      storeId,
      title,
      category,
      contractDate,
      total: t.total,
      status: "confirmed",
      workerIds: [worker],
      siteAddress: customer.address,
      progressNotes: [],
      createdBy: sales,
      approvedBy: approver,
      createdAt: contractAt,
      updatedAt: contractAt,
    };
    quote.orderId = order.id;
    db.orders.push(order);
    db.approvals.push({
      id: nextId(ctx, "ap"), type: "order", targetId: order.id, title: `${order.number} ${title}`, amount: t.total, storeId,
      requestedBy: sales, requiredRole: reqRole, status: "approved", decidedBy: approver, decidedAt: contractAt, createdAt: contractAt,
    });
    audit(ctx, contractAt, sales, "create", "order", order.id, order.number, `受注を登録 (${title})`, storeId);
    audit(ctx, contractAt, approver, "approve", "order", order.id, order.number, "受注 (契約) を承認", storeId);
    order.progressNotes.push({ id: nextId(ctx, "pn"), at: contractAt, userId: sales, kind: "note", body: "ご契約いただきました。施工日を調整します。" });

    // 施工予定: 施工担当が空いている日に入れ、受注の施工予定と連動する「施工」の予定を作る
    const len = category === "fusuma" ? 2 : chance(ctx, 0.2) ? 2 : 1;
    const slot = findSlot(ctx, [worker], addDays(contractDate, between(ctx, 5, 21)), 360, [9], { days: len });
    const schedStart = slot.date;
    const schedEnd = addDays(schedStart, len - 1);
    order.scheduledStart = schedStart;
    order.scheduledEnd = schedEnd;
    const schedAt = at(addDays(contractDate, 1), 11, 0);
    addEvent(ctx, {
      title: `${customer.name} 様 ${title} 施工`, kind: "install", date: schedStart, endDate: len > 1 ? schedEnd : undefined, startTime: "09:00", endTime: "15:00",
      storeId, assigneeIds: [worker], customerId: customer.id, inquiryId: inquiry.id, quoteId: quote.id, orderId: order.id, location: customer.address,
      source: "order", ...by(sales, schedAt),
    });
    order.progressNotes.push({ id: nextId(ctx, "pn"), at: schedAt, userId: sales, kind: "production", body: `施工日 ${schedStart} で確定。材料を手配。` });
    db.commLogs.push({
      id: nextId(ctx, "cl"), customerId: customer.id, channel: sentVia, direction: "outbound", subject: "施工日のご案内",
      body: `${schedStart} に施工にお伺いします。`, at: schedAt, userId: sales, relatedType: "order", relatedId: order.id,
    });

    if (schedStart > ctx.today) {
      order.status = "scheduled";
      continue;
    }
    if (schedEnd >= ctx.today) {
      order.status = "in_progress";
      order.progressNotes.push({ id: nextId(ctx, "pn"), at: at(schedStart, 9, 15), userId: worker, kind: "install", body: "現場到着。古畳の引取開始。" });
      continue;
    }

    // 施工完了 → 売上計上
    const completedAt = at(schedEnd, between(ctx, 14, 17), between(ctx, 0, 59));
    order.status = "completed";
    order.completedAt = schedEnd;
    order.salesDate = schedEnd;
    order.progressNotes.push({ id: nextId(ctx, "pn"), at: at(schedStart, 9, 10), userId: worker, kind: "install", body: "現場到着、施工開始。" });
    order.progressNotes.push({ id: nextId(ctx, "pn"), at: completedAt, userId: worker, kind: "complete", body: "施工完了。お客様確認済み。" });
    order.updatedAt = completedAt;
    audit(ctx, completedAt, worker, "status", "order", order.id, order.number, "施工完了を登録 (売上計上)", storeId);
    // 直近に完了した案件の一部は未請求 (本部の請求書発行を試せるようにする)
    if (daysBetween(schedEnd, ctx.today) <= 5 && chance(ctx, 0.6)) continue;

    // 請求
    const issueDate = addDays(schedEnd, between(ctx, 0, 2));
    const issueAt = at(issueDate, 10, between(ctx, 0, 59));
    const invoice: Invoice = {
      id: nextId(ctx, "inv"),
      number: nextNumber(ctx, "INV", issueDate),
      orderId: order.id,
      customerId: customer.id,
      storeId,
      issueDate,
      dueDate: addDays(issueDate, customer.type === "corporate" ? 30 : 14),
      subtotal: t.subtotal - t.discount,
      tax: t.tax,
      total: t.total,
      paidAmount: 0,
      status: "issued",
      sentVia: customer.type === "corporate" ? "email" : sentVia === "line" ? "line" : "mail",
      createdBy: "u14",
      createdAt: issueAt,
      updatedAt: issueAt,
    };
    db.invoices.push(invoice);
    order.invoiceId = invoice.id;
    order.status = "invoiced";
    audit(ctx, issueAt, "u14", "create", "invoice", invoice.id, invoice.number, `請求書を発行 (¥${t.total.toLocaleString("ja-JP")})`, storeId);
    db.commLogs.push({
      id: nextId(ctx, "cl"), customerId: customer.id, channel: invoice.sentVia!, direction: "outbound", subject: `ご請求書 ${invoice.number}`,
      body: `施工完了に伴い、ご請求書をお送りしました。お支払期限: ${invoice.dueDate}`, at: issueAt, userId: "u14", relatedType: "invoice", relatedId: invoice.id,
    });

    // 入金
    const dueAge = Math.round((ctx.now.getTime() - parseDate(invoice.dueDate).getTime()) / 86400000);
    let payState: "paid" | "partial" | "overdue" | "issued";
    if (dueAge > 5) payState = chance(ctx, 0.86) ? "paid" : chance(ctx, 0.6) ? "overdue" : "partial";
    else if (dueAge > -10) payState = chance(ctx, 0.5) ? "paid" : "issued";
    else payState = chance(ctx, 0.2) ? "paid" : "issued";

    if (payState === "paid" || payState === "partial") {
      const payDate = addDays(issueDate, between(ctx, 2, Math.max(3, Math.min(dueAge + 6, 40))));
      const amount = payState === "paid" ? t.total : Math.floor(t.total * 0.5 / 1000) * 1000;
      const payAt = at(payDate, 15, between(ctx, 0, 59));
      const payment: Payment = {
        id: nextId(ctx, "pay"), invoiceId: invoice.id, date: payDate, amount,
        method: customer.type === "corporate" ? "transfer" : weighted(ctx, [["cash", 45], ["transfer", 35], ["card", 12], ["paypay", 8]]),
        memo: payState === "partial" ? "内金" : undefined, recordedBy: payState === "paid" && chance(ctx, 0.5) ? worker : "u14", createdAt: payAt,
      };
      db.payments.push(payment);
      invoice.paidAmount = amount;
      invoice.status = payState === "paid" ? "paid" : "partially_paid";
      invoice.updatedAt = payAt;
      audit(ctx, payAt, payment.recordedBy, "create", "payment", payment.id, invoice.number, `入金を登録 (¥${amount.toLocaleString("ja-JP")})`, storeId);
      if (payState === "paid") {
        order.status = "paid";
        order.updatedAt = payAt;
      }
    } else if (payState === "overdue") {
      invoice.status = "overdue";
    }
  }
}

/* ------------------------------------------------------------------ */
/* showcase: 各ロールで操作できる「今」のデータ                          */
/* ------------------------------------------------------------------ */

function seedShowcase(ctx: Ctx) {
  const { db, today } = ctx;
  const yesterday = addDays(today, -1);
  const d2 = addDays(today, -2);
  const d3 = addDays(today, -3);
  const d4 = addDays(today, -4);
  const tomorrow = addDays(today, 1);
  const custOf = (storeId: StoreId, corporate = false) =>
    db.customers.find((c) => c.storeId === storeId && (corporate ? c.type === "corporate" : c.type === "individual"))!;

  // --- 新規問い合わせ (未対応) ---
  const inqNew = (p: Partial<Inquiry> & Pick<Inquiry, "contactName" | "channel" | "storeId" | "category" | "summary" | "detail" | "receivedAt" | "createdBy">): Inquiry => {
    const inq: Inquiry = {
      id: nextId(ctx, "inq"),
      number: nextNumber(ctx, "INQ", p.receivedAt.slice(0, 10)),
      status: "new",
      updatedAt: p.receivedAt,
      ...p,
    };
    db.inquiries.push(inq);
    audit(ctx, inq.receivedAt, inq.createdBy, "create", "inquiry", inq.id, inq.number, `問い合わせを登録 (${inq.channel === "ai_phone" ? "AI電話受付" : inq.contactName})`, inq.storeId);
    if (inq.customerId) {
      db.commLogs.push({ id: nextId(ctx, "cl"), customerId: inq.customerId, channel: inq.channel, direction: "inbound", subject: inq.summary, body: inq.detail, at: inq.receivedAt, userId: inq.createdBy, relatedType: "inquiry", relatedId: inq.id });
    }
    return inq;
  };

  const inq1 = inqNew({
    contactName: "坂本 幸子", contactPhone: "090-1234-5678", channel: "ai_phone", storeId: "koshi", category: "tatami",
    summary: "AI電話受付: 和室8畳の畳表替え 概算希望", detail: "【AI電話受付 自動登録】和室8畳の表替えを検討中。来週以降の平日午前で現地調査希望。駐車スペースあり。折返し連絡先: 090-1234-5678",
    receivedAt: at(today, 8, 45), createdBy: "u15", assignedUserId: "u06", nextAction: "折返し電話で現地調査日を調整", nextActionDue: today,
  });
  const chuoCust = custOf("chuo");
  inqNew({
    contactName: chuoCust.name, contactPhone: chuoCust.phone, customerId: chuoCust.id, channel: "line", storeId: "chuo", category: "fusuma",
    summary: "LINE: 襖4枚の写真受領、概算見積希望", detail: "LINE で襖4枚 (押入2枚・間仕切2枚) の写真が届いた。柄は「ちどり」希望。概算をLINEで返信する。",
    receivedAt: at(today, 9, 30), createdBy: "u08", assignedUserId: "u08", nextAction: "LINEで概算返信", nextActionDue: today,
  });
  const nishiCust = custOf("nishi");
  const inq3 = inqNew({
    contactName: nishiCust.name, contactPhone: nishiCust.phone, customerId: nishiCust.id, channel: "web", storeId: "nishi", category: "shoji",
    summary: "Webフォーム: 障子6枚・網戸3枚の張替え", detail: "Webフォームより。縁側の障子 (大) 6枚と網戸 (大) 3枚の張替え希望。土日施工を希望。", status: "in_progress",
    receivedAt: at(yesterday, 20, 12), createdBy: "u15", assignedUserId: "u10", nextAction: "見積作成・送付", nextActionDue: tomorrow,
  });
  const inq4 = inqNew({
    contactName: "永田 真理", contactPhone: "090-8765-4321", channel: "visit", storeId: "hq", category: "tatami",
    summary: "ショールーム来店: へり無し畳 (琉球畳風) のサンプル確認", detail: "坪井ショールームに来店。リビング続きの和室 (6畳) をへり無し畳に。和紙表・グレー系希望。後日サンプル持参で現地調査。", status: "in_progress",
    receivedAt: at(yesterday, 14, 0), createdBy: "u15", assignedUserId: "u15", nextAction: "サンプル持参で現地調査 (合志店職人同行)", nextActionDue: addDays(today, 3),
  });
  const tamanaCorp = custOf("tamana", true);
  const inq5 = inqNew({
    contactName: `${tamanaCorp.name} 施設長`, contactPhone: tamanaCorp.phone, customerId: tamanaCorp.id, channel: "phone", storeId: "tamana", category: "tatami",
    summary: "電話: 介護施設 4室 (計48畳) の畳入替", detail: "年度内に4室の畳を入替したい。利用者が多いため抗菌仕様希望。見積は本部宛にメールで。", status: "quoted",
    receivedAt: at(d2, 10, 20), createdBy: "u12", assignedUserId: "u12", nextAction: "見積承認後にメール送付", nextActionDue: tomorrow,
  });
  const koshiCust = custOf("koshi");
  const inq6 = inqNew({
    contactName: koshiCust.name, contactPhone: koshiCust.phone, customerId: koshiCust.id, channel: "referral", storeId: "koshi", category: "tatami",
    summary: "OB客からの紹介: 新築和室の畳新調 (8畳)", detail: "OB客 (緒方様) のご紹介。新築の和室8畳に「古都」で新調希望。手書き見積を撮影して取込済。", status: "quoted",
    receivedAt: at(d3, 11, 0), createdBy: "u06", assignedUserId: "u06",
  });
  const chuoCorp = custOf("chuo", true);
  const inq7 = inqNew({
    contactName: `${chuoCorp.name} 管理部`, contactPhone: chuoCorp.phone, customerId: chuoCorp.id, channel: "email", storeId: "chuo", category: "tatami",
    summary: "メール: 管理物件3室の畳・襖 原状回復", detail: "退去に伴う原状回復。3室 (各6畳) の畳表替えと襖 (計12面) の張替え。月末までに完了希望。", status: "quoted",
    receivedAt: at(d4, 16, 40), createdBy: "u08", assignedUserId: "u08",
  });

  // --- 承認待ちの見積 ---
  const mkQuote = (p: {
    inquiry: Inquiry; customer: Customer; title: string; category: ServiceCategory; items: QuoteItem[]; createdBy: string; date: string; source?: Quote["source"]; discount?: number;
  }): Quote => {
    const t = totals(p.items, p.discount ?? 0);
    const createdAt = at(p.date, 15, 30);
    const q: Quote = {
      id: nextId(ctx, "q"), number: nextNumber(ctx, "Q", p.date), version: 1, customerId: p.customer.id, inquiryId: p.inquiry.id, storeId: p.inquiry.storeId,
      title: p.title, category: p.category, items: p.items, ...t, status: "pending_approval", validUntil: addDays(p.date, 30), createdBy: p.createdBy,
      source: p.source ?? "manual", createdAt, updatedAt: createdAt,
    };
    db.quotes.push(q);
    p.inquiry.quoteId = q.id;
    const role = requiredRoleFor(q.storeId, t.total, APPROVAL_RULES.quoteAdminThreshold);
    db.approvals.push({
      id: nextId(ctx, "ap"), type: "quote", targetId: q.id, title: `${q.number} ${q.title}`, amount: t.total, storeId: q.storeId, requestedBy: p.createdBy,
      requiredRole: role, status: "pending", requestComment: "内容をご確認のうえ承認をお願いします。", createdAt: createdAt,
    });
    audit(ctx, createdAt, p.createdBy, "create", "quote", q.id, q.number, `見積を作成 (${q.title})`, q.storeId);
    audit(ctx, createdAt, p.createdBy, "submit", "quote", q.id, q.number, `承認を申請 (${role === "admin" ? "管理者" : "店長"}承認)`, q.storeId);
    return q;
  };

  const qA = mkQuote({
    inquiry: inq6, customer: koshiCust, title: "新築和室8畳 畳新調 (古都)", category: "tatami", createdBy: "u06", date: d3, source: "ocr",
    items: [item(ctx, product("p_t_shincho"), 8, "熊本産 古都 表 / 畳床新調"), item(ctx, product("p_misc"), 1)],
  });
  const qB = mkQuote({
    inquiry: inq7, customer: chuoCorp, title: "管理物件3室 原状回復 (畳・襖)", category: "tatami", createdBy: "u08", date: yesterday,
    items: [item(ctx, product("p_t_nagomi"), 18, "3室 × 6畳"), item(ctx, product("p_f_nozomi"), 12, "3室 × 4面"), item(ctx, product("p_t_disposal"), 18), item(ctx, product("p_misc"), 1)],
  });
  const qC = mkQuote({
    inquiry: inq5, customer: tamanaCorp, title: "介護施設 4室 畳入替 (抗菌仕様)", category: "tatami", createdBy: "u05", date: yesterday,
    items: [item(ctx, product("p_t_kizuna"), 48, "4室 × 12畳 / 抗菌加工"), item(ctx, product("p_t_disposal"), 48), item(ctx, product("p_misc"), 1)],
    discount: 20000,
  });
  void qA; void qB; void qC;

  // --- 確定済み見積の金額変更 (承認待ち) ---
  let qAmend: Quote | undefined;
  {
    const items = [item(ctx, product("p_s_puraka_l"), 6, "縁側"), item(ctx, product("p_a_24_l"), 3), item(ctx, product("p_misc"), 1)];
    const t = totals(items);
    const createdAt = at(d2, 11, 0);
    const q: Quote = {
      id: nextId(ctx, "q"), number: nextNumber(ctx, "Q", d2), version: 1, customerId: nishiCust.id, inquiryId: inq3.id, storeId: "nishi",
      title: "縁側 障子6枚・網戸3枚 張替え", category: "shoji", items, ...t, status: "sent", validUntil: addDays(d2, 30), issuedAt: d2, sentVia: "email",
      createdBy: "u10", approvedBy: "u04", approvedAt: createdAt, source: "manual", createdAt, updatedAt: at(yesterday, 17, 20),
    };
    const newItems = [...items.slice(0, 2), item(ctx, product("p_a_24_l"), 2, "追加分 (2階)"), items[2]];
    const nt = totals(newItems);
    q.pendingChange = { items: newItems, ...nt, reason: "お客様より2階の網戸2枚を追加したいとのご要望", requestedBy: "u10", requestedAt: at(yesterday, 17, 20) };
    db.quotes.push(q);
    qAmend = q;
    inq3.quoteId = q.id;
    inq3.status = "quoted";
    db.approvals.push({
      id: nextId(ctx, "ap"), type: "quote_amend", targetId: q.id, title: `${q.number} ${q.title} (網戸2枚追加)`, amount: nt.total, storeId: "nishi", requestedBy: "u10",
      requiredRole: "store_manager", status: "pending", requestComment: `変更前 ¥${t.total.toLocaleString("ja-JP")} → 変更後 ¥${nt.total.toLocaleString("ja-JP")}`, createdAt: q.pendingChange.requestedAt,
    });
    audit(ctx, createdAt, "u10", "create", "quote", q.id, q.number, `見積を作成 (${q.title})`, "nishi");
    audit(ctx, q.pendingChange.requestedAt, "u10", "submit", "quote", q.id, q.number, "確定見積の金額変更を申請", "nishi", [{ field: "total", before: t.total, after: nt.total }]);
  }

  // --- 受注 (契約) 承認待ち ---
  {
    const cust = db.customers.filter((c) => c.storeId === "nishi" && c.type === "individual")[2];
    const items = [item(ctx, product("p_f_suzaku"), 6, "客間 3枚 × 両面"), item(ctx, product("p_misc"), 1)];
    const t = totals(items);
    const qDate = addDays(today, -6);
    const q: Quote = {
      id: nextId(ctx, "q"), number: nextNumber(ctx, "Q", qDate), version: 1, customerId: cust.id, storeId: "nishi", title: "客間 襖張替え (朱雀)", category: "fusuma", items, ...t,
      status: "accepted", validUntil: addDays(qDate, 30), issuedAt: addDays(qDate, 1), sentVia: "line", createdBy: "u10", approvedBy: "u04", approvedAt: at(qDate, 16, 0),
      source: "manual", createdAt: at(qDate, 14, 0), updatedAt: at(yesterday, 10, 0),
    };
    db.quotes.push(q);
    const o: Order = {
      id: nextId(ctx, "o"), number: nextNumber(ctx, "O", yesterday), quoteId: q.id, customerId: cust.id, storeId: "nishi", title: q.title, category: "fusuma",
      contractDate: yesterday, total: t.total, status: "pending_approval", workerIds: ["u11"], siteAddress: cust.address, progressNotes: [
        { id: nextId(ctx, "pn"), at: at(yesterday, 10, 0), userId: "u10", kind: "note", body: "LINE にて正式にご依頼をいただきました。契約承認を申請します。" },
      ], createdBy: "u10", createdAt: at(yesterday, 10, 0), updatedAt: at(yesterday, 10, 0),
    };
    q.orderId = o.id;
    db.orders.push(o);
    // お客様の希望日 (来週火曜) で施工を仮押さえし、引き取り・納品も案件の予定として登録 (契約承認後に確定)
    {
      const dow = parseDate(today).getDay();
      const tue = workday(addDays(today, (2 - dow + 7) % 7 || 7));
      const sl = findSlot(ctx, ["u11"], tue, 360, [9], { days: 2 });
      o.scheduledStart = sl.date;
      o.scheduledEnd = addDays(sl.date, 1);
      const link = { storeId: "nishi" as StoreId, customerId: cust.id, quoteId: q.id, orderId: o.id, location: cust.address };
      addEvent(ctx, { title: `${cust.name} 様 ${q.title} 施工`, kind: "install", date: o.scheduledStart, endDate: o.scheduledEnd, startTime: "09:00", endTime: "15:00", assigneeIds: ["u11"], source: "order", ...link, ...by("u10", at(yesterday, 10, 5)) });
      addEvent(ctx, { title: `${cust.name} 様 襖 引き取り (6面)`, kind: "pickup", date: o.scheduledStart, startTime: "09:00", endTime: "10:00", assigneeIds: ["u11"], ...link, memo: "朱雀の柄見本を持参。家具の移動はお客様にお願い済み", ...by("u10", at(yesterday, 10, 6)) });
      addEvent(ctx, { title: `${cust.name} 様 襖 納品・建て付け`, kind: "delivery", date: o.scheduledEnd, startTime: "14:00", endTime: "15:00", assigneeIds: ["u11"], ...link, ...by("u10", at(yesterday, 10, 6)) });
    }
    db.approvals.push({
      id: nextId(ctx, "ap"), type: "order", targetId: o.id, title: `${o.number} ${o.title}`, amount: t.total, storeId: "nishi", requestedBy: "u10", requiredRole: "store_manager",
      status: "pending", requestComment: "施工希望日は来週火曜。承認後に材料発注します。", createdAt: o.createdAt,
    });
    audit(ctx, o.createdAt, "u10", "create", "order", o.id, o.number, "受注を登録し契約承認を申請", "nishi");
    db.commLogs.push({ id: nextId(ctx, "cl"), customerId: cust.id, channel: "line", direction: "inbound", subject: "襖張替えの正式依頼", body: "見積内容で進めてください。来週火曜希望です。", at: at(yesterday, 9, 40), userId: "u10", relatedType: "order", relatedId: o.id });
  }

  // --- 期日超過の請求を 2 件確保 ---
  const overdueCount = db.invoices.filter((i) => i.status === "overdue").length;
  if (overdueCount < 2) {
    for (const inv of db.invoices) {
      if (inv.status === "issued" && inv.dueDate < today) {
        inv.status = "overdue";
        if (db.invoices.filter((i) => i.status === "overdue").length >= 2) break;
      }
    }
  }

  // --- 案件の予定 (本日〜来週)。担当者の空いている時間に入れる ---
  // 坂本様の現地調査: 同行する小林さん (施工担当) は本日施工中のため時間が重なる → 予定表の「重複」の確認・調整のデモ
  addEvent(ctx, {
    title: "坂本 幸子 様 現地調査 (和室8畳)", kind: "survey", date: today, startTime: "10:00", endTime: "11:00", storeId: "koshi", assigneeIds: ["u06", "u07"], inquiryId: inq1.id,
    location: "熊本県合志市須屋 (AI電話受付 要確認)", memo: `${inq1.number} AI電話受付から。採寸のため小林さんの同行を依頼 (本日の施工と時間が重なるため要調整)`, ...by("u06", at(today, 9, 5)),
  });
  {
    const link = { inquiryId: inq5.id, quoteId: qC.id };
    const s = findSlot(ctx, ["u12", "u13"], today, 90, [15.5, 16, 13, 10], { link });
    addEvent(ctx, { title: `${tamanaCorp.name} 4室 採寸 (抗菌仕様の確認)`, kind: "measure", date: s.date, startTime: s.start, endTime: s.end, storeId: "tamana", assigneeIds: ["u12", "u13"], customerId: tamanaCorp.id, ...link, location: tamanaCorp.address, ...by("u12", at(d2, 11, 0)) });
  }
  {
    const s = findSlot(ctx, ["u15", "u07"], addDays(today, 3), 60, [10.5, 13.5, 15, 16], { link: { inquiryId: inq4.id } });
    addEvent(ctx, { title: "永田 真理 様 サンプル持参・現地調査", kind: "survey", date: s.date, startTime: s.start, endTime: s.end, storeId: "hq", assigneeIds: ["u15", "u07"], inquiryId: inq4.id, location: "熊本市中央区黒髪", memo: "へり無し畳 (和紙表・グレー系) のサンプル 3 種を持参", ...by("u15", at(yesterday, 14, 30)) });
  }
  if (qAmend) {
    const link = { inquiryId: inq3.id, quoteId: qAmend.id };
    const s = findSlot(ctx, ["u10"], tomorrow, 60, [10, 13, 15, 16], { link });
    addEvent(ctx, { title: `${nishiCust.name} 様 見積変更のご説明 (網戸2枚追加)`, kind: "visit", date: s.date, startTime: s.start, endTime: s.end, storeId: "nishi", assigneeIds: ["u10"], customerId: nishiCust.id, ...link, location: nishiCust.address, ...by("u10", at(yesterday, 17, 30)) });
  }
  {
    const link = { inquiryId: inq7.id, quoteId: qB.id };
    const s = findSlot(ctx, ["u08", "u09"], tomorrow, 60, [15.5, 16, 14, 10], { link });
    addEvent(ctx, { title: `${chuoCorp.name} 鍵の受け取り・現地確認`, kind: "visit", date: s.date, startTime: s.start, endTime: s.end, storeId: "chuo", assigneeIds: ["u08", "u09"], customerId: chuoCorp.id, ...link, location: chuoCorp.address, ...by("u08", at(yesterday, 16, 0)) });
  }
}

/* ------------------------------------------------------------------ */
/* 社内の予定 (会議・会合・社内行事・イベント・休暇)。案件より先に押さえる  */
/* ------------------------------------------------------------------ */

function seedCompanyCalendar(ctx: Ctx) {
  const { today } = ctx;
  const mon = weekStart(today);
  const d = (n: number) => addDays(today, n);
  // 全社朝礼 (毎週月曜・オンライン・全社共通)
  const morning = nextId(ctx, "ser");
  for (let i = -6; i <= 6; i++) {
    const day = addDays(mon, i * 7);
    if (isOffDay(day)) continue;
    addEvent(ctx, { title: "全社朝礼 (オンライン)", kind: "meeting", date: day, startTime: "08:30", endTime: "08:45", storeId: "hq", companyWide: true, assigneeIds: [], location: "オンライン (各店舗から参加)", memo: "今週の重点・安全確認・連絡事項", seriesId: morning, ...by("u01", at(addDays(mon, -49), 9, 0)) });
  }
  // 合志店 朝ミーティング (毎週月曜)
  const koshiMtg = nextId(ctx, "ser");
  for (let i = -4; i <= 4; i++) {
    const day = addDays(mon, i * 7);
    if (isOffDay(day)) continue;
    addEvent(ctx, { title: "合志店 朝ミーティング", kind: "meeting", date: day, startTime: "08:00", endTime: "08:25", storeId: "koshi", assigneeIds: ["u02", "u06", "u07"], location: "合志店 事務所", memo: "今週の施工・現地調査の段取りと人員の確認", seriesId: koshiMtg, ...by("u02", at(addDays(mon, -35), 18, 0)) });
  }
  // 月次経営会議 (本日 16:00)
  addEvent(ctx, { title: "月次経営会議 (店長・本部)", kind: "meeting", date: today, startTime: "16:00", endTime: "17:00", storeId: "hq", assigneeIds: ["u01", "u02", "u03", "u04", "u05", "u14"], location: "本社 会議室 (オンライン参加可)", memo: "今月の売上見込み・展示販売会の人員・年末の施工枠", ...by("u01", at(d(-2), 13, 10)) });
  // 社内行事: 新商品研修・全社安全講習
  addEvent(ctx, { title: "新商品研修 (和紙畳・カラー畳の提案方法)", kind: "company", date: workday(d(4)), startTime: "13:00", endTime: "15:00", storeId: "hq", assigneeIds: ["u06", "u08", "u10", "u12", "u15"], location: "坪井ショールーム", memo: "各店の営業・受付担当が参加。サンプル帳を持参", ...by("u15", at(d(-1), 15, 0)) });
  const safety = workday(d(8));
  addEvent(ctx, { title: "全社 安全講習 (車両・電動工具)", kind: "company", date: safety, startTime: "17:30", endTime: "19:00", storeId: "hq", companyWide: true, assigneeIds: ["u02", "u03", "u04", "u05", "u07", "u09", "u11", "u13"], location: "本社 研修室", memo: "施工車の日常点検・電動工具の取扱い。受講記録を残します", ...by("u15", at(d(-1), 11, 30)) });
  // 会合
  addEvent(ctx, { title: "畳組合 定例会合", kind: "gathering", date: workday(d(6)), startTime: "18:30", endTime: "20:30", storeId: "hq", assigneeIds: ["u01"], location: "組合会館 (熊本市中央区)", ...by("u01", at(d(-3), 10, 0)) });
  addEvent(ctx, { title: "地域商工会 定例会 (中央地区)", kind: "gathering", date: workday(d(13)), startTime: "19:00", endTime: "21:00", storeId: "chuo", assigneeIds: ["u03"], location: "地区公民館", ...by("u03", at(d(-5), 11, 0)) });
  // イベント: 展示販売会 (3 日間) と各店からの応援
  const fair = workday(addDays(safety, 1));
  addEvent(ctx, { title: "ゆめタウン大牟田 展示販売会", kind: "event", date: fair, endDate: addDays(fair, 2), startTime: "09:30", endTime: "18:00", storeId: "hq", companyWide: true, assigneeIds: ["u15"], location: "ゆめタウン大牟田 1F 催事場", memo: "初日 8:00 搬入 / 最終日 18:00 撤収。各店から 1 名ずつ応援 (玉名: 林 1〜2 日目 / 合志: 小林 2〜3 日目)", ...by("u01", at(d(-2), 13, 0)) });
  addEvent(ctx, { title: "展示販売会 応援 (ゆめタウン大牟田)", kind: "event", date: fair, endDate: addDays(fair, 1), startTime: "09:30", endTime: "18:00", storeId: "tamana", assigneeIds: ["u13"], location: "ゆめタウン大牟田", ...by("u05", at(d(-2), 15, 30)) });
  addEvent(ctx, { title: "展示販売会 応援 (ゆめタウン大牟田)", kind: "event", date: addDays(fair, 1), endDate: addDays(fair, 2), startTime: "09:30", endTime: "18:00", storeId: "koshi", assigneeIds: ["u07"], location: "ゆめタウン大牟田", ...by("u02", at(d(-1), 9, 0)) });
  // 休暇・不在
  addEvent(ctx, { title: "小林 翔太 有給休暇", kind: "leave", date: workday(d(2)), storeId: "koshi", assigneeIds: ["u07"], ...by("u07", at(d(-6), 17, 0)) });
  addEvent(ctx, { title: "加藤 由美 午前半休 (通院)", kind: "leave", date: workday(d(1)), startTime: "09:00", endTime: "13:00", storeId: "chuo", assigneeIds: ["u08"], ...by("u08", at(d(-4), 18, 0)) });
  // 社内行事: 全社忘年会 (翌月 15 日以降の最初の金曜)
  const base = parseDate(today);
  let party = toDateKey(new Date(base.getFullYear(), base.getMonth() + 1, 15));
  while (parseDate(party).getDay() !== 5) party = addDays(party, 1);
  addEvent(ctx, { title: "全社 忘年会", kind: "company", date: party, startTime: "18:30", endTime: "21:00", storeId: "hq", companyWide: true, assigneeIds: [], location: "熊本市内 (詳細は社内連絡で案内)", memo: "出欠は社内連絡のスレッドに返信", ...by("u15", at(d(-3), 12, 0)) });
}

/** 各店舗に「施工中」の受注を確保する (店舗ダッシュボード・予定表の検証用)。施工担当の空きを確認して本日に移す */
function ensureInProgress(ctx: Ctx) {
  const { db, today } = ctx;
  const tomorrow = addDays(today, 1);
  for (const storeId of ["koshi", "chuo", "nishi", "tamana"] as StoreId[]) {
    const orders = db.orders.filter((o) => o.storeId === storeId);
    if (orders.some((o) => o.status === "in_progress")) continue;
    const cands = orders.filter((o) => o.status === "scheduled").sort((a, b) => (a.scheduledStart ?? "").localeCompare(b.scheduledStart ?? ""));
    for (const cand of cands) {
      const main = db.schedule.find((e) => e.orderId === cand.id && e.source === "order");
      if (main) release(ctx, main);
      const two = !isOffDay(tomorrow) && isFree(ctx, cand.workerIds, [today, tomorrow], 540, 900);
      if (!two && !isFree(ctx, cand.workerIds, [today], 540, 900)) {
        if (main) reserve(ctx, main);
        continue;
      }
      cand.status = "in_progress";
      cand.scheduledStart = today;
      cand.scheduledEnd = two ? tomorrow : today;
      cand.updatedAt = at(today, 9, 10);
      cand.progressNotes.push({ id: nextId(ctx, "pn"), at: at(today, 9, 10), userId: cand.workerIds[0] ?? "u07", kind: "install", body: "現場到着、施工開始。" });
      if (main) {
        main.date = today;
        main.endDate = two ? tomorrow : undefined;
        reserve(ctx, main);
      }
      break;
    }
  }
}

/* ------------------------------------------------------------------ */
/* expenses & purchases                                                */
/* ------------------------------------------------------------------ */

function seedExpensesAndPurchases(ctx: Ctx) {
  const { db, today } = ctx;
  const mkExpense = (p: Omit<Expense, "id" | "number" | "createdAt" | "updatedAt" | "taxAmount"> & { createdAt?: string }): Expense => {
    const createdAt = p.createdAt ?? at(p.date, 18, 10);
    const e: Expense = { id: nextId(ctx, "exp"), number: nextNumber(ctx, "EXP", p.date), taxAmount: Math.floor(p.amount - p.amount / 1.1), createdAt, updatedAt: createdAt, ...p };
    db.expenses.push(e);
    audit(ctx, createdAt, e.submittedBy, "create", "expense", e.id, e.number, `経費を登録 (${e.vendor} ¥${e.amount.toLocaleString("ja-JP")})`, e.storeId);
    if (e.status === "pending_approval") {
      const role = requiredRoleFor(e.storeId, e.amount, APPROVAL_RULES.expenseAdminThreshold);
      db.approvals.push({ id: nextId(ctx, "ap"), type: "expense", targetId: e.id, title: `${e.number} ${e.vendor} (${e.account})`, amount: e.amount, storeId: e.storeId, requestedBy: e.submittedBy, requiredRole: role, status: "pending", requestComment: e.description, createdAt });
      audit(ctx, createdAt, e.submittedBy, "submit", "expense", e.id, e.number, "経費精算を申請", e.storeId);
    } else if (e.status === "approved" || e.status === "paid") {
      const role = requiredRoleFor(e.storeId, e.amount, APPROVAL_RULES.expenseAdminThreshold);
      const approver = role === "admin" ? "u01" : managerOf(e.storeId);
      const decidedAt = at(addDays(e.date, 1), 9, 30);
      db.approvals.push({ id: nextId(ctx, "ap"), type: "expense", targetId: e.id, title: `${e.number} ${e.vendor} (${e.account})`, amount: e.amount, storeId: e.storeId, requestedBy: e.submittedBy, requiredRole: role, status: "approved", decidedBy: approver, decidedAt, createdAt });
      e.approvedBy = approver;
      e.approvedAt = decidedAt;
      audit(ctx, decidedAt, approver, "approve", "expense", e.id, e.number, "経費を承認", e.storeId);
    }
    return e;
  };

  // 承認待ち (各ロールで試せる)
  mkExpense({ storeId: "koshi", submittedBy: "u07", date: addDays(today, -1), vendor: "ENEOS 合志SS", amount: 6820, account: "車両費 (ガソリン代)", paymentMethod: "card", description: "施工車 (軽トラ) 給油", status: "pending_approval", source: "ocr", documentId: "doc_0002" });
  mkExpense({ storeId: "koshi", submittedBy: "u06", date: addDays(today, -2), vendor: "ホームセンター アグリ 合志店", amount: 12430, account: "消耗品費", paymentMethod: "cash", description: "養生シート・カッター替刃・結束バンド", status: "pending_approval", source: "manual" });
  mkExpense({ storeId: "chuo", submittedBy: "u09", date: addDays(today, -1), vendor: "NEXCO西日本 (ETC)", amount: 2310, account: "旅費交通費", paymentMethod: "card", description: "玉名応援 高速代 (往復)", status: "pending_approval", source: "ocr", documentId: "doc_0005" });
  mkExpense({ storeId: "hq", submittedBy: "u15", date: addDays(today, -3), vendor: "有限会社 サイン工房くまもと", amount: 68200, account: "修繕費", paymentMethod: "transfer", description: "坪井ショールーム 看板照明の修繕", status: "pending_approval", source: "manual" });
  mkExpense({ storeId: "tamana", submittedBy: "u13", date: addDays(today, -2), vendor: "九州畳材 株式会社 (店頭現金)", amount: 54120, account: "材料費", paymentMethod: "cash", description: "畳縁 (無地・淡色) 緊急購入 20反", status: "pending_approval", source: "manual" });

  // 履歴 (承認済・精算済)
  const VENDORS: [string, string, number, number][] = [
    ["ENEOS 合志SS", "車両費 (ガソリン代)", 4500, 9800],
    ["出光 玉名バイパスSS", "車両費 (ガソリン代)", 4000, 8500],
    ["ホームセンター アグリ 合志店", "消耗品費", 2000, 15000],
    ["ダイソー 保田窪店", "消耗品費", 500, 3000],
    ["セブン-イレブン", "会議費", 800, 2500],
    ["NTTドコモ", "通信費", 9000, 14000],
    ["熊本日日新聞 (折込)", "広告宣伝費", 20000, 45000],
    ["ヤマト運輸", "雑費", 1200, 4000],
  ];
  for (let i = 0; i < 22; i++) {
    const storeId = weighted<StoreId>(ctx, [["koshi", 28], ["chuo", 26], ["nishi", 20], ["tamana", 18], ["hq", 8]]);
    const [vendor, account, min, max] = pick(ctx, VENDORS);
    const amount = Math.round(between(ctx, min, max) / 10) * 10;
    const date = addDays(today, -between(ctx, 4, 95));
    const submittedBy = chance(ctx, 0.5) ? WORKER_BY_STORE[storeId] : SALES_BY_STORE[storeId];
    mkExpense({ storeId, submittedBy, date, vendor, amount, account, paymentMethod: weighted(ctx, [["cash", 50], ["card", 40], ["transfer", 10]]), description: `${account.replace(/ \(.*\)/, "")}`, status: chance(ctx, 0.7) ? "paid" : "approved", source: chance(ctx, 0.6) ? "ocr" : "manual" });
  }

  // 仕入請求書 (買掛)
  const mkPurchase = (p: Omit<PurchaseInvoice, "id" | "number" | "createdAt" | "updatedAt" | "taxAmount">): PurchaseInvoice => {
    const createdAt = at(addDays(p.invoiceDate, 2), 11, 0);
    const pi: PurchaseInvoice = { id: nextId(ctx, "ap_inv"), number: nextNumber(ctx, "AP", p.invoiceDate), taxAmount: Math.floor(p.amount - p.amount / 1.1), createdAt, updatedAt: createdAt, ...p };
    db.purchases.push(pi);
    audit(ctx, createdAt, pi.registeredBy, "create", "purchase", pi.id, pi.number, `仕入請求書を登録 (¥${pi.amount.toLocaleString("ja-JP")})`, pi.storeId);
    if (pi.status === "pending_approval") {
      db.approvals.push({ id: nextId(ctx, "ap"), type: "purchase", targetId: pi.id, title: `${pi.number} ${db.suppliers.find((s) => s.id === pi.supplierId)?.name}`, amount: pi.amount, storeId: "hq", requestedBy: pi.registeredBy, requiredRole: "admin", status: "pending", requestComment: `支払期限 ${pi.dueDate}`, createdAt });
    } else if (pi.status === "paid" || pi.status === "approved") {
      const decidedAt = at(addDays(pi.invoiceDate, 4), 10, 0);
      db.approvals.push({ id: nextId(ctx, "ap"), type: "purchase", targetId: pi.id, title: `${pi.number} ${db.suppliers.find((s) => s.id === pi.supplierId)?.name}`, amount: pi.amount, storeId: "hq", requestedBy: pi.registeredBy, requiredRole: "admin", status: "approved", decidedBy: "u01", decidedAt, createdAt });
      pi.approvedBy = "u01";
    }
    return pi;
  };
  const lastMonthEnd = (() => { const d = parseDate(today); d.setDate(0); return toDateKey(d); })();
  mkPurchase({ supplierId: "s01", storeId: "hq", invoiceDate: lastMonthEnd, dueDate: addDays(lastMonthEnd, 30), amount: 486200, description: "10月分 い草・畳表 (熊本産 各グレード)", status: "pending_approval", source: "ocr", documentId: "doc_0003", registeredBy: "u14" });
  mkPurchase({ supplierId: "s02", storeId: "hq", invoiceDate: lastMonthEnd, dueDate: addDays(lastMonthEnd, 30), amount: 214500, description: "10月分 畳床・畳縁", status: "pending_approval", source: "manual", registeredBy: "u14" });
  mkPurchase({ supplierId: "s03", storeId: "hq", invoiceDate: addDays(today, -5), dueDate: addDays(today, 20), amount: 66000, description: "襖紙 (朱雀・ちどり)・障子紙", status: "received", source: "ocr", documentId: "doc_0007", registeredBy: "u14" });
  for (let m = 1; m <= 4; m++) {
    const d = parseDate(today); d.setMonth(d.getMonth() - m); d.setDate(0);
    const inv = toDateKey(d);
    mkPurchase({ supplierId: "s01", storeId: "hq", invoiceDate: inv, dueDate: addDays(inv, 30), amount: Math.round(between(ctx, 380000, 560000) / 100) * 100, description: `${d.getMonth() + 1}月分 い草・畳表`, status: m === 1 ? "approved" : "paid", source: "ocr", registeredBy: "u14", paidAt: m === 1 ? undefined : addDays(inv, 28) });
    mkPurchase({ supplierId: "s02", storeId: "hq", invoiceDate: inv, dueDate: addDays(inv, 30), amount: Math.round(between(ctx, 150000, 260000) / 100) * 100, description: `${d.getMonth() + 1}月分 畳床・畳縁`, status: m === 1 ? "approved" : "paid", source: "manual", registeredBy: "u14", paidAt: m === 1 ? undefined : addDays(inv, 28) });
    if (m % 2 === 0) {
      mkPurchase({ supplierId: "s05", storeId: "hq", invoiceDate: inv, dueDate: addDays(inv, 30), amount: Math.round(between(ctx, 40000, 90000) / 100) * 100, description: `${d.getMonth() + 1}月分 配送・引取`, status: "paid", source: "manual", registeredBy: "u14", paidAt: addDays(inv, 25) });
    }
  }
}

/* ------------------------------------------------------------------ */
/* threads / messages                                                  */
/* ------------------------------------------------------------------ */

function seedThreads(ctx: Ctx) {
  const { db, today } = ctx;
  const mk = (t: Omit<Thread, "id" | "createdAt" | "updatedAt"> & { createdAt: string }, msgs: [string, string, string, string[]?][]) => {
    const thread: Thread = { id: nextId(ctx, "th"), updatedAt: msgs[msgs.length - 1]?.[2] ?? t.createdAt, ...t };
    db.threads.push(thread);
    for (const [userId, body, atIso, mentions] of msgs) {
      db.messages.push({ id: nextId(ctx, "msg"), threadId: thread.id, userId, body, at: atIso, mentions: mentions ?? [] });
    }
    return thread;
  };
  const qC = db.quotes.find((q) => q.title.startsWith("介護施設"));
  const apPending = db.purchases.find((p) => p.supplierId === "s02" && p.status === "pending_approval");
  const inq1 = db.inquiries.find((i) => i.channel === "ai_phone" && i.status === "new");

  mk({ title: "【依頼】坂本様 (AI電話受付) 現地調査の日程調整", kind: "request", storeId: "koshi", createdBy: "u06", participants: ["u06", "u07", "u02"], relatedType: "inquiry", relatedId: inq1?.id, relatedLabel: inq1?.number, status: "open", createdAt: at(today, 9, 5) }, [
    ["u06", "AI電話受付で登録された坂本様の件、本日10時に現地調査へ行きます。@小林 翔太 さん同行お願いできますか？採寸を一緒に。", at(today, 9, 5), ["u07"]],
    ["u07", "了解です。9:45に店舗を出ます。軽トラで行きます。", at(today, 9, 12)],
  ]);
  mk({ title: "【確認】玉名 介護施設案件 (48畳) の支払条件と承認", kind: "question", storeId: "tamana", createdBy: "u05", participants: ["u05", "u01", "u14"], relatedType: "quote", relatedId: qC?.id, relatedLabel: qC?.number, status: "open", createdAt: at(addDays(today, -1), 17, 45) }, [
    ["u05", "介護施設の4室入替、見積を作成し承認申請しました (¥50万超のため管理者承認)。先方は年度内の施工を希望。@山田 太郎 社長、@山本 恵 さん、支払条件は月末締め翌月末で問題ないでしょうか。", at(addDays(today, -1), 17, 45), ["u01", "u14"]],
    ["u14", "法人の既存取引先なので翌月末払いで問題ありません。請求書は本部からメール送付します。", at(addDays(today, -1), 18, 10)],
    ["u01", "見積内容を確認して本日中に承認します。抗菌加工の仕入原価を見積に反映しているか確認してください。", at(today, 8, 20), ["u05"]],
  ]);
  mk({ title: "【連絡】11月 展示販売会 (ゆめタウン大牟田) 人員配置", kind: "notice", createdBy: "u01", participants: ["u01", "u02", "u03", "u04", "u05", "u15"], status: "open", createdAt: at(addDays(today, -2), 13, 0) }, [
    ["u01", `${addDays(today, 9)} から3日間の展示販売会、各店から1名ずつ応援をお願いします。シフトを木曜までに本スレッドへ返信してください。`, at(addDays(today, -2), 13, 0), ["u02", "u03", "u04", "u05"]],
    ["u05", "玉名店は林が初日・2日目に参加します。", at(addDays(today, -2), 15, 30)],
    ["u02", "合志店は小林を2日目・3日目に出します。", at(addDays(today, -1), 9, 0)],
  ]);
  mk({ title: "【確認】仕入先請求書の金額相違 (九州畳材 10月分)", kind: "question", storeId: "hq", createdBy: "u14", participants: ["u14", "u01", "u02"], relatedType: "purchase", relatedId: apPending?.id, relatedLabel: apPending?.number, status: "open", createdAt: at(addDays(today, -1), 11, 30) }, [
    ["u14", "九州畳材の10月分請求が納品書合計より ¥8,800 多くなっています。@田中 健一 店長、10/28 の追加納品 (畳縁) は合志店で受領していますか？", at(addDays(today, -1), 11, 30), ["u02"]],
    ["u02", "確認しました。10/28 に畳縁 4反を追加で受け取っています。納品書を取込んでおきます。", at(addDays(today, -1), 14, 5)],
  ]);
  mk({ title: "【報告】中央店 先月 施工完了・売上報告", kind: "report", storeId: "chuo", createdBy: "u03", participants: ["u03", "u01", "u14"], status: "done", createdAt: at(addDays(today, -8), 18, 0) }, [
    ["u03", "先月の施工は全件完了。売上はダッシュボードの通りです。未入金2件は今週フォローします。", at(addDays(today, -8), 18, 0), ["u01"]],
    ["u01", "確認しました。お疲れさまでした。", at(addDays(today, -7), 8, 30)],
  ]);
  mk({ title: "【依頼】請求書を LINE で受け取りたいお客様への対応", kind: "request", storeId: "nishi", createdBy: "u10", participants: ["u10", "u14"], status: "open", createdAt: at(addDays(today, -3), 16, 20) }, [
    ["u10", "請求書を郵送ではなく LINE で送ってほしいというお客様が増えています。@山本 恵 さん、本部からの送付時に LINE (PDF) を選べるようにできますか？", at(addDays(today, -3), 16, 20), ["u14"]],
    ["u14", "システム上は送付方法に LINE を選べるので、顧客の希望連絡手段を LINE に設定しておいてください。本部側で対応します。", at(addDays(today, -3), 17, 0)],
  ]);
}

/* ------------------------------------------------------------------ */
/* documents (紙のデジタル化)                                           */
/* ------------------------------------------------------------------ */

function seedDocuments(ctx: Ctx) {
  const { db, today } = ctx;
  const qA = db.quotes.find((q) => q.source === "ocr" && q.status === "pending_approval");
  const expGas = db.expenses.find((e) => e.documentId === "doc_0002");
  const apIgusa = db.purchases.find((p) => p.documentId === "doc_0003");
  const docs: CapturedDocument[] = [
    { id: "doc_0001", kind: "handwritten_quote", fileName: "IMG_20261107_手書き見積_緒方様紹介.jpg", uploadedBy: "u06", storeId: "koshi", uploadedAt: at(addDays(today, -3), 14, 50), status: "confirmed", confidence: 0.94, linkedType: "quote", linkedId: qA?.id,
      extracted: { customerName: "新築和室 (紹介: 緒方様)", items: [{ name: "畳新調 古都 8畳", qty: 8, unitPrice: 32000 }, { name: "諸経費", qty: 1, unitPrice: 3000 }], total: 283800 } },
    { id: "doc_0002", kind: "receipt", fileName: "receipt_eneos_20261109.jpg", uploadedBy: "u07", storeId: "koshi", uploadedAt: at(addDays(today, -1), 18, 5), status: "confirmed", confidence: 0.97, linkedType: "expense", linkedId: expGas?.id,
      extracted: { vendor: "ENEOS 合志SS", date: addDays(today, -1), amount: 6820, taxAmount: 620, account: "車両費 (ガソリン代)", paymentMethod: "card" } },
    { id: "doc_0003", kind: "supplier_invoice", fileName: "請求書_い草協同組合_10月分.pdf", uploadedBy: "u14", storeId: "hq", uploadedAt: at(addDays(today, -6), 10, 30), status: "confirmed", confidence: 0.96, linkedType: "purchase", linkedId: apIgusa?.id,
      extracted: { supplier: "熊本県い草生産者協同組合", invoiceDate: apIgusa?.invoiceDate, dueDate: apIgusa?.dueDate, amount: 486200, taxAmount: 44200 } },
    { id: "doc_0004", kind: "drawing", fileName: "IMG_20261109_採寸メモ_縁側障子.jpg", uploadedBy: "u10", storeId: "nishi", uploadedAt: at(addDays(today, -1), 11, 20), status: "uploaded" },
    { id: "doc_0005", kind: "receipt", fileName: "ETC利用証明_20261109.png", uploadedBy: "u09", storeId: "chuo", uploadedAt: at(addDays(today, -1), 19, 40), status: "extracted", confidence: 0.91,
      extracted: { vendor: "NEXCO西日本 (ETC)", date: addDays(today, -1), amount: 2310, taxAmount: 210, account: "旅費交通費", paymentMethod: "card" } },
    { id: "doc_0006", kind: "handwritten_quote", fileName: "IMG_20261110_手書き見積_介護施設採寸.jpg", uploadedBy: "u12", storeId: "tamana", uploadedAt: at(today, 15, 40), status: "extracted", confidence: 0.88,
      extracted: { customerName: "介護老人保健施設 さくら苑", items: [{ name: "畳表替え きずな (抗菌)", qty: 48, unitPrice: 12000 }, { name: "古畳 引取・処分", qty: 48, unitPrice: 1000 }, { name: "諸経費", qty: 1, unitPrice: 3000 }], total: 686400, note: "手書きの数量「48」の読取確度がやや低いため要確認" } },
    { id: "doc_0007", kind: "supplier_invoice", fileName: "請求書_ふすま堂_11月.jpg", uploadedBy: "u14", storeId: "hq", uploadedAt: at(addDays(today, -5), 9, 15), status: "extracted", confidence: 0.93,
      extracted: { supplier: "和紙工房 ふすま堂", invoiceDate: addDays(today, -5), dueDate: addDays(today, 20), amount: 66000, taxAmount: 6000 } },
  ];
  db.documents.push(...docs);
  for (const d of docs) {
    audit(ctx, d.uploadedAt, d.uploadedBy, "create", "document", d.id, d.fileName, `書類を取込 (${d.kind})`, d.storeId);
  }
}

/* ------------------------------------------------------------------ */

function finalize(ctx: Ctx) {
  const { db, today } = ctx;
  // 本日のログイン
  for (const uid of ["u01", "u02", "u06", "u14"]) {
    audit(ctx, at(today, 8, 30 + Number(uid.slice(1))), uid, "login", "session", uid, db.users.find((u) => u.id === uid)!.name, "ログイン");
  }
  // 問い合わせの最終更新 = 見積の状態に追従
  for (const inq of db.inquiries) {
    if (inq.quoteId) {
      const q = db.quotes.find((x) => x.id === inq.quoteId);
      if (q) inq.updatedAt = q.updatedAt;
    }
  }
  // 顧客の更新日時 = 最新の案件
  for (const c of db.customers) {
    const latest = db.quotes.filter((q) => q.customerId === c.id).map((q) => q.updatedAt).sort().pop();
    if (latest && latest > c.updatedAt) c.updatedAt = latest;
  }
  // 時系列ソート
  db.auditLogs.sort((a, b) => a.at.localeCompare(b.at));
  db.commLogs.sort((a, b) => a.at.localeCompare(b.at));
  db.schedule.sort(compareEvents);
}

export { item as makeItem };
