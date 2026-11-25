import type { Customer, Database, Inquiry, User } from "@/lib/db/types";
import { canEditCaseStore, canReadStoreRecords } from "@/lib/auth/permissions";
import { policyReader } from "@/lib/access-policy";
import { addAudit, newId, nowIso } from "@/lib/db/store";
import { customerHasPhone, phoneDigits } from "@/lib/customer-contacts";
import { linkInquiryLogs } from "@/lib/ai-intake";
import { caseChainOf, type CaseChain } from "@/lib/case-store";
import { invoiceCoversOrder, liveInvoicesOfOrder } from "@/lib/billing";

/**
 * 問い合わせ (受付) を紐付けられるお客様: 顧客の一覧で見られるお客様 (閲覧の範囲の設定。初期設定は全社員が全店舗) と、変更できる店舗のお客様。
 * 紐付けはお客様の記録を変えない (問い合わせの店舗・担当はそのまま) ため、ほかの店舗・本部で登録したお客様にも紐付けられる
 * (お客様のご要望 2026-11-24「顧客の二重登録を防ぐ」: 顧客検索で見つかるお客様が紐付けの候補に出なかった)
 */
/**
 * 問い合わせで聞いた電話番号が、紐付けたお客様の登録にないときは「ほかの電話番号」に足す (次からその番号でも検索・照合できる。
 * お客様のご要望 2026-11-24「② どの電話番号からでも紐付け」)。お客様を変更できる人 (canEditCaseStore) のときだけ・ほかのお客様の番号でないときだけ。足した番号を返す
 */
export function addInquiryPhone(db: Database, user: User, c: Customer, phone: string | undefined, note: string): string | undefined {
  const p = (phone ?? "").trim();
  const d = phoneDigits(p);
  if (d.length < 9 || customerHasPhone(c, d) || !canEditCaseStore(user, c.storeId)) return undefined;
  // ほかのお客様の番号なら足さない (付け替えのときの前のお客様の番号など。同じ番号のお客様が増えると照合で迷う)
  if (db.customers.some((x) => x.id !== c.id && customerHasPhone(x, d))) return undefined;
  const before = [...(c.contacts ?? [])];
  if (before.length >= 30) return undefined;
  c.contacts = [...before, { id: newId("cc"), relation: "問い合わせの電話", phone: p, note: note.slice(0, 100) }];
  addAudit(db, { userId: user.id, action: "update", entity: "customer", entityId: c.id, entityLabel: `${c.code} ${c.name}`, summary: `問い合わせで聞いた電話番号 ${p} を「ほかの電話番号」に追加`, storeId: c.storeId, changes: [{ field: "contacts", before, after: c.contacts }] });
  return p;
}

export function canLinkToCustomer(db: Pick<Database, "settings">, user: User, c: Pick<Customer, "storeId">): boolean {
  return canEditCaseStore(user, c.storeId) || canReadStoreRecords(policyReader(db, user), c.storeId);
}

/**
 * 問い合わせ (案件) と既存の顧客のひも付け (お客様のご要望 2026-11-24「■3」「■5」「■6」)
 * ------------------------------------------------------------
 * - 問い合わせの画面・顧客の画面のどちらからでも、問い合わせを既存の顧客にひも付ける (付け替える)
 * - 付け替えると、その問い合わせの予定・資料・やりとりの記録も新しいお客様に移す (予定表で案件を開くと、ひも付けたお客様の情報が出る)
 * - 予定表の取込で仮に作った顧客 (タグ「予定表から登録」) から付け替えて、仮の顧客にほかの記録が何も残らなければ、仮の顧客を消す
 * - 見積・受注のあとの案件は moveCaseToCustomer で見積・受注・予定もまとめて付け替える (請求書を発行した案件は付け替えない)
 */

export const PLACEHOLDER_TAG = "予定表から登録";

/** 予定表の取込で仮に作った顧客 (電話・住所なし) */
export function isPlaceholderCustomer(c: Pick<Customer, "tags"> | undefined): boolean {
  return Boolean(c?.tags?.includes(PLACEHOLDER_TAG));
}

/**
 * この問い合わせ (案件) のお客様を付け替えられないときの理由 (付け替えられるなら undefined)。
 * 見積・受注のあとの案件も、問い合わせ・見積・受注・予定などの情報をそのままにお客様だけを付け替えられる (お客様のご要望 2026-11-25「⑤ 紐付け間違いの修正」。
 * moveCaseToCustomer)。請求書を発行した案件は、請求書の宛名がずれるので付け替えない
 */
export function relinkBlocker(db: Pick<Database, "quotes" | "orders" | "inquiries" | "invoices">, inq: Pick<Inquiry, "id" | "quoteId">): string | undefined {
  const chain = caseChainOf(db, inq.id);
  return chain ? caseRelinkBlocker(db, chain) : undefined;
}

/** 案件のお客様を付け替えられないときの理由 */
export function caseRelinkBlocker(db: Pick<Database, "invoices">, c: CaseChain): string | undefined {
  const o = c.order;
  if (o?.status === "cancelled") return "キャンセルした受注のお客様は付け替えられません。";
  if (o && liveInvoicesOfOrder(db.invoices, o).length) return "請求書を発行済みの案件のため、お客様は付け替えられません (請求書の宛名とずれるため)。入金前であれば本部・管理者が請求書を無効にしてから付け替えてください。";
  return undefined;
}

/**
 * 案件 (問い合わせ → 見積 → 受注) を顧客 to に付け替える (mutate の中で呼ぶ)。問い合わせ・見積・受注・予定・資料・やりとり・アンケートの記録はそのままで、
 * お客様 (customerId) だけを変える。予定・資料は、お客様が空か前のお客様のものだけを移す (ほかのお客様を選んである予定は変えない)。
 * 変更履歴は記録ごとにここで残す。前のお客様が予定表の取込で作った仮の顧客で、記録が何も残らなければ消す
 */
export function moveCaseToCustomer(db: Database, c: CaseChain, to: Customer, userId: string): MoveResult & { records: number } {
  const fromId = c.order?.customerId ?? c.quote?.customerId ?? c.inquiry?.customerId;
  const from = fromId ? db.customers.find((x) => x.id === fromId) : undefined;
  const now = nowIso();
  const movable = (cid: string | undefined) => !cid || (fromId !== undefined && cid === fromId);
  let records = 0;
  let events = 0;
  const label = `${from ? `${from.code} ${from.name}` : "(なし)"} → ${to.code} ${to.name}`;
  if (c.inquiry && c.inquiry.customerId !== to.id) {
    const before = c.inquiry.customerId ?? null;
    const r = moveInquiryToCustomer(db, c.inquiry, to, userId, { keepPlaceholder: true });
    events += r.events;
    records++;
    addAudit(db, { userId, action: "update", entity: "inquiry", entityId: c.inquiry.id, entityLabel: c.inquiry.number, summary: `顧客を付け替え (${label})`, storeId: c.inquiry.storeId, changes: [{ field: "customerId", before, after: to.id }] });
  }
  for (const [entity, r] of [["quote", c.quote], ["order", c.order]] as const) {
    if (!r || r.customerId === to.id) continue;
    const before = r.customerId;
    r.customerId = to.id;
    r.updatedAt = now;
    records++;
    addAudit(db, { userId, action: "update", entity, entityId: r.id, entityLabel: r.number, summary: `顧客を付け替え (${label})`, storeId: r.storeId, changes: [{ field: "customerId", before, after: to.id }] });
  }
  const ids = new Set([c.quote?.id, c.order?.id].filter(Boolean) as string[]);
  for (const e of db.schedule) {
    if (!((c.order && e.orderId === c.order.id) || (c.quote && e.quoteId === c.quote.id)) || !movable(e.customerId) || e.customerId === to.id) continue;
    e.customerId = to.id;
    e.updatedAt = now;
    events++;
  }
  for (const a of db.attachments) if ((a.parentType === "quote" || a.parentType === "order") && ids.has(a.parentId) && movable(a.customerId)) a.customerId = to.id;
  for (const l of db.commLogs) if ((l.relatedType === "quote" || l.relatedType === "order") && l.relatedId && ids.has(l.relatedId) && fromId && l.customerId === fromId) l.customerId = to.id;
  if (c.order) for (const sv of db.surveys) if (sv.orderId === c.order.id && movable(sv.customerId)) sv.customerId = to.id;
  if (c.order) for (const inv of db.invoices) if (invoiceCoversOrder(inv, c.order.id) && inv.status === "void" && movable(inv.customerId)) inv.customerId = to.id;
  to.updatedAt = now;
  let removed: Customer | undefined;
  if (from && from.id !== to.id && isPlaceholderCustomer(from) && !customerReferenced(db, from.id)) {
    db.customers = db.customers.filter((x) => x.id !== from.id);
    removed = from;
    addAudit(db, { userId, action: "delete", entity: "customer", entityId: from.id, entityLabel: `${from.code} ${from.name}`, summary: `予定表の取込で仮に作った顧客を削除 (案件 ${c.head.number} を ${to.code} ${to.name} に付け替えたため。ほかの記録はありません)`, storeId: from.storeId });
  }
  return { from, events, removed, records };
}

/** 顧客 ID を持つ記録がどこかに残っているか (仮の顧客を消してよいかの確認。すべての表の customerId を見る) */
export function customerReferenced(db: Database, customerId: string): boolean {
  for (const [key, rows] of Object.entries(db)) {
    if (!Array.isArray(rows) || key === "customers" || key === "auditLogs") continue;
    for (const r of rows as unknown[]) {
      if (!r || typeof r !== "object") continue;
      const o = r as Record<string, unknown>;
      if (o.customerId === customerId) return true;
      // 地図の結び付け・承認などは記録の種類と ID で持つ
      if ((o.targetId === customerId || o.recordId === customerId || o.parentId === customerId) && (o.targetType === "customer" || o.recordType === "customer" || o.parentType === "customer" || o.type === "customer_change")) return true;
    }
  }
  return false;
}

export interface MoveResult {
  from?: Customer;
  events: number;
  /** 記録が何も残らなくなって消した仮の顧客 */
  removed?: Customer;
}

/**
 * 問い合わせを顧客 to にひも付ける (付け替える)。mutate の中で呼ぶ。変更履歴は呼び出し側が問い合わせに残す (仮の顧客を消したときはここで残す)
 * 予定は、お客様が空か前のお客様のものだけを移す (ほかのお客様を選んである予定は変えない)
 */
export function moveInquiryToCustomer(db: Database, inq: Inquiry, to: Customer, userId: string, opts: { keepPlaceholder?: boolean } = {}): MoveResult {
  const fromId = inq.customerId;
  const from = fromId ? db.customers.find((c) => c.id === fromId) : undefined;
  const now = nowIso();
  inq.customerId = to.id;
  inq.updatedAt = now;
  const movable = (cid: string | undefined) => !cid || (fromId !== undefined && cid === fromId);
  let events = 0;
  for (const e of db.schedule) {
    if (e.inquiryId !== inq.id || !movable(e.customerId)) continue;
    e.customerId = to.id;
    events++;
  }
  // 問い合わせに登録済みの資料・写真・やりとりの記録も顧客にまとめる (受付の会話の記録などはお客様の履歴に移す)
  for (const a of db.attachments) if (a.parentType === "inquiry" && a.parentId === inq.id && movable(a.customerId)) a.customerId = to.id;
  for (const c of db.commLogs) if (c.relatedType === "inquiry" && c.relatedId === inq.id && fromId && c.customerId === fromId) c.customerId = to.id;
  linkInquiryLogs(db, inq, to.id);
  to.updatedAt = now;
  let removed: Customer | undefined;
  if (!opts.keepPlaceholder && from && from.id !== to.id && isPlaceholderCustomer(from) && !customerReferenced(db, from.id)) {
    db.customers = db.customers.filter((c) => c.id !== from.id);
    removed = from;
    addAudit(db, {
      userId,
      action: "delete",
      entity: "customer",
      entityId: from.id,
      entityLabel: `${from.code} ${from.name}`,
      summary: `予定表の取込で仮に作った顧客を削除 (問い合わせ ${inq.number} を既存の顧客 ${to.code} ${to.name} にひも付けたため。ほかの記録はありません)`,
      storeId: from.storeId,
    });
  }
  return { from, events, removed };
}
