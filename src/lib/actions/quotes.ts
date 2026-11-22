"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, mutate, newId, nextNumber, nowIso } from "@/lib/db/store";
import type { Approval, Database, Quote, QuoteItem, StoreId, User } from "@/lib/db/types";
import { AUTO_APPROVAL_NOTE, settleOwnApproval } from "@/lib/approval-decide";
import { addDays, toDateKey } from "@/lib/format";
import { CATEGORY_LABEL, CHANNEL_LABEL } from "@/lib/constants";
import { approvalSettings, manYen } from "@/lib/approval-rules";
import { notifyNewApprovals } from "@/lib/notify/approvals";
import { syncOrderEvent } from "@/lib/db/schedule";
import { approverLabel, approverRole } from "@/lib/auth/permissions";
import { relinkDocumentAttachments } from "@/lib/attachments";
import { documentSettings } from "@/lib/doc-settings";
import { quoteTotals } from "@/lib/quote-calc";
import { siteInfoFromForm } from "@/lib/site-info";
import { plannedFromSiteInfo } from "@/lib/case-status";
import { syncHandoverMemo } from "@/lib/db/schedule";
import { assertStore, choice, fail, requireActionUser, resolveStoreId, str, withMsg } from "./guards";
import { propagateOrderSite } from "@/lib/maps/store";
import { quoteCompletedLock, completedLockMessage } from "@/lib/case-access";

function parseItems(formData: FormData, back: string): QuoteItem[] {
  let raw: unknown;
  try {
    raw = JSON.parse(str(formData, "items") || "[]");
  } catch {
    fail(back, "明細の形式が不正です。");
  }
  if (!Array.isArray(raw) || raw.length === 0) fail(back, "明細を 1 行以上入力してください。");
  const items: QuoteItem[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    const qty = Number(r.qty);
    const unitPrice = Number(r.unitPrice);
    const name = String(r.name ?? "").trim();
    if (!name) continue;
    if (!Number.isFinite(qty) || qty <= 0) fail(back, `「${name}」の数量が不正です。`);
    // 値引きの行は単価がマイナス
    if (!Number.isFinite(unitPrice)) fail(back, `「${name}」の単価が不正です。`);
    items.push({
      id: newId("qi"),
      productId: r.productId ? String(r.productId) : undefined,
      name,
      spec: r.spec ? String(r.spec) : undefined,
      qty,
      unit: String(r.unit ?? "式"),
      unitPrice,
      amount: Math.round(qty * unitPrice),
    });
  }
  if (items.length === 0) fail(back, "明細を 1 行以上入力してください。");
  return items;
}

/** 施工場所 (お客様の住所と違うとき) と領収書の宛名。フォームに欄がないときは undefined (変更しない) */
function siteFieldsOf(formData: FormData): { siteAddress?: string; receiptName?: string } | undefined {
  if (!formData.has("siteAddress") && !formData.has("receiptName")) return undefined;
  return { siteAddress: str(formData, "siteAddress").slice(0, 200) || undefined, receiptName: str(formData, "receiptName").slice(0, 100) || undefined };
}

/**
 * 施工場所・領収書の宛名を見積に反映する (金額に関わらないので承認は不要)。受注済みなら受注にも反映する。
 * 変更があった項目の監査ログを書き、変更の一覧を返す
 */
function applySiteFields(db: Database, q: Quote, next: { siteAddress?: string; receiptName?: string }, user: User): string[] {
  const before = { siteAddress: q.siteAddress, receiptName: q.receiptName };
  const changes = (["siteAddress", "receiptName"] as const).filter((f) => (before[f] ?? "") !== (next[f] ?? "")).map((f) => ({ field: f, before: before[f], after: next[f] }));
  if (!changes.length) return [];
  q.siteAddress = next.siteAddress;
  q.receiptName = next.receiptName;
  addAudit(db, { userId: user.id, action: "update", entity: "quote", entityId: q.id, entityLabel: q.number, summary: `${changes.map((c) => (c.field === "siteAddress" ? "施工場所" : "領収書の宛名")).join("・")}を変更`, storeId: q.storeId, changes });
  const o = q.orderId ? db.orders.find((x) => x.id === q.orderId && x.status !== "cancelled") : undefined;
  if (o) {
    const customer = db.customers.find((c) => c.id === q.customerId);
    const ob = { siteAddress: o.siteAddress, receiptName: o.receiptName };
    if (changes.some((c) => c.field === "siteAddress")) o.siteAddress = next.siteAddress || customer?.address || o.siteAddress;
    if (changes.some((c) => c.field === "receiptName")) o.receiptName = next.receiptName;
    const oc = (["siteAddress", "receiptName"] as const).filter((f) => (ob[f] ?? "") !== (o[f] ?? "")).map((f) => ({ field: f, before: ob[f], after: o[f] }));
    if (oc.length) {
      o.updatedAt = nowIso();
      if (oc.some((c) => c.field === "siteAddress") && db.schedule.some((e) => e.orderId === o.id && e.source === "order")) syncOrderEvent(db, o, user.id);
      if (oc.some((c) => c.field === "siteAddress")) propagateOrderSite(db, user, o, ob.siteAddress);
      addAudit(db, { userId: user.id, action: "update", entity: "order", entityId: o.id, entityLabel: o.number, summary: `見積 ${q.number} の変更に合わせて${oc.map((c) => (c.field === "siteAddress" ? "施工場所" : "領収書の宛名")).join("・")}を変更`, storeId: o.storeId, changes: oc });
    }
  }
  return changes.map((c) => c.field);
}

function calc(items: QuoteItem[], discount: number, taxIncluded = false) {
  return quoteTotals(items, discount, taxIncluded);
}

/** 見積から作った受注に、有効な (無効化していない) 請求書があるか。あれば金額は変えられない */
function hasActiveInvoice(db: Database, quoteId: string): boolean {
  return db.orders.some((o) => o.quoteId === quoteId && o.status !== "cancelled" && db.invoices.some((i) => i.id === o.invoiceId && i.status !== "void"));
}

/** 見積・受注の承認者 (金額が基準以上、本部の案件、承認できる店長がいない店舗は管理者) */
function requiredRole(db: Database, storeId: StoreId, amount: number, requesterId: string): "store_manager" | "admin" {
  return approverRole(db.users, storeId, amount >= approvalSettings(db).quoteAdminThreshold, requesterId);
}

/** 見積の承認の申請。管理者の申請は承認を省略して、その場で承認済みにする (auto = true) */
function requestApproval(db: Database, q: Quote, user: User, comment?: string): { role: "store_manager" | "admin"; auto: boolean } {
  const role = requiredRole(db, q.storeId, q.total, user.id);
  const approval: Approval = {
    id: newId("ap"),
    type: "quote",
    targetId: q.id,
    title: `${q.number} ${q.title}`,
    amount: q.total,
    storeId: q.storeId,
    requestedBy: user.id,
    requiredRole: role,
    status: "pending",
    requestComment: comment || undefined,
    createdAt: nowIso(),
  };
  db.approvals.push(approval);
  q.status = "pending_approval";
  addAudit(db, { userId: user.id, action: "submit", entity: "quote", entityId: q.id, entityLabel: q.number, summary: `見積の承認を申請 (${approverLabel(role, q.total >= approvalSettings(db).quoteAdminThreshold, manYen(approvalSettings(db).quoteAdminThreshold))})`, storeId: q.storeId });
  return { role, auto: settleOwnApproval(db, approval, user, `/quotes/${q.id}`) };
}

/** 申請のあとの案内 (管理者の申請は承認を省略して承認済み) */
const submittedText = (r: { role: string; auto: boolean }) => (r.auto ? `${AUTO_APPROVAL_NOTE}し、承認済みにしました。` : `${r.role === "admin" ? "管理者" : "店長"}へ承認を申請しました。`);

export async function createQuote(formData: FormData) {
  const user = await requireActionUser();
  const back = "/quotes/new";
  const customerId = str(formData, "customerId");
  const title = str(formData, "title");
  if (!customerId) fail(back, "お客様を選択してください。");
  if (!title) fail(back, "件名を入力してください。");
  const items = parseItems(formData, back);
  const intent = str(formData, "intent");
  const id = newId("q");
  let submitted = "";
  const approvalIds: string[] = [];
  await mutate((db) => {
    const documentId = str(formData, "documentId");
    const doc = documentId ? db.documents.find((d) => d.id === documentId) : undefined;
    if (doc && (doc.linkedId || doc.status === "discarded")) fail("/capture?doc=" + doc.id, "この取込書類はすでに登録済み (または破棄済み) です。");
    const customer = db.customers.find((c) => c.id === customerId);
    if (!customer) fail(back, "お客様が見つかりません。");
    // 店舗のロールは自店舗のお客様だけ (一覧で見えないお客様の見積を作らない)
    assertStore(user, customer.storeId, back);
    const storeId = resolveStoreId(user, str(formData, "storeId"), customer.storeId);
    assertStore(user, storeId, back);
    const today = toDateKey(new Date());
    const now = nowIso();
    const taxIncluded = str(formData, "taxIncluded") === "1";
    const t = calc(items, Number(str(formData, "discount")) || 0, taxIncluded);
    if (t.total <= 0) fail(back, "合計が 0 円以下です。明細を確認してください。");
    const estimator = str(formData, "estimatorId");
    const quoteDate = str(formData, "quoteDate");
    const handedOver = formData.get("handedOver") === "on";
    const q: Quote = {
      id,
      number: nextNumber(db, "Q", db.quotes, today),
      version: 1,
      customerId,
      inquiryId: str(formData, "inquiryId") || undefined,
      storeId,
      title,
      category: choice(formData, "category", CATEGORY_LABEL, "tatami"),
      items,
      ...t,
      status: "draft",
      validUntil: str(formData, "validUntil") || addDays(today, documentSettings(db).quoteValidDays),
      createdBy: user.id,
      notes: str(formData, "notes") || undefined,
      workDetails: str(formData, "workDetails") || undefined,
      source: choice(formData, "source", ["manual", "ocr", "ai_phone"] as const, "manual"),
      documentId: str(formData, "documentId") || undefined,
      taxIncluded: taxIncluded || undefined,
      siteInfo: siteInfoFromForm(formData),
      paperNo: str(formData, "paperNo") || undefined,
      estimatorId: estimator && db.users.some((u) => u.id === estimator) ? estimator : user.id,
      ...(siteFieldsOf(formData) ?? {}),
      handedOver: handedOver || undefined,
      issuedAt: handedOver && /^\d{4}-\d{2}-\d{2}$/.test(quoteDate) ? quoteDate : undefined,
      createdAt: now,
      updatedAt: now,
    };
    db.quotes.push(q);
    addAudit(db, { userId: user.id, action: "create", entity: "quote", entityId: id, entityLabel: q.number, summary: `見積を作成 (${customer.name} 様 / ${title} / ${t.total.toLocaleString("ja-JP")}円)`, storeId });
    const inq = db.inquiries.find((i) => i.id === q.inquiryId);
    if (inq) {
      inq.quoteId = id;
      if (inq.status === "new" || inq.status === "in_progress") inq.status = "quoted";
      inq.updatedAt = now;
    }
    if (doc) {
      doc.status = "confirmed";
      doc.linkedType = "quote";
      doc.linkedId = id;
      relinkDocumentAttachments(db, doc.id, { type: "quote", id, customerId: q.customerId, storeId });
    }
    if (intent === "submit") {
      submitted = submittedText(requestApproval(db, q, user));
      approvalIds.push(db.approvals[db.approvals.length - 1].id);
    }
  });
  await notifyNewApprovals(approvalIds, user.id);
  revalidatePath("/quotes");
  redirect(withMsg(`/quotes/${id}`, intent === "submit" ? `見積を作成し、${submitted}` : "見積を下書き保存しました。"));
}

export async function updateQuote(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/quotes/${id}/edit`;
  const items = parseItems(formData, back);
  const intent = str(formData, "intent");
  let message = "見積を更新しました。";
  const approvalIds: string[] = [];
  await mutate((db) => {
    const q = db.quotes.find((x) => x.id === id);
    if (!q) fail("/quotes", "見積が見つかりません。");
    assertStore(user, q.storeId, back);
    const lock = quoteCompletedLock(db, user, q);
    if (lock.locked) fail(`/quotes/${id}`, completedLockMessage(lock.reason));
    const taxIncluded = str(formData, "taxIncluded") === "1";
    const t = calc(items, Number(str(formData, "discount")) || 0, taxIncluded);
    if (t.total <= 0) fail(back, "合計が 0 円以下です。明細を確認してください。");
    const now = nowIso();
    const site = siteFieldsOf(formData);
    if (q.status === "draft") {
      if (site) applySiteFields(db, q, site, user);
      q.taxIncluded = taxIncluded || undefined;
      const est = str(formData, "estimatorId");
      if (est && db.users.some((u) => u.id === est)) q.estimatorId = est;
      q.title = str(formData, "title") || q.title;
      q.category = choice(formData, "category", CATEGORY_LABEL, q.category);
      q.validUntil = str(formData, "validUntil") || q.validUntil;
      q.notes = str(formData, "notes") || undefined;
      q.workDetails = str(formData, "workDetails") || undefined;
      q.items = items;
      Object.assign(q, t);
      q.updatedAt = now;
      addAudit(db, { userId: user.id, action: "update", entity: "quote", entityId: id, entityLabel: q.number, summary: `見積 (下書き) を更新 (合計 ${t.total.toLocaleString("ja-JP")}円)`, storeId: q.storeId });
      if (intent === "submit") {
        const r = requestApproval(db, q, user);
        approvalIds.push(db.approvals[db.approvals.length - 1].id);
        message = `見積を更新し、${submittedText(r)}`;
      }
    } else if (q.status === "approved" || q.status === "sent" || q.status === "accepted") {
      if (q.pendingChange) fail(`/quotes/${id}`, "すでに承認待ちの変更があります。");
      const title = str(formData, "title") || q.title;
      const workDetails = str(formData, "workDetails");
      const notes = str(formData, "notes");
      const sameItems = JSON.stringify(items.map((i) => [i.name, i.spec ?? "", i.qty, i.unit, i.unitPrice])) === JSON.stringify(q.items.map((i) => [i.name, i.spec ?? "", i.qty, i.unit, i.unitPrice]));
      const sameContent = sameItems && t.discount === q.discount && taxIncluded === Boolean(q.taxIncluded) && title === q.title && workDetails === (q.workDetails ?? "") && notes === (q.notes ?? "");
      const siteChanged = Boolean(site) && ((site!.siteAddress ?? "") !== (q.siteAddress ?? "") || (site!.receiptName ?? "") !== (q.receiptName ?? ""));
      // 施工場所・領収書の宛名だけの変更は、承認・変更理由なしで反映する (金額・契約内容に関わらない)
      if (sameContent && siteChanged) {
        const changed = applySiteFields(db, q, site!, user);
        q.updatedAt = now;
        message = `${changed.map((f) => (f === "siteAddress" ? "施工場所" : "領収書の宛名")).join("・")}を変更しました${q.orderId ? " (受注にも反映しました)" : ""}。`;
        return;
      }
      if (sameContent) fail(back, "変更された内容がありません。");
      if (hasActiveInvoice(db, q.id)) fail(`/quotes/${id}`, "請求書を発行済みの案件は金額を変更できません。入金前であれば、請求書を無効化してから変更を申請してください。");
      const reason = str(formData, "reason");
      if (!reason) fail(back, "確定済みの見積を変更するには変更理由が必要です。");
      if (siteChanged) applySiteFields(db, q, site!, user);
      q.pendingChange = { items, ...t, taxIncluded, title, workDetails, notes, reason, requestedBy: user.id, requestedAt: now };
      q.updatedAt = now;
      const role = requiredRole(db, q.storeId, Math.max(t.total, q.total), user.id);
      const amend: Approval = {
        id: newId("ap"),
        type: "quote_amend",
        targetId: q.id,
        title: `${q.number} ${q.title} (${t.total !== q.total ? "金額変更" : "内容変更"} 第${q.version + 1}版)`,
        amount: t.total,
        storeId: q.storeId,
        requestedBy: user.id,
        requiredRole: role,
        status: "pending",
        requestComment: `${t.total !== q.total ? `変更前 ¥${q.total.toLocaleString("ja-JP")} → 変更後 ¥${t.total.toLocaleString("ja-JP")}` : `金額の変更なし (¥${q.total.toLocaleString("ja-JP")})`}${title !== q.title ? ` / 件名: ${title}` : ""}${workDetails !== (q.workDetails ?? "") ? " / 施工内容を変更" : ""} / 理由: ${reason}`,
        createdAt: now,
      };
      db.approvals.push(amend);
      approvalIds.push(amend.id);
      addAudit(db, { userId: user.id, action: "submit", entity: "quote", entityId: id, entityLabel: q.number, summary: `確定見積の金額変更を申請 (${q.total.toLocaleString("ja-JP")}円 → ${t.total.toLocaleString("ja-JP")}円)`, storeId: q.storeId, changes: [{ field: "total", before: q.total, after: t.total }] });
      message = settleOwnApproval(db, amend, user, `/quotes/${id}`)
        ? `${AUTO_APPROVAL_NOTE}し、変更を第${q.version}版として反映しました。`
        : `変更を申請しました。${role === "admin" ? "管理者" : "店長"}の承認後に第${q.version + 1}版として反映されます。`;
    } else {
      fail(`/quotes/${id}`, "この状態の見積は編集できません。");
    }
  });
  await notifyNewApprovals(approvalIds, user.id);
  revalidatePath("/quotes");
  redirect(withMsg(`/quotes/${id}`, message));
}

export async function submitQuote(id: string) {
  const user = await requireActionUser();
  const back = `/quotes/${id}`;
  let submitted = "";
  let approvalId = "";
  await mutate((db) => {
    const q = db.quotes.find((x) => x.id === id);
    if (!q) fail("/quotes", "見積が見つかりません。");
    assertStore(user, q.storeId, back);
    if (q.status !== "draft") fail(back, "下書きの見積のみ申請できます。");
    submitted = submittedText(requestApproval(db, q, user));
    approvalId = db.approvals[db.approvals.length - 1].id;
  });
  await notifyNewApprovals([approvalId], user.id);
  revalidatePath(back);
  redirect(withMsg(back, submitted));
}

export async function sendQuote(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/quotes/${id}`;
  const channel = choice(formData, "channel", CHANNEL_LABEL, "email");
  await mutate((db) => {
    const q = db.quotes.find((x) => x.id === id);
    if (!q) fail("/quotes", "見積が見つかりません。");
    assertStore(user, q.storeId, back);
    if (q.status !== "approved" && q.status !== "sent") fail(back, "承認済みの見積のみ送付できます。");
    const now = nowIso();
    q.status = "sent";
    q.issuedAt = q.issuedAt ?? toDateKey(new Date());
    q.sentVia = channel;
    q.updatedAt = now;
    db.commLogs.push({ id: newId("cl"), customerId: q.customerId, channel, direction: "outbound", subject: `お見積書 ${q.number} 送付`, body: `${q.title} のお見積書 (合計 ¥${q.total.toLocaleString("ja-JP")}) を${CHANNEL_LABEL[channel]}でお送りしました。`, at: now, userId: user.id, relatedType: "quote", relatedId: q.id });
    const inq = db.inquiries.find((i) => i.id === q.inquiryId);
    if (inq && inq.status !== "won") inq.status = "quoted";
    addAudit(db, { userId: user.id, action: "send", entity: "quote", entityId: id, entityLabel: q.number, summary: `見積書を送付 (${CHANNEL_LABEL[channel]})`, storeId: q.storeId });
  });
  revalidatePath(back);
  redirect(withMsg(back, `見積書を${CHANNEL_LABEL[channel]}で送付した記録を残しました。`));
}

/** お客様の承諾 → 受注 (契約承認待ち) を作成 */
export async function convertQuoteToOrder(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/quotes/${id}`;
  let orderId = "";
  let role = "";
  let auto = false;
  let approvalId = "";
  await mutate((db) => {
    const q = db.quotes.find((x) => x.id === id);
    if (!q) fail("/quotes", "見積が見つかりません。");
    assertStore(user, q.storeId, back);
    if (!["approved", "sent"].includes(q.status)) fail(back, "承認済み・送付済みの見積のみ受注にできます。");
    if (q.orderId) fail(back, "この見積はすでに受注登録されています。");
    const customer = db.customers.find((c) => c.id === q.customerId);
    const now = nowIso();
    const today = toDateKey(new Date());
    orderId = newId("o");
    const scheduledStart = str(formData, "scheduledStart") || undefined;
    const workerIds = formData.getAll("workerIds").map(String).filter(Boolean);
    db.orders.push({
      id: orderId,
      number: nextNumber(db, "O", db.orders, today),
      quoteId: q.id,
      customerId: q.customerId,
      storeId: q.storeId,
      title: q.title,
      category: q.category,
      contractDate: today,
      total: q.total,
      status: "pending_approval",
      scheduledStart,
      scheduledEnd: scheduledStart,
      workerIds,
      siteAddress: str(formData, "siteAddress") || q.siteAddress || customer?.address || "",
      receiptName: q.receiptName,
      workDetails: q.workDetails,
      siteInfo: q.siteInfo,
      plannedPayment: plannedFromSiteInfo(q.siteInfo?.paymentMethod),
      progressNotes: [{ id: newId("pn"), at: now, userId: user.id, kind: "note", body: str(formData, "note") || "お客様よりご承諾をいただきました。契約承認を申請します。" }],
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
    });
    q.orderId = orderId;
    q.updatedAt = now;
    // 施工予定日を入れて受注登録した場合は、契約承認前でも予定表に施工予定を載せて日程を押さえる
    const created = db.orders[db.orders.length - 1];
    if (created.scheduledStart) syncOrderEvent(db, created, user.id);
    syncHandoverMemo(db, created);
    const r = requiredRole(db, q.storeId, q.total, user.id);
    role = r;
    approvalId = newId("ap");
    const contract: Approval = { id: approvalId, type: "order", targetId: orderId, title: `${db.orders[db.orders.length - 1].number} ${q.title}`, amount: q.total, storeId: q.storeId, requestedBy: user.id, requiredRole: r, status: "pending", requestComment: str(formData, "note") || undefined, createdAt: now };
    db.approvals.push(contract);
    addAudit(db, { userId: user.id, action: "create", entity: "order", entityId: orderId, entityLabel: db.orders[db.orders.length - 1].number, summary: `見積 ${q.number} から受注を登録し契約承認を申請`, storeId: q.storeId });
    auto = settleOwnApproval(db, contract, user, back);
  });
  await notifyNewApprovals([approvalId], user.id);
  revalidatePath("/orders");
  redirect(withMsg(`/orders/${orderId}`, auto ? `受注を登録しました。${AUTO_APPROVAL_NOTE}し、契約を確定しました。施工手配へ進めます。` : `受注を登録しました。${role === "admin" ? "管理者" : "店長"}の契約承認後に施工手配へ進めます。`));
}

export async function markQuoteLost(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/quotes/${id}`;
  await mutate((db) => {
    const q = db.quotes.find((x) => x.id === id);
    if (!q) fail("/quotes", "見積が見つかりません。");
    assertStore(user, q.storeId, back);
    if (!["approved", "sent", "draft"].includes(q.status)) fail(back, "この状態の見積は失注にできません。");
    q.status = "rejected";
    q.updatedAt = nowIso();
    const inq = db.inquiries.find((i) => i.id === q.inquiryId);
    if (inq) inq.status = "lost";
    addAudit(db, { userId: user.id, action: "status", entity: "quote", entityId: id, entityLabel: q.number, summary: `失注として登録${str(formData, "reason") ? ` (${str(formData, "reason")})` : ""}`, storeId: q.storeId });
  });
  revalidatePath(back);
  redirect(withMsg(back, "失注として登録しました。"));
}

export async function deleteQuote(id: string) {
  const user = await requireActionUser();
  await mutate((db) => {
    const idx = db.quotes.findIndex((x) => x.id === id);
    if (idx < 0) fail("/quotes", "見積が見つかりません。");
    const q = db.quotes[idx];
    assertStore(user, q.storeId, `/quotes/${id}`);
    if (q.status !== "draft") fail(`/quotes/${id}`, "下書きの見積のみ削除できます。");
    db.quotes.splice(idx, 1);
    // 取込書類から作った見積なら、書類を確認待ちに戻し、元の画像も書類に戻す
    const doc = q.documentId ? db.documents.find((d) => d.id === q.documentId && d.linkedType === "quote" && d.linkedId === id) : undefined;
    if (doc) {
      doc.status = "extracted";
      doc.linkedType = undefined;
      doc.linkedId = undefined;
      for (const a of db.attachments) {
        if (a.parentType === "quote" && a.parentId === id && a.fileName === doc.fileName.slice(0, 200)) {
          a.parentType = "document";
          a.parentId = doc.id;
          a.storeId = doc.storeId;
        }
      }
    }
    const inq = db.inquiries.find((i) => i.quoteId === id);
    if (inq) {
      inq.quoteId = undefined;
      if (inq.status === "quoted") inq.status = "in_progress";
    }
    addAudit(db, { userId: user.id, action: "delete", entity: "quote", entityId: id, entityLabel: q.number, summary: `見積 (下書き) を削除`, storeId: q.storeId });
  });
  revalidatePath("/quotes");
  redirect(withMsg("/quotes", "下書きの見積を削除しました。"));
}
