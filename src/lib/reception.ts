import type { CapturedDocument, Channel, Customer, Database, ServiceCategory, StoreId, Supplier, User } from "@/lib/db/types";
import { CATEGORY_LABEL, INQUIRY_STATUS, ORDER_STATUS, QUOTE_STATUS } from "@/lib/constants";
import { customerHasPhone, phoneDigits } from "@/lib/customer-contacts";
import { canAccessStore } from "@/lib/auth/permissions";
import { findDuplicateCustomers } from "@/lib/duplicates";

/**
 * 受付 (すべての問い合わせの共通の入口)
 * ------------------------------------------------------------
 * 来店・イベント・現場の紹介の手書きメモの写真、担当者の携帯にかかった電話を話して入力・文章で入力、
 * 会社の電話の録音 (または電話のシステムから届く文字起こし) を、同じ形の「受付」にして確認待ちに入れる。
 * 1. AI が項目 (お名前・住所・電話・内容など) を読み取り、内容の種類を判定する (src/lib/ai/reception.ts)
 *    新しい問い合わせ / 進行中の案件の連絡 / 仕入先・協力業者 / 営業・勧誘 / 社内の連絡 / その他
 * 2. このファイルの matchReception が、電話番号・お名前で登録済みのお客様と仕入先を探し、そのお客様の進行中の案件を並べ、
 *    登録先の候補 (問い合わせとして登録 / 案件に履歴を追加 / 記録だけ / 記録しない) を出す
 * 3. 担当者が画面 (/inquiries/reception/[id]) で確かめて直し、登録する (src/lib/actions/reception.ts)。AI の判定だけでは何も登録しない
 * 受付は取込書類 (documents。kind = reception) に持つ (元の写真は書類の添付ファイル → 登録先に付け替える)。録音の本体は保存せず、文字起こしだけを残す
 */

export type ReceptionType = "new_inquiry" | "existing_case" | "supplier" | "sales" | "internal" | "other";

export const RECEPTION_TYPE_LABEL: Record<ReceptionType, string> = {
  new_inquiry: "新しい問い合わせ",
  existing_case: "進行中の案件の連絡 (日程の変更・確認など)",
  supplier: "仕入先・協力業者からの連絡",
  sales: "営業・勧誘の電話",
  internal: "社内の連絡",
  other: "その他 (判断できない)",
};

export const RECEPTION_TYPE_SHORT: Record<ReceptionType, string> = {
  new_inquiry: "新規",
  existing_case: "案件の連絡",
  supplier: "仕入先・業者",
  sales: "営業電話",
  internal: "社内",
  other: "その他",
};

export const RECEPTION_TYPE_TONE: Record<ReceptionType, "accent" | "info" | "neutral" | "warn"> = {
  new_inquiry: "accent",
  existing_case: "info",
  supplier: "neutral",
  sales: "neutral",
  internal: "neutral",
  other: "warn",
};

export const RECEPTION_TYPES = Object.keys(RECEPTION_TYPE_LABEL) as ReceptionType[];

export const isReceptionType = (v: unknown): v is ReceptionType => typeof v === "string" && v in RECEPTION_TYPE_LABEL;

/** 受付の入り方 */
export type ReceptionSource = "photo" | "voice" | "text" | "audio" | "phone_api";

export const RECEPTION_SOURCE_LABEL: Record<ReceptionSource, string> = {
  photo: "手書きメモの写真",
  voice: "話して入力",
  text: "文章で入力",
  audio: "通話の録音",
  phone_api: "電話のシステム (自動)",
};

/** 受付の入口 (問い合わせの入口 Channel のうち、この画面で選ぶもの) */
export const RECEPTION_CHANNELS: Channel[] = ["phone", "mobile", "visit", "event", "referral", "mail", "email", "line", "unknown"];

/** 読み取った項目 (documents.extracted。AI の項目名と同じ。src/lib/ai/reception.ts の SCHEMA) */
export interface ReceptionFields {
  callType: ReceptionType | "";
  callTypeReason: string;
  customerName: string;
  kana: string;
  phone: string;
  otherPhone: string;
  email: string;
  postalCode: string;
  address: string;
  /** 種別 (畳・襖・障子・網戸・カーテン・クロス・その他) のラベル */
  category: string;
  summary: string;
  detail: string;
  desiredDate: string;
  urgency: "high" | "normal" | "low" | "";
  callback: "要" | "不要" | "";
  mediaText: string;
  storeHint: string;
  staffName: string;
  /** 受付の日時 (メモに書かれていれば。YYYY-MM-DDTHH:mm、日本時間) */
  receivedAt: string;
  /** 既存の案件の手がかり (案件番号・「先週表替えした件」など) */
  caseHint: string;
  /** 仕入先・業者・営業電話の会社名 */
  companyName: string;
  /** メモに書かれた文字そのまま (写真のとき) */
  memoText: string;
  uncertainFields: string[];
}

export const RECEPTION_FIELD_KEYS: (keyof ReceptionFields)[] = [
  "callType",
  "callTypeReason",
  "customerName",
  "kana",
  "phone",
  "otherPhone",
  "email",
  "postalCode",
  "address",
  "category",
  "summary",
  "detail",
  "desiredDate",
  "urgency",
  "callback",
  "mediaText",
  "storeHint",
  "staffName",
  "receivedAt",
  "caseHint",
  "companyName",
  "memoText",
  "uncertainFields",
];

export const RECEPTION_FIELD_LABEL: Record<keyof ReceptionFields, string> = {
  callType: "内容の種類",
  callTypeReason: "判定の理由",
  customerName: "お名前",
  kana: "ふりがな",
  phone: "電話番号",
  otherPhone: "ほかの電話番号",
  email: "メール",
  postalCode: "郵便番号",
  address: "住所",
  category: "種別",
  summary: "用件 (要約)",
  detail: "内容",
  desiredDate: "希望の日時",
  urgency: "緊急度",
  callback: "折返し",
  mediaText: "当社を知ったきっかけ",
  storeHint: "店舗・地域",
  staffName: "受けた人",
  receivedAt: "受付日時",
  caseHint: "案件の手がかり",
  companyName: "会社名",
  memoText: "メモの文字",
  uncertainFields: "要確認の項目",
};

const str = (v: unknown, max = 2000): string => (typeof v === "string" ? v.trim().slice(0, max) : typeof v === "number" ? String(v) : "");

/** 受け取った値 (AI・画面の入力) を受付の項目にそろえる */
export function normalizeReception(raw: Record<string, unknown>): ReceptionFields {
  const urgency = str(raw.urgency);
  const callback = str(raw.callback);
  const callType = str(raw.callType);
  const cat = str(raw.category);
  const catLabel = (Object.values(CATEGORY_LABEL) as string[]).includes(cat) ? cat : (CATEGORY_LABEL as Record<string, string>)[cat] ?? "";
  const received = str(raw.receivedAt).replace(" ", "T").slice(0, 16);
  return {
    callType: isReceptionType(callType) ? callType : "",
    callTypeReason: str(raw.callTypeReason, 300),
    customerName: str(raw.customerName, 60).replace(/\s*(様|さま|殿)$/, ""),
    kana: str(raw.kana, 60),
    phone: str(raw.phone, 40),
    otherPhone: str(raw.otherPhone, 40),
    email: str(raw.email, 120),
    postalCode: str(raw.postalCode, 10),
    address: str(raw.address, 200),
    category: catLabel,
    summary: str(raw.summary, 100),
    detail: str(raw.detail, 4000),
    desiredDate: str(raw.desiredDate, 100),
    urgency: urgency === "high" || urgency === "normal" || urgency === "low" ? urgency : "",
    callback: callback === "要" || callback === "不要" ? callback : "",
    mediaText: str(raw.mediaText, 100),
    storeHint: str(raw.storeHint, 60),
    staffName: str(raw.staffName, 40),
    receivedAt: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(received) ? received : /^\d{4}-\d{2}-\d{2}$/.test(received.slice(0, 10)) && received.length === 10 ? `${received}T00:00` : "",
    caseHint: str(raw.caseHint, 200),
    companyName: str(raw.companyName, 80),
    memoText: str(raw.memoText, 4000),
    uncertainFields: Array.isArray(raw.uncertainFields) ? (raw.uncertainFields as unknown[]).map((x) => str(x, 40)).filter((x) => RECEPTION_FIELD_KEYS.includes(x as keyof ReceptionFields)).slice(0, 20) : [],
  };
}

/** 種別のラベル → コード (分からなければ other) */
export function categoryKey(label: string): ServiceCategory {
  return ((Object.keys(CATEGORY_LABEL) as ServiceCategory[]).find((k) => CATEGORY_LABEL[k] === label || k === label) ?? "other") as ServiceCategory;
}

/* ================================================================== */
/* AI を使わない読み取り (AI のキーがないとき・AI が失敗したときの下書き)     */
/* ================================================================== */

const CATEGORY_WORDS: [string, RegExp][] = [
  ["畳", /畳|たたみ|タタミ|表替|裏返|新調|へり|縁/],
  ["襖", /襖|ふすま|フスマ/],
  ["障子", /障子|しょうじ/],
  ["網戸", /網戸|あみど|アミド/],
  ["カーテン", /カーテン|ブラインド/],
  ["クロス", /クロス|壁紙/],
];

const TYPE_WORDS: [ReceptionType, RegExp][] = [
  ["sales", /営業の(お電話|ご案内)|ご提案させて|広告の|掲載の|ホームページ制作|求人広告|電気料金|回線|光回線|アンケートのお願い|セールス/],
  ["supplier", /請求書|納品書|入荷|発注|仕入|在庫|出荷|配送の|業者|問屋|メーカー/],
  ["internal", /社内|店長から|本社から|本部から|お疲れ様です|お疲れさまです/],
  ["existing_case", /日程|変更|延期|キャンセル|取り消|確認したい|何時に|いつ来|納品|引き取り|引取|お支払い|支払|請求|やり直|手直し|不具合|先日の|この前の|前回の|INQ-|Q-\d|O-\d|R-\d/],
];

/** 文章から電話番号を探す (ハイフンなし・全角も) */
export function findPhones(text: string): string[] {
  // 「−」(マイナス)・「ー」(長音) などのダッシュも区切りとみなす (NFKC では「-」にならない)
  const t = text.normalize("NFKC").replace(/[‐‑‒–—―−ーｰ]/g, "-");
  const out: string[] = [];
  for (const m of t.matchAll(/(?<!\d)(0\d{1,4}[-(\s]?\d{1,4}[-)\s]?\d{3,4})(?!\d)/g)) {
    const d = phoneDigits(m[1]);
    if (d.length >= 10 && d.length <= 11 && !out.some((x) => phoneDigits(x) === d)) out.push(m[1].replace(/\s/g, "-"));
  }
  return out.slice(0, 3);
}

/** AI を使わない読み取り (電話番号・種別・内容の種類だけ。お名前・住所は画面で入力) */
export function ruleReception(text: string): ReceptionFields {
  const t = text.normalize("NFKC");
  const phones = findPhones(t);
  const type = TYPE_WORDS.find(([, re]) => re.test(t))?.[0] ?? "new_inquiry";
  const firstLine = t.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  const name = t.match(/([一-龥ぁ-んァ-ヶ]{1,6}\s?[一-龥ぁ-んァ-ヶ]{0,6})\s?(様|さま)/)?.[1] ?? "";
  return normalizeReception({
    callType: type,
    callTypeReason: "AI を使わずに言葉から判定しました (確かめてください)",
    customerName: name,
    phone: phones[0] ?? "",
    otherPhone: phones[1] ?? "",
    category: CATEGORY_WORDS.find(([, re]) => re.test(t))?.[0] ?? "",
    summary: firstLine.slice(0, 60),
    detail: t.slice(0, 4000),
    urgency: /至急|急ぎ|今日中|すぐに/.test(t) ? "high" : "",
    callback: /折り?返し/.test(t) ? "要" : "",
    caseHint: t.match(/(INQ|Q|O|R)-\d{4}-\d{3,5}/i)?.[0] ?? "",
    uncertainFields: ["customerName", "address", "summary"],
  });
}

/* ================================================================== */
/* 照合: お客様・仕入先・進行中の案件と、登録先の候補                        */
/* ================================================================== */

export type CaseType = "inquiry" | "quote" | "order";

export interface CaseCandidate {
  type: CaseType;
  id: string;
  number: string;
  storeId: StoreId;
  customerId?: string;
  title: string;
  statusLabel: string;
  /** 最後に動いた日 (YYYY-MM-DD) */
  date: string;
  href: string;
  /** 案件の担当 (知らせる相手の候補) */
  ownerId?: string;
  open: boolean;
  /** 候補にした理由 (番号が一致・お客様の案件) */
  reason: string;
}

export interface CustomerCandidate {
  customer: Customer;
  /** address = 住所で一致 (いちばんの目印) / phone = 電話 / name = お名前など */
  level: "phone" | "address" | "name";
  reason: string;
}

export type ReceptionAction = "inquiry" | "case" | "record" | "dismiss";

export const RECEPTION_ACTION_LABEL: Record<ReceptionAction, string> = {
  inquiry: "問い合わせとして登録する",
  case: "案件のやりとりに追加する",
  record: "やりとりの記録だけ残す",
  dismiss: "記録しない (営業電話など)",
};

export interface ReceptionMatch {
  customers: CustomerCandidate[];
  /** 閲覧できない店舗のお客様と電話番号が一致した (店舗名だけ) */
  otherStores: { storeId: StoreId; count: number }[];
  suppliers: Supplier[];
  cases: CaseCandidate[];
  suggestion: { action: ReceptionAction; customerId?: string; caseKey?: string; supplierId?: string; reason: string };
  warnings: string[];
}

export const caseKey = (c: Pick<CaseCandidate, "type" | "id">) => `${c.type}:${c.id}`;

const OPEN_INQUIRY = new Set(["new", "in_progress", "quoted"]);
const OPEN_QUOTE = new Set(["draft", "pending_approval", "approved", "sent"]);
const DAY = 86_400_000;

type MatchDb = Pick<Database, "customers" | "suppliers" | "inquiries" | "quotes" | "orders" | "stores">;

function caseOfInquiry(db: MatchDb, id: string, reason: string): CaseCandidate | undefined {
  const i = db.inquiries.find((x) => x.id === id);
  if (!i) return undefined;
  return { type: "inquiry", id: i.id, number: i.number, storeId: i.storeId, customerId: i.customerId, title: i.summary, statusLabel: INQUIRY_STATUS[i.status]?.label ?? i.status, date: (i.updatedAt || i.receivedAt).slice(0, 10), href: `/inquiries/${i.id}`, ownerId: i.assignedUserId, open: OPEN_INQUIRY.has(i.status), reason };
}

function caseOfQuote(db: MatchDb, id: string, reason: string): CaseCandidate | undefined {
  const q = db.quotes.find((x) => x.id === id);
  if (!q) return undefined;
  const ordered = db.orders.some((o) => o.quoteId === q.id);
  return { type: "quote", id: q.id, number: q.number, storeId: q.storeId, customerId: q.customerId, title: q.title, statusLabel: QUOTE_STATUS[q.status]?.label ?? q.status, date: q.updatedAt.slice(0, 10), href: `/quotes/${q.id}`, ownerId: q.estimatorId ?? q.createdBy, open: OPEN_QUOTE.has(q.status) && !ordered, reason };
}

function caseOfOrder(db: MatchDb, id: string, reason: string): CaseCandidate | undefined {
  const o = db.orders.find((x) => x.id === id);
  if (!o) return undefined;
  const quote = o.quoteId ? db.quotes.find((q) => q.id === o.quoteId) : undefined;
  return { type: "order", id: o.id, number: o.number, storeId: o.storeId, customerId: o.customerId, title: o.title, statusLabel: ORDER_STATUS[o.status]?.label ?? o.status, date: (o.scheduledStart ?? o.updatedAt).slice(0, 10), href: `/orders/${o.id}`, ownerId: quote?.estimatorId ?? quote?.createdBy ?? o.createdBy, open: o.status !== "paid" && o.status !== "cancelled", reason };
}

/** 番号 (INQ-・Q-・O-/R- など、受付の項目に書かれた番号) の案件 */
function caseByNumber(db: MatchDb, hint: string): CaseCandidate | undefined {
  const nums = hint.normalize("NFKC").toUpperCase().match(/[A-Z]{1,4}-\d{4}-\d{2,6}/g) ?? [];
  for (const n of nums) {
    const i = db.inquiries.find((x) => x.number.toUpperCase() === n);
    if (i) return caseOfInquiry(db, i.id, `番号 ${i.number} が一致`);
    const q = db.quotes.find((x) => x.number.toUpperCase() === n);
    if (q) return caseOfQuote(db, q.id, `番号 ${q.number} が一致`);
    const o = db.orders.find((x) => x.number.toUpperCase() === n);
    if (o) return caseOfOrder(db, o.id, `番号 ${o.number} が一致`);
  }
  return undefined;
}

/** お客様の案件 (進行中と、終わって半年以内の受注 = 手直し・支払いの連絡があるため) */
export function customerCases(db: MatchDb, customerId: string, today = new Date()): CaseCandidate[] {
  const recent = (d: string) => today.getTime() - Date.parse(d) < 183 * DAY;
  const out: CaseCandidate[] = [];
  for (const i of db.inquiries) if (i.customerId === customerId && (OPEN_INQUIRY.has(i.status) || recent(i.updatedAt || i.receivedAt))) out.push(caseOfInquiry(db, i.id, "このお客様の問い合わせ")!);
  for (const q of db.quotes) if (q.customerId === customerId && OPEN_QUOTE.has(q.status) && !db.orders.some((o) => o.quoteId === q.id)) out.push(caseOfQuote(db, q.id, "このお客様の見積")!);
  for (const o of db.orders) if (o.customerId === customerId && o.status !== "cancelled" && (o.status !== "paid" || recent(o.completedAt ?? o.updatedAt))) out.push(caseOfOrder(db, o.id, "このお客様の受注・施工")!);
  // 進行中を先に、新しい順。受注 > 見積 > 問い合わせ (同じ日なら案件の先の段階)
  const rank: Record<CaseType, number> = { order: 0, quote: 1, inquiry: 2 };
  return out.sort((a, b) => Number(b.open) - Number(a.open) || b.date.localeCompare(a.date) || rank[a.type] - rank[b.type]);
}

const digitsOf = (v: string) => {
  const d = phoneDigits(v);
  return d.length >= 9 ? d : "";
};

/**
 * 受付の内容から、登録済みのお客様・仕入先・進行中の案件を探し、登録先の候補を決める。
 * 閲覧できる店舗のお客様・案件だけを候補にする (ほかの店舗のお客様と一致したときは店舗名だけ知らせる)。
 * お客様の判別は住所をいちばんの目印にする (同じ氏名・電話が別住所で登録されることがある)。
 */
export function matchReception(db: MatchDb, user: User, f: ReceptionFields, today = new Date()): ReceptionMatch {
  const warnings: string[] = [];
  const phones = [...new Set([digitsOf(f.phone), digitsOf(f.otherPhone)].filter(Boolean))];
  const byPhone = phones.length ? db.customers.filter((c) => phones.some((d) => customerHasPhone(c, d))) : [];
  const otherStores = [...byPhone.filter((c) => !canAccessStore(user, c.storeId)).reduce((m, c) => m.set(c.storeId, (m.get(c.storeId) ?? 0) + 1), new Map<StoreId, number>())].map(([storeId, count]) => ({ storeId, count }));

  // 住所・氏名・電話をまとめて照合 (住所一致を優先して候補に載せる)
  const byId = new Map<string, CustomerCandidate>();
  const put = (c: Customer, level: CustomerCandidate["level"], reason: string) => {
    if (!canAccessStore(user, c.storeId)) return;
    const rank = { address: 3, phone: 2, name: 1 } as const;
    const prev = byId.get(c.id);
    if (!prev || rank[level] > rank[prev.level]) byId.set(c.id, { customer: c, level, reason });
  };
  for (const c of byPhone) put(c, "phone", "電話番号が一致");
  const dup = findDuplicateCustomers(db, {
    name: f.customerName,
    phone: f.phone,
    otherPhones: f.otherPhone ? [f.otherPhone] : [],
    email: f.email,
    postalCode: f.postalCode,
    address: f.address,
  });
  const levelOf = (reasons: string[]): CustomerCandidate["level"] => {
    const t = reasons.join("・");
    // 「住所も確かめてください」のような注意書きは住所一致ではない
    if (/(氏名と住所が一致|同じ姓と住所が一致|電話番号と住所が一致|住所が一致)/.test(t) && !/住所は異なる/.test(t)) return "address";
    if (/電話番号/.test(t)) return "phone";
    return "name";
  };
  for (const m of [...dup.high, ...dup.check, ...dup.sameName.slice(0, 5)]) {
    const c = db.customers.find((x) => x.id === m.id);
    if (c) put(c, levelOf(m.reasons), m.reasons.join("・") || "お名前が同じ");
  }
  const customers = [...byId.values()].sort((a, b) => {
    const rank = { address: 0, phone: 1, name: 2 };
    return rank[a.level] - rank[b.level] || (b.customer.updatedAt ?? "").localeCompare(a.customer.updatedAt ?? "");
  });

  const suppliers = phones.length || f.companyName
    ? db.suppliers.filter((s) => (phones.length && phones.some((d) => [s.phone, s.fax].some((p) => digitsOf(p ?? "") === d))) || (f.companyName && s.name && normalize(s.name).includes(normalize(f.companyName).slice(0, 8)) && normalize(f.companyName).length >= 2))
    : [];

  // 案件: 番号の一致 → 住所・電話で一致したお客様の案件 (お名前だけの一致は選ばれたときに画面で出す)
  const hinted = caseByNumber(db, [f.caseHint, f.summary, f.detail, f.memoText].join(" "));
  const cases: CaseCandidate[] = [];
  if (hinted && canAccessStore(user, hinted.storeId)) cases.push(hinted);
  for (const c of customers.filter((x) => x.level === "address" || x.level === "phone").slice(0, 5)) {
    for (const k of customerCases(db, c.customer.id, today)) if (!cases.some((x) => caseKey(x) === caseKey(k)) && canAccessStore(user, k.storeId)) cases.push(k);
  }

  // 自動で選ぶお客様: 住所一致が 1 件 → それを優先。なければ電話一致が 1 件だけ。複数なら選ばず人が確かめる
  const addressHits = customers.filter((c) => c.level === "address");
  const phoneHits = customers.filter((c) => c.level === "phone");
  const picked =
    addressHits.length === 1 ? addressHits[0] :
    addressHits.length === 0 && phoneHits.length === 1 ? phoneHits[0] :
    undefined;
  const pickedCustomer = picked?.customer;

  const type = f.callType || "new_inquiry";
  const openCases = cases.filter((c) => c.open);
  let suggestion: ReceptionMatch["suggestion"];
  if (type === "existing_case") {
    const target = hinted && canAccessStore(user, hinted.storeId) ? hinted : openCases[0] ?? cases[0];
    if (target) suggestion = { action: "case", caseKey: caseKey(target), customerId: target.customerId, reason: hinted && target === hinted ? `${target.number} の連絡として追加します (番号が一致)` : openCases.length > 1 ? `進行中の案件が ${openCases.length} 件あります。いちばん最近の案件を選びました。違う場合は選び直してください` : `${target.number} の連絡として追加します` };
    else {
      suggestion = { action: "inquiry", customerId: pickedCustomer?.id, reason: "案件の連絡と判定しましたが、該当する案件が見つかりません。お客様と案件を確かめてください (新しい問い合わせとして登録することもできます)" };
      warnings.push("該当する案件が見つかりません。お客様の住所・電話番号・お名前、または案件番号を確かめてください。");
    }
  } else if (type === "supplier") {
    suggestion = { action: "record", supplierId: suppliers[0]?.id, reason: suppliers[0] ? `仕入先・協力業者「${suppliers[0].name}」とのやりとりとして記録します` : "仕入先・協力業者からの連絡と判定しました。相手を選んで記録するか、記録しないを選んでください" };
  } else if (type === "sales") {
    suggestion = { action: "dismiss", reason: "営業・勧誘の電話と判定しました。記録は不要なら「記録しない」で閉じます" };
  } else if (type === "internal") {
    suggestion = { action: "dismiss", reason: "社内の連絡と判定しました。必要なら社内連絡・業務依頼で伝えてください" };
  } else if (type === "other") {
    suggestion = { action: pickedCustomer ? "record" : "dismiss", customerId: pickedCustomer?.id, reason: "内容の種類を判断できませんでした。内容を確かめて登録先を選んでください" };
  } else {
    const how = picked?.level === "address" ? "住所" : picked?.level === "phone" ? "電話番号" : "";
    suggestion = {
      action: "inquiry",
      customerId: pickedCustomer?.id,
      reason: pickedCustomer
        ? `登録済みのお客様「${pickedCustomer.name}」様の新しい問い合わせとして登録します (${how}で一致)`
        : customers.length
          ? "候補のお客様が複数あります。住所を確かめて選んでから登録してください"
          : "新しいお客様の問い合わせとして登録します",
    };
    // 同じお客様の対応中の問い合わせがあれば知らせる (同じ件の再度の連絡のことがある)
    const sameOpen = openCases.find((c) => c.type === "inquiry" && today.getTime() - Date.parse(c.date) < 30 * DAY);
    if (sameOpen) warnings.push(`このお客様には対応中の問い合わせ ${sameOpen.number} (${sameOpen.title}) があります。同じ件の連絡なら「案件のやりとりに追加する」を選んでください。`);
  }
  if (addressHits.length > 1) warnings.push(`住所が近いお客様が ${addressHits.length} 人います。どの住所のお客様か確かめてください。`);
  const phoneMatchCount = byPhone.filter((c) => canAccessStore(user, c.storeId)).length;
  if (phoneMatchCount > 1) warnings.push(`電話番号が一致するお客様が ${phoneMatchCount} 人います。同じ番号でも住所が違うことがあるため、住所で確かめてください。`);
  if (dup.check.some((m) => m.reasons.some((r) => r.includes("住所は異なる")))) {
    warnings.push("電話番号は一致しますが住所が異なる候補があります。別の住所の記録の可能性があるので、住所で選んでください。");
  }
  if (!f.address?.trim() && (phoneHits.length > 0 || customers.some((c) => c.level === "name"))) {
    warnings.push("住所が読み取れていません。メモの住所を入力すると、既存のお客様と正しく結びつけやすくなります。");
  }
  if (pickedCustomer?.tradeStopped) warnings.push(`「${pickedCustomer.name}」様は取引停止のお客様です。対応の前に店長に確かめてください。`);
  if (otherStores.length) {
    const names = otherStores.map((o) => db.stores.find((s) => s.id === o.storeId)?.name ?? o.storeId).join("・");
    warnings.push(`電話番号が${names}のお客様と一致します (閲覧の権限がないため候補に出していません)。${names}に知らせてください。`);
  }
  return { customers, otherStores, suppliers, cases, suggestion, warnings };
}

const normalize = (s: string) => s.normalize("NFKC").replace(/[\s　]|株式会社|\(株\)|有限会社|\(有\)/g, "").toLowerCase();

/* ================================================================== */
/* 受付の一覧                                                            */
/* ================================================================== */

export const isReception = (d: Pick<CapturedDocument, "kind">) => d.kind === "reception";

/** 確認待ちの受付 (読み取りが終わって、まだ登録・破棄していない) */
export const isPendingReception = (d: Pick<CapturedDocument, "kind" | "status">) => d.kind === "reception" && (d.status === "extracted" || d.status === "failed" || d.status === "uploaded");

/** 受付の画面 */
export const receptionHref = (id: string) => `/inquiries/reception/${id}`;

/** 受付の項目 (documents.extracted から) */
export function receptionFieldsOf(doc: Pick<CapturedDocument, "extracted">): ReceptionFields {
  return normalizeReception((doc.extracted ?? {}) as Record<string, unknown>);
}

/** 受付の記録 (_ で始まる項目) */
export interface ReceptionMeta {
  source: ReceptionSource;
  channel: Channel;
  /** 文字起こし・入力した文章 */
  text?: string;
  /** 電話のシステムから届いた項目 */
  call?: { id?: string; from?: string; to?: string; direction?: "inbound" | "outbound"; startedAt?: string; durationSec?: number; recordingUrl?: string; extension?: string; staff?: string };
  decision?: { action: ReceptionAction; at: string; by: string; targetType?: string; targetId?: string; label?: string; href?: string; note?: string };
  /** 顧客の画面から取り込んだ受付のお客様 (お客様が決まっている。お客様のご要望 2026-11-24「■6」) */
  customerId?: string;
}

export function receptionMetaOf(doc: Pick<CapturedDocument, "extracted">): ReceptionMeta {
  const x = (doc.extracted ?? {}) as Record<string, unknown>;
  const source = (["photo", "voice", "text", "audio", "phone_api"] as const).find((s) => s === x._source) ?? "text";
  return {
    source,
    channel: (typeof x._channel === "string" ? x._channel : source === "phone_api" || source === "audio" ? "phone" : "unknown") as Channel,
    text: typeof x._text === "string" ? x._text : undefined,
    call: x._call && typeof x._call === "object" ? (x._call as ReceptionMeta["call"]) : undefined,
    decision: x._decision && typeof x._decision === "object" ? (x._decision as ReceptionMeta["decision"]) : undefined,
    customerId: typeof x._customerId === "string" && x._customerId ? x._customerId : undefined,
  };
}

/** 一覧・通知に出す見出し (お名前 / 会社名 + 用件) */
export function receptionTitle(f: ReceptionFields): string {
  const who = f.customerName ? `${f.customerName} 様` : f.companyName || (f.phone ? f.phone : "相手不明");
  return `${who}${f.summary ? ` — ${f.summary}` : ""}`.slice(0, 100);
}

/** 利用者が見られる確認待ちの受付の件数 (ヘッダーの問い合わせのバッジ・一覧の案内) */
export function pendingReceptionCount(db: Pick<Database, "documents">, user: User): number {
  return db.documents.filter((d) => isPendingReception(d) && canAccessStore(user, d.storeId)).length;
}
