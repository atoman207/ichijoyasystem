import type { Database, Inquiry, MediaKey, Promotion, PromotionKind, PromotionStatus, StoreId, User } from "@/lib/db/types";
import { canViewStoreFigures } from "@/lib/auth/permissions";
import { cleanAddressText, normalizeAddress } from "@/lib/maps/address";
import { MEDIA_KEYS, MEDIA_LABEL, MEDIA_NONE, MEDIA_SOURCE_LABEL, UNCLASSIFIED, inquiryMedia, matchesMediaFilter, mediaIndex, orderMedia, surveyMediaKeys, type MediaIndex, type MediaSource } from "@/lib/media";
import { toDateKey } from "@/lib/format";
import { fiscalRange, fiscalYearOf, kpiSettings } from "@/lib/kpi-settings";
import { caseUnits, kpiBasis, monthKey, periodMonths } from "@/lib/kpi-basis";

/**
 * 販促と媒体の分析 (F-13)
 * ------------------------------------------------------------
 * - 問い合わせ: 受付日 (日本時間) が期間内のもの。媒体は Inquiry.media、空なら対応表で読み替えた推定 (src/lib/media.ts)。
 *   問い合わせ一覧の絞り込み (?media=…&from=…&to=…) と同じ判定なので、件数は一覧と一致する
 * - 成約: 問い合わせ → 見積 → 受注 (キャンセルを除く) があるもの、または状態が「受注」のもの。売上は その受注の契約金額 (税込)
 * - 受注 (契約日が期間内・キャンセルを除く) の媒体別: 問い合わせのない移行した受注を含む (受注の媒体欄・アンケート・顧客の媒体から読み替え)
 * - 町: お客様の住所 → 受注・見積の施工場所 → 問い合わせの地区 の市区町村・町名 (src/lib/maps/address.ts の正規化)
 * - チラシの部数: 販促の記録 (チラシ・実施済み。地域ごとの部数) + 作業日報の配布 (配布人・枚数・地域)。
 *   部数あたりの問い合わせ = その地域 (町名・市区町村) に住むお客様の、期間内の媒体「チラシ」の問い合わせ ÷ 部数 × 1,000
 * - 来店数: 作業日報の手入力
 * 店舗のロールは自店舗だけ (permissions.ts の canAccessStore)
 */

export const PROMOTION_KIND: Record<PromotionKind, { label: string; media: MediaKey; unit: string; copiesLabel: string }> = {
  flyer: { label: "チラシ", media: "flyer", unit: "部", copiesLabel: "部数" },
  event: { label: "イベント", media: "event", unit: "人", copiesLabel: "来場者数 (わかれば)" },
  dm: { label: "点検の DM", media: "dm", unit: "通", copiesLabel: "送付数" },
  teleapo: { label: "テレアポ", media: "teleapo", unit: "件", copiesLabel: "架電数" },
  other: { label: "その他", media: "other", unit: "件", copiesLabel: "数量" },
};
export const PROMOTION_KINDS = Object.keys(PROMOTION_KIND) as PromotionKind[];

export const PROMOTION_STATUS: Record<PromotionStatus, { label: string; tone: "info" | "good" | "neutral" }> = {
  planned: { label: "計画", tone: "info" },
  done: { label: "実施済み", tone: "good" },
  cancelled: { label: "中止", tone: "neutral" },
};

/** 受付日 (日本時間の日付) */
export const inquiryDate = (inq: Pick<Inquiry, "receivedAt">) => toDateKey(new Date(inq.receivedAt));

/** 町 (市区町村・町名) を取り出す。空なら "" */
export function townOf(text: string | undefined | null): string {
  if (!text?.trim()) return "";
  const n = normalizeAddress(text);
  return n.town || cleanAddressText(text).replace(/\s+/g, "");
}

/** 地域 (チラシの配布地域の書き方: 合志市 / 合志市須屋 / 須屋) がその町を含むか */
export function areaCovers(area: string, town: string): boolean {
  const a = townOf(area);
  if (!a || !town) return false;
  return town === a || town.startsWith(a) || (!/[市区町村]/.test(a) && town.includes(a));
}

type AnalysisDb = Pick<Database, "inquiries" | "quotes" | "orders" | "customers" | "surveys" | "settings" | "stores" | "promotions" | "workReportDays">;

export interface PromoScope {
  from: string;
  to: string;
  /** 対象の店舗 (閲覧できる店舗。絞り込みがあれば 1 店舗) */
  storeIds: StoreId[];
}

/** 利用者が見られる店舗 (絞り込みがあればその店舗だけ。見られない店舗の指定は無視)。経営の数字の閲覧の範囲 (policyReader の写しなら設定どおり全店舗) */
export function scopeStores(db: Pick<Database, "stores">, user: User, store?: string): StoreId[] {
  const visible = db.stores.filter((s) => canViewStoreFigures(user, s.id)).map((s) => s.id);
  return store && visible.includes(store as StoreId) ? [store as StoreId] : visible;
}

export interface InquiryFact {
  id: string;
  number: string;
  storeId: StoreId;
  date: string;
  contactName: string;
  media: MediaKey | null;
  source: MediaSource;
  raw?: string;
  town: string;
  won: boolean;
  orderId?: string;
  orderNumber?: string;
  sales: number;
  promotionId?: string;
}

interface Ctx {
  ix: MediaIndex;
  quoteByInquiry: Map<string, string>;
  inquiryByQuote: Map<string, Inquiry>;
}

function context(db: AnalysisDb): Ctx {
  const quoteByInquiry = new Map<string, string>();
  for (const q of db.quotes) if (q.inquiryId && !quoteByInquiry.has(q.inquiryId)) quoteByInquiry.set(q.inquiryId, q.id);
  const inquiryByQuote = new Map<string, Inquiry>();
  for (const i of db.inquiries) {
    const qid = i.quoteId ?? quoteByInquiry.get(i.id);
    if (qid && !inquiryByQuote.has(qid)) inquiryByQuote.set(qid, i);
  }
  return { ix: mediaIndex(db), quoteByInquiry, inquiryByQuote };
}

function factOf(ctx: Ctx, inq: Inquiry): InquiryFact {
  const qid = inq.quoteId ?? ctx.quoteByInquiry.get(inq.id);
  const q = qid ? ctx.ix.quotes.get(qid) : undefined;
  const o = ctx.ix.orderOfQuote(q);
  const live = o && o.status !== "cancelled" ? o : undefined;
  const m = inquiryMedia(ctx.ix, { ...inq, quoteId: qid });
  const c = inq.customerId ? ctx.ix.customers.get(inq.customerId) : undefined;
  const town = townOf(c?.address) || townOf(live?.siteAddress) || townOf(q?.siteAddress) || townOf(inq.area) || townOf(c?.area);
  return {
    id: inq.id,
    number: inq.number,
    storeId: inq.storeId,
    date: inquiryDate(inq),
    contactName: inq.contactName,
    media: m.media,
    source: m.source,
    raw: m.raw,
    town,
    won: Boolean(live) || inq.status === "won",
    orderId: live?.id,
    orderNumber: live?.number,
    sales: live?.total ?? 0,
    promotionId: inq.promotionId,
  };
}

/** 期間・店舗の問い合わせ (媒体・町・成約つき) */
export function inquiryFacts(db: AnalysisDb, scope: PromoScope, ctx: Ctx = context(db)): InquiryFact[] {
  const stores = new Set(scope.storeIds);
  const out: InquiryFact[] = [];
  for (const inq of db.inquiries) {
    // 削除した問い合わせ (誤って登録したもの) は数えない
    if (inq.deleted || !stores.has(inq.storeId)) continue;
    const d = inquiryDate(inq);
    if (d < scope.from || d > scope.to) continue;
    out.push(factOf(ctx, inq));
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number));
}

/**
 * 問い合わせ一覧の絞り込み (媒体・受付日)。分析と同じ判定 (件数が一致する)
 * media: 分類のコード / none (未分類) / 空 (すべて)
 */
export function filterInquiries<T extends Inquiry>(db: AnalysisDb, rows: T[], f: { media?: string; from?: string; to?: string }): T[] {
  let out = rows;
  if (f.from) out = out.filter((i) => inquiryDate(i) >= f.from!);
  if (f.to) out = out.filter((i) => inquiryDate(i) <= f.to!);
  if (f.media) {
    const ctx = context(db);
    out = out.filter((i) => matchesMediaFilter(f.media, inquiryMedia(ctx.ix, { ...i, quoteId: i.quoteId ?? ctx.quoteByInquiry.get(i.id) }).media));
  }
  return out;
}

/** 一覧に出す媒体 (問い合わせごと) */
export function inquiryMediaMap(db: AnalysisDb, rows: Inquiry[]): Map<string, { media: MediaKey | null; source: MediaSource; raw?: string }> {
  const ctx = context(db);
  return new Map(rows.map((i) => [i.id, inquiryMedia(ctx.ix, { ...i, quoteId: i.quoteId ?? ctx.quoteByInquiry.get(i.id) })]));
}

/* ---------------- チラシの部数 ---------------- */

export interface FlyerDrop {
  source: "promotion" | "work_report";
  id: string;
  storeId: StoreId;
  date: string;
  area: string;
  copies: number;
  label: string;
  promotionId?: string;
}

/** 期間・店舗のチラシの配布 (販促の記録の実施済みのチラシ + 作業日報の配布) */
export function flyerDrops(db: Pick<Database, "promotions" | "workReportDays">, scope: PromoScope): FlyerDrop[] {
  const stores = new Set(scope.storeIds);
  const out: FlyerDrop[] = [];
  for (const p of db.promotions ?? []) {
    if (p.kind !== "flyer" || p.status !== "done" || !stores.has(p.storeId) || p.startDate < scope.from || p.startDate > scope.to) continue;
    if (p.areas.length) for (const a of p.areas) out.push({ source: "promotion", id: p.id, storeId: p.storeId, date: p.startDate, area: a.area, copies: a.copies, label: `${p.number} ${p.title}`, promotionId: p.id });
    else out.push({ source: "promotion", id: p.id, storeId: p.storeId, date: p.startDate, area: "", copies: p.copies, label: `${p.number} ${p.title}`, promotionId: p.id });
  }
  for (const w of db.workReportDays ?? []) {
    if (!stores.has(w.storeId) || w.date < scope.from || w.date > scope.to) continue;
    w.flyers.forEach((f, i) => out.push({ source: "work_report", id: `${w.id}#${i}`, storeId: w.storeId, date: w.date, area: f.area ?? "", copies: f.copies, label: `作業日報 ${f.distributor}` }));
  }
  return out;
}

/* ---------------- 集計 ---------------- */

export interface MediaRow {
  key: MediaKey | typeof MEDIA_NONE;
  label: string;
  inquiries: number;
  /** うち入力 */
  input: number;
  /** うち読み替え (推定) */
  estimated: number;
  won: number;
  sales: number;
  /** 受注 (契約日が期間内) の件数と金額 */
  orders: number;
  orderAmount: number;
}

export interface AreaRow {
  town: string;
  inquiries: number;
  flyerInquiries: number;
  won: number;
  sales: number;
  /** この町と同じ書き方で登録したチラシの部数 */
  copies: number;
}

export interface FlyerAreaRow {
  area: string;
  copies: number;
  fromPromotions: number;
  fromWorkReports: number;
  /** その地域のお客様の問い合わせ (すべての媒体) */
  inquiries: number;
  /** その地域のお客様の媒体「チラシ」の問い合わせ */
  flyerInquiries: number;
  won: number;
  sales: number;
  /** 1,000 部あたりのチラシの問い合わせ */
  per1000: number | null;
}

export interface MonthRow {
  month: string;
  copies: number;
  visitors: number;
  inquiries: number;
  flyerInquiries: number;
  won: number;
  sales: number;
  promotions: number;
}

export interface YearRow {
  fy: number;
  from: string;
  to: string;
  inquiries: number;
  won: number;
  sales: number;
  byMedia: Record<string, { inquiries: number; won: number; sales: number; orders: number; orderAmount: number }>;
  flyerCopies: number;
  plannedCopies: number;
  visitors: number;
}

export interface PromotionRow {
  promotion: Promotion;
  inquiries: number;
  won: number;
  sales: number;
  per1000: number | null;
}

/**
 * 販促 KPI (経営分析用。お客様のご指示 2026-11-24「販促KPIは経営分析に使用するもので、インセンティブの計算には関係ありませんので、別々の指標として管理」)。
 * 個人件数は売上の実績どおり 1 件ずつ (リピートもまとめない)。アンケート返信率の分母 (リピートを 1 件。kpi-basis.ts) とは別の数字
 */
export interface PromoStoreKpi {
  storeId: StoreId | "all";
  /** 全案件数 (売上台帳の現場名の行 + 新システムで完了した受注) */
  cases: number;
  /** 個人のお客様の案件 (リピートも 1 件ずつ) */
  individualCases: number;
  /** 個人のお客様の売上 (税込。案件の受注の金額) */
  individualSales: number;
  /** 個人客単価 (税込) */
  unitPrice: number | null;
  /** 年間チラシ計画の個人件数 (本年度実績。値のある月の合計) と値のある月の数 */
  plan?: { value: number; months: number; of: number };
  flyerCopies: number;
  inquiries: number;
  flyerInquiries: number;
  won: number;
  /** チラシ 1,000 部あたりのチラシの問い合わせ */
  per1000: number | null;
  /** 成約率 (成約 ÷ 問い合わせ) */
  winRate: number | null;
}

export interface PromoReport {
  scope: PromoScope;
  /** 販促 KPI (店舗ごと + 合計。経営分析用・インセンティブには使わない) */
  kpi: PromoStoreKpi[];
  facts: InquiryFact[];
  totals: { inquiries: number; input: number; estimated: number; unclassified: number; won: number; sales: number; flyerCopies: number; visitors: number };
  media: MediaRow[];
  months: MonthRow[];
  flyerAreas: FlyerAreaRow[];
  areas: AreaRow[];
  surveys: { key: MediaKey; label: string; count: number }[];
  surveyCount: number;
  promotions: PromotionRow[];
  years: YearRow[];
}

const per1000 = (n: number, copies: number) => (copies > 0 ? Math.round((n / copies) * 1000 * 100) / 100 : null);

function mediaKeyOf(m: MediaKey | null): MediaKey | typeof MEDIA_NONE {
  return m ?? MEDIA_NONE;
}

/** 受注 (契約日が期間内・キャンセルを除く) の媒体別 */
function orderMediaCounts(db: AnalysisDb, ctx: Ctx, scope: PromoScope): Map<string, { orders: number; orderAmount: number }> {
  const stores = new Set(scope.storeIds);
  const out = new Map<string, { orders: number; orderAmount: number }>();
  for (const o of db.orders) {
    if (o.status === "cancelled" || !stores.has(o.storeId) || !o.contractDate || o.contractDate < scope.from || o.contractDate > scope.to) continue;
    const m = orderMedia(ctx.ix, o, (qid) => ctx.inquiryByQuote.get(qid));
    const k = mediaKeyOf(m.media);
    const cur = out.get(k) ?? { orders: 0, orderAmount: 0 };
    cur.orders++;
    cur.orderAmount += o.total;
    out.set(k, cur);
  }
  return out;
}

function mediaRows(facts: InquiryFact[], orders: Map<string, { orders: number; orderAmount: number }>): MediaRow[] {
  const rows = new Map<string, MediaRow>();
  const keys: (MediaKey | typeof MEDIA_NONE)[] = [...MEDIA_KEYS, MEDIA_NONE];
  for (const k of keys) rows.set(k, { key: k, label: k === MEDIA_NONE ? UNCLASSIFIED : MEDIA_LABEL[k], inquiries: 0, input: 0, estimated: 0, won: 0, sales: 0, orders: orders.get(k)?.orders ?? 0, orderAmount: orders.get(k)?.orderAmount ?? 0 });
  for (const f of facts) {
    const r = rows.get(mediaKeyOf(f.media))!;
    r.inquiries++;
    if (f.source === "input") r.input++;
    else if (f.media) r.estimated++;
    if (f.won) r.won++;
    r.sales += f.sales;
  }
  return keys.map((k) => rows.get(k)!).filter((r) => r.inquiries || r.orders || (r.key !== MEDIA_NONE && r.key !== "other" && r.key !== "business"));
}

/** 月の一覧 (YYYY-MM)。最大 60 か月 */
function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const end = to.slice(0, 7);
  while (out.length < 60) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    if (key > end) break;
    out.push(key);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

/** 販促 KPI の店舗ごとの行 + 合計 (scope の店舗が 2 つ以上のとき) */
function promoStoreKpis(db: AnalysisDb, scope: PromoScope, facts: InquiryFact[], drops: FlyerDrop[]): PromoStoreKpi[] {
  const basis = kpiBasis(db);
  const cmap = new Map(db.customers.map((c) => [c.id, c]));
  const months = periodMonths({ from: scope.from, to: scope.to });
  const full = new Set(months.filter((m) => m.full).map((m) => m.month));
  const any = new Set(months.map((m) => m.month));
  const take = (month: string, date: string) => full.has(month) || (any.has(month) && date >= scope.from && date <= scope.to);
  const orders = new Map(db.orders.map((o) => [o.id, o]));
  const rows = new Map<string, PromoStoreKpi>();
  const row = (id: StoreId | "all") => {
    let r = rows.get(id);
    if (!r) rows.set(id, (r = { storeId: id, cases: 0, individualCases: 0, individualSales: 0, unitPrice: null, flyerCopies: 0, inquiries: 0, flyerInquiries: 0, won: 0, per1000: null, winRate: null }));
    return r;
  };
  for (const id of scope.storeIds) row(id);
  const sold = new Map<string, Set<string>>();
  for (const u of caseUnits(db.orders, basis.repeatDays)) {
    if (!rows.has(u.storeId) || !take(u.month, u.date)) continue;
    const r = row(u.storeId);
    r.cases++;
    if (cmap.get(u.customerId)?.type === "corporate") continue;
    r.individualCases++;
    // 売上は受注ごとに 1 回 (同じ日の追加工事の行をまとめた受注は行が 2 つでも金額は 1 回)
    const seen = sold.get(u.storeId) ?? new Set<string>();
    if (!seen.has(u.orderId)) {
      seen.add(u.orderId);
      r.individualSales += orders.get(u.orderId)?.total ?? 0;
    }
    sold.set(u.storeId, seen);
  }
  for (const d of drops) if (rows.has(d.storeId)) row(d.storeId).flyerCopies += d.copies;
  for (const f of facts) {
    if (!rows.has(f.storeId)) continue;
    const r = row(f.storeId);
    r.inquiries++;
    if (f.media === "flyer") r.flyerInquiries++;
    if (f.won) r.won++;
  }
  for (const id of scope.storeIds) {
    const vals = [...full].map((m) => basis.months[monthKey(id, m)]?.individual).filter((v): v is number => v !== undefined);
    if (vals.length) row(id).plan = { value: vals.reduce((a, b) => a + b, 0), months: vals.length, of: full.size };
  }
  const list = scope.storeIds.map((id) => row(id));
  if (list.length > 1) {
    const t = row("all");
    for (const r of list) {
      t.cases += r.cases;
      t.individualCases += r.individualCases;
      t.individualSales += r.individualSales;
      t.flyerCopies += r.flyerCopies;
      t.inquiries += r.inquiries;
      t.flyerInquiries += r.flyerInquiries;
      t.won += r.won;
      if (r.plan) t.plan = { value: (t.plan?.value ?? 0) + r.plan.value, months: Math.min(t.plan?.months ?? r.plan.months, r.plan.months), of: r.plan.of };
    }
    if (list.some((r) => !r.plan)) delete t.plan;
    list.push(t);
  }
  for (const r of list) {
    // 客単価 = 個人の売上 ÷ 個人件数 (年間チラシ計画の「個人客単価」と同じ割り方。件数はリピートも 1 件ずつ)
    r.unitPrice = r.individualCases ? Math.round(r.individualSales / r.individualCases) : null;
    r.per1000 = per1000(r.flyerInquiries, r.flyerCopies);
    r.winRate = r.inquiries ? r.won / r.inquiries : null;
  }
  return list;
}

export function promoReport(db: AnalysisDb, user: User, opts: { from: string; to: string; store?: string; years?: number }): PromoReport {
  const scope: PromoScope = { from: opts.from, to: opts.to, storeIds: scopeStores(db, user, opts.store) };
  const stores = new Set(scope.storeIds);
  const ctx = context(db);
  const facts = inquiryFacts(db, scope, ctx);
  const drops = flyerDrops(db, scope);
  const visitorDays = (db.workReportDays ?? []).filter((w) => stores.has(w.storeId) && w.date >= scope.from && w.date <= scope.to && w.visitors !== undefined);

  // 媒体別
  const media = mediaRows(facts, orderMediaCounts(db, ctx, scope));

  // 月別
  const months: MonthRow[] = monthsBetween(scope.from, scope.to).map((month) => {
    const fs = facts.filter((f) => f.date.startsWith(month));
    return {
      month,
      copies: drops.filter((d) => d.date.startsWith(month)).reduce((a, d) => a + d.copies, 0),
      visitors: visitorDays.filter((w) => w.date.startsWith(month)).reduce((a, w) => a + (w.visitors ?? 0), 0),
      inquiries: fs.length,
      flyerInquiries: fs.filter((f) => f.media === "flyer").length,
      won: fs.filter((f) => f.won).length,
      sales: fs.reduce((a, f) => a + f.sales, 0),
      promotions: (db.promotions ?? []).filter((p) => stores.has(p.storeId) && p.status === "done" && p.startDate.startsWith(month)).length,
    };
  });

  // チラシの地域別の反応 (登録した地域の書き方ごと)
  const byArea = new Map<string, FlyerAreaRow>();
  for (const d of drops) {
    const key = townOf(d.area);
    const label = key || "(地域の登録なし)";
    const cur = byArea.get(label) ?? { area: label, copies: 0, fromPromotions: 0, fromWorkReports: 0, inquiries: 0, flyerInquiries: 0, won: 0, sales: 0, per1000: null };
    cur.copies += d.copies;
    if (d.source === "promotion") cur.fromPromotions += d.copies;
    else cur.fromWorkReports += d.copies;
    byArea.set(label, cur);
  }
  for (const row of byArea.values()) {
    if (row.area === "(地域の登録なし)") continue;
    const inArea = facts.filter((f) => areaCovers(row.area, f.town));
    row.inquiries = inArea.length;
    const fl = inArea.filter((f) => f.media === "flyer");
    row.flyerInquiries = fl.length;
    row.won = fl.filter((f) => f.won).length;
    row.sales = fl.reduce((a, f) => a + f.sales, 0);
    row.per1000 = per1000(row.flyerInquiries, row.copies);
  }
  const flyerAreas = [...byArea.values()].sort((a, b) => Number(a.area === "(地域の登録なし)") - Number(b.area === "(地域の登録なし)") || b.copies - a.copies);

  // 町別
  const towns = new Map<string, AreaRow>();
  for (const f of facts) {
    const t = f.town || "(住所なし)";
    const cur = towns.get(t) ?? { town: t, inquiries: 0, flyerInquiries: 0, won: 0, sales: 0, copies: 0 };
    cur.inquiries++;
    if (f.media === "flyer") cur.flyerInquiries++;
    if (f.won) cur.won++;
    cur.sales += f.sales;
    towns.set(t, cur);
  }
  for (const d of drops) {
    const t = townOf(d.area);
    const cur = t ? towns.get(t) : undefined;
    if (cur) cur.copies += d.copies;
  }
  const areas = [...towns.values()].sort((a, b) => b.inquiries - a.inquiries || a.town.localeCompare(b.town));

  // アンケートの ⑥ (複数回答。全社共通の分類に読み替え)
  const surveyCounts = new Map<MediaKey, number>();
  let surveyCount = 0;
  for (const s of db.surveys ?? []) {
    const d = (s.answeredOn || s.receivedAt || "").slice(0, 10);
    if (!stores.has(s.storeId) || !d || d < scope.from || d > scope.to) continue;
    const keys = surveyMediaKeys(ctx.ix, s);
    if (!keys.length) continue;
    surveyCount++;
    for (const k of keys) surveyCounts.set(k, (surveyCounts.get(k) ?? 0) + 1);
  }
  const surveys = MEDIA_KEYS.filter((k) => surveyCounts.get(k)).map((k) => ({ key: k, label: MEDIA_LABEL[k], count: surveyCounts.get(k)! })).sort((a, b) => b.count - a.count);

  // 販促ごと
  const promotions: PromotionRow[] = (db.promotions ?? [])
    .filter((p) => stores.has(p.storeId) && p.startDate >= scope.from && p.startDate <= scope.to)
    .sort((a, b) => b.startDate.localeCompare(a.startDate))
    .map((p) => {
      const linked = db.inquiries.filter((i) => i.promotionId === p.id && !i.deleted).map((i) => factOf(ctx, i));
      return { promotion: p, inquiries: linked.length, won: linked.filter((f) => f.won).length, sales: linked.reduce((a, f) => a + f.sales, 0), per1000: per1000(linked.length, p.copies) };
    });

  // 年度の比較 (期間の終わりの年度と、その前の年度)
  const startMonth = kpiSettings(db).fiscalStartMonth;
  const lastFy = fiscalYearOf(scope.to, startMonth);
  const years: YearRow[] = [];
  for (let fy = lastFy - Math.max(0, (opts.years ?? 3) - 1); fy <= lastFy; fy++) {
    const r = fiscalRange(fy, startMonth);
    const ys: PromoScope = { from: r.from, to: r.to, storeIds: scope.storeIds };
    const yf = inquiryFacts(db, ys, ctx);
    const yo = orderMediaCounts(db, ctx, ys);
    const byMedia: YearRow["byMedia"] = {};
    for (const k of [...MEDIA_KEYS, MEDIA_NONE]) byMedia[k] = { inquiries: 0, won: 0, sales: 0, orders: yo.get(k)?.orders ?? 0, orderAmount: yo.get(k)?.orderAmount ?? 0 };
    for (const f of yf) {
      const b = byMedia[mediaKeyOf(f.media)];
      b.inquiries++;
      if (f.won) b.won++;
      b.sales += f.sales;
    }
    const plannedCopies = (db.promotions ?? []).filter((p) => p.kind === "flyer" && p.status === "planned" && stores.has(p.storeId) && p.startDate >= r.from && p.startDate <= r.to).reduce((a, p) => a + p.copies, 0);
    years.push({
      fy,
      from: r.from,
      to: r.to,
      inquiries: yf.length,
      won: yf.filter((f) => f.won).length,
      sales: yf.reduce((a, f) => a + f.sales, 0),
      byMedia,
      flyerCopies: flyerDrops(db, ys).reduce((a, d) => a + d.copies, 0),
      plannedCopies,
      visitors: (db.workReportDays ?? []).filter((w) => stores.has(w.storeId) && w.date >= r.from && w.date <= r.to).reduce((a, w) => a + (w.visitors ?? 0), 0),
    });
  }

  return {
    scope,
    kpi: promoStoreKpis(db, scope, facts, drops),
    facts,
    totals: {
      inquiries: facts.length,
      input: facts.filter((f) => f.source === "input").length,
      estimated: facts.filter((f) => f.source !== "input" && f.media).length,
      unclassified: facts.filter((f) => !f.media).length,
      won: facts.filter((f) => f.won).length,
      sales: facts.reduce((a, f) => a + f.sales, 0),
      flyerCopies: drops.reduce((a, d) => a + d.copies, 0),
      visitors: visitorDays.reduce((a, w) => a + (w.visitors ?? 0), 0),
    },
    media,
    months,
    flyerAreas,
    areas,
    surveys,
    surveyCount,
    promotions,
    years,
  };
}

/* ---------------- CSV ---------------- */

export const PROMO_CSV_SECTIONS = {
  kpi: "販促 KPI (店舗別)",
  media: "媒体別",
  monthly: "月別 (チラシの部数・来店数・問い合わせ)",
  flyers: "チラシの地域別の反応",
  areas: "町別",
  years: "年度の比較",
  promotions: "販促ごとの反応",
  surveys: "アンケートの媒体",
  inquiries: "問い合わせの明細",
} as const;
export type PromoCsvSection = keyof typeof PROMO_CSV_SECTIONS;

export function promoCsvRows(r: PromoReport, section: PromoCsvSection, storeName: (id: StoreId) => string): (string | number)[][] {
  switch (section) {
    case "kpi":
      return [
        ["店舗", "全案件数", "個人件数 (1 件ずつ)", "年間チラシ計画の個人件数", "計画の値のある月", "個人の売上 (税込)", "個人客単価 (税込)", "チラシの部数", "問い合わせ", "チラシの問い合わせ", "1,000 部あたり", "成約", "成約率"],
        ...r.kpi.map((k) => [k.storeId === "all" ? "合計" : storeName(k.storeId), k.cases, k.individualCases, k.plan?.value ?? "", k.plan ? `${k.plan.months}/${k.plan.of}` : "", k.individualSales, k.unitPrice ?? "", k.flyerCopies, k.inquiries, k.flyerInquiries, k.per1000 ?? "", k.won, k.winRate === null ? "" : `${(k.winRate * 100).toFixed(1)}%`]),
      ];
    case "media":
      return [["媒体", "問い合わせ", "うち入力", "うち読み替え (推定)", "成約", "成約率 (%)", "成約の売上 (税込)", "受注 (契約日が期間内)", "受注金額 (税込)"], ...r.media.map((m) => [m.label, m.inquiries, m.input, m.estimated, m.won, m.inquiries ? Math.round((m.won / m.inquiries) * 1000) / 10 : "", m.sales, m.orders, m.orderAmount]), ["合計", r.totals.inquiries, r.totals.input, r.totals.estimated, r.totals.won, r.totals.inquiries ? Math.round((r.totals.won / r.totals.inquiries) * 1000) / 10 : "", r.totals.sales, r.media.reduce((a, m) => a + m.orders, 0), r.media.reduce((a, m) => a + m.orderAmount, 0)]];
    case "monthly":
      return [["月", "チラシの部数", "来店数", "問い合わせ", "うちチラシ", "成約", "成約の売上 (税込)", "実施した販促"], ...r.months.map((m) => [m.month, m.copies, m.visitors, m.inquiries, m.flyerInquiries, m.won, m.sales, m.promotions])];
    case "flyers":
      return [["配布地域", "部数", "うち販促の記録", "うち作業日報", "その地域の問い合わせ", "うちチラシ", "チラシの成約", "チラシの成約の売上 (税込)", "1,000 部あたりのチラシの問い合わせ"], ...r.flyerAreas.map((a) => [a.area, a.copies, a.fromPromotions, a.fromWorkReports, a.inquiries, a.flyerInquiries, a.won, a.sales, a.per1000 ?? ""])];
    case "areas":
      return [["町", "問い合わせ", "うちチラシ", "成約", "成約の売上 (税込)", "チラシの部数 (同じ町名で登録)"], ...r.areas.map((a) => [a.town, a.inquiries, a.flyerInquiries, a.won, a.sales, a.copies])];
    case "years": {
      const head = ["媒体", ...r.years.flatMap((y) => [`${y.fy}年度 問い合わせ`, `${y.fy}年度 成約`, `${y.fy}年度 成約の売上`, `${y.fy}年度 受注`, `${y.fy}年度 受注金額`])];
      const keys = [...MEDIA_KEYS, MEDIA_NONE];
      const rows: (string | number)[][] = [head];
      for (const k of keys) {
        if (!r.years.some((y) => y.byMedia[k].inquiries || y.byMedia[k].orders)) continue;
        rows.push([k === MEDIA_NONE ? UNCLASSIFIED : MEDIA_LABEL[k as MediaKey], ...r.years.flatMap((y) => [y.byMedia[k].inquiries, y.byMedia[k].won, y.byMedia[k].sales, y.byMedia[k].orders, y.byMedia[k].orderAmount])]);
      }
      rows.push(["合計", ...r.years.flatMap((y) => [y.inquiries, y.won, y.sales, Object.values(y.byMedia).reduce((a, b) => a + b.orders, 0), Object.values(y.byMedia).reduce((a, b) => a + b.orderAmount, 0)])]);
      rows.push(["チラシの部数 (実施)", ...r.years.flatMap((y) => [y.flyerCopies, "", "", "", ""])]);
      rows.push(["チラシの部数 (計画・未実施)", ...r.years.flatMap((y) => [y.plannedCopies, "", "", "", ""])]);
      rows.push(["来店数", ...r.years.flatMap((y) => [y.visitors, "", "", "", ""])]);
      return rows;
    }
    case "promotions":
      return [["番号", "種類", "名前", "店舗", "状態", "配布日・開始日", "終了日", "地域と部数", "部数・件数", "費用", "媒体", "問い合わせ", "成約", "成約の売上 (税込)", "1,000 あたりの問い合わせ"], ...r.promotions.map(({ promotion: p, inquiries, won, sales, per1000: pk }) => [p.number, PROMOTION_KIND[p.kind].label, p.title, storeName(p.storeId), PROMOTION_STATUS[p.status].label, p.startDate, p.endDate ?? "", p.areas.map((a) => `${a.area} ${a.copies}`).join(" / "), p.copies, p.cost ?? "", MEDIA_LABEL[p.media], inquiries, won, sales, pk ?? ""])];
    case "surveys":
      return [["媒体 (アンケートの ⑥。複数回答)", "回答数"], ...r.surveys.map((s) => [s.label, s.count]), ["媒体に回答したアンケート", r.surveyCount]];
    case "inquiries":
      return [["受付日", "問い合わせ番号", "店舗", "お客様", "媒体", "媒体の出どころ", "読み替えた元の値", "町", "成約", "受注番号", "受注金額 (税込)", "販促"], ...r.facts.map((f) => [f.date, f.number, storeName(f.storeId), f.contactName, f.media ? MEDIA_LABEL[f.media] : UNCLASSIFIED, MEDIA_SOURCE_LABEL[f.source], f.raw ?? "", f.town, f.won ? "成約" : "", f.orderNumber ?? "", f.sales || "", f.promotionId ?? ""])];
  }
}
