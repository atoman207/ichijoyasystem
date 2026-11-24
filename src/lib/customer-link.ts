import type { Customer, Database, Inquiry, User } from "@/lib/db/types";
import { canEditCaseStore, canReadStoreRecords } from "@/lib/auth/permissions";
import { policyReader } from "@/lib/access-policy";
import { addAudit, nowIso } from "@/lib/db/store";
import { linkInquiryLogs } from "@/lib/ai-intake";

/**
 * 問い合わせ (受付) を紐付けられるお客様: 顧客の一覧で見られるお客様 (閲覧の範囲の設定。初期設定は全社員が全店舗) と、変更できる店舗のお客様。
 * 紐付けはお客様の記録を変えない (問い合わせの店舗・担当はそのまま) ため、ほかの店舗・本部で登録したお客様にも紐付けられる
 * (お客様のご要望 2026-11-24「顧客の二重登録を防ぐ」: 顧客検索で見つかるお客様が紐付けの候補に出なかった)
 */
export function canLinkToCustomer(db: Pick<Database, "settings">, user: User, c: Pick<Customer, "storeId">): boolean {
  return canEditCaseStore(user, c.storeId) || canReadStoreRecords(policyReader(db, user), c.storeId);
}

/**
 * 問い合わせ (案件) と既存の顧客のひも付け (お客様のご要望 2026-11-24「■3」「■5」「■6」)
 * ------------------------------------------------------------
 * - 問い合わせの画面・顧客の画面のどちらからでも、問い合わせを既存の顧客にひも付ける (付け替える)
 * - 付け替えると、その問い合わせの予定・資料・やりとりの記録も新しいお客様に移す (予定表で案件を開くと、ひも付けたお客様の情報が出る)
 * - 予定表の取込で仮に作った顧客 (タグ「予定表から登録」) から付け替えて、仮の顧客にほかの記録が何も残らなければ、仮の顧客を消す
 * - 見積を作った後の案件は、見積・受注にもお客様があるため、ここでは付け替えない (見積の画面で直す)
 */

export const PLACEHOLDER_TAG = "予定表から登録";

/** 予定表の取込で仮に作った顧客 (電話・住所なし) */
export function isPlaceholderCustomer(c: Pick<Customer, "tags"> | undefined): boolean {
  return Boolean(c?.tags?.includes(PLACEHOLDER_TAG));
}

/** この問い合わせのお客様を付け替えられないときの理由 (付け替えられるなら undefined) */
export function relinkBlocker(db: Pick<Database, "quotes">, inq: Pick<Inquiry, "quoteId">): string | undefined {
  if (inq.quoteId && db.quotes.some((q) => q.id === inq.quoteId)) return "見積を作成した案件のお客様は、ここでは変えられません (見積・受注にもお客様が入っています)。見積の画面で確かめてください。";
  return undefined;
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
export function moveInquiryToCustomer(db: Database, inq: Inquiry, to: Customer, userId: string): MoveResult {
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
  if (from && from.id !== to.id && isPlaceholderCustomer(from) && !customerReferenced(db, from.id)) {
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
