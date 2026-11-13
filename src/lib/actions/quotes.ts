"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addAudit, mutate, newId, nextNumber, nowIso } from "@/lib/db/store";
import type { Channel, Database, Quote, QuoteItem, ServiceCategory, StoreId, User } from "@/lib/db/types";
import { addDays, calcTax, toDateKey } from "@/lib/format";
import { APPROVAL_RULES, CATEGORY_LABEL, CHANNEL_LABEL } from "@/lib/constants";
import { syncOrderEvent } from "@/lib/db/schedule";
import { approverLabel, approverRole } from "@/lib/auth/permissions";
import { relinkDocumentAttachments } from "@/lib/attachments";
import { assertStore, choice, fail, requireActionUser, resolveStoreId, str, withMsg } from "./guards";

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
    if (!Number.isFinite(unitPrice) || unitPrice < 0) fail(back, `「${name}」の単価が不正です。`);
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

function calc(items: QuoteItem[], discount: number) {
  const subtotal = items.reduce((s, i) => s + i.amount, 0);
  const d = Math.min(Math.max(0, discount), subtotal);
  const tax = calcTax(subtotal - d);
  return { subtotal, discount: d, tax, total: subtotal - d + tax };
}

/** 見積から作った受注に、有効な (無効化していない) 請求書があるか。あれば金額は変えられない */
function hasActiveInvoice(db: Database, quoteId: string): boolean {
  return db.orders.some((o) => o.quoteId === quoteId && o.status !== "cancelled" && db.invoices.some((i) => i.id === o.invoiceId && i.status !== "void"));
}

/** 見積・受注の承認者 (金額が基準以上、本部の案件、承認できる店長がいない店舗は管理者) */
function requiredRole(db: Database, storeId: StoreId, amount: number, requesterId: string): "store_manager" | "admin" {
  return approverRole(db.users, storeId, amount >= APPROVAL_RULES.quoteAdminThreshold, requesterId);
}

function requestApproval(db: Database, q: Quote, user: User, comment?: string) {
  const role = requiredRole(db, q.storeId, q.total, user.id);
  db.approvals.push({
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
  });
  q.status = "pending_approval";
  addAudit(db, { userId: user.id, action: "submit", entity: "quote", entityId: q.id, entityLabel: q.number, summary: `見積の承認を申請 (${approverLabel(role, q.total >= APPROVAL_RULES.quoteAdminThreshold, "¥50万")})`, storeId: q.storeId });
  return role;
}

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
  let role: string | null = null;
  await mutate((db) => {
    const customer = db.customers.find((c) => c.id === customerId);
    if (!customer) fail(back, "お客様が見つかりません。");
    // 店舗のロールは自店舗のお客様だけ (一覧で見えないお客様の見積を作らない)
    assertStore(user, customer.storeId, back);
    const storeId = resolveStoreId(user, str(formData, "storeId"), customer.storeId);
    assertStore(user, storeId, back);
    const today = toDateKey(new Date());
    const now = nowIso();
    const t = calc(items, Number(str(formData, "discount")) || 0);
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
      validUntil: str(formData, "validUntil") || addDays(today, 30),
      createdBy: user.id,
      notes: str(formData, "notes") || undefined,
      source: choice(formData, "source", ["manual", "ocr", "ai_phone"] as const, "manual"),
      documentId: str(formData, "documentId") || undefined,
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
    const doc = db.documents.find((d) => d.id === q.documentId);
    if (doc) {
      doc.status = "confirmed";
      doc.linkedType = "quote";
      doc.linkedId = id;
      relinkDocumentAttachments(db, doc.id, { type: "quote", id, customerId: q.customerId, storeId });
    }
    if (intent === "submit") role = requestApproval(db, q, user);
  });
  revalidatePath("/quotes");
  redirect(withMsg(`/quotes/${id}`, intent === "submit" ? `見積を作成し、${role === "admin" ? "管理者" : "店長"}へ承認を申請しました。` : "見積を下書き保存しました。"));
}

export async function updateQuote(id: string, formData: FormData) {
  const user = await requireActionUser();
  const back = `/quotes/${id}/edit`;
  const items = parseItems(formData, back);
  const intent = str(formData, "intent");
  let message = "見積を更新しました。";
  await mutate((db) => {
    const q = db.quotes.find((x) => x.id === id);
    if (!q) fail("/quotes", "見積が見つかりません。");
    assertStore(user, q.storeId, back);
    const t = calc(items, Number(str(formData, "discount")) || 0);
    const now = nowIso();
    if (q.status === "draft") {
      q.title = str(formData, "title") || q.title;
      q.category = choice(formData, "category", CATEGORY_LABEL, q.category);
      q.validUntil = str(formData, "validUntil") || q.validUntil;
      q.notes = str(formData, "notes") || undefined;
      q.items = items;
      Object.assign(q, t);
      q.updatedAt = now;
      addAudit(db, { userId: user.id, action: "update", entity: "quote", entityId: id, entityLabel: q.number, summary: `見積 (下書き) を更新 (合計 ${t.total.toLocaleString("ja-JP")}円)`, storeId: q.storeId });
      if (intent === "submit") {
        const role = requestApproval(db, q, user);
        message = `見積を更新し、${role === "admin" ? "管理者" : "店長"}へ承認を申請しました。`;
      }
    } else if (q.status === "approved" || q.status === "sent" || q.status === "accepted") {
      if (q.pendingChange) fail(`/quotes/${id}`, "すでに承認待ちの変更があります。");
      if (hasActiveInvoice(db, q.id)) fail(`/quotes/${id}`, "請求書を発行済みの案件は金額を変更できません。入金前であれば、請求書を無効化してから変更を申請してください。");
      const reason = str(formData, "reason");
      if (!reason) fail(back, "確定済みの見積を変更するには変更理由が必要です。");
      q.pendingChange = { items, ...t, reason, requestedBy: user.id, requestedAt: now };
      q.updatedAt = now;
      const role = requiredRole(db, q.storeId, Math.max(t.total, q.total), user.id);
      db.approvals.push({
        id: newId("ap"),
        type: "quote_amend",
        targetId: q.id,
        title: `${q.number} ${q.title} (金額変更)`,
        amount: t.total,
        storeId: q.storeId,
        requestedBy: user.id,
        requiredRole: role,
        status: "pending",
        requestComment: `変更前 ¥${q.total.toLocaleString("ja-JP")} → 変更後 ¥${t.total.toLocaleString("ja-JP")} / 理由: ${reason}`,
        createdAt: now,
      });
      addAudit(db, { userId: user.id, action: "submit", entity: "quote", entityId: id, entityLabel: q.number, summary: `確定見積の金額変更を申請 (${q.total.toLocaleString("ja-JP")}円 → ${t.total.toLocaleString("ja-JP")}円)`, storeId: q.storeId, changes: [{ field: "total", before: q.total, after: t.total }] });
      message = `金額変更を申請しました。${role === "admin" ? "管理者" : "店長"}の承認後に反映されます。`;
    } else {
      fail(`/quotes/${id}`, "この状態の見積は編集できません。");
    }
  });
  revalidatePath("/quotes");
  redirect(withMsg(`/quotes/${id}`, message));
}

export async function submitQuote(id: string) {
  const user = await requireActionUser();
  const back = `/quotes/${id}`;
  let role = "";
  await mutate((db) => {
    const q = db.quotes.find((x) => x.id === id);
    if (!q) fail("/quotes", "見積が見つかりません。");
    assertStore(user, q.storeId, back);
    if (q.status !== "draft") fail(back, "下書きの見積のみ申請できます。");
    role = requestApproval(db, q, user);
  });
  revalidatePath(back);
  redirect(withMsg(back, `${role === "admin" ? "管理者" : "店長"}へ承認を申請しました。`));
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
      siteAddress: str(formData, "siteAddress") || customer?.address || "",
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
    const r = requiredRole(db, q.storeId, q.total, user.id);
    role = r;
    db.approvals.push({ id: newId("ap"), type: "order", targetId: orderId, title: `${db.orders[db.orders.length - 1].number} ${q.title}`, amount: q.total, storeId: q.storeId, requestedBy: user.id, requiredRole: r, status: "pending", requestComment: str(formData, "note") || undefined, createdAt: now });
    addAudit(db, { userId: user.id, action: "create", entity: "order", entityId: orderId, entityLabel: db.orders[db.orders.length - 1].number, summary: `見積 ${q.number} から受注を登録し契約承認を申請`, storeId: q.storeId });
  });
  revalidatePath("/orders");
  redirect(withMsg(`/orders/${orderId}`, `受注を登録しました。${role === "admin" ? "管理者" : "店長"}の契約承認後に施工手配へ進めます。`));
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
