import type { Channel, Customer, Database, Inquiry, MediaKey, Order, Quote, SiteInfo, SurveyResponse } from "@/lib/db/types";

/**
 * 全社共通の媒体の分類 (お客様が当社を知ったきっかけ) と、過去のデータの読み替え (対応表)
 * ------------------------------------------------------------
 * - 問い合わせ (Inquiry.media)・顧客・アンケートで同じ分類を使う。画面で登録する問い合わせは必須 (わからなければ「不明」)
 * - これまでの媒体は書類ごとに分類が違った: 手書き見積書の媒体欄 (SiteInfo.media: R・チラシ・HP…)、
 *   アンケートはがきの ⑥ (SurveyResponse.mediaList: 以前頼んだことがある・ダイレクトメール…)、
 *   販売管理ソフト (顧客のタグ「媒体:○○」。自由な文字)。これらは対応表 (settings の id = media_mapping) で読み替える
 * - 問い合わせの媒体が空のとき (移行・自動受付) は、見積 → 受注の媒体欄 → 受注のアンケート → 顧客のタグ → 入口 (紹介・イベント) の順で読み替え、
 *   どれもなければ「未分類」。読み替えた値は「推定」として分けて数える
 * このファイルは画面 (クライアント)・サーバー・テストから読むため、サーバー専用の import をしない
 */

export const MEDIA: Record<MediaKey, { label: string; hint: string }> = {
  repeat: { label: "以前のご利用 (リピート)", hint: "以前に当社を利用された・前回の担当から" },
  referral: { label: "紹介・口コミ", hint: "知人・家族・ご近所の紹介、口コミ" },
  flyer: { label: "チラシ", hint: "新聞折込・ポスティング・店舗のチラシ" },
  dm: { label: "DM・点検のご案内", hint: "ダイレクトメール・点検のはがき" },
  teleapo: { label: "テレアポ (電話のご案内)", hint: "当社からの電話のご案内" },
  event: { label: "イベント・展示会", hint: "イベント・催事・展示会の受付" },
  store: { label: "店舗・看板", hint: "店舗・ショールーム・看板を見て" },
  web: { label: "ホームページ・ネット検索", hint: "ホームページ・Google などの検索" },
  map: { label: "Google マップ", hint: "地図アプリ・Google マップ" },
  sns: { label: "SNS (インスタ・LINE など)", hint: "Instagram・LINE・Facebook・YouTube" },
  tv_radio: { label: "CM・テレビ・ラジオ", hint: "テレビ・ラジオの CM・番組" },
  paper: { label: "フリーペーパー・雑誌・パンフ", hint: "タウン誌・フリーペーパー・パンフレット" },
  business: { label: "取引先 (工務店・不動産など)", hint: "工務店・不動産・管理会社からの依頼" },
  other: { label: "その他", hint: "上のどれにも当てはまらない" },
  unknown: { label: "不明", hint: "お客様に聞けなかった・覚えていない" },
};

export const MEDIA_KEYS = Object.keys(MEDIA) as MediaKey[];
export const MEDIA_LABEL = Object.fromEntries(MEDIA_KEYS.map((k) => [k, MEDIA[k].label])) as Record<MediaKey, string>;

/** 媒体のない問い合わせ (移行・自動受付で読み替えもできないもの) */
export const UNCLASSIFIED = "未分類";
/** 絞り込み・CSV で「未分類」を表す値 */
export const MEDIA_NONE = "none";
export type MediaFilterKey = MediaKey | typeof MEDIA_NONE;

export function isMediaKey(v: unknown): v is MediaKey {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(MEDIA, v);
}

export function mediaLabel(key: MediaKey | null | undefined): string {
  return key ? MEDIA_LABEL[key] : UNCLASSIFIED;
}

/* ---------------- 対応表 (過去の値 → 全社共通の分類) ---------------- */

export const MEDIA_MAPPING_ID = "media_mapping";

/** exact = 値が同じ (空白・全角半角・大文字小文字を無視) / contains = 値に含む */
export type MediaMatch = "exact" | "contains";
export const MEDIA_MATCH_LABEL: Record<MediaMatch, string> = { exact: "同じ値", contains: "含む" };

export interface MediaRule {
  from: string;
  match: MediaMatch;
  media: MediaKey;
}

const ex = (from: string, media: MediaKey): MediaRule => ({ from, match: "exact", media });
const has = (from: string, media: MediaKey): MediaRule => ({ from, match: "contains", media });

/**
 * 既定の対応表 (上から順に見て、最初に当てはまった分類にする)。
 * 手書き見積書の媒体欄 (SITE_MEDIA_OPTIONS)・アンケートの ⑥ (MEDIA_OPTIONS)・販売管理ソフトの媒体の書き方に合わせている
 */
export const DEFAULT_MEDIA_RULES: MediaRule[] = [
  // 短い略号は「同じ値」だけ (ほかの言葉の一部と取り違えない)
  ex("R", "repeat"),
  ex("HP", "web"),
  ex("MAP", "map"),
  ex("TV", "tv_radio"),
  ex("CM", "tv_radio"),
  ex("DM", "dm"),
  ex("SNS", "sns"),
  ex("不明", "unknown"),
  ex("その他", "other"),
  has("以前", "repeat"),
  has("リピート", "repeat"),
  has("リピーター", "repeat"),
  has("前回", "repeat"),
  has("再依頼", "repeat"),
  has("紹介", "referral"),
  has("口コミ", "referral"),
  has("クチコミ", "referral"),
  has("知人", "referral"),
  has("友人", "referral"),
  has("チラシ", "flyer"),
  has("折込", "flyer"),
  has("ポスティング", "flyer"),
  has("ダイレクトメール", "dm"),
  has("点検", "dm"),
  has("はがき", "dm"),
  has("テレアポ", "teleapo"),
  has("電話案内", "teleapo"),
  has("イベント", "event"),
  has("催事", "event"),
  has("展示会", "event"),
  has("グーグルマップ", "map"),
  has("googleマップ", "map"),
  has("マップ", "map"),
  has("ホームページ", "web"),
  has("ネット", "web"),
  has("検索", "web"),
  has("web", "web"),
  has("インスタ", "sns"),
  has("instagram", "sns"),
  has("facebook", "sns"),
  has("youtube", "sns"),
  has("line", "sns"),
  has("ラジオ", "tv_radio"),
  has("テレビ", "tv_radio"),
  has("フリーペーパー", "paper"),
  has("雑誌", "paper"),
  has("タウン誌", "paper"),
  has("パンフ", "paper"),
  has("工務店", "business"),
  has("不動産", "business"),
  has("管理会社", "business"),
  has("業者", "business"),
  has("看板", "store"),
  has("店舗", "store"),
  has("来店", "store"),
  has("ショールーム", "store"),
  has("通りがかり", "store"),
];

/** 照合用に整える (全角半角・大文字小文字・空白をそろえる) */
export function normMediaText(s: string | undefined | null): string {
  return (s ?? "").normalize("NFKC").toLowerCase().replace(/[\s　・]/g, "");
}

/** 設定の対応表 (なければ既定)。壊れた行は使わない */
export function readMediaRules(db: Pick<Database, "settings">): { rules: MediaRule[]; configured: boolean; updatedAt?: string; updatedBy?: string } {
  const s = (db.settings ?? []).find((x) => x.id === MEDIA_MAPPING_ID);
  const raw = s?.value?.rules;
  if (!Array.isArray(raw)) return { rules: DEFAULT_MEDIA_RULES, configured: false };
  const rules: MediaRule[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    const from = typeof r?.from === "string" ? r.from.trim() : "";
    if (!from || !isMediaKey(r.media)) continue;
    rules.push({ from: from.slice(0, 60), match: r.match === "exact" ? "exact" : "contains", media: r.media });
  }
  return { rules, configured: true, updatedAt: s?.updatedAt, updatedBy: s?.updatedBy };
}

/** 文字 (過去の媒体の値) を分類にする。当てはまらなければ null */
export function mapMediaText(rules: MediaRule[], text: string | undefined | null): MediaKey | null {
  const t = normMediaText(text);
  if (!t) return null;
  // 分類のラベルそのもの (「チラシ」「紹介・口コミ」) と分類のコードはそのまま
  for (const k of MEDIA_KEYS) if (t === normMediaText(MEDIA[k].label) || t === k) return k;
  for (const r of rules) {
    const f = normMediaText(r.from);
    if (!f) continue;
    if (r.match === "exact" ? t === f : t.includes(f)) return r.media;
  }
  return null;
}

/* ---------------- 記録ごとの媒体 ---------------- */

/** 媒体の出どころ (input = 問い合わせに入力。ほかは過去の記録からの読み替え = 推定) */
export type MediaSource = "input" | "quote" | "order" | "survey" | "customer" | "channel" | "none";
export const MEDIA_SOURCE_LABEL: Record<MediaSource, string> = {
  input: "入力",
  quote: "見積の媒体欄から推定",
  order: "受注の媒体欄から推定",
  survey: "アンケートから推定",
  customer: "顧客の媒体 (販売管理ソフト) から推定",
  channel: "入口 (紹介・イベント) から推定",
  none: "未分類",
};

/** 入口 (Inquiry.channel) が媒体を表しているもの */
const CHANNEL_MEDIA: Partial<Record<Channel, MediaKey>> = { referral: "referral", event: "event" };

export interface MediaResult {
  media: MediaKey | null;
  source: MediaSource;
  /** 読み替えた元の値 (例: チラシ / 媒体:ホームページ) */
  raw?: string;
}

export type MediaDb = Pick<Database, "settings" | "quotes" | "orders" | "surveys" | "customers">;

/** 一覧・集計で何度も引くための索引 */
export interface MediaIndex {
  rules: MediaRule[];
  quotes: Map<string, Quote>;
  orders: Map<string, Order>;
  orderOfQuote: (q: Quote | undefined) => Order | undefined;
  surveysByOrder: Map<string, SurveyResponse[]>;
  customers: Map<string, Customer>;
  map: (text: string | undefined | null) => MediaKey | null;
}

export function mediaIndex(db: MediaDb): MediaIndex {
  const rules = readMediaRules(db).rules;
  const quotes = new Map(db.quotes.map((q) => [q.id, q]));
  const orders = new Map(db.orders.map((o) => [o.id, o]));
  const byQuote = new Map<string, Order>();
  for (const o of db.orders) {
    if (!o.quoteId) continue;
    const cur = byQuote.get(o.quoteId);
    // キャンセルでない受注を優先する
    if (!cur || (cur.status === "cancelled" && o.status !== "cancelled")) byQuote.set(o.quoteId, o);
  }
  const surveysByOrder = new Map<string, SurveyResponse[]>();
  for (const s of db.surveys ?? []) if (s.orderId) surveysByOrder.set(s.orderId, [...(surveysByOrder.get(s.orderId) ?? []), s]);
  const cache = new Map<string, MediaKey | null>();
  return {
    rules,
    quotes,
    orders,
    orderOfQuote: (q) => (q ? ((q.orderId ? orders.get(q.orderId) : undefined) ?? byQuote.get(q.id)) : undefined),
    surveysByOrder,
    customers: new Map(db.customers.map((c) => [c.id, c])),
    map: (text) => {
      const key = text ?? "";
      if (!cache.has(key)) cache.set(key, mapMediaText(rules, key));
      return cache.get(key)!;
    },
  };
}

function fromSiteInfo(ix: MediaIndex, si: SiteInfo | undefined): { media: MediaKey; raw: string } | null {
  for (const v of [...(si?.media ?? []), si?.mediaOther ?? ""]) {
    const m = ix.map(v);
    if (m) return { media: m, raw: v };
  }
  return null;
}

/** アンケートの ⑥ (複数回答) を分類にする (重複を除く) */
export function surveyMediaKeys(ix: Pick<MediaIndex, "map">, s: Pick<SurveyResponse, "media" | "mediaList">): MediaKey[] {
  const values = s.mediaList?.length ? s.mediaList : (s.media ?? "").split(/[、,，/／・\n]/);
  const out: MediaKey[] = [];
  for (const v of values) {
    const m = ix.map(v);
    if (m && !out.includes(m)) out.push(m);
  }
  return out;
}

function fromSurveys(ix: MediaIndex, orderId: string | undefined): { media: MediaKey; raw: string } | null {
  for (const s of (orderId ? ix.surveysByOrder.get(orderId) : undefined) ?? []) {
    const keys = surveyMediaKeys(ix, s);
    if (keys.length) return { media: keys[0], raw: (s.mediaList?.length ? s.mediaList.join("・") : s.media) ?? "" };
  }
  return null;
}

/** 顧客のタグ「媒体:○○」(販売管理ソフトから移行) */
export function customerTagMedia(ix: Pick<MediaIndex, "map">, c: Pick<Customer, "tags"> | undefined): { media: MediaKey; raw: string } | null {
  for (const t of c?.tags ?? []) {
    const m = /^媒体[:：](.+)$/.exec(t);
    if (!m) continue;
    const k = ix.map(m[1]);
    if (k) return { media: k, raw: t };
  }
  return null;
}

/** 問い合わせの媒体 (入力 > 見積・受注の媒体欄 > 受注のアンケート > 顧客のタグ > 入口) */
export function inquiryMedia(ix: MediaIndex, inq: Pick<Inquiry, "media" | "quoteId" | "customerId" | "channel">): MediaResult {
  if (inq.media && isMediaKey(inq.media)) return { media: inq.media, source: "input" };
  const q = inq.quoteId ? ix.quotes.get(inq.quoteId) : undefined;
  const fq = fromSiteInfo(ix, q?.siteInfo);
  if (fq) return { media: fq.media, source: "quote", raw: fq.raw };
  const o = ix.orderOfQuote(q);
  const fo = fromSiteInfo(ix, o?.siteInfo);
  if (fo) return { media: fo.media, source: "order", raw: fo.raw };
  const fs = fromSurveys(ix, o?.id);
  if (fs) return { media: fs.media, source: "survey", raw: fs.raw };
  const fc = customerTagMedia(ix, inq.customerId ? ix.customers.get(inq.customerId) : undefined);
  if (fc) return { media: fc.media, source: "customer", raw: fc.raw };
  const ch = CHANNEL_MEDIA[inq.channel];
  if (ch) return { media: ch, source: "channel", raw: inq.channel };
  return { media: null, source: "none" };
}

/** 受注の媒体 (問い合わせの媒体 > 受注・見積の媒体欄 > アンケート > 顧客のタグ)。問い合わせのない移行した受注の年度比較に使う */
export function orderMedia(ix: MediaIndex, o: Order, inquiryOfQuote: (quoteId: string) => Inquiry | undefined): MediaResult {
  const inq = o.quoteId ? inquiryOfQuote(o.quoteId) : undefined;
  if (inq) {
    const r = inquiryMedia(ix, inq);
    if (r.media) return r;
  }
  const fo = fromSiteInfo(ix, o.siteInfo);
  if (fo) return { media: fo.media, source: "order", raw: fo.raw };
  const q = o.quoteId ? ix.quotes.get(o.quoteId) : undefined;
  const fq = fromSiteInfo(ix, q?.siteInfo);
  if (fq) return { media: fq.media, source: "quote", raw: fq.raw };
  const fs = fromSurveys(ix, o.id);
  if (fs) return { media: fs.media, source: "survey", raw: fs.raw };
  const fc = customerTagMedia(ix, ix.customers.get(o.customerId));
  if (fc) return { media: fc.media, source: "customer", raw: fc.raw };
  return { media: null, source: "none" };
}

/** 顧客の媒体 (最初の問い合わせの媒体 > 顧客のタグ > 最初に連絡を受けた入口) */
export function customerMedia(ix: MediaIndex, c: Customer, inquiriesOfCustomer: Inquiry[]): MediaResult {
  const first = [...inquiriesOfCustomer].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  for (const inq of first) {
    const r = inquiryMedia(ix, inq);
    if (r.media && r.source !== "customer") return r;
  }
  const fc = customerTagMedia(ix, c);
  if (fc) return { media: fc.media, source: "customer", raw: fc.raw };
  const ch = CHANNEL_MEDIA[c.firstContactChannel];
  if (ch) return { media: ch, source: "channel", raw: c.firstContactChannel };
  return { media: null, source: "none" };
}

/** 絞り込みの値 (分類のコード・none = 未分類) に当てはまるか */
export function matchesMediaFilter(filter: string | undefined, media: MediaKey | null): boolean {
  if (!filter) return true;
  if (filter === MEDIA_NONE) return media === null;
  return media === filter;
}

/**
 * 過去の媒体の値の一覧 (対応表の画面で、どの値がどの分類になるかを確かめる)。
 * 見積・受注の媒体欄・アンケートの ⑥・顧客のタグの値を件数つきで返す
 */
export function legacyMediaValues(db: MediaDb, rules: MediaRule[]): { value: string; where: string; count: number; media: MediaKey | null }[] {
  const counts = new Map<string, { value: string; where: string; count: number }>();
  const add = (value: string | undefined, where: string) => {
    const v = (value ?? "").trim();
    if (!v) return;
    const key = `${where}\u0000${v}`;
    const cur = counts.get(key) ?? { value: v, where, count: 0 };
    cur.count++;
    counts.set(key, cur);
  };
  for (const q of db.quotes) for (const v of [...(q.siteInfo?.media ?? []), q.siteInfo?.mediaOther]) add(v, "見積の媒体欄");
  for (const o of db.orders) for (const v of [...(o.siteInfo?.media ?? []), o.siteInfo?.mediaOther]) add(v, "受注の媒体欄");
  for (const s of db.surveys ?? []) for (const v of s.mediaList?.length ? s.mediaList : (s.media ?? "").split(/[、,，/／・\n]/)) add(v, "アンケート");
  for (const c of db.customers) for (const t of c.tags ?? []) {
    const m = /^媒体[:：](.+)$/.exec(t);
    if (m) add(m[1], "顧客の媒体 (販売管理ソフト)");
  }
  return [...counts.values()].map((x) => ({ ...x, media: mapMediaText(rules, x.value) })).sort((a, b) => Number(a.media !== null) - Number(b.media !== null) || b.count - a.count);
}
