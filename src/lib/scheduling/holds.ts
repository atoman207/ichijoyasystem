import "server-only";
import type { Database, ResourceBooking, ScheduleEvent, ScheduleHold, ScheduleKind, StoreId, User } from "@/lib/db/types";
import { newId, nowIso } from "@/lib/db/store";
import { SCHEDULE_KIND } from "@/lib/constants";
import { findConflicts, periodLabel, shortDate } from "@/lib/calendar";
import { loadMasters } from "./masters";
import { buildProductionJob } from "./production";
import type { Candidate } from "./engine";

/**
 * 仮押さえ (候補日を押さえて、担当者・お客様の確認のあとで予定にする)
 * ------------------------------------------------------------
 * - 候補 (第 1〜3 候補) を同じ groupId で押さえる。押さえている間は、ほかの提案でその担当者・車両・店舗の枠を使わない (context.ts)
 * - 担当者は「行ける / 行けない」を返す (acks)。お客様には候補を案内できる (offeredAt)。お客様の選んだ候補は customerChoiceAt
 * - 確定: 予定 (schedule) を作り、車両の予約を予定に付け替え、引き取りなら製造の予定を作り、同じ group のほかの候補は解除
 * - 期限 (expiresAt。既定 3 日) を過ぎた仮押さえは自動で解除 (expireHolds。画面を開いたとき・定期処理)
 * 予定の登録と同じく、確定の前に担当者の予定の重なりを確かめる
 */

export interface HoldBase {
  storeId: StoreId;
  kind: ScheduleKind;
  title: string;
  customerId?: string;
  inquiryId?: string;
  quoteId?: string;
  orderId?: string;
  location?: string;
  memo?: string;
  chainId?: string;
  minutes?: number;
}

export function createHolds(db: Database, user: User, base: HoldBase, candidates: Candidate[], now = new Date()): ScheduleHold[] {
  const rules = loadMasters(db).rules;
  const groupId = newId("hg");
  const t = nowIso();
  const expiresAt = new Date(now.getTime() + rules.holdDays * 86_400_000).toISOString();
  const holds = candidates.slice(0, 3).map(
    (c, i): ScheduleHold => ({
      id: newId("hold"),
      groupId,
      rank: i + 1,
      storeId: base.storeId,
      kind: base.kind,
      title: base.title,
      date: c.date,
      endDate: c.endDate,
      startTime: c.startTime,
      endTime: c.endTime,
      slot: !c.startTime && (c.slot === "am" || c.slot === "pm") ? c.slot : undefined,
      assigneeIds: c.assigneeIds,
      resourceIds: c.resourceIds ?? [],
      customerId: base.customerId,
      inquiryId: base.inquiryId,
      quoteId: base.quoteId,
      orderId: base.orderId,
      location: base.location,
      memo: base.memo,
      chainId: base.chainId,
      score: c.score,
      reasons: c.reasons.slice(0, 8),
      warnings: c.warnings.slice(0, 8),
      status: "held",
      expiresAt,
      acks: [],
      createdBy: user.id,
      createdAt: t,
      updatedBy: user.id,
      updatedAt: t,
    }),
  );
  db.scheduleHolds.push(...holds);
  return holds;
}

/** 期限を過ぎた仮押さえを解除する。解除した件数 */
export function expireHolds(db: Database, now = new Date()): number {
  const iso = now.toISOString();
  let n = 0;
  for (const h of db.scheduleHolds ?? []) {
    if (h.status === "held" && h.expiresAt <= iso) {
      h.status = "expired";
      h.updatedAt = iso;
      n++;
    }
  }
  return n;
}

export function releaseHold(db: Database, user: User, id: string, scope: "one" | "group" = "group"): ScheduleHold[] {
  const h = db.scheduleHolds.find((x) => x.id === id);
  if (!h) return [];
  const targets = db.scheduleHolds.filter((x) => x.status === "held" && (scope === "group" ? x.groupId === h.groupId : x.id === id));
  const t = nowIso();
  for (const x of targets) {
    x.status = "released";
    x.updatedBy = user.id;
    x.updatedAt = t;
  }
  return targets;
}

export function ackHold(db: Database, user: User, id: string, ok: boolean, note?: string): ScheduleHold | undefined {
  const h = db.scheduleHolds.find((x) => x.id === id);
  if (!h || h.status !== "held") return undefined;
  h.acks = [...(h.acks ?? []).filter((a) => a.userId !== user.id), { userId: user.id, ok, note: note?.slice(0, 200), at: nowIso() }];
  h.updatedAt = nowIso();
  return h;
}

/** 確定する前の確かめ: 担当者の予定と重ならないか (仮押さえのあとで入った予定) */
export function holdConflicts(db: Database, h: ScheduleHold): string[] {
  const hits = findConflicts({ date: h.date, endDate: h.endDate, startTime: h.startTime, endTime: h.endTime, slot: h.slot, assigneeIds: h.assigneeIds, orderId: h.orderId, quoteId: h.quoteId, inquiryId: h.inquiryId }, db.schedule);
  return hits.map((x) => `${x.event.title} (${periodLabel(x.event)})`);
}

export interface ConfirmResult {
  event: ScheduleEvent;
  released: ScheduleHold[];
  bookings: ResourceBooking[];
  productionJobId?: string;
  notes: string[];
}

/** 仮押さえを予定にする (db は mutate の中のもの) */
export function confirmHold(db: Database, user: User, id: string, now = new Date()): ConfirmResult | string {
  const h = db.scheduleHolds.find((x) => x.id === id);
  if (!h) return "仮押さえが見つかりません。";
  if (h.status !== "held") return h.status === "confirmed" ? "この仮押さえは確定済みです。" : "この仮押さえは解除されています。もう一度候補日を探してください。";
  if (h.expiresAt <= now.toISOString()) {
    h.status = "expired";
    return "仮押さえの期限が過ぎています。もう一度候補日を探してください。";
  }
  const t = nowIso();
  const order = h.orderId ? db.orders.find((o) => o.id === h.orderId) : undefined;
  const quote = h.quoteId ? db.quotes.find((q) => q.id === h.quoteId) : order?.quoteId ? db.quotes.find((q) => q.id === order.quoteId) : undefined;
  const ev: ScheduleEvent = {
    id: newId("ev"),
    title: h.title,
    kind: h.kind,
    date: h.date,
    endDate: h.endDate,
    startTime: h.startTime,
    endTime: h.endTime,
    slot: h.startTime ? undefined : h.slot,
    storeId: h.storeId,
    assigneeIds: h.assigneeIds,
    customerId: h.customerId,
    inquiryId: h.inquiryId ?? quote?.inquiryId,
    quoteId: h.quoteId ?? order?.quoteId,
    orderId: h.orderId,
    source: "manual",
    location: h.location,
    memo: [h.memo, `仮押さえ (第 ${h.rank} 候補・${h.score ?? "-"} 点) から確定`].filter(Boolean).join("\n"),
    createdBy: user.id,
    createdAt: t,
    updatedBy: user.id,
    updatedAt: t,
  };
  db.schedule.push(ev);
  h.status = "confirmed";
  h.eventId = ev.id;
  h.updatedBy = user.id;
  h.updatedAt = t;
  const released = db.scheduleHolds.filter((x) => x.groupId === h.groupId && x.id !== h.id && x.status === "held");
  for (const x of released) {
    x.status = "released";
    x.updatedBy = user.id;
    x.updatedAt = t;
  }
  const bookings: ResourceBooking[] = h.resourceIds.map((rid) => ({ id: newId("rb"), resourceId: rid, storeId: h.storeId, date: h.date, endDate: h.endDate, startTime: h.startTime, endTime: h.endTime, slot: h.startTime ? undefined : h.slot, eventId: ev.id, createdBy: user.id, createdAt: t }));
  db.resourceBookings.push(...bookings);
  const notes: string[] = [];
  const pj = buildProductionJob(db, user, { event: ev }, now);
  if (pj) {
    db.productionJobs.push(pj);
    notes.push(`製造の予定を作りました (${shortDate(pj.startDate)}〜${shortDate(pj.endDate)} に製造)。`);
    if (pj.materialCheck && !pj.materialCheck.ok) notes.push(`材料の在庫が足りません: ${pj.materialCheck.lines.filter((l) => l.stock < l.need).map((l) => `${l.name} ${l.need}${l.unit ?? ""} (在庫 ${l.stock})`).join("・")}`);
  }
  if (order) {
    order.progressNotes.push({ id: newId("pn"), at: t, userId: user.id, kind: "note", body: `予定を登録 (仮押さえから確定): ${periodLabel(ev)} ${SCHEDULE_KIND[ev.kind].label}` });
    order.updatedAt = t;
  }
  return { event: ev, released, bookings, productionJobId: pj?.id, notes };
}

/** お客様への候補の案内の文 (メール・LINE。お客様の名前・候補の日時・連絡先) */
export function offerText(db: Database, holds: ScheduleHold[], opts: { link?: string } = {}): { subject: string; body: string } {
  const h0 = holds[0];
  const customer = h0.customerId ? db.customers.find((c) => c.id === h0.customerId) : undefined;
  const store = db.stores.find((s) => s.id === h0.storeId);
  const kind = SCHEDULE_KIND[h0.kind].label;
  const when = (h: ScheduleHold) => `${shortDate(h.date)}${h.endDate ? `〜${shortDate(h.endDate)}` : ""} ${h.startTime ? `${h.startTime}頃` : h.slot === "am" ? "午前" : h.slot === "pm" ? "午後" : "終日"}`;
  const lines = [
    `${customer ? `${customer.name} 様` : "お客様"}`,
    "",
    `いつも一畳屋をご利用いただきありがとうございます。${store?.name ?? ""}です。`,
    `${kind}のお日にちについて、次の候補をご用意しました。ご都合のよい日をお知らせください。`,
    "",
    ...holds.map((h) => `第 ${h.rank} 候補: ${when(h)}`),
    "",
    opts.link ? `こちらからお選びいただけます: ${opts.link}` : "このメッセージへのご返信、またはお電話でお知らせください。",
    "ご都合が合わない場合も、お気軽にご連絡ください。",
    "",
    `株式会社一畳屋 ${store?.name ?? ""}`,
  ];
  return { subject: `【一畳屋】${kind}の日程のご相談`, body: lines.join("\n") };
}
