import "server-only";
import type { Database, Order, ScheduleEvent, User } from "./types";
import { addAudit, newId, nowIso } from "./store";
import { HANDOVER_MARK, handoverMemo } from "@/lib/site-info";
import { HANDOVER_REF_PREFIX, HANDOVER_ROLE_LABEL, handoverGroups, handoverRef, handoverSpan, parseHandoverRef, type HandoverGroup } from "@/lib/handover";
import { moveBookingsWithEvent } from "@/lib/scheduling/impact";
import { replanProductionForPickup } from "@/lib/scheduling/production";
import { planTablesReady } from "@/lib/scheduling/tables";
import { toDateKey } from "@/lib/format";
import { ADOPTED_KIND, adoptionAudit, isAdoptedVisit, restoreVisit, sameDayVisit } from "@/lib/visit-adopt";
import { buildCaseMap, caseIdOfEvent } from "@/lib/case-group";

/**
 * 受注の品目ごとの引取・納品の日程 (Order.handovers) → 予定表の予定 (src/lib/handover.ts)
 * ------------------------------------------------------------
 * - 引き取り・納品は日付の日だけの予定 (間の日には出ない)。同じ日・同じ時間の品目は 1 件にまとめる。リフォームは施工期間の「施工」
 * - 予定は source = "order"・sourceRef = "handover:<役割>:<行の ID>+…"。作り直すときは同じ役割で品目の重なる予定を使い回す
 *   (予定の ID・担当者・手で書いたメモ・車両の予約・製造の予定のつながりを保つ)
 * - 以前の形 (施工期間の「施工」の予定 1 件) の予定は、日程を保存したときに置き換える
 * - 同じ案件 (この受注・見積・問い合わせ・案件に追加した記録。src/lib/case-group.ts) の今日以降の引き取り・納品の予定 (予定表から移行した予定・
 *   予定表や問い合わせから手で登録した予定・引取から足した納品。ほかの受注の予定は除く) は、新しく作る代わりに使い回す
 *   (どの画面から受注を登録しても同じ予定を二重にしない。お客様のご要望 2026-11-26「二重登録の防止」)。
 *   受注の登録の画面で「登録済みの予定はそのまま残して新しく追加する」を選んだときだけ使い回さない (opts.noAdopt)
 * - 作業 (引き取り・1 日の施工) の日に同じ案件の訪問 (見積・現調・現見) の予定があれば、新しい予定を足さずにその予定を「現見」に切り替える
 *   (見積の訪問がその場で現見になったとき。src/lib/visit-adopt.ts)。作業を別の日に動かす・使わなくなったときは訪問の予定に戻す (消さない)
 * - 受注の scheduledStart / scheduledEnd は日程の最初の日・最後の日 (経営ダッシュボード・案件の状態・予定の提案が使う)
 */

export const isHandoverEvent = (e: Pick<ScheduleEvent, "source" | "sourceRef">): boolean => e.source === "order" && Boolean(e.sourceRef?.startsWith(HANDOVER_REF_PREFIX));

const KIND = { pickup: "pickup", delivery: "delivery", install: "install" } as const;

function titleOf(customerName: string | undefined, g: HandoverGroup, visit = false): string {
  const who = customerName ? `${customerName} 様 ` : "";
  const what = g.labels.join("・");
  if (visit) return `${who}現見 (${what})`;
  return g.role === "install" ? `${who}${what} 施工` : `${who}${HANDOVER_ROLE_LABEL[g.role]} (${what})`;
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
const timeKey = (e: Pick<ScheduleEvent, "date" | "endDate" | "startTime" | "endTime" | "slot">) => `${e.date}|${e.endDate ?? ""}|${e.startTime ?? ""}|${e.endTime ?? ""}|${e.slot ?? ""}`;

/**
 * 日程から予定表の予定を作り直す。戻り値の moved は日時が変わった予定 (車両の予約・製造の予定の作り直しに使う)。
 * prevWorkers: 受注の担当を変えたときの前の担当 (前の担当のままの予定だけ新しい担当にする。予定ごとに変えた担当は残す)
 */
export function syncHandoverEvents(db: Database, o: Order, actorId: string, opts: { prevWorkers?: string[]; noAdopt?: boolean } = {}): { moved: ScheduleEvent[] } {
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
  const today = toDateKey(new Date());
  const inquiryId = quote?.inquiryId;
  // 同じ案件の受注の予定でない引き取り・納品の予定 (予定表から移行・手で登録・引取から足した納品 "pair:…") は使い回す
  const map = opts.noAdopt ? undefined : buildCaseMap(db);
  const myCase = map?.caseOf(o.id);
  const adoptable = opts.noAdopt
    ? []
    : db.schedule.filter(
        (e) =>
          e.source !== "order" &&
          e.date >= today &&
          (e.kind === "pickup" || e.kind === "delivery") &&
          (!e.orderId || e.orderId === o.id) &&
          (e.orderId === o.id || (o.quoteId && e.quoteId === o.quoteId) || (inquiryId && e.inquiryId === inquiryId) || Boolean(myCase && caseIdOfEvent(map!, e) === myCase)),
      );

  const keys = { orderId: o.id, quoteId: o.quoteId, inquiryId, customerId: o.customerId };
  // 切り替えた訪問の予定で、作業が別の日に動いたもの (訪問の予定に戻す)
  const restore: ScheduleEvent[] = [];
  for (const g of groups) {
    let cand: ScheduleEvent | undefined =
      existing
        .filter((e) => !used.has(e.id))
        .map((e) => ({ e, ref: parseHandoverRef(e.sourceRef) }))
        .filter((x) => x.ref?.role === g.role)
        .map((x) => ({ e: x.e, overlap: x.ref!.rowIds.filter((id) => g.rowIds.includes(id)).length }))
        .filter((x) => x.overlap > 0)
        .sort((a, b) => b.overlap - a.overlap)[0]?.e ??
      legacy.find((e) => !used.has(e.id)) ??
      // 予定表から移行した同じ案件の予定 (同じ日 → 近い日)
      (g.role === "install"
        ? undefined
        : adoptable
            .filter((e) => !used.has(e.id) && e.kind === g.role)
            .sort((a, b) => Number(b.date === g.date) - Number(a.date === g.date) || Math.abs(Date.parse(a.date) - Date.parse(g.date)) - Math.abs(Date.parse(b.date) - Date.parse(g.date)))[0]);
    if (cand && isAdoptedVisit(cand) && cand.date !== g.date) {
      // 訪問から切り替えた予定の作業が別の日に動いた: その日の訪問の記録は残し、作業の予定は新しく作る
      used.add(cand.id);
      restore.push(cand);
      cand = undefined;
    }
    // 作業の日に同じ案件の訪問 (見積・現調・現見) があれば、その予定を切り替える (新しい予定を足さない)
    const canVisit = g.role === "pickup" || (g.role === "install" && !g.endDate);
    let adopting = false;
    let beforeKind: ScheduleEvent["kind"] | undefined;
    if (!cand && canVisit && !opts.noAdopt) {
      cand = sameDayVisit(db, keys, g.date, used);
      adopting = Boolean(cand);
      beforeKind = cand?.kind;
    }
    // 種類は「現見」のまま (訪問から切り替えた予定が同じ日のあいだ)
    const visit = canVisit && Boolean(cand) && cand!.date === g.date && (adopting || isAdoptedVisit(cand!));
    // 日程に時間を入れていなければ、訪問の予定の時間を残す (受注の日程にも書いて、次の保存で消えないように)
    if (adopting && cand && !g.start && !g.slot && (cand.startTime || cand.slot)) {
      g.start = cand.startTime;
      g.end = cand.startTime ? cand.endTime : undefined;
      g.slot = cand.startTime ? undefined : cand.slot;
      for (const r of o.handovers ?? []) {
        if (!g.rowIds.includes(r.id)) continue;
        r.pickupStart = g.start;
        r.pickupEnd = g.end;
        r.pickupSlot = g.slot;
      }
    }
    const fields = {
      title: titleOf(customer?.name, g, visit),
      kind: visit ? ADOPTED_KIND : KIND[g.role],
      date: g.date,
      endDate: g.endDate,
      startTime: g.start,
      endTime: g.start ? g.end : undefined,
      // 時刻のない午前・午後 (受注の画面の「AM」「PM」)
      slot: g.start ? undefined : g.slot,
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
      if (adopting && beforeKind) addAudit(db, adoptionAudit(cand, beforeKind, o, actorId));
      continue;
    }
    const ev: ScheduleEvent = { id: newId("ev"), ...fields, assigneeIds: [...o.workerIds], memo, createdBy: actorId, createdAt: now, updatedBy: actorId, updatedAt: now };
    db.schedule.push(ev);
    used.add(ev.id);
  }
  // 使わなくなった予定 (品目の削除・まとめ方の変更) と、置き換えた以前の「施工」の予定を外す。訪問から切り替えた予定は訪問の予定に戻す
  for (const e of mine) if (!used.has(e.id) && isAdoptedVisit(e)) restore.push(e);
  for (const e of restore) {
    restoreVisit(e, actorId, now);
    e.kind = "survey";
  }
  const drop = new Set(mine.filter((e) => !used.has(e.id) && !isAdoptedVisit(e) && !restore.includes(e)).map((e) => e.id));
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
