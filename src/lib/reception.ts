import type { CapturedDocument, Channel, Customer, Database, MediaKey, ServiceCategory, StoreId, Supplier, User } from "@/lib/db/types";
import { CATEGORY_LABEL, INQUIRY_STATUS, ORDER_STATUS, QUOTE_STATUS } from "@/lib/constants";
import { customerHasPhone, phoneDigits } from "@/lib/customer-contacts";
import { canAccessStore, canEditCaseStore, canReadStoreRecords } from "@/lib/auth/permissions";
import { policyReader } from "@/lib/access-policy";
import { addressMatch, areaInAddress, nameMatch } from "@/lib/customer-match";
import { isPlaceholderCustomer, placeholderMatches } from "@/lib/placeholder-match";
import { isMediaKey } from "@/lib/media";

/**
 * 受付 (すべての問い合わせの共通の入口)
 * ------------------------------------------------------------
 * 来店・イベント・現場の紹介の手書きメモの写真、担当者の携帯にかかった電話を話して入力・文章で入力、
 * 会社の電話の録音 (または電話のシステムから届く文字起こし) を、同じ形の「受付」にして確認待ちに入れる。
 * 1. AI が項目 (お名前・住所・電話・内容など) を読み取り、内容の種類を判定する (src/lib/ai/reception.ts)
 *    新しい問い合わせ / 進行中の案件の連絡 / 仕入先・協力業者 / 営業・勧誘 / 社内の連絡 / その他
 * 2. このファイルの matchReception が、電話番号・お名前で登録済みのお客様と仕入先を探し、そのお客様の進行中の案件を並べ、
 *    登録先の候補 (問い合わせとして登録 / 既存の案件に問い合わせを追加 / 記録だけ / 記録しない) を出す。
 *    お客様を決めたあとは、そのお客様の案件 (src/lib/case-choice.ts) から「新規案件 / この案件に問い合わせを追加」を選ぶ。どちらも問い合わせを作る (案件に追加 = Inquiry.caseId)
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
/** 受付の入口の選択肢 (constants.ts。初期値は電話) */
export { RECEPTION_CHANNELS } from "@/lib/constants";

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
  /** 施工現場の住所 (依頼主の住所と違うとき。業者の現場・ご実家など。お客様のご要望 2026-11-25「⑨」) */
  siteAddress: string;
  /** メモ・会話で決まっている日程 (訪問・引取など)。予定の登録の初期値にする (お客様のご要望 2026-11-25「⑦」) */
  appointments: ReceptionAppointment[];
}

/** 受付で読み取った日程の種類 (予定表の種類と同じ名前) */
export const APPOINTMENT_KINDS = ["survey", "site_survey", "onsite_quote", "measure", "pickup", "delivery", "install", "reform", "visit"] as const;
export type AppointmentKind = (typeof APPOINTMENT_KINDS)[number];

/** 受付で読み取った日程 (AI はメモの文字 text を残し、日付・時刻を YYYY-MM-DD・HH:mm にする。register = 予定表に登録する) */
export interface ReceptionAppointment {
  kind: AppointmentKind;
  date: string;
  time: string;
  slot: "am" | "pm" | "";
  text: string;
  register?: boolean;
  assigneeId?: string;
}

/** 日程の値をそろえる (AI の値・画面の JSON)。日付のないもの・読めないものは除く。最大 6 件 */
export function normalizeAppointments(raw: unknown): ReceptionAppointment[] {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v || "[]");
    } catch {
      v = [];
    }
  }
  if (!Array.isArray(v)) return [];
  const out: ReceptionAppointment[] = [];
  for (const r of v as Record<string, unknown>[]) {
    if (!r || typeof r !== "object") continue;
    const kind = (APPOINTMENT_KINDS as readonly string[]).includes(String(r.kind)) ? (String(r.kind) as AppointmentKind) : "survey";
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(r.date ?? "")) ? String(r.date) : "";
    const tm = String(r.time ?? "").match(/^(\d{1,2}):(\d{2})$/);
    const time = tm && Number(tm[1]) < 24 && Number(tm[2]) < 60 ? `${tm[1].padStart(2, "0")}:${tm[2]}` : "";
    const slot = r.slot === "am" || r.slot === "pm" ? r.slot : "";
    const text = String(r.text ?? "").trim().slice(0, 100);
    if (!date && !text) continue;
    out.push({ kind, date, time, slot: time ? "" : slot, text, ...(typeof r.register === "boolean" ? { register: r.register } : {}), ...(typeof r.assigneeId === "string" && r.assigneeId ? { assigneeId: r.assigneeId } : {}) });
  }
  return out.slice(0, 6);
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
  "siteAddress",
  "appointments",
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
  siteAddress: "施工現場の住所",
  appointments: "決まっている日程",
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
    siteAddress: str(raw.siteAddress, 200),
    appointments: normalizeAppointments(raw.appointments),
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
  /**
   * 予定表 (スプレッドシート) から移行した予定の仮のお客様 (名字と地区だけで登録。タグ「予定表から登録」)。
   * 画面は別にまとめて出し、紐付けるとメモの電話番号・住所で正式なお客様にする (お客様のご連絡 2026-11-27)
   */
  placeholder?: boolean;
}

export type ReceptionAction = "inquiry" | "case" | "record" | "dismiss";

export const RECEPTION_ACTION_LABEL: Record<ReceptionAction, string> = {
  inquiry: "問い合わせとして登録する",
  case: "既存の案件に問い合わせを追加する",
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

type MatchDb = Pick<Database, "customers" | "suppliers" | "inquiries" | "quotes" | "orders" | "stores" | "settings"> & Partial<Pick<Database, "schedule">>;

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
  for (const i of db.inquiries) if (i.customerId === customerId && !i.deleted && (OPEN_INQUIRY.has(i.status) || recent(i.updatedAt || i.receivedAt))) out.push(caseOfInquiry(db, i.id, "このお客様の問い合わせ")!);
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
  // 候補にできるお客様 = 顧客の一覧で見られるお客様 (閲覧の範囲の設定。初期設定は全社員が全店舗)。ほかの店舗・本部で登録したお客様も出す
  const reader = policyReader(db, user);
  const visible = (c: Customer) => canReadStoreRecords(reader, c.storeId) || canEditCaseStore(user, c.storeId);
  const byPhone = phones.length ? db.customers.filter((c) => phones.some((d) => customerHasPhone(c, d))) : [];
  const otherStores = [...byPhone.filter((c) => !visible(c)).reduce((m, c) => m.set(c.storeId, (m.get(c.storeId) ?? 0) + 1), new Map<StoreId, number>())].map(([storeId, count]) => ({ storeId, count }));

  // 既存のお客様の候補 (お客様のご要望 2026-11-24「紐付け候補の優先順位」): ① 住所の一致 → ② 電話番号の一致 → ③ 名字の一致。
  // 町名だけの一致 (移行した顧客の地区「○○」など) は住所の一致に数えない (同じ町のほかのお宅)。名字の候補の並びの手がかりにだけ使う
  const scored: (CustomerCandidate & { score: number; phoneOtherAddress?: boolean })[] = [];
  const hasAddress = Boolean(f.address?.trim());
  for (const c of db.customers) {
    if (!visible(c)) continue;
    const addr = hasAddress ? addressMatch(f.address, c.address) : undefined;
    const townHit = addr === "town" || (hasAddress && !c.address && areaInAddress(c.area, f.address));
    const phoneHit = phones.some((d) => customerHasPhone(c, d));
    const name = nameMatch({ name: f.customerName, kana: f.kana }, c);
    const nameText = name === "full" ? "お名前" : name === "surname" ? "名字" : "";
    let cand: (typeof scored)[number] | undefined;
    if (addr === "exact" || addr === "partial" || addr === "building") {
      const parts = [addr === "exact" ? "住所が一致" : addr === "partial" ? "住所 (番地の一部) が一致" : "同じ建物 (部屋番号が違う)", phoneHit ? "電話番号も一致" : "", nameText ? `${nameText}も一致` : ""].filter(Boolean);
      cand = { customer: c, level: "address", reason: parts.join("・"), score: (addr === "exact" ? 300 : addr === "partial" ? 250 : 220) + (phoneHit ? 50 : 0) + (name === "full" ? 40 : name ? 20 : 0) };
    } else if (phoneHit) {
      const other = hasAddress && Boolean(c.address) && !townHit;
      cand = { customer: c, level: "phone", reason: ["電話番号が一致", nameText ? `${nameText}も一致` : "", townHit ? "同じ町名" : "", other ? "住所は異なる (別の住所の可能性。住所で確かめてください)" : ""].filter(Boolean).join("・"), score: 200 + (name === "full" ? 40 : name ? 20 : 0) + (townHit ? 15 : 0) - (other ? 30 : 0), phoneOtherAddress: other };
    } else if (name) {
      cand = { customer: c, level: "name", reason: [name === "full" ? "お名前が一致" : "名字が一致", townHit ? "同じ町名" : ""].filter(Boolean).join("・"), score: 100 + (name === "full" ? 20 : 0) + (townHit ? 40 : 0) };
    }
    if (cand) scored.push(cand);
  }
  // 予定表 (スプレッドシート) から移行した予定の仮のお客様 (名字と地区だけ。お客様のご連絡 2026-11-27): 名字・町名・電話のほか、
  // 手書きの名字を読み違えても町名とメモの日程の日 (予定の日) が合えば候補にする
  const todayKey = new Date(today.getTime() + 9 * 3600e3).toISOString().slice(0, 10);
  const phMatches = placeholderMatches(
    { customers: db.customers, schedule: db.schedule ?? [] },
    { name: f.customerName, kana: f.kana, phones: [f.phone, f.otherPhone], addresses: [f.address, f.siteAddress], dates: (f.appointments ?? []).map((a) => a.date) },
    { visible, today: todayKey },
  );
  const phReason = new Map(phMatches.map((m) => [m.customer.id, m.reason]));
  const rank = { address: 0, phone: 1, name: 2 } as const;
  scored.sort((a, b) => rank[a.level] - rank[b.level] || b.score - a.score || (b.customer.updatedAt ?? "").localeCompare(a.customer.updatedAt ?? ""));
  // 名字だけの候補は多いことがある (同じ名字の方が何十人も) → 同じ町名・最近の取引の順に上位だけ
  const customers: CustomerCandidate[] = [
    ...scored.filter((c) => c.level === "address").slice(0, 8),
    ...scored.filter((c) => c.level === "phone").slice(0, 8),
    ...scored.filter((c) => c.level === "name").slice(0, 8),
  ].map(({ customer, level, reason }) => (isPlaceholderCustomer(customer) ? { customer, level, reason: phReason.get(customer.id) ?? `予定表から移行した仮の登録・${reason}`, placeholder: true } : { customer, level, reason }));
  for (const m of phMatches) {
    if (customers.some((c) => c.customer.id === m.customer.id)) continue;
    customers.push({ customer: m.customer, level: m.phone ? "phone" : "name", reason: m.reason, placeholder: true });
  }
  const nameTotal = scored.filter((c) => c.level === "name").length;

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
  // 予定表から移行した予定の案件 (仮のお客様の案件。メモの件は予定表に入っている案件のことが多い)
  for (const m of phMatches.slice(0, 3)) {
    for (const k of customerCases(db, m.customer.id, today)) if (!cases.some((x) => caseKey(x) === caseKey(k)) && canAccessStore(user, k.storeId)) cases.push({ ...k, reason: "予定表から移行した予定の案件" });
  }

  // 自動で選ぶお客様: 住所一致が 1 件 → それを優先。なければ電話一致が 1 件だけ。複数なら選ばず人が確かめる
  const addressHits = customers.filter((c) => c.level === "address");
  const phoneHits = customers.filter((c) => c.level === "phone");
  // 同じ建物・同じ番地に何人かいるときは、お名前 (名字) も一致する 1 人
  const addressAndName = addressHits.filter((c) => /(お名前|名字)も一致/.test(c.reason));
  const picked =
    addressAndName.length === 1 ? addressAndName[0] :
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
    if (sameOpen) warnings.push(`このお客様には対応中の問い合わせ ${sameOpen.number} (${sameOpen.title}) があります。同じ件の連絡なら、お客様を紐付けたあとの「案件」で「この案件に問い合わせを追加」を選んでください。`);
  }
  if (addressHits.length > 1) warnings.push(`住所が近いお客様が ${addressHits.length} 人います。どの住所のお客様か確かめてください。`);
  const phoneMatchCount = byPhone.filter(visible).length;
  if (phoneMatchCount > 1) warnings.push(`電話番号が一致するお客様が ${phoneMatchCount} 人います。同じ番号でも住所が違うことがあるため、住所で確かめてください。`);
  if (scored.some((c) => c.phoneOtherAddress)) {
    warnings.push("電話番号は一致しますが住所が異なる候補があります。別の住所の記録の可能性があるので、住所で選んでください。");
  }
  if (nameTotal > 8 && !customers.some((c) => c.level !== "name")) warnings.push(`名字が同じお客様が ${nameTotal} 人います (同じ町名・最近の取引の順に 8 人を出しています)。見つからないときは「既存のお客様を検索」で住所・電話番号から探してください。`);
  if (!f.address?.trim() && (phoneHits.length > 0 || customers.some((c) => c.level === "name"))) {
    warnings.push("住所が読み取れていません。メモの住所を入力すると、既存のお客様と正しく結びつけやすくなります。");
  }
  if (phMatches.length && !pickedCustomer) {
    const m = phMatches[0];
    const place = m.customer.area || m.customer.address;
    warnings.push(`予定表 (スプレッドシート) から移行した予定のお客様「${m.customer.name}」様${place ? ` (${place.slice(0, 20)})` : ""}が仮に登録されています${phMatches.length > 1 ? ` (ほか ${phMatches.length - 1} 件)` : ""}。同じお客様なら、新規顧客として登録せずに「予定表から移行した予定のお客様」から紐付けてください (予定と案件がそのままつながります)。`);
  }
  if (pickedCustomer?.tradeStopped) warnings.push(`「${pickedCustomer.name}」様は取引停止のお客様です。対応の前に店長に確かめてください。`);
  if (otherStores.length) {
    const names = otherStores.map((o) => db.stores.find((s) => s.id === o.storeId)?.name ?? o.storeId).join("・");
    warnings.push(`電話番号が${names}のお客様と一致します (閲覧の範囲の外のため候補に出していません)。${names}に知らせてください。`);
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
  /** 確認の画面で選んだ登録の値 (媒体・担当店舗・担当者・案件)。紐付け・保存のあとも選び直さない */
  reg: ReceptionReg;
}

/**
 * 確認の画面で選んだ登録の値 (documents.extracted._reg。お客様のご要望 2026-11-26「■2 同じ情報は一度の入力で」):
 * 「このお客様に紐付ける」「新規顧客として登録」「修正を保存」で画面を読み直しても、選んだ媒体・担当店舗・担当者・案件をそのまま出す
 */
export interface ReceptionReg {
  media?: MediaKey;
  storeId?: StoreId;
  /** 担当店舗を手で選んだ (住所の担当エリア・案件の店舗で決め直さない) */
  storeManual?: boolean;
  assigneeId?: string;
  handoff?: boolean;
  /** "new" = 新規案件 / 案件の ID = この案件に問い合わせを追加 */
  caseId?: string;
}

/** _reg の値を読む (知らない値は捨てる) */
export function receptionRegOf(raw: unknown): ReceptionReg {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const s = (v: unknown, max = 80) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
  return {
    ...(isMediaKey(r.media) ? { media: r.media } : {}),
    ...(s(r.storeId) ? { storeId: s(r.storeId) as StoreId } : {}),
    ...(typeof r.storeManual === "boolean" ? { storeManual: r.storeManual } : {}),
    ...(s(r.assigneeId) ? { assigneeId: s(r.assigneeId) } : {}),
    ...(typeof r.handoff === "boolean" ? { handoff: r.handoff } : {}),
    ...(s(r.caseId) ? { caseId: s(r.caseId) } : {}),
  };
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
    reg: receptionRegOf(x._reg),
  };
}

/** 一覧・通知に出す見出し (お名前 / 会社名 + 用件) */
export function receptionTitle(f: ReceptionFields): string {
  const who = f.customerName ? `${f.customerName} 様` : f.companyName || (f.phone ? f.phone : "相手不明");
  return `${who}${f.summary ? ` — ${f.summary}` : ""}`.slice(0, 100);
}

/** 利用者が見られる確認待ちの受付の件数 (ヘッダーの問い合わせのバッジ・一覧の案内) */
export function pendingReceptionCount(db: Pick<Database, "documents">, user: User): number {
  return pendingReceptionIds(db, user).length;
}

/** 利用者が見られる確認待ちの受付の ID (ヘッダーの数字の「確認済み」。src/lib/notify-seen.ts) */
export function pendingReceptionIds(db: Pick<Database, "documents">, user: User): string[] {
  return db.documents.filter((d) => isPendingReception(d) && canAccessStore(user, d.storeId)).map((d) => d.id);
}
