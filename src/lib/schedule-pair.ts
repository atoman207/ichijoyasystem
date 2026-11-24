import type { Database, Order, ScheduleEvent, ScheduleKind } from "@/lib/db/types";
import { caseValue, createCaseResolver } from "@/lib/db/schedule";
import { cleanHandovers, parseHandoverRef } from "@/lib/handover";
import { daysBetween } from "@/lib/format";

/**
 * 引取・現見 ⇄ 納品 の組 (お客様のご要望 2026-11-24「⑦ 引取・現見と納品予定の連動」)
 * ------------------------------------------------------------
 * 引取 (pickup)・現見 (onsite_quote = 現場見積) の案件は納品がセット。予定表で開いた予定の相手の予定を探す:
 *  1. 予定表の小さな画面で「納品予定を追加」した納品 (sourceRef = "pair:<引取・現見の予定 ID>")
 *  2. 受注の引取・納品の日程と連動する予定 (handover:<pickup|delivery>:<行 ID>)。同じ品目の行の相手
 *  3. 同じ案件 (問い合わせ → 見積 → 受注の連鎖。案件の一番進んだ段階で比べる) の納品 / 引取・現見
 *  4. 案件のない予定は、同じお客様の 60 日以内の予定
 * 納品は引取・現見の日以降の近い順、引取・現見は納品の日以前の近い順を先に並べる。データは変えない (純粋関数)
 */

export const PAIR_ORIGIN_KINDS: ScheduleKind[] = ["pickup", "onsite_quote"];
export const PAIR_PREFIX = "pair:";

/** この予定に相手 (納品 / 引取・現見) があるか */
export function pairRole(kind: ScheduleKind): "delivery" | "origin" | undefined {
  if (PAIR_ORIGIN_KINDS.includes(kind)) return "delivery";
  if (kind === "delivery") return "origin";
  return undefined;
}

export interface EventPairInfo {
  /** 探す相手: delivery = 納品 (引取・現見の予定) / origin = 引取・現見 (納品の予定) */
  want: "delivery" | "origin";
  events: ScheduleEvent[];
  /** 受注の引取の予定で、納品日が決まっていない品目の行 (納品予定の追加 = 受注の日程に納品日を入れる) */
  undatedRows: string[];
  /** 受注の日程と連動する引取の予定 (納品予定の追加は受注の日程に入れる) */
  order?: Order;
}

export function eventPair(db: Pick<Database, "schedule" | "orders" | "quotes" | "inquiries" | "customers">, e: ScheduleEvent, resolver = createCaseResolver(db as Database)): EventPairInfo | undefined {
  const want = pairRole(e.kind);
  if (!want) return undefined;
  const kinds: ScheduleKind[] = want === "delivery" ? ["delivery"] : PAIR_ORIGIN_KINDS;
  const others = db.schedule.filter((x) => x.id !== e.id && kinds.includes(x.kind));
  const picked = new Map<string, number>();
  const add = (x: ScheduleEvent, rank: number) => {
    if (!picked.has(x.id) || picked.get(x.id)! > rank) picked.set(x.id, rank);
  };

  // 1. 予定表から追加した納品 (明示の組)
  const pairOf = e.sourceRef?.startsWith(PAIR_PREFIX) ? e.sourceRef.slice(PAIR_PREFIX.length) : undefined;
  for (const x of others) if (x.sourceRef === `${PAIR_PREFIX}${e.id}` || (pairOf && x.id === pairOf)) add(x, 0);

  // 2. 受注の引取・納品の日程 (同じ品目の行)
  const hv = parseHandoverRef(e.sourceRef);
  const order = e.orderId ? db.orders.find((o) => o.id === e.orderId) : undefined;
  let undatedRows: string[] = [];
  if (hv && order && (hv.role === "pickup" || hv.role === "delivery")) {
    const otherRole = hv.role === "pickup" ? "delivery" : "pickup";
    for (const x of others) {
      const r = parseHandoverRef(x.sourceRef);
      if (x.orderId === order.id && r?.role === otherRole && r.rowIds.some((id) => hv.rowIds.includes(id))) add(x, 1);
    }
    if (hv.role === "pickup") {
      const rows = cleanHandovers(order.handovers ?? []).rows;
      undatedRows = rows.filter((r) => hv.rowIds.includes(r.id) && !r.deliveryDate).map((r) => r.id);
    }
  }

  // 3. 同じ案件 / 4. 案件のない予定は同じお客様
  const ref = resolver.ofEvent(e);
  const key = ref ? caseValue(ref) : undefined;
  for (const x of others) {
    if (key) {
      const r = resolver.ofEvent(x);
      if (r && caseValue(r) === key) add(x, 2);
    } else if (e.customerId && x.customerId === e.customerId && !resolver.ofEvent(x) && Math.abs(daysBetween(e.date, x.date)) <= 60) add(x, 3);
  }

  const near = (x: ScheduleEvent) => {
    const d = daysBetween(e.date, x.date);
    // 納品: 引取・現見の日以降を先に (近い順)。引取・現見: 納品の日以前を先に (近い順)
    const forward = want === "delivery" ? d >= 0 : d <= 0;
    return (forward ? 0 : 100000) + Math.abs(d);
  };
  const events = [...picked.entries()]
    .map(([id, rank]) => ({ x: others.find((o) => o.id === id)!, rank }))
    .sort((a, b) => a.rank - b.rank || near(a.x) - near(b.x))
    .map((p) => p.x)
    .slice(0, 4);
  return { want, events, undatedRows, order: hv?.role === "pickup" ? order : undefined };
}
