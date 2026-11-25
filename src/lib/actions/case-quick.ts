"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, getDb, mutate, newId, nextNumber, nowIso } from "@/lib/db/store";
import type { Inquiry, ScheduleEvent, ScheduleKind, StoreId } from "@/lib/db/types";
import { CATEGORY_LABEL, CHANNEL_LABEL, QUICK_MAX_ASSIGNEES, SCHEDULE_KIND, SCHEDULE_KINDS } from "@/lib/constants";
import { canEditCaseStore, canViewCompanySchedule } from "@/lib/auth/permissions";
import { createCaseResolver } from "@/lib/db/schedule";
import { CASE_REQUEST_KIND, createCaseRequest, isCaseRequestKind } from "@/lib/case-requests";
import { requestTargets } from "@/lib/inquiry-requests";
import { dueAtFrom } from "@/lib/inquiry-flow";
import { taskNotices } from "@/lib/notify/events";
import { sendAndRecord } from "@/lib/notify/send";
import { caseChainOf } from "@/lib/case-store";
import { canLinkToCustomer, caseRelinkBlocker, moveCaseToCustomer } from "@/lib/customer-link";
import { completedCaseLock, completedLockMessage } from "@/lib/case-access";
import { addChangeNotice, caseTarget } from "@/lib/change-notices";
import { syncOrderEvent } from "@/lib/db/schedule";
import { currentEventMode, propagateOrderSite, mapTablesReady, saveEventLocationMode } from "@/lib/maps/store";
import { findConflicts, isDateKey, normTime, periodLabel, toMinutes } from "@/lib/calendar";
import { toDateKey } from "@/lib/format";
import { isMediaKey, MEDIA_LABEL } from "@/lib/media";
import { newCaseStore } from "@/lib/store-area";
import { updateQuote } from "./quotes";
import { choice, fail, requireActionUser, safeReturn, str, withMsg } from "./guards";

/**
 * 予定表の小さな画面から案件を直す・足す (お客様のご要望 2026-11-25「予定表を起点に、案件の確認・変更・追加をその画面で」)
 * ------------------------------------------------------------
 * - relinkCase: 紐付け間違いの修正。問い合わせ・見積・受注・予定などの情報はそのままに、お客様だけを付け替える (「⑤」)
 * - setCaseSite: 施工現場の住所 (依頼主の住所と別) を案件に登録する。予定表の町名・地図はこの住所を使う (「⑨」)
 * - quickAmendLines: 明細 (仕様・枚数・単価) の修正・追加・部分キャンセル。見積の変更 (版として残る) と同じ処理 (「③」)
 * - quickNewCase: 同じお客様 (取引先) の新しい案件 (問い合わせ) と、必要なら最初の予定を登録する (「⑩」)
 * どれも担当店舗・本部・管理者に変更をお知らせする (src/lib/change-notices.ts)
 */

const back = (fd: FormData, fallback: string) => safeReturn(str(fd, "returnTo"), fallback);

/** 案件のお客様を付け替える (caseId = 問い合わせ・見積・受注のどれか) */
export async function relinkCase(caseId: string, formData: FormData) {
  const user = await requireActionUser();
  const ret = back(formData, "/schedule");
  const customerId = str(formData, "customerId");
  if (!customerId) fail(ret, "付け替える先のお客様を選んでください。");
  let message = "";
  await mutate((db) => {
    const chain = caseChainOf(db, caseId);
    if (!chain) fail(ret, "案件が見つかりません。");
    if (!canEditCaseStore(user, chain.head.storeId)) fail(ret, "この案件を変更する権限がありません。");
    if (chain.order) {
      const lock = completedCaseLock(db, user, chain.order);
      if (lock.locked) fail(ret, completedLockMessage(lock.reason));
    }
    const blocker = caseRelinkBlocker(db, chain);
    if (blocker) fail(ret, blocker);
    const to = db.customers.find((c) => c.id === customerId);
    if (!to) fail(ret, "お客様が見つかりません。");
    if (!canLinkToCustomer(db, user, to)) fail(ret, "このお客様は閲覧の範囲の外のため付け替えられません。店舗または本部に依頼してください。");
    const fromId = chain.order?.customerId ?? chain.quote?.customerId ?? chain.inquiry?.customerId;
    if (fromId === to.id) fail(ret, `すでに ${to.name} 様の案件です。`);
    const from = fromId ? db.customers.find((c) => c.id === fromId) : undefined;
    const r = moveCaseToCustomer(db, chain, to, user.id);
    if (chain.order) chain.order.progressNotes.push({ id: newId("pn"), at: nowIso(), userId: user.id, kind: "change", body: `お客様を付け替え: ${from ? `${from.name} 様 (${from.code})` : "(未登録)"} → ${to.name} 様 (${to.code})` });
    addChangeNotice(db, user.id, caseTarget(db, chain.head.id), "お客様の付け替え", [{ label: "お客様", before: from ? `${from.name} 様 (${from.code})` : "(未登録)", after: `${to.name} 様 (${to.code})` }]);
    message = `案件 ${chain.head.number} を ${to.name} 様に付け替えました (記録 ${r.records} 件${r.events ? `・予定 ${r.events} 件` : ""})。問い合わせ・見積・受注・予定の内容はそのままです。${r.removed ? `仮の顧客 (${r.removed.code}) は記録がなくなったため削除しました。` : ""}`;
  });
  revalidatePath("/", "layout");
  redirect(withMsg(ret, message));
}

/**
 * 施工現場の住所 (依頼主 = お客様の住所と違うとき)。案件のいちばん進んだ記録 (受注 → 見積 → 問い合わせ) に入れ、前の段階の記録にもそろえる。
 * 空にするとお客様の住所 (施工現場 = 依頼主の住所)
 */
export async function setCaseSite(caseId: string, formData: FormData) {
  const user = await requireActionUser();
  const ret = back(formData, "/schedule");
  const address = str(formData, "siteAddress").replace(/\s+/g, " ").trim().slice(0, 200);
  let message = "";
  await mutate((db) => {
    const chain = caseChainOf(db, caseId);
    if (!chain) fail(ret, "案件が見つかりません。");
    if (!canEditCaseStore(user, chain.head.storeId)) fail(ret, "この案件を変更する権限がありません。");
    if (chain.order) {
      const lock = completedCaseLock(db, user, chain.order);
      if (lock.locked) fail(ret, completedLockMessage(lock.reason));
    }
    const customer = db.customers.find((c) => c.id === (chain.order?.customerId ?? chain.quote?.customerId ?? chain.inquiry?.customerId));
    const now = nowIso();
    const current = chain.order?.siteAddress || chain.quote?.siteAddress || chain.inquiry?.siteAddress || "";
    // 受注の施工場所が空 = お客様の住所。お客様の住所と同じ文字なら空と同じ
    const next = address && customer?.address && address === customer.address ? "" : address;
    const shown = (v: string) => v || (customer?.address ? `お客様の住所と同じ (${customer.address})` : "(未登録)");
    if ((chain.order ? chain.order.siteAddress || "" : current) === next && (chain.quote?.siteAddress ?? "") === next && (chain.inquiry?.siteAddress ?? "") === next) fail(ret, "変更はありませんでした。");
    if (chain.inquiry && (chain.inquiry.siteAddress ?? "") !== next) {
      const inq = chain.inquiry;
      const b = inq.siteAddress;
      inq.siteAddress = next || undefined;
      inq.updatedAt = now;
      addAudit(db, { userId: user.id, action: "update", entity: "inquiry", entityId: inq.id, entityLabel: inq.number, summary: "施工現場の住所を変更", storeId: inq.storeId, changes: [{ field: "siteAddress", before: b ?? null, after: next || null }] });
      // 問い合わせの段階の予定 (見積・受注にひも付いていない予定) の場所も現場にする (予定表の町名・地図が現場になる)。この予定だけの別の場所は変えない
      for (const e of db.schedule) {
        if (e.inquiryId !== inq.id || e.orderId || e.quoteId || e.source === "order") continue;
        const follows = currentEventMode(db, e) === "follow" || (b && e.location === b);
        if (!follows) continue;
        const before = e.location;
        e.location = next || undefined;
        e.updatedBy = user.id;
        e.updatedAt = now;
        if (mapTablesReady()) saveEventLocationMode(db, user, e, next ? "custom" : "follow");
        if ((before ?? "") !== (e.location ?? "")) addAudit(db, { userId: user.id, action: "update", entity: "schedule", entityId: e.id, entityLabel: e.title, summary: "案件の施工現場の住所に合わせて予定の場所を変更", storeId: e.storeId, changes: [{ field: "location", before: before ?? null, after: e.location ?? null }] });
      }
    }
    if (chain.quote && (chain.quote.siteAddress ?? "") !== next) {
      const b = chain.quote.siteAddress;
      chain.quote.siteAddress = next || undefined;
      chain.quote.updatedAt = now;
      addAudit(db, { userId: user.id, action: "update", entity: "quote", entityId: chain.quote.id, entityLabel: chain.quote.number, summary: "施工場所を変更", storeId: chain.quote.storeId, changes: [{ field: "siteAddress", before: b ?? null, after: next || null }] });
    }
    if (chain.order) {
      const o = chain.order;
      const b = o.siteAddress;
      const after = next || customer?.address || o.siteAddress;
      if ((b ?? "") !== (after ?? "")) {
        o.siteAddress = after;
        o.updatedAt = now;
        if (db.schedule.some((e) => e.orderId === o.id && e.source === "order")) syncOrderEvent(db, o, user.id);
        propagateOrderSite(db, user, o, b);
        addAudit(db, { userId: user.id, action: "update", entity: "order", entityId: o.id, entityLabel: o.number, summary: "施工場所 (現場住所) を変更", storeId: o.storeId, changes: [{ field: "siteAddress", before: b ?? null, after: after ?? null }] });
      }
    }
    addChangeNotice(db, user.id, caseTarget(db, chain.head.id), "施工現場の住所の変更", [{ label: "施工現場の住所", before: shown(current), after: shown(next) }]);
    message = next ? `施工現場の住所を「${next}」にしました。予定表の町名と地図 (Google マップ・住宅地図) はこの住所になります。依頼主の住所はお客様の情報のままです。` : "施工現場の住所を外しました (お客様の住所と同じ)。";
  });
  revalidatePath("/", "layout");
  redirect(withMsg(ret, message));
}

/**
 * 明細 (仕様・枚数・単価) の修正・追加・部分キャンセル (行の削除)。見積の画面の変更と同じ処理 (updateQuote) を呼ぶ:
 * 下書きはそのまま保存、確定した見積は変更 (版として残す)。差額が設定の金額 (既定 1 万円) 以下なら承認なしで反映、超えれば店長・管理者の承認。
 * 画面にない項目 (件名・施工内容・備考・税・値引き・種別・有効期限・担当) は今の値のまま
 */
export async function quickAmendLines(quoteId: string, formData: FormData) {
  await requireActionUser();
  const ret = back(formData, `/quotes/${quoteId}`);
  const q = getDb().quotes.find((x) => x.id === quoteId);
  if (!q) fail(ret, "見積が見つかりません。");
  const fd = new FormData();
  fd.set("items", str(formData, "items"));
  fd.set("title", q.title);
  fd.set("category", q.category);
  fd.set("validUntil", q.validUntil ?? "");
  fd.set("notes", q.notes ?? "");
  fd.set("workDetails", q.workDetails ?? "");
  if (q.estimatorId) fd.set("estimatorId", q.estimatorId);
  fd.set("taxMode", q.taxExempt ? "exempt" : q.taxIncluded ? "included" : "excluded");
  fd.set("discount", String(q.discount ?? 0));
  fd.set("reason", str(formData, "reason").slice(0, 300));
  fd.set("intent", q.status === "draft" ? "draft" : "amend");
  fd.set("returnTo", ret);
  return updateQuote(quoteId, fd);
}

/**
 * 同じお客様 (取引先) の新しい案件 (お客様のご要望 2026-11-25「⑩」: 業者から複数の現場を受けるとき、予定表から新しい案件を追加)。
 * 問い合わせを登録し、日付を入れたときは最初の予定 (見積り・現地調査・引取など) も登録する
 */
export async function quickNewCase(formData: FormData) {
  const user = await requireActionUser();
  const ret = back(formData, "/schedule");
  const summary = str(formData, "summary").slice(0, 200);
  if (!summary) fail(ret, "新しい案件の内容 (要件) を入力してください。");
  const media = str(formData, "media");
  if (!isMediaKey(media)) fail(ret, "媒体 (当社を知ったきっかけ) を選んでください。");
  const siteAddress = str(formData, "siteAddress").replace(/\s+/g, " ").trim().slice(0, 200);
  const date = str(formData, "date");
  const kindRaw = str(formData, "kind");
  const kind: ScheduleKind = SCHEDULE_KINDS.includes(kindRaw as ScheduleKind) && SCHEDULE_KIND[kindRaw as ScheduleKind].group === "case" ? (kindRaw as ScheduleKind) : "survey";
  const mode = str(formData, "timeMode");
  const startTime = date && mode === "time" ? normTime(str(formData, "startTime")) : undefined;
  if (date && mode === "time" && !startTime) fail(ret, "時刻を正しく入れてください。");
  const endTime = startTime ? normTime(str(formData, "endTime")) : undefined;
  if (startTime && endTime && toMinutes(endTime) <= toMinutes(startTime)) fail(ret, "終了時刻は開始時刻より後にしてください。");
  const slot: "am" | "pm" | undefined = date && !startTime && (mode === "am" || mode === "pm") ? mode : undefined;
  if (date && !isDateKey(date)) fail(ret, "日付を正しく入れてください。");
  const db0 = getDb();
  const active = new Set(db0.users.filter((u) => u.active).map((u) => u.id));
  const assigneeIds = [...new Set(formData.getAll("assigneeIds").map(String))].filter((a) => active.has(a)).slice(0, QUICK_MAX_ASSIGNEES);
  if (date && !assigneeIds.length) fail(ret, "予定の担当者を 1 人以上選んでください (予定を登録しないときは日付を空にしてください)。");
  const customer = db0.customers.find((c) => c.id === str(formData, "customerId"));
  if (!customer) fail(ret, "お客様が見つかりません。");
  if (!canLinkToCustomer(db0, user, customer)) fail(ret, "このお客様は閲覧の範囲の外のため、案件を登録できません。");
  if (date && assigneeIds.length && str(formData, "allowOverlap") !== "1") {
    const hits = findConflicts({ date, startTime, endTime, slot, assigneeIds }, db0.schedule);
    if (hits.length) fail(ret, `担当者の予定が重複しています: ${[...new Set(hits.map((h) => `${db0.users.find((u) => u.id === h.userId)?.name ?? "-"} さん「${h.event.title}」`))].slice(0, 3).join("・")}。日時・担当者を見直すか、「重複を承知で登録する」にチェックしてください。`);
  }
  const id = newId("inq");
  let eventId = "";
  let storeName = "";
  await mutate((db) => {
    const c = db.customers.find((x) => x.id === customer.id)!;
    // 担当店舗: 手で選んだ店舗 > 現場の住所 (なければお客様の住所) の担当エリア > お客様の店舗 > 自店舗 (src/lib/store-area.ts)
    const pick = newCaseStore(db, user, { requested: str(formData, "storeId"), auto: !str(formData, "storeId"), address: siteAddress || c.address, customer: c });
    const storeId: StoreId = pick.storeId;
    if (!canEditCaseStore(user, storeId)) fail(ret, "この店舗の案件を登録する権限がありません。");
    storeName = db.stores.find((s) => s.id === storeId)?.name ?? storeId;
    const now = nowIso();
    const inq: Inquiry = {
      id,
      number: nextNumber(db, "INQ", db.inquiries, toDateKey(new Date())),
      customerId: c.id,
      contactName: c.name,
      contactPhone: c.phone || undefined,
      channel: choice(formData, "channel", CHANNEL_LABEL, "phone"),
      storeId,
      category: choice(formData, "category", CATEGORY_LABEL, "tatami"),
      summary,
      detail: str(formData, "detail").slice(0, 4000),
      status: date ? "in_progress" : "new",
      assignedUserId: assigneeIds[0] ?? user.id,
      receivedAt: now,
      createdBy: user.id,
      updatedAt: now,
      media,
      siteAddress: siteAddress && siteAddress !== c.address ? siteAddress : undefined,
    };
    db.inquiries.push(inq);
    addAudit(db, { userId: user.id, action: "create", entity: "inquiry", entityId: id, entityLabel: inq.number, summary: `予定表から同じお客様の新しい案件を登録 (${c.name} / ${summary} / 媒体: ${MEDIA_LABEL[media]}${inq.siteAddress ? ` / 現場: ${inq.siteAddress}` : ""})`, storeId });
    db.commLogs.push({ id: newId("cl"), customerId: c.id, storeId, channel: inq.channel, direction: "inbound", subject: summary, body: inq.detail || summary, at: now, userId: user.id, relatedType: "inquiry", relatedId: id });
    c.updatedAt = now;
    if (date) {
      eventId = newId("ev");
      const ev: ScheduleEvent = {
        id: eventId,
        title: `${c.name} ${SCHEDULE_KIND[kind].short ?? SCHEDULE_KIND[kind].label}`.trim(),
        kind,
        date,
        startTime,
        endTime: startTime ? endTime : undefined,
        slot,
        storeId,
        assigneeIds,
        customerId: c.id,
        inquiryId: id,
        location: inq.siteAddress,
        memo: str(formData, "memo").slice(0, 2000) || undefined,
        source: "manual",
        createdBy: user.id,
        createdAt: now,
        updatedBy: user.id,
        updatedAt: now,
      };
      db.schedule.push(ev);
      if (mapTablesReady()) saveEventLocationMode(db, user, ev, inq.siteAddress ? "custom" : "follow");
      addAudit(db, { userId: user.id, action: "create", entity: "schedule", entityId: eventId, entityLabel: ev.title, summary: `予定を登録 (${periodLabel(ev)} ${SCHEDULE_KIND[kind].label} / 案件 ${inq.number})`, storeId });
    }
    addChangeNotice(db, user.id, caseTarget(db, id), "新しい案件の登録", [
      { label: "案件", before: "(なし)", after: `${inq.number} ${summary}` },
      ...(inq.siteAddress ? [{ label: "施工現場の住所", before: "", after: inq.siteAddress }] : []),
      ...(date ? [{ label: `${SCHEDULE_KIND[kind].label}の予定`, before: "(なし)", after: `${periodLabel({ date, startTime, endTime, slot })} (担当: ${assigneeIds.map((a) => db.users.find((u) => u.id === a)?.name ?? "-").join("・")})` }] : []),
    ]);
  });
  revalidatePath("/inquiries");
  revalidatePath("/schedule");
  revalidatePath(`/customers/${customer.id}`);
  redirect(withMsg(ret, `${customer.name} 様の新しい案件を登録しました (${storeName})。${eventId ? "予定表に予定も登録しました。" : "日程が決まったら、問い合わせの画面か予定表から予定を登録してください。"}`));
}

/**
 * 案件への依頼 (メンション) を送る (お客様のご要望 2026-11-25「⑪」。src/lib/case-requests.ts)。
 * eventId (予定表の小さな画面から) か caseId (案件の画面から)。宛先は target = store (店舗の店長・スタッフ全員) / users (担当者を選ぶ)。
 * 種類 kind・内容 note (「その他」は必須)・期限 due (なし・本日12時まで・本日中・明日中)・至急 urgent
 */
export async function sendCaseRequest(formData: FormData) {
  const user = await requireActionUser();
  const ret = back(formData, "/schedule");
  if (!canViewCompanySchedule(user)) fail(ret, "依頼を送る権限がありません。");
  const kind = str(formData, "kind");
  if (!isCaseRequestKind(kind)) fail(ret, "依頼の種類 (日程変更依頼・仕様変更依頼・クレーム・手直し・その他) を選んでください。");
  const note = str(formData, "note").slice(0, 2000);
  if (kind === "other" && !note) fail(ret, "「その他」の依頼は、内容を書いてください。");
  const db0 = getDb();
  const eventId = str(formData, "eventId");
  const ev = eventId ? db0.schedule.find((x) => x.id === eventId) : undefined;
  if (eventId && !ev) fail(ret, "予定が見つかりません (削除された可能性があります)。");
  const ref = ev ? createCaseResolver(db0).ofEvent(ev) : undefined;
  const chain = caseChainOf(db0, str(formData, "caseId") || ref?.id);
  const customerId = chain ? undefined : ev?.customerId;
  if (!chain && !customerId) fail(ret, "依頼を送る案件が見つかりません (案件・お客様にひも付いた予定から送れます)。");
  const active = db0.users.filter((u) => u.active && !u.id.startsWith("u_review"));
  const byUsers = str(formData, "target") === "users";
  const assignees = byUsers ? [...new Set(formData.getAll("assigneeIds").map(String))].map((id) => active.find((u) => u.id === id)).filter((u): u is NonNullable<typeof u> => Boolean(u)).slice(0, 10) : [];
  if (byUsers && !assignees.filter((u) => u.id !== user.id).length) fail(ret, "依頼する担当者を選んでください (自分のほかに 1 人以上)。");
  const storeRaw = str(formData, "storeId");
  const storeId = (db0.stores.some((s) => s.id === storeRaw) ? storeRaw : chain?.head.storeId ?? ev?.storeId ?? user.storeId) as StoreId;
  if (!byUsers && !requestTargets(db0, storeId).filter((u) => u.id !== user.id).length) fail(ret, "この店舗には依頼を受ける社員 (店長・スタッフ) がいません。担当者を選んで送ってください。");
  const dueChoice = str(formData, "due");
  const due = dueChoice === "noon" || dueChoice === "today" || dueChoice === "tomorrow" ? dueAtFrom(dueChoice, undefined, new Date()) : {};
  if (due.error) fail(ret, due.error);
  const urgent = str(formData, "urgent") === "1";
  let tid = "";
  await mutate((db) => {
    const c = chain ? caseChainOf(db, chain.head.id) : undefined;
    const e = ev ? db.schedule.find((x) => x.id === ev.id) : undefined;
    const t = createCaseRequest(db, { actor: user, chain: c, customerId, event: e, kind, note: note || `${CASE_REQUEST_KIND[kind].label}をお願いします。`, storeId, assignees: byUsers ? assignees : undefined, dueAt: due.dueAt, urgent });
    tid = t.id;
  });
  const db1 = getDb();
  const t = db1.threads.find((x) => x.id === tid);
  if (t) await sendAndRecord(taskNotices(db1, t, user.id, "request", note), user.id).catch((err) => console.warn("[case-request] notice failed:", (err as Error).message));
  revalidatePath("/", "layout");
  const to = byUsers ? assignees.filter((u) => u.id !== user.id).map((u) => u.name).join("・") : `${db1.stores.find((s) => s.id === storeId)?.name ?? storeId}の店長・スタッフ`;
  redirect(withMsg(ret, `${CASE_REQUEST_KIND[kind].label}を ${to} に送りました。受けた人のお知らせ (ベル) から、この案件を直接開けます。送った内容は案件の「この案件への依頼」に残ります。`));
}
