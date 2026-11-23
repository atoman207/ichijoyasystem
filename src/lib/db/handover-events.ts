import "server-only";
import type { Database, Order, ScheduleEvent, User } from "./types";
import { newId, nowIso } from "./store";
import { HANDOVER_MARK, handoverMemo } from "@/lib/site-info";
import { HANDOVER_REF_PREFIX, HANDOVER_ROLE_LABEL, handoverGroups, handoverRef, handoverSpan, parseHandoverRef, type HandoverGroup } from "@/lib/handover";
import { moveBookingsWithEvent } from "@/lib/scheduling/impact";
import { replanProductionForPickup } from "@/lib/scheduling/production";
import { planTablesReady } from "@/lib/scheduling/tables";

/**
 * 受注の品目ごとの引取・納品の日程 (Order.handovers) → 予定表の予定 (src/lib/handover.ts)
 * ------------------------------------------------------------
 * - 引き取り・納品は日付の日だけの予定 (間の日には出ない)。同じ日・同じ時間の品目は 1 件にまとめる。リフォームは施工期間の「施工」
 * - 予定は source = "order"・sourceRef = "handover:<役割>:<行の ID>+…"。作り直すときは同じ役割で品目の重なる予定を使い回す
 *   (予定の ID・担当者・手で書いたメモ・車両の予約・製造の予定のつながりを保つ)
 * - 以前の形 (施工期間の「施工」の予定 1 件) の予定は、日程を保存したときに置き換える
 * - 受注の scheduledStart / scheduledEnd は日程の最初の日・最後の日 (経営ダッシュボード・案件の状態・予定の提案が使う)
 */

export const isHandoverEvent = (e: Pick<ScheduleEvent, "source" | "sourceRef">): boolean => e.source === "order" && Boolean(e.sourceRef?.startsWith(HANDOVER_REF_PREFIX));

const KIND = { pickup: "pickup", delivery: "delivery", install: "install" } as const;

function titleOf(customerName: string | undefined, g: HandoverGroup): string {
  const who = customerName ? `${customerName} 様 ` : "";
  const what = g.labels.join("・");
  return g.role === "install" ? `${who}${what} 施工` : `${who}${HANDOVER_ROLE_LABEL[g.role]} (${what})`;
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
const timeKey = (e: Pick<ScheduleEvent, "date" | "endDate" | "startTime" | "endTime">) => `${e.date}|${e.endDate ?? ""}|${e.startTime ?? ""}|${e.endTime ?? ""}`;

/**
 * 日程から予定表の予定を作り直す。戻り値の moved は日時が変わった予定 (車両の予約・製造の予定の作り直しに使う)。
 * prevWorkers: 受注の担当を変えたときの前の担当 (前の担当のままの予定だけ新しい担当にする。予定ごとに変えた担当は残す)
 */
export function syncHandoverEvents(db: Database, o: Order, actorId: string, opts: { prevWorkers?: string[] } = {}): { moved: ScheduleEvent[] } {
  const mine = db.schedule.filter((e) => e.orderId === o.id && e.source === "order");
  const moved: ScheduleEvent[] = [];
  if (o.status === "cancelled") return { moved };
  const groups = handoverGroups(o.handovers);
  const legacy = mine.filter((e) => !isHandoverEvent(e));
  const existing = mine.filter(isHandoverEvent);
  const used = new Set<string>();
  const quote = db.quotes.find((q) => q.id === o.quoteId);
  const customer = db.customers.find((c) => c.id === o.customerId);
  const memo = handoverMemo(o.siteInfo, o.workDetails);
  const location = o.siteAddress || customer?.address || undefined;
  const now = nowIso();

  for (const g of groups) {
    const cand =
      existing
        .filter((e) => !used.has(e.id))
        .map((e) => ({ e, ref: parseHandoverRef(e.sourceRef) }))
        .filter((x) => x.ref?.role === g.role)
        .map((x) => ({ e: x.e, overlap: x.ref!.rowIds.filter((id) => g.rowIds.includes(id)).length }))
        .filter((x) => x.overlap > 0)
        .sort((a, b) => b.overlap - a.overlap)[0]?.e ?? legacy.find((e) => !used.has(e.id));
    const fields = {
      title: titleOf(customer?.name, g),
      kind: KIND[g.role],
      date: g.date,
      endDate: g.endDate,
      startTime: g.start,
      endTime: g.start ? g.end : undefined,
      slot: undefined,
      storeId: o.storeId,
      customerId: o.customerId,
      orderId: o.id,
      quoteId: o.quoteId,
      inquiryId: quote?.inquiryId,
      location,
      source: "order" as const,
      sourceRef: handoverRef(g),
    };
    if (cand) {
      used.add(cand.id);
      const before = JSON.stringify(cand);
      const beforeTime = timeKey(cand);
      if (!cand.assigneeIds.length || (opts.prevWorkers && sameSet(cand.assigneeIds, opts.prevWorkers))) cand.assigneeIds = [...o.workerIds];
      Object.assign(cand, fields);
      if (!cand.memo || cand.memo.startsWith(HANDOVER_MARK)) cand.memo = memo;
      if (JSON.stringify(cand) !== before) {
        cand.updatedBy = actorId;
        cand.updatedAt = now;
      }
      if (timeKey(cand) !== beforeTime) moved.push(cand);
      continue;
    }
    const ev: ScheduleEvent = { id: newId("ev"), ...fields, assigneeIds: [...o.workerIds], memo, createdBy: actorId, createdAt: now, updatedBy: actorId, updatedAt: now };
    db.schedule.push(ev);
    used.add(ev.id);
  }
  // 使わなくなった予定 (品目の削除・まとめ方の変更) と、置き換えた以前の「施工」の予定を外す
  const drop = new Set(mine.filter((e) => !used.has(e.id)).map((e) => e.id));
  if (drop.size) db.schedule = db.schedule.filter((e) => !drop.has(e.id));

  const span = handoverSpan(o.handovers);
  o.scheduledStart = span.start;
  o.scheduledEnd = span.start ? span.end : undefined;
  if (o.status === "confirmed" && span.start) o.status = "scheduled";
  if (o.status === "scheduled" && !span.start) o.status = "confirmed";
  return { moved };
}

/** 日時が変わった予定の後続 (車両・設備の予約を移す・引き取りが動いたら製造の予定を作り直す)。戻り値は注意の文 */
export function followMovedEvents(db: Database, user: User | undefined, moved: ScheduleEvent[]): string[] {
  if (!moved.length || !planTablesReady()) return [];
  const out: string[] = [];
  let bookings = 0;
  for (const ev of moved) {
    bookings += moveBookingsWithEvent(db, ev);
    if (ev.kind === "pickup" && user) out.push(...replanProductionForPickup(db, user, ev));
  }
  if (bookings) out.unshift("車両・設備の予約も移しました。");
  return out;
}
