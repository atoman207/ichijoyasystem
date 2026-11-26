import type { CommLog, Customer, Database, Quote } from "@/lib/db/types";
import type { CaseMap } from "@/lib/case-group";

/**
 * TEL待ち (お客様のご要望 2026-11-26「■6」: 見積を提出してお客様からの連絡を待っている状態。これまではスプレッドシートで管理)
 * ------------------------------------------------------------
 * TEL待ちの見積 = 受注・失注 (却下・期限切れ) になっていない見積のうち、お客様に提出した (状態 = 提出済み) か手書きの見積書をお渡しした (handedOver) もの。
 * 同じ案件に、その見積より後に受注がある見積は「受注にならなかった別の案 (履歴)」として除く (case-group.ts の summarizeCase と同じ)。
 * import は型だけ (画面・テストで共通)
 */

export const TEL_AGE_FILTERS = [
  { days: 7, label: "7 日以上" },
  { days: 14, label: "14 日以上" },
  { days: 30, label: "30 日以上" },
] as const;

export interface TelWaitRow {
  quote: Quote;
  customer?: Customer;
  caseId: string;
  caseNumber: string;
  /** お渡し・提出した日 */
  since: string;
  /** 今日まで何日 */
  days: number;
  /** 同じ案件の、ほかの TEL待ちの見積の数 */
  siblings: number;
  lastLog?: Pick<CommLog, "at" | "body">;
  /** 次の連絡 (問い合わせの次のアクションの期日・日程未定の次回の連絡予定日) */
  next?: { date: string; text?: string };
}

const dayDiff = (from: string, to: string) => Math.max(0, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from.slice(0, 10)}T00:00:00Z`)) / 86_400_000));

/** TEL待ちの見積か (受注になった見積・失注・提出していない見積は false) */
export function isTelWaitQuote(q: Quote, orderedQuoteIds: ReadonlySet<string>): boolean {
  if (q.orderId || orderedQuoteIds.has(q.id)) return false;
  if (q.status === "rejected" || q.status === "expired" || q.status === "accepted" || q.status === "pending_approval") return false;
  return q.status === "sent" || Boolean(q.handedOver);
}

export function telWaitRows(db: Pick<Database, "quotes" | "orders" | "inquiries" | "customers" | "commLogs">, map: CaseMap, today: string): TelWaitRow[] {
  const ordered = new Set(db.orders.map((o) => o.quoteId).filter((x): x is string => Boolean(x)));
  const customers = new Map(db.customers.map((c) => [c.id, c]));
  const candidates = db.quotes.filter((q) => isTelWaitQuote(q, ordered));
  const byCase = new Map<string, Quote[]>();
  const rows: TelWaitRow[] = [];
  for (const q of candidates) {
    const caseId = map.caseOf(q.id) ?? q.id;
    const m = map.members(caseId);
    // 受注より前の見積は、受注にならなかった別の案 (履歴)
    if (m?.orders.some((o) => o.status !== "cancelled" && o.createdAt >= q.createdAt)) continue;
    byCase.set(caseId, [...(byCase.get(caseId) ?? []), q]);
    const ids = new Set([...(m?.inquiries ?? []).map((i) => i.id), ...(m?.quotes ?? []).map((x) => x.id), ...(m?.orders ?? []).map((o) => o.id)]);
    const lastLog = db.commLogs.filter((c) => c.relatedId && ids.has(c.relatedId)).sort((a, b) => b.at.localeCompare(a.at))[0];
    const inq = [...(m?.inquiries ?? [])].reverse().find((i) => i.scheduleHold?.nextContact || i.nextActionDue);
    const next = inq?.scheduleHold?.nextContact ? { date: inq.scheduleHold.nextContact, text: "連絡予定" } : inq?.nextActionDue ? { date: inq.nextActionDue, text: inq.nextAction } : undefined;
    const first = m ? (m.kind === "order" ? m.orders.find((o) => o.id === caseId) : m.kind === "quote" ? m.quotes.find((x) => x.id === caseId) : m.inquiries.find((i) => i.id === caseId)) : undefined;
    const since = (q.issuedAt ?? q.updatedAt ?? q.createdAt).slice(0, 10);
    rows.push({ quote: q, customer: customers.get(q.customerId), caseId, caseNumber: first?.number ?? q.number, since, days: dayDiff(since, today), siblings: 0, lastLog: lastLog ? { at: lastLog.at, body: lastLog.body } : undefined, next });
  }
  for (const r of rows) r.siblings = (byCase.get(r.caseId)?.length ?? 1) - 1;
  return rows.sort((a, b) => a.since.localeCompare(b.since) || a.quote.number.localeCompare(b.quote.number));
}
