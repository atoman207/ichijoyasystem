import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { syncDb } from "@/lib/db/store";
import { canAccessStore, canEditCaseStore, canEditEvent, canReadStoreRecords, canViewCompanySchedule } from "@/lib/auth/permissions";
import { policyReader } from "@/lib/access-policy";
import { caseValue, createCaseResolver, orderEditable } from "@/lib/db/schedule";
import { parseHandoverRef } from "@/lib/handover";
import { periodLabel } from "@/lib/calendar";
import { eventLabeler } from "@/lib/schedule-label";
import { scheduleWork } from "@/lib/schedule-work";
import { workDescription, workText, workNoteOf } from "@/lib/work-summary";
import type { EventQuickData, QuickCase, QuickMap, QuickPair, QuickRemove, QuickRequest, QuickStoreChange } from "@/components/schedule/quick-types";
import { approverRole, skipsApproval } from "@/lib/auth/permissions";
import { caseChainOf } from "@/lib/case-store";
import { caseIdOf } from "@/lib/case-group";
import { caseStoreChangeInfo } from "@/lib/case-store-view";
import type { Order } from "@/lib/db/types";
import type { Database, ScheduleEvent, User } from "@/lib/db/types";
import { canEditRecordMap, canViewRecordMap } from "@/lib/maps/access";
import { mapIndex, placeOf } from "@/lib/maps/resolve";
import { ZENRIN_GIS } from "@/lib/maps/purpose";
import { quickStaff } from "@/lib/quick-staff";
import { eventPair } from "@/lib/schedule-pair";
import { handoverLabel } from "@/lib/handover";
import { approvalSettings } from "@/lib/approval-rules";
import { CATEGORY_LABEL, SCHEDULE_KIND, TASK_STATUS } from "@/lib/constants";
import { CASE_REQUEST_KIND, CASE_REQUEST_KINDS, caseRequestsOf } from "@/lib/case-requests";
import type { ScheduleKind } from "@/lib/db/types";
import { completedCaseLock, completedLockMessage } from "@/lib/case-access";
import { canLinkToCustomer, caseRelinkBlocker, isPlaceholderCustomer } from "@/lib/customer-link";
import { liveInvoicesOfOrder } from "@/lib/billing";
import { taxModeOf } from "@/lib/quote-calc";
import { WORK_ROLES, WORK_ROLE_LABEL, workStaffOf } from "@/lib/work-staff";
import type { QuickWork } from "@/components/schedule/quick-types";
import { ATTACHMENT_ACCEPT, canAddToParent, canViewAttachment, resolveParent, toView } from "@/lib/attachments";
import { canIssueInvoice, canIssueReceipt, canOutputDocument } from "@/lib/auth/permissions";
import { invoiceAccessInfo, orderAccessInfo, quoteAccessInfo } from "@/lib/case-access";
import { canIssueFor } from "@/lib/invoice-rules";
import { partLabel, receiptChecks, receiptDraft, receiptHeading, receiptWanted } from "@/lib/receipts";
import { outputsOf } from "@/lib/doc-outputs";
import { quoteOrderPlan } from "@/lib/quote-order-plan";
import { QUOTE_STATUS, ORDER_STATUS } from "@/lib/constants";
import { toDateKey } from "@/lib/format";
import { VISIT_KINDS } from "@/lib/visit-adopt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };

/**
 * 予定表で予定を押したときの小さな画面 (EventQuickDialog) の中身 (お客様のご要望 2026-11-24「■3」「■4」)
 * お客様は案件 (受注 → 見積 → 問い合わせ) から引く (問い合わせを既存の顧客にひも付けたあとは、その顧客の情報)
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  if (!canViewCompanySchedule(user)) return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  const { id } = await params;
  const db = await syncDb();
  const e = db.schedule.find((x) => x.id === id);
  if (!e) return NextResponse.json({ error: "予定が見つかりません (削除された可能性があります)。" }, { status: 404, headers: NO_STORE });
  const resolver = createCaseResolver(db);
  const ref = resolver.ofEvent(e);
  const labeler = eventLabeler(db);
  const label = labeler.label(e);
  const customer = labeler.customerOf(e);
  const reader = policyReader(db, user);
  const canSeeCustomer = customer ? canReadStoreRecords(reader, customer.storeId) || canEditCaseStore(user, customer.storeId) : false;
  const order = e.orderId ? db.orders.find((o) => o.id === e.orderId) : undefined;
  const synced = e.source === "order";
  const handover = synced && Boolean(parseHandoverRef(e.sourceRef));
  const canEdit = canEditEvent(user, e) && (!synced || (order ? orderEditable(order) : false));
  const inq = ref?.inquiryId ? db.inquiries.find((i) => i.id === ref.inquiryId) : undefined;
  const store = db.stores.find((s) => s.id === e.storeId);
  const users = new Map(db.users.map((u) => [u.id, u.name]));
  const workCounts = scheduleWork(db, [e]).get(e.id);
  const data: EventQuickData = {
    id: e.id,
    title: e.title,
    label: label.text,
    area: label.area,
    kind: e.kind,
    date: e.date,
    endDate: e.endDate,
    startTime: e.startTime,
    endTime: e.endTime,
    slot: e.slot,
    memo: e.memo ?? "",
    location: e.location,
    period: periodLabel(e),
    storeId: e.storeId,
    storeName: store?.name ?? e.storeId,
    assigneeIds: e.assigneeIds,
    assignees: e.assigneeIds.map((a) => users.get(a) ?? "-"),
    // 手入力の自由な作業内容 (「養生、廃材撤去」) はそのまま、ほかは「タ6 タ新4 フ2」(src/lib/work-summary.ts)
    work: workNoteOf(e) ?? (workDescription(workCounts) || undefined),
    workText: workNoteOf(e) ?? (workText(workCounts) || undefined),
    workManual: e.work?.trim() || undefined,
    storeChange: quickStoreChange(db, user, e, canEdit, resolver),
    remove: quickRemove(db, user, e, canEdit, order, resolver),
    caseRef: ref ? caseValue(ref) : undefined,
    case: ref ? { label: `${ref.stage} ${ref.number}`, title: ref.title, href: ref.href, canOpen: canAccessStore(user, ref.storeId) || canEditCaseStore(user, ref.storeId) } : undefined,
    customer: customer
      ? {
          name: customer.name,
          href: canSeeCustomer ? `/customers/${customer.id}` : undefined,
          phones: canSeeCustomer ? [customer.phone, ...(customer.contacts ?? []).map((x) => x.phone)].filter((p): p is string => Boolean(p?.trim())).slice(0, 3) : [],
          address: canSeeCustomer ? customer.address || (customer.area ? `地区 ${customer.area}` : "") : "",
          corporate: customer.type === "corporate",
          placeholder: isPlaceholderCustomer(customer),
        }
      : undefined,
    contactName: inq && customer && inq.contactName !== customer.name ? inq.contactName : !customer && inq ? inq.contactName : undefined,
    contactPhone: !customer && inq ? inq.contactPhone || inq.intake?.phone : undefined,
    inquiryHref: inq && !customer ? `/inquiries/${inq.id}#link-customer` : isPlaceholderCustomer(customer) && inq ? `/inquiries/${inq.id}#link-customer` : undefined,
    synced,
    handover,
    scheduleApproval: approvalSettings(db).scheduleChange && !skipsApproval(user, "handover_change"),
    lockKind: synced,
    canEdit,
    hold: false,
    map: quickMap(db, user, e),
    staff: quickStaff(db, e.storeId),
    pair: quickPair(db, user, e, canEdit, labeler, users, resolver),
    caseEdit: quickCase(db, user, e, resolver),
    request: quickRequest(db, e, resolver),
    caseWork: quickWork(db, user, e),
  };
  return NextResponse.json(data, { headers: NO_STORE });
}

/** 施工店舗の変更 (案件の予定だけ。案件のない予定は「詳しく変更」で店舗を変える。判定は見積・受注の画面と共通: case-store-view.ts) */
function quickStoreChange(db: Database, user: User, e: ScheduleEvent, canEdit: boolean, resolver: ReturnType<typeof createCaseResolver>): QuickStoreChange | undefined {
  const ref = resolver.ofEvent(e);
  const chain = ref ? caseChainOf(db, ref.id) : undefined;
  if (!chain) return undefined;
  return caseStoreChangeInfo(db, user, chain, canEdit, `${ref!.stage} ${chain.head.number}`);
}

/** 予定の削除 (小さな画面のいちばん下) */
function quickRemove(db: Database, user: User, e: ScheduleEvent, canEdit: boolean, order: Order | undefined, resolver: ReturnType<typeof createCaseResolver>): QuickRemove {
  // あわせて削除できる関連する予定 (引取 ⇄ 納品)
  const info = eventPair(db, e, resolver);
  const events = (info?.events ?? []).filter((x) => pairEditable(db, user, x)).map((x) => ({ id: x.id, label: `${SCHEDULE_KIND[x.kind].label} ${periodLabel(x)}${x.assigneeIds.length ? ` (${x.assigneeIds.map((a) => db.users.find((u) => u.id === a)?.name.split(/[\s　]/)[0] ?? "-").join("・")})` : ""}` }));
  const pair = info && events.length ? { want: info.want, events } : undefined;
  if (e.source !== "order") return { mode: "event", canDelete: canEditEvent(user, e), needsApproval: false, pair };
  if (!parseHandoverRef(e.sourceRef)) return { mode: "order", canDelete: false, needsApproval: false, orderHref: order ? `/orders/${order.id}` : undefined };
  const needsApproval = approvalSettings(db).scheduleChange && !skipsApproval(user, "handover_change");
  return { mode: "handover", canDelete: canEdit, needsApproval, approver: order && needsApproval ? (approverRole(db.users, order.storeId, false, user.id) === "admin" ? "管理者" : `${db.stores.find((s) => s.id === order.storeId)?.name ?? ""}の店長`) : undefined, orderHref: order ? `/orders/${order.id}` : undefined, pair };
}

/** 関連する予定をこの画面から動かせる・消せるか (受注の施工予定・完了した受注の予定は不可) */
function pairEditable(db: Database, user: User, x: ScheduleEvent): boolean {
  if (!canEditEvent(user, x)) return false;
  if (x.source !== "order") return true;
  if (!parseHandoverRef(x.sourceRef)) return false;
  const o = db.orders.find((y) => y.id === x.orderId);
  return Boolean(o && orderEditable(o));
}

/** 地図: Google マップ・経路案内・登録済みの住宅地図 (MapInfoCard と同じ場所の決め方。src/lib/maps/resolve.ts) */
function quickMap(db: Database, user: User, e: ScheduleEvent): QuickMap | undefined {
  if (!canViewRecordMap(user, db, "event", e.id)) return { hidden: true, address: "", heading: "", docs: [], canEdit: false, zenrinUrl: ZENRIN_GIS.url };
  const place = placeOf(db, "event", e.id, mapIndex(db));
  if (!place) return undefined;
  return {
    address: place.addressText,
    searchText: place.searchText,
    heading: place.heading,
    searchUrl: place.searchUrl,
    directionsUrl: place.directionsUrl,
    docs: place.documents.map((d) => ({ id: d.id, title: d.title })),
    canEdit: canEditRecordMap(user, db, "event", e.id) && Boolean(place.addressText),
    placeHref: place.location ? `/maps/locations/${place.location.id}` : undefined,
    zenrinUrl: ZENRIN_GIS.url,
  };
}

/** 引取・現見 ⇄ 納品 の相手 (src/lib/schedule-pair.ts) */
function quickPair(db: Database, user: User, e: ScheduleEvent, canEdit: boolean, labeler: ReturnType<typeof eventLabeler>, users: Map<string, string>, resolver: ReturnType<typeof createCaseResolver>): QuickPair | undefined {
  const info = eventPair(db, e, resolver);
  if (!info) return undefined;
  const orderOk = info.order ? orderEditable(info.order) : false;
  const rows = info.order?.handovers ?? [];
  const undated = info.undatedRows.map((id) => rows.find((r) => r.id === id)).filter((r): r is NonNullable<typeof r> => Boolean(r)).map((r) => handoverLabel(r));
  const addMode: QuickPair["addMode"] = info.order && info.undatedRows.length && orderOk ? "order" : "event";
  // 納品予定を追加できる: 引取・現見の予定で、納品の予定がないか、受注の日程に納品日の決まっていない品目がある
  const canAdd = canEdit && info.want === "delivery" && (addMode === "order" ? true : info.events.length === 0) && !(info.order && !orderOk);
  return {
    want: info.want,
    events: info.events.map((x) => ({ id: x.id, kind: x.kind, period: periodLabel(x), label: labeler.label(x).text, assignees: x.assigneeIds.map((a) => users.get(a) ?? "-"), date: x.date, startTime: x.startTime, endTime: x.endTime, slot: x.slot, assigneeIds: x.assigneeIds, canEdit: canEdit && pairEditable(db, user, x) })),
    canAdd,
    addMode,
    undated,
  };
}

/** 案件の確認・変更・追加 (明細・現場の住所・お客様の付け替え・新しい案件・作業の担当)。お客様のご要望 2026-11-25「③⑤⑨⑩④」 */
function quickCase(db: Database, user: User, e: ScheduleEvent, resolver: ReturnType<typeof createCaseResolver>): QuickCase | undefined {
  const ref = resolver.ofEvent(e);
  const chain = ref ? caseChainOf(db, ref.id) : undefined;
  const customerId = chain ? (chain.order?.customerId ?? chain.quote?.customerId ?? chain.inquiry?.customerId) : e.customerId;
  const customer = customerId ? db.customers.find((c) => c.id === customerId) : undefined;
  if (!chain && !customer) return undefined;
  const lock = chain?.order ? completedCaseLock(db, user, chain.order) : undefined;
  const canEdit = Boolean(chain) && canEditCaseStore(user, chain!.head.storeId) && !lock?.locked;
  const out: QuickCase = { caseId: chain?.head.id, caseNumber: chain?.head.number, canEdit, lock: lock?.locked ? completedLockMessage(lock.reason) : undefined };
  if (chain) {
    const site = chain.order ? (chain.order.siteAddress && chain.order.siteAddress !== customer?.address ? chain.order.siteAddress : "") : chain.quote?.siteAddress || chain.inquiry?.siteAddress || "";
    out.site = { address: site, requester: customer?.address ?? chain.inquiry?.intake?.address ?? "", corporate: customer?.type === "corporate", canEdit };
    const q = chain.quote;
    if (q) {
      const o = chain.order;
      const done = (st?: string) => st === "completed" || st === "invoiced" || st === "paid";
      const invoiced = Boolean(o && liveInvoicesOfOrder(db.invoices, o).length);
      const blocked = q.pendingChange
        ? "承認待ちの変更があります。承認・差戻しのあとに変更できます。"
        : invoiced
          ? "請求書を発行済みのため、明細・金額は変えられません (入金前なら本部・管理者が請求書を無効にしてから)。"
          : !["draft", "approved", "sent", "accepted"].includes(q.status)
            ? "この状態の見積は変更できません (承認待ち・失注など)。見積の画面で確かめてください。"
            : undefined;
      out.quote = {
        id: q.id,
        number: q.number,
        href: `/quotes/${q.id}`,
        draft: q.status === "draft",
        version: q.version,
        items: q.items,
        discount: q.discount,
        taxMode: taxModeOf(q),
        total: q.total,
        editable: canEdit && !blocked,
        blocked,
        smallLimit: approvalSettings(db).smallChangeLimit,
        confirmedSales: done(o?.status),
        ownApproval: skipsApproval(user, "quote_amend") && (user.role === "admin" || !done(o?.status)),
      };
    } else if (chain.order) {
      out.orderTotal = chain.order.total;
      out.orderHref = `/orders/${chain.order.id}`;
    }
    const blocker = caseRelinkBlocker(db, chain);
    out.relink = { canRelink: canEdit && !blocker, blocked: canEdit ? blocker : undefined, current: customer ? `${customer.name} 様 (${customer.code})` : undefined };
    if (chain.order) {
      const ws = workStaffOf(db, chain.order);
      const names = (ids: string[]) => ids.map((id) => db.users.find((u) => u.id === id)?.name ?? "-").join("・") || "未登録";
      out.workStaff = { href: `/orders/${chain.order.id}#work-staff`, source: ws.source, rows: WORK_ROLES.map((r) => ({ role: WORK_ROLE_LABEL[r], names: names(ws[r]) })) };
    }
  }
  if (customer && canLinkToCustomer(db, user, customer)) {
    out.newCase = {
      customerId: customer.id,
      customerName: customer.name,
      corporate: customer.type === "corporate",
      media: customer.type === "corporate" ? "business" : "repeat",
      storeId: chain?.head.storeId ?? e.storeId,
      categories: Object.entries(CATEGORY_LABEL).map(([id, label]) => ({ id, label })),
      kinds: (["survey", "site_survey", "onsite_quote", "measure", "pickup", "delivery", "install", "visit", "site"] as ScheduleKind[]).map((k) => ({ id: k, label: SCHEDULE_KIND[k].label })),
    };
  }
  return out;
}

/** 担当店舗・担当者への依頼 (メンション。お客様のご要望 2026-11-25「⑪」) */
function quickRequest(db: Database, e: ScheduleEvent, resolver: ReturnType<typeof createCaseResolver>): QuickRequest | undefined {
  const ref = resolver.ofEvent(e);
  const chain = ref ? caseChainOf(db, ref.id) : undefined;
  const customerId = chain ? (chain.order?.customerId ?? chain.quote?.customerId ?? chain.inquiry?.customerId) : e.customerId;
  if (!chain && !customerId) return undefined;
  const customer = customerId ? db.customers.find((c) => c.id === customerId) : undefined;
  const name = (id: string) => db.users.find((u) => u.id === id)?.name ?? "-";
  const storeName = (id: string) => db.stores.find((s) => s.id === id)?.name ?? id;
  const ids = chain ? [chain.order?.id, chain.quote?.id, chain.inquiry?.id] : [customerId];
  const open = caseRequestsOf(db, ids)
    .filter((t) => t.taskStatus && t.taskStatus !== "confirmed")
    .slice(0, 4)
    .map((t) => ({ id: t.id, title: t.title, status: TASK_STATUS[t.taskStatus!].label, at: t.createdAt, from: name(t.createdBy), to: t.assigneeStoreId ? `${storeName(t.assigneeStoreId)} (店舗)` : (t.assigneeIds ?? []).map(name).join("・") }));
  return {
    caseLabel: [chain ? `${ref?.stage ?? ""} ${chain.head.number}`.trim() : "", customer ? `${customer.name} 様` : ""].filter(Boolean).join(" "),
    storeId: chain?.head.storeId ?? e.storeId,
    stores: db.stores.map((s) => ({ id: s.id, name: s.name })),
    kinds: CASE_REQUEST_KINDS.map((k) => ({ id: k, label: CASE_REQUEST_KIND[k].label, hint: CASE_REQUEST_KIND[k].hint })),
    open,
  };
}

/**
 * この案件で (お客様のご要望 2026-11-25「②〜⑧」): 手書きの見積書の撮影 → 見積 / 受注 (品目ごとの日程つき) / 資料・写真 (種類つき) / 帳票 (見積書・請求書・領収書)。
 * それぞれの権限は画面と同じ (見積を作る・受注にする = canEditCaseStore、資料 = canAddToParent、帳票の出力 = 記録を見られる人、請求書の発行 = 店長・本部・管理者)
 */
function quickWork(db: Database, user: User, e: ScheduleEvent): QuickWork | undefined {
  const chain = caseChainOf(db, e.orderId ?? e.quoteId ?? e.inquiryId);
  const customerId = chain ? (chain.order?.customerId ?? chain.quote?.customerId ?? chain.inquiry?.customerId) : e.customerId;
  const customer = customerId ? db.customers.find((c) => c.id === customerId) : undefined;
  if (!chain && !customer) return undefined;
  const storeId = chain?.head.storeId ?? customer!.storeId;
  const canCase = canEditCaseStore(user, storeId);
  const out: QuickWork = { caseLabel: [chain ? `${chain.head.number}` : "", customer ? `${customer.name} 様` : ""].filter(Boolean).join(" ") };
  const today = toDateKey(new Date());
  const q = chain?.quote && !["rejected", "expired"].includes(chain.quote.status) ? chain.quote : undefined;
  const o = chain?.order && chain.order.status !== "cancelled" ? chain.order : undefined;
  // ② 見積書の撮影 (見積のない案件。案件がなければお客様の新しい見積)
  if (!q && !o && canCase) out.capture = { inquiryId: chain?.inquiry?.id, customerId: customer?.id, ...(isPlaceholderCustomer(customer) ? { placeholder: true } : {}) };
  // 見積・受注のある案件にも、別の見積 (追加工事・仕様や金額の違う案) を作れる (1 つの案件に複数の見積。src/lib/case-group.ts)
  else if (chain && canCase) out.capture = { caseId: caseIdOf(db, chain.head.id), customerId: customer?.id, additional: true };
  if (q) out.quote = { id: q.id, number: q.number, status: QUOTE_STATUS[q.status]?.label ?? q.status, href: `/quotes/${q.id}` };
  if (o) out.order = { id: o.id, number: o.number, status: ORDER_STATUS[o.status]?.label ?? o.status, href: `/orders/${o.id}` };
  // ③④ 受注にする (品目ごとの日程つき)
  if (q && !o && canCase) {
    // 手書きの見積書に引取日がなければ、訪問 (見積・現調・現見) の日 = その場で作業 (現見) を初期値にする。登録済みの引き取り・納品の予定があればその日程を引き継ぐ
    const plan = quoteOrderPlan(db, user, q, { fallbackDate: VISIT_KINDS.includes(e.kind) || e.date >= today ? e.date : today, workerIds: e.assigneeIds, inquiryId: chain?.inquiry?.id });
    if (plan && "blocked" in plan) out.orderBlocked = plan.blocked;
    else if (plan) out.toOrder = plan;
  }
  // ⑤ 資料・写真 (登録先は一番進んだ記録)
  const headType = o ? "order" : q ? "quote" : chain?.inquiry ? "inquiry" : undefined;
  const headId = o?.id ?? q?.id ?? chain?.inquiry?.id;
  if (headType && headId) {
    const parent = resolveParent(db, headType, headId);
    if (parent) {
      const ids = new Set([chain?.inquiry?.id, q?.id, o?.id].filter(Boolean));
      const all = db.attachments.filter((a) => (a.parentType === "inquiry" || a.parentType === "quote" || a.parentType === "order") && ids.has(a.parentId) && canViewAttachment(user, db, a)).sort((a, b) => (b.takenAt ?? b.uploadedAt).localeCompare(a.takenAt ?? a.uploadedAt));
      out.files = { parentType: headType, parentId: headId, parentLabel: parent.label, canAdd: canAddToParent(user, db, parent), accept: ATTACHMENT_ACCEPT, items: all.slice(0, 24).map((a) => toView(db, user, a)), more: Math.max(0, all.length - 24) };
    }
  }
  // ⑥⑦⑧ 帳票
  const docs: NonNullable<QuickWork["docs"]> = { batchHref: `/schedule/print?date=${e.date}&store=${e.storeId}` };
  if (q) docs.quote = { id: q.id, number: q.number, version: q.version, draft: q.status === "draft" || q.status === "pending_approval", outputs: outputsOf(db, "quote", q.id, q.version).length, canPrint: canOutputDocument(user, quoteAccessInfo(db, user, q).access) };
  if (o) {
    docs.delivery = { orderId: o.id, number: o.number, outputs: outputsOf(db, "invoice", o.id, undefined, "delivery").length, canPrint: canOutputDocument(user, orderAccessInfo(db, user, o).access) };
    const inv = liveInvoicesOfOrder(db.invoices, o)[0];
    const w = receiptWanted(o);
    const canSetWanted = canEditCaseStore(user, o.storeId) || canAccessStore(user, o.storeId);
    if (inv) {
      const access = invoiceAccessInfo(db, user, inv).access;
      docs.invoice = { id: inv.id, number: inv.number, total: inv.total, paidAmount: inv.paidAmount, outputs: outputsOf(db, "invoice", inv.id).length, canPrint: canOutputDocument(user, access), href: `/invoices/${inv.id}` };
      const d = receiptDraft(db, inv, o);
      const head = receiptHeading(customer, inv, o);
      docs.receipt = {
        wanted: w.wanted,
        auto: w.auto,
        reason: w.reason,
        canSetWanted,
        orderId: o.id,
        issued: (db.receipts ?? []).filter((r) => r.invoiceId === inv.id).map((r) => ({ id: r.id, number: r.number, amount: r.amount, parts: r.parts.map((p) => `${partLabel(p)} ¥${p.amount.toLocaleString("ja-JP")}`).join("・"), outputs: outputsOf(db, "receipt", r.id).length, status: r.status })),
        form: canIssueReceipt(user, access) && d.remaining > 0 && inv.status !== "void" ? { invoiceId: inv.id, invoiceNumber: inv.number, total: inv.total, paidAmount: inv.paidAmount, remaining: d.remaining, amount: d.amount, parts: d.parts, beforePayment: d.beforePayment, addressee: head.addressee, honorific: head.honorific, purpose: head.purpose } : undefined,
        checks: receiptChecks(db, inv, o),
      };
    } else {
      const can = canIssueFor(db, o);
      const allowed = canIssueInvoice(user) && canAccessStore(user, o.storeId);
      docs.invoiceIssue = { ok: can.ok && allowed, pre: can.pre, reason: !can.ok ? can.reason : allowed ? undefined : "請求書の発行は店長・本部・管理者 (その店舗) が行えます。", orderId: o.id, total: o.total, needsSetup: can.needsSetup };
      docs.receipt = { wanted: w.wanted, auto: w.auto, reason: w.reason, canSetWanted, orderId: o.id, issued: [], checks: [] };
    }
  }
  if (docs.quote || docs.invoice || docs.invoiceIssue || docs.delivery) out.docs = docs;
  return out;
}
