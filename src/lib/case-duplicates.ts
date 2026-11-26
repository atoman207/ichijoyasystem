import type { Database, ScheduleEvent, ScheduleKind } from "@/lib/db/types";
import { buildCaseMap } from "@/lib/case-group";

/**
 * 同じ案件・同じ日の予定の二重登録を防ぐ (お客様のご連絡 2026-11-26「問い合わせから顧客・日程を登録すると予定表に二重に表示される」)
 * ------------------------------------------------------------
 * 担当者の重複の確かめ (findConflicts) は同じ案件の予定を重複とみなさない (引取と納品が同じ日など)。そのため、問合せ登録のメモから自動で入った予定に、
 * 問い合わせの画面からもう一度同じ日の予定を足すと、予定表に二重に出ていた。
 * ここでは、登録しようとしている予定と 同じ案件 (問い合わせ ⇄ 見積 ⇄ 受注、案件のつながっていないそのお客様の予定) ・同じ日・同じ種類のまとまり
 * (見積・現調・現見・採寸・顧客訪問は 1 つのまとまり、ほかは同じ種類) の予定を探す。見つかったら、登録の画面で
 * 「既存の予定をこの内容に直す」か「別の予定として追加する」を選ばせる (サーバーでも選ぶまで登録しない)。案件は case-group.ts (ほかの案件に追加した問い合わせ・見積も同じ案件)
 */

export const VISIT_GROUP: readonly ScheduleKind[] = ["survey", "site_survey", "onsite_quote", "measure", "visit"];
const groupOf = (k: ScheduleKind) => (VISIT_GROUP.includes(k) ? "visit" : k);

export interface DuplicateCandidate {
  date: string;
  kind: ScheduleKind;
  inquiryId?: string;
  quoteId?: string;
  orderId?: string;
  customerId?: string;
}

/** 案件の記録の ID (問い合わせ ⇄ 見積 ⇄ 受注 + ほかの案件に追加した問い合わせ・見積。src/lib/case-group.ts) */
function chainIds(db: Pick<Database, "quotes" | "orders" | "inquiries">, c: DuplicateCandidate): Set<string> {
  const ids = new Set<string>([c.inquiryId, c.quoteId, c.orderId].filter((x): x is string => Boolean(x)));
  const map = buildCaseMap({ inquiries: db.inquiries ?? [], quotes: db.quotes, orders: db.orders });
  const caseId = map.caseOf(c.orderId ?? c.quoteId ?? c.inquiryId);
  const m = caseId ? map.members(caseId) : undefined;
  if (m) for (const r of [...m.inquiries, ...m.quotes, ...m.orders]) ids.add(r.id);
  return ids;
}

/** 同じ案件・同じ日・同じ種類のまとまりの予定 (excludeId = 変更中の予定) */
export function sameCaseSameDay(db: Pick<Database, "schedule" | "quotes" | "orders" | "inquiries">, c: DuplicateCandidate, excludeId?: string): ScheduleEvent[] {
  const ids = chainIds(db, c);
  if (!ids.size && !c.customerId) return [];
  const group = groupOf(c.kind);
  return db.schedule.filter((e) => {
    if (e.id === excludeId || e.id.startsWith("hold:")) return false;
    if (!(e.date === c.date || (e.endDate && e.date <= c.date && c.date <= e.endDate))) return false;
    if (groupOf(e.kind) !== group) return false;
    const linked = Boolean(e.inquiryId || e.quoteId || e.orderId);
    if (linked) return Boolean((e.inquiryId && ids.has(e.inquiryId)) || (e.quoteId && ids.has(e.quoteId)) || (e.orderId && ids.has(e.orderId)));
    return Boolean(c.customerId && e.customerId === c.customerId);
  });
}

/** フォームの「caseDuplicate」(replace:<予定の ID> / add) を読む */
export function parseDuplicateChoice(v: string): { mode: "replace"; id: string } | { mode: "add" } | undefined {
  if (v === "add") return { mode: "add" };
  const m = v.match(/^replace:([A-Za-z0-9_:-]+)$/);
  return m ? { mode: "replace", id: m[1] } : undefined;
}
