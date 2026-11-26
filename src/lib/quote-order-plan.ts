import "server-only";
import type { Database, OrderHandover, Quote, ScheduleEvent, User } from "@/lib/db/types";
import type { QuoteOrderPlan } from "@/components/schedule/quick-types";
import { skipsApproval } from "@/lib/auth/permissions";
import { HANDOVER_ITEM, suggestHandovers, toFormRows } from "@/lib/handover";
import { quoteHandoverLines } from "@/lib/handover-save";
import { formStores, formUsers } from "@/components/schedule/form-data";
import { SCHEDULE_KIND } from "@/lib/constants";
import { toDateKey } from "@/lib/format";
import { caseVisits } from "@/lib/visit-adopt";
import { buildCaseMap, caseIdOfEvent } from "@/lib/case-group";

/**
 * 見積を受注にするときの日程の案 (予定表の小さな画面の「受注にする」と見積の画面の「受注登録」で共通)
 * ------------------------------------------------------------
 * お客様のご要望 2026-11-26「③ 受注登録時の日程設定」: 見積から受注へ進んだ同じ画面で、引き取り日と納品日をセットで登録する。
 * 日程の案は 手書きの見積書の「引取日時」「納品日時」 → 同じ案件の登録済みの引き取り・納品の予定 (引き継ぐ) → 訪問 (見積・現調・現見) の日。
 * どれもなければ「未定」(空) のまま。登録済みの引き取り・納品の予定は受注の予定として使い回す (src/lib/db/handover-events.ts。二重にしない)
 */

const timeText = (e: Pick<ScheduleEvent, "startTime" | "slot">) => e.startTime ?? (e.slot === "am" ? "午前" : e.slot === "pm" ? "午後" : "");
const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

/** 同じ案件の今日以降の引き取り・納品の予定 (受注の予定でない・ほかの受注にひも付いていないもの。受注の予定として使い回す候補) */
export function caseHandoverEvents(db: Database, q: Pick<Quote, "id" | "inquiryId" | "orderId">, today = toDateKey(new Date())): ScheduleEvent[] {
  const map = buildCaseMap(db);
  const mine = map.caseOf(q.id);
  return db.schedule
    .filter(
      (e) =>
        e.source !== "order" &&
        e.date >= today &&
        (e.kind === "pickup" || e.kind === "delivery") &&
        (!e.orderId || e.orderId === q.orderId) &&
        (e.quoteId === q.id || (q.inquiryId && e.inquiryId === q.inquiryId) || Boolean(mine && caseIdOfEvent(map, e) === mine)),
    )
    .sort((a, b) => a.date.localeCompare(b.date) || (a.startTime ?? "").localeCompare(b.startTime ?? ""));
}

/**
 * 見積を受注にする画面の材料。受注にできない見積は { blocked } (理由)、受注にしない見積 (失注・受注済み) は undefined
 * @param opts.fallbackDate 予定表の小さな画面から開いたときの予定の日 (訪問の日。その場で作業するときの初期値)
 */
export function quoteOrderPlan(db: Database, user: User, q: Quote, opts: { fallbackDate?: string; workerIds?: string[]; inquiryId?: string } = {}): QuoteOrderPlan | { blocked: string } | undefined {
  if (q.orderId || ["rejected", "expired"].includes(q.status)) return undefined;
  if (q.pendingChange) return { blocked: "見積の変更が承認待ちです。承認・差戻しのあとに受注にできます。" };
  if (!["draft", "pending_approval", "approved", "sent"].includes(q.status)) return { blocked: "この状態の見積は受注にできません。" };
  const today = toDateKey(new Date());
  const onsite = q.status === "draft" || q.status === "pending_approval";
  const own = skipsApproval(user, "order");
  const customer = db.customers.find((c) => c.id === q.customerId);
  const inquiryId = q.inquiryId ?? opts.inquiryId;
  const visitsAll = caseVisits(db, { quoteId: q.id, inquiryId, customerId: q.customerId });
  const existing = caseHandoverEvents(db, { id: q.id, inquiryId, orderId: q.orderId }, today);
  const pickupEv = existing.find((e) => e.kind === "pickup");
  const deliveryEv = existing.find((e) => e.kind === "delivery" && (!pickupEv || e.date >= pickupEv.date));
  const upcomingVisit = visitsAll.find((v) => v.date >= today);
  // 引取日の初期値: 登録済みの引き取りの予定 → 開いた予定の日 (訪問) → これからの訪問の日。なければ未定
  const fallback = pickupEv?.date ?? opts.fallbackDate ?? upcomingVisit?.date;
  let rows: OrderHandover[] = suggestHandovers({ lines: quoteHandoverLines(db, q.items), category: q.category, pickupText: q.siteInfo?.pickupAt, deliveryText: q.siteInfo?.deliveryAt, fallbackPickup: fallback, ref: today });
  // 畳・襖・障子・網戸のない見積 (リフォームなど) は施工日の行
  if (!rows.length) rows = [{ id: `hv_${Date.now().toString(36)}`, item: "reform", label: HANDOVER_ITEM.reform.label, ...(fallback ? { pickupDate: fallback } : {}) }];
  // 登録済みの予定の日程を引き継ぐ (手書きの日時が書いていない側だけ。時間も)
  const inherited: string[] = [];
  if (pickupEv && !q.siteInfo?.pickupAt) {
    let used = false;
    for (const r of rows) {
      if (HANDOVER_ITEM[r.item].mode === "install" || r.pickupDate !== pickupEv.date || r.pickupStart || r.pickupSlot) continue;
      if (pickupEv.startTime) {
        r.pickupStart = pickupEv.startTime;
        if (pickupEv.endTime) r.pickupEnd = pickupEv.endTime;
      } else if (pickupEv.slot) r.pickupSlot = pickupEv.slot;
      used = true;
    }
    if (used || rows.some((r) => r.pickupDate === pickupEv.date)) inherited.push(`引取 ${md(pickupEv.date)}${timeText(pickupEv) ? ` ${timeText(pickupEv)}` : ""}`);
  }
  if (deliveryEv && !q.siteInfo?.deliveryAt) {
    let used = false;
    for (const r of rows) {
      const def = HANDOVER_ITEM[r.item];
      if (def.mode === "install" || r.deliveryDate || (r.pickupDate && r.pickupDate > deliveryEv.date)) continue;
      r.deliveryDate = deliveryEv.date;
      if (deliveryEv.startTime) {
        r.deliveryStart = deliveryEv.startTime;
        if (deliveryEv.endTime) r.deliveryEnd = deliveryEv.endTime;
      } else if (deliveryEv.slot) r.deliverySlot = deliveryEv.slot;
      used = true;
    }
    if (used) inherited.push(`納品 ${md(deliveryEv.date)}${timeText(deliveryEv) ? ` ${timeText(deliveryEv)}` : ""}`);
  }
  const sourceText = [q.siteInfo?.pickupAt && `引取: ${q.siteInfo.pickupAt}`, q.siteInfo?.deliveryAt && `納品: ${q.siteInfo.deliveryAt}`].filter(Boolean).join(" / ") || undefined;
  return {
    quoteId: q.id,
    quoteNumber: q.number,
    total: q.total,
    onsite,
    own,
    approvalNote: own
      ? "店長・管理者のため承認は省略し、その場で受注 (契約) を確定します。"
      : onsite
        ? "見積の承認と受注 (契約) の承認をあわせて申請します (受注を承認すると見積も承認済み)。承認の前でも日程は予定表に載ります。"
        : "受注 (契約) の承認を申請します。承認の前でも日程は予定表に載ります。",
    initial: toFormRows(rows),
    sourceText,
    inheritedText: inherited.length ? `登録済みの予定 (${inherited.join("・")})` : undefined,
    workerIds: opts.workerIds?.length ? opts.workerIds : (pickupEv?.assigneeIds ?? deliveryEv?.assigneeIds ?? upcomingVisit?.assigneeIds ?? []),
    siteAddress: q.siteAddress || customer?.address || "",
    storeId: q.storeId,
    users: formUsers(db),
    stores: formStores(db),
    currentUserId: user.id,
    visits: visitsAll.map((v) => ({ date: v.date, label: SCHEDULE_KIND[v.kind].label, time: timeText(v) })),
    existing: existing.map((e) => ({ id: e.id, kind: e.kind as "pickup" | "delivery", date: e.date, label: SCHEDULE_KIND[e.kind].label, time: timeText(e) })),
  };
}
