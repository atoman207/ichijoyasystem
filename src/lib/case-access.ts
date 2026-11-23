import type { Approval, Customer, Database, Inquiry, Invoice, Order, Quote, StoreId, User } from "@/lib/db/types";
import { canAccessStore, canEditCaseStore, canEditCompletedCase, canReadStoreRecords, canRequestRecordView, canViewOpenCases } from "@/lib/auth/permissions";
import { accessPolicy, policyReader, type AccessPolicy } from "@/lib/access-policy";
import { caseIndex, inquiryCase, orderCase, quoteCase, type CaseIndex, type CaseRow } from "@/lib/case-status";
import { toDateKey } from "@/lib/format";
import { invoiceOrderIds } from "@/lib/billing";

/**
 * 案件の閲覧の範囲と、完了した案件の変更の制限
 * ------------------------------------------------------------
 * 1. 進行中の案件 (問い合わせ → 見積 → 受注・施工 → 請求 → 入金完了 まで) は、全社員がほかの店舗の案件も閲覧できる
 *    (お客様が別の店舗に電話したときなどに、どの店舗でも状況を確かめられるように。お客様のご要望)。
 *    入金が完了した・全処理完了にした・失注・キャンセルした案件は、通常の権限 (自店舗。全店舗ロールは全店舗) に戻る。
 *    ほかの店舗の案件は「閲覧のみ」: 登録・変更・削除はその店舗の社員 (サーバーの操作は assertStore・assertCaseStore で断る)。
 *    ただし店長は、顧客・問い合わせ・見積・受注をすべての店舗で変更できる (お客様の決定 2026-11-23。permissions.ts の canEditCaseStore)。
 *    請求書はこれまでどおりその店舗の社員だけ (canAccessStore)
 *    進行中かどうかは「案件の進捗」(src/lib/case-status.ts) と同じ判定: 失注・キャンセル・全処理完了・移行データの完了ではなく、入金が済んでいない
 * 2. 入金が完了した案件・全処理完了の案件は、内容 (案件情報・契約内容・現場の情報・状態・見積) を変更できない。変更できるのは管理者だけ
 *    (canEditCompletedCase。変更は変更履歴に残る)。進捗・やりとりの記録・写真の追加は続けられる
 * 3. 閲覧の範囲の設定 (src/lib/access-policy.ts) で、ほかの店舗の完了した案件も見られるようにできる:
 *    all = 全社員 (既定) / approval = 店長以上は全店舗、店舗スタッフは上司が承認した顧客 (承認の type = record_view、承認から grantDays 日) / open = 1. だけ。
 *    どの場合も、ほかの店舗の記録は閲覧のみ (edit にはならない。店長の顧客・問い合わせ・見積・受注だけは 1. の例外)。閲覧は自店舗の記録も含めて変更履歴に記録する (src/lib/record-views.ts)
 */

export type RecordAccess = "edit" | "view" | "none";

/** 案件の行が進行中か (入金が完了するまで) */
export function isOpenCaseRow(r: Pick<CaseRow, "closed" | "payment">): boolean {
  return !r.closed && r.payment !== "paid";
}

function index(db: Database): CaseIndex {
  return caseIndex(db);
}

/** 受注の案件の行 (請求・入金を含めた状態) */
function orderRow(db: Database, o: Order, ix = index(db)): CaseRow {
  return orderCase(o, ix, toDateKey(new Date()));
}

function orderOfQuote(db: Database, q: Quote): Order | undefined {
  return db.orders.find((o) => o.id === q.orderId || o.quoteId === q.id);
}

export function isOpenOrder(db: Database, o: Order, ix?: CaseIndex): boolean {
  return isOpenCaseRow(orderRow(db, o, ix));
}

export function isOpenQuote(db: Database, q: Quote, ix?: CaseIndex): boolean {
  const o = orderOfQuote(db, q);
  if (o) return isOpenOrder(db, o, ix);
  return isOpenCaseRow(quoteCase(q, ix ?? index(db)));
}

export function isOpenInquiry(db: Database, i: Inquiry, ix?: CaseIndex): boolean {
  const quotes = db.quotes.filter((q) => q.inquiryId === i.id || q.id === i.quoteId);
  if (quotes.length) {
    const x = ix ?? index(db);
    return quotes.some((q) => isOpenQuote(db, q, x));
  }
  return isOpenCaseRow(inquiryCase(i, ix ?? index(db), toDateKey(new Date())));
}

export function isOpenInvoice(db: Database, inv: Invoice, ix?: CaseIndex): boolean {
  if (inv.status === "void") return false;
  // まとめ請求は、対象の案件のどれかが進行中なら進行中
  const ids = new Set(invoiceOrderIds(inv));
  const x = ix ?? (ids.size > 1 ? index(db) : undefined);
  return db.orders.some((o) => ids.has(o.id) && isOpenOrder(db, o, x));
}

/** お客様に進行中の案件があるか */
export function hasOpenCase(db: Database, c: Pick<Customer, "id">, ix?: CaseIndex): boolean {
  const x = ix ?? index(db);
  return (
    db.orders.some((o) => o.customerId === c.id && isOpenOrder(db, o, x)) ||
    db.quotes.some((q) => q.customerId === c.id && isOpenQuote(db, q, x)) ||
    db.inquiries.some((i) => i.customerId === c.id && isOpenInquiry(db, i, x))
  );
}

/** 進行中の案件があるお客様の ID (一覧・検索用。まとめて計算する) */
export function openCaseCustomerIds(db: Database): Set<string> {
  const ix = index(db);
  const out = new Set<string>();
  const ordered = new Set<string>();
  for (const o of db.orders) {
    if (o.quoteId) ordered.add(o.quoteId);
    if (isOpenOrder(db, o, ix)) out.add(o.customerId);
  }
  const quoted = new Set<string>();
  for (const q of db.quotes) {
    if (q.inquiryId) quoted.add(q.inquiryId);
    if (q.orderId || ordered.has(q.id)) continue;
    if (isOpenCaseRow(quoteCase(q, ix))) out.add(q.customerId);
  }
  const today = toDateKey(new Date());
  for (const i of db.inquiries) {
    if (!i.customerId || i.quoteId || quoted.has(i.id)) continue;
    if (isOpenCaseRow(inquiryCase(i, ix, today))) out.add(i.customerId);
  }
  return out;
}

/** 記録の種類 (変えられる店舗の判定が違う: 請求書は自店舗だけ) */
export type RecordKind = "customer" | "inquiry" | "quote" | "order" | "invoice";

/** 記録の店舗で変更できるか: 顧客・問い合わせ・見積・受注は canEditCaseStore (店長は全店舗)、請求書は canAccessStore (自店舗) */
export function canEditRecordStore(user: User, kind: RecordKind, storeId: StoreId): boolean {
  return kind === "invoice" ? canAccessStore(user, storeId) : canEditCaseStore(user, storeId);
}

/**
 * 記録を見られるか・変えられるか
 * - edit: 記録の店舗で変更できる (canEditRecordStore)
 * - view: ほかの店舗の記録 (閲覧のみ)。理由は basis
 * - none: 見られない
 */
export function recordAccess(user: User, kind: RecordKind, storeId: StoreId, isOpen: () => boolean): RecordAccess {
  if (canEditRecordStore(user, kind, storeId)) return "edit";
  return canViewOpenCases(user) && isOpen() ? "view" : "none";
}

/** ほかの店舗の記録を見られる理由: open = 進行中の案件 / all = 閲覧の範囲 = 全社員 (承認制の店長を含む) / grant = 閲覧の申請が承認された */
export type ViewBasis = "open" | "all" | "grant";

export interface AccessInfo {
  access: RecordAccess;
  basis?: ViewBasis;
  /** basis = grant のとき、見られる最後の日時 */
  grantUntil?: string;
  /** access = none のとき、閲覧を申請できる (承認制) */
  canRequest?: boolean;
  /** 申請中の閲覧の申請 */
  pending?: Approval;
  /** その記録のお客様 (閲覧の申請の対象) */
  customerId?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 閲覧の申請 (承認の type = record_view) が承認され、まだ期限内か。期限の日時を返す */
export function viewGrantUntil(db: Pick<Database, "approvals">, user: Pick<User, "id">, customerId: string | undefined, policy: AccessPolicy, now = new Date()): string | undefined {
  if (!customerId) return undefined;
  let best: string | undefined;
  for (const a of db.approvals ?? []) {
    if (a.type !== "record_view" || a.targetId !== customerId || a.requestedBy !== user.id || a.status !== "approved" || !a.decidedAt) continue;
    const until = new Date(new Date(a.decidedAt).getTime() + policy.grantDays * DAY_MS).toISOString();
    if (until > now.toISOString() && (!best || until > best)) best = until;
  }
  return best;
}

/** 申請中の閲覧の申請 */
export function pendingViewRequest(db: Pick<Database, "approvals">, user: Pick<User, "id">, customerId: string | undefined): Approval | undefined {
  return customerId ? (db.approvals ?? []).find((a) => a.type === "record_view" && a.targetId === customerId && a.requestedBy === user.id && a.status === "pending") : undefined;
}

/**
 * 閲覧の範囲の設定 (access_policy) を含めて、記録を見られるか・その理由
 * 変更できる店舗 (canEditRecordStore: 自店舗、店長は顧客・問い合わせ・見積・受注なら全店舗) → edit /
 * 全社員に公開 (canReadStoreRecords) → view (all) / 進行中の案件 → view (open) /
 * 承認制で閲覧の申請が承認済み → view (grant) / それ以外 → none (承認制なら申請できる)
 */
export function accessInfo(db: Database, user: User, kind: RecordKind, storeId: StoreId, isOpen: () => boolean, customerId: string | undefined, now = new Date()): AccessInfo {
  if (canEditRecordStore(user, kind, storeId)) return { access: "edit", customerId };
  const policy = accessPolicy(db);
  if (canReadStoreRecords(policyReader(db, user), storeId)) return { access: "view", basis: "all", customerId };
  if (canViewOpenCases(user) && isOpen()) return { access: "view", basis: "open", customerId };
  if (policy.customers === "approval") {
    const until = viewGrantUntil(db, user, customerId, policy, now);
    if (until) return { access: "view", basis: "grant", grantUntil: until, customerId };
    if (customerId && canRequestRecordView(user, policy)) return { access: "none", canRequest: true, pending: pendingViewRequest(db, user, customerId), customerId };
  }
  return { access: "none", customerId };
}

export const orderAccessInfo = (db: Database, user: User, o: Order, now = new Date()) => accessInfo(db, user, "order", o.storeId, () => isOpenOrder(db, o), o.customerId, now);
export const quoteAccessInfo = (db: Database, user: User, q: Quote, now = new Date()) => accessInfo(db, user, "quote", q.storeId, () => isOpenQuote(db, q), q.customerId, now);
export const inquiryAccessInfo = (db: Database, user: User, i: Inquiry, now = new Date()) => accessInfo(db, user, "inquiry", i.storeId, () => isOpenInquiry(db, i), i.customerId, now);
/** 請求書は店長でも自店舗だけ変更できる (ほかの店舗の請求書は閲覧のみ) */
export const invoiceAccessInfo = (db: Database, user: User, inv: Invoice, now = new Date()) => accessInfo(db, user, "invoice", inv.storeId, () => isOpenInvoice(db, inv), inv.customerId, now);
export const customerAccessInfo = (db: Database, user: User, c: Customer, now = new Date()) => accessInfo(db, user, "customer", c.storeId, () => hasOpenCase(db, c), c.id, now);

export const orderAccess = (db: Database, user: User, o: Order) => orderAccessInfo(db, user, o).access;
export const quoteAccess = (db: Database, user: User, q: Quote) => quoteAccessInfo(db, user, q).access;
export const inquiryAccess = (db: Database, user: User, i: Inquiry) => inquiryAccessInfo(db, user, i).access;
export const invoiceAccess = (db: Database, user: User, inv: Invoice) => invoiceAccessInfo(db, user, inv).access;
export const customerAccess = (db: Database, user: User, c: Customer) => customerAccessInfo(db, user, c).access;

/** 見られない記録を開いたときの案内 (承認制で申請できるときは、お客様の画面の「閲覧の申請」へ) */
export function deniedHref(info: AccessInfo, fallback: string, what: string): string {
  if (info.canRequest && info.customerId) return `/customers/${info.customerId}`;
  return `${fallback}?err=${encodeURIComponent(`この${what}を閲覧する権限がありません (ほかの店舗の案件は、入金が完了するまでの間だけ閲覧できます)。`)}`;
}

/* ---------------- 完了した案件の変更の制限 ---------------- */

/** 入金完了・全処理完了の受注か (内容を変えない)。理由の文を返す (変えられるときは空) */
export function completedCaseReason(db: Database, o: Order): string {
  if (o.status === "cancelled") return "";
  if (o.closedAt) return "全処理完了にした案件";
  if (o.status === "paid") return o.source === "import" ? "移行した完了済みの売上" : "入金済みの案件";
  const row = orderRow(db, o);
  if (row.payment === "paid") return "入金が完了した案件";
  return "";
}

/** 完了した案件を変えられるか (管理者だけ) */
export function completedCaseLock(db: Database, user: User, o: Order): { locked: boolean; reason: string } {
  const reason = completedCaseReason(db, o);
  return { locked: Boolean(reason) && !canEditCompletedCase(user), reason };
}

/** 見積の案件 (受注になっていれば受注) が完了して変えられないか */
export function quoteCompletedLock(db: Database, user: User, q: Quote): { locked: boolean; reason: string } {
  const o = orderOfQuote(db, q);
  return o ? completedCaseLock(db, user, o) : { locked: false, reason: "" };
}

export function completedLockMessage(reason: string): string {
  return `${reason}のため、内容は変更できません。変更が必要なときは管理者に依頼してください (変更は変更履歴に残ります)。`;
}

/**
 * お客様の画面をほかの店舗の社員が閲覧のみで開いたとき: 進行中の案件 (とその予定・やりとり) だけを残す。
 * 入金が完了した過去の案件・売上の累計は、通常の権限 (その店舗) のまま
 */
export function openCaseTimeline<T extends { inquiries: Inquiry[]; quotes: Quote[]; orders: Order[]; invoices: Invoice[]; comms: { relatedType?: string; relatedId?: string; at: string }[]; events: { inquiryId?: string; quoteId?: string; orderId?: string }[]; lifetime: number }>(db: Database, t: T): T {
  const ix = index(db);
  const inquiries = t.inquiries.filter((i) => isOpenInquiry(db, i, ix));
  const quotes = t.quotes.filter((q) => isOpenQuote(db, q, ix));
  const orders = t.orders.filter((o) => isOpenOrder(db, o, ix));
  const invoices = t.invoices.filter((inv) => isOpenInvoice(db, inv, ix));
  const ids = new Set([...inquiries, ...quotes, ...orders, ...invoices].map((x) => x.id));
  const since = [...inquiries.map((i) => i.receivedAt), ...quotes.map((q) => q.createdAt), ...orders.map((o) => o.createdAt)].sort()[0];
  const comms = t.comms.filter((c) => (c.relatedId ? ids.has(c.relatedId) : Boolean(since) && c.at >= since!));
  const events = t.events.filter((e) => (e.inquiryId && ids.has(e.inquiryId)) || (e.quoteId && ids.has(e.quoteId)) || (e.orderId && ids.has(e.orderId)));
  return { ...t, inquiries, quotes, orders, invoices, comms, events, lifetime: 0 };
}
