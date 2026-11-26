import type { Database, Inquiry, MediaKey, ServiceCategory, StoreId, User } from "@/lib/db/types";
import { addAudit, newId, nowIso } from "@/lib/db/store";
import { addChangeNotice, caseTarget } from "@/lib/change-notices";
import { CHANNEL_LABEL } from "@/lib/constants";
import { buildCaseMap, caseHref, customerCaseSummaries, summarizeCase, type CaseMap, type CaseMembers, type CaseSummary } from "@/lib/case-group";
import { caseIndex } from "@/lib/case-status";
import { canEditCaseStore } from "@/lib/auth/permissions";
import { isMediaKey } from "@/lib/media";
import { toDateKey } from "@/lib/format";

/**
 * 問い合わせの登録のときの「新規案件か、既存の案件か」(お客様のご要望 2026-11-26「■5」)
 * ------------------------------------------------------------
 * 既存のお客様の問い合わせは、そのお客様の進行中の案件と最近の完了した案件 (クレーム・手直しの連絡) を候補に出し、
 * 工事内容・進み具合を見て「新規案件として登録」か「この案件に問い合わせを追加」を選ぶ (問合せ登録の確認の画面・手入力の問い合わせ・問い合わせの画面)。
 * どちらでも問い合わせの記録は必ず作り、既存の案件に追加したときは Inquiry.caseId = 案件の ID (src/lib/case-group.ts)。
 * 画面に渡す CaseOption は JSON にできる値だけ (クライアントの部品 src/components/inquiries/CaseChoice.tsx。型だけを import する)
 */

/** 完了した案件を候補に出す期間 (年) と件数 */
export const PAST_CASE_YEARS = 3;
export const PAST_CASE_LIMIT = 10;

export interface CaseOption {
  id: string;
  number: string;
  href: string;
  title: string;
  open: boolean;
  stageLabel: string;
  detail: string;
  startedAt: string;
  lastAt: string;
  amount?: number;
  amountLabel: string;
  storeId: StoreId;
  storeName: string;
  counts: { inquiries: number; quotes: number; orders: number };
  /** この案件に問い合わせを追加できる (案件の店舗の記録を変更できる。permissions.ts の canEditCaseStore) */
  canAdd: boolean;
  /** 案件の担当 (問い合わせの担当者の初期値・知らせる相手) */
  ownerId?: string;
  /** 案件の媒体 (最初の問い合わせの媒体。追加する問い合わせの媒体の初期値) */
  media?: MediaKey;
}

export interface CaseRecordRef {
  type: "inquiry" | "quote" | "order";
  id: string;
  number: string;
  title: string;
  href: string;
  storeId: StoreId;
}

/** 案件の記録 (問い合わせ・見積・受注) の参照 */
function recordRef(m: CaseMembers, id: string): CaseRecordRef | undefined {
  const o = m.orders.find((x) => x.id === id);
  if (o) return { type: "order", id: o.id, number: o.number, title: o.title, href: `/orders/${o.id}`, storeId: o.storeId };
  const q = m.quotes.find((x) => x.id === id);
  if (q) return { type: "quote", id: q.id, number: q.number, title: q.title, href: `/quotes/${q.id}`, storeId: q.storeId };
  const i = m.inquiries.find((x) => x.id === id);
  if (i) return { type: "inquiry", id: i.id, number: i.number, title: i.summary, href: `/inquiries/${i.id}`, storeId: i.storeId };
  return undefined;
}

/** 案件の連絡を書き残す記録: いちばん新しい受注 (取り消しを除く) → 見積 → 問い合わせ */
export function caseContactTarget(m: CaseMembers): CaseRecordRef | undefined {
  const o = [...m.orders].reverse().find((x) => x.status !== "cancelled") ?? m.orders.at(-1);
  if (o) return { type: "order", id: o.id, number: o.number, title: o.title, href: `/orders/${o.id}`, storeId: o.storeId };
  const q = m.quotes.at(-1);
  if (q) return { type: "quote", id: q.id, number: q.number, title: q.title, href: `/quotes/${q.id}`, storeId: q.storeId };
  const i = [...m.inquiries].reverse().find((x) => !x.deleted);
  if (i) return { type: "inquiry", id: i.id, number: i.number, title: i.summary, href: `/inquiries/${i.id}`, storeId: i.storeId };
  return undefined;
}

/** 案件の担当: 受注 → その見積の担当者 (見積の作成者・受注の作成者)、見積 → 担当者、問い合わせ → 担当者 */
export function caseOwnerId(db: Pick<Database, "quotes">, m: CaseMembers): string | undefined {
  const o = [...m.orders].reverse().find((x) => x.status !== "cancelled");
  if (o) {
    const q = o.quoteId ? (m.quotes.find((x) => x.id === o.quoteId) ?? db.quotes.find((x) => x.id === o.quoteId)) : undefined;
    return q?.estimatorId ?? q?.createdBy ?? o.createdBy;
  }
  const q = m.quotes.at(-1);
  if (q) return q.estimatorId ?? q.createdBy;
  return [...m.inquiries].reverse().find((i) => i.assignedUserId)?.assignedUserId;
}

/** 案件の媒体 (案件のいちばん古い、媒体のある問い合わせ) */
export function caseMedia(m: CaseMembers): MediaKey | undefined {
  return m.inquiries.find((i) => isMediaKey(i.media))?.media;
}

const yearsBefore = (date: string, years: number) => `${Number(date.slice(0, 4)) - years}${date.slice(4)}`;

function toOption(db: Database, user: User, s: CaseSummary, m: CaseMembers | undefined): CaseOption {
  const store = db.stores.find((x) => x.id === s.storeId);
  return {
    id: s.id,
    number: s.number,
    href: s.href,
    title: s.title,
    open: s.open,
    stageLabel: s.stageLabel,
    detail: s.detail,
    startedAt: s.startedAt,
    lastAt: s.lastAt,
    ...(s.amount !== undefined ? { amount: s.amount } : {}),
    amountLabel: s.amountLabel,
    storeId: s.storeId,
    storeName: store?.shortName ?? store?.name ?? s.storeId,
    counts: s.counts,
    canAdd: Boolean(s.storeId) && canEditCaseStore(user, s.storeId),
    ...(m ? { ownerId: caseOwnerId(db, m), media: caseMedia(m) } : {}),
  };
}

/**
 * お客様の案件の候補: 進行中 (すべて) と、完了した案件のうち最後の動きが PAST_CASE_YEARS 年以内のもの (新しい順に PAST_CASE_LIMIT 件)。
 * excludeCaseId = 候補から外す案件 (問い合わせの画面で、その問い合わせの案件)
 */
export function caseOptionsForCustomer(
  db: Database,
  user: User,
  customerId: string,
  today = toDateKey(new Date()),
  opts: { excludeCaseId?: string; map?: CaseMap } = {},
): { open: CaseOption[]; past: CaseOption[]; pastTotal: number } {
  const map = opts.map ?? buildCaseMap(db);
  const { open, past } = customerCaseSummaries(db, customerId, today, map);
  const since = yearsBefore(today, PAST_CASE_YEARS);
  const keep = (s: CaseSummary) => s.id !== opts.excludeCaseId;
  const recent = past.filter((s) => keep(s) && (s.lastAt || s.startedAt) >= since);
  return {
    open: open.filter(keep).map((s) => toOption(db, user, s, map.members(s.id))),
    past: recent.slice(0, PAST_CASE_LIMIT).map((s) => toOption(db, user, s, map.members(s.id))),
    pastTotal: recent.length,
  };
}

/**
 * 初めに選んでおく案件: 指定 (URL の caseId・前に選んだもの) が候補にあればそれ → 進行中の案件が 1 件だけ (追加できる) ならその案件 → 新規案件。
 * 戻り値は案件の ID か "new"
 */
export function initialCaseChoice(options: { open: CaseOption[]; past: CaseOption[] }, preferred?: string): string {
  const all = [...options.open, ...options.past];
  if (preferred === "new") return "new";
  if (preferred && all.some((c) => c.id === preferred && c.canAdd)) return preferred;
  return options.open.length === 1 && options.open[0].canAdd ? options.open[0].id : "new";
}

export interface CaseAdd {
  caseId: string;
  number: string;
  title: string;
  href: string;
  open: boolean;
  storeId: StoreId;
  storeName: string;
  customerId?: string;
  ownerId?: string;
  media?: MediaKey;
  /** 案件の種別 (いちばん新しい受注 → 見積 → 問い合わせ) */
  category?: ServiceCategory;
  /** 案件の連絡を書き残す記録 (受注なら経過メモにも書く) */
  target?: CaseRecordRef;
}

/**
 * 問い合わせを追加する案件を確かめる。id = 案件の ID か、その案件のどれかの記録 (問い合わせ・見積・受注) の ID。
 * record = true のときは id の記録 (登録先で選んだ受注など) に連絡を書き残す (ふつうは案件のいちばん進んだ記録)。
 * 案件の店舗の記録を変更できない人 (店舗スタッフのほかの店舗の案件) は追加できない
 */
export function caseForAdd(db: Database, user: User, id: string, map: CaseMap = buildCaseMap(db), opts: { record?: boolean; today?: string } = {}): CaseAdd | { error: string } {
  const today = opts.today ?? toDateKey(new Date());
  const caseId = map.caseOf(id);
  const m = caseId ? map.members(caseId) : undefined;
  if (!caseId || !m) return { error: "選んだ案件が見つかりません。" };
  const s = summarizeCase(m, caseIndex(db), today);
  const store = db.stores.find((x) => x.id === s.storeId);
  const storeName = store?.name ?? s.storeId;
  if (!s.storeId || !canEditCaseStore(user, s.storeId)) {
    return { error: `案件 ${s.number} は${storeName}の案件のため、この案件には追加できません (この店舗の記録を変更する権限がありません)。新規案件として登録するか、${storeName}に依頼してください。` };
  }
  return {
    caseId,
    number: s.number,
    title: s.title,
    href: caseHref(caseId),
    open: s.open,
    storeId: s.storeId,
    storeName,
    customerId: s.customerId,
    ownerId: caseOwnerId(db, m),
    media: caseMedia(m),
    category: (m.orders.at(-1) ?? m.quotes.at(-1) ?? m.inquiries.at(-1))?.category,
    target: (opts.record ? recordRef(m, id) : undefined) ?? caseContactTarget(m),
  };
}

/** 案件のすべての記録の ID (問い合わせ・見積・受注。予定の二重登録の確かめ用) */
export function caseRecordIds(map: CaseMap, id: string | undefined): { inquiryIds: string[]; quoteIds: string[]; orderIds: string[] } {
  const caseId = map.caseOf(id);
  const m = caseId ? map.members(caseId) : undefined;
  return { inquiryIds: m?.inquiries.map((i) => i.id) ?? [], quoteIds: m?.quotes.map((q) => q.id) ?? [], orderIds: m?.orders.map((o) => o.id) ?? [] };
}

/**
 * 既存の案件に問い合わせを追加したときの記録 (mutate の中で呼ぶ): 受注なら経過メモ、案件の記録の変更履歴、案件の担当店舗への「変更のお知らせ」。
 * 問い合わせそのものの記録 (やりとり・資料) は問い合わせに付ける (案件の画面にまとめて出る)
 */
export function noteInquiryOnCase(db: Database, userId: string, add: CaseAdd, inq: Pick<Inquiry, "number" | "summary" | "channel">, p: { body?: string; via: string }) {
  const target = add.target;
  if (!target) return;
  const now = nowIso();
  if (target.type === "order") {
    const o = db.orders.find((x) => x.id === target.id);
    if (o) {
      o.progressNotes.push({ id: newId("pn"), at: now, userId, kind: "note", body: `お客様から連絡 (${CHANNEL_LABEL[inq.channel] ?? inq.channel}・問い合わせ ${inq.number}): ${inq.summary}${p.body && p.body !== inq.summary ? `\n${p.body}` : ""}`.slice(0, 3000) });
      o.updatedAt = now;
    }
  } else if (target.type === "quote") {
    const q = db.quotes.find((x) => x.id === target.id);
    if (q) q.updatedAt = now;
  } else {
    const i = db.inquiries.find((x) => x.id === target.id);
    if (i) i.updatedAt = now;
  }
  addAudit(db, { userId, action: "update", entity: target.type, entityId: target.id, entityLabel: target.number, summary: `問い合わせ ${inq.number} を案件 ${add.number} に追加 (${p.via} / ${CHANNEL_LABEL[inq.channel] ?? inq.channel} / ${inq.summary})`.slice(0, 300), storeId: target.storeId });
  addChangeNotice(db, userId, caseTarget(db, target.id), "問い合わせの追加", [{ label: "問い合わせ", before: "(なし)", after: `${inq.number} ${inq.summary}`.slice(0, 200) }]);
}
