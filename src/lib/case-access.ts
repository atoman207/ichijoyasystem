import type { Customer, Database, Inquiry, Invoice, Order, Quote, User } from "@/lib/db/types";
import { canAccessStore, canEditCompletedCase, canViewOpenCases } from "@/lib/auth/permissions";
import { caseIndex, inquiryCase, orderCase, quoteCase, type CaseIndex, type CaseRow } from "@/lib/case-status";
import { toDateKey } from "@/lib/format";

/**
 * 案件の閲覧の範囲と、完了した案件の変更の制限
 * ------------------------------------------------------------
 * 1. 進行中の案件 (問い合わせ → 見積 → 受注・施工 → 請求 → 入金完了 まで) は、全社員がほかの店舗の案件も閲覧できる
 *    (お客様が別の店舗に電話したときなどに、どの店舗でも状況を確かめられるように。お客様のご要望)。
 *    入金が完了した・全処理完了にした・失注・キャンセルした案件は、通常の権限 (自店舗。全店舗ロールは全店舗) に戻る。
 *    ほかの店舗の案件は「閲覧のみ」: 登録・変更・削除は従来どおりその店舗の社員 (サーバーの操作は assertStore で断る)。
 *    進行中かどうかは「案件の進捗」(src/lib/case-status.ts) と同じ判定: 失注・キャンセル・全処理完了・移行データの完了ではなく、入金が済んでいない
 * 2. 入金が完了した案件・全処理完了の案件は、内容 (案件情報・契約内容・現場の情報・状態・見積) を変更できない。変更できるのは管理者だけ
 *    (canEditCompletedCase。変更は変更履歴に残る)。進捗・やりとりの記録・写真の追加は続けられる
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
  const o = db.orders.find((x) => x.id === inv.orderId);
  return Boolean(o && inv.status !== "void" && isOpenOrder(db, o, ix));
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

/**
 * 記録を見られるか・変えられるか
 * - edit: 記録の店舗を扱える (従来の権限)
 * - view: ほかの店舗の進行中の案件 (閲覧のみ)
 * - none: 見られない
 */
export function recordAccess(user: User, storeId: Parameters<typeof canAccessStore>[1], isOpen: () => boolean): RecordAccess {
  if (canAccessStore(user, storeId)) return "edit";
  return canViewOpenCases(user) && isOpen() ? "view" : "none";
}

export const orderAccess = (db: Database, user: User, o: Order) => recordAccess(user, o.storeId, () => isOpenOrder(db, o));
export const quoteAccess = (db: Database, user: User, q: Quote) => recordAccess(user, q.storeId, () => isOpenQuote(db, q));
export const inquiryAccess = (db: Database, user: User, i: Inquiry) => recordAccess(user, i.storeId, () => isOpenInquiry(db, i));
export const invoiceAccess = (db: Database, user: User, inv: Invoice) => recordAccess(user, inv.storeId, () => isOpenInvoice(db, inv));
export const customerAccess = (db: Database, user: User, c: Customer) => recordAccess(user, c.storeId, () => hasOpenCase(db, c));

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
