import type { Attachment, AuditChange, CasePost, CasePostAction, CasePostChannel, CasePostConsent, CasePostEvent, CasePostStatus, Customer, Database, Order, StoreId, User } from "@/lib/db/types";
import type { Tone } from "@/lib/constants";
import { CATEGORY_LABEL } from "@/lib/constants";
import { normalizeAddress } from "@/lib/maps/address";
import {
  canApproveCasePost,
  canDiscardCasePost,
  canEditCasePost,
  canRecordCasePosting,
  canRequestCasePostReview,
  canReturnCasePost,
  canViewCasePost,
  canWithdrawCasePost,
  isCasePostReviewer,
  isDemoAccount,
  isReviewAccount,
} from "@/lib/auth/permissions";

/**
 * 施工事例の投稿 (お客様のご要望 2026-11-23「■7. 施工事例写真の活用」)
 * ------------------------------------------------------------
 * 案件 (受注) の写真・商品名・施工内容から AI で投稿文の下書きを作り (src/lib/ai/case-post.ts。AI がないときは定型文)、
 * 確認する人 (設定 case_posts の reviewerIds。既定 = 本部の管理者) が確認してから、担当者が SNS・ホームページに手で投稿する。
 * - 進み方: 下書き → 確認依頼 → 承認済み → 投稿済み (投稿先・日・URL を記録)。差し戻し (理由つき)・取りやめ。
 *   承認のあとに確認する人以外が文面・写真を直すと下書きに戻る (承認した内容だけを投稿する)
 * - お客様の個人情報 (お名前・番地までの住所・電話・メール) は投稿文に入れない: AI に渡す前に除き (scrubPersonal)、
 *   AI の答えからも除き、確認を頼むとき・承認するときに残っていないか確かめる (personalInfoFindings)。地域は町名まで
 * - SNS への自動の投稿はしない (API なし)。画面で文面をコピーし、写真を保存して投稿する
 * このファイルは画面・テストからも読み込む (サーバー専用の import をしない)。権限は permissions.ts、操作は src/lib/actions/case-posts.ts
 */

export const CASE_POSTS_SETTING_ID = "case_posts";

export const CASE_POST_STATUS: Record<CasePostStatus, { label: string; tone: Tone; hint: string }> = {
  draft: { label: "下書き", tone: "neutral", hint: "写真・商品名・施工内容と投稿文を整えて「確認を依頼する」を押してください" },
  review: { label: "確認依頼中", tone: "warn", hint: "確認する人が投稿文と写真を確認しています" },
  approved: { label: "承認済み (投稿待ち)", tone: "info", hint: "承認された内容です。文面をコピー・写真を保存して投稿し、投稿したら記録してください" },
  returned: { label: "差し戻し", tone: "serious", hint: "理由を確かめて直し、もう一度「確認を依頼する」を押してください" },
  posted: { label: "投稿済み", tone: "good", hint: "投稿した記録です。ほかの投稿先にも出したら追加で記録できます" },
  discarded: { label: "取りやめ", tone: "critical", hint: "取りやめた投稿です。必要なら下書きに戻せます" },
};

export const CASE_POST_ACTION_LABEL: Record<CasePostAction, string> = {
  create: "作成",
  edit: "内容を修正",
  ai: "投稿文の下書きを作成",
  photos: "写真を追加",
  request: "確認を依頼",
  approve: "承認",
  return: "差し戻し",
  withdraw: "確認の依頼を取り下げ",
  post: "投稿を記録",
  discard: "取りやめ",
  restore: "下書きに戻す",
};

export const CASE_POST_CHANNEL_LABEL: Record<CasePostChannel, string> = {
  instagram: "Instagram",
  website: "ホームページ (施工事例)",
  google: "Google ビジネスプロフィール",
  facebook: "Facebook",
  line: "LINE 公式アカウント",
  other: "その他",
};
export const CASE_POST_CHANNELS = Object.keys(CASE_POST_CHANNEL_LABEL) as CasePostChannel[];

export const CASE_POST_CONSENT_LABEL: Record<CasePostConsent, { label: string; tone: Tone }> = {
  unconfirmed: { label: "未確認", tone: "warn" },
  obtained: { label: "了承をいただいた", tone: "good" },
  not_needed: { label: "不要 (お宅と分からない写真だけ)", tone: "neutral" },
};

/** 1 つの投稿で使う写真の上限 (Instagram のカルーセルは 10 枚まで) */
export const CASE_POST_MAX_PHOTOS = 10;
export const CASE_POST_MAX_TEXT = 5000;

export class CasePostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CasePostError";
  }
}

const clean = (s: string | undefined | null, max: number) => (s ?? "").replace(/\r\n?/g, "\n").trim().slice(0, max);

/* ================================================================== */
/* 確認する人 (設定)                                                     */
/* ================================================================== */

export interface CasePostSettings {
  /** 確認する人 (空 = 既定: 本部の管理者) */
  reviewerIds: string[];
}

export function casePostSettings(db: Pick<Database, "settings">): CasePostSettings {
  const v = (db.settings ?? []).find((s) => s.id === CASE_POSTS_SETTING_ID)?.value as { reviewerIds?: unknown } | undefined;
  const ids = Array.isArray(v?.reviewerIds) ? (v!.reviewerIds as unknown[]).filter((x): x is string => typeof x === "string") : [];
  return { reviewerIds: ids };
}

const reviewable = (u: User) => u.active && !isReviewAccount(u) && u.signupStatus !== "pending";

/**
 * 確認する人: 設定で選んだ社員 (有効な人だけ)。設定がない・全員が無効なら、本部 (storeId = hq) の管理者、いなければ管理者全員。
 * デモ用アカウントと社員は混ぜない (社員がいれば社員だけ)
 */
export function casePostReviewers(db: Pick<Database, "settings" | "users">): User[] {
  const { reviewerIds } = casePostSettings(db);
  const chosen = reviewerIds.map((id) => db.users.find((u) => u.id === id)).filter((u): u is User => Boolean(u && reviewable(u)));
  if (chosen.length) return chosen;
  const admins = db.users.filter((u) => reviewable(u) && u.role === "admin");
  const staff = admins.filter((u) => !isDemoAccount(u));
  const pool = staff.length ? staff : admins;
  const hq = pool.filter((u) => u.storeId === "hq");
  return hq.length ? hq : pool;
}

export function casePostReviewerIds(db: Pick<Database, "settings" | "users">): string[] {
  return casePostReviewers(db).map((u) => u.id);
}

/** 設定に確認する人が選ばれているか (画面の「既定」の表示用) */
export function reviewersConfigured(db: Pick<Database, "settings" | "users">): boolean {
  const { reviewerIds } = casePostSettings(db);
  return reviewerIds.some((id) => db.users.some((u) => u.id === id && reviewable(u)));
}

/* ================================================================== */
/* 案件からの下書きの材料 (写真・商品名・施工内容・地域)                         */
/* ================================================================== */

/** 商品名にしない明細 (値引き・諸経費・運搬など) */
const NOT_PRODUCT = /値引|割引|諸経費|出張|運搬|処分|廃棄|駐車|交通費|消費税|小計|合計|調整|端数|送料|手数料/;

/** 案件の商品名 (見積の明細の品名。重複を除く。なければ受注の内訳・種別) */
export function orderProductNames(db: Pick<Database, "quotes">, order: Pick<Order, "quoteId" | "amounts" | "category">): string[] {
  const q = order.quoteId ? db.quotes.find((x) => x.id === order.quoteId) : undefined;
  const names: string[] = [];
  for (const it of q?.items ?? []) {
    const n = [it.name, it.spec].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    if (!n || NOT_PRODUCT.test(n) || it.amount < 0) continue;
    if (!names.includes(n)) names.push(n.slice(0, 80));
  }
  if (names.length) return names.slice(0, 15);
  const AMOUNT_LABEL: Record<string, string> = { tatami: "畳", fusuma: "襖", shoji: "障子", amido: "網戸", curtain: "カーテン", cloth: "クロス・工事", own: "自社商品" };
  const fromAmounts = Object.entries(order.amounts ?? {})
    .filter(([k, v]) => AMOUNT_LABEL[k] && Number(v) > 0)
    .map(([k]) => AMOUNT_LABEL[k]);
  return fromAmounts.length ? fromAmounts : [CATEGORY_LABEL[order.category] ?? "畳"];
}

/** 地域 (町名まで。番地・建物名・部屋番号は入れない) */
export function areaOfAddress(address: string | undefined | null): string {
  const n = normalizeAddress(address);
  return n.town.slice(0, 40);
}

/** 受注の写真 (撮影・登録の古い順) */
export function orderPhotos(db: Pick<Database, "attachments">, orderId: string): Attachment[] {
  return db.attachments
    .filter((a) => a.parentType === "order" && a.parentId === orderId && a.kind === "photo")
    .sort((a, b) => (a.takenAt ?? a.uploadedAt).localeCompare(b.takenAt ?? b.uploadedAt));
}

export interface CasePostPrefill {
  title: string;
  products: string;
  workContent: string;
  area: string;
  photoIds: string[];
  channels: CasePostChannel[];
}

/** 新しい投稿の初期値 (案件の写真・明細・施工内容・施工場所の町名) */
export function postPrefill(db: Pick<Database, "quotes" | "customers" | "attachments">, order: Order): CasePostPrefill {
  const customer = db.customers.find((c) => c.id === order.customerId);
  const area = areaOfAddress(order.siteAddress || customer?.address);
  const ctx = personalContext(customer, order);
  const work = scrubPersonal([order.workDetails, order.title].filter(Boolean).join("\n"), ctx);
  const cat = CATEGORY_LABEL[order.category] ?? "";
  // 見出しには「お客様」も入れない (受注の件名の「〇〇様邸」を外す)
  const title = scrubPersonal(`${area ? `${area} ` : ""}${order.title || cat}`, ctx).replace(/お客様宅?\s*(?:の\s*)?/g, "").replace(/\s{2,}/g, " ").trim().slice(0, 80);
  return {
    title,
    products: orderProductNames(db, order).join("\n"),
    workContent: work.slice(0, 2000),
    area,
    photoIds: orderPhotos(db, order.id).slice(-CASE_POST_MAX_PHOTOS).map((a) => a.id),
    channels: ["instagram"],
  };
}

/* ================================================================== */
/* お客様の個人情報 (投稿文に入れない)                                         */
/* ================================================================== */

export interface PersonalContext {
  /** お客様のお名前・ふりがな・領収書の宛名 (姓だけも見る) */
  names: string[];
  /** お客様の住所・施工場所 (番地まで) */
  addresses: string[];
  phones: string[];
  emails: string[];
}

export function personalContext(customer: Pick<Customer, "name" | "kana" | "address" | "phone" | "email" | "contacts"> | undefined, order?: Pick<Order, "siteAddress" | "receiptName">): PersonalContext {
  const names = [customer?.name, customer?.kana, order?.receiptName, ...(customer?.contacts ?? []).map((c) => c.name)].map((s) => (s ?? "").trim()).filter((s) => s.length >= 2);
  const phones = [customer?.phone, ...(customer?.contacts ?? []).map((c) => c.phone)].map((s) => (s ?? "").trim()).filter(Boolean);
  return { names, addresses: [customer?.address, order?.siteAddress].map((s) => (s ?? "").trim()).filter(Boolean), phones, emails: [customer?.email ?? ""].filter(Boolean) };
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const digits = (s: string) => s.replace(/\D/g, "");

/** 名前の候補 (姓名・空白なし・姓だけ (2 文字以上)) */
function nameVariants(names: string[]): string[] {
  const out = new Set<string>();
  for (const raw of names) {
    const n = raw.normalize("NFKC").replace(/(様|さま|御中|殿)$/, "").trim();
    if (n.length < 2) continue;
    out.add(n);
    out.add(n.replace(/[\s　]+/g, ""));
    const parts = n.split(/[\s　]+/).filter(Boolean);
    if (parts.length >= 2 && parts[0].length >= 2) out.add(parts[0]);
  }
  return [...out].filter((x) => x.length >= 2).sort((a, b) => b.length - a.length);
}

const PHONE_RE = /(?<![\d-])(?:\+81[-\s]?|0)\d{1,4}[-‐－ー−\s]?\d{1,4}[-‐－ー−\s]?\d{3,4}(?![\d-])/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/**
 * 「〇〇様邸」「〇〇様宅」(漢字・カタカナ 1〜4 文字の名前)。「〇〇様」だけは仕様・模様・同様などと見分けられないため、
 * お客様のお名前 (PersonalContext.names) で消す
 */
const HONORIFIC_RE = /(?<![一-龥ァ-ヶー])([一-龥ァ-ヶー]{1,4})(様邸|様宅|様方)/g;
const NOT_NAME = new Set(["皆", "各", "貴", "奥", "神", "仏", "王", "殿", "同", "客", "仕", "模", "多", "異", "一"]);
/** 番地 (1-2-3・12番5号・12番地。町名のすぐ後ろだけを消す) */
const HOUSE = String.raw`\d{1,5}(?:\s*(?:丁目|番地|番|号|-)\s*\d{1,5})*(?:\s*(?:丁目|番地|番|号))?`;
/** 町名がなくても番地と分かる書き方 (3丁目12番5号・12番地) */
const FULL_HOUSE_RE = /\d{1,3}丁目\d{1,5}番地?(?:\d{1,5}号?)?|\d{1,5}番地(?:\d{1,5})?/g;

/**
 * 文からお客様の個人情報を除く (AI に渡す前・AI の答え・定型文)。
 * お名前 → 「お客様」、住所 → 町名まで、電話・メール → 消す、「〇〇様邸」→「お客様宅」
 */
export function scrubPersonal(text: string, ctx: PersonalContext): string {
  let s = (text ?? "").normalize("NFKC");
  s = s.replace(EMAIL_RE, "");
  for (const e of ctx.emails) if (e) s = s.split(e).join("");
  s = s.replace(PHONE_RE, (m) => (digits(m).length >= 10 ? "" : m));
  for (const addr of ctx.addresses) {
    const n = normalizeAddress(addr);
    for (const form of [addr.normalize("NFKC").trim(), n.display].filter((x) => x && x.length >= 4)) s = s.split(form).join(n.town || "");
  }
  for (const v of nameVariants(ctx.names)) s = s.replace(new RegExp(`${esc(v)}(?:\\s*(?:様邸|様宅|様方|様|さま|邸))?`, "g"), "お客様");
  s = s.replace(HONORIFIC_RE, (m, n: string, suffix: string) => (NOT_NAME.has(n) ? m : suffix === "様方" ? "お客様" : "お客様宅"));
  s = s.replace(/お客様(?:\s*お客様)+/g, "お客様");
  // 町名のすぐ後ろの番地 (住所の文字が少し違って上で消えなかったもの)
  for (const addr of ctx.addresses) {
    const town = normalizeAddress(addr).town;
    if (town) s = s.replace(new RegExp(`(${esc(town)})\\s*${HOUSE}`, "g"), "$1");
  }
  s = s.replace(FULL_HOUSE_RE, "");
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
}

/** 投稿文・見出しに残っている個人情報 (確認を頼むとき・承認するときに確かめる)。なければ空 */
export function personalInfoFindings(text: string, ctx: PersonalContext): string[] {
  const s = (text ?? "").normalize("NFKC");
  const out: string[] = [];
  for (const v of nameVariants(ctx.names)) if (s.includes(v)) out.push(`お客様のお名前「${v}」`);
  const phoneHits = (s.match(PHONE_RE) ?? []).filter((m) => digits(m).length >= 10);
  const known = new Set(ctx.phones.map(digits).filter((d) => d.length >= 10));
  if (phoneHits.some((m) => known.has(digits(m)))) out.push("お客様の電話番号");
  else if (phoneHits.length) out.push(`電話番号のような数字「${phoneHits[0]}」`);
  if (EMAIL_RE.test(s)) out.push("メールアドレス");
  EMAIL_RE.lastIndex = 0;
  for (const addr of ctx.addresses) {
    const n = normalizeAddress(addr);
    if (n.houseNumber && n.town && new RegExp(`${esc(n.town)}\\s*${esc(n.houseNumber.split("-")[0])}(?:\\D|$)`).test(s)) out.push(`番地まで書いた住所「${n.town}${n.houseNumber}」`);
  }
  const honor = [...s.matchAll(HONORIFIC_RE)].filter((m) => !NOT_NAME.has(m[1])).map((m) => m[0]);
  if (honor.length) out.push(`お名前のような書き方「${honor[0]}」`);
  const house = s.match(FULL_HOUSE_RE);
  if (house) out.push(`番地「${house[0]}」`);
  return [...new Set(out)];
}

/* ================================================================== */
/* 定型文 (AI がないとき・失敗したとき)                                       */
/* ================================================================== */

export interface PostDraftInput {
  title: string;
  area: string;
  products: string[];
  workContent: string;
  categoryLabel: string;
  storeName: string;
  channels: CasePostChannel[];
  /** 施工の月 (例: 11 月) */
  month?: string;
}

const TAG_WORDS: [RegExp, string][] = [
  [/畳|たたみ|タタミ/, "畳"],
  [/表替|表がえ|おもてがえ/, "畳表替え"],
  [/新調|新畳/, "畳新調"],
  [/裏返/, "畳裏返し"],
  [/琉球|縁なし|へりなし/, "縁なし畳"],
  [/和紙/, "和紙畳"],
  [/襖|ふすま/, "襖張替え"],
  [/障子/, "障子張替え"],
  [/網戸/, "網戸張替え"],
  [/クロス|壁紙/, "クロス張替え"],
  [/カーテン/, "カーテン"],
  [/ブラインド/, "ブラインド"],
  [/リフォーム/, "リフォーム"],
];

/** ハッシュタグの候補 (#一畳屋・種別・商品の言葉・市町村) */
export function suggestHashtags(input: Pick<PostDraftInput, "area" | "products" | "workContent" | "categoryLabel">): string[] {
  const tags = ["一畳屋"];
  const hay = `${input.categoryLabel} ${input.products.join(" ")} ${input.workContent}`;
  for (const [re, tag] of TAG_WORDS) if (re.test(hay) && !tags.includes(tag)) tags.push(tag);
  const city = /^(.+?[市町村])/.exec(input.area)?.[1]?.replace(/^.+?郡/, "");
  if (city) tags.push(city.replace(/^熊本市.+$/, "熊本市"));
  tags.push("施工事例", "和室");
  return [...new Set(tags)].slice(0, 10).map((t) => `#${t}`);
}

/** 定型文の投稿文 (地域・施工内容・商品名だけを使う) */
export function templateDraft(input: PostDraftInput): { text: string; hashtags: string } {
  const area = input.area ? `${input.area}で` : "";
  const what = input.categoryLabel ? `${input.categoryLabel}の` : "";
  const lines: string[] = [];
  lines.push(`【施工事例】${area}${what}施工をさせていただきました。`);
  const work = input.workContent.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 4);
  if (work.length) lines.push("", "■ 施工内容", ...work.map((l) => `・${l}`));
  if (input.products.length) lines.push("", "■ 使用した商品", ...input.products.slice(0, 8).map((p) => `・${p}`));
  lines.push("", `畳・襖・障子・網戸のことなら、一畳屋${input.storeName ? ` ${input.storeName}` : ""}にお気軽にご相談ください。`);
  const hashtags = input.channels.some((c) => c === "instagram" || c === "facebook") || input.channels.length === 0 ? suggestHashtags(input).join(" ") : "";
  return { text: lines.join("\n"), hashtags };
}

/** ハッシュタグの書き方をそろえる (# を付け、空白区切り・重複なし・15 個まで) */
export function normalizeHashtags(raw: string | string[]): string {
  const list = (Array.isArray(raw) ? raw : raw.split(/[\s　,、]+/))
    .map((t) => t.normalize("NFKC").trim().replace(/^#+/, "").replace(/[#\s]/g, ""))
    .filter(Boolean);
  return [...new Set(list)].slice(0, 15).map((t) => `#${t}`).join(" ");
}

/** コピーする文 (本文 + ハッシュタグ) */
export function postFullText(p: Pick<CasePost, "text" | "hashtags">): string {
  return [p.text.trim(), p.hashtags.trim()].filter(Boolean).join("\n\n");
}

/* ================================================================== */
/* 作成・修正・状態の変更                                                   */
/* ================================================================== */

/** 番号 (CP-2026-0001) */
export function nextPostNumber(list: { number: string }[], dateKey: string, prefix = "CP"): string {
  const head = `${prefix}-${dateKey.slice(0, 4)}-`;
  const max = list.filter((x) => x.number.startsWith(head)).reduce((m, x) => Math.max(m, Number(x.number.slice(head.length)) || 0), 0);
  return `${head}${String(max + 1).padStart(4, "0")}`;
}

function event(p: CasePost, by: string, action: CasePostAction, at: string, extra: Partial<CasePostEvent> = {}) {
  p.events.push({ at, by, action, ...extra });
  if (p.events.length > 200) p.events.splice(0, p.events.length - 200);
}

export interface CasePostFields {
  title?: string;
  photoIds?: string[];
  products?: string;
  workContent?: string;
  area?: string;
  channels?: CasePostChannel[];
  text?: string;
  hashtags?: string;
  consent?: CasePostConsent;
}

function cleanChannels(list: readonly string[] | undefined): CasePostChannel[] {
  return [...new Set((list ?? []).filter((c): c is CasePostChannel => (CASE_POST_CHANNELS as string[]).includes(c)))];
}

/** 新しい投稿 (下書き) を作って db に足す。photoIds は呼び出し側で受注の写真か確かめておく */
export function createCasePost(
  db: Pick<Database, "casePosts">,
  user: User,
  input: { id: string; order: Pick<Order, "id" | "storeId">; fields: CasePostFields; aiText?: string; provider: CasePost["provider"] },
  now: string,
): CasePost {
  const f = input.fields;
  const p: CasePost = {
    id: input.id,
    number: nextPostNumber(db.casePosts, now.slice(0, 10)),
    orderId: input.order.id,
    storeId: input.order.storeId as StoreId,
    title: clean(f.title, 120),
    photoIds: [...new Set(f.photoIds ?? [])].slice(0, CASE_POST_MAX_PHOTOS),
    products: clean(f.products, 2000),
    workContent: clean(f.workContent, 3000),
    area: clean(f.area, 60) || undefined,
    channels: cleanChannels(f.channels),
    aiText: input.aiText,
    text: clean(f.text, CASE_POST_MAX_TEXT),
    hashtags: normalizeHashtags(f.hashtags ?? ""),
    provider: input.provider,
    consent: f.consent ?? "unconfirmed",
    status: "draft",
    postings: [],
    events: [],
    createdBy: user.id,
    createdAt: now,
    updatedAt: now,
  };
  event(p, user.id, "create", now, { to: "draft" });
  db.casePosts.push(p);
  return p;
}

const FIELD_KEYS = ["title", "photoIds", "products", "workContent", "area", "channels", "text", "hashtags", "consent"] as const;
/** 直すと承認のやり直しになる項目 (お客様の了承の記録だけの変更はやり直さない) */
const CONTENT_KEYS = new Set<string>(["title", "photoIds", "products", "workContent", "area", "channels", "text", "hashtags"]);

/**
 * 内容を直す。変わったときだけ記録する。承認済みを確認する人以外が直すと下書きに戻る。
 * 戻り値の changes は変更履歴に残す変更 (長い文は文字数だけ)
 */
export function editCasePost(p: CasePost, user: User, f: CasePostFields, reviewerIds: readonly string[], now: string, source: "edit" | "ai" = "edit"): { changed: boolean; reset: boolean; changes: AuditChange[] } {
  if (!canEditCasePost(user, p, reviewerIds)) {
    throw new CasePostError(
      p.status === "review" ? "確認を依頼している間は、確認する人だけが直せます。直すときは「確認の依頼を取り下げる」を押してください。" : p.status === "posted" ? "投稿済みの投稿は直せません。" : p.status === "discarded" ? "取りやめた投稿です。下書きに戻してから直してください。" : "この投稿を直す権限がありません。",
    );
  }
  const next: Record<string, unknown> = {
    title: f.title === undefined ? p.title : clean(f.title, 120),
    photoIds: f.photoIds === undefined ? p.photoIds : [...new Set(f.photoIds)].slice(0, CASE_POST_MAX_PHOTOS),
    products: f.products === undefined ? p.products : clean(f.products, 2000),
    workContent: f.workContent === undefined ? p.workContent : clean(f.workContent, 3000),
    area: f.area === undefined ? p.area : clean(f.area, 60) || undefined,
    channels: f.channels === undefined ? p.channels : cleanChannels(f.channels),
    text: f.text === undefined ? p.text : clean(f.text, CASE_POST_MAX_TEXT),
    hashtags: f.hashtags === undefined ? p.hashtags : normalizeHashtags(f.hashtags),
    consent: f.consent ?? p.consent,
  };
  const changes: AuditChange[] = [];
  let content = false;
  for (const k of FIELD_KEYS) {
    const before = (p as unknown as Record<string, unknown>)[k];
    const after = next[k];
    if (JSON.stringify(before ?? "") === JSON.stringify(after ?? "")) continue;
    if (CONTENT_KEYS.has(k)) content = true;
    changes.push(
      k === "text" || k === "workContent"
        ? { field: k, before: `${String(before ?? "").length} 文字`, after: `${String(after ?? "").length} 文字` }
        : k === "photoIds"
          ? { field: k, before: `${(before as string[]).length} 枚`, after: `${(after as string[]).length} 枚` }
          : { field: k, before: before ?? "", after: after ?? "" },
    );
  }
  if (!changes.length) return { changed: false, reset: false, changes };
  Object.assign(p, next);
  const from = p.status;
  const reset = content && from === "approved" && !isCasePostReviewer(user, reviewerIds);
  if (reset) {
    p.status = "draft";
    p.approvedBy = p.approvedAt = undefined;
    changes.push({ field: "status", before: CASE_POST_STATUS.approved.label, after: CASE_POST_STATUS.draft.label });
  }
  p.updatedBy = user.id;
  p.updatedAt = now;
  event(p, user.id, source, now, reset ? { from, to: "draft" } : {});
  return { changed: true, reset, changes };
}

export type CasePostTransition = "request" | "approve" | "return" | "withdraw" | "discard" | "restore";

/** 確認を頼む・承認するときに足りないもの (なければ空) */
export function readinessProblems(p: Pick<CasePost, "text" | "title" | "photoIds" | "channels">, ctx: PersonalContext): string[] {
  const out: string[] = [];
  if (!p.text.trim()) out.push("投稿文が空です");
  if (!p.photoIds.length) out.push("写真を 1 枚以上選んでください");
  if (!p.channels.length) out.push("投稿先を選んでください");
  const found = personalInfoFindings(`${p.title}\n${p.text}`, ctx);
  if (found.length) out.push(`投稿文にお客様の個人情報が残っています (${found.join("・")})。町名までにして、お名前・電話番号は消してください`);
  return out;
}

const TRANSITION: Record<CasePostTransition, { to: CasePostStatus; can: (u: User, p: CasePost, ids: readonly string[]) => boolean; denied: (p: CasePost) => string }> = {
  request: { to: "review", can: canRequestCasePostReview, denied: (p) => (p.status === "draft" || p.status === "returned" ? "この投稿の確認を依頼する権限がありません。" : `「${CASE_POST_STATUS[p.status].label}」の投稿は確認を依頼できません。`) },
  approve: {
    to: "approved",
    can: canApproveCasePost,
    denied: (p) => (p.status !== "review" ? "承認できるのは確認を依頼している投稿です。" : "この投稿を承認する権限がありません (確認する人が承認します。自分が作った投稿は承認できません)。"),
  },
  return: { to: "returned", can: canReturnCasePost, denied: (p) => (p.status === "review" || p.status === "approved" ? "差し戻せるのは確認する人です。" : "差し戻せるのは確認依頼中・承認済みの投稿です。") },
  withdraw: { to: "draft", can: (u, p) => canWithdrawCasePost(u, p), denied: () => "取り下げられるのは確認依頼中の投稿です。" },
  discard: { to: "discarded", can: (u, p, ids) => p.status !== "discarded" && canDiscardCasePost(u, p, ids), denied: (p) => (p.status === "posted" ? "投稿済みの投稿は取りやめにできません。" : p.status === "discarded" ? "すでに取りやめています。" : "この投稿を取りやめる権限がありません。") },
  restore: { to: "draft", can: (u, p, ids) => p.status === "discarded" && canDiscardCasePost(u, p, ids), denied: () => "下書きに戻せるのは取りやめた投稿です。" },
};

/** 状態を変える (確認の依頼・承認・差し戻し・取り下げ・取りやめ・戻す)。差し戻しは理由が必要。確認の依頼と承認は足りないものがあると断る */
export function transitionCasePost(p: CasePost, user: User, action: CasePostTransition, reviewerIds: readonly string[], ctx: PersonalContext, comment: string | undefined, now: string): { from: CasePostStatus; to: CasePostStatus } {
  const t = TRANSITION[action];
  if (!t.can(user, p, reviewerIds)) throw new CasePostError(t.denied(p));
  const note = clean(comment, 500) || undefined;
  if (action === "return" && !note) throw new CasePostError("差し戻しの理由を入力してください (作成者に伝わります)。");
  if (action === "request" || action === "approve") {
    const problems = readinessProblems(p, ctx);
    if (problems.length) throw new CasePostError(`${action === "request" ? "確認を依頼" : "承認"}できません: ${problems.join(" / ")}。`);
  }
  const from = p.status;
  p.status = t.to;
  if (action === "request") Object.assign(p, { requestedBy: user.id, requestedAt: now });
  if (action === "approve") Object.assign(p, { approvedBy: user.id, approvedAt: now });
  if (action === "return" || action === "withdraw" || action === "restore") Object.assign(p, { approvedBy: undefined, approvedAt: undefined });
  p.updatedBy = user.id;
  p.updatedAt = now;
  event(p, user.id, action, now, { from, to: t.to, comment: note });
  return { from, to: t.to };
}

/** 投稿したことを記録する (承認済み → 投稿済み。投稿済みに別の投稿先を足すこともできる) */
export function recordCasePosting(p: CasePost, user: User, posting: { channel: CasePostChannel; on: string; url?: string }, reviewerIds: readonly string[], now: string): { from: CasePostStatus } {
  if (!canRecordCasePosting(user, p, reviewerIds)) throw new CasePostError(p.status === "approved" || p.status === "posted" ? "この投稿を記録する権限がありません。" : "投稿を記録できるのは、承認済みの投稿です (確認 → 承認 のあとに投稿してください)。");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(posting.on)) throw new CasePostError("投稿した日を入れてください。");
  const url = clean(posting.url, 500);
  if (url && !/^https?:\/\/\S+$/.test(url)) throw new CasePostError("URL は https:// から入れてください。");
  const from = p.status;
  p.postings = [...p.postings.filter((x) => !(x.channel === posting.channel && x.on === posting.on && (x.url ?? "") === url)), { channel: posting.channel, on: posting.on, url: url || undefined, by: user.id, at: now }];
  p.status = "posted";
  p.postedAt ??= now;
  p.updatedBy = user.id;
  p.updatedAt = now;
  event(p, user.id, "post", now, { from, to: "posted", comment: `${CASE_POST_CHANNEL_LABEL[posting.channel]} ${posting.on}${url ? ` ${url}` : ""}` });
  return { from };
}

/* ================================================================== */
/* 一覧・知らせ                                                         */
/* ================================================================== */

export const lastPostEvent = (p: Pick<CasePost, "events">): CasePostEvent | undefined => p.events[p.events.length - 1];

/** 最後の差し戻しの理由 */
export function lastReturnComment(p: Pick<CasePost, "events">): string | undefined {
  for (let i = p.events.length - 1; i >= 0; i--) if (p.events[i].action === "return") return p.events[i].comment;
  return undefined;
}

/** 画面のヘッダーの知らせ: 確認を待っている投稿 (確認する人)・差し戻された自分の投稿・承認されてまだ投稿していない自分の投稿 */
export function casePostAttention(db: Pick<Database, "casePosts" | "settings" | "users">, user: User): { toReview: CasePost[]; returned: CasePost[]; toPost: CasePost[] } {
  const list = db.casePosts ?? [];
  if (!list.length) return { toReview: [], returned: [], toPost: [] };
  const ids = casePostReviewerIds(db);
  return {
    toReview: list.filter((p) => p.status === "review" && canApproveCasePost(user, p, ids)),
    returned: list.filter((p) => p.status === "returned" && (p.createdBy === user.id || p.requestedBy === user.id)),
    toPost: list.filter((p) => p.status === "approved" && (p.createdBy === user.id || p.requestedBy === user.id)),
  };
}

/** 見られる投稿 */
export function visibleCasePosts(db: Pick<Database, "casePosts" | "settings" | "users">, user: User): CasePost[] {
  const ids = casePostReviewerIds(db);
  return (db.casePosts ?? []).filter((p) => canViewCasePost(user, p, ids));
}
